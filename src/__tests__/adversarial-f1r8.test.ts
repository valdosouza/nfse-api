/// <reference types="jest" />
// GATE ADVERSARIAL r8 — delta da RODADA 6 (D-F41…D-F45) + retrabalho §17.1/17.2 + D-F46 (testar-adversarial.md §4-6, 2026-10-04).
// Achado CONFIRMADO = `it.failing('[r8-…]')` (PASSA enquanto o bug existe; quando a correção entrar, vira `it`), com um
// `it` de CENÁRIO ao lado (se o cenário não se monta, falha de verdade). Ataque que o código RESISTIU = `it` normal.
// Só unitário (mocks na fronteira) — nenhum banco, nenhum fisco.
//
// Achados deste arquivo:
//  - [MEDIUM — r8-cancel-idem — CORRIGIDO 2026-10-04: o openIssuer travante foi para logo antes do K] o retrabalho do §17.2 (a decisão do cancelamento abre o emissor TRAVANDO antes do K) pôs o
//    `openIssuer` ANTES das saídas que não falam com o fisco: com o A1 ausente/vencido (ou a habilitação excluída), o
//    "já cancelada no fisco" (200 atAuthority=false, idempotente — contrato) e o "nunca transmitida" (409
//    FISCAL_NOT_AUTHORIZED, "cancele direto no ERP") viram 409 FISCAL_CERT_* — o app (que só avança no 200) fica sem o
//    passo para o setes-api até renovar um A1 que nem é usado;
//  - [LOW — r8-resync-55 — CORRIGIDO 2026-10-04: leitura não travante antes do `continue`] a re-sincronia (`migrate:setes` sem `--cutover`) só olha institution com SE no ERP: uma réplica
//    de OUTRO modelo (versão anterior do script) numa institution SEM SE no ERP nunca dispara a "falha alta com a instrução
//    de DELETE" da D-F42 — e trava a institution (cerca = "réplica em qualquer linha") sem saída pelo `--cutover`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import * as txMod from '../nfse/transmission'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { cancelServiceInvoiceAtAuthority, NfseDeps } from '../nfse/transmission'
import { createApp } from '../app'
import type { AppContext } from '../context'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openIssuer: jest.fn(actual.openIssuer),
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn(),
      orderInterface: jest.fn(), userHasPrivilege: jest.fn(), institutionHasInterface: jest.fn(), assertInstitutionSchema: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getTransmission: jest.fn(), latestTransmission: jest.fn(), findTransmissionEventByKind: jest.fn(), insertTransmissionEvent: jest.fn(),
  }
})

const actualFiscal = jest.requireActual('fiscal-api')
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const fM = fiscal as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r8-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

beforeEach(() => {
  jest.clearAllMocks()
  fM.openIssuer.mockImplementation(actualFiscal.openIssuer)
})

// ===========================================================================
// 1. Cancelamento no fisco — a decisão abre o emissor TRAVANDO (retrabalho §17.2)
// ===========================================================================
describe('[MEDIUM — r8-cancel-idem] a decisão do cancelamento abre o A1 ANTES das saídas que não falam com o fisco', () => {
  const INVOICE = 6400
  const KEY = '4106902207742094000113' + '0'.repeat(28)
  const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
  const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
  const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({ 1: Buffer.alloc(32, 8) }), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
  const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990008 }
  const tx = (over: any = {}) => ({
    institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 44, dpsId: 'DPS' + '4'.repeat(42),
    accessKey: KEY, nfseNumber: '44', dhProc: '2026-09-30 13:00:00', createdAt: '2026-09-30 13:00:00', ageMinutes: 6000, lastQueriedAt: null,
    lastEvent: 3, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 6000, ...over,
  })

  beforeEach(() => {
    // virada: 1 linha, 0 réplica (emissionStillInErp = falso — a cerca não interfere)
    pool.query.mockImplementation(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: 0 }]] : [[]]))
    // habilitação SE viva e VIRADA; o A1 foi APAGADO depois do C (a guarda do DELETE deixa: C é voz FINAL)
    conn.query.mockImplementation(async (sql: string) => {
      if (/FROM tb_establishment_issuer/.test(sql)) return [[{ institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 12:00:00' }]]
      if (/FROM tb_establishment_certificate/.test(sql)) return [[]]
      return [[]]
    })
    erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })   // C local ainda NÃO aplicado
    erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    repoM.findTransmissionEventByKind.mockResolvedValue({ attempt: 1, event: 3, kind: 'C' })
    repoM.insertTransmissionEvent.mockResolvedValue(9)
  })
  const run = () => cancelServiceInvoiceAtAuthority(deps, ACTOR, INVOICE, 'cancelamento adversarial r8').then(r => r, (e: any) => [e.statusCode, e.code])

  it('cenário: com o emissor ABRINDO, o retry depois da voz C é idempotente (200 atAuthority=false → o app segue ao setes-api)', async () => {
    repoM.latestTransmission.mockResolvedValue(tx({ lastKind: 'C' }))
    fM.openIssuer.mockResolvedValue({ issuer: { model: 'SE', cutoverAt: 'x' } })
    expect(await run()).toMatchObject({ atAuthority: false, transmissionEvent: 3, nextStep: 'apply-local-cancel' })
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  // [corrigido 2026-10-04] a conferência do A1 sob a trava foi para logo ANTES do K (depois das saídas C/R/F/sem tentativa)
  it('[r8-cancel-idem][corrigido] voz C já gravada + A1 ausente → o retry continua idempotente (200 atAuthority=false), A1 nem aberto', async () => {
    repoM.latestTransmission.mockResolvedValue(tx({ lastKind: 'C' }))
    expect(await run()).toMatchObject({ atAuthority: false, transmissionEvent: 3, nextStep: 'apply-local-cancel' })
    expect(fM.openIssuer).not.toHaveBeenCalled()
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
  })

  it('[r8-cancel-idem][corrigido] nota NUNCA transmitida + A1 ausente → 409 FISCAL_NOT_AUTHORIZED (cancele direto no ERP)', async () => {
    repoM.latestTransmission.mockResolvedValue(null)
    expect(await run()).toEqual([409, 'FISCAL_NOT_AUTHORIZED'])
    expect(fM.openIssuer).not.toHaveBeenCalled()
  })

  it('resistiu: AUTORIZADA + A1 ausente → 409 FISCAL_CERT_MISSING ANTES do K (nenhum K vivo sem A1 — o objetivo do §17.2)', async () => {
    repoM.latestTransmission.mockResolvedValue(tx({ lastKind: 'A' }))
    expect(await run()).toEqual([409, 'FISCAL_CERT_MISSING'])
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(conn.commit).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// 2. D-F46 — ramo não contratado = bloqueio total (borda HTTP)
// ===========================================================================
describe('D-F46 — ataques à borda: ramo não contratado, admin, lista vazia, corpo estranho, outros caminhos', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
  // pool da borda: a cerca (issuerRowsState) diz VIRADA — o resto não chega ao banco (as peças do serviço são espiadas)
  const pool = { query: jest.fn(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: 0 }]] : [[]])), getConnection: jest.fn() } as any
  const ctx = (): AppContext => ({
    db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
    pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
    fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: false,
  })
  const NAMES = ['refreshOpenServiceTransmissions', 'transmitServiceInvoice', 'refreshServiceTransmission', 'reconfirmBeforeLocalCancel',
    'cancelServiceInvoiceAtAuthority', 'getServiceFiscalView', 'readNfseXml', 'listPending'] as const
  let spies: Record<string, jest.SpyInstance>
  beforeEach(() => {
    spies = {}
    for (const n of NAMES) spies[n] = jest.spyOn(txMod, n as any).mockResolvedValue({ ok: 'spy', data: [], total: 0 } as any)
    spies.refreshOpenServiceTransmissions.mockResolvedValue({ checked: 0, changed: 0, errors: [], stoppedEarly: false, skipped: false } as any)
    erpM.orderInterface.mockResolvedValue('orders')
    erpM.userHasPrivilege.mockResolvedValue(false)
    erpM.institutionHasInterface.mockResolvedValue(true)
  })
  afterEach(() => { for (const s of Object.values(spies)) s.mockRestore() })
  const contracted = (...keys: string[]) => erpM.institutionHasInterface.mockImplementation(async (_p: any, _s: string, _i: number, k: string) => keys.includes(k))
  const privileged = (...keys: string[]) => erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, k: string) => keys.includes(k))

  it('corpo com `interfaces` (e __proto__) forjado NÃO alarga a passada: os ramos vêm só da guarda; minMinutes/limit seguem validados', async () => {
    contracted('service-orders', 'orders'); privileged('service-orders')
    const app = createApp(ctx())
    const raw = '{"minMinutes":5,"interfaces":["service-orders","orders","order-returns"],"__proto__":{"interfaces":["orders"]}}'
    const r = await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).set('Content-Type', 'application/json').send(raw)
    expect(r.status).toBe(200)
    expect(spies.refreshOpenServiceTransmissions).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      { minMinutes: 5, limit: undefined, interfaces: ['service-orders'], liveOnlyInterfaces: ['order-returns'] })   // D-F47: o cortado só com viva
    for (const body of [[], { limit: 51 }, { minMinutes: 0 }, { minMinutes: '5' }]) {
      const b = await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).send(body as any)
      expect([JSON.stringify(body), b.status, b.body.code]).toEqual([JSON.stringify(body), 400, 'VALIDATION_FAILED'])
    }
  })

  it('admin com SÓ a devolução contratada → a passada leva só ["order-returns"] (os cortados só com viva); nada contratado → D-F47: admin fecha só as VIVAS dos cortados; usuário comum 403', async () => {
    const app = createApp(ctx())
    const admin = { Authorization: `Bearer ${token({ role: 'admin' })}` }
    contracted('order-returns')
    expect((await request(app).post('/v1/nfse/refresh').set(admin).send({})).status).toBe(200)
    expect(spies.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ interfaces: ['order-returns'], liveOnlyInterfaces: ['service-orders', 'orders'] }))
    contracted()
    expect((await request(app).post('/v1/nfse/refresh').set(admin).send({})).status).toBe(200)
    expect(spies.refreshOpenServiceTransmissions).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ interfaces: [], liveOnlyInterfaces: ['service-orders', 'orders', 'order-returns'] }))
    spies.refreshOpenServiceTransmissions.mockClear()
    const r = await request(app).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).send({})
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    expect(spies.refreshOpenServiceTransmissions).not.toHaveBeenCalled()
  })

  it('usuário com privilégio em service-orders e nota de "orders" (contratado, sem privilégio) → TODA ação por nota 403; leitura passa (Q-N32)', async () => {
    contracted('service-orders', 'orders'); privileged('service-orders')
    erpM.orderInterface.mockResolvedValue('orders')
    const app = createApp(ctx())
    const auth = { Authorization: `Bearer ${token()}` }
    for (const p of ['transmit', 'refresh', 'reconfirm', 'cancel']) {
      const r = await request(app).post(`/v1/nfse/invoices/10/${p}`).set(auth).send({ reason: 'x' })
      expect([p, r.status, r.body.code]).toEqual([p, 403, 'PRIVILEGE_REQUIRED'])
    }
    expect((await request(app).get('/v1/nfse/invoices/10').set(auth)).status).toBe(200)
  })

  it('ramo da nota NÃO contratado (admin incluído; nota sem linha na view = "orders") → 403 INTERFACE_NOT_ALLOWED em leitura, XML, DANFSe e ações', async () => {
    contracted('service-orders')                                       // "orders" não contratado
    erpM.orderInterface.mockResolvedValue('orders')                    // o default de nota sem linha na view
    const app = createApp(ctx())
    const auth = { Authorization: `Bearer ${token({ role: 'admin' })}` }
    const calls: [string, string][] = [['get', ''], ['get', '/xml'], ['get', '/danfse'], ['post', '/transmit'], ['post', '/refresh'], ['post', '/reconfirm'], ['post', '/cancel']]
    for (const [m, p] of calls) {
      const r = await (request(app) as any)[m](`/v1/nfse/invoices/10${p}`).set(auth).send(m === 'post' ? { reason: 'x' } : undefined)
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'INTERFACE_NOT_ALLOWED'])
    }
    for (const n of NAMES) expect([n, spies[n].mock.calls.length]).toEqual([n, 0])
  })

  it('pendentes: nada contratado → lista VAZIA sem consultar o banco (a lista vazia nunca vira "sem filtro")', async () => {
    contracted()
    spies.listPending.mockRestore()
    const app = createApp(ctx())
    pool.query.mockClear()
    const r = await request(app).get('/v1/nfse/invoices/pending').set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect([r.status, r.body.data, r.body.total]).toEqual([200, [], 0])
    expect(pool.query.mock.calls.filter((c: any[]) => /vw_order_interface|tb_invoice/.test(String(c[0])))).toHaveLength(0)
  })

  it('nota sem linha na view: a rota por nota (erp.orderInterface) e o SQL das candidatas (COALESCE) dão o MESMO "orders"', async () => {
    const q = (rows: any[]) => ({ query: jest.fn(async () => [rows]) }) as any
    expect(await actualFiscal.erp.orderInterface(q([]), 'setes_setes', 1, 10)).toBe('orders')
    expect(await actualFiscal.erp.orderInterface(q([{ k: null }]), 'setes_setes', 1, 10)).toBe('orders')
    expect(await actualFiscal.erp.orderInterface(q([{ k: 'service-orders' }]), 'setes_setes', 1, 10)).toBe('service-orders')
    const calls: any[] = []
    await (jest.requireActual('../nfse/repository') as typeof repo).listRefreshCandidates(
      { query: async (sql: string, p: any[]) => { calls.push([sql, p]); return [[]] } } as any, 'setes_setes', 1, 5, 10, 8, { interfaces: ['orders'] })
    expect(calls[0][0]).toMatch(/COALESCE\(oi\.interface_key, 'orders'\) IN \(\?\)/)
    expect(calls[0][1]).toContainEqual(['orders'])
  })
})

// ===========================================================================
// 3. Scripts da migração/virada (D-F42/D-F44) — o script INTEIRO roda com pool falso (nenhum banco)
// ===========================================================================
describe('scripts: migrate:setes --cutover / re-sincronia (D-F42/D-F44)', () => {
  type Handler = (sql: string, p: any[]) => any
  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)

  async function runScript(argv: string[], handler: Handler) {
    const sqls: string[] = []
    const conn: any = {
      beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
      query: jest.fn(async (sql: string, p: any[] = []) => {
        sqls.push(sql.replace(/\s+/g, ' ').trim())
        const out = handler(sql, p)
        if (out instanceof Error) throw out
        if (out !== undefined) return out
        return isWrite(sql) ? [{ affectedRows: 0 }] : [[]]
      }),
    }
    let ended!: () => void
    const done = new Promise<void>(r => { ended = r })
    const pool: any = { query: conn.query, getConnection: jest.fn(async () => conn), end: jest.fn(async () => ended()) }
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    const errors: string[] = [], logs: string[] = []
    const err = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.map(String).join(' ')) })
    const log = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')) })
    const prevArgv = process.argv
    process.env.SETES_SECRETS_PATH = path.join(storageRoot, 'sem-cofre')
    process.argv = ['node', 'migrate-from-setes-api.ts', ...argv]
    try {
      jest.isolateModules(() => {
        const f = require('fiscal-api')
        f.createFiscalPool.mockReturnValue(pool)
        jest.spyOn(f.MasterKeyRing, 'fromEnv').mockReturnValue(f.MasterKeyRing.of({ 1: Buffer.alloc(32, 3) }))
        require('../../scripts/migrate-from-setes-api')
      })
      await done
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    } finally {
      process.argv = prevArgv
    }
    const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, conn, pool, sqls }
    exit.mockRestore(); err.mockRestore(); log.mockRestore()
    return res
  }

  /** ERP com a SE viva (série [erpSerie]) e o fiscal_api com [apiRows]; [retire] decide o UPDATE no ERP. */
  const cutoverDb = (o: { erpSerie?: string; apiRows?: any[]; retire?: () => any; f2a?: boolean } = {}): Handler => {
    let turned = false
    return (sql) => {
      if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
      if (/FROM `setes_x`\._migrations WHERE name = \?/.test(sql)) return o.f2a === false ? [[]] : [[{ x: 1 }]]   // D-F50
      if (/dps_last_number AS n FROM `setes_x`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) return [[{ model: 'SE', serie: o.erpSerie ?? '1', deleted: 'N', n: 10 }]]
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [o.apiRows ?? [{ model: 'SE', c: null }]]
      if (/information_schema\.tables/.test(sql)) return [[{ x: 1 }]]
      if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \?$/.test(sql.trim())) {
        return [[{ tb_institution_id: 1, model: 'SE', environment: 'P', serie: o.erpSerie ?? '1', dps_last_number: 10, tb_user_id: null, created_at: null, updated_at: null, deleted: 'N' }]]
      }
      if (/invoice_event IS NULL/.test(sql)) return [[{ n: 0 }]]
      if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(sql)) return [[{ m: 0 }]]
      if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: turned ? 0 : 1 }]]
      if (/^\s*UPDATE tb_establishment_issuer SET cutover_at/.test(sql)) { turned = true; return [{ affectedRows: 1 }] }
      if (/UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(sql)) return o.retire ? o.retire() : [{ affectedRows: 1 }]
      return undefined
    }
  }
  const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']

  it('resistiu: `--dry-run` executa o ATO inteiro (inclusive a aposentadoria no ERP) e DESFAZ — nenhum commit', async () => {
    const r = await runScript([...CUT, '--dry-run'], cutoverDb())
    expect(r.exitCode).toBeNull()
    expect(r.conn.commit).not.toHaveBeenCalled()
    expect(r.conn.rollback).toHaveBeenCalled()
    expect(r.sqls.some(s => /^UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(s))).toBe(true)
    const out = JSON.parse(r.logs.join('\n'))
    expect(out).toMatchObject({ dryRun: true, committed: false, cutover: { linhasViradas: 1, habilitacaoErpAposentada: 1 } })
  })

  it('resistiu: a trava da SE do ERP é o 1º comando da transação, pela PK com o MODELO como parâmetro (a 55 do faturamento fica livre)', async () => {
    const r = await runScript([...CUT, '--dry-run'], cutoverDb())
    const begin = r.conn.beginTransaction.mock.invocationCallOrder[0]
    const first = r.conn.query.mock.invocationCallOrder.find((o: number) => o > begin)
    const idx = r.conn.query.mock.invocationCallOrder.indexOf(first)
    expect(r.conn.query.mock.calls[idx][0]).toMatch(/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \? FOR UPDATE/)
    expect(r.conn.query.mock.calls[idx][1]).toEqual([1, 'SE'])
    expect(r.sqls.filter(s => /setes_x`\.tb_establishment_issuer SET/.test(s))).toEqual([expect.stringMatching(/model = \? AND deleted = 'N'$/)])
  })

  it('resistiu: série da NOTA SE ≠ "1" → falha ALTA antes de QUALQUER escrita (fiscal_api ou ERP)', async () => {
    const r = await runScript([...CUT], cutoverDb({ erpSerie: '2' }))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/série da NOTA SE do ERP é '2'/)
    expect(r.sqls.filter(isWrite)).toEqual([])
    expect(r.conn.commit).not.toHaveBeenCalled()
  })

  it('resistiu: réplica de OUTRO modelo no fiscal_api → falha ALTA com a instrução de DELETE físico, nada escrito', async () => {
    const r = await runScript([...CUT], cutoverDb({ apiRows: [{ model: 'SE', c: null }, { model: '55', c: null }] }))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/réplica do ERP de modelo 55 .*DELETE FROM tb_establishment_issuer WHERE tb_institution_id = 1 AND model IN \('55'\) AND cutover_at IS NULL/)
    expect(r.sqls.filter(isWrite)).toEqual([])
  })

  it('resistiu: credencial SEM UPDATE no ERP (o usuário fiscal_api) → o UPDATE é negado e o ATO inteiro volta (cutover_at não comita)', async () => {
    const denied = Object.assign(new Error("UPDATE command denied to user 'fiscal_api'"), { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 })
    const r = await runScript([...CUT], cutoverDb({ retire: () => denied }))
    expect(r.exitCode).toBe(1)
    expect(r.conn.commit).not.toHaveBeenCalled()
    expect(r.conn.rollback).toHaveBeenCalled()
  })

  // D-F50 (= Q-F59 (a), Valdo 2026-10-04): a virada exige a F2a do setes-api aplicada no schema do cliente
  it('[D-F50] sem a migration da F2a no _migrations do cliente → a virada REAL recusa antes de abrir a transação (nada escrito)', async () => {
    const r = await runScript(CUT, cutoverDb({ f2a: false }))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/F2a do setes-api não está aplicada.*f2a_fiscal_passivo.*D-F50/)
    expect(r.conn.beginTransaction).not.toHaveBeenCalled()
    expect(r.sqls.some(q => /^(INSERT|UPDATE|DELETE)/i.test(q))).toBe(false)
  })

  it('[D-F50] no --dry-run a ausência da F2a vira BLOQUEIO no relatório e o ensaio segue (e desfaz)', async () => {
    const r = await runScript([...CUT, '--dry-run'], cutoverDb({ f2a: false }))
    expect(r.exitCode).toBeNull()
    expect(r.logs.join(' ')).toMatch(/"bloqueios"[\s\S]*D-F50: a virada REAL seria recusada/)
    expect(r.conn.commit).not.toHaveBeenCalled()
    expect(r.conn.rollback).toHaveBeenCalled()
  })

  it('resistiu: `--cutover` sem `--confirmo-setes-api-parado` → recusa antes de abrir conexão', async () => {
    const r = await runScript(['--cutover', '1'], cutoverDb())
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/exige --confirmo-setes-api-parado/)
    expect(r.pool.getConnection).not.toHaveBeenCalled()
  })

  // institution 2: o ERP NÃO tem SE (só a 55 do faturamento); o fiscal_api tem uma RÉPLICA 55 deixada por versão anterior
  const strandedDb: Handler = (sql) => {
    if (/SELECT id, schema_name AS schemaName FROM setes_central\.tb_institution WHERE deleted = 'N'/.test(sql)) return [[{ id: 2, schemaName: 'setes_y' }]]
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_y' }]]
    if (/FROM `setes_y`\._migrations WHERE name = \?/.test(sql)) return [[{ x: 1 }]]                       // D-F50: F2a aplicada
    if (/SELECT 1 AS x FROM `setes_y`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = 'SE'/.test(sql)) return [[]]
    if (/FROM `setes_y`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) return [[]]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [[{ model: '55', c: null }]]
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: 1 }]]
    return undefined
  }

  // D-F48 (= Q-F58 (a), Valdo 2026-10-04): re-sincronia com UMA transação POR institution — a que falha volta sozinha
  it('[D-F48] a institution que falha volta SOZINHA; a seguinte é gravada; o script sai ≠ 0 listando a que falhou', async () => {
    const twoDb: Handler = (sql, p) => {
      if (/SELECT id, schema_name AS schemaName FROM setes_central\.tb_institution WHERE deleted = 'N'/.test(sql)) return [[{ id: 2, schemaName: 'setes_y' }, { id: 3, schemaName: 'setes_z' }]]
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [p[0] === 2 ? [{ model: '55', c: null }] : []]
      return strandedDb(sql, p)
    }
    const r = await runScript([], twoDb)
    expect(r.conn.beginTransaction).toHaveBeenCalledTimes(2)                 // uma por institution
    expect(r.conn.rollback).toHaveBeenCalledTimes(1)                         // só a 2 (réplica 55) voltou
    expect(r.conn.commit).toHaveBeenCalledTimes(1)                           // a 3 foi gravada
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/1 institution\(s\) com falha — nada delas gravado; as demais foram gravadas: setes_y: o fiscal_api tem réplica do ERP de modelo 55/)
    expect(r.logs.join(' ')).toMatch(/"failures"/)
  })

  it('cenário r8-resync-55: a institution fica TRAVADA (cerca = réplica em qualquer linha) e o `--cutover` não tem saída ("nada a virar")', async () => {
    const q = { query: jest.fn(async (sql: string, p: any[]) => strandedDb(sql, p) ?? [[]]) }
    expect(await actualFiscal.emissionStillInErp(q, 'setes_y', 2)).toBe(true)
    const r = await runScript(['--cutover', '2', '--confirmo-setes-api-parado'], strandedDb)
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/não tem habilitação SE — nada a virar/)
  })

  // [corrigido 2026-10-04] a institution sem SE no ERP passa por uma leitura NÃO travante das linhas do fiscal_api antes do
  // `continue` — a réplica de outro modelo falha alto com a instrução de DELETE físico (D-F42)
  it('[r8-resync-55][corrigido] re-sincronia acusa a réplica 55 da institution SEM SE no ERP (falha alta com a instrução de DELETE)', async () => {
    const r = await runScript([], strandedDb)
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/réplica do ERP de modelo 55/)
  })
})
