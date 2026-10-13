/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA COMBINADO (correções dos gates da Rodada 9 + Rodada 10 — 2026-10-13; skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F50/D-F153/D-F162, §22.28). Alvo: nfse-api
// `0e1ae9d..1779a7a` — `tombstonePhrase`: UMA frase por estado da lápide (linha + lápide · aborto pela metade · abortada) para o ATO real
// e o ENSAIO. Aqui: a frase é a MESMA (igualdade, não só o mesmo padrão) nos três estados e nas bordas da contagem "de pé".
// Convenção: `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Nada aqui toca banco: o SCRIPT do ato inteiro com o pool falso (harness copiado do gate R9, sem mudança).
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

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r10-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

type Handler = (sql: string, p: any[]) => any
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
const F2A = 'f2a_fiscal_passivo'
const TOMB = 'f2a_fiscal_passivo_abortada'
const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']

/** O script INTEIRO do ato com o pool falso (molde do gate R8): exit, erros, logs e cada SQL (com a marca "dentro da transação"). */
async function runScript(argv: string[], handler: Handler) {
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
  const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, conn, sqls }
  exit.mockRestore(); err.mockRestore(); log.mockRestore()
  return res
}

/** ERP com a SE viva e o fiscal_api réplica. [names] = linhas do `_migrations` (pelo NOME pedido) ou o erro da leitura; [triggers] = information_schema. */
const db = (names: string[] | Error, triggers: object[] | Error = freezeTriggerRows()): Handler => {
  let turned = false
  return (sql, p) => {
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
    if (/\._migrations WHERE name/.test(sql)) {
      if (names instanceof Error) return names
      const asked = (p ?? []).map(String)
      return [names.filter(n => asked.includes(n)).map(name => ({ x: 1, name }))]
    }
    if (FREEZE_TRIGGERS_SQL.test(sql)) return triggers instanceof Error ? triggers : [triggers]
    if (/dps_last_number AS n FROM `setes_x`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) return [[{ model: 'SE', serie: '1', deleted: 'N', n: 10 }]]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [[{ model: 'SE', c: null }]]
    if (/information_schema\.tables/.test(sql)) return [[{ x: 1 }]]
    if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \?$/.test(sql.trim())) {
      return [[{ tb_institution_id: 1, model: 'SE', environment: 'P', serie: '1', dps_last_number: 10, tb_user_id: null, created_at: null, updated_at: null, deleted: 'N' }]]
    }
    if (/invoice_event IS NULL/.test(sql)) return [[{ n: 0 }]]
    if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(sql)) return [[{ m: 0 }]]
    if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: turned ? 0 : 1 }]]
    if (/^\s*UPDATE tb_establishment_issuer SET cutover_at/.test(sql)) { turned = true; return [{ affectedRows: 1 }] }
    if (/UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(sql)) return [{ affectedRows: 1 }]
    return undefined
  }
}
const half = () => freezeTriggerRows().slice(0, 4)
const bloqueiosOf = (logs: string[]): string[] => {
  for (const l of logs) { try { const j = JSON.parse(l); if (Array.isArray(j?.bloqueios)) return j.bloqueios } catch { /* não é o relatório */ } }
  return []
}
const reportOf = (logs: string[]): any => {
  for (const l of logs) { try { const j = JSON.parse(l); if (j && typeof j === 'object' && 'dryRun' in j) return j } catch { /* não é o relatório */ } }
  return null
}


const PREFIX_DRY = 'D-F50: a virada REAL seria recusada — '
/** A frase do estado: do ato real ("[migrate:setes] FALHA: setes_x: <frase>") e do ensaio ("D-F50: a virada REAL seria recusada — <frase>"). */
const realPhrase = (errors: string[]): string => {
  const line = errors.find(e => e.includes('[migrate:setes] FALHA:')) ?? ''
  return line.includes('setes_x: ') ? line.slice(line.indexOf('setes_x: ') + 'setes_x: '.length) : ''
}
const dryPhrase = (logs: string[]): string => {
  const b = bloqueiosOf(logs).find(x => x.startsWith(PREFIX_DRY)) ?? ''
  return b.slice(PREFIX_DRY.length)
}
/** Gatilhos de pé com o CORPO trocado (DROP + CREATE à mão, versão antiga): o ato os conta como "de pé" (só "ausente" sai da conta). */
const altered = (n: number) => (freezeTriggerRows() as any[]).slice(0, n).map((r, i) => (i % 2 ? { ...r, body: 'BEGIN END' } : r))

describe('tombstonePhrase — o ato e o ensaio dizem a MESMA frase', () => {
  it('[RESISTIU] IGUALDADE (não só o mesmo padrão): nos três estados — linha + lápide, pela METADE (4, 9 e com corpos trocados), abortada (0 visíveis) — o texto do ato real depois de "setes_x: " é IDÊNTICO ao do bloqueio do ensaio depois de "D-F50: a virada REAL seria recusada — "; o ato sai com 1 sem abrir transação nem gravar, o ensaio sai sem erro, desfaz e tem UM bloqueio', async () => {
    const cases: [string, string[], object[], RegExp][] = [
      ['juntas', [F2A, TOMB], freezeTriggerRows(), /^a linha "f2a_fiscal_passivo" E a lápide "f2a_fiscal_passivo_abortada" juntas em setes_x\._migrations/],
      ['metade-4', [TOMB], freezeTriggerRows().slice(0, 4), /^a F2a do setes-api foi ABORTADA em setes_x, mas o aborto ficou PELA METADE \(4 gatilho\(s\) de trava de pé/],
      ['metade-9', [TOMB], freezeTriggerRows(), /PELA METADE \(9 gatilho/],
      ['metade-corpo-trocado', [TOMB], altered(5), /PELA METADE \(5 gatilho/],
      ['abortada', [TOMB], [], /^a F2a do setes-api foi ABORTADA em setes_x \(lápide "f2a_fiscal_passivo_abortada" — D-F153\/D-F162\) — voltar à F2a = /],
    ]
    for (const [label, names, trg, want] of cases) {
      const real = await runScript([...CUT, '--vai'], db(names, trg))
      const dry = await runScript([...CUT, '--dry-run'], db(names, trg))
      const [pr, pd] = [realPhrase(real.errors), dryPhrase(dry.logs)]
      expect([label, pr.length > 40, pr === pd]).toEqual([label, true, true])
      expect([label, want.test(pr)]).toEqual([label, true])
      expect([label, real.exitCode, real.conn.beginTransaction.mock.calls.length, real.sqls.some(s => isWrite(s.sql))]).toEqual([label, 1, 0, false])
      expect([label, dry.exitCode, bloqueiosOf(dry.logs).length, reportOf(dry.logs)?.committed]).toEqual([label, null, 1, false])
    }
  })

  it('[CORRIGIDO R10-SOC-05 LOW — gate socrático] a frase única vale também FORA da lápide: "sem F2a" e D-F110 (gatilhos de trava faltando com a F2a aplicada) — o ato real e o ensaio dizem o MESMO texto, com o porquê e o comando que resolve (aplicar a F2a; `scripts/f2a-reapply-freeze.ts <schema> --vai` a partir da WORKTREE da F2a)', async () => {
    const prefix110 = 'D-F110: a virada REAL seria recusada — '
    const noF2a = [await runScript([...CUT, '--vai'], db([])), await runScript([...CUT, '--dry-run'], db([]))]
    expect(realPhrase(noF2a[0].errors)).toBe(dryPhrase(noF2a[1].logs))
    expect(realPhrase(noF2a[0].errors)).toMatch(/^a F2a do setes-api não está aplicada neste schema — migration "f2a_fiscal_passivo" \(F2a do setes-api\) ausente em setes_x\._migrations; [\s\S]*aplique a F2a antes da virada \(D-F50\)$/)
    const freeze = [await runScript([...CUT, '--vai'], db([F2A], half())), await runScript([...CUT, '--dry-run'], db([F2A], half()))]
    const dry110 = (bloqueiosOf(freeze[1].logs).find(x => x.startsWith(prefix110)) ?? '').slice(prefix110.length)
    expect([freeze[0].exitCode, freeze[0].conn.beginTransaction.mock.calls.length, bloqueiosOf(freeze[1].logs).length]).toEqual([1, 0, 1])
    expect(realPhrase(freeze[0].errors)).toBe(dry110)
    expect(dry110).toMatch(/^gatilhos de TRAVA da F2a faltando ou diferentes em setes_x \([\s\S]*`scripts\/f2a-reapply-freeze\.ts <schema> --vai` a partir da árvore do setes-api com a F2a \(a worktree até a janela; a árvore principal depois\) \(D-F152; D-F110\)$/)   // D-F186
  })

  it('[FATO] com a lápide e o usuário SEM o privilégio TRIGGER (o information_schema esconde os gatilhos — 0 visíveis) o ato e o ensaio dizem "abortada" — e a MESMA frase manda conferir pelo ensaio do aborto a partir da WORKTREE da F2a (o leitor que distingue "abortada" de "metade" sem o privilégio)', async () => {
    const real = await runScript([...CUT, '--vai'], db([TOMB], []))
    expect(realPhrase(real.errors)).toMatch(/Se o usuário do ato não tem o privilégio TRIGGER, gatilhos de pé não aparecem aqui — o ensaio do aborto \(sem --vai\), a partir da WORKTREE da F2a, diz o estado real$/)   // D-F190: a lápide cita a worktree
  })
})
