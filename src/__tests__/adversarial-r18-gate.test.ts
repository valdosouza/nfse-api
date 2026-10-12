/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 18 das APIs fiscais (D-F94…D-F97, Valdo 2026-10-11 "siga as recomendações") — nfse-api (+ núcleo
// fiscal-api). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F94 (`logAmbiguousFiscal` leva `code` + `reason` = mensagem com os dígitos trocados por `#`), D-F95 (origem
// EXPLÍCITA: o invólucro do `refreshServiceTransmission` só registra com `opts.origin` — a rota da consulta; o passo 0b do transmitir
// envolve o `reconcileInterrupted` e registra "transmissao"), D-F96 (`authority/adn.ts` — assinatura do evento pelo `firstText` do
// parse; repetição → o XML arquivado é o MENOR na ordem do texto) e a composição com a D-F97 do núcleo (a prova que a nfse-api
// GRAVA — `nfse_not_generated_at` — é a que a F2a vai ler com `reconfirmationProven(candidate, lifeList)`).
//
//  * ACHADOS (`it.failing('[SEV R18-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo) e prova
//    que o cenário do `it.failing` vizinho monta de verdade (o `it.failing` só afirma a última coisa).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r17-gate.test.ts`), nenhuma migration, nada que fale com o fisco.
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r18-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const INVOICE_B = 6201
const CNPJ = '12345678000199'
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const KEY_B = `${KEY.slice(0, -1)}8`
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
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
      const ok = Number(params[4]) === maxEvent
      if (ok) stamps.push({ attempt: Number(params[3]), seen: Number(params[4]) }); else refusedStamps += 1
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
import { webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

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
  cnpj: id === 1 ? '12.345.678/0001-99' : '98.765.432/0001-88', im: id === 1 ? '777' : null, cpf: null,
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
function refreshCallSites(roots: string[]): string[] {
  const sites: string[] = []
  for (const f of roots.flatMap(walkTs)) {
    const code = uncomment(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(PROJECT_ROOT, f).replace(/\\/g, '/')
    const re = /refreshServiceTransmission\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue            // a definição
      const call = code.slice(m.index, code.indexOf('\n', m.index))
      const fnStart = code.lastIndexOf('function ', m.index)
      const fn = code.slice(fnStart + 9).match(/^\w+/)?.[0] ?? '?'
      const who = /origin:\s*'consulta'/.test(call) ? 'origem dita (consulta)'
        : /fromRun:\s*true/.test(call) ? 'rodizio (registra por si)'
        : /\bquery\s*\}/.test(call) ? 'reconferencia (registra por si)'
        : fn === 'reconcileInterrupted' ? 'transmissao (passo 0b registra)'
        : 'MUDO'
      sites.push(`${rel} :: ${fn} :: ${who}`)
    }
  }
  return sites
}

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R18-01 (LOW) — D-F94: o `reason` é a MENSAGEM inteira com os dígitos trocados — texto EXTERNO interpolado nela (o `infDPS/@Id` da resposta TROCADA, `parsed.dpsId` em nfse/transmission.ts:564) passa menos os dígitos: com o CNPJ ALFANUMÉRICO de um terceiro (inscrições novas desde 07/2026) as LETRAS do documento alheio vão ao alarme', () => {
  it('[CORRIGIDO — D-F98] consulta da tela com a NFS-e de OUTRO DPS (terceiro com CNPJ alfanumérico) → 502, UM alarme "consulta" com a causa FECHADA `nfse-de-outro-dps`', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(foreignVoice(FOREIGN_ALNUM_DPS_ID))
    expect(await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(reasonOf()).not.toMatch(/\d/)
    expect(reasonOf()).toBe('nfse-de-outro-dps')                                   // D-F98 (b): a causa da lista FECHADA, nunca texto
  })
  it('[CORRIGIDO — D-F98] [LOW R18-01] consulta da tela: o alarme não leva fragmento do identificador de TERCEIRO (nem as letras do CNPJ alfanumérico)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(foreignVoice(FOREIGN_ALNUM_DPS_ID))
    await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(reasonOf()).not.toContain('ABC')
  })
  it('[CORRIGIDO — D-F98] passo 0b do transmitir (reserva interrompida → o GET /dps acha a chave → a NFS-e lida é de OUTRO DPS) → 502, nada reservado, UM alarme "transmissao" com a causa FECHADA', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue(foreignVoice(FOREIGN_ALNUM_DPS_ID))
    expect(await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(origins()).toEqual(['transmissao'])
    expect(reasonOf()).toBe('nfse-de-outro-dps')                                   // D-F98 (b): a causa da lista FECHADA, nunca texto
  })
  it('[CORRIGIDO — D-F98] [LOW R18-01] passo 0b do transmitir: o alarme "transmissao" idem — nenhum fragmento do Id alheio', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue(foreignVoice(FOREIGN_ALNUM_DPS_ID))
    await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(reasonOf()).not.toContain('ABC')
  })
})

describe('ACHADO R18-02 (LOW, FORA do delta — a mesma classe do R17-02) — a D-F94 fechou só o ALARME: o Id do DPS ALHEIO (com o CPF/CNPJ do terceiro) segue INTEIRO no log do adaptador (`unknownResponse` grava o `label` no warn — "transmitir: NFS-e de OUTRO DPS (veio …)", authority/adn.ts:226/95) e no corpo do 502 que o app mostra (nfse/transmission.ts:564)', () => {
  const signedDps = `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse"><infDPS Id="${DPS_ID}"></infDPS></DPS>`
  const postForeign = () => mockHttp.mockImplementation(async (call: HttpsCall) =>
    (call.method === 'POST' && /\/nfse$/.test(call.url) ? ok({ nfseXmlGZipB64: gz(nfseXmlWithDps(KEY, FOREIGN_DPS_ID)) }) : notFound()))
  it('contexto: POST /nfse devolve a NFS-e de OUTRO DPS → o adaptador lança 502 ambíguo (o cenário monta)', async () => {
    postForeign()
    expect(await settle(adnAdapter.transmit(ctxH as any, signedDps))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
  })
  it('[CORRIGIDO — D-F98 (c)] [LOW R18-02] …e NENHUM log carrega o documento do terceiro', async () => {
    postForeign()
    await settle(adnAdapter.transmit(ctxH as any, signedDps))
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls])).not.toContain(THIRD_CPF)
  })
  it('[gate R20 — S1 / D-F100] a resposta TROCADA não viaja no erro: o `body` do 502 vem VAZIO (o corpo é do terceiro, em gzip+base64 — a busca por texto não o enxerga)', async () => {
    postForeign()
    const out = await settle(adnAdapter.transmit(ctxH as any, signedDps))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(out.body).toBe('')
    expect(JSON.stringify(out)).not.toContain('GZipB64')
  })
  it('[CORRIGIDO — D-F98 (c)] o 502 da CONSULTA (OUTRO DPS) não leva o Id alheio ao app — nem o CPF do terceiro, nem o Id inteiro; o alarme também não', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(foreignVoice(FOREIGN_DPS_ID))
    const out = await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(out).toMatchObject({ statusCode: 502 })
    expect(String(out.message)).not.toContain(THIRD_CPF)
    expect(String(out.message)).not.toContain(FOREIGN_DPS_ID)
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(THIRD_CPF)
  })
})

describe('ACHADO R18-07 (LOW — regressão do D-F96) — o `firstText` DES-ESCAPA (`unescapeXml` → `String.fromCodePoint`) e LANÇA RangeError numa referência numérica fora do Unicode; com a assinatura lendo por ele, os 4 campos novos (nDFSe, autor, ambGer, tpAmb) viraram ponto de exceção CRUA: 500 com ref na rota e, na passada, "erro inesperado" — sem alarme e sem carimbo', () => {
  const base = generatedEventXml({ code: '101101' })
  const bad = (field: string, v: string) => base.replace(`<${field}>${v}</${field}>`, `<${field}>&#x110000;</${field}>`)
  const FIELDS: [string, string][] = [['nDFSe', '1'], ['ambGer', '2'], ['tpAmb', '2'], ['CNPJAutor', CNPJ]]
  it('[CORRIGIDO na sessão — R18-07] o adaptador NUNCA lança RangeError cru nos 4 campos da assinatura (a leitura ilegível vira ambígua)', async () => {
    for (const [f, v] of FIELDS) {
      expect(bad(f, v)).not.toBe(base)
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(bad(f, v))) : undefined) })
      expect(await settle(adnAdapter.queryNfse(ctxH as any, KEY))).not.toBeInstanceOf(RangeError)
    }
  })
  it('[CORRIGIDO na sessão] [LOW R18-07] referência numérica fora do Unicode em nDFSe/ambGer/tpAmb/CNPJAutor → resposta AMBÍGUA (unknown ou 502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE), nunca exceção crua', async () => {
    for (const [f, v] of FIELDS) {
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(bad(f, v))) : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
      expect(out?.status === 'unknown' || out?.code === ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE).toBe(true)
    }
  })
  it('[CORRIGIDO na sessão — R18-07] na PASSADA a leitura ilegível é o ambíguo da casa: 502 no relatório, alarme "rodizio" e o carimbo da vez', async () => {
    const t = tx({ lastKind: 'A' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([t])
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(bad('nDFSe', '1'))) : undefined) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r.errors).toEqual([expect.objectContaining({ invoiceId: INVOICE, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })])
    expect(ambiguousLogs()).toHaveLength(1)
    expect(repo.touchQueriedAt).toHaveBeenCalled()
  })
})

// ===========================================================================
// CONTEXTO — composição com a D-F97 do núcleo (a prova que a nfse-api GRAVA × a que a F2a vai LER)
// ===========================================================================

describe('CONTEXTO R18-05 (LOW — Q-F105) — a reconferência da nfse-api GRAVA a prova (E2404 na candidata) mesmo com uma tentativa da MESMA identidade EM VOO; a D-F97 conta a apresentação dela pelo `createdAt` da RESERVA', () => {
  it('[CORRIGIDO — D-F99] vida = [F por consulta (1), em voo (2, mesmo Id, P)] → a nfse-api ainda responde "reconferido, não gerada" e carimba a prova na 1 (Q-F105 (c) não foi escolhida), mas a prova LIDA pela regra do núcleo NÃO passa enquanto a 2 estiver sem voz', async () => {
    const f1 = F({ attempt: 1, lastEventAt: '2026-10-09 10:00:00' })
    const v2 = inFlight({ attempt: 2, createdAt: '2026-10-11 10:00:00' })
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(v2)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1, v2], events: [] })
    fisco({})                                                                          // GET /dps → E2404 (tipoAmbiente 1)
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))).toEqual({ invoiceId: INVOICE, needed: true, found: false, attempt: 1, accessKey: null })
    expect(stamps).toEqual([{ attempt: 1, seen: 2 }])
    // o que a F2a vai ler: o carimbo (NOW() da nfse-api) 2 s depois da RESERVA da 2 — o POST dela pode chegar ao fisco depois disso
    const proof = { ...f1, nfseNotGeneratedAt: '2026-10-11 10:00:02' }
    expect(reconfirmationProven(proof as any, [f1, v2] as any)).toBe(false)              // D-F99: tentativa da mesma identidade sem voz
  })
  it('resistiu: a mesma vida com a 2 já RESPONDIDA (R às 10:00:05) → a prova de 10:00:02 não vale; uma reconferência nova (10:00:06) vale', () => {
    const f1 = F({ attempt: 1, lastEventAt: '2026-10-09 10:00:00' })
    const r2 = F({ attempt: 2, lastKind: 'R', lastSource: 'P', lastEvent: 1, createdAt: '2026-10-11 10:00:00', lastEventAt: '2026-10-11 10:00:05' })
    expect(reconfirmationProven({ ...f1, nfseNotGeneratedAt: '2026-10-11 10:00:02' } as any, [f1, r2] as any)).toBe(false)
    expect(reconfirmationProven({ ...f1, nfseNotGeneratedAt: '2026-10-11 10:00:06' } as any, [f1, r2] as any)).toBe(true)
  })
})

// ===========================================================================
// RESISTIU — D-F95: nenhum chamador de produção ficou mudo; um alarme só
// ===========================================================================

describe('RESISTIU — D-F95: a origem é dita por quem chama — nenhum chamador de PRODUÇÃO perdeu o alarme (cerca estática)', () => {
  it('resistiu: toda chamada de `refreshServiceTransmission(` em src/ (fora dos testes) diz a origem OU é de quem registra por si; mudo só o smoke manual de homologação (scripts/, roda com "vai" e imprime o próprio erro)', () => {
    const sites = refreshCallSites([SRC_ROOT, path.join(PROJECT_ROOT, 'scripts')])
    const silent = sites.filter(s => s.endsWith('MUDO'))
    expect(silent).toHaveLength(2)
    expect(silent.every(s => s.startsWith('scripts/smoke-adn-homologacao.ts :: '))).toBe(true)
    expect(sites.filter(s => s.startsWith('src/'))).toEqual(expect.arrayContaining([
      'src/modules/nfse/nfse.routes.ts :: nfseRoutes :: origem dita (consulta)',
      'src/nfse/transmission.ts :: reconcileInterrupted :: transmissao (passo 0b registra)',
      'src/nfse/transmission.ts :: reconfirmCandidate :: reconferencia (registra por si)',
      'src/nfse/transmission.ts :: refreshOpenServiceTransmissions :: rodizio (registra por si)',
    ]))
    expect(sites.filter(s => s.startsWith('src/'))).toHaveLength(4)
  })
  it('resistiu: quem "registra por si" registra de fato — o 0b envolve TODA chamada do `reconcileInterrupted`, a reconferência envolve o `reconfirmCandidate` e a passada registra "rodizio"', () => {
    const code = uncomment(fs.readFileSync(path.join(SRC_ROOT, 'nfse/transmission.ts'), 'utf8'))
    const reconcileCalls = code.match(/[^\n]*reconcileInterrupted\([^\n]*/g)!.filter(l => !/function\s+reconcileInterrupted/.test(l))
    expect(reconcileCalls).toHaveLength(1)
    expect(code).toMatch(/try \{ await reconcileInterrupted\([^)]*\) \}\s*catch \(err\) \{ logAmbiguousFiscal\('transmissao'[^\n]*throw err \}/)
    expect(code).toMatch(/try \{\s*return await reconfirmCandidate\([^)]*\)\s*\} catch \(err\) \{\s*logAmbiguousFiscal\('reconferencia'/)
    expect(code).toMatch(/logAmbiguousFiscal\('rodizio'/)
  })
  it('resistiu: 0b com a leitura AMBÍGUA dentro do refresh interno → UM alarme só ("transmissao", tentativa certa) — o invólucro interno não registra de novo', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockRejectedValue(unknownBoom())
    await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(origins()).toEqual(['transmissao'])
    expect(ambiguousLogs()[0][1]).toMatchObject({ institutionId: 1, invoiceId: INVOICE, attempt: 1, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
  })
  it('resistiu: D-F94 — o `reason` é cortado em 160 DEPOIS da máscara e nunca carrega a chave nem o Id da NOSSA nota', () => {
    logAmbiguousFiscal('consulta', { institutionId: 1, invoiceId: INVOICE }, new HttpError(502, `${'9'.repeat(400)} ${KEY} ${DPS_ID} ${'x'.repeat(400)}`, undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE))
    expect(reasonOf().length).toBeLessThanOrEqual(160)
    expect(reasonOf()).not.toMatch(/\d/)
    expect(reasonOf()).not.toContain(KEY); expect(reasonOf()).not.toContain(DPS_ID)
  })
})

// ===========================================================================
// RESISTIU — D-F96: a escolha determinística só escolhe entre candidatos JÁ conferidos; parse e assinatura concordam
// ===========================================================================

describe('RESISTIU — D-F96 no adaptador ADN da nfse-api', () => {
  const base = generatedEventXml({ code: '101101' })
  const v = (s: string) => base.replace('<verAplic>SEFIN</verAplic>', `<verAplic>${s}</verAplic>`)
  it('resistiu: (c) TRÊS repetições (verAplic diferente) em TODAS as 6 ordens da lista → o MESMO XML arquivado, e é o menor na ordem do texto', async () => {
    const xs = [v('SEFIN-3'), v('SEFIN-1'), v('SEFIN-2')]
    const got = new Set<string>()
    for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(...p.map(i => typedItemRaw(xs[i]))) : undefined) })
      const r = await adnAdapter.queryNfse(ctxH as any, KEY)
      expect(r.status).toBe('cancelled')
      got.add(r.cancelled!.eventXml!)
    }
    expect([...got]).toEqual([[...xs].sort()[0]])
  })
  it('resistiu: (c) o ECO do nosso pedido (sem Id EVT nem dhProc) e o evento GERADO de OUTRA chave — ambos MENORES na ordem do texto — nunca são o XML escolhido', async () => {
    const eco = '<?xml version="1.0"?>' + base.replace(/ Id="EVT[^"]*"/, '').replace(/<dhProc>[^<]*<\/dhProc>/, '')
    const OTHER = '0'.repeat(50)
    const other = generatedEventXml({ code: '101101', key: OTHER })
    expect(eco < base).toBe(true); expect(other < base).toBe(true)
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(eco), typedItemRaw(other, '101101', OTHER), typedItemRaw(base)) : undefined) })
    const r = await adnAdapter.queryNfse(ctxH as any, KEY)
    expect(r).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
    expect(r.cancelled!.eventXml).toBe(base)
  })
  it('resistiu: (a) parse e assinatura concordam — entidade numérica × literal do MESMO valor (CNPJAutor `&#49;…`, nDFSe `&#x31;`) é REPETIÇÃO (cancelled), com o mesmo XML nas duas ordens', async () => {
    const ent = base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CNPJAutor>&#49;${CNPJ.slice(1)}</CNPJAutor>`).replace('<nDFSe>1</nDFSe>', '<nDFSe>&#x31;</nDFSe>')
    const r = await orderIndependent(base, ent)
    expect([r.ab.status, r.ba.status]).toEqual(['cancelled', 'cancelled'])
    expect(r.ok).toBe(true)
  })
  it('resistiu: (a) o `firstText` exportado é o MESMO leitor do parse (não uma cópia) — o adaptador não tem mais leitor próprio', () => {
    const adn = uncomment(fs.readFileSync(path.join(SRC_ROOT, 'authority/adn.ts'), 'utf8'))
    expect(adn).not.toMatch(/const\s+tagText\b|function\s+tagText\b/)
    expect(adn).toMatch(/import \{[^}]*\bfirstText\b[^}]*\} from '\.\/dps-builder'/)
    expect(adn).not.toMatch(/function\s+firstText\b|const\s+firstText\b/)
  })
})
