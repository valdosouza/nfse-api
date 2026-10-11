/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 20 das APIs fiscais (D-F100…D-F101, Valdo 2026-10-11) — nfse-api (+ núcleo fiscal-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F101 (= Q-F107 (b)) é do NÚCLEO (`reconfirmationProven` falha FECHADO com irmã da mesma identidade VIVA — S/K/sem
// voz/`lastKind` ausente); aqui se ataca a COMPOSIÇÃO com a nfse-api: o que a reconferência (`reconfirmBeforeLocalCancel`) responde ×
// o que a prova lida pelo núcleo diz, e se a irmã viva tem SAÍDA (senão o falso negativo é permanente — laço "reconfira"). D-F100 (=
// Q-F106 (a)) é só comentário ("NADA da resposta alheia é guardado") — aqui se confere a afirmação contra TUDO que persiste ou sai:
// banco (todas as escritas), arquivo fiscal (disco), logs (índice + transporte) e o corpo HTTP — inclusive o blob gzip+base64 da
// NFS-e alheia (a agulha em texto do r19 não o enxergava).
//
//  * ACHADOS (`it.failing('[SEV R20-xx] …')`) — o teste afirma o que a spec/decisão promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo trocado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r19-gate.test.ts`), nenhuma migration, nada que fale com o fisco. Lê o setes-api só como TEXTO.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing } from 'fiscal-api'
import { refreshServiceTransmission, NfseDeps } from '../nfse/transmission'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    nextDpsNumber: jest.fn(),
    acquireRefreshLease: jest.fn(),
    releaseRefreshLease: jest.fn(),
    renewRefreshLease: jest.fn(),
    emissionStillInErp: jest.fn(),
    getIssuer: jest.fn(),
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), invoiceLives: jest.fn(), institutionZone: jest.fn(),
      entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), establishmentCnpj: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getLifeDps: jest.fn(), insertLifeDps: jest.fn(), getTransmission: jest.fn(), latestTransmission: jest.fn(),
    findTransmissionByDpsId: jest.fn(), listLifeTransmissions: jest.fn(), insertTransmission: jest.fn(),
    fillAuthorityData: jest.fn(), insertTransmissionEvent: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(), listRefreshCandidates: jest.fn(),
    findKeyHolder: jest.fn(),
    // recordNfseNotGenerated fica REAL: o UPDATE dele vai ao `pool.query` falso deste teste (a "tabela" em memória abaixo)
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r20-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000199'
// layout REAL da chave (gate R19 — R19-03): cMun(7) + ambGer(1) + tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1)
const KEY = '4106902' + '2' + '2' + '12345678000199' + '0000000000123' + '2609' + '000012345' + '1'
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const nfseXmlOf = (key: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-10-10 21:43:04', createdAt: '2026-10-10 21:43:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})
/** F "envio interrompido" por CONSULTA em PRODUÇÃO — a candidata da reconferência (D-F29). Reserva 09/10 09:59, F 09/10 10:00. */
const F = (over: any = {}) => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2,
  createdAt: '2026-10-09 09:59:00', lastEventAt: '2026-10-09 10:00:00', lastQueriedAt: '2026-10-09 10:00:00', ...over })
/** Tentativa EM VOO (sem voz) em PRODUÇÃO. */
const inFlight = (over: any = {}) => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastEvent: null, lastKind: null,
  lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null, ageMinutes: 2, ...over })

// "tabela" da tentativa em memória para o escritor REAL da D-F90 (o subselect `COALESCE(MAX(e.event), 0)` = `maxEvent`)
let maxEvent = 0
let stamps: { attempt: number; seen: number }[] = []
let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  maxEvent = 0; stamps = []
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/nfse_not_generated_at = NOW\(\)/.test(sql)) {
      const ok = Number(params[3]) === maxEvent
      if (ok) stamps.push({ attempt: Number(params[2]), seen: Number(params[3]) })
      return [{ affectedRows: ok ? 1 : 0 }]
    }
    return /GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]
  })
  conn.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null }, cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
    info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
  })
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  ;(repo.listRefreshCandidates as jest.Mock).mockReset().mockResolvedValue([])
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

// A Sefin REAL (D-F61) pelo transporte do NÚCLEO — nenhum socket
import { transport, HttpsCall, reconfirmationCandidate, reconfirmationProven, isLiveTransmission, currentOf, ErrorCodes, sendError } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { reconfirmBeforeLocalCancel, transmitServiceInvoice, isInterruptedInFlight, IN_FLIGHT_MINUTES } from '../nfse/transmission'
import { voiceSProducers } from './voice-kind-fence'

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset() })

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const E2404 = (tipoAmbiente?: number) => ({ status: 404, headers: {}, text: JSON.stringify({
  ...(tipoAmbiente === undefined ? {} : { tipoAmbiente, versaoAplicativo: 'SefinNacional_1.6.0', dataHoraProcessamento: '2026-10-11T10:00:00-03:00' }),
  erro: { codigo: 'E2404', descricao: 'Não foi gerada uma NFS-e com o identificador de DPS informado' } }) })
const sefinNoneP = () => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente: 1 }) })
/** A Sefin falsa: `/dps/{id}`, `/nfse/{chave}`, GET tipado (sempre "não há esse evento" em P). */
function fiscoP(o: { dpsKey?: string | null; dps?: () => any; nfse?: (key: string) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return o.dps?.() ?? (o.dpsKey ? ok({ chaveAcesso: o.dpsKey }) : E2404(1))
    if (/\/nfse\/(\d+)\/eventos\/(\d+)\/(\d+)$/.test(call.url) && call.method === 'GET') return sefinNoneP()
    const nf = call.url.match(/\/nfse\/(\d+)$/)
    if (nf) return o.nfse?.(nf[1]) ?? ok({ nfseXmlGZipB64: gz(nfseXmlOf(nf[1])) })
    return notFound()
  })
}

// fixtures do transmitir (molde do r19)
const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? '12.345.678/0001-99' : '98.765.432/0001-88', im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
let headerRow: any
beforeEach(() => {
  headerRow = header()
  const basePool = pool.query.getMockImplementation()
  pool.query.mockImplementation(async (sql: string, params: any[] = []) => (/FROM `setes_setes`\.tb_invoice i/.test(sql) ? [[headerRow]] : basePool!(sql, params)))
  const baseConn = conn.query.getMockImplementation()
  conn.query.mockImplementation(async (sql: string, params: any[] = []) => (/FROM `setes_setes`\.tb_invoice_service\s/.test(sql) ? [[{ updatedAt: headerRow.branchUpdatedAt }]] : baseConn!(sql, params)))
  erpM.invoiceLives.mockImplementation(async () => new Map())
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(repo.getLifeDps as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  adapter.transmit.mockReset(); adapter.queryNfse.mockReset(); adapter.queryDpsAccessKey.mockReset()
})

// o log REAL do núcleo (o transporte loga por ele) — capturado junto com o do índice (mock)
const logger = fiscal.logger as unknown as Record<'info' | 'warn' | 'error', jest.Mock>
const coreLogger = (jest.requireActual('fiscal-api') as typeof fiscal).logger
beforeEach(() => {
  jest.spyOn(coreLogger, 'info').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'warn').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'error').mockImplementation(() => undefined)
})
afterEach(() => { (coreLogger.info as jest.Mock).mockRestore?.(); (coreLogger.warn as jest.Mock).mockRestore?.(); (coreLogger.error as jest.Mock).mockRestore?.() })
const allLogs = () => JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls,
  (coreLogger.info as jest.Mock).mock.calls, (coreLogger.warn as jest.Mock).mock.calls, (coreLogger.error as jest.Mock).mock.calls])

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const WORKSPACE = path.resolve(PROJECT_ROOT, '..')
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ===========================================================================
// Cenário da composição: vida = [F por consulta (1) — a candidata —, irmã da MESMA identidade (2)]
// ===========================================================================

/** Irmã 2, mesmo Id/ambiente da candidata, reservada 11/10 08:00, SEM chave; voz e idade parametrizadas (velha o bastante para a D-F51). */
const sibling = (lastKind: 'S' | 'K' | null, over: any = {}) => tx({
  attempt: 2, environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-10-11 08:00:00',
  ageMinutes: IN_FLIGHT_MINUTES + 120, lastQueriedAt: null,
  ...(lastKind === null
    ? { lastEvent: null, lastKind: null, lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null }
    : { lastEvent: 1, lastKind, lastSource: 'P', lastDh: null, lastEventAt: '2026-10-11 08:00:01', lastEventAgeMinutes: IN_FLIGHT_MINUTES + 119 }),
  ...over,
})
function lifeScenario(sib: any) {
  const f1 = F()
  maxEvent = 2                                                                       // a última voz da candidata (o F) — o escritor da D-F90 aceita
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(sib)                      // a VIGENTE (sem chave na vida) = a maior tentativa
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1, sib], events: [] })
  return { f1, life: [f1, sib] }
}
/** A candidata como a F2a a leria DEPOIS da reconferência: o E2404 carimbado agora (11/10 10:00 — posterior a toda apresentação). */
const stamped = (f1: any) => ({ ...f1, nfseNotGeneratedAt: '2026-10-11 10:00:00' })

// ===========================================================================
// ACHADO R20-01 — a irmã S não tem saída: a prova (D-F101) fica falsa PARA SEMPRE
// ===========================================================================

describe('ACHADO R20-01 (LOW latente — S não tem produtor; questão Q-F108) — D-F101 faz a prova esperar a irmã VIVA ganhar voz FINAL ("a prova volta quando a tentativa ganhar voz" — D-F99), mas na nfse-api só a tentativa SEM voz tem saída (D-F51: `isInterruptedInFlight` exige `lastKind === null`). Uma irmã S sem chave: o rodízio a revisita para sempre (`le.kind IN (\'S\',\'K\')`), o fisco responde E2404 e ela NUNCA fecha — a reconferência da nfse-api responde "reconferida, não achou" e a prova lida pelo núcleo diz "não provado" para sempre (laço "reconfira"/"em andamento" sem fim); o transmitir também fica preso (409 em andamento)', () => {
  it('contexto: a nfse-api RESPONDE "reconferida" (needed, !found) e carimba o E2404 na candidata — e o núcleo, com a MESMA vida, diz NÃO PROVADO (irmã S viva)', async () => {
    const { f1, life } = lifeScenario(sibling('S'))
    fiscoP({})                                                                        // GET /dps → E2404 (P)
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, INVOICE)).toEqual({ invoiceId: INVOICE, needed: true, found: false, attempt: 1, accessKey: null })
    expect(stamps).toEqual([{ attempt: 1, seen: 2 }])
    expect(reconfirmationCandidate(life as any)?.attempt).toBe(1)
    expect(reconfirmationProven(stamped(f1), life as any)).toBe(false)
  })
  it('contexto: a barreira do plano (nota de implantação da F2a (1)) vê a vigente S como VIVA → a F2a diria "transmissão em andamento" (mensagem coerente — mas sem prazo)', () => {
    const { life } = lifeScenario(sibling('S'))
    expect(isLiveTransmission(currentOf(life as any))).toBe(true)
  })
  it('contexto: o rodízio revisita S a cada `minMinutes`, PARA SEMPRE (SQL real das candidatas: S/K só pelo throttle, sem teto de idade)', async () => {
    let sql = ''
    const actual = jest.requireActual('../nfse/repository') as typeof repo
    await actual.listRefreshCandidates({ query: async (s: string) => { sql = s; return [[]] } } as any, 'setes_setes', 1, 5, IN_FLIGHT_MINUTES, 8)
    expect(sql.replace(/\s+/g, ' ')).toMatch(/OR \(le\.kind IN \('S','K'\) AND \(t\.last_queried_at IS NULL OR t\.last_queried_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)\)\)/)
  })
  it('contexto: a consulta (rodízio) da irmã S velha com E2404 → NADA muda (sem voz nova, carimba "nós olhamos" e o E2404 na própria S) — `isInterruptedInFlight` não a reconhece', async () => {
    const s2 = sibling('S')
    lifeScenario(s2)
    fiscoP({})
    expect(isInterruptedInFlight(s2 as any)).toBe(false)
    expect(await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q', { attempt: 2, fromRun: true })).toMatchObject({ attempt: 2, changed: false, kind: 'S' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(expect.anything(), 1, INVOICE, 2)
  })
  it('contexto: o transmitir com a vigente S → 409 "em andamento" (não reconcilia: o passo 0b também só olha a tentativa SEM voz)', async () => {
    lifeScenario(sibling('S'))
    const out = await settle(transmitServiceInvoice(realDeps(), A, INVOICE))
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS })
    expect(mockHttp.mock.calls.some((c: any[]) => /\/dps\//.test(String(c[0].url)))).toBe(false)
  })
  it('[CONHECIMENTO NEGATIVO — D-F102 (= Q-F108 (a))] irmã S (sem chave) com E2404 e voz S há ≥ IN_FLIGHT_MINUTES → a consulta NÃO a fecha: S não tem saída de propósito (sem produtor). Quem criar produtor de S dá a ela a saída da D-F51 na mesma entrega — e troca este teste pelo veredito F', async () => {
    lifeScenario(sibling('S'))
    fiscoP({})
    // R21-04 do gate da Rodada 21: SEM `settle` — a chamada tem de CHEGAR à decisão (o `settle` deixava o teste verde com o fisco em 503)
    const r = await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q', { attempt: 2, fromRun: true })
    expect(r).toMatchObject({ attempt: 2, changed: false, kind: 'S' })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(expect.anything(), 1, INVOICE, 2)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalledWith(expect.anything(), 1, INVOICE, 2, A.userId, expect.objectContaining({ kind: 'F' }))
  })
  it('resistiu — CERCA da D-F102 (é o que torna o R20-01 LATENTE; quebra no dia em que S ganhar produtor): nenhum produtor de voz S — nem na nfse-api, nem no núcleo, nem na composição de produção do setes-api; o `OUTCOME_KIND` (recusa/credencial) só dá R/F', () => {
    // R21-01 do gate da Rodada 21: a cerca é a peça COMPARTILHADA `voice-kind-fence.ts` — AST (qualquer grafia, comentário fora pelo
    // compilador) sobre TODO lugar que escreve na voz (nfse-api src/scripts/migrations, núcleo, setes-api — pasta + migrations)
    expect(voiceSProducers()).toEqual([])
    const { OUTCOME_KIND } = jest.requireActual('../nfse/transmission') as typeof import('../nfse/transmission')
    expect(Object.values(OUTCOME_KIND).sort()).toEqual(['F', 'F', 'R'])
  })
})

// ===========================================================================
// RESISTIU — as outras irmãs vivas: sem voz (tem saída) e K (não chega à reconferência)
// ===========================================================================

describe('RESISTIU — D-F101 × nfse-api: irmã SEM voz tem saída (D-F51) e irmã K nunca chega à reconferência', () => {
  it('resistiu: irmã SEM voz e velha — a reconferência carimba (needed) e o núcleo diz NÃO PROVADO; a consulta da irmã com E2404 a FECHA com F (D-F51) e, com ela final, a nova candidata (2) prova com o E2404 posterior', async () => {
    const s2 = sibling(null)
    const { f1, life } = lifeScenario(s2)
    fiscoP({})
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, INVOICE)).toMatchObject({ needed: true, found: false, attempt: 1 })
    expect(reconfirmationProven(stamped(f1), life as any)).toBe(false)
    expect(await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q', { attempt: 2, fromRun: true })).toMatchObject({ attempt: 2, changed: true, kind: 'F' })
    const f2 = F({ attempt: 2, createdAt: '2026-10-11 08:00:00', lastEvent: 1, lastEventAt: '2026-10-11 08:20:00' })
    const after = [f1, f2]
    expect(reconfirmationCandidate(after as any)?.attempt).toBe(2)
    expect(reconfirmationProven({ ...f2, nfseNotGeneratedAt: '2026-10-11 08:20:01' } as any, after as any)).toBe(true)
  })
  it('resistiu: irmã K — K só nasce em tentativa AUTORIZADA (com chave): com chave na vida o seletor devolve null, a nfse-api responde "nada a reconferir" SEM perguntar ao fisco (a prova nunca é pedida)', async () => {
    const k2 = sibling('K', { accessKey: KEY, nfseNumber: '123', dhProc: '2026-10-11 08:00:00' })
    lifeScenario(k2)
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, INVOICE)).toEqual({ invoiceId: INVOICE, needed: false, found: false, attempt: null, accessKey: null })
    expect(mockHttp).not.toHaveBeenCalled()
    expect(stamps).toEqual([])
  })
  it('resistiu: o cancelamento no fisco nunca grava K em tentativa SEM chave (fonte: a decisão do cancelamento exige A/N com `accessKey`) — análise estática do produtor', () => {
    const code = uncomment(fs.readFileSync(path.join(SRC_ROOT, 'nfse/transmission.ts'), 'utf8'))
    const k = code.indexOf("kind: 'K'")
    expect(k).toBeGreaterThan(0)
    const before = code.slice(Math.max(0, k - 2500), k)
    expect(before).toMatch(/if \(!tx\.accessKey\) throw new HttpError\(409/)
    expect(before).toMatch(/if \(tx\.lastKind === null \|\| tx\.lastKind === 'S' \|\| tx\.lastKind === 'K'\) throw liveTransmissionError\(tx\)/)
  })
})

// ===========================================================================
// D-F100 — "NADA da resposta alheia é guardado": banco, disco, logs e corpo HTTP — inclusive o blob gzip+base64
// ===========================================================================

const THIRD_CPF = '12345678909'
const FOREIGN_DPS_ID = `DPS41069021000${THIRD_CPF}00001000000000000077`
const ALNUM_CNPJ = '12ABC34501DE35'
const FOREIGN_ALNUM_DPS_ID = `DPS41069022${ALNUM_CNPJ}00001000000000000077`
const foreignXml = (dpsId: string) => nfseXmlOf(KEY).replace(`Id="${DPS_ID}"`, `Id="${dpsId}"`)
const fakeRes = () => { const r: any = {}; r.status = (c: number) => { r.code = c; return r }; r.json = (b: unknown) => { r.payload = b; return r }; return r }
const filesUnder = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]))
/** TUDO o que persiste ou sai: escritas no banco (pool/conn + repositório mockado), arquivo fiscal (disco), logs (índice + núcleo), corpo HTTP. */
function persistedAndEmitted(out: unknown): string {
  const res = fakeRes()
  if (out instanceof Error) sendError(res, out, 'rota')
  const repoWrites = [repo.insertTransmissionEvent, repo.fillAuthorityData, repo.touchQueriedAt, repo.insertTransmission, repo.insertLifeDps]
    .map(m => (m as jest.Mock).mock.calls.map(c => c.slice(1)))
  const disk = filesUnder(storageRoot).map(f => `${f}\n${fs.readFileSync(f, 'utf8')}`)
  return JSON.stringify([res.payload ?? null, (out as any)?.errors ?? null, pool.query.mock.calls, conn.query.mock.calls, repoWrites, disk, allLogs()])
}
const THIRDS = [
  { label: 'CPF', dpsId: FOREIGN_DPS_ID, extra: [THIRD_CPF] },
  { label: 'CNPJ alfanumérico', dpsId: FOREIGN_ALNUM_DPS_ID, extra: [ALNUM_CNPJ, 'ABC34501DE'] },
]
const needlesOf = (dpsId: string, extra: string[]) => {
  const blob = gz(foreignXml(dpsId))
  return [dpsId, ...extra, blob, blob.slice(0, 40), foreignXml(dpsId)]
}

describe('RESISTIU — D-F100: nada da NFS-e de OUTRO DPS persiste nem sai — banco, disco, logs (os dois) e corpo HTTP; agulhas = Id/documento do terceiro E o blob gzip+base64 da resposta', () => {
  it.each(THIRDS)('resistiu: TRANSMITIR (POST /nfse devolve a NFS-e alheia) — terceiro com $label', async ({ dpsId, extra }) => {
    mockHttp.mockImplementation(async (call: HttpsCall) => (call.method === 'POST' && /\/nfse$/.test(call.url) ? ok({ nfseXmlGZipB64: gz(foreignXml(dpsId)) })
      : /convenio/.test(call.url) ? ok({ prazoCancelamentoDias: 365 }) : notFound()))
    const out = await settle(transmitServiceInvoice(realDeps(), A, INVOICE))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(filesUnder(storageRoot).length).toBeGreaterThan(0)                         // o DPS NOSSO foi ao disco (prova que o disco é olhado)
    const hay = persistedAndEmitted(out)
    for (const n of needlesOf(dpsId, extra)) expect(hay).not.toContain(n)
  })
  it.each(THIRDS)('resistiu: CONSULTA da tela (GET /nfse/{chave} devolve a NFS-e alheia) — terceiro com $label', async ({ dpsId, extra }) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    fiscoP({ nfse: () => ok({ nfseXmlGZipB64: gz(foreignXml(dpsId)) }) })
    const out = await settle(refreshServiceTransmission(realDeps(), A, INVOICE, 'Q', { origin: 'consulta' }))
    expect(out).toMatchObject({ statusCode: 502 })
    const hay = persistedAndEmitted(out)
    for (const n of needlesOf(dpsId, extra)) expect(hay).not.toContain(n)
  })
  it.each(THIRDS)('resistiu: passo 0b do TRANSMITIR (reserva interrompida → GET /dps acha a NOSSA chave → a NFS-e vem alheia) — terceiro com $label', async ({ dpsId, extra }) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(inFlight({ ageMinutes: IN_FLIGHT_MINUTES + 5 }))
    fiscoP({ dpsKey: KEY, nfse: () => ok({ nfseXmlGZipB64: gz(foreignXml(dpsId)) }) })
    const out = await settle(transmitServiceInvoice(realDeps(), A, INVOICE))
    expect(out).toMatchObject({ statusCode: 502 })
    const hay = persistedAndEmitted(out)
    for (const n of needlesOf(dpsId, extra)) expect(hay).not.toContain(n)
  })
  it.each(THIRDS)('resistiu: RECONFERÊNCIA (GET /dps acha a chave → a NFS-e vem alheia) — terceiro com $label; nenhum carimbo de prova', async ({ dpsId, extra }) => {
    const f1 = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f1)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1], events: [] })
    fiscoP({ dpsKey: KEY, nfse: () => ok({ nfseXmlGZipB64: gz(foreignXml(dpsId)) }) })
    const out = await settle(reconfirmBeforeLocalCancel(realDeps(), A, INVOICE))
    expect(out).toMatchObject({ statusCode: 502 })
    expect(stamps).toEqual([])
    const hay = persistedAndEmitted(out)
    for (const n of needlesOf(dpsId, extra)) expect(hay).not.toContain(n)
  })
  it('[CORRIGIDO na sessão — S1 / D-F100] o 502 do TRANSMITIR com a resposta TROCADA não leva mais o corpo CRU: `body` VAZIO — nenhuma porta que serialize o erro inteiro carrega o blob gzip+base64 da NFS-e alheia', async () => {
    mockHttp.mockImplementation(async (call: HttpsCall) => (call.method === 'POST' && /\/nfse$/.test(call.url) ? ok({ nfseXmlGZipB64: gz(foreignXml(FOREIGN_DPS_ID)) })
      : /convenio/.test(call.url) ? ok({ prazoCancelamentoDias: 365 }) : notFound()))
    const out = await settle(transmitServiceInvoice(realDeps(), A, INVOICE))
    expect((out as any).body).toBe('')
    expect(JSON.stringify(out)).not.toContain(gz(foreignXml(FOREIGN_DPS_ID)))
    expect(JSON.stringify(out)).not.toContain(THIRD_CPF)
  })
  it('resistiu: cerca — nenhum log da nfse-api/núcleo leva o erro INTEIRO nem o corpo/texto/raw da resposta como valor (só `errMsg(err)`, `err.message`/`stack`, `err.code`, status ou tamanho do corpo); a única exceção é a conexão do pool (erro do driver, sem resposta do fisco)', () => {
    const roots = [SRC_ROOT, path.join(WORKSPACE, 'fiscal-api', 'src')]
    const offenders: string[] = []
    for (const f of roots.flatMap(walkTs)) {
      const code = uncomment(fs.readFileSync(f, 'utf8'))
      for (const m of code.matchAll(/logger\.(?:info|warn|error)\(/g)) {
        // o argumento inteiro da chamada (parênteses balanceados), sem o conteúdo das strings
        let depth = 1, i = m.index! + m[0].length
        while (i < code.length && depth > 0) { const ch = code[i++]; if (ch === '(') depth += 1; else if (ch === ')') depth -= 1 }
        const args = code.slice(m.index! + m[0].length, i - 1).replace(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g, "''")
        const safe = args.replace(/errMsg\([^)]*\)/g, 'X').replace(/Buffer\.byteLength\([^)]*\)/g, 'X')
        // o erro vai INTEIRO como valor (`{ err }`, `err: err`, `, error)`) — o `.body` cru iria junto
        // (dentro de chamada — `String(err)`, `ambiguousCauseOf(err)` — não conta: só o valor de campo ou o argumento direto do log)
        const bare = /[:{,]\s*(?:err|error|aerr|touchErr)\s*(?=[,})])/.test(safe)
        // o corpo/texto/raw da resposta vai como valor
        const raw = /\.body\b|[:{,]\s*(?:text|raw|body|data)\s*(?=[,})])/.test(safe)
        if (bare || raw) offenders.push(`${path.relative(WORKSPACE, f).replace(/\\/g, '/')} :: ${args.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    // a ÚNICA exceção: pool.ts — conexão nova sem invariante (erro do DRIVER, nunca resposta do fisco)
    expect(offenders).toEqual([expect.stringMatching(/^fiscal-api\/src\/db\/pool\.ts :: /)])
  })
})
