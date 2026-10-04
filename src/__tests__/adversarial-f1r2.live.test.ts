/// <reference types="jest" />
// GATE ADVERSARIAL da F1 — 2ª RODADA ao vivo (testar-adversarial.md, 2026-10-04): BANCO REAL do dev +
// FISCO FALSO. ⚠️ Só roda com NFSE_ADV_LIVE=1. Mesmo isolamento da 1ª rodada (`adversarial-f1.live.test.ts`):
// adaptador falso E transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real);
// escreve SÓ no `fiscal_api` (o usuário do .env só tem SELECT no ERP) e num storage temporário. Linhas do
// ataque marcadas com tb_user_id 990002; o afterAll devolve o `fiscal_api` ao estado de antes e CONFERE por
// CHECKSUM TABLE (falha a suíte se sobrar resíduo).
// `it.failing` = achado CONFIRMADO (passa enquanto o bug existe). Cada achado tem um `it` de CENÁRIO antes
// (pré-condições normais — se o cenário não se monta, falha de verdade; o it.failing só confere o desfecho).
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r2.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import { refreshOpenServiceTransmissions, resetMunicipalTermsCache, IN_FLIGHT_MINUTES, REFRESH_MIN_MINUTES } from '../nfse/transmission'
import { listRefreshCandidates, countLiveTransmissions } from '../nfse/repository'

// mesma normalização EM MEMÓRIA da 1ª rodada: o ramo congelado das notas do dev tem cTribMun "0102" (anterior
// à D-N26b) → 422 antes de reservar. Nada é escrito no ERP.
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
jest.setTimeout(180_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const SCHEMA = 'setes_setes'
const ADV_USER = 990002                    // marca as linhas do ataque
const LEASE_INST = 990002                  // institution FICTÍCIA só no fiscal_api (linha de habilitação do aluguel)
const NO_ISSUER_INST = 990003              // institution FICTÍCIA sem habilitação nenhuma
const CNPJ = '07742094000113'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
type TransmitMode = 'authorize' | 'reject' | 'unavailable'
type EventMode = 'accept' | 'crash'
interface Rec { key: string; xml: string; n: string; dpsId: string; env: string }
const fisco = {
  recs: new Map<string, Rec>(),
  cancelled: new Set<string>(),
  transmitMode: 'authorize' as TransmitMode,
  eventMode: 'accept' as EventMode,
  eventDelay: 0,
  calls: { transmit: 0, query: 0, dps: 0, event: 0 },
}
let seq = 0
const newKey = (dpsId: string) => (`8${dpsId.slice(-12)}${String(Date.now()).slice(-9)}${String(++seq).padStart(4, '0')}`).padEnd(50, '7').slice(0, 50)
const nfseXml = (key: string, dpsId: string, n: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${n}</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
function generate(env: string, dpsId: string): Rec {
  const k = `${env}:${dpsId}`
  let rec = fisco.recs.get(k)
  if (!rec) {
    const key = newKey(dpsId)
    const n = String(800000 + seq)
    rec = { key, xml: nfseXml(key, dpsId, n), n, dpsId, env }
    fisco.recs.set(k, rec)
  }
  return rec
}
const rejected = () => new AuthorityHttpError(422, 'Fisco rejeitou (400): E0001: teste adversarial r2', 'FISCAL_DPS_REJECTED', 400,
  '{"erros":[{"codigo":"E0001","descricao":"teste adversarial r2"}]}', [{ field: 'dps', message: 'E0001: teste adversarial r2' }])
const unavailable = () => new AuthorityHttpError(503, 'Fisco indisponível (falso)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')

const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit(ctx: AuthorityContext, xml: string) {
    fisco.calls.transmit++
    const dpsId = /<infDPS\b[^>]*\sId="([^"]*)"/.exec(xml)![1]
    if (fisco.transmitMode === 'reject') throw rejected()
    if (fisco.transmitMode === 'unavailable') throw unavailable()
    const rec = generate(ctx.environment, dpsId)
    return { accessKey: rec.key, nfseNumber: rec.n, dhProc: '2026-10-04T10:00:00-03:00', nfseXml: rec.xml, raw: {} }
  },
  async queryNfse(ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    const rec = [...fisco.recs.values()].find(r => r.key === accessKey && r.env === ctx.environment)
    if (!rec) throw notFound()
    if (fisco.cancelled.has(accessKey)) {
      return { accessKey, status: 'cancelled' as const, nfseXml: rec.xml, dhProc: '2026-10-04T10:00:00-03:00', cancelled: { dhEvento: '2026-10-04T10:05:00-03:00', motive: 'falso', eventXml: null } }
    }
    return { accessKey, status: 'authorized' as const, nfseXml: rec.xml, dhProc: '2026-10-04T10:00:00-03:00' }
  },
  async queryDpsAccessKey(ctx: AuthorityContext, dpsId: string) {
    fisco.calls.dps++
    return fisco.recs.get(`${ctx.environment}:${dpsId}`)?.key ?? null
  },
  async registerEvent(ctx: AuthorityContext, accessKey: string) {
    fisco.calls.event++
    if (fisco.eventDelay) await sleep(fisco.eventDelay)
    // 'crash': o processo da nfse-api "morre" entre o K da reserva e o fisco (nada chegou ao fisco)
    if (fisco.eventMode === 'crash') throw new Error('ADVERSARIAL r2: processo caiu antes de o pedido sair')
    const rec = [...fisco.recs.values()].find(r => r.key === accessKey && r.env === ctx.environment)
    if (!rec) throw notFound()
    fisco.cancelled.add(accessKey)
    return { dhEvento: '2026-10-04T10:05:00-03:00', protocol: `EVT${accessKey}`, eventXml: `<evento><chNFSe>${accessKey}</chNFSe></evento>`, raw: {} }
  },
  async municipalTerms() { return { cancelDays: null, raw: null } },
}
function resetFisco(): void {
  Object.assign(fisco, { transmitMode: 'authorize', eventMode: 'accept', eventDelay: 0 })
  fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0 }
}

// storage: LÊ o arquivo fiscal real, ESCREVE só num temporário
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r2-'))
class SandboxStorage implements FiscalStorage {
  constructor(private real: FiscalStorage, private tmp: FsFiscalStorage) {}
  save(...a: Parameters<FiscalStorage['save']>) { return this.tmp.save(...a) }
  find(...a: Parameters<FiscalStorage['find']>) { return this.tmp.find(...a) ?? this.real.find(...a) }
  read(ref: string) { return fs.readFileSync(ref, 'utf8') }
  probe() { return this.tmp.probe() }
}

let privPem = ''
const tok = (claims: any = {}) =>
  jwt.sign({ institutionId: INST, userId: ADV_USER, role: 'admin', schemaName: SCHEMA, ...claims }, privPem, { algorithm: 'RS256', keyid: 'default', expiresIn: '1h' })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

let ctx: AppContext
let harness: DisposableFiscalDb
let app: any            // cerca DESLIGADA (o ataque exercita a máquina da voz — fisco falso)
let appFenced: any      // a MESMA app — a cerca é o FATO da habilitação (D-F39); `asReplica()` liga-a NA CÓPIA no trecho que a testa
let appNoIdentity: any  // institutions fictícias (sem conferência de identidade no ERP)
const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]

const TABLES = ['tb_establishment_issuer', 'tb_establishment_certificate', 'tb_invoice_service_dps', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']
const checksums = async () => Object.fromEntries((await q(`CHECKSUM TABLE ${TABLES.join(', ')}`)).map(r => [r.Table, String(r.Checksum)]))

let sumsBefore: Record<string, string> = {}
let issuerBefore: any
let certBefore: any
const maxAttemptBefore = new Map<number, number>()
const dpsBefore = new Set<number>()
const TOUCHED: number[] = []

async function txRows(invoiceId: number) {
  return q(`SELECT attempt, environment, access_key AS accessKey, last_kind AS lastKind, last_source AS lastSource, dps_id AS dpsId
              FROM vw_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt`, [INST, invoiceId])
}
const lastOf = async (id: number) => { const r = await txRows(id); return r[r.length - 1] }
const newAttempts = async (id: number) => (await txRows(id)).filter(r => Number(r.attempt) > (maxAttemptBefore.get(id) ?? 0))
async function restoreCertificate(): Promise<void> {
  await q(`UPDATE tb_establishment_certificate SET certificate_pem = ?, deleted = ?, updated_at = ?, tb_user_id = ? WHERE tb_institution_id = ?`,
    [certBefore.certificate_pem, certBefore.deleted, certBefore.updated_at, certBefore.tb_user_id, INST])
}

d('GATE ADVERSARIAL F1 — 2ª rodada — banco real + fisco falso', () => {
  let X = 0, W = 0, V = 0, Z = 0

  beforeAll(async () => {
    require('dotenv').config({ path: path.join(ROOT, '.env') })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r2: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    // gates R4: o ataque roda numa CÓPIA descartável do fiscal_api (virada SÓ na cópia) — o real nunca é virado
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_r2', { turned: true })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    process.chdir(cwd)
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.adapter).toBe(fakeAdapter)
    app = createApp(ctx)
    appFenced = app
    appNoIdentity = createApp({ ...ctx, checkIdentity: false })
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

    sumsBefore = await checksums()
    issuerBefore = (await q(`SELECT environment, serie, dps_last_number, tb_user_id, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
                                    DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS refresh_lease_until, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutover_at
                               FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
    certBefore = (await q(`SELECT certificate_pem, deleted, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at, tb_user_id
                             FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0]
    expect(certBefore?.certificate_pem).toBeTruthy()
    for (const r of await q(`SELECT tb_invoice_id AS id, MAX(attempt) AS m FROM tb_invoice_service_transmission WHERE tb_institution_id = ? GROUP BY tb_invoice_id`, [INST])) maxAttemptBefore.set(Number(r.id), Number(r.m))
    for (const r of await q(`SELECT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])) dpsBefore.add(Number(r.id))
    const stray = await q(`SELECT COUNT(*) n FROM tb_establishment_issuer WHERE tb_institution_id IN (?, ?)`, [LEASE_INST, NO_ISSUER_INST])
    expect(Number(stray[0].n)).toBe(0)

    const svc = await import('../facts/service-facts')
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E' ORDER BY i.id DESC LIMIT 400`, [INST])
    const fresh: number[] = []
    for (const r of rows) {
      const id = Number(r.id)
      if (maxAttemptBefore.has(id) || dpsBefore.has(id)) continue
      try {
        const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, INST, id)
        await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
        fresh.push(id)
      } catch { /* cadastro incompleto — não serve de alvo */ }
      if (fresh.length >= 4) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r2] notas-alvo frescas', fresh.join(','))
    expect(fresh.length).toBe(4)
    ;[X, W, V, Z] = fresh
    TOUCHED.push(X, W, V, Z)
  })

  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    if (!ctx) return
    let after: Record<string, string> = {}
    try {
      await restoreCertificate()
      for (const id of TOUCHED) {
        const before = maxAttemptBefore.get(id) ?? 0
        await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        await q(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        if (!dpsBefore.has(id)) await q(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
      }
      await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_user_id = ?`, [INST, ADV_USER])
      await q(`UPDATE tb_establishment_issuer SET environment = ?, serie = ?, dps_last_number = ?, tb_user_id = ?, updated_at = ?, refresh_lease_until = ?, cutover_at = ?
                WHERE tb_institution_id = ? AND model = 'SE'`,
        [issuerBefore.environment, issuerBefore.serie, issuerBefore.dps_last_number, issuerBefore.tb_user_id, issuerBefore.updated_at, issuerBefore.refresh_lease_until, issuerBefore.cutover_at, INST])
      await q(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id IN (?, ?)`, [LEASE_INST, NO_ISSUER_INST])
      after = await checksums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r2] CHECKSUM antes', JSON.stringify(sumsBefore), '| depois', JSON.stringify(after))
      await harness.drop()                                 // apaga a cópia e confere o fiscal_api REAL intocado
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (JSON.stringify(after) !== JSON.stringify(sumsBefore)) throw new Error('RESÍDUO no fiscal_api depois do ataque — conferir as tabelas')
  })

  // =========================================================================
  // D-F39: "na cerca" = habilitação RÉPLICA (cutover_at NULL) — o estado real da institution 1; o resto do ataque a vira
  const asReplica = () => q(`UPDATE tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
  const asTurned = () => q(`UPDATE tb_establishment_issuer SET cutover_at = NOW() WHERE tb_institution_id = ? AND model = 'SE'`, [INST])

  describe('A. cerca da virada (regressão do retrabalho) — institution na cerca, rota a rota', () => {
    beforeAll(async () => { if (ctx) await asReplica() })
    afterAll(async () => { if (ctx) await asTurned() })
    it('toda AÇÃO e escrita do emitente → 409 FISCAL_CUTOVER_PENDING; as LEITURAS respondem e NÃO escrevem nada (CHECKSUM igual)', async () => {
      const a = bearer(tok())
      const s0 = await checksums()
      for (const [m, p, body] of [
        ['post', `/v1/nfse/invoices/${X}/transmit`, undefined], ['post', `/v1/nfse/invoices/8011/refresh`, undefined],
        ['post', `/v1/nfse/invoices/8005/reconfirm`, undefined], ['post', `/v1/nfse/invoices/8011/cancel`, { reason: 'cerca da virada adversarial' }],
        ['post', '/v1/nfse/refresh', {}], ['put', '/v1/emitter/certificate', { pfxBase64: 'QUJD', password: '' }],
        ['delete', '/v1/emitter/certificate', undefined], ['put', '/v1/emitter/issuers/SE', { environment: 'H', serie: '1' }],
        ['delete', '/v1/emitter/issuers/SE', undefined],
      ] as const) {
        const r = await (request(appFenced) as any)[m](p).set(a).send(body)
        expect([m, p, r.status, r.body.code]).toEqual([m, p, 409, 'FISCAL_CUTOVER_PENDING'])
      }
      const reads: [string, number][] = []
      for (const p of ['/v1/nfse/invoices/8011', '/v1/nfse/invoices/8011/xml', '/v1/nfse/invoices/8011/danfse', `/v1/nfse/invoices/${X}`,
        '/v1/nfse/invoices/pending?pageSize=5', '/v1/emitter', '/v1/nfse/invoices/2147483647']) {
        const r = await request(appFenced).get(p).set(a)
        reads.push([p, r.status])
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r2] leituras na cerca', JSON.stringify(reads))
      expect(reads.every(([, st]) => st === 200 || st === 404)).toBe(true)
      expect(await checksums()).toEqual(s0)
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0 })
    })
  })

  // =========================================================================
  describe('A2. migrate:setes (D-F18) — re-sincronia FALHA ALTO em dual-write (antes de qualquer tentativa do ataque)', () => {
    beforeAll(async () => { if (ctx) await asReplica() })          // a re-sincronia só COPIA réplica (virada = congelada)
    afterAll(async () => { if (ctx) await asTurned() })
    const runDry = () => spawnSync('npm', ['run', 'migrate:setes', '--', '--dry-run'], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 150_000, env: { ...process.env, ...harness.env } })

    it('tentativa no fiscal_api que a origem não tem (institution da cerca) → exit ≠ 0 "dual-write", nada gravado; sem ela → exit 0', async () => {
      const id = Z
      const life = (await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, INST, id))!.lifeEvent!
      const dpsId = `DPS4106902${'2'}${CNPJ}00001${'999999999'.padStart(15, '0')}`
      expect(dpsId).toHaveLength(45)
      const attempt = (maxAttemptBefore.get(id) ?? 0) + 1
      await q(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
               VALUES (?, ?, 0, ?, '1', 999999999, ?, ?, NOW(), NOW(), 'N')`, [INST, id, life, dpsId, ADV_USER])
      await q(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, tb_user_id, created_at, updated_at, deleted)
               VALUES (?, ?, 0, ?, ?, 'H', ?, NOW(), NOW(), 'N')`, [INST, id, attempt, life, ADV_USER])
      let dual: ReturnType<typeof runDry> | undefined
      try {
        dual = runDry()
      } finally {
        await q(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = ?`, [INST, id, attempt])
        await q(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ? AND dps_id = ?`, [INST, id, dpsId])
      }
      const clean = runDry()
      // eslint-disable-next-line no-console
      console.log('[adv-r2] migrate:setes com dual-write → exit', dual!.status, '|', (dual!.stderr || '').split('\n').filter(l => /FALHA|dual/.test(l)).join(' ').slice(0, 300), '| limpo → exit', clean.status)
      expect(dual!.status).not.toBe(0)
      expect(String(dual!.stderr)).toMatch(/dual-write/)
      expect(clean.status).toBe(0)
    })
  })

  // =========================================================================
  describe('B. DELETE do A1 × reserva em curso — REPEATABLE READ', () => {
    // A reserva abre a transação da nota, faz a 1ª leitura NÃO travante (latestTransmission → o snapshot nasce
    // aqui) e SÓ DEPOIS pede o FOR UPDATE da habilitação SE. O DELETE do A1 (`removeCertificate`) trava a
    // habilitação, confere zero viva e apaga o A1. A reserva que esperava a trava acorda, lê a habilitação
    // fresca (FOR UPDATE) mas o CERTIFICADO por leitura consistente = o SNAPSHOT de antes do DELETE: assina com
    // o A1 apagado, cunha nDPS e manda ao fisco — a guarda "recusa com transmissão viva" é contornada.
    // Simulação fiel do removeCertificate: trava a habilitação SE, conta vivas (0), apaga o certificado
    // (PEM NULL + deleted 'S' — a chave cifrada NÃO é tocada) e COMMIT. O certificado é restaurado no fim.
    const out: { blockedSeen: boolean; freshAfterDelete: string; status: number; code: string; transmits: number; attempts: any[] } = {
      blockedSeen: false, freshAfterDelete: '', status: 0, code: '', transmits: 0, attempts: [],
    }

    it('cenário: a reserva PARA na trava da habilitação; o A1 é apagado e QUEM LÊ AGORA já não o vê', async () => {
      fisco.transmitMode = 'reject'                                    // desfecho do fisco falso: R (a tentativa fecha)
      const blocker = await ctx.pool.getConnection()
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        await blocker.query(`SELECT tb_institution_id FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N' FOR UPDATE`, [INST])
        expect(await countLiveTransmissions(blocker, INST)).toBe(0)     // a guarda do DELETE deixaria apagar
        const pending = request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(r => r)
        const t0 = Date.now()
        while (Date.now() - t0 < 20_000) {
          const pl = (await q('SHOW FULL PROCESSLIST')) as any[]
          if (pl.some(p => Number(p.Id) !== Number(cid) && /tb_establishment_issuer/.test(String(p.Info ?? '')) && /FOR UPDATE/i.test(String(p.Info ?? '')))) { out.blockedSeen = true; break }
          await sleep(40)
        }
        await blocker.query(`UPDATE tb_establishment_certificate SET certificate_pem = NULL, deleted = 'S' WHERE tb_institution_id = ?`, [INST])
        await blocker.commit()
        out.freshAfterDelete = await fiscal.openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, INST, 'SE').then(() => 'abriu', (e: any) => String(e?.code))
        const r = await pending
        out.status = r.status; out.code = r.body?.code ?? (r.body?.ok ? 'ok' : '')
        out.transmits = fisco.calls.transmit
        out.attempts = await newAttempts(X)
      } finally {
        try { await blocker.rollback() } catch { /* já comitado */ }
        blocker.release()
        await restoreCertificate()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r2] DELETE do A1 × reserva:', JSON.stringify({ ...out, attempts: out.attempts.map(a => `${a.attempt}:${a.environment}:${a.lastKind}`) }))
      expect(out.blockedSeen).toBe(true)
      expect(out.freshAfterDelete).toBe('FISCAL_CERT_MISSING')
      expect((await q(`SELECT deleted FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0].deleted).toBe('N')   // restaurado
    })

    it('[corrigido — MEDIUM] a reserva que esperava a trava acorda e vê o A1 ATUAL (apagado): 409 FISCAL_CERT_MISSING, nada reservado, nada ao fisco', () => {
      expect([out.status, out.code]).toEqual([409, 'FISCAL_CERT_MISSING'])
      expect(out.transmits).toBe(0)
      expect(out.attempts).toHaveLength(0)
    })
  })

  // =========================================================================
  describe('C. ALUGUEL do rodízio (migration 002)', () => {
    const slowList = (ms: number) => new Proxy(ctx.pool, {
      get(target: any, prop, recv) {
        if (prop === 'query') {
          return async (sql: string, params?: any) => {
            if (/vw_invoice_life/.test(String(sql))) await sleep(ms)                   // a passada "demora" (fisco lento)
            return target.query(sql, params)
          }
        }
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const actor = { schemaName: SCHEMA, institutionId: LEASE_INST, userId: ADV_USER }
    const lease = async () => (await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [LEASE_INST]))[0]?.u ?? null
    const run: { aSkipped?: boolean; bSkipped?: boolean; cSkipped?: boolean; leaseAfterA?: string | null; cStart?: number; bEnd?: number } = {}

    beforeAll(async () => {
      if (!ctx) return
      await q(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted, cutover_at)
               VALUES (?, 'SE', 'H', '1', 0, ?, NOW(), NOW(), 'N', NOW())`, [LEASE_INST, ADV_USER])
    })

    it('regressão: 2ª passada enquanto a 1ª está DENTRO do aluguel → skipped (uma passada por estabelecimento)', async () => {
      const deps = { ...ctx, pool: slowList(1500) as any }
      const p1 = refreshOpenServiceTransmissions(deps, actor, { budgetMs: 5000 })
      await sleep(200)
      const r2 = await refreshOpenServiceTransmissions(deps, actor, { budgetMs: 5000 })
      const r1 = await p1
      expect([r1.skipped, r2.skipped]).toEqual([false, true])
      expect(await lease()).toBeNull()
    })

    it('cenário: a passada A ESTOURA os 60 s do aluguel (o orçamento de 20 s só é conferido ENTRE notas; cada chamada ao fisco tem 30 s de inatividade × 2 + espera da trava da nota) → B toma o aluguel vencido; A termina e devolve…', async () => {
      const deps = { ...ctx, pool: slowList(3000) as any }
      const pA = refreshOpenServiceTransmissions(deps, actor, { budgetMs: 10_000 })
      await sleep(800)
      await q(`UPDATE tb_establishment_issuer SET refresh_lease_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE tb_institution_id = ? AND model = 'SE'`, [LEASE_INST])  // = 60 s se passaram
      await sleep(200)
      const pB = refreshOpenServiceTransmissions(deps, actor, { budgetMs: 10_000 }).then(r => { run.bEnd = Date.now(); return r })
      const rA = await pA
      run.leaseAfterA = await lease()
      run.cStart = Date.now()
      const pC = refreshOpenServiceTransmissions(deps, actor, { budgetMs: 10_000 })
      const [rB, rC] = await Promise.all([pB, pC])
      Object.assign(run, { aSkipped: rA.skipped, bSkipped: rB.skipped, cSkipped: rC.skipped })
      // eslint-disable-next-line no-console
      console.log('[adv-r2] aluguel A/B/C', JSON.stringify({ ...run, bStillRunningWhenCStarted: (run.bEnd ?? 0) > (run.cStart ?? 0) }))
      expect([rA.skipped, rB.skipped]).toEqual([false, false])        // B tomou o aluguel VENCIDO de A (correto)
      expect(run.bEnd!).toBeGreaterThan(run.cStart!)                  // C começou com B ainda rodando
      expect(await lease()).toBeNull()
    })

    it('[corrigido — LOW] a passada que estourou NÃO apaga o aluguel da seguinte (devolução só pelo dono) → a 3ª é pulada', () => {
      expect(run.leaseAfterA).not.toBeNull()
      expect(run.cSkipped).toBe(true)
    })

    it('cenário: institution SEM habilitação SE nenhuma (nem viva nem excluída)', async () => {
      expect((await q(`SELECT COUNT(*) n FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [NO_ISSUER_INST]))[0].n).toBe(0)
    })

    it('[corrigido — LOW] a passada de institution SEM habilitação responde 409 FISCAL_ISSUER_MISSING (nunca "outra passada em curso")', async () => {
      const outcome = await refreshOpenServiceTransmissions(ctx, { schemaName: SCHEMA, institutionId: NO_ISSUER_INST, userId: ADV_USER })
        .then(r => (r.skipped ? 'skipped' : 'ran'), (e: any) => (e instanceof HttpError ? String(e.code) : 'erro'))
      expect(outcome).toBe('FISCAL_ISSUER_MISSING')
    })
  })

  // =========================================================================
  describe('D. K da reserva do cancelamento', () => {
    it('processo MORTO entre o K e o fisco: K bloqueia transmitir/cancelar; o rodízio a pega; N só depois da carência (10 min) e da próxima passada; aí cancela', async () => {
      const a = bearer(tok())
      const id = W
      const actor = { schemaName: SCHEMA, institutionId: INST, userId: ADV_USER }
      expect((await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)).status).toBe(201)
      fisco.eventMode = 'crash'
      const c1 = await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'processo cai depois do K adversarial' })
      expect((await lastOf(id)).lastKind).toBe('K')
      const blockedT = await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)
      const blockedC = await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'segunda tentativa com K preso' })
      expect([blockedT.body.code, blockedC.body.code]).toEqual(['FISCAL_CANCEL_IN_FLIGHT', 'FISCAL_CANCEL_IN_FLIGHT'])
      const cands = await listRefreshCandidates(ctx.pool, SCHEMA, INST, REFRESH_MIN_MINUTES, IN_FLIGHT_MINUTES, 50)
      expect(cands.some(t => t.invoiceId === id && t.lastKind === 'K')).toBe(true)                   // o rodízio PEGA o K
      const pass1 = await refreshOpenServiceTransmissions(ctx, actor)
      expect((await lastOf(id)).lastKind).toBe('K')                                                  // antes da carência: nada
      // envelhece o K (fato do ataque) e o "nós olhamos" (a passada seguinte só volta depois de minMinutes)
      await q(`UPDATE tb_invoice_service_transmission_event SET created_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE tb_institution_id = ? AND tb_invoice_id = ? AND kind = 'K'`, [IN_FLIGHT_MINUTES + 1, INST, id])
      await q(`UPDATE tb_invoice_service_transmission SET last_queried_at = DATE_SUB(NOW(), INTERVAL ? MINUTE) WHERE tb_institution_id = ? AND tb_invoice_id = ? AND access_key IS NOT NULL`, [REFRESH_MIN_MINUTES + 1, INST, id])
      const pass2 = await refreshOpenServiceTransmissions(ctx, actor)
      expect((await lastOf(id)).lastKind).toBe('N')
      fisco.eventMode = 'accept'
      const c2 = await request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'agora o pedido sai de verdade' })
      // eslint-disable-next-line no-console
      console.log('[adv-r2] K preso:', JSON.stringify({ cancelCrash: [c1.status, c1.body.code], pass1: { checked: pass1.checked, changed: pass1.changed }, pass2: { checked: pass2.checked, changed: pass2.changed }, cancelDepois: c2.status }))
      expect(c2.status).toBe(200)
      expect((await lastOf(id)).lastKind).toBe('C')
      expect(await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d') u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST])).toEqual([{ u: null }])
    })

    it('cancelar × consultar com o K gravado e o fisco LENTO: a consulta vê K (sem N antes da carência) e o cancelamento fecha C — um e101101 só', async () => {
      const a = bearer(tok())
      const id = V
      expect((await request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a)).status).toBe(201)
      fisco.eventDelay = 1500
      const pc = request(app).post(`/v1/nfse/invoices/${id}/cancel`).set(a).send({ reason: 'cancelar com fisco lento adversarial' }).then(r => r)
      await sleep(400)
      const rr = await request(app).post(`/v1/nfse/invoices/${id}/refresh`).set(a)
      const c = await pc
      const kinds = (await q(`SELECT e.kind FROM tb_invoice_service_transmission_event e WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.attempt > ? ORDER BY e.attempt, e.event`, [INST, id, maxAttemptBefore.get(id) ?? 0])).map(r => r.kind).join('')
      // eslint-disable-next-line no-console
      console.log('[adv-r2] cancelar × consultar:', rr.status, JSON.stringify(rr.body.data ?? rr.body), '| cancel', c.status, '| vozes', kinds, '| e101101', fisco.calls.event)
      expect(rr.body.data).toMatchObject({ kind: 'K', changed: false })
      expect(c.status).toBe(200)
      expect(kinds).toBe('AKC')
      expect(fisco.calls.event).toBe(1)
    })
  })

  // =========================================================================
  describe('E. pendentes paginados', () => {
    it('page gigante → página vazia com o MESMO total; page acima do teto → 400; usuário sem ramo contratado → vazio; tempo do COUNT medido', async () => {
      const a = bearer(tok())
      const t0 = Date.now()
      const p1 = await request(app).get('/v1/nfse/invoices/pending?page=1&pageSize=100').set(a)
      const ms = Date.now() - t0
      const big = await request(app).get('/v1/nfse/invoices/pending?page=100000&pageSize=100').set(a)
      const over = await request(app).get('/v1/nfse/invoices/pending?page=100001&pageSize=100').set(a)
      const none = await request(appNoIdentity).get('/v1/nfse/invoices/pending').set(bearer(tok({ institutionId: NO_ISSUER_INST, role: 'user' })))
      // eslint-disable-next-line no-console
      console.log('[adv-r2] pendentes: total', p1.body.total, '| 1ª página em', ms, 'ms | page 100000', big.status, big.body.data?.length, big.body.total, '| 100001', over.status, '| sem ramo', none.status, none.body.total)
      expect(p1.status).toBe(200)
      expect([big.status, big.body.data, big.body.total]).toEqual([200, [], p1.body.total])
      expect([over.status, over.body.code]).toEqual([400, 'VALIDATION_FAILED'])
      expect([none.status, none.body.total, none.body.data]).toEqual([200, 0, []])
    })
  })

})

// sanity para o describe.skip não deixar o arquivo "vazio" quando NFSE_ADV_LIVE não está ligado
if (!LIVE) it('adversarial r2 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
