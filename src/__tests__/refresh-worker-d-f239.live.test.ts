/// <reference types="jest" />
// DEPLOY.E2.P1.T1 (D-F239) — AO VIVO: o worker do rodízio em DUAS instâncias sobre o MESMO banco não consulta a mesma nota duas vezes.
// ⚠️ Só roda com NFSE_ADV_LIVE=1. Pré-requisitos (os de toda suíte ao vivo — §23.11 do prompt): `DB_USER` do `.env` = `fiscal_api` (D-F53,
// `ops/grants.sql` 1b), `../setes-api/.env` presente (o dono cria/apaga a cópia), `ADV_ERP_SCHEMA` (padrão `setes_setes`). Isolamento:
//  - cópia DESCARTÁVEL `fiscal_api_adv_worker` com toda habilitação VIRADA (`disposableFiscalDb(..., { turned: true })`); o `fiscal_api`
//    real e o ERP são vigiados por CHECKSUM no `drop()` do harness;
//  - fisco FALSO (o transporte HTTPS do núcleo trocado por um que explode — nenhum byte ao fisco real), que CONTA as consultas por chave e
//    por Id do DPS. A SOBREPOSIÇÃO das duas passadas é garantida por construção (gate adversarial L1): a 1ª consulta ao fisco só responde
//    depois que uma das duas instâncias VOLTOU — quem está com o aluguel espera, e a outra só pode voltar pulando (`skipped`);
//  - o leitor das habilitações viradas é RESTRITO ao estabelecimento 1 (as notas reais dos outros estabelecimentos não entram) e TODAS as
//    tentativas da cópia são carimbadas como "olhadas agora" — só as 4 sintéticas (≤ REFRESH_MAX_PER_RUN, cabem numa passada) são candidatas.
// As 4 sintéticas são tentativas EM VOO há 15 min (sem voz, sem chave): entram em qualquer escopo (ramo contratado ou cortado — D-F47), e a
// consulta acha a NFS-e pelo Id do DPS e grava a voz A com fonte Q — SEM autor (o worker não tem usuário).
//
// Uso: NFSE_ADV_LIVE=1 npx jest refresh-worker-d-f239.live --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, createFiscalPool } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, attackVerifier } from './live-harness'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import { resetMunicipalTermsCache } from '../nfse/transmission'
import { RefreshWorker, refreshWorkerDeps, EstablishmentRun } from '../worker/refresh-worker'

const LIVE = process.env.NFSE_ADV_LIVE === '1'
const d = LIVE ? describe : describe.skip
jest.setTimeout(300_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const SCHEMA = process.env.ADV_ERP_SCHEMA ?? 'setes_setes'
const ADV_USER = 990005
const CNPJ = '07742094000113'
const N = 4
const FISCO_DELAY_MS = 300
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO — conta por chave e por Id do DPS
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-11-19T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV WORKER</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
let firstReturned: () => void = () => {}
const instanceReturned = new Promise<void>(r => { firstReturned = r })
let gateUsed = false
/** A 1ª consulta ao fisco espera uma instância voltar (no máximo 30 s — sem sobreposição o teste falha, não trava). */
async function overlapGate(): Promise<void> {
  if (gateUsed) return
  gateUsed = true
  await Promise.race([instanceReturned, sleep(30_000)])
}
const fisco = {
  byKey: new Map<string, string>(),                     // chave → Id do DPS (as NFS-e sintéticas "existem" no fisco falso)
  queryByKey: new Map<string, number>(),
  dpsById: new Map<string, number>(),
  other: 0,
}
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() { fisco.other++; throw new Error('ADV worker: o worker NUNCA transmite') },
  async queryNfse(_ctx: AuthorityContext, accessKey: string) {
    bump(fisco.queryByKey, accessKey)
    await sleep(FISCO_DELAY_MS)
    const dpsId = fisco.byKey.get(accessKey)
    if (!dpsId) throw notFound()
    return { accessKey, status: 'authorized' as const, nfseXml: nfseXml(accessKey, dpsId), dhProc: '2026-11-19T10:00:00-03:00' }
  },
  async queryDpsAccessKey(_ctx: AuthorityContext, dpsId: string) {
    bump(fisco.dpsById, dpsId)
    await overlapGate()
    await sleep(FISCO_DELAY_MS)
    return [...fisco.byKey.entries()].find(([, id]) => id === dpsId)?.[0] ?? null
  },
  async registerEvent() { fisco.other++; throw new Error('ADV worker: o worker NUNCA cancela') },
  async municipalTerms() { return { cancelDays: 60, raw: null } },
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-worker-'))
class SandboxStorage implements FiscalStorage {
  constructor(private real: FiscalStorage, private tmp: FsFiscalStorage) {}
  save(...a: Parameters<FiscalStorage['save']>) { return this.tmp.save(...a) }
  find(...a: Parameters<FiscalStorage['find']>) { return this.tmp.find(...a) ?? this.real.find(...a) }
  read(ref: string) { return fs.readFileSync(ref, 'utf8') }
  probe() { return this.tmp.probe() }
}

let harness: DisposableFiscalDb | undefined
let ctx1: AppContext
let ctx2: AppContext
let pool2: ReturnType<typeof createFiscalPool> | undefined
const q = async (sql: string, params: any[] = []) => (await ctx1.pool.query(sql, params))[0] as any[]
const SYN: { inv: number; key: string; dpsId: string }[] = []

/** Tentativa EM VOO há 15 min na nota fresca [inv] (DPS cunhado, sem voz, sem chave); a NFS-e "existe" no fisco falso. */
async function seedInFlight(inv: number): Promise<void> {
  const life = (await fiscal.erp.invoiceLife(ctx1.pool, SCHEMA, fiscal.invoiceRef(INST, inv, fiscal.WEB_TERMINAL)))!.lifeEvent!
  const nDps = 991_000_000 + inv
  const dpsId = `DPS4106902${'2'}${CNPJ}00999${String(nDps).padStart(15, '0')}`
  const key = (`41069022${CNPJ}98${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50)
  expect(dpsId).toHaveLength(45)
  await q(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, '999', ?, ?, ?, NOW(), NOW(), 'N')`, [INST, inv, life, nDps, dpsId, ADV_USER])
  await q(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', NULL, NULL, NULL, NULL, ?, DATE_SUB(NOW(), INTERVAL 15 MINUTE), NOW(), 'N')`, [INST, inv, life, ADV_USER])
  fisco.byKey.set(key, dpsId)
  SYN.push({ inv, key, dpsId })
}

function workerOn(ctx: AppContext): RefreshWorker {
  // o leitor REAL das habilitações viradas, restrito ao estabelecimento do teste (as notas reais dos outros não entram na conta)
  const real = refreshWorkerDeps(ctx)
  return new RefreshWorker({ ...real, establishments: async () => (await real.establishments()).filter(e => e.institutionId === INST) })
}
const ofInst = (runs: EstablishmentRun[]) => runs.find(r => r.institutionId === INST)!

d('DEPLOY.E2.P1.T1 — worker do rodízio em DUAS instâncias (D-F239, aluguel D-F41) — cópia descartável + fisco falso', () => {
  const result: { a?: EstablishmentRun[]; b?: EstablishmentRun[]; third?: EstablishmentRun[]; establishments?: number[] } = {}

  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADV worker: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_worker', { turned: true })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool, verifier: attackVerifier() })
    process.chdir(cwd)
    const storage = new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot))
    ctx1 = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage }
    pool2 = createFiscalPool(harness.cfg)                                  // a 2ª INSTÂNCIA: outro pool, o mesmo banco
    ctx2 = { ...ctx1, pool: pool2 }
    expect(ctx1.adapter).toBe(fakeAdapter)

    // o leitor real enxerga o estabelecimento do teste como VIRADO na cópia
    result.establishments = (await refreshWorkerDeps(ctx1).establishments()).map(e => e.institutionId)
    // só as sintéticas são candidatas: tudo o que veio do real é "olhado agora"; nenhum aluguel herdado
    await q(`UPDATE tb_invoice_service_transmission SET last_queried_at = NOW()`)
    await q(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ? AND model = 'SE'`, [INST])

    const busy = new Set((await q(`SELECT DISTINCT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?
                                   UNION SELECT DISTINCT tb_invoice_id FROM tb_invoice_service_transmission WHERE tb_institution_id = ?`, [INST, INST])).map(r => Number(r.id)))
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E'
        AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
      ORDER BY i.id DESC LIMIT 200`, [INST])
    const fresh = rows.map(r => Number(r.id)).filter(id => !busy.has(id)).slice(0, N)
    // eslint-disable-next-line no-console
    console.log('[adv-worker] notas-alvo frescas', fresh.join(','))
    expect(fresh).toHaveLength(N)
    for (const inv of fresh) await seedInFlight(inv)
    resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache()

    // as DUAS instâncias ao mesmo tempo; depois uma terceira rodada (a janela de REFRESH_MIN_MINUTES ainda aberta)
    const mark = <T>(p: Promise<T>) => p.finally(() => firstReturned())
    const [a, b] = await Promise.all([mark(workerOn(ctx1).runOnce()), mark(workerOn(ctx2).runOnce())])
    result.a = a; result.b = b
    result.third = await workerOn(ctx1).runOnce()
    // eslint-disable-next-line no-console
    console.log('[adv-worker] instância 1', JSON.stringify(a), '\n[adv-worker] instância 2', JSON.stringify(b), '\n[adv-worker] 3ª rodada', JSON.stringify(result.third),
      '\n[adv-worker] fisco por Id do DPS', JSON.stringify([...fisco.dpsById]), '| por chave', JSON.stringify([...fisco.queryByKey]))
  })

  afterAll(async () => {
    try { await pool2?.end() } catch { /* já encerrado */ }
    try { if (harness) await harness.drop() } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }) }
  })

  it('o leitor real das habilitações viradas traz o estabelecimento do teste (cópia virada, institution viva)', () => {
    expect(result.establishments).toContain(INST)
  })

  it('D-F247: a reconferência real antes da passada diz sim para o estabelecimento como está, e NÃO para schema trocado ou id sem habilitação', async () => {
    const deps = refreshWorkerDeps(ctx1)
    expect(await deps.stillTurned({ institutionId: INST, schemaName: SCHEMA })).toBe(true)
    expect(await deps.stillTurned({ institutionId: INST, schemaName: 'setes_outro' })).toBe(false)
    expect(await deps.stillTurned({ institutionId: 999_999_999, schemaName: SCHEMA })).toBe(false)
  })

  it('cada nota sintética é consultada no fisco EXATAMENTE uma vez no total (Id do DPS e chave), nas duas instâncias somadas', () => {
    for (const s of SYN) {
      expect([s.inv, fisco.dpsById.get(s.dpsId) ?? 0]).toEqual([s.inv, 1])
      expect([s.inv, fisco.queryByKey.get(s.key) ?? 0]).toEqual([s.inv, 1])
    }
    expect(fisco.other).toBe(0)                                    // nada de transmitir nem cancelar
  })

  it('exatamente UMA das duas instâncias pula o estabelecimento (`skipped` — o aluguel na linha da habilitação, D-F41) e a outra consulta as 4', () => {
    const reports = [ofInst(result.a!), ofInst(result.b!)]
    expect(reports.map(r => r.error ?? null)).toEqual([null, null])
    expect(reports.filter(r => r.report!.skipped)).toHaveLength(1)
    const ran = reports.find(r => !r.report!.skipped)!.report!
    expect(ran).toMatchObject({ checked: N, changed: N, stoppedEarly: false, errors: [] })
  })

  it('a 3ª rodada logo depois não consulta nada (a nota consultada sai das candidatas pela janela de REFRESH_MIN_MINUTES)', () => {
    expect(ofInst(result.third!).report).toMatchObject({ checked: 0, skipped: false })
  })

  it('a voz gravada pelo worker é A, fonte Q, SEM autor (`tb_user_id` NULL — D-F239), uma por nota', async () => {
    const rows = await q(`SELECT tb_invoice_id AS inv, kind, source, tb_user_id AS userId FROM tb_invoice_service_transmission_event
                           WHERE tb_institution_id = ? AND tb_invoice_id IN (?) ORDER BY tb_invoice_id, event`, [INST, SYN.map(s => s.inv)])
    expect(rows.map(r => ({ inv: Number(r.inv), kind: r.kind, source: r.source, userId: r.userId })))
      .toEqual(SYN.map(s => s.inv).sort((x, y) => x - y).map(inv => ({ inv, kind: 'A', source: 'Q', userId: null })))
  })

  it('o aluguel foi devolvido (nenhuma passada ficou com a habilitação)', async () => {
    const [row] = await q(`SELECT refresh_lease_until AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
    expect(row.u ?? null).toBeNull()
  })
})
