/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 15 das APIs fiscais (D-F84 = Q-F90 · D-F85 = Q-F91, Valdo 2026-10-10) — nfse-api (+ núcleo fiscal-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F84 no adaptador ADN da nfse-api (`authority/adn.ts` — GET tipado com TIPOS DIFERENTES de cancelamento desta
// chave = ambíguo, supera o L7) e D-F85 em `substituteKeyOf` (`nfse/transmission.ts` — substituta só do MESMO emitente).
//
//  * ACHADOS (`it.failing('[SEV R15-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r13-gate.test.ts`), nenhuma migration, nenhum script que fale com o fisco.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, localCancelPending, isSubstitutionCancel } from 'fiscal-api'
import { refreshServiceTransmission, getServiceFiscalView, NfseDeps } from '../nfse/transmission'

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
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r15-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000195'
const KEY = '4106902212345678000195000000000012320260921000012345'.slice(0, 50)
const SUBST_KEY = `${KEY.slice(0, -1)}9`
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const nfseXmlFor = (extra = '') =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS>${extra}</infNFSe></NFSe>`
const NFSE_XML = nfseXmlFor()

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-10-10 21:43:04', createdAt: '2026-10-10 21:43:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})

let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  conn.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null }, cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
    info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
  })
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

// ---------------------------------------------------------------------------
// A Sefin REAL (D-F61) pelo transporte do NÚCLEO — nenhum socket (molde do r11 da nfse-api)
// ---------------------------------------------------------------------------
import { transport, HttpsCall } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'

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
const typedItem = (file: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: file })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
function generatedEventXml(o: { key?: string; code?: string; inner?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${key}${code}001"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-10-10T18:43:05-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo>${o.inner ?? ''}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}
const substEventXml = (substitute: string) => generatedEventXml({ code: '105102', inner: `<chSubstituta>${substitute}</chSubstituta>` })
function sefin(o: { nfse?: () => any; typed?: (code: string) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1])) ?? sefinNone()
    if (/\/nfse\/\d+$/.test(call.url)) return o.nfse?.() ?? ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return notFound()
  })
}
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const insertedEvents = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map((c: any[]) => c[3])
const fiscoCalls = () => mockHttp.mock.calls.filter((c: any[]) => !/convenio/.test(c[0].url)).length

// ---------------------------------------------------------------------------
// Ferramentas do R15
// ---------------------------------------------------------------------------
import { reconfirmationCandidate, reconfirmationProven, ErrorCodes } from 'fiscal-api'
import { refreshOpenServiceTransmissions, reconfirmBeforeLocalCancel, IN_FLIGHT_MINUTES } from '../nfse/transmission'
import { webRef, WEB, refOf } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return reconfirmationProven(cc, life ?? [cc])
}

const OTHER_KEY = `${KEY.slice(0, 40)}9999999999`
const item = (code: string, o: { key?: string; inner?: string } = {}) =>
  typedItem(arquivo2(generatedEventXml({ code, key: o.key, inner: o.inner })), code, o.key ?? KEY)
const divergentLogged = () => ((fiscal.logger as any).error as jest.Mock).mock.calls.some((c: any[]) => /tipos diferentes de (cancelamento|evento)/.test(String(c[0])))   // D-F88: o log diz "de evento"
const pooledTouches = () => (repo.touchQueriedAt as jest.Mock).mock.calls.filter((c: any[]) => c[0] === pool)

/** A Sefin falsa com `/dps/{id}` (a revisita do F e a reconferência perguntam a chave pelo Id do DPS). */
function fisco(o: { typed?: (code: string) => any; dpsKey?: string | null; dps?: () => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return o.dps?.() ?? (o.dpsKey ? ok({ chaveAcesso: o.dpsKey }) : ok({ erro: { codigo: 'E2404' } }, 404))
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1])) ?? sefinNone()
    if (/\/nfse\/\d+$/.test(call.url)) return ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return notFound()
  })
}
const CONTRADICTION_101101 = (code: string) => (code === '101101' ? typedOk(item('101101'), item('105102')) : undefined)
const fiscalUnknown = { statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE }

beforeEach(() => {
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.listRefreshCandidates as jest.Mock).mockReset().mockResolvedValue([])
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
})

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R15-01 (LOW) — D-F84 na nfse-api só conta tipos DO DOMÍNIO de cancelamento: [e105105 (cancelamento INDEFERIDO), e105104 (DEFERIDO)] gerados desta chave em /eventos/105104/1 → o 105105 cai no filtro `CANCEL_EVENT_CODES` antes do conjunto de tipos e a resposta antagônica vira cancelled 105104 (C local automático)', () => {
  const deferredAndRefused = (code: string) => (code === '105104' ? typedOk(item('105105'), item('105104')) : undefined)
  it('[CORRIGIDO — D-F88] [LOW R15-01] adaptador: tipos diferentes gerados desta chave no mesmo GET tipado → unknown (502), nunca "cancelled"', async () => {
    fisco({ typed: deferredAndRefused })
    const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
    expect(out?.status === 'cancelled').toBe(false)              // hoje: cancelled 105104
  })
  it('[CORRIGIDO — D-F88] [LOW R15-01] composição: a consulta com essa resposta NÃO devolve localCancelPending=true (o app aplicaria o C local sem humano)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    fisco({ typed: deferredAndRefused })
    const r = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(r?.localCancelPending === true).toBe(false)           // hoje: true (voz C 105104 gravada)
  })
})

describe('ACHADO R15-02 (MEDIUM — pré-existente D-F52 × D-F63, latente até a F2a; a D-F84 é mais um gatilho) — a REVISITA do F "envio interrompido" pelo rodízio acha a NFS-e no fisco (GET /dps devolve a chave) mas a consulta pela chave é AMBÍGUA (502) → o rodízio carimba `last_queried_at` FORA da transação como "falha persistente" — e esse carimbo É a prova da D-F29 (`reconfirmationProven`: alguém olhou o fisco DEPOIS do F) que libera o cancelamento LOCAL de uma nota cuja NFS-e o fisco acabou de mostrar', () => {
  const F = () => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2,
    lastEventAt: '2026-10-09 10:00:00', lastQueriedAt: '2026-10-09 10:00:00' })
  it('contexto [R15-02]: a candidata é a da reconferência (F por consulta, em P, sem chave) e a prova ainda NÃO existe antes da passada', () => {
    const f = F()
    expect(reconfirmationCandidate([f])).toMatchObject({ attempt: 1 })
    expect(proven(f)).toBe(false)
  })
  it('[CORRIGIDO — D-F90] [MEDIUM R15-02] rodízio: revisita do F + GET /dps ACHA a chave + /eventos/101101/1 contraditório (D-F84) → a prova da D-F29 continua FALSA (o fisco mostrou a NFS-e: "não se prova no escuro")', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([f])
    fisco({ dpsKey: KEY, typed: CONTRADICTION_101101 })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])   // a NFS-e existe; a leitura é ambígua
    expect(mockHttp.mock.calls.some((c: any[]) => /\/dps\//.test(c[0].url))).toBe(true)
    const stamped = pooledTouches().some((c: any[]) => c[2] === INVOICE && c[3] === 1)
    const after = { ...f, lastQueriedAt: stamped ? '2026-10-10 22:00:00' : f.lastQueriedAt }  // o UPDATE … SET last_queried_at = NOW()
    expect(reconfirmationCandidate([after])).not.toBeNull()
    expect(proven(after)).toBe(false)              // hoje: true — o setes-api (F2a) cancelaria localmente
  })
  it('[CORRIGIDO — D-F90] [MEDIUM R15-02] mesma raiz, sem a D-F84: revisita do F + GET /dps AMBÍGUO (404 sem o corpo do fisco — gateway) → a prova da D-F29 continua FALSA ("404 vazio não é conclusivo" — Q-ADV1a)', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([f])
    fisco({ dps: () => ({ status: 404, headers: {}, text: '' }) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
    const stamped = pooledTouches().some((c: any[]) => c[2] === INVOICE && c[3] === 1)
    expect(proven({ ...f, lastQueriedAt: stamped ? '2026-10-10 22:00:00' : f.lastQueriedAt })).toBe(false)   // hoje: true
  })
  it('resistiu [R15-02]: o ATO da reconferência (`reconfirmBeforeLocalCancel`) com o mesmo fisco → 502 fail-closed, SEM carimbo (a prova não nasce por aqui)', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({ dpsKey: KEY, typed: CONTRADICTION_101101 })
    expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject(fiscalUnknown)
    expect(pooledTouches()).toHaveLength(0)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled(); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// RESISTIU — D-F84 no adaptador e na composição da nfse-api
// ===========================================================================

describe('RESISTIU — D-F84 no adaptador ADN da nfse-api', () => {
  it('resistiu: [e101101, e101101, e105102] → unknown + log de contrato divergente', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), item('101101'), item('105102')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown'); expect(divergentLogged()).toBe(true)
  })
  it('resistiu: /eventos/105102/1 com [e105102, e105104] → unknown (nenhuma marca de substituição a partir de resposta contraditória)', async () => {
    fisco({ typed: code => (code === '105102' ? typedOk(item('105102', { inner: `<chSubstituta>${SUBST_KEY}</chSubstituta>` }), item('105104')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
  it('resistiu: tipo diferente de OUTRA chave é filtrado antes do conjunto — [e101101 desta, e105102 de outra] → cancelled 101101', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), item('105102', { key: OTHER_KEY })) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH as any, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
    expect(divergentLogged()).toBe(false)
  })
  it('resistiu: mesmo tipo repetido vale — [e101101, e101101] → cancelled 101101', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), item('101101')) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH as any, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
})

describe('RESISTIU — D-F84 × composição da nfse-api', () => {
  it('resistiu: autorizada (A) + resposta contraditória → 502; nenhuma voz, nenhum write-once, transação desfeita', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    fisco({ typed: CONTRADICTION_101101 })
    expect(await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))).toMatchObject(fiscalUnknown)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled(); expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.commit).not.toHaveBeenCalled()
  })
  it(`resistiu: K em voo além da carência (${IN_FLIGHT_MINUTES} min) + resposta contraditória → 502; o K nunca vira N nem C`, async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES + 60 }))
    fisco({ typed: CONTRADICTION_101101 })
    expect(await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))).toMatchObject(fiscalUnknown)
    expect(insertedEvents()).toEqual([])
  })
  it('resistiu: rodízio de uma AUTORIZADA na resposta contraditória → 502 no relatório, a passada segue, carimbo fora da transação (anti-monopólio da D-F63)', async () => {
    const a = tx({ lastKind: 'A' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(a)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([a, a])
    fisco({ typed: CONTRADICTION_101101 })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
    expect(pooledTouches()).toHaveLength(2)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// RESISTIU — D-F85 na nfse-api
// ===========================================================================

describe('RESISTIU — D-F85 na nfse-api: `chSubstituta` × emitente embutido na chave (só exibição)', () => {
  const REAL = `4106902` + `2` + `2` + CNPJ + `0000000000704` + `2609` + `123456789` + `5`
  const at = (k: string, i: number, s: string) => k.slice(0, i) + s + k.slice(i + s.length)
  const SAME = at(REAL, 23, `0000000000705` + `2610` + `987654321` + `1`)
  it.each([
    ['mesmo emitente, outra NFS-e', true, () => SAME],
    ['mesmo emitente, outro cMun', true, () => at(SAME, 0, '3550308')],
    ['mesmo emitente, outro ambGer', true, () => at(SAME, 7, '1')],
    ['espaços/quebras em volta (o leitor apara)', true, () => ` \n${SAME}\n `],
    ['tpInsc diferente com a mesma inscrição', false, () => at(SAME, 8, '1')],
    ['filial do mesmo CNPJ raiz', false, () => at(SAME, 9, '12345678000280')],
    ['inscrição alfanumérica de outro emitente', false, () => at(SAME, 9, '12ABC34501DE35')],
    ['a própria chave substituída', false, () => REAL],
    ['chave de NF-e (44)', false, () => SAME.slice(0, 44)],
  ] as const)('resistiu: %s → exibida = %s', async (_l, expected, make) => {
    const sub = make()
    const current = tx({ attempt: 1, accessKey: REAL, lastKind: 'C', lastCode: '105102' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })
    deps.storage.save({ cnpj: CNPJ, kind: 'nfse', serie: '1', environment: 'H', zone: 'America/Sao_Paulo' }, `${REAL}-evt101101.xml`,
      generatedEventXml({ key: REAL, code: '105102', inner: `<chSubstituta>${sub}</chSubstituta>` }), new Date('2026-10-10T21:43:04Z'))
    const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
    expect(v.substitution?.substituteAccessKey ?? null).toBe(expected ? sub.trim() : null)
  })
})

// ===========================================================================
// D-F90 (= Q-F96 (c), Valdo 2026-10-11 — parecer do guardião): a prova da D-F29 é o E2404 EXPLÍCITO (`nfse_not_generated_at`),
// gravado por escritor PRÓPRIO e só quando a voz vista ainda é a última; o carimbo do rodízio nunca prova
// ===========================================================================
describe('D-F90 — prova explícita do "NFS-e não gerada" (E2404)', () => {
  const F = () => tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2,
    lastEventAt: '2026-10-09 10:00:00', lastQueriedAt: '2026-10-09 10:00:00' })
  const notGeneratedWrites = () => pool.query.mock.calls.filter((c: any[]) => /nfse_not_generated_at = NOW\(\)/.test(String(c[0])))
  it('o ATO da reconferência com E2404 grava a prova pelo escritor próprio, guardado pela voz VISTA (o F da candidata, evento 2)', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({})                                                                  // GET /dps → 404 {erro:{codigo:'E2404'}}
    const base = pool.query.getMockImplementation()
    pool.query.mockImplementation(async (sql: string, p: any[]) => (/nfse_not_generated_at = NOW\(\)/.test(sql) ? [{ affectedRows: 1 }] : base!(sql, p)))
    const r = await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))
    expect(r).toMatchObject({ needed: true, found: false, attempt: 1 })
    expect(notGeneratedWrites()).toHaveLength(1)
    expect(notGeneratedWrites()[0][1]).toEqual([A.institutionId, INVOICE, WEB, 1, 2])
    expect(String(notGeneratedWrites()[0][0]).replace(/\s+/g, ' ')).toContain('COALESCE(MAX(e.event), 0) FROM tb_invoice_service_transmission_event e')
  })
  it('a revisita do F pelo rodízio com E2404 também grava (guardada pela voz vista); com resposta AMBÍGUA nunca grava', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([f])
    fisco({})
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(notGeneratedWrites().map((c: any[]) => c[1])).toEqual([[A.institutionId, INVOICE, WEB, 1, 2]])
    pool.query.mockClear()
    fisco({ dpsKey: KEY, typed: CONTRADICTION_101101 })                     // a NFS-e existe; a leitura é ambígua (502)
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(notGeneratedWrites()).toHaveLength(0)
    fisco({ dps: () => ({ status: 404, headers: {}, text: '' }) })            // 404 sem o corpo do fisco: não é E2404
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(notGeneratedWrites()).toHaveLength(0)
  })
  it('o escritor devolve false quando a voz mudou desde a pergunta (resposta velha não pousa — gate r10)', async () => {
    const actualRepo = jest.requireActual('../nfse/repository')
    const q = { query: jest.fn(async () => [{ affectedRows: 0 }]) }
    expect(await actualRepo.recordNfseNotGenerated(q, refOf(1, INVOICE), 1, 2)).toBe(false)
    q.query.mockResolvedValueOnce([{ affectedRows: 1 }] as any)
    expect(await actualRepo.recordNfseNotGenerated(q, refOf(1, INVOICE), 1, null)).toBe(true)
    expect((q.query.mock.calls[1] as any[])[1]).toEqual([1, INVOICE, WEB, 1, 0])      // sem voz vista = 0 (o terminal por parâmetro — NE-1a parte 2)
  })
  it('a prova: E2404 no MESMO instante do F (a consulta que o gerou) não prova; posterior prova; o carimbo do rodízio nunca', () => {
    const f = { ...F(), createdAt: '2026-10-09 09:59:00' }   // D-F97: a reserva (apresentação) é anterior ao F
    expect(proven({ ...f, nfseNotGeneratedAt: f.lastEventAt })).toBe(false)
    expect(proven({ ...f, nfseNotGeneratedAt: '2026-10-10 09:00:00' })).toBe(true)
    expect(proven({ ...f, nfseNotGeneratedAt: null, lastQueriedAt: '2026-10-10 09:00:00' })).toBe(false)
  })
})

describe('D-F91 (Rodada 17) — reconferência ambígua alimenta o alarme', () => {
  it('reconferência com GET /dps achando a chave e resposta contraditória → 502 fail-closed, UM alarme "reconferencia" com a tentativa, nenhuma prova', async () => {
    const f = tx({ environment: 'P', accessKey: null, nfseNumber: null, dhProc: null, lastKind: 'F', lastSource: 'Q', lastEvent: 2,
      lastEventAt: '2026-10-09 10:00:00', lastQueriedAt: '2026-10-09 10:00:00' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({ dpsKey: KEY, typed: CONTRADICTION_101101 })
    expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject(fiscalUnknown)
    const logs = ((fiscal.logger as any).error as jest.Mock).mock.calls.filter((c: any[]) => /Fisco ambíguo persistente/.test(String(c[0])))
    expect(logs).toHaveLength(1)
    expect(logs[0][1]).toMatchObject({ origin: 'reconferencia', institutionId: A.institutionId, invoiceId: INVOICE, attempt: 1 })
    expect(pool.query.mock.calls.some((c: any[]) => /nfse_not_generated_at = NOW/.test(String(c[0])))).toBe(false)
  })
})
