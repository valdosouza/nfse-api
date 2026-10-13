/// <reference types="jest" />
// F2a, gates da A3 (2026-10-13 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22.13): F2A3-ADV-04 — o ATO da virada confere os 9
// gatilhos de TRAVA da `f2a_fiscal_passivo` pelo NOME (D-F110: "o ensaio da virada confere os triggers"); `_migrations.name` só prova que a
// migration rodou. A lista vive no módulo puro do ato (`scripts/cutover-erp.ts`) e é a MESMA da migration do setes-api (cerca abaixo,
// quando a F2a está no SETES_API_DIR — D-F117).
import fs from 'fs'
import path from 'path'
import { F2A_FREEZE_TRIGGERS, f2aFreezeTriggersMissing, normalizeTriggerBody } from '../../scripts/cutover-erp'
import { SETES_API_DIR, setesApiF2aApplied } from './voice-kind-fence'

const ALL = Object.entries(F2A_FREEZE_TRIGGERS).map(([name, [tbl, ev, body]]) => ({ name, tbl, ev, timing: 'BEFORE', body }))
const qOf = (rows: object[]) => ({ query: jest.fn(async () => [rows, []]) })

describe('F2A3-ADV-04 — o ato confere os 9 gatilhos de TRAVA pelo nome', () => {
  it('todos presentes, BEFORE, no evento e na tabela certos, recusando (SIGNAL 45000) → nada falta; a consulta é escopada pelo schema e pelos nomes', async () => {
    const q = qOf(ALL)
    expect(await f2aFreezeTriggersMissing(q, 'setes_setes')).toEqual([])
    const [sql, params] = (q.query.mock.calls[0] as unknown) as [string, unknown[]]
    expect(sql).toMatch(/FROM information_schema\.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = \? AND TRIGGER_NAME IN \(\?\)/)   // F2AR4-SOC-04
    expect(params).toEqual(['setes_setes', Object.keys(F2A_FREEZE_TRIGGERS)])
  })
  it('DROP TRIGGER (um some) → acusado pelo nome; nenhum visível (usuário sem o privilégio TRIGGER) → os 9 (falha FECHADA)', async () => {
    expect(await f2aFreezeTriggersMissing(qOf(ALL.filter(t => t.name !== 'tg_f2a_freeze_issuer_se_bu')), 's')).toEqual(['tg_f2a_freeze_issuer_se_bu ausente'])
    expect(await f2aFreezeTriggersMissing(qOf([]), 's')).toHaveLength(9)
  })
  it('gatilho com o nome certo mas FURADO (corpo sem SIGNAL, AFTER, outro evento ou outra tabela) → acusado como diferente', async () => {
    const swap = (name: string, over: object) => ALL.map(t => (t.name === name ? { ...t, ...over } : t))
    for (const over of [{ body: 'BEGIN END' }, { timing: 'AFTER' }, { ev: 'INSERT' }, { tbl: 'tb_outra' }]) {
      const out = await f2aFreezeTriggersMissing(qOf(swap('tg_f2a_freeze_voice_bu', over)), 's')
      expect(out).toHaveLength(1); expect(out[0]).toMatch(/^tg_f2a_freeze_voice_bu diferente/)
    }
  })
  it('F2AR4-ADV-02: o CORPO é o da migration — SIGNAL sob IF que nunca vale, SIGNAL em comentário e a trava da SE de versão ANTERIOR (sem o dono/contador) → diferentes; espaços e comentários a mais NÃO contam', async () => {
    const se = 'tg_f2a_freeze_issuer_se_bu'
    const swap = (name: string, body: string) => ALL.map(t => (t.name === name ? { ...t, body } : t))
    for (const body of [
      "BEGIN\n  IF OLD.`model` = 'XX' THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x';\n  END IF;\nEND",
      "BEGIN\n  /* SIGNAL SQLSTATE '45000' */ SET @adv = 1;\nEND",
      "BEGIN\n  IF OLD.`model` = 'SE' OR NEW.`model` = 'SE' THEN\n    IF NOT (NEW.`model` <=> OLD.`model`) THEN\n      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x';\n    END IF;\n  END IF;\nEND",
    ]) {
      expect(await f2aFreezeTriggersMissing(qOf(swap(se, body)), 's')).toEqual([`${se} diferente (o corpo não é o da migration)`])
    }
    const [, , real] = F2A_FREEZE_TRIGGERS[se]
    const reformatted = `/* re-indentado */\n${real.replace(/ THEN /g, ' THEN\n      ').replace(/; END/g, ';\n  END')} -- fim\n`
    expect(await f2aFreezeTriggersMissing(qOf(swap(se, reformatted)), 's')).toEqual([])
  })
})

describe('cerca D-F117 — a lista do ato é a da migration do setes-api (quando a F2a está no SETES_API_DIR)', () => {
  it('nomes, tabelas e eventos da `NNN_f2a_fiscal_passivo.sql` = F2A_FREEZE_TRIGGERS (antes da F2a no SETES_API_DIR não há o que comparar)', () => {
    if (!setesApiF2aApplied()) return
    const dir = path.join(SETES_API_DIR, 'src', 'migrations', 'sql')
    const file = fs.readdirSync(dir).find(f => /^\d{3}_f2a_fiscal_passivo\.sql$/.test(f))!
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    const created = [...sql.matchAll(/CREATE TRIGGER `(tg_f2a_freeze_\w+)` BEFORE (INSERT|UPDATE|DELETE) ON `(\w+)`/g)]
      .map(m => [m[1], m[3], m[2]] as const).sort()
    const expected = Object.entries(F2A_FREEZE_TRIGGERS).map(([name, [tbl, ev]]) => [name, tbl, ev] as const).sort()
    expect(created).toEqual(expected)
  })
  it('F2AR4-ADV-02: o CORPO de cada gatilho da migration (pelo divisor do runner — tira as linhas `--` e corta no `END;`) normalizado = o da lista do ato', () => {
    if (!setesApiF2aApplied()) return
    const dir = path.join(SETES_API_DIR, 'src', 'migrations', 'sql')
    const file = fs.readdirSync(dir).find(f => /^\d{3}_f2a_fiscal_passivo\.sql$/.test(f))!
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').replace(/--[^\n]*\n/g, '\n')
    const bodies = Object.fromEntries([...sql.matchAll(/CREATE TRIGGER `(tg_f2a_freeze_\w+)` BEFORE \w+ ON `\w+`\s+FOR EACH ROW\s+([\s\S]+?\nEND;)/g)]
      .map(m => [m[1], normalizeTriggerBody(m[2])]))
    expect(Object.keys(bodies).sort()).toEqual(Object.keys(F2A_FREEZE_TRIGGERS).sort())
    for (const [name, [, , body]] of Object.entries(F2A_FREEZE_TRIGGERS)) expect([name, bodies[name]]).toEqual([name, body])
  })
})
