/// <reference types="jest" />
// CRED.E1.P1 (D-NE221…D-NE226, ficha `projetos/nfse-api/SUBJECT/CRED/ficha-cred-e1-p1-rota-credenciais.md`): a nfse-api mantém a credencial
// fiscal do FORNECEDOR por UF (o CSRT do PR) pela peça do núcleo 4.1.0 — só o super com vínculo à Setes; o VALOR é só de escrita (nunca em
// resposta, erro ou log) — e o boot dela sobe SEM o CSRT (é por ela que ele é cadastrado).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { MasterKeyRing, ProductTokenVerifier, FsFiscalStorage } from 'fiscal-api'
import { wireAccess, live } from './access-stub'
import { createApp, loadOpenApi } from '../app'
import type { AppContext } from '../context'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    saveProviderFiscalCredential: jest.fn(), endProviderFiscalCredential: jest.fn(), listProviderFiscalCredentials: jest.fn(),
  }
})

const actual = jest.requireActual('fiscal-api') as typeof fiscal
const saveM = fiscal.saveProviderFiscalCredential as unknown as jest.Mock
const endM = fiscal.endProviderFiscalCredential as unknown as jest.Mock
const listM = fiscal.listProviderFiscalCredentials as unknown as jest.Mock
const loggerM = fiscal.logger as unknown as Record<'info' | 'warn' | 'error', jest.Mock>
wireAccess(fiscal.access, jest.fn(async () => true), jest.fn(async () => false))

const SRC = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p)
    return /\.ts$/.test(e.name) ? [p] : []
  })
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: { institutionId: number; userId: number; role: string }) =>
  jwt.sign(live({ schemaName: 'setes_setes', ...claims }), privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const SUPER = { institutionId: 1, userId: 7, role: 'super' }
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-cred-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

// conexão de mentira: o `withTransaction` REAL do núcleo roda (begin/commit/rollback/release)
const conn = { query: jest.fn(), beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn() }
const pool = { query: jest.fn(async () => [[]]), getConnection: jest.fn(async () => conn) } as any
const ctx = (): AppContext => ({
  db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
  fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: ['https://app.setesgestao.com.br'],
  checkIdentity: true,
})

const MARK = 'CSRT-MARCADOR-9f3c2a7e'                                 // valor FICTÍCIO — nunca um CSRT real em teste
const body = (over: Record<string, unknown> = {}) => ({
  state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '03', codeValue: MARK, validFrom: '2026-11-22T03:00:00Z', ...over,
})
const KEY = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', validFrom: '2026-11-22T03:00:00Z' }
const ROW = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '03', validFrom: '2026-11-22 03:00:00', validUntil: null, userId: 7 }

let consoleSpies: jest.SpyInstance[] = []
beforeEach(() => {
  jest.clearAllMocks()
  saveM.mockResolvedValue(ROW)
  endM.mockResolvedValue(true)
  listM.mockResolvedValue([ROW])
  consoleSpies = (['log', 'warn', 'error'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => consoleSpies.forEach(s => s.mockRestore()))

/** O marcador não saiu em lugar nenhum: resposta, logger dublado e o console (o logger interno do núcleo escreve por ele). */
function expectNoValueLeak(res: request.Response): void {
  expect(JSON.stringify(res.body)).not.toContain(MARK)
  expect(res.text).not.toContain(MARK)
  for (const m of Object.values(loggerM)) expect(JSON.stringify(m.mock.calls)).not.toContain(MARK)
  for (const s of consoleSpies) expect(JSON.stringify(s.mock.calls)).not.toContain(MARK)
}

describe('CRED.E1.P1.T2 — o boot da nfse-api não depende do CSRT', () => {
  it('o boot confere o domínio da 006 depois das migrations e NÃO exige a credencial do fornecedor', () => {
    const server = read('server.ts')
    expect(server.indexOf('await assertFiscalCodeDomainsEnforced(ctx.pool)')).toBeGreaterThan(server.indexOf('await runMigrations('))
    expect(server).not.toMatch(/assertRequiredProviderCodesPresent|requiredFiscalCredentialsFor/)
  })
  it('nenhum arquivo de src/ (fora dos testes) chama a exigência do CSRT', () => {
    const offenders = sourceFiles(SRC).filter(f => /assertRequiredProviderCodesPresent/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
  })
})

describe('CRED.E1.P1.T1 — quem pode: só o super com vínculo à Setes (D-NE224)', () => {
  const routes: [string, string, unknown][] = [
    ['get', '/v1/provider/fiscal-credentials', undefined],
    ['post', '/v1/provider/fiscal-credentials', body()],
    ['post', '/v1/provider/fiscal-credentials/end', KEY],
  ]
  it.each(routes)('1 · sem token → 401 (%s %s)', async (m, url, b) => {
    const r = await (request(createApp(ctx())) as any)[m](url).send(b)
    expect(r.status).toBe(401)
  })
  const notSuper: [string, { institutionId: number; userId: number; role: string }][] = [
    ['admin da Setes', { institutionId: 1, userId: 8, role: 'admin' }],
    ['super de outra institution', { institutionId: 2, userId: 9, role: 'super' }],
    ['usuário comum da Setes', { institutionId: 1, userId: 10, role: 'user' }],
  ]
  for (const [who, claims] of notSuper) {
    it.each(routes)(`2 · ${who} → 403 VENDOR_SUPER_REQUIRED, peça não chamada (%s %s)`, async (m, url, b) => {
      const r = await (request(createApp(ctx())) as any)[m](url).set('Authorization', `Bearer ${token(claims)}`).send(b)
      expect([r.status, r.body.code]).toEqual([403, 'VENDOR_SUPER_REQUIRED'])
      expect(saveM).not.toHaveBeenCalled(); expect(endM).not.toHaveBeenCalled(); expect(listM).not.toHaveBeenCalled()
      expectNoValueLeak(r)
    })
  }
  it('sem a sessão viva (checkIdentity desligado) o perfil é vazio → 403 mesmo com o role super no token (falha fechada)', async () => {
    const r = await request(createApp({ ...ctx(), checkIdentity: false })).get('/v1/provider/fiscal-credentials')
      .set('Authorization', `Bearer ${token(SUPER)}`)
    expect([r.status, r.body.code]).toEqual([403, 'VENDOR_SUPER_REQUIRED'])
  })
})

describe('CRED.E1.P1.T1 — gravar, listar e encerrar; o valor só de escrita', () => {
  const auth = () => ({ Authorization: `Bearer ${token(SUPER)}` })

  it('3 · POST válido → 201 em transação; a peça recebe o autor do token e os instantes como Date; a resposta sem o valor, em ISO Z', async () => {
    const r = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body())
    expect(r.status).toBe(201)
    expect(saveM).toHaveBeenCalledTimes(1)
    const [q, input] = saveM.mock.calls[0]
    expect(q).toBe(conn)                                                // dentro do withTransaction (INSERT + encerra a anterior atômicos)
    expect(conn.beginTransaction).toHaveBeenCalled(); expect(conn.commit).toHaveBeenCalled(); expect(conn.release).toHaveBeenCalled()
    expect(input).toEqual({ state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '03', codeValue: MARK,
      validFrom: new Date('2026-11-22T03:00:00Z'), validUntil: null, userId: 7 })
    expect(r.body).toEqual({ ok: true, data: { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '03',
      validFrom: '2026-11-22T03:00:00Z', validUntil: null, userId: 7 } })
    expect(loggerM.info).toHaveBeenCalledWith('Credencial fiscal do fornecedor gravada', expect.objectContaining({ codeId: '03', userId: 7 }))
    expectNoValueLeak(r)
  })

  it('4 · GET → 200 só com id, vigência e autor — nenhum codeValue mesmo se a peça o devolvesse', async () => {
    listM.mockResolvedValue([{ ...ROW, codeValue: MARK, validUntil: '2026-12-01 03:00:00' }])
    const r = await request(createApp(ctx())).get('/v1/provider/fiscal-credentials').set(auth())
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual([{ state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '03',
      validFrom: '2026-11-22T03:00:00Z', validUntil: '2026-12-01T03:00:00Z', userId: 7 }])
    expectNoValueLeak(r)
  })

  it('5 · FiscalCodeInvalidError da peça → 400 FISCAL_CODE_INVALID com o CAMPO, sem o valor; a transação desfeita', async () => {
    saveM.mockRejectedValue(new actual.FiscalCodeInvalidError('codeId', 'fora da forma do tipo CSRT'))
    const r = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body({ codeId: '3' }))
    expect([r.status, r.body.code, r.body.fields?.[0]?.field]).toEqual([400, 'FISCAL_CODE_INVALID', 'codeId'])
    expect(conn.rollback).toHaveBeenCalled(); expect(conn.commit).not.toHaveBeenCalled()
    expectNoValueLeak(r)
  })

  it('6 · FiscalCodeConflictError → 409 FISCAL_CODE_CONFLICT', async () => {
    saveM.mockRejectedValue(new actual.FiscalCodeConflictError())
    const r = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body())
    expect([r.status, r.body.code]).toEqual([409, 'FISCAL_CODE_CONFLICT'])
    expectNoValueLeak(r)
  })

  it('7 · FiscalCodeStoreError → 503 FISCAL_CODE_STORE_FAILED; contenção embrulhada → 409 RESOURCE_BUSY', async () => {
    saveM.mockRejectedValue(new actual.FiscalCodeStoreError(1146, 'ER_NO_SUCH_TABLE'))
    const a = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body())
    expect([a.status, a.body.code]).toEqual([503, 'FISCAL_CODE_STORE_FAILED'])
    expectNoValueLeak(a)
    saveM.mockRejectedValue(new actual.FiscalCodeStoreError(1213, 'ER_LOCK_DEADLOCK'))
    const b = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body())
    expect([b.status, b.body.code]).toEqual([409, 'RESOURCE_BUSY'])
    listM.mockRejectedValue(new actual.FiscalCodeStoreError(1205, 'ER_LOCK_WAIT_TIMEOUT'))
    const c = await request(createApp(ctx())).get('/v1/provider/fiscal-credentials').set(auth())
    expect([c.status, c.body.code]).toEqual([409, 'RESOURCE_BUSY'])
  })

  it('8 · encerrar: true → 200 data.ended; false → 404 FISCAL_CODE_NOT_FOUND; o `at` da peça vira `validUntil` no erro', async () => {
    const ok = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials/end').set(auth())
      .send({ ...KEY, validUntil: '2026-12-01T03:00:00Z' })
    expect([ok.status, ok.body]).toEqual([200, { ok: true, data: { ended: true } }])
    expect(endM).toHaveBeenCalledWith(pool, { state: 'PR', model: '55', environment: 'H', type: 'CSRT',
      validFrom: new Date('2026-11-22T03:00:00Z') }, new Date('2026-12-01T03:00:00Z'))
    endM.mockResolvedValue(false)
    const none = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials/end').set(auth()).send(KEY)
    expect([none.status, none.body.code]).toEqual([404, 'FISCAL_CODE_NOT_FOUND'])
    expect(endM.mock.calls[1][2]).toBeInstanceOf(Date)                  // padrão: agora
    endM.mockRejectedValue(new actual.FiscalCodeInvalidError('at', 'não é depois do início'))
    const early = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials/end').set(auth())
      .send({ ...KEY, validUntil: '2026-11-01T03:00:00Z' })
    expect([early.status, early.body.code, early.body.fields?.[0]?.field]).toEqual([400, 'FISCAL_CODE_INVALID', 'validUntil'])
    expect(early.body.fields[0].message).not.toMatch(/\bat\b/)
  })

  it('9 · corpo fora da forma → 400 VALIDATION_FAILED, peça não chamada, valor não ecoado', async () => {
    for (const b of [body({ validFrom: '22/11/2026' }), body({ codeValue: undefined }), body({ validFrom: '2026-11-22T03:00:00' }),
      body({ codeValue: 12345 }), body({ state: 'PRX' })]) {
      const r = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(b)
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED'])
      expectNoValueLeak(r)
    }
    expect(saveM).not.toHaveBeenCalled()
  })

  it('10 · erro INESPERADO do núcleo (500 com ref, pelo logger interno → console) também não leva o valor', async () => {
    saveM.mockRejectedValue(new Error('falha qualquer'))
    const r = await request(createApp(ctx())).post('/v1/provider/fiscal-credentials').set(auth()).send(body())
    expect([r.status, r.body.code]).toEqual([500, 'INTERNAL'])
    expectNoValueLeak(r)
  })
})

describe('CRED.E1.P1.T2 — contrato (D-F8, regra 5 do CLAUDE.md)', () => {
  it('11 · os três caminhos estão no YAML; o valor é writeOnly e não está no schema de leitura', () => {
    const doc = loadOpenApi()
    expect(Object.keys(doc.paths['/v1/provider/fiscal-credentials'] ?? {}).sort()).toEqual(['get', 'post'])
    expect(Object.keys(doc.paths['/v1/provider/fiscal-credentials/end'] ?? {})).toEqual(['post'])
    const s = doc.components.schemas
    expect(s.ProviderFiscalCredentialInput.properties.codeValue.writeOnly).toBe(true)
    expect(Object.keys(s.ProviderFiscalCredential.properties)).not.toContain('codeValue')
    expect(Object.keys(s.ProviderFiscalCredentialEnd.properties)).not.toContain('codeValue')
  })
})

describe('CRED.E1.P1.T1 — a borda não afrouxa a peça REAL (RF-NFE-30: idCSRT com dois dígitos)', () => {
  const catalog = { id: 'CSRT', owner: 'provider', pattern: '^[0-9]{2}$' }
  const fakeQ = () => ({ query: jest.fn(async (sql: string) => (/FROM tb_fiscal_code_type/.test(sql) ? [[catalog]] : [{ affectedRows: 1 }])) })
  const input = (codeId: string) => ({ state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId, codeValue: MARK,
    validFrom: new Date('2026-11-22T03:00:00Z') })

  it.each(['3', '003', 'ab'])('12 · codeId %p → FiscalCodeInvalidError no campo codeId, sem INSERT', async id => {
    const q = fakeQ()
    const err = await actual.saveProviderFiscalCredential(q as any, input(id)).catch(e => e)
    expect(err).toBeInstanceOf(actual.FiscalCodeInvalidError)
    expect([err.field, String(err.message).includes(MARK)]).toEqual(['codeId', false])
    expect(q.query.mock.calls.some(([sql]) => /INSERT/.test(String(sql)))).toBe(false)
  })
  it('12 · codeId "03" → INSERT chamado', async () => {
    const q = fakeQ()
    await actual.saveProviderFiscalCredential(q as any, input('03'))
    expect(q.query.mock.calls.some(([sql]) => /INSERT INTO tb_provider_fiscal_credential/.test(String(sql)))).toBe(true)
  })
})
