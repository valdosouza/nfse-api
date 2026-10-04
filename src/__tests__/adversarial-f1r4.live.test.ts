/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA da RODADA 4 (D-F36…D-F40) — AO VIVO: banco REAL do dev + FISCO FALSO + banco DESCARTÁVEL.
// ⚠️ Só roda com NFSE_ADV_LIVE=1. Isolamento (mesmo das rodadas 1–3):
//  - adaptador FALSO e o transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real); o smoke e o
//    migrate rodam em processo filho SEM `--vai` (o smoke só confere — lido no código: retorna antes do adaptador);
//  - o ERP é só LIDO (o usuário do serviço só tem SELECT; a trava da nota é FOR UPDATE de leitura) — CHECKSUM das tabelas
//    do ERP antes/depois;
//  - `fiscal_api` REAL: a institution 1 é RÉPLICA (cutover_at NULL — o estado real); as seções A (réplica) e B (virada SÓ
//    durante o ataque, como a r3) escrevem linhas SINTÉTICAS (nota fresca, tb_user_id 990004) que são APAGADAS; a
//    habilitação volta COMPLETA; CHECKSUM TABLE igual no fim (falha a suíte se sobrar resíduo);
//  - seção C: banco DESCARTÁVEL `fiscal_api_adv4` (usuário do ../setes-api/.env, que cria banco) — migrations + cópia do
//    `fiscal_api`; a VIRADA real, o `--cutover` e as adulterações acontecem SÓ nele; APAGADO no fim (SHOW DATABASES igual).
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r4.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError, createFiscalPool, runMigrations, dbConfigFromEnv } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb } from './live-harness'
import { createApp } from '../app'
import { MIGRATION_SETS } from '../migrations'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions, resetMunicipalTermsCache,
} from '../nfse/transmission'
import { listRefreshCandidates } from '../nfse/repository'

// mesma normalização EM MEMÓRIA das rodadas 1–3: o ramo congelado das notas do dev tem cTribMun "0102" (anterior à D-N26b)
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
jest.setTimeout(300_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const SCHEMA = 'setes_setes'
const ADV_USER = 990004
const CNPJ = '07742094000113'
const ADV_DB = 'fiscal_api_adv4'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dbConfigFromEnvSafe = () => ({ ...dbConfigFromEnv(process.env), database: 'fiscal_api' })

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R4</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
const fisco = {
  byKey: new Map<string, string>(),                     // chave → Id do DPS (as NFS-e sintéticas "existem" no fisco falso)
  calls: { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 },
  termsDelayMs: 0,
  termsCancelDays: 60 as number | null,
}
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() { fisco.calls.transmit++; throw new AuthorityHttpError(422, 'Fisco rejeitou (falso)', 'FISCAL_DPS_REJECTED', 400, '{"erros":[{"codigo":"E0001"}]}', [{ field: 'dps', message: 'E0001' }]) },
  async queryNfse(_ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    const dpsId = fisco.byKey.get(accessKey)
    if (!dpsId) throw notFound()
    return { accessKey, status: 'authorized' as const, nfseXml: nfseXml(accessKey, dpsId), dhProc: '2026-10-04T10:00:00-03:00' }
  },
  async queryDpsAccessKey(_ctx: AuthorityContext, dpsId: string) {
    fisco.calls.dps++
    return [...fisco.byKey.entries()].find(([, id]) => id === dpsId)?.[0] ?? null
  },
  async registerEvent() { fisco.calls.event++; throw notFound() },
  async municipalTerms() {
    fisco.calls.terms++
    if (fisco.termsDelayMs) await sleep(fisco.termsDelayMs)
    return { cancelDays: fisco.termsCancelDays, raw: null }
  },
}
function resetFisco(): void {
  fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 }
  fisco.termsDelayMs = 0
  fisco.termsCancelDays = 60
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r4-'))
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
const ACTOR = { schemaName: SCHEMA, institutionId: INST, userId: ADV_USER }

let ctx: AppContext
let harness: DisposableFiscalDb
let app: any
const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]

const FISCAL_TABLES = ['tb_establishment_issuer', 'tb_establishment_certificate', 'tb_invoice_service_dps', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event', '_migrations']
const ERP_TABLES = ['tb_establishment_issuer', 'tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_invoice_service_transmission',
  'tb_invoice_service_transmission_event', 'tb_institution_has_interface', 'tb_user_has_privilege'].map(t => `${SCHEMA}.${t}`)
const checksumsOf = async (db: string, tables: string[], run = q) =>
  Object.fromEntries((await run(`CHECKSUM TABLE ${tables.map(t => (t.includes('.') ? t : `${db}.${t}`)).join(', ')}`)).map((r: any) => [r.Table, String(r.Checksum)]))
const fiscalSums = () => checksumsOf(ctx.fiscalDb, FISCAL_TABLES)      // a CÓPIA do ataque (o real é conferido pelo harness)
const erpSums = () => checksumsOf(SCHEMA, ERP_TABLES)
/** SHOW DATABASES pelo usuário do setes-api: o do serviço só VÊ os bancos em que tem privilégio (não veria o descartável). */
let rootPool: ReturnType<typeof createFiscalPool>
const databases = async () => ((await rootPool.query<any[]>('SHOW DATABASES'))[0]).map((r: any) => String(r.Database)).sort().join(',')

let sumsBefore: Record<string, string> = {}
let erpBefore: Record<string, string> = {}
let dbsBefore = ''
let issuerBefore: any
const SYN: number[] = []                       // notas frescas que recebem linhas sintéticas (apagadas no fim)
let X = 0, OLD = 0, RECENT = 0

async function restoreIssuer(): Promise<void> {
  const i = issuerBefore
  await q(`UPDATE tb_establishment_issuer SET environment = ?, serie = ?, dps_last_number = ?, refresh_lease_until = ?, tb_user_id = ?,
             created_at = ?, updated_at = ?, deleted = ?, cutover_at = ? WHERE tb_institution_id = ? AND model = 'SE'`,
    [i.environment, i.serie, i.dps_last_number, i.refresh_lease_until, i.tb_user_id, i.created_at, i.updated_at, i.deleted, i.cutover_at, INST])
}
const asTurned = () => q(`UPDATE tb_establishment_issuer SET cutover_at = NOW() WHERE tb_institution_id = ? AND model = 'SE'`, [INST])

async function purgeSynthetic(): Promise<void> {
  for (const id of SYN) {
    await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
    await q(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
    await q(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
  }
}

/** Autorizada SINTÉTICA (H) na nota fresca [inv], com dh_proc há [daysAgo] dias; a NFS-e "existe" no fisco falso. */
async function seedAuthorized(inv: number, daysAgo: number): Promise<{ key: string; dpsId: string }> {
  const life = (await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, INST, inv))!.lifeEvent!
  const nDps = 990_000_000 + inv
  const dpsId = `DPS4106902${'2'}${CNPJ}00999${String(nDps).padStart(15, '0')}`
  const key = (`41069022${CNPJ}99${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50)
  expect(dpsId).toHaveLength(45)
  await q(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, '999', ?, ?, ?, NOW(), NOW(), 'N')`, [INST, inv, life, nDps, dpsId, ADV_USER])
  await q(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', ?, '990001', DATE_SUB(NOW(), INTERVAL ? DAY), NULL, ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [INST, inv, life, key, daysAgo, ADV_USER, daysAgo])
  await q(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, 1, 'A', NULL, 'autorizada SINTÉTICA (adversarial r4)', DATE_SUB(NOW(), INTERVAL ? DAY), 'P', ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [INST, inv, daysAgo, ADV_USER, daysAgo])
  fisco.byKey.set(key, dpsId)
  return { key, dpsId }
}
const kindsOf = async (inv: number) => (await q(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt, event`, [INST, inv])).map(r => String(r.kind))
const candidateIds = async (maxDays: number) =>
  (await listRefreshCandidates(ctx.pool, SCHEMA, INST, 5, 10, 50, { authorizedMaxDays: maxDays })).map(t => t.invoiceId)

// usuário do setes-api (cria/apaga o banco descartável; SELECT no ERP) — lido do .env SEM tocar o process.env
let setesUser = '', setesPass = ''
const runScript = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('npm', ['run', script, '--', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

d('GATE ADVERSARIAL — delta da Rodada 4 (D-F36…D-F40) — banco real (réplica) + fisco falso + banco descartável', () => {
  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(ROOT, '..', 'setes-api', '.env')))
    setesUser = setesEnv.DB_USER; setesPass = setesEnv.DB_PASSWORD ?? ''
    rootPool = createFiscalPool({ ...dbConfigFromEnvSafe(), user: setesUser, password: setesPass })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r4: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    // gates R4: as seções A/B rodam numa CÓPIA descartável em estado de RÉPLICA (a B a vira — só na cópia)
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_r4', { turned: false })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    process.chdir(cwd)
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.adapter).toBe(fakeAdapter)
    app = createApp(ctx)
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

    sumsBefore = await fiscalSums()
    erpBefore = await erpSums()
    dbsBefore = await databases()
    expect(dbsBefore).not.toContain(ADV_DB)
    issuerBefore = (await q(`SELECT environment, serie, dps_last_number, tb_user_id, deleted,
                                    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
                                    DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS refresh_lease_until,
                                    DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutover_at
                               FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
    expect(issuerBefore?.cutover_at).toBeNull()                 // D-F39: a institution 1 do dev é RÉPLICA do ERP
    expect(issuerBefore?.deleted).toBe('N')

    const svc = await import('../facts/service-facts')
    const busy = new Set((await q(`SELECT DISTINCT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?
                                   UNION SELECT DISTINCT tb_invoice_id FROM tb_invoice_service_transmission WHERE tb_institution_id = ?`, [INST, INST])).map(r => Number(r.id)))
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E'
        AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
      ORDER BY i.id DESC LIMIT 400`, [INST])
    const fresh: number[] = []
    for (const r of rows) {
      const id = Number(r.id)
      if (busy.has(id)) continue
      try {
        const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, INST, id)
        await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
        fresh.push(id)
      } catch { /* cadastro incompleto — não serve de alvo */ }
      if (fresh.length >= 3) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r4] notas-alvo frescas', fresh.join(','))
    expect(fresh.length).toBe(3)
    ;[X, OLD, RECENT] = fresh
    SYN.push(OLD, RECENT)
  })

  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    if (!ctx) return
    let after: Record<string, string> = {}, erpAfter: Record<string, string> = {}, dbsAfter = ''
    try {
      await purgeSynthetic()
      await restoreIssuer()
      try { await rootPool.query(`DROP DATABASE IF EXISTS \`${ADV_DB}\``) }
      catch (err) { /* eslint-disable-next-line no-console */ console.error('[adv-r4] falha ao apagar o banco descartável', err) }
      after = await fiscalSums()
      erpAfter = await erpSums()
      dbsAfter = await databases()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r4] CHECKSUM fiscal_api antes', JSON.stringify(sumsBefore), '| depois', JSON.stringify(after),
        '\n[adv-r4] CHECKSUM ERP antes', JSON.stringify(erpBefore), '| depois', JSON.stringify(erpAfter), '\n[adv-r4] bancos antes', dbsBefore, '| depois', dbsAfter)
      await harness.drop()
      await rootPool.end()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (JSON.stringify(after) !== JSON.stringify(sumsBefore)) throw new Error('RESÍDUO no fiscal_api depois do ataque — conferir as tabelas')
    if (JSON.stringify(erpAfter) !== JSON.stringify(erpBefore)) throw new Error('O ERP MUDOU durante o ataque — conferir')
    if (dbsAfter !== dbsBefore) throw new Error('Sobrou banco depois do ataque — conferir SHOW DATABASES')
  })

  // =========================================================================
  describe('A. D-F39 — habilitação RÉPLICA (o estado REAL do dev, sem virar): rota a rota e composição direta', () => {
    let syn: { key: string; dpsId: string }
    beforeAll(async () => {
      if (!ctx) return
      await seedAuthorized(OLD, 120)
      syn = await seedAuthorized(RECENT, 5)
    })

    it('rota a rota: toda AÇÃO e escrita do emitente → 409 FISCAL_CUTOVER_PENDING; leituras respondem; nada ao fisco; CHECKSUM igual', async () => {
      const a = bearer(tok())
      const s0 = await fiscalSums()
      const outs: string[] = []
      for (const [m, p, body] of [
        ['post', `/v1/nfse/invoices/${X}/transmit`, undefined], ['post', `/v1/nfse/invoices/${RECENT}/refresh`, undefined],
        ['post', `/v1/nfse/invoices/8005/reconfirm`, undefined], ['post', `/v1/nfse/invoices/${RECENT}/cancel`, { reason: 'cerca da virada adversarial r4' }],
        ['post', '/v1/nfse/refresh', {}], ['put', '/v1/emitter/certificate', { pfxBase64: 'QUJD', password: '' }],
        ['delete', '/v1/emitter/certificate', undefined], ['put', '/v1/emitter/issuers/SE', { environment: 'H', serie: '900' }],
        ['delete', '/v1/emitter/issuers/SE', undefined],
      ] as const) {
        const r = await (request(app) as any)[m](p).set(a).send(body)
        outs.push(`${m} ${p} ${r.status} ${r.body.code}`)
        expect([m, p, r.status, r.body.code]).toEqual([m, p, 409, 'FISCAL_CUTOVER_PENDING'])
      }
      const reads: [string, number][] = []
      for (const p of [`/v1/nfse/invoices/${RECENT}`, `/v1/nfse/invoices/${RECENT}/xml`, '/v1/nfse/invoices/8011', '/v1/nfse/invoices/8011/danfse',
        '/v1/nfse/invoices/pending?pageSize=5', '/v1/emitter']) {
        reads.push([p, (await request(app).get(p).set(a)).status])
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r4] réplica rota a rota', JSON.stringify(outs), '| leituras', JSON.stringify(reads))
      expect(reads.every(([, st]) => st === 200 || st === 404)).toBe(true)
      expect(await fiscalSums()).toEqual(s0)
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0, terms: 0 })
    })

    it('composição direta: transmitir, consultar, cunhar nDPS e tomar o aluguel RECUSAM a réplica NO NÚCLEO — nada ao fisco, nada gravado', async () => {
      const s0 = await fiscalSums()
      await expect(transmitServiceInvoice(ctx, ACTOR, X)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
      await expect(refreshServiceTransmission(ctx, ACTOR, 8005)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
      await expect(refreshServiceTransmission(ctx, ACTOR, RECENT)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
      await expect(fiscal.withTransaction(ctx.pool, 'adv-r4 nDPS na réplica', {}, conn => fiscal.nextDpsNumber(conn, INST)))
        .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
      expect(await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 60)).toBeNull()
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0, terms: 0 })
      expect(await fiscalSums()).toEqual(s0)
    })

    const lease: { result?: any; err?: any } = {}
    it('cenário: passada do rodízio chamada DIRETO na réplica — nada consultado, aluguel não tomado, nada gravado', async () => {
      const s0 = await fiscalSums()
      try { lease.result = await refreshOpenServiceTransmissions(ctx, ACTOR) } catch (err) { lease.err = err }
      // eslint-disable-next-line no-console
      console.log('[adv-r4] rodízio direto na réplica →', JSON.stringify(lease.result ?? { status: lease.err?.statusCode, code: lease.err?.code }))
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0, terms: 0 })
      expect(await fiscalSums()).toEqual(s0)
    })
    it('[corrigido nos gates R4] …e responde 409 FISCAL_CUTOVER_PENDING (nunca `skipped: true`)', () => {
      expect(lease.err?.code).toBe('FISCAL_CUTOVER_PENDING')
    })

    const cancel: { status?: number; code?: string; kindsBefore?: string[]; kindsAfter?: string[] } = {}
    it('cenário: cancelar NO FISCO direto a NFS-e (sintética, autorizada) da réplica → 409 FISCAL_CUTOVER_PENDING e nada vai ao fisco', async () => {
      expect(syn.key).toHaveLength(50)
      cancel.kindsBefore = await kindsOf(RECENT)
      try { await cancelServiceInvoiceAtAuthority(ctx, ACTOR, RECENT, 'cancelamento adversarial r4 na réplica') } catch (err: any) { cancel.status = err.statusCode; cancel.code = err.code }
      cancel.kindsAfter = await kindsOf(RECENT)
      // eslint-disable-next-line no-console
      console.log('[adv-r4] cancelamento direto na réplica', JSON.stringify(cancel))
      expect([cancel.status, cancel.code]).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
      expect(fisco.calls.event).toBe(0)
      expect(cancel.kindsBefore).toEqual(['A'])
    })
    it('[corrigido nos gates R4] …e a composição NÃO grava reserva K nem liberação N na tentativa da RÉPLICA', () => {
      expect(cancel.kindsAfter).toEqual(cancel.kindsBefore)
    })
  })

  // =========================================================================
  describe('B. D-F38 — teto de idade das autorizadas no rodízio (habilitação VIRADA só durante o ataque)', () => {
    beforeAll(async () => { if (ctx) await asTurned() })
    // a passada agora CONSULTA de verdade (gates R4: o teto absurdo cai no padrão) e marca last_queried_at — cada teste
    // da seção parte das notas sintéticas "nunca olhadas" (só na cópia descartável)
    beforeEach(async () => {
      if (ctx && SYN.length) await q(`UPDATE tb_invoice_service_transmission SET last_queried_at = NULL WHERE tb_institution_id = ? AND tb_invoice_id IN (?)`, [INST, SYN])
    })
    afterAll(async () => {
      if (!ctx) return
      await restoreIssuer()
      await purgeSynthetic()                     // a seção C copia o fiscal_api — sem as linhas sintéticas
    })

    it('teto padrão (60 + 30): a autorizada de 5 dias é candidata, a de 120 dias NÃO; com teto de 200 dias as duas', async () => {
      const at90 = await candidateIds(90)
      const at200 = await candidateIds(200)
      // eslint-disable-next-line no-console
      console.log('[adv-r4] candidatas teto 90', at90.join(','), '| teto 200', at200.join(','))
      expect(at90).toContain(RECENT)
      expect(at90).not.toContain(OLD)
      expect(at200).toEqual(expect.arrayContaining([RECENT, OLD]))
    })

    it('a consulta MANUAL da autorizada fora do teto continua: POST /invoices/:id/refresh → 200, fisco consultado', async () => {
      const r = await request(app).post(`/v1/nfse/invoices/${OLD}/refresh`).set(bearer(tok()))
      // eslint-disable-next-line no-console
      console.log('[adv-r4] consulta manual da autorizada de 120 dias', r.status, JSON.stringify(r.body))
      expect(r.status).toBe(200)
      expect(r.body.data).toMatchObject({ invoiceId: OLD, kind: 'A', changed: false })
      expect(fisco.calls.query).toBe(1)
    })

    const huge: { ids?: number[]; sqlNull?: boolean; pass?: any } = {}
    it('cenário [LOW]: prazo do PAM absurdo (data 20261231 lida como "dias") → o SQL recebe 20261261 dias; o DATE_SUB sai do domínio (NULL)', async () => {
      huge.ids = await candidateIds(20_261_261)
      huge.sqlNull = (await q(`SELECT DATE_SUB(NOW(), INTERVAL ? DAY) IS NULL AS n`, [20_261_261]))[0].n === 1
      const control90 = await candidateIds(90)                    // antes da passada (ela marca last_queried_at)
      fisco.termsCancelDays = 20_261_231
      huge.pass = await refreshOpenServiceTransmissions(ctx, ACTOR, { budgetMs: 5000 })
      // eslint-disable-next-line no-console
      console.log('[adv-r4] teto absurdo', JSON.stringify(huge), '| controle teto 90', control90.join(','))
      expect(huge.sqlNull).toBe(true)
      expect(fisco.calls.terms).toBe(1)
      expect(control90).toContain(RECENT)                         // a autorizada de 5 dias continua elegível no teto normal
    })
    it('[corrigido nos gates R4] teto MAIOR nunca exclui o que o menor inclui (valor absurdo é descartado/limitado)', () => {
      expect(huge.ids).toContain(RECENT)
      expect(huge.pass.checked).toBe(1)
    })

    const slow: { pass?: any; ms?: number; leaseAfter?: string | null } = {}
    it('cenário [MEDIUM]: a de 5 dias é candidata e o convênio do fisco falso demora 1,5 s (> orçamento de 1 s da passada)', async () => {
      expect(await candidateIds(90)).toContain(RECENT)
      fisco.termsDelayMs = 1500
      const t0 = Date.now()
      slow.pass = await refreshOpenServiceTransmissions(ctx, ACTOR, { budgetMs: 1000 })
      slow.ms = Date.now() - t0
      slow.leaseAfter = (await q(`SELECT refresh_lease_until AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].u ?? null
      // eslint-disable-next-line no-console
      console.log('[adv-r4] convênio lento × passada', JSON.stringify({ ...slow, consultas: fisco.calls.query, convenio: fisco.calls.terms }))
      expect(fisco.calls.terms).toBe(1)
      expect(slow.leaseAfter).toBeNull()                          // o aluguel foi devolvido
    })
    it('[corrigido nos gates R4] …e a passada consulta a candidata (o prazo do PAM fica fora do orçamento, ≤ 3 s)', () => {
      expect(slow.pass.checked).toBe(1)
    })

    it('controle: com o convênio rápido a MESMA passada consulta a autorizada de 5 dias (o que trava é o PAM, não o rodízio)', async () => {
      const r = await refreshOpenServiceTransmissions(ctx, ACTOR, { budgetMs: 5000 })
      expect(r).toMatchObject({ checked: 1, skipped: false, stoppedEarly: false })
      expect(fisco.calls.query).toBe(1)
    })
  })

  // =========================================================================
  describe('C. banco DESCARTÁVEL fiscal_api_adv4 — lacuna (b), D-F37, revive, migrate:setes / --cutover / assertFrozen, smoke sem --vai', () => {
    let admin: ReturnType<typeof createFiscalPool>
    let advPool: ReturnType<typeof createFiscalPool>
    let appAdv: any
    let ctxAdv: AppContext
    const qa = async (sql: string, params: any[] = []) => (await advPool.query(sql, params))[0] as any[]
    const advSums = () => checksumsOf(ADV_DB, FISCAL_TABLES.filter(t => t !== '_migrations'), qa)
    const advEnv = () => ({ FISCAL_DB_NAME: ADV_DB, DB_USER: setesUser, DB_PASSWORD: setesPass })
    const COPY = ['tb_establishment_issuer', 'tb_establishment_certificate', 'tb_invoice_service_dps', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']
    const copyFrom = async (table: string, where = '1=1') => admin.query(`INSERT INTO \`${ADV_DB}\`.${table} SELECT * FROM fiscal_api.${table} WHERE ${where}`)
    const advIssuer = async (inst: number) => (await qa(`SELECT DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c, deleted, environment, serie, dps_last_number AS n
                                                           FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [inst]))[0] ?? null

    beforeAll(async () => {
      if (!ctx) return
      admin = createFiscalPool({ ...ctx.db, user: setesUser, password: setesPass })
      await runMigrations({ ...ctx.db, user: setesUser, password: setesPass, database: ADV_DB }, MIGRATION_SETS)
      for (const t of COPY) {
        const cols = async (db: string) => (await admin.query<any[]>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [db, t]))[0].map(r => r.c).join(',')
        expect(await cols(ADV_DB)).toBe(await cols('fiscal_api'))
        await copyFrom(t)
      }
      advPool = createFiscalPool({ ...ctx.db, user: setesUser, password: setesPass, database: ADV_DB })
      ctxAdv = { ...ctx, pool: advPool, fiscalDb: ADV_DB, checkIdentity: false }
      appAdv = createApp(ctxAdv)
      expect((await advIssuer(INST))?.c).toBeNull()               // a cópia nasce RÉPLICA, como a origem
    })
    afterAll(async () => {
      if (advPool) await advPool.end()
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${ADV_DB}\``); await admin.end() }
    })

    it('lacuna (b): SEM linha no fiscal_api e habilitação SE no ERP → escrita do emitente e ações → 409 FISCAL_CUTOVER_PENDING; nada criado', async () => {
      await qa(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
      try {
        const a = bearer(tok())
        const outs: [string, number, string][] = []
        for (const [m, p, body] of [
          ['put', '/v1/emitter/issuers/SE', { environment: 'H', serie: '900' }], ['delete', '/v1/emitter/issuers/SE', undefined],
          ['put', '/v1/emitter/certificate', { pfxBase64: 'QUJD', password: '' }], ['delete', '/v1/emitter/certificate', undefined],
          ['post', `/v1/nfse/invoices/${X}/transmit`, undefined], ['post', '/v1/nfse/refresh', {}],
        ] as const) {
          const r = await (request(appAdv) as any)[m](p).set(a).send(body)
          outs.push([`${m} ${p}`, r.status, r.body.code])
        }
        // eslint-disable-next-line no-console
        console.log('[adv-r4] lacuna (b)', JSON.stringify(outs))
        expect(outs.every(([, st, code]) => st === 409 && code === 'FISCAL_CUTOVER_PENDING')).toBe(true)
        expect(await qa(`SELECT 1 FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])).toEqual([])
        expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0, terms: 0 })
      } finally {
        await qa(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
        await copyFrom('tb_establishment_issuer', `tb_institution_id = ${INST}`)
      }
    })

    it('institution SEM habilitação no ERP: PUT nasce VIRADA; excluir e recriar REVIVE com o MESMO cutover_at (não desvira)', async () => {
      const a2 = bearer(tok({ institutionId: 2 }))
      const put1 = await request(appAdv).put('/v1/emitter/issuers/SE').set(a2).send({ environment: 'H', serie: '900' })
      const born = await advIssuer(2)
      await sleep(1100)
      const del = await request(appAdv).delete('/v1/emitter/issuers/SE').set(a2)
      const dead = await advIssuer(2)
      const put2 = await request(appAdv).put('/v1/emitter/issuers/SE').set(a2).send({ environment: 'P', serie: '901' })
      const revived = await advIssuer(2)
      // eslint-disable-next-line no-console
      console.log('[adv-r4] inst 2: nasce / exclui / revive', JSON.stringify({ put1: put1.status, born, del: del.status, dead, put2: put2.status, revived }))
      expect([put1.status, del.status, put2.status]).toEqual([200, 200, 200])
      expect(born.c).not.toBeNull()
      expect([dead.deleted, dead.c]).toEqual(['S', born.c])
      expect([revived.deleted, revived.c, revived.environment, revived.serie]).toEqual(['N', born.c, 'P', '901'])
    })

    it('D-F37: ADMIN de institution SEM o ramo contratado → 403 INTERFACE_NOT_ALLOWED em ações, leituras e passada; pendentes = lista vazia', async () => {
      const a2 = bearer(tok({ institutionId: 2 }))
      const outs: [string, number, string][] = []
      for (const [m, p, body] of [
        ['post', `/v1/nfse/invoices/${X}/transmit`, undefined], ['post', `/v1/nfse/invoices/${X}/refresh`, undefined],
        ['post', `/v1/nfse/invoices/${X}/reconfirm`, undefined], ['post', `/v1/nfse/invoices/${X}/cancel`, { reason: 'licença adversarial r4' }],
        ['post', '/v1/nfse/refresh', {}], ['get', `/v1/nfse/invoices/${X}`, undefined], ['get', `/v1/nfse/invoices/${X}/xml`, undefined],
        ['get', `/v1/nfse/invoices/${X}/danfse`, undefined],
      ] as const) {
        const r = await (request(appAdv) as any)[m](p).set(a2).send(body)
        outs.push([`${m} ${p}`, r.status, r.body.code])
      }
      const pend = await request(appAdv).get('/v1/nfse/invoices/pending?pageSize=5').set(a2)
      // eslint-disable-next-line no-console
      console.log('[adv-r4] D-F37 admin sem ramo', JSON.stringify(outs), '| pendentes', pend.status, JSON.stringify(pend.body))
      expect(outs.every(([, st, code]) => st === 403 && code === 'INTERFACE_NOT_ALLOWED')).toBe(true)
      expect([pend.status, pend.body.total, pend.body.data]).toEqual([200, 0, []])
      expect(fisco.calls).toEqual({ transmit: 0, query: 0, dps: 0, event: 0, terms: 0 })
    })

    it('réplica EXCLUÍDA: o PUT recusa (409 — a exclusão não apaga a réplica); a peça upsertIssuer direto TAMBÉM recusa (re-prova R4: a cerca está na peça) e nada vira', async () => {
      await qa(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
      try {
        const r = await request(appAdv).put('/v1/emitter/issuers/SE').set(bearer(tok())).send({ environment: 'H', serie: '900' })
        expect([r.status, r.body.code]).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
        await expect(fiscal.withTransaction(advPool, 'adv-r4 revive da réplica', {}, conn => fiscal.upsertIssuer(conn, SCHEMA, INST, 'SE', { environment: 'H', serie: '900', userId: ADV_USER })))
          .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
        const row = await advIssuer(INST)
        expect([row.deleted, row.c]).toEqual(['S', null])                                   // continua réplica excluída — nada vira
        await expect(fiscal.openIssuer({ pool: advPool, keyring: ctx.keyring }, INST, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
      } finally {
        await qa(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
        await copyFrom('tb_establishment_issuer', `tb_institution_id = ${INST}`)
      }
    })

    // ---- migrate:setes no banco descartável --------------------------------------------------------------------------
    it('migrate:setes na RÉPLICA → exit 0 (re-sincronia); --dry-run do resync não deixa resíduo', async () => {
      const s0 = await advSums()
      const dry = runScript('migrate:setes', ['--dry-run'], advEnv())
      expect(dry.status).toBe(0)
      expect(await advSums()).toEqual(s0)
      const real = runScript('migrate:setes', [], advEnv())
      // eslint-disable-next-line no-console
      console.log('[adv-r4] resync réplica', real.status, real.out.match(/"certificate": "[^"]*"/)?.[0])
      expect(real.status).toBe(0)
      expect((await advIssuer(INST)).c).toBeNull()
    })

    it('--cutover SEM a confirmação → falha alto, nada muda; com --dry-run → "virou" e desfez (nada muda)', async () => {
      const s0 = await advSums()
      const noFlag = runScript('migrate:setes', ['--cutover', '1'], advEnv())
      expect(noFlag.status).not.toBe(0)
      expect(noFlag.out).toMatch(/--confirmo-setes-api-parado/)
      expect(await advSums()).toEqual(s0)
      const dry = runScript('migrate:setes', ['--cutover', '1', '--confirmo-setes-api-parado', '--dry-run'], advEnv())
      // eslint-disable-next-line no-console
      console.log('[adv-r4] --cutover --dry-run', dry.status, dry.out.match(/"linhasViradas": \d+/)?.[0])
      expect(dry.status).toBe(0)
      expect(dry.out).toMatch(/"dryRun": true/)
      expect(dry.out).toMatch(/"linhasViradas": 1/)
      expect(dry.out).toMatch(/"habilitacaoErpAposentada": 1/)                   // D-F44: o ato aposenta a SE do ERP — e o dry-run desfaz
      expect(await advSums()).toEqual(s0)
      expect((await advIssuer(INST)).c).toBeNull()
    })

    let turnedAt: string | null = null
    // D-F44 (2026-10-04): o ato REAL agora escreve no ERP (aposenta a habilitação SE) — NUNCA roda contra o ERP real do dev
    // (é o que emite a produção da Setes). A virada da CÓPIA é feita pelo teste; a recusa da 2ª virada acontece ANTES de
    // qualquer escrita (passo 2 do ato), então ela continua provada pelo script de verdade.
    it('virada da CÓPIA (feita pelo teste — o ato real escreve no ERP, D-F44); o ato depois dela falha alto ANTES de escrever e o instante não muda; o resync CONGELA (nada copiado)', async () => {
      await qa(`UPDATE tb_establishment_issuer SET cutover_at = NOW() WHERE tb_institution_id = ? AND cutover_at IS NULL`, [INST])
      turnedAt = (await advIssuer(INST)).c
      expect(turnedAt).not.toBeNull()
      await sleep(1100)
      const again = runScript('migrate:setes', ['--cutover', '1', '--confirmo-setes-api-parado'], advEnv())
      expect(again.status).not.toBe(0)
      expect(again.out).toMatch(/já VIRADA/)
      expect((await advIssuer(INST)).c).toBe(turnedAt)
      const s0 = await advSums()
      const resync = runScript('migrate:setes', [], advEnv())
      // eslint-disable-next-line no-console
      console.log('[adv-r4] resync depois da virada', resync.status, resync.out.match(/"state": "[^"]*"/)?.[0])
      expect(resync.status).toBe(0)
      expect(resync.out).toMatch(/virada — origem congelada/)
      expect(await advSums()).toEqual(s0)
      // a virada abre o emissor (o fato é lido pelo núcleo)
      await expect(fiscal.openIssuer({ pool: advPool, keyring: ctx.keyring }, INST, 'SE')).resolves.toBeDefined()
    })

    it('assertFrozen ACUSA o ERP emitindo depois da virada: tentativa da origem ausente no fiscal_api; contador do ERP além do da API', async () => {
      const victim = (await qa(`SELECT tb_invoice_id AS inv, attempt FROM tb_invoice_service_transmission WHERE tb_institution_id = ? ORDER BY tb_invoice_id, attempt DESC LIMIT 1`, [INST]))[0]
      await qa(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = ?`, [INST, victim.inv, victim.attempt])
      await qa(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = ?`, [INST, victim.inv, victim.attempt])
      let missing = { status: null as number | null, out: '' }
      try { missing = runScript('migrate:setes', ['--dry-run'], advEnv()) } finally {
        await copyFrom('tb_invoice_service_transmission', `tb_institution_id = ${INST} AND tb_invoice_id = ${victim.inv} AND attempt = ${victim.attempt}`)
        await copyFrom('tb_invoice_service_transmission_event', `tb_institution_id = ${INST} AND tb_invoice_id = ${victim.inv} AND attempt = ${victim.attempt}`)
      }
      const n0 = (await advIssuer(INST)).n
      await qa(`UPDATE tb_establishment_issuer SET dps_last_number = 0 WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
      let counter = { status: null as number | null, out: '' }
      try { counter = runScript('migrate:setes', ['--dry-run'], advEnv()) } finally {
        await qa(`UPDATE tb_establishment_issuer SET dps_last_number = ? WHERE tb_institution_id = ? AND model = 'SE'`, [n0, INST])
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r4] assertFrozen', missing.status, missing.out.match(/FALHA[^\n]*/)?.[0], '|', counter.status, counter.out.match(/FALHA[^\n]*/)?.[0])
      expect(missing.status).not.toBe(0)
      expect(missing.out).toMatch(/origem tem tentativa/)
      expect(counter.status).not.toBe(0)
      expect(counter.out).toMatch(/contador do ERP/)
    })

    const voice: { status?: number | null; out?: string; victim?: any } = {}
    it('cenário [LOW]: a origem ganhou uma VOZ depois da virada (ex.: o setes-api ainda cancelou no fisco) — simulado tirando a última voz da cópia', async () => {
      voice.victim = (await qa(`SELECT tb_invoice_id AS inv, attempt, MAX(event) AS ev FROM tb_invoice_service_transmission_event
                                  WHERE tb_institution_id = ? GROUP BY tb_invoice_id, attempt ORDER BY MAX(event) DESC, tb_invoice_id LIMIT 1`, [INST]))[0]
      const where = `tb_institution_id = ${INST} AND tb_invoice_id = ${voice.victim.inv} AND attempt = ${voice.victim.attempt} AND event = ${voice.victim.ev}`
      voice.victim.kind = (await qa(`SELECT kind FROM tb_invoice_service_transmission_event WHERE ${where}`))[0].kind
      await qa(`DELETE FROM tb_invoice_service_transmission_event WHERE ${where}`)
      try {
        const r = runScript('migrate:setes', ['--dry-run'], advEnv())
        voice.status = r.status; voice.out = r.out
      } finally {
        await copyFrom('tb_invoice_service_transmission_event', where)
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r4] voz nova na origem depois da virada', JSON.stringify(voice.victim), '→ exit', voice.status, voice.out?.match(/"state": "[^"]*"|FALHA[^\n]*/)?.[0])
      expect((await advIssuer(INST)).c).toBe(turnedAt)
    })
    it('[corrigido nos gates R4] …o assertFrozen ACUSA também a voz nova da origem', () => {
      expect(voice.status).not.toBe(0)
    })

    // ---- D-F36: smoke sem --vai ----------------------------------------------------------------------------------------
    it('smoke:adn-h SEM --vai (--candidatas e --nota) não cria banco nem escreve; nome de banco não descartável é recusado', async () => {
      const dbs0 = await databases()
      const s0 = await fiscalSums()
      const e0 = await erpSums()
      const env = { SMOKE_DB_USER: setesUser, SMOKE_DB_PASSWORD: setesPass }
      const cand = runScript('smoke:adn-h', ['--candidatas'], env)
      const first = Number(cand.out.match(/"nota": (\d+)/)?.[1] ?? X)
      const nota = runScript('smoke:adn-h', ['--nota', String(first)], env)
      const bad = runScript('smoke:adn-h', ['--nota', String(first)], { ...env, SMOKE_DB_NAME: 'fiscal_api' })
      const noUser = runScript('smoke:adn-h', ['--candidatas'], { SMOKE_DB_USER: '' })
      // eslint-disable-next-line no-console
      console.log('[adv-r4] smoke sem --vai', JSON.stringify({ candidatas: cand.status, nota: [first, nota.status, nota.out.match(/Sem --vai[^\n]*/)?.[0]], bancoReal: [bad.status, bad.out.match(/FALHA[^\n]*/)?.[0]], semUsuario: noUser.status }))
      // eslint-disable-next-line no-console
      console.log('[adv-r4] smoke --candidatas', cand.out.match(/"elegiveis": \[[^\]]*\]/)?.[0], cand.out.match(/"recusadas_por": \{[^}]*\}/)?.[0]?.replace(/\s+/g, ' '))
      expect(cand.status).toBe(0)
      // sem nota elegível no dev (regra de ISS sem código nacional / cTribMun "0102") o --nota falha na PRÉ-CONDIÇÃO — também sem escrever
      if (nota.status === 0) expect(nota.out).toMatch(/Sem --vai: nada enviado ao fisco, nenhum banco criado/)
      else expect(nota.out).toMatch(/\[smoke:adn-h\] FALHA:/)
      expect(nota.out).not.toMatch(/EMISSOR DO SMOKE|1\. TRANSMITIR/)
      expect(bad.status).not.toBe(0)
      expect(bad.out).toMatch(/SMOKE_DB_NAME inválido/)
      expect(noUser.status).not.toBe(0)
      expect(await databases()).toBe(dbs0)
      expect(dbs0).not.toContain('fiscal_api_smoke')
      expect(await fiscalSums()).toEqual(s0)
      expect(await erpSums()).toEqual(e0)
    })
  })

  // =========================================================================
  describe('D. D-F40 — a cerca de EXPLAIN das leituras que crescem com o histórico', () => {
    // EXPLAIN de VIEW exige SHOW VIEW: usuário de diagnóstico (o do setes-api), como o script `explain-leituras.ts` pede.
    const plan: { rows?: any[]; sqlCount?: number } = {}
    it('cenário: o plano da página de PENDENTES (a mesma função do serviço) MATERIALIZA a subconsulta NOT EXISTS da view de transmissões (exists_to_in)', async () => {
      const sqls: { sql: string; params: unknown[] }[] = []
      const capture = { query: async (sql: string, params: unknown[] = []) => { sqls.push({ sql, params }); return rootPool.query(sql, params) } } as any
      await listPendingServiceInvoicesReal(capture)
      plan.sqlCount = sqls.length
      plan.rows = ((await rootPool.query<any[]>(`EXPLAIN ${sqls[0].sql}`, sqls[0].params))[0]) as any[]
      // eslint-disable-next-line no-console
      console.log('[adv-r4] EXPLAIN pendentes (COUNT)', JSON.stringify(plan.rows.map(p => [p.id, p.select_type, p.table, p.type, p.key, p.rows])))
      expect(plan.sqlCount).toBe(2)
      expect(plan.rows.some(p => p.select_type === 'MATERIALIZED')).toBe(true)
    })
    it('[corrigido nos gates R4] …e a materialização chega por CHAVE já filtrada pela institution (a cerca reprova varredura)', () => {
      const scans = (plan.rows ?? []).filter(p => p.select_type === 'MATERIALIZED' && (p.type === 'index' || p.type === 'ALL'))
      expect(scans).toEqual([])
    })
  })
})

async function listPendingServiceInvoicesReal(q: any): Promise<void> {
  const { listPendingServiceInvoices } = jest.requireActual('../facts/service-facts')
  await listPendingServiceInvoices(q, SCHEMA, INST, 'fiscal_api', { page: 1, pageSize: 25 }, ['service-orders', 'orders'])
}

// sanity para o describe.skip não deixar o arquivo "vazio" quando NFSE_ADV_LIVE não está ligado
if (!LIVE) it('adversarial r4 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
