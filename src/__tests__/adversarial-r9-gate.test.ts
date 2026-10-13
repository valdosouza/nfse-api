/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 9 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F50/D-F110/D-F153/D-F162, §22.13 roteiro da JANELA). Alvo: nfse-api `267b4b0..0e1ae9d` — o ENSAIO
// (`migrate:setes --cutover` sem `--vai`) distingue os três estados da lápide (linha + lápide · aborto pela metade · abortada) "com as
// frases do ato real" (R8-SOC-03); a frase do ato real ganhou "a partir da WORKTREE da F2a" e a ressalva do privilégio TRIGGER.
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R9-ADV-NN SEV] …')` (descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado (a prova executável do achado).
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r9-gate --runInBand
// Nada aqui toca banco: o SCRIPT do ato inteiro com o pool falso (molde dos gates R7/R8).
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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r9-'))
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

// =================================================================================================
// 1. O ENSAIO diz o que o ato real diria? (R8-SOC-03: "com as frases do ato real")
// =================================================================================================
describe('1 — o ensaio × o ato real nos três estados da lápide', () => {
  it('[CORRIGIDO R9-ADV-04 LOW — uma frase por estado para o ato e o ensaio] o ENSAIO distingue os três estados (certo), mas NÃO com as frases do ato real: "PELA METADE" sai sem o comando que resolve (`f2a-abort-before-cutover.ts <schema> <institutionId> --vai --confirmo-setes-api-parado` a partir da WORKTREE da F2a — o ato real dá) e "ABORTADA" sai sem o caminho de volta (`--retirar-lapide --vai`) e SEM a ressalva nova do privilégio TRIGGER ("gatilhos de pé não aparecem aqui — o ensaio do aborto … diz o estado real"). O ensaio é o que o roteiro da janela lê ANTES do ato (o próprio comentário do R8-SOC-03); o R8-ADV-02 pedia "a MESMA frase do ato real (pela metade + quantos + o comando)". O caso que importa: lápide e NENHUM gatilho visível para o usuário do ensaio (o `information_schema` esconde o gatilho de quem não tem TRIGGER) — o ensaio diz "ABORTADA" seco, quem o lê vai ao `--retirar-lapide`, que recusa ("lápide COM gatilho"). Correção sugerida: o bloqueio do ensaio reusa o TEXTO do erro do ato real (uma função que monta a frase para os dois)', async () => {
    const dryHalf = bloqueiosOf((await runScript([...CUT, '--dry-run'], db([TOMB], half()))).logs).join(' ')
    const dryDone = bloqueiosOf((await runScript([...CUT, '--dry-run'], db([TOMB], []))).logs).join(' ')
    expect(dryHalf).toMatch(/f2a-abort-before-cutover\.ts <schema> <institutionId> --vai[\s\S]*--confirmo-setes-api-parado/)
    expect(dryDone).toMatch(/--retirar-lapide --vai/)
    expect(dryDone).toMatch(/privilégio TRIGGER/)
  })

  it.skip('[SUPERADO pelo R9-ADV-04 corrigido — o ensaio usa a MESMA frase do ato] o FATO de antes: o ATO real e o ENSAIO, no MESMO estado: (a) pela metade — o ato manda rodar o aborto da WORKTREE com as duas flags; o ensaio diz só "termine o aborto"; (b) lápide e nenhum gatilho visível (o aborto acabou OU o usuário não tem TRIGGER) — o ato dá o `--retirar-lapide` E a ressalva do TRIGGER; o ensaio dá só "foi ABORTADA … (lápide …)"', async () => {
    const realHalf = (await runScript([...CUT, '--vai'], db([TOMB], half()))).errors.join(' ')
    const dryHalf = bloqueiosOf((await runScript([...CUT, '--dry-run'], db([TOMB], half()))).logs).join(' ')
    expect(realHalf).toMatch(/termine o aborto: `scripts\/f2a-abort-before-cutover\.ts <schema> <institutionId> --vai --confirmo-setes-api-parado` a partir da WORKTREE/)
    expect(dryHalf).toMatch(/PELA METADE \(4 gatilho\(s\) de trava de pé\) — termine o aborto \(D-F153\/D-F162\)$/)
    expect(dryHalf).not.toMatch(/f2a-abort-before-cutover|WORKTREE/)
    const realDone = (await runScript([...CUT, '--vai'], db([TOMB], []))).errors.join(' ')
    const dryDone = bloqueiosOf((await runScript([...CUT, '--dry-run'], db([TOMB], []))).logs).join(' ')
    expect(realDone).toMatch(/--retirar-lapide --vai[\s\S]*Se o usuário do ato não tem o privilégio TRIGGER/)
    expect(dryDone).toMatch(/foi ABORTADA em setes_x \(lápide "f2a_fiscal_passivo_abortada" — D-F153\/D-F162\)$/)
    expect(dryDone).not.toMatch(/retirar-lapide|TRIGGER/)
  })

  it('[RESISTIU] os três estados no ENSAIO: cada um com UM bloqueio D-F50 e a frase do seu estado ("juntas" · "PELA METADE (N)" · "foi ABORTADA"), nenhum D-F110 (os gatilhos não são conferidos com a F2a ausente), o ato inteiro roda DENTRO da transação e é DESFEITO (rollback, zero commit) — e "juntas" vence "metade" (linha + lápide + 4 gatilhos = "juntas"); lápide + os 9 (o aborto caiu antes do 1º DROP) = "PELA METADE (9"', async () => {
    const cases: [string[], object[], RegExp][] = [
      [[F2A, TOMB], half(), /E a lápide[\s\S]*juntas/],
      [[TOMB], half(), /PELA METADE \(4 gatilho/],
      [[TOMB], freezeTriggerRows(), /PELA METADE \(9 gatilho/],
      [[TOMB], [], /foi ABORTADA em setes_x \(lápide/],
      [[], [], /migration "f2a_fiscal_passivo" \(F2a do setes-api\) ausente/],
    ]
    for (const [names, trg, want] of cases) {
      const r = await runScript([...CUT, '--dry-run'], db(names, trg))
      const b = bloqueiosOf(r.logs)
      expect([r.exitCode, b.length, b.filter(x => /^D-F50/.test(x)).length, b.some(x => /D-F110/.test(x))]).toEqual([null, 1, 1, false])
      expect(b[0]).toMatch(want)
      if (names.includes(F2A)) expect(b[0]).not.toMatch(/PELA METADE/)
      expect([r.conn.commit.mock.calls.length, r.conn.rollback.mock.calls.length > 0, reportOf(r.logs)?.committed]).toEqual([0, true, false])
      expect(r.sqls.filter(s => isWrite(s.sql)).every(s => s.tx)).toBe(true)
    }
  })

  it('[RESISTIU — falha fechado também no ENSAIO] a leitura dos GATILHOS que falha com a lápide (conexão caída) e a leitura da LÁPIDE que falha por permissão (ER_TABLEACCESS_DENIED_ERROR 1142 — não é o 1146 "sem _migrations"): o ensaio termina com exit 1, SEM relatório de bloqueios, sem abrir transação — nunca vira "abortada" nem "ausente"', async () => {
    const lost = Object.assign(new Error('Lost connection to server during query'), { code: 'PROTOCOL_CONNECTION_LOST' })
    const denied = Object.assign(new Error("SELECT command denied to user 'x' for table '_migrations'"), { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' })
    for (const h of [db([TOMB], lost), db(denied)]) {
      const r = await runScript([...CUT, '--dry-run'], h)
      expect([r.exitCode, bloqueiosOf(r.logs).length, reportOf(r.logs), r.conn.beginTransaction.mock.calls.length]).toEqual([1, 0, null, 0])
      expect(r.errors.join(' ')).toMatch(/Lost connection|command denied/)
    }
  })

  it('[RESISTIU] schema SEM `_migrations` (1146): o ensaio diz "ausente" (nunca "abortada") e o ato real recusa com a frase de aplicar a F2a', async () => {
    const noTable = Object.assign(new Error("Table 'setes_x._migrations' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
    const dry = await runScript([...CUT, '--dry-run'], db(noTable))
    expect(bloqueiosOf(dry.logs).join(' ')).toMatch(/ausente em setes_x\._migrations/)
    const real = await runScript([...CUT, '--vai'], db(noTable))
    expect([real.exitCode, /aplique a F2a antes da virada/.test(real.errors.join(' '))]).toEqual([1, true])
  })
})
