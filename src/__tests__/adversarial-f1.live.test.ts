/// <reference types="jest" />
// GATE ADVERSARIAL da F1 (testar-adversarial.md) — ataques contra o BANCO REAL do dev com o FISCO FALSO.
// ⚠️ Só roda com NFSE_ADV_LIVE=1 (precisa do MariaDB do dev e do .env da nfse-api). Nunca fala com o
// fisco: o adaptador é falso E o transporte HTTPS do núcleo é trocado por um que explode. Escreve SÓ no
// banco `fiscal_api` (o usuário do .env só tem SELECT no ERP) e num storage temporário (o arquivo fiscal
// real é só LIDO). O afterAll devolve o `fiscal_api` ao estado de antes (linhas criadas apagadas, emissor
// restaurado).
// Retrabalho dos gates (2026-10-04): os achados CORRIGIDOS viraram `it` (a regra que os fecha); a Q-F46
// (admin × licença) virou a D-F37 — licença para todos — e o teste dela também é `it`.
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import forge from 'node-forge'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, MasterKeyRing, HttpError, createFiscalPool } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import { refreshOpenServiceTransmissions, resetMunicipalTermsCache, listPending } from '../nfse/transmission'
import { refOf, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return fiscal.reconfirmationProven(cc, life ?? [cc])
}

// O ramo congelado das notas E do dev tem cTribMun "0102" (anterior à D-N26b) → 422 antes de reservar em
// TODAS as notas. Para atacar a máquina da voz, o ramo é normalizado EM MEMÓRIA (cTribMun inválido →
// ausente). Nada é escrito no ERP; locks, views, repositório e banco fiscal continuam REAIS.
jest.mock('../facts/service-facts', () => {
  const actual = jest.requireActual('../facts/service-facts')
  return {
    __esModule: true, ...actual,
    readServiceInvoice: async (...args: any[]) => {
      const h = await actual.readServiceInvoice(...args)
      if (h.branch.municipalCode && !/^\d{3}$/.test(String(h.branch.municipalCode).trim())) h.branch.municipalCode = null
      return h
    },
  }
})

const LIVE = process.env.NFSE_ADV_LIVE === '1'
const d = LIVE ? describe : describe.skip
jest.setTimeout(120_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const SCHEMA = 'setes_setes'
const ADV_USER = 990001                    // marca as linhas do ataque
const CNPJ = '07742094000113'

// ---------------------------------------------------------------------------
// FISCO FALSO (estado em memória — o "fisco" do ataque)
// ---------------------------------------------------------------------------
type TransmitMode = 'authorize' | 'reject' | 'unavailable' | 'unknown' | 'generate-then-timeout'
type EventMode = 'accept' | 'dup-reject' | 'unavailable'
interface Rec { key: string; xml: string; n: string; dpsId: string; env: string }
const fisco = {
  recs: new Map<string, Rec>(),               // `${env}:${dpsId}`
  cancelled: new Set<string>(),
  transmitMode: 'authorize' as TransmitMode,
  transmitDelay: 0,
  eventMode: 'accept' as EventMode,
  eventDelay: 0,
  swapQuery: false,
  calls: { transmit: 0, query: 0, dps: 0, event: 0 },
  envs: [] as string[],                       // ambiente de cada chamada (prova do ctx usado)
  sentEvents: [] as string[],
}
let seq = 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const newKey = (dpsId: string) => (`9${dpsId.slice(-12)}${String(Date.now()).slice(-9)}${String(++seq).padStart(4, '0')}`).padEnd(50, '3').slice(0, 50)
const nfseXml = (key: string, dpsId: string, n: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${n}</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
function generate(env: string, dpsId: string): Rec {
  const k = `${env}:${dpsId}`
  let rec = fisco.recs.get(k)
  if (!rec) {
    const key = newKey(dpsId)
    const n = String(900000 + seq)
    rec = { key, xml: nfseXml(key, dpsId, n), n, dpsId, env }
    fisco.recs.set(k, rec)
  }
  return rec
}
const rejected = (code = 'E0001') => new AuthorityHttpError(422, `Fisco rejeitou (400): ${code}: teste adversarial`, 'FISCAL_DPS_REJECTED', 400,
  `{"erros":[{"codigo":"${code}","descricao":"teste adversarial"}]}`, [{ field: 'dps', message: `${code}: teste adversarial` }])
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível (falso)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const unknown = () => new AuthorityHttpError(502, 'Fisco respondeu 200 sem envelope legível (falso)', 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE', 200, '<html/>')
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')

const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit(ctx: AuthorityContext, xml: string) {
    fisco.calls.transmit++; fisco.envs.push(`transmit:${ctx.environment}`)
    if (fisco.transmitDelay) await sleep(fisco.transmitDelay)
    const dpsId = /<infDPS\b[^>]*\sId="([^"]*)"/.exec(xml)![1]
    switch (fisco.transmitMode) {
      case 'reject': throw rejected()
      case 'unavailable': throw unavailable()
      case 'unknown': throw unknown()
      case 'generate-then-timeout': generate(ctx.environment, dpsId); throw unavailable()
      default: {
        const rec = generate(ctx.environment, dpsId)
        return { accessKey: rec.key, nfseNumber: rec.n, dhProc: '2026-10-04T10:00:00-03:00', nfseXml: rec.xml, raw: {} }
      }
    }
  },
  async queryNfse(ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++; fisco.envs.push(`query:${ctx.environment}`)
    const rec = [...fisco.recs.values()].find(r => r.key === accessKey && r.env === ctx.environment)
    if (!rec) throw notFound()
    if (fisco.swapQuery) {
      const other = 'DPS999999929999999999999900001000000000000777'
      return { accessKey, status: 'authorized' as const, nfseXml: nfseXml(accessKey, other, rec.n), dhProc: '2026-10-04T10:00:00-03:00' }
    }
    if (fisco.cancelled.has(accessKey)) {
      return { accessKey, status: 'cancelled' as const, nfseXml: rec.xml, dhProc: '2026-10-04T10:00:00-03:00', cancelled: { dhEvento: '2026-10-04T10:05:00-03:00', motive: 'falso', eventXml: null } }
    }
    return { accessKey, status: 'authorized' as const, nfseXml: rec.xml, dhProc: '2026-10-04T10:00:00-03:00' }
  },
  async queryDpsAccessKey(ctx: AuthorityContext, dpsId: string) {
    fisco.calls.dps++; fisco.envs.push(`dps:${ctx.environment}`)
    return fisco.recs.get(`${ctx.environment}:${dpsId}`)?.key ?? null
  },
  async registerEvent(ctx: AuthorityContext, accessKey: string, xml: string) {
    fisco.calls.event++; fisco.envs.push(`event:${ctx.environment}`); fisco.sentEvents.push(xml)
    if (fisco.eventDelay) await sleep(fisco.eventDelay)
    if (fisco.eventMode === 'unavailable') throw unavailable()
    const rec = [...fisco.recs.values()].find(r => r.key === accessKey && r.env === ctx.environment)
    if (!rec) throw notFound()
    if (fisco.eventMode === 'dup-reject' && fisco.cancelled.has(accessKey)) throw rejected('E0840')
    fisco.cancelled.add(accessKey)
    return { dhEvento: '2026-10-04T10:05:00-03:00', protocol: `EVT${accessKey}`, eventXml: `<evento><chNFSe>${accessKey}</chNFSe></evento>`, raw: {} }
  },
  async municipalTerms() { return { cancelDays: null, raw: null } },
}
function resetFisco(): void {
  Object.assign(fisco, { transmitMode: 'authorize', transmitDelay: 0, eventMode: 'accept', eventDelay: 0, swapQuery: false })
  fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0 }
  fisco.envs = []; fisco.sentEvents = []
}

// ---------------------------------------------------------------------------
// Storage: LÊ o arquivo fiscal real, ESCREVE só num temporário
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-'))
class SandboxStorage implements FiscalStorage {
  constructor(private real: FiscalStorage, private tmp: FsFiscalStorage) {}
  save(...a: Parameters<FiscalStorage['save']>) { return this.tmp.save(...a) }
  find(...a: Parameters<FiscalStorage['find']>) { return this.tmp.find(...a) ?? this.real.find(...a) }
  read(ref: string) { return fs.readFileSync(ref, 'utf8') }
  probe() { return this.tmp.probe() }
}

// ---------------------------------------------------------------------------
// Token RS256 com a chave PRIVADA de dev do setes-api (D-F13)
// ---------------------------------------------------------------------------
let privPem = ''
let pubPem = ''
const tok = (claims: any = {}, opts: jwt.SignOptions = {}) =>
  jwt.sign({ institutionId: INST, userId: ADV_USER, role: 'admin', schemaName: SCHEMA, ...claims }, privPem, { algorithm: 'RS256', keyid: 'default', expiresIn: '1h', ...opts })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

// ---------------------------------------------------------------------------
// Envelope: todo não-2xx observado é conferido no fim (error + code; nunca 500)
// ---------------------------------------------------------------------------
const seen: { label: string; status: number; body: any }[] = []
function track<T extends { status: number; body: any }>(label: string, r: T): T {
  seen.push({ label, status: r.status, body: r.body })
  return r
}

let ctx: AppContext
let harness: DisposableFiscalDb
let app: any
const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]

// estado de antes (o afterAll devolve)
let issuerBefore: any
let maxAttemptBefore = new Map<number, number>()
let dpsBefore = new Set<number>()
const TOUCHED: number[] = []

async function txRows(invoiceId: number) {
  // NE-1a (D-NE56): a projeção à mão traz o FATO do registro publicado pela view 004 (os predicados do núcleo falham alto sem ele — D-NE66)
  return q(`SELECT attempt, environment, access_key AS accessKey, authority_recorded AS authorityRecorded, last_kind AS lastKind,
                   last_source AS lastSource, dps_id AS dpsId, DATE_FORMAT(last_queried_at, '%Y-%m-%d %H:%i:%s') AS lastQueriedAt
              FROM vw_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt`, [INST, invoiceId])
}
async function newAttempts(invoiceId: number) {
  const before = maxAttemptBefore.get(invoiceId) ?? 0
  return (await txRows(invoiceId)).filter(r => Number(r.attempt) > before)
}

d('GATE ADVERSARIAL F1 — banco real + fisco falso', () => {
  // notas E do dev com ramo de serviço montável (após a normalização em memória) — 6 frescas + a 8005 (F em H)
  let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0
  const HP = 8005, SYNCED = 6531, NO_BRANCH = 8003, DELETED = 6756, CANCELLED = 8011, FAILED_H = 8005
  const lastOf = async (id: number) => { const r = await txRows(id); return r[r.length - 1] }
  const issuerN = async () => Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)

  beforeAll(async () => {
    require('dotenv').config({ path: path.join(ROOT, '.env') })
    // cinto + suspensório: o transporte HTTPS real do núcleo EXPLODE (nenhum byte ao fisco)
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    // a cerca da virada (D-F18) fica DESLIGADA aqui: o ataque exercita a máquina da voz (o fisco é falso)
    // gates R4: o ataque roda numa CÓPIA descartável do fiscal_api (virada SÓ na cópia) — o real nunca é virado
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_r1', { turned: true })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    process.chdir(cwd)
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.adapter).toBe(fakeAdapter)
    app = createApp(ctx)
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')
    pubPem = fs.readFileSync(path.resolve(ROOT, process.env.JWT_PUBLIC_KEY_PATH!), 'utf8')

    issuerBefore = (await q(`SELECT environment, serie, dps_last_number, tb_user_id, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
                                    DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutover_at FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
    for (const r of await q(`SELECT tb_invoice_id AS id, MAX(attempt) AS m FROM tb_invoice_service_transmission WHERE tb_institution_id = ? GROUP BY tb_invoice_id`, [INST])) maxAttemptBefore.set(Number(r.id), Number(r.m))
    for (const r of await q(`SELECT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])) dpsBefore.add(Number(r.id))

    const svc = await import('../facts/service-facts')
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E' ORDER BY i.id DESC LIMIT 400`, [INST])
    const fresh: number[] = []
    for (const r of rows) {
      const id = Number(r.id)
      if (maxAttemptBefore.has(id)) continue
      try {
        const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, refOf(INST, id))
        await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
        fresh.push(id)
      } catch { /* cadastro incompleto — não serve de alvo */ }
    }
    // eslint-disable-next-line no-console
    console.log('[adv] notas-alvo frescas', fresh.join(','), '+ HP', HP)
    expect(fresh.length).toBeGreaterThanOrEqual(6)
    ;[A, B, C, D, E, F] = fresh
    TOUCHED.push(A, B, C, D, E, F, HP)
  })

  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    if (!ctx) return
    try {
      for (const id of TOUCHED) {
        const before = maxAttemptBefore.get(id) ?? 0
        await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        await q(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        if (!dpsBefore.has(id)) await q(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
      }
      // pré-existentes: o ataque pode ter gravado vozes NOVAS e chave falsa em tentativas antigas (achado do H→P)
      await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_user_id = ?`, [INST, ADV_USER])
      await q(`UPDATE tb_invoice_service_transmission SET access_key = NULL, nfse_number = NULL, dh_proc = NULL
                WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt <= ? AND access_key LIKE '9%'`, [INST, HP, maxAttemptBefore.get(HP) ?? 0])
      await q(`UPDATE tb_invoice_service_transmission SET last_queried_at = NULL WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt <= ?`, [INST, HP, maxAttemptBefore.get(HP) ?? 0])
      await q(`UPDATE tb_establishment_issuer SET environment = ?, serie = ?, dps_last_number = ?, tb_user_id = ?, updated_at = ?, refresh_lease_until = NULL, cutover_at = ? WHERE tb_institution_id = ? AND model = 'SE'`,
        [issuerBefore.environment, issuerBefore.serie, issuerBefore.dps_last_number, issuerBefore.tb_user_id, issuerBefore.updated_at, issuerBefore.cutover_at, INST])
      await q(`DELETE FROM tb_establishment_certificate WHERE tb_institution_id = 2`)
      await q(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = 2`)
    } finally {
      const bad = seen.filter(s => s.status >= 400 && (typeof s.body?.error !== 'string' || typeof s.body?.code !== 'string'))
      const fiveHundred = seen.filter(s => s.status >= 500 && s.status !== 502 && s.status !== 503)
      // eslint-disable-next-line no-console
      console.log('[adv] respostas observadas', seen.length, '| fora do envelope', JSON.stringify(bad.map(b => [b.label, b.status])), '| 500', JSON.stringify(fiveHundred.map(b => [b.label, b.status, b.body?.ref])))
      await harness.drop()                                 // apaga a cópia e confere o fiscal_api REAL intocado
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  // =========================================================================
  describe('0. corrida entre notas DIFERENTES (primeira — usa as 6 frescas)', () => {
    it('[corrigido — MEDIUM] 6 notas diferentes ao mesmo tempo (fisco recusa) → nDPS distintos e contíguos, 6 R, nenhum 500', async () => {
      const a = bearer(tok())
      const ids = [A, B, C, D, E, F]
      fisco.transmitDelay = 300
      fisco.transmitMode = 'reject'
      const n0 = await issuerN()
      const rs = await Promise.all(ids.map(id => request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)))
      rs.forEach((r, i) => track(`corrida N notas ${i}`, r))
      // eslint-disable-next-line no-console
      console.log('[adv] 6 notas', rs.map(r => `${r.status}:${r.body.code}`).join(' '))
      expect(rs.map(r => r.status)).toEqual(ids.map(() => 422))
      const nums = (await q(`SELECT dps_number n FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id IN (?)`, [INST, ids])).map(r => Number(r.n)).sort((x, y) => x - y)
      expect(nums).toEqual(ids.map((_, i) => n0 + 1 + i))
      expect(await issuerN()).toBe(n0 + 6)
      for (const id of ids) expect((await lastOf(id)).lastKind).toBe('R')
    })
  })

  // =========================================================================
  describe('1. autenticação (D-F13) — identidade conferida no banco', () => {
    it('sem token · HS256 com a chave PÚBLICA · alg none · kid desconhecido · expirado · tipos errados · schema trocado → 401 com code', async () => {
      const forgedHs = jwt.sign({ institutionId: 1, userId: 1, role: 'admin', schemaName: SCHEMA }, pubPem, { algorithm: 'HS256', keyid: 'default' })
      const none = jwt.sign({ institutionId: 1, userId: 1, role: 'admin', schemaName: SCHEMA }, '', { algorithm: 'none' as any })
      const before = (await txRows(A)).length
      const cases: [string, Record<string, string>, string][] = [
        ['sem token', {}, 'UNAUTHORIZED'],
        ['Basic', { Authorization: 'Basic abc' }, 'UNAUTHORIZED'],
        ['HS256 c/ chave pública', bearer(forgedHs), 'UNAUTHORIZED'],
        ['alg none', bearer(none), 'UNAUTHORIZED'],
        ['kid desconhecido', bearer(tok({}, { keyid: 'evil' })), 'UNAUTHORIZED'],
        ['expirado', bearer(jwt.sign({ institutionId: INST, userId: ADV_USER, role: 'admin', schemaName: SCHEMA, exp: 1 }, privPem, { algorithm: 'RS256', keyid: 'default' })), 'UNAUTHORIZED'],
        ['institutionId string', bearer(tok({ institutionId: '1' })), 'UNAUTHORIZED'],
        ['schema com injeção', bearer(tok({ schemaName: 'setes_setes`; DROP TABLE x; --' })), 'UNAUTHORIZED'],
        ['schema de OUTRA base', bearer(tok({ schemaName: 'setes_central' })), 'INSTITUTION_MISMATCH'],
        ['institution inexistente', bearer(tok({ institutionId: 2 })), 'INSTITUTION_MISMATCH'],
      ]
      for (const [label, h, code] of cases) {
        const r = track(`auth ${label}`, await request(app).post(`/v1/nfse/invoices/${A}/transmit`).set(h))
        expect([label, r.status, r.body.code]).toEqual([label, 401, code])
      }
      expect(fisco.calls.transmit).toBe(0)
      expect((await txRows(A)).length).toBe(before)
    })
  })

  describe('2. autorização de AÇÃO, licença e emitente', () => {
    it('usuário comum sem TRANSMITIR/CANCELAR no ramo (ou ramo não contratado) → 403 sem tocar o fisco; emitente → 403 ADMIN_REQUIRED', async () => {
      const user = bearer(tok({ role: 'user', userId: 266 }))
      const iface = (await q(`SELECT interface_key AS k FROM \`${SCHEMA}\`.vw_order_interface WHERE tb_institution_id = ? AND tb_order_id = ?`, [INST, A]))[0]?.k
      const expected = (await fiscal.erp.institutionHasInterface(ctx.pool, SCHEMA, INST, iface)) ? 'PRIVILEGE_REQUIRED' : 'INTERFACE_NOT_ALLOWED'
      // D-F46 (b): ramo não contratado = bloqueio total, inclusive sobre o já emitido — a licença decide em TODAS as ações
      for (const [m, p, body] of [
        ['post', `/v1/nfse/invoices/${A}/transmit`, undefined],
        ['post', `/v1/nfse/invoices/${A}/cancel`, { reason: 'teste adversarial de privilégio' }],
        ['post', `/v1/nfse/invoices/${A}/reconfirm`, undefined],
        ['post', `/v1/nfse/invoices/${A}/refresh`, undefined],
      ] as const) {
        const r = track(`authz ${p}`, await (request(app) as any)[m](p).set(user).send(body))
        expect([p, r.status, r.body.code]).toEqual([p, 403, expected])
      }
      for (const [m, p] of [['get', '/v1/emitter'], ['put', '/v1/emitter/certificate'], ['delete', '/v1/emitter/certificate'], ['put', '/v1/emitter/issuers/SE'], ['delete', '/v1/emitter/issuers/SE']] as const) {
        const r = track(`emitter ${m} ${p}`, await (request(app) as any)[m](p).set(user).send({}))
        expect([p, r.status, r.body.code]).toEqual([p, 403, 'ADMIN_REQUIRED'])
      }
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0 })
    })

    it('[corrigido — LOW] LICENÇA (D-F14): o lote de pendentes do usuário comum traz SÓ os ramos contratados', async () => {
      const user = bearer(tok({ role: 'user', userId: 266 }))
      const contracted: string[] = []
      for (const k of ['service-orders', 'orders']) if (await fiscal.erp.institutionHasInterface(ctx.pool, SCHEMA, INST, k)) contracted.push(k)
      const pending = track('licença pending', await request(app).get('/v1/nfse/invoices/pending?pageSize=100').set(user))
      expect(pending.status).toBe(200)
      const keys = new Set<string>((pending.body.data ?? []).map((x: any) => x.interfaceKey))
      // eslint-disable-next-line no-console
      console.log('[adv] ramos contratados', contracted, '| ramos no lote do usuário', [...keys], '| total', pending.body.total)
      expect([...keys].every(k => contracted.includes(k))).toBe(true)
      const all = await listPending(ctx, { schemaName: SCHEMA, institutionId: INST, userId: 266 }, WEB, { page: 1, pageSize: 100_000 }, contracted)
      expect(pending.body.total).toBe(all.total)
    })

    it('[corrigido — MEDIUM] LOTE PAGINADO: o app alcança as notas transmissíveis por página, mesmo com a cabeça cheia de 422 de cadastro', async () => {
      const a = bearer(tok())
      const first = track('lote página 1', await request(app).get('/v1/nfse/invoices/pending?page=1&pageSize=100').set(a))
      expect(first.body).toMatchObject({ ok: true, page: 1, pageSize: 100 })
      const total = Number(first.body.total)
      const ids: number[] = []
      for (let page = 1; (page - 1) * 100 < total; page++) {
        const r = track(`lote página ${page}`, await request(app).get(`/v1/nfse/invoices/pending?page=${page}&pageSize=100`).set(a))
        ids.push(...(r.body.data ?? []).map((x: any) => Number(x.invoiceId)))
      }
      const stillPending = [A, B, C, D, E, F].filter(id => ids.includes(id))
      // eslint-disable-next-line no-console
      console.log('[adv] lote paginado: total', total, '| percorridas', ids.length, '| distintas', new Set(ids).size, '| alvos alcançados', stillPending.length)
      expect(ids.length).toBe(total)
      expect(new Set(ids).size).toBe(total)                                    // nenhuma repetida entre páginas
      expect(stillPending.length).toBeGreaterThan(0)
    })

    it('[D-F37] LICENÇA para todos + DADO acertado: `service-orders` contratada na institution 1 — o ADMIN transmite a OS porque o ramo é contratado, não porque é admin', async () => {
      const iface = (await q(`SELECT interface_key AS k FROM \`${SCHEMA}\`.vw_order_interface WHERE tb_institution_id = ? AND tb_order_id = ?`, [INST, A]))[0]?.k
      const contracted = await fiscal.erp.institutionHasInterface(ctx.pool, SCHEMA, INST, iface)
      // eslint-disable-next-line no-console
      console.log('[adv] interface do ramo', iface, 'contratada?', contracted)
      expect(contracted).toBe(true)
      const r = track('licença admin transmit', await request(app).post(`/v1/nfse/invoices/${A}/transmit`).set(bearer(tok())))
      expect(r.status).toBeLessThan(500)
      expect(r.body.code).not.toBe('INTERFACE_NOT_ALLOWED')
    })
  })

  // =========================================================================
  describe('3. entradas', () => {
    it('invoiceId inválido → 400 INVALID_ID (nunca 500)', async () => {
      for (const raw of ['0', '-1', 'abc', '1.5', '1e3', '0x1F', '99999999999999999999', '%20', '12abc', '9007199254740993']) {
        const r = track(`id ${raw}`, await request(app).post(`/v1/nfse/invoices/${raw}/transmit`).set(bearer(tok())))
        expect([raw, r.status, r.body.code]).toEqual([raw, 400, 'INVALID_ID'])
      }
    })

    it('invoiceId além do INT / inexistente → nada >= 500, fisco intocado (registro do comportamento por rota)', async () => {
      const big = '2147483648'
      const a = bearer(tok())
      const out: Record<string, [number, string]> = {}
      for (const [m, p, body] of [
        ['get', `/v1/nfse/invoices/${big}`, undefined], ['post', `/v1/nfse/invoices/${big}/transmit`, undefined],
        ['post', `/v1/nfse/invoices/${big}/cancel`, { reason: 'motivo de teste adversarial' }],
        ['post', `/v1/nfse/invoices/${big}/refresh`, undefined], ['post', `/v1/nfse/invoices/${big}/reconfirm`, undefined],
        ['get', `/v1/nfse/invoices/${big}/xml`, undefined], ['get', `/v1/nfse/invoices/${big}/danfse`, undefined],
      ] as const) {
        const r = track(`inexistente ${m} ${p}`, await (request(app) as any)[m](p).set(a).send(body))
        out[`${m} ${p.replace(big, ':id')}`] = [r.status, r.body.code ?? (r.body.ok ? `ok ${JSON.stringify(r.body.data)}` : '')]
      }
      // eslint-disable-next-line no-console
      console.log('[adv] nota inexistente', JSON.stringify(out))
      for (const [k, [s]] of Object.entries(out)) expect([k, s < 500]).toEqual([k, true])
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0 })
    })

    it('corpos com tipo errado / enormes / JSON malformado → 400/413 no envelope', async () => {
      const a = bearer(tok())
      const id = B
      const bodies: [string, any, number][] = [
        ['cancel {}', {}, 400], ['cancel number', { reason: 123 }, 400], ['cancel array', { reason: ['x'] }, 400],
        ['cancel 256', { reason: 'x'.repeat(256) }, 400], ['cancel espaços', { reason: '    ' }, 400],
      ]
      for (const [label, body, st] of bodies) {
        const r = track(label, await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send(body))
        expect([label, r.status, r.body.code]).toEqual([label, st, 'VALIDATION_FAILED'])
      }
      const mal = track('malformado', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).set('Content-Type', 'application/json').send('{"reason":'))
      expect([mal.status, mal.body.code]).toEqual([400, 'VALIDATION_FAILED'])
      const nul = track('null', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).set('Content-Type', 'application/json').send('null'))
      expect(nul.status).toBe(400)
      const big = track('413', await request(app).put('/v1/emitter/certificate').set(a).send({ pfxBase64: 'A'.repeat(200_000), password: '' }))
      expect([big.status, big.body.code]).toEqual([413, 'VALIDATION_FAILED'])
      for (const [label, body] of [['limit 0', { limit: 0 }], ['limit 51', { limit: 51 }], ['limit str', { limit: '5' }], ['minMinutes 0', { minMinutes: 0 }], ['minMinutes 1.5', { minMinutes: 1.5 }], ['array', []]] as const) {
        const r = track(`pass ${label}`, await request(app).post('/v1/nfse/refresh').set(a).send(body as any))
        expect([label, r.status, r.body.code]).toEqual([label, 400, 'VALIDATION_FAILED'])
      }
      for (const lim of ['0', '101', 'abc', '-5', '']) {
        const r = track(`pending ${lim}`, await request(app).get(`/v1/nfse/invoices/pending?pageSize=${lim}`).set(a))
        expect([lim, r.status, r.body.code]).toEqual([lim, 400, 'VALIDATION_FAILED'])
      }
      for (const [label, body, st, code] of [
        ['pfx não-base64', { pfxBase64: '!!!$$$', password: '' }, 400, 'FISCAL_CERT_INVALID'],
        ['pfx 64001', { pfxBase64: 'A'.repeat(64_001), password: '' }, 400, 'VALIDATION_FAILED'],
        ['pfx lixo', { pfxBase64: Buffer.from('não sou um pkcs12').toString('base64'), password: 'x' }, 400, 'FISCAL_CERT_INVALID'],
        ['senha número', { pfxBase64: 'QUJD', password: 123 }, 400, 'VALIDATION_FAILED'],
        ['pfx só "="', { pfxBase64: '====', password: '' }, 400, 'FISCAL_CERT_INVALID'],
      ] as const) {
        const r = track(label, await request(app).put('/v1/emitter/certificate').set(a).send(body as any))
        expect([label, r.status, r.body.code]).toEqual([label, st, code])
      }
      for (const [label, model, body, st] of [
        ['modelo 55', '55', { environment: 'H', serie: '1' }, 422], ['ambiente X', 'SE', { environment: 'X', serie: '1' }, 400],
        ['série 0', 'SE', { environment: 'H', serie: '0' }, 400], ['série 50000', 'SE', { environment: 'H', serie: '50000' }, 400],
        ['série -1', 'SE', { environment: 'H', serie: '-1' }, 400], ['série número', 'SE', { environment: 'H', serie: 1 }, 400],
      ] as const) {
        const r = track(label, await request(app).put(`/v1/emitter/issuers/${model}`).set(a).send(body as any))
        expect([label, r.status]).toEqual([label, st])
      }
      const issuerNow = (await q(`SELECT environment, serie FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
      expect(issuerNow).toMatchObject({ environment: issuerBefore.environment, serie: issuerBefore.serie })
    })
  })

  // =========================================================================
  describe('4. semântica do ciclo', () => {
    it('nota cancelada / sincronizada / sem ramo / soft-deletada → 409/422/404, fisco intocado', async () => {
      const a = bearer(tok())
      const exp: [number, number, string][] = [
        [CANCELLED, 409, 'INVOICE_NOT_TRANSMITTABLE'], [7971, 409, 'INVOICE_NOT_TRANSMITTABLE'],
        [SYNCED, 404, 'INVOICE_NOT_FOUND'],            // sincronizada da origem: `issuer` ≠ institution no dev → 404 antes do 409 (ambos ok, nunca 5xx)
        [NO_BRANCH, 422, 'INVOICE_SERVICE_BRANCH_MISSING'], [DELETED, 404, 'INVOICE_NOT_FOUND'],
      ]
      for (const [id, st, code] of exp) {
        const r = track(`transmit ${id}`, await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
        expect([id, r.status, r.body.code]).toEqual([id, st, code])
      }
      const c1 = track('cancel F', await request(app).post(`/v1/nfse/invoices/${FAILED_H}/cancel`).set(a).send({ reason: 'teste adversarial cancelar F' }))
      expect([c1.status, c1.body.code]).toEqual([409, 'FISCAL_NOT_AUTHORIZED'])
      const c2 = track('cancel C', await request(app).post(`/v1/nfse/invoices/${CANCELLED}/cancel`).set(a).send({ reason: 'teste adversarial cancelar C' }))
      expect(c2.status).toBe(200)
      expect(c2.body.data).toMatchObject({ atAuthority: false, nextStep: 'apply-local-cancel' })
      const rc = track('reconfirm F/H', await request(app).post(`/v1/nfse/invoices/${FAILED_H}/reconfirm`).set(a))
      expect(rc.body.data).toMatchObject({ needed: false })
      const v = track('view 704', await request(app).get(`/v1/nfse/invoices/${CANCELLED}`).set(a))
      expect(v.body.data.state).toBe('cancelled')
      const x = track('xml 704', await request(app).get(`/v1/nfse/invoices/${CANCELLED}/xml`).set(a))
      expect(x.status).toBe(200)
      const pdf = track('danfse 704', await request(app).get(`/v1/nfse/invoices/${CANCELLED}/danfse`).set(a))
      expect(pdf.status).toBe(200)
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0 })
    })

    it('ciclo: transmite → 2ª vez 409 → cancela com motivo hostil (escapado, sem 500) → voz C sem efeito no ERP → re-transmitir 409 EFFECT_PENDING → pendentes', async () => {
      const a = bearer(tok())
      const id = B
      const ev0 = (await q(`SELECT COUNT(*) n, MAX(event) m FROM \`${SCHEMA}\`.tb_invoice_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id]))[0]
      const t1 = track('ciclo transmit', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t1.status, t1.body.data?.kind]).toEqual([201, 'A'])
      const t2 = track('ciclo transmit 2', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t2.status, t2.body.code]).toEqual([409, 'FISCAL_ALREADY_AUTHORIZED'])
      const hostile = 'erro </xMotivo><cMotivo>9</cMotivo><xMotivo> & "aspas" \u0001\u0007 fim'
      const c = track('ciclo cancel hostil', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: hostile }))
      // eslint-disable-next-line no-console
      console.log('[adv] cancel com motivo hostil →', c.status, c.body.code ?? '', c.body.ref ?? '', '| evento enviado com <cMotivo>9 cru?', fisco.sentEvents.some(x => x.includes('<cMotivo>9</cMotivo>')), '| com \\u0001 cru?', fisco.sentEvents.some(x => x.includes('\u0001')))
      expect(c.status).toBeLessThan(500)
      expect(fisco.sentEvents.some(x => x.includes('<cMotivo>9</cMotivo>'))).toBe(false)
      if (c.status !== 200) return
      const ev1 = (await q(`SELECT COUNT(*) n, MAX(event) m FROM \`${SCHEMA}\`.tb_invoice_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id]))[0]
      expect(ev1).toEqual(ev0)                                                // voz C não aplica nada no ERP (D-F11/D-F28)
      const v = track('ciclo view', await request(app).get(`/v1/nfse/invoices/${id}`).set(a))
      expect(v.body.data).toMatchObject({ state: 'cancelled', localCancelPending: true })
      const t3 = track('ciclo transmit pós-C', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t3.status, t3.body.code]).toEqual([409, 'FISCAL_EFFECT_PENDING'])
      const again = track('ciclo cancel 2', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'segunda vez, idempotente' }))
      expect(again.body.data).toMatchObject({ atAuthority: false })
      const listed = (await listPending(ctx, { schemaName: SCHEMA, institutionId: INST, userId: ADV_USER }, WEB, { page: 1, pageSize: 100_000 }, null)).data.some(x => x.invoiceId === id)
      // eslint-disable-next-line no-console
      console.log('[adv] nota com voz C (efeito local pendente) aparece no lote de pendentes?', listed)
    })

    it('[corrigido — LOW] nota com voz C e C local pendente NÃO está no lote de pendentes (só daria 409 FISCAL_EFFECT_PENDING)', async () => {
      const life = await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, fiscal.invoiceRef(INST, B, fiscal.WEB_TERMINAL))
      expect(life?.lastKind).toBe('E')
      expect((await lastOf(B)).lastKind).toBe('C')
      const listed = (await listPending(ctx, { schemaName: SCHEMA, institutionId: INST, userId: ADV_USER }, WEB, { page: 1, pageSize: 100_000 }, null)).data.some(x => x.invoiceId === B)
      expect(listed).toBe(false)
    })

    it('ambíguo (2xx ilegível) NÃO fecha; resposta trocada (NFS-e de outro DPS) não grava chave; consulta reconcilia', async () => {
      const a = bearer(tok())
      const id = C
      fisco.transmitMode = 'unknown'
      const t1 = track('amb 502', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t1.status, t1.body.code]).toEqual([502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'])
      let last = await lastOf(id)
      expect(last.lastKind).toBeNull()                                           // em voo
      const t2 = track('amb 2ª', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t2.status, t2.body.code]).toEqual([409, 'FISCAL_TRANSMISSION_IN_PROGRESS'])
      const r1 = track('amb refresh sem NFS-e', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      expect(r1.body.data).toMatchObject({ changed: false, kind: null })
      last = await lastOf(id)
      expect(last.lastKind).toBeNull()                                           // em voo RECENTE: F só depois de IN_FLIGHT_MINUTES (D-F51)
      generate(issuerBefore.environment, last.dpsId)                             // o fisco GEROU; a resposta se perdeu…
      fisco.swapQuery = true                                                     // …e a consulta devolve a NFS-e de OUTRO DPS
      const r2 = track('amb refresh trocada', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      expect([r2.status, r2.body.code]).toEqual([502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'])
      const all = await txRows(id)
      expect(all.every(x => !x.accessKey)).toBe(true)
      expect((await lastOf(id)).lastKind).toBeNull()
      fisco.swapQuery = false
      const r3 = track('amb refresh ok', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      const rows = await txRows(id)
      // eslint-disable-next-line no-console
      console.log('[adv] ambíguo reconciliado', JSON.stringify(r3.body.data), JSON.stringify(rows.map(x => `${x.attempt}:${x.environment}:${x.lastKind}/${x.lastSource}:${x.accessKey ? 'CHAVE' : '-'}`)))
      expect(r3.body.data).toMatchObject({ changed: true, kind: 'A' })
      const holder = rows.find(x => !!x.accessKey)
      // Q-ADV2h (decidido): a chave pousa na tentativa que CUNHOU o Id (a 1ª da vida); a que fez o envio fecha com F "reconciliado"
      expect(holder.attempt).toBe(rows[0].attempt)
      expect(holder.environment).toBe(last.environment)                        // mesmo ambiente aqui — o caso H→P está na seção 6
    })

    it('série trocada no emissor NÃO muda o Id da vida (D-F30)', async () => {
      const a = bearer(tok())
      const id = D
      if (!(await q(`SELECT 1 FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])).length) {
        fisco.transmitMode = 'reject'
        await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)          // cunha o DPS da vida com a série atual
        fisco.transmitMode = 'authorize'
      }
      const before = (await q(`SELECT serie, dps_id AS dpsId FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id]))[0]
      const put = track('série PUT 7', await request(app).put('/v1/emitter/issuers/SE').set(a).send({ environment: issuerBefore.environment, serie: '7' }))
      expect(put.status).toBe(200)
      const t2 = track('série A', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect(t2.status).toBe(201)
      expect(t2.body.data.dpsId).toBe(before.dpsId)
      expect(before.serie).toBe(String(issuerBefore.serie))
      await request(app).put('/v1/emitter/issuers/SE').set(a).send({ environment: issuerBefore.environment, serie: String(issuerBefore.serie) })
    })

    it('RECONFIRMAR (D-F29): F por consulta em P → fisco fora = 503 sem prova; fisco não acha = prova (last_queried_at > F); fisco acha = A e a prova some', async () => {
      const a = bearer(tok())
      const id = C                                                               // A depois do teste do ambíguo — usa-se a vida dela? não: precisa de F/Q
      const id2 = D                                                              // série: termina A — idem
      void id; void id2
      // nota F: em voo há > 10 min → nova transmissão reconcilia com F/Q (fisco não gerou)
      const tgt = E
      fisco.transmitMode = 'unavailable'
      expect((await request(app).post(`/v1/nfse/invoices/${tgt}/transmit`).set(a)).status).toBe(503)
      await q(`UPDATE tb_invoice_service_transmission SET created_at = DATE_SUB(NOW(), INTERVAL 11 MINUTE) WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = ?`, [INST, tgt, (await lastOf(tgt)).attempt])
      fisco.transmitMode = 'reject'
      const t2 = track('reconf reconcilia', await request(app).post(`/v1/nfse/invoices/${tgt}/transmit`).set(a))
      expect(t2.status).toBe(422)
      const rows = await txRows(tgt)
      const cand = rows.find(x => x.lastKind === 'F' && x.lastSource === 'Q' && x.environment === 'P')
      expect(cand).toBeDefined()
      await sleep(1100)                                                         // a prova é estritamente POSTERIOR ao F (resolução de segundo)
      const realDps = fakeAdapter.queryDpsAccessKey
      fakeAdapter.queryDpsAccessKey = async () => { throw unavailable() }
      const r0 = track('reconf fisco fora', await request(app).post(`/v1/nfse/invoices/${tgt}/reconfirm`).set(a))
      fakeAdapter.queryDpsAccessKey = realDps
      expect([r0.status, r0.body.code]).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
      // D-F90: a prova é o E2404 explícito (`nfse_not_generated_at`), nunca o carimbo do rodízio
      const proof0 = (await q(`SELECT nfse_not_generated_at ng, last_event_at ea FROM vw_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = ?`, [INST, tgt, cand.attempt]))[0]
      expect(proof0.ng === null || proof0.ng <= proof0.ea).toBe(true)          // nada provado no escuro
      const r1 = track('reconf não acha', await request(app).post(`/v1/nfse/invoices/${tgt}/reconfirm`).set(a))
      expect(r1.body.data).toMatchObject({ needed: true, found: false, attempt: cand.attempt })
      const v1 = (await q(`${fiscal.transmissionViewSelect(ctx.fiscalDb)} WHERE v.tb_institution_id = ? AND v.tb_invoice_id = ? AND v.attempt = ?`, [INST, tgt, cand.attempt])).map(fiscal.mapTransmissionView)[0]
      expect(proven(v1)).toBe(true)
      generate('P', cand.dpsId)                                                 // agora o fisco tem a NFS-e daquele Id
      const r2 = track('reconf acha', await request(app).post(`/v1/nfse/invoices/${tgt}/reconfirm`).set(a))
      const after = await txRows(tgt)
      // eslint-disable-next-line no-console
      console.log('[adv] reconfirm acha →', r2.status, JSON.stringify(r2.body.data ?? r2.body), JSON.stringify(after.map(x => `${x.attempt}:${x.environment}:${x.lastKind}/${x.lastSource}:${x.accessKey ? 'CHAVE' : '-'}`)))
      expect(r2.body.data).toMatchObject({ needed: true, found: true })
      // o fato vem da VIEW real ('S'/'N' → boolean); a tentativa reconciliada com a NFS-e está registrada
      expect(fiscal.reconfirmationCandidate(after.map(x => ({ ...x, attempt: Number(x.attempt), authorityRecorded: x.authorityRecorded === 'S' })))).toBeNull()
    })

    it('K em voo bloqueia transmitir/cancelar; N só depois da carência; depois o cancelamento passa', async () => {
      const a = bearer(tok())
      const id = E
      if ((await txRows(id)).every(x => !x.accessKey)) expect((await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)).status).toBe(201)
      expect(['A', 'N']).toContain((await txRows(id)).find(x => !!x.accessKey)?.lastKind)
      fisco.eventMode = 'unavailable'
      const c1 = track('K 503', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'pedido de cancelamento sem resposta' }))
      expect([c1.status, c1.body.code]).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
      const kRow = async () => (await txRows(id)).find(x => !!x.accessKey)
      expect((await kRow()).lastKind).toBe('K')
      const t = track('K transmit', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect([t.status, t.body.code]).toEqual([409, 'FISCAL_CANCEL_IN_FLIGHT'])
      const c2 = track('K cancel', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'segunda tentativa com K em voo' }))
      expect([c2.status, c2.body.code]).toEqual([409, 'FISCAL_CANCEL_IN_FLIGHT'])
      const r1 = track('K refresh cedo', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      expect(r1.body.data.kind).toBe('K')
      await q(`UPDATE tb_invoice_service_transmission_event SET created_at = DATE_SUB(NOW(), INTERVAL 11 MINUTE) WHERE tb_institution_id = ? AND tb_invoice_id = ? AND kind = 'K'`, [INST, id])
      const r2 = track('K refresh carência', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      expect(r2.body.data.kind).toBe('N')
      fisco.eventMode = 'accept'
      const c3 = track('N cancel', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'agora o fisco responde' }))
      expect(c3.status).toBe(200)
      expect((await kRow()).lastKind).toBe('C')
    })
  })

  // =========================================================================
  describe('5. corrida na MESMA nota', () => {
    it('6 transmissões SIMULTÂNEAS (fisco lento) → 1 tentativa nova, DPS da vida intocado, contador intocado, nenhum 500', async () => {
      const a = bearer(tok())
      const id = F
      fisco.transmitDelay = 1500
      const n0 = await issuerN()
      const t0 = (await txRows(id)).length
      const rs = await Promise.all(Array.from({ length: 6 }, () => request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)))
      rs.forEach((r, i) => track(`corrida transmit ${i}`, r))
      // eslint-disable-next-line no-console
      console.log('[adv] corrida transmit', rs.map(r => `${r.status}:${r.body.code ?? r.body.data?.kind}`).join(' '), '| fisco.transmit =', fisco.calls.transmit)
      expect(rs.filter(r => r.status === 201)).toHaveLength(1)
      expect(rs.filter(r => r.status >= 500)).toHaveLength(0)
      expect(fisco.calls.transmit).toBe(1)
      expect((await txRows(id)).length).toBe(t0 + 1)
      expect((await q(`SELECT COUNT(*) n FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id]))[0].n).toBe(1)
      expect(await issuerN()).toBe(n0)                                          // a vida já tinha DPS: nDPS não é recunhado
    })

    it('[corrigido — MEDIUM] 6 cancelamentos SIMULTÂNEOS da mesma NFS-e (fisco lento, recusa duplicata como o real) → UM e101101; os outros 409 CANCEL_IN_FLIGHT', async () => {
      const a = bearer(tok())
      const id = F
      fisco.eventDelay = 800
      fisco.eventMode = 'dup-reject'
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: `cancelamento concorrente ${i} adversarial` })))
      rs.forEach((r, i) => track(`corrida cancel ${i}`, r))
      // eslint-disable-next-line no-console
      console.log('[adv] corrida cancel', rs.map(r => `${r.status}:${r.body.code ?? (r.body.data?.atAuthority ? 'C' : 'já')}`).join(' '), '| pedidos e101101 ao fisco =', fisco.calls.event)
      expect(rs.filter(r => r.status >= 500)).toHaveLength(0)
      expect((await lastOf(id)).lastKind).toBe('C')
      expect(fisco.calls.event).toBe(1)
      expect(rs.filter(r => r.status === 200)).toHaveLength(1)
      expect(rs.filter(r => r.status === 409).every(r => r.body.code === 'FISCAL_CANCEL_IN_FLIGHT')).toBe(true)
    })

    it('transmitir × cancelar no fisco concorrentes na MESMA nota autorizada → nenhum 500, fisco não recebe DPS', async () => {
      const a = bearer(tok())
      const id = A                                                               // autorizada no teste de licença
      fisco.eventDelay = 600
      const rs = await Promise.all([
        request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'transmitir x cancelar adversarial' }),
        request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a),
        request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a),
      ])
      rs.forEach((r, i) => track(`tx×cancel ${i}`, r))
      // eslint-disable-next-line no-console
      console.log('[adv] transmitir × cancelar', rs.map(r => `${r.status}:${r.body.code ?? 'ok'}`).join(' '))
      expect(rs.filter(r => r.status >= 500)).toHaveLength(0)
      expect(rs[0].status).toBe(200)
      expect(fisco.calls.transmit).toBe(0)
    })
  })

  // =========================================================================
  describe('6. vida que atravessa H → P (forma REAL: a 704 teve 13 tentativas em H e 4 em P no MESMO Id; a 8005 tem a 1ª em H)', () => {
    it('[corrigido — HIGH] 8005: envio ambíguo em P reconciliado pela consulta — a chave de PRODUÇÃO pousa numa tentativa de P e o cancelamento vai ao fisco de P', async () => {
      const a = bearer(tok())
      const id = HP
      const pre = await txRows(id)
      // eslint-disable-next-line no-console
      console.log('[adv] 8005 antes', JSON.stringify(pre.map(x => `${x.attempt}:${x.environment}:${x.lastKind}/${x.lastSource}`)), '| emissor', issuerBefore.environment)
      expect(pre[0].environment).toBe('H')
      fisco.transmitMode = 'generate-then-timeout'                              // o fisco de P GEROU a NFS-e; a resposta se perdeu
      const tP = track('HP ambíguo em P', await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a))
      expect(tP.status).toBe(503)
      const r = track('HP refresh', await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a))
      const rows = await txRows(id)
      // eslint-disable-next-line no-console
      console.log('[adv] 8005 depois do refresh', JSON.stringify(rows.map(x => `${x.attempt}:${x.environment}:${x.lastKind}/${x.lastSource}:${x.accessKey ? 'CHAVE' : '-'}`)), '| refresh', r.status, JSON.stringify(r.body.data ?? r.body))
      const holder = rows.find(x => !!x.accessKey)
      fisco.envs = []
      const c = track('HP cancel', await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'cancelar a NFS-e de produção' }))
      const after = await txRows(id)
      const v = track('HP view', await request(app).get(`/v1/nfse/invoices/${id}`).set(a))
      const savedUnderH = fs.existsSync(path.join(tmpRoot, CNPJ, 'H'))
      // eslint-disable-next-line no-console
      console.log('[adv] 8005 cancel →', c.status, c.body.code ?? '', '| ambiente usado no e101101:', fisco.envs.join(','), '| depois:', JSON.stringify(after.map(x => `${x.attempt}:${x.environment}:${x.lastKind}`)), '| view.state', v.body.data?.state, '| XML da NFS-e de P gravado na pasta H?', savedUnderH)
      expect(holder).toBeDefined()
      expect(holder!.environment).toBe('P')                                     // ACHADO HIGH se 'H'
      expect(fisco.envs).toContain('event:P')
    })
  })

  // =========================================================================
  describe('7. cofre (D-F16) e chave-mestra', () => {
    function pfxFor(cn: string, password = 'senha', days = 365): string {
      const keys = forge.pki.rsa.generateKeyPair(1024)
      const cert = forge.pki.createCertificate()
      cert.publicKey = keys.publicKey
      cert.serialNumber = '01' + Math.floor(Math.random() * 1e8).toString(16)
      cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
      cert.validity.notAfter = new Date(Date.now() + days * 86_400_000)
      const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
      cert.setSubject(attrs); cert.setIssuer(attrs)
      cert.sign(keys.privateKey, forge.md.sha256.create())
      const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
      return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64')
    }
    const certRow = async () => (await q(`SELECT fingerprint256, cnpj, cipher_key_version v FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0]

    it('A1 de OUTRO CNPJ / e-CPF / CN sem documento / senha errada / expirado → recusa SEM tocar o cofre', async () => {
      const a = bearer(tok())
      const before = await certRow()
      const cases: [string, string, string, number, string][] = [
        ['outro CNPJ', pfxFor('OUTRA EMPRESA LTDA:11222333000181'), 'senha', 409, 'FISCAL_CERT_INVALID'],
        ['e-CPF', pfxFor('FULANO DE TAL:12345678909'), 'senha', 409, 'FISCAL_CERT_INVALID'],
        ['CN sem documento', pfxFor('SEM DOCUMENTO'), 'senha', 409, 'FISCAL_CERT_INVALID'],
        ['senha errada', pfxFor(`SETES:${CNPJ}`), 'errada', 400, 'FISCAL_CERT_INVALID'],
        ['expirado', pfxFor(`SETES:${CNPJ}`, 'senha', -2), 'senha', 409, 'FISCAL_CERT_EXPIRED'],
      ]
      for (const [label, b64, pw, st, code] of cases) {
        const r = track(`cofre ${label}`, await request(app).put('/v1/emitter/certificate').set(a).send({ pfxBase64: b64, password: pw }))
        expect([label, r.status, r.body.code]).toEqual([label, st, code])
      }
      expect(await certRow()).toEqual(before)
    })

    it('chave-mestra ausente → /v1/health 503; transmitir 503; upload válido recusado ANTES de gravar', async () => {
      const noKey = createApp({ ...ctx, keyring: MasterKeyRing.of({}) })
      const h = track('health sem chave', await request(noKey).get('/v1/health'))
      expect([h.status, h.body.masterKey]).toEqual([503, false])
      const t = track('transmit sem chave', await request(noKey).post(`/v1/nfse/invoices/${C}/transmit`).set(bearer(tok())))
      expect([t.status, t.body.code]).toEqual([503, 'FISCAL_MASTER_KEY_UNAVAILABLE'])
      const before = await certRow()
      const u = track('upload sem chave', await request(noKey).put('/v1/emitter/certificate').set(bearer(tok())).send({ pfxBase64: pfxFor(`SETES:${CNPJ}`), password: 'senha' }))
      expect([u.status, u.body.code]).toEqual([503, 'FISCAL_MASTER_KEY_UNAVAILABLE'])
      expect(await certRow()).toEqual(before)
      expect(fisco.calls.transmit).toBe(0)
    })

    it('cifra COPIADA para outra institution não abre (AAD); chave-mestra trocada na mesma versão não abre — 409, nunca 500', async () => {
      await q(`INSERT INTO tb_establishment_certificate (tb_institution_id, cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version,
                 subject, issued_by, not_before, not_after, fingerprint256, tb_user_id, created_at, updated_at, deleted)
               SELECT 2, cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version, subject, issued_by, not_before, not_after,
                      fingerprint256, ?, NOW(), NOW(), 'N' FROM tb_establishment_certificate WHERE tb_institution_id = 1`, [ADV_USER])
      await q(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted, cutover_at) VALUES (2, 'SE', 'H', '1', 0, ?, NOW(), NOW(), 'N', NOW())`, [ADV_USER])
      await expect(fiscal.openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, 2, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_INVALID' })
      await expect(fiscal.openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, 1, 'SE')).resolves.toBeDefined()
      await expect(fiscal.openIssuer({ pool: ctx.pool, keyring: MasterKeyRing.of({ 1: Buffer.alloc(32, 7) }) }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_INVALID' })
      await expect(fiscal.openIssuer({ pool: ctx.pool, keyring: MasterKeyRing.of({ 2: Buffer.alloc(32, 9) }) }, 1, 'SE')).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' })
    })
  })

  // =========================================================================
  describe('8. disponibilidade', () => {
    it('[corrigido — MEDIUM] passadas do rodízio de institutions DIFERENTES com pool de 2 conexões: o ALUGUEL não retém conexão → terminam', async () => {
      const small = createFiscalPool({ ...ctx.db, connectionLimit: 2 })
      const deps = { ...ctx, pool: small }
      const run = Promise.all([
        refreshOpenServiceTransmissions(deps, { schemaName: SCHEMA, institutionId: 1, userId: ADV_USER }, { terminal: WEB, budgetMs: 2000 }),
        refreshOpenServiceTransmissions(deps, { schemaName: SCHEMA, institutionId: 2, userId: ADV_USER }, { terminal: WEB, budgetMs: 2000 }),
      ]).then(() => 'terminou')
      const outcome = await Promise.race([run, sleep(8000).then(() => 'TRAVADO')])
      // eslint-disable-next-line no-console
      console.log('[adv] 2 passadas × pool de 2 conexões →', outcome)
      try { await Promise.race([small.end(), sleep(2000)]) } catch { /* pool travado */ }
      expect(outcome).toBe('terminou')                                           // ACHADO se 'TRAVADO'
    })
  })

  // =========================================================================
  describe('9. contrato de leitura (D-F33) — a vigente do SQL do repositório = currentOf da biblioteca (socrático R2, LOW)', () => {
    it('para TODA vida do fiscal_api (inclusive a 704: 17 tentativas, chave na 17ª, e as que o ataque criou), as duas regras escolhem a MESMA tentativa', async () => {
      const repo = await import('../nfse/repository')
      const lives = await q(`SELECT DISTINCT tb_invoice_id AS inv, life_event AS life FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND deleted = 'N'`, [INST])
      const diverge: string[] = []
      for (const l of lives) {
        const bySql = await repo.latestTransmission(ctx.pool, refOf(INST, Number(l.inv)), Number(l.life))
        const { transmissions } = await repo.listLifeTransmissions(ctx.pool, refOf(INST, Number(l.inv)), Number(l.life))
        const byLib = fiscal.currentOf(transmissions)
        if ((bySql?.attempt ?? null) !== (byLib?.attempt ?? null)) diverge.push(`${l.inv}/${l.life}: sql ${bySql?.attempt} × lib ${byLib?.attempt}`)
      }
      // eslint-disable-next-line no-console
      console.log('[adv] vigente SQL × currentOf — vidas conferidas', lives.length, '| divergentes', JSON.stringify(diverge))
      expect(lives.length).toBeGreaterThan(3)
      expect(diverge).toEqual([])
    })
  })
})

// sanity para o describe.skip não deixar o arquivo "vazio" quando NFSE_ADV_LIVE não está ligado
if (!LIVE) it('adversarial live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
