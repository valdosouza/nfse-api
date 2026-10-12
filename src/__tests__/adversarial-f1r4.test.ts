/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA da RODADA 4 da extração fiscal (D-F36…D-F40 — testar-adversarial.md §4-6, 2026-10-04).
// Achado CONFIRMADO vira teste permanente: `it.failing` = reproduz o bug (PASSA enquanto o bug existe; quando a
// correção entrar, vira `it`). Cada achado tem um `it` de CENÁRIO antes (pré-condições normais — se o cenário não se
// monta, falha de verdade; o `it.failing` só confere o desfecho). Aqui ficam as reproduções SEM banco; as que dependem
// do SQL real / do `migrate:setes` estão em `adversarial-f1r4.live.test.ts` (NFSE_ADV_LIVE=1).
//
// Achados deste arquivo:
//  - [MEDIUM — D-F38] o PRAZO do município (PAM) é buscado no fisco DENTRO do orçamento da passada do rodízio: convênio
//    lento/pendurado (timeout do transporte 30 s > orçamento 20 s) consome a passada inteira — nenhuma candidata é
//    consultada, a cada passada (falha não fica em cache);
//  - [LOW — D-F38] o prazo do PAM não tem teto: valor absurdo (ex.: data aaaammdd lida pela heurística [INCERTO] como
//    "dias") vira um DATE_SUB fora do domínio do MySQL → NULL → TODAS as autorizadas saem do rodízio, em silêncio;
//  - [LOW — D-F39] a garantia do NÚCLEO não cobre as composições nem as escritas do emitente: numa RÉPLICA o
//    cancelamento grava K/N antes da cerca recusar, a passada do rodízio responde "outra passada em curso" e o
//    `storeCertificate` grava o A1 — só a BORDA da nfse-api (requireCutover) protege.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, DEFAULT_TIMEOUT_MS } from 'fiscal-api'
import {
  refreshOpenServiceTransmissions, cancelServiceInvoiceAtAuthority, resetMunicipalTermsCache, REFRESH_BUDGET_MS, NfseDeps,
} from '../nfse/transmission'
import { findCancelDays } from '../authority/adn'
import { WEB, webRef } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

const actualFiscal = jest.requireActual('fiscal-api')

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(actual.openIssuer),
    acquireRefreshLease: jest.fn(actual.acquireRefreshLease),
    releaseRefreshLease: jest.fn(actual.releaseRefreshLease),
    renewRefreshLease: jest.fn(actual.renewRefreshLease),
    getIssuer: jest.fn(actual.getIssuer),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn(),
      entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), establishmentCnpj: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getTransmission: jest.fn(), latestTransmission: jest.fn(), findTransmissionByDpsId: jest.fn(), listRefreshCandidates: jest.fn(),
    fillAuthorityData: jest.fn(), insertTransmissionEvent: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(),
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const fM = fiscal as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r4-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const ring = MasterKeyRing.of({ 1: Buffer.alloc(32, 4) })
const deps: NfseDeps = { pool, keyring: ring, storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990004 }
const INVOICE = 6200
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000042'
const KEY = ('4106902' + '2' + CNPJ + '0'.repeat(50)).slice(0, 50)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}"><nNFSe>42</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '42', dhProc: '2026-09-30 13:00:00', createdAt: '2026-09-30 13:00:00', ageMinutes: 6000, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-30 13:00:00', lastEventAt: '2026-09-30 13:00:00',
  lastEventAgeMinutes: 6000, ...over,
})
const openedVirada = () => ({
  issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 12:00:00' },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
})
/** Linha da habilitação como o `fiscal_api` do dev está HOJE: RÉPLICA do ERP (cutover_at NULL). */
const REPLICA_ROW = { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: 1, cutoverAt: null }

/** Pool que responde como o banco com a habilitação RÉPLICA (para as funções REAIS do núcleo). */
function poolAsReplica(): void {
  const answer = async (sql: string) => {
    if (/UPDATE tb_establishment_issuer SET refresh_lease_until/.test(sql)) return [{ affectedRows: /cutover_at IS NOT NULL/.test(sql) ? 0 : 1 }]
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: 1 }]]          // issuerRowsState: 1 linha, réplica
    if (/FROM tb_establishment_issuer/.test(sql)) return [[REPLICA_ROW]]
    return [[]]
  }
  pool.query.mockImplementation(answer)
  conn.query.mockImplementation(answer)                                          // a peça confere DENTRO da transação
}

/** Última voz gravada pela composição (o mock de getTransmission devolve a tentativa com ela — K da reserva → N da liberação). */
let lastKindNow = 'A'

beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  lastKindNow = 'A'
  for (const k of ['openIssuer', 'acquireRefreshLease', 'releaseRefreshLease', 'getIssuer']) fM[k].mockImplementation(actualFiscal[k])
  fM.renewRefreshLease.mockResolvedValue('2026-10-04 12:01:00')            // a passada renova o aluguel antes de cada candidata
  pool.query.mockImplementation(async () => [[]])
  conn.query.mockImplementation(async () => [[]])
  erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
  erpM.invoiceLife.mockResolvedValue({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.entityFiscal.mockResolvedValue({
    id: 1, nameCompany: 'SETES SISTEMAS LTDA', nickTrade: null, cnpj: CNPJ, im: null, cpf: null,
    addresses: [{ main: 'S', street: 'Rua A', nmbr: '1', complement: null, neighborhood: 'Centro', zipCode: '80010000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
  })
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  repoM.getTransmission.mockImplementation(async () => tx({ lastKind: lastKindNow }))
  repoM.latestTransmission.mockImplementation(async () => tx({ lastKind: lastKindNow }))
  repoM.findTransmissionByDpsId.mockResolvedValue(null)
  repoM.hasTransmissionEvent.mockResolvedValue(true)
  repoM.findTransmissionEventByKind.mockResolvedValue(null)
  repoM.insertTransmissionEvent.mockImplementation(async (__itx: any, _a: number, _u: any, e: any) => { lastKindNow = e.kind; return 1 })
  adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: null })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: 60, raw: {} })
})

// ===========================================================================
describe('[MEDIUM — D-F38, corrigido nos gates R4] o prazo do PAM fica FORA do caminho crítico da passada do rodízio', () => {
  // O `deadline` da passada é fixado ANTES de `cancelDaysOf` (openIssuer + buildEmitter + GET /parametros_municipais/…/convenio).
  // O transporte do núcleo espera até 30 s de inatividade; o orçamento da passada (a requisição de quem abriu a tela) é 20 s.
  // Convênio pendurado = a passada inteira gasta esperando o PRAZO, nenhuma candidata consultada; a falha não entra no cache
  // (só o sucesso) → TODA passada repete a espera. O próprio código promete o contrário: "o teto é dado de manutenção, nunca
  // bloqueia a passada" (transmission.ts, cancelDaysOf). Antes da D-F38 o rodízio não dependia do convênio.
  const virada = () => {
    fM.openIssuer.mockResolvedValue(openedVirada())
    fM.acquireRefreshLease.mockResolvedValue('2026-10-04 12:01:00')
    fM.releaseRefreshLease.mockResolvedValue(true)
    repoM.listRefreshCandidates.mockResolvedValue([tx()])
  }

  it('cenário: transporte (30 s de inatividade) > orçamento da passada (20 s); com o convênio RÁPIDO a candidata autorizada é consultada', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(REFRESH_BUDGET_MS)
    virada()
    const r = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB, budgetMs: 200 })
    expect(r).toMatchObject({ checked: 1, stoppedEarly: false, skipped: false })
    expect(adapter.municipalTerms).toHaveBeenCalledTimes(1)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
    expect(repoM.listRefreshCandidates.mock.calls[0][6]).toEqual({ authorizedMaxDays: 90 })
  })

  it('[corrigido] convênio que FALHA devagar: a falha entra no cache — a passada seguinte não repete a espera e consulta a candidata', async () => {
    virada()
    adapter.municipalTerms.mockImplementation(async () => { await sleep(150); throw new Error('timeout') })   // falha dentro do teto de espera
    const r1 = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB, budgetMs: 1000 })
    const r2 = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB, budgetMs: 200 })
    // eslint-disable-next-line no-console
    console.log('[adv-r4] convênio lento × orçamento da passada', JSON.stringify({ r1, r2, chamadasAoConvenio: adapter.municipalTerms.mock.calls.length, consultas: adapter.queryNfse.mock.calls.length }))
    expect(r1.checked).toBe(1)
    expect(r2.checked).toBe(1)
    expect(adapter.municipalTerms).toHaveBeenCalledTimes(1)                                            // falha em cache (10 min)
    expect([r1.ceilingSource, r2.ceilingSource]).toEqual(['padrao', 'padrao'])
  })
})

// ===========================================================================
describe('[LOW — D-F38, corrigido nos gates R4] prazo do PAM implausível é descartado (nunca vira DATE_SUB fora do domínio)', () => {
  it('a heurística [INCERTO] do convênio lê uma DATA aaaammdd como "dias" — a passada DESCARTA o valor e usa o padrão (60 + 30)', async () => {
    expect(findCancelDays({ convenio: { dataLimiteCancelamento: 20261231 } })).toBe(20261231)
    fM.openIssuer.mockResolvedValue(openedVirada())
    fM.acquireRefreshLease.mockResolvedValue('2026-10-04 12:01:00')
    fM.releaseRefreshLease.mockResolvedValue(true)
    repoM.listRefreshCandidates.mockResolvedValue([])
    adapter.municipalTerms.mockResolvedValue({ cancelDays: 20261231, raw: {} })
    const r = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB })
    expect(repoM.listRefreshCandidates.mock.calls[0][6]).toEqual({ authorizedMaxDays: 90 })
    expect(r.ceilingSource).toBe('padrao')
  })

  it('[corrigido] o teto passado ao SQL produz um instante DENTRO do DATETIME (ano < 1000) — no MariaDB do dev o DATE_SUB vira NULL (prova ao vivo no .live)', async () => {
    fM.openIssuer.mockResolvedValue(openedVirada())
    fM.acquireRefreshLease.mockResolvedValue('2026-10-04 12:01:00')
    fM.releaseRefreshLease.mockResolvedValue(true)
    repoM.listRefreshCandidates.mockResolvedValue([])
    adapter.municipalTerms.mockResolvedValue({ cancelDays: 20261231, raw: {} })
    await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB })
    const days = repoM.listRefreshCandidates.mock.calls[0][6].authorizedMaxDays as number
    expect(Date.now() - days * 86_400_000).toBeGreaterThanOrEqual(Date.UTC(1000, 0, 1))
  })
})

// ===========================================================================
describe('[LOW — D-F39, corrigido nos gates R4] a réplica é recusada também nas composições e na peça do emitente', () => {
  // A borda da nfse-api (requireCutover) recusa tudo isto antes; o achado é o que o próprio comentário promete: "a garantia é
  // do núcleo — openIssuer, nextDpsNumber e o aluguel recusam a réplica" (guards.ts) e "abrir o emissor, cunhar nDPS, tomar o
  // aluguel do rodízio e ESCREVER O EMITENTE recusam (409 FISCAL_CUTOVER_PENDING)" (migration 003). Quem chamar a composição
  // ou a peça direto (script, a futura nfe-api que AGREGA o núcleo — D-F20) escreve na réplica.

  it('cenário: na RÉPLICA o aluguel não é tomado (a condição da virada está no UPDATE) e nada vai ao fisco', async () => {
    poolAsReplica()
    await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB }).catch(() => null)
    const upd = [...pool.query.mock.calls, ...conn.query.mock.calls].map((c: any[]) => String(c[0]))   // D-F41: pela conexão emprestada
      .find((s: string) => /SET refresh_lease_until = DATE_ADD/.test(s))
    expect(upd).toMatch(/cutover_at IS NOT NULL/)
    expect(repoM.listRefreshCandidates).not.toHaveBeenCalled()
    expect(adapter.municipalTerms).not.toHaveBeenCalled()
  })

  it('[corrigido] rodízio na RÉPLICA responde `skipped: true` ("outra passada do estabelecimento em curso") em vez de 409 FISCAL_CUTOVER_PENDING', async () => {
    poolAsReplica()
    await expect(refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB })).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
  })

  it('cenário: cancelar NO FISCO uma NFS-e autorizada da RÉPLICA → 409 FISCAL_CUTOVER_PENDING (openIssuer real) e nada vai ao fisco', async () => {
    poolAsReplica()
    await expect(cancelServiceInvoiceAtAuthority(deps, ACTOR, webRef(ACTOR, INVOICE), 'cancelamento adversarial r4'))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('[corrigido] …e ANTES da recusa a composição NÃO grava a reserva K e a liberação N na tentativa copiada do ERP (a próxima re-sincronia acusa dual-write)', async () => {
    poolAsReplica()
    await cancelServiceInvoiceAtAuthority(deps, ACTOR, webRef(ACTOR, INVOICE), 'cancelamento adversarial r4').catch(() => null)
    // eslint-disable-next-line no-console
    console.log('[adv-r4] vozes gravadas na RÉPLICA pela composição do cancelamento', JSON.stringify(repoM.insertTransmissionEvent.mock.calls.map((c: any[]) => c[3].kind)))
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  function pfxFor(cn: string, password = 'senha'): Buffer {
    const keys = forge.pki.rsa.generateKeyPair(1024)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '04' + Math.floor(Math.random() * 1e8).toString(16)
    cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
    const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
    cert.setSubject(attrs); cert.setIssuer(attrs)
    cert.sign(keys.privateKey, forge.md.sha256.create())
    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
    return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
  }

  it('[corrigido] "escrever o emitente" numa RÉPLICA recusa no NÚCLEO (migration 003) — não só na borda da nfse-api', async () => {
    poolAsReplica()
    await expect(actualFiscal.storeCertificate({ pool, keyring: ring }, 1, pfxFor(`SETES:${CNPJ}`), 'senha', { expectedCnpj: CNPJ, userId: 990004, schemaName: 'setes_setes' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(conn.query.mock.calls.some((c: any[]) => /INSERT INTO tb_establishment_certificate/.test(String(c[0])))).toBe(false)
  })
})
