/// <reference types="jest" />
// Borda HTTP da nfse-api: o MESMO login do produto (RS256 — D-F13), autorização de AÇÃO do RAMO e
// licença (D-F14), admin no emitente, envelope de erro da casa, CORS por lista (D-F9), health
// (§12.8-1) e a cerca CONTRATO × ROTAS (OpenAPI design-first — D-F8) e ERP × fonte de fatos (D-F10).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import * as tx from '../nfse/transmission'
import { createApp, loadOpenApi } from '../app'
import type { AppContext } from '../context'
import { emitterRoutes } from '../modules/emitter/emitter.routes'
import { nfseRoutes } from '../modules/nfse/nfse.routes'
import { refLike, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    emissionStillInErp: jest.fn(), anyEmissionStillInErp: jest.fn(),
    erp: { ...actual.erp, orderInterface: jest.fn(), userHasPrivilege: jest.fn(), institutionHasInterface: jest.fn(), assertInstitutionSchema: jest.fn() },
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
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-app-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const pool = { query: jest.fn(async () => [[{ x: 1 }]]), getConnection: jest.fn() } as any
const ctx = (over: Partial<AppContext> = {}): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: ['https://app.setesgestao.com.br'],
  checkIdentity: false, ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  erpM.orderInterface.mockResolvedValue('service-orders')
  erpM.userHasPrivilege.mockResolvedValue(false)
  erpM.institutionHasInterface.mockResolvedValue(true)        // ramo contratado por padrão; a negação é explícita onde se testa
  ;(fiscal.emissionStillInErp as unknown as jest.Mock).mockResolvedValue(false)   // D-F39: virada (o padrão dos testes)
  ;(fiscal.anyEmissionStillInErp as unknown as jest.Mock).mockResolvedValue(false) // o grão do estabelecimento (A1 — D-NE10)
  ;(tx.transmitServiceInvoice as jest.Mock).mockResolvedValue({ invoiceId: 10, attempt: 1, dpsId: 'D', accessKey: 'K', nfseNumber: '1', kind: 'A' })
  ;(tx.cancelServiceInvoiceAtAuthority as jest.Mock).mockResolvedValue({ invoiceId: 10, attempt: 1, atAuthority: true, transmissionEvent: 2, warnings: [], nextStep: 'apply-local-cancel' })
  ;(tx.getServiceFiscalView as jest.Mock).mockResolvedValue({ invoiceId: 10, state: 'none' })
})

describe('autenticação — JWT do produto (D-F13)', () => {
  it('sem token / HS256 forjado com a chave pública / expirado → 401 no envelope da casa', async () => {
    const app = createApp(ctx())
    expect((await request(app).post('/v1/nfse/invoices/10/transmit')).status).toBe(401)
    const forged = jwt.sign({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes' }, pubPem, { algorithm: 'HS256', keyid: 'k1' })
    const r = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${forged}`)
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ code: 'UNAUTHORIZED' })
    const old = jwt.sign({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes', exp: 1 }, privPem, { algorithm: 'RS256', keyid: 'k1' })
    expect((await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${old}`)).status).toBe(401)
    expect(tx.transmitServiceInvoice).not.toHaveBeenCalled()
  })

  it('identidade conferida no banco quando ligada (schema do token × institution)', async () => {
    erpM.assertInstitutionSchema.mockRejectedValueOnce(new fiscal.HttpError(401, 'Token não corresponde', undefined, 'INSTITUTION_MISMATCH'))
    const r = await request(createApp(ctx({ checkIdentity: true }))).get('/v1/nfse/invoices/10').set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('INSTITUTION_MISMATCH')
  })
})

describe('autorização de AÇÃO e licença (D-F13/D-F14)', () => {
  it('usuário SEM TRANSMITIR na interface do RAMO → 403 PRIVILEGE_REQUIRED; COM → 201 com o ator do token', async () => {
    const app = createApp(ctx())
    erpM.institutionHasInterface.mockResolvedValue(true)
    const no = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token()}`)
    expect(no.status).toBe(403)
    expect(no.body.code).toBe('PRIVILEGE_REQUIRED')
    expect(erpM.userHasPrivilege).toHaveBeenCalledWith(pool, 'setes_setes', 7, 'service-orders', fiscal.erp.PRIVILEGE_TRANSMITIR)
    erpM.userHasPrivilege.mockResolvedValue(true)
    const ok = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token()}`)
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual({ ok: true, data: expect.objectContaining({ kind: 'A' }) })
    expect(tx.transmitServiceInvoice).toHaveBeenCalledWith(expect.anything(), { schemaName: 'setes_setes', institutionId: 1, userId: 7 }, refLike(10))
  })

  it('D-F37: admin passa o PRIVILÉGIO, nunca a LICENÇA; leitura exige a interface CONTRATADA (Q-N32); cancelar exige CANCELAR', async () => {
    const app = createApp(ctx())
    expect((await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token({ role: 'admin' })}`)).status).toBe(201)
    expect(erpM.userHasPrivilege).not.toHaveBeenCalled()                             // admin: sem conferir privilégio
    erpM.institutionHasInterface.mockResolvedValue(false)
    for (const role of ['admin', 'user']) {
      const tr = await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token({ role })}`)
      expect([role, tr.status, tr.body.code]).toEqual([role, 403, 'INTERFACE_NOT_ALLOWED'])
      const view = await request(app).get('/v1/nfse/invoices/10').set('Authorization', `Bearer ${token({ role })}`)
      expect([role, view.status, view.body.code]).toEqual([role, 403, 'INTERFACE_NOT_ALLOWED'])
    }
    erpM.institutionHasInterface.mockResolvedValue(true)
    expect((await request(app).get('/v1/nfse/invoices/10').set('Authorization', `Bearer ${token()}`)).status).toBe(200)
    await request(app).post('/v1/nfse/invoices/10/cancel').set('Authorization', `Bearer ${token()}`).send({ reason: 'erro na emissão' })
    expect(erpM.userHasPrivilege).toHaveBeenLastCalledWith(pool, 'setes_setes', 7, 'service-orders', fiscal.erp.PRIVILEGE_CANCELAR)
  })

  it('licença também nas AÇÕES (gates da F1): privilégio antigo em ramo NÃO contratado → 403 INTERFACE_NOT_ALLOWED, nada executado', async () => {
    erpM.userHasPrivilege.mockResolvedValue(true)
    erpM.institutionHasInterface.mockResolvedValue(false)
    const app = createApp(ctx())
    for (const [p, body] of [['/v1/nfse/invoices/10/transmit', undefined], ['/v1/nfse/invoices/10/cancel', { reason: 'erro na emissão' }],
      ['/v1/nfse/invoices/10/refresh', undefined], ['/v1/nfse/invoices/10/reconfirm', undefined], ['/v1/nfse/refresh', {}]] as const) {
      const r = await request(app).post(p).set('Authorization', `Bearer ${token()}`).send(body as any)
      expect([p, r.status, r.body.code]).toEqual([p, 403, 'INTERFACE_NOT_ALLOWED'])
    }
    expect(tx.transmitServiceInvoice).not.toHaveBeenCalled()
    expect(tx.cancelServiceInvoiceAtAuthority).not.toHaveBeenCalled()
    expect(tx.refreshOpenServiceTransmissions).not.toHaveBeenCalled()
  })

  it('D-F46: a PASSADA só consulta os ramos em que quem pede pode agir (contratado + privilégio CONSULTAR — D-PV40); o resto não vai de carona', async () => {
    ;(tx.refreshOpenServiceTransmissions as jest.Mock).mockResolvedValue({ checked: 0, changed: 0, errors: [], stoppedEarly: false, skipped: false })
    const app = createApp(ctx())
    // contratados: service-orders e orders; o usuário só tem TRANSMITIR em service-orders
    erpM.institutionHasInterface.mockImplementation(async (_p: any, _s: string, _i: number, key: string) => key !== 'order-returns')
    erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, key: string) => key === 'service-orders')
    expect((await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).send({})).status).toBe(200)
    expect(tx.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), { schemaName: 'setes_setes', institutionId: 1, userId: 7 },
      expect.objectContaining({ terminal: WEB, interfaces: ['service-orders'], liveOnlyInterfaces: ['order-returns'] }))   // D-F47: cortado só com viva
    // admin passa o privilégio, nunca a licença (D-F37): todos os CONTRATADOS, o não contratado fica fora
    await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token({ role: 'admin' })}`).send({})
    expect(tx.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ terminal: WEB, interfaces: ['service-orders', 'orders'] }))
    // devolução contratada com privilégio entra (o MESMO domínio da rota por nota — erp.orderInterface)
    erpM.institutionHasInterface.mockResolvedValue(true)
    erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, key: string) => key === 'order-returns')
    await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).send({})
    expect(tx.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ terminal: WEB, interfaces: ['order-returns'] }))
    // contratado sem privilégio em nenhum → 403 PRIVILEGE_REQUIRED, passada não roda
    ;(tx.refreshOpenServiceTransmissions as jest.Mock).mockClear()
    erpM.userHasPrivilege.mockResolvedValue(false)
    const r = await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).send({})
    expect([r.status, r.body.code]).toEqual([403, 'PRIVILEGE_REQUIRED'])
    expect(tx.refreshOpenServiceTransmissions).not.toHaveBeenCalled()
  })

  it('emitente é ato do ADMIN → usuário comum 403 ADMIN_REQUIRED', async () => {
    const r = await request(createApp(ctx())).get('/v1/emitter').set('Authorization', `Bearer ${token()}`)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('ADMIN_REQUIRED')
  })
})

describe('CERCA DA VIRADA (D-F18/D-F39 — sem dual-write): estabelecimento ainda emitido pelo ERP só LÊ', () => {
  it('ações e escritas do emitente → 409 FISCAL_CUTOVER_PENDING antes de qualquer coisa; leituras seguem', async () => {
    ;(fiscal.emissionStillInErp as unknown as jest.Mock).mockImplementation(async (_q: any, _s: string, id: number) => id === 1)
    ;(fiscal.anyEmissionStillInErp as unknown as jest.Mock).mockImplementation(async (_q: any, _s: string, id: number) => id === 1)
    const app = createApp(ctx())
    const auth = { Authorization: `Bearer ${token({ role: 'admin' })}` }
    for (const [m, p, body] of [
      ['post', '/v1/nfse/invoices/10/transmit', undefined], ['post', '/v1/nfse/invoices/10/refresh', undefined],
      ['post', '/v1/nfse/invoices/10/reconfirm', undefined], ['post', '/v1/nfse/invoices/10/cancel', { reason: 'erro na emissão' }],
      ['post', '/v1/nfse/refresh', {}], ['put', '/v1/emitter/certificate', { pfxBase64: 'QUJD', password: '' }],
      ['delete', '/v1/emitter/certificate', undefined], ['put', '/v1/emitter/issuers/SE', { environment: 'H', serie: '1' }],
      ['delete', '/v1/emitter/issuers/SE', undefined],
    ] as const) {
      const r = await (request(app) as any)[m](p).set(auth).send(body)
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 409, 'FISCAL_CUTOVER_PENDING'])
    }
    expect(tx.transmitServiceInvoice).not.toHaveBeenCalled()
    expect(tx.cancelServiceInvoiceAtAuthority).not.toHaveBeenCalled()
    expect((await request(app).get('/v1/nfse/invoices/10').set(auth)).status).toBe(200)
    // outra institution não está na cerca
    expect((await request(app).post('/v1/nfse/invoices/10/transmit').set('Authorization', `Bearer ${token({ role: 'admin', institutionId: 2 })}`)).status).toBe(201)
  })

  it('D-F39: a cerca é FATO no banco — a variável antiga (FISCAL_LEGACY_INSTITUTIONS) definida impede o boot', () => {
    const { assertRetiredEnv } = jest.requireActual('../context')
    expect(() => assertRetiredEnv({ FISCAL_LEGACY_INSTITUTIONS: '1' })).toThrow(/APOSENTADA/)
    expect(() => assertRetiredEnv({})).not.toThrow()
  })
})

describe('pendentes do lote — PAGINADOS (regra da casa) e só dos ramos visíveis (D-F14)', () => {
  beforeEach(() => {
    ;(tx.listPending as jest.Mock).mockImplementation(async (_d: any, _a: any, _t: any, page: any) => ({ data: [{ invoiceId: 10 }], page: page.page, pageSize: page.pageSize, total: 41 }))
  })

  it('envelope { ok, data, page, pageSize, total }; default page 1 / pageSize 25; admin vê só os ramos CONTRATADOS (D-F37)', async () => {
    erpM.institutionHasInterface.mockImplementation(async (_p: any, _s: string, _i: number, key: string) => key === 'service-orders')
    const r = await request(createApp(ctx())).get('/v1/nfse/invoices/pending').set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect(r.body).toEqual({ ok: true, data: [{ invoiceId: 10 }], page: 1, pageSize: 25, total: 41 })
    expect(tx.listPending).toHaveBeenCalledWith(expect.anything(), { schemaName: 'setes_setes', institutionId: 1, userId: 7 }, WEB, { page: 1, pageSize: 25 }, ['service-orders'])
  })

  it('usuário comum: só os ramos CONTRATADOS chegam à consulta; nenhum contratado → lista vazia (não 403)', async () => {
    erpM.institutionHasInterface.mockImplementation(async (_p: any, _s: string, _i: number, key: string) => key === 'orders')
    const app = createApp(ctx())
    const r = await request(app).get('/v1/nfse/invoices/pending?page=2&pageSize=10').set('Authorization', `Bearer ${token()}`)
    expect(r.status).toBe(200)
    expect(tx.listPending).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), WEB, { page: 2, pageSize: 10 }, ['orders'])
    erpM.institutionHasInterface.mockResolvedValue(false)
    await request(app).get('/v1/nfse/invoices/pending').set('Authorization', `Bearer ${token()}`)
    expect(tx.listPending).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), WEB, { page: 1, pageSize: 25 }, [])
  })

  it('page/pageSize fora da faixa → 400 VALIDATION_FAILED', async () => {
    const app = createApp(ctx())
    for (const q of ['page=0', 'pageSize=0', 'pageSize=101', 'page=abc', 'pageSize=-5', 'pageSize=']) {
      const r = await request(app).get(`/v1/nfse/invoices/pending?${q}`).set('Authorization', `Bearer ${token({ role: 'admin' })}`)
      expect([q, r.status, r.body.code]).toEqual([q, 400, 'VALIDATION_FAILED'])
    }
  })
})

describe('entrada — validação e envelope', () => {
  it('invoiceId inválido → 400 INVALID_ID; cancel sem motivo → 400 VALIDATION_FAILED com fields; JSON malformado → 400', async () => {
    const app = createApp(ctx())
    const auth = { Authorization: `Bearer ${token({ role: 'admin' })}` }
    expect((await request(app).post('/v1/nfse/invoices/abc/transmit').set(auth)).body.code).toBe('INVALID_ID')
    const bad = await request(app).post('/v1/nfse/invoices/10/cancel').set(auth).send({})
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', fields: [expect.objectContaining({ field: 'reason' })] })
    const malformed = await request(app).post('/v1/nfse/invoices/10/cancel').set(auth).set('Content-Type', 'application/json').send('{"reason":')
    expect(malformed.status).toBe(400)
    const ok = await request(app).post('/v1/nfse/invoices/10/cancel').set(auth).send({ reason: 'erro na emissão' })
    expect(ok.body.data.nextStep).toBe('apply-local-cancel')
  })

  it('erro inesperado → 500 INTERNAL com ref; contenção → 409 RESOURCE_BUSY', async () => {
    const app = createApp(ctx())
    const auth = { Authorization: `Bearer ${token({ role: 'admin' })}` }
    ;(tx.transmitServiceInvoice as jest.Mock).mockRejectedValueOnce(new Error('boom'))
    const r = await request(app).post('/v1/nfse/invoices/10/transmit').set(auth)
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ code: 'INTERNAL', ref: expect.stringMatching(/^[0-9A-F]{8}$/) })
    ;(tx.transmitServiceInvoice as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' }))
    expect((await request(app).post('/v1/nfse/invoices/10/transmit').set(auth)).body.code).toBe('RESOURCE_BUSY')
  })
})

describe('CORS por lista (D-F9) e health (§12.8-1)', () => {
  it('origem da lista recebe os cabeçalhos; outra não; preflight 204', async () => {
    const app = createApp(ctx())
    const ok = await request(app).options('/v1/nfse/invoices/10/transmit').set('Origin', 'https://app.setesgestao.com.br')
    expect(ok.status).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.setesgestao.com.br')
    const evil = await request(app).options('/v1/nfse/invoices/10/transmit').set('Origin', 'https://evil.example')
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('health: banco + chave-mestra + storage → 200; sem chave-mestra → 503 dizendo qual', async () => {
    expect((await request(createApp(ctx())).get('/v1/health')).body).toEqual({ status: 'ok', db: true, masterKey: true, storage: true })
    const r = await request(createApp(ctx({ keyring: MasterKeyRing.of({}) }))).get('/v1/health')
    expect(r.status).toBe(503)
    expect(r.body).toMatchObject({ masterKey: false })
  })

  it('health: A1 cifrado com versão de chave-mestra que NÃO está no anel (rotação mal feita) → 503 masterKey false', async () => {
    const versions = (v: number[]) => ({ query: jest.fn(async (sql: string) => (/cipher_key_version/.test(sql) ? [v.map(x => ({ v: x }))] : [[{ x: 1 }]])), getConnection: jest.fn() } as any)
    expect((await request(createApp(ctx({ pool: versions([1]) }))).get('/v1/health')).status).toBe(200)
    const r = await request(createApp(ctx({ pool: versions([1, 2]) }))).get('/v1/health')
    expect([r.status, r.body.masterKey]).toEqual([503, false])
  })
})

describe('CERCA: contrato OpenAPI × rotas reais (design-first — D-F8)', () => {
  it('toda rota implementada está no YAML e todo path do YAML tem rota (método a método)', () => {
    const fromRouter = (prefix: string, router: any): string[] => router.stack.filter((l: any) => l.route).flatMap((l: any) =>
      Object.keys(l.route.methods).map(m => `${m.toUpperCase()} ${(prefix + (l.route.path === '/' ? '' : l.route.path)).replace(/:(\w+)/g, '{$1}')}`))
    const implemented = new Set([
      'GET /v1/health',
      ...fromRouter('/v1/emitter', emitterRoutes(ctx())),
      ...fromRouter('/v1/nfse', nfseRoutes(ctx())),
    ])
    const doc = loadOpenApi()
    const documented = new Set<string>()
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const m of Object.keys(ops)) if (['get', 'post', 'put', 'delete', 'patch'].includes(m)) documented.add(`${m.toUpperCase()} ${p}`)
    }
    expect([...implemented].filter(r => !documented.has(r))).toEqual([])
    expect([...documented].filter(r => !implemented.has(r))).toEqual([])
  })
})

describe('CERCA D-F31: o que a API fiscal ESCREVE no ERP é lista fechada (src/ E scripts/)', () => {
  it('a ÚNICA escrita de dado no ERP de todo o projeto é a aposentadoria da habilitação SE no ATO da virada (D-F44, scripts/cutover-erp.ts)', () => {
    const root = path.resolve(__dirname, '..', '..')
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
    // escrita em tabela QUALIFICADA pelo schema do cliente (\`${s}\`.) ou pelo central (setes_*.) — o fiscal_api é o banco da
    // conexão. Exceção nomeada: \`${SMOKE_DB}\` é o banco DESCARTÁVEL do smoke (fiscal_api_smoke* — o script recusa outro nome)
    const ERP_WRITE = /(INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:\\`\$\{(?!SMOKE_DB\})\w+\}\\`|`?setes_\w*`?)\./g
    const writes = [path.join(root, 'src'), path.join(root, 'scripts')].flatMap(files).flatMap(f => {
      const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      return (code.match(ERP_WRITE) ?? []).map(m => `${path.relative(root, f).replace(/\\/g, '/')}: ${m.replace(/\s+/g, ' ')}`)
    })
    expect(writes).toEqual(['scripts/cutover-erp.ts: UPDATE \\`${schema}\\`.'])
  })
})

describe('CERCA: tabela do ERP só na fonte de fatos (D-F10 / §12.8-1)', () => {
  it('nenhum tb_invoice / tb_order / tb_entity* fora de src/facts/ (as tabelas da FAMÍLIA no fiscal_api não contam)', () => {
    const srcRoot = path.resolve(__dirname, '..')
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' || d.name === 'migrations' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
    const ERP_TABLE = /\btb_(invoice|order|entity)(?!_id\b)(?!_service_(dps|transmission)\w*)\w*/
    const offenders = files(srcRoot)
      .filter(f => !f.includes(`${path.sep}facts${path.sep}`))
      .filter(f => ERP_TABLE.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
      .map(f => path.relative(srcRoot, f))
    expect(offenders).toEqual([])
  })
})
