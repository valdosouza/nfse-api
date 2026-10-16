/// <reference types="jest" />
// GATE ADVERSARIAL INDEPENDENTE da D-CJ19 (= Q-CJ19 (a), Valdo 2026-10-16 — `prompt_frente_cnpj_alfanumerico.md` §8.10–§8.11; commit c67bcc4):
// a PASTA do arquivo fiscal de documento JÁ autorizado e o `CNPJAutor` do pedido de cancelamento saem do emitente EMBUTIDO na chave
// (`cnpjOfAccessKey`), com o cadastro como recurso só quando a chave não traz CNPJ na forma (`documentCnpj`).
//
// Convenção (skill testar-adversarial.md §4.6): ataque que RESISTIU = teste verde; achado CONFIRMADO = teste que FALHA hoje, com o
// título `[ACHADO <SEVERIDADE>] …` — fixa o comportamento esperado ANTES da correção (não se corrige produção neste gate).
//
// Molde de mocks: `transmission.test.ts` (fisco/ERP/repositório simulados; arquivo fiscal REAL num diretório temporário).
import { withRecord } from './fixture-record'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, CNPJ_FORM, transport, AuthorityContext } from 'fiscal-api'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, getServiceFiscalView, resetMunicipalTermsCache,
  NfseDeps, readNfseXml,
} from '../nfse/transmission'
import { cnpjOfAccessKey, issuerOfAccessKey, NFSE_ACCESS_KEY_FORM } from '../authority/access-key'
import { adnAdapter } from '../authority/adn'
import { webRef } from './fixture-ref'

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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-dcj19-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const ZONE = 'America/Sao_Paulo'

/** O estabelecimento A (institution 1) — o cadastro dos fixtures. */
const CNPJ_A = '12345678000195'
/** OUTRO estabelecimento (outro tenant no MESMO arquivo fiscal — a raiz é uma só para todos os clientes). */
const CNPJ_B = '11222333000181'
/** Para onde o cadastro de A foi "corrigido" depois da emissão (cenário da D-CJ19). */
const CNPJ_NOVO = '98765432000198'
const ALFA = 'PC3D315K000193'

// chave de 50: cMun(7) + ambGer(1) + tpInsc(1) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1)
const keyOf = (insc: string, tp = '2', nNfse = '0000000000123') => `4106902` + `2` + tp + insc + nNfse + '2608' + '000012345' + '6'
// Id do DPS DESTA nota (emitente A): "DPS" + cMun(7) + tpInsc(1) + inscrição(14) + série(5) + nDPS(15)
const DPS_ID_A = `DPS4106902${'2'}${CNPJ_A}00001${'000000000000042'}`
const DPS_ID_ALFA = `DPS4106902${'2'}${ALFA}00001${'000000000000042'}`

const nfseXmlOf = (key: string, dpsId: string, nNfse = '123') => '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${key}"><xLocEmi>Curitiba</xLocEmi><nNFSe>${nNfse}</nNFSe><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>`
  + `<dhProc>2026-08-15T10:00:00-03:00</dhProc><nDFSe>555</nDFSe><emit><CNPJ>${key.slice(9, 23)}</CNPJ><xNome>Empresa</xNome></emit>`
  + `<DPS versao="1.01"><infDPS Id="${dpsId}"><tpAmb>2</tpAmb><dhEmi>2026-08-15T09:59:00-03:00</dhEmi><nDPS>42</nDPS></infDPS></DPS></infNFSe>`
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>x</SignatureValue></Signature></NFSe>'
const substEventXml = (key: string, substitute: string) =>
  `<evento versao="1.01"><infEvento Id="EVT${key}105102001"><dhProc>2026-08-20T18:43:04-03:00</dhProc><pedRegEvento><infPedReg>`
  + `<chNFSe>${key}</chNFSe><e105102><xDesc>Cancelamento de NFS-e por Substituição</xDesc><cMotivo>1</cMotivo><xMotivo>erro no valor</xMotivo>`
  + `<chSubstituta>${substitute}</chSubstituta></e105102></infPedReg></pedRegEvento></infEvento></evento>`
const EVT = '<evento><infEvento Id="EVT1"><dhProc>2026-09-22T09:00:00-03:00</dhProc></infEvento></evento>'

const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
let cadastro = CNPJ_A
const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? cadastro : '11444777000161', im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
const opened = (env = 'H') => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ_A}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ_A, fingerprint256: 'x' },
})
const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID_A,
  accessKey: keyOf(CNPJ_A), nfseNumber: '123', dhProc: '2026-08-15 13:00:00', createdAt: '2026-08-15 12:59:00', ageMinutes: 0, lastQueriedAt: null,
  nfseNotGeneratedAt: null, lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-08-15 13:00:00',
  lastEventAt: '2026-08-15 13:00:00', lastEventAgeMinutes: 0, ...over,
})
/** O cadastro do estabelecimento A trocado para [cnpj] (o que a D-CJ19 diz não governar documento JÁ autorizado). */
const cadastroTrocadoPara = (cnpj: string) => {
  cadastro = cnpj
  erpM.establishmentCnpj.mockResolvedValue(cnpj)
}
/** Pastas de primeiro nível do arquivo fiscal (uma por CNPJ). */
const folders = () => (fs.existsSync(storageRoot) ? fs.readdirSync(storageRoot) : [])
const filesUnder = (cnpj: string) => {
  const root = path.join(storageRoot, cnpj)
  return fs.existsSync(root) ? (fs.readdirSync(root, { recursive: true } as any) as any[]).map(String) : []
}

let headerRow: any
let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  for (const d of folders()) fs.rmSync(path.join(storageRoot, d), { recursive: true, force: true })
  cadastro = CNPJ_A
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
  erpM.institutionZone.mockResolvedValue(ZONE)
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockImplementation(async () => cadastro)
  erpM.establishmentCnpjFact.mockResolvedValue(null)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
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

// ===========================================================================================================================
// 1. CHAVES FORJADAS / ESTRANHAS — `cnpjOfAccessKey` decide PASTA (nome de diretório) e AUTOR: só a forma canônica sai, nada mais
// ===========================================================================================================================
describe('D-CJ19 / chaves forjadas e estranhas — cnpjOfAccessKey devolve a forma canônica ou null, nunca outra coisa', () => {
  const VALID = keyOf(CNPJ_A)

  it('tpInsc fora de 1/2 (0, 3…9) → null (a forma geral não presume o domínio; quem chama cai no recurso)', () => {
    for (const tp of ['0', '3', '4', '5', '6', '7', '8', '9']) {
      expect(NFSE_ACCESS_KEY_FORM.test(keyOf(CNPJ_A, tp))).toBe(true)          // a chave ainda tem a forma geral...
      expect(cnpjOfAccessKey(keyOf(CNPJ_A, tp))).toBeNull()                    // ...mas não traz CNPJ
    }
    expect(cnpjOfAccessKey(keyOf(ALFA, '1'))).toBeNull()                       // tpInsc CPF com letra: nunca vira "CNPJ"
  })

  it('letra em QUALQUER posição proibida (fora das 12 primeiras da inscrição) → null; letra só nas 12 → a inscrição exata', () => {
    for (let i = 0; i < 50; i++) {
      const forged = VALID.slice(0, i) + 'A' + VALID.slice(i + 1)
      const out = cnpjOfAccessKey(forged)
      if (i >= 9 && i <= 20) expect(out).toBe(forged.slice(9, 23))
      else expect(out).toBeNull()
    }
  })

  it('minúscula, Unicode parecido com dígito/letra, espaço invisível, BOM, NUL, quebra de linha → null (nada é "subido" nem aparado)', () => {
    const insc = VALID.slice(9, 23)
    const swaps = ['p', 'c', 'ａ', 'Ａ', '０', '٠', '०', 'А', 'Α', 'İ', 'K', 'ß', ' ', '​', '́', '﻿', '\u0000']
    for (const ch of swaps) {
      for (const pos of [0, 5, 11, 12, 13]) {
        const bad = insc.slice(0, pos) + ch + insc.slice(pos + 1)
        expect(cnpjOfAccessKey(VALID.slice(0, 9) + bad + VALID.slice(23))).toBeNull()
      }
    }
    expect(cnpjOfAccessKey(keyOf(ALFA.toLowerCase()))).toBeNull()
    expect(cnpjOfAccessKey(`${VALID}\n`)).toBeNull()                            // `$` do JS não casa antes de \n
    expect(cnpjOfAccessKey(`\n${VALID}`)).toBeNull()
    expect(cnpjOfAccessKey(` ${VALID}`)).toBeNull()
    expect(cnpjOfAccessKey(`${VALID} `)).toBeNull()
    expect(cnpjOfAccessKey(`﻿${VALID}`)).toBeNull()
    expect(cnpjOfAccessKey(`${VALID}\u0000`)).toBeNull()
  })

  it('comprimento errado (0, 49, 51, 100, 100 mil) e não-string → null, em tempo linear', () => {
    for (const s of ['', VALID.slice(1), `${VALID}0`, VALID + VALID, VALID.repeat(2000)]) expect(cnpjOfAccessKey(s)).toBeNull()
    for (const v of [null, undefined, 4106902, {}, []] as any[]) expect(cnpjOfAccessKey(v)).toBeNull()
    const t0 = Date.now()
    cnpjOfAccessKey('9'.repeat(100_000) + 'A')
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('PATH TRAVERSAL — fuzz determinístico (30 mil strings: mutações da chave com ../, \\, :, %2e, NUL, Unicode): a saída é null ou CNPJ_FORM, e a pasta fica DENTRO da raiz', () => {
    let seed = 0x5eed1919
    const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const pieces = ['..', '/', '\\', ':', '%2e', '%2f', '\u0000', '.', ' ', 'a', 'Z', '9', '∕', '／', '․', 'CON', 'NUL', 'COM1', '~', '$']
    const nonNull: string[] = []
    for (let n = 0; n < 30_000; n++) {
      let s = rnd() < 0.5 ? keyOf(CNPJ_A) : keyOf(ALFA)
      const edits = 1 + Math.floor(rnd() * 3)
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rnd() * (s.length + 1))
        const p = pieces[Math.floor(rnd() * pieces.length)]
        s = rnd() < 0.5 ? s.slice(0, at) + p + s.slice(at + p.length) : s.slice(0, at) + p + s.slice(at)
      }
      const out = cnpjOfAccessKey(s)
      if (out === null) continue
      expect(out).toMatch(CNPJ_FORM)
      expect(out).toBe(s.slice(9, 23))
      nonNull.push(out)
    }
    expect(nonNull.length).toBeGreaterThan(300)                                 // o fuzz exercitou a saída NÃO nula (não é vácuo — 436 nesta semente)
    for (const out of Array.from(new Set(nonNull)).slice(0, 40)) {
      const full = deps.storage.save(out, 'x-nfse.xml', '<x/>', new Date('2026-08-15T13:00:00Z'), 'P', ZONE)
      const rel = path.relative(storageRoot, full)
      expect(rel.startsWith('..')).toBe(false)
      expect(path.isAbsolute(rel)).toBe(false)
      expect(rel.split(path.sep)[0]).toBe(out)                                 // a 1ª pasta é a inscrição, exatamente
    }
  })
})

// ===========================================================================================================================
// 2. GRAVAÇÃO × BUSCA — o mesmo documento gravado por um caminho e procurado por outro
// ===========================================================================================================================
describe('D-CJ19 / gravação × busca — quem grava e quem procura chegam à MESMA pasta', () => {
  it('transmitir grava a NFS-e na pasta da CHAVE; a 2ª via, a tela e a DANFSe a acham — também depois do cadastro trocado; nenhuma pasta do cadastro novo', async () => {
    const key = keyOf(CNPJ_A)
    adapter.transmit.mockResolvedValue({ accessKey: key, nfseNumber: '123', dhProc: '2026-08-15T10:00:00-03:00', nfseXml: nfseXmlOf(key, DPS_ID_A), raw: {} })
    const r = await transmitServiceInvoice(deps, A, webRef(A, INVOICE))
    expect(r.dpsId).toBe(DPS_ID_A)
    expect(filesUnder(CNPJ_A).some(f => f.endsWith(`${key}-nfse.xml`))).toBe(true)
    cadastroTrocadoPara(CNPJ_NOVO)
    const t = tx({ accessKey: key, createdAt: '2026-08-15 12:59:00' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [t], events: [] })
    expect((await readNfseXml(deps, A, webRef(A, INVOICE))).accessKey).toBe(key)
    expect((await getServiceFiscalView(deps, A, webRef(A, INVOICE))).xmlAvailable).toBe(true)
    expect(folders()).toEqual([CNPJ_A])
  })

  it('o transmitir NÃO gravou (disco falhou): a consulta regrava na pasta da CHAVE com o cadastro já trocado — a 2ª via passa a achar', async () => {
    const key = keyOf(ALFA)                                                     // emitente alfanumérico em H
    const t = tx({ accessKey: key, dpsId: `DPS4106902${'2'}${ALFA}00001${'000000000000042'}` })
    cadastroTrocadoPara(CNPJ_NOVO)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [t], events: [] })
    await expect(readNfseXml(deps, A, webRef(A, INVOICE))).rejects.toMatchObject({ statusCode: 404 })
    adapter.queryNfse.mockResolvedValue({ accessKey: key, status: 'authorized', nfseXml: nfseXmlOf(key, t.dpsId), dhProc: '2026-08-15T10:00:00-03:00' })
    await refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q')
    expect((await readNfseXml(deps, A, webRef(A, INVOICE))).accessKey).toBe(key)
    expect(folders()).toEqual([ALFA])
  })

  it('cancelar grava o evento na pasta da CHAVE; a consulta da C o acha lá (com a NFS-e) e NÃO volta ao fisco para "arquivar o que falta"', async () => {
    const key = keyOf(CNPJ_A)
    // a NFS-e autorizada já está na pasta da chave (o transmitir a gravou) — D-CJ27: faltando ela, a consulta da C volta ao fisco para regravar
    deps.storage.save(CNPJ_A, `${key}-nfse.xml`, nfseXmlOf(key, DPS_ID_A), new Date('2026-08-15T13:00:00Z'), 'H', ZONE)
    cadastroTrocadoPara(CNPJ_NOVO)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ accessKey: key }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
    await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço')
    expect(filesUnder(CNPJ_A).some(f => f.endsWith(`${key}-evt101101.xml`))).toBe(true)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ accessKey: key, lastKind: 'C', lastCode: '101101' }))
    await refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q')
    expect(adapter.queryNfse).not.toHaveBeenCalled()
    expect(folders()).toEqual([CNPJ_A])
  })

  it('a leitura de documento com CNPJ na chave NÃO depende do cadastro de hoje (cadastro ilegível/ausente: a 2ª via segue)', async () => {
    const key = keyOf(CNPJ_A)
    deps.storage.save(CNPJ_A, `${key}-nfse.xml`, nfseXmlOf(key, DPS_ID_A), new Date('2026-08-15T13:00:00Z'), 'H', ZONE)
    erpM.establishmentCnpj.mockRejectedValue(new Error('cadastro não deveria ser lido'))
    erpM.establishmentCnpjFact.mockRejectedValue(new Error('cadastro não deveria ser lido'))
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ accessKey: key })], events: [] })
    expect((await readNfseXml(deps, A, webRef(A, INVOICE))).accessKey).toBe(key)
    expect((await getServiceFiscalView(deps, A, webRef(A, INVOICE))).xmlAvailable).toBe(true)
    expect(erpM.establishmentCnpj).not.toHaveBeenCalled()
  })
})

// ===========================================================================================================================
// 3. DOCUMENTOS ANTIGOS — gravados pela pasta do CADASTRO antes da D-CJ19 ("o banco que JÁ passou pela versão anterior")
// ===========================================================================================================================
describe('D-CJ19 / documentos arquivados ANTES da decisão (pasta do cadastro)', () => {
  it('cadastro nunca mudou (o caso real da Setes — chaves 704–707): a pasta antiga É a da chave; a 2ª via segue achando', async () => {
    const key = keyOf(CNPJ_A)
    // o caminho antigo gravava em `base.emitter.cnpj` / `emitterCnpj` = o cadastro = a inscrição que foi para o DPS = a da chave
    deps.storage.save(cadastro, `${key}-nfse.xml`, nfseXmlOf(key, DPS_ID_A), new Date('2026-08-15T13:00:00Z'), 'P', ZONE)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ accessKey: key, environment: 'P' })], events: [] })
    expect((await readNfseXml(deps, A, webRef(A, INVOICE))).accessKey).toBe(key)
  })

  // CORRIGIDO — D-CJ27 (= Q-CJ27 (b), Valdo 2026-10-16): a consulta da C regrava o XML da NFS-e que o fisco devolve quando falta na pasta da chave
  it('[CORRIGIDO — D-CJ27, ACHADO LOW] nota CANCELADA cujo XML a versão anterior arquivou pela pasta do cadastro JÁ trocado: a 2ª via/DANFSe vira 404 e a consulta da C (que recebe o XML da NFS-e do fisco) só arquiva o evento — nunca se recupera', async () => {
    // antes da D-CJ19 a consulta gravava em `emitterCnpj` (cadastro de HOJE): cadastro corrigido para CNPJ_NOVO depois da emissão →
    // o XML da nota emitida com CNPJ_A ficou em CNPJ_NOVO/…; agora a busca é só em CNPJ_A/…
    const key = keyOf(CNPJ_A)
    cadastroTrocadoPara(CNPJ_NOVO)
    deps.storage.save(CNPJ_NOVO, `${key}-nfse.xml`, nfseXmlOf(key, DPS_ID_A), new Date('2026-08-15T13:00:00Z'), 'H', ZONE)
    const c = tx({ accessKey: key, lastKind: 'C', lastCode: '101101' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(c)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [c], events: [] })
    adapter.queryNfse.mockResolvedValue({ accessKey: key, status: 'cancelled', nfseXml: nfseXmlOf(key, DPS_ID_A), dhProc: '2026-08-15T10:00:00-03:00',
      cancelled: { dhEvento: '2026-08-20T09:00:00-03:00', motive: 'x', eventCode: '101101', eventXml: EVT } })
    await refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q')        // "consulte a nota para regravar" (a mensagem do 404)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)                          // a consulta da C RELEU o fisco (que devolveu o XML da NFS-e)
    const r = await readNfseXml(deps, A, webRef(A, INVOICE)).then(x => x, (e: any) => e)
    expect(r?.statusCode).toBeUndefined()                                       // hoje: 404 FISCAL_NFSE_NOT_FOUND, para sempre
    expect(r?.accessKey).toBe(key)
  })
})

// ===========================================================================================================================
// 4. CHAVE DE OUTRO EMITENTE gravada numa tentativa — a chave agora DECIDE pasta (raiz COMPARTILHADA entre clientes) e AUTOR
// CORRIGIDO na sessão: o POST /nfse confere o emitente da chave contra o DPS (como o GET /dps); a transmissão repete a conferência (cinto)
// e a pasta/o autor de documento já autorizado só saem da chave se ela for do emitente do DPS da tentativa — senão ambígua `nfse-chave-divergente`
// ===========================================================================================================================
describe('D-CJ19 / chave de OUTRO emitente na tentativa desta nota (o DPS embute o emitente A; a chave embute B)', () => {
  const KEY_B = keyOf(CNPJ_B)                    // uma NFS-e REAL do estabelecimento B (outro cliente do mesmo arquivo fiscal)
  const XML_B = nfseXmlOf(KEY_B, `DPS4106902${'2'}${CNPJ_B}00001${'000000000000777'}`, '999')

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] adaptador POST /nfse: NFS-e com o NOSSO Id de DPS e a chave embutindo OUTRO emitente é aceita como voz A (o GET /dps recusa a mesma incoerência como "chave de OUTRO emitente")', async () => {
    const mockHttp = jest.fn()
    const original = transport.request
    transport.request = mockHttp as any
    try {
      const ctx: AuthorityContext = { environment: 'H', cert: Buffer.from('cert-pem'), key: Buffer.from('key-pem') }
      const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
      const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: JSON.stringify(obj) })
      // contraste — o GET /dps JÁ confere o emitente embutido (adn.ts: "dps: chave de OUTRO emitente")
      mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: KEY_B }))
      await expect(adnAdapter.queryDpsAccessKey(ctx, DPS_ID_A)).rejects.toMatchObject({ statusCode: 502 })
      // o POST /nfse: mesma incoerência (Id do DPS = o nosso; chave = de B) — deveria ser a MESMA recusa (502, resposta alheia)
      mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: KEY_B, nfseXmlGZipB64: gz(nfseXmlOf(KEY_B, DPS_ID_A)) }, 201))
      const got = await adnAdapter.transmit(ctx, `<DPS><infDPS Id="${DPS_ID_A}"/></DPS>`).then(x => x, (e: any) => e)
      expect(issuerOfAccessKey(KEY_B)?.inscricao).toBe(CNPJ_B)
      expect(got).toMatchObject({ statusCode: 502 })                            // hoje: { accessKey: KEY_B, ... } — vira voz A
    } finally {
      transport.request = original
    }
  })

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] transmitir com a resposta incoerente: o XML desta nota é gravado na pasta do OUTRO cliente (escrita cruzada no arquivo fiscal — antes da D-CJ19 ia para a pasta de A)', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY_B, nfseNumber: '123', dhProc: '2026-08-15T10:00:00-03:00', nfseXml: nfseXmlOf(KEY_B, DPS_ID_A), raw: {} })
    await transmitServiceInvoice(deps, A, webRef(A, INVOICE)).catch(() => null)
    expect(filesUnder(CNPJ_B)).toEqual([])                                       // hoje: H/2026/MM/<KEY_B>-nfse.xml na pasta de B
  })

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] 2ª via/DANFSe de A com a chave de B na tentativa: serve o XML REAL de B, lido da pasta de B (leitura cruzada entre clientes)', async () => {
    deps.storage.save(CNPJ_B, `${KEY_B}-nfse.xml`, XML_B, new Date('2026-08-10T13:00:00Z'), 'H', ZONE)   // o arquivo legítimo de B
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ accessKey: KEY_B, dpsId: DPS_ID_A })], events: [] })
    const r = await readNfseXml(deps, A, webRef(A, INVOICE)).then(x => x, (e: any) => e)
    expect(r?.xml).not.toBe(XML_B)                                              // hoje: o documento de B (tomador, valores) para quem é de A
    const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
    expect(v.ibscbs?.groupInDps ?? null).toBeNull()                              // hoje: a tela de A lê o DPS de B (false = "lido")
  })

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] tela "No fisco" de A (C por substituição) com a chave de B: a SUBSTITUTA exibida é a de B, lida do evento arquivado na pasta de B', async () => {
    const SUBST_B = keyOf(CNPJ_B, '2', '0000000000124')
    deps.storage.save(CNPJ_B, `${KEY_B}-evt101101.xml`, substEventXml(KEY_B, SUBST_B), new Date('2026-08-20T21:43:04Z'), 'H', ZONE)
    const current = tx({ accessKey: KEY_B, dpsId: DPS_ID_A, lastKind: 'C', lastCode: '105102' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
    expect(v.substitution).toEqual({ substituteAccessKey: null })               // hoje: a chave da substituta de B
  })

  it('[CORRIGIDO na sessão — ACHADO MEDIUM] cancelar com a chave de B na tentativa: nada local impede — reserva K e pedido assinado com o A1 de A declarando CNPJAutor = B (e o evento iria para a pasta de B)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ accessKey: KEY_B, dpsId: DPS_ID_A }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
    const err = await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço').then(() => null, (e: any) => e)
    const sent = adapter.registerEvent.mock.calls[0]?.[2] as string | undefined
    expect(sent ?? '').not.toContain(`<CNPJAutor>${CNPJ_B}</CNPJAutor>`)        // hoje: o pedido sai com o autor B
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()                 // hoje: K reservado
    expect(filesUnder(CNPJ_B)).toEqual([])                                       // hoje: o evento cai na pasta de B
    expect(err).toBeTruthy()
  })
})

// ===========================================================================================================================
// 5. LEIAUTE DO EVENTO EM PRODUÇÃO — autor alfanumérico = 422 ANTES da reserva K
// ===========================================================================================================================
describe('D-CJ19 × D-CJ7 / leiaute do evento: autor da CHAVE com letra em P = 422 antes do K', () => {
  const expect422BeforeK = async () => {
    const err = await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço').then(() => null, (e: any) => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  }

  it('nota com letra em P → 422 sem K mesmo com o cadastro de hoje ILEGÍVEL (a decisão não lê o cadastro quando a chave traz o CNPJ)', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    erpM.establishmentCnpj.mockRejectedValue(new Error('cadastro não deveria ser lido'))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ environment: 'P', accessKey: keyOf(ALFA), dpsId: `DPS4106902${'2'}${ALFA}00001${'000000000000042'}` }))
    await expect422BeforeK()
  })

  it('nota com letra AUTORIZADA em P e o emissor hoje em H: o ambiente congelado da TENTATIVA decide → 422 sem K', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('H'))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ environment: 'P', accessKey: keyOf(ALFA), dpsId: DPS_ID_ALFA }))
    await expect422BeforeK()
  })

  // correção do achado MEDIUM desta suíte (§4): chave tpInsc 1 com o DPS tpInsc 2 = chave de OUTRO emitente → recusa AMBÍGUA antes do K
  // (antes da correção caía no recurso ao cadastro e dava 422 do leiaute — também sem K)
  it('chave SEM CNPJ na forma (tpInsc 1) em P com o cadastro alfanumérico: recusada antes do K (chave de outro emitente que o DPS)', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    cadastroTrocadoPara(ALFA)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ environment: 'P', accessKey: keyOf(CNPJ_A, '1') }))
    const err = await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço').then(() => null, (e: any) => e)
    expect(err).toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('nota com letra em H (leiaute aceita desde 10/08/2026) e o emissor hoje em P: segue; o CNPJAutor é o da chave, tpAmb de H', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ environment: 'H', accessKey: keyOf(ALFA), dpsId: DPS_ID_ALFA }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
    await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço')
    const sent = adapter.registerEvent.mock.calls[0][2] as string
    expect(sent).toContain(`<CNPJAutor>${ALFA}</CNPJAutor>`)
    expect(sent).toContain('<tpAmb>2</tpAmb>')
    expect(adapter.registerEvent.mock.calls[0][0]).toMatchObject({ environment: 'H' })
  })
})

// ===========================================================================================================================
// 6. SUBSTITUTA (`substituteKeyOf`) — lida do evento na pasta da CHAVE; só do MESMO emitente
// ===========================================================================================================================
describe('D-CJ19 / substituta — evento arquivado na pasta da chave; a substituta é do mesmo emitente', () => {
  const key = keyOf(CNPJ_A)
  const current = () => tx({ accessKey: key, lastKind: 'C', lastCode: '105102' })
  const view = async (substitute: string) => {
    deps.storage.save(CNPJ_A, `${key}-evt101101.xml`, substEventXml(key, substitute), new Date('2026-08-20T21:43:04Z'), 'H', ZONE)
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current()], events: [] })
    return (await getServiceFiscalView(deps, A, webRef(A, INVOICE))).substitution
  }

  it('cadastro trocado: a substituta segue achada na pasta da chave', async () => {
    cadastroTrocadoPara(CNPJ_NOVO)
    const s = keyOf(CNPJ_A, '2', '0000000000124')
    expect(await view(s)).toEqual({ substituteAccessKey: s })
  })

  it('substituta de OUTRO emitente, de outro tpInsc, minúscula, a própria chave, fora da forma → null', async () => {
    for (const bad of [keyOf(CNPJ_B, '2', '0000000000124'), keyOf(CNPJ_A, '1', '0000000000124'), keyOf(ALFA.toLowerCase(), '2', '0000000000124'),
      key, `${key.slice(0, 49)}`, `${keyOf(CNPJ_A, '2', '0000000000124')}0`]) {
      for (const d of folders()) fs.rmSync(path.join(storageRoot, d), { recursive: true, force: true })
      expect(await view(bad)).toEqual({ substituteAccessKey: null })
    }
  })
})
