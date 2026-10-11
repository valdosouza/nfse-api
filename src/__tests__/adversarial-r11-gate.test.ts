/// <reference types="jest" />
// RE-GATE ADVERSARIAL — Rodada 11 (retrabalho dos MEDIUMs do gate da D-F61) — nfse-api (+ núcleo fiscal-api), 2026-10-10.
// Alvo do delta: D-F62 (aluguel 210 s), D-F63 ("unknown"), D-F64 (substituição: só a voz com o texto — o efeito é do
// setes-api, D-F28), D-F65 (401/403 em rota de evento), D-F66 (NFC), `cut()`.
// ACHADOS = it.failing('[SEV R11-xx] …') (prova do bug; o corretor troca para it); RESISTIU = it('resistiu: …').
// Nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/repositório/erp mockados — harness copiado do
// adversarial-df61-gate.test.ts), nenhum script que fale com o fisco.
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, AuthorityHttpError, HttpError, MasterKeyRing } from 'fiscal-api'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, reconfirmBeforeLocalCancel,
  refreshOpenServiceTransmissions, getServiceFiscalView, resetMunicipalTermsCache, NfseDeps, CEILING_LOOKUP_TIMEOUT_MS,
} from '../nfse/transmission'

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
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r11-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000199'
const KEY = '4106902212345678000199000000000012320260921000012345'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019900001000000000000042'
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

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
const opened = (env = 'H') => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
})
const tx = (over: any = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 13:15:30', createdAt: '2026-09-21 13:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})
const rejected = () => new AuthorityHttpError(422, 'Fisco rejeitou (400): E0718: alíquota inválida', 'FISCAL_DPS_REJECTED', 400,
  '{"erros":[{"codigo":"E0718","descricao":"alíquota inválida"}]}', [{ field: 'dps', message: 'E0718: alíquota inválida' }])
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')

let headerRow: any
let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  headerRow = header()
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[headerRow]]
    if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
    return [[]]
  })
  conn.query.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice_service\s/.test(sql)) return [[{ updatedAt: headerRow.branchUpdatedAt }]]
    if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
    return [[]]
  })
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.invoiceLives.mockImplementation(async () => new Map())
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)                     // D-F39: virada (o padrão dos testes)
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.getLifeDps as jest.Mock).mockResolvedValue(null)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

// ===========================================================================
// Ferramentas do ataque: a Sefin REAL (D-F61) pelo transporte do NÚCLEO (fiscal-api) — nenhum socket
// ===========================================================================
import { gzipSync } from 'zlib'
import { transport, HttpsCall } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { buildDpsXml, buildDpsId, toTsString, unescapeXml } from '../authority/dps-builder'
import type { DpsInput } from '../authority/types'
import { IN_FLIGHT_MINUTES } from '../nfse/transmission'

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset() })

const OTHER_KEY = KEY.slice(0, 40) + '9999999999'
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const arquivo2 = (x: string | Buffer) => b64(gzipSync(typeof x === 'string' ? Buffer.from(x, 'utf8') : x).toString('base64'))
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const typedItem = (file: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: file })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
const delay = <T,>(ms: number, v: () => T) => new Promise<T>(res => setTimeout(() => res(v()), ms))
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }

/** Evento GERADO pela Sefin (TCInfEvento: Id EVT + dhProc + pedRegEvento{chNFSe, eNNNNNN}). */
function generatedEventXml(o: { key?: string; code?: string; withId?: boolean; withDhProc?: boolean } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  const id = o.withId === false ? '' : ` Id="EVT${key}${code}001"`
  const dhProc = o.withDhProc === false ? '' : '<dhProc>2026-10-10T18:43:05-03:00</dhProc>'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento${id}><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento>${dhProc}<nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo></e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}
function sefin(o: { nfse?: () => any; typed?: (code: string) => any; post?: (c: HttpsCall) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1])) ?? sefinNone()
    if (/\/eventos$/.test(call.url)) return call.method === 'POST' ? (o.post?.(call) ?? ok(null)) : { status: 405, headers: { allow: 'POST' }, text: '' }
    if (/\/nfse\/\d+$/.test(call.url)) return o.nfse?.() ?? ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    if (/\/nfse$/.test(call.url) && call.method === 'POST') return o.post?.(call) ?? ok(null)
    return notFound()
  })
}
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
/** deps com o ADAPTADOR REAL (o transporte é que é falso). */
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const kindsInserted = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map((c: any[]) => c[5]?.kind)
const prestOf = (xml: string) => xml.match(/<prest>[\s\S]*?<\/prest>/)?.[0] ?? ''
const TS_STRING = /^(?:[!-ÿ][ -ÿ]*[!-ÿ]|[!-ÿ])$/
const textOf = (xml: string, el: string): string | null => { const m = xml.match(new RegExp(`<${el}>([\\s\\S]*?)</${el}>`)); return m ? unescapeXml(m[1]) : null }
const DPS_BASE: DpsInput = {
  environment: 'H', dhEmi: '2026-10-10T10:15:30-03:00', verAplic: 'nfse-api 1.0', serie: 1, nDps: 42, dCompet: '2026-10-10',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: CNPJ, im: '777', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000188', xNome: 'Cliente Ltda', end: { cMun: '4106902', cep: '80010000', xLgr: 'Rua A', nro: '10', xBairro: 'Centro' } },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Licença mensal ERP' } },
  valores: { vServ: 100, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
}
const DPS_XML_ID = buildDpsId('4106902', '2', CNPJ, 1, 42)
const dpsWith = (f: (d: DpsInput) => void): DpsInput => { const d = JSON.parse(JSON.stringify(DPS_BASE)); f(d); return d }

// ===========================================================================
// Ferramentas da Rodada 11
// ===========================================================================
import { REFRESH_LEASE_SECONDS } from '../nfse/transmission'
import { DEFAULT_TIMEOUT_MS } from 'fiscal-api'

const substItem = () => typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')
const sefinSubstituted = () => sefin({ typed: code => (code === '105102' ? typedOk(substItem()) : undefined) })
const fiscoCalls = () => mockHttp.mock.calls.filter((c: any[]) => !/convenio/.test(c[0].url)).length
const insertedEvents = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map((c: any[]) => c[5])

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R11-06 (LOW, LATENTE até a F2a) — D-F64 na nfse-api: a voz de SUBSTITUIÇÃO responde `localCancelPending: true` — pelo contrato da D-F28 isso diz ao app "envie o cancelamento ao setes-api" (a saga aplica o C local no próximo contato, sem humano decidir) — e o único marcador da substituição é TEXTO livre na mensagem', () => {
  it('[CORRIGIDO — D-F68] [LOW R11-06] consulta lê e105102 desta chave → voz C gravada, mas `localCancelPending` NÃO manda o app aplicar o efeito', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefinSubstituted()
    const r = await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    expect(r.kind).toBe('C')
    expect(r.localCancelPending).toBe(false)                           // hoje: true (= "o app envia o cancelamento", D-F28)
  })
})

describe('ACHADO R11-03 (LOW) — nfse-api: a marca da substituição depende do código do XML LIDO, não do TIPO perguntado — /eventos/105102/1 trazendo um e101101 desta chave vira cancelamento comum (D-F63: "outro tipo" = ambíguo)', () => {
  it('[CORRIGIDO — D-F69] [LOW R11-03a] adaptador da nfse-api: 101101 = 404 e 105102 = 200 com e101101 → nunca "cancelled" sem a marca 105102', async () => {
    sefin({ typed: code => (code === '105102' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })), '105102')) : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
    expect(out?.status === 'cancelled' && out?.cancelled?.eventCode !== '105102').toBe(false)
  })
})

describe('ACHADO R11-04 (LOW) — nfse-api: o NFC (D-F66) compõe letra + marca num caractere fora do Latin-1 e o filtro apaga a LETRA (antes só o diacrítico)', () => {
  it('[CORRIGIDO] [LOW R11-04] "Ševčík" em NFD → as letras base sobrevivem ("Sevcík")', () => {
    expect(toTsString('Ševčík')).toBe('Sevcík')   // NFD → Š→S, č→c (letra-base); o í é Latin-1 e FICA
  })
})

describe('ACHADO R11-05 (LOW) — nfse-api: o 200 tipado que não se confere vira "unknown" SEM logger.error (o 404 fora do envelope tem — M5)', () => {
  it('[CORRIGIDO] [LOW R11-05] /eventos/101101/1 → 200 com arquivo ilegível → logger.error registrado', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2('<html><body>erro</body></html>'))) : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
    expect(out?.status === 'unknown' || out?.statusCode === 502).toBe(true)
    expect(fiscal.logger.error).toHaveBeenCalled()
  })
})

// ===========================================================================
// RESISTIU — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('RESISTIU — D-F64 na nfse-api: voz com o texto, sem laço, sem efeito', () => {
  it('resistiu: e105102 → UMA voz C "Cancelada no fisco por SUBSTITUIÇÃO (e105102): <motivo>" (o motivo do fisco fica — não há sobrescrita aqui)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefinSubstituted()
    await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    const cs = insertedEvents().filter(e => e?.kind === 'C')
    expect(cs).toHaveLength(1)
    expect(cs[0].message).toBe('Cancelada no fisco por SUBSTITUIÇÃO (e105102): cliente desistiu do serviço')
  })
  it('resistiu: tentativa já em C (substituição) → a consulta NÃO volta ao fisco (C é o fim da história — nenhum laço de 15 min na nfse-api)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 2 }))
    sefinSubstituted()
    const r = await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    expect(r).toMatchObject({ kind: 'C', changed: false })
    expect(fiscoCalls()).toBe(0)
  })
  it('resistiu: K de 10 min + a consulta lê e105102 → voz C (nunca N); 2ª leitura com a voz já gravada não duplica', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefinSubstituted()
    await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    expect(kindsInserted()).toEqual(['C'])
    ;(repo.insertTransmissionEvent as jest.Mock).mockClear()
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ event: 3, kind: 'C' })
    await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    expect(kindsInserted()).toEqual([])
  })
})

describe('RESISTIU — D-F63 "unknown" e D-F65 na passada da nfse-api', () => {
  it('resistiu: A + 200 tipado de OUTRA chave → 502 persistente, nenhuma voz, last_queried_at marcado fora da transação', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ key: OTHER_KEY })))) : undefined) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A)
    expect(r).toMatchObject({ checked: 1, stoppedEarly: false })
    expect(r.errors[0]).toMatchObject({ code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(kindsInserted()).toEqual([])
    expect((repo.touchQueriedAt as jest.Mock).mock.calls.some((c: any[]) => c[0] === pool)).toBe(true)
  })
  it('resistiu: 403 HTTP em toda rota de evento → a passada NÃO para (2 notas olhadas, 2 marcadas); 403 no GET /nfse ainda para', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' }), tx({ lastKind: 'A' })])
    sefin({ typed: () => ({ status: 403, headers: {}, text: '<html>403</html>' }) })
    const r1 = await refreshOpenServiceTransmissions(realDeps(), A)
    expect(r1).toMatchObject({ checked: 2, stoppedEarly: false })
    expect((repo.touchQueriedAt as jest.Mock).mock.calls.filter((c: any[]) => c[0] === pool)).toHaveLength(2)
    mockHttp.mockReset(); (repo.touchQueriedAt as jest.Mock).mockClear()
    sefin({ nfse: () => ({ status: 403, headers: {}, text: '' }) })
    const r2 = await refreshOpenServiceTransmissions(realDeps(), A)
    expect(r2).toMatchObject({ checked: 1, stoppedEarly: true }); expect(r2.errors[0].code).toBe('FISCAL_AUTHORITY_AUTH_FAILED')
  })
  it('resistiu: 405/406/415 numa rota de evento (núcleo) → 502 ambíguo da nota, nunca "não há evento" nem 422', async () => {
    for (const status of [405, 406, 415]) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '105102' ? { status, headers: {}, text: '' } : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
      expect([status, out?.statusCode, out?.code]).toEqual([status, 502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'])
    }
  })
})

describe('RESISTIU — D-F62: o aluguel cobre UMA candidata no pior caso de idas SEQUENCIAIS', () => {
  it('resistiu: 210 s ≥ (GET /dps + GET /nfse + 4 eventos) × timeout de inatividade do núcleo + folga', () => {
    expect(REFRESH_LEASE_SECONDS * 1000).toBeGreaterThanOrEqual(6 * DEFAULT_TIMEOUT_MS + 30_000)
  })
})

describe('RESISTIU — `cut()` da nfse-api', () => {
  it('resistiu: xDescServ "a" + 2500 espaços + "b" → "a"; multilinha cortada logo depois da quebra → sem quebra na ponta', () => {
    const x1 = buildDpsXml(dpsWith(d => { d.serv.cServ.xDescServ = 'a' + ' '.repeat(2500) + 'b' }), DPS_XML_ID)
    expect(textOf(x1, 'xDescServ')).toBe('a')
    const x2 = buildDpsXml(dpsWith(d => { d.serv.cServ.xDescServ = 'l'.repeat(1999) + ' \nresto' }), DPS_XML_ID)
    expect(textOf(x2, 'xDescServ')).toBe('l'.repeat(1999))
  })
})

describe('ACHADO R11-07 (LOW) — arquivo fiscal ROTULADO errado: o XML do evento de cancelamento é gravado SEMPRE como `<chave>-evt101101.xml` (`cancelEventFileName`, nos dois serviços) — com a D-F64 o tipo passou a importar e o e105102 (substituição) fica no arquivo do contribuinte com o nome de "cancelamento pelo emitente"', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
  it.failing('[LOW R11-07] consulta lê e105102 → o XML do evento gravado no arquivo fiscal NÃO se chama "-evt101101.xml"', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefinSubstituted()
    await refreshServiceTransmission(realDeps(), A, INVOICE, 'Q')
    const subst = walk(storageRoot).filter(f => fs.readFileSync(f, 'utf8').includes('<e105102>'))
    expect(subst).toHaveLength(1)                                      // o evento foi arquivado…
    expect(path.basename(subst[0])).not.toMatch(/-evt101101\.xml$/)   // …com o nome do TIPO certo (hoje: -evt101101.xml)
  })
})

// ===========================================================================
// RODADA 14 (Valdo 2026-10-10, "siga as recomendações" do gate socrático da Rodada 13) — L6/L7 no adaptador (porte D-F43)
// ===========================================================================
describe('RODADA 14 — L6/L7 no adaptador ADN da nfse-api', () => {
  it('L6: NFS-e com o bloco <e101101> embutido → cancelled COM eventCode 101101 (nunca voz C sem código depois da D-F68)', async () => {
    const withBlock = NFSE_XML.replace('</infNFSe>', '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>erro na emissao do servico</xMotivo></e101101></infNFSe>')
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(withBlock) }) })
    const out = await adnAdapter.queryNfse(ctxH as any, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('D-F84 (= Q-F90 — supera o L7): o GET tipado traz DOIS tipos desta chave (305101 antes do 101101 perguntado) → AMBÍGUO (unknown)', async () => {
    const both = { ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml({ code: '305101' })), '305101'), typedItem(arquivo2(generatedEventXml({ code: '101101' })))] }
    sefin({ typed: code => (code === '101101' ? ok(both) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH as any, KEY)
    expect(out.status).toBe('unknown')
  })
  it('D-F84: dois itens do MESMO tipo desta chave (repetição) → vale (não é contradição)', async () => {
    const twice = { ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml({ code: '101101' }))), typedItem(arquivo2(generatedEventXml({ code: '101101' })))] }
    sefin({ typed: code => (code === '101101' ? ok(twice) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH as any, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
})

// ===========================================================================
// RODADA 16 (Valdo 2026-10-11, "siga as recomendações" — gates da Rodada 15): D-F86 (o laço para no primeiro tipo — fixado) e
// D-F87 (a passada registra o ambíguo persistente COM a nota, para o alarme da F3)
// ===========================================================================
describe('RODADA 16 — D-F86/D-F87 na nfse-api', () => {
  it('D-F86 (CONHECIMENTO NEGATIVO): rota 101101 limpa + um e105102 na rota dele → "cancelled 101101" e a rota 105102 NEM é perguntada (cancelamento é único por NFS-e — D-F61)', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' }))))
      : code === '105102' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')) : undefined) })
    const out = await adnAdapter.queryNfse(ctxH as any, KEY)
    expect(out).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
    const asked = mockHttp.mock.calls.map((c: any[]) => String(c[0].url).match(/\/eventos\/(\d+)\/1$/)?.[1]).filter(Boolean)
    expect(asked).toEqual(['101101'])
  })
  it('D-F87: a passada com resposta AMBÍGUA persistente registra "Fisco ambíguo persistente" COM institution, nota e tentativa (o alarme da F3 sabe QUAL nota)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' }))), typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')) : undefined) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A)
    expect(r.errors[0]).toMatchObject({ code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    const logged = ((fiscal.logger as any).error as jest.Mock).mock.calls.find((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))
    expect(logged?.[1]).toMatchObject({ institutionId: A.institutionId, invoiceId: INVOICE, attempt: 1 })
  })
})

// ===========================================================================
// RODADA 17 (Valdo 2026-10-11, "siga as recomendações"): D-F91 — o alarme do ambíguo também na consulta da TELA e na RECONFERÊNCIA
// ===========================================================================
describe('RODADA 17 — D-F91 na nfse-api', () => {
  const ambiguousLogs = () => ((fiscal.logger as any).error as jest.Mock).mock.calls.filter((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))
  const CONTRA = (code: string) => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' }))), typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102')) : undefined)
  it('D-F91: a consulta da TELA com resposta ambígua → 502 e UM alarme "consulta" com institution e nota', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefin({ typed: CONTRA })
    const out = await settle(refreshServiceTransmission(realDeps(), A, INVOICE, 'Q', { origin: 'consulta' }))   // D-F95: a tela diz a origem
    expect(out).toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(ambiguousLogs()).toHaveLength(1)
    expect(ambiguousLogs()[0][1]).toMatchObject({ origin: 'consulta', institutionId: A.institutionId, invoiceId: INVOICE })
  })
  it('D-F91: o rodízio registra UMA vez (origem "rodizio", tentativa e última voz)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ lastKind: 'A' })])
    sefin({ typed: CONTRA })
    await refreshOpenServiceTransmissions(realDeps(), A)
    expect(ambiguousLogs()).toHaveLength(1)
    expect(ambiguousLogs()[0][1]).toMatchObject({ origin: 'rodizio', invoiceId: INVOICE, attempt: 1, lastKind: 'A' })
  })
})
