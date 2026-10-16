/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 19 das APIs fiscais (D-F98…D-F99, Valdo 2026-10-11) — nfse-api (+ núcleo fiscal-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F98 (= Q-F104 (b)+(c)) — todo ambíguo (502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE) nasce marcado com uma CAUSA da lista
// FECHADA (`tagAmbiguous` no `unknownResponse` do `authority/adn.ts`, no 401/403 de evento, e na composição `nfse/transmission.ts` —
// "OUTRO DPS" e "situação ilegível"); o alarme `logAmbiguousFiscal` leva `reason = ambiguousCauseOf(err)`; a mensagem "NFS-e de OUTRO
// DPS" não interpola mais o Id do terceiro (nem no 502 ao app, nem no warn do adaptador). D-F99 (= Q-F105 (b)) é do núcleo — aqui só a
// composição com a nfse-api (a reserva morta ganha voz sozinha?).
//
//  * ACHADOS (`it.failing('[SEV R19-xx] …')`) — o teste afirma o que a spec/decisão promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo) e prova
//    que o cenário do `it.failing` vizinho monta de verdade (o `it.failing` só afirma a última coisa).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo trocado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r18-gate.test.ts`), nenhuma migration, nada que fale com o fisco.
// ⚠️ O log do TRANSPORTE é o `logger` REAL do núcleo (`fiscal-api/src/log/logger.ts`) — o mock do índice `fiscal-api` não o pega
// (o "NENHUM log" do R18-02 olhava só o do índice); aqui os dois são capturados (`allLogs`).
import { setesApiPathUntilF2a, setesApiSources, relWorkspace } from './voice-kind-fence'   // D-F117: SETES_API_DIR, falha alto
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r19-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const INVOICE_B = 6201
const CNPJ = '12345678000195'
// Gate R19 (R19-03): a chave de teste segue o layout REAL (conferido nas 3 chaves de produção em 2026-10-11) — cMun(7) + ambGer(1) +
// tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1); a antiga não tinha o tpInsc e o GET /dps agora confere o emitente
const KEY = '4106902' + '2' + '2' + '12345678000195' + '0000000000123' + '2609' + '000012345' + '1'
const KEY_B = `${KEY.slice(0, -1)}8`
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const nfseXmlOf = (key: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-10-10 21:43:04', createdAt: '2026-10-10 21:43:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})
/** F "envio interrompido" por CONSULTA em PRODUÇÃO — a candidata da reconferência (D-F29). */
const F = (over: any = {}) => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2,
  lastEventAt: '2026-10-09 10:00:00', lastQueriedAt: '2026-10-09 10:00:00', ...over })
/** Tentativa EM VOO recente (sem voz, < IN_FLIGHT_MINUTES) em PRODUÇÃO. */
const inFlight = (over: any = {}) => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastEvent: null, lastKind: null,
  lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null, ageMinutes: 2, ...over })

// ---------------------------------------------------------------------------
// A "tabela" da tentativa em memória: o UPDATE do escritor da D-F90 é avaliado contra a última voz VIVA da tentativa
// (o que o subselect `COALESCE(MAX(e.event), 0)` lê no banco) — `maxEvent` muda quando um escritor concorrente grava voz.
// ---------------------------------------------------------------------------
let maxEvent = 0
let stamps: { attempt: number; seen: number }[] = []
let refusedStamps = 0
const notGeneratedWrites = () => pool.query.mock.calls.filter((c: any[]) => /nfse_not_generated_at = NOW\(\)/.test(String(c[0])))

let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  maxEvent = 0; stamps = []; refusedStamps = 0
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/nfse_not_generated_at = NOW\(\)/.test(sql)) {
      const ok = Number(params[3]) === maxEvent
      if (ok) stamps.push({ attempt: Number(params[2]), seen: Number(params[3]) }); else refusedStamps += 1
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

// ---------------------------------------------------------------------------
// A Sefin REAL (D-F61) pelo transporte do NÚCLEO — nenhum socket (molde do r15 da nfse-api)
// ---------------------------------------------------------------------------
import { transport, HttpsCall, reconfirmationCandidate, reconfirmationProven, ErrorCodes } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { refreshOpenServiceTransmissions, reconfirmBeforeLocalCancel } from '../nfse/transmission'

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset() })

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const arquivo2 = (x: string) => b64(gzipSync(Buffer.from(x, 'utf8')).toString('base64'))
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const typedItemRaw = (xml: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: arquivo2(xml) })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
function generatedEventXml(o: { key?: string; code?: string; inner?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${key}${code}001"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-10-10T18:43:05-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo>${o.inner ?? ''}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}
const item = (code: string, o: { key?: string; inner?: string } = {}) => typedItemRaw(generatedEventXml({ code, key: o.key, inner: o.inner }), code, o.key ?? KEY)
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
const ctxP = { environment: 'P' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const E2404 = (tipoAmbiente?: number) => ({ status: 404, headers: {}, text: JSON.stringify({
  ...(tipoAmbiente === undefined ? {} : { tipoAmbiente, versaoAplicativo: 'SefinNacional_1.6.0', dataHoraProcessamento: '2026-10-11T10:00:00-03:00' }),
  erro: { codigo: 'E2404', descricao: 'Não foi gerada uma NFS-e com o identificador de DPS informado' } }) })

/** A Sefin falsa: `/dps/{id}` (+ gancho `onDps` para simular o escritor concorrente), `/nfse/{chave}` por chave, GET tipado por chave+código. */
function fisco(o: { typed?: (code: string, key: string) => any; dpsKey?: string | null; dps?: () => any; onDps?: () => void; nfse?: (key: string) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) { o.onDps?.(); return o.dps?.() ?? (o.dpsKey ? ok({ chaveAcesso: o.dpsKey }) : E2404(1)) }
    const typed = call.url.match(/\/nfse\/(\d+)\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[2], typed[1])) ?? sefinNone()
    const nf = call.url.match(/\/nfse\/(\d+)$/)
    if (nf) return o.nfse?.(nf[1]) ?? ok({ nfseXmlGZipB64: gz(nfseXmlOf(nf[1])) })
    return notFound()
  })
}
const ambiguousLogs = () => ((fiscal.logger as any).error as jest.Mock).mock.calls.filter((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))

// ===========================================================================
// Ferramentas da Rodada 17 (+ fixtures do transmitir, molde do transmission.test.ts)
// ===========================================================================
import { HttpError, AuthorityHttpError } from 'fiscal-api'
import { transmitServiceInvoice, logAmbiguousFiscal, IN_FLIGHT_MINUTES } from '../nfse/transmission'
import { webRef, WEB, webScope, itxLike } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

const origins = () => ambiguousLogs().map((c: any[]) => c[1]?.origin)
const unknownBoom = () => new HttpError(502, 'Fisco respondeu sem situação legível para a NFS-e', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, '')
/** GET tipado contraditório (D-F84): e101101 + e105102 desta chave na rota 101101 → 502 ambíguo. */
const CONTRA = (code: string) => (code === '101101' ? typedOk(item('101101'), item('105102')) : undefined)
/** CPF fictício (dígitos verificadores válidos) de um PRESTADOR pessoa física — um TERCEIRO (tpInsc 1 no Id do DPS). */
const THIRD_CPF = '12345678909'
const FOREIGN_DPS_ID = `DPS41069021000${THIRD_CPF}00001000000000000077`
const nfseXmlWithDps = (key: string, dpsId: string) => nfseXmlOf(key).replace(`Id="${DPS_ID}"`, `Id="${dpsId}"`)
const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? '12345678000195' : '98765432000198', im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
let headerRow: any
beforeEach(() => {
  // o transmitir lê a nota/ramo do ERP pela fonte de fatos: o pool/conn falsos do r16 ganham a nota (o resto delega)
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
/** Reconferência em P com a candidata F (tentativa 1, voz 2) — o estado de partida dos ataques à reconferência. */
function reconfirmScenario(f = F()) {
  maxEvent = 2
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
  return f
}
const orderIndependent = async (a: string, b: string) => {
  mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(a), typedItemRaw(b)) : undefined) })
  const ab = await adnAdapter.queryNfse(ctxH as any, KEY)
  mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(b), typedItemRaw(a)) : undefined) })
  const ba = await adnAdapter.queryNfse(ctxH as any, KEY)
  return { ab, ba, ok: (ab.status === 'unknown' && ba.status === 'unknown') || ab.cancelled?.eventXml === ba.cancelled?.eventXml }
}

// ===========================================================================
// Ferramentas da Rodada 18
// ===========================================================================

/** D-F95: a consulta pedida pela TELA (rota POST /v1/nfse/invoices/:id/refresh) diz a origem. */
const SCREEN = { origin: 'consulta' as const }
/** CNPJ ALFANUMÉRICO (formato da RFB para inscrições NOVAS desde 07/2026: 12 posições alfanuméricas + 2 DV numéricos) — exemplo da RFB. */
const ALNUM_CNPJ = '12ABC34501DE35'
/** Id de DPS de um TERCEIRO com CNPJ alfanumérico (tpInsc 2) — o que a resposta TROCADA traz no `infDPS/@Id`. */
const FOREIGN_ALNUM_DPS_ID = `DPS41069022${ALNUM_CNPJ}00001000000000000077`
const reasonOf = (i = 0) => String(ambiguousLogs()[i]?.[1]?.reason ?? '')
const foreignVoice = (dpsId: string) => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: nfseXmlWithDps(KEY, dpsId), dhProc: '2026-09-21T10:15:30-03:00' })
const interrupted = () => inFlight({ ageMinutes: IN_FLIGHT_MINUTES + 5 })
const logger = fiscal.logger as unknown as Record<'info' | 'warn' | 'error', jest.Mock>
const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
/** Cada chamada `refreshServiceTransmission(` fora dos testes, com a função que a contém e QUEM registra o ambíguo dela. */

// ===========================================================================
// Ferramentas da Rodada 19
// ===========================================================================
const { AMBIGUOUS_CAUSES, ambiguousCauseOf, tagAmbiguous } = fiscal
/** Regra da D-F85 (`sameIssuerKey` — PRIVADA em nfse/transmission.ts, usada só na substituta): tpInsc + inscrição = posições 8..22 da chave. */
const sameIssuerOf = (a: string, b: string) => a.length === 50 && b.length === 50 && a.slice(8, 23) === b.slice(8, 23)

/** O log REAL do núcleo: o transporte (`fiscal-api/src/transport/https-json.ts`) loga por ELE, não pelo `logger` do mock do índice. */
const coreLogger = (jest.requireActual('fiscal-api') as typeof fiscal).logger
beforeEach(() => {
  jest.spyOn(coreLogger, 'info').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'warn').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'error').mockImplementation(() => undefined)
})
afterEach(() => { (coreLogger.info as jest.Mock).mockRestore?.(); (coreLogger.warn as jest.Mock).mockRestore?.(); (coreLogger.error as jest.Mock).mockRestore?.() })
/** Todo texto que saiu por log — o do índice (mock) e o do núcleo (transporte). */
const allLogs = () => JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls,
  (coreLogger.info as jest.Mock).mock.calls, (coreLogger.warn as jest.Mock).mock.calls, (coreLogger.error as jest.Mock).mock.calls])
const causeOf = (i = 0) => ambiguousLogs()[i]?.[1]?.reason
/** Chave de 50 dígitos de OUTRO emitente — prestador PF (tpInsc 1, inscrição = 000 + CPF do terceiro). */
const FOREIGN_KEY = `4106902${'1'}${'1'}000${THIRD_CPF}${'0000000000077'}2610${'000000000'}1`
/** "Não há esse evento" na forma cravada para PRODUÇÃO (tipoAmbiente 1 — L8: o envelope tem de ser do ambiente perguntado). */
const sefinNoneP = () => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente: 1 }) })
/** A Sefin falsa em PRODUÇÃO (tentativas em P: reserva interrompida, candidata da reconferência). */
const fiscoP = (o: Parameters<typeof fisco>[0] = {}) => fisco({ typed: () => sefinNoneP(), ...o })
const foreignNfse = (dpsId: string) => ok({ nfseXmlGZipB64: gz(nfseXmlWithDps(KEY, dpsId)) })
const THIRD_PARTIES = [
  { label: 'CPF', dpsId: FOREIGN_DPS_ID, needles: [THIRD_CPF, FOREIGN_DPS_ID] },
  { label: 'CNPJ alfanumérico', dpsId: FOREIGN_ALNUM_DPS_ID, needles: [ALNUM_CNPJ, FOREIGN_ALNUM_DPS_ID, 'ABC34501DE', 'ABC'] },
]
/** Tudo o que a porta produziu: mensagem/campos do erro, relatório, logs (os dois), vozes e escritas do fisco. */
const haystack = (out: any) => JSON.stringify([out?.message ?? null, out?.fields ?? null, out?.errors ?? null, out, allLogs(),
  (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c.slice(1)), (repo.fillAuthorityData as jest.Mock).mock.calls.map(c => c.slice(1))])

// ===========================================================================
// ACHADO — falha no código atual (prova do bug); passa depois da correção
// ===========================================================================

describe('ACHADO R19-03 (LOW, fora do delta — a mesma classe do R18-02, por outra porta) — a chave que o `GET /dps/{id}` devolve NÃO é conferida contra o emitente da nota (`authority/adn.ts` `queryDpsAccessKey` aceita `chaveAcesso`/`chave` ou QUALQUER 50 dígitos do corpo); numa resposta TROCADA a chave é de OUTRO emitente — e a chave EMBUTE o CPF/CNPJ dele. Ela vira URL do `GET /nfse/{chave}` e, se essa consulta falha (405 ou rede), o transporte do núcleo grava a URL no log (`fiscal-api/src/transport/https-json.ts` — warn "Fisco indisponível" / error "Contrato do fisco divergente"). A peça que confere emitente já existe (`sameIssuerKey`, D-F85) e não é usada aqui', () => {
  const inFlightP = () => inFlight({ attempt: 1, ageMinutes: 2 })
  it('[CORRIGIDO na sessão — R19-03] consulta da tela de tentativa SEM chave → GET /dps devolve a chave do TERCEIRO → 502 `dps-fora-do-contrato` ANTES de perguntar por ela; nenhum log (nem o do transporte) leva o documento', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(inFlightP())
    fiscoP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ({ status: 405, headers: { allow: 'POST' }, text: '' }) })
    const out = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(mockHttp.mock.calls.some((c: any[]) => String(c[0].url).endsWith(`/nfse/${FOREIGN_KEY}`))).toBe(false)
    expect(causeOf()).toBe('dps-fora-do-contrato')
    expect(JSON.stringify(ambiguousLogs())).not.toContain(THIRD_CPF)
    expect(allLogs()).not.toContain(THIRD_CPF)
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] a chave de OUTRO emitente vinda do GET /dps nunca é perguntada ao fisco (falha FECHADO antes: ambígua `dps-fora-do-contrato`)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(inFlightP())
    fiscoP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ({ status: 405, headers: {}, text: '' }) })
    await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(mockHttp.mock.calls.some((c: any[]) => String(c[0].url).includes(FOREIGN_KEY))).toBe(false)
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] …e NENHUM log (nem o do transporte) leva o documento do terceiro — 405 e falha de rede na consulta pela chave dele', async () => {
    for (const nfse of [() => ({ status: 405, headers: {}, text: '' }), () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }]) {
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(inFlightP())
      mockHttp.mockReset(); fiscoP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse })
      await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))
    }
    expect(allLogs()).not.toContain(THIRD_CPF)
  })
  it('[CORRIGIDO na sessão] [LOW R19-03] (implausível — a NFS-e real sempre embute o DPS — mas a MESMA correção fecha) reconferência: GET /dps devolve a chave do terceiro e a NFS-e dele vem SEM o `infDPS/@Id` → a chave alheia NUNCA pousa na nossa tentativa (hoje: `fillAuthorityData` + voz A com a chave do terceiro)', async () => {
    reconfirmScenario()
    const noDps = nfseXmlOf(FOREIGN_KEY).replace(/<DPS>[\s\S]*<\/DPS>/, '')
    fiscoP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ok({ nfseXmlGZipB64: gz(noDps) }) })
    await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(JSON.stringify((repo.fillAuthorityData as jest.Mock).mock.calls.map(c => c.slice(1)))).not.toContain(FOREIGN_KEY)
  })
  it('[CORRIGIDO na sessão — R19-03] o cenário "implausível" — a chave do terceiro NÃO pousa na tentativa 1 e nenhuma voz nasce com ela', async () => {
    reconfirmScenario()
    const noDps = nfseXmlOf(FOREIGN_KEY).replace(/<DPS>[\s\S]*<\/DPS>/, '')
    fiscoP({ dps: () => ok({ chaveAcesso: FOREIGN_KEY }), nfse: () => ok({ nfseXmlGZipB64: gz(noDps) }) })
    await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(JSON.stringify((repo.fillAuthorityData as jest.Mock).mock.calls)).not.toContain(FOREIGN_KEY)
    expect(JSON.stringify((repo.insertTransmissionEvent as jest.Mock).mock.calls)).not.toContain(FOREIGN_KEY)
  })
  it('contexto: a peça de conferência do emitente pela chave existe (D-F85 — tpInsc + inscrição) e reconhece a chave alheia', () => {
    // D-CJ7 (frente do CNPJ alfanumérico): o recorte posicional saiu de transmission.ts e do adaptador para UMA peça (`authority/access-key.ts`)
    expect(uncomment(fs.readFileSync(path.join(SRC_ROOT, 'nfse/transmission.ts'), 'utf8'))).toMatch(/function sameIssuerKey\(a: string, b: string\): boolean \{\s*return sameEmbeddedIssuer\(issuerOfAccessKey\(a\), issuerOfAccessKey\(b\)\)/)
    expect(uncomment(fs.readFileSync(path.join(SRC_ROOT, 'authority/access-key.ts'), 'utf8'))).toMatch(/return \{ tpInsc: key\[8\], inscricao: key\.slice\(9, 23\) \}/)
    expect(sameIssuerOf(KEY, KEY)).toBe(true)
    expect(sameIssuerOf(KEY, FOREIGN_KEY)).toBe(false)
  })
})

// ===========================================================================
// RESISTIU — D-F98: cerca estática + a marca sobrevive a TODO caminho real até o alarme
// ===========================================================================

/** Cada ocorrência de `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` no código (sem comentários) — molde da cerca do r19 do núcleo. */
type Site = { file: string; kind: 'definicao' | 'comparacao' | 'conjunto' | 'produtor' | 'DESCONHECIDO'; tagged?: boolean; cause?: string | null }
function ambiguousSites(roots: string[], base: string): Site[] {
  const out: Site[] = []
  for (const f of roots.flatMap(walkTs)) {
    const code = uncomment(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(base, f).replace(/\\/g, '/')
    const re = /FISCAL_AUTHORITY_UNKNOWN_RESPONSE/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1
      const nl = code.indexOf('\n', m.index)
      const line = code.slice(lineStart, nl === -1 ? undefined : nl)
      if (/^\s*FISCAL_AUTHORITY_UNKNOWN_RESPONSE\s*:/.test(line)) { out.push({ file: rel, kind: 'definicao' }); continue }
      const before = code.slice(Math.max(0, m.index - 600), m.index)
      if (/(===|!==)\s*(ErrorCodes\.)?$/.test(before)) { out.push({ file: rel, kind: 'comparacao' }); continue }
      const ctor = Math.max(before.lastIndexOf('new HttpError('), before.lastIndexOf('new AuthorityHttpError('))
      // o texto entre o construtor e o código, sem o conteúdo das strings (mensagem com ';' não fecha a instrução)
      const between = ctor >= 0 ? before.slice(ctor).replace(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g, "''") : ''
      if (ctor >= 0 && !/;|\n\s*\n/.test(between)) {
        const tagged = /tagAmbiguous\($/.test(before.slice(0, ctor).replace(/\s+$/, ''))
        const cause = tagged ? (code.slice(m.index, m.index + 400).match(/^[^;]*?\)\s*,\s*(?:(?:nfse\.unknownCause \?\? )?'([^']*)'|(cause))\s*\)/)?.slice(1).find(Boolean) ?? null) : null
        out.push({ file: rel, kind: 'produtor', tagged, cause })
        continue
      }
      if (/new Set[^;]*$/.test(before)) { out.push({ file: rel, kind: 'conjunto' }); continue }
      out.push({ file: rel, kind: 'DESCONHECIDO' })
    }
  }
  return out
}
const unknownResponseCauses = (file: string) => [...uncomment(fs.readFileSync(file, 'utf8')).matchAll(/unknownResponse\(\s*([^,\s)]+)/g)].map(m => m[1])
const causePairs = (file: string) => [...uncomment(fs.readFileSync(file, 'utf8')).matchAll(/unknownResponse\('([a-z-]+)',\s*([^,]+),/g)].map(m => `${m[1]} :: ${m[2]}`)

describe('RESISTIU — D-F98: cerca estática da nfse-api (todo produtor do ambíguo é marcado com causa da lista)', () => {
  it('resistiu: todo `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` produzido em nfse-api/src (fora dos testes) nasce DENTRO de `tagAmbiguous(…, causa)`; nenhuma outra forma de produzir o código', () => {
    const sites = ambiguousSites([SRC_ROOT], PROJECT_ROOT)
    expect(sites.filter(s => s.kind === 'DESCONHECIDO')).toEqual([])
    const producers = sites.filter(s => s.kind === 'produtor')
    expect(producers.filter(p => !p.tagged)).toEqual([])
    expect(producers.map(p => `${p.file} :: ${p.cause}`).sort()).toEqual([
      'src/authority/adn.ts :: cause',                            // o `unknownResponse(cause, …)` — conferido abaixo
      'src/authority/adn.ts :: evento-recusado',
      'src/nfse/transmission.ts :: nfse-chave-divergente',     // D-CJ19 (2026-10-16): chave de OUTRO emitente que o DPS — pasta/autor nunca alheios
      'src/nfse/transmission.ts :: nfse-de-outro-dps',
      'src/nfse/transmission.ts :: situacao-ilegivel',
    ])
  })
  it('[gate R19 — S3] toda `unknownCause:` do adaptador é LITERAL da lista FECHADA (a composição marca com ela; a reserva é `situacao-ilegivel`)', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'authority/adn.ts'), 'utf8')
    const causes = [...src.matchAll(/unknownCause:\s*([^,}\s]+)/g)].map(m => m[1])
    expect(causes.length).toBeGreaterThanOrEqual(6)
    for (const c of causes) {
      expect(c).toMatch(/^'[a-z-]+'$/)
      expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(c.slice(1, -1))
    }
  })
  it('resistiu: toda chamada de `unknownResponse(` passa uma causa LITERAL da lista FECHADA (nunca `nao-classificada`, nunca variável)', () => {
    const causes = unknownResponseCauses(path.join(SRC_ROOT, 'authority/adn.ts')).filter(c => c !== 'cause:')
    expect(causes.length).toBeGreaterThan(0)
    for (const c of causes) {
      expect(c).toMatch(/^'[a-z-]+'$/)
      expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(c.slice(1, -1))
    }
  })
  it('resistiu: ESPELHO — os pares (causa, rótulo) do adaptador da nfse-api são os MESMOS do adaptador do setes-api (caminho de produção até a F2a); com a F2a aplicada o adaptador do setes-api MORREU e nada dele sobra', () => {
    // D-F117 revisto na A3 da F2a: o espelho existe até a A3 (que o remove); depois, nenhum adaptador/causa do ambíguo no setes-api (nota (3))
    const mirror = setesApiPathUntilF2a('src', 'shared', 'tax-authority', 'adapters', 'adn.ts')
    if (!mirror) {
      const left = setesApiSources().filter(f => /AMBIGUOUS_CAUSES|tagAmbiguous|logAmbiguousFiscal|adnAdapter|\/SefinNacional\//.test(fs.readFileSync(f, 'utf8')))
      expect(left.map(relWorkspace)).toEqual([])
      return
    }
    expect(causePairs(path.join(SRC_ROOT, 'authority/adn.ts'))).toEqual(causePairs(mirror))
  })
})

describe('RESISTIU — D-F98: a causa chega ao alarme por TODO caminho real (adaptador ADN real + transporte trocado) — nenhum `nao-classificada`', () => {
  const nfseXmlNoIds = () => nfseXmlOf(KEY).replace(/ Id="[^"]*"/g, '')
  const consulta: [string, string, () => void][] = [
    ['2xx sem a NFS-e', 'envelope-ilegivel', () => fisco({ nfse: () => ok({}) })],
    ['NFS-e ilegível (entidade fora do Unicode)', 'nfse-ilegivel', () => fisco({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY).replace('<nNFSe>123</nNFSe>', '<nNFSe>&#x110000;</nNFSe>')) }) })],
    ['NFS-e de OUTRA chave', 'nfse-chave-divergente', () => fisco({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_B)) }) })],
    ['NFS-e sem identidade', 'nfse-sem-identidade', () => fisco({ nfse: () => ok({ nfseXmlGZipB64: gz(nfseXmlNoIds()) }) })],
    ['NFS-e de OUTRO DPS', 'nfse-de-outro-dps', () => fisco({ nfse: () => foreignNfse(FOREIGN_DPS_ID) })],
    ['evento: 404 em HTML', 'evento-fora-do-contrato', () => fisco({ typed: () => ({ status: 404, headers: {}, text: '<html>not found</html>' }) })],
    ['evento: 2xx sem a lista', 'evento-fora-do-contrato', () => fisco({ typed: () => ok({ ...SEFIN }) })],
    ['evento: 401 na rota do evento', 'evento-recusado', () => fisco({ typed: () => ({ status: 401, headers: {}, text: '' }) })],
    ['evento: 405 na rota do evento', 'rota-nao-atendida', () => fisco({ typed: () => ({ status: 405, headers: {}, text: '' }) })],
    ['eventos contraditórios', 'evento-contraditorio', () => fisco({ typed: CONTRA })],
  ]
  it.each(consulta)('resistiu: consulta da TELA — %s → UM alarme "consulta" com a causa `%s`', async (_l, cause, arrange) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    arrange()
    expect(await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(causeOf()).toBe(cause)
  })
  const zeroB: [string, string, () => void][] = [
    ['GET /dps 404 sem a forma do fisco', 'dps-fora-do-contrato', () => fiscoP({ dps: () => notFound() })],
    ['GET /dps 2xx sem chave', 'dps-fora-do-contrato', () => fiscoP({ dps: () => ok({ algo: 1 }) })],
    ['GET /dps 405', 'rota-nao-atendida', () => fiscoP({ dps: () => ({ status: 405, headers: {}, text: '' }) })],
    ['GET /dps acha a chave e a NFS-e é de OUTRO DPS', 'nfse-de-outro-dps', () => fiscoP({ dpsKey: KEY, nfse: () => foreignNfse(FOREIGN_ALNUM_DPS_ID) })],
  ]
  it.each(zeroB)('resistiu: passo 0b do TRANSMITIR — %s → nada reservado, UM alarme "transmissao" com a causa `%s`', async (_l, cause, arrange) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    arrange()
    expect(await settle(transmitServiceInvoice(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(origins()).toEqual(['transmissao'])
    expect(causeOf()).toBe(cause)
  })
  it('resistiu: RODÍZIO — NFS-e de OUTRO DPS e rota 405 → relatório 502, alarme "rodizio" com a causa, carimbo da vez', async () => {
    for (const [arrange, cause] of [[() => fisco({ nfse: () => foreignNfse(FOREIGN_DPS_ID) }), 'nfse-de-outro-dps'], [() => fisco({ nfse: () => ({ status: 405, headers: {}, text: '' }) }), 'rota-nao-atendida']] as const) {
      ;(fiscal.logger.error as jest.Mock).mockClear(); (repo.touchQueriedAt as jest.Mock).mockClear(); mockHttp.mockReset()
      const t = tx({ lastKind: 'A' })
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
      ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([t])
      arrange()
      const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
      expect(r.errors).toEqual([expect.objectContaining({ invoiceId: INVOICE, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })])
      expect(origins()).toEqual(['rodizio'])
      expect(causeOf()).toBe(cause)
      expect(repo.touchQueriedAt).toHaveBeenCalled()
    }
  })
  it('resistiu: RECONFERÊNCIA — GET /dps 405 e NFS-e de OUTRO DPS → UM alarme "reconferencia" com a causa; nenhum carimbo de prova', async () => {
    for (const [arrange, cause] of [[() => fiscoP({ dps: () => ({ status: 405, headers: {}, text: '' }) }), 'rota-nao-atendida'], [() => fiscoP({ dpsKey: KEY, nfse: () => foreignNfse(FOREIGN_DPS_ID) }), 'nfse-de-outro-dps']] as const) {
      ;(fiscal.logger.error as jest.Mock).mockClear(); mockHttp.mockReset(); stamps = []
      reconfirmScenario()
      arrange()
      expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
      expect(origins()).toEqual(['reconferencia'])
      expect(causeOf()).toBe(cause)
      expect(stamps).toEqual([])
    }
  })
  it('resistiu: a transação que FALHA no rollback (conexão caída) não troca o erro — o `withTransaction` do núcleo engole a falha do rollback e o ambíguo (`situacao-ilegivel`, lançado DENTRO da transação) chega ao alarme com a causa', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: nfseXmlOf(KEY), dhProc: '2026-09-21T10:15:30-03:00' })
    conn.rollback.mockRejectedValueOnce(new Error('Connection lost: The server closed the connection.'))
    expect(await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(causeOf()).toBe('situacao-ilegivel')
  })
  it('resistiu: re-embrulho fora da lista não forja causa — o alarme lê `nao-classificada` de um 502 sem marca (o alarme continua, sem texto)', () => {
    logAmbiguousFiscal('consulta', { institutionId: 1, invoiceId: INVOICE }, new HttpError(502, `NFS-e de ${FOREIGN_ALNUM_DPS_ID}`, undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE))
    logAmbiguousFiscal('consulta', { institutionId: 1, invoiceId: INVOICE }, tagAmbiguous(new HttpError(502, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE), FOREIGN_ALNUM_DPS_ID as any))
    expect([causeOf(0), causeOf(1)]).toEqual(['nao-classificada', 'nao-classificada'])
    expect(JSON.stringify(ambiguousLogs())).not.toContain('ABC')
    expect(ambiguousCauseOf(undefined)).toBe('nao-classificada')
  })
})

// ===========================================================================
// RESISTIU — D-F98 (c): a NFS-e de OUTRO DPS (CPF e CNPJ ALFANUMÉRICO do terceiro) por TODAS as portas — nada do terceiro sai
// ===========================================================================

describe('RESISTIU — D-F98 (c): nenhuma porta leva Id/CPF/CNPJ/letras do terceiro — mensagem HTTP, relatório, logs (índice E transporte), vozes', () => {
  it.each(THIRD_PARTIES)('resistiu: POST /nfse (transmitir) devolve a NFS-e de OUTRO DPS — terceiro com $label → 502 ambíguo, nenhuma voz, nada do terceiro em lugar nenhum', async ({ dpsId, needles }) => {
    mockHttp.mockImplementation(async (call: HttpsCall) => (call.method === 'POST' && /\/nfse$/.test(call.url) ? foreignNfse(dpsId) : /convenio/.test(call.url) ? ok({ prazoCancelamentoDias: 365 }) : notFound()))
    const out = await settle(transmitServiceInvoice(realDeps(), A, webRef(A, INVOICE)))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(ambiguousCauseOf(out)).toBe('nfse-de-outro-dps')
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: consulta da TELA — terceiro com $label', async ({ dpsId, needles }) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    fisco({ nfse: () => foreignNfse(dpsId) })
    const out = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: passo 0b do TRANSMITIR — terceiro com $label', async ({ dpsId, needles }) => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    fiscoP({ dpsKey: KEY, nfse: () => foreignNfse(dpsId) })
    const out = await settle(transmitServiceInvoice(realDeps(), A, webRef(A, INVOICE)))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()                      // nenhuma voz F com o Id alheio
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: RODÍZIO — terceiro com $label (o relatório leva a mensagem — sem o Id)', async ({ dpsId, needles }) => {
    const t = tx({ lastKind: 'A' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([t])
    fisco({ nfse: () => foreignNfse(dpsId) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r.errors).toHaveLength(1)
    const hay = haystack(r)
    for (const n of needles) expect(hay).not.toContain(n)
  })
  it.each(THIRD_PARTIES)('resistiu: RECONFERÊNCIA — terceiro com $label', async ({ dpsId, needles }) => {
    reconfirmScenario()
    fiscoP({ dpsKey: KEY, nfse: () => foreignNfse(dpsId) })
    const out = await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(causeOf()).toBe('nfse-de-outro-dps')
    const hay = haystack(out)
    for (const n of needles) expect(hay).not.toContain(n)
  })
})

// ===========================================================================
// RESISTIU — D-F99 composta com a nfse-api: a reserva MORTA não prende a prova para sempre
// ===========================================================================

describe('RESISTIU — D-F99 × reserva morta: a tentativa sem voz ganha voz sozinha (D-F51) — a prova volta pela próxima reconferência', () => {
  it('resistiu: o rodízio REVISITA a tentativa sem voz (SQL real das candidatas: `le.kind IS NULL` com a reserva mais velha que o mínimo)', async () => {
    let sql = ''
    const actual = jest.requireActual('../nfse/repository') as typeof repo
    await actual.listRefreshCandidates({ query: async (s: string) => { sql = s; return [[]] } } as any, 'setes_setes', webScope(1), 5, IN_FLIGHT_MINUTES, 8)
    expect(sql.replace(/\s+/g, ' ')).toMatch(/le\.kind IS NULL AND t\.created_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/)
  })
  it('resistiu: vida = [F por consulta (1), reserva MORTA (2, sem voz há > 10 min)] → a prova não passa; a consulta da 2 (rodízio) pergunta o GET /dps, ouve E2404 e FECHA a 2 com F (D-F51); a nova candidata é a 2 e o E2404 POSTERIOR ao F dela prova', async () => {
    const f1 = F({ attempt: 1, lastEventAt: '2026-10-09 10:00:00', nfseNotGeneratedAt: '2026-10-11 10:00:02' })
    const dead = inFlight({ attempt: 2, createdAt: '2026-10-11 09:00:00', ageMinutes: IN_FLIGHT_MINUTES + 50 })
    expect(reconfirmationProven(f1 as any, [f1, dead] as any)).toBe(false)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(dead)
    fiscoP({})                                                                         // GET /dps → E2404 (tipoAmbiente 1 = P)
    expect(await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', { attempt: 2, fromRun: true })).toMatchObject({ attempt: 2, changed: true, kind: 'F' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(itxLike(expect.anything(), 1, INVOICE), 2, A.userId, expect.objectContaining({ kind: 'F', source: 'Q' }))
    const f2 = F({ attempt: 2, createdAt: '2026-10-11 09:00:00', lastEventAt: '2026-10-11 10:30:00' })
    const life = [f1, f2]
    expect(reconfirmationCandidate(life as any)?.attempt).toBe(2)
    expect(reconfirmationProven({ ...f2, nfseNotGeneratedAt: '2026-10-11 10:30:01' } as any, life as any)).toBe(true)
  })
})
