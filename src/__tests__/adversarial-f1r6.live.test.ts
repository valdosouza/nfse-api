/// <reference types="jest" />
// GATE ADVERSARIAL — RE-PROVA FINAL do DELTA do RETRABALHO 2 da RODADA 4 — AO VIVO: banco do dev (ERP só LIDO) + FISCO FALSO
// + CÓPIA DESCARTÁVEL `fiscal_api_adv_r6` (harness `live-harness.ts`). ⚠️ Só roda com NFSE_ADV_LIVE=1.
// Isolamento (molde do r5):
//  - adaptador FALSO e o transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real); `migrate:setes` e
//    o smoke rodam em processo filho SEM `--vai` e apontados para a CÓPIA (FISCAL_DB_NAME);
//  - o ERP é só LIDO (as travas são FOR UPDATE de leitura) — CHECKSUM do ERP antes/depois;
//  - TODA escrita do teste passa por `w()` (recusa alvo `fiscal_api.`/`setes_*.`); o banco de smoke temporário
//    (`fiscal_api_smoke_r6`) e o de sobra (`fiscal_api_advr6`) são apagados no fim;
//  - o `fiscal_api` REAL: CHECKSUM das 6 tabelas-base + lista de objetos antes/depois; `SHOW DATABASES LIKE 'fiscal%'`
//    termina só com `fiscal_api`.
//
// Achados deste arquivo (os `it.failing` reproduzem; cada um tem o `it` de CENÁRIO antes):
//  - [MEDIUM] DELETE do A1 × reserva K do CANCELAMENTO no fisco: a guarda do DELETE conta 0 vivas (snapshot depois da trava
//    da habilitação) e o cancelamento grava o K e abre o A1 sem passar por essa trava → A1 apagado com o K VIVO; ambíguo =
//    K irreconciliável (refresh → 409 FISCAL_CERT_MISSING) — a invariante que o retrabalho 2 diz ter fechado;
//    CORRIGIDO pós-gate (o cancelamento trava a habilitação antes do K) — o cenário foi reescrito para a ordem nova
//    (sessão 2026-10-04): o cancelamento espera o DELETE, vê o A1 apagado e devolve o K com N sem falar com o fisco;
//  - [sessão 2026-10-04] §D: `lockIssuerRows` por FAIXA + `getIssuer(...FOR UPDATE)` antes = promoção de trava → 1213 cru
//    no aluguel do rodízio; corrigido com trava POR LINHA no núcleo + `leaseCommand` (deadlock reexecuta 1×, resto 409);
//  - [LOW] `migrate:setes`: a conferência de XML foi para DEPOIS do commit, mas a falha dela ainda imprime
//    "FALHA (nada gravado)" — a virada (write-once) e a re-sincronia JÁ estão comitadas;
//  - [LOW] harness: a varredura de sobras (`fiscal\_api\_adv\_%`) não casa nomes que o próprio validador aceita
//    (`fiscal_api_adv[a-z0-9_]*` — ex.: o `fiscal_api_adv4` da suíte r4, que roda `--cutover` com o A1 e o contador reais).
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r6.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import forge from 'node-forge'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError, createFiscalPool, dbConfigFromEnv, runMigrations } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, FISCAL_COPY_TABLES } from './live-harness'
import { createApp } from '../app'
import { MIGRATION_SETS } from '../migrations'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions,
  resetMunicipalTermsCache,
} from '../nfse/transmission'
import { countLiveTransmissions } from '../nfse/repository'
import { saveIssuer } from '../modules/emitter/emitter.service'

// mesma normalização EM MEMÓRIA das rodadas 1–5: o ramo congelado das notas do dev tem cTribMun "0102" (anterior à D-N26b)
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
const ADV_USER = 990006
const CNPJ = '07742094000113'
const COPY = 'fiscal_api_adv_r6'
const SOBRA = 'fiscal_api_advr6'                 // nome que o VALIDADOR do harness aceita e a VARREDURA não casa
const SMOKE = 'fiscal_api_smoke_r6'
const REAL = 'fiscal_api'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R6</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
const ambiguous = () => new AuthorityHttpError(503, 'Fisco sem resposta (falso — ambíguo)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const fisco = {
  byKey: new Map<string, string>(),
  calls: { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 },
}
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() { fisco.calls.transmit++; throw ambiguous() },          // a reserva fica EM VOO
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
  async registerEvent() { fisco.calls.event++; throw ambiguous() },        // pedido de cancelamento SEM resposta: K fica
  async municipalTerms() { fisco.calls.terms++; return { cancelDays: 60, raw: null } },
}
function resetFisco(): void { fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 } }

const tmpRoot = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r6-')) : ''
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
const INST_PAYLOAD = { institutionId: INST, userId: ADV_USER, role: 'admin', schemaName: SCHEMA } as any

let ctx: AppContext
let harness: DisposableFiscalDb | null = null
let app: any
let rootPool: ReturnType<typeof createFiscalPool>
let setesUser = '', setesPass = ''

const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]
async function w(sql: string, params: any[] = []): Promise<any> {
  if (/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql)) {
    const target = sql.split(/\bSELECT\b/i)[0]
    if (/`?fiscal_api`?\s*\.|`?setes_[a-z0-9_]*`?\s*\./i.test(target)) throw new Error(`ADV r6: escrita fora da cópia recusada: ${sql.slice(0, 90)}`)
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
async function seedDps(inv: number, life: number, n: number): Promise<string> {
  const dpsId = `DPS4106902${'2'}${CNPJ}00999${String(n).padStart(15, '0')}`
  await w(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, ?, '999', ?, ?, ?, NOW(), NOW(), 'N')`, [INST, inv, life, n, dpsId, ADV_USER])
  return dpsId
}
async function seedAuthorized(inv: number, daysAgo: number): Promise<{ key: string; dpsId: string }> {
  const life = await lifeOf(inv)
  const dpsId = await seedDps(inv, life, 990_600_000 + inv)
  const key = (`41069022${CNPJ}96${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50)
  await w(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', ?, '990001', DATE_SUB(NOW(), INTERVAL ? DAY), NULL, ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [INST, inv, life, key, daysAgo, ADV_USER, daysAgo])
  await w(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, 1, 'A', NULL, 'autorizada SINTÉTICA (adversarial r6)', DATE_SUB(NOW(), INTERVAL ? DAY), 'P', ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [INST, inv, daysAgo, ADV_USER, daysAgo])
  fisco.byKey.set(key, dpsId)
  return { key, dpsId }
}
async function purge(ids: number[]): Promise<void> {
  for (const id of ids) {
    await w(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
    await w(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
    await w(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
  }
}
const kindsOf = async (inv: number) => (await q(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt, event`, [INST, inv])).map(r => String(r.kind))
const issuerOfCopy = async () => (await q(`SELECT environment, serie, dps_last_number AS n, deleted, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c
                                             FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0] ?? null
const certOfCopy = async () => (await q(`SELECT deleted, certificate_pem IS NULL AS noPem, fingerprint256 AS fp FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0] ?? null
const realCertFp = async () => (await rq(`SELECT fingerprint256 AS fp FROM \`${REAL}\`.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0]?.fp
async function restoreIssuerFromReal(): Promise<void> {
  await w(`DELETE FROM \`${COPY}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
  await w(`INSERT INTO \`${COPY}\`.tb_establishment_issuer SELECT * FROM \`${REAL}\`.tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
}
const restoreCertFromReal = () =>
  w(`REPLACE INTO \`${COPY}\`.tb_establishment_certificate SELECT * FROM \`${REAL}\`.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST])
const turnCopy = () => w(`UPDATE tb_establishment_issuer SET cutover_at = NOW(), environment = 'H', serie = '900', deleted = 'N', refresh_lease_until = NULL
                          WHERE tb_institution_id = ? AND model = 'SE'`, [INST])

function pfxFor(cn: string, password = 'senha'): { pfx: Buffer; fp: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '06' + Math.floor(Math.random() * 1e8).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const fp = forge.md.sha256.create().update(der).digest().toHex()
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), fp }
}
const storeA1 = (pfx: Buffer) => fiscal.storeCertificate({ pool: ctx.pool, keyring: ctx.keyring }, INST, pfx, 'senha',
  { expectedCnpj: CNPJ, userId: ADV_USER, schemaName: SCHEMA }).then(() => 'gravou', (e: any) => [e.statusCode ?? e.errno, e.code])
const clearA1 = () => fiscal.clearCertificate({ pool: ctx.pool, keyring: ctx.keyring }, INST, ADV_USER, { schemaName: SCHEMA })
  .then(() => 'apagou', (e: any) => [e.statusCode ?? e.errno, e.code])

/** Processo filho SEMPRE apontado para a CÓPIA e NUNCA com `--vai`. */
const guardArgs = (args: string[]) => { if (args.includes('--vai')) throw new Error('ADV r6: --vai é proibido nesta suíte') }
const runScript = (script: string, args: string[], env: Record<string, string>) => {
  guardArgs(args)
  const r = spawnSync('npm', ['run', script, '--', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env } })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}
const spawnScript = (script: string, args: string[], env: Record<string, string>) => {
  guardArgs(args)
  return new Promise<{ status: number | null; out: string }>(resolve => {
    const p = spawn('npm', ['run', script, '--', ...args], { cwd: ROOT, shell: true, env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', c => { out += String(c) }); p.stderr.on('data', c => { out += String(c) })
    p.on('close', code => resolve({ status: code, out }))
  })
}
const copyEnv = () => ({ FISCAL_DB_NAME: COPY, DB_USER: setesUser, DB_PASSWORD: setesPass })

let realBefore: { sums: Record<string, string>; objects: string } = { sums: {}, objects: '' }
let erpBefore: Record<string, string> = {}
let X = 0, Z = 0
const sweep: any = {}

d('GATE ADVERSARIAL r6 — re-prova final do delta do retrabalho 2 (cópia descartável fiscal_api_adv_r6 + fisco falso)', () => {
  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(ROOT, '..', 'setes-api', '.env')))
    setesUser = setesEnv.DB_USER; setesPass = setesEnv.DB_PASSWORD ?? ''
    rootPool = createFiscalPool({ ...dbConfigFromEnv(process.env), database: 'information_schema', user: setesUser, password: setesPass })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r6: rede bloqueada — nenhum fisco real') }
    expect(await fiscalDbs()).toEqual([REAL])
    realBefore = await realSums()
    erpBefore = await erpSums()

    // G (pré-condição da prova da varredura): uma SOBRA com nome que o validador do harness aceita — banco VAZIO (nada real)
    expect(/^fiscal_api_adv[a-z0-9_]*$/.test(SOBRA)).toBe(true)
    await rootPool.query(`CREATE DATABASE \`${SOBRA}\``)
    const cwd = process.cwd(); process.chdir(ROOT)
    try { harness = await disposableFiscalDb(ROOT, COPY, { turned: false }) } finally { process.chdir(cwd) }
    sweep.after = await fiscalDbs()
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.fiscalDb).toBe(COPY)
    expect((await q('SELECT DATABASE() AS db'))[0].db).toBe(COPY)
    expect((await issuerOfCopy())?.c).toBeNull()
    app = createApp(ctx)
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
      if (!X) {
        try {
          const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, INST, id)
          await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
          X = id; continue
        } catch { /* cadastro incompleto — serve só de alvo sintético */ }
      }
      if (!Z) Z = id
      if (X && Z) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r6] notas-alvo: transmite', X, '| sintética', Z)
    expect(X).toBeGreaterThan(0)
    expect(Z).toBeGreaterThan(0)
  })
  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    let dbsAfter: string[] = [], realAfter = { sums: {} as Record<string, string>, objects: '' }, erpAfter: Record<string, string> = {}
    let dropErr: unknown = null
    try {
      if (harness) { try { await harness.drop() } catch (e) { dropErr = e } }   // apaga a cópia e FALHA se o real/ERP mudou
      for (const db of [COPY, SOBRA, SMOKE]) if ((await fiscalDbs()).includes(db)) await rootPool.query(`DROP DATABASE IF EXISTS \`${db}\``)
      dbsAfter = await fiscalDbs()
      realAfter = await realSums()
      erpAfter = await erpSums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r6] fiscal_api REAL antes', JSON.stringify(realBefore), '| depois', JSON.stringify(realAfter),
        '\n[adv-r6] ERP antes', JSON.stringify(erpBefore), '| depois', JSON.stringify(erpAfter), '\n[adv-r6] bancos fiscal% no fim', dbsAfter.join(','))
      await rootPool.end()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (dropErr) throw dropErr
    if (JSON.stringify(realAfter) !== JSON.stringify(realBefore)) throw new Error('O fiscal_api REAL mudou durante o ataque — conferir')
    if (JSON.stringify(erpAfter) !== JSON.stringify(erpBefore)) throw new Error('O ERP mudou durante o ataque — conferir')
    if (JSON.stringify(dbsAfter) !== JSON.stringify([REAL])) throw new Error(`Sobrou banco fiscal%: ${dbsAfter.join(',')}`)
  })

  // =========================================================================
  describe('A. [MEDIUM] DELETE do A1 × reserva K do CANCELAMENTO no fisco (habilitação VIRADA só na cópia)', () => {
    beforeAll(async () => { await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy() })
    afterAll(async () => { await purge([Z]); await restoreCertFromReal() })
    const reason = 'cancelamento adversarial r6 — reserva K × DELETE do A1'

    const ctl: any = {}
    it('controle: o K JÁ gravado (pedido ambíguo) ANTES do DELETE → 409 FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS e o A1 fica', async () => {
      await purge([Z]); await seedAuthorized(Z, 5)
      ctl.cancel = await cancelServiceInvoiceAtAuthority(ctx, ACTOR, Z, reason).then(() => 'ok', (e: any) => [e.statusCode, e.code])
      ctl.kinds = await kindsOf(Z)
      const r = await request(app).delete('/v1/emitter/certificate').set(bearer(tok()))
      ctl.delete = [r.status, r.body.code]
      ctl.cert = (await certOfCopy())?.deleted
      // eslint-disable-next-line no-console
      console.log('[adv-r6] controle K antes do DELETE', JSON.stringify(ctl))
      expect(ctl.cancel).toEqual([503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
      expect(ctl.kinds).toEqual(['A', 'K'])
      expect(ctl.delete).toEqual([409, 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS'])
      expect(ctl.cert).toBe('N')
    })

    const race: any = {}
    // ORDEM NOVA (correção pós-gate de 2026-10-04: o cancelamento trava a habilitação antes do K). O cenário antigo — "o
    // cancelamento grava o K NO intervalo do DELETE" — deixou de existir: o cancelamento agora ESPERA a mesma trava que o
    // DELETE segura. (Esperá-lo com o bloqueador preso só produzia lock wait de 50 s nos dois — sessão de 2026-10-04.)
    it('cenário (ordem nova): o DELETE trava a habilitação, conta 0 vivas e espera a linha do A1; o cancelamento ESPERA a trava da habilitação — nenhum K nasce enquanto o DELETE decide', async () => {
      await purge([Z]); await seedAuthorized(Z, 5); await restoreCertFromReal()
      const blocker = await ctx.pool.getConnection()
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        // alarga a janela entre a CONTAGEM e o COMMIT do DELETE (o UPDATE do A1 espera esta linha) — nada é apagado aqui
        await blocker.query(`SELECT tb_institution_id FROM tb_establishment_certificate WHERE tb_institution_id = ? FOR UPDATE`, [INST])
        const pDel = request(app).delete('/v1/emitter/certificate').set(bearer(tok())).then(r => r)
        race.deleteBlocked = await waitBlocked(Number(cid), [/UPDATE tb_establishment_certificate/i])
        const pCancel = cancelServiceInvoiceAtAuthority(ctx, ACTOR, Z, reason).then(() => 'ok', (e: any) => [e.statusCode ?? e.errno, e.code])
        race.cancelBlocked = await waitBlocked(Number(cid), [/FROM tb_establishment_issuer/i, /FOR UPDATE/i])
        race.kindsWhileBlocked = await kindsOf(Z)
        await blocker.rollback()
        const del = await pDel
        race.delete = [del.status, del.body.code ?? null]
        race.cancel = await pCancel
        race.kindsAfterCancel = await kindsOf(Z)
      } finally {
        try { await blocker.rollback() } catch { /* já encerrada */ }
        blocker.release()
      }
      race.cert = await certOfCopy()
      race.live = await countLiveTransmissions(ctx.pool, INST)
      try { await refreshServiceTransmission(ctx, ACTOR, Z); race.refresh = 'ok' } catch (e: any) { race.refresh = [e.statusCode, e.code] }
      race.events = fisco.calls.event
      // eslint-disable-next-line no-console
      console.log('[adv-r6] DELETE do A1 × reserva K do cancelamento', JSON.stringify(race))
      expect(race.deleteBlocked).toBe(true)
      expect(race.cancelBlocked).toBe(true)
      expect(race.kindsWhileBlocked).toEqual(['A'])                        // o K não nasce enquanto o DELETE segura a trava
    })
    it('[corrigido] …o DELETE conclui SEM nada vivo e o cancelamento que chega depois vê o A1 apagado SOB a trava: 409 antes do K (gates do delta de 2026-10-04 — sem a janela K→N), nenhum pedido ao fisco', () => {
      expect(race.delete).toEqual([200, null])                             // nada vivo no instante da decisão do DELETE
      expect(race.cancel).toEqual([409, 'FISCAL_CERT_MISSING'])
      expect(race.kindsAfterCancel).toEqual(['A'])                         // nenhuma voz: a decisão conferiu o A1 antes do K
      expect(race.events).toBe(0)                                         // o pedido de cancelamento não saiu
      expect(race.cert.deleted).toBe('S')
      expect(race.live).toBe(0)
      expect(race.live > 0 && race.cert.deleted === 'S').toBe(false)      // a invariante: nenhum K vivo sem o A1
      expect(race.refresh).toEqual([409, 'FISCAL_CERT_MISSING'])           // sem A1 a consulta recusa — e nada ficou em voo
    })
  })

  // =========================================================================
  describe('B. núcleo — escrever/apagar o A1 DIRETO na réplica viva, excluída e na lacuna (b)', () => {
    afterAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('sem achado: `storeCertificate` e `clearCertificate` direto → 409 FISCAL_CUTOVER_PENDING nos três casos; o A1 não muda', async () => {
      const out: any = {}
      const { pfx } = pfxFor(`ADV R6 TESTE:${CNPJ}`)
      const fp0 = (await certOfCopy())?.fp
      await restoreIssuerFromReal()                                                       // réplica VIVA
      out.viva = [await storeA1(pfx), await clearA1()]
      await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ?`, [INST])   // réplica EXCLUÍDA
      out.excluida = [await storeA1(pfx), await clearA1()]
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])                // lacuna (b): ERP tem SE
      out.lacunaB = [await storeA1(pfx), await clearA1()]
      out.cert = await certOfCopy()
      // eslint-disable-next-line no-console
      console.log('[adv-r6] núcleo do A1 na réplica', JSON.stringify(out))
      for (const k of ['viva', 'excluida', 'lacunaB']) expect(out[k]).toEqual([[409, 'FISCAL_CUTOVER_PENDING'], [409, 'FISCAL_CUTOVER_PENDING']])
      expect([out.cert.deleted, out.cert.fp]).toEqual(['N', fp0])
    })
  })

  // =========================================================================
  describe('C. corrida A1 × `migrate:setes --cutover` (processo filho na CÓPIA) — sem deadlock, desfecho coerente', () => {
    afterAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('sem achado: a virada e o PUT do A1 esperam a MESMA trava da habilitação; quem pega primeiro decide, o outro vê o estado novo', async () => {
      await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal()
      const { pfx, fp } = pfxFor(`ADV R6 TESTE:${CNPJ}`)
      const out: any = {}
      const blocker = await ctx.pool.getConnection()
      let pCut: Promise<{ status: number | null; out: string }> | null = null
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        await blocker.query(`SELECT cutover_at FROM tb_establishment_issuer WHERE tb_institution_id = ? FOR UPDATE`, [INST])
        // D-F44: o ato REAL aposenta a habilitação SE do ERP — contra o ERP real do dev, SÓ em --dry-run (escrita desfeita)
        pCut = spawnScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'], copyEnv())
        out.cutBlocked = await waitBlocked(Number(cid), [/SELECT model, cutover_at AS c FROM tb_establishment_issuer/, /FOR UPDATE/i], 1, 90_000)   // trava POR LINHA (D-F42)
        const pStore = storeA1(pfx)
        out.storeBlocked = await waitBlocked(Number(cid), [/SELECT cutover_at AS c FROM tb_establishment_issuer/, /FOR UPDATE/i])
        await blocker.rollback()
        out.store = await pStore
        const cut = await pCut
        out.cutStatus = cut.status
        out.cutMsg = cut.out.match(/"linhasViradas": \d+|FALHA[^\n]*/)?.[0]
      } finally {
        try { await blocker.rollback() } catch { /* já encerrada */ }
        blocker.release()
        if (pCut) await pCut
      }
      out.issuer = await issuerOfCopy()
      const norm = (v: unknown) => String(v ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
      out.certFp = (await certOfCopy())?.fp
      out.newFp = norm(out.certFp) === norm(fp) ? 'novo' : norm(out.certFp) === norm(await realCertFp()) ? 'real' : out.certFp
      // eslint-disable-next-line no-console
      console.log('[adv-r6] --cutover × PUT do A1', JSON.stringify(out))
      expect(out.cutBlocked).toBe(true)
      expect(out.storeBlocked).toBe(true)
      expect(out.cutStatus).toBe(0)
      expect(out.cutMsg).toBe('"linhasViradas": 1')                                  // o ato virou DENTRO da transação…
      expect(out.issuer.c).toBeNull()                                                  // …e o --dry-run desfez (D-F44)
      // desfecho coerente: quem pegou a trava primeiro decidiu; o A1 nunca é escrito numa réplica (antes OU depois do ensaio)
      expect(out.store).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
      expect(out.newFp).toBe('real')
    })
  })

  // =========================================================================
  describe('D. ordem nota → habilitação → A1: reserva × PUT do A1 × PUT da habilitação × passada, concorrentes', () => {
    beforeAll(async () => { await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy(); await seedAuthorized(Z, 5) })
    afterAll(async () => { await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('sem achado: 4 rodadas — nenhum 500/deadlock cru; cada reserva cunha um nDPS único e chega ao fisco falso (ambíguo)', async () => {
      const rounds: any[] = []
      const { pfx } = pfxFor(`ADV R6 TESTE:${CNPJ}`)
      for (let i = 0; i < 4; i++) {
        await purge([X])
        await w(`UPDATE tb_invoice_service_transmission SET last_queried_at = NULL WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, Z])
        await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
        const res = await Promise.all([
          transmitServiceInvoice(ctx, ACTOR, X).then(() => 'ok', (e: any) => [e.statusCode ?? e.errno, e.code]),
          storeA1(pfx),
          saveIssuer(ctx, INST_PAYLOAD, 'SE', { environment: 'H', serie: '900' }).then(() => 'ok', (e: any) => [e.statusCode ?? e.errno, e.code]),
          refreshOpenServiceTransmissions(ctx, ACTOR, { budgetMs: 2000 }).then(r => ({ checked: r.checked, skipped: r.skipped, errors: r.errors.map(x => x.code) }),
            (e: any) => [e.statusCode ?? e.errno, e.code]),
        ])
        rounds.push(res)
      }
      const dps = await q(`SELECT dps_number AS n FROM tb_invoice_service_dps WHERE tb_institution_id = ? ORDER BY dps_number`, [INST])
      // eslint-disable-next-line no-console
      console.log('[adv-r6] concorrência nota → habilitação → A1', JSON.stringify(rounds), '| envios', fisco.calls.transmit)
      const flat = JSON.stringify(rounds)
      expect(flat).not.toMatch(/INTERNAL|ER_LOCK_DEADLOCK|ER_LOCK_WAIT_TIMEOUT|\b1213\b|\b1205\b|\[500/)
      for (const [t, s, h] of rounds) {
        expect(JSON.stringify(t)).toMatch(/503,"FISCAL_AUTHORITY_UNAVAILABLE"|409,"RESOURCE_BUSY"/)
        expect(s).toBe('gravou')
        expect(h).toBe('ok')
      }
      expect(new Set(dps.map(r => Number(r.n))).size).toBe(dps.length)
    })

    it('[corrigido — sessão 2026-10-04] determinístico: `getIssuer(FOR UPDATE)` → aluguel na FILA → `lockIssuerRows` + `upsertIssuer` na MESMA transação: nenhum 1213 (era a promoção de trava da FAIXA — o caminho do PUT da habilitação)', async () => {
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      const conn = await ctx.pool.getConnection()
      const out: any = {}
      try {
        const [[{ cid }]] = await conn.query('SELECT CONNECTION_ID() AS cid') as any
        await conn.beginTransaction()
        await fiscal.getIssuer(conn, INST, 'SE', true)                                   // trava de REGISTRO na linha SE
        const pLease = fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 90).then(t => (t ? 'alugou' : 'nulo'), (e: any) => [e.errno, e.code])
        out.queued = await waitBlocked(Number(cid), [/SET refresh_lease_until/i])       // o aluguel ESPERA a linha
        out.lock = await fiscal.lockIssuerRows(conn, INST).then(() => 'ok', (e: any) => [e.errno, e.code])
        out.upsert = await fiscal.upsertIssuer(conn, SCHEMA, INST, 'SE', { environment: 'H', serie: '900', userId: ADV_USER })
          .then(() => 'ok', (e: any) => [e.errno ?? e.statusCode, e.code])
        await conn.commit()
        out.lease = await pLease
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r6] promoção de trava ponto → linhas com o aluguel na fila', JSON.stringify(out))
      expect(out).toEqual({ queued: true, lock: 'ok', upsert: 'ok', lease: 'alugou' })   // com a FAIXA: lease = [1213, 'ER_LOCK_DEADLOCK']
    })
  })

  // =========================================================================
  describe('E. [LOW, corrigido] `migrate:setes` — depois do commit nada nega o commit (falha da conferência de XML vira AVISO)', () => {
    afterAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal() })
    const mig: any = {}
    it('cenário: STORAGE_PATH com a pasta do CNPJ trocada por um ARQUIVO (ENOTDIR na conferência) — re-sincronia COMMITA e AVISA; `--cutover --dry-run` (D-F44: o ato real escreve no ERP) também só AVISA', async () => {
      await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal()
      const broken = path.join(tmpRoot, 'storage-quebrado')
      fs.mkdirSync(broken, { recursive: true })
      fs.writeFileSync(path.join(broken, CNPJ), 'nao sou pasta')
      // re-sincronia: a origem VENCE nos campos mutáveis — a série adulterada na cópia volta à do ERP se o commit acontecer
      await w(`UPDATE tb_establishment_issuer SET serie = '777' WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
      const rs = runScript('migrate:setes', [], { ...copyEnv(), STORAGE_PATH: broken })
      mig.resync = { status: rs.status, msg: rs.out.match(/FALHA[^\n]*/)?.[0]?.slice(0, 140), serieDepois: (await issuerOfCopy())?.serie }
      await restoreIssuerFromReal()
      const ct = runScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'], { ...copyEnv(), STORAGE_PATH: broken })   // D-F44: só ensaio contra o ERP real
      mig.cutover = { status: ct.status, msg: ct.out.match(/FALHA[^\n]*/)?.[0]?.slice(0, 140), viradaDepois: (await issuerOfCopy())?.c }
      mig.xmlWarning = /conferência de XML NÃO concluída/.test(rs.out) && /conferência de XML NÃO concluída/.test(ct.out)
      // eslint-disable-next-line no-console
      console.log('[adv-r6] migrate:setes com falha DEPOIS do commit', JSON.stringify(mig))
      for (const r of [mig.resync, mig.cutover]) {
        expect(r.status).toBe(0)
        expect(r.msg).toBeUndefined()                                            // nenhuma "FALHA (nada gravado)"
      }
    })
    it('[corrigido] …e a saída corresponde ao que foi gravado: a série voltou à da origem; o ensaio do ato não deixou a cópia virada (o aviso da conferência está nos dois relatórios)', () => {
      expect(mig.resync.serieDepois).not.toBe('777')
      expect(mig.cutover.viradaDepois).toBeNull()                                     // D-F44: o ato roda em --dry-run (o commit do ato está no resync acima)
      expect(mig.xmlWarning).toBe(true)
    })
  })

  // =========================================================================
  describe('F. smoke:adn-h SEM --vai — evidência anterior e `--descartar-evidencia`', () => {
    afterAll(async () => { await rootPool.query(`DROP DATABASE IF EXISTS \`${SMOKE}\``) })
    it('sem achado: banco de smoke com EVIDÊNCIA (envio sem voz) fica intacto mesmo com `--descartar-evidencia` (sem --vai nada é apagado)', async () => {
      await restoreCertFromReal()
      await runMigrations({ ...harness!.cfg, database: SMOKE }, MIGRATION_SETS)
      const life = await lifeOf(X)
      await rootPool.query(`INSERT INTO \`${SMOKE}\`.tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
                            VALUES (?, ?, 0, ?, '900', 1, ?, NULL, NOW(), NOW(), 'N')`, [INST, X, life, `DPS4106902${'2'}${CNPJ}00900${'1'.padStart(15, '0')}`])
      await rootPool.query(`INSERT INTO \`${SMOKE}\`.tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, tb_user_id, created_at, updated_at, deleted)
                            VALUES (?, ?, 0, 1, ?, 'H', NULL, NOW(), NOW(), 'N')`, [INST, X, life])
      const env = { ...copyEnv(), SMOKE_DB_USER: setesUser, SMOKE_DB_PASSWORD: setesPass, SMOKE_DB_NAME: SMOKE }
      const runs = [
        runScript('smoke:adn-h', ['--nota', String(X), '--descartar-evidencia'], env),
        runScript('smoke:adn-h', ['--candidatas', '--descartar-evidencia'], env),
      ]
      const left = await rq(`SELECT COUNT(*) AS n FROM \`${SMOKE}\`.vw_invoice_service_transmission WHERE last_kind IS NULL`)
      // eslint-disable-next-line no-console
      console.log('[adv-r6] smoke sem --vai × evidência', JSON.stringify(runs.map(r => [r.status, r.out.match(/Sem --vai[^\n]*|FALHA[^\n]*|ELEGÍVEIS/)?.[0]])), '| evidência', left[0].n)
      expect(runs[1].status).toBe(0)
      if (runs[0].status !== 0) expect(runs[0].out).toMatch(/\[smoke:adn-h\] FALHA:/)
      else expect(runs[0].out).toMatch(/Sem --vai: nada enviado ao fisco, nenhum banco criado/)
      for (const r of runs) expect(r.out).not.toMatch(/EMISSOR DO SMOKE|1\. TRANSMITIR|APAGADO/)
      expect(await fiscalDbs()).toContain(SMOKE)
      expect(Number(left[0].n)).toBe(1)
    })
  })

  // =========================================================================
  describe('G. [LOW] harness — varredura de sobras e cobertura do CHECKSUM', () => {
    it('cenário: uma sobra `fiscal_api_advr6` (nome que o VALIDADOR aceita — molde do `fiscal_api_adv4` da suíte r4) existia quando o harness criou a cópia', async () => {
      // eslint-disable-next-line no-console
      console.log('[adv-r6] bancos fiscal% logo depois de criar a cópia', JSON.stringify(sweep.after))
      expect(sweep.after).toContain(COPY)
      // CHECKSUM de tabela INEXISTENTE é NULL sem erro: ADV_ERP_SCHEMA errado = vigilância que sempre "bate"
      const ghost = await rq(`CHECKSUM TABLE setes_nao_existe_r6.tb_invoice`)
      sweep.ghost = ghost[0]?.Checksum ?? null
      expect(sweep.ghost).toBeNull()
    })
    it('[corrigido] …e a varredura a apagou (casa TODO nome que o validador aceita)', () => {
      expect(sweep.after).not.toContain(SOBRA)
    })
  })

  // =========================================================================
  describe('H. aluguel — renovação no mesmo segundo, dono errado, habilitação excluída no meio', () => {
    beforeAll(async () => { await restoreIssuerFromReal(); await turnCopy() })
    afterAll(async () => { await restoreIssuerFromReal() })
    it('sem achado: toma e renova no MESMO segundo (FOUND_ROWS); token alheio não renova nem devolve; aluguel vencido não é retomado por renovação alheia', async () => {
      const out: any = {}
      const t1 = await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 90)
      out.renewSameSecond = await fiscal.renewRefreshLease(ctx.pool, INST, 'SE', t1!, 90)
      out.second = await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 90)                  // ocupado
      out.renewStranger = await fiscal.renewRefreshLease(ctx.pool, INST, 'SE', '2020-01-01 00:00:00', 90)
      out.releaseStranger = await fiscal.releaseRefreshLease(ctx.pool, INST, 'SE', '2020-01-01 00:00:00')
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE tb_institution_id = ?`, [INST])
      const expired = (await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS t FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0].t
      out.newOwner = await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 90)
      out.oldOwnerRenew = await fiscal.renewRefreshLease(ctx.pool, INST, 'SE', expired, 90)
      await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ?`, [INST])
      out.renewAfterDelete = !!(await fiscal.renewRefreshLease(ctx.pool, INST, 'SE', out.newOwner, 90))
      out.release = await fiscal.releaseRefreshLease(ctx.pool, INST, 'SE', (await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS t FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0].t)
      // eslint-disable-next-line no-console
      console.log('[adv-r6] aluguel', JSON.stringify(out))
      expect(t1).not.toBeNull()
      expect(out.renewSameSecond).not.toBeNull()                                             // mesmo segundo (ou o seguinte): renova
      expect(String(out.renewSameSecond) >= String(t1)).toBe(true)
      expect(out.second).toBeNull()
      expect(out.renewStranger).toBeNull()
      expect(out.releaseStranger).toBe(false)
      expect(out.newOwner).not.toBeNull()
      expect(out.newOwner).not.toBe(expired)
      expect(out.oldOwnerRenew).toBeNull()
      expect(out.release).toBe(true)
    })
  })

  // =========================================================================
  describe('H. D-F42 (Valdo 2026-10-04) — `migrate:setes` só a habilitação SE: réplica de outro modelo no fiscal_api = FALHA ALTA', () => {
    afterAll(async () => {
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model <> 'SE'`, [INST])
      await restoreIssuerFromReal(); await restoreCertFromReal()
    })
    it('réplica 55 na cópia (versão anterior do script) → re-sincronia e `--cutover --dry-run` FALHAM ALTO com a instrução de DELETE físico; nada vira; a SE copiada segue só a SE', async () => {
      await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal()
      await w(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
               VALUES (?, '55', 'H', NULL, 0, NOW(), NOW(), 'N', NULL)`, [INST])
      const rs = runScript('migrate:setes', ['--dry-run'], copyEnv())
      const ct = runScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'], copyEnv())
      const rows = (await q(`SELECT model, cutover_at IS NULL AS replica FROM tb_establishment_issuer WHERE tb_institution_id = ? ORDER BY model`, [INST]))
        .map(r => `${r.model}:${Number(r.replica) ? 'replica' : 'virada'}`)
      const out = { resync: [rs.status, /réplica do ERP de modelo 55/.test(rs.out), /DELETE FROM tb_establishment_issuer/.test(rs.out)],
                    cutover: [ct.status, /réplica do ERP de modelo 55/.test(ct.out)], rows }
      // eslint-disable-next-line no-console
      console.log('[adv-r6] D-F42 réplica 55', JSON.stringify(out))
      expect(out.resync).toEqual([1, true, true])
      expect(out.cutover).toEqual([1, true])
      expect(rows).toEqual(['55:replica', 'SE:replica'])                                   // nada virou, nada mudou
      // sem a réplica estranha, a re-sincronia volta a passar e só existe a SE (o ERP do dev só tem SE)
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = '55'`, [INST])
      const ok = runScript('migrate:setes', ['--dry-run'], copyEnv())
      expect(ok.status).toBe(0)
    })

    it('D-F44 — o ATO aposenta a habilitação SE do ERP na MESMA transação (ensaio: `--cutover --dry-run` executa a escrita e a DESFAZ); o ERP real fica intacto', async () => {
      await restoreIssuerFromReal()
      const erpBefore = (await q(`SELECT deleted, serie, dps_last_number AS n FROM \`${SCHEMA}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
      const ct = runScript('migrate:setes', ['--cutover', String(INST), '--confirmo-setes-api-parado', '--dry-run'], copyEnv())
      const erpAfter = (await q(`SELECT deleted, serie, dps_last_number AS n FROM \`${SCHEMA}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
      const out = { status: ct.status, virou: ct.out.match(/"linhasViradas": \d+/)?.[0], aposentou: ct.out.match(/"habilitacaoErpAposentada": \d+/)?.[0], erpBefore, erpAfter }
      // eslint-disable-next-line no-console
      console.log('[adv-r6] D-F44 ensaio do ato', JSON.stringify(out))
      expect(out.status).toBe(0)
      expect([out.virou, out.aposentou]).toEqual(['"linhasViradas": 1', '"habilitacaoErpAposentada": 1'])
      expect(erpBefore.deleted).toBe('N')
      expect(erpAfter).toEqual(erpBefore)                                                 // desfeito: o setes-api segue emitindo
      expect((await issuerOfCopy())?.c).toBeNull()
    })
  })
})

if (!LIVE) it('adversarial r6 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
