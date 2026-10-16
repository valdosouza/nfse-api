/// <reference types="jest" />
// GATE ADVERSARIAL da ONDA 1 da frente do CNPJ alfanumérico (skill `testar-adversarial.md`, 2026-10-16) — nfse-api.
// Alvos: o calendário por LEIAUTE (`layout-calendar.ts`), os cintos do montador (`dps-builder.ts`), a recusa legível ANTES da reserva
// (`service-facts.ts` → `transmission.ts`), a leitura tolerante do CNPJ do emitente (D-CJ16) e a regra 5 da cerca (helper de dígitos
// sobre inscrição — D-CJ15). Ataque que RESISTIU = teste verde. Achado CONFIRMADO = teste que FALHAVA, marcado `[ACHADO <SEVERIDADE>]`; os LOW foram CORRIGIDOS na sessão de entrega (§8.10 do prompt).
// Banco e fisco MOCKADOS (nada é lido do banco real, nenhuma chamada externa); o arquivo fiscal vai para uma pasta temporária.
import { withRecord } from './fixture-record'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, AuthorityHttpError, HttpError, MasterKeyRing } from 'fiscal-api'
import { transmitServiceInvoice, cancelServiceInvoiceAtAuthority, resetMunicipalTermsCache, NfseDeps } from '../nfse/transmission'
import { emitterCnpj } from '../facts/service-facts'
import { LAYOUT_CALENDAR, LAYOUT_SCHEMAS, cnpjAlphanumericAccepted, layoutLineAt } from '../authority/layout-calendar'
import { buildCancelEventXml, buildDpsId, buildDpsXml } from '../authority/dps-builder'
import type { DpsInput } from '../authority/types'
import { strippingHitsIn } from './federal-id-fence'
import { webRef } from './fixture-ref'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    nextDpsNumber: jest.fn(),
    emissionStillInErp: jest.fn(),
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
    findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(), listRefreshCandidates: jest.fn(), findKeyHolder: jest.fn(),
  }
})

const ALFA = 'PC3D315K000193'
const ALFA2 = '00000000E08G12'
const NUM = '12345678000195'
const NUM2 = '98765432000198'

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 3a — o calendário por LEIAUTE: bordas de instante, ambiente desconhecido, pacote sem fatos, imutabilidade
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('promessa 3 — layout-calendar: bordas e falha alta', () => {
  it('borda EXATA de H (2026-08-10T03:00:00Z): 1 ms antes = pacote de produção; no instante = pacote RTC; P nunca, nem em 2100', () => {
    for (const doc of ['DPS', 'EVENT'] as const) {
      expect(cnpjAlphanumericAccepted(doc, 'H', new Date('2026-08-10T02:59:59.999Z'))).toBe(false)
      expect(cnpjAlphanumericAccepted(doc, 'H', new Date('2026-08-10T03:00:00.000Z'))).toBe(true)
      expect(cnpjAlphanumericAccepted(doc, 'H', new Date('2026-08-10T00:00:00-03:00'))).toBe(true)
      expect(cnpjAlphanumericAccepted(doc, 'P', new Date('2100-01-01T00:00:00Z'))).toBe(false)
    }
  })
  it('ambiente desconhecido, instante inválido e instante anterior ao piso: FALHA ALTA (nunca "aceita" por omissão)', () => {
    for (const env of ['X', '', 'h', 'p', undefined, null] as any[]) {
      expect(() => cnpjAlphanumericAccepted('DPS', env, new Date('2026-10-16T12:00:00Z'))).toThrow(/Sem leiaute/)
    }
    expect(() => cnpjAlphanumericAccepted('DPS', 'H', new Date('xx'))).toThrow(/Instante inválido/)
    expect(() => cnpjAlphanumericAccepted('DPS', 'H', new Date('1999-12-31T23:59:59Z'))).toThrow(/Sem leiaute/)
    expect(() => cnpjAlphanumericAccepted('NFE' as any, 'H', new Date('2026-10-16T12:00:00Z'))).toThrow(/Sem leiaute/)
  })
  it('o calendário e as linhas são CONGELADOS (nada vira "aceita" em tempo de execução); toda linha tem pacote com fatos', () => {
    expect(() => (LAYOUT_CALENDAR as any).push({ document: 'DPS', environment: 'P', validFrom: '2026-01-01T00:00:00Z', version: '1.01', schema: 'NFSe-1.01-RTC-20260727' })).toThrow()
    expect(() => { (LAYOUT_CALENDAR[2] as any).schema = 'NFSe-1.01-RTC-20260727' }).toThrow()
    expect(() => { (LAYOUT_SCHEMAS as any)['NFSe-NOVO'] = { cnpjAlphanumeric: true, source: 'x' } }).toThrow()
    for (const l of LAYOUT_CALENDAR) expect(typeof LAYOUT_SCHEMAS[l.schema]?.cnpjAlphanumeric).toBe('boolean')
    // nenhum pacote herda fatos do protótipo (chave tipo `toString` não é pacote)
    expect(LAYOUT_SCHEMAS['toString' as string]).toBeInstanceOf(Function)            // o objeto É comum…
    expect(LAYOUT_CALENDAR.every(l => Object.prototype.hasOwnProperty.call(LAYOUT_SCHEMAS, l.schema))).toBe(true)   // …mas as linhas apontam só para chaves PRÓPRIAS
  })
  it('a linha vigente de P é UMA e numérica em qualquer instante desde o piso', () => {
    for (const iso of ['2000-01-01T00:00:00Z', '2026-08-10T03:00:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z']) {
      expect(LAYOUT_SCHEMAS[layoutLineAt('DPS', 'P', new Date(iso)).schema].cnpjAlphanumeric).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 3b — os cintos do montador: o que chega fora do leiaute LANÇA (nunca vai ao fisco nem mutilado)
// ---------------------------------------------------------------------------------------------------------------------------------------
const dps = (env: 'H' | 'P', prest: string, toma: Record<string, unknown>, dhEmi = '2026-10-16T09:00:00-03:00'): DpsInput => ({
  environment: env, dhEmi, verAplic: 'nfse-api', serie: 1, nDps: 42, dCompet: '2026-10-16', tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: prest, regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { xNome: 'Cliente', ...toma },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Licença' } },
  valores: { vServ: 100, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
} as any)

describe('promessa 3 — cintos do montador', () => {
  it('a BORDA de H vale pelo dhEmi (com fuso): 23:59:59 de 09/08 em Brasília LANÇA; 00:00:00 de 10/08 passa', () => {
    const id = buildDpsId('4106902', '2', ALFA, 1, 42)
    expect(() => buildDpsXml(dps('H', ALFA, { cnpj: NUM }, '2026-08-09T23:59:59-03:00'), id)).toThrow(/não aceita CNPJ com letras/)
    expect(buildDpsXml(dps('H', ALFA, { cnpj: NUM }, '2026-08-10T00:00:00-03:00'), id)).toContain(`<CNPJ>${ALFA}</CNPJ>`)
    expect(buildDpsXml(dps('H', ALFA, { cnpj: NUM }, '2026-08-10T00:00:00'), id)).toContain(`<CNPJ>${ALFA}</CNPJ>`)   // sem fuso = Brasília
  })
  it('fora da forma canônica LANÇA em H também (quebra de linha no fim, branco, minúscula, Unicode, 13/15 posições)', () => {
    const id = buildDpsId('4106902', '2', NUM, 1, 42)
    for (const bad of [`${NUM}\n`, ` ${NUM}`, 'pc3d315k000193', 'PC3D315K000193', '1234567800019５', NUM.slice(0, 13), `${NUM}0`]) {
      expect(() => buildDpsXml(dps('H', bad, { cnpj: NUM2 }), id)).toThrow(/fora da forma canônica/)
      expect(() => buildDpsXml(dps('H', NUM, { cnpj: bad }), id)).toThrow(/fora da forma canônica/)
    }
    expect(() => buildDpsId('4106902', '2', `${ALFA}\n`, 1, 42)).toThrow(/inscrição inválida/)
    expect(() => buildDpsId('4106902', '1', 'PC3D315K000', 1, 42)).toThrow(/inscrição inválida/)   // CPF nunca com letra
  })
  it('PRODUÇÃO: letra em QUALQUER das três posições (Id, prestador, tomador) lança — inclusive só no Id com prestador numérico', () => {
    expect(() => buildDpsXml(dps('P', NUM, { cnpj: NUM2 }), buildDpsId('4106902', '2', ALFA2, 1, 42))).toThrow(/Id do DPS com CNPJ alfanumérico/)
    expect(() => buildDpsXml(dps('P', ALFA2, { cnpj: NUM2 }), buildDpsId('4106902', '2', NUM, 1, 42))).toThrow(/prestador alfanumérico/)
    expect(() => buildDpsXml(dps('P', NUM, { cnpj: ALFA2 }), buildDpsId('4106902', '2', NUM, 1, 42))).toThrow(/tomador alfanumérico/)
  })
  it('tomador: CPF fora da forma, CPF com letra, CNPJ E CPF juntos, nenhum dos dois → LANÇA', () => {
    const id = buildDpsId('4106902', '2', NUM, 1, 42)
    for (const t of [{ cpf: '5299822472A' }, { cpf: '529982247250' }, { cpf: ' 52998224725' }, { cnpj: NUM2, cpf: '52998224725' }, {}, { cnpj: '', cpf: '' }]) {
      expect(() => buildDpsXml(dps('H', NUM, t), id)).toThrow()
    }
  })
  it('evento: CNPJAutor fora da forma lança em H; alfanumérico em H ANTES da borda lança; CPFAutor com máscara lança; os dois juntos lança', () => {
    const key = '4106902' + '2' + '2' + ALFA + '0000000000123' + '2610' + '000000001' + '7'
    const ev = (over: Record<string, unknown>) => () => buildCancelEventXml({ accessKey: key, dhEvento: '2026-10-16T10:00:00-03:00', cMotivo: '2',
      xMotivo: 'Serviço não prestado ao cliente', environment: 'H', verAplic: 'v', ...over } as any)
    expect(ev({ cnpjAutor: 'pc3d315k000193' })).toThrow(/fora da forma canônica/)
    expect(ev({ cnpjAutor: ALFA, dhEvento: '2026-08-09T23:59:59-03:00' })).toThrow(/não aceita CNPJ com letras/)
    expect(ev({ cpfAutor: '529.982.247-25' })).toThrow(/CPF do autor fora da forma/)
    expect(ev({ cnpjAutor: ALFA, cpfAutor: '52998224725' })).toThrow(/exatamente um/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 3c — recusa legível (422) ANTES de nDPS/tentativa/fisco em todo caminho; harness = o de `transmission.test.ts`
// ---------------------------------------------------------------------------------------------------------------------------------------
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-advcj1-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const KEY = '4106902221234567800019500000000001232026092100001234'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019500001000000000000042'

const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
let emitterDoc = NUM
let tomaDoc = NUM2
const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? emitterDoc : tomaDoc, im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
const opened = (env = 'H') => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${NUM}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: NUM, fingerprint256: 'x' },
})
const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 13:15:30', createdAt: '2026-09-21 13:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})

let headerRow: any
let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  emitterDoc = NUM
  tomaDoc = NUM2
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
  erpM.establishmentCnpj.mockImplementation(async () => emitterDoc)
  erpM.establishmentCnpjFact.mockImplementation(async () => fiscal.readFederalIdFact('cnpj', emitterDoc))
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.getLifeDps as jest.Mock).mockResolvedValue(null)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

const nothingReservedNorSent = () => {
  expect(fiscal.nextDpsNumber).not.toHaveBeenCalled()
  expect(repo.insertLifeDps).not.toHaveBeenCalled()
  expect(repo.insertTransmission).not.toHaveBeenCalled()
  expect(adapter.transmit).not.toHaveBeenCalled()
  expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()
}

describe('promessa 3 — PRODUÇÃO recusa LEGÍVEL antes de nDPS/tentativa/fisco, em todo caminho', () => {
  it('emitente E tomador alfanuméricos: 422 FISCAL_DPS_INVALID com os DOIS campos; nada reservado nem enviado', async () => {
    emitterDoc = ALFA; tomaDoc = ALFA2
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    const err = await transmitServiceInvoice(deps, A, webRef(A, INVOICE)).then(() => null, x => x)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID' })
    expect(err.fields.map((f: any) => f.field).sort()).toEqual(['emitter.cnpj', 'recipient.document'])
    nothingReservedNorSent()
  })
  it('passo 0b: com uma reserva INTERROMPIDA em voo, a recusa vem ANTES da pergunta ao fisco (GET /dps nunca é chamado)', async () => {
    emitterDoc = ALFA
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ environment: 'P', lastKind: null, accessKey: null, nfseNumber: null, ageMinutes: 30, lastEvent: null }))
    await expect(transmitServiceInvoice(deps, A, webRef(A, INVOICE))).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID' })
    nothingReservedNorSent()
  })
  it('CORRIDA: a habilitação vira H→P entre a pré-checagem e a reserva → 422 do cinto DENTRO da transação, que é DESFEITA (rollback, sem commit, sem fisco)', async () => {
    emitterDoc = ALFA
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened('H')).mockResolvedValue(opened('P'))
    const err = await transmitServiceInvoice(deps, A, webRef(A, INVOICE)).then(() => null, x => x)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID' })
    expect(adapter.transmit).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
    // o arquivo fiscal não recebeu DPS (o snapshot só é gravado depois do COMMIT da reserva)
    expect(fs.existsSync(path.join(storageRoot, ALFA))).toBe(false)
  })
  it('HOMOLOGAÇÃO: o DPS assinado vai para a pasta do CNPJ COMO É (letras), nunca uma pasta "só dígitos"', async () => {
    emitterDoc = ALFA
    adapter.transmit.mockRejectedValue(new AuthorityHttpError(503, 'Fisco indisponível', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, ''))
    await transmitServiceInvoice(deps, A, webRef(A, INVOICE)).catch(() => null)
    const sent = adapter.transmit.mock.calls[0][1] as string
    expect(sent).toContain(`<prest><CNPJ>${ALFA}</CNPJ>`)
    expect(fs.existsSync(path.join(storageRoot, ALFA, 'H'))).toBe(true)
    expect(fs.readdirSync(storageRoot).filter(d => d !== ALFA)).toEqual([])
  })
  // O cancelamento lê o CNPJAutor do cadastro ATUAL (buildEmitter — que na onda 1 deixou de recusar o alfanumérico); em P o cinto do montador
  // do evento LANÇA um Error cru, o preparo libera o K com "falha interna no preparo" e o erro sobe como 500 (com ref), não como 422 legível.
  // D-CJ19 (2026-10-16): o autor do pedido é o emitente da NOTA (embutido na chave), não o cadastro de hoje — o caso passa a ser a nota COM
  // letra em P (chave e DPS do emitente alfanumérico); cadastro hoje alfanumérico com nota numérica segue (teste em `transmission.test.ts`)
  it('[CORRIGIDO na sessão — ACHADO LOW] cancelar em PRODUÇÃO nota de emitente alfanumérico: 422 legível ANTES do K (era Error cru → 500 depois da reserva)', async () => {
    emitterDoc = ALFA
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    const keyAlfa = '4106902' + '2' + '2' + ALFA + '0000000000123' + '2610' + '000012345' + '6'
    const dpsAlfa = `DPS4106902${'2'}${ALFA}00001${'000000000000042'}`
    // a tentativa ACOMPANHA as vozes gravadas (K da reserva, N da liberação) — molde `followVoices` de transmission.test.ts
    let kind: string | null = 'A'
    ;(repo.insertTransmissionEvent as jest.Mock).mockImplementation(async (_i: any, _a: number, _u: any, ev: any) => { kind = ev.kind; return 2 })
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => tx({ environment: 'P', lastKind: kind, accessKey: keyAlfa, dpsId: dpsAlfa }))
    const err = await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'cliente desistiu do serviço').then(() => null, x => x)
    expect(adapter.registerEvent).not.toHaveBeenCalled()                                                   // o fisco não é chamado
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()                                            // e NADA é reservado (nem K, nem N)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_INVALID' })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 3d — `emitterCnpj` tolerante (D-CJ16): nunca aponta para a pasta de OUTRO CNPJ nem aceita lixo
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('promessa 3 — emitterCnpj (D-CJ16)', () => {
  const read = async (raw: unknown) => {
    erpM.establishmentCnpj.mockResolvedValue(null)
    erpM.establishmentCnpjFact.mockResolvedValue(fiscal.readFederalIdFact('cnpj', raw))
    return emitterCnpj(pool, 1).then(v => v, (e: any) => `ERR ${e.statusCode} ${e.code}`)
  }
  it('máscara sai, minúscula sobe, branco das pontas sai — a MESMA inscrição', async () => {
    expect(await read('12.345.678/0001-95')).toBe(NUM)
    expect(await read('pc.3d3.15k/0001-93')).toBe(ALFA)
    expect(await read(` ${ALFA} `)).toBe(ALFA)
  })
  it('nada é APAGADO: Unicode, sublinhado, 13/15 posições, quebra de linha interna, caminho com letra → 422 (nunca outra pasta)', async () => {
    for (const raw of ['PC3D315K00019３', 'PC3D_315K000193', NUM.slice(0, 13), `${NUM}0`, '1234567800\n0195', '../x/12345678000195', 'ſC3D315K000193', 'PC3D315K000193']) {
      expect([raw, await read(raw)]).toEqual([raw, 'ERR 422 FISCAL_EMITTER_INCOMPLETE'])
    }
  })
  it('ausente (null, vazio, sentinela "0") → 422 "sem CNPJ"', async () => {
    for (const raw of [null, '', '0', '   ']) expect([raw, await read(raw)]).toEqual([raw, 'ERR 422 FISCAL_EMITTER_INCOMPLETE'])
  })
  it('separador de caminho nunca sobrevive: o que volta casa a forma canônica (sem "/", "\\\\", "..")', async () => {
    for (const raw of ['12/345/678/0001/95', '12.345.678.0001.95', '12-345-678-0001-95']) {
      const v = await read(raw)
      expect([raw, v]).toEqual([raw, NUM])
    }
    expect(await read('12\\345678000195')).toBe('ERR 422 FISCAL_EMITTER_INCOMPLETE')
  })
  // O veto dos 14 dígitos iguais é a forma clássica de LIXO (o "preenchimento" de quem não tem o número); a leitura tolerante o devolve
  // como pasta do arquivo fiscal (D-CJ16 abriu mão do DV, mas não decidiu abrir mão do veto).
  it('[CORRIGIDO na sessão — ACHADO LOW] "00000000000000" / "00.000.000/0000-00" no cadastro: a leitura tolerante RECUSA (o veto dos iguais vale — era lixo aceito como pasta)', async () => {
    expect(await read('00000000000000')).toBe('ERR 422 FISCAL_EMITTER_INCOMPLETE')
    expect(await read('00.000.000/0000-00')).toBe('ERR 422 FISCAL_EMITTER_INCOMPLETE')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 4 — cerca `federal-id-fence`, regra 5 (helper de dígitos aplicado a inscrição — D-CJ15). Predicado IDÊNTICO nos 3 repositórios.
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('promessa 4 — regra 5 da cerca (vigia o VALOR)', () => {
  it('formas que a regra 5 PEGA (resistiu)', () => {
    for (const code of [
      "el('CNPJ', digits(p['cnpj'], 'x', 14))", 'digits(`${p.cnpj}`, "x", 14)', "digits?.(p.cnpj, 'x', 14)", "digits(...[p.cnpj, 'x', 14])",
      "digits(input.cnpjAutor, 'CNPJ do autor', 14)", 'digitsOf(row.CNPJ)', "onlyDigits(toma.cpf)", "digits(inscricao, 'x', 14)",
      "digits(String(p.cnpj ?? ''), 'x', 14)", 'digits(federalId.value)', "digits(recipient.document, 'x')",
    ]) expect([code, strippingHitsIn(code).length > 0]).toEqual([code, true])
  })
  // A regra 5 casa o NOME do helper (identificador nu de uma lista fechada) e o TEXTO do 1º argumento. Qualquer indireção escapa — inclusive
  // o nome de variável que o próprio montador usa (`const insc = String(inscricao ?? '')` em `buildDpsId`). Hoje NENHUM uso real escapa
  // (varredura dos 3 repositórios: todo `digits`/`digitsOf` do código recebe cMun/CEP/fone/códigos/IBGE) — o risco é a REGRESSÃO calada.
  it('[CORRIGIDO na sessão — ACHADO LOW] formas que ESCAPAVAM da regra 5 (alias, argumento indireto, outro nome, chamada indireta)', () => {
    const escapes = [
      "const insc = String(inscricao ?? ''); el('CNPJ', digits(insc, 'Id', 14))",       // o nome do próprio buildDpsId
      "const x = p.cnpj; el('CNPJ', digits(x, 'CNPJ do prestador', 14))",               // argumento indireto
      "const { cnpj: c } = p; digits(c, 'x', 14)",                                      // desestruturação renomeada
      "const d = digits; el('CNPJ', d(p.cnpj, 'x', 14))",                               // alias do helper
      "(digits)(p.cnpj, 'x', 14)",                                                      // parênteses
      "digits.call(null, p.cnpj, 'x', 14)",                                             // .call
      "h.digits(p.cnpj, 'x', 14)",                                                      // helper importado como namespace
      "[p.cnpj].map(v => digits(v, 'x', 14))",                                          // callback
      "soNumeros(p.cnpj)",                                                              // outro nome (definido sobre digits())
      "digits(t.doc, 'x', 14)", "digits(toma.ni, 'x', 14)", "digits(emitter.id14, 'x', 14)",   // nome de campo fora da lista
    ].filter(code => strippingHitsIn(code).length === 0)
    expect(escapes).toEqual([])
  })
  // Fora da regra 5, as regras 1–4 (do gate da onda 0) reconhecem a classe pelo TEXTO `0-9`/`\d`/`0123456789` e a flag g — formas
  // equivalentes escritas de outro jeito passam caladas. Mesma classificação: regressão possível, nenhum uso real hoje.
  it('[CORRIGIDO na sessão — ACHADO LOW] regras 1–4: formas equivalentes de "tirar o que não é dígito" que ESCAPAM (escape hex/Unicode, \\p{…}, sem flag g, includes, coerção numérica)', () => {
    const escapes = [
      String.raw`cnpj.replace(/[^\x30-\x39]/g, '')`,
      String.raw`cnpj.replace(/[^0-9]/g, '')`,
      String.raw`cnpj.replace(/\p{L}/gu, '')`,
      String.raw`cnpj.replace(/[^\p{Nd}]/gu, '')`,
      String.raw`[...cnpj].filter(c => /\d/.test(c)).join('')`,
      String.raw`[...cnpj].filter(c => '0123456789'.includes(c)).join('')`,
      String.raw`[...cnpj].filter(c => !isNaN(Number(c))).join('')`,
      String.raw`const re = '\\D'; cnpj.replace(new RegExp(re, 'g'), '')`,
      String.raw`String(parseInt(cnpj, 10)).padStart(14, '0')`,
    ].filter(code => strippingHitsIn(code).length === 0)
    expect(escapes).toEqual([])
  })
})
