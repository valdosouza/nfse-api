/// <reference types="jest" />
// GATE ADVERSARIAL do delta das APIs fiscais (sessão 2026-10-10) — nfse-api, só unit (nenhum banco: os processos filhos
// apontam para uma porta MORTA e um usuário inexistente — o `import 'dotenv/config'` do script NÃO sobrescreve variável já
// definida). Alvos:
//  - M3 (`scripts/migrate-from-setes-api.ts` `argumentErrors`): lista FECHADA de argumentos; o ATO é ensaio por padrão.
//  - D-F47 (`hasFiscalObligation`/`institutionHasFiscalObligation`): o que conta como "obrigação já assumida".
// Achados (os `it.failing` fixam o estado atual; a correção é do Valdo):
//  - [LOW ADV-R8-03] argumento REPETIDO e id NÃO canônico passam: `--cutover 1 --cutover abc` vira o ato da institution 1
//    (o 1º vence, o 2º é ignorado em silêncio); `--cutover 0x1`/`1e0`/`01` viram a institution 1.
//  - [LOW ADV-R8-04] o npm ENGOLE a flag escrita sem o separador `--`: `npm run migrate:setes --dry-run` chega ao script SEM
//    argumento (o npm a guarda em `npm_config_dry_run`) → a RE-SINCRONIA grava no `fiscal_api` (o ato continua protegido:
//    o `--vai` engolido vira ensaio; e o `1` solto de `--cutover 1` vira "argumento desconhecido").
//  - [LOW ADV-R8-05] as duas consultas de obrigação discordam em `terminal`: a da nota exige `terminal = 0`, a da institution
//    (passada do rodízio) conta qualquer terminal.
//  - [LOW ADV-R8-07] (gêmeo do setes-api) o xMotivo leva não-caractere XML / surrogate solto ao XML assinado — sem 500.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { argumentErrors } from '../../scripts/migrate-from-setes-api'
import { hasFiscalObligation, institutionHasFiscalObligation } from '../nfse/repository'
import { normalizeCancelMotive } from '../nfse/transmission'

const ROOT = path.resolve(__dirname, '..', '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r8-'))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

/** Ambiente MORTO: porta 1 (recusa) + usuário/banco inexistentes — mesmo que conectasse, não autenticaria. */
const DEAD_ENV = {
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'adv_r8_ninguem', DB_PASSWORD: 'x', FISCAL_DB_NAME: 'fiscal_api_adv_r8_morto',
  FISCAL_MASTER_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}`, STORAGE_PATH: TMP, SETES_SECRETS_PATH: TMP,
}
const npmArgsEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_/i.test(k)))
/** O script como o operador o chama — `npm run migrate:setes <args>` (cmd.exe no Windows, sem PowerShell no meio). */
function viaNpm(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('npm', ['run', 'migrate:setes', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 120_000,
    env: { ...npmArgsEnv(process.env), ...DEAD_ENV } })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}
/** Chegou ao BANCO (passou de toda validação) — a porta morta responde ECONNREFUSED. */
const reachedDb = (out: string) => /ECONNREFUSED|ETIMEDOUT|connect E|Access denied/i.test(out)
const refusedArgs = (out: string) => /argumento desconhecido|precisa de um institutionId|só existe para o ato|juntos/.test(out)

describe('M3 — lista fechada de argumentos (função pura)', () => {
  it('sem achado: formas que escapariam por GRAFIA são recusadas (= no valor, caixa, travessão de autocorreção, separador solto, vazio)', () => {
    const ato = ['--cutover', '1', '--confirmo-setes-api-parado']
    for (const extra of ['--cutover=1', '--VAI', '--Vai', '--vai=1', '–dry-run', '—vai', '--dry-run ', ' --vai', '--', '', '-vai', 'vai']) {
      expect([extra, argumentErrors([...ato, extra]).join()]).toEqual([extra, expect.stringMatching(/argumento desconhecido/)])
    }
    expect(argumentErrors(['--cutover=1', '--confirmo-setes-api-parado', '--vai']).join()).toMatch(/desconhecido.*só existe para o ato|só existe para o ato/)
  })
  it('sem achado: `--vai` nunca vira o valor do `--cutover` nem anda sem ele; `--vai` + `--dry-run` em qualquer ordem = erro', () => {
    expect(argumentErrors(['--cutover', '--vai', '--confirmo-setes-api-parado']).join()).toMatch(/precisa de um institutionId/)
    expect(argumentErrors(['--dry-run', '--vai']).join()).toMatch(/só existe para o ato/)
    for (const a of [['--vai', '--cutover', '1', '--confirmo-setes-api-parado', '--dry-run'], ['--dry-run', '--confirmo-setes-api-parado', '--cutover', '1', '--vai']]) {
      expect(argumentErrors(a).join()).toMatch(/juntos/)
    }
  })
  it('[LOW ADV-R8-03 — CORRIGIDO] argumento repetido é recusado (qual `--cutover` vale seria adivinhação); id só decimal canônico', () => {
    expect(argumentErrors(['--cutover', '1', '--cutover', '2', '--confirmo-setes-api-parado']).join()).toMatch(/repetido/)
    expect(argumentErrors(['--cutover', '1', '--confirmo-setes-api-parado', '--vai', '--vai']).join()).toMatch(/repetido/)
    for (const v of ['0x1', '1e0', '01', ' 1', '1.0', '+1']) expect([v, argumentErrors(['--cutover', v, '--confirmo-setes-api-parado']).length > 0]).toEqual([v, true])
  })
})

describe('M3 — o script inteiro em processo filho (banco MORTO — nenhuma escrita possível)', () => {
  jest.setTimeout(240_000)
  const out: Record<string, { status: number | null; db: boolean; refused: boolean; msg: string }> = {}
  const run = (name: string, args: string[], how: 'npm' | 'npm--' = 'npm--') => {
    const r = viaNpm(how === 'npm--' ? ['--', ...args] : args)
    out[name] = { status: r.status, db: reachedDb(r.out), refused: refusedArgs(r.out), msg: (r.out.match(/FALHA[^\n]*/)?.[0] ?? r.out.slice(-200)).slice(0, 200) }
  }
  beforeAll(() => {
    run('cutover 0', ['--cutover', '0', '--confirmo-setes-api-parado'])
    run('cutover -1', ['--cutover', '-1', '--confirmo-setes-api-parado'])
    run('cutover 1 e depois abc', ['--cutover', '1', '--cutover', 'abc', '--confirmo-setes-api-parado'])
    run('cutover abc e depois 1', ['--cutover', 'abc', '--cutover', '1', '--confirmo-setes-api-parado'])
    run('cutover 0x1', ['--cutover', '0x1', '--confirmo-setes-api-parado'])
    run('npm sem --: --dry-run', ['--dry-run'], 'npm')
    run('npm sem --: ato com --vai', ['--cutover', '1', '--confirmo-setes-api-parado', '--vai'], 'npm')
    // eslint-disable-next-line no-console
    console.log('[adv-r8] migrate:setes em processo filho (banco morto)', JSON.stringify(out, null, 1))
  })
  it('sem achado: id zero/negativo é recusado ANTES do banco; o ato sem `--` no npm vira "argumento desconhecido" (o `--vai` engolido nunca grava)', () => {
    for (const k of ['cutover 0', 'cutover -1', 'cutover abc e depois 1']) expect([k, out[k].status, out[k].db]).toEqual([k, 1, false])
    expect(out['npm sem --: ato com --vai']).toMatchObject({ status: 1, db: false, refused: true })
  })
  it('[LOW ADV-R8-03 — CORRIGIDO] `--cutover 1 --cutover abc` e `--cutover 0x1` são recusados antes do banco (hoje viram o ato da institution 1)', () => {
    expect([out['cutover 1 e depois abc'].db, out['cutover 0x1'].db]).toEqual([false, false])
  })
  it('[LOW ADV-R8-04 — CORRIGIDO] `npm run migrate:setes --dry-run` (sem o `--`) NÃO vira re-sincronia gravando: o script recusa quando o npm engoliu flag dele (npm_config_dry_run/cutover/vai)', () => {
    expect(out['npm sem --: --dry-run'].db).toBe(false)
  })
})

describe('L2 (gêmeo na nfse-api) — normalizeCancelMotive × Unicode', () => {
  // o setes-api recebeu o porte (D-F43); a nfse-api tem a MESMA função — o achado LOW ADV-R8-07 vale para as duas
  const NOT_XML_OR_LONE = /[￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  it('sem achado: tamanho sempre 15–255 (controle sai antes do piso; corte em 255)', () => {
    for (const raw of ['\u0001'.repeat(30), 'x'.repeat(300), '  '.repeat(10), '﻿'.repeat(20), '']) {
      const m = normalizeCancelMotive(raw)
      expect(m.length >= 15 && m.length <= 255).toBe(true)
    }
  })
  it('[LOW ADV-R8-07 — CORRIGIDO] o xMotivo da nfse-api não leva não-caractere XML nem surrogate solto (U+FFFF, \\uD800, emoji cortado em 255)', () => {
    for (const raw of ['￿'.repeat(20), '\uD800'.repeat(20), 'a'.repeat(254) + '\u{1F600}']) {
      expect(NOT_XML_OR_LONE.test(normalizeCancelMotive(raw))).toBe(false)
    }
  })
})

describe('D-F47 — o que é "obrigação já assumida" (SQL das duas consultas)', () => {
  it('sem achado: a obrigação da NOTA é escopada pela institution do token + nota (nunca de outra institution) e ignora tentativa excluída', async () => {
    const q = { query: jest.fn(async () => [[]]) } as any
    expect(await hasFiscalObligation(q, 7, 42)).toBe(false)
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/WHERE tb_institution_id = \? AND tb_invoice_id = \? AND terminal = 0 AND deleted = 'N' LIMIT 1/)
    expect(params).toEqual([7, 42])
  })
  it('[LOW ADV-R8-05 — CORRIGIDO] as duas consultas de obrigação usam o MESMO predicado de tentativa (terminal = 0 nas duas)', async () => {
    const q = { query: jest.fn(async () => [[]]) } as any
    await institutionHasFiscalObligation(q, 7)
    expect(q.query.mock.calls[0][0]).toMatch(/terminal = 0/)
  })
})
