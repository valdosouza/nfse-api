/// <reference types="jest" />
// GATE ADVERSARIAL — RE-PROVA do DELTA do retrabalho da RODADA 4 (D-F36…D-F40 — testar-adversarial.md §4-6, 2026-10-04).
// Achado CONFIRMADO vira teste permanente: `it.failing` = reproduz o bug (PASSA enquanto o bug existe; quando a correção
// entrar, vira `it`). Cada achado tem um `it` de CENÁRIO antes (pré-condições normais — se o cenário não se monta, falha
// de verdade; o `it.failing` só confere o desfecho). Aqui ficam as reproduções SEM banco; as que dependem do MVCC/SQL real,
// do `migrate:setes`, do smoke e do harness estão em `adversarial-f1r5.live.test.ts` (NFSE_ADV_LIVE=1).
//
// Achados deste arquivo:
//  - [MEDIUM — regressão do retrabalho R4] `clearCertificate` (DELETE do A1) passou a abrir a transação com uma leitura
//    NÃO travante (`assertNotReplica` → `issuerRowsState`): o SNAPSHOT do REPEATABLE READ nasce ANTES da trava da
//    habilitação que a guarda pede; a guarda "transmissão viva → 409" conta as vivas nesse snapshot velho (prova ao vivo
//    no .live: reserva que esperava commita, o DELETE apaga o A1 com a tentativa EM VOO);
//  - [LOW — D-F39] a cerca do núcleo/composição usa critério MAIS FRACO que o predicado `emissionStillInErp`: o
//    cancelamento direto lê `getIssuer` (só linha VIVA) → réplica EXCLUÍDA (ou sem linha, ERP emitindo) grava K e N na
//    tentativa copiada; `storeCertificate` só olha as linhas do `fiscal_api` → na lacuna (b) grava o A1;
//  - [LOW — D-F38] o cache do prazo do PAM não tem "uma consulta por vez" nem ordem: convênio PENDURADO (o transporte só
//    tem timeout de INATIVIDADE) é relançado a cada passada (cada uma paga os 3 s e deixa mais uma chamada viva, com o
//    A1 decifrado na closure); uma falha TARDIA sobrescreve o sucesso mais NOVO por 10 min (o teto encolhe).
import forge from 'node-forge'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing } from 'fiscal-api'
import {
  refreshOpenServiceTransmissions, cancelServiceInvoiceAtAuthority, resetMunicipalTermsCache, CEILING_LOOKUP_TIMEOUT_MS, NfseDeps,
} from '../nfse/transmission'
import { removeCertificate } from '../modules/emitter/emitter.service'

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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r5-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const ring = MasterKeyRing.of({ 1: Buffer.alloc(32, 5) })
const deps: NfseDeps = { pool, keyring: ring, storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990005 }
const INVOICE = 6200
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000042'
const KEY = ('4106902' + '2' + CNPJ + '0'.repeat(50)).slice(0, 50)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}"><nNFSe>42</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const tx = (over: any = {}) => ({
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
const TURNED_ROW = { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: 1, cutoverAt: '2026-10-04 12:00:00' }

function pfxFor(cn: string, password = 'senha'): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '05' + Math.floor(Math.random() * 1e8).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
}

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
  repoM.insertTransmissionEvent.mockImplementation(async (_c: any, _i: number, _inv: number, _a: number, _u: any, e: any) => { lastKindNow = e.kind; return 1 })
  adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: null })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: 60, raw: {} })
})

// ===========================================================================
describe('[MEDIUM — regressão do retrabalho R4, corrigida] DELETE do A1: a 1ª leitura da transação volta a ser TRAVANTE', () => {
  // Antes do retrabalho R4 a transação do `clearCertificate` começava pela GUARDA da família (`getIssuer(..., true)` =
  // FOR UPDATE na habilitação SE) — o snapshot do REPEATABLE READ nascia na contagem das vivas, DEPOIS da trava, e a
  // reserva que segurava a habilitação já tinha comitado a tentativa. O retrabalho R4 pôs `assertNotReplica`
  // (`SELECT COUNT(*), SUM(cutover_at IS NULL) … FROM tb_establishment_issuer`, leitura CONSISTENTE) ANTES da guarda: o
  // snapshot nasce antes de esperar a trava → `countLiveTransmissions` lê o passado. É a regra 2 do PADROES §9 que o gate
  // R2 cravou na RESERVA ("trava antes de qualquer leitura não travante"), agora quebrada do lado do DELETE.
  const answer = async (sql: string) => {
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [[{ model: 'SE', c: '2026-10-04 00:00:00' }]]   // trava: SE VIRADA
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: 0, s: 1 }]]                 // habilitação SE VIRADA (D-F50: s = linhas SE)
    if (/FROM tb_establishment_issuer/.test(sql)) return [[TURNED_ROW]]
    if (/COUNT\(\*\) AS n\s+FROM tb_invoice_service_transmission/.test(sql)) return [[{ n: 0 }]]
    if (/UPDATE tb_establishment_certificate/.test(sql)) return [{ affectedRows: 1 }]
    return [[]]
  }
  const ctxDel = { pool, keyring: ring } as any
  const inst = { institutionId: 1, userId: 990005, schemaName: 'setes_setes', role: 'admin' } as any
  const tableStatements = () => conn.query.mock.calls.map((c: any[]) => String(c[0])).filter(s => /\b(FROM|UPDATE|INTO)\s+`?tb_/.test(s))

  it('cenário: o DELETE do A1 (removeCertificate real) roda a guarda da família e apaga o A1 de uma habilitação VIRADA sem vivas', async () => {
    pool.query.mockImplementation(answer); conn.query.mockImplementation(answer)
    await removeCertificate(ctxDel, inst)
    const stmts = tableStatements()
    // eslint-disable-next-line no-console
    console.log('[adv-r5] ordem dos comandos na transação do DELETE do A1:\n  ' + stmts.map(s => s.replace(/\s+/g, ' ').slice(0, 110)).join('\n  '))
    expect(stmts.some(s => /FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(s))).toBe(true)              // a guarda trava
    expect(stmts.some(s => /FROM tb_invoice_service_transmission/.test(s))).toBe(true)                      // e conta as vivas
    expect(stmts.some(s => /UPDATE tb_establishment_certificate/.test(s))).toBe(true)                       // e apaga
  })

  it('[corrigido] …e a 1ª leitura de tabela da transação é TRAVANTE (o snapshot nasce DEPOIS da trava da habilitação — regra 2 do PADROES §9)', async () => {
    pool.query.mockImplementation(answer); conn.query.mockImplementation(answer)
    await removeCertificate(ctxDel, inst)
    const first = tableStatements()[0] ?? ''
    expect(/FOR UPDATE|LOCK IN SHARE MODE/.test(first) || /^\s*UPDATE\b/.test(first)).toBe(true)
  })
})

// ===========================================================================
describe('[LOW — D-F39, corrigido] a cerca do núcleo/composição usa o MESMO predicado da borda (réplica viva/excluída + lacuna b)', () => {
  // A borda (requireCutover) usa `emissionStillInErp`: réplica VIVA ou EXCLUÍDA, ou — sem linha — habilitação SE no ERP.
  // O retrabalho R4 fechou "o cancelamento direto grava K/N antes de recusar" lendo `getIssuer` (que só vê linha VIVA) e
  // "o núcleo escreve o A1 da réplica" contando só as linhas do `fiscal_api`. Quem chama a composição/peça direto (script,
  // a futura nfe-api que AGREGA o núcleo — D-F20) ainda escreve num estabelecimento que o ERP emite.
  /** Réplica EXCLUÍDA: a linha existe com cutover_at NULL e deleted='S' (o migrate copia o `deleted` do ERP). */
  const excludedReplica = async (sql: string) => {
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: 1 }]]
    if (/FROM tb_establishment_issuer/.test(sql) && /deleted = 'N'/.test(sql)) return [[]]       // getIssuer só vê viva
    return [[]]
  }

  it('cenário: réplica EXCLUÍDA — o predicado da borda diz "o ERP ainda emite"; o cancelamento direto recusa (409) e nada vai ao fisco', async () => {
    pool.query.mockImplementation(excludedReplica); conn.query.mockImplementation(excludedReplica)
    expect(await actualFiscal.emissionStillInErp(pool, 'setes_setes', 1)).toBe(true)
    await expect(cancelServiceInvoiceAtAuthority(deps, ACTOR, INVOICE, 'cancelamento adversarial r5 réplica excluída'))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('[corrigido] …e a composição NÃO grava K (reserva) nem N (liberação) na tentativa copiada da réplica excluída', async () => {
    pool.query.mockImplementation(excludedReplica); conn.query.mockImplementation(excludedReplica)
    await cancelServiceInvoiceAtAuthority(deps, ACTOR, INVOICE, 'cancelamento adversarial r5 réplica excluída').catch(() => null)
    // eslint-disable-next-line no-console
    console.log('[adv-r5] vozes gravadas na réplica EXCLUÍDA pelo cancelamento direto', JSON.stringify(repoM.insertTransmissionEvent.mock.calls.map((c: any[]) => c[5].kind)))
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  /** Lacuna (b): nenhuma linha no `fiscal_api` e habilitação SE própria no ERP (institution ainda não migrada). */
  const gapB = async (sql: string) => {
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 0, r: 0 }]]
    if (/`setes_setes`\.tb_establishment_issuer/.test(sql)) return [[{ x: 1 }]]
    if (/INSERT INTO tb_establishment_certificate/.test(sql)) return [{ affectedRows: 1 }]
    return [[]]
  }

  it('cenário: lacuna (b) — o predicado da borda diz "o ERP ainda emite" (requireCutover recusaria o PUT do A1); o MESMO .pfx numa habilitação VIRADA grava (o arquivo é válido)', async () => {
    pool.query.mockImplementation(gapB); conn.query.mockImplementation(gapB)
    expect(await actualFiscal.emissionStillInErp(pool, 'setes_setes', 1)).toBe(true)
    const turned = async (sql: string) => {
      if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: 0 }]]
      if (/INSERT INTO tb_establishment_certificate/.test(sql)) return [{ affectedRows: 1 }]
      return [[]]
    }
    pool.query.mockImplementation(turned); conn.query.mockImplementation(turned)
    await actualFiscal.storeCertificate({ pool, keyring: ring }, 1, pfxFor(`SETES:${CNPJ}`), 'senha', { expectedCnpj: CNPJ, userId: 990005, schemaName: 'setes_setes' })
    expect(conn.query.mock.calls.some((c: any[]) => /INSERT INTO tb_establishment_certificate/.test(String(c[0])))).toBe(true)
  })

  it('[corrigido] …e o NÚCLEO (`storeCertificate`) também recusa gravar o A1 (409 FISCAL_CUTOVER_PENDING)', async () => {
    pool.query.mockImplementation(gapB); conn.query.mockImplementation(gapB)
    const out = await actualFiscal.storeCertificate({ pool, keyring: ring }, 1, pfxFor(`SETES:${CNPJ}`), 'senha', { expectedCnpj: CNPJ, userId: 990005, schemaName: 'setes_setes' })
      .then(() => 'gravou', (e: any) => [e.statusCode, e.code])
    // eslint-disable-next-line no-console
    console.log('[adv-r5] storeCertificate na lacuna (b) →', JSON.stringify(out))
    expect(out).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
    expect(conn.query.mock.calls.some((c: any[]) => /INSERT INTO tb_establishment_certificate/.test(String(c[0])))).toBe(false)
  })
})

// ===========================================================================
describe('[LOW — D-F38, corrigido] cache do prazo do PAM: uma consulta por vez e a falha nunca encolhe o prazo conhecido', () => {
  const virada = () => {
    fM.openIssuer.mockResolvedValue(openedVirada())
    fM.acquireRefreshLease.mockResolvedValue('2026-10-04 12:01:00')
    fM.releaseRefreshLease.mockResolvedValue(true)
    repoM.listRefreshCandidates.mockResolvedValue([tx()])
  }
  const timedPass = async () => { const t0 = Date.now(); const r = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 }); return { ms: Date.now() - t0, r } }

  it('cenário: convênio PENDURADO (nunca responde) — o bulkhead segura: cada passada espera ≤ 3 s, usa o padrão e consulta a candidata', async () => {
    virada()
    adapter.municipalTerms.mockImplementation(() => new Promise(() => { /* nunca resolve: servidor que pinga bytes não estoura o timeout de inatividade */ }))
    const p1 = await timedPass()
    const p2 = await timedPass()
    // eslint-disable-next-line no-console
    console.log('[adv-r5] convênio pendurado × passadas', JSON.stringify({ p1, p2, chamadasAoConvenio: adapter.municipalTerms.mock.calls.length }))
    for (const p of [p1, p2]) {
      expect(p.r).toMatchObject({ checked: 1, ceilingSource: 'padrao', authorizedMaxDays: 90 })
      expect(p.ms).toBeGreaterThanOrEqual(CEILING_LOOKUP_TIMEOUT_MS - 50)
      expect(p.ms).toBeLessThan(CEILING_LOOKUP_TIMEOUT_MS + 2000)
    }
  }, 20_000)

  it('[corrigido] …e a 2ª passada NÃO relança a consulta pendurada (uma por vez por institution/município)', async () => {
    virada()
    adapter.municipalTerms.mockImplementation(() => new Promise(() => { /* pendurado */ }))
    await timedPass()
    await timedPass()
    expect(adapter.municipalTerms).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('[corrigido] uma consulta por vez: a falha lenta em curso é ESPERADA (não se lança outra) e a 2ª passada não usa resposta fora de ordem', async () => {
    virada()
    // UMA resposta só: com "uma consulta por vez" uma 2ª nunca é pedida (e uma 2ª enfileirada vazaria para o teste seguinte)
    adapter.municipalTerms.mockImplementationOnce(async () => { await sleep(CEILING_LOOKUP_TIMEOUT_MS + 450); throw new Error('timeout') })
    const a = await timedPass()                                          // ~3 s: padrão; a consulta 1 segue
    const b = await timedPass()                                          // espera a MESMA consulta (falha) → padrão
    expect([a.r.ceilingSource, b.r.ceilingSource]).toEqual(['padrao', 'padrao'])
    expect(adapter.municipalTerms).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('[corrigido] a FALHA nunca encolhe o prazo conhecido: sucesso (150) → cache vencido → convênio fora → continua 150 (+10 min) — A13', async () => {
    virada()
    const t0 = Date.now()
    const now = jest.spyOn(Date, 'now')
    try {
      now.mockReturnValue(t0)
      adapter.municipalTerms.mockImplementationOnce(async () => ({ cancelDays: 120, raw: {} }))
      const a = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 })
      now.mockReturnValue(t0 + 61 * 60_000)                              // o cache de 1 h venceu
      adapter.municipalTerms.mockImplementationOnce(async () => { throw new Error('convênio fora') })
      const b = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 })
      now.mockReturnValue(t0 + 62 * 60_000)
      const c = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 })
      expect([a.ceilingSource, a.authorizedMaxDays]).toEqual(['municipio', 150])
      expect([b.ceilingSource, b.authorizedMaxDays]).toEqual(['municipio', 150])
      expect([c.ceilingSource, c.authorizedMaxDays]).toEqual(['municipio', 150])
      expect(adapter.municipalTerms).toHaveBeenCalledTimes(2)            // a 3ª passada usa o cache (a falha vale +10 min)
    } finally {
      now.mockRestore()
    }
  }, 20_000)

  it('cenário (sem achado): lixo do convênio cai no padrão; string numérica plausível vale; PAM < 60 nunca encolhe o teto', async () => {
    virada()
    const cases: [unknown, string, number][] = [
      ['abc', 'padrao', 90], [-5, 'padrao', 90], [0, 'padrao', 90], [1e9, 'padrao', 90], [45.5, 'padrao', 90],
      [Infinity, 'padrao', 90], [null, 'padrao', 90], ['90', 'municipio', 120], [45, 'municipio', 90], [3650, 'municipio', 3680],
    ]
    const got: [unknown, string | undefined, number | undefined][] = []
    for (const [v] of cases) {
      resetMunicipalTermsCache()
      adapter.municipalTerms.mockResolvedValueOnce({ cancelDays: v as any, raw: {} })
      const r = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 })
      got.push([v, r.ceilingSource, r.authorizedMaxDays])
    }
    resetMunicipalTermsCache()
    adapter.municipalTerms.mockResolvedValueOnce('lixo' as any)
    const junk = await refreshOpenServiceTransmissions(deps, ACTOR, { budgetMs: 500 })
    expect(got).toEqual(cases)
    expect([junk.ceilingSource, junk.authorizedMaxDays]).toEqual(['padrao', 90])
  })
})
