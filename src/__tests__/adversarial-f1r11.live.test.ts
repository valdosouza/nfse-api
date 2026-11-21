/// <reference types="jest" />
// GATE ADVERSARIAL r11 — DELTA da sessão 2026-10-10 (Rodada 6 + correções do socrático M2/M3/L1 + D-F56/D-F57) — AO VIVO:
// banco do dev (ERP só LIDO) + FISCO FALSO + CÓPIA DESCARTÁVEL `fiscal_api_adv_r11` (harness `live-harness.ts`).
// Nasceu como "r8" naquela máquina; na reconciliação com a 3ª sessão de 2026-10-04 (que já tinha r8–r10) virou r11 — os ids
// ADV-R8-xx ficam como registro. ⚠️ Só roda com NFSE_ADV_LIVE=1. Molde: r7.
// Alvos:
//  A. D-F46 (b) + D-F47 + D-F51 da 3ª sessão de 2026-10-04 (a D-F47 desta sessão — licença só na transmissão nova — foi
//     REVOGADA na reconciliação): ramo fora do contrato = 403 para todos nas rotas por nota; a PASSADA do admin fecha só as
//     tentativas vivas (em voo interrompida → F por consulta); a autorizada não volta ao rodízio. O fim do contrato é
//     SIMULADO por `spyContractCut` (as leituras do veredito — costura A1) (o ERP não é escrito).
//  B. M2 — decisão do cancelamento: estado (idempotente/recusas) ANTES de `openIssuer` travante; corrida de cancelamentos e
//     cancelar × DELETE do A1 × PUT/DELETE da habilitação.
//  C. L1 — passo 5 do ato (`UPDATE … model IN (?)` pela PK) — nenhuma trava de FAIXA (o SQL é LIDO do script).
//  D. D-F57 — a lacuna (b) olha a LINHA SE: trava × contagem × predicado × guarda em todos os estados; rotas e peças no
//     estado "55 virada + SE só no ERP"; re-sincronia; `--cutover` (ENSAIO — M3: sem `--vai` é ensaio) nesse estado.
// Isolamento (molde do r7): adaptador FALSO + transporte do núcleo que explode (nenhum byte ao fisco real); o ERP só é LIDO
// pelas rotas — o ENSAIO do ato executa a escrita no ERP e a DESFAZ na mesma transação (como o r6 §H); CHECKSUM do ERP e do
// `fiscal_api` real antes/depois; toda escrita do teste passa por `w()`; processos filhos SEMPRE com `copyEnv()` e NUNCA
// com `--vai` (o ensaio sem `--vai` só roda se a linha do DRY no script for a conferida neste gate — senão usa `--dry-run`).
//
// Achados (os `it.failing` reproduzem; cada um tem o `it` de CENÁRIO/registro antes):
//  - [LOW ADV-R8-02 → Q-F66 = Q-F60 da 3ª sessão → D-F51] obrigação EM VOO interrompida (sem voz há > 10 min) SEM NFS-e no
//    fisco não tinha como ser concluída com o ramo fora do contrato — o único caminho que gravava o F era o passo (0b) do
//    TRANSMITIR (barrado pela licença). Fechado pela D-F51 (F por consulta) + D-F47 (a passada fecha as vivas do ramo cortado).
//  - [LOW ADV-R8-08] D-F57: o `--cutover` no estado "55 virada + SE só no ERP" falha com "já VIRADA — write-once" (o passo 2
//    decide por TODAS as linhas; a re-sincronia já decide pela linha SE). Fail-closed, mensagem falsa; contorno: re-sincronia
//    antes (que copia a SE como réplica).
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r11.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { spawnSync } from 'child_process'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError, createFiscalPool, dbConfigFromEnv, withTransaction, ISSUER_MODELS } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, attackVerifier, FISCAL_COPY_TABLES, licensedFact, spyContractCut, attackSession } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import { transmitServiceInvoice, refreshOpenServiceTransmissions, resetMunicipalTermsCache } from '../nfse/transmission'
// parte 2 da NE-1a (D-NE9): as vivas são contadas pelo EMITTER do núcleo (leituras PUBLICADAS de todas as famílias)
const countLiveTransmissions = (q: any, inst: number, environment?: 'H' | 'P') => fiscal.countLiveTransmissions(q, inst, { branches: 'all', environment })
import { argumentErrors } from '../../scripts/migrate-args'
import { refOf, webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

// mesma normalização EM MEMÓRIA das rodadas 1–7: o ramo congelado das notas do dev tem cTribMun "0102" (anterior à D-N26b)
jest.mock('../facts/service-facts', () => {
  const actual = jest.requireActual('../facts/service-facts')
  return {
    __esModule: true, ...actual,
    readServiceInvoice: async (...args: any[]) => {
      // D-F231: cTribMun normalizado e ramo do ERP Desktop completado pelo ramo-molde da web — SÓ em memória (live-harness)
      return jest.requireActual('./live-harness').completeBranchForAttack(await actual.readServiceInvoice(...args), args)
    },
  }
})

const LIVE = process.env.NFSE_ADV_LIVE === '1'
const d = LIVE ? describe : describe.skip
jest.setTimeout(300_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const OTHER = 2                                   // institution que NÃO existe no setes_central (só no token, app sem identidade)
const SCHEMA = 'setes_setes'
const ADV_USER = 990008
const CNPJ = '07742094000113'
const COPY = 'fiscal_api_adv_r11'
const REAL = 'fiscal_api'
const SYN = 990801                                // institution SINTÉTICA (só na cópia; o ERP não tem SE dela)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-10T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R8</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
const ambiguous = () => new AuthorityHttpError(503, 'Fisco sem resposta (falso — ambíguo)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const fisco = {
  byKey: new Map<string, string>(),
  calls: { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 },
  /** 'ok' = o pedido de cancelamento é registrado (após `eventDelay` ms); 'ambiguous' = sem resposta (K fica). */
  eventMode: 'ambiguous' as 'ok' | 'ambiguous',
  eventDelay: 0,
}
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() { fisco.calls.transmit++; throw ambiguous() },          // a reserva fica EM VOO
  async queryNfse(_ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    const dpsId = fisco.byKey.get(accessKey)
    if (!dpsId) throw notFound()
    return { accessKey, status: 'authorized' as const, nfseXml: nfseXml(accessKey, dpsId), dhProc: '2026-10-10T10:00:00-03:00' }
  },
  async queryDpsAccessKey(_ctx: AuthorityContext, dpsId: string) {
    fisco.calls.dps++
    return [...fisco.byKey.entries()].find(([, id]) => id === dpsId)?.[0] ?? null
  },
  async registerEvent() {
    fisco.calls.event++
    if (fisco.eventDelay) await sleep(fisco.eventDelay)
    if (fisco.eventMode === 'ambiguous') throw ambiguous()
    return { dhEvento: '2026-10-10T10:05:00-03:00', protocol: null, eventXml: null, raw: null }
  },
  async municipalTerms() { fisco.calls.terms++; return { cancelDays: 60, raw: null } },
}
function resetFisco(): void { fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 }; fisco.eventMode = 'ambiguous'; fisco.eventDelay = 0 }

const tmpRoot = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r11-')) : ''
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
let ctxShort: AppContext
let shortPool: ReturnType<typeof createFiscalPool> | null = null
let harness: DisposableFiscalDb | null = null
let attack: { liveAdmin: number; restore(): void } | null = null   // D-F231: a sessão do ataque (live-harness)
let app: any
let appNoId: any
let rootPool: ReturnType<typeof createFiscalPool>
let setesUser = '', setesPass = ''

const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]
async function w(sql: string, params: any[] = []): Promise<any> {
  if (/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql)) {
    const target = sql.split(/\bSELECT\b/i)[0]
    if (/`?fiscal_api`?\s*\.|`?setes_[a-z0-9_]*`?\s*\./i.test(target)) throw new Error(`ADV r11: escrita fora da cópia recusada: ${sql.slice(0, 90)}`)
  }
  return (await ctx.pool.query(sql, params))[0]
}
const rq = async (sql: string, params: any[] = []) => (await rootPool.query(sql, params))[0] as any[]

const REAL_TABLES = [...FISCAL_COPY_TABLES, '_migrations']
const ERP_TABLES = ['tb_establishment_issuer', 'tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_invoice_service_transmission',
  'tb_invoice_service_transmission_event', 'tb_institution_has_interface', 'tb_user_has_privilege'].map(t => `${SCHEMA}.${t}`)
  .concat(['setes_central.tb_institution', 'setes_central.tb_company'])
const sumsOf = async (tables: string[]) =>
  Object.fromEntries((await rq(`CHECKSUM TABLE ${tables.join(', ')}`)).map((r: any) => [r.Table, String(r.Checksum)]))
const realSums = async () => ({
  sums: await sumsOf(REAL_TABLES.map(t => `${REAL}.${t}`)),
  objects: (await rq(`SELECT table_name AS t, table_type AS k FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [REAL]))
    .map((r: any) => `${r.t}:${r.k}`).join(','),
})
const erpSums = () => sumsOf(ERP_TABLES)
const fiscalDbs = async () => (await rq(`SHOW DATABASES LIKE 'fiscal%'`)).map((r: any) => String(Object.values(r)[0])).sort()
const erpSe = async () => (await rq(`SELECT serie, deleted, dps_last_number AS n FROM \`${SCHEMA}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]

async function waitBlocked(blockerCid: number, patterns: RegExp[], count = 1, ms = 20_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const pl = await rq('SHOW FULL PROCESSLIST')
    if (pl.filter(p => Number(p.Id) !== blockerCid && patterns.every(re => re.test(String(p.Info ?? '')))).length >= count) return true
    await sleep(40)
  }
  return false
}
const outcome = (p: Promise<any>) => p.then(() => 'ok', (e: any) => [e?.statusCode ?? e?.errno ?? 'X', e?.code ?? null])
const httpOut = (r: request.Response) => (r.status < 300 ? r.status : [r.status, r.body?.code ?? null])

// ---- linhas SINTÉTICAS (só na cópia) ------------------------------------------------------------------------------
const lifeOf = async (inv: number) => (await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, fiscal.invoiceRef(INST, inv, fiscal.WEB_TERMINAL)))!.lifeEvent!
async function seedDps(inst: number, inv: number, life: number, n: number): Promise<string> {
  const dpsId = `DPS4106902${'2'}${CNPJ}00999${String(n).padStart(15, '0')}`
  await w(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, '999', ?, ?, ?, NOW(), NOW(), 'N')`, [inst, inv, life, n, dpsId, ADV_USER])
  return dpsId
}
/** Tentativa 1 da nota: `voice` = última voz (null = em voo, sem voz); `minutesAgo` = idade; `deleted` = excluída. */
async function seedAttempt(inv: number, opts: { voice: 'A' | 'R' | 'F' | null; minutesAgo: number; deleted?: boolean; inst?: number; life?: number }): Promise<{ key: string | null; dpsId: string }> {
  const inst = opts.inst ?? INST
  const life = opts.life ?? await lifeOf(inv)
  const dpsId = await seedDps(inst, inv, life, 990_800_000 + inv)
  const key = opts.voice === 'A' ? (`41069022${CNPJ}98${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50) : null
  await w(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', ?, ?, ${key ? 'DATE_SUB(NOW(), INTERVAL ? MINUTE)' : 'NULL + ?'}, NULL, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW(), ?)`,
    [inst, inv, life, key, key ? '990001' : null, opts.minutesAgo, ADV_USER, opts.minutesAgo, opts.deleted ? 'S' : 'N'])
  if (opts.voice) {
    await w(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
             VALUES (?, ?, 0, 1, 1, ?, NULL, 'voz SINTÉTICA (adversarial r11)', DATE_SUB(NOW(), INTERVAL ? MINUTE), 'P', ?, DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW(), 'N')`,
      [inst, inv, opts.voice, opts.minutesAgo, ADV_USER, opts.minutesAgo])
  }
  if (key) fisco.byKey.set(key, dpsId)
  return { key, dpsId }
}
async function purge(ids: number[], inst = INST): Promise<void> {
  for (const id of ids) {
    await w(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
    await w(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
    await w(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
  }
}
const kindsOf = async (inv: number) => (await q(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt, event`, [INST, inv])).map(r => String(r.kind))
const attemptsOf = async (inv: number) => Number((await q(`SELECT COUNT(*) AS n FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, inv]))[0].n)
const issuerRowsOf = async (inst: number) => (await q(`SELECT model, deleted, dps_last_number AS n, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c
                                                          FROM tb_establishment_issuer WHERE tb_institution_id = ? ORDER BY model`, [inst]))
  .map((r: any) => `${r.model}:${r.c ? 'virada' : 'replica'}:${r.deleted}`)
const certOfCopy = async () => (await q(`SELECT deleted, fingerprint256 AS fp FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0] ?? null
async function restoreIssuerFromReal(): Promise<void> {
  await w(`DELETE FROM \`${COPY}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
  await w(`INSERT INTO \`${COPY}\`.tb_establishment_issuer SELECT * FROM \`${REAL}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
  // D-F231: a origem destas suítes é a RÉPLICA (o real foi VIRADO na janela da F2a, 2026-10-14/15) — a cópia volta réplica
  await w(`UPDATE \`${COPY}\`.tb_establishment_issuer SET cutover_at = NULL WHERE tb_institution_id = ?`, [INST])
}
const restoreCertFromReal = () =>
  w(`REPLACE INTO \`${COPY}\`.tb_establishment_certificate SELECT * FROM \`${REAL}\`.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST])
const turnCopy = () => w(`UPDATE tb_establishment_issuer SET cutover_at = NOW(), environment = 'H', serie = '900', deleted = 'N', refresh_lease_until = NULL
                          WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
type RowSpec = { model: 'SE' | '55' | '65'; turned: boolean; deleted?: boolean }
async function putRows(inst: number, rows: RowSpec[]): Promise<void> {
  // o contador da SE acompanha o do ERP (a re-sincronia acusa dual-write se o ERP passou a API — assertFrozen); fixo em 3 o
  // teste envelheceu quando a NFS-e 706 de produção (2026-10-10) levou o ERP a 4. Sem SE no ERP (sintética), 3 como antes.
  const erp = (await q(`SELECT dps_last_number AS n FROM \`${SCHEMA}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [inst]))[0]
  const seCounter = erp ? Number(erp.n) : 3
  await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [inst])
  for (const r of rows) {
    await w(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
             VALUES (?, ?, 'H', '1', ?, NOW(), NOW(), ?, ${r.turned ? `'2026-10-10 09:00:00'` : 'NULL'})`, [inst, r.model, r.model === 'SE' ? seCounter : 0, r.deleted ? 'S' : 'N'])
  }
}

/** Processo filho SEMPRE apontado para a CÓPIA e NUNCA com `--vai`. */
const guardArgs = (args: string[]) => {
  if (args.includes('--vai')) throw new Error('ADV r11: --vai é proibido nesta suíte')
  if (argumentErrors(args).length) throw new Error(`ADV r11: argumentos inválidos para o script: ${argumentErrors(args).join()}`)
}
// D-F53: a re-sincronia na CÓPIA roda com o usuário do SERVIÇO; só o ENSAIO do ato (escreve no ERP e desfaz) leva o DONO
const copyEnv = () => ({ FISCAL_DB_NAME: COPY, DB_USER: process.env.DB_USER ?? '', DB_PASSWORD: process.env.DB_PASSWORD ?? '' })
const ownerEnv = () => ({ FISCAL_DB_NAME: COPY, DB_USER: setesUser, DB_PASSWORD: setesPass })
const runScript = (script: string, args: string[]) => {
  guardArgs(args)
  const env = args.includes('--cutover') ? ownerEnv() : copyEnv()
  const r = spawnSync('npm', ['run', script, '--', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}
/** M3: o ENSAIO sem `--vai` só roda se a linha que decide o DRY no script for EXATAMENTE a conferida neste gate. */
const SCRIPT_SRC = () => fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
const DRY_LINE = `const DRY = ARGS.includes('--dry-run') || (CUTOVER !== undefined && !ARGS.includes('--vai'))`

let realBefore: { sums: Record<string, string>; objects: string } = { sums: {}, objects: '' }
let erpBefore: Record<string, string> = {}
let X = 0, Z = 0, Z2 = 0

d('GATE ADVERSARIAL r11 (o "r8" de 2026-10-10) — delta da sessão 2026-10-10 (cópia descartável fiscal_api_adv_r11 + fisco falso)', () => {
  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(ROOT, '..', 'setes-api', '.env')))
    setesUser = setesEnv.DB_USER; setesPass = setesEnv.DB_PASSWORD ?? ''
    rootPool = createFiscalPool({ ...dbConfigFromEnv(process.env), database: 'information_schema', user: setesUser, password: setesPass })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r11: rede bloqueada — nenhum fisco real') }
    expect(await fiscalDbs()).toEqual([REAL])
    realBefore = await realSums()
    erpBefore = await erpSums()
    const cwd = process.cwd(); process.chdir(ROOT)
    try { harness = await disposableFiscalDb(ROOT, COPY, { turned: false }) } finally { process.chdir(cwd) }
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool, verifier: attackVerifier() })
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    attack = await attackSession(fiscal, harness!.pool, SCHEMA, INST)   // D-F231: acesso VIVO de um admin real — depois do ctx (falhar aqui ainda passa pelo afterAll)
    expect(ctx.fiscalDb).toBe(COPY)
    expect((await q('SELECT DATABASE() AS db'))[0].db).toBe(COPY)
    shortPool = createFiscalPool(harness.cfg)
    shortPool.on('connection', (c: any) => c.query('SET SESSION innodb_lock_wait_timeout = 3', () => { /* sessão */ }))
    ctxShort = { ...ctx, pool: shortPool }
    expect((await shortPool.query('SELECT DATABASE() AS db, @@session.innodb_lock_wait_timeout AS t'))[0]).toEqual([{ db: COPY, t: 3 }])
    app = createApp(ctx)
    appNoId = createApp({ ...ctx, checkIdentity: false })
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

    const svc = await import('../facts/service-facts')
    const busy = new Set((await q(`SELECT DISTINCT tb_invoice_id AS id FROM tb_invoice_service_transmission WHERE tb_institution_id = ?`, [INST])).map(r => Number(r.id)))
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND i.issuer = i.tb_institution_id AND l.last_kind = 'E'
        AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
      ORDER BY i.id DESC LIMIT 400`, [INST])
    for (const r of rows) {
      const id = Number(r.id)
      if (busy.has(id)) continue
      const key = await fiscal.erp.orderInterface(ctx.pool, SCHEMA, fiscal.invoiceRef(INST, id, fiscal.WEB_TERMINAL))
      if (!(await licensedFact(ctx.pool, SCHEMA, INST, key))) continue
      if (!X) {
        try {
          const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, refOf(INST, id))
          await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
          X = id; continue
        } catch { /* cadastro incompleto — serve só de alvo sintético */ }
      }
      if (!Z) { Z = id; continue }
      if (!Z2) Z2 = id
      if (X && Z && Z2) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r11] notas-alvo: transmite', X, '| sintéticas', Z, Z2)
    expect(X).toBeGreaterThan(0)
    expect(Z).toBeGreaterThan(0)
    expect(Z2).toBeGreaterThan(0)
  })
  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    let dbsAfter: string[] = [], realAfter = { sums: {} as Record<string, string>, objects: '' }, erpAfter: Record<string, string> = {}
    let dropErr: unknown = null
    try {
      if (shortPool) { try { await shortPool.end() } catch { /* já encerrado */ } }
      attack?.restore(); attack = null
      if (harness) { try { await harness.drop() } catch (e) { dropErr = e } }   // apaga a cópia e FALHA se o real/ERP mudou
      if ((await fiscalDbs()).includes(COPY)) await rootPool.query(`DROP DATABASE IF EXISTS \`${COPY}\``)
      dbsAfter = await fiscalDbs()
      realAfter = await realSums()
      erpAfter = await erpSums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r11] fiscal_api REAL antes', JSON.stringify(realBefore), '| depois', JSON.stringify(realAfter),
        '\n[adv-r11] ERP antes', JSON.stringify(erpBefore), '| depois', JSON.stringify(erpAfter), '\n[adv-r11] bancos fiscal% no fim', dbsAfter.join(','))
      await rootPool.end()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (dropErr) throw dropErr
    if (JSON.stringify(realAfter) !== JSON.stringify(realBefore)) throw new Error('O fiscal_api REAL mudou durante o ataque — conferir')
    if (JSON.stringify(erpAfter) !== JSON.stringify(erpBefore)) throw new Error('O ERP mudou durante o ataque — conferir')
    if (JSON.stringify(dbsAfter) !== JSON.stringify([REAL])) throw new Error(`Sobrou banco fiscal%: ${dbsAfter.join(',')}`)
  })

  // =========================================================================
  describe('A. D-F46 (b) + D-F47 + D-F51 — contrato do ramo ENCERRADO (simulado): bloqueio total; a PASSADA só fecha o que estava vivo', () => {
    // Reconciliação 2026-10-10: a D-F47 desta máquina (licença barra só a transmissão nova) foi REVOGADA — vale a D-F46 (b)
    // da 3ª sessão de 2026-10-04. Estes testes provam AO VIVO o código daquela sessão (que só tinha rodado unitário na nuvem).
    let spy: { mockRestore(): void }
    beforeAll(async () => { await purge([X, Z, Z2]); await purge([Z], OTHER); await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy() })
    beforeEach(() => { spy = spyContractCut(fiscal) })
    afterEach(() => spy.mockRestore())
    afterAll(async () => { await purge([X, Z, Z2]); await purge([Z], OTHER); await restoreIssuerFromReal(); await restoreCertFromReal() })

    const call = async (a: any, m: 'get' | 'post', p: string, body?: any, t = tok()) => httpOut(await (request(a) as any)[m](p).set(bearer(t)).send(body))
    const userTok = () => tok({ role: 'user' })
    const queriedAt = async (inv: number) => (await q(`SELECT last_queried_at AS t FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, inv]))[0]?.t ?? null

    it('sem achado (D-F46): tentativa REJEITADA (R) com o ramo fora do contrato — transmitir, consultar, reconferir, cancelar, ler e XML = 403 para TODOS (admin incluso); nada vai ao fisco', async () => {
      await purge([Z]); await seedAttempt(Z, { voice: 'R', minutesAgo: 24 * 60 })
      const out: any = {}
      for (const [who, t] of [['admin', tok()], ['user', userTok()]] as const) {
        out[who] = {
          transmit: await call(app, 'post', `/v1/nfse/invoices/${Z}/transmit`, undefined, t),
          refresh: await call(app, 'post', `/v1/nfse/invoices/${Z}/refresh`, undefined, t),
          reconfirm: await call(app, 'post', `/v1/nfse/invoices/${Z}/reconfirm`, undefined, t),
          cancel: await call(app, 'post', `/v1/nfse/invoices/${Z}/cancel`, { reason: 'adversarial r11 D-F46 rejeitada' }, t),
          view: await call(app, 'get', `/v1/nfse/invoices/${Z}`, undefined, t),
          xml: await call(app, 'get', `/v1/nfse/invoices/${Z}/xml`, undefined, t),
        }
      }
      out.userPass = await call(app, 'post', '/v1/nfse/refresh', {}, userTok())
      out.pending = (await request(app).get('/v1/nfse/invoices/pending?pageSize=5').set(bearer(tok()))).body?.total
      out.attempts = await attemptsOf(Z); out.fisco = { ...fisco.calls }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] A1 D-F46 rejeitada + contrato encerrado', JSON.stringify(out))
      const denied = [403, 'INTERFACE_NOT_ALLOWED']
      for (const who of ['admin', 'user']) expect(Object.values(out[who])).toEqual(Array(6).fill(denied))
      expect(out.userPass).toEqual(denied)                                  // nada contratado e não admin: a passada nem roda
      expect(out.pending).toBe(0)                                           // candidatas a transmissão: só ramo contratado
      expect(out.attempts).toBe(1)
      expect(out.fisco).toMatchObject({ transmit: 0, event: 0, dps: 0 })
    })

    const inflight: any = {}
    it('[D-F47 + D-F51] tentativa EM VOO interrompida (sem voz há 20 min, fisco SEM o DPS), ramo fora do contrato: rota por nota = 403; a PASSADA do admin a fecha com F por consulta e nada novo vai ao fisco', async () => {
      await purge([X]); await seedAttempt(X, { voice: null, minutesAgo: 20 })
      inflight.refreshByNote = await call(app, 'post', `/v1/nfse/invoices/${X}/refresh`)
      inflight.userPass = await call(app, 'post', '/v1/nfse/refresh', {}, userTok())
      inflight.adminPass = (await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({})).body?.data
      inflight.cancel = await call(app, 'post', `/v1/nfse/invoices/${X}/cancel`, { reason: 'adversarial r11 D-F46 em voo' })
      inflight.kinds = await kindsOf(X)
      inflight.source = (await q(`SELECT source FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY event DESC LIMIT 1`, [INST, X]))[0]?.source
      inflight.fisco = { ...fisco.calls }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] A2 em voo interrompida + contrato encerrado', JSON.stringify(inflight))
      expect(inflight.refreshByNote).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
      expect(inflight.userPass).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
      expect(inflight.adminPass).toMatchObject({ checked: 1, changed: 1 })   // D-F47: admin sem nada contratado roda só as vivas
      expect(inflight.kinds).toEqual(['F'])                                  // D-F51: E2404 + ≥ 10 min = F "sem resposta"
      expect(inflight.source).toBe('Q')
      expect(inflight.cancel).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
      expect(inflight.fisco.transmit).toBe(0)
    })
    it('registro ADV-R8-02: com o ramo CONTRATADO de volta, transmitir abre uma tentativa NOVA (a F da passada fica como história)', async () => {
      spy.mockRestore()                                                 // contrato vigente (o ERP real tem os 3 ramos)
      const r = await call(app, 'post', `/v1/nfse/invoices/${X}/transmit`)
      const after = { r, kinds: await kindsOf(X), attempts: await attemptsOf(X), sent: fisco.calls.transmit }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] A2b em voo + contrato vigente: transmitir', JSON.stringify(after))
      expect(after.kinds[0]).toBe('F')
      expect(after.attempts).toBe(2)
      expect(after.sent).toBe(1)
      spy = spyContractCut(fiscal)
    })

    it('sem achado (D-F47): a AUTORIZADA (A) de ramo cortado NÃO volta ao rodízio — a passada do admin não a consulta nem carimba', async () => {
      await purge([X, Z]); await seedAttempt(Z, { voice: 'A', minutesAgo: 26 * 60 })   // vencida para a revisita de 24 h (D-N21)
      const pass = (await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({})).body?.data
      const out = { pass, queried: await queriedAt(Z), fisco: { ...fisco.calls } }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] A3 autorizada de ramo cortado × passada', JSON.stringify(out))
      expect(out.pass).toMatchObject({ checked: 0, changed: 0 })
      expect(out.queried).toBeNull()
      expect(out.fisco.query).toBe(0)
      // controle: com o contrato de volta a MESMA autorizada entra na passada (o filtro, não a idade, a tirou)
      spy.mockRestore()
      const control = (await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({})).body?.data
      expect(control.checked).toBeGreaterThanOrEqual(1)
      expect(await queriedAt(Z)).not.toBeNull()
      spy = spyContractCut(fiscal)
    })

    it('sem achado: tentativa de OUTRA institution na MESMA nota não abre nada — e a institution 2 também é barrada pela licença', async () => {
      await purge([Z]); await purge([Z], OTHER)
      await seedAttempt(Z, { voice: 'R', minutesAgo: 60, inst: OTHER, life: 1 })   // só na cópia
      const t2 = tok({ institutionId: OTHER })
      const out = {
        inst1View: await call(app, 'get', `/v1/nfse/invoices/${Z}`),
        inst1Refresh: await call(app, 'post', `/v1/nfse/invoices/${Z}/refresh`),
        inst2View: await call(appNoId, 'get', `/v1/nfse/invoices/${Z}`, undefined, t2),
        inst2Xml: await call(appNoId, 'get', `/v1/nfse/invoices/${Z}/xml`, undefined, t2),
        inst2Transmit: await call(appNoId, 'post', `/v1/nfse/invoices/${Z}/transmit`, undefined, t2),
        inst2Refresh: await call(appNoId, 'post', `/v1/nfse/invoices/${Z}/refresh`, undefined, t2),
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] A4 tentativa de outra institution', JSON.stringify(out))
      for (const v of Object.values(out)) expect(JSON.stringify(v)).not.toMatch(/^200$/)
      expect([out.inst1View, out.inst1Refresh]).toEqual([[403, 'INTERFACE_NOT_ALLOWED'], [403, 'INTERFACE_NOT_ALLOWED']])
      expect(fisco.calls).toMatchObject({ transmit: 0, event: 0 })
    })
  })

  // =========================================================================
  describe('B. M2 — decisão do cancelamento: estado ANTES de abrir o emissor; corrida com o A1 e a habilitação', () => {
    beforeAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy() })
    afterAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal(); await restoreCertFromReal() })
    const cancelRoute = (reason: string) => request(app).post(`/v1/nfse/invoices/${Z}/cancel`).set(bearer(tok())).send({ reason })
      .then(r => (r.status < 300 ? { s: r.status, atAuthority: r.body?.data?.atAuthority } : { s: r.status, code: r.body?.code }))

    it('sem achado: 6 cancelamentos SIMULTÂNEOS da mesma NFS-e → UM pedido ao fisco, UM K e UM C; os outros 409 em voo ou ok idempotente; zero 500', async () => {
      await purge([Z]); await seedAttempt(Z, { voice: 'A', minutesAgo: 60 * 24 })
      fisco.eventMode = 'ok'; fisco.eventDelay = 400
      const res = await Promise.all(Array.from({ length: 6 }, (_, i) => sleep(i * 15).then(() => cancelRoute(`adversarial r11 corrida ${i}`))))
      const kinds = await kindsOf(Z)
      // eslint-disable-next-line no-console
      console.log('[adv-r11] B1 6 cancelamentos simultâneos', JSON.stringify(res), JSON.stringify(kinds), 'pedidos', fisco.calls.event)
      expect(JSON.stringify(res)).not.toMatch(/"s":500|INTERNAL|ER_LOCK/)
      expect(res.filter(r => r.s === 200 && r.atAuthority === true)).toHaveLength(1)
      for (const r of res) if (!(r.s === 200)) expect(r).toEqual({ s: 409, code: 'FISCAL_CANCEL_IN_FLIGHT' })
      expect(fisco.calls.event).toBe(1)
      expect(kinds).toEqual(['A', 'K', 'C'])
    })

    it('sem achado (M2 ao vivo): com a voz C já gravada, o A1 APAGADO não troca o ok idempotente por 409 — o emissor nem é aberto', async () => {
      const del = httpOut(await request(app).delete('/v1/emitter/certificate').set(bearer(tok())))
      const cert = await certOfCopy()
      const again = await cancelRoute('adversarial r11 repetido sem A1')
      // eslint-disable-next-line no-console
      console.log('[adv-r11] B2 idempotente sem A1', JSON.stringify({ del, cert, again }))
      expect(del).toBe(200)
      expect(cert?.deleted).toBe('S')
      expect(again).toEqual({ s: 200, atAuthority: false })
      expect(fisco.calls.event).toBe(0)
      await restoreCertFromReal()
    })

    it('sem achado: 8 rodadas embaralhadas cancelar × DELETE do A1 × PUT da habilitação × DELETE da habilitação (fisco alterna ok/ambíguo) — nenhum 500/1213/1205; nunca K vivo sem A1 ou sem habilitação; pedido ao fisco só com K', async () => {
      const rounds: any[] = []
      const viol: string[] = []
      let seed = 11
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
      for (let i = 0; i < 8; i++) {
        await purge([Z])
        await w(`UPDATE tb_establishment_issuer SET deleted = 'N', environment = 'H', serie = '900', refresh_lease_until = NULL WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
        await restoreCertFromReal()
        await seedAttempt(Z, { voice: 'A', minutesAgo: 60 * 24 })
        resetFisco(); fisco.eventMode = i % 2 ? 'ambiguous' : 'ok'; fisco.eventDelay = 50
        const ops: (() => Promise<any>)[] = [
          () => cancelRoute(`adversarial r11 rodada ${i}`),
          () => request(app).delete('/v1/emitter/certificate').set(bearer(tok())).then(httpOut),
          () => request(app).put('/v1/emitter/issuers/SE').set(bearer(tok())).send({ environment: 'H', serie: String(900 + i) }).then(httpOut),
          () => request(app).delete('/v1/emitter/issuers/SE').set(bearer(tok())).then(httpOut),
        ]
        const delays = ops.map(() => Math.floor(rnd() * 120))
        const res = await Promise.all(ops.map((op, k) => sleep(delays[k]).then(op)))
        const live = await countLiveTransmissions(ctx.pool, INST)
        const cert = await certOfCopy()
        const se = (await q(`SELECT deleted FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
        const kinds = await kindsOf(Z)
        const kLive = kinds[kinds.length - 1] === 'K'
        if (kLive && cert?.deleted === 'S') viol.push(`rodada ${i}: K vivo sem A1`)
        if (kLive && se?.deleted === 'S') viol.push(`rodada ${i}: K vivo sem habilitação`)
        if (fisco.calls.event > 0 && !kinds.includes('K')) viol.push(`rodada ${i}: pedido ao fisco sem K`)
        if (fisco.calls.event > 1) viol.push(`rodada ${i}: ${fisco.calls.event} pedidos`)
        rounds.push({ mode: fisco.eventMode, delays, res, live, cert: cert?.deleted, se: se?.deleted, kinds, pedidos: fisco.calls.event })
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] B3 corrida cancelamento × A1 × habilitação', JSON.stringify(rounds), '| violações', JSON.stringify(viol))
      expect(JSON.stringify(rounds)).not.toMatch(/"s":500|\[500|INTERNAL|1213|1205|ER_LOCK/)
      expect(viol).toEqual([])
    })
  })

  // =========================================================================
  describe('C. L1 — passo 5 do ato pela PK: nenhuma trava de FAIXA (SQL lido do script)', () => {
    beforeAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal() })
    afterAll(async () => { await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id IN (0, ?)`, [OTHER]); await restoreIssuerFromReal() })
    const src = () => SCRIPT_SRC()
    // o passo 2 vive em `apiIssuerRows` (refatoração da 3ª sessão de 2026-10-04: a mesma leitura serve travante e não travante);
    // o teste monta a forma TRAVANTE como o script a monta (`lockApiIssuers` → forUpdate = true)
    const step2 = () => {
      const m = src().match(/`(SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*?\$\{forUpdate \? ' FOR UPDATE' : ''\})`/)
      if (!m) throw new Error('passo 2 do ato não encontrado no script')
      return m[1]
        .replace(/\$\{ISSUER_MODELS\.map\(\(\) => '\?'\)\.join\(', '\)\}/, ISSUER_MODELS.map(() => '?').join(', '))
        .replace(/\$\{forUpdate \? ' FOR UPDATE' : ''\}/, ' FOR UPDATE')
    }
    const step5 = () => {
      const m = src().match(/`(UPDATE tb_establishment_issuer SET cutover_at = NOW\(\), updated_at = NOW\(\)[\s\S]*?)`/)
      if (!m) throw new Error('passo 5 do ato não encontrado no script')
      return m[1]
    }
    const RANGE_FORM = `UPDATE tb_establishment_issuer SET cutover_at = NOW(), updated_at = NOW() WHERE tb_institution_id = ? AND cutover_at IS NULL`

    async function scenario(update: string, params: any[]): Promise<any> {
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      const conn = await ctx.pool.getConnection()
      const out: any = {}
      try {
        const [[{ cid }]] = await conn.query('SELECT CONNECTION_ID() AS cid') as any
        await conn.beginTransaction()
        await conn.query(step2(), [INST, ...ISSUER_MODELS])                            // passo 2: as linhas, FOR UPDATE por linha
        const pLease = fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 90).then(t => (t ? 'alugou' : 'nulo'), (e: any) => [e.errno, e.code])
        out.queued = await waitBlocked(Number(cid), [/SET refresh_lease_until/i])        // o aluguel ESPERA a linha SE
        out.update = await conn.query(update, params).then(([r]: any) => r.affectedRows, (e: any) => [e.errno, e.code])
        // vizinha ACIMA (institution 2) criando a habilitação enquanto o ato segura — não pode esperar
        const t0 = Date.now()
        out.neighborAbove = await outcome((shortPool as any).query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
                                                                     VALUES (?, 'SE', 'H', '1', 0, NOW(), NOW(), 'N', NOW())`, [OTHER]))
        out.neighborAboveMs = Date.now() - t0
        // vizinha ABAIXO (institution 0) — a F4 (ACEITA, §17): chave AUSENTE (55/65 da institution 1) = trava de INTERVALO
        out.neighborBelow = await outcome((shortPool as any).query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
                                                                     VALUES (0, '55', 'H', '1', 0, NOW(), NOW(), 'N', NOW())`))
        await conn.rollback()
        out.lease = await pLease
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
        await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id IN (0, ?)`, [OTHER])
      }
      return out
    }

    it('sem achado: o passo 5 do script é o UPDATE pela PK (`model IN (?)`) e o EXPLAIN é range na PRIMARY', async () => {
      expect(step5()).toMatch(/WHERE tb_institution_id = \? AND model IN \(\?\) AND cutover_at IS NULL/)
      const ex = await q(`EXPLAIN UPDATE tb_establishment_issuer SET cutover_at = NOW() WHERE tb_institution_id = ? AND model IN ('SE','55','65') AND cutover_at IS NULL`, [INST])
      // eslint-disable-next-line no-console
      console.log('[adv-r11] C EXPLAIN passo 5', JSON.stringify(ex.map((r: any) => `${r.type}:${r.key}`)))
      expect(ex.map((r: any) => `${r.type}:${r.key}`)).toEqual(['range:PRIMARY'])
    })
    it('sem achado (L1): passos 2 + 5 do ato com o aluguel NA FILA da linha SE → nenhum 1213; a vizinha de CIMA cria sem esperar', async () => {
      const out = await scenario(step5(), [INST, ISSUER_MODELS])
      // eslint-disable-next-line no-console
      console.log('[adv-r11] C passo 5 pela PK', JSON.stringify(out))
      expect(out.queued).toBe(true)
      expect(out.update).toBe(1)
      expect(out.lease).toBe('nulo')                                                       // réplica não aluga — e NÃO 1213
      expect(out.neighborAbove).toBe('ok')
      expect(out.neighborAboveMs).toBeLessThan(2_000)
    })
    it('controle (a forma ANTIGA, pela faixa da institution): o mesmo cenário dá 1213 no aluguel — o teste acima discrimina', async () => {
      const out = await scenario(RANGE_FORM, [INST])
      // eslint-disable-next-line no-console
      console.log('[adv-r11] C controle pela FAIXA', JSON.stringify(out))
      expect(out.lease).toEqual([1213, 'ER_LOCK_DEADLOCK'])
    })
  })

  // =========================================================================
  describe('D. D-F57 — a lacuna (b) olha a LINHA SE (estados, rotas, peças, re-sincronia e o ATO em ensaio)', () => {
    beforeAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal(); await restoreCertFromReal() })
    afterAll(async () => {
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [SYN])
      await restoreIssuerFromReal(); await restoreCertFromReal()
    })

    const STATES: Record<string, RowSpec[]> = {
      'nenhuma linha': [],
      'SE réplica viva': [{ model: 'SE', turned: false }],
      'SE réplica excluída': [{ model: 'SE', turned: false, deleted: true }],
      'SE virada': [{ model: 'SE', turned: true }],
      'SE virada excluída': [{ model: 'SE', turned: true, deleted: true }],
      'só 55 virada': [{ model: '55', turned: true }],
      '55 + 65 viradas': [{ model: '55', turned: true }, { model: '65', turned: true }],
      '55 virada + SE réplica': [{ model: '55', turned: true }, { model: 'SE', turned: false }],
      '55 virada + SE virada': [{ model: '55', turned: true }, { model: 'SE', turned: true }],
      '55 virada + SE virada excluída': [{ model: '55', turned: true }, { model: 'SE', turned: true, deleted: true }],
      'só 55 réplica (script antigo)': [{ model: '55', turned: false }],
    }
    const expectedStill = (rows: RowSpec[], erpHasSe: boolean) =>
      rows.some(r => !r.turned) ? true : rows.some(r => r.model === 'SE') ? false : erpHasSe
    // D-NE10 (a): por MODELO — réplica do modelo → ERP; a SE (transmitida pelo ERP) sem linha → o ERP decide; 55/65 nunca
    const expectedStillOf = (rows: RowSpec[], erpHasSe: boolean, model: string) => {
      const mine = rows.filter(r => r.model === model)
      if (mine.some(r => !r.turned)) return true
      if (model !== 'SE') return false
      return mine.length > 0 ? false : erpHasSe
    }

    it('sem achado: em TODOS os estados (institution 1 COM SE no ERP × sintética SEM) trava = contagem e a guarda de escrita = o predicado da cerca', async () => {
      const seen: any[] = []
      for (const [inst, erpHasSe] of [[INST, true], [SYN, false]] as const) {
        for (const [name, rows] of Object.entries(STATES)) {
          await putRows(inst, rows)
          const state = await fiscal.issuerRowsState(ctx.pool, inst)
          const conn = await ctx.pool.getConnection()
          let locked: any, writable: any
          try {
            await conn.beginTransaction()
            locked = await fiscal.lockIssuerRows(conn, inst)
            writable = await fiscal.assertCertificateWritable(conn, SCHEMA, inst).then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : [e?.errno, e?.code]))
          } finally { await conn.rollback(); conn.release() }
          const still = await fiscal.anyEmissionStillInErp(ctx.pool, SCHEMA, inst)
          seen.push({ inst, name, state, locked, still, writable })
          expect([inst, name, state]).toEqual([inst, name, locked])
          expect([inst, name, still]).toEqual([inst, name, expectedStill(rows, erpHasSe)])
          expect([inst, name, writable]).toEqual([inst, name, !still])
          // NE-1a parte 2 (D-NE10 (a)) — no MOTOR real: o predicado e a guarda da habilitação POR MODELO são o mesmo, e o grão do
          // estabelecimento é a disjunção deles sobre o catálogo
          const perModel: boolean[] = []
          for (const model of fiscal.ISSUER_MODELS) {
            const stillM = await fiscal.emissionStillInErp(ctx.pool, SCHEMA, inst, model)
            const c2 = await ctx.pool.getConnection()
            let writableM: any
            try {
              await c2.beginTransaction()
              writableM = await fiscal.assertIssuerWritable(c2, SCHEMA, inst, model).then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : [e?.errno, e?.code]))
            } finally { await c2.rollback(); c2.release() }
            expect([inst, name, model, stillM]).toEqual([inst, name, model, expectedStillOf(rows, erpHasSe, model)])
            expect([inst, name, model, writableM]).toEqual([inst, name, model, !stillM])
            perModel.push(stillM)
          }
          expect([inst, name, perModel.some(Boolean)]).toEqual([inst, name, still])
        }
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D1 matriz da cerca', JSON.stringify(seen))
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [SYN])
    })

    it('sem achado: "só 55 virada" + SE no ERP — rotas e peças da nfse-api recusam com 409 FISCAL_CUTOVER_PENDING e NADA é escrito nem dito ao fisco', async () => {
      await putRows(INST, [{ model: '55', turned: true }])
      const before = { rows: await issuerRowsOf(INST), cert: await certOfCopy() }
      const t = tok()
      const out: any = {
        transmit: httpOut(await request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(t))),
        refresh: httpOut(await request(app).post(`/v1/nfse/invoices/${X}/refresh`).set(bearer(t))),
        cancel: httpOut(await request(app).post(`/v1/nfse/invoices/${X}/cancel`).set(bearer(t)).send({ reason: 'adversarial r11 D-F57' })),
        pass: httpOut(await request(app).post('/v1/nfse/refresh').set(bearer(t)).send({})),
        putSE: httpOut(await request(app).put('/v1/emitter/issuers/SE').set(bearer(t)).send({ environment: 'H', serie: '1' })),
        putCert: httpOut(await request(app).put('/v1/emitter/certificate').set(bearer(t)).send({ pfxBase64: 'AAAA', password: 'x' })),
        delCert: httpOut(await request(app).delete('/v1/emitter/certificate').set(bearer(t))),
        openIssuer: await outcome(fiscal.openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, INST, 'SE', { schemaName: SCHEMA })),
        upsertDirect: await outcome(withTransaction(ctx.pool, 'adv r11 upsert direto', {}, conn => fiscal.upsertIssuer(conn, SCHEMA, INST, 'SE', { environment: 'H', serie: '1', userId: ADV_USER }))),
        clearDirect: await outcome(fiscal.clearCertificate({ pool: ctx.pool, keyring: ctx.keyring }, INST, ADV_USER, { schemaName: SCHEMA })),
        transmitDirect: await outcome(transmitServiceInvoice(ctx, ACTOR, webRef(ACTOR, X))),
        passDirect: await outcome(refreshOpenServiceTransmissions(ctx, ACTOR, { terminal: WEB, budgetMs: 2000 })),
      }
      const after = { rows: await issuerRowsOf(INST), cert: await certOfCopy() }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D2 só 55 virada + SE no ERP', JSON.stringify(out), JSON.stringify({ before, after }))
      for (const [k, v] of Object.entries(out)) expect([k, v]).toEqual([k, [409, 'FISCAL_CUTOVER_PENDING']])
      expect(after).toEqual(before)
      expect(fisco.calls).toMatchObject({ transmit: 0, event: 0, query: 0, dps: 0 })
      expect(await attemptsOf(X)).toBe(0)
    })

    const act: any = {}
    it('[LOW ADV-R8-08 — CORRIGIDO] `--cutover` (ensaio `--dry-run`) no estado "só 55 virada + SE no ERP": o passo 2 decide pela LINHA SE e ENSAIA a virada (nada fica gravado)', async () => {
      await putRows(INST, [{ model: '55', turned: true }])
      const r = runScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'])
      act.bad = { status: r.status, msg: r.out.match(/FALHA[^\n]*/)?.[0]?.slice(0, 200) ?? null, rows: await issuerRowsOf(INST) }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D3 --cutover no estado D-F57', JSON.stringify(act.bad))
      expect(act.bad.status).toBe(0)
      expect(act.bad.msg).toBeNull()
      expect(act.bad.rows).toEqual(['55:virada:N'])                                             // ensaio: desfeito
    })

    // D-F232 (Valdo, 2026-11-07): HISTÓRICO — ensaia o ato da virada/re-sincronia da institution 1 no mundo de ANTES da virada (habilitação SE viva no ERP e A1 no cofre em arquivo do setes-api). A virada real de 2026-10-14/15 retirou os dois e a F2a congelou a origem; verde até 2026-10-14 (prompt §22.51 e §23.10).
    it.skip('sem achado: a RE-SINCRONIA (grava na CÓPIA) nesse estado copia a SE do ERP como RÉPLICA e não toca a 55 virada nem o A1', async () => {
      await putRows(INST, [{ model: '55', turned: true }])
      const c55 = (await q(`SELECT DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = '55'`, [INST]))[0]
      const fp = (await certOfCopy())?.fp
      const r = runScript('migrate:setes', [])
      const c55after = (await q(`SELECT DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = '55'`, [INST]))[0]
      act.resync = { status: r.status, msg: r.out.match(/FALHA[^\n]*/)?.[0] ?? null, rows: await issuerRowsOf(INST), c55, c55after, fpSame: (await certOfCopy())?.fp === fp }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D4 re-sincronia no estado D-F57', JSON.stringify(act.resync))
      expect(act.resync.status).toBe(0)
      expect(act.resync.rows).toEqual(['55:virada:N', 'SE:replica:N'])
      expect(act.resync.c55after).toEqual(c55)
      expect(act.resync.fpSame).toBe(true)
      expect(await fiscal.anyEmissionStillInErp(ctx.pool, SCHEMA, INST)).toBe(true)             // réplica: o ERP segue emitindo
    })

    // D-F232 (Valdo, 2026-11-07): HISTÓRICO — ensaia o ato da virada/re-sincronia da institution 1 no mundo de ANTES da virada (habilitação SE viva no ERP e A1 no cofre em arquivo do setes-api). A virada real de 2026-10-14/15 retirou os dois e a F2a congelou a origem; verde até 2026-10-14 (prompt §22.51 e §23.10).
    it.skip('sem achado (M3 + D-F57): `--cutover` SEM `--vai` é ENSAIO — vira só a SE réplica (a 55 já virada fica), aposenta a SE do ERP e DESFAZ tudo; cópia e ERP idênticos depois', async () => {
      expect(act.resync?.rows).toEqual(['55:virada:N', 'SE:replica:N'])                         // estado deixado pelo teste anterior
      const safeDefault = SCRIPT_SRC().includes(DRY_LINE)
      const args = ['--cutover', String(INST), '--confirmo-setes-api-parado', ...(safeDefault ? [] : ['--dry-run'])]
      const erpBefore1 = await erpSe()
      const rowsBefore = await issuerRowsOf(INST)
      const r = runScript('migrate:setes', args)
      const out = { safeDefault, args, status: r.status, dry: r.out.match(/"dryRun": (true|false)/)?.[1], committed: r.out.match(/"committed": (true|false)/)?.[1],
        virou: r.out.match(/"linhasViradas": \d+/)?.[0], aposentou: r.out.match(/"habilitacaoErpAposentada": \d+/)?.[0],
        msg: r.out.match(/FALHA[^\n]*/)?.[0] ?? null, erpBefore: erpBefore1, erpAfter: await erpSe(), rowsBefore, rowsAfter: await issuerRowsOf(INST) }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D5 ato em ENSAIO (sem --vai) com a 55 virada', JSON.stringify(out))
      expect(out.safeDefault).toBe(true)                                                         // a linha do DRY é a conferida
      expect([out.status, out.dry, out.committed]).toEqual([0, 'true', 'false'])
      expect([out.virou, out.aposentou]).toEqual(['"linhasViradas": 1', '"habilitacaoErpAposentada": 1'])
      expect(out.erpAfter).toEqual(out.erpBefore)
      expect(out.erpBefore.deleted).toBe('N')
      expect(out.rowsAfter).toEqual(out.rowsBefore)
    })

    it('sem achado: "SE virada EXCLUÍDA + 55 virada" = API (não ERP) — re-sincronia vê CONGELADA; `--cutover` recusa write-once', async () => {
      await putRows(INST, [{ model: '55', turned: true }, { model: 'SE', turned: true, deleted: true }])
      const still = await fiscal.anyEmissionStillInErp(ctx.pool, SCHEMA, INST)
      const rs = runScript('migrate:setes', ['--dry-run'])
      const ct = runScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'])
      const out = { still, resync: [rs.status, /origem congelada/.test(rs.out)], cutover: [ct.status, /já VIRADA/.test(ct.out)], rows: await issuerRowsOf(INST) }
      // eslint-disable-next-line no-console
      console.log('[adv-r11] D6 SE virada excluída + 55', JSON.stringify(out), '| falha da re-sincronia:', rs.out.match(/FALHA[^\n]*|"failures":[\s\S]{0,400}/)?.[0] ?? '-')
      expect(out).toEqual({ still: false, resync: [0, true], cutover: [1, true], rows: ['55:virada:N', 'SE:virada:S'] })
    })
  })
})

if (!LIVE) it('adversarial r11 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
