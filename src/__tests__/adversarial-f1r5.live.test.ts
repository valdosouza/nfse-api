/// <reference types="jest" />
// GATE ADVERSARIAL — RE-PROVA do DELTA do retrabalho da RODADA 4 (D-F36…D-F40) — AO VIVO: banco do dev (ERP só LIDO) +
// FISCO FALSO + CÓPIA DESCARTÁVEL `fiscal_api_adv_r5` (harness `live-harness.ts`). ⚠️ Só roda com NFSE_ADV_LIVE=1.
// Isolamento:
//  - adaptador FALSO e o transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real); o smoke e o
//    migrate rodam em processo filho SEM `--vai` e apontados para a CÓPIA (FISCAL_DB_NAME);
//  - o ERP é só LIDO (a trava da nota é FOR UPDATE de leitura) — CHECKSUM do ERP antes/depois;
//  - TODA escrita do teste passa por `w()`, que recusa alvo qualificado `fiscal_api.`/`setes_*.` (só a cópia);
//  - o `fiscal_api` REAL: CHECKSUM das 6 tabelas-base (inclusive `_migrations`) + lista de objetos antes/depois, e
//    `SHOW DATABASES LIKE 'fiscal%'` termina só com `fiscal_api`.
//
// Achados deste arquivo (os `it.failing` reproduzem; cada um tem o `it` de CENÁRIO antes):
//  - [MEDIUM — regressão do retrabalho R4] DELETE do A1 × reserva em curso: o `assertNotReplica` abre a transação do
//    `clearCertificate` com leitura NÃO travante → o snapshot nasce antes da trava da habilitação → a guarda "transmissão
//    viva → 409" conta no passado → o A1 é apagado com a tentativa EM VOO (que deixa de ser reconciliável);
//  - [LOW — D-F39] cancelamento direto numa réplica EXCLUÍDA / sem linha grava K e N; `storeCertificate` direto na lacuna
//    (b) grava o A1 (o critério do núcleo é mais fraco que `emissionStillInErp`);
//  - [LOW — D-F38/aluguel] o aluguel de 60 s não cobre a passada: o orçamento só é conferido ENTRE candidatas e a chamada
//    ao fisco que começa antes do prazo pode durar o timeout de inatividade do transporte (30 s por requisição);
//  - [LOW — harness] detecta, não impede: o pool do ataque é SUPERUSUÁRIO (a cerca de privilégio da D-F31 fica desligada
//    no ataque) e o CHECKSUM final não cobre `_migrations`; jest morto deixa a cópia VIRADA com o A1 e o contador reais.
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r5.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import forge from 'node-forge'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError, createFiscalPool, dbConfigFromEnv } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, FISCAL_COPY_TABLES } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions,
  resetMunicipalTermsCache, listPending,
} from '../nfse/transmission'
import { countLiveTransmissions } from '../nfse/repository'

// mesma normalização EM MEMÓRIA das rodadas 1–4: o ramo congelado das notas do dev tem cTribMun "0102" (anterior à D-N26b)
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
const OTHER_INST = 999
const SCHEMA = 'setes_setes'
const ADV_USER = 990005
const CNPJ = '07742094000113'
const COPY = 'fiscal_api_adv_r5'
const REAL = 'fiscal_api'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R5</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
const fisco = {
  byKey: new Map<string, string>(),
  calls: { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 },
  transmitMode: 'reject' as 'reject' | 'ambiguous',
  termsMode: 'value' as 'value' | 'hang',
  termsDelayMs: 0,
  termsCancelDays: 60 as unknown,
  queryHangOnceMs: 0,
}
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() {
    fisco.calls.transmit++
    // ambíguo = o que o transporte real devolve num timeout DEPOIS do handshake: a reserva fica EM VOO
    if (fisco.transmitMode === 'ambiguous') throw new AuthorityHttpError(503, 'Fisco sem resposta (falso — ambíguo)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
    throw new AuthorityHttpError(422, 'Fisco rejeitou (falso)', 'FISCAL_DPS_REJECTED', 400, '{"erros":[{"codigo":"E0001"}]}', [{ field: 'dps', message: 'E0001' }])
  },
  async queryNfse(_ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    if (fisco.queryHangOnceMs) { const ms = fisco.queryHangOnceMs; fisco.queryHangOnceMs = 0; await sleep(ms) }
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
    if (fisco.termsMode === 'hang') return new Promise(() => { /* convênio pendurado */ }) as any
    if (fisco.termsDelayMs) await sleep(fisco.termsDelayMs)
    return { cancelDays: fisco.termsCancelDays as any, raw: null }
  },
}
function resetFisco(): void {
  fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 }
  fisco.transmitMode = 'reject'
  fisco.termsMode = 'value'
  fisco.termsDelayMs = 0
  fisco.termsCancelDays = 60
  fisco.queryHangOnceMs = 0
}

const tmpRoot = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r5-')) : ''      // desligada: nada criado no disco
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
let harness: DisposableFiscalDb | null = null
let app: any
let rootPool: ReturnType<typeof createFiscalPool>
let setesUser = '', setesPass = ''

/** Leitura na CÓPIA (banco default do pool do ataque). */
const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]
/** Escrita do TESTE: só na cópia — alvo qualificado `fiscal_api.`/`setes_*.` é recusado antes de ir ao banco. */
async function w(sql: string, params: any[] = []): Promise<any> {
  if (/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql)) {
    const target = sql.split(/\bSELECT\b/i)[0]
    if (/`?fiscal_api`?\s*\.|`?setes_[a-z0-9_]*`?\s*\./i.test(target)) throw new Error(`ADV r5: escrita fora da cópia recusada: ${sql.slice(0, 90)}`)
  }
  return (await ctx.pool.query(sql, params))[0]
}
/** Leitura com o usuário do setes-api, banco default information_schema (nunca escreve). */
const rq = async (sql: string, params: any[] = []) => (await rootPool.query(sql, params))[0] as any[]

const REAL_TABLES = [...FISCAL_COPY_TABLES, '_migrations']
const ERP_TABLES = ['tb_establishment_issuer', 'tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_invoice_service_transmission',
  'tb_invoice_service_transmission_event', 'tb_institution_has_interface', 'tb_user_has_privilege'].map(t => `${SCHEMA}.${t}`)
  .concat(['setes_central.tb_institution'])
const sumsOf = async (tables: string[]) =>
  Object.fromEntries((await rq(`CHECKSUM TABLE ${tables.join(', ')}`)).map((r: any) => [r.Table, String(r.Checksum)]))
const realSums = async () => ({
  sums: await sumsOf(REAL_TABLES.map(t => `${REAL}.${t}`)),
  objects: (await rq(`SELECT table_name AS t, table_type AS k FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [REAL]))
    .map((r: any) => `${r.t}:${r.k}`).join(','),
})
const erpSums = () => sumsOf(ERP_TABLES)
const fiscalDbs = async () => (await rq(`SHOW DATABASES LIKE 'fiscal%'`)).map((r: any) => String(Object.values(r)[0])).sort()

async function waitBlocked(blockerCid: number, patterns: RegExp[], count = 1, ms = 20_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const pl = await rq('SHOW FULL PROCESSLIST')
    if (pl.filter(p => Number(p.Id) !== blockerCid && patterns.every(re => re.test(String(p.Info ?? '')))).length >= count) return true
    await sleep(40)
  }
  return false
}

// ---- linhas SINTÉTICAS (só na cópia) ------------------------------------------------------------------------------
const lifeOf = async (inv: number) => (await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, INST, inv))!.lifeEvent!
async function seedDps(inst: number, inv: number, life: number, n: number): Promise<string> {
  const dpsId = `DPS4106902${'2'}${CNPJ}00999${String(n).padStart(15, '0')}`
  expect(dpsId).toHaveLength(45)
  await w(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, '999', ?, ?, ?, NOW(), NOW(), 'N')`, [inst, inv, life, n, dpsId, ADV_USER])
  return dpsId
}
/** Autorizada SINTÉTICA (H) com dh_proc há [daysAgo] dias; a NFS-e "existe" no fisco falso. */
async function seedAuthorized(inv: number, daysAgo: number, inst = INST): Promise<{ key: string; dpsId: string }> {
  const life = await lifeOf(inv)
  const dpsId = await seedDps(inst, inv, life, 990_000_000 + inv)
  const key = (`41069022${CNPJ}${inst === INST ? '95' : '96'}${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50)
  await w(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', ?, '990001', DATE_SUB(NOW(), INTERVAL ? DAY), NULL, ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [inst, inv, life, key, daysAgo, ADV_USER, daysAgo])
  await w(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, 1, 'A', NULL, 'autorizada SINTÉTICA (adversarial r5)', DATE_SUB(NOW(), INTERVAL ? DAY), 'P', ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [inst, inv, daysAgo, ADV_USER, daysAgo])
  fisco.byKey.set(key, dpsId)
  return { key, dpsId }
}
/** Tentativa EM VOO sintética (sem voz) — o que a guarda do DELETE do A1 tem de ver. */
async function seedInFlight(inv: number): Promise<void> {
  const life = await lifeOf(inv)
  await seedDps(INST, inv, life, 990_100_000 + inv)
  await w(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', NULL, NULL, NULL, NULL, ?, NOW(), NOW(), 'N')`, [INST, inv, life, ADV_USER])
}
async function purge(ids: number[]): Promise<void> {
  for (const inst of [INST, OTHER_INST]) {
    for (const id of ids) {
      await w(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
      await w(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
      await w(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [inst, id])
    }
  }
}
const kindsOf = async (inv: number) => (await q(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt, event`, [INST, inv])).map(r => String(r.kind))
const issuerOfCopy = async () => (await q(`SELECT environment, serie, dps_last_number AS n, deleted, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c
                                             FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0] ?? null
const certOfCopy = async () => (await q(`SELECT deleted, certificate_pem IS NULL AS noPem, fingerprint256 AS fp FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0] ?? null
async function restoreIssuerFromReal(): Promise<void> {
  await w(`DELETE FROM \`${COPY}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
  await w(`INSERT INTO \`${COPY}\`.tb_establishment_issuer SELECT * FROM \`${REAL}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
}
const restoreCertFromReal = () =>
  w(`REPLACE INTO \`${COPY}\`.tb_establishment_certificate SELECT * FROM \`${REAL}\`.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST])
const turnCopy = () => w(`UPDATE tb_establishment_issuer SET cutover_at = NOW(), environment = 'H', serie = '900', deleted = 'N', refresh_lease_until = NULL
                          WHERE tb_institution_id = ? AND model = 'SE'`, [INST])

function pfxFor(cn: string, password = 'senha'): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '05' + Math.floor(Math.random() * 1e8).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
}

/** Processo filho (npm run) SEMPRE apontado para a CÓPIA e NUNCA com `--vai`. */
const runScript = (script: string, args: string[], env: Record<string, string>) => {
  if (args.includes('--vai')) throw new Error('ADV r5: --vai é proibido nesta suíte')
  const r = spawnSync('npm', ['run', script, '--', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}
// D-F53: a re-sincronia na CÓPIA roda com o usuário do SERVIÇO; só o ENSAIO do ato (escreve no ERP e desfaz) leva o DONO
const copyEnv = () => ({ FISCAL_DB_NAME: COPY, DB_USER: process.env.DB_USER ?? '', DB_PASSWORD: process.env.DB_PASSWORD ?? '' })
const ownerEnv = () => ({ FISCAL_DB_NAME: COPY, DB_USER: setesUser, DB_PASSWORD: setesPass })

let realBefore: { sums: Record<string, string>; objects: string } = { sums: {}, objects: '' }
let erpBefore: Record<string, string> = {}
let X = 0, Y = 0, Z = 0, W = 0

d('GATE ADVERSARIAL r5 — re-prova do delta da Rodada 4 (cópia descartável fiscal_api_adv_r5 + fisco falso)', () => {
  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(ROOT, '..', 'setes-api', '.env')))
    setesUser = setesEnv.DB_USER; setesPass = setesEnv.DB_PASSWORD ?? ''
    rootPool = createFiscalPool({ ...dbConfigFromEnv(process.env), database: 'information_schema', user: setesUser, password: setesPass })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r5: rede bloqueada — nenhum fisco real') }
    expect(await fiscalDbs()).toEqual([REAL])                       // nenhuma sobra antes de começar
    realBefore = await realSums()
    erpBefore = await erpSums()
  })

  afterAll(async () => {
    let dbsAfter: string[] = [], realAfter = { sums: {} as Record<string, string>, objects: '' }, erpAfter: Record<string, string> = {}
    try {
      // cinto: a cópia pode ter sobrado se o harness falhou antes do drop
      if ((await fiscalDbs()).includes(COPY)) await rootPool.query(`DROP DATABASE IF EXISTS \`${COPY}\``)
      dbsAfter = await fiscalDbs()
      realAfter = await realSums()
      erpAfter = await erpSums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r5] fiscal_api REAL antes', JSON.stringify(realBefore), '| depois', JSON.stringify(realAfter),
        '\n[adv-r5] ERP antes', JSON.stringify(erpBefore), '| depois', JSON.stringify(erpAfter), '\n[adv-r5] bancos fiscal% no fim', dbsAfter.join(','))
      await rootPool.end()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (JSON.stringify(realAfter) !== JSON.stringify(realBefore)) throw new Error('O fiscal_api REAL mudou durante o ataque — conferir')
    if (JSON.stringify(erpAfter) !== JSON.stringify(erpBefore)) throw new Error('O ERP mudou durante o ataque — conferir')
    if (JSON.stringify(dbsAfter) !== JSON.stringify([REAL])) throw new Error(`Sobrou banco fiscal%: ${dbsAfter.join(',')}`)
  })

  // =========================================================================
  describe('G0. harness — o jest MORRE no meio (processo filho que cria a cópia e sai sem o afterAll)', () => {
    const leftover: any = {}
    it('cenário: o real fica LIMPO; a cópia SOBRA — VIRADA, com o A1 e o contador reais — até a mesma suíte rodar de novo', async () => {
      const script = path.join(tmpRoot, 'killed-harness.ts')
      const harnessPath = path.join(ROOT, 'src', '__tests__', 'live-harness').replace(/\\/g, '/')
      fs.writeFileSync(script, `import { disposableFiscalDb } from ${JSON.stringify(harnessPath)}
;(async () => {
  await disposableFiscalDb(${JSON.stringify(ROOT.replace(/\\/g, '/'))}, '${COPY}', { turned: true })
  console.log('HARNESS_CRIADO')
  process.exit(9)                                   // jest morto: nenhum afterAll, nenhum drop()
})().catch(e => { console.error('ERRO', e && e.message); process.exit(2) })
`)
      const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--require', 'tsconfig-paths/register', script],
        { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env } })
      leftover.exit = r.status
      leftover.created = `${r.stdout ?? ''}`.includes('HARNESS_CRIADO')
      leftover.err = `${r.stderr ?? ''}`.trim().slice(0, 300)
      leftover.dbs = await fiscalDbs()
      leftover.issuer = (await rq(`SELECT environment, serie, dps_last_number AS n, cutover_at IS NOT NULL AS turned FROM \`${COPY}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0]
      leftover.realIssuer = (await rq(`SELECT environment, serie, dps_last_number AS n FROM \`${REAL}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0]
      leftover.sameA1 = (await rq(`SELECT c.fingerprint256 = r.fingerprint256 AND c.private_key_cipher = r.private_key_cipher AS same
                                     FROM \`${COPY}\`.tb_establishment_certificate c JOIN \`${REAL}\`.tb_establishment_certificate r ON r.tb_institution_id = c.tb_institution_id
                                    WHERE c.tb_institution_id = ?`, [INST]))[0]?.same
      leftover.realSame = JSON.stringify(await realSums()) === JSON.stringify(realBefore)
      // eslint-disable-next-line no-console
      console.log('[adv-r5] jest morto no meio:', JSON.stringify(leftover))
      expect(leftover.exit).toBe(9)
      expect(leftover.created).toBe(true)
      expect(leftover.realSame).toBe(true)                          // o real NÃO foi tocado
      expect(leftover.dbs).toContain(COPY)                          // a cópia SOBROU
      expect(Number(leftover.issuer.turned)).toBe(1)                // VIRADA…
      expect([leftover.issuer.environment, Number(leftover.issuer.n)]).toEqual([leftover.realIssuer.environment, Number(leftover.realIssuer.n)])
      expect(Number(leftover.sameA1)).toBe(1)                       // …com o A1 (cifrado) e o contador de PRODUÇÃO
    })
  })

  // =========================================================================
  describe('principal — cópia fiscal_api_adv_r5 recriada pelo harness (a sobra do G0 é apagada no DROP inicial)', () => {
    beforeAll(async () => {
      const cwd = process.cwd(); process.chdir(ROOT)
      harness = await disposableFiscalDb(ROOT, COPY, { turned: false })
      const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
      process.chdir(cwd)
      ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
      expect(ctx.adapter).toBe(fakeAdapter)
      expect(ctx.fiscalDb).toBe(COPY)
      expect((await q('SELECT DATABASE() AS db'))[0].db).toBe(COPY)
      expect((await issuerOfCopy())?.c).toBeNull()                    // recriada: RÉPLICA, como o real (a sobra virada morreu)
      app = createApp(ctx)
      privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

      // notas-alvo: E na web, sem tentativa em lugar nenhum; X e Y montam o DPS (transmitem de verdade contra o fisco falso)
      const svc = await import('../facts/service-facts')
      const busy = new Set((await q(`SELECT DISTINCT tb_invoice_id AS id FROM tb_invoice_service_transmission WHERE tb_institution_id = ?`, [INST])).map(r => Number(r.id)))
      const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
         JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
         JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
        WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND i.issuer = i.tb_institution_id AND l.last_kind = 'E'
          AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
        ORDER BY i.id DESC LIMIT 400`, [INST])
      const fresh: number[] = [], others: number[] = []
      for (const r of rows) {
        const id = Number(r.id)
        if (busy.has(id)) continue
        if (fresh.length < 2) {
          try {
            const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, INST, id)
            await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
            fresh.push(id); continue
          } catch { /* cadastro incompleto — serve só de alvo sintético */ }
        }
        if (others.length < 2) others.push(id)
        if (fresh.length >= 2 && others.length >= 2) break
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r5] notas-alvo: transmitem', fresh.join(','), '| sintéticas', others.join(','))
      expect(fresh.length).toBe(2)
      expect(others.length).toBe(2)
      ;[X, Y] = fresh
      ;[Z, W] = others
    })
    beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })
    afterAll(async () => {
      if (harness) await harness.drop()                            // apaga a cópia e FALHA se o CHECKSUM do real mudou
    })

    // -----------------------------------------------------------------------
    describe('A. D-F39 — réplica EXCLUÍDA / sem linha; o núcleo e a migração', () => {
      beforeAll(async () => { await seedAuthorized(Z, 5) })
      afterAll(async () => { await purge([Z]); await restoreIssuerFromReal(); await restoreCertFromReal() })

      const out: { excluded?: any; noRow?: any } = {}
      it('cenário: réplica EXCLUÍDA e SEM linha — a borda recusa (409 FISCAL_CUTOVER_PENDING) e nada é gravado; a composição direta recusa (409) sem ir ao fisco', async () => {
        const run = async () => {
          const before = await kindsOf(Z)
          const http = await request(app).post(`/v1/nfse/invoices/${Z}/cancel`).set(bearer(tok())).send({ reason: 'cancelamento adversarial r5 na réplica' })
          const afterHttp = await kindsOf(Z)
          let err: any
          try { await cancelServiceInvoiceAtAuthority(ctx, ACTOR, Z, 'cancelamento adversarial r5 na réplica') } catch (e) { err = e }
          return { before, http: [http.status, http.body.code], afterHttp, direct: [err?.statusCode, err?.code], afterDirect: await kindsOf(Z) }
        }
        await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
        out.excluded = await run()
        await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])   // lacuna (b): o ERP tem a habilitação SE
        out.noRow = await run()
        // eslint-disable-next-line no-console
        console.log('[adv-r5] cancelamento na réplica', JSON.stringify(out))
        for (const o of [out.excluded, out.noRow]) {
          expect(o.http).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
          expect(o.afterHttp).toEqual(o.before)
          expect(o.direct[0]).toBe(409)
        }
        expect(fisco.calls.event).toBe(0)
      })
      it('[corrigido] …e a composição direta NÃO grava K nem N na tentativa da réplica (predicado completo antes de qualquer voz)', () => {
        expect(out.excluded.afterDirect).toEqual(out.excluded.before)
        expect(out.noRow.afterDirect).toEqual(out.noRow.before)
      })

      const a1: { http?: any; direct?: any; fpBefore?: string; fpAfter?: string } = {}
      it('cenário: lacuna (b) — SEM linha no fiscal_api e habilitação SE no ERP: o PUT do A1 pela borda → 409 FISCAL_CUTOVER_PENDING', async () => {
        await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
        a1.fpBefore = (await certOfCopy())?.fp
        const pfx = pfxFor(`ADV R5 TESTE:${CNPJ}`)
        const http = await request(app).put('/v1/emitter/certificate').set(bearer(tok())).send({ pfxBase64: pfx.toString('base64'), password: 'senha' })
        a1.http = [http.status, http.body.code]
        try {
          await fiscal.storeCertificate({ pool: ctx.pool, keyring: ctx.keyring }, INST, pfx, 'senha',
            { expectedCnpj: await fiscal.erp.establishmentCnpj(ctx.pool, INST), userId: ADV_USER, schemaName: SCHEMA })
          a1.direct = 'gravou'
        } catch (e: any) { a1.direct = [e.statusCode, e.code] }
        a1.fpAfter = (await certOfCopy())?.fp
        // eslint-disable-next-line no-console
        console.log('[adv-r5] A1 na lacuna (b)', JSON.stringify(a1))
        expect(a1.http).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
        // o .pfx é válido para o CNPJ: a peça ou grava (o achado) ou recusa pela cerca (corrigido) — nunca outro erro
        expect(a1.direct === 'gravou' || (Array.isArray(a1.direct) && a1.direct[1] === 'FISCAL_CUTOVER_PENDING')).toBe(true)
      })
      it('[corrigido] …e o NÚCLEO também recusa (`storeCertificate` direto não troca o A1 de um estabelecimento que o ERP ainda emite)', () => {
        expect(a1.direct).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
        expect(a1.fpAfter).toBe(a1.fpBefore)
      })

      it('sem achado: a migração AINDA renova o A1 da réplica (escreve por SQL, não pela peça) — e a peça recusa a réplica', async () => {
        await purge([Z])                                              // a re-sincronia acusaria a tentativa sintética como dual-write
        await restoreIssuerFromReal()
        await restoreCertFromReal()
        await w(`UPDATE tb_establishment_certificate SET fingerprint256 = 'adv-r5-antigo', not_after = '2020-01-01 00:00:00' WHERE tb_institution_id = ?`, [INST])
        let direct: any
        try { await fiscal.storeCertificate({ pool: ctx.pool, keyring: ctx.keyring }, INST, pfxFor(`ADV R5 TESTE:${CNPJ}`), 'senha', { expectedCnpj: CNPJ, userId: ADV_USER, schemaName: SCHEMA }) }
        catch (e: any) { direct = [e.statusCode, e.code] }
        const r = runScript('migrate:setes', ['--dry-run'], copyEnv())
        // eslint-disable-next-line no-console
        console.log('[adv-r5] migrate:setes na réplica com A1 velho', r.status, r.out.match(/"certificate": "[^"]*"/)?.[0], '| peça direta', JSON.stringify(direct))
        expect(direct).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
        expect(r.status).toBe(0)
        expect(r.out).toMatch(/"certificate": "RENOVADO/)
        expect((await certOfCopy())?.fp).toBe('adv-r5-antigo')       // --dry-run desfez
        await seedAuthorized(Z, 5)                                    // para o afterAll purgar de novo (idempotente)
      })
    })

    // -----------------------------------------------------------------------
    describe('B. [regressão R4] DELETE do A1 × reserva em curso (habilitação VIRADA só na cópia)', () => {
      beforeAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy() })
      afterAll(async () => { await purge([X, Y, W]); await restoreCertFromReal() })

      it('controle: sem corrida, a guarda funciona — tentativa EM VOO → DELETE do A1 → 409 FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS', async () => {
        await seedInFlight(W)
        try {
          const r = await request(app).delete('/v1/emitter/certificate').set(bearer(tok()))
          expect([r.status, r.body.code]).toEqual([409, 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS'])
          expect((await certOfCopy())?.deleted).toBe('N')
        } finally { await purge([W]) }
      })

      const mvcc: any = {}
      it('cenário (MVCC, sem apagar nada): reserva REAL parada no A1; duas guardas esperam a habilitação — a da ORDEM NOVA (leitura antes da trava) e a da ordem pré-R4 (trava primeiro)', async () => {
        fisco.transmitMode = 'ambiguous'
        const blocker = await ctx.pool.getConnection()
        const cNew = await ctx.pool.getConnection()
        const cOld = await ctx.pool.getConnection()
        try {
          const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
          await blocker.beginTransaction()
          await blocker.query(`SELECT tb_institution_id FROM tb_establishment_certificate WHERE tb_institution_id = ? FOR UPDATE`, [INST])
          const pRes = transmitServiceInvoice(ctx, ACTOR, Y).then(r => ({ ok: r }), (e: any) => ({ err: [e.statusCode, e.code] }))
          mvcc.reserveBlocked = await waitBlocked(Number(cid), [/tb_establishment_certificate/, /LOCK IN SHARE MODE/i])
          // ordem ATUAL do `clearCertificate` (corrigida na re-prova R4): TRAVA das linhas da habilitação (lockIssuerRows) →
          // guarda da família (FOR UPDATE + contagem) — o snapshot nasce DEPOIS da trava
          await cNew.beginTransaction()
          const pNew = fiscal.lockIssuerRows(cNew, INST).then(() => fiscal.getIssuer(cNew, INST, 'SE', true))
            .then(() => countLiveTransmissions(cNew, INST)).then(async n => { await cNew.rollback(); return n })
          // ordem pré-R4: FOR UPDATE da habilitação primeiro, contagem depois
          await cOld.beginTransaction()
          const pOld = fiscal.getIssuer(cOld, INST, 'SE', true).then(() => countLiveTransmissions(cOld, INST)).then(async n => { await cOld.rollback(); return n })
          mvcc.guardsBlocked = await waitBlocked(Number(cid), [/tb_establishment_issuer/, /FOR UPDATE/i], 2)
          await blocker.rollback()
          mvcc.reservation = await pRes
          ;[mvcc.liveNewOrder, mvcc.liveOldOrder] = await Promise.all([pNew, pOld])
          mvcc.liveNow = await countLiveTransmissions(ctx.pool, INST)
        } finally {
          for (const c of [blocker, cNew, cOld]) { try { await c.rollback() } catch { /* já encerrada */ } c.release() }
        }
        // eslint-disable-next-line no-console
        console.log('[adv-r5] MVCC guarda do DELETE do A1 × reserva', JSON.stringify(mvcc))
        expect(mvcc.reserveBlocked).toBe(true)
        expect(mvcc.guardsBlocked).toBe(true)
        expect(mvcc.reservation.err).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])   // ambíguo: a tentativa fica EM VOO
        expect(mvcc.liveNow).toBe(1)
        expect(mvcc.liveOldOrder).toBe(1)                                               // a ordem pré-R4 VÊ a viva
      })
      it('[corrigido] …e a guarda na ORDEM ATUAL também vê a tentativa viva (a 1ª instrução é a trava)', () => {
        expect(mvcc.liveNewOrder).toBe(1)
      })

      const e2e: any = {}
      it('cenário (ponta a ponta, rota REAL): reserva parada no A1 + DELETE /v1/emitter/certificate esperando a habilitação; a reserva comita e o envio fica EM VOO', async () => {
        await purge([Y])
        fisco.transmitMode = 'ambiguous'
        const blocker = await ctx.pool.getConnection()
        try {
          const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
          await blocker.beginTransaction()
          await blocker.query(`SELECT tb_institution_id FROM tb_establishment_certificate WHERE tb_institution_id = ? FOR UPDATE`, [INST])
          const pRes = transmitServiceInvoice(ctx, ACTOR, X).then(r => ({ ok: r }), (e: any) => ({ err: [e.statusCode, e.code] }))
          e2e.reserveBlocked = await waitBlocked(Number(cid), [/tb_establishment_certificate/, /LOCK IN SHARE MODE/i])
          const pDel = request(app).delete('/v1/emitter/certificate').set(bearer(tok())).then(r => r)
          e2e.deleteBlocked = await waitBlocked(Number(cid), [/tb_establishment_issuer/, /FOR UPDATE/i])
          await blocker.rollback()
          e2e.reservation = await pRes
          const del = await pDel
          e2e.delete = [del.status, del.body.code]
        } finally {
          try { await blocker.rollback() } catch { /* já encerrada */ }
          blocker.release()
        }
        e2e.txX = (await q(`SELECT attempt, last_kind AS k FROM vw_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, X]))
        e2e.cert = await certOfCopy()
        try { await refreshServiceTransmission(ctx, ACTOR, X); e2e.refresh = 'ok' } catch (e: any) { e2e.refresh = [e.statusCode, e.code] }
        // eslint-disable-next-line no-console
        console.log('[adv-r5] DELETE do A1 × reserva (rota real)', JSON.stringify(e2e), '| envios ao fisco falso', fisco.calls.transmit)
        expect(e2e.reserveBlocked).toBe(true)
        expect(e2e.deleteBlocked).toBe(true)
        expect(e2e.reservation.err).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
        expect(e2e.txX).toHaveLength(1)
        expect(e2e.txX[0].k).toBeNull()                                  // a tentativa está EM VOO
        expect(fisco.calls.transmit).toBe(1)
      })
      it('[corrigido] …e o DELETE recusa (409 FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS), o A1 fica e a tentativa continua reconciliável', () => {
        expect(e2e.delete).toEqual([409, 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS'])
        expect(e2e.cert.deleted).toBe('N')
        expect(e2e.refresh).not.toEqual([409, 'FISCAL_CERT_MISSING'])
      })
    })

    // -----------------------------------------------------------------------
    describe('C. D-F38 — bulkhead do prazo do PAM e o aluguel da passada (habilitação VIRADA só na cópia)', () => {
      beforeAll(async () => { await purge([X, Y, Z, W]); await restoreCertFromReal(); await turnCopy(); await seedAuthorized(Z, 5) })
      beforeEach(async () => { await w(`UPDATE tb_invoice_service_transmission SET last_queried_at = NULL WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, Z]) })
      afterAll(async () => { await purge([Z]); await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST]) })

      it('cenário: convênio PENDURADO — cada passada pela rota espera ≤ 3 s, usa o padrão (90) e consulta a candidata; a consulta pendurada NÃO é relançada', async () => {
        fisco.termsMode = 'hang'
        const passes: any[] = []
        for (let i = 0; i < 2; i++) {
          const t0 = Date.now()
          const r = await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({})
          passes.push({ ms: Date.now() - t0, status: r.status, data: r.body.data })
        }
        // eslint-disable-next-line no-console
        console.log('[adv-r5] convênio pendurado × passadas (rota)', JSON.stringify(passes), '| chamadas ao convênio', fisco.calls.terms)
        for (const p of passes) {
          expect(p.status).toBe(200)
          expect(p.data).toMatchObject({ ceilingSource: 'padrao', authorizedMaxDays: 90, skipped: false })
          expect(p.ms).toBeLessThan(6000)
        }
        expect(passes[0].data.checked).toBe(1)
        expect(fisco.calls.terms).toBe(1)                              // uma consulta por vez: a 2ª passada espera a MESMA (corrigido)
      })

      it('sem achado: duas passadas SIMULTÂNEAS (convênio lento 1,5 s) — UMA roda, a outra `skipped`; o convênio é perguntado uma vez', async () => {
        fisco.termsDelayMs = 1500
        fisco.termsCancelDays = 75
        const [a, b] = await Promise.all([0, 1].map(() => request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({})))
        const datas = [a.body.data, b.body.data]
        // eslint-disable-next-line no-console
        console.log('[adv-r5] passadas simultâneas', JSON.stringify(datas), '| convênio', fisco.calls.terms)
        expect([a.status, b.status]).toEqual([200, 200])
        expect(datas.filter(x => x.skipped).length).toBe(1)
        expect(datas.find(x => !x.skipped)).toMatchObject({ checked: 1, ceilingSource: 'municipio', authorizedMaxDays: 105 })
        expect(fisco.calls.terms).toBe(1)
        expect(fisco.calls.query).toBe(1)
      })

      const lease: any = {}
      it('cenário: a chamada ao fisco que COMEÇA dentro do orçamento dura mais que o aluguel (60 s) — uma 2ª passada toma o aluguel e roda JUNTO', async () => {
        fisco.queryHangOnceMs = 63_000                                  // ex.: GET /dps + GET /nfse no timeout de inatividade (2 × 30 s)
        let p1Done = false
        const t0 = Date.now()
        const p1 = refreshOpenServiceTransmissions(ctx, ACTOR).then(r => { p1Done = true; return r })
        await sleep(61_000)
        lease.p1RunningWhenP2Started = !p1Done
        lease.p2 = await refreshOpenServiceTransmissions(ctx, ACTOR)
        lease.p1 = await p1
        lease.p1Ms = Date.now() - t0
        lease.queries = fisco.calls.query
        lease.leaseAfter = (await q(`SELECT refresh_lease_until AS u FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].u
        // eslint-disable-next-line no-console
        console.log('[adv-r5] aluguel × passada longa', JSON.stringify(lease))
        expect(lease.p1RunningWhenP2Started).toBe(true)
        expect(lease.p1.checked).toBe(1)
      }, 150_000)
      it('[corrigido] …e a 2ª passada sai `skipped` (aluguel de 90 s renovado antes de cada candidata)', () => {
        expect(lease.p2.skipped).toBe(true)
        expect(lease.queries).toBe(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('D. pendentes com a institution CONSTANTE — COUNT × página, ramos, isolamento por institution', () => {
      afterAll(async () => { await purge([X, Y, Z, W]) })
      const both = ['service-orders', 'orders']
      const all = async (interfaces: string[], pageSize = 7) => {
        const ids: number[] = []
        let total = -1
        for (let page = 1; page < 1000; page++) {
          const r = await listPending(ctx, ACTOR, { page, pageSize }, interfaces)
          if (total < 0) total = r.total
          expect(r.total).toBe(total)
          if (!r.data.length) break
          ids.push(...r.data.map(x => x.invoiceId))
        }
        return { ids, total }
      }

      it('sem achado: Σ páginas = total, sem repetição; ramos disjuntos que somam o todo; página além do fim vazia com o mesmo total', async () => {
        const b = await all(both)
        const so = await all(['service-orders'])
        const or = await all(['orders'])
        const beyond = await listPending(ctx, ACTOR, { page: 100_000, pageSize: 100 }, both)
        // eslint-disable-next-line no-console
        console.log('[adv-r5] pendentes', JSON.stringify({ total: b.total, serviceOrders: so.total, orders: or.total }))
        expect(b.ids.length).toBe(b.total)
        expect(new Set(b.ids).size).toBe(b.total)
        expect(so.total + or.total).toBe(b.total)
        expect(so.ids.filter(id => or.ids.includes(id))).toEqual([])
        expect(new Set([...so.ids, ...or.ids])).toEqual(new Set(b.ids))
        expect([beyond.data.length, beyond.total]).toEqual([0, b.total])
        expect((await listPending(ctx, ACTOR, { page: 1, pageSize: 5 }, [])).total).toBe(0)
      })

      it('sem achado: tentativa de OUTRA institution com o mesmo id de nota não esconde a pendente; a da própria (A) esconde; R não esconde', async () => {
        const first = (await listPending(ctx, ACTOR, { page: 1, pageSize: 1 }, both))
        const V = first.data[0].invoiceId
        const t0 = first.total
        await seedAuthorized(V, 1, OTHER_INST)
        const withOther = await listPending(ctx, ACTOR, { page: 1, pageSize: 100 }, both)
        await seedAuthorized(V, 1, INST)
        const withOwnA = await listPending(ctx, ACTOR, { page: 1, pageSize: 100 }, both)
        await w(`UPDATE tb_invoice_service_transmission_event SET kind = 'R', dh = NULL WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, V])
        await w(`UPDATE tb_invoice_service_transmission SET access_key = NULL, nfse_number = NULL, dh_proc = NULL WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, V])
        const withOwnR = await listPending(ctx, ACTOR, { page: 1, pageSize: 100 }, both)
        await purge([V])
        // eslint-disable-next-line no-console
        console.log('[adv-r5] isolamento', JSON.stringify({ V, t0, outra: withOther.total, propriaA: withOwnA.total, propriaR: withOwnR.total }))
        expect(withOther.total).toBe(t0)
        expect(withOwnA.total).toBe(t0 - 1)
        expect(withOwnA.data.map(x => x.invoiceId)).not.toContain(V)
        expect(withOwnR.total).toBe(t0)
      })

      it('sem achado: a rota pagina no envelope da casa e recusa page/pageSize fora do domínio (400)', async () => {
        const a = bearer(tok())
        const ok = await request(app).get('/v1/nfse/invoices/pending?page=1&pageSize=5').set(a)
        const bad = await Promise.all(['page=0', 'pageSize=0', 'pageSize=101', 'page=abc', 'page=100001', 'page=-1&pageSize=5']
          .map(qs => request(app).get(`/v1/nfse/invoices/pending?${qs}`).set(a).then(r => [qs, r.status, r.body.code])))
        expect(ok.status).toBe(200)
        expect(ok.body).toMatchObject({ ok: true, page: 1, pageSize: 5 })
        expect(ok.body.data.length).toBeLessThanOrEqual(5)
        expect(bad.every(([, st]) => st === 400)).toBe(true)
      })
    })

    // -----------------------------------------------------------------------
    describe('E. migrate:setes na CÓPIA — `--cutover` e `assertFrozen` (processo filho, nunca o real)', () => {
      afterAll(async () => { await purge([W]); await restoreIssuerFromReal(); await restoreCertFromReal() })

      it('sem achado: `--cutover` numa cópia JÁ virada falha alto ("já VIRADA") e o instante não muda', async () => {
        await restoreIssuerFromReal(); await turnCopy()
        const before = (await issuerOfCopy())?.c
        const r = runScript('migrate:setes', ['--cutover', '1', '--confirmo-setes-api-parado', '--dry-run'], ownerEnv())
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/já VIRADA/)
        expect((await issuerOfCopy())?.c).toBe(before)
      })

      it('sem achado (regressão do R4): VIRADA + a origem com VOZ que a cópia não tem → assertFrozen falha alto', async () => {
        const victim = (await q(`SELECT tb_invoice_id AS inv, attempt, MAX(event) AS ev FROM tb_invoice_service_transmission_event
                                   WHERE tb_institution_id = ? GROUP BY tb_invoice_id, attempt ORDER BY MAX(event) DESC, tb_invoice_id LIMIT 1`, [INST]))[0]
        const where = `tb_institution_id = ${INST} AND tb_invoice_id = ${Number(victim.inv)} AND attempt = ${Number(victim.attempt)} AND event = ${Number(victim.ev)}`
        await w(`DELETE FROM tb_invoice_service_transmission_event WHERE ${where}`)
        let r = { status: null as number | null, out: '' }
        try { r = runScript('migrate:setes', ['--dry-run'], copyEnv()) } finally {
          await w(`INSERT INTO \`${COPY}\`.tb_invoice_service_transmission_event SELECT * FROM \`${REAL}\`.tb_invoice_service_transmission_event WHERE ${where}`)
        }
        // eslint-disable-next-line no-console
        console.log('[adv-r5] assertFrozen × voz nova da origem', JSON.stringify(victim), r.status, r.out.match(/FALHA[^\n]*/)?.[0])
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/origem tem voz/)
      })

      it('sem achado: `--cutover` numa RÉPLICA cuja cópia tem tentativa EM VOO que a origem não tem → falha alto e NADA vira', async () => {
        await restoreIssuerFromReal()
        await seedInFlight(W)
        const r = runScript('migrate:setes', ['--cutover', '1', '--confirmo-setes-api-parado', '--dry-run'], ownerEnv())
        await purge([W])
        // eslint-disable-next-line no-console
        console.log('[adv-r5] --cutover com tentativa só no fiscal_api', r.status, r.out.match(/FALHA[^\n]*/)?.[0])
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(/dual-write/)
        expect((await issuerOfCopy())?.c).toBeNull()
      })
    })

    // -----------------------------------------------------------------------
    describe('F. smoke:adn-h SEM --vai (processo filho apontado para a cópia)', () => {
      it('sem achado: --candidatas e --nota só leem; nome de banco fora do molde ou igual ao banco da instância → recusado; nenhum banco criado', async () => {
        await restoreCertFromReal()
        const dbs0 = await fiscalDbs()
        const env = { ...copyEnv(), SMOKE_DB_USER: setesUser, SMOKE_DB_PASSWORD: setesPass }
        const cand = runScript('smoke:adn-h', ['--candidatas'], env)
        const nota = runScript('smoke:adn-h', ['--nota', String(X)], env)
        const copyName = runScript('smoke:adn-h', ['--nota', String(X)], { ...env, SMOKE_DB_NAME: COPY })
        const same = runScript('smoke:adn-h', ['--nota', String(X)], { ...env, SMOKE_DB_NAME: 'fiscal_api_smoke_r5', FISCAL_DB_NAME: 'fiscal_api_smoke_r5' })
        const realName = runScript('smoke:adn-h', ['--nota', String(X)], { ...env, SMOKE_DB_NAME: REAL })
        // eslint-disable-next-line no-console
        console.log('[adv-r5] smoke sem --vai', JSON.stringify({ candidatas: cand.status, nota: [nota.status, nota.out.match(/Sem --vai[^\n]*|FALHA[^\n]*/)?.[0]],
          copia: copyName.status, mesmoBanco: same.status, real: realName.status }))
        expect(cand.status).toBe(0)
        if (nota.status === 0) expect(nota.out).toMatch(/Sem --vai: nada enviado ao fisco, nenhum banco criado/)
        else expect(nota.out).toMatch(/\[smoke:adn-h\] FALHA:/)
        expect(nota.out).not.toMatch(/EMISSOR DO SMOKE|1\. TRANSMITIR/)
        for (const r of [copyName, same, realName]) {
          expect(r.status).not.toBe(0)
          expect(r.out).toMatch(/SMOKE_DB_NAME inválido/)
        }
        expect(await fiscalDbs()).toEqual(dbs0)
      })
    })

    // -----------------------------------------------------------------------
    describe('G. harness — D-F53: o ataque IMPEDE escrita no ERP (usuário do serviço); o fiscal_api real segue por detecção', () => {
      const h: any = {}
      it('[D-F53] o pool do ataque usa o usuário do SERVIÇO (não o dono do ERP); a verificação do drop() cobre o fiscal_api real', async () => {
        h.user = (await q('SELECT CURRENT_USER() AS u'))[0].u
        h.grants = (await q('SHOW GRANTS FOR CURRENT_USER()')).map((r: any) => String(Object.values(r)[0]).replace(/PASSWORD '[^']*'/, "PASSWORD '***'"))
        h.realBaseTables = (await rq(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, [REAL])).map((r: any) => String(r.t))
        h.checked = [...FISCAL_COPY_TABLES, '_migrations']                         // o drop() confere também a _migrations (re-prova R4)
        // eslint-disable-next-line no-console
        console.log('[adv-r5] harness', JSON.stringify(h))
        expect(h.user).toMatch(new RegExp(`^${process.env.DB_USER}@`))
        expect(h.user).not.toMatch(new RegExp(`^${setesUser}@`))
        expect(h.realBaseTables).toEqual(expect.arrayContaining(h.checked))
      })
      // D-F53 (= Q-F53 (a), Valdo 2026-10-04; GRANT completado nos 4 hosts em 2026-10-10): o ERP é protegido por PRIVILÉGIO —
      // provado pelos GRANTs do usuário E pela recusa do próprio MySQL
      it('[D-F53] …e o pool do ataque NÃO tem privilégio de escrita no ERP nem global (prevenção por privilégio)', () => {
        expect(h.grants.some((g: string) => /ON \*\.\*/.test(g) && !/^GRANT USAGE ON/.test(g))).toBe(false)
        expect(h.grants.some((g: string) => /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^`]*ON `setes/.test(g))).toBe(false)
      })
      it('[D-F53] …e o pool do ataque NÃO consegue escrever no ERP (o MySQL recusa antes de executar — WHERE 1 = 0 não toca linha)', async () => {
        await expect(q(`DELETE FROM \`${SCHEMA}\`.tb_invoice_event WHERE 1 = 0`)).rejects.toMatchObject({ errno: 1142 })
        await expect(q(`UPDATE \`${SCHEMA}\`.tb_establishment_issuer SET deleted = deleted WHERE 1 = 0`)).rejects.toMatchObject({ errno: 1142 })
      })
      // LIMITE aceito: POR DESENHO o usuário do serviço é DONO do fiscal_api real (D-F7/D-F15) — ali a defesa dos ataques segue
      // sendo DETECÇÃO (CHECKSUM do real no drop()); prevenção exigiria um usuário de teste próprio (decisão nova, se quiser)
      it.failing('[D-F53 — limite] …o pool do ataque NÃO tem escrita no fiscal_api REAL (o serviço é dono dele)', () => {
        expect(h.grants.some((g: string) => /ON `?fiscal_api`?\.\*/.test(g))).toBe(false)
      })
      it('[corrigido] …e a verificação do drop() cobre TODAS as tabelas-base do fiscal_api real (inclusive `_migrations`)', () => {
        expect(h.checked).toEqual(expect.arrayContaining(h.realBaseTables))
      })
    })
  })
})

if (!LIVE) it('adversarial r5 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
