/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA (correções dos gates da Rodada 11 + Rodada 12 da F2a/F2b — 2026-10-13; skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F50/D-F110/D-F152/D-F153/D-F162/D-F186, §22.36–§22.38).
// Alvo: nfse-api `56b684d..c967dcf` — (1) o ENSAIO do `--cutover` interrompido por um erro duro DENTRO da transação imprime os bloqueios
// D-F50/D-F110 já conferidos (`{ dryRun, committed: false, bloqueios, interrompidoPor }`) e sai com 1; (2) D-F186: `F2A_TREE` — o "de onde
// rodar" neutro no tempo nas frases da lápide e do D-F110.
// Convenção: `failing('[ACHADO R12-ADV-NN SEV] …')` = o comportamento CERTO, hoje falha (ADV_SHOW=1 mostra a falha); `it('[FATO …]')` =
// o comportamento atual registrado (a prova executável); `it('[RESISTIU] …')` = o ataque foi barrado.
// Nada aqui toca banco: o SCRIPT do ato inteiro com o pool falso (harness dos gates R8–R11, sem mudança na mecânica — + a alavanca de
// falhar o `getConnection`). O lado app deste gate: `setes-app-f2b/apps/web/test/adversarial_r12_gate_test.dart`.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FREEZE_TRIGGERS_SQL, freezeTriggerRows } from './fixture-freeze-triggers'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
  }
})


const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-f2a-r12-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

type Handler = (sql: string, p: any[]) => any
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
const F2A = 'f2a_fiscal_passivo'
const TOMB = 'f2a_fiscal_passivo_abortada'
const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']
/** O texto DECIDIDO da D-F186 (Valdo 2026-10-13 — Q-F194 (a)). */
const D_F186 = 'a partir da árvore do setes-api com a F2a (a worktree até a janela; a árvore principal depois)'

/** O script INTEIRO do ato com o pool falso (molde dos gates R8–R11) + [getConnectionError]: o pool falha ao dar a conexão da transação. */
async function runScript(argv: string[], handler: Handler, opts: { getConnectionError?: Error } = {}) {
  const sqls: { sql: string; p: any[]; tx: boolean }[] = []
  let inTx = false
  const conn: any = {
    beginTransaction: jest.fn(async () => { inTx = true }), commit: jest.fn(async () => { inTx = false }),
    rollback: jest.fn(async () => { inTx = false }), release: jest.fn(),
    query: jest.fn(async (sql: string, p: any[] = []) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), p, tx: inTx })
      const out = handler(sql, p)
      if (out instanceof Error) throw out
      if (out !== undefined) return out
      return isWrite(sql) ? [{ affectedRows: 0 }] : [[]]
    }),
  }
  let ended!: () => void
  const done = new Promise<void>(r => { ended = r })
  const pool: any = {
    query: conn.query,
    getConnection: jest.fn(async () => { if (opts.getConnectionError) throw opts.getConnectionError; return conn }),
    end: jest.fn(async () => ended()),
  }
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
  const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, conn, sqls }
  exit.mockRestore(); err.mockRestore(); log.mockRestore()
  return res
}

/**
 * ERP com a SE viva e o fiscal_api réplica (o `db` dos gates R10/R11) + as alavancas: [live] transmissões VIVAS na origem; [noSe] o ERP sem
 * a habilitação SE; [turned] a linha SE do fiscal_api JÁ virada (o "já VIRADA" — passo 2); [postFails] a pós-condição (passo 7) falha.
 */
const db = (names: string[], opts: { triggers?: object[]; live?: object[]; noSe?: boolean; turned?: boolean; postFails?: boolean } = {}): Handler => {
  const triggers = opts.triggers ?? freezeTriggerRows()
  let turned = false
  return (sql, p) => {
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
    if (/\._migrations WHERE name/.test(sql)) {
      const asked = (p ?? []).map(String)
      return [names.filter(n => asked.includes(n)).map(name => ({ x: 1, name }))]
    }
    if (FREEZE_TRIGGERS_SQL.test(sql)) return [triggers]
    if (/dps_last_number AS n FROM `setes_x`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) {
      return opts.noSe ? [[]] : [[{ model: 'SE', serie: '1', deleted: 'N', n: 10 }]]
    }
    if (/FROM `setes_x`\.tb_invoice_service_transmission t\s+LEFT JOIN/.test(sql)) return [opts.live ?? []]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [[{ model: 'SE', c: opts.turned ? new Date('2026-10-01T00:00:00Z') : null }]]
    if (/information_schema\.tables/.test(sql)) return [[{ x: 1 }]]
    if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \?$/.test(sql.trim())) {
      return [[{ tb_institution_id: 1, model: 'SE', environment: 'P', serie: '1', dps_last_number: 10, tb_user_id: null, created_at: null, updated_at: null, deleted: 'N' }]]
    }
    if (/invoice_event IS NULL/.test(sql)) return [[{ n: 0 }]]
    if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(sql)) return [[{ m: 0 }]]
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: turned && !opts.postFails ? 0 : 1 }]]
    if (/^\s*UPDATE tb_establishment_issuer SET cutover_at/.test(sql)) { turned = true; return [{ affectedRows: 1 }] }
    if (/UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(sql)) return [{ affectedRows: 1 }]
    return undefined
  }
}
const half = () => freezeTriggerRows().slice(0, 4)
const LIVE = [{ inv: 7223, attempt: 2 }]

/** A frase do ato real (depois de "setes_x: "). */
const realPhrase = (errors: string[]): string => {
  const line = errors.find(e => e.includes('[migrate:setes] FALHA:')) ?? ''
  return line.includes('setes_x: ') ? line.slice(line.indexOf('setes_x: ') + 'setes_x: '.length) : ''
}
/** Os relatórios JSON que o ensaio imprimiu (o que o roteiro da janela lê). */
const reportsOf = (logs: string[]): any[] => {
  const out: any[] = []
  for (const l of logs) { try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j) } catch { /* não é relatório */ } }
  return out
}

describe('o ENSAIO interrompido DENTRO da transação (R11-SOC-06 = R11-ADV-01, corrigido no §22.36)', () => {
  it('[RESISTIU] os TRÊS estados da LÁPIDE (abortada; pela METADE — 4 de 9 gatilhos de pé; linha + lápide "juntas") × o erro duro no meio (transmissão VIVA; ERP sem SE): o ato real recusa ANTES da transação com a frase da lápide; o ensaio sai com 1 e imprime UM relatório — exatamente `{dryRun: true, committed: false, bloqueios, interrompidoPor}` —, com a frase da lápide IGUAL à do ato (+ o prefixo D-F50), o erro duro em `interrompidoPor`, o rollback feito, nenhum commit e nenhuma escrita', async () => {
    const cases: [string, string[], object[], RegExp][] = [
      ['abortada', [TOMB], [], /^a F2a do setes-api foi ABORTADA em setes_x \(lápide/],
      ['pela metade', [TOMB], half(), /^a F2a do setes-api foi ABORTADA em setes_x, mas o aborto ficou PELA METADE \(4 gatilho\(s\)/],
      ['juntas', [F2A, TOMB], [], /^a linha "f2a_fiscal_passivo" E a lápide/],
    ]
    for (const [label, names, triggers, want] of cases) {
      for (const [hard, extra, says] of [['viva', { live: LIVE }, /transmissão VIVA na origem \(7223\/2\)/], ['sem SE', { noSe: true }, /o ERP não tem habilitação SE — nada a virar/]] as [string, object, RegExp][]) {
        const real = await runScript([...CUT, '--vai'], db(names, { triggers, ...extra }))
        const dry = await runScript([...CUT, '--dry-run'], db(names, { triggers, ...extra }))
        const tag = `${label} × ${hard}`
        expect([tag, real.exitCode, real.conn.beginTransaction.mock.calls.length]).toEqual([tag, 1, 0])
        expect([tag, want.test(realPhrase(real.errors))]).toEqual([tag, true])
        const reports = reportsOf(dry.logs)
        expect([tag, dry.exitCode, reports.length]).toEqual([tag, 1, 1])
        const r = reports[0]
        expect([tag, Object.keys(r)]).toEqual([tag, ['dryRun', 'committed', 'bloqueios', 'interrompidoPor']])
        expect([tag, r.dryRun, r.committed, r.bloqueios]).toEqual([tag, true, false, [`D-F50: a virada REAL seria recusada — ${realPhrase(real.errors)}`]])
        expect([tag, says.test(r.interrompidoPor)]).toEqual([tag, true])
        expect([tag, dry.conn.rollback.mock.calls.length > 0, dry.conn.commit.mock.calls.length, dry.sqls.filter(s => isWrite(s.sql)).length]).toEqual([tag, true, 0, 0])
        // o erro duro segue também no stderr (exit 1 — o roteiro não lê o ensaio interrompido como "ok")
        expect([tag, says.test(dry.errors.join('\n'))]).toEqual([tag, true])
      }
    }
  })

  it('[RESISTIU] o erro duro dos passos MAIS FUNDOS (o "já VIRADA" do passo 2; a pós-condição do passo 7, DEPOIS das escritas da transação) com o D-F110 (trava faltando): o relatório interrompido traz o bloqueio do D-F110 com a frase do ato e o erro; as escritas da transação são DESFEITAS (rollback, nenhum commit)', async () => {
    for (const [label, extra, says] of [
      ['já VIRADA', { turned: true }, /já VIRADA — a virada é write-once/],
      ['pós-condição', { postFails: true }, /depois da virada o predicado ainda diz "emissão do ERP"/],
    ] as [string, object, RegExp][]) {
      const real = await runScript([...CUT, '--vai'], db([F2A], { triggers: half(), ...extra }))
      const dry = await runScript([...CUT, '--dry-run'], db([F2A], { triggers: half(), ...extra }))
      expect([label, /^gatilhos de TRAVA da F2a faltando ou diferentes em setes_x/.test(realPhrase(real.errors))]).toEqual([label, true])
      const reports = reportsOf(dry.logs)
      expect([label, dry.exitCode, reports.length]).toEqual([label, 1, 1])
      expect([label, reports[0].bloqueios]).toEqual([label, [`D-F110: a virada REAL seria recusada — ${realPhrase(real.errors)}`]])
      expect([label, says.test(reports[0].interrompidoPor)]).toEqual([label, true])
      expect([label, dry.conn.commit.mock.calls.length, dry.conn.rollback.mock.calls.length > 0]).toEqual([label, 0, true])
      if (label === 'pós-condição') {
        // as escritas aconteceram DENTRO da transação (a virada e a aposentadoria da SE) — e foram desfeitas
        expect(dry.sqls.filter(s => isWrite(s.sql)).every(s => s.tx)).toBe(true)
        expect(dry.sqls.some(s => /UPDATE tb_establishment_issuer SET cutover_at/.test(s.sql))).toBe(true)
      }
    }
  })

  it('[RESISTIU] os caminhos que a correção NÃO mexe: ensaio com bloqueio e SEM erro duro = o relatório de sempre (com `cutover` e `bloqueios`, `committed: false`) e saída normal (sem `process.exit`); ensaio SEM bloqueio e com erro duro = nenhum relatório, exit 1 (o roteiro não confunde "interrompido sem bloqueio" com relatório)', async () => {
    const ok = await runScript([...CUT, '--dry-run'], db([], {}))
    const okReports = reportsOf(ok.logs)
    expect([ok.exitCode, okReports.length]).toEqual([null, 1])
    expect([okReports[0].dryRun, okReports[0].committed, typeof okReports[0].cutover, okReports[0].bloqueios?.length, 'interrompidoPor' in okReports[0]])
      .toEqual([true, false, 'object', 1, false])
    const clean = await runScript([...CUT, '--dry-run'], db([F2A], { live: LIVE }))
    expect([clean.exitCode, reportsOf(clean.logs).length]).toEqual([1, 0])
    expect(clean.errors.join('\n')).toMatch(/transmissão VIVA na origem/)
  })

  it('[FATO — fora da correção, sem achado] o erro duro ANTES da transação (o pool não entrega a conexão — servidor caiu entre as leituras em autocommit e a transação) com o bloqueio do D-F50 JÁ conferido: o ensaio sai com 1 sem relatório (o `catch` que imprime os bloqueios é o da transação). É infraestrutura, não um estado a corrigir — rodar de novo mostra o bloqueio', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' })
    const dry = await runScript([...CUT, '--dry-run'], db([], { live: LIVE }), { getConnectionError: down })
    expect([dry.exitCode, reportsOf(dry.logs).length, /ECONNREFUSED/.test(dry.errors.join('\n'))]).toEqual([1, 0, true])
  })
})

describe('D-F186/D-F190 — de onde rodar: o D-F110 neutro no tempo; a LÁPIDE na worktree (o aborto só existe antes da 1ª janela)', () => {
  it('[DECIDIDO D-F190 (= Q-F195-SOC-04 (a)) — revê o RESISTIU da D-F186 nas frases da LÁPIDE] o reaplicar da trava (D-F110) diz o texto NEUTRO da D-F186, letra a letra, no ato E no ensaio; as frases da LÁPIDE (terminar o aborto — pela metade; o `--retirar-lapide` e o ensaio do aborto — abortada) citam a WORKTREE da F2a — o aborto só existe ANTES da 1ª janela (o script recusa depois); nenhuma marca de molde; ato e ensaio iguais', async () => {
    const WORKTREE = 'a partir da WORKTREE da F2a'
    const want: [string, string[], object[], string, number][] = [
      ['metade', [TOMB], half(), WORKTREE, 1], ['abortada', [TOMB], [], WORKTREE, 2], ['D-F110', [F2A], half(), D_F186, 1],
    ]
    for (const [label, names, triggers, text, times] of want) {
      const real = await runScript([...CUT, '--vai'], db(names, { triggers }))
      const dry = await runScript([...CUT, '--dry-run'], db(names, { triggers }))
      const p = realPhrase(real.errors)
      const b = (reportsOf(dry.logs)[0]?.bloqueios ?? [])[0] ?? ''
      expect([label, p.split(text).length - 1, b.split(text).length - 1]).toEqual([label, times, times])
      expect([label, /\$\{|undefined|null/.test(p)]).toEqual([label, false])
      expect([label, b.endsWith(p)]).toEqual([label, true])
    }
  })

  // o setes-api: a frase do PRÓPRIO script do aborto (o leitor que a frase do ato manda rodar)
  const abortSrc = path.resolve(process.env.SETES_API_DIR ?? path.join(__dirname, '../../../setes-api'), 'scripts/f2a-abort-before-cutover.ts')
  const withAbort = fs.existsSync(abortSrc)
  ;(withAbort ? it : it.skip)('[DECIDIDO D-F190 (= Q-F195-SOC-04 (a); cobre a Q-F195-ADV-02) — o aborto só existe ANTES da 1ª janela: "a worktree f2a" e "o merge de novo" são o certo; era o FATO R12-ADV-05 — analisado] a D-F186 neutralizou o "de onde rodar" nas frases do ATO (nfse-api), mas o script do aborto do setes-api — o que a frase manda rodar — ainda recusa com "rode o aborto a partir da worktree f2a (a que a aplicou)" quando roda numa árvore SEM a migration da F2a: depois do merge da 1ª janela a worktree some (ou fica velha) e a frase manda a próxima virada para lá; e a frase da lápide abortada ainda manda "o merge de novo" — que só faz sentido antes do merge da 1ª janela', async () => {
    expect(fs.readFileSync(abortSrc, 'utf8')).toContain('rode o aborto a partir da worktree f2a (a que a aplicou)')
    const real = await runScript([...CUT, '--vai'], db([TOMB], { triggers: [] }))
    expect(realPhrase(real.errors)).toContain('e o merge de novo, antes da virada (D-F50)')
  })
  ;(withAbort ? it : it.skip)('[DECIDIDO D-F190 — no lugar do ACHADO R12-ADV-05] o script do aborto RECUSA quando qualquer institution da instalação já virou (`cutover_at` no `fiscal_api`) — depois do merge da 1ª janela a lápide num schema faria o boot recusar para TODOS; por isso a frase dele (e a da lápide) pode citar a worktree', () => {
    const src = fs.readFileSync(abortSrc, 'utf8')
    expect(src).toMatch(/D-F190/)
    expect(src).toMatch(/WHERE cutover_at IS NOT NULL/)
  })
})
