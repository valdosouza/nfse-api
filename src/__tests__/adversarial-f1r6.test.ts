/// <reference types="jest" />
// GATE ADVERSARIAL — RE-PROVA FINAL do DELTA do RETRABALHO 2 da RODADA 4 (testar-adversarial.md §4-6, 2026-10-04).
// Achado CONFIRMADO vira teste permanente: `it.failing` = reproduz o bug (PASSA enquanto o bug existe; quando a correção
// entrar, vira `it`). Cada achado tem um `it` de CENÁRIO antes (se o cenário não se monta, falha de verdade). Aqui ficam
// as reproduções SEM banco; a prova de MVCC/SQL real, do `migrate:setes`, do smoke e do harness está em
// `adversarial-f1r6.live.test.ts` (NFSE_ADV_LIVE=1).
//
// Achados deste arquivo:
//  - [MEDIUM — A1 × reserva K do cancelamento] o retrabalho 2 serializou o DELETE do A1 com a reserva da TRANSMISSÃO pela
//    trava da habilitação (`lockIssuerRows` 1ª instrução); a decisão do CANCELAMENTO NO FISCO grava a reserva K (que
//    `countLiveTransmissions` conta como VIVA) só sob a trava da NOTA e abre o A1 por leitura NÃO travante — não passa pela
//    trava que o DELETE pega. Estrutural aqui; a prova ponta a ponta (A1 apagado com o K vivo e irreconciliável) no .live;
//  - [LOW — D-F38] "uma consulta por vez" sem IDADE MÁXIMA: o transporte real só tem timeout de INATIVIDADE (provado com
//    um servidor TLS local que pinga bytes); uma consulta ao convênio que nunca termina congela o prazo do município para
//    TODAS as institutions dele (e ambiente) até reiniciar o processo — o cache vence, mas a pendurada é reaproveitada
//    para sempre; cada passada e cada cancelamento pagam os 3 s, e a closure da pendurada retém o A1 decifrado.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import forge from 'node-forge'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { AddressInfo } from 'net'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, AuthorityHttpError } from 'fiscal-api'
import {
  refreshOpenServiceTransmissions, cancelServiceInvoiceAtAuthority, resetMunicipalTermsCache, CEILING_LOOKUP_TIMEOUT_MS, NfseDeps,
} from '../nfse/transmission'
import { webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r6-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const ring = MasterKeyRing.of({ 1: Buffer.alloc(32, 6) })
const deps: NfseDeps = { pool, keyring: ring, storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990006 }
const ACTOR_2 = { schemaName: 'setes_outro', institutionId: 2, userId: 990006 }      // OUTRA institution, MESMO município
const INVOICE = 6300
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000043'
const KEY = ('4106902' + '2' + '2' + CNPJ + '0'.repeat(50)).slice(0, 50)   // cMun + ambGer + tpInsc 2 + CNPJ (D-CJ19: chave do emitente do DPS)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}"><nNFSe>43</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 43, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '43', dhProc: '2026-09-30 13:00:00', createdAt: '2026-09-30 13:00:00', ageMinutes: 6000, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-30 13:00:00', lastEventAt: '2026-09-30 13:00:00',
  lastEventAgeMinutes: 6000, ...over,
})
const openedVirada = () => ({
  issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 12:00:00' },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
})

let lastKindNow = 'A'
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  lastKindNow = 'A'
  for (const k of ['openIssuer', 'acquireRefreshLease', 'releaseRefreshLease', 'getIssuer']) fM[k].mockImplementation(actualFiscal[k])
  fM.renewRefreshLease.mockResolvedValue('2026-10-04 12:01:30')
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
describe('[MEDIUM — A1 × reserva K do cancelamento] a decisão do cancelamento NO FISCO não passa pela trava que o DELETE do A1 pega', () => {
  // O DELETE do A1 (clearCertificate) trava as linhas da HABILITAÇÃO (1ª instrução) e só então conta as vivas
  // (`countLiveTransmissions` — K é VIVA). A reserva da TRANSMISSÃO trava a mesma habilitação (openIssuer forUpdate) antes
  // de gravar a tentativa → serializa. A decisão do CANCELAMENTO grava o K só sob a trava da NOTA (que o DELETE não pega)
  // e abre o A1 depois por leitura NÃO travante: um K comitado DEPOIS da contagem do DELETE e um A1 lido ANTES do commit
  // do DELETE = pedido no fisco com o A1 que está sendo apagado; ambíguo → K vivo SEM A1 (irreconciliável — prova no .live).
  const seq: string[] = []
  const trace = () => {
    seq.length = 0
    conn.query.mockImplementation(async (sql: string) => { seq.push(`sql:${String(sql).replace(/\s+/g, ' ').slice(0, 400)}`); return [[]] })
    pool.query.mockImplementation(async () => [[]])                                         // emissionStillInErp: sem linha, ERP sem SE → segue
    fM.openIssuer.mockImplementation(async (_d: any, _i: number, _m: string, o: any = {}) => {
      seq.push(`openIssuer:${o?.conn ? 'conn' : 'pool'}${o?.forUpdate ? '+forUpdate' : ''}`)
      return openedVirada()
    })
    repoM.insertTransmissionEvent.mockImplementation(async (__itx: any, _a: number, _u: any, e: any) => {
      seq.push(`voice:${e.kind}`); lastKindNow = e.kind; return 1
    })
    adapter.registerEvent.mockRejectedValue(new AuthorityHttpError(503, 'Fisco sem resposta (falso — ambíguo)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, ''))
  }
  const run = () => cancelServiceInvoiceAtAuthority(deps, ACTOR, webRef(ACTOR, INVOICE), 'cancelamento adversarial r6 — reserva K').then(() => 'ok', (e: any) => [e.statusCode, e.code])

  it('cenário: a decisão grava a reserva K (fato nosso, VIVA para a guarda do DELETE) e só DEPOIS abre o A1 — o pedido sai e volta ambíguo (K fica)', async () => {
    trace()
    const out = await run()
    // eslint-disable-next-line no-console
    console.log('[adv-r6] ordem do cancelamento no fisco:\n  ' + seq.join('\n  '), '\n  →', JSON.stringify(out))
    expect(out).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
    expect(seq).toContain('voice:K')
    expect(seq.indexOf('voice:K')).toBeLessThan(seq.indexOf('openIssuer:pool'))
    expect(seq).not.toContain('voice:N')                                                     // ambíguo: o K fica VIVO
    expect(adapter.registerEvent).toHaveBeenCalledTimes(1)
  })

  it('[corrigido] …e ANTES do K a transação trava a HABILITAÇÃO (a mesma trava que o DELETE do A1 pega primeiro — ordem nota → habilitação)', async () => {
    trace()
    await run()
    const k = seq.indexOf('voice:K')
    const lock = seq.findIndex(s => /^sql:.*FROM tb_establishment_issuer.*FOR UPDATE/.test(s) || s === 'openIssuer:conn+forUpdate')
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(k)
  })
})

// ===========================================================================
describe('[LOW — D-F38] "uma consulta por vez" sem IDADE MÁXIMA: a consulta pendurada ao convênio congela o prazo do município', () => {
  function selfSigned(): { cert: string; key: string } {
    const keys = forge.pki.rsa.generateKeyPair(1024)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '06' + Math.floor(Math.random() * 1e8).toString(16)
    cert.validity.notBefore = new Date(Date.now() - 86_400_000)
    cert.validity.notAfter = new Date(Date.now() + 86_400_000)
    const attrs = [{ name: 'commonName', value: '127.0.0.1' }]
    cert.setSubject(attrs); cert.setIssuer(attrs)
    cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
  }

  const drip: any = {}
  it('cenário (transporte REAL do núcleo, servidor TLS LOCAL — nada sai da máquina): resposta que pinga 1 byte a cada 200 ms passa do `timeoutMs` (800 ms) — o timeout é de INATIVIDADE, não de duração', async () => {
    const tls = selfSigned()
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      let n = 0
      const t = setInterval(() => { res.write(' '); if (++n >= 15) { clearInterval(t); res.end('{}') } }, 200)   // ~3 s pingando
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    // o agente global passa a confiar SÓ no certificado do servidor LOCAL (a verificação continua ligada); restaurado no fim
    const agentOpts = https.globalAgent.options as any
    const prevCa = agentOpts.ca
    agentOpts.ca = tls.cert
    const t0 = Date.now()
    try {
      const r = await actualFiscal.httpsRequest({ url: `https://127.0.0.1:${port}/parametros_municipais/4106902/convenio`, method: 'GET',
        cert: Buffer.from(tls.cert), key: Buffer.from(tls.key), timeoutMs: 800 })
      drip.status = r.status
    } catch (e: any) { drip.err = e?.message }
    finally {
      drip.ms = Date.now() - t0
      if (prevCa === undefined) delete agentOpts.ca; else agentOpts.ca = prevCa
      https.globalAgent.destroy()
      await new Promise<void>(r => server.close(() => r()))
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r6] transporte × servidor que pinga bytes', JSON.stringify(drip))
    expect(drip.status).toBe(200)
    expect(drip.ms).toBeGreaterThan(2500)                                                      // > 3× o timeoutMs, e não falhou
  }, 20_000)

  const frozen: any = {}
  it('cenário: convênio PENDURADO na passada da institution 1 (espera ≤ 3 s, padrão); 25 h depois a consulta pendurada é dada por perdida', async () => {
    fM.openIssuer.mockResolvedValue(openedVirada())
    fM.acquireRefreshLease.mockResolvedValue('2026-10-04 12:01:00')
    fM.releaseRefreshLease.mockResolvedValue(true)
    repoM.listRefreshCandidates.mockResolvedValue([tx()])
    adapter.municipalTerms.mockImplementationOnce(() => new Promise(() => { /* pendurado: servidor pingando bytes */ }))
    adapter.municipalTerms.mockImplementation(async () => ({ cancelDays: 120, raw: {} }))     // o convênio VOLTOU a responder
    const t0 = Date.now()
    const now = jest.spyOn(Date, 'now')
    try {
      const pass = (actor: typeof ACTOR) => refreshOpenServiceTransmissions(deps, actor, { terminal: WEB, budgetMs: 500 })
      now.mockImplementation(() => t0)
      frozen.first = await pass(ACTOR)
      now.mockImplementation(() => t0 + 25 * 3_600_000)                                        // 25 h: o TTL de 1 h venceu 25×
      const t1 = process.hrtime.bigint()                                                       // relógio real (Date.now está fixo)
      frozen.later1 = await pass(ACTOR)
      frozen.later2 = await pass(ACTOR_2)
      frozen.laterMs = Number((process.hrtime.bigint() - t1) / 1_000_000n)
      frozen.calls = adapter.municipalTerms.mock.calls.length
    } finally {
      now.mockRestore()
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r6] convênio pendurado × 25 h depois', JSON.stringify(frozen))
    expect(frozen.first).toMatchObject({ checked: 1, ceilingSource: 'padrao', authorizedMaxDays: 90 })
    expect(frozen.laterMs).toBeLessThan(2 * CEILING_LOOKUP_TIMEOUT_MS)                         // a pendurada não é mais esperada
  }, 30_000)

  it('[corrigido] …e, vencido o cache, uma consulta NOVA é feita (a pendurada tem idade máxima) — o convênio que voltou a responder (120) é perguntado', () => {
    expect(frozen.calls).toBeGreaterThan(1)
    expect([frozen.later1?.ceilingSource, frozen.later1?.authorizedMaxDays]).toEqual(['municipio', 150])
  })
})
