/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 16 das APIs fiscais (D-F86…D-F90, Valdo 2026-10-11) — nfse-api (+ núcleo fiscal-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F86 (laço para no 1º tipo — fixado), D-F87 (log do ambíguo persistente COM a nota na passada),
// D-F88/D-F89 (`authority/adn.ts` — todo evento gerado desta chave conta; mesmo tipo só vale com conteúdo idêntico —
// `eventSignature`), D-F90 (`nfse_not_generated_at` + escritor `recordNfseNotGenerated` guardado pela última voz vista;
// `reconfirmationProven` = E2404 explícito POSTERIOR ao F).
//
//  * ACHADOS (`it.failing('[SEV R16-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do `adversarial-r15-gate.test.ts`), nenhuma migration aplicada (o SQL da 003 é só LIDO do disco), nada que fale com o fisco.
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r16-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const INVOICE_B = 6201
const CNPJ = '12345678000195'
const KEY = '4106902212345678000195000000000012320260921000012345'.slice(0, 50)
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
import { webRef, WEB, refOf } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return reconfirmationProven(cc, life ?? [cc])
}

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
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R16-01 (LOW) — D-F89: `eventSignature` cobre só 8 campos (código, Id, dhProc, dhEvento, nSeqEvento, cMotivo, xMotivo, chSubstituta); dois eventos do MESMO tipo com o MESMO Id que divergem FORA desses campos (nDFSe — o número do documento no ADN —, autor, ambGer…) passam como "repetição" e o XML ARQUIVADO (Q-N38/D-F78) é o do 1º item — depende da ordem da lista, o que a D-F89 diz que não pode acontecer', () => {
  const one = generatedEventXml({ code: '101101' })
  const other = one.replace('<nDFSe>1</nDFSe>', '<nDFSe>2</nDFSe>')
  it('[CORRIGIDO — D-F93] [LOW R16-01] /eventos/101101/1 com [e101101 nDFSe 1, e101101 nDFSe 2] (mesmo Id) → ambíguo nas duas ordens OU o mesmo XML arquivado nas duas ordens', async () => {
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(one), typedItemRaw(other)) : undefined) })
    const ab = await adnAdapter.queryNfse(ctxH as any, KEY)
    mockHttp.mockReset()
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(other), typedItemRaw(one)) : undefined) })
    const ba = await adnAdapter.queryNfse(ctxH as any, KEY)
    const orderIndependent = (ab.status === 'unknown' && ba.status === 'unknown') || ab.cancelled?.eventXml === ba.cancelled?.eventXml
    expect(orderIndependent).toBe(true)          // hoje: cancelled nas duas, com o XML do 1º item de cada lista (nDFSe 1 × nDFSe 2)
  })
})

describe('R16-02 (LOW — CORRIGIDO DURANTE O GATE pelo LOW-4 do socrático da Rodada 16) — `reconfirmBeforeLocalCancel` ignorava o retorno de `recordNfseNotGenerated`: com a guarda recusando (voz nova durante a pergunta), o ato respondia `{ needed: true, found: false }` sem a prova ter pousado', () => {
  it('resistiu [R16-02]: guarda recusou (o rodízio gravou o A da NFS-e atrasada durante o GET /dps) → 409 RESOURCE_BUSY, nunca "não achou"', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({ onDps: () => { maxEvent = 3 } })                // o rodízio gravou o A (evento 3) enquanto a reconferência perguntava
    const r = await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(stamps).toHaveLength(0); expect(refusedStamps).toBe(1)   // a guarda funcionou (fail-closed no banco)…
    expect(r).toMatchObject({ statusCode: 409, code: ErrorCodes.RESOURCE_BUSY })   // …e a resposta não afirma o que não foi gravado
  })
  it('resistiu [R16-02]: sem concorrência a reconferência responde "não achou" e a prova pousa com a voz do F', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({})
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))).toMatchObject({ needed: true, found: false, attempt: 1 })
    expect(stamps).toEqual([{ attempt: 1, seen: 2 }])
  })
})

describe('ACHADO R16-03 (LOW, pré-existente — a D-F90 o promove a PROVA) — `isDpsNotGenerated` não confere `tipoAmbiente` do envelope: um E2404 com o envelope de HOMOLOGAÇÃO (tipoAmbiente 2) numa pergunta de PRODUÇÃO vira "DPS sem NFS-e" e grava a prova da D-F29 em P (o "não há evento" do GET tipado confere o ambiente desde o L8)', () => {
  it('[CORRIGIDO — regra do L8 no E2404] [LOW R16-03] adaptador: E2404 com tipoAmbiente 2 numa pergunta em P → ambíguo (502), nunca null', async () => {
    fisco({ dps: () => E2404(2) })
    const out = await settle(adnAdapter.queryDpsAccessKey(ctxP as any, DPS_ID))
    expect(out).not.toBeNull()                               // hoje: null ("o fisco não gerou NFS-e para este DPS")
  })
  it('[CORRIGIDO — regra do L8 no E2404] [LOW R16-03] composição: a reconferência em P com esse envelope NÃO grava a prova', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({ dps: () => E2404(2) })
    await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))
    expect(stamps).toHaveLength(0)                           // hoje: 1 (prova gravada a partir da voz de OUTRO ambiente)
  })
  it('resistiu [R16-03]: o MESMO envelope com tipoAmbiente 1 (P) e a forma sem envelope (só `erro`) seguem valendo como E2404', async () => {
    fisco({ dps: () => E2404(1) })
    expect(await adnAdapter.queryDpsAccessKey(ctxP as any, DPS_ID)).toBeNull()
    mockHttp.mockReset(); fisco({ dps: () => E2404() })
    expect(await adnAdapter.queryDpsAccessKey(ctxP as any, DPS_ID)).toBeNull()
  })
})

// ===========================================================================
// RESISTIU — D-F90 (prova explícita do "NFS-e não gerada")
// ===========================================================================

describe('RESISTIU — D-F90: a guarda pela última voz VISTA', () => {
  it('resistiu: E2404 na consulta de tentativa EM VOO recente (sem voz) grava com voz vista 0; o F que nasce DEPOIS (mesmo segundo ou posterior) não fica provado por ela', async () => {
    const t = inFlight()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
    fisco({})
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(r).toMatchObject({ changed: false, kind: null })
    expect(stamps).toEqual([{ attempt: 1, seen: 0 }])
    // o F nasce depois (relógio do mesmo servidor: created_at = NOW() do INSERT); a prova exige E2404 ESTRITAMENTE posterior
    const at = '2026-10-11 10:00:00'
    expect(proven({ nfseNotGeneratedAt: at, lastEventAt: at })).toBe(false)
    expect(proven({ nfseNotGeneratedAt: at, lastEventAt: '2026-10-11 10:00:01' })).toBe(false)
  })
  it('resistiu: E2404 obtido ANTES de um F concorrente (o F nasce durante o GET /dps) → a guarda usa a voz lida ANTES da pergunta e recusa', async () => {
    const t = inFlight()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
    fisco({ onDps: () => { maxEvent = 1 } })                 // recordInterruptedFailure de outra passada gravou o F (evento 1)
    await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(stamps).toHaveLength(0); expect(refusedStamps).toBe(1)
    expect(notGeneratedWrites()[0][1]).toEqual([A.institutionId, INVOICE, WEB, 1, 0])   // voz vista = a da leitura (nenhuma), não relida depois
  })
  it('resistiu: revisita do F com E2404 e outra voz concorrente durante o GET → nada pousa; sem concorrência pousa com a voz do F', async () => {
    const f = F()
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([f])
    maxEvent = 2
    fisco({ onDps: () => { maxEvent = 3 } })
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(stamps).toHaveLength(0)
    maxEvent = 2; mockHttp.mockReset(); fisco({})
    await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(stamps).toEqual([{ attempt: 1, seen: 2 }])
  })
  it('resistiu: dois "não gerada" seguidos na mesma tentativa — os dois pousam (o 2º só regrava o instante) e a prova continua sendo "posterior ao F"', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({})
    await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))
    await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))
    expect(stamps).toEqual([{ attempt: 1, seen: 2 }, { attempt: 1, seen: 2 }])
    expect(proven({ nfseNotGeneratedAt: '2026-10-11 10:00:02', lastEventAt: f.lastEventAt })).toBe(true)
  })
  it('resistiu: reconferência em HOMOLOGAÇÃO — a candidata é só P (Q-CA5b): nada a reconfirmar, nenhum GET, nenhuma prova', async () => {
    const f = F({ environment: 'H' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    fisco({})
    expect(await reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE))).toMatchObject({ needed: false })
    expect(mockHttp).not.toHaveBeenCalled(); expect(notGeneratedWrites()).toHaveLength(0)
    expect(reconfirmationCandidate([f as any])).toBeNull()
  })
  it('resistiu: E2404 só vale na forma do fisco — 404 vazio/HTML (gateway) e 404 JSON sem E2404 nunca gravam a prova (reconferência → 502)', async () => {
    const f = F()
    maxEvent = 2
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(f)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f], events: [] })
    for (const dps of [() => notFound(), () => ({ status: 404, headers: {}, text: '<html>Not Found</html>' }), () => ok({ erro: { codigo: 'E0001' } }, 404), () => ok({ ...SEFIN }, 404)]) {
      mockHttp.mockReset(); fisco({ dps })
      expect(await settle(reconfirmBeforeLocalCancel(realDeps(), A, webRef(A, INVOICE)))).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    }
    expect(notGeneratedWrites()).toHaveLength(0)
  })
})

describe('RESISTIU — D-F90: o SQL da guarda, da leitura e da view usam a MESMA "última voz" (só `deleted = N`, mesma tentativa)', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ')
  it('resistiu: escritor — subselect escopado por institution/nota/terminal/tentativa e só voz viva; voz vista nula = 0 (= COALESCE)', async () => {
    const actual = jest.requireActual('../nfse/repository')
    const q = { query: jest.fn(async () => [{ affectedRows: 1 }]) }
    await actual.recordNfseNotGenerated(q, refOf(1, INVOICE), 3, null)
    const [sql, params] = (q.query.mock.calls[0] as any[])
    expect(norm(sql)).toMatch(/WHERE t\.tb_institution_id = \? AND t\.tb_invoice_id = \? AND t\.terminal = \? AND t\.attempt = \?/)   // NE-1a parte 2: terminal por parâmetro
    for (const frag of ['e.tb_institution_id = t.tb_institution_id', 'e.tb_invoice_id = t.tb_invoice_id', 'e.terminal = t.terminal', 'e.attempt = t.attempt', "e.deleted = 'N'", 'COALESCE(MAX(e.event), 0)']) {
      expect(norm(sql)).toContain(frag)
    }
    expect(params).toEqual([1, INVOICE, WEB, 3, 0])
  })
  it('resistiu: leitor da nfse-api (TX_SELECT → `lastEvent`) também é a MAIOR voz viva — a voz soft-deletada não vira "voz vista"', async () => {
    const actual = jest.requireActual('../nfse/repository')
    const q = { query: jest.fn(async () => [[]]) }
    await actual.getTransmission(q, refOf(1, INVOICE), 1)
    const sql = norm(String((q.query.mock.calls[0] as any[])[0]))
    expect(sql).toContain("le.deleted = 'N'")
    expect(sql).toMatch(/SELECT MAX\(x\.event\) FROM tb_invoice_service_transmission_event x WHERE .*x\.attempt = t\.attempt AND x\.deleted = 'N'/)
  })
  it('resistiu: migration 003 — coluna nasce NULL sem backfill (o carimbo antigo não prova), re-executável, e a view expõe a coluna com a MESMA última voz viva', () => {
    const sql = norm(fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '003_transmission_nfse_not_generated.sql'), 'utf8'))
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS `nfse_not_generated_at` DATETIME DEFAULT NULL/)
    expect(sql).not.toMatch(/UPDATE\s+`?tb_invoice_service_transmission/i)
    expect(sql).toContain("t.`nfse_not_generated_at`")
    expect(sql).toContain("le.`deleted` = 'N'"); expect(sql).toContain("x.`deleted` = 'N'"); expect(sql).toContain("WHERE t.`deleted` = 'N'")
  })
})

// ===========================================================================
// RESISTIU — D-F88/D-F89 no adaptador ADN da nfse-api
// ===========================================================================

describe('RESISTIU — D-F88/D-F89 no adaptador ADN da nfse-api', () => {
  it('resistiu: D-F89 repetição LEGÍTIMA com formatação diferente (XML indentado, declaração, espaços em volta dos valores) → cancelled (o leitor apara; espaço entre tags não conta)', async () => {
    const compact = generatedEventXml({ code: '101101' })
    const pretty = '<?xml version="1.0" encoding="UTF-8"?>\n' + compact.replace(/></g, '>\n  <').replace('<xMotivo>cliente desistiu do serviço</xMotivo>', '<xMotivo>\n   cliente desistiu do serviço  \n</xMotivo>')
    fisco({ typed: code => (code === '101101' ? typedOk(typedItemRaw(compact), typedItemRaw(pretty)) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH as any, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101', motive: 'cliente desistiu do serviço' } })
  })
  it('resistiu: D-F89 nSeqEvento diferente no mesmo GET tipado (/1) → ambíguo', async () => {
    const seq2 = generatedEventXml({ code: '101101' }).replace('<nSeqEvento>1</nSeqEvento>', '<nSeqEvento>2</nSeqEvento>')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(seq2)) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
  it('resistiu: D-F89 Id diferente (mesmo tipo, mesmo conteúdo) → ambíguo', async () => {
    const otherId = generatedEventXml({ code: '101101' }).replace(`Id="EVT${KEY}101101001"`, `Id="EVT${KEY}101101002"`)
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(otherId)) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
  it('resistiu: D-F88/D-F89 só contam eventos GERADOS DESTA chave — e101101 de OUTRA chave com outro motivo e o ECO do nosso pedido (sem Id/dhProc) de outro tipo são filtrados antes → cancelled 101101', async () => {
    const otherKeyOtherMotive = generatedEventXml({ code: '101101', key: KEY_B }).replace('cliente desistiu do serviço', 'erro de valor na emissao')
    const echo105102 = `<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infPedReg Id="PRE${KEY}105102"><tpAmb>2</tpAmb><verAplic>SETES</verAplic>` +
      `<dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${KEY}</chNFSe><e105102><xDesc>x</xDesc><cMotivo>1</cMotivo><xMotivo>eco</xMotivo></e105102></infPedReg></pedRegEvento>`
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(otherKeyOtherMotive, '101101', KEY_B), typedItemRaw(echo105102, '105102')) : undefined) })
    expect(await adnAdapter.queryNfse(ctxH as any, KEY)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('resistiu: D-F88 tipo FORA do domínio (e101103) com chNFSe formatado (pontos/espaços) ainda é "desta chave" → conta → ambíguo', async () => {
    const dotted = KEY.replace(/(\d{10})/g, '$1.').replace(/\.$/, '')
    const x = generatedEventXml({ code: '101103' }).replace(`<chNFSe>${KEY}</chNFSe>`, `<chNFSe> ${dotted} </chNFSe>`)
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(x, '101103')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
  it('contexto [liveness, fail-closed]: o MESMO instante em formatos diferentes (−03:00 × Z) conta como conteúdo diferente → ambíguo (a nota fica presa até o fisco repetir igual; nunca efeito errado)', async () => {
    const zulu = generatedEventXml({ code: '101101' }).replace('<dhProc>2026-10-10T18:43:05-03:00</dhProc>', '<dhProc>2026-10-10T21:43:05Z</dhProc>')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(zulu)) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
  })
  it('resistiu: D-F86 — rota 101101 AMBÍGUA (D-F89) não segue para as rotas seguintes (nada de "tentar a próxima" e achar outra marca)', async () => {
    const other = generatedEventXml({ code: '101101' }).replace('cliente desistiu do serviço', 'erro de valor na emissao')
    fisco({ typed: code => (code === '101101' ? typedOk(item('101101'), typedItemRaw(other)) : code === '105102' ? typedOk(item('105102')) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('unknown')
    expect(mockHttp.mock.calls.map((c: any[]) => String(c[0].url).match(/\/eventos\/(\d+)\/1$/)?.[1]).filter(Boolean)).toEqual(['101101'])
  })
})

// ===========================================================================
// RESISTIU — D-F87 na passada da nfse-api
// ===========================================================================

describe('RESISTIU — D-F87: o alarme do ambíguo persistente na passada', () => {
  const txA = () => tx({ invoiceId: INVOICE, accessKey: KEY, lastKind: 'A' })
  const txB = () => tx({ invoiceId: INVOICE_B, accessKey: KEY_B, lastKind: 'A', attempt: 2 })
  function twoNotes() {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([txA(), txB()])
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, __r: any) => (__r.invoiceId === INVOICE_B ? txB() : txA()))
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async (_q: any, __r: any) => (__r.invoiceId === INVOICE_B ? txB() : txA()))
  }
  it('resistiu: passada com 2 notas, só a 2ª ambígua (D-F84) → UM alarme, com a nota/tentativa CERTAS (não a 1ª) e sem a chave de acesso no payload', async () => {
    twoNotes()
    fisco({ typed: (code, key) => (key === KEY_B && code === '101101' ? typedOk(item('101101', { key: KEY_B }), item('105102', { key: KEY_B })) : undefined) })
    const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    expect(r).toMatchObject({ checked: 2, stoppedEarly: false })
    expect(r.errors.map(e => e.invoiceId)).toEqual([INVOICE_B])
    expect(ambiguousLogs()).toHaveLength(1)
    expect(ambiguousLogs()[0][1]).toMatchObject({ institutionId: 1, invoiceId: INVOICE_B, attempt: 2, lastKind: 'A' })
    expect(JSON.stringify(ambiguousLogs()[0][1])).not.toContain(KEY_B)
  })
  it('resistiu: ambíguo que nasce NO ADAPTADOR (AuthorityHttpError 502 — 200 com a lista vazia, 401 na rota de evento) também dispara o alarme', async () => {
    for (const typed of [() => typedOk(), () => ({ status: 401, headers: {}, text: '' })]) {
      ;((fiscal.logger as any).error as jest.Mock).mockClear()
      ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([txA()])
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(txA())
      mockHttp.mockReset(); fisco({ typed: code => (code === '101101' ? typed() : undefined) })
      const r = await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
      expect(r.errors.map(e => e.code)).toEqual([ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE])
      expect(ambiguousLogs()).toHaveLength(1)
    }
  })
  it('resistiu: 503 TRANSITÓRIO (5xx/429 do fisco) e recusa de REGRA (422) nunca disparam o alarme do ambíguo', async () => {
    for (const nfse of [() => ({ status: 503, headers: {}, text: '' }), () => ({ status: 429, headers: {}, text: '' }), () => ({ status: 400, headers: {}, text: JSON.stringify({ erros: [{ codigo: 'E9999', descricao: 'x' }] }) })]) {
      ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([txA()])
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(txA())
      mockHttp.mockReset(); fisco({ nfse })
      await refreshOpenServiceTransmissions(realDeps(), A, { terminal: WEB })
    }
    expect(ambiguousLogs()).toHaveLength(0)
  })
})
