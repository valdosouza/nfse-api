/// <reference types="jest" />
// nfse-api:DEPLOY.E1.P4 — núcleo 4.0.0 (D-NE93/D-NE164: teto de 2 MB no transporte; D-NE88: o XML descomprimido sob o MAX_XML_BYTES).
// O `authorityJson` do núcleo traduz a resposta acima do teto num 502 AMBÍGUO com a causa `envelope-ilegivel` (D-F98), corpo vazio e o
// `authorityStatus` REAL do fisco. O adaptador do ADN não pode RE-ROTULAR esse ambíguo pelo status (404 → "fora do contrato",
// 401/403 → "evento recusado"): casa pelo CÓDIGO que o núcleo dá a esses status. Nenhum socket: o `transport.request` do núcleo é falso.
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import { transport, HttpsCall, ResponseTooLargeError, ambiguousCauseOf, ErrorCodes } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return { __esModule: true, ...actual, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }
})

const KEY = '4106902212345678000195000000000012320260921000012345'.slice(0, 50)
const CNPJ = '12345678000195'
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: JSON.stringify(obj) })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const tooLarge = (status: number) => async () => { throw new ResponseTooLargeError(status) }
const errorLog = fiscal.logger.error as unknown as jest.Mock

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset(); errorLog.mockClear() })

/** GET /nfse/{chave} 200 com NFS-e autorizada SEM cancelamento embutido; o GET TIPADO do evento responde por `typed`. */
function sefin(typed: () => Promise<any>) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/\/nfse\/\d+\/eventos\/\d+\/\d+$/.test(call.url)) return typed()
    if (/\/nfse\/\d+$/.test(call.url)) return ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return { status: 404, headers: {}, text: '' }
  })
}
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
const verdict = (e: any) => ({ statusCode: e?.statusCode, code: e?.code, cause: ambiguousCauseOf(e) })
const AMBIGUOUS_TOO_LARGE = { statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, cause: 'envelope-ilegivel' }
const contractDivergentLogged = () => errorLog.mock.calls.some(c => /Contrato da Sefin divergente|recusou a rota de EVENTO/.test(String(c[0])))

describe('DEPLOY.E1.P4 — resposta acima de 2 MB: o ambíguo do núcleo passa INTACTO pelo adaptador (causa envelope-ilegivel, D-F98)', () => {
  it('queryDpsAccessKey: 404 grande → 502 ambíguo envelope-ilegivel (nunca null, nunca dps-fora-do-contrato)', async () => {
    mockHttp.mockImplementation(tooLarge(404))
    const e = await settle(adnAdapter.queryDpsAccessKey(ctxH, DPS_ID))
    expect(e).not.toBeNull()
    expect(verdict(e)).toEqual(AMBIGUOUS_TOO_LARGE)
  })

  it.each([404, 401, 403])('queryNfse: GET do evento %i grande → 502 envelope-ilegivel, sem o alarme de contrato divergente', async status => {
    sefin(tooLarge(status))
    const e = await settle(adnAdapter.queryNfse(ctxH, KEY))
    expect(verdict(e)).toEqual(AMBIGUOUS_TOO_LARGE)
    expect(contractDivergentLogged()).toBe(false)
  })

  it('queryNfse: a própria consulta grande (GET /nfse 200 acima do teto) → 502 envelope-ilegivel', async () => {
    mockHttp.mockImplementation(tooLarge(200))
    expect(verdict(await settle(adnAdapter.queryNfse(ctxH, KEY)))).toEqual(AMBIGUOUS_TOO_LARGE)
  })
})

describe('DEPLOY.E1.P4 — os 404/401/403 NORMAIS seguem com a causa de antes', () => {
  it('queryDpsAccessKey: 404 vazio (gateway) → dps-fora-do-contrato; 404 E2404 estruturado → null', async () => {
    mockHttp.mockResolvedValue({ status: 404, headers: {}, text: '' })
    expect(ambiguousCauseOf(await settle(adnAdapter.queryDpsAccessKey(ctxH, DPS_ID)))).toBe('dps-fora-do-contrato')
    mockHttp.mockResolvedValue({ status: 404, headers: {}, text: JSON.stringify({ tipoAmbiente: 0, erro: { codigo: 'E2404', descricao: 'DPS não encontrada' } }) })
    expect(await settle(adnAdapter.queryDpsAccessKey(ctxH, DPS_ID))).toBeNull()
  })

  it('queryNfse: evento 404 vazio → evento-fora-do-contrato (com o alarme); 401 e 403 → evento-recusado; 404 da Sefin → autorizada', async () => {
    sefin(async () => ({ status: 404, headers: {}, text: '' }))
    expect(ambiguousCauseOf(await settle(adnAdapter.queryNfse(ctxH, KEY)))).toBe('evento-fora-do-contrato')
    expect(contractDivergentLogged()).toBe(true)
    for (const status of [401, 403]) {
      sefin(async () => ({ status, headers: {}, text: '' }))
      expect([status, ambiguousCauseOf(await settle(adnAdapter.queryNfse(ctxH, KEY)))]).toEqual([status, 'evento-recusado'])
    }
    sefin(async () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) }))
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('authorized')
  })
})

describe('DEPLOY.E1.P4 — D-NE88: o XML descomprimido do ADN acima de 1 MB (MAX_XML_BYTES) nunca é lido', () => {
  it('NFS-e gzip+base64 pequena no fio que descomprime acima de 1 MB → 502 envelope-ilegivel', async () => {
    const big = NFSE_XML.replace('<nNFSe>', `<!--${'x'.repeat(fiscal.MAX_XML_BYTES)}--><nNFSe>`)
    const wire = gz(big)
    // o corpo no fio caberia no teto do transporte (2 MB — aqui o transporte é falso, o corte real do `httpsRequest` é dos testes do
    // núcleo); quem recusa é o teto do LEITOR no gunzip (D-NE88)
    expect(wire.length).toBeLessThan(fiscal.MAX_RESPONSE_BYTES)
    mockHttp.mockResolvedValue(ok({ nfseXmlGZipB64: wire }))
    expect(verdict(await settle(adnAdapter.queryNfse(ctxH, KEY)))).toEqual(AMBIGUOUS_TOO_LARGE)
  })

  it('logo abaixo de 1 MB descomprimido a mesma NFS-e é lida (o teto é do tamanho, não da forma)', async () => {
    const near = NFSE_XML.replace('<nNFSe>', `<!--${'x'.repeat(fiscal.MAX_XML_BYTES - NFSE_XML.length - 64)}--><nNFSe>`)
    expect(Buffer.byteLength(near)).toBeLessThan(fiscal.MAX_XML_BYTES)
    mockHttp.mockImplementation(async (call: HttpsCall) => /\/eventos\//.test(call.url)
      ? { status: 404, headers: {}, text: JSON.stringify(SEFIN) } : ok({ nfseXmlGZipB64: gz(near) }))
    expect((await adnAdapter.queryNfse(ctxH, KEY)).status).toBe('authorized')
  })
})
