/// <reference types="jest" />
// GATE ADVERSARIAL INDEPENDENTE da Rodada 4 da frente do CNPJ alfanumérico (D-CJ23…D-CJ27 — `prompt_frente_cnpj_alfanumerico.md`
// §8.12–§8.13; nfse-api commit 6b0f277):
//  - D-CJ23: `documentCnpj` sem recurso ao cadastro — chave sem CNPJ do emitente = 422 "emitente fora do suporte";
//  - D-CJ24: E0812 do fisco no cancelamento traduzido com a SAÍDA (`cancelRefusalWayOut`);
//  - D-CJ25: o cancelamento sem `buildEmitter` (autor e cMun da CHAVE — `cMunOfAccessKey`); DANFSe com `infNFSe/xLocEmi`;
//  - D-CJ27: a consulta de nota JÁ cancelada regrava o XML da NFS-e que falta na pasta da chave (`archiveCancelEventIfMissing`);
//  - `saveXmlSafe` com a pasta por FUNÇÃO.
//
// Convenção (skill testar-adversarial.md §4.6): ataque que RESISTIU = teste verde; achado CONFIRMADO = teste que FALHA hoje, com o
// título `[ACHADO <SEVERIDADE>] …` — fixa o comportamento esperado ANTES da correção (este gate não corrige produção).
//
// Molde de mocks: `transmission.test.ts` (fisco/ERP/repositório simulados; arquivo fiscal REAL num diretório temporário). Onde o ataque
// depende do que o ADAPTADOR deixa passar, o fisco é o adaptador REAL (`adnAdapter`) com o transporte HTTP simulado (molde do D-CJ19).
import { withRecord } from './fixture-record'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync, inflateSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, AuthorityHttpError, HttpError, ErrorCatalog, transport } from 'fiscal-api'
import {
  refreshServiceTransmission, cancelServiceInvoiceAtAuthority, getServiceFiscalView, resetMunicipalTermsCache, NfseDeps, readNfseXml,
  refreshOpenServiceTransmissions,
} from '../nfse/transmission'
import { adnAdapter } from '../authority/adn'
import { parseNfseXml } from '../authority/dps-builder'
import { renderDanfse } from '../nfse/danfse'
import { webRef, WEB } from './fixture-ref'

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
      entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), establishmentCnpj: jest.fn(), establishmentCnpjFact: jest.fn(),
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
const warnM = fiscal.logger.warn as unknown as jest.Mock
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-cnpj-r4-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const realStorage = new FsFiscalStorage(storageRoot)
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: realStorage, adapter: adapter as any, fiscalDb: 'fiscal_api' }
/** O MESMO serviço com o adaptador REAL da Sefin (o transporte HTTP é que é simulado — `withTransport`). */
const depsReal: NfseDeps = { ...deps, adapter: adnAdapter }
/** Disco cheio: grava sempre falha; a busca e a leitura seguem no arquivo real. */
const brokenDisk = {
  save: jest.fn(() => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }),
  find: realStorage.find.bind(realStorage), read: realStorage.read.bind(realStorage), probe: () => false,
}
const depsBrokenDisk: NfseDeps = { ...deps, storage: brokenDisk as any }

const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const ZONE = 'America/Sao_Paulo'
const CNPJ_A = '12345678000195'
const CNPJ_B = '11222333000181'
/** CPF 529.982.247-25 na inscrição de 14 (tpInsc 1 — emitente pessoa física: fora do suporte). */
const CPF_INSC = '00052998224725'

// chave de 50: cMun(7) + ambGer(1) + tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1)
const keyOf = (insc: string, tp = '2', cMun = '4106902', nNfse = '0000000000123') => `${cMun}2${tp}${insc}${nNfse}2608000012345` + '6'
// Id do DPS: "DPS" + cMun(7) + tpInsc(1) + inscrição(14) + série(5) + nDPS(15)
const dpsIdOf = (insc: string, tp = '2', nDps = '000000000000042', cMun = '4106902') => `DPS${cMun}${tp}${insc}00001${nDps}`
const KEY_A = keyOf(CNPJ_A)
const DPS_ID_A = dpsIdOf(CNPJ_A)
const CPF_KEY = keyOf(CPF_INSC, '1')
const CPF_DPS = dpsIdOf(CPF_INSC, '1')

const nfseXmlOf = (key: string | null, dpsId: string, o: { cancelled?: boolean; nNfse?: string; emit?: string } = {}) =>
  '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe${key ? ` Id="NFS${key}"` : ''}><xLocEmi>Curitiba</xLocEmi><nNFSe>${o.nNfse ?? '123'}</nNFSe><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>`
  + `<dhProc>2026-08-15T10:00:00-03:00</dhProc><nDFSe>555</nDFSe><emit><CNPJ>${o.emit ?? CNPJ_A}</CNPJ><xNome>Empresa</xNome></emit>`
  + `<DPS versao="1.01"><infDPS Id="${dpsId}"><tpAmb>2</tpAmb><dhEmi>2026-08-15T09:59:00-03:00</dhEmi><nDPS>42</nDPS>`
  + `<toma><CNPJ>98765432000198</CNPJ><xNome>Tomador ${o.emit ?? CNPJ_A}</xNome></toma></infDPS></DPS>`
  + (o.cancelled ? '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>erro na emissao do documento</xMotivo></e101101>' : '')
  + '</infNFSe><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>x</SignatureValue></Signature></NFSe>'
const EVT = '<evento><infEvento Id="EVT1"><dhProc>2026-09-22T09:00:00-03:00</dhProc></infEvento></evento>'
const WHEN = new Date('2026-08-15T13:00:00Z')

const opened = (env = 'H', certCnpj = CNPJ_A) => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${certCnpj}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: certCnpj, fingerprint256: 'x' },
})
const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID_A,
  accessKey: KEY_A, nfseNumber: '123', dhProc: '2026-08-15 13:00:00', createdAt: '2026-08-15 12:59:00', ageMinutes: 0, lastQueriedAt: null,
  nfseNotGeneratedAt: null, lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-08-15 13:00:00',
  lastEventAt: '2026-08-15 13:00:00', lastEventAgeMinutes: 0, ...over,
})
const entity = (id: number, cnpj = CNPJ_A, city = 'Curitiba') => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? cnpj : '11444777000161', im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: city, stateName: 'Paraná' }],
})

/** Pastas de primeiro nível do arquivo fiscal (uma por CNPJ) e os arquivos sob uma delas. */
const folders = () => (fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot) : [])
const filesUnder = (cnpj: string) => {
  const root = path.join(storageRoot, cnpj)
  return fs.existsSync(root) ? (fs.readdirSync(root, { recursive: true } as any) as any[]).map(String).filter(f => f.endsWith('.xml')) : []
}
const nfseIn = (cnpj: string, key = KEY_A) => realStorage.find(cnpj, `${key}-nfse.xml`, ['2026-08-15 13:00:00'], 'H', ZONE)
const kindsWritten = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c[3]?.kind)
const outcome = <T>(p: Promise<T>) => p.then(ok => ({ ok, err: null as any }), (err: any) => ({ ok: null as T | null, err }))
const cancel = (d: NfseDeps = deps) => cancelServiceInvoiceAtAuthority(d, A, webRef(A, INVOICE), 'cliente desistiu do serviço')
const refresh = (d: NfseDeps = deps) => refreshServiceTransmission(d, A, webRef(A, INVOICE), 'Q')

/** A voz/tentativa vigente da nota (consulta, cancelamento e leitores leem dela). */
const vigente = (t: any) => {
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [t], events: [] })
}

/** O fisco = o adaptador REAL; o HTTP responde pela função (rota → resposta). Devolve o restaurador. */
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const http = (status: number, body: unknown) => ({ status, headers: {}, text: typeof body === 'string' ? body : JSON.stringify(body) })
async function withTransport<T>(route: (call: { url: string; method: string; body?: string }) => { status: number; headers: any; text: string }, fn: () => Promise<T>): Promise<T> {
  const original = transport.request
  transport.request = jest.fn(async (call: any) => route(call)) as any
  try { return await fn() } finally { transport.request = original }
}

let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  for (const d of folders()) fs.rmSync(path.join(storageRoot, d), { recursive: true, force: true })
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  conn.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.invoiceLives.mockImplementation(async () => new Map())
  erpM.institutionZone.mockResolvedValue(ZONE)
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ_A)
  erpM.establishmentCnpjFact.mockResolvedValue(null)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.getLifeDps as jest.Mock).mockResolvedValue(null)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([])
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
  adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
})

// ===========================================================================================================================
// 1. D-CJ25 — o cancelamento tira da NOTA o que precisa: cadastro vazio/ilegível/de outro estabelecimento, A1, réplica, cMun estranho
// ===========================================================================================================================
describe('D-CJ25 / cancelamento sem o cadastro de hoje', () => {
  it('cadastro INTEIRO ilegível (todo leitor do cadastro lança): cancela pelo autor e cMun da CHAVE — nenhum leitor do cadastro é chamado', async () => {
    vigente(tx())
    for (const f of ['entityFiscal', 'entityTax', 'cityIbge', 'establishmentCnpj', 'establishmentCnpjFact']) erpM[f].mockRejectedValue(new Error(`cadastro ilegível (${f})`))
    const r = await cancel()
    expect(r).toMatchObject({ atAuthority: true, nextStep: 'apply-local-cancel' })
    expect(adapter.registerEvent.mock.calls[0][2]).toContain(`<CNPJAutor>${CNPJ_A}</CNPJAutor>`)
    expect(adapter.municipalTerms).toHaveBeenCalledWith(expect.anything(), '4106902')
    for (const f of ['entityFiscal', 'entityTax', 'cityIbge', 'establishmentCnpj', 'establishmentCnpjFact']) expect(erpM[f]).not.toHaveBeenCalled()
    expect(kindsWritten()).toEqual(['K', 'C'])
  })

  it('cadastro apontando OUTRO estabelecimento (CNPJ B, São Paulo): autor e prazo seguem a NOTA (A, Curitiba) — nunca B nem 3550308', async () => {
    vigente(tx())
    erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id, CNPJ_B, 'São Paulo'))
    erpM.cityIbge.mockResolvedValue('3550308')
    erpM.establishmentCnpj.mockResolvedValue(CNPJ_B)
    await cancel()
    const sent = adapter.registerEvent.mock.calls[0][2] as string
    expect(sent).toContain(`<CNPJAutor>${CNPJ_A}</CNPJAutor>`)
    expect(sent).not.toContain(CNPJ_B)
    expect(adapter.municipalTerms.mock.calls.map(c => c[1])).toEqual(['4106902'])
    expect(folders()).toEqual([CNPJ_A])                                          // o evento na pasta da chave
  })

  it('chave com cMun ESTRANHO (0000000 / 9999999, ≠ do DPS): o prazo é só AVISO — convênio que falha não trava; prazo vencido avisa e segue', async () => {
    for (const [cMun, terms, warns] of [['0000000', 'falha', 0], ['9999999', 1, 1]] as const) {
      jest.clearAllMocks()
      resetMunicipalTermsCache()
      ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
      adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
      if (terms === 'falha') adapter.municipalTerms.mockRejectedValue(new Error('convênio inexistente'))
      else adapter.municipalTerms.mockResolvedValue({ cancelDays: terms, raw: {} })
      vigente(tx({ accessKey: keyOf(CNPJ_A, '2', cMun) }))
      const r = await cancel()
      expect(adapter.municipalTerms.mock.calls.map(c => c[1])).toEqual([cMun])
      expect(r.warnings).toHaveLength(warns)
      expect(adapter.registerEvent).toHaveBeenCalledTimes(1)
    }
  })

  it('A1 ausente/vencido/ilegível: 409 do cofre ANTES do K — nada reservado nem enviado (e nunca o 422 do emitente)', async () => {
    vigente(tx())
    for (const code of ['FISCAL_CERT_MISSING', 'FISCAL_CERT_EXPIRED', 'FISCAL_CERT_INVALID']) {
      ;(fiscal.openIssuer as jest.Mock).mockRejectedValueOnce(new HttpError(409, `A1: ${code}`, undefined, code))
      const { err } = await outcome(cancel())
      expect(err).toMatchObject({ statusCode: 409, code })
    }
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('A1 some ENTRE a decisão e o preparo: o K é liberado com N (o pedido não vigora) e o fisco não é chamado', async () => {
    vigente(tx())
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened()).mockRejectedValueOnce(new HttpError(409, 'A1 apagado', undefined, 'FISCAL_CERT_MISSING'))
    const { err } = await outcome(cancel())
    expect(err).toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_MISSING' })
    expect(kindsWritten()).toEqual(['K', 'N'])
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('habilitação RÉPLICA (cutover pendente) pelos dois predicados: 409 FISCAL_CUTOVER_PENDING sem voz nem fisco', async () => {
    vigente(tx())
    ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValueOnce(true)
    expect((await outcome(cancel())).err).toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    ;(fiscal.openIssuer as jest.Mock).mockRejectedValueOnce(new HttpError(409, 'réplica', undefined, 'FISCAL_CUTOVER_PENDING'))
    expect((await outcome(cancel())).err).toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('D-CJ23 no cancelamento: chave SEM CNPJ (emitente CPF, DPS coerente e sem DPS) → 422 legível ANTES do K', async () => {
    for (const dpsId of [CPF_DPS, null]) {
      vigente(tx({ accessKey: CPF_KEY, dpsId }))
      const { err } = await outcome(cancel())
      expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_EMITTER_UNSUPPORTED', message: expect.stringMatching(/fora do suporte/) })
    }
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('saveXmlSafe com a pasta por função: DISCO CHEIO depois do cancelamento no fisco só avisa — a voz C é gravada e o app segue', async () => {
    vigente(tx())
    const r = await cancel(depsBrokenDisk)
    expect(r).toMatchObject({ atAuthority: true, nextStep: 'apply-local-cancel' })
    expect(kindsWritten()).toEqual(['K', 'C'])
    expect(brokenDisk.save).toHaveBeenCalledTimes(1)
    expect(warnM).toHaveBeenCalledWith('XML do evento de cancelamento não gravado no arquivo fiscal', expect.objectContaining({ err: expect.stringMatching(/ENOSPC/) }))
  })
})

// ===========================================================================================================================
// 2. D-CJ24 — E0812 traduzido com a SAÍDA: no corpo, nos fields, parecido, na forma real do adaptador
// ===========================================================================================================================
describe('D-CJ24 / recusa E0812 do cancelamento', () => {
  const refusal = (fields: string[], body: string) => new AuthorityHttpError(422, `Fisco rejeitou (400): ${fields.join(' — ')}`, 'FISCAL_DPS_REJECTED', 400,
    body, fields.map(message => ({ field: 'event', message })))
  const refusedWith = async (err: AuthorityHttpError) => {
    adapter.registerEvent.mockRejectedValueOnce(err)
    const { err: e } = await outcome(cancel())
    return e
  }
  beforeEach(() => {
    vigente(tx())
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
  })

  it('E0812 nos fields, só no corpo (`erro` singular — fields sem código) ou só no texto cru → 409 com a saída; o K é liberado com N', async () => {
    const cases: [string, AuthorityHttpError][] = [
      ['fields', refusal(['E0812: Certificado não pertence à raiz do CNPJ do emitente'], '{"erros":[{"codigo":"E0812"}]}')],
      ['corpo', refusal(['Fisco recusou (400) sem detalhar'], '{"tipoAmbiente":2,"erro":{"codigo":"E0812","descricao":"raiz"}}')],
      ['texto', refusal([], 'E0812')],
    ]
    for (const [name, err] of cases) {
      const e = await refusedWith(err)
      expect([name, e?.statusCode, e?.code, /cancele pelo Emissor Nacional com o acesso ou o certificado do emitente da nota/.test(e?.message ?? '')])
        .toEqual([name, 409, 'FISCAL_CANCEL_REFUSED', true])
    }
    expect(kindsWritten().filter(k => k === 'N')).toHaveLength(cases.length)
  })

  it('códigos PARECIDOS não são E0812 (E08120, e0812, XE0812, E0812X, E812, E00812) → só o texto do fisco, sem a saída', async () => {
    for (const code of ['E08120', 'e0812', 'XE0812', 'E0812X', 'E812', 'E00812']) {
      const e = await refusedWith(refusal([`${code}: recusa`], `{"erros":[{"codigo":"${code}"}]}`))
      expect([code, e?.code, /Emissor Nacional/.test(e?.message ?? '')]).toEqual([code, 'FISCAL_CANCEL_REFUSED', false])
    }
  })

  it('E0812 na FORMA REAL do adaptador (HTTP 400 do POST /eventos, `erro` singular e `erros[]`) → 409 com a saída', async () => {
    const shapes: Record<string, unknown> = {
      singular: { tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.4', erro: { codigo: 'E0812', descricao: 'Certificado de raiz de CNPJ diferente do emitente' } },
      lista: { erros: [{ codigo: 'E0812', descricao: 'Certificado de raiz de CNPJ diferente do emitente' }] },
    }
    const got: unknown[] = []
    for (const [name, body] of Object.entries(shapes)) {
      const { err } = await withTransport(call => (call.method === 'POST' && /\/eventos$/.test(call.url) ? http(400, body) : http(404, '')), () => outcome(cancel(depsReal)))
      got.push([name, err?.statusCode, err?.code, /Emissor Nacional/.test(err?.message ?? '')])
    }
    expect(got).toEqual([['singular', 409, 'FISCAL_CANCEL_REFUSED', true], ['lista', 409, 'FISCAL_CANCEL_REFUSED', true]])
  })

  it('[CORRIGIDO na sessão — ACHADO LOW] E0812 que NÃO é o 1º código da lista do fisco (ex.: E0840 + E0812) perde a SAÍDA — `firstAuthorityCode` olha só o 1º', async () => {
    const e = await refusedWith(refusal(['E0840: Data do evento inválida', 'E0812: Certificado não pertence à raiz do CNPJ do emitente'],
      '{"erros":[{"codigo":"E0840"},{"codigo":"E0812"}]}'))
    expect(e).toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_REFUSED' })
    expect(e.message).toMatch(/cancele pelo Emissor Nacional com o acesso ou o certificado do emitente da nota/)     // hoje: só o texto do fisco
  })
})

// ===========================================================================================================================
// 3. D-CJ27 — a consulta da C regrava o XML da NFS-e: resposta de outra chave/outro DPS, ilegível, sem XML, disco, A1, réplica
// ===========================================================================================================================
describe('D-CJ27 / consulta de nota JÁ cancelada regravando a NFS-e que falta', () => {
  const cTx = (over: any = {}) => tx({ lastKind: 'C', lastCode: '101101', ...over })
  /** O evento já está na pasta da chave (só a NFS-e falta). */
  const eventArchived = (cnpj = CNPJ_A, key = KEY_A) => realStorage.save(cnpj, `${key}-evt101101.xml`, EVT, WHEN, 'H', ZONE)
  const nfseRoute = (xml: string | null, key = KEY_A) => (call: { url: string }) =>
    (call.url.endsWith(`/nfse/${key}`) ? http(200, xml === null ? {} : { nfseXmlGZipB64: gz(xml) }) : http(500, ''))

  /** Respostas "trocadas" que o ADAPTADOR deixa passar (a chave do Id é a perguntada, ou não há Id) — mas o DPS embutido é OUTRO. */
  const foreignDps = [
    ['Id = a nossa chave, DPS de OUTRO emitente (B)', nfseXmlOf(KEY_A, dpsIdOf(CNPJ_B, '2', '000000000000777'), { cancelled: true, emit: CNPJ_B })],
    ['Id = a nossa chave, OUTRO DPS do mesmo emitente (outra vida)', nfseXmlOf(KEY_A, dpsIdOf(CNPJ_A, '2', '000000000000099'), { cancelled: true })],
    ['sem Id no infNFSe, DPS de OUTRO emitente (B)', nfseXmlOf(null, dpsIdOf(CNPJ_B, '2', '000000000000777'), { cancelled: true, emit: CNPJ_B })],
  ] as const

  it('contraste (resistiu): a MESMA resposta na consulta da AUTORIZADA é recusada (R2-2 c — 502 "nfse-de-outro-dps") e nada é gravado', async () => {
    for (const [name, xml] of foreignDps) {
      vigente(tx())
      const { err } = await withTransport(nfseRoute(xml), () => outcome(refresh(depsReal)))
      expect([name, err?.statusCode, err?.code]).toEqual([name, 502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'])
      expect(nfseIn(CNPJ_A)).toBeNull()
    }
  })

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] a consulta da C (D-CJ27) grava como XML DESTA nota a NFS-e de OUTRO DPS (outro emitente/outra vida) — falta a conferência do DPS embutido (R2-2 c) que a consulta da autorizada faz; a 2ª via/DANFSe passam a servir o documento alheio, para sempre', async () => {
    const got: string[][] = []
    for (const [name, xml] of foreignDps) {
      for (const d of folders()) fs.rmSync(path.join(storageRoot, d), { recursive: true, force: true })
      vigente(cTx())
      eventArchived()
      const r = await withTransport(nfseRoute(xml), () => refresh(depsReal))
      expect(r).toMatchObject({ kind: 'C', changed: false })                    // a consulta do estado final não cai
      const served = await outcome(readNfseXml(depsReal, A, webRef(A, INVOICE)))
      got.push([name, served.ok ? `2ª via serve o DPS ${parseNfseXml(served.ok.xml).dpsId}` : `nada gravado (${served.err?.statusCode})`])
    }
    // esperado: nada gravado (a 2ª via segue 404 "consulte a nota" até o fisco devolver o documento DESTE DPS); hoje: grava o alheio
    expect(got).toEqual(foreignDps.map(([name]) => [name, 'nada gravado (404)']))
  })

  it('resposta de OUTRA chave (Id do infNFSe ≠ a perguntada): o adaptador recusa → só aviso; nada gravado; a consulta da C não cai', async () => {
    vigente(cTx())
    eventArchived()
    const other = keyOf(CNPJ_A, '2', '4106902', '0000000000999')
    const r = await withTransport(nfseRoute(nfseXmlOf(other, DPS_ID_A, { cancelled: true })), () => refresh(depsReal))
    expect(r).toMatchObject({ kind: 'C', changed: false })
    expect(nfseIn(CNPJ_A)).toBeNull()
    expect(nfseIn(CNPJ_A, other)).toBeNull()
    expect(warnM).toHaveBeenCalledWith('XML do evento de cancelamento não arquivado na consulta', expect.anything())
  })

  it('XML ILEGÍVEL (entidade inválida, texto que não é XML) e envelope SEM o XML: o adaptador recusa → só aviso; nada gravado', async () => {
    const bad = nfseXmlOf(KEY_A, DPS_ID_A, { cancelled: true }).replace('<nNFSe>123</nNFSe>', '<nNFSe>&bogus;</nNFSe>')
    for (const route of [nfseRoute(bad), nfseRoute('isto não é XML'), nfseRoute(null)]) {
      vigente(cTx())
      eventArchived()
      const r = await withTransport(route, () => refresh(depsReal))
      expect(r).toMatchObject({ kind: 'C', changed: false })
      expect(nfseIn(CNPJ_A)).toBeNull()
    }
  })

  it('fisco devolve a C sem nfseXml (null/vazio — adaptador simulado): a NFS-e não é gravada; o evento que faltava, sim', async () => {
    for (const nfseXml of [null, '']) {
      for (const d of folders()) fs.rmSync(path.join(storageRoot, d), { recursive: true, force: true })
      vigente(cTx())
      adapter.queryNfse.mockResolvedValueOnce({ accessKey: KEY_A, status: 'cancelled', nfseXml, dhProc: null,
        cancelled: { dhEvento: '2026-08-20T09:00:00-03:00', motive: 'x', eventCode: '101101', eventXml: EVT } })
      await refresh()
      expect(nfseIn(CNPJ_A)).toBeNull()
      expect(filesUnder(CNPJ_A).some(f => f.endsWith(`${KEY_A}-evt101101.xml`))).toBe(true)
    }
  })

  it('a NFS-e JÁ arquivada nunca é SOBRESCRITA pela resposta da consulta (só o evento que falta é gravado)', async () => {
    vigente(cTx())
    const original = nfseXmlOf(KEY_A, DPS_ID_A, { nNfse: '123' })
    realStorage.save(CNPJ_A, `${KEY_A}-nfse.xml`, original, WHEN, 'H', ZONE)
    adapter.queryNfse.mockResolvedValueOnce({ accessKey: KEY_A, status: 'cancelled', nfseXml: nfseXmlOf(KEY_A, DPS_ID_A, { nNfse: '456', cancelled: true }), dhProc: null,
      cancelled: { dhEvento: '2026-08-20T09:00:00-03:00', motive: 'x', eventCode: '101101', eventXml: EVT } })
    await refresh()
    expect(realStorage.read(nfseIn(CNPJ_A)!)).toBe(original)
    expect(filesUnder(CNPJ_A).some(f => f.endsWith(`${KEY_A}-evt101101.xml`))).toBe(true)
  })

  it('DISCO CHEIO ao regravar: só aviso, a consulta do estado final não cai; a próxima consulta (disco bom) regrava', async () => {
    vigente(cTx())
    eventArchived()
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY_A, status: 'cancelled', nfseXml: nfseXmlOf(KEY_A, DPS_ID_A, { cancelled: true }), dhProc: null,
      cancelled: { dhEvento: '2026-08-20T09:00:00-03:00', motive: 'x', eventCode: '101101', eventXml: EVT } })
    expect(await refresh(depsBrokenDisk)).toMatchObject({ kind: 'C', changed: false })
    expect(brokenDisk.save).toHaveBeenCalled()
    expect(warnM).toHaveBeenCalledWith('XML do evento de cancelamento não arquivado na consulta', expect.objectContaining({ err: expect.stringMatching(/ENOSPC/) }))
    expect(nfseIn(CNPJ_A)).toBeNull()
    await refresh()
    expect(nfseIn(CNPJ_A)).not.toBeNull()
  })

  it('A1 vencido / habilitação réplica / fisco fora: a consulta da C não cai (só aviso) e nada é gravado', async () => {
    for (const fail of [
      () => (fiscal.openIssuer as jest.Mock).mockRejectedValueOnce(new HttpError(409, 'A1 vencido', undefined, 'FISCAL_CERT_EXPIRED')),
      () => (fiscal.openIssuer as jest.Mock).mockRejectedValueOnce(new HttpError(409, 'réplica', undefined, 'FISCAL_CUTOVER_PENDING')),
      () => adapter.queryNfse.mockRejectedValueOnce(new AuthorityHttpError(503, 'Fisco indisponível', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')),
    ]) {
      vigente(cTx())
      eventArchived()
      fail()
      expect(await refresh()).toMatchObject({ kind: 'C', changed: false })
      expect(nfseIn(CNPJ_A)).toBeNull()
    }
  })

  it('C com chave SEM CNPJ (CPF) ou chave de OUTRO emitente que o DPS: nem pergunta ao fisco (a pasta é recusada antes); nada em pasta alheia', async () => {
    for (const t of [cTx({ accessKey: CPF_KEY, dpsId: CPF_DPS }), cTx({ accessKey: keyOf(CNPJ_B), dpsId: DPS_ID_A })]) {
      vigente(t)
      expect(await refresh()).toMatchObject({ kind: 'C', changed: false })
    }
    expect(fiscal.openIssuer).not.toHaveBeenCalled()
    expect(adapter.queryNfse).not.toHaveBeenCalled()
    expect(folders()).toEqual([])
  })
})

// ===========================================================================================================================
// 4. D-CJ23 — o 422 "emitente fora do suporte" em TODOS os leitores (a tela "No fisco" nunca 500)
// ===========================================================================================================================
describe('D-CJ23 / chave sem CNPJ do emitente nos leitores', () => {
  const cpfTx = (over: any = {}) => tx({ accessKey: CPF_KEY, dpsId: CPF_DPS, ...over })
  beforeEach(() => {
    // o documento existe na pasta do CADASTRO (o recurso antigo) — nenhum leitor pode achá-lo por lá
    realStorage.save(CNPJ_A, `${CPF_KEY}-nfse.xml`, nfseXmlOf(CPF_KEY, CPF_DPS), WHEN, 'H', ZONE)
    realStorage.save(CNPJ_A, `${CPF_KEY}-evt101101.xml`, EVT, WHEN, 'H', ZONE)
  })

  it('tela "No fisco" (autorizada e C por SUBSTITUIÇÃO): responde — XML/DANFSe indisponíveis, IBS/CBS sem leitura, substituta null', async () => {
    for (const t of [cpfTx(), cpfTx({ lastKind: 'C', lastCode: '105102' })]) {
      ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [t], events: [] })
      const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
      expect(v).toMatchObject({ xmlAvailable: false, danfseAvailable: false })
      expect(v.ibscbs?.groupInDps ?? null).toBeNull()
      if (t.lastKind === 'C') expect(v.substitution).toEqual({ substituteAccessKey: null })
    }
  })

  it('2ª via / DANFSe: 422 legível (nunca 500, nunca o arquivo da pasta do cadastro)', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [cpfTx()], events: [] })
    const { ok, err } = await outcome(readNfseXml(deps, A, webRef(A, INVOICE)))
    expect(ok).toBeNull()
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_EMITTER_UNSUPPORTED' })
  })

  it('consulta da autorizada: a voz é gravada, o XML não (só aviso) — a consulta não cai', async () => {
    vigente(cpfTx({ lastKind: null, nfseNumber: null }))
    adapter.queryNfse.mockResolvedValue({ accessKey: CPF_KEY, status: 'authorized', nfseXml: nfseXmlOf(CPF_KEY, CPF_DPS), dhProc: '2026-08-15T10:00:00-03:00' })
    const r = await refresh()
    expect(r).toMatchObject({ kind: 'A', changed: true })
    expect(warnM).toHaveBeenCalledWith('XML da NFS-e não gravado na consulta', expect.objectContaining({ err: expect.stringMatching(/fora do suporte/) }))
    expect(folders()).toEqual([CNPJ_A])                                          // só o que o teste pôs (nenhuma pasta nova)
  })

  it('rodízio: a candidata com chave sem CNPJ não vira erro da passada', async () => {
    const t = cpfTx()
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([t])
    vigente(t)
    adapter.queryNfse.mockResolvedValue({ accessKey: CPF_KEY, status: 'authorized', nfseXml: nfseXmlOf(CPF_KEY, CPF_DPS), dhProc: '2026-08-15T10:00:00-03:00' })
    const report = await refreshOpenServiceTransmissions(deps, A, { terminal: WEB })
    expect(report).toMatchObject({ checked: 1, errors: [] })
  })

  it('[CORRIGIDO na sessão — ACHADO LOW] o 422 "emitente fora do suporte" sai com o código FISCAL_EMITTER_INCOMPLETE, cujo SIGNIFICADO no catálogo manda completar o cadastro (que a D-CJ23 diz não resolver) — e o lote do app trata o código como "cadastro do emitente incompleto" (sistêmico)', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [cpfTx()], events: [] })
    const { err } = await outcome(readNfseXml(deps, A, webRef(A, INVOICE)))
    expect(err.message).toMatch(/consulte o suporte/)                            // a mensagem diz uma coisa…
    expect((ErrorCatalog as Record<string, string>)[err.code]).not.toMatch(/Meu Estabelecimento|complete/i)   // …o código diz outra
  })
})

// ===========================================================================================================================
// 5. D-CJ25 — DANFSe: "Município gerador" do documento (`infNFSe/xLocEmi`)
// ===========================================================================================================================
describe('D-CJ25 / DANFSe com xLocEmi', () => {
  const KEY = keyOf(CNPJ_A)
  const DANFSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">
<xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><cStat>100</cStat><dhProc>2026-09-21T10:15:30-03:00</dhProc>
<emit><CNPJ>12345678000195</CNPJ><IM>777</IM><xNome>SETES SISTEMAS LTDA</xNome></emit>
<valores><vLiq>1230.00</vLiq><vISSQN>24.69</vISSQN><pAliqAplic>2.00</pAliqAplic></valores>
<DPS><infDPS Id="${DPS_ID_A}"><tpAmb>2</tpAmb><serie>1</serie><nDPS>42</nDPS><dCompet>2026-09-21</dCompet>
<prest><CNPJ>12345678000195</CNPJ><IM>777</IM></prest>
<toma><CNPJ>98765432000198</CNPJ><xNome>Cliente</xNome></toma>
<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>Licença mensal ERP</xDescServ></cServ></serv>
<valores><vServPrest><vServ>1234.50</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>`
  const withLocEmi = (el: string) => DANFSE_XML.replace('<xLocEmi>Curitiba</xLocEmi>', el)
  const CADASTRO_HOJE = 'Ponta Grossa / Paraná'
  /** Texto dos fluxos do PDF (molde do danfse.test.ts). */
  const pdfText = (pdf: Buffer): string => {
    const out: string[] = []
    const src = pdf.toString('latin1')
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const start = m.index + m[0].indexOf(m[1])
      const raw = pdf.subarray(start, start + Buffer.byteLength(m[1], 'latin1'))
      try { out.push(inflateSync(raw).toString('latin1')) } catch { out.push(m[1]) }
    }
    return out.join('\n').replace(/\[((?:<[0-9a-fA-F]*>|[\s\-\d.])+)\]\s*TJ/g, (_, arr: string) =>
      (arr.match(/<([0-9a-fA-F]*)>/g) ?? []).map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''))
  }
  const render = async (xml: string) => {
    const pdf = await renderDanfse(xml, { issuerName: 'SETES' })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    return pdfText(pdf)
  }

  it('xLocEmi com CDATA, marcação, acentos, 150+ e 3 000 caracteres: o PDF nasce (nunca 500) e o valor legível sai do documento', async () => {
    // CDATA com marcação dentro e marcação mista: o leitor recusa o campo (D-NE87/valor-nao-simples) — o PDF nasce mesmo assim (`render` confere o %PDF-)
    expect(await render(withLocEmi('<xLocEmi><![CDATA[<b>Pinhais</b>]]></xLocEmi>'))).not.toContain('<b>')
    expect(await render(withLocEmi('<xLocEmi>Pin<b>ha</b>is</xLocEmi>'))).toContain('DANFSe')
    expect(await render(withLocEmi('<xLocEmi>São José dos Pinhais</xLocEmi>'))).toContain('São José dos Pinhais')
    const long150 = 'Município de nome muito longo '.repeat(6).trim()                      // 179 caracteres
    expect(long150.length).toBeGreaterThan(150)
    expect(await render(withLocEmi(`<xLocEmi>${long150}</xLocEmi>`))).toContain('Município de nome muito longo')
    const t0 = Date.now()
    expect(await render(withLocEmi(`<xLocEmi>${'X'.repeat(3000)}</xLocEmi>`))).toContain('XXXXXXXXXX')
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('[CORRIGIDO na sessão — ACHADO LOW] xLocEmi ausente, vazio, só espaço, em CDATA ou com marcação: o "Município gerador" volta a ser o CADASTRO DE HOJE — o recurso que a D-CJ25 quis tirar (e, no CDATA, o documento diz Pinhais e o DANFSe diz Ponta Grossa)', async () => {
    const variants: [string, string][] = [
      ['ausente', ''], ['vazio', '<xLocEmi></xLocEmi>'], ['só espaço', '<xLocEmi>   </xLocEmi>'],
      ['CDATA', '<xLocEmi><![CDATA[Pinhais]]></xLocEmi>'], ['marcação', '<xLocEmi>Pin<b>ha</b>is</xLocEmi>'],
    ]
    const got: [string, boolean][] = []
    for (const [name, el] of variants) got.push([name, (await render(withLocEmi(el))).includes('Ponta Grossa')])
    // esperado: o DANFSe nunca mostra o endereço de HOJE como município gerador do documento ("—" quando o documento não diz)
    expect(got).toEqual(variants.map(([name]) => [name, false]))
  })
})
