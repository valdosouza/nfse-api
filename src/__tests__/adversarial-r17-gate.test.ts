/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 17 das APIs fiscais (D-F91…D-F93, Valdo 2026-10-11 "siga as recomendações") — nfse-api (+ núcleo
// fiscal-api). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F91 (`logAmbiguousFiscal` + invólucro do `refreshServiceTransmission` → origem "consulta"; a passada passa
// `fromRun: true` → "rodizio"; `reconfirmBeforeLocalCancel` → `reconfirmCandidate` em try/catch → "reconferencia", preservando o
// LOW-4 (409 RESOURCE_BUSY) e a D-F90 (prova só no E2404)), D-F92 (conhecimento negativo: a prova não tem prazo) e D-F93
// (`authority/adn.ts` — `eventSignature` soma nDFSe, autor, ambGer e tpAmb lidos por `tagText`).
//
//  * ACHADOS (`it.failing('[SEV R17-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r16-gate.test.ts` + fixtures do transmitir do `transmission.test.ts`), nenhuma migration, nada que fale
// com o fisco.
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r17-'))
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
import { webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return reconfirmationProven(cc, life ?? [cc])
}

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
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

/** D-F95 (Rodada 18): a consulta pedida pela TELA diz a origem — o invólucro não a deduz mais pela ausência de flags. */
const SCREEN = { origin: 'consulta' as const }

describe('ACHADO R17-01 (LOW) — D-F93: `tagText` é MAIS ESTRITO que o `firstText` do parseEventXml (atributos, CDATA, entidades): com atributo ou CDATA nos 4 campos novos os dois lados leem null → divergência real passa como "repetição" e o XML ARQUIVADO (Q-N38/D-F78) volta a depender da ordem da lista — a R16-01 reabre por outra forma', () => {
  const base = generatedEventXml({ code: '101101' })
  const attrA = base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">1</nDFSe>')
  const attrB = base.replace('<nDFSe>1</nDFSe>', '<nDFSe versao="1">2</nDFSe>')
  const cdataA = base.replace('<tpAmb>2</tpAmb>', '<tpAmb><![CDATA[2]]></tpAmb>')
  const cdataB = base.replace('<tpAmb>2</tpAmb>', '<tpAmb><![CDATA[1]]></tpAmb>')
  it('[CORRIGIDO — Rodada 18] [LOW R17-01] nDFSe com ATRIBUTO (`versao="1"`, valores 1 × 2, mesmo Id) → ambíguo nas duas ordens OU o mesmo XML nas duas ordens', async () => {
    expect((await orderIndependent(attrA, attrB)).ok).toBe(true)
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-01] tpAmb em CDATA (2 × 1 — ambientes DIFERENTES, mesmo Id) → ambíguo nas duas ordens OU o mesmo XML', async () => {
    expect((await orderIndependent(cdataA, cdataB)).ok).toBe(true)
  })
  it('[D-F96] as duas formas (atributo, CDATA divergentes) → AMBÍGUO nas DUAS ordens (o leitor do parse lê o valor)', async () => {
    for (const [a, b] of [[attrA, attrB], [cdataA, cdataB]]) {
      const r = await orderIndependent(a, b)
      expect([r.ab.status, r.ba.status]).toEqual(['unknown', 'unknown'])
    }
  })
  it('[D-F96] liveness: CDATA × texto segue ambíguo (fail-closed); entidade numérica × literal e `<nDFSe >` com espaço nunca deixam o arquivo depender da ordem', async () => {
    mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(base), typedItemRaw(base.replace('<nDFSe>1</nDFSe>', '<nDFSe><![CDATA[1]]></nDFSe>'))) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
    for (const v of [base.replace('<ambGer>2</ambGer>', '<ambGer>&#50;</ambGer>'), base.replace('<nDFSe>1</nDFSe>', '<nDFSe >1</nDFSe>')]) {
      expect((await orderIndependent(base, v)).ok).toBe(true)
    }
  })
  it('[D-F96 (c)] `verAplic` (fora da assinatura) passa como repetição — e o XML arquivado é o MESMO nas duas ordens (escolha determinística)', async () => {
    const r = await orderIndependent(base, base.replace('<verAplic>SEFIN</verAplic>', '<verAplic>SEFIN-2</verAplic>'))
    expect([r.ab.status, r.ba.status]).toEqual(['cancelled', 'cancelled'])
    expect(r.ok).toBe(true)
  })
})

describe('ACHADO R17-02 (LOW) — D-F91: o alarme leva `err: errMsg(err)`; o 502 "NFS-e de OUTRO DPS" (resposta trocada) traz o Id do DPS ALHEIO, que embute o documento do prestador de OUTRA nota (tpInsc 1 = CPF) — a consulta da tela e a reconferência passaram a jogar isso no log de ERRO', () => {
  const foreign = () => ({ accessKey: KEY, status: 'authorized' as const, nfseXml: nfseXmlWithDps(KEY, FOREIGN_DPS_ID), dhProc: '2026-09-21T10:15:30-03:00' })
  it('[D-F94] a consulta da tela com a NFS-e de OUTRO DPS → 502, nada gravado, UM alarme "consulta" com o CÓDIGO e rótulo SEM DÍGITOS', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(foreign())
    const out = await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['consulta'])
    expect(ambiguousLogs()[0][1]).toMatchObject({ code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(ambiguousLogs()[0][1].err).toBeUndefined()
    expect(String(ambiguousLogs()[0][1].reason)).not.toMatch(/\d/)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled(); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-02] o alarme do ambíguo nunca carrega documento (CPF/CNPJ) de TERCEIRO', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue(foreign())
    await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))
    expect(ambiguousLogs()).toHaveLength(1)
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(THIRD_CPF)
  })
})

describe('ACHADO R17-03 (LOW) — D-F91: "sem `query` e sem `fromRun`" ≠ "consulta da TELA": o TRANSMITIR (passo 0b, reserva interrompida → `reconcileInterrupted`) chama o refresh assim e o ambíguo da transmissão vai ao alarme rotulado "consulta"; o GET /dps ambíguo do MESMO passo (fora do refresh) não vai', () => {
  const interrupted = () => inFlight({ ageMinutes: IN_FLIGHT_MINUTES + 5 })
  it('[D-F95] transmitir com a reserva interrompida; GET /dps acha a chave e a leitura é ambígua → 502 (nada reservado, nada enviado) e UM alarme "transmissao"', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: nfseXmlOf(KEY), dhProc: null })
    const out = await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(adapter.transmit).not.toHaveBeenCalled(); expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(origins()).toEqual(['transmissao'])
  })
  it('[CORRIGIDO — Rodada 18] [LOW R17-03] o ambíguo que nasce no TRANSMITIR nunca é rotulado como a consulta pedida pela TELA', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: nfseXmlOf(KEY), dhProc: null })
    await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(origins()).not.toContain('consulta')
  })
  it('[D-F95] no MESMO passo 0b o GET /dps AMBÍGUO (antes do refresh) sobe 502 e alarma "transmissao" — onde quer que a ambiguidade nasça', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(interrupted())
    adapter.queryDpsAccessKey.mockRejectedValue(unknownBoom())
    const out = await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(out).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(origins()).toEqual(['transmissao'])
  })
})

// ===========================================================================
// RESISTIU — D-F91: o invólucro é transparente
// ===========================================================================

describe('RESISTIU — D-F91: o invólucro do `refreshServiceTransmission` não muda valor nem exceção', () => {
  it('resistiu: caminho feliz — a consulta da tela devolve o MESMO resultado (autorizada, sem mudança, sem pendência) e não alarma', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    fisco({})
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN)
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, changed: false, kind: 'A', accessKey: KEY, localCancelPending: false })
    expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: a exceção que sobe é a MESMA instância — a ambígua alarma 1×; 503, erro técnico e lançamento não-Error sobem intactos e sem alarme', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    const boom = unknownBoom()
    adapter.queryNfse.mockRejectedValueOnce(boom)
    expect(await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))).toBe(boom)
    expect(origins()).toEqual(['consulta'])
    for (const e of [unavailable(), new Error('ECONNRESET do banco'), 'lançamento cru'] as unknown[]) {
      ;((fiscal.logger as any).error as jest.Mock).mockClear()
      adapter.queryNfse.mockRejectedValueOnce(e)
      expect(await settle(refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q', SCREEN))).toBe(e)
      expect(ambiguousLogs()).toHaveLength(0)
    }
  })
  it('resistiu: `logAmbiguousFiscal` filtra pelo CÓDIGO na classe certa e nunca lança; o payload é só origem/institution/nota/tentativa/última voz/código/rótulo (D-F94)', () => {
    const at = { institutionId: 1, invoiceId: INVOICE }
    for (const e of [undefined, null, { code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, message: 'imitação' }, new HttpError(502, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE)]) {
      expect(() => logAmbiguousFiscal('consulta', at, e)).not.toThrow()
    }
    expect(ambiguousLogs()).toHaveLength(0)
    logAmbiguousFiscal('reconferencia', at, new AuthorityHttpError(502, 'ambíguo', ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 200, '{}'))
    expect(Object.keys(ambiguousLogs()[0][1]).sort()).toEqual(['attempt', 'code', 'institutionId', 'invoiceId', 'lastKind', 'origin', 'reason'])
  })
})

// ===========================================================================
// RESISTIU — D-F91 na reconferência: UM alarme, LOW-4 e D-F90 preservados pelo split `reconfirmCandidate`
// ===========================================================================

describe('RESISTIU — D-F91 × reconferência (split `reconfirmCandidate`)', () => {
  it('resistiu: GET /dps AMBÍGUO (404 do gateway / 404 JSON sem E2404) → 502, UM alarme "reconferencia" com a tentativa da candidata, nenhuma prova, nenhum carimbo', async () => {
    for (const dps of [() => notFound(), () => ok({ erro: { codigo: 'E0001' } }, 404)]) {
      ;((fiscal.logger as any).error as jest.Mock).mockClear(); (repo.touchQueriedAt as jest.Mock).mockClear()
      reconfirmScenario(); mockHttp.mockReset(); fisco({ dps })
      expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
      expect(origins()).toEqual(['reconferencia'])
      expect(ambiguousLogs()[0][1]).toMatchObject({ institutionId: 1, invoiceId: INVOICE, attempt: 1 })
      expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    }
    expect(notGeneratedWrites()).toHaveLength(0)
  })
  it('resistiu: LOW-4 — a guarda da prova recusa (voz nova durante a pergunta) → 409 RESOURCE_BUSY atravessa o try/catch intacto e SEM alarme', async () => {
    reconfirmScenario()
    fisco({ onDps: () => { maxEvent = 3 } })
    const out = await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(out).toBeInstanceOf(HttpError)
    expect(out).toMatchObject({ statusCode: 409, code: ErrorCodes.RESOURCE_BUSY })
    expect(stamps).toHaveLength(0); expect(refusedStamps).toBe(1); expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: D-F90 — prova SÓ no E2404: com a chave achada (reconciliada) nenhuma escrita da prova; com 503 nada (nem prova, nem carimbo, nem alarme)', async () => {
    reconfirmScenario()
    // a chave aparece e a NFS-e é lida (P, sem eventos); a tentativa reconciliada passa a deter a chave
    const reconciled = F({ accessKey: KEY, lastKind: 'A', lastEvent: 3 })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValueOnce({ transmissions: [F()], events: [] }).mockResolvedValueOnce({ transmissions: [reconciled], events: [] })
    fisco({ dpsKey: KEY, typed: () => ({ status: 404, headers: {}, text: JSON.stringify({ ...SEFIN, tipoAmbiente: 1 }) }) })
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))).toMatchObject({ needed: true, found: true, accessKey: KEY })
    expect(notGeneratedWrites()).toHaveLength(0); expect(ambiguousLogs()).toHaveLength(0)
    reconfirmScenario(); mockHttp.mockReset(); (repo.touchQueriedAt as jest.Mock).mockClear()
    fisco({ dps: () => ({ status: 503, headers: {}, text: '' }) })
    expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 503 })
    expect(notGeneratedWrites()).toHaveLength(0); expect(repo.touchQueriedAt).not.toHaveBeenCalled(); expect(ambiguousLogs()).toHaveLength(0)
  })
  it('resistiu: a chave aparece e a leitura dela é ambígua (D-F84) — UM alarme "reconferencia" (o refresh com a consulta pronta não registra "consulta"), sem a chave de acesso, sem prova', async () => {
    reconfirmScenario()
    fisco({ dpsKey: KEY, typed: (code: string) => (code === '101101' ? typedOk(item('101101'), item('105102')) : undefined) })
    expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502 })
    expect(origins()).toEqual(['reconferencia'])
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY)
    expect(notGeneratedWrites()).toHaveLength(0)
  })
})

// ===========================================================================
// RESISTIU — D-F91 na passada e na tela: origem certa, sem duplicata, nunca a chave
// ===========================================================================

describe('RESISTIU — D-F91: a passada (`fromRun`) e a tela', () => {
  it('resistiu: passada com DUAS notas ambíguas → DOIS alarmes "rodizio" (um por nota, tentativa certa), nenhum "consulta"', async () => {
    const txA = tx({ invoiceId: INVOICE, accessKey: KEY, lastKind: 'A' })
    const txB = tx({ invoiceId: INVOICE_B, accessKey: KEY_B, lastKind: 'A', attempt: 2 })
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([txA, txB])
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, __r: any) => (__r.invoiceId === INVOICE_B ? txB : txA))
    adapter.queryNfse.mockRejectedValue(unknownBoom())
    const r = await refreshOpenServiceTransmissions(deps, A, { terminal: WEB })
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(origins()).toEqual(['rodizio', 'rodizio'])
    expect(ambiguousLogs().map((c: any[]) => [c[1].invoiceId, c[1].attempt])).toEqual([[INVOICE, 1], [INVOICE_B, 2]])
  })
  it('resistiu: revisita do F pelo rodízio com GET /dps AMBÍGUO → UM alarme "rodizio" (não "consulta"), nenhuma prova', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([f])
    fisco({ dps: () => notFound() })
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(origins()).toEqual(['rodizio'])
    expect(notGeneratedWrites()).toHaveLength(0)
  })
  it('resistiu: a consulta da tela — nenhuma variante de ambíguo leva a chave de acesso ao alarme (D-F84, 200 com lista vazia, 404 fora do envelope, 401 na rota de evento, 405)', async () => {
    const variants: ((code: string) => any)[] = [
      CONTRA,
      code => (code === '101101' ? typedOk() : undefined),
      code => (code === '101101' ? { status: 404, headers: {}, text: '<html>gateway</html>' } : undefined),
      code => (code === '101101' ? { status: 401, headers: {}, text: '' } : undefined),
      () => ({ status: 405, headers: { allow: 'POST' }, text: '' }),
    ]
    for (const typed of variants) {
      ;((fiscal.logger as any).error as jest.Mock).mockClear()
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
      mockHttp.mockReset(); fisco({ typed })
      expect(await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', SCREEN))).toMatchObject({ statusCode: 502 })
      expect(origins()).toEqual(['consulta'])
      expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY)
    }
  })
})

// ===========================================================================
// RESISTIU — D-F93 (os 4 campos novos) e CONTEXTO da D-F92 (a prova sem prazo × reuso do Id do DPS — D-N3/D-F30)
// ===========================================================================

describe('RESISTIU — D-F93 no adaptador ADN da nfse-api', () => {
  const base = generatedEventXml({ code: '101101' })
  it('resistiu: cada um dos 4 campos novos divergente (nDFSe, CNPJAutor, CNPJAutor × CPFAutor, ambGer, tpAmb) → ambíguo', async () => {
    for (const v of [
      base.replace('<nDFSe>1</nDFSe>', '<nDFSe>2</nDFSe>'),
      base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, '<CNPJAutor>98765432000198</CNPJAutor>'),
      base.replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CPFAutor>${THIRD_CPF}</CPFAutor>`),
      base.replace('<ambGer>2</ambGer>', '<ambGer>1</ambGer>'),
      base.replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>'),
    ]) {
      expect(v).not.toBe(base)
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(base), typedItemRaw(v)) : undefined) })
      expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
    }
  })
  it('resistiu: repetição LEGÍTIMA — espaços/quebras em volta dos 4 valores, declaração XML e indentação → cancelled', async () => {
    const spaced = '<?xml version="1.0" encoding="UTF-8"?>\n' + base
      .replace('<nDFSe>1</nDFSe>', '<nDFSe>\n  1 </nDFSe>').replace('<ambGer>2</ambGer>', '<ambGer> 2</ambGer>')
      .replace('<tpAmb>2</tpAmb>', '<tpAmb>2\n</tpAmb>').replace(`<CNPJAutor>${CNPJ}</CNPJAutor>`, `<CNPJAutor>\t${CNPJ} </CNPJAutor>`)
      .replace(/></g, '>\n  <')
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(base), typedItemRaw(spaced)) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH as any, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('resistiu: prefixo de namespace em TODO o evento → o leitor não reconhece evento gerado → ambíguo (nunca "cancelled" com assinatura vazia)', async () => {
    const prefixed = base.replace(/<(\/?)([A-Za-z])/g, '<$1ns:$2').replace('xmlns=', 'xmlns:ns=')
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(prefixed), typedItemRaw(prefixed.replace('<ns:nDFSe>1', '<ns:nDFSe>2'))) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
})

describe('CONTEXTO — D-F92 (a prova não tem prazo) × D-N3/D-F30 (as tentativas da MESMA vida reapresentam o MESMO Id do DPS)', () => {
  it('[D-F97 = Q-F103 (b)] F por consulta (tentativa 1) com E2404 posterior; depois a tentativa 2 reapresenta o MESMO Id e o fisco a RECUSA — a candidata segue sendo a 1, mas a prova ANTIGA (anterior à 2ª apresentação) NÃO vale mais', () => {
    const t1 = { ...F({ attempt: 1, lastEventAt: '2026-10-01 10:00:00' }), nfseNotGeneratedAt: '2026-10-02 10:00:00' }
    const t2 = { ...F({ attempt: 2, lastKind: 'R', lastSource: 'P', lastEvent: 1, lastEventAt: '2026-10-20 10:00:00' }), nfseNotGeneratedAt: null }
    expect(t2.dpsId).toBe(t1.dpsId)
    const cand = reconfirmationCandidate([t1, t2] as any)
    expect(cand).toMatchObject({ attempt: 1 })
    expect(reconfirmationProven(cand as any, [t1, t2] as any)).toBe(false)   // o Id voltou ao fisco em 20/10: o E2404 de 02/10 não prova
    expect(reconfirmationProven({ ...cand, nfseNotGeneratedAt: '2026-10-21 10:00:00' } as any, [t1, t2] as any)).toBe(true)
  })
  it('resistiu: D-F92 — a revisita de 24 h semanas antes do cancelamento ainda prova; E2404 no MESMO instante do F não prova', () => {
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-11-15 10:00:00' })).toBe(true)
    expect(proven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-01 10:00:00' })).toBe(false)
  })
})
