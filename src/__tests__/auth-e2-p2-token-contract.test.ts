/// <reference types="jest" />
// nfse-api:AUTH.E2.P2 (absorvido pelo DEPLOY.E1.P4 — núcleo 4.0.0, que traz a 3.0.0; D-AU3, D-AU16, D-AU19, `Vault/prompts/
// prompt_frente_auth_api.md` §5): a nfse-api aceita o token da auth-api SEM `role` e o do setes-api COM `role` (tolerado e IGNORADO);
// admin/super só do PERFIL VIVO (`access.liveIdentity`), lido pelas GUARDAS (`requireAdmin`, `src/modules/guards.ts`). A prova é contra
// o VETOR DE CONTRATO publicado pela auth-api (`auth-api/contract/token-vector.json` — par de chaves SÓ DE TESTE), com o `kid` dela pela
// lista `JWT_PUBLIC_KEYS` (D-AU16), pela borda HTTP REAL da nfse-api. Vetor não achado = REPROVA (cerca que some calada não prova nada).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import { wireAccess } from './access-stub'
import { WORKSPACE } from './voice-kind-fence'
import * as emitter from '../modules/emitter/emitter.service'
import * as tx from '../nfse/transmission'
import { createApp } from '../app'
import type { AppContext } from '../context'

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
jest.mock('../modules/emitter/emitter.service', () => ({ __esModule: true, ...jest.requireActual('../modules/emitter/emitter.service'), fetchEmitter: jest.fn() }))
jest.mock('../nfse/transmission', () => ({ __esModule: true, ...jest.requireActual('../nfse/transmission'), transmitServiceInvoice: jest.fn() }))

const AUTH_API_DIR = path.resolve(process.env.AUTH_API_DIR ?? path.join(WORKSPACE, 'auth-api'))
const VECTOR_PATH = path.join(AUTH_API_DIR, 'contract', 'token-vector.json')
if (!fs.existsSync(VECTOR_PATH)) {
  throw new Error(`AUTH.E2.P2: o vetor de contrato da auth-api não está em ${VECTOR_PATH} — clone a auth-api ao lado da nfse-api ou aponte AUTH_API_DIR`)
}
const vector = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8')) as {
  alg: string; kid: string; publicKeyPem: string
  claims: { institutionId: number; userId: number; schemaName: string }
  cases: Record<'final_sem_role' | 'final_com_role_legado' | 'selecao' | 'final_sem_iat', { token: string }>
}

const live = fiscal.access.liveIdentity as unknown as jest.Mock
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const licensedM = jest.fn()
const grantedM = jest.fn()
wireAccess(fiscal.access, licensedM, grantedM)
const pool = { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any
let tmp: string
let app: ReturnType<typeof createApp>

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-auth-e2p2-'))
  fs.writeFileSync(path.join(tmp, 'auth-api.pem'), vector.publicKeyPem)
  const ctx: AppContext = {
    db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
    pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(tmp), adapter: {} as any, fiscalDb: 'fiscal_api',
    verifier: ProductTokenVerifier.fromEnv({ JWT_PUBLIC_KEYS: `${vector.kid}=${path.join(tmp, 'auth-api.pem')}` } as NodeJS.ProcessEnv),
    corsOrigins: [], checkIdentity: true,
  }
  app = createApp(ctx)
})
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** O perfil VIVO do usuário do vetor — o que a sessão viva diz, nunca o token. */
const liveProfile = (role: string) => live.mockImplementation(async (_q: unknown, p: any) => ({ ...p, role }))

beforeEach(() => {
  jest.clearAllMocks()
  erpM.orderInterface.mockResolvedValue('service-orders')
  licensedM.mockResolvedValue(true)
  grantedM.mockResolvedValue(false)
  ;(fiscal.emissionStillInErp as unknown as jest.Mock).mockResolvedValue(false)
  ;(fiscal.anyEmissionStillInErp as unknown as jest.Mock).mockResolvedValue(false)
  ;(emitter.fetchEmitter as jest.Mock).mockResolvedValue({ issuers: [] })
  ;(tx.transmitServiceInvoice as jest.Mock).mockResolvedValue({ invoiceId: 10, attempt: 1, dpsId: 'D', accessKey: 'K', nfseNumber: '1', kind: 'A' })
})

const bearer = (c: keyof typeof vector.cases) => ({ Authorization: `Bearer ${vector.cases[c].token}` })

describe('vetor de contrato da auth-api (D-AU19) pela borda da nfse-api — admin só do perfil VIVO, pelas guardas', () => {
  it('o vetor é o RS256 com o kid de TESTE', () => {
    expect([vector.alg, vector.kid]).toEqual(['RS256', 'auth-api-contract-test'])
  })

  it.each(['final_sem_role', 'final_com_role_legado'] as const)('%s → ACEITO; a sessão viva recebe a identidade do token SEM perfil', async c => {
    liveProfile('user')
    const r = await request(app).get('/v1/emitter').set(bearer(c))
    expect(r.status).not.toBe(401)
    expect(live).toHaveBeenCalledWith(pool, expect.objectContaining({ ...vector.claims, role: '' }), expect.any(Number))
  })

  it('final_com_role_legado (o token diz "super") com perfil vivo comum → requireAdmin 403 ADMIN_REQUIRED (o role do token nunca concede)', async () => {
    liveProfile('user')
    const r = await request(app).get('/v1/emitter').set(bearer('final_com_role_legado'))
    expect([r.status, r.body.code]).toEqual([403, 'ADMIN_REQUIRED'])
    expect(emitter.fetchEmitter).not.toHaveBeenCalled()
  })

  it.each(['final_sem_role', 'final_com_role_legado'] as const)('%s com perfil vivo ADMIN → passa o requireAdmin (200)', async c => {
    liveProfile('admin')
    const r = await request(app).get('/v1/emitter').set(bearer(c))
    expect(r.status).toBe(200)
    expect(emitter.fetchEmitter).toHaveBeenCalledTimes(1)
  })

  it('o privilégio do RAMO também segue o perfil vivo: comum sem concessão 403 PRIVILEGE_REQUIRED; admin vivo transmite (201)', async () => {
    liveProfile('user')
    const denied = await request(app).post('/v1/nfse/invoices/10/transmit').set(bearer('final_com_role_legado'))
    expect([denied.status, denied.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    liveProfile('admin')
    expect((await request(app).post('/v1/nfse/invoices/10/transmit').set(bearer('final_sem_role'))).status).toBe(201)
  })

  it('final_com_role_legado ("super" na institution 1) com perfil vivo comum e ramo NÃO contratado → 403 INTERFACE_NOT_ALLOWED (o escape de licença do super — A-PV1 — nunca vem do token)', async () => {
    liveProfile('user')
    licensedM.mockResolvedValue(false)
    const r = await request(app).post('/v1/nfse/invoices/10/transmit').set(bearer('final_com_role_legado'))
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(tx.transmitServiceInvoice).not.toHaveBeenCalled()
  })

  it.each(['selecao', 'final_sem_iat'] as const)('%s → 401, sem ler a sessão viva', async c => {
    const r = await request(app).get('/v1/emitter').set(bearer(c))
    expect(r.status).toBe(401)
    expect(live).not.toHaveBeenCalled()
  })
})
