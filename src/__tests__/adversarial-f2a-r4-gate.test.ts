/// <reference types="jest" />
// GATE ADVERSARIAL independente — lado da nfse-api do DELTA da Rodada 4 da F2a + Rodada 1 da F2b (2026-10-13; skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F136/D-F142/D-F145/D-F146). Alvo: 6a33982 —
// `src/cors-origins.ts` + `server.ts` (D-F146), `nfse.dto.ts`/`nfse.routes.ts` (`interfaceKey` — D-F145), `transmission.ts`
// (`currentAttempt` — D-F142); e a D-F136 (núcleo 24ab152) vista pelos leitores PRÓPRIOS da família (`mapTx`, cancelamento no fisco).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO F2AR4-ADV-NN SEV] …')`; barrado = `it('[RESISTIU] …')`. Só unitário (mocks na
// fronteira) — nenhum banco, nenhum fisco.
import { generateKeyPairSync, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { wireAccess } from './access-stub'
import * as repo from '../nfse/repository'
import * as txMod from '../nfse/transmission'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier, corsFor } from 'fiscal-api'
import { cancelServiceInvoiceAtAuthority, NfseDeps } from '../nfse/transmission'
import { createApp } from '../app'
import { contextFromEnv } from '../context'
import type { AppContext } from '../context'
import { assertCorsOrigins } from '../cors-origins'
import { withRecord } from './fixture-record'
import { webRef, WEB } from './fixture-ref'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openIssuer: jest.fn(actual.openIssuer),
    createFiscalPool: jest.fn(() => ({ query: jest.fn(), getConnection: jest.fn() })),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn(),
      orderInterface: jest.fn(), assertInstitutionSchema: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return { __esModule: true, ...actual, latestTransmission: jest.fn(), findTransmissionEventByKind: jest.fn(), insertTransmissionEvent: jest.fn() }
})

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const actualFiscal = jest.requireActual('fiscal-api')
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const licensedM = jest.fn()   // licença (interface contratada) — costura A1: o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const fM = fiscal as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r4-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const pool = { query: jest.fn(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: 0 }]] : [[]])), getConnection: jest.fn() } as any
const ctx = (corsOrigins: string[] = []): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins, checkIdentity: false,
})
const contracted = (...keys: string[]) => licensedM.mockImplementation(async (_p: any, _s: string, _i: number, k: string) => keys.includes(k))

beforeEach(() => {
  jest.clearAllMocks()
  fM.openIssuer.mockImplementation(actualFiscal.openIssuer)
})

// =================================================================================================
// 1. D-F145 — `interfaceKey` nas pendentes
// =================================================================================================
describe('1 — D-F145: interfaceKey hostil / duplicado / array nas pendentes', () => {
  let listPending: jest.SpyInstance
  beforeEach(() => { listPending = jest.spyOn(txMod, 'listPending').mockResolvedValue({ data: [], page: 1, pageSize: 25, total: 0 } as any) })
  afterEach(() => listPending.mockRestore())
  const get = (qs: string, claims: any = { role: 'admin' }) => request(createApp(ctx())).get(`/v1/nfse/invoices/pending${qs}`).set('Authorization', `Bearer ${token(claims)}`)

  it('[RESISTIU] repetido (mesmo valor ou dois ramos), [] / [0] / [chave], espaço, NUL, caixa, sublinhado, __proto__, ramo fora do domínio → 400 VALIDATION_FAILED, sem ler nada', async () => {
    contracted('service-orders', 'orders')
    for (const qs of ['?interfaceKey=orders&interfaceKey=orders', '?interfaceKey=orders&interfaceKey=service-orders', '?interfaceKey[]=orders',
      '?interfaceKey[0]=orders', '?interfaceKey[a]=orders', '?interfaceKey=%20orders', '?interfaceKey=orders%00', '?interfaceKey=Orders',
      '?interfaceKey=service_orders', '?interfaceKey=__proto__', '?interfaceKey=order-returns', '?interfaceKey=orders&page=1&page=2']) {
      const r = await get(qs)
      expect([qs, r.status, r.body.code]).toEqual([qs, 400, 'VALIDATION_FAILED'])
    }
    expect(listPending).not.toHaveBeenCalled()
  })

  it('[RESISTIU] o filtro fica DENTRO do visível: ramo pedido não contratado → lista vazia (nunca o ramo pedido de carona); sem token → 401; usuário comum vê só o contratado', async () => {
    contracted('orders')
    expect((await get('?interfaceKey=service-orders')).status).toBe(200)
    expect(listPending).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), WEB, { page: 1, pageSize: 25 }, [])
    await get('?interfaceKey=orders', { role: 'user' })
    expect(listPending).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), WEB, { page: 1, pageSize: 25 }, ['orders'])
    listPending.mockClear()
    const r = await request(createApp(ctx())).get('/v1/nfse/invoices/pending?interfaceKey=orders')
    expect(r.status).toBe(401); expect(listPending).not.toHaveBeenCalled()
  })
})

// =================================================================================================
// 2. D-F146 — CORS_ORIGINS no boot
// =================================================================================================
describe('2 — D-F146: o boot confere CORS_ORIGINS', () => {
  const envCtx = (raw: string | undefined) => contextFromEnv({ CORS_ORIGINS: raw } as any, {
    pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), verifier: ProductTokenVerifier.of({ k1: pubPem }), adapter: {} as any,
  })
  /** O navegador manda a ORIGEM serializada (RFC 6454): esquema/host em minúsculas, porta padrão omitida. */
  const browserForm = (o: string) => { try { return new URL(o).origin } catch { return null } }
  const preflight = async (allowed: string[], origin: string) =>
    (await request(createApp(ctx(allowed))).options('/v1/nfse/invoices/pending').set('Origin', origin)).headers['access-control-allow-origin']

  it('[RESISTIU] vazia, só vírgulas, ausente, "*", "null", barra final, caminho, espaço no meio, esquema estranho, IPv6 (sem forma aceita) → o boot RECUSA', () => {
    for (const raw of [undefined, '', ',', ' , ', '*', 'null', 'http://localhost:5051/', 'https://app.setes.com.br/app', 'http://local host:5051', 'ws://localhost:5051',
      'http://[::1]:5051', 'http://localhost:5051,*']) {
      expect(() => assertCorsOrigins(envCtx(raw).corsOrigins)).toThrow(/D-F146/)
    }
  })

  it('[RESISTIU] espaços em volta e itens vazios entre vírgulas são aparados; a origem do dev passa e o preflight do navegador recebe o Allow-Origin — outra origem não', async () => {
    const c = envCtx(' http://localhost:5051 , ,https://app.setes.com.br ')
    expect(assertCorsOrigins(c.corsOrigins)).toBe('http://localhost:5051, https://app.setes.com.br')
    expect(await preflight(c.corsOrigins, 'http://localhost:5051')).toBe('http://localhost:5051')
    expect(await preflight(c.corsOrigins, 'http://localhost:5052')).toBeUndefined()
    expect(await preflight(c.corsOrigins, 'http://evil.localhost:5051')).toBeUndefined()
  })

  it('[CORRIGIDO F2AR4-ADV-09 LOW] o boot ACEITA origens que nenhum navegador manda — maiúsculas (`HTTP://LOCALHOST:5051`), porta padrão explícita (`:80`/`:443` — o navegador a omite), porta impossível (`:99999`) — e o `corsFor` compara por igualdade exata: o app cai no "Failed to fetch" sem diagnóstico, exatamente o que a D-F146 quis matar no boot', async () => {
    const out: [string, boolean, string | undefined][] = []
    for (const o of ['HTTP://LOCALHOST:5051', 'http://localhost:80', 'https://app.setes.com.br:443', 'http://localhost:99999']) {
      let accepted = true
      try { assertCorsOrigins([o]) } catch { accepted = false }
      const sent = browserForm(o)
      const allowed = accepted && sent ? await preflight([o], sent) : undefined
      // CERTO: ou o boot recusa, ou o navegador (com a forma que ELE manda) recebe o Allow-Origin
      out.push([o, !accepted || allowed === sent, sent ?? undefined])
    }
    expect(out.filter(([, ok]) => !ok)).toEqual([])
  })

  it('[RESISTIU] a conferência roda no boot ANTES das migrations e do listen (estático)', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const at = server.indexOf('assertCorsOrigins(ctx.corsOrigins)')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(server.indexOf('await runMigrations('))
    expect(at).toBeLessThan(server.search(/\.listen\(/))
  })
})

// =================================================================================================
// 3. D-F136 nos leitores PRÓPRIOS da família (nfse-api): A sem registro nunca libera nada
// =================================================================================================
describe('3 — D-F136 vista pela nfse-api: autorizada SEM registro (sem chave)', () => {
  const INVOICE = 6500
  const conn = { beginTransaction: jest.fn(), query: jest.fn(async () => [[]]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const p = { query: jest.fn(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: 0 }]] : [[]])), getConnection: jest.fn(async () => conn) } as any
  const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
  const deps: NfseDeps = { pool: p, keyring: MasterKeyRing.of({ 1: Buffer.alloc(32, 8) }), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
  const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990009 }
  const tx = (over: any = {}) => withRecord({
    institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 45, dpsId: 'DPS' + '5'.repeat(42),
    accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-10-10 13:00:00', ageMinutes: 60, lastQueriedAt: null, nfseNotGeneratedAt: null,
    lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: null, lastEventAt: null, lastEventAgeMinutes: 60, ...over,
  })

  it('[CORRIGIDO F2AR4-SOC-06] `mapTx` RECUSA A sem registro (D-F136 nos dois leitores — antes aceitava: registro ⇔ chave bastava) — e o cancelamento no FISCO recusa ANTES do K e do A1: 409 FISCAL_TRANSMISSION_IN_PROGRESS, nada gravado, fisco não chamado', async () => {
    expect(() => repo.mapTx({ ...tx(), authorityRecorded: 'N' })).toThrow(/D-F136/)
    erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
    erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
    repoM.latestTransmission.mockResolvedValue(tx())
    const out = await cancelServiceInvoiceAtAuthority(deps, ACTOR, webRef(ACTOR, INVOICE), 'adversarial r4').then(r => r, (e: any) => [e.statusCode, e.code])
    expect(out).toEqual([409, 'FISCAL_TRANSMISSION_IN_PROGRESS'])
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(adapter.registerEvent).not.toHaveBeenCalled()
    expect(fM.openIssuer).not.toHaveBeenCalled()
  })

  it('[RESISTIU — analisado] a reserva de NOVA transmissão barra a última tentativa autorizada pela LETRA (`isAuthorized`), com ou sem chave — o A sem registro não reabre o envio', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'nfse', 'transmission.ts'), 'utf8')
    expect(src).toMatch(/if \(latest && \(isLiveTransmission\(latest\) \|\| isAuthorized\(latest\)\)\) throw liveTransmissionError\(latest\)/)
  })
})
