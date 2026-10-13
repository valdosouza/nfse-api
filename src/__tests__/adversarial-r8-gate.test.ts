/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 8 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F50/D-F110/D-F153/D-F162). Alvo: nfse-api `7bf6ea9..267b4b0` — o ato `migrate:setes --cutover`
// lê a LÁPIDE da F2a abortada SEMPRE (falha fechado), linha + lápide = recusa (R7-SOC-05/R7-ADV-03), lápide + gatilhos de trava de pé =
// "termine o aborto" (R7-ADV-04); textos (.env.example, JSDoc do `mapTx`).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R8-ADV-NN SEV] …')` (descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r8-gate --runInBand
// Nada aqui toca banco: o SCRIPT do ato inteiro com o pool falso (molde do f1r10/R7); a cerca cruzada lê o FONTE do setes-api.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { F2A_FREEZE_TRIGGERS } from '../../scripts/cutover-erp'
import { FREEZE_TRIGGERS_SQL, freezeTriggerRows } from './fixture-freeze-triggers'
import { SETES_API_DIR } from './voice-kind-fence'

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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r8-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

type Handler = (sql: string, p: any[]) => any
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
const F2A = 'f2a_fiscal_passivo'
const TOMB = 'f2a_fiscal_passivo_abortada'
const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']

/** O script INTEIRO do ato com o pool falso (molde do gate R7): devolve exit, erros, logs e cada SQL (com a marca "dentro da transação"). */
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

/** ERP com a SE viva e o fiscal_api réplica. [names] = linhas do `_migrations` (respondidas pelo NOME pedido); [triggers] = information_schema. */
const db = (names: string[], triggers: object[] | Error = freezeTriggerRows()): Handler => {
  let turned = false
  return (sql, p) => {
    if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
    if (/\._migrations WHERE name/.test(sql)) {
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

// =================================================================================================
// 1. O ENSAIO (--dry-run) × o ato REAL nos estados novos da lápide
// =================================================================================================
describe('1 — o ensaio diz o que o ato real diria?', () => {
  it('[CORRIGIDO R8-ADV-02 LOW — R8-SOC-03] ABORTO PELA METADE (lápide + 4 dos 9 gatilhos de trava de pé): o ato REAL recusa com o diagnóstico novo ("o aborto ficou PELA METADE … termine o aborto: `f2a-abort-before-cutover.ts … --vai --confirmo-setes-api-parado`" — R7-ADV-04), mas o ENSAIO (`--cutover` sem `--vai`), que é o que o operador roda ANTES na JANELA para ver o que vai acontecer, só lista o bloqueio genérico "a F2a do setes-api foi ABORTADA" — sem "pela metade", sem os gatilhos que sobraram, sem o comando que resolve (o `abortHalfway` é CALCULADO no ensaio e jogado fora; os gatilhos nem entram no D-F110 porque a F2a conta como ausente). Quem lê o ensaio vai para o `--retirar-lapide` — que RECUSA esse estado. Correção sugerida: o bloqueio do ensaio usa a MESMA frase do ato real (pela metade + quantos + o comando)', async () => {
    const dry = await runScript([...CUT, '--dry-run'], db([TOMB], half()))
    expect(dry.exitCode).toBeNull()
    expect(bloqueiosOf(dry.logs).join(' ')).toMatch(/PELA METADE[\s\S]*4 gatilho/)
  })

  it('[CORRIGIDO R8-ADV-02 LOW — R8-SOC-03] LINHA + LÁPIDE juntas (só nasce de SQL à mão): o ato REAL recusa com a frase própria ("a linha … E a lápide … juntas … confira antes" — R7-SOC-05), o ENSAIO diz só "ABORTADA" (a frase do caminho do `--retirar-lapide`, que também RECUSA esse estado). Dois relatórios do MESMO ato, dois diagnósticos. Correção sugerida: o bloqueio do ensaio distingue "juntas" como o ato real', async () => {
    const dry = await runScript([...CUT, '--dry-run'], db([F2A, TOMB]))
    expect(dry.exitCode).toBeNull()
    expect(bloqueiosOf(dry.logs).join(' ')).toMatch(/juntas/)
  })

  it.skip('[SUPERADO pelo R8-ADV-02 corrigido — o ensaio distingue os três estados] o FATO de antes: nos dois estados o ensaio termina (exit null, rollback), o bloqueio é o MESMO texto ("ABORTADA … lápide") e nenhum D-F110 aparece; o ato real (`--vai`) dá as duas frases DIFERENTES — "PELA METADE (… 4 gatilho(s) de trava de pé)" e "… E a lápide … juntas"', async () => {
    const dryHalf = await runScript([...CUT, '--dry-run'], db([TOMB], half()))
    const dryBoth = await runScript([...CUT, '--dry-run'], db([F2A, TOMB]))
    const bh = bloqueiosOf(dryHalf.logs), bb = bloqueiosOf(dryBoth.logs)
    expect([bh.length, bb.length, bh[0] === bb[0], /ABORTADA/.test(bh[0]), bh.some(b => /D-F110/.test(b))]).toEqual([1, 1, true, true, false])
    expect([dryHalf.conn.rollback.mock.calls.length > 0, dryHalf.conn.commit.mock.calls.length]).toEqual([true, 0])
    const realHalf = await runScript([...CUT, '--vai'], db([TOMB], half()))
    const realBoth = await runScript([...CUT, '--vai'], db([F2A, TOMB]))
    expect(realHalf.errors.join(' ')).toMatch(/PELA METADE[\s\S]*4 gatilho\(s\) de trava de pé/)
    expect(realBoth.errors.join(' ')).toMatch(/E a lápide[\s\S]*juntas/)
  })
})

// =================================================================================================
// 2. O ato REAL contra os estados da lápide (falha fechado, nada escrito)
// =================================================================================================
describe('2 — o ato real nos estados da lápide', () => {
  it('[RESISTIU] lápide + os 9 gatilhos (a conexão caiu logo depois da lápide, antes do 1º DROP): "PELA METADE … 9 gatilho(s)" — nenhuma transação, nada escrito, a frase manda RODAR O ABORTO de novo (e só depois, se for o caso, o `--retirar-lapide`)', async () => {
    const r = await runScript([...CUT, '--vai'], db([TOMB]))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/PELA METADE[\s\S]*9 gatilho\(s\)[\s\S]*f2a-abort-before-cutover\.ts <schema> <institutionId> --vai --confirmo-setes-api-parado/)
    expect([r.conn.beginTransaction.mock.calls.length, r.sqls.some(s => isWrite(s.sql))]).toEqual([0, false])
  })

  it('[RESISTIU] gatilho com o NOME da trava mas em OUTRA tabela, ou com o corpo trocado ("diferente"), conta como DE PÉ na metade (a contagem é pelo nome — só "ausente" desconta): lápide + 2 "diferentes" = "PELA METADE … 2 gatilho(s)"', async () => {
    const [n1, n2] = Object.keys(F2A_FREEZE_TRIGGERS)
    const odd = [
      { name: n1, tbl: 'tb_outra', ev: 'INSERT', timing: 'BEFORE', body: 'BEGIN END' },
      { name: n2, tbl: F2A_FREEZE_TRIGGERS[n2][0], ev: F2A_FREEZE_TRIGGERS[n2][1], timing: 'BEFORE', body: 'BEGIN END' },
    ]
    const r = await runScript([...CUT, '--vai'], db([TOMB], odd))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/PELA METADE[\s\S]*2 gatilho\(s\)/)
  })

  it('[RESISTIU — falha fechado] com a lápide, a leitura dos GATILHOS que falha (conexão caiu / sem permissão no information_schema): o erro sobe CRU, exit 1, nenhuma transação, nada escrito — nunca vira "aborto completo" (a frase do `--retirar-lapide`)', async () => {
    const r = await runScript([...CUT, '--vai'], db([TOMB], Object.assign(new Error('Lost connection to server during query'), { code: 'PROTOCOL_CONNECTION_LOST' })))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/Lost connection/)
    expect(r.errors.join(' ')).not.toMatch(/--retirar-lapide/)
    expect([r.conn.beginTransaction.mock.calls.length, r.sqls.some(s => isWrite(s.sql))]).toEqual([0, false])
  })

  it('[FATO — limite conhecido] lápide e NENHUM gatilho visível = a frase do `--retirar-lapide` — o ato não distingue "o aborto derrubou os 9" de "o usuário do ato não tem o privilégio TRIGGER" (o `information_schema` esconde o gatilho de quem não o tem). Hoje inofensivo: o ato REAL escreve no ERP (aposenta a SE — D-F44), então roda com o DONO, que vê os gatilhos; e o `--retirar-lapide` do setes-api confere de novo e recusa "lápide COM gatilho"', async () => {
    const r = await runScript([...CUT, '--vai'], db([TOMB], []))
    expect(r.errors.join(' ')).toMatch(/ABORTADA[\s\S]*--retirar-lapide --vai/)
    expect(r.errors.join(' ')).not.toMatch(/PELA METADE/)
  })

  it('[RESISTIU] a ORDEM das leituras do ato: o `_migrations` (F2a, depois a lápide) e os gatilhos — tudo em autocommit, ANTES de qualquer transação; nos estados de recusa nenhuma leitura de ERP/fiscal_api além delas acontece', async () => {
    for (const [names, trg] of [[[TOMB], half()], [[F2A, TOMB], freezeTriggerRows()], [[TOMB], []]] as [string[], object[]][]) {
      const r = await runScript([...CUT, '--vai'], db(names, trg))
      const reads = r.sqls.map(s => s.sql)
      expect(r.sqls.every(s => !s.tx)).toBe(true)
      expect(reads.filter(s => !/setes_central\.tb_institution|_migrations|information_schema\.TRIGGERS/.test(s))).toEqual([])
    }
  })
})

// =================================================================================================
// 3. Cerca cruzada: os comandos que as frases do ato mandam rodar EXISTEM no setes-api, com as flags que ele aceita
// =================================================================================================
describe('3 — as frases do ato apontam para comandos de verdade (SETES_API_DIR)', () => {
  it('[RESISTIU] `f2a-abort-before-cutover.ts <schema> <institutionId> --vai --confirmo-setes-api-parado` (pela metade) e `--retirar-lapide --vai` (abortada): o script existe, as flags são as constantes dele (`CONFIRM_STOPPED`/`RESUME_FLAG`) e o `--vai` do aborto exige exatamente a confirmação nomeada; `f2a-reapply-freeze.ts` (gatilho faltando com a F2a aplicada) também existe. Sem a F2a no SETES_API_DIR, nada a comparar', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
    expect(script).toMatch(/f2a-abort-before-cutover\.ts <schema> <institutionId> --vai `\s*\+ '--confirmo-setes-api-parado`/)
    expect(script).toMatch(/f2a-abort-before-cutover\.ts <schema> <institutionId> --retirar-lapide --vai/)
    const abort = path.join(SETES_API_DIR, 'scripts', 'f2a-abort-before-cutover.ts')
    if (!fs.existsSync(abort)) return
    const src = fs.readFileSync(abort, 'utf8')
    expect(/export const CONFIRM_STOPPED = '([^']+)'/.exec(src)?.[1]).toBe('--confirmo-setes-api-parado')
    expect(/export const RESUME_FLAG = '([^']+)'/.exec(src)?.[1]).toBe('--retirar-lapide')
    expect(src).toMatch(/if \(!resume && vai && !rest\.includes\(CONFIRM_STOPPED\)\)/)
    expect(fs.existsSync(path.join(SETES_API_DIR, 'scripts', 'f2a-reapply-freeze.ts'))).toBe(true)
  })

  it('[RESISTIU] o .env.example novo bate com o setes-api: o kid do caminho único é "default" e o JWT_KID do setes-api também nasce "default" (`product-token.ts`); a forma da lista é `kid=caminho` separada por vírgula, como o `fromEnv` do núcleo lê', () => {
    const ex = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8')
    expect(ex).toMatch(/JWT_PUBLIC_KEY_PATH = um caminho \(kid "default"/)
    expect(ex).toMatch(/JWT_PUBLIC_KEYS="default=\.\/secrets\/jwt\/anterior\.pem,k2=\.\/secrets\/jwt\/nova\.pem"/)
    const tok = path.join(SETES_API_DIR, 'src', 'shared', 'auth', 'product-token.ts')
    if (!fs.existsSync(tok)) return
    expect(fs.readFileSync(tok, 'utf8')).toMatch(/String\(env\.JWT_KID \?\? 'default'\)/)
  })
})
