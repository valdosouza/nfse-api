/// <reference types="jest" />
// GATE ADVERSARIAL r9 — delta D-F47 (passada fecha as vivas do ramo cortado) + D-F48 (re-sincronia por institution),
// commit 478f781 (testar-adversarial.md §4-6, 2026-10-04). Revisor independente — não fez a entrega.
// Achado CONFIRMADO = `it.failing('[r9-…]')` (PASSA enquanto o bug existe; quando a correção entrar, vira `it`), com um
// `it` de CENÁRIO ao lado (se o cenário não se monta, falha de verdade). Ataque que o código RESISTIU = `it` normal.
// Só unitário (mocks na fronteira) — nenhum banco, nenhum fisco.
//
// Oráculo do SQL: `whereOracle` traduz o WHERE PRINCIPAL (profundidade 0) do SQL REAL para JS, consumindo os parâmetros na
// ordem textual dos `?` — prova ao mesmo tempo a PRECEDÊNCIA AND/OR e o ALINHAMENTO placeholder × parâmetro. Qualquer
// trecho do WHERE que o oráculo não reconheça faz o teste falhar (cobertura total, sem "passa por não entender").
//
// Achados deste arquivo:
//  - [MEDIUM — r9-inflight-never-closes — CORRIGIDO 2026-10-04 pela D-F51] a passada NÃO fecha a tentativa EM VOO cujo DPS o fisco não conhece (o envio
//    interrompido que nunca chegou): `refreshServiceTransmission` só grava `last_queried_at`; o F "sem resposta" só é
//    escrito por `reconcileInterrupted`, que roda SÓ no transmitir — 403 para ramo cortado (D-F46). A tentativa segue viva,
//    `countLiveTransmissions` segue > 0 e o emitente segue travado — a D-F47 não destrava esse caso; de quebra a órfã
//    volta ao topo do rodízio (grupo das vivas) a cada `minMinutes`, com uma chamada ao ADN por passada, para sempre;
//  - [LOW — r9-resync-rollback-throws — CORRIGIDO 2026-10-04] D-F48: o `rollback` do catch (e o `beginTransaction` da institution seguinte) estão
//    FORA de qualquer proteção — conexão caída no meio de uma institution derruba o laço: as institutions seguintes não
//    rodam, o relatório JSON (inclusive das já COMITADAS) não sai e a causa raiz some (o erro final é o do rollback).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { wireAccess } from './access-stub'
import * as repo from '../nfse/repository'
import * as txMod from '../nfse/transmission'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import type { NfseDeps } from '../nfse/transmission'
import { passScope } from '../modules/guards'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { webScope, webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openIssuer: jest.fn(actual.openIssuer),
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn(),
      orderInterface: jest.fn(), assertInstitutionSchema: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getTransmission: jest.fn(), latestTransmission: jest.fn(), findTransmissionEventByKind: jest.fn(), insertTransmissionEvent: jest.fn(),
    findTransmissionByDpsId: jest.fn(), touchQueriedAt: jest.fn(),
  }
})

const actualFiscal = jest.requireActual('fiscal-api')
const actualRepo = jest.requireActual('../nfse/repository')
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const licensedM = jest.fn()   // licença (interface contratada) — costura A1: o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const fM = fiscal as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r9-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

beforeEach(() => {
  jest.clearAllMocks()
  fM.openIssuer.mockImplementation(actualFiscal.openIssuer)
})

// ===========================================================================
// Oráculo do WHERE principal
// ===========================================================================
interface Row {
  inst: number; terminal: number; deleted: 'N' | 'S'; env: 'H' | 'P'
  kind: string | null               // última voz da tentativa (le.kind)
  createdAgeMin: number             // idade de t.created_at
  lqAgeMin: number | null           // idade de t.last_queried_at (null = nunca olhada)
  erpLastKind: string | null        // vw_invoice_life.last_kind
  procAgeDays: number               // idade de COALESCE(t.dh_proc, t.created_at)
  branch: string | null             // vw_order_interface.interface_key (null = sem linha na view)
  source: string | null             // le.source da última voz (D-F52)
  hasKey: boolean                   // t.access_key IS NOT NULL (D-F52)
  voiceAgeMin: number               // idade de le.created_at (D-F52)
  newerAttempt: boolean             // existe tentativa POSTERIOR na mesma vida (D-F52)
}
const row = (over: Partial<Row> = {}): Row => ({
  inst: 1, terminal: 0, deleted: 'N', env: 'P', kind: null, createdAgeMin: 60, lqAgeMin: null, erpLastKind: 'E', procAgeDays: 1, branch: 'orders',
  source: 'P', hasKey: false, voiceAgeMin: 0, newerAttempt: false, ...over,
})

/** O WHERE de profundidade 0 (o das subconsultas do TX_SELECT fica dentro de parênteses) até o ORDER BY/LIMIT/fim. */
function mainWhere(sql: string): { where: string; before: string } {
  const s = sql.replace(/\s+/g, ' ')
  let depth = 0, start = -1, end = s.length
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && start < 0 && s.startsWith(' WHERE ', i)) start = i + 7
    else if (depth === 0 && start >= 0 && (s.startsWith(' ORDER BY ', i) || s.startsWith(' LIMIT ', i))) { end = i; break }
  }
  if (start < 0) throw new Error('WHERE principal não achado')
  return { where: s.slice(start, end).trim(), before: s.slice(0, start) }
}

const ATOMS: { re: RegExp; js: (take: () => unknown, m: RegExpExecArray) => string }[] = [
  { re: /t\.tb_institution_id = \?/y, js: t => `(r.inst === ${JSON.stringify(t())})` },
  { re: /t\.terminal = 0/y, js: () => '(r.terminal === 0)' },
  // NE-1a parte 2 (D-NE12): o terminal por PARÂMETRO
  { re: /t\.terminal = \?/y, js: t => `(r.terminal === ${JSON.stringify(t())})` },
  { re: /t\.deleted = 'N'/y, js: () => `(r.deleted === 'N')` },
  { re: /\(\? IS NULL OR t\.environment = \?\)/y, js: t => { const a = t(), b = t(); return `(${JSON.stringify(a)} === null || r.env === ${JSON.stringify(b)})` } },
  { re: /le\.kind IS NULL/y, js: () => '(r.kind === null)' },
  // parte 2 da NE-1a (D-NE9): a contagem do EMITTER lê a view publicada (última voz = `t.last_kind`; a view já tira a tentativa excluída)
  { re: /t\.last_kind IS NULL/y, js: () => '(r.kind === null)' },
  { re: /t\.last_kind NOT IN \(([^)]*)\)/y, js: (_t, m) => `(r.kind !== null && ![${m[1]}].includes(r.kind))` },
  { re: /le\.kind NOT IN \(([^)]*)\)/y, js: (_t, m) => `(r.kind !== null && ![${m[1]}].includes(r.kind))` },
  { re: /le\.kind IN \(([^)?]*)\)/y, js: (_t, m) => `(r.kind !== null && [${m[1]}].includes(r.kind))` },
  { re: /t\.created_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/y, js: t => `(r.createdAgeMin > ${JSON.stringify(t())})` },
  { re: /t\.last_queried_at IS NULL/y, js: () => '(r.lqAgeMin === null)' },
  { re: /t\.last_queried_at < DATE_SUB\(NOW\(\), INTERVAL \? MINUTE\)/y, js: t => `(r.lqAgeMin !== null && r.lqAgeMin > ${JSON.stringify(t())})` },
  { re: /t\.last_queried_at < DATE_SUB\(NOW\(\), INTERVAL \? HOUR\)/y, js: t => `(r.lqAgeMin !== null && r.lqAgeMin > ${JSON.stringify(t())} * 60)` },
  { re: /COALESCE\(l\.last_kind, '-'\) <> 'C'/y, js: () => `(r.erpLastKind !== 'C')` },
  { re: /COALESCE\(t\.dh_proc, t\.created_at\) >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/y, js: t => `(r.procAgeDays <= ${JSON.stringify(t())})` },
  { re: /COALESCE\(oi\.interface_key, 'orders'\) IN \(\?\)/y, js: t => `(${JSON.stringify(t())}.includes(r.branch ?? 'orders'))` },
  // D-F52 — revisita única do F por consulta
  { re: /le\.kind = 'F'/y, js: () => `(r.kind === 'F')` },
  { re: /le\.source = 'Q'/y, js: () => `(r.source === 'Q')` },
  { re: /t\.access_key IS NULL/y, js: () => '(!r.hasKey)' },
  { re: /le\.created_at <= DATE_SUB\(NOW\(\), INTERVAL (\d+) HOUR\)/y, js: (_t, m) => `(r.voiceAgeMin >= ${Number(m[1])} * 60)` },
  { re: /le\.created_at >= DATE_SUB\(NOW\(\), INTERVAL (\d+) DAY\)/y, js: (_t, m) => `(r.voiceAgeMin <= ${Number(m[1])} * 1440)` },
  { re: /t\.last_queried_at < DATE_ADD\(le\.created_at, INTERVAL (\d+) HOUR\)/y, js: (_t, m) => `(r.lqAgeMin !== null && (r.voiceAgeMin - r.lqAgeMin) < ${Number(m[1])} * 60)` },
  { re: /NOT EXISTS \(SELECT 1 FROM tb_invoice_service_transmission t2 WHERE [^()]*t2\.attempt > t\.attempt\)/y, js: () => '(!r.newerAttempt)' },
]

/** Traduz o WHERE principal para um predicado JS; devolve também quantos parâmetros consumiu. */
function whereOracle(sql: string, params: unknown[]): { pred: (r: Row) => boolean; used: number; skeleton: string } {
  const { where, before } = mainWhere(sql)
  if (/\?/.test(before)) throw new Error('placeholder ANTES do WHERE — o oráculo assume que os parâmetros começam no WHERE')
  let i = 0
  const take = () => { if (i >= params.length) throw new Error('faltou parâmetro'); return params[i++] }
  let out = '', skeleton = '', pos = 0
  while (pos < where.length) {
    let matched = false
    for (const a of ATOMS) {
      a.re.lastIndex = pos
      const m = a.re.exec(where)
      if (m) { out += a.js(take, m); skeleton += ' # '; pos += m[0].length; matched = true; break }
    }
    if (matched) continue
    if (where.startsWith('AND ', pos)) { out += ' && '; skeleton += ' AND '; pos += 4; continue }
    if (where.startsWith('OR ', pos)) { out += ' || '; skeleton += ' OR '; pos += 3; continue }
    const ch = where[pos]
    if (ch === '(' || ch === ')' || ch === ' ') { out += ch; skeleton += ch; pos++; continue }
    throw new Error(`oráculo não reconhece o WHERE a partir de: «${where.slice(pos, pos + 60)}»`)
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('r', `return !!(${out})`) as (r: Row) => boolean
  return { pred: fn, used: i, skeleton: skeleton.replace(/\s+/g, ' ').trim() }
}

const fakeQ = () => {
  const calls: { sql: string; params: unknown[] }[] = []
  // NE-1a (gates da parte 1): o `mapTx` é estrito — a linha de contagem `{ n: 0 }` só para o COUNT; as listas de tentativas voltam vazias
  const q = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [/COUNT\(\*\)/i.test(sql) ? [{ n: 0 }] : [], []] }) }
  return { q: q as any, calls }
}

async function candidatesOracle(opts: { interfaces?: string[]; liveOnlyInterfaces?: string[] }, minMinutes = 5, inFlight = 10) {
  const { q, calls } = fakeQ()
  await actualRepo.listRefreshCandidates(q, 'setes_setes', webScope(1), minMinutes, inFlight, 8, { authorizedMaxDays: 90, ...opts })
  expect(calls).toHaveLength(1)
  const { sql, params } = calls[0]
  const o = whereOracle(sql, params)
  expect(params.slice(o.used)).toEqual([8])                       // sobra SÓ o LIMIT — nenhum parâmetro desalinhado
  expect((sql.match(/\?/g) ?? []).length).toBe(params.length)
  return { ...o, sql, params }
}

// ===========================================================================
// 1. D-F47 — precedência AND/OR do filtro novo dentro do WHERE existente
// ===========================================================================
describe('D-F47 — o filtro de ramo não escapa da institution nem do bloco de idade (oráculo sobre o SQL REAL)', () => {
  const MIXED = { interfaces: ['service-orders'], liveOnlyInterfaces: ['orders', 'order-returns'] }

  it('resistiu: no nível 0 do WHERE só há AND — o OR novo fica preso no parêntese do filtro', async () => {
    const { skeleton } = await candidatesOracle(MIXED)
    let depth = 0
    const topLevel: string[] = []
    let cur = ''
    for (const tok of skeleton.split(' ')) {
      for (const ch of tok) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
      cur += tok + ' '
      if (depth === 0 && (tok === 'AND' || tok === 'OR')) { topLevel.push(tok); cur = '' }
    }
    expect(topLevel.length).toBeGreaterThanOrEqual(4)
    expect(topLevel.every(t => t === 'AND')).toBe(true)
  })

  it('resistiu: matriz de linhas — institution alheia, ramo cortado autorizado, viva olhada há pouco, em voo jovem, terminal/excluída', async () => {
    const { pred } = await candidatesOracle(MIXED)
    const cases: [string, Row, boolean][] = [
      ['cortado, em voo elegível', row({ branch: 'orders' }), true],
      ['cortado sem linha na view (= orders), em voo', row({ branch: null }), true],
      ['cortado, K elegível', row({ branch: 'order-returns', kind: 'K', lqAgeMin: 30 }), true],
      ['cortado, viva de OUTRA institution', row({ inst: 2 }), false],
      ['cortado, AUTORIZADA (A) — não volta ao rodízio', row({ kind: 'A' }), false],
      ['cortado, N (autorizada depois de K)', row({ kind: 'N' }), false],
      ['cortado, K olhada há 2 min (< minMinutes)', row({ kind: 'K', lqAgeMin: 2 }), false],
      ['cortado, em voo com 3 min (< inFlight)', row({ createdAgeMin: 3 }), false],
      ['cortado, terminal 1', row({ terminal: 1 }), false],
      ['cortado, tentativa excluída', row({ deleted: 'S' }), false],
      ['cortado, R/F/C', row({ kind: 'R' }), false],
      ['contratado, A elegível', row({ branch: 'service-orders', kind: 'A' }), true],
      ['contratado, A de OUTRA institution', row({ branch: 'service-orders', kind: 'A', inst: 2 }), false],
      ['contratado, A velha demais (teto)', row({ branch: 'service-orders', kind: 'A', procAgeDays: 120 }), false],
      ['contratado, A com C local no ERP', row({ branch: 'service-orders', kind: 'A', erpLastKind: 'C' }), false],
      ['contratado, A olhada há 2 h (< 24 h)', row({ branch: 'service-orders', kind: 'A', lqAgeMin: 120 }), false],
    ]
    expect(cases.map(([n, r]) => [n, pred(r)])).toEqual(cases.map(([n, , want]) => [n, want]))
  })

  it('resistiu: admin com NADA contratado — só as vivas; nenhuma autorizada de nenhum ramo; outra institution fora', async () => {
    const { pred } = await candidatesOracle({ interfaces: [], liveOnlyInterfaces: ['service-orders', 'orders', 'order-returns'] })
    expect(pred(row({ branch: 'service-orders' }))).toBe(true)
    expect(pred(row({ branch: 'service-orders', kind: 'A' }))).toBe(false)
    expect(pred(row({ branch: 'orders', kind: 'N' }))).toBe(false)
    expect(pred(row({ inst: 2 }))).toBe(false)
  })

  it('cenário (dentes do oráculo): sem o parêntese externo do filtro, a viva de OUTRA institution vazaria — o oráculo acusa', async () => {
    const { sql, params } = await candidatesOracle(MIXED)
    const mutated = sql.replace(/AND \((COALESCE\(oi\.interface_key, 'orders'\) IN \(\?\) OR \([\s\S]*?\)\))\)(\s*ORDER BY)/, 'AND $1$2')
    expect(mutated).not.toBe(sql)
    expect(whereOracle(mutated, params).pred(row({ inst: 2 }))).toBe(true)
    expect(whereOracle(sql, params).pred(row({ inst: 2 }))).toBe(false)
  })
})

// D-F52 (= Q-F61 (a), Valdo 2026-10-04) — o F "sem resposta" por CONSULTA volta ao rodízio UMA vez, 24 h depois
describe('D-F52 — revisita única do F por consulta (oráculo sobre o SQL REAL)', () => {
  it('entra só o F de source Q, sem chave, ≥ 24 h, dentro do teto, não revisitado, última tentativa da vida e de ramo com privilégio', async () => {
    const { pred } = await candidatesOracle({ interfaces: ['service-orders'], liveOnlyInterfaces: ['orders'] })
    // F gravado há 25 h; a consulta que o gravou carimbou junto (lqAge ≈ voiceAge)
    const F = (over: Partial<Row> = {}) => row({ branch: 'service-orders', kind: 'F', source: 'Q', voiceAgeMin: 25 * 60, lqAgeMin: 25 * 60, ...over })
    const cases: [string, Row, boolean][] = [
      ['F por consulta há 25 h, nunca revisitado', F(), true],
      ['F por consulta há 23 h (< 24 h)', F({ voiceAgeMin: 23 * 60, lqAgeMin: 23 * 60 }), false],
      ['F por consulta JÁ revisitado (carimbo 24 h depois do F)', F({ lqAgeMin: 60 }), false],
      ['F do transmitir (source P — recusa explícita)', F({ source: 'P' }), false],
      ['F com chave', F({ hasKey: true }), false],
      ['F com tentativa POSTERIOR na vida (retransmitida)', F({ newerAttempt: true }), false],
      ['F velho demais (além do teto de 90 dias)', F({ voiceAgeMin: 91 * 1440, lqAgeMin: 91 * 1440 }), false],
      ['F de ramo CORTADO (só vivas — D-F46/D-F47)', F({ branch: 'orders' }), false],
      ['F de outra institution', F({ inst: 2 }), false],
    ]
    expect(cases.map(([label, r]) => [label, pred(r)])).toEqual(cases.map(([label, , want]) => [label, want]))
  })
})

// ===========================================================================
// 2. D-F47 — "viva" do SQL × countLiveTransmissions (o que trava o emitente) × isLiveTransmission
// ===========================================================================
describe('D-F47 — semântica de "viva": a passada × a guarda do emitente', () => {
  const KINDS = [null, 'S', 'K', 'A', 'R', 'C', 'F', 'N'] as const

  it('resistiu: por KIND, o grupo dos cortados = countLiveTransmissions = isLiveTransmission (complemento de FINAL)', async () => {
    const cand = await candidatesOracle({ interfaces: [], liveOnlyInterfaces: ['orders'] })
    const { q, calls } = fakeQ()
    await actualFiscal.countLiveTransmissions(q, 1, { branches: 'all' })            // o EMITTER do núcleo (D-NE9)
    const count = whereOracle(calls[0].sql, calls[0].params)
    expect(count.used).toBe(calls[0].params.length)
    const table = KINDS.map(k => {
      const r = row({ kind: k, lqAgeMin: 30 })
      return [k, cand.pred(r), count.pred(r), actualFiscal.isLiveTransmission({ attempt: 1, accessKey: null, lastKind: k })]
    })
    expect(table).toEqual(KINDS.map(k => [k, k === null || k === 'S' || k === 'K', k === null || k === 'S' || k === 'K', k === null || k === 'S' || k === 'K']))
  })

  // --- o que a passada FAZ com a candidata viva de ramo cortado ---
  const INVOICE = 7100
  const DPS = 'DPS' + '7'.repeat(42)
  const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
  const pool = { query: jest.fn(async () => [[]]), getConnection: jest.fn() } as any
  const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({ 1: Buffer.alloc(32, 9) }), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
  const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990009 }
  const inFlight = {
    institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 71, dpsId: DPS,
    accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-10-01 10:00:00', ageMinutes: 4000, lastQueriedAt: '2026-10-04 10:00:00',
    lastEvent: null, lastKind: null, lastCode: null, lastMessage: null, lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null,
  }
  const conn = { beginTransaction: jest.fn(), query: jest.fn(async () => [[]]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const arrange = () => {
    pool.getConnection.mockResolvedValue(conn)                        // D-F51: o F nasce sob a trava da nota (transação)
    erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
    repoM.insertTransmissionEvent.mockResolvedValue(1)
    erpM.invoiceLife.mockResolvedValue({ lifeEvent: 1, lastEvent: 1, lastKind: 'E', alive: true })
    repoM.getTransmission.mockResolvedValue(inFlight)
    repoM.findTransmissionByDpsId.mockResolvedValue(null)
    repoM.touchQueriedAt.mockResolvedValue(undefined)
    fM.openIssuer.mockResolvedValue({ issuer: { model: 'SE', environment: 'P', serie: '1', cutoverAt: '2026-10-04 12:00:00' }, cert: 'c', key: 'k' })
    adapter.queryDpsAccessKey.mockResolvedValue(null)                 // o fisco não conhece o DPS: o POST nunca chegou
  }

  // [corrigido 2026-10-04 — D-F51 (= Q-F60 (a))] a consulta grava o F "sem resposta" com o mesmo critério do transmitir
  it('[r9-inflight-never-closes][corrigido] a passada FECHA a tentativa em voo de ramo cortado que o fisco não conhece (voz final gravada — D-F47/D-F51)', async () => {
    arrange()
    const r = await txMod.refreshServiceTransmission(deps, ACTOR, webRef(ACTOR, INVOICE), 'Q', { attempt: 1 })
    expect(r).toMatchObject({ changed: true, kind: 'F' })
    const kinds = repoM.insertTransmissionEvent.mock.calls.map(c => c[3]?.kind)
    expect(kinds.some(k => actualFiscal.FINAL_TRANSMISSION_KINDS.has(k))).toBe(true)
  })
})

// ===========================================================================
// 3. D-F47 — passScope e a borda HTTP
// ===========================================================================
describe('D-F47 — passScope: partição dos ramos, admin sem nada contratado, cerca antes de tudo', () => {
  const ctxLite = { pool: {} } as unknown as AppContext
  const inst = (role = 'user') => ({ institutionId: 1, userId: 7, role, schemaName: 'setes_setes' }) as any
  const contracted = (...keys: string[]) => licensedM.mockImplementation(async (_p: any, _s: string, _i: number, k: string) => keys.includes(k))
  const privileged = (...keys: string[]) => grantedM.mockImplementation(async (_p: any, _s: string, _u: number, k: string) => keys.includes(k))
  const KEYS = ['service-orders', 'orders', 'order-returns']
  const run = (role: string) => passScope(ctxLite, inst(role), KEYS, 'CONSULTAR').then(r => r, (e: any) => [e.statusCode, e.code])

  it('resistiu: contratado SEM privilégio não cai em NENHUMA lista (nem vira "vivas de cortado"); cortado só em liveOnly', async () => {
    contracted('service-orders', 'orders'); privileged('service-orders')
    expect(await run('user')).toEqual({ interfaces: ['service-orders'], liveOnlyInterfaces: ['order-returns'] })
  })

  it('resistiu: usuário comum com contratado mas SEM privilégio em nenhum → 403 PRIVILEGE_REQUIRED mesmo havendo ramo cortado', async () => {
    contracted('orders'); privileged()
    expect(await run('user')).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('resistiu: nada contratado — admin roda só sobre as vivas (interfaces vazia); usuário comum 403 INTERFACE_NOT_ALLOWED', async () => {
    contracted(); privileged(...KEYS)
    expect(await run('admin')).toEqual({ interfaces: [], liveOnlyInterfaces: KEYS })
    expect(await run('user')).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
  })

  it('resistiu: as duas listas são DISJUNTAS e cobrem só chaves pedidas (nenhuma chave forjada entra)', async () => {
    contracted('orders'); privileged('orders')
    const r = await run('admin') as any
    expect([...r.interfaces, ...r.liveOnlyInterfaces].sort()).toEqual([...KEYS].sort())
    expect(r.interfaces.filter((k: string) => r.liveOnlyInterfaces.includes(k))).toEqual([])
  })

  describe('borda HTTP', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, role: 'user', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
    let replica = false
    const pool = { query: jest.fn(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: replica ? 1 : 0 }]] : [[]])), getConnection: jest.fn() } as any
    const ctx = (): AppContext => ({
      db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
      pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }), storage: new FsFiscalStorage(storageRoot), adapter: {} as any,
      fiscalDb: 'fiscal_api', verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: false,
    })
    let spy: jest.SpyInstance
    beforeEach(() => {
      replica = false
      spy = jest.spyOn(txMod, 'refreshOpenServiceTransmissions').mockResolvedValue({ checked: 0, changed: 0, errors: [], stoppedEarly: false, skipped: false } as any)
    })
    afterEach(() => spy.mockRestore())

    it('resistiu: admin com NADA contratado em institution NÃO virada → 409 FISCAL_CUTOVER_PENDING antes de ler licença/privilégio', async () => {
      replica = true; contracted()
      const r = await request(createApp(ctx())).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token({ role: 'admin' })}`).send({})
      expect([r.status, r.body.code]).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
      expect(licensedM).not.toHaveBeenCalled()
      expect(spy).not.toHaveBeenCalled()
    })

    it('resistiu: o corpo não injeta `liveOnlyInterfaces` (nem __proto__) — o escopo vem só da guarda', async () => {
      contracted('service-orders'); privileged('service-orders')
      const raw = '{"liveOnlyInterfaces":["service-orders","orders","order-returns","x"],"interfaces":["x"],"__proto__":{"liveOnlyInterfaces":["y"]}}'
      const r = await request(createApp(ctx())).post('/v1/nfse/refresh').set('Authorization', `Bearer ${token()}`).set('Content-Type', 'application/json').send(raw)
      expect(r.status).toBe(200)
      expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(),
        { terminal: WEB, minMinutes: undefined, limit: undefined, interfaces: ['service-orders'], liveOnlyInterfaces: ['orders', 'order-returns'] })   // o terminal vem da BORDA (NE-1a parte 2)
    })
  })
})

// ===========================================================================
// 4. D-F48 — re-sincronia com uma transação por institution
// ===========================================================================
describe('D-F48 — resyncAll: conexão reutilizada, rollback, checkXmls, --dry-run com várias institutions', () => {
  type Handler = (sql: string, p: any[]) => any
  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)

  async function runScript(argv: string[], handler: Handler, connOver: Record<string, jest.Mock> = {}) {
    const sqls: string[] = []
    const conn: any = {
      beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
      query: jest.fn(async (sql: string, p: any[] = []) => {
        sqls.push(sql.replace(/\s+/g, ' ').trim())
        const out = handler(sql, p)
        if (out instanceof Error) throw out
        if (out !== undefined) return out
        return isWrite(sql) ? [{ affectedRows: 0 }] : [[]]
      }),
      ...connOver,
    }
    let ended!: () => void
    const done = new Promise<void>(r => { ended = r })
    const pool: any = { query: conn.query, getConnection: jest.fn(async () => conn), end: jest.fn(async () => ended()) }
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    const errors: string[] = [], logs: string[] = []
    const err = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.map(String).join(' ')) })
    const log = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')) })
    const prevArgv = process.argv
    process.env.SETES_SECRETS_PATH = path.join(storageRoot, 'sem-cofre')
    process.argv = ['node', 'migrate-from-setes-api.ts', ...argv]
    try {
      jest.isolateModules(() => {
        const f = require('fiscal-api')
        f.createFiscalPool.mockReturnValue(pool)
        jest.spyOn(f.MasterKeyRing, 'fromEnv').mockReturnValue(f.MasterKeyRing.of({ 1: Buffer.alloc(32, 3) }))
        require('../../scripts/migrate-from-setes-api')
      })
      await done
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    } finally {
      process.argv = prevArgv
    }
    const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, conn, pool, sqls }
    exit.mockRestore(); err.mockRestore(); log.mockRestore()
    return res
  }

  /**
   * institution 1 (setes_x): SE no ERP, réplica SE no fiscal_api → re-sincronia completa (migrateInstitution) com sucesso.
   * institution 2 (setes_y): sem SE no ERP e RÉPLICA 55 no fiscal_api → falha alta (D-F42).
   * institution 3 (setes_z): sem SE no ERP, nada no fiscal_api → nada a fazer.
   */
  const db = (ids: number[]): Handler => (sql, p) => {
    const SCHEMA: Record<number, string> = { 1: 'setes_x', 2: 'setes_y', 3: 'setes_z' }
    if (/SELECT id, schema_name AS schemaName FROM setes_central\.tb_institution WHERE deleted = 'N'/.test(sql)) return [ids.map(id => ({ id, schemaName: SCHEMA[id] }))]
    if (/SELECT 1 AS x FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = 'SE'/.test(sql)) return [[{ x: 1 }]]
    if (/SELECT 1 AS x FROM `setes_[yz]`\.tb_establishment_issuer/.test(sql)) return [[]]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [p[0] === 1 ? [{ model: 'SE', c: null }] : p[0] === 2 ? [{ model: '55', c: null }] : []]
    if (/information_schema\.tables/.test(sql)) return [[{ x: 1 }]]
    if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \?$/.test(sql.trim())) {
      return [[{ tb_institution_id: 1, model: 'SE', environment: 'P', serie: '1', dps_last_number: 10, tb_user_id: null, created_at: null, updated_at: null, deleted: 'N' }]]
    }
    if (/invoice_event IS NULL/.test(sql)) return [[{ n: 0 }]]
    if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(sql)) return [[{ m: 0 }]]
    return undefined
  }
  const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i]

  it('resistiu: --dry-run com VÁRIAS institutions — uma transação cada, todas desfeitas, nenhum commit, relatório "dryRun", saída 0', async () => {
    const r = await runScript(['--dry-run'], db([1, 3]))
    expect(r.conn.beginTransaction).toHaveBeenCalledTimes(2)
    expect(r.conn.rollback).toHaveBeenCalledTimes(2)
    expect(r.conn.commit).not.toHaveBeenCalled()
    expect(r.exitCode).toBeNull()
    const out = JSON.parse(r.logs.join('\n'))
    expect(out).toMatchObject({ dryRun: true, committed: false, failures: [] })
    expect(out.reports).toHaveLength(1)
    expect(out.reports[0]).toMatchObject({ schema: 'setes_x', institutionId: 1 })
  })

  it('resistiu: a trava (FOR UPDATE) de cada institution nasce DENTRO da transação dela e morre no fim dela (antes da próxima)', async () => {
    const r = await runScript([], db([1, 3]))
    const lockIdx = r.sqls.findIndex(s => /FROM tb_establishment_issuer WHERE tb_institution_id = \? AND model IN .* FOR UPDATE/.test(s))
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    const lockOrder = r.conn.query.mock.invocationCallOrder[lockIdx]
    expect(order(r.conn.beginTransaction, 0)).toBeLessThan(lockOrder)
    expect(lockOrder).toBeLessThan(order(r.conn.commit, 0))
    expect(order(r.conn.commit, 0)).toBeLessThan(order(r.conn.beginTransaction, 1))
    expect(r.conn.commit).toHaveBeenCalledTimes(2)
    expect(r.exitCode).toBeNull()
  })

  it('resistiu: a que falha é DESFEITA antes da seguinte começar; a seguinte comita; checkXmls só para a que comitou; saída 1', async () => {
    const r = await runScript([], db([2, 1]))
    expect(order(r.conn.beginTransaction, 0)).toBeLessThan(order(r.conn.rollback, 0))
    expect(order(r.conn.rollback, 0)).toBeLessThan(order(r.conn.beginTransaction, 1))
    expect(order(r.conn.beginTransaction, 1)).toBeLessThan(order(r.conn.commit, 0))
    expect(r.conn.commit).toHaveBeenCalledTimes(1)
    // checkXmls (SELECT t.access_key … de UMA institution) roda DEPOIS do último commit e só para a 1
    const xmlIdx = r.sqls.map((s, i) => [s, i] as const).filter(([s]) => /SELECT t\.access_key AS k/.test(s))
    expect(xmlIdx).toHaveLength(1)
    expect(r.conn.query.mock.calls[xmlIdx[0][1]][1]).toEqual([1])
    expect(r.conn.query.mock.invocationCallOrder[xmlIdx[0][1]]).toBeGreaterThan(order(r.conn.commit, 0))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/1 institution\(s\) com falha — nada delas gravado; as demais foram gravadas: setes_y/)
  })

  it('resistiu: o COMMIT que falha vira falha DAQUELA institution (rollback, segue para a próxima)', async () => {
    let n = 0
    const commit = jest.fn(async () => { if (n++ === 0) throw new Error('commit perdido (deadlock no COMMIT)') })
    const r = await runScript([], db([1, 3]), { commit })
    expect(commit).toHaveBeenCalledTimes(2)
    expect(r.conn.rollback).toHaveBeenCalledTimes(1)
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/1 institution\(s\) com falha.*commit perdido/)
  })

  // --- conexão caída no meio de uma institution: o rollback do catch lança ---
  const deadConn = () => {
    let dead = false
    return {
      rollback: jest.fn(async () => { if (dead) throw new Error("Can't add new command when connection is in closed state") }),
      beginTransaction: jest.fn(async () => { if (dead) throw new Error("Can't add new command when connection is in closed state") }),
      kill: () => { dead = true },
    }
  }

  // [corrigido 2026-10-04] rollback protegido: conexão que não desfaz é descartada e a próxima institution usa outra;
  // o relatório sai sempre (finally)
  it('[r9-resync-rollback-throws][corrigido] conexão caída numa institution: a causa raiz e o relatório das já comitadas chegam ao operador', async () => {
    const d = deadConn()
    const base = db([1, 2, 3])
    const r = await runScript([], (sql, p) => {
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql) && p[0] === 2) { d.kill(); return new Error('PROTOCOL_CONNECTION_LOST') }
      return base(sql, p)
    }, { rollback: d.rollback, beginTransaction: d.beginTransaction })
    expect(r.errors.join(' ')).toMatch(/PROTOCOL_CONNECTION_LOST/)
    expect(r.logs.join(' ')).toMatch(/"reports"/)
  })
})
