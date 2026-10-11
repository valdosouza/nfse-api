/// <reference types="jest" />
// nfse-api — composição da NFS-e (F1 da extração fiscal). Cenários PORTADOS da Onda 3 (setes-api
// invoice-transmission.test.ts) + o que as Rodadas 2/3 mudaram:
//  - a nota é TRAVADA no ERP e é o 1º lock (D-F27/D-F31); o fisco nunca é chamado com transação aberta;
//  - o DPS da VIDA nasce uma vez (série + nDPS + Id) e é REUSADO; Id que mudaria → 409 (D-F30);
//  - NENHUM efeito no ERP: voz C gravada e devolvida; pendência derivada (D-F28);
//  - cancelar sem NFS-e autorizada → 409 FISCAL_NOT_AUTHORIZED (o app vai direto ao setes-api);
//  - reconfirmação grava a PROVA (last_queried_at) quando o fisco não acha (D-F29);
//  - rodízio sem Map em memória: ALUGUEL na linha do emissor (gates da F1 — a trava nomeada retinha conexão);
//  - cancelamento com RESERVA em voo: K antes do fisco; recusa/preparo local que falha → N (o pedido não vigora).
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-tx-'))
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

describe('transmitir — trava da nota → DPS da vida → fisco FORA da transação → A', () => {
  it('caminho feliz: nota travada antes do emissor; DPS da VIDA nasce (série + nDPS + Id); A + XML; fisco entre commits', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
    const r = await transmitServiceInvoice(deps, A, INVOICE)
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, dpsId: DPS_ID, accessKey: KEY, nfseNumber: '123', kind: 'A' })
    // a trava da nota (ERP) é o 1º lock; o emissor FOR UPDATE vem depois (ordem nota → emissor → DPS → tentativa)
    const lockAt = erpM.lockInvoice.mock.invocationCallOrder[0]
    const issuerForUpdate = (fiscal.openIssuer as jest.Mock).mock.calls.findIndex(c => c[3]?.forUpdate)
    expect(lockAt).toBeLessThan((fiscal.openIssuer as jest.Mock).mock.invocationCallOrder[issuerForUpdate])
    expect(fiscal.nextDpsNumber).toHaveBeenCalledTimes(1)
    expect(repo.insertLifeDps).toHaveBeenCalledWith(conn, 1, INVOICE, { lifeEvent: 1, serie: '1', dpsNumber: 42, dpsId: DPS_ID }, A.userId)
    expect(repo.insertTransmission).toHaveBeenCalledWith(conn, 1, INVOICE, 1, 'H', A.userId)
    const fiscoAt = adapter.transmit.mock.invocationCallOrder[0]
    expect(conn.commit.mock.invocationCallOrder[0]).toBeLessThan(fiscoAt)
    expect(conn.beginTransaction.mock.invocationCallOrder[1]).toBeGreaterThan(fiscoAt)
    const sent = adapter.transmit.mock.calls[0][1] as string
    expect(sent).toContain(`<infDPS Id="${DPS_ID}">`)
    expect(sent).toContain('<prest><CNPJ>12345678000199</CNPJ><IM>777</IM><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>')
    expect(sent).toContain('<toma><CNPJ>98765432000188</CNPJ><xNome>Cliente Ltda</xNome>')
    expect(sent).not.toContain('<pAliq>')                       // ME/EPP pelo Simples sem retenção (E0625)
    expect(repo.fillAuthorityData).toHaveBeenCalledWith(conn, 1, INVOICE, 1, { accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 13:15:30' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'A', source: 'P', dh: '2026-09-21 13:15:30' }))
    const files = fs.readdirSync(path.join(storageRoot, CNPJ, 'H'), { recursive: true } as any).map(String)
    expect(files.some(f => f.endsWith(`${DPS_ID}-dps.xml`))).toBe(true)
    expect(files.some(f => f.endsWith(`${KEY}-nfse.xml`))).toBe(true)
    // D-F31: nenhuma escrita no ERP (só a trava) — a única SQL na conexão fora da fiscal é o SELECT do ramo
    expect(conn.query.mock.calls.filter(([sql]) => /setes_setes/.test(sql) && !/^\s*SELECT/i.test(sql))).toEqual([])
  })

  it('DPS da vida JÁ existe (tentativa anterior R) → REUSA série/nDPS/Id; nenhum nDPS novo; attempt 2', async () => {
    ;(repo.getLifeDps as jest.Mock).mockResolvedValue({ lifeEvent: 1, serie: '1', dpsNumber: 42, dpsId: DPS_ID })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'R', accessKey: null }))
    ;(repo.insertTransmission as jest.Mock).mockResolvedValue(2)
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '124', dhProc: '2026-09-21T11:00:00-03:00', nfseXml: NFSE_XML, raw: {} })
    const r = await transmitServiceInvoice(deps, A, INVOICE)
    expect(r.attempt).toBe(2)
    expect(fiscal.nextDpsNumber).not.toHaveBeenCalled()
    expect(repo.insertLifeDps).not.toHaveBeenCalled()
  })

  it('D-F30: série TROCADA no emissor depois da 1ª tentativa NÃO muda o Id da vida (série congelada no DPS)', async () => {
    ;(repo.getLifeDps as jest.Mock).mockResolvedValue({ lifeEvent: 1, serie: '1', dpsNumber: 42, dpsId: DPS_ID })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'F', accessKey: null }))
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({ ...opened(), issuer: { ...opened().issuer, serie: '7' } })
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '124', dhProc: null, nfseXml: NFSE_XML, raw: {} })
    const r = await transmitServiceInvoice(deps, A, INVOICE)
    expect(r.dpsId).toBe(DPS_ID)
    expect(adapter.transmit.mock.calls[0][1]).toContain('<serie>1</serie>')
  })

  it('D-F30: o Id da vida mudaria (município do emitente mudou) → 409 FISCAL_DPS_ID_CHANGED, nada reservado nem enviado', async () => {
    ;(repo.getLifeDps as jest.Mock).mockResolvedValue({ lifeEvent: 1, serie: '1', dpsNumber: 42, dpsId: DPS_ID })
    erpM.cityIbge.mockResolvedValue('3550308')
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_DPS_ID_CHANGED' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
    expect(adapter.transmit).not.toHaveBeenCalled()
  })

  it('REJEIÇÃO (422 E0xxx) → voz R (source P, authority_code E0718) e o 422 sobe', async () => {
    adapter.transmit.mockRejectedValue(rejected())
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_DPS_REJECTED' })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'R', source: 'P', authorityCode: 'E0718' }))
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
  })

  it('AMBÍGUO (503) → NADA gravado além da reserva (em voo; a consulta por dps_id reconcilia)', async () => {
    adapter.transmit.mockRejectedValue(unavailable())
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 503 })
    expect(repo.insertTransmission).toHaveBeenCalledTimes(1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(conn.commit).toHaveBeenCalledTimes(1)
  })

  it('já AUTORIZADA → 409 FISCAL_ALREADY_AUTHORIZED; em voo → IN_PROGRESS; K → CANCEL_IN_FLIGHT — nunca o fisco', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_ALREADY_AUTHORIZED' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null, ageMinutes: 1 }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
    expect(adapter.transmit).not.toHaveBeenCalled()
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it('gate M-5: a consulta pousou a MESMA chave numa irmã durante o POST → a reservada fecha com F "envio reconciliado", nunca 500', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
    ;(repo.insertTransmission as jest.Mock).mockResolvedValue(2)
    ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(tx({ attempt: 1 }))
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(tx({ attempt: 2, lastKind: null, accessKey: null }))
    const r = await transmitServiceInvoice(deps, A, INVOICE)
    expect(r.attempt).toBe(1)
    expect(repo.fillAuthorityData).not.toHaveBeenCalled()
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 2, A.userId, expect.objectContaining({ kind: 'F', message: expect.stringMatching(/envio reconciliado/) }))
  })

  it('D-F28: voz C do fisco com a nota ainda NÃO cancelada no ERP → 409 FISCAL_EFFECT_PENDING (resolve-se no ERP antes)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C' }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_EFFECT_PENDING' })
  })

  it('nota mudou entre a leitura e a trava (evento novo) → 409 RESOURCE_BUSY, nada reservado', async () => {
    locked = { alive: true, lifeEvent: 3, lastEvent: 3, lastKind: 'E' }
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })

  it('sem ramo → 422; sem código nacional → 422; sincronizada → 409; tomador sem documento → 422 — tudo ANTES de reservar', async () => {
    headerRow = header({ branchId: null })
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'INVOICE_SERVICE_BRANCH_MISSING' })
    headerRow = header({ nationalCode: null })
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'SERVICE_RULE_NATIONAL_CODE_REQUIRED' })
    headerRow = header({ lastKind: null, lifeEvent: null })
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_NOT_TRANSMITTABLE' })
    headerRow = header()
    erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => id === 900 ? { ...entity(900), cnpj: null } : entity(id))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 422, code: 'FISCAL_RECIPIENT_INCOMPLETE' })
    expect(repo.insertTransmission).not.toHaveBeenCalled()
  })
})

describe('D-F59 (= Q-F67 (a), Valdo 2026-10-10) — IM do PRESTADOR no DPS só em HOMOLOGAÇÃO', () => {
  // o cadastro do emitente TEM a IM (777): em H o CNC exige (E0116 — smoke de 2026-10-10); em P o CNC recusa (E0120 — Q-N35)
  it('habilitação em PRODUÇÃO: o mesmo emitente sai SEM <IM> no <prest> (o caminho feliz em H acima leva <IM>777</IM>)', async () => {
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21T10:15:30-03:00', nfseXml: NFSE_XML, raw: {} })
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
    await transmitServiceInvoice(deps, A, INVOICE)
    const sentP = adapter.transmit.mock.calls[0][1] as string
    expect(sentP).toContain('<prest><CNPJ>12345678000199</CNPJ><regTrib>')
    expect(sentP).not.toMatch(/<prest>(?:(?!<\/prest>)[\s\S])*<IM>/)
  })
})

describe('consultar — a voz do fisco, idempotente, SEM efeito no ERP', () => {
  it('A já gravado e fisco "authorized" → nada novo; last_queried_at marcado', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: false, kind: 'A', localCancelPending: false })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(conn, 1, INVOICE, 1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it('em voo RECENTE (< 10 min) sem chave: GET /dps não gerou → só "nós olhamos" (o POST pode estar no fisco agora — D-I21/D-F51)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r.changed).toBe(false)
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, 1, INVOICE, 1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it('D-F51: em voo há ≥ 10 min e o fisco SEM o DPS → F "sem resposta" por CONSULTA, sob a trava da nota (o mesmo veredito do transmitir)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null, ageMinutes: 15 }))
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null, ageMinutes: 15 }))
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'F', accessKey: null })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'F', source: 'Q' }))
    expect(conn.commit).toHaveBeenCalled()
  })

  it('D-F51: sob a trava a tentativa JÁ ganhou voz (corrida com outra consulta) → nenhum F; devolve a voz LIDA e não carimba (gate r10)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null, ageMinutes: 15 }))
    ;(repo.getTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: false, kind: 'A' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })

  it('em voo sem chave: GET /dps achou → A retroativo (source Q) + write-once', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'A', accessKey: KEY })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'A', source: 'Q' }))
  })

  it('C do fisco → SÓ a voz C; nota ainda E no ERP → localCancelPending (o app envia ao setes-api); nenhum C local daqui', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null, cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'erro na emissão do documento' } })
    const r = await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(r).toMatchObject({ changed: true, kind: 'C', localCancelPending: true })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'C', source: 'Q', dh: '2026-09-22 12:00:00' }))
    expect(conn.query.mock.calls.filter(([sql]) => /setes_setes/.test(sql))).toEqual([])
  })

  it('a mesma voz C 2× (idempotência por KIND) → nada novo; tentativa já C → não volta ao fisco (com o XML do evento arquivado)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 2, kind: 'C' })
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null, cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x' } })
    await refreshServiceTransmission(deps, A, INVOICE, 'Q')
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    adapter.queryNfse.mockClear()
    const cTx = tx({ lastKind: 'C', lastCode: '101101' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(cTx)
    deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, '<evento/>', new Date(`${cTx.dhProc!.replace(' ', 'T')}Z`), 'H', 'America/Sao_Paulo')
    try {
      await refreshServiceTransmission(deps, A, INVOICE, 'Q')
      expect(adapter.queryNfse).not.toHaveBeenCalled()
    } finally { fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true }) }
  })
  it('D-F78 (= Q-F85 (a)): tentativa já C SEM o XML do evento no arquivo → relê o fisco SÓ para arquivar (nenhuma voz); outro código não arquiva', async () => {
    const cTx = tx({ lastKind: 'C', lastCode: '105102' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(cTx)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
      cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x', eventCode: '101101', eventXml: '<evento>outro</evento>' } })
    try {
      await refreshServiceTransmission(deps, A, INVOICE, 'Q')
      expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
      const hasFile = () => !!deps.storage.find(CNPJ, `${KEY}-evt101101.xml`, [cTx.dhProc, cTx.createdAt], 'H', 'America/Sao_Paulo')
      expect(hasFile()).toBe(false)                                                     // o fisco falou de OUTRO código: nada arquivado
      adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
        cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x', eventCode: '105102', eventXml: '<evento>subst</evento>' } })
      await refreshServiceTransmission(deps, A, INVOICE, 'Q')
      expect(hasFile()).toBe(true)
      expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
      adapter.queryNfse.mockClear()
      await refreshServiceTransmission(deps, A, INVOICE, 'Q')                           // arquivado: não volta mais ao fisco
      expect(adapter.queryNfse).not.toHaveBeenCalled()
    } finally { fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true }) }
  })

  it('nunca transmitida → 409 FISCAL_NOT_TRANSMITTED; situação "unknown" → 502 sem gravar voz', async () => {
    await expect(refreshServiceTransmission(deps, A, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_TRANSMITTED' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'unknown', nfseXml: NFSE_XML, dhProc: null })
    await expect(refreshServiceTransmission(deps, A, INVOICE, 'Q')).rejects.toMatchObject({ statusCode: 502, code: 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
})

describe('cancelar no fisco — operação EM LINHA (D-F28)', () => {
  it('nunca transmitida / R / F → 409 FISCAL_NOT_AUTHORIZED (o app cancela direto no ERP); fisco não é chamado', async () => {
    for (const t of [null, tx({ lastKind: 'R', accessKey: null }), tx({ lastKind: 'F', accessKey: null })]) {
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
      await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NOT_AUTHORIZED' })
    }
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('fisco ACEITA → voz C (source P) + evento no arquivo fiscal; resposta "ok" com nextStep; NENHUM C local daqui', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A', dhProc: '2026-08-15 13:00:00' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    const EVT = '<evento><infEvento Id="EVT1"><dhProc>2026-09-22T09:00:00-03:00</dhProc></infEvento></evento>'
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: EVT, raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')
    expect(r).toEqual({ invoiceId: INVOICE, attempt: 1, atAuthority: true, transmissionEvent: 2, warnings: [], nextStep: 'apply-local-cancel' })
    const eventXml = adapter.registerEvent.mock.calls[0][2] as string
    expect(eventXml).toContain(`<chNFSe>${KEY}</chNFSe>`)
    expect(eventXml).toContain('<xMotivo>cliente desistiu do serviço</xMotivo>')
    expect(eventXml).toContain(`<CNPJAutor>${CNPJ}</CNPJAutor>`)
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'C', source: 'P', dh: '2026-09-22 12:00:00' }))
    expect(fs.readFileSync(path.join(storageRoot, CNPJ, 'H', '2026', '08', `${KEY}-evt101101.xml`), 'utf8')).toBe(EVT)
    expect(conn.query.mock.calls.filter(([sql]) => /setes_setes/.test(sql))).toEqual([])
  })

  it('motivo curto ganha complemento; prazo do PAM vencido só AVISA (D-N15)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A', dhProc: '2026-01-01 10:00:00' }))
    adapter.municipalTerms.mockResolvedValue({ cancelDays: 30, raw: {} })
    adapter.registerEvent.mockResolvedValue({ dhEvento: null, raw: {} })
    const r = await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')
    expect(r.warnings).toEqual([expect.stringMatching(/Prazo de cancelamento .*30 dias/)])
    expect(adapter.registerEvent.mock.calls[0][2]).toContain('<xMotivo>erro - Cancelamento solicitado pelo emissor</xMotivo>')
  })

  /** Estado da tentativa 1 que ACOMPANHA as vozes gravadas (K da reserva, N da liberação). */
  const followVoices = (start: string) => {
    let kind: string | null = start
    ;(repo.insertTransmissionEvent as jest.Mock).mockImplementation(async (_c: any, _i: number, _n: number, _a: number, _u: any, ev: any) => { kind = ev.kind; return 2 })
    ;(repo.latestTransmission as jest.Mock).mockImplementation(async () => tx({ lastKind: kind }))
    return () => kind
  }
  const kindsWritten = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c[5].kind)

  it('RESERVA: o K nasce ANTES do fisco (quem chega depois vê K → CANCEL_IN_FLIGHT)', async () => {
    followVoices('A')
    let kindAtAuthority: string | null = null
    adapter.registerEvent.mockImplementation(async () => { kindAtAuthority = kindsWritten().join(','); return { dhEvento: null, raw: {} } })
    await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')
    expect(kindAtAuthority).toBe('K')
    expect(kindsWritten()).toEqual(['K', 'C'])
    // K é fato NOSSO: sem dh — a chave única (kind, dh) é da voz do fisco (K → N → K no mesmo segundo colidia → 500)
    expect((repo.insertTransmissionEvent as jest.Mock).mock.calls[0][5].dh).toBeNull()
  })

  it('fisco RECUSA (E0822) → 409 FISCAL_CANCEL_REFUSED e N libera a reserva (NFS-e segue autorizada); AMBÍGUO → o K FICA e o 503 sobe', async () => {
    const kindNow = followVoices('A')
    adapter.registerEvent.mockRejectedValueOnce(new AuthorityHttpError(422, 'Fisco rejeitou', 'FISCAL_DPS_REJECTED', 400, '', [{ field: 'event', message: 'E0822: prazo de cancelamento expirado' }]))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CANCEL_REFUSED' })
    expect(kindsWritten()).toEqual(['K', 'N'])
    expect(kindNow()).toBe('N')                                         // N = cancelável de novo (D-N17)
    ;(repo.insertTransmissionEvent as jest.Mock).mockClear()
    adapter.registerEvent.mockRejectedValueOnce(unavailable())
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ statusCode: 503 })
    expect(kindsWritten()).toEqual(['K'])                               // ambíguo: o fisco PODE ter cancelado
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'outra tentativa de cancelar')).rejects.toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
  })

  it('gates do delta de 2026-10-04: A1 que não abre SOB a trava da habilitação → 409 ANTES do K (nenhuma voz, fisco não chamado)', async () => {
    followVoices('A')
    ;(fiscal.openIssuer as jest.Mock).mockRejectedValueOnce(new HttpError(409, 'A1 vencido', undefined, 'FISCAL_CERT_EXPIRED'))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ code: 'FISCAL_CERT_EXPIRED' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(kindsWritten()).toEqual([])
    expect((fiscal.openIssuer as jest.Mock).mock.calls[0][3]).toMatchObject({ forUpdate: true, schemaName: 'setes_setes' })   // na decisão, travando
  })

  it('preparo LOCAL falha DEPOIS do K (o A1 abriu na decisão e não abre no preparo) → o fisco NÃO é chamado e N libera a reserva', async () => {
    followVoices('A')
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened()).mockRejectedValueOnce(new HttpError(409, 'A1 vencido', undefined, 'FISCAL_CERT_EXPIRED'))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ code: 'FISCAL_CERT_EXPIRED' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(kindsWritten()).toEqual(['K', 'N'])
  })

  it('em voo → IN_PROGRESS; K → CANCEL_IN_FLIGHT; já C → ok idempotente (atAuthority false) sem chamar o fisco', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: null, accessKey: null }))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')).rejects.toMatchObject({ code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'K' }))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')).rejects.toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 3 }))
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 3, kind: 'C' })
    const r = await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')
    expect(r).toMatchObject({ atAuthority: false, transmissionEvent: 3, nextStep: 'apply-local-cancel' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })
  it('[gate do delta da Rodada 6 — M2 = r8-cancel-idem] já C + A1 vencido / chave-mestra ausente → AINDA o ok idempotente (o emissor nem é aberto); recusas de estado também não abrem', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 3 }))
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 3, kind: 'C' })
    ;(fiscal.openIssuer as jest.Mock).mockRejectedValue(new HttpError(409, 'A1 vencido', undefined, 'FISCAL_CERT_EXPIRED'))
    const r = await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')
    expect(r).toMatchObject({ atAuthority: false, transmissionEvent: 3, nextStep: 'apply-local-cancel' })
    for (const t of [null, tx({ lastKind: 'R', accessKey: null }), tx({ lastKind: 'K' })]) {
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(t)
      await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'erro')).rejects.toMatchObject({ statusCode: 409 })
    }
    expect(fiscal.openIssuer).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })
})

describe('reconfirmar (Q-ADV1b → D-F29) — a PROVA lida no banco', () => {
  const fq = (over: any = {}) => tx({ lastKind: 'F', lastSource: 'Q', accessKey: null, environment: 'P', ...over })

  it('F por consulta em P sem chave: fisco não acha (E2404) → grava a PROVA na CANDIDATA (`nfse_not_generated_at`, D-F90) e nada mais', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [fq({ attempt: 1 }), tx({ attempt: 2, lastKind: 'R', accessKey: null, environment: 'P' })], events: [] })
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const base = pool.query.getMockImplementation()
    pool.query.mockImplementation(async (sql: string, p: any[]) => (/nfse_not_generated_at = NOW\(\)/.test(sql) ? [{ affectedRows: 1 }] : base!(sql, p)))
    const r = await reconfirmBeforeLocalCancel(deps, A, INVOICE)
    expect(r).toEqual({ invoiceId: INVOICE, needed: true, found: false, attempt: 1, accessKey: null })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, 1, INVOICE, 1)
    expect(pool.query.mock.calls.filter((c: any[]) => /nfse_not_generated_at = NOW\(\)/.test(String(c[0])))).toHaveLength(1)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
  })
  it('LOW-4 do gate da Rodada 16: a guarda da prova recusa (a voz mudou durante a pergunta) → 409 RESOURCE_BUSY "consulte de novo", nunca "reconferido"', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [fq({ attempt: 1 })], events: [] })
    adapter.queryDpsAccessKey.mockResolvedValue(null)
    const base = pool.query.getMockImplementation()
    pool.query.mockImplementation(async (sql: string, p: any[]) => (/nfse_not_generated_at = NOW\(\)/.test(sql) ? [{ affectedRows: 0 }] : base!(sql, p)))
    await expect(reconfirmBeforeLocalCancel(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
  })

  it('o fisco AGORA acha a NFS-e → reconcilia (A) — e se nada pousou, 409 (não cancela no escuro)', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [fq()], events: [] })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(fq())
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await expect(reconfirmBeforeLocalCancel(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_TRANSMISSION_IN_PROGRESS' })
    expect(adapter.queryDpsAccessKey).toHaveBeenCalledTimes(1)
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
  })

  it('homologação, F direto (P), R, sem tentativa ou com chave → needed false, fisco não é chamado', async () => {
    for (const list of [[fq({ environment: 'H' })], [fq({ lastSource: 'P' })], [tx({ lastKind: 'R', accessKey: null })], [], [fq(), tx({ attempt: 2, lastKind: 'A' })]]) {
      ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: list, events: [] })
      expect(await reconfirmBeforeLocalCancel(deps, A, INVOICE)).toMatchObject({ needed: false })
    }
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()
  })

  it('fisco FORA → o erro sobe (fail-closed) e a prova NÃO é gravada', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [fq()], events: [] })
    adapter.queryDpsAccessKey.mockRejectedValue(new HttpError(503, 'fora', undefined, 'FISCAL_AUTHORITY_UNAVAILABLE'))
    await expect(reconfirmBeforeLocalCancel(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 503 })
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()
  })
})

describe('consulta ativa — ALUGUEL na linha do emissor, candidatas filtradas no SQL', () => {
  it('outra passada do mesmo estabelecimento em curso (aluguel não obtido) → skipped, nada consultado, nenhuma conexão retida', async () => {
    ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValueOnce(null)
    const r = await refreshOpenServiceTransmissions(deps, A)
    expect(r).toMatchObject({ skipped: true, checked: 0 })
    expect(repo.listRefreshCandidates).not.toHaveBeenCalled()
    // D-F41: o comando do aluguel EMPRESTA uma conexão (espera curta na sessão) e a devolve — nenhuma fica retida
    expect(conn.release).toHaveBeenCalledTimes(pool.getConnection.mock.calls.length)
    expect(conn.query).toHaveBeenCalledWith('SET SESSION innodb_lock_wait_timeout = ?', [3])
    expect(fiscal.releaseRefreshLease).not.toHaveBeenCalled()             // não é dele
  })

  it('sem habilitação SE não há aluguel a tomar → 409 FISCAL_ISSUER_MISSING (nunca "outra passada em curso" — gate R2)', async () => {
    ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValueOnce(null)
    ;(fiscal.getIssuer as jest.Mock).mockResolvedValueOnce(null)
    await expect(refreshOpenServiceTransmissions(deps, A)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_MISSING' })
    expect(repo.listRefreshCandidates).not.toHaveBeenCalled()
  })

  it('D-F46: os ramos de quem pede descem até o SQL das candidatas (o filtro é antes do LIMIT, nunca em JS)', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([])
    await refreshOpenServiceTransmissions(deps, A, { minMinutes: 7, limit: 3, interfaces: ['service-orders'], liveOnlyInterfaces: ['orders'] })
    expect(repo.listRefreshCandidates).toHaveBeenCalledWith(pool, 'setes_setes', 1, 7, 10, 3, { authorizedMaxDays: 90, interfaces: ['service-orders'], liveOnlyInterfaces: ['orders'] })
  })

  it('consulta CADA candidata que o SQL devolveu (o filtro da vida vigente é do SQL) e devolve o aluguel no fim', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([
      tx({ invoiceId: 12, lifeEvent: 1, lastKind: 'A' }),
      tx({ invoiceId: 13, lifeEvent: 1, lastKind: 'A' }),
    ])
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: null })
    const r = await refreshOpenServiceTransmissions(deps, A, { minMinutes: 7, limit: 3 })
    expect(r).toMatchObject({ checked: 2, skipped: false })
    expect(repo.listRefreshCandidates).toHaveBeenCalledWith(pool, 'setes_setes', 1, 7, 10, 3, { authorizedMaxDays: 90 })   // D-F38: sem PAM = 60 + 30
    expect(fiscal.acquireRefreshLease).toHaveBeenCalledWith(conn, 1, 'SE', 210)        // pela conexão curta (D-F41)
    expect(fiscal.renewRefreshLease).toHaveBeenCalledTimes(2)                // renovado antes de CADA candidata (gates R4)
    expect(fiscal.releaseRefreshLease).toHaveBeenCalledWith(conn, 1, 'SE', '2026-10-04 12:01:00')   // devolve SÓ o próprio
  })

  it('D-F38 (gates R4): teto = max(PAM, 60) + 30 — leitura do convênio só ALARGA; implausível/lento/falha → padrão 60 + 30; o relatório diz a origem', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([])
    const run = async (pam: any) => {
      resetMunicipalTermsCache()
      ;(repo.listRefreshCandidates as jest.Mock).mockClear()
      adapter.municipalTerms.mockImplementationOnce(pam)
      const r = await refreshOpenServiceTransmissions(deps, A)
      return { teto: (repo.listRefreshCandidates as jest.Mock).mock.calls[0][6].authorizedMaxDays, r }
    }
    expect((await run(async () => ({ cancelDays: 120, raw: {} }))).teto).toBe(150)
    const curto = await run(async () => ({ cancelDays: 45, raw: {} }))
    expect([curto.teto, curto.r.ceilingSource]).toEqual([90, 'municipio'])             // nunca menor que o padrão
    const absurdo = await run(async () => ({ cancelDays: 20261231, raw: {} }))          // data lida como "dias" ([INCERTO])
    expect([absurdo.teto, absurdo.r.ceilingSource]).toEqual([90, 'padrao'])
    const falha = await run(async () => { throw new Error('convênio fora') })
    expect([falha.teto, falha.r.ceilingSource, falha.r.authorizedMaxDays]).toEqual([90, 'padrao', 90])
  })

  it('D-F38 (gates R4): convênio LENTO não segura a passada — no máximo CEILING_LOOKUP_TIMEOUT_MS e as candidatas são consultadas', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    try {
      resetMunicipalTermsCache()
      adapter.municipalTerms.mockImplementationOnce(() => new Promise(() => undefined))     // nunca responde
      ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ invoiceId: 12, lastKind: 'A' })])
      ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
      adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: null })
      const p = refreshOpenServiceTransmissions(deps, A, { budgetMs: 60_000 })
      await jest.advanceTimersByTimeAsync(CEILING_LOOKUP_TIMEOUT_MS + 10)
      const r = await p
      expect(r).toMatchObject({ checked: 1, ceilingSource: 'padrao', authorizedMaxDays: 90 })
    } finally {
      jest.useRealTimers()
    }
  })

  const dbErr = (code: string, errno: number) => Object.assign(new Error(code), { code, errno })

  it('[sessão 2026-10-04] aluguel com DEADLOCK (1213) ao tomar: reexecuta 1× (o InnoDB desfez o UPDATE) e a passada segue', async () => {
    ;(fiscal.acquireRefreshLease as jest.Mock).mockRejectedValueOnce(dbErr('ER_LOCK_DEADLOCK', 1213))
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([])
    const r = await refreshOpenServiceTransmissions(deps, A)
    expect(r).toMatchObject({ skipped: false, checked: 0 })
    expect(fiscal.acquireRefreshLease).toHaveBeenCalledTimes(2)
    expect(fiscal.releaseRefreshLease).toHaveBeenCalledWith(conn, 1, 'SE', '2026-10-04 12:01:00')
  })

  it('[sessão 2026-10-04] aluguel com contenção que SOBRA (deadlock de novo / lock wait) → 409 RESOURCE_BUSY, nunca o erro cru do banco; nada consultado', async () => {
    ;(fiscal.acquireRefreshLease as jest.Mock)
      .mockRejectedValueOnce(dbErr('ER_LOCK_DEADLOCK', 1213)).mockRejectedValueOnce(dbErr('ER_LOCK_DEADLOCK', 1213))
    await expect(refreshOpenServiceTransmissions(deps, A)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    ;(fiscal.acquireRefreshLease as jest.Mock).mockRejectedValueOnce(dbErr('ER_LOCK_WAIT_TIMEOUT', 1205))
    await expect(refreshOpenServiceTransmissions(deps, A)).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(fiscal.acquireRefreshLease).toHaveBeenCalledTimes(3)                       // lock wait NÃO reexecuta
    expect(repo.listRefreshCandidates).not.toHaveBeenCalled()
    expect(fiscal.releaseRefreshLease).not.toHaveBeenCalled()                         // nada tomado, nada devolvido
  })

  it('[sessão 2026-10-04] RENOVAR o aluguel sob contenção no meio da passada: para aqui (stoppedEarly), o relatório guarda o que já consultou e o aluguel é devolvido', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([
      tx({ invoiceId: 12, lifeEvent: 1, lastKind: 'A' }),
      tx({ invoiceId: 13, lifeEvent: 1, lastKind: 'A' }),
    ])
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: null })
    ;(fiscal.renewRefreshLease as jest.Mock)
      .mockResolvedValueOnce('2026-10-04 12:01:00').mockRejectedValueOnce(dbErr('ER_LOCK_WAIT_TIMEOUT', 1205))
    const r = await refreshOpenServiceTransmissions(deps, A)
    expect(r).toMatchObject({ checked: 1, stoppedEarly: true, skipped: false, errors: [] })
    expect(fiscal.releaseRefreshLease).toHaveBeenCalledWith(conn, 1, 'SE', '2026-10-04 12:01:00')
  })

  it('D-F39 (gates R4 + delta de 2026-10-04, F1/F2): sem aluguel, a passada confere a cerca pelo predicado COMPLETO (réplica viva/excluída ou lacuna (b)) → 409 FISCAL_CUTOVER_PENDING (nunca "skipped" nem "configure a habilitação")', async () => {
    ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValueOnce(null)
    ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValueOnce(true)
    ;(fiscal.getIssuer as jest.Mock).mockResolvedValueOnce(null)                          // ex.: réplica EXCLUÍDA
    await expect(refreshOpenServiceTransmissions(deps, A)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(fiscal.emissionStillInErp).toHaveBeenCalledWith(pool, 'setes_setes', 1)
  })

  it('D-F39 (gates R4): cancelar no fisco numa RÉPLICA recusa ANTES de qualquer voz (sem K/N na tentativa copiada)', async () => {
    ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValueOnce(true)               // réplica viva/excluída ou lacuna (b)
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    await expect(cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')).rejects.toMatchObject({ code: 'FISCAL_CUTOVER_PENDING' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(erpM.lockInvoice).not.toHaveBeenCalled()
  })

  it('erro do EMISSOR pára a passada; erro persistente da NOTA marca last_queried_at (não monopoliza o rodízio); aluguel devolvido mesmo assim', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([
      tx({ invoiceId: 20, attempt: 4, lastKind: 'A' }), tx({ invoiceId: 21, lastKind: 'A' }), tx({ invoiceId: 22, lastKind: 'A' }),
    ])
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (_q: any, _i: number, inv: number, attempt: number) => tx({ invoiceId: inv, attempt, lastKind: 'A' }))
    adapter.queryNfse
      .mockRejectedValueOnce(new HttpError(502, 'resposta ilegível', undefined, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'))
      .mockRejectedValueOnce(new HttpError(409, 'A1 vencido', undefined, 'FISCAL_CERT_EXPIRED'))
    const r = await refreshOpenServiceTransmissions(deps, A)
    expect(r).toMatchObject({ checked: 2, stoppedEarly: true })
    expect(r.errors.map(e => e.code)).toEqual(['FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 'FISCAL_CERT_EXPIRED'])
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(pool, 1, 20, 4)
    expect(repo.touchQueriedAt).toHaveBeenCalledTimes(1)
    expect(fiscal.releaseRefreshLease).toHaveBeenCalled()
  })
})

describe('tela "No fisco" — estado derivado + pendência derivada', () => {
  it('vigente por chave; voz C × nota E → localCancelPending; instantes na zona', async () => {
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({
      transmissions: [tx({ attempt: 1, lastKind: 'R', accessKey: null }), tx({ attempt: 2, lastKind: 'C' })],
      events: [{ attempt: 2, event: 1, kind: 'A', dh: '2026-09-21 13:15:30', createdAt: '2026-09-21 13:15:30' }],
    })
    const v = await getServiceFiscalView(deps, A, INVOICE)
    expect(v).toMatchObject({ state: 'cancelled', localCancelPending: true })
    expect(v.events[0].dh).toBe('2026-09-21 10:15:30')
  })
})

describe('Rodada 13 (D-F67/D-F68/D-F71/D-F76, Valdo 2026-10-10) — código do evento na voz C e a SUBSTITUIÇÃO (e105102)', () => {
  const SUBST_KEY = `${KEY.slice(0, -1)}9`
  const substEventXml = (substitute: string | null) =>
    `<evento versao="1.01"><infEvento Id="EVT${KEY}105102001"><dhProc>2026-10-10T18:43:04-03:00</dhProc><pedRegEvento><infPedReg>`
    + `<chNFSe>${KEY}</chNFSe><e105102><xDesc>Cancelamento de NFS-e por Substituição</xDesc><cMotivo>1</cMotivo><xMotivo>erro no valor</xMotivo>`
    + `${substitute ? `<chSubstituta>${substitute}</chSubstituta>` : ''}</e105102></infPedReg></pedRegEvento></infEvento></evento>`

  it('cancelar no fisco: a voz C do NOSSO pedido grava authorityCode 101101 (D-F68)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A', dhProc: '2026-08-15 13:00:00' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-22T09:00:00-03:00', protocol: 'EVT1', eventXml: '<evento/>', raw: {} })
    await cancelServiceInvoiceAtAuthority(deps, A, INVOICE, 'cliente desistiu do serviço')
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'C', source: 'P', authorityCode: '101101' }))
  })

  it('consulta lê o cancelamento: e105102 → authorityCode 105102 e localCancelPending FALSE (decisão humana — D-F64/D-F67); e101101 → true', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
      cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'erro no valor', eventCode: '105102' } })
    expect(await refreshServiceTransmission(deps, A, INVOICE, 'Q')).toMatchObject({ kind: 'C', localCancelPending: false })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId,
      expect.objectContaining({ kind: 'C', source: 'Q', authorityCode: '105102', message: expect.stringContaining('SUBSTITUIÇÃO (e105102)') }))
    ;(repo.insertTransmissionEvent as jest.Mock).mockClear()
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
      cancelled: { dhEvento: '2026-09-22T09:00:00-03:00', motive: 'x', eventCode: '101101' } })
    expect(await refreshServiceTransmission(deps, A, INVOICE, 'Q')).toMatchObject({ kind: 'C', localCancelPending: true })
    expect(repo.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, A.userId, expect.objectContaining({ kind: 'C', authorityCode: '101101' }))
  })

  it('transmitir com a vigente C de SUBSTITUIÇÃO → 409 FISCAL_NFSE_SUBSTITUTED mesmo com a nota MANTIDA (não-C no ERP) — nunca reenvia o mesmo DPS; C comum com a nota viva → FISCAL_EFFECT_PENDING', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastCode: '105102' }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_NFSE_SUBSTITUTED' })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastCode: '101101' }))
    await expect(transmitServiceInvoice(deps, A, INVOICE)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_EFFECT_PENDING' })
    expect(adapter.transmit).not.toHaveBeenCalled()
  })

  it('tela "No fisco": a vigente C de SUBSTITUIÇÃO traz `substitution` com a chave da SUBSTITUTA lida do XML do evento arquivado (D-F76); sem XML = null; sem pendência derivada', async () => {
    const current = tx({ attempt: 1, lastKind: 'C', lastCode: '105102', dhProc: '2026-10-10 21:43:04' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    let v = await getServiceFiscalView(deps, A, INVOICE)
    expect(v).toMatchObject({ state: 'cancelled', localCancelPending: false, substitution: { substituteAccessKey: null } })   // XML ausente
    deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, substEventXml(SUBST_KEY), new Date('2026-10-10T21:43:04Z'), 'H', 'America/Sao_Paulo')
    v = await getServiceFiscalView(deps, A, INVOICE)
    expect(v.substitution).toEqual({ substituteAccessKey: SUBST_KEY })
    // C comum: nenhuma substituição na tela
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ attempt: 1, lastKind: 'C', lastCode: '101101' })], events: [] })
    expect((await getServiceFiscalView(deps, A, INVOICE)).substitution).toBeNull()
  })
})
