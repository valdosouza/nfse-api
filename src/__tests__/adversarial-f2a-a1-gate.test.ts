/// <reference types="jest" />
// GATE ADVERSARIAL — DELTA da etapa A1 da F2a na nfse-api (Rodada 1 da F2a, Valdo 2026-10-12 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md`
// §22; D-F109 `/reconfirm` pelo veredito · D-F107 CHECK binário de `kind` (migration 005) + sonda do boot · D-NE84 CHECK binário de `model`
// (005 do núcleo) · `nfseNotGeneratedAt` no TX_SELECT). Revisor: o gate (não fez a entrega).
//
// Duas partes:
//  - UNIT (sempre): driver SIMULADO por SQL (o `mapTx`, o `invoiceLife` e o veredito do núcleo rodam DE VERDADE), fisco falso;
//  - AO VIVO (só com NFSE_ADV_LIVE=1): bancos DESCARTÁVEIS `fiscal_api_adv_gatea1` e `fiscal_api_adv_gatea1_pre`, criados do ZERO pelo runner
//    (NUNCA cópia do `fiscal_api` real — nada dele é lido), com o usuário do SERVIÇO (.env da nfse-api: ALL só em `fiscal_api_adv%`, SELECT no
//    ERP — a defesa do ERP é por construção); apagados no fim. Do ERP só SELECT (`setes_setes.vw_invoice_life`, para a nota real do
//    ponta-a-ponta). Nunca o fisco (adaptador falso; o caminho atacado recusa antes dele).
//
// Achados (`it.failing`):
//  - [LOW F2A1-02b] `/reconfirm` com a irmã FINAL sem o instante da voz (`created_at` da voz é `DATETIME DEFAULT NULL`): o veredito do núcleo
//    diz `irma-viva` sem tentativa viva (F2A1-02 do gate do núcleo) e `transmissions.find(isLiveTransmission)!` é `undefined` →
//    `liveTransmissionError(undefined)` → TypeError → 500 (crash-ref) em vez de um 409 honesto. Provado no unit E ao vivo (view/TX_SELECT reais).
//  - [MEDIUM F2A1-01 — ao vivo] a vida ANTERIOR registrada mascara a reconferência quando o veredito recebe TODAS as vidas que o leitor novo
//    devolve (gate do núcleo) — reproduzido com a view 004 e o mapa REAIS. A nfse-api em si filtra a vida (resistiu).
//  - [LOW F2A1-06] OpenAPI do `/reconfirm` promete "tentativa VIVA → 409 FISCAL_TRANSMISSION_IN_PROGRESS"; com K vivo o código responde
//    FISCAL_CANCEL_IN_FLIGHT (a mensagem do transmitir — o comentário do código diz isso; a spec publicada não).
// Resistiu / contexto: ver os `it('resistiu: …')` e `it('contexto: …')`.
//
// CONVERSÃO (2026-10-12, mesma sessão — D-F118…D-F123): F2A1-02b/06/07 [CORRIGIDO na sessão] · F2A1-01 ao vivo [CORRIGIDO — D-F119] ·
// F2A1-08 [CORRIGIDO na sessão — a cópia confere a origem] · Q-F131/Q-F130/Q-F132/Q-F133 [DECIDIDO — D-F120/D-F121/D-F122/D-F123].
// Uso: npx jest src/__tests__/adversarial-f2a-a1-gate.test.ts   ·   ao vivo: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f2a-a1-gate.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import * as fiscal from 'fiscal-api'
import {
  HttpError, MasterKeyRing, FsFiscalStorage, FiscalDbConfig, Pool, createFiscalPool, dbConfigFromEnv, runMigrations, assertIssuerModelDomainEnforced,
  assertIssuerEnvironmentDomainEnforced,
  SERVICE_VOICE_READING, readFamilyTransmissions, reconfirmationVerdict, inLife, isLiveTransmission, mapCommonView,
  invoiceRef, WEB_TERMINAL,
} from 'fiscal-api'
import * as repo from '../nfse/repository'
import { reconfirmBeforeLocalCancel, NfseDeps } from '../nfse/transmission'
import { assertServiceVoiceDomainsEnforced, SERVICE_VOICE_FAMILY, SERVICE_VOICE_WRITE_KINDS } from '../nfse/voice-family'
import { MIGRATION_SETS } from '../migrations'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openIssuer: jest.fn(actual.openIssuer),           // passa direto; o unit que fala com o fisco falso troca UMA vez
  }
})

const ROOT = path.resolve(__dirname, '..', '..')
const DPS = 'DPS410690221234567800019500001000000000000042'
const KEY = '4106902221234567800019500000000001232026092100001234'.slice(0, 50)
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-gatea1-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

/** Linha CRUA do TX_SELECT (o `mapTx` real a mapeia). */
const TX = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS,
  accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, createdAt: '2026-10-01 10:00:00', ageMinutes: 30,
  lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q',
  lastDh: null, lastEventAt: '2026-10-01 10:05:00', lastEventAgeMinutes: 25, ...over,
})
/** Driver simulado POR SQL: vida do ERP (`vw_invoice_life`), tentativas (TX_SELECT — 1ª leitura e as seguintes), vozes, carimbos. */
function fakePool(s: { txs: any[]; after?: any[]; record?: number }) {
  let reads = 0
  const query = jest.fn(async (sql: string) => {
    // as escritas ANTES (o carimbo do E2404 tem subconsulta na tabela de vozes)
    if (/SET last_queried_at = NOW\(\)/.test(sql)) return [{ affectedRows: 1 }, []]
    if (/nfse_not_generated_at = NOW\(\)/.test(sql)) return [{ affectedRows: s.record ?? 1 }, []]
    if (/vw_invoice_life/.test(sql)) return [[{ invoiceId: INVOICE, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' }], []]
    if (/FROM tb_invoice_service_transmission t\s+JOIN tb_invoice_service_dps d/.test(sql)) { reads++; return [reads === 1 ? s.txs : (s.after ?? s.txs), []] }
    if (/FROM tb_invoice_service_transmission_event e/.test(sql)) return [[], []]
    throw new Error(`SQL inesperado no driver simulado: ${sql.slice(0, 90)}`)
  })
  return { query, getConnection: jest.fn() } as any
}
const depsOf = (pool: any): NfseDeps => ({ pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' })
const ref = () => invoiceRef(A.institutionId, INVOICE, WEB_TERMINAL)
const opened = () => ({ issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null }, cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: {} })
/** Erro HTTP do contrato (4xx/5xx com código) — nunca um TypeError cru (500 com crash-ref). */
const asHttp = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e: any) { return e instanceof HttpError ? `${e.statusCode} ${e.code}` : `NAO-HTTP ${e?.constructor?.name}: ${e?.message}` } }

beforeEach(() => { jest.clearAllMocks() })

// ===========================================================================
// UNIT
// ===========================================================================
describe('[F2A1-02b] /reconfirm — a barreira `irma-viva` sem tentativa viva', () => {
  // irmã R (FINAL, direta) da MESMA identidade sem o instante da voz + a candidata F por consulta em P com E2404 posterior
  const life = [TX({ attempt: 1, lastKind: 'R', lastSource: 'P', lastEventAt: null, lastEventAgeMinutes: null }), TX({ attempt: 2, nfseNotGeneratedAt: '2026-10-01 11:00:00' })]
  it('[CORRIGIDO na sessão] (era o contexto: o veredito dizia `irma-viva` sem tentativa viva) — pelo `mapTx` real nenhuma está viva e o veredito diz `instante-invalido` (projeção incompleta; `irma-viva` ⇔ `isLiveTransmission`)', () => {
    const mapped = life.map(repo.mapTx)
    expect([mapped.some(t => isLiveTransmission(t)), reconfirmationVerdict(mapped).reason]).toEqual([false, 'instante-invalido'])
  })
  it('[CORRIGIDO na sessão] [LOW F2A1-02b] a reconferência nunca dá TypeError/500: com a projeção incompleta ela segue (pergunta ao fisco, carimba) e responde o veredito DEPOIS (`instante-invalido` — a prova não fecha com essa irmã)', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened())
    adapter.queryDpsAccessKey.mockResolvedValueOnce(null)
    const r = await reconfirmBeforeLocalCancel(depsOf(fakePool({ txs: life })), A, ref())
    expect(r).toMatchObject({ needed: true, found: false, attempt: 2, verdict: 'instante-invalido' })
  })
})

describe('resistiu: /reconfirm — barreira ANTES do fisco (D-F109, nota (1) da F2a)', () => {
  const cases: [string, any[], string][] = [
    ['K vivo (cancelamento em voo) numa vida registrada', [TX({ accessKey: KEY, authorityRecorded: 'S', lastKind: 'K', lastSource: 'P' })], '409 FISCAL_CANCEL_IN_FLIGHT'],
    ['reserva sem voz (em voo) ao lado da F por consulta', [TX({ attempt: 1 }), TX({ attempt: 2, lastKind: null, lastEvent: null, lastSource: null, lastEventAt: null })], '409 FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['voz S (sem produtor — D-F102) gravada por fora', [TX({ attempt: 1 }), TX({ attempt: 2, lastKind: 'S', lastSource: 'P' })], '409 FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['voz P (da NF-e) gravada por fora na NFS-e', [TX({ attempt: 1 }), TX({ attempt: 2, lastKind: 'P', lastSource: 'Q' })], '409 FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['voz \'f\' minúscula (anterior ao CHECK) — viva para o código', [TX({ attempt: 1 }), TX({ attempt: 2, lastKind: 'f' })], '409 FISCAL_TRANSMISSION_IN_PROGRESS'],
    ['tentativa viva em HOMOLOGAÇÃO (outra identidade)', [TX({ attempt: 1, nfseNotGeneratedAt: '2026-10-01 11:00:00' }), TX({ attempt: 2, environment: 'H', lastKind: null, lastEvent: null, lastSource: null, lastEventAt: null })], '409 FISCAL_TRANSMISSION_IN_PROGRESS'],
  ]
  it.each(cases)('%s → %s, sem ir ao fisco e sem carimbar a prova', async (_l, txs, expected) => {
    const pool = fakePool({ txs })
    expect(await asHttp(reconfirmBeforeLocalCancel(depsOf(pool), A, ref()))).toBe(expected)
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()
    expect(pool.query.mock.calls.filter((c: any[]) => /UPDATE/.test(String(c[0])))).toHaveLength(0)
  })
})

describe('resistiu: /reconfirm — o veredito DEPOIS é relido e nunca afirma o que esta chamada não gravou', () => {
  it('nova tentativa VIVA aparece entre a 1ª leitura e o carimbo → 200 com `irma-viva` (honesto: nada de `provada`)', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened())
    adapter.queryDpsAccessKey.mockResolvedValueOnce(null)
    const cand = TX({ attempt: 1 })
    const pool = fakePool({ txs: [cand], after: [{ ...cand, nfseNotGeneratedAt: '2026-10-01 12:00:00' }, TX({ attempt: 2, lastKind: null, lastEvent: null, lastSource: null, lastEventAt: null, createdAt: '2026-10-01 11:59:00' })] })
    expect(await reconfirmBeforeLocalCancel(depsOf(pool), A, ref())).toMatchObject({ needed: true, found: false, attempt: 1, verdict: 'irma-viva' })
  })
  it('a guarda do carimbo recusa (outra voz nasceu na tentativa durante a pergunta) → 409 RESOURCE_BUSY, sem veredito', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened())
    adapter.queryDpsAccessKey.mockResolvedValueOnce(null)
    expect(await asHttp(reconfirmBeforeLocalCancel(depsOf(fakePool({ txs: [TX({ attempt: 1 })], record: 0 })), A, ref()))).toBe('409 RESOURCE_BUSY')
  })
  it('E2404 carimbado mas a irmã R (mesma identidade) foi reapresentada DEPOIS dele → `apresentada-depois`, não `provada`', async () => {
    ;(fiscal.openIssuer as jest.Mock).mockResolvedValueOnce(opened())
    adapter.queryDpsAccessKey.mockResolvedValueOnce(null)
    const after = [TX({ attempt: 1, nfseNotGeneratedAt: '2026-10-01 12:00:00' }), TX({ attempt: 2, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-01 12:00:30', lastEventAt: '2026-10-01 12:00:31' })]
    expect(await reconfirmBeforeLocalCancel(depsOf(fakePool({ txs: [TX({ attempt: 1 })], after })), A, ref())).toMatchObject({ verdict: 'apresentada-depois' })
  })
})

describe('[DECIDIDO — D-F120 (= Q-F131 (a)) + correção de sessão] `environment`/`source`: o banco fecha (CHECK binário da 005) e os dois leitores concordam', () => {
  it('(era: o `mapTx` lia environment \'p\' como H — veredito `nao-exigida` — e o mapa da view LANÇAVA) — o `mapTx` também LANÇA (M4), como o mapa da view', () => {
    const raw = TX({ environment: 'p' })
    expect(() => repo.mapTx(raw)).toThrow(/sem environment/)
    expect(() => mapCommonView({ ...raw, lifeEvent: 1, terminal: 0 })).toThrow(/sem environment/)
  })
  it('voz F com source \'q\': o seletor da candidata (`=== \'Q\'`) segue EXATO — quem fecha é o BANCO (CHECK `source` P/Q da 005; o teste ao vivo prova a recusa)', () => {
    expect(reconfirmationVerdict([repo.mapTx(TX({ lastSource: 'q' }))]).reason).toBe('nao-exigida')
    expect(reconfirmationVerdict([repo.mapTx(TX({ lastSource: 'Q' }))]).reason).toBe('sem-e2404')
  })
})

describe('[F2A1-06] OpenAPI do /reconfirm × código', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'openapi', 'nfse-api.v1.yaml'), 'utf8')
  const block = yaml.slice(yaml.indexOf('/v1/nfse/invoices/{invoiceId}/reconfirm:'), yaml.indexOf('/v1/nfse/invoices/{invoiceId}/cancel:'))
  it('resistiu: o enum `verdict` da OpenAPI é EXATAMENTE o `ReconfirmReason` do núcleo (os 7 motivos)', () => {
    const m = /verdict:\s*\n\s*type: string\s*\n\s*enum: \[([^\]]*)\]/.exec(yaml)
    expect(m).not.toBeNull()
    expect(m![1].split(',').map(s => s.trim()).sort()).toEqual(['apresentada-depois', 'instante-invalido', 'irma-viva', 'nao-exigida', 'provada', 'sem-e2404', 'sem-identidade'])
  })
  it('[CORRIGIDO na sessão] [LOW F2A1-06] a spec publicada lista os DOIS códigos da tentativa viva (FISCAL_TRANSMISSION_IN_PROGRESS e, com K, FISCAL_CANCEL_IN_FLIGHT) — spec e código concordam', async () => {
    const got = await asHttp(reconfirmBeforeLocalCancel(depsOf(fakePool({ txs: [TX({ accessKey: KEY, authorityRecorded: 'S', lastKind: 'K', lastSource: 'P' })] })), A, ref()))
    expect(got).toBe('409 FISCAL_CANCEL_IN_FLIGHT')
    expect(block).toMatch(/FISCAL_TRANSMISSION_IN_PROGRESS/)
    expect(block).toMatch(/FISCAL_CANCEL_IN_FLIGHT/)
  })
})

describe('[F2A1-08] a cópia de vozes do `migrate:setes` × o CHECK da 005 (nota (7) da F2a)', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
  const mig = fs.readFileSync(path.join(ROOT, 'src', 'migrations', 'sql', '005_service_transmission_domains.sql'), 'utf8')
  it('contexto: a cópia de vozes é `INSERT IGNORE … SELECT … JOIN` e a conferência do passo 6 compara só a ÚLTIMA voz de cada tentativa', () => {
    expect(script).toMatch(/INSERT IGNORE INTO tb_invoice_service_transmission_event[\s\S]{0,400}SELECT ev\.tb_institution_id/)
    expect(script).toMatch(/NOT \(v\.last_kind <=> \(\s*SELECT x\.kind FROM/)
    // (era: a 005 afirmava que o INSERT IGNORE "NÃO rebaixa" — corrigido: registra as DUAS formas)
    expect(mig).toMatch(/REBAIXA a violação do CHECK a\s*(--\s*)?AVISO/)
  })
  it('[CORRIGIDO na sessão] [MEDIUM F2A1-08] voz da ORIGEM fora da lista da família não some CALADA na cópia — a nota (7) manda "se rebaixar, a cópia confere a lista antes de inserir"; o MariaDB 10.4 REBAIXA na forma `INSERT IGNORE … SELECT` (provado ao vivo neste gate) e o comentário da 005 afirma o contrário', () => {
    const copyGuarded = !/INSERT IGNORE INTO tb_invoice_service_transmission_event/.test(script) || /SERVICE_VOICE_WRITE_KINDS/.test(script)
    expect(copyGuarded).toBe(true)
    expect(mig).not.toMatch(/NÃO rebaixa a violação do CHECK/)
  })
})

describe('resistiu: UMA fonte da lista do CHECK e a sonda', () => {
  it('a sonda do kind grava valores FORA da lista da família (o S) e a MINÚSCULA de um da lista (o f) — nunca um valor da lista; cada linha com PK própria (F2A1-07)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'nfse', 'voice-family.ts'), 'utf8')
    const probes = [...src.matchAll(/ev\((\d+), '(\w)', 'P', '\w', KIND\)/g)].map(m => [Number(m[1]), m[2]] as const)
    expect(probes).toEqual([[1, 'S'], [2, 'f']])
    expect((SERVICE_VOICE_WRITE_KINDS as readonly string[]).includes(probes[0][1])).toBe(false)
    expect((SERVICE_VOICE_WRITE_KINDS as readonly string[]).includes(probes[1][1])).toBe(false)
    expect((SERVICE_VOICE_WRITE_KINDS as readonly string[]).includes(probes[1][1].toUpperCase())).toBe(true)
  })
})

// ===========================================================================
// AO VIVO (NFSE_ADV_LIVE=1) — bancos descartáveis criados do zero
// ===========================================================================
const LIVE = process.env.NFSE_ADV_LIVE === '1'
const dLive = LIVE ? describe : describe.skip
const NAME = 'fiscal_api_adv_gatea1'
const PRE = 'fiscal_api_adv_gatea1_pre'
const SYN = 990001                                    // institution SINTÉTICA (só existe nas cópias descartáveis)

dLive('AO VIVO — migrations 005, sondas do boot, view 004 e o veredito com linhas gravadas pelo banco', () => {
  jest.setTimeout(240_000)
  let base: FiscalDbConfig
  let pool: Pool                 // NAME, várias conexões
  let one: Pool                  // NAME, UMA conexão (sessão suja apareceria aqui)
  let prePool: Pool
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-gatea1-mig-'))
  const preSets = () => MIGRATION_SETS.map(s => {
    const dir = path.join(tmp, s.project)
    fs.mkdirSync(dir, { recursive: true })
    for (const f of fs.readdirSync(s.dir).filter(f => f.endsWith('.sql') && !f.startsWith('005_'))) fs.copyFileSync(path.join(s.dir, f), path.join(dir, f))
    return { project: s.project, dir }
  })
  const errOf = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e: any) { return `${e?.errno ?? ''} ${e?.message ?? e}` } }
  /** Uma escrita numa transação SEMPRE desfeita (FK desligada só na sessão dela) — devolve 'ok' ou o errno. */
  async function attempt(p: Pool, sql: string, params: unknown[], opts: { noFk?: boolean; session?: string } = {}): Promise<string> {
    const c = await p.getConnection()
    try {
      await c.beginTransaction()
      if (opts.noFk) await c.query('SET SESSION foreign_key_checks = 0')
      if (opts.session) await c.query(opts.session)
      try { await c.query(sql, params); return 'ok' } catch (e: any) { return String(e.errno) }
    } finally {
      try { await c.rollback() } catch { /* */ }
      await c.query('SET SESSION foreign_key_checks = 1')
      if (opts.session) await c.query('SET SESSION check_constraint_checks = 1')
      c.release()
    }
  }
  const kindSql = `INSERT INTO ${SERVICE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, created_at, deleted) VALUES (?, 1, 0, 1, 1, ?, 'P', UTC_TIMESTAMP(), 'N')`
  const modelSql = `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, dps_last_number, deleted) VALUES (?, ?, 'H', 0, 'N')`
  /** Uma nota sintética: DPS da vida + tentativas + vozes gravadas pelo banco (FK ligada). */
  async function seed(p: Pool, inst: number, inv: number, rows: { attempt: number; life: number; env: string; dpsId: string; key?: string | null;
    created?: string | null; voice?: { kind: string; source: string; created: string | null } | null; notGenerated?: string | null }[]) {
    const lives = new Map<number, string>()
    for (const r of rows) lives.set(r.life, r.dpsId)
    for (const [life, dpsId] of lives) {
      await p.query(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, created_at, deleted)
                     VALUES (?, ?, 0, ?, '1', ?, ?, UTC_TIMESTAMP(), 'N')`, [inst, inv, life, inv * 100 + life, dpsId])
    }
    for (const r of rows) {
      await p.query(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, created_at, nfse_not_generated_at, deleted)
                     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'N')`, [inst, inv, r.attempt, r.life, r.env, r.key ?? null, r.created ?? '2026-10-01 10:00:00', r.notGenerated ?? null])
      if (r.voice) {
        await p.query(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, created_at, deleted)
                       VALUES (?, ?, 0, ?, 1, ?, ?, ?, 'N')`, [inst, inv, r.attempt, r.voice.kind, r.voice.source, r.voice.created])
      }
    }
  }
  const DPS_OF = (inv: number, life: number) => `DPS4106902212345678000195${String(inv).padStart(5, '0')}${String(life).padStart(15, '0')}`.slice(0, 45)

  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    base = dbConfigFromEnv()
    if (!base.user) throw new Error('DB_USER vazio no .env da nfse-api')
    if (base.database === NAME || base.database === PRE) throw new Error('o banco do .env não pode ser o descartável')
    // sobra de execução MORTA: o runner cria o banco se faltar; uma conexão nele derruba os DOIS descartáveis e tudo recomeça do zero
    await runMigrations({ ...base, database: NAME }, MIGRATION_SETS)
    const sweep = createFiscalPool({ ...base, database: NAME, connectionLimit: 1 })
    for (const db of [PRE, NAME]) await sweep.query(`DROP DATABASE IF EXISTS \`${db}\``)
    await sweep.end()
    await runMigrations({ ...base, database: NAME }, MIGRATION_SETS)                 // como o boot (núcleo → família)
    await runMigrations({ ...base, database: PRE }, preSets())                        // o mesmo, ATÉ a 004 (estado anterior ao delta)
    pool = createFiscalPool({ ...base, database: NAME, connectionLimit: 4 })
    one = createFiscalPool({ ...base, database: NAME, connectionLimit: 1 })
    prePool = createFiscalPool({ ...base, database: PRE, connectionLimit: 2 })
  })
  afterAll(async () => {
    for (const p of [one, prePool]) { try { await p?.end() } catch { /* */ } }
    if (pool) {
      for (const db of [PRE, NAME]) await pool.query(`DROP DATABASE IF EXISTS \`${db}\``)
      const [left] = await pool.query(`SHOW DATABASES LIKE 'fiscal\\_api\\_adv\\_gatea1%'`)
      await pool.end()
      expect(left).toEqual([])
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('resistiu: com TODAS as migrations as sondas do boot passam; o banco recusa ZZ/se/sE/Se no modelo e S/f/P/D/s/a no kind, e aceita SE/55/65 e A/R/C/K/F/N', async () => {
    await expect(assertIssuerModelDomainEnforced(pool)).resolves.toBeUndefined()
    await expect(assertIssuerEnvironmentDomainEnforced(pool)).resolves.toBeUndefined()
    await expect(assertServiceVoiceDomainsEnforced(pool)).resolves.toBeUndefined()
    const model: Record<string, string> = {}
    for (const m of ['ZZ', 'se', 'sE', 'Se', 'SE', '55', '65']) model[m] = await attempt(pool, modelSql, [SYN, m])
    expect(model).toEqual({ ZZ: '4025', se: '4025', sE: '4025', Se: '4025', SE: 'ok', '55': 'ok', '65': 'ok' })
    const kind: Record<string, string> = {}
    for (const k of ['S', 'f', 'P', 'D', 's', 'a', ...SERVICE_VOICE_WRITE_KINDS]) kind[k] = await attempt(pool, kindSql, [SYN, k], { noFk: true })
    expect(kind).toEqual({ S: '4025', f: '4025', P: '4025', D: '4025', s: '4025', a: '4025', A: 'ok', R: 'ok', C: 'ok', K: 'ok', F: 'ok', N: 'ok' })
  })

  it('resistiu: as sondas não sujam a sessão nem deixam linha — pool de UMA conexão: depois delas `foreign_key_checks` = 1, nenhuma transação aberta, zero linhas', async () => {
    await assertServiceVoiceDomainsEnforced(one)
    await assertIssuerModelDomainEnforced(one)
    await assertIssuerEnvironmentDomainEnforced(one)
    const [s] = await one.query<any[]>(`SELECT @@session.foreign_key_checks AS fk, @@in_transaction AS tx,
      (SELECT COUNT(*) FROM tb_invoice_service_transmission_event) AS ev, (SELECT COUNT(*) FROM tb_establishment_issuer) AS iss,
      (SELECT COUNT(*) FROM tb_invoice_service_transmission) AS txs`)
    expect(s[0]).toEqual({ fk: 1, tx: 0, ev: 0, iss: 0, txs: 0 })
  })

  it('resistiu: banco SEM as 005 (até a 004) — as sondas FALHAM (o boot não sobe): o modelo com o diagnóstico certo (a recusa veio do CHECK _ci da 004, não do binário — F2A1-05)', async () => {
    expect(await errOf(assertIssuerModelDomainEnforced(prePool))).toMatch(/recusada por OUTRO CHECK, não pelo ck_establishment_issuer_model_bin/)
    expect(await errOf(assertIssuerEnvironmentDomainEnforced(prePool))).toMatch(/ACEITOU o ambiente da habilitação fora do domínio \(X, h\)/)
    expect(await errOf(assertServiceVoiceDomainsEnforced(prePool))).not.toBe('ok')
  })

  it('[CORRIGIDO na sessão] [LOW F2A1-07] banco SEM o CHECK do kind (sem a 005, ou motor que ignora CHECK): a sonda diz o DIAGNÓSTICO do domínio ("ACEITOU … S, f") — hoje as duas linhas da sonda têm a MESMA PK (0,0,0,0,1): o \'S\' entra e o \'f\' cai em 1062 "Duplicate entry", que sobe cru (o teste unitário da entrega, com driver simulado, promete "não aplica CHECK")', async () => {
    expect(await errOf(assertServiceVoiceDomainsEnforced(prePool))).toMatch(/ACEITOU o kind da voz da NFS-e fora do domínio \(S, f\)/)
  })

  it('contexto: o motor APLICA CHECK no banco sem a 005 (o da 002 recusa C com código fora da lista) — o que falta é só a migration; a mensagem "o motor não aplica CHECK" (sonda que aceita tudo) mandaria o operador trocar de motor', async () => {
    const c = `INSERT INTO ${SERVICE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, source, deleted) VALUES (?, 1, 0, 1, 1, 'C', 'XXXX', 'P', 'N')`
    expect(await attempt(prePool, c, [SYN], { noFk: true })).toBe('4025')
  })

  it('resistiu: aplicar as 005 sobre linha FORA do domínio binário FALHA alto e não registra a versão (conferência embutida no ALTER) — o boot não sobe calado; limpo o dado, aplica', async () => {
    await prePool.query(modelSql, [SYN, 'se'])                                                   // a 004 (_ci) aceita
    await seed(prePool, SYN, 1, [{ attempt: 1, life: 1, env: 'P', dpsId: DPS_OF(1, 1), voice: { kind: 'f', source: 'Q', created: '2026-10-01 10:05:00' } }])
    const versions = async () => (await prePool.query<any[]>(`SELECT CONCAT(project, '/', version) v FROM _migrations WHERE version = '005' ORDER BY 1`))[0].map(r => r.v)
    expect(await errOf(runMigrations({ ...base, database: PRE }, MIGRATION_SETS))).toMatch(/4025|CONSTRAINT/)
    expect(await versions()).toEqual([])
    await prePool.query(`DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'se'`, [SYN])
    expect(await errOf(runMigrations({ ...base, database: PRE }, MIGRATION_SETS))).toMatch(/4025|CONSTRAINT/)   // o núcleo passa; a família recusa o 'f'
    expect(await versions()).toEqual(['fiscal-api/005'])
    await prePool.query(`UPDATE tb_invoice_service_transmission_event SET kind = 'F' WHERE tb_institution_id = ? AND kind = 'f' COLLATE utf8mb4_bin`, [SYN])
    expect(await errOf(runMigrations({ ...base, database: PRE }, MIGRATION_SETS))).toBe('ok')
    expect(await versions()).toEqual(['fiscal-api/005', 'nfse-api/005'])
    await expect(assertIssuerModelDomainEnforced(prePool)).resolves.toBeUndefined()
    await expect(assertIssuerEnvironmentDomainEnforced(prePool)).resolves.toBeUndefined()
    await expect(assertServiceVoiceDomainsEnforced(prePool)).resolves.toBeUndefined()
  })

  /**
   * A FORMA da cópia de vozes do `migrate:setes` (`scripts/migrate-from-setes-api.ts`, passo 5: `INSERT IGNORE INTO …_event (…) SELECT ev.… FROM
   * <origem>.…_event ev JOIN <origem>.…_transmission t …`) — reproduzida com uma ORIGEM descartável (a origem real é `setes_*`, só leitura).
   * Origem: a tentativa 1 da nota 51 tem as vozes 1 'S' (fora da lista — gravada por fora; a origem não tem CHECK) e 2 'A'.
   */
  async function copyLikeMigrate(c: any): Promise<{ affected: number; warnings: string[]; copied: string[] }> {
    await c.query('CREATE TEMPORARY TABLE src_ev (tb_institution_id INT, tb_invoice_id INT, terminal INT, attempt INT, event INT, kind CHAR(1), source CHAR(1), created_at DATETIME, deleted CHAR(1))')
    await c.query('CREATE TEMPORARY TABLE src_tx (tb_institution_id INT, tb_invoice_id INT, terminal INT, attempt INT, dps_id VARCHAR(45))')
    await c.query(`INSERT INTO src_tx VALUES (?, 51, 0, 1, 'x')`, [SYN])
    await c.query(`INSERT INTO src_ev VALUES (?, 51, 0, 1, 1, 'S', 'P', '2026-10-01 10:00:00', 'N'), (?, 51, 0, 1, 2, 'A', 'P', '2026-10-01 10:00:05', 'N')`, [SYN, SYN])
    const [r] = await c.query(
      `INSERT IGNORE INTO tb_invoice_service_transmission_event
         (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, created_at, deleted)
       SELECT ev.tb_institution_id, ev.tb_invoice_id, ev.terminal, ev.attempt, ev.event, ev.kind, ev.source, ev.created_at, ev.deleted
         FROM src_ev ev
         JOIN src_tx t ON t.tb_institution_id = ev.tb_institution_id AND t.tb_invoice_id = ev.tb_invoice_id AND t.terminal = ev.terminal AND t.attempt = ev.attempt
        WHERE ev.tb_institution_id = ? AND t.dps_id IS NOT NULL`, [SYN])
    const [w] = await c.query('SHOW WARNINGS')
    const [rows] = await c.query(`SELECT CONCAT(event, ':', kind) e FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = 51 ORDER BY event`, [SYN])
    return { affected: Number(r.affectedRows), warnings: (w as any[]).map(x => `${x.Code}`), copied: (rows as any[]).map(x => x.e) }
  }
  async function underCopy<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const c = await pool.getConnection()
    try {
      await c.beginTransaction()
      await seed(c as any, SYN, 51, [{ attempt: 1, life: 1, env: 'P', dpsId: DPS_OF(51, 1) }])
      return await fn(c)
    } finally {
      try { await c.rollback() } catch { /* */ }
      await c.query('DROP TEMPORARY TABLE IF EXISTS src_ev')
      await c.query('DROP TEMPORARY TABLE IF EXISTS src_tx')
      c.release()
    }
  }

  it('resistiu: INSERT IGNORE … VALUES com kind fora do domínio → ERRO 4025 no MariaDB 10.4 (a forma VALUES — a 005 registra as DUAS formas)', async () => {
    const c = await pool.getConnection()
    try {
      await c.query('SET SESSION foreign_key_checks = 0')
      await c.beginTransaction()
      expect((await errOf(c.query(kindSql.replace('INSERT INTO', 'INSERT IGNORE INTO'), [SYN, 'f']))).split(' ')[0]).toBe('4025')
    } finally {
      try { await c.rollback() } catch { /* */ }
      await c.query('SET SESSION foreign_key_checks = 1')
      c.release()
    }
  })

  it('contexto (prova do F2A1-08 — por isso a cópia do `migrate:setes` confere a ORIGEM antes): na FORMA da cópia (INSERT IGNORE … SELECT … JOIN) o MariaDB 10.4.20 REBAIXA a violação do CHECK a AVISO 4025 — a voz \'S\' some CALADA, a \'A\' entra (1 linha, 1 aviso); a última voz da tentativa fica igual nos dois lados (a conferência do passo 6 do script — só a ÚLTIMA voz — não acusa)', async () => {
    const r = await underCopy(copyLikeMigrate)
    expect(r).toEqual({ affected: 1, warnings: ['4025'], copied: ['2:A'] })
    // UMA linha só (a voz fora da lista sozinha) — também aviso, não erro: o rebaixamento é da forma INSERT IGNORE … SELECT
    const single = await underCopy(async c => {
      await copyLikeMigrate(c)
      await c.query(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = 51`, [SYN])
      const [x] = await c.query(`INSERT IGNORE INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, created_at, deleted)
        SELECT ev.tb_institution_id, ev.tb_invoice_id, ev.terminal, ev.attempt, ev.event, ev.kind, ev.source, ev.created_at, ev.deleted FROM src_ev ev WHERE ev.event = 1`)
      const [w] = await c.query('SHOW WARNINGS')
      return { affected: Number(x.affectedRows), warnings: (w as any[]).map(y => `${y.Code}`) }
    })
    expect(single).toEqual({ affected: 0, warnings: ['4025'] })
  })

  it('[DECIDIDO — D-F122 (= Q-F132 (a))] contexto: `SET SESSION check_constraint_checks = 0` (variável de SESSÃO — o usuário do serviço a liga sem privilégio extra) faz o MariaDB aceitar kind \'f\' e modelo \'se\': o CHECK fecha o ENGANO, não a sessão que o desliga; a sonda do boot não enxerga um escritor assim', async () => {
    expect(await attempt(pool, kindSql, [SYN, 'f'], { noFk: true, session: 'SET SESSION check_constraint_checks = 0' })).toBe('ok')
    expect(await attempt(pool, modelSql, [SYN, 'se'], { session: 'SET SESSION check_constraint_checks = 0' })).toBe('ok')
  })

  it('[DECIDIDO — D-F120 (= Q-F131 (a))] (era o contexto: depois das 005 o banco AINDA aceitava environment \'p\' e source \'q\') — a 005 recusa os dois (CHECK binário), na tentativa e na voz', async () => {
    expect(await errOf(seed(pool, SYN, 11, [{ attempt: 1, life: 1, env: 'p', dpsId: DPS_OF(11, 1) }]))).toMatch(/4025.*ck_invoice_service_transmission_environment/)
    expect(await errOf(seed(pool, SYN, 12, [{ attempt: 1, life: 1, env: 'P', dpsId: DPS_OF(12, 1), voice: { kind: 'F', source: 'q', created: '2026-10-01 10:05:00' } }])))
      .toMatch(/4025.*ck_invoice_service_transmission_event_source/)
  })

  it('resistiu: caso POSITIVO pela view 004 REAL (nota (5) da F2a) — E2404 gravado pelo banco depois da F → `provada` pelo leitor da F2a e pelo da nfse-api', async () => {
    await seed(pool, SYN, 21, [{ attempt: 1, life: 1, env: 'P', dpsId: DPS_OF(21, 1), voice: { kind: 'F', source: 'Q', created: '2026-10-01 10:05:00' }, notGenerated: '2026-10-01 11:00:00' }])
    const r = invoiceRef(SYN, 21, 0)
    const view = await readFamilyTransmissions(pool, SERVICE_VOICE_READING, NAME, r, 1)                     // D-F119: pela vida
    expect([view[0].nfseNotGeneratedAt, reconfirmationVerdict(view).reason]).toEqual(['2026-10-01 11:00:00', 'provada'])
    expect(reconfirmationVerdict((await repo.listLifeTransmissions(pool, r, 1)).transmissions).reason).toBe('provada')
  })

  it('[CORRIGIDO — D-F119] [MEDIUM F2A1-01 — ao vivo] view + mapa REAIS: a vida ANTERIOR autorizada em H (cancelada local, nota refaturada) não dispensa a reconferência — o leitor entrega só a vida PEDIDA e o veredito RECUSA a mistura', async () => {
    await seed(pool, SYN, 31, [
      { attempt: 1, life: 3, env: 'H', dpsId: DPS_OF(31, 3), key: '41069022212345678000195000000000012320260921000' + '311', voice: { kind: 'A', source: 'P', created: '2026-09-20 10:00:05' } },
      { attempt: 2, life: 9, env: 'P', dpsId: DPS_OF(31, 9), voice: { kind: 'F', source: 'Q', created: '2026-10-01 10:05:00' } },
    ])
    const r = invoiceRef(SYN, 31, 0)
    const vigente = await readFamilyTransmissions(pool, SERVICE_VOICE_READING, NAME, r, 9)
    expect(reconfirmationVerdict(vigente).reason).toBe('sem-e2404')                                        // pelo leitor da F2a
    expect(reconfirmationVerdict((await repo.listLifeTransmissions(pool, r, 9)).transmissions).reason).toBe('sem-e2404')   // a nfse-api filtra a vida
    const all = [...await readFamilyTransmissions(pool, SERVICE_VOICE_READING, NAME, r, 3), ...vigente]       // a mistura só montada à mão
    let reason: string
    try { reason = reconfirmationVerdict(all).reason } catch { reason = 'recusou' }
    expect(reason).toBe('recusou')
  })

  it('[CORRIGIDO na sessão] [LOW F2A1-02b — ao vivo, ponta a ponta] nota REAL do ERP (só lida) + voz R gravada SEM created_at (coluna DEFAULT NULL): `/reconfirm` nunca dá TypeError/500 — o veredito é `instante-invalido` (não `irma-viva`) e a resposta é do contrato HTTP', async () => {
    const [lives] = await pool.query<any[]>(`SELECT tb_invoice_id AS id, life_event AS life FROM \`setes_setes\`.vw_invoice_life
      WHERE tb_institution_id = 1 AND terminal = 0 AND life_event IS NOT NULL AND invoice_deleted = 'N' ORDER BY tb_invoice_id DESC LIMIT 1`)
    expect(lives).toHaveLength(1)
    const { id, life } = { id: Number(lives[0].id), life: Number(lives[0].life) }
    const dpsId = DPS_OF(id, life)
    await seed(pool, 1, id, [
      { attempt: 1, life, env: 'P', dpsId, voice: { kind: 'R', source: 'P', created: null } },
      { attempt: 2, life, env: 'P', dpsId, created: '2026-10-01 10:10:00', voice: { kind: 'F', source: 'Q', created: '2026-10-01 10:15:00' }, notGenerated: '2026-10-01 11:00:00' },
    ])
    const mapped = (await repo.listLifeTransmissions(pool, invoiceRef(1, id, 0), life)).transmissions
    expect([mapped.some(t => isLiveTransmission(t)), reconfirmationVerdict(mapped).reason]).toEqual([false, 'instante-invalido'])
    const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: NAME }
    const got = await asHttp(reconfirmBeforeLocalCancel(deps, A, invoiceRef(1, id, 0)))
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()                     // a habilitação da cópia não abre: falha HTTP antes do fisco
    expect(got).toMatch(/^\d{3} [A-Z_]+$/)
  })

  it('[DECIDIDO — D-F121 (= Q-F130 (a))] contexto: o leitor não trava e herda o SNAPSHOT da transação de quem chama — leitura consistente ANTES da trava + voz gravada por outra conexão + trava (FOR UPDATE) → o leitor NÃO vê a voz nova; fora da transação vê', async () => {
    const r = invoiceRef(SYN, 41, 0)
    await pool.query(modelSql, [SYN, '55'])                                        // linha a travar (o papel da trava da nota no ERP)
    const c1 = await pool.getConnection()
    try {
      await c1.beginTransaction()
      expect(await readFamilyTransmissions(c1, SERVICE_VOICE_READING, NAME, r, 1)).toEqual([])  // 1ª leitura consistente = snapshot
      await seed(pool, SYN, 41, [{ attempt: 1, life: 1, env: 'P', dpsId: DPS_OF(41, 1), voice: { kind: 'A', source: 'P', created: '2026-10-01 10:05:00' }, key: '4106902221234567800019500000000001232026092100410' }])
      await c1.query(`SELECT * FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = '55' FOR UPDATE`, [SYN])
      expect(await readFamilyTransmissions(c1, SERVICE_VOICE_READING, NAME, r, 1)).toEqual([])  // DEPOIS da trava: ainda o snapshot velho (por isso D-F121)
    } finally {
      try { await c1.rollback() } catch { /* */ }
      c1.release()
    }
    expect((await readFamilyTransmissions(pool, SERVICE_VOICE_READING, NAME, r, 1)).map(t => [t.attempt, t.authorityRecorded])).toEqual([[1, true]])
  })

  it('[DECIDIDO — D-F123 (= Q-F133 (a))] (era o contexto: as 005 NÃO eram re-executáveis) — processo morto entre o ALTER e o registro em `_migrations`: o próximo boot REAPLICA sem erro (`IF [NOT] EXISTS` — só MariaDB; o MySQL 8 da F3 revê a cadeia)', async () => {
    const [rows] = await pool.query<any[]>(`SELECT project, version, name FROM _migrations WHERE version = '005'`)
    expect(rows).toHaveLength(2)
    await pool.query(`DELETE FROM _migrations WHERE version = '005'`)
    expect(await errOf(runMigrations({ ...base, database: NAME }, MIGRATION_SETS))).toBe('ok')
    const [again] = await pool.query<any[]>(`SELECT CONCAT(project, '/', version) v FROM _migrations WHERE version = '005' ORDER BY 1`)
    expect(again.map((r: any) => r.v)).toEqual(['fiscal-api/005', 'nfse-api/005'])
    await expect(assertServiceVoiceDomainsEnforced(pool)).resolves.toBeUndefined()
  })
})

// sanity para o describe.skip não deixar a parte ao vivo "vazia" quando NFSE_ADV_LIVE não está ligado
if (!LIVE) it('gate f2a-a1 ao vivo: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(SERVICE_VOICE_READING.ownColumns.map(c => c[1])).toContain('nfseNotGeneratedAt') })
