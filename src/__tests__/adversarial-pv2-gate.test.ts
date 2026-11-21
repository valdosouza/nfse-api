/// <reference types="jest" />
// GATE testar-adversarial da onda da D-PV2 — lado nfse-api (A-PV1/A-PV11, 2026-10-18 — prompt_privilegios_interfaces.md §11).
// Alvo: a peça `licensed` de `src/modules/guards.ts` (o super passa a LICENÇA) — caminho fiscal de PRODUÇÃO.
// Ataques: super FALSO (role super fora da Setes), grafias do papel, institutionId string, a cerca da virada para o super,
// a passada do rodízio e a lista de pendentes pela borda HTTP real (JWT RS256 → guarda → composição dublê).
// Convenção: `[RESISTIU]` = a sonda tentou quebrar e o código aguentou.
import { generateKeyPairSync, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { wireAccess, live } from './access-stub'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import * as tx from '../nfse/transmission'
import { createApp } from '../app'
import type { AppContext } from '../context'
import {
  requireBranchPrivilege, requireBranchInterface, requireAnyInterface, visibleInterfaces, passScope, requireCutover,
} from '../modules/guards'
import { webRef } from './fixture-ref'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    emissionStillInErp: jest.fn(), anyEmissionStillInErp: jest.fn(),
    erp: { ...actual.erp, orderInterface: jest.fn(), assertInstitutionSchema: jest.fn() },
  }
})
jest.mock('../nfse/transmission', () => {
  const actual = jest.requireActual('../nfse/transmission')
  return {
    __esModule: true, ...actual,
    transmitServiceInvoice: jest.fn(), refreshServiceTransmission: jest.fn(), cancelServiceInvoiceAtAuthority: jest.fn(),
    reconfirmBeforeLocalCancel: jest.fn(), getServiceFiscalView: jest.fn(), readNfseXml: jest.fn(), listPending: jest.fn(),
    refreshOpenServiceTransmissions: jest.fn(),
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const licensedM = jest.fn()   // licença (interface contratada) — costura A1: o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const stillInErp = fiscal.emissionStillInErp as unknown as jest.Mock
const anyStillInErp = fiscal.anyEmissionStillInErp as unknown as jest.Mock
const KEYS = ['service-orders', 'orders', 'order-returns']
const gctx = { pool: {} } as unknown as AppContext
const outcome = (p: Promise<unknown>) => p.then(r => ['ok', r], (e: any) => [e.statusCode, e.code])

const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' } as any
const FORGED_ROLES = [
  { institutionId: 2, userId: 5, role: 'super', schemaName: 'setes_x' },     // super fora da Setes
  { institutionId: 1, userId: 5, role: 'Super', schemaName: 'setes_setes' },
  { institutionId: 1, userId: 5, role: 'SUPER', schemaName: 'setes_setes' },
  { institutionId: 1, userId: 5, role: 'super ', schemaName: 'setes_setes' },
  { institutionId: '1', userId: 5, role: 'super', schemaName: 'setes_setes' }, // id como texto
] as any[]

// borda HTTP real
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
// Núcleo 3.0.0+ (D-AU19, DEPLOY.E1.P4): o verificador DESCARTA o `role` do token — com `live(claims)` os "papéis forjados" daqui passam a
// ser o perfil VIVO forjado (grafia, institution, id como texto); a prova de que o `role` do TOKEN nunca concede (nem o escape A-PV1) é
// do `auth-e2-p2-token-contract.test.ts`
const token = (claims: any) => jwt.sign(live(claims), privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-pv2-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))
const pool = { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any
const httpCtx = (): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: ['https://app.setesgestao.com.br'],
  checkIdentity: true,
})

beforeEach(() => {
  jest.clearAllMocks()
  erpM.orderInterface.mockResolvedValue('service-orders')
  licensedM.mockResolvedValue(false)          // NADA contratado
  grantedM.mockResolvedValue(false)
  stillInErp.mockResolvedValue(false); anyStillInErp.mockResolvedValue(false)
  ;(tx.transmitServiceInvoice as jest.Mock).mockResolvedValue({ invoiceId: 10, attempt: 1, kind: 'A' })
  ;(tx.listPending as jest.Mock).mockResolvedValue({ data: [], page: 1, pageSize: 25, total: 0 })
  ;(tx.refreshOpenServiceTransmissions as jest.Mock).mockResolvedValue({ checked: 0, changed: 0, errors: [], stoppedEarly: false, skipped: false })
})

describe('[RESISTIU] super FALSO / papel forjado não herda a A-PV1 nas guardas', () => {
  it.each(FORGED_ROLES.map(p => [JSON.stringify(p), p]))('%s: nada contratado → 403 INTERFACE_NOT_ALLOWED em toda guarda', async (_n, who) => {
    const ref = webRef({ institutionId: 1 }, 77)
    grantedM.mockResolvedValue(true)                 // nem o vínculo antigo salva: a licença barra
    expect(await outcome(requireBranchPrivilege(gctx, who, ref, 'TRANSMITIR'))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(await outcome(requireBranchInterface(gctx, who, ref))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(await outcome(requireAnyInterface(gctx, who, KEYS))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(await visibleInterfaces(gctx, who, KEYS)).toEqual([])
    expect(await outcome(passScope(gctx, who, KEYS, 'TRANSMITIR'))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(licensedM).toHaveBeenCalled()          // a licença foi de fato consultada
  })

  it('super FALSO com o ramo contratado e SEM vínculo → 403 PRIVILEGE_REQUIRED (não vira admin)', async () => {
    licensedM.mockResolvedValue(true)
    const ref = webRef({ institutionId: 2 }, 77)
    expect(await outcome(requireBranchPrivilege(gctx, FORGED_ROLES[0], ref, 'TRANSMITIR'))).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })
})

describe('[RESISTIU] a cerca da virada não é licença: barra o super nos DOIS grãos', () => {
  it('modelo SE e estabelecimento (A1) ainda no ERP → 409 FISCAL_CUTOVER_PENDING para o super', async () => {
    stillInErp.mockResolvedValue(true)
    expect(await outcome(requireCutover(gctx, SUPER, 'SE'))).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
    stillInErp.mockResolvedValue(false); anyStillInErp.mockResolvedValue(true)
    expect(await outcome(requireCutover(gctx, SUPER, 'establishment'))).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
  })

  it('pela borda HTTP: o super NÃO transmite/cancela/consulta antes da virada — e a composição nem é chamada', async () => {
    stillInErp.mockResolvedValue(true)
    const app = createApp(httpCtx())
    const auth = `Bearer ${token(SUPER)}`
    for (const [p, body] of [['/v1/nfse/invoices/10/transmit', undefined], ['/v1/nfse/invoices/10/cancel', { reason: 'erro na emissão' }],
      ['/v1/nfse/invoices/10/refresh', undefined], ['/v1/nfse/invoices/10/reconfirm', undefined], ['/v1/nfse/refresh', {}]] as const) {
      const r = await request(app).post(p).set('Authorization', auth).send(body as any)
      expect([p, r.status, r.body.code]).toEqual([p, 409, 'FISCAL_CUTOVER_PENDING'])
    }
    expect(tx.transmitServiceInvoice).not.toHaveBeenCalled()
    expect(tx.cancelServiceInvoiceAtAuthority).not.toHaveBeenCalled()
    expect(tx.refreshOpenServiceTransmissions).not.toHaveBeenCalled()
  })
})

describe('[RESISTIU] borda HTTP: A-PV1 só para o super legítimo', () => {
  it('ramo NÃO contratado: super transmite (A-PV1); super FALSO e admin → 403, nada executado', async () => {
    const app = createApp(httpCtx())
    const ok = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token(SUPER)}`)
    expect(ok.status).toBe(201)
    expect(tx.transmitServiceInvoice).toHaveBeenCalledTimes(1)
    for (const claims of [FORGED_ROLES[0], FORGED_ROLES[1], { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' }]) {
      const r = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token(claims)}`)
      expect([JSON.stringify(claims), r.status]).toEqual([JSON.stringify(claims), r.status === 401 ? 401 : 403])
    }
    expect(tx.transmitServiceInvoice).toHaveBeenCalledTimes(1)
  })

  it('pendentes: o filtro de ramo fora da lista (order-returns, __proto__, ramo inventado) não alarga a visão do super', async () => {
    const app = createApp(httpCtx())
    const auth = `Bearer ${token(SUPER)}`
    for (const k of ['order-returns', '__proto__', 'customers', 'orders,service-orders']) {
      const r = await request(app).get(`/v1/nfse/invoices/pending?interfaceKey=${encodeURIComponent(k)}`).set('Authorization', auth)
      expect([k, r.status]).toEqual([k, 400])                          // enum fechado no DTO
    }
    await request(app).get('/v1/nfse/invoices/pending').set('Authorization', auth)
    expect((tx.listPending as jest.Mock).mock.calls.at(-1)![4]).toEqual(['service-orders', 'orders'])
    // super FALSO: nada contratado → lista vazia (nunca a do super)
    await request(app).get('/v1/nfse/invoices/pending').set('Authorization', `Bearer ${token(FORGED_ROLES[0])}`)
    expect((tx.listPending as jest.Mock).mock.calls.at(-1)![4]).toEqual([])
  })

  it('passada do rodízio: super = os 3 ramos em [interfaces] e nenhum "só vivas"; super FALSO → 403', async () => {
    const app = createApp(httpCtx())
    expect((await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token(SUPER)}`).send({})).status).toBe(200)
    expect(tx.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ interfaces: KEYS, liveOnlyInterfaces: [] }))
    const r = await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token(FORGED_ROLES[0])}`).send({})
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(tx.refreshOpenServiceTransmissions).toHaveBeenCalledTimes(1)
  })
})
