/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA (correções dos gates do delta combinado + Rodada 11 da F2a/F2b — 2026-10-13; skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F50/D-F110/D-F152/D-F179…D-F181, §22.32).
// Alvo: nfse-api `1779a7a..56b684d` — `f2aMissingPhrase`/`freezeMissingPhrase`: o ato REAL e o ENSAIO do `--cutover` com o MESMO texto
// também no "sem F2a" (D-F50) e nos gatilhos de trava faltando (D-F110). (O nome `adversarial-r11-gate.test.ts` já é de OUTRA rodada — a
// Rodada 11 da D-F61, 2026-10-10 — por isso este arquivo leva o prefixo `f2a-`.)
// Convenção: `failing('[ACHADO R11-ADV-NN SEV] …')` = o comportamento CERTO, hoje falha (ADV_SHOW=1 mostra a falha); `it('[FATO …]')` =
// o comportamento atual registrado (a prova executável do achado); `it('[RESISTIU] …')` = o ataque foi barrado.
// Nada aqui toca banco: o SCRIPT do ato inteiro com o pool falso (harness do gate R10, sem mudança na mecânica).
// CORREÇÃO na mesma sessão (= R11-SOC-06 do gate socrático): o ensaio interrompido DENTRO da transação imprime os bloqueios já
// conferidos — o FATO e o ACHADO do R11-ADV-01 viraram `[CORRIGIDO …]` (comparação pelo relatório JSON, o que o roteiro da janela lê).
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

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-f2a-r11-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

type Handler = (sql: string, p: any[]) => any
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
const F2A = 'f2a_fiscal_passivo'
const TOMB = 'f2a_fiscal_passivo_abortada'
const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']

/** O script INTEIRO do ato com o pool falso (molde dos gates R8–R10): exit, erros, logs e cada SQL (com a marca "dentro da transação"). */
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

/**
 * ERP com a SE viva e o fiscal_api réplica (o `db` do gate R10) + as alavancas deste gate: [live] = transmissões VIVAS na origem (o
 * setes-api ANTES da F2a ainda emite — a voz S/K existe no dia a dia); [noSe] = o ERP sem a habilitação SE.
 */
const db = (names: string[] | Error, opts: { triggers?: object[]; live?: object[]; noSe?: boolean } = {}): Handler => {
  const triggers = opts.triggers ?? freezeTriggerRows()
  let turned = false
  return (sql, p) => {
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
    if (/\._migrations WHERE name/.test(sql)) {
      if (names instanceof Error) return names
      const asked = (p ?? []).map(String)
      return [names.filter(n => asked.includes(n)).map(name => ({ x: 1, name }))]
    }
    if (FREEZE_TRIGGERS_SQL.test(sql)) return [triggers]
    if (/dps_last_number AS n FROM `setes_x`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) {
      return opts.noSe ? [[]] : [[{ model: 'SE', serie: '1', deleted: 'N', n: 10 }]]
    }
    if (/FROM `setes_x`\.tb_invoice_service_transmission t\s+LEFT JOIN/.test(sql)) return [opts.live ?? []]
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
const LIVE = [{ inv: 7223, attempt: 2 }]

/** A frase do ato real (depois de "setes_x: ") e o texto do ENSAIO (bloqueios do relatório, ou a FALHA dele quando não há relatório). */
const realPhrase = (errors: string[]): string => {
  const line = errors.find(e => e.includes('[migrate:setes] FALHA:')) ?? ''
  return line.includes('setes_x: ') ? line.slice(line.indexOf('setes_x: ') + 'setes_x: '.length) : ''
}
const bloqueiosOf = (logs: string[]): string[] => {
  for (const l of logs) { try { const j = JSON.parse(l); if (Array.isArray(j?.bloqueios)) return j.bloqueios } catch { /* não é o relatório */ } }
  return []
}
/** Tudo o que o ENSAIO diz ao operador (stdout + stderr) — onde a frase do ato tem de aparecer. */
const everythingDry = (r: { errors: string[]; logs: string[] }) => [...r.logs, ...r.errors].join('\n')

describe('R11-ADV-01 (nfse-api) — a frase única do ato × ensaio quando o ENSAIO falha DENTRO da transação', () => {
  it('[CORRIGIDO R11-ADV-01 — era o FATO; o ensaio interrompido imprime os bloqueios] com a F2a AUSENTE (o estado de TODO schema antes da janela) e uma transmissão VIVA na origem (o setes-api ainda é o caminho de produção — a voz S/K existe no dia a dia), o ATO recusa com a frase do D-F50 ("a F2a … não está aplicada") e o ENSAIO — o leitor que o roteiro da janela consulta antes do ato — sai com OUTRA coisa ("transmissão VIVA na origem — reconcilie"): os bloqueios D-F50/D-F110 só são impressos no relatório do FIM da transação, e a falha no meio (passos 1–7) os engole. O mesmo com o ERP sem a habilitação SE ("nada a virar") e com o D-F110 (trava faltando + transmissão viva)', async () => {
    const real = await runScript([...CUT, '--vai'], db([], { live: LIVE }))
    const dry = await runScript([...CUT, '--dry-run'], db([], { live: LIVE }))
    expect(real.exitCode).toBe(1)
    expect(realPhrase(real.errors)).toMatch(/^a F2a do setes-api não está aplicada neste schema/)
    expect(real.conn.beginTransaction).not.toHaveBeenCalled()
    expect(dry.exitCode).toBe(1)
    const said = everythingDry(dry)
    expect(said).toMatch(/transmissão VIVA na origem \(7223\/2\)/)                  // o erro duro segue (exit 1)…
    // …e os bloqueios já conferidos saem no relatório do ensaio interrompido, com a frase do ato
    expect(bloqueiosOf(dry.logs)).toEqual([`D-F50: a virada REAL seria recusada — ${realPhrase(real.errors)}`])
    // o ERP sem SE: o ato diz "F2a ausente"; o ensaio diz "nada a virar" E o bloqueio da F2a
    const realNoSe = await runScript([...CUT, '--vai'], db([], { noSe: true }))
    const dryNoSe = await runScript([...CUT, '--dry-run'], db([], { noSe: true }))
    expect(realPhrase(realNoSe.errors)).toMatch(/^a F2a do setes-api não está aplicada/)
    expect(everythingDry(dryNoSe)).toMatch(/o ERP não tem habilitação SE — nada a virar/)
    expect(bloqueiosOf(dryNoSe.logs)).toEqual([`D-F50: a virada REAL seria recusada — ${realPhrase(realNoSe.errors)}`])
    // D-F110: F2a aplicada, 4 gatilhos de pé, transmissão viva — o ato fala da TRAVA; o ensaio da transmissão E da trava
    const real110 = await runScript([...CUT, '--vai'], db([F2A], { triggers: half(), live: LIVE }))
    const dry110 = await runScript([...CUT, '--dry-run'], db([F2A], { triggers: half(), live: LIVE }))
    expect(realPhrase(real110.errors)).toMatch(/^gatilhos de TRAVA da F2a faltando ou diferentes em setes_x/)
    expect(bloqueiosOf(dry110.logs)).toEqual([`D-F110: a virada REAL seria recusada — ${realPhrase(real110.errors)}`])
  })

  it('[CORRIGIDO R11-ADV-01 LOW — = R11-SOC-06] o ENSAIO diz a MESMA frase do ato em TODO ramo de recusa: quando a F2a falta (ou a trava falta), a frase do D-F50 (ou do D-F110) aparece no que o ensaio imprime MESMO que ele falhe depois, dentro da transação (transmissão viva, ERP sem SE). Correção sugerida: o ensaio imprimir os bloqueios também no caminho da falha (no `catch` do ato, com DRY) — ou anexá-los à mensagem; nunca o operador da janela corrigir uma coisa, rodar o ensaio de novo e só então descobrir a outra', async () => {
    for (const [label, names, opts, phrase] of [
      ['sem-F2a+viva', [], { live: LIVE }, 'não está aplicada neste schema'],
      ['sem-F2a+sem-SE', [], { noSe: true }, 'não está aplicada neste schema'],
      ['D-F110+viva', [F2A], { triggers: half(), live: LIVE }, 'gatilhos de TRAVA da F2a faltando'],
    ] as [string, string[], any, string][]) {
      const real = await runScript([...CUT, '--vai'], db(names, opts))
      const dry = await runScript([...CUT, '--dry-run'], db(names, opts))
      expect([label, realPhrase(real.errors).includes(phrase)]).toEqual([label, true])
      // o relatório do ensaio (o JSON que o roteiro da janela lê) — mesmo interrompido pelo erro duro
      expect([label, bloqueiosOf(dry.logs).some(b => b.endsWith(` — ${realPhrase(real.errors)}`))]).toEqual([label, true])
    }
  })
})

describe('R11-ADV-05 (nfse-api, analisado) — o "de onde rodar" das frases depois da janela', () => {
  it('[FATO — prova do R11-ADV-05 LOW (analisado); base da Q-F190-ADV-05] as frases que mandam rodar um script do setes-api (o reaplicar da trava — D-F110, NOVA neste delta; terminar o aborto e o `--retirar-lapide` — R9) dizem "a partir da WORKTREE da F2a": vale até a janela; depois do merge da F2a na árvore principal, a virada das PRÓXIMAS institutions (o ato é por institution — D-F3, alvo 1000 clientes) chega com a frase apontando para uma worktree que já não é a árvore em produção (ou nem existe) — rodar dali usaria a migration/conferência de uma cópia possivelmente velha', async () => {
    const r = await runScript([...CUT, '--vai'], db([F2A], { triggers: half() }))
    expect(realPhrase(r.errors)).toContain('a partir da WORKTREE da F2a do setes-api')
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/migrate-from-setes-api.ts'), 'utf8')
    expect((src.match(/a partir da WORKTREE da F2a/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

describe('a frase única nos ramos que RESISTIRAM', () => {
  it('[RESISTIU] sem a tabela de controle (`_migrations` inexistente — errno 1146): "sem F2a" — o ato e o ensaio dizem o MESMO texto (igualdade); leitura do `_migrations` com OUTRO erro (permissão) = o MESMO erro nos dois, nada gravado', async () => {
    const noTable = Object.assign(new Error("Table 'setes_x._migrations' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
    const real = await runScript([...CUT, '--vai'], db(noTable))
    const dry = await runScript([...CUT, '--dry-run'], db(noTable))
    const pd = (bloqueiosOf(dry.logs)[0] ?? '').replace(/^D-F50: a virada REAL seria recusada — /, '')
    expect(realPhrase(real.errors)).toBe(pd)
    expect(pd).toMatch(/^a F2a do setes-api não está aplicada neste schema/)
    const denied = Object.assign(new Error('SELECT command denied to user'), { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' })
    const r2 = await runScript([...CUT, '--vai'], db(denied))
    const d2 = await runScript([...CUT, '--dry-run'], db(denied))
    expect([r2.exitCode, d2.exitCode]).toEqual([1, 1])
    expect(r2.errors.join('\n')).toContain('SELECT command denied to user')
    expect(d2.errors.join('\n')).toContain('SELECT command denied to user')
    expect([r2.sqls.some(s => isWrite(s.sql)), d2.sqls.some(s => isWrite(s.sql))]).toEqual([false, false])
  })

  it('[RESISTIU] a precedência das frases é a MESMA no ato e no ensaio: lápide SEM a linha da F2a = a frase da LÁPIDE (nunca a do "sem F2a"); a linha + lápide = "juntas"; e com a F2a ausente o D-F110 NÃO é conferido (sem frase de trava) — nos dois', async () => {
    for (const [names, want] of [[[TOMB], /^a F2a do setes-api foi ABORTADA em setes_x/], [[F2A, TOMB], /^a linha "f2a_fiscal_passivo" E a lápide/]] as [string[], RegExp][]) {
      const real = await runScript([...CUT, '--vai'], db(names, { triggers: [] }))
      const dry = await runScript([...CUT, '--dry-run'], db(names, { triggers: [] }))
      expect(realPhrase(real.errors)).toMatch(want)
      expect(bloqueiosOf(dry.logs)).toHaveLength(1)
      expect(bloqueiosOf(dry.logs)[0]).toContain(realPhrase(real.errors))
      expect(bloqueiosOf(dry.logs).some(b => b.startsWith('D-F110'))).toBe(false)
    }
  })

  it('[RESISTIU] as duas frases NOVAS nunca saem com marcas de molde (`${…}`, "undefined", "null") nem com a lista de gatilhos vazia "()"; os comandos citados existem com a sintaxe citada (o reaplicar aceita `<schema> --vai`; o ensaio dele é sem `--vai`)', async () => {
    const r1 = await runScript([...CUT, '--vai'], db([]))
    const r2 = await runScript([...CUT, '--vai'], db([F2A], { triggers: half() }))
    for (const p of [realPhrase(r1.errors), realPhrase(r2.errors)]) {
      expect(p.length).toBeGreaterThan(60)
      expect(p).not.toMatch(/\$\{|undefined|null|\(\)/)
    }
    expect(realPhrase(r2.errors)).toMatch(/\(tg_f2a_freeze_\w+ ausente; /)            // a lista dos que faltam vai na frase
    const reapply = path.resolve(process.env.SETES_API_DIR ?? path.join(__dirname, '../../../setes-api'), 'scripts/f2a-reapply-freeze.ts')
    if (fs.existsSync(reapply)) {
      const src = fs.readFileSync(reapply, 'utf8')
      expect(src).toContain("scripts/f2a-reapply-freeze.ts <schema setes_*> [--vai]")
    }
  })
})
