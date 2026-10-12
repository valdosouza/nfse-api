/// <reference types="jest" />
// GATE ADVERSARIAL — D-F61 (contrato REAL da Sefin para os eventos) + TSString + D-F59 — nfse-api (+ núcleo fiscal-api), 2026-10-10.
// ACHADOS = it.failing('[SEV ID] …') (prova do bug; o corretor troca para it); RESISTIU = it('resistiu: …').
// Nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/repositório/erp mockados — harness copiado do
// transmission.test.ts), nenhum script que fale com o fisco.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-df61-'))
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
const tx = (over: any = {}) => withRecord({
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
import { webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

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
const kindsInserted = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map((c: any[]) => c[3]?.kind)
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
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO DF61-01 (MEDIUM) — nfse-api: 200 no GET TIPADO (o evento EXISTE) com `arquivoXml` gzip válido mas ilegível vira "autorizada"', () => {
  const illegible: [string, string][] = [
    ['gzip de HTML de erro', arquivo2('<html><body>Erro interno</body></html>')],
    ['gzip do evento em UTF-16LE com BOM', arquivo2(Buffer.from('﻿' + generatedEventXml(), 'utf16le'))],
    ['gzip do evento com prefixo de namespace', arquivo2(generatedEventXml().replace(/<(\/?)/g, '<$1ns2:'))],
  ]
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-01a] adaptador da nfse-api → "unknown" ou 502, NUNCA "authorized"', async () => {
    for (const [label, file] of illegible) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(file)) : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
      expect([label, out?.status === 'authorized']).toEqual([label, false])
    }
  })
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-01b] refresh da nfse-api: K com 10 min + 200 tipado ilegível → grava N "não consta" (voz conclusiva sobre resposta ambígua)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(illegible[0][1])) : undefined) })
    const out = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(kindsInserted()).not.toContain('N')
    expect(out).toMatchObject({ statusCode: 502 })
  })
})

describe('ACHADO DF61-02 (MEDIUM — EXIGE DECISÃO; contraria "evento de outra chave → authorized (R2-2 (d))") — nfse-api: 200 tipado com evento de OUTRA chave / ecoado / outro tipo = resposta trocada lida como "autorizada"', () => {
  const swapped: [string, string][] = [
    ['evento de OUTRA chave', generatedEventXml({ key: OTHER_KEY })],
    ['pedido ecoado (sem Id EVT/dhProc)', generatedEventXml({ withId: false, withDhProc: false })],
    ['evento de outro tipo (e202201)', generatedEventXml({ code: '202201' })],
  ]
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-02a] adaptador da nfse-api → nunca "authorized"', async () => {
    for (const [label, xml] of swapped) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(xml))) : undefined) })
      const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
      expect([label, out?.status === 'authorized']).toEqual([label, false])
    }
  })
  it('[CORRIGIDO — D-F63] [MEDIUM DF61-02b] refresh da nfse-api: K com 10 min + evento de OUTRA chave no tipado → N falso', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(swapped[0][1]))) : undefined) })
    await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(kindsInserted()).not.toContain('N')
  })
})

describe('ACHADOS DF61-03/04/05/06 (LOW) — mesmo montador copiado na nfse-api (a correção tem de ir aos DOIS)', () => {
  it.failing('[LOW DF61-03] campo obrigatório esvaziado pelo toTsString (xNome CJK, xBairro/xDescServ só emoji) → recusa local ou elemento presente', () => {
    const cases: [string, (d: DpsInput) => void, string][] = [
      ['xNome CJK', d => { d.toma!.xNome = '株式会社東京' }, 'xNome'],
      ['xBairro emoji', d => { d.toma!.end!.xBairro = '\u{1F3E0}' }, 'xBairro'],
      ['xDescServ emoji', d => { d.serv.cServ.xDescServ = '\u{1F4E6}' }, 'xDescServ'],
    ]
    for (const [label, mutate, el] of cases) {
      let xml: string | null = null; let err: unknown = null
      try { xml = buildDpsXml(dpsWith(mutate), DPS_XML_ID) } catch (e) { err = e }
      expect([label, err !== null || !!textOf(xml!, el)]).toEqual([label, true])
    }
  })
  it.failing('[LOW DF61-04] xBairro 62 (TSBairro 60) e IM 20 (TSInscMun 15) → recusa local ou cabe', () => {
    const cases: [string, (d: DpsInput) => void, string, number][] = [
      ['xBairro 62', d => { d.toma!.end!.xBairro = 'Conjunto Habitacional Residencial Parque das Palmeiras Norte 1' }, 'xBairro', 60],
      ['IM 20', d => { d.prest.im = '01.06.501.367-7/0001' }, 'IM', 15],
    ]
    for (const [label, mutate, el, max] of cases) {
      let xml: string | null = null; let err: unknown = null
      try { xml = buildDpsXml(dpsWith(mutate), DPS_XML_ID) } catch (e) { err = e }
      expect([label, err !== null || (textOf(xml!, el) ?? '').length <= max]).toEqual([label, true])
    }
  })
  it('[CORRIGIDO] [LOW DF61-05 latente] docRef/xPed cortados num espaço continuam TSString', () => {
    const xml = buildDpsXml(dpsWith(d => { d.serv.infoCompl = { docRef: 'a'.repeat(254) + ' bcd', xPed: 'p'.repeat(59) + ' q' } }), DPS_XML_ID)
    expect(TS_STRING.test(textOf(xml, 'docRef')!)).toBe(true)
    expect(TS_STRING.test(textOf(xml, 'xPed')!)).toBe(true)
  })
  it('[CORRIGIDO — D-F66] [LOW DF61-06] NFD → NFC (acento decomposto não some)', () => {
    expect(toTsString('Serviço de manutenção')).toBe('Serviço de manutenção')
  })
})

describe('ACHADO DF61-07 (LOW) — nfse-api: D-F59 decidida pelo ambiente lido FORA (opened0) e o DPS enviado no ambiente lido SOB a trava', () => {
  it.failing('[LOW DF61-07] openIssuer H fora e P na reserva → DPS de produção (tpAmb 1) leva a IM do prestador', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockReset().mockResolvedValueOnce(opened('H')).mockResolvedValue(opened('P'))
    const box: { sent: { env: string; xml: string } | null } = { sent: null }
    adapter.transmit.mockImplementation(async (ctx: any, xml: string) => { box.sent = { env: ctx.environment, xml }; throw unavailable() })
    await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
    expect(box.sent).not.toBeNull()
    expect(box.sent!.env).toBe('P'); expect(box.sent!.xml).toContain('<tpAmb>1</tpAmb>')
    expect(prestOf(box.sent!.xml)).not.toContain('<IM>')
  })
})

// ===========================================================================
// RESISTIU
// ===========================================================================

describe('RESISTIU — nfse-api (adaptador + núcleo fiscal-api + composição)', () => {
  it('resistiu: 404 que imita o envelope com erro / eventos não vazio / HTML → 502 (núcleo + adaptador)', async () => {
    for (const text of [JSON.stringify({ ...SEFIN, erro: { codigo: 'E9999' } }), JSON.stringify({ ...SEFIN, eventos: [typedItem(arquivo2(generatedEventXml()))] }), '<html>404</html>']) {
      mockHttp.mockReset()
      sefin({ typed: code => (code === '101101' ? { status: 404, headers: {}, text } : undefined) })
      await expect(adnAdapter.queryNfse(ctxH as any, KEY)).rejects.toMatchObject({ statusCode: 502 })
    }
  })
  it('resistiu: forma REAL (2 camadas) → cancelled; 4 códigos com o envelope 404 → authorized em 5 chamadas', async () => {
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml()))) : undefined) })
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('cancelled')
    mockHttp.mockReset(); sefin()
    expect((await adnAdapter.queryNfse(ctxH as any, KEY)).status).toBe('authorized')
    expect(mockHttp).toHaveBeenCalledTimes(5)
  })
  it('resistiu: 503/405/timeout no 3º código → 503/502/503; refresh com K de 10 min não grava N nem "nós olhamos"', async () => {
    const cases: [() => any, number][] = [[() => ({ status: 503, headers: {}, text: '' }), 503], [() => ({ status: 405, headers: {}, text: '' }), 502], [() => { throw new Error('timeout') }, 503]]
    for (const [resp, status] of cases) {
      mockHttp.mockReset(); (repo.insertTransmissionEvent as jest.Mock).mockClear(); (repo.touchQueriedAt as jest.Mock).mockClear()
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K', lastEvent: 2, lastEventAgeMinutes: IN_FLIGHT_MINUTES }))
      sefin({ typed: code => (code === '105104' ? resp() : undefined) })
      const out = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
      expect([status, out?.statusCode]).toEqual([status, status])
      expect(repo.insertTransmissionEvent).not.toHaveBeenCalled(); expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    }
  })
  it('resistiu: 405 no POST /nfse (núcleo fiscal-api) → 502 ambíguo; a reserva fica em voo, nenhuma voz R/F', async () => {
    sefin({ post: () => ({ status: 405, headers: { allow: 'GET' }, text: '' }) })
    const out = await settle(transmitServiceInvoice(realDeps(), A, webRef(A, INVOICE)))
    expect(out).toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1); expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
  it('resistiu: D-F59 — P sem IM do prestador; H com a IM aparada', async () => {
    for (const env of ['P', 'H']) {
      ;(fiscal.openIssuer as jest.Mock).mockReset().mockResolvedValue(opened(env))
      erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => ({ ...entity(id), im: id === 1 ? '  01.065.013-677 ' : null }))
      let xml = ''
      adapter.transmit.mockReset().mockImplementation(async (_c: any, x: string) => { xml = x; throw unavailable() })
      await settle(transmitServiceInvoice(deps, A, webRef(A, INVOICE)))
      expect([env, prestOf(xml).includes('<IM>01.065.013-677</IM>')]).toEqual([env, env === 'H'])
      expect(xml).toContain(env === 'P' ? '<tpAmb>1</tpAmb>' : '<tpAmb>2</tpAmb>')
    }
  })
  it('resistiu: motivo do fisco com acentuação DUPLA (C1 incluído) vira voz C como veio, sem quebrar', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    const mojibake = Buffer.from('Correção da emissão — AÇÃO', 'utf8').toString('latin1')
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml().replace('cliente desistiu do serviço', mojibake)))) : undefined) })
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(r).toMatchObject({ kind: 'C' })
    const c = (repo.insertTransmissionEvent as jest.Mock).mock.calls.find((x: any[]) => x[3]?.kind === 'C')![3]
    expect(c.message).toBe(`Cancelada no fisco: ${mojibake}`)
  })
})

describe('DF61-08 (LOW) — orçamento da passada na nfse-api também só é conferido entre candidatas', () => {
  it.failing('[LOW DF61-08] orçamento de 60 ms com 40 ms por GET tipado → a passada termina em < 2× o orçamento', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([{ invoiceId: INVOICE, attempt: 1 }])
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefin({ typed: () => delay(40, () => sefinNone()) })
    const d = realDeps()
    await refreshOpenServiceTransmissions(d, A, { terminal: WEB, budgetMs: 10_000 })          // aquece o cache do teto do PAM (fora da medida)
    mockHttp.mockClear()
    const t0 = Date.now()
    const r = await refreshOpenServiceTransmissions(d, A, { terminal: WEB, budgetMs: 60 })
    expect(r.checked).toBe(1)
    expect(Date.now() - t0).toBeLessThan(120)
  })
})

describe('ACHADO DF61-09 (LOW) — núcleo fiscal-api: a exceção da D-F61 cobre SÓ o 405; 406/415 (erro de CONTRATO) ainda viram FISCAL_DPS_REJECTED → voz R', () => {
  it('[CORRIGIDO] [LOW DF61-09] POST /nfse → 406/415 → ambíguo (502), nunca voz R', async () => {
    for (const status of [406, 415]) {
      mockHttp.mockReset(); (repo.insertTransmissionEvent as jest.Mock).mockClear()
      sefin({ post: () => ({ status, headers: {}, text: '' }) })
      const out = await settle(transmitServiceInvoice(realDeps(), A, webRef(A, INVOICE)))
      expect([status, out?.code, kindsInserted()]).toEqual([status, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', []])
    }
  })
})
