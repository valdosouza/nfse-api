/// <reference types="jest" />
// DEPLOY.E2.P1.T2 — D-F238 (executa a reserva da D-F166, Valdo 2026-11-15): a contenção na gravação DEPOIS do fisco sai com o código
// próprio FISCAL_OUTCOME_NOT_RECORDED (resultado incerto — "consulte a nota antes de repetir"); RESOURCE_BUSY fica só ANTES do fisco
// ("tente de novo"). Sem banco: a trava da nota é a costura `erp.lockInvoice` do núcleo, dublada.
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import { FsFiscalStorage, MasterKeyRing, HttpError, ErrorCodes } from 'fiscal-api'
import { withRecord } from './fixture-record'
import * as repo from '../nfse/repository'
import { refreshServiceTransmission, cancelServiceInvoiceAtAuthority, outcomeNotRecorded, resetMunicipalTermsCache, NfseDeps } from '../nfse/transmission'
import { NfseErrorCodes } from '../nfse/error-codes'
import { WEB } from './fixture-ref'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  const erpFns = Object.fromEntries(Object.entries(actual.erp).map(([k, v]) => [k, typeof v === 'function' ? jest.fn(v as any) : v]))
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    emissionStillInErp: jest.fn(async () => false),
    erp: erpFns,
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? jest.fn(v as any) : v]))
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-df238-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(async () => [[]]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(async () => [[]]), getConnection: jest.fn(async () => conn) } as any
const fakeAdapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: fakeAdapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990003 }
const INVOICE = 6238
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000042'
const KEY = ('4106902' + '2' + CNPJ + '0'.repeat(50)).slice(0, 50)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}"><nNFSe>42</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`
const REF = { institutionId: 1, invoiceId: INVOICE, terminal: WEB }

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '42', dhProc: '2026-10-04 13:00:00', createdAt: '2026-10-04 12:55:00', ageMinutes: 30, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 30, ...over,
})
const lockWait = () => Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
const busy = () => new HttpError(409, 'Nota ocupada', undefined, ErrorCodes.RESOURCE_BUSY)

beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.invoiceLife.mockResolvedValue({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null },
    cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: { cnpj: CNPJ, expired: false, notYetValid: false },
  })
  repoM.getTransmission.mockResolvedValue(tx())
  repoM.latestTransmission.mockResolvedValue(tx())
  repoM.findTransmissionByDpsId.mockResolvedValue(null)
  repoM.touchQueriedAt.mockResolvedValue(null)
  fakeAdapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-10-04T10:00:00-03:00' })
})

describe('D-F238 — a peça: só a CONTENÇÃO vira "resposta do fisco não gravada"', () => {
  it.each([
    ['409 RESOURCE_BUSY do núcleo', busy()],
    ['lock wait cru (1205)', lockWait()],
    ['deadlock cru (1213)', deadlock()],
  ])('%s → 409 FISCAL_OUTCOME_NOT_RECORDED, com a frase do resultado incerto', (_label, err) => {
    const out = outcomeNotRecorded(err, 'teste') as HttpError
    expect(out).toBeInstanceOf(HttpError)
    expect([out.statusCode, out.code]).toEqual([409, NfseErrorCodes.FISCAL_OUTCOME_NOT_RECORDED])
    expect(out.message).toMatch(/resultado incerto: consulte a nota antes de repetir/)
  })

  it.each([
    ['recusa do fisco (422)', new HttpError(422, 'DPS rejeitado', undefined, ErrorCodes.FISCAL_DPS_REJECTED)],
    ['ambíguo do fisco (502)', new HttpError(502, 'Fisco ambíguo', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)],
    ['erro técnico', new Error('ECONNRESET')],
  ])('%s passa como veio (não é contenção)', (_label, err) => {
    expect(outcomeNotRecorded(err, 'teste')).toBe(err)
  })
})

describe('D-F238 — a consulta (refresh) e o cancelamento no fisco: DEPOIS do fisco a contenção é FISCAL_OUTCOME_NOT_RECORDED', () => {
  it('consulta: o fisco respondeu e a trava da nota estoura (1205) → 409 FISCAL_OUTCOME_NOT_RECORDED; o fisco FOI chamado', async () => {
    erpM.lockInvoice.mockRejectedValue(lockWait())
    const err = await refreshServiceTransmission(deps, ACTOR, REF, 'Q').catch(e => e)
    expect(fakeAdapter.queryNfse).toHaveBeenCalledTimes(1)
    expect([err.statusCode, err.code]).toEqual([409, 'FISCAL_OUTCOME_NOT_RECORDED'])
  })

  it('cancelamento: a trava da DECISÃO (antes do fisco) estoura → segue RESOURCE_BUSY ("tente de novo") e o fisco NÃO é chamado', async () => {
    erpM.lockInvoice.mockRejectedValue(lockWait())
    const err = await cancelServiceInvoiceAtAuthority(deps, ACTOR, REF, 'Erro na emissão').catch(e => e)
    expect(fakeAdapter.registerEvent).not.toHaveBeenCalled()
    // a contenção ANTES do fisco sobe como veio e a borda a responde 409 RESOURCE_BUSY (`contentionToHttpError`, a regra da casa)
    expect(err.code).not.toBe('FISCAL_OUTCOME_NOT_RECORDED')
    expect(fiscal.contentionToHttpError(err)?.code).toBe('RESOURCE_BUSY')
  })
})
