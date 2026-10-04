/// <reference types="jest" />
// GATE ADVERSARIAL — DELTA da sessão 2026-10-04 (as 4 falhas do fim do §16.4) — AO VIVO: banco do dev (ERP só LIDO) + FISCO
// FALSO + CÓPIA DESCARTÁVEL `fiscal_api_adv_r7` (harness `live-harness.ts`). ⚠️ Só roda com NFSE_ADV_LIVE=1.
// Alvo do delta:
//  1. `lockIssuerRows` trava as LINHAS da PK (institution × SE/55/65), não mais a FAIXA da institution;
//  2. `openIssuer`: sem linha viva + réplica (inclusive excluída) → 409 FISCAL_CUTOVER_PENDING;
//  3. `leaseCommand` no aluguel do rodízio (deadlock reexecuta 1×; resto 409 RESOURCE_BUSY; renovar sob contenção para a
//     passada — `stoppedEarly` — e o `finally` devolve o aluguel).
// Isolamento (molde do r6):
//  - adaptador FALSO e o transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real); nenhum script
//    filho, nenhum `--vai`;
//  - o ERP é só LIDO (as travas são FOR UPDATE de leitura) — CHECKSUM do ERP antes/depois;
//  - TODA escrita do teste passa por `w()` (recusa alvo `fiscal_api.`/`setes_*.`); institutions SINTÉTICAS (9907xx) existem
//    SÓ na cópia (o ERP não tem linha delas — o predicado da lacuna (b) as vê como "o ERP nunca emitiu");
//  - o `fiscal_api` REAL: CHECKSUM das tabelas-base + `_migrations` + lista de objetos antes/depois;
//    `SHOW DATABASES LIKE 'fiscal%'` termina só com `fiscal_api`.
//  - contenção com `innodb_lock_wait_timeout` CURTO (3 s) num pool PRÓPRIO apontado para a cópia (`ctxShort`) — o servidor
//    não é tocado (variável de SESSÃO); um cenário roda com o padrão do servidor (50 s) para medir o caminho real.
//
// Achados (os `it.failing` reproduzem; cada um tem o `it` de CENÁRIO/registro antes). Retrabalho do delta (sessão
// 2026-10-04): F1, F2 e F3 CORRIGIDOS (viraram `it`); F4 e F6 ACEITOS como limitação (§17 do prompt) — seguem `it.failing`:
//  - [LOW] F1 passada do rodízio DIRETO numa réplica EXCLUÍDA → 409 FISCAL_ISSUER_MISSING ("configure a habilitação"),
//    não FISCAL_CUTOVER_PENDING — o delta 2 corrigiu o `openIssuer`, mas o diagnóstico da passada depois do aluguel nulo
//    (`refreshOpenServiceTransmissions`, getIssuer só `deleted='N'`) ficou com a regra antiga;
//  - [LOW] F2 lacuna (b) (sem linha no fiscal_api, habilitação SE no ERP) pela PEÇA: `openIssuer`/transmitir/passada →
//    FISCAL_ISSUER_MISSING "configure ambiente e série" enquanto o PUT da habilitação recusa com FISCAL_CUTOVER_PENDING
//    (a mesma "mentira" que o comentário do delta 2 diz evitar); pela ROTA o `requireCutover` responde certo;
//  - [LOW] F3 modelo FORA da lista: `lockIssuerRows` (só SE/55/65) × `issuerRowsState`/`emissionStillInErp` (todas as
//    linhas) — com SE VIRADA + uma linha 'XX' RÉPLICA a rota diz "ainda é do ERP" (409) e a peça ESCREVE o A1 e a
//    habilitação (antes do delta a faixa contava a 'XX' e recusava);
//  - [LOW] F4 `FOR UPDATE` em chave AUSENTE (getIssuer + `lockIssuerRows` de quem não tem linha, e os 55/65 ausentes de
//    quem só tem SE) é trava de INTERVALO até a próxima chave existente — cobre institutions VIZINHAS: (i) a criação da
//    vizinha ESPERA enquanto a outra segura (provado: holder sem linha → vizinha de cima; holder só-SE → vizinha de BAIXO);
//    (ii) criações simultâneas em institutions DIFERENTES (um PUT cada) entram em deadlock entre si e, esgotadas as 3
//    reexecuções, 409 RESOURCE_BUSY sem linha gravada (provado: 3/6 na 1ª execução, 14/24 na 2ª). A promessa do comentário
//    ("a faixa ainda segurava o INSERT da institution VIZINHA" — a linha não) só vale para vizinha ACIMA de quem tem linha;
//  - [LOW] F6 renovar sob contenção para a passada (ok), mas a devolução do `finally` esbarra na MESMA trava: o aluguel fica
//    até vencer (≤ 90 s — nunca além do prazo) e a passada seguinte responde `skipped` ("outra passada em curso") sem passada
//    nenhuma rodando; e os comandos do aluguel não respeitam o orçamento da passada (lock wait do servidor: 50 s no tomar).
//  Sem achado (provados): criação concorrente na MESMA institution (2 e 8 PUT → 1 linha virada, nunca 500/1213); a lacuna
//  (b) fica FECHADA sob corrida (11 operações simultâneas, nenhuma linha/DPS/envio); institution populada não segura a
//  vizinha de CIMA (31 ms; EXPLAIN range:PRIMARY); tomar sob contenção → 409 RESOURCE_BUSY (peça e rota); deadlock no tomar
//  reexecuta 1× e a passada roda; 8 rodadas de A1 × habilitação × passada × reserva × cancelamento sem 500/1213/1205 cru,
//  nDPS estritamente crescentes, nenhuma tentativa viva sem A1/habilitação; réplica viva/excluída pela rota e pela peça
//  (exceto F1) → FISCAL_CUTOVER_PENDING.
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r7.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import forge from 'node-forge'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError, createFiscalPool, dbConfigFromEnv, withTransaction } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, FISCAL_COPY_TABLES } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, refreshOpenServiceTransmissions,
  resetMunicipalTermsCache,
} from '../nfse/transmission'
import { countLiveTransmissions } from '../nfse/repository'

// mesma normalização EM MEMÓRIA das rodadas 1–6: o ramo congelado das notas do dev tem cTribMun "0102" (anterior à D-N26b)
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
const ADV_USER = 990007
const CNPJ = '07742094000113'
const COPY = 'fiscal_api_adv_r7'
const REAL = 'fiscal_api'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO
// ---------------------------------------------------------------------------
const nfseXml = (key: string, dpsId: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R7</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
const ambiguous = () => new AuthorityHttpError(503, 'Fisco sem resposta (falso — ambíguo)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const fisco = {
  byKey: new Map<string, string>(),
  calls: { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 },
  /** Portão da consulta: enquanto definido, a 1ª consulta pela chave espera (abre a janela da contenção no aluguel). */
  gate: null as null | { reached: () => void; open: Promise<void> },
}
const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit() { fisco.calls.transmit++; throw ambiguous() },          // a reserva fica EM VOO
  async queryNfse(_ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    const g = fisco.gate
    if (g) { fisco.gate = null; g.reached(); await g.open }
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
function resetFisco(): void { fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0, terms: 0 }; fisco.gate = null }

const tmpRoot = LIVE ? fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r7-')) : ''
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
let app: any
let appNoId: any                       // institutions SINTÉTICAS (só na cópia) — sem a conferência de identidade no setes_central
let appShort: any
let rootPool: ReturnType<typeof createFiscalPool>

const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]
async function w(sql: string, params: any[] = []): Promise<any> {
  if (/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql)) {
    const target = sql.split(/\bSELECT\b/i)[0]
    if (/`?fiscal_api`?\s*\.|`?setes_[a-z0-9_]*`?\s*\./i.test(target)) throw new Error(`ADV r7: escrita fora da cópia recusada: ${sql.slice(0, 90)}`)
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

/** Alguma transação da instância ESPERANDO trava com este comando (INNODB_TRX — o processlist não distingue espera de execução). */
async function lockWaitOn(patterns: RegExp[], ms = 6_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const rows = await rq(`SELECT trx_query AS q FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'`)
    if (rows.some((r: any) => patterns.every(re => re.test(String(r.q ?? ''))))) return true
    await sleep(25)
  }
  return false
}
/**
 * O comando em ESPERA visto pelo PROCESSLIST (sessão 2026-10-04: no MariaDB 10.4 o UPDATE em AUTOCOMMIT que espera uma
 * trava NÃO aparece no INNODB_TRX — provado em banco descartável; o `lockWaitOn` acima serve para transação já aberta).
 */
async function statementWaiting(patterns: RegExp[], ms = 6_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const rows = await rq('SHOW FULL PROCESSLIST')
    if (rows.some((r: any) => patterns.every(re => re.test(String(r.Info ?? ''))))) return true
    await sleep(25)
  }
  return false
}
const outcome = (p: Promise<any>) => p.then(() => 'ok', (e: any) => [e?.statusCode ?? e?.errno ?? 'X', e?.code ?? null])
const httpOut = (r: request.Response) => (r.status < 300 ? r.status : [r.status, r.body?.code ?? null])

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
  const dpsId = await seedDps(inv, life, 990_700_000 + inv)
  const key = (`41069022${CNPJ}97${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50)
  await w(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, ?, 'H', ?, '990001', DATE_SUB(NOW(), INTERVAL ? DAY), NULL, ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
    [INST, inv, life, key, daysAgo, ADV_USER, daysAgo])
  await w(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
           VALUES (?, ?, 0, 1, 1, 'A', NULL, 'autorizada SINTÉTICA (adversarial r7)', DATE_SUB(NOW(), INTERVAL ? DAY), 'P', ?, DATE_SUB(NOW(), INTERVAL ? DAY), NOW(), 'N')`,
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
const issuerRowsOf = async (inst: number) => q(`SELECT model, environment, serie, dps_last_number AS n, deleted, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS c,
                                                       DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS lease
                                                  FROM tb_establishment_issuer WHERE tb_institution_id = ? ORDER BY model`, [inst])
const certOfCopy = async () => (await q(`SELECT deleted, certificate_pem IS NULL AS noPem, fingerprint256 AS fp FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0] ?? null
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
  cert.serialNumber = '07' + Math.floor(Math.random() * 1e8).toString(16)
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
const storeA1 = (pfx: Buffer, c: AppContext = ctx) => outcome(fiscal.storeCertificate({ pool: c.pool, keyring: c.keyring }, INST, pfx, 'senha',
  { expectedCnpj: CNPJ, userId: ADV_USER, schemaName: SCHEMA }))
const upsertDirect = (inst: number, environment: 'H' | 'P' = 'H', serie = '900', c: AppContext = ctx) =>
  outcome(withTransaction(c.pool, 'adv r7 upsert direto', { inst }, conn => fiscal.upsertIssuer(conn, SCHEMA, inst, 'SE', { environment, serie, userId: ADV_USER })))
const putIssuer = (a: any, inst: number, environment: 'H' | 'P' = 'H', serie = '900') =>
  request(a).put('/v1/emitter/issuers/SE').set(bearer(tok({ institutionId: inst }))).send({ environment, serie }).then(httpOut)
const passDirect = (c: AppContext = ctx) => refreshOpenServiceTransmissions(c, ACTOR, { budgetMs: 4000 })
  .then(r => ({ checked: r.checked, stoppedEarly: r.stoppedEarly, skipped: r.skipped, errors: r.errors.map(e => e.code) }), (e: any) => [e?.statusCode ?? e?.errno, e?.code ?? null])

let realBefore: { sums: Record<string, string>; objects: string } = { sums: {}, objects: '' }
let erpBefore: Record<string, string> = {}
let X = 0, Z = 0, Z2 = 0

d('GATE ADVERSARIAL r7 — delta da sessão 2026-10-04 (cópia descartável fiscal_api_adv_r7 + fisco falso)', () => {
  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(ROOT, '..', 'setes-api', '.env')))
    rootPool = createFiscalPool({ ...dbConfigFromEnv(process.env), database: 'information_schema', user: setesEnv.DB_USER, password: setesEnv.DB_PASSWORD ?? '' })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r7: rede bloqueada — nenhum fisco real') }
    expect(await fiscalDbs()).toEqual([REAL])
    realBefore = await realSums()
    erpBefore = await erpSums()
    const cwd = process.cwd(); process.chdir(ROOT)
    try { harness = await disposableFiscalDb(ROOT, COPY, { turned: false }) } finally { process.chdir(cwd) }
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.fiscalDb).toBe(COPY)
    expect((await q('SELECT DATABASE() AS db'))[0].db).toBe(COPY)
    // pool PRÓPRIO para os cenários de contenção: espera de trava CURTA na SESSÃO (o servidor não muda)
    shortPool = createFiscalPool(harness.cfg)
    shortPool.on('connection', (c: any) => c.query('SET SESSION innodb_lock_wait_timeout = 3', () => { /* sessão */ }))
    ctxShort = { ...ctx, pool: shortPool }
    expect((await shortPool.query('SELECT DATABASE() AS db, @@session.innodb_lock_wait_timeout AS t'))[0]).toEqual([{ db: COPY, t: 3 }])
    app = createApp(ctx)
    appNoId = createApp({ ...ctx, checkIdentity: false })
    appShort = createApp(ctxShort)
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

    // notas-alvo: ramo CONTRATADO (a licença não mascara o código que se quer ver nas rotas)
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
      const key = await fiscal.erp.orderInterface(ctx.pool, SCHEMA, INST, id)
      if (!(await fiscal.erp.institutionHasInterface(ctx.pool, SCHEMA, INST, key))) continue
      if (!X) {
        try {
          const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, INST, id)
          await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
          X = id; continue
        } catch { /* cadastro incompleto — serve só de alvo sintético */ }
      }
      if (!Z) { Z = id; continue }
      if (!Z2) Z2 = id
      if (X && Z && Z2) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r7] notas-alvo: transmite', X, '| sintéticas', Z, Z2)
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
      if (harness) { try { await harness.drop() } catch (e) { dropErr = e } }   // apaga a cópia e FALHA se o real/ERP mudou
      if ((await fiscalDbs()).includes(COPY)) await rootPool.query(`DROP DATABASE IF EXISTS \`${COPY}\``)
      dbsAfter = await fiscalDbs()
      realAfter = await realSums()
      erpAfter = await erpSums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r7] fiscal_api REAL antes', JSON.stringify(realBefore), '| depois', JSON.stringify(realAfter),
        '\n[adv-r7] ERP antes', JSON.stringify(erpBefore), '| depois', JSON.stringify(erpAfter), '\n[adv-r7] bancos fiscal% no fim', dbsAfter.join(','))
      await rootPool.end()
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (dropErr) throw dropErr
    if (JSON.stringify(realAfter) !== JSON.stringify(realBefore)) throw new Error('O fiscal_api REAL mudou durante o ataque — conferir')
    if (JSON.stringify(erpAfter) !== JSON.stringify(erpBefore)) throw new Error('O ERP mudou durante o ataque — conferir')
    if (JSON.stringify(dbsAfter) !== JSON.stringify([REAL])) throw new Error(`Sobrou banco fiscal%: ${dbsAfter.join(',')}`)
  })

  // =========================================================================
  describe('A. (a) CRIAÇÃO concorrente da habilitação numa institution SEM linha (sintética, ERP sem SE)', () => {
    it('sem achado: 2 PUT simultâneos (corpos diferentes) → nenhum 500/1213 cru; UMA linha, VIRADA, com o corpo de um deles', async () => {
      const inst = 990710
      const res = await Promise.all([putIssuer(appNoId, inst, 'H', '900'), putIssuer(appNoId, inst, 'P', '901')])
      const rows = await issuerRowsOf(inst)
      // eslint-disable-next-line no-console
      console.log('[adv-r7] A1 2×PUT criação', JSON.stringify(res), JSON.stringify(rows))
      expect(JSON.stringify(res)).not.toMatch(/INTERNAL|\b500\b|1213|1205|ER_LOCK/)
      for (const r of res) expect([200, JSON.stringify([409, 'RESOURCE_BUSY'])]).toContain(typeof r === 'number' ? r : JSON.stringify(r))
      expect(rows).toHaveLength(1)
      expect(rows[0].c).not.toBeNull()
      expect(rows[0].deleted).toBe('N')
      expect([['H', '900'], ['P', '901']]).toContainEqual([rows[0].environment, rows[0].serie])
    })
    const storm: any = { neighbors: [] as any[], neighborRows: [] as number[], ms: [] as number[] }
    it('sem achado (consistência): 8 PUT simultâneos na MESMA institution sem linha + 3 tempestades de 8 institutions VIZINHAS sem linha (uma PUT cada) → nunca 500/1213 cru, nunca 2 linhas', async () => {
      const same = 990720
      storm.same = await Promise.all(Array.from({ length: 8 }, (_, i) => putIssuer(appNoId, same, i % 2 ? 'P' : 'H', String(900 + i))))
      storm.sameRows = await issuerRowsOf(same)
      // blocos ABAIXO de 990710 (fora dos intervalos da seção B); cada institution recebe UM PUT — ninguém disputa a mesma
      for (const baseId of [990620, 990630, 990640]) {
        const ids = Array.from({ length: 8 }, (_, i) => baseId + 1 + i)
        const t0 = Date.now()
        storm.neighbors.push(...await Promise.all(ids.map(n => putIssuer(appNoId, n))))
        storm.ms.push(Date.now() - t0)
        storm.neighborRows.push(...await Promise.all(ids.map(async n => (await issuerRowsOf(n)).length)))
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] A2 tempestade de criação', JSON.stringify(storm))
      const flat = JSON.stringify([storm.same, storm.neighbors])
      expect(flat).not.toMatch(/INTERNAL|\b500\b|1213|1205|ER_LOCK/)
      expect(storm.sameRows).toHaveLength(1)
      expect(storm.sameRows[0].c).not.toBeNull()
      for (const r of [...storm.same, ...storm.neighbors]) expect([200, JSON.stringify([409, 'RESOURCE_BUSY'])]).toContain(typeof r === 'number' ? r : JSON.stringify(r))
      for (const n of storm.neighborRows) expect(n).toBeLessThanOrEqual(1)
      storm.neighbors.forEach((r: any, i: number) => expect(storm.neighborRows[i]).toBe(r === 200 ? 1 : 0))   // 409 = nada gravado
    })
    // LIMITAÇÃO ACEITA (§17 do prompt): trava de INTERVALO de chave ausente alcança a vizinha na CRIAÇÃO (a faixa fazia o mesmo);
    // criação concorrente de habilitação é ato de implantação — deadlock reexecutado, esgotado = 409 sem gravar nada
    it.failing('[LOW F4 — aceito] …e a criação em institutions DIFERENTES (vizinhas sem linha, cada uma com UM PUT) nunca devolve RESOURCE_BUSY — só a corrida na MESMA institution poderia', () => {
      // a peça reexecuta deadlock até 3×; 409 numa institution que ninguém mais escreveu = vizinha segurada pela trava de INTERVALO
      // (getIssuer FOR UPDATE + lockIssuerRows em chave AUSENTE = gap lock no intervalo até a próxima chave existente)
      const busy = storm.neighbors.filter((r: any) => r !== 200)
      // eslint-disable-next-line no-console
      console.log('[adv-r7] A3 vizinhas — não-200:', busy.length, 'de', storm.neighbors.length)
      expect(busy).toEqual([])
    })
  })

  // =========================================================================
  describe('B. (d) a institution VIZINHA não é mais segurada por `lockIssuerRows`', () => {
    it('sem achado (caso populado): a institution 1 (com linha SE) segurando `lockIssuerRows` NÃO segura a criação de uma vizinha nem o aluguel/PUT de outra já criada', async () => {
      await restoreIssuerFromReal(); await turnCopy()
      const explain = await rq(`EXPLAIN SELECT cutover_at FROM \`${COPY}\`.tb_establishment_issuer WHERE tb_institution_id = 1 AND model IN ('SE','55','65')`)
      const conn = await ctx.pool.getConnection()
      const out: any = { explain: explain.map((r: any) => `${r.type}:${r.key}`) }
      try {
        await conn.beginTransaction()
        out.held = await fiscal.lockIssuerRows(conn, INST)
        const t0 = Date.now()
        out.create = await Promise.race([putIssuer(appNoId, 990741), sleep(8_000).then(() => 'PRESO 8 s')])
        out.lease = await Promise.race([fiscal.acquireRefreshLease(ctx.pool, 990710, 'SE', 90).then(t => (t ? 'alugou' : 'nulo')), sleep(8_000).then(() => 'PRESO 8 s')])
        out.update = await Promise.race([putIssuer(appNoId, 990720, 'H', '950'), sleep(8_000).then(() => 'PRESO 8 s')])
        out.ms = Date.now() - t0
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] B1 vizinha × institution populada', JSON.stringify(out))
      expect(out.held).toEqual({ rows: 1, replicas: 0 })
      expect(out.explain.every((k: string) => /PRIMARY/.test(k) && !/^ALL/.test(k))).toBe(true)
      expect(out).toMatchObject({ create: 200, lease: 'alugou', update: 200 })
      expect(out.ms).toBeLessThan(5_000)
    })

    const gap: any = {}
    it('cenário: institution SEM linha (990751) segurando `lockIssuerRows` × criação da VIZINHA sem linha (990752); institution COM linha só SE (990762) segurando × criação da vizinha de BAIXO sem linha (990761)', async () => {
      expect((await putIssuer(appNoId, 990762)) ).toBe(200)                          // 990762 populada (só SE)
      for (const [holder, victim] of [[990751, 990752], [990762, 990761]] as const) {
        const conn = await ctx.pool.getConnection()
        const r: any = {}
        try {
          await conn.beginTransaction()
          r.held = await fiscal.lockIssuerRows(conn, holder)
          const t0 = Date.now()
          const p = putIssuer(appNoId, victim)
          // a vizinha terminou ENQUANTO a trava estava segura? (corrida de 2 s — independe de como o servidor expõe a espera)
          r.whileHeld = await Promise.race([p, sleep(2_000).then(() => 'PRESA')])
          r.waited = r.whileHeld === 'PRESA'
          r.trx = (await rq(`SELECT trx_state AS s, LEFT(REPLACE(trx_query, '\n', ' '), 60) AS q FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'`))
          r.lockWaitSeen = await lockWaitOn([/tb_establishment_issuer/i], 500)
          await conn.rollback()
          r.result = await p
          r.ms = Date.now() - t0
        } finally {
          try { await conn.rollback() } catch { /* já encerrada */ }
          conn.release()
        }
        r.rows = (await issuerRowsOf(victim)).length
        gap[`${holder}->${victim}`] = r
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] B2 trava de intervalo × vizinha', JSON.stringify(gap))
      for (const r of Object.values(gap) as any[]) { expect(r.result).toBe(200); expect(r.rows).toBe(1) }
    })
    // LIMITAÇÃO ACEITA (§17 do prompt): trava de INTERVALO de chave ausente alcança a vizinha na CRIAÇÃO (a faixa fazia o mesmo);
    // criação concorrente de habilitação é ato de implantação — deadlock reexecutado, esgotado = 409 sem gravar nada
    it.failing('[LOW F4 — aceito] …e a vizinha NÃO espera — a promessa "a vizinha não é mais segurada" (comentário de `lockIssuerRows`) vale também para institution sem linha', () => {
      for (const r of Object.values(gap) as any[]) expect(r.waited).toBe(false)
    })
  })

  // =========================================================================
  describe('C. (b) lacuna (b) sob CORRIDA — institution 1 SEM linha no fiscal_api e COM habilitação SE no ERP', () => {
    afterAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('sem achado: 4 PUT da habilitação (rota) + 2 upsert direto + PUT do A1 (rota e peça) + transmitir (rota e peça) + passada simultâneos → a cerca fica FECHADA: nenhuma linha, A1 intacto, nenhum DPS', async () => {
      await purge([X, Z, Z2]); await restoreCertFromReal()
      await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST])
      expect(await fiscal.erp.erpServiceIssuerExists(ctx.pool, SCHEMA, INST)).toBe(true)
      const fp0 = (await certOfCopy())?.fp
      const dps0 = Number((await q(`SELECT COUNT(*) AS n FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST]))[0].n)   // as 3 vidas copiadas do real
      const { pfx } = pfxFor(`ADV R7 TESTE:${CNPJ}`)
      const pfxBase64 = pfx.toString('base64')
      const res = await Promise.all([
        putIssuer(app, INST), putIssuer(app, INST, 'P', '901'), putIssuer(app, INST, 'H', '902'), putIssuer(app, INST, 'P', '903'),
        upsertDirect(INST), upsertDirect(INST, 'P', '904'),
        request(app).put('/v1/emitter/certificate').set(bearer(tok())).send({ pfxBase64, password: 'senha' }).then(httpOut),
        storeA1(pfx),
        request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(httpOut),
        outcome(transmitServiceInvoice(ctx, ACTOR, X)),
        passDirect(),
      ])
      const rows = await issuerRowsOf(INST)
      const dps = await q(`SELECT COUNT(*) AS n FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])
      const fp1 = (await certOfCopy())?.fp
      // eslint-disable-next-line no-console
      console.log('[adv-r7] C lacuna (b) sob corrida', JSON.stringify(res), '| linhas', rows.length, '| DPS', dps[0].n, '| envios', fisco.calls.transmit)
      expect(JSON.stringify(res)).not.toMatch(/INTERNAL|\b500\b|1213|1205|ER_LOCK/)
      for (const r of res.slice(0, 9)) expect(r).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
      for (const r of res.slice(9)) expect(JSON.stringify(r)).toMatch(/409,"FISCAL_(CUTOVER_PENDING|ISSUER_MISSING)"/)
      expect(rows).toHaveLength(0)
      expect(fp1).toBe(fp0)
      expect(Number(dps[0].n)).toBe(dps0)                                                   // nenhum nDPS cunhado
      expect(fisco.calls.transmit).toBe(0)
    })
  })

  // =========================================================================
  const matrix: Record<string, any> = {}
  describe('D. `openIssuer` (delta 2): réplica viva × réplica EXCLUÍDA × virada excluída × sem linha — rota e peça', () => {
    afterAll(async () => { await purge([X, Z]); await restoreIssuerFromReal(); await restoreCertFromReal() })
    const states: Record<string, () => Promise<void>> = {
      'replica-viva':      async () => { await restoreIssuerFromReal() },
      'replica-excluida':  async () => { await restoreIssuerFromReal(); await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ?`, [INST]) },
      'virada-excluida':   async () => { await restoreIssuerFromReal(); await turnCopy(); await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ?`, [INST]) },
      'lacuna-b':          async () => { await w(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]) },
    }
    it('registro da matriz (cada estado: rota transmit/refresh/cancel/passada + peça openIssuer/transmitir/consultar/cancelar/passada) — nada chega ao fisco', async () => {
      for (const [name, setup] of Object.entries(states)) {
        await purge([X, Z]); await restoreCertFromReal(); await setup()
        await seedAuthorized(Z, 5)
        resetFisco()
        const m: any = {}
        m.routeTransmit = httpOut(await request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())))
        m.routeRefresh = httpOut(await request(app).post(`/v1/nfse/invoices/${Z}/refresh`).set(bearer(tok())))
        m.routeCancel = httpOut(await request(app).post(`/v1/nfse/invoices/${Z}/cancel`).set(bearer(tok())).send({ reason: 'adversarial r7 matriz' }))
        m.routePass = httpOut(await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({}))
        // a peça com o schema (contrato desde o retrabalho do delta: com ele, o predicado COMPLETO — inclusive a lacuna (b))
        m.openIssuer = await outcome(fiscal.openIssuer({ pool: ctx.pool, keyring: ctx.keyring }, INST, 'SE', { schemaName: SCHEMA }))
        m.transmit = await outcome(transmitServiceInvoice(ctx, ACTOR, X))
        m.refresh = await outcome(refreshServiceTransmission(ctx, ACTOR, Z))
        m.cancel = await outcome(cancelServiceInvoiceAtAuthority(ctx, ACTOR, Z, 'adversarial r7 matriz'))
        m.pass = await passDirect()
        m.kindsZ = (await q(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt, event`, [INST, Z])).map(r => r.kind).join('')
        m.fisco = { ...fisco.calls }
        matrix[name] = m
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] D matriz', JSON.stringify(matrix, null, 1))
      const CP = [409, 'FISCAL_CUTOVER_PENDING'], IM = [409, 'FISCAL_ISSUER_MISSING']
      // a ROTA: toda réplica e a lacuna (b) param na cerca; a virada excluída é "configure a habilitação"
      for (const s of ['replica-viva', 'replica-excluida', 'lacuna-b']) {
        expect([matrix[s].routeTransmit, matrix[s].routeRefresh, matrix[s].routeCancel, matrix[s].routePass]).toEqual([CP, CP, CP, CP])
      }
      expect([matrix['virada-excluida'].routeTransmit, matrix['virada-excluida'].routeRefresh, matrix['virada-excluida'].routeCancel]).toEqual([IM, IM, IM])
      // a PEÇA (delta 2): réplica viva E excluída → CUTOVER_PENDING no openIssuer e em quem o chama
      for (const s of ['replica-viva', 'replica-excluida']) {
        expect([matrix[s].openIssuer, matrix[s].transmit, matrix[s].refresh, matrix[s].cancel]).toEqual([CP, CP, CP, CP])
      }
      expect([matrix['virada-excluida'].openIssuer, matrix['virada-excluida'].transmit, matrix['virada-excluida'].refresh]).toEqual([IM, IM, IM])
      // ninguém falou com o fisco; réplica/lacuna nunca ganham voz nossa (K/N) na tentativa copiada
      for (const s of Object.keys(states)) expect(matrix[s].fisco).toMatchObject({ transmit: 0, query: 0, event: 0 })
      for (const s of ['replica-viva', 'replica-excluida', 'lacuna-b']) expect(matrix[s].kindsZ).toBe('A')
    })
    it('[LOW F1 — corrigido] passada do rodízio DIRETO na réplica EXCLUÍDA → 409 FISCAL_CUTOVER_PENDING (sem aluguel, a passada confere o predicado COMPLETO antes de dizer "sem habilitação")', () => {
      expect(matrix['replica-excluida'].pass).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
    })
    it('[LOW F2 — corrigido] lacuna (b) pela PEÇA: openIssuer (com o schema)/transmitir/consultar/passada → FISCAL_CUTOVER_PENDING, como o PUT da habilitação', () => {
      const CP = [409, 'FISCAL_CUTOVER_PENDING']
      const m = matrix['lacuna-b']
      expect([m.openIssuer, m.transmit, m.refresh, m.pass]).toEqual([CP, CP, CP, CP])
    })
  })

  // =========================================================================
  describe('E. `leaseCommand` ao vivo — contenção no tomar / renovar / devolver o aluguel', () => {
    beforeAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal(); await restoreCertFromReal(); await turnCopy() })
    afterAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal() })

    it('sem achado: TOMAR com a linha do emissor travada (espera curta 3 s) → 409 RESOURCE_BUSY pela peça e pela rota; nenhum aluguel gravado; nada consultado', async () => {
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      const conn = await ctx.pool.getConnection()
      const out: any = {}
      try {
        await conn.beginTransaction()
        await fiscal.getIssuer(conn, INST, 'SE', true)
        let t0 = Date.now()
        out.direct = await passDirect(ctxShort); out.directMs = Date.now() - t0
        t0 = Date.now()
        out.route = httpOut(await request(appShort).post('/v1/nfse/refresh').set(bearer(tok())).send({})); out.routeMs = Date.now() - t0
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      out.lease = (await issuerRowsOf(INST))[0].lease
      // eslint-disable-next-line no-console
      console.log('[adv-r7] E1 tomar sob contenção', JSON.stringify(out), '| consultas', fisco.calls.query)
      expect(out.direct).toEqual([409, 'RESOURCE_BUSY'])
      expect(out.route).toEqual([409, 'RESOURCE_BUSY'])
      expect(out.lease).toBeNull()
      expect(fisco.calls.query).toBe(0)
    })

    it('sem achado: DEADLOCK no tomar (vítima = o UPDATE do aluguel; a outra ponta promove a trava por uma FAIXA estranha ao núcleo e solta) → reexecuta 1× e a passada RODA', async () => {
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      const conn = await ctx.pool.getConnection()
      const out: any = {}
      try {
        await conn.beginTransaction()
        await fiscal.getIssuer(conn, INST, 'SE', true)                                       // trava de REGISTRO
        const pPass = passDirect(ctxShort)
        out.queued = await statementWaiting([/SET refresh_lease_until/i])
        // faixa = next-key na mesma linha com o aluguel na fila → ciclo (o cenário do 1213 de antes do delta)
        out.range = await outcome(conn.query(`SELECT cutover_at FROM tb_establishment_issuer WHERE tb_institution_id = ? FOR UPDATE`, [INST]))
        if (out.range === 'ok') await conn.commit()
        out.pass = await pPass
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] E2 deadlock no tomar', JSON.stringify(out))
      expect(out.queued).toBe(true)
      expect(JSON.stringify(out.pass)).not.toMatch(/1213|1205|ER_LOCK|INTERNAL/)
      if (out.range === 'ok') expect(out.pass).toMatchObject({ skipped: false })            // o aluguel era a vítima: reexecutou
    })

    const ren: any = {}
    it('registro: RENOVAR com a linha travada no meio da passada (espera curta 3 s) → para aqui com o que já consultou; o DEVOLVER também esbarra', async () => {
      await purge([Z, Z2]); await seedAuthorized(Z, 5); await seedAuthorized(Z2, 6)
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      let reached!: () => void, release!: () => void
      const reachedP = new Promise<void>(r => { reached = r })
      fisco.gate = { reached: () => reached(), open: new Promise<void>(r => { release = r }) }
      const pPass = passDirect(ctxShort)
      await reachedP                                                                      // a 1ª candidata está "no fisco"
      const conn = await ctx.pool.getConnection()
      try {
        await conn.beginTransaction()
        await fiscal.getIssuer(conn, INST, 'SE', true)                                       // PUT da habilitação/A1 em curso
        ren.leaseWhileHeld = (await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS t FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0].t
        const t0 = Date.now()
        release()
        ren.pass = await pPass
        ren.ms = Date.now() - t0
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      const after = (await q(`SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS t, TIMESTAMPDIFF(SECOND, NOW(), refresh_lease_until) AS left_s
                                FROM tb_establishment_issuer WHERE tb_institution_id = ?`, [INST]))[0]
      ren.leaseAfter = after.t; ren.leftS = after.left_s == null ? null : Number(after.left_s)
      ren.second = await passDirect(ctxShort)                                                // aluguel ainda vigente → outra passada = skipped
      ren.queries = fisco.calls.query
      // eslint-disable-next-line no-console
      console.log('[adv-r7] E3 renovar sob contenção', JSON.stringify(ren))
      expect(ren.pass).toEqual({ checked: 1, stoppedEarly: true, skipped: false, errors: [] })
      expect(ren.queries).toBe(1)
    })
    it('sem achado: …e o aluguel NUNCA fica além do prazo — o que sobrou (devolução esbarrou) vence em ≤ 90 s, e só ele segura a próxima passada', () => {
      if (ren.leaseAfter === null) { expect(ren.second).toMatchObject({ skipped: false }); return }   // a devolução conseguiu
      expect(ren.leaseAfter).toBe(ren.leaseWhileHeld)                                                 // não foi renovado depois de parar
      expect(ren.leftS).toBeLessThanOrEqual(90)
      expect(ren.second).toMatchObject({ skipped: true })
    })
    // LIMITAÇÃO ACEITA (§17 do prompt): parada por contenção na linha do emissor = a devolução esbarra na MESMA trava (agora
    // por no máximo a espera curta da D-F41, não 50 s); o aluguel vence sozinho em ≤ 90 s (PADROES §11.7) — fica fixado aqui
    it.failing('[LOW F6 — aceito] …mas a promessa "o `finally` devolve o aluguel" não vale quando a parada foi por contenção: a devolução esbarra na MESMA trava, o aluguel fica até vencer e a passada seguinte responde `skipped` ("outra passada em curso") sem passada nenhuma rodando', () => {
      expect(ren.leaseAfter).toBeNull()
      expect(ren.second).toMatchObject({ skipped: false })
    })

    it('[D-F41] com a config REAL do servidor (lock wait 50 s), a passada pela ROTA atrás de uma escrita longa na linha do emissor desiste na ESPERA CURTA do comando do aluguel e devolve 409 RESOURCE_BUSY', async () => {
      await w(`UPDATE tb_establishment_issuer SET refresh_lease_until = NULL WHERE tb_institution_id = ?`, [INST])
      const lw = Number((await q(`SELECT @@session.innodb_lock_wait_timeout AS t`))[0].t)
      const conn = await ctx.pool.getConnection()
      const out: any = { lockWait: lw }
      try {
        await conn.beginTransaction()
        await fiscal.getIssuer(conn, INST, 'SE', true)
        const t0 = Date.now()
        out.route = httpOut(await request(app).post('/v1/nfse/refresh').set(bearer(tok())).send({}))
        out.ms = Date.now() - t0
      } finally {
        try { await conn.rollback() } catch { /* já encerrada */ }
        conn.release()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] E4 passada × escrita longa (lock wait do servidor)', JSON.stringify(out))
      expect(out.route).toEqual([409, 'RESOURCE_BUSY'])
      expect(out.lockWait).toBeGreaterThan(10)                                   // o servidor segue com o padrão longo…
      expect(out.ms).toBeLessThan(10_000)                                        // …e o comando do aluguel não espera por ele (≈ 3 s)
      // nenhuma conexão volta ao pool com a espera curta: amostra várias conexões ociosas ao mesmo tempo
      const conns = await Promise.all(Array.from({ length: 5 }, () => ctx.pool.getConnection()))
      try {
        for (const c of conns) expect(Number(((await c.query('SELECT @@session.innodb_lock_wait_timeout AS t')) as any)[0][0].t)).toBe(lw)
      } finally { conns.forEach(c => c.release()) }
    }, 120_000)
  })

  // =========================================================================
  describe('F. (c) PUT/DELETE do A1 × PUT/DELETE da habilitação × passada × reserva × cancelamento — N rodadas', () => {
    beforeAll(async () => { await purge([X, Z, Z2]) })
    afterAll(async () => { await purge([X, Z, Z2]); await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('sem achado: 8 rodadas (partida embaralhada) — nenhum 500/1213/1205 cru; nDPS cunhados ESTRITAMENTE crescentes (nunca repete) e ≤ contador; nenhuma tentativa VIVA sem A1 ou sem habilitação', async () => {
      const rounds: any[] = []
      const viol: string[] = []
      const minted: number[] = []
      const { pfx } = pfxFor(`ADV R7 TESTE:${CNPJ}`)
      const pfxBase64 = pfx.toString('base64')
      await restoreIssuerFromReal(); await turnCopy()
      // atraso de PARTIDA por operação, determinístico por rodada (a ordem de chegada muda de rodada para rodada)
      let seed = 7
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
      for (let i = 0; i < 8; i++) {
        await purge([X, Z])
        // o CONTADOR atravessa as rodadas (nada de restaurar a linha): revive/ambiente/série/aluguel voltam ao ponto de partida
        await w(`UPDATE tb_establishment_issuer SET deleted = 'N', environment = 'H', serie = '900', refresh_lease_until = NULL
                  WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
        await restoreCertFromReal()
        await seedAuthorized(Z, 5)
        const ops: (() => Promise<any>)[] = [
          () => outcome(transmitServiceInvoice(ctx, ACTOR, X)),
          () => request(app).put('/v1/emitter/certificate').set(bearer(tok())).send({ pfxBase64, password: 'senha' }).then(httpOut),
          () => request(app).delete('/v1/emitter/certificate').set(bearer(tok())).then(httpOut),
          () => putIssuer(app, INST, 'H', String(900 + i)),
          () => request(app).delete('/v1/emitter/issuers/SE').set(bearer(tok())).then(httpOut),
          () => passDirect(),
          () => outcome(cancelServiceInvoiceAtAuthority(ctx, ACTOR, Z, `adversarial r7 rodada ${i}`)),
        ]
        const delays = ops.map(() => Math.floor(rnd() * 120))
        const res = await Promise.all(ops.map((op, k) => sleep(delays[k]).then(op)))
        const live = await countLiveTransmissions(ctx.pool, INST)
        const cert = await certOfCopy()
        const iss = (await issuerRowsOf(INST))[0]
        if (live > 0 && cert?.deleted === 'S') viol.push(`rodada ${i}: ${live} viva(s) sem A1`)
        if (live > 0 && iss?.deleted === 'S') viol.push(`rodada ${i}: ${live} viva(s) sem habilitação`)
        const dpsX = (await q(`SELECT dps_number AS n FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, X])).map(r => Number(r.n))
        if (dpsX.length > 1) viol.push(`rodada ${i}: ${dpsX.length} DPS para a MESMA vida`)
        if (dpsX.length && iss && dpsX[0] > Number(iss.n)) viol.push(`rodada ${i}: nDPS ${dpsX[0]} > contador ${iss.n}`)
        minted.push(...dpsX)
        rounds.push({ delays, res, live, cert: cert?.deleted, issuer: iss?.deleted, nDps: dpsX[0] ?? null, ctr: iss ? Number(iss.n) : null })
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] F concorrência mista', JSON.stringify(rounds), '| violações', JSON.stringify(viol), '| nDPS', JSON.stringify(minted),
        '| envios', fisco.calls.transmit, '| pedidos de cancelamento', fisco.calls.event)
      const flat = JSON.stringify(rounds)
      expect(flat).not.toMatch(/INTERNAL|\b500\b|1213|1205|ER_LOCK/)
      expect(viol).toEqual([])
      for (let k = 1; k < minted.length; k++) expect(minted[k]).toBeGreaterThan(minted[k - 1])
    })
  })

  // =========================================================================
  // D-F45 (Valdo 2026-10-04 — Q-F56 (a)): o domínio do modelo virou FATO DO BANCO (CHECK da migration 004 do núcleo). O
  // ataque original desta seção (F3 — 'XX' fora da trava e da contagem da cerca) deixou de ter estado possível: o banco o
  // recusa na entrada. A seção passa a provar a RECUSA e que trava × contagem enxergam o mesmo conjunto.
  describe('G. modelo FORA da lista — D-F45: o BANCO recusa (CHECK da migration 004 do núcleo)', () => {
    afterAll(async () => { await restoreIssuerFromReal(); await restoreCertFromReal() })
    it('[LOW F3 — fechado pela D-F45] INSERT de modelo fora do domínio (réplica ou virada) e UPDATE da SE para fora dele são RECUSADOS pelo banco; nada muda', async () => {
      await restoreIssuerFromReal()
      const before = (await issuerRowsOf(INST)).map((r: any) => `${r.model}:${r.c ? 'virada' : 'replica'}:${r.deleted}`)
      const out: any = {}
      for (const [name, cut] of [['replica', 'NULL'], ['virada', 'NOW()']] as const) {
        out[name] = await outcome(w(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, created_at, updated_at, deleted, cutover_at)
                                     VALUES (?, 'XX', 'H', NULL, 0, NOW(), NOW(), 'N', ${cut})`, [INST]))
      }
      out.update = await outcome(w(`UPDATE tb_establishment_issuer SET model = 'XX' WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))
      const after = (await issuerRowsOf(INST)).map((r: any) => `${r.model}:${r.c ? 'virada' : 'replica'}:${r.deleted}`)
      // eslint-disable-next-line no-console
      console.log('[adv-r7] G domínio do modelo (D-F45)', JSON.stringify({ ...out, before, after }))
      for (const k of ['replica', 'virada', 'update']) expect([4025, 3819]).toContain(out[k][0])     // ER_CONSTRAINT_FAILED / ER_CHECK_CONSTRAINT_VIOLATED
      expect(after).toEqual(before)
    })
    it('o boot do núcleo PROVA que o motor aplica o CHECK (`assertIssuerModelDomainEnforced`) e não deixa resíduo', async () => {
      await expect(fiscal.assertIssuerModelDomainEnforced(ctx.pool)).resolves.toBeUndefined()
      expect(await q(`SELECT 1 FROM tb_establishment_issuer WHERE tb_institution_id = 0`)).toEqual([])
    })
    it('trava × contagem da cerca enxergam o MESMO conjunto (o domínio é fato do banco) — réplica viva, excluída e virada', async () => {
      const seen: any[] = []
      for (const setup of [
        async () => { await restoreIssuerFromReal() },
        async () => { await restoreIssuerFromReal(); await w(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ?`, [INST]) },
        async () => { await restoreIssuerFromReal(); await turnCopy() },
      ]) {
        await setup()
        const rowsState = await fiscal.issuerRowsState(ctx.pool, INST)
        const conn = await ctx.pool.getConnection()
        let lockRows: any
        try { await conn.beginTransaction(); lockRows = await fiscal.lockIssuerRows(conn, INST) } finally { await conn.rollback(); conn.release() }
        seen.push({ rowsState, lockRows })
        expect(rowsState).toEqual(lockRows)
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r7] G trava × contagem', JSON.stringify(seen))
    })
  })
})

if (!LIVE) it('adversarial r7 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
