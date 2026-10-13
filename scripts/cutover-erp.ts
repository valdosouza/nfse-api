// D-F44 (Valdo 2026-10-04 — Q-F50 (a), refinada pelo parecer do guardião no §17 do prompt): a ÚNICA escrita de dado de uma
// API fiscal no ERP (item da LISTA FECHADA da D-F31). O ATO da virada (`migrate:setes --cutover`) APOSENTA a habilitação SE
// do ERP (`deleted='S'`) na MESMA transação que vira o `fiscal_api` — fecha o lado do ERP POR CONSTRUÇÃO: o setes-api lê e
// cunha a habilitação sempre com `deleted='N'`, então a reserva dele (que esperava a trava) acorda e recebe 409
// FISCAL_ISSUER_MISSING sem mudar uma linha do setes-api; uma instância esquecida ou um rollback do deploy do setes-api
// não cunham mais o MESMO nDPS na mesma série (cenário R2-2).
//
// Este módulo vive em `scripts/` de propósito: o SERVIÇO (src/) nunca o importa — escrita UMA vez, pelo script, com a
// credencial do DONO do ERP (o usuário `fiscal_api` só tem SELECT no ERP — `ops/grants.sql`: com ele o UPDATE é negado e o
// ato inteiro volta atrás). Cerca por teste: `app.test.ts` "CERCA D-F31".
//
// A linha SE do ERP carrega DOIS conceitos (parecer do guardião): a SÉRIE DA NOTA interna (`tb_invoice.serie` — lida pelo
// faturamento e pela OS com default '1' quando não há linha viva) e a habilitação para falar com o fisco. Aposentar a
// linha muda a série das notas NOVAS para '1' — por isso a CONFERÊNCIA embutida: série efetiva ≠ '1' = FALHA ALTA (decidir
// antes, nunca mudar a série da nota em silêncio). Depois da virada a tabela do ERP significa só a série da nota (F2a).
import type { PoolConnection } from 'fiscal-api'

/** A série que o setes-api usa quando não há habilitação VIVA (`issuerLine?.serie ?? '1'` — billing e OS). */
export const ERP_DEFAULT_NOTE_SERIE = '1'

export interface ErpServiceIssuerRow { serie: string | null; deleted: string }

/**
 * Conferência do ato: a série da NOTA que o setes-api usa HOJE (a da linha viva, ou o default) tem de ser a mesma que ele
 * usará DEPOIS de aposentada a linha (o default '1'). Linha já aposentada = nada muda.
 */
export function assertNoteSerieKept(schema: string, row: ErpServiceIssuerRow): void {
  if (row.deleted !== 'N') return
  const now = row.serie ?? ERP_DEFAULT_NOTE_SERIE                          // espelho exato do setes-api (sem trim)
  if (now !== ERP_DEFAULT_NOTE_SERIE) {
    throw new Error(`${schema}: a série da NOTA SE do ERP é '${now}' — aposentar a habilitação SE na virada (D-F44) mudaria a série `
      + `das notas novas para '${ERP_DEFAULT_NOTE_SERIE}'. Decida a série antes (nada gravado).`)
  }
}

/** Aposenta a habilitação SE do ERP (quem chama já a travou FOR UPDATE como 1º comando da transação). Devolve as linhas. */
export async function retireErpServiceIssuer(c: PoolConnection, schema: string, institutionId: number, model: string): Promise<number> {
  const [r] = await c.query<any>(
    `UPDATE \`${schema}\`.tb_establishment_issuer SET deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'`, [institutionId, model])
  return Number(r?.affectedRows ?? 0)
}

/**
 * Os 9 gatilhos de TRAVA da `f2a_fiscal_passivo` (D-F110) — nome → [tabela, evento, CORPO normalizado]. D-F110: "o ensaio da virada confere
 * os triggers"; F2A3-ADV-04 (gate adversarial da A3): `_migrations.name` prova que a migration RODOU, não que os gatilhos continuam lá (DROP
 * TRIGGER, dump `--skip-triggers`, restauração). O CORPO entra no gate do delta da Rodada 4 (F2AR4-ADV-02): SIGNAL sob um IF que nunca vale,
 * SIGNAL em comentário ou a trava da SE de uma versão ANTERIOR passavam com a regra antiga ("o corpo tem um SIGNAL"). Cerca: nome, tabela,
 * evento e corpo batem com a migration do setes-api quando a F2a está no `SETES_API_DIR` (`f2a-a3-gatilhos.test.ts`).
 */
export const F2A_FREEZE_TRIGGERS: Readonly<Record<string, readonly [table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', body: string]>> = Object.freeze({
  tg_f2a_freeze_tx_bi:        ['tb_invoice_service_transmission', 'INSERT',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): tentativa ao fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada'; END"],
  tg_f2a_freeze_tx_bu:        ['tb_invoice_service_transmission', 'UPDATE',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): tentativa ao fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada'; END"],
  tg_f2a_freeze_tx_bd:        ['tb_invoice_service_transmission', 'DELETE',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): origem congelada das tentativas ao fisco - nada se apaga'; END"],
  tg_f2a_freeze_voice_bi:     ['tb_invoice_service_transmission_event', 'INSERT',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): a voz do fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada'; END"],
  tg_f2a_freeze_voice_bu:     ['tb_invoice_service_transmission_event', 'UPDATE',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): a voz do fisco e escrita so pela nfse-api (fiscal_api) - tabela do ERP congelada'; END"],
  tg_f2a_freeze_voice_bd:     ['tb_invoice_service_transmission_event', 'DELETE',
    "BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): origem congelada da voz do fisco - nada se apaga'; END"],
  tg_f2a_freeze_issuer_se_bi: ['tb_establishment_issuer', 'INSERT',
    "BEGIN IF NEW.`model` = 'SE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): a habilitacao SE e da nfse-api - o ERP nao cria linha SE'; END IF; END"],
  tg_f2a_freeze_issuer_se_bu: ['tb_establishment_issuer', 'UPDATE',
    "BEGIN IF OLD.`model` = 'SE' OR NEW.`model` = 'SE' THEN IF NOT (NEW.`model` <=> OLD.`model`) OR NOT (NEW.`tb_institution_id` <=> OLD.`tb_institution_id`) OR NOT (NEW.`environment` <=> OLD.`environment`) OR NOT (NEW.`dps_last_number` <=> OLD.`dps_last_number`) OR (OLD.`deleted` = 'S' AND NEW.`deleted` <> 'S') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): habilitacao SE do ERP congelada - so o ato da virada a aposenta (N para S)'; END IF; END IF; END"],
  tg_f2a_freeze_issuer_se_bd: ['tb_establishment_issuer', 'DELETE',
    "BEGIN IF OLD.`model` = 'SE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110/D-F44): a historia da habilitacao SE fica - nada se apaga'; END IF; END"],
})

/**
 * O corpo de um gatilho na forma COMPARÁVEL — a MESMA regra do setes-api (`src/migrations/f2a-freeze-triggers.ts`, que lê a migration):
 * comentários (`/* *\/`, `-- `, `#`) fora de literais saem, espaços em branco fora de literais viram UM espaço, pontas aparadas, `;` final
 * fora. Literais ('…', "…", `…`) ficam intactos.
 */
export function normalizeTriggerBody(sql: string): string {
  let out = ''
  let quote: string | null = null
  let space = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) out += sql[++i]                     // aspas dobradas = a própria aspa
        else quote = null
      } else if (ch === '\\' && quote !== '`' && i + 1 < sql.length) {
        out += sql[++i]
      }
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 1
      space = true
      continue
    }
    if ((ch === '-' && sql[i + 1] === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) || ch === '#') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
      space = true
      continue
    }
    if (/\s/.test(ch)) { space = true; continue }
    if (space && out.length) out += ' '
    space = false
    out += ch
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
  }
  return out.replace(/;$/, '').trim()
}

/**
 * Os gatilhos de TRAVA que FALTAM (ou estão diferentes) no schema do cliente — pelo NOME no `information_schema.TRIGGERS`: tabela, BEFORE, o
 * evento e o CORPO normalizado igual ao da migration. Filtro por `EVENT_OBJECT_SCHEMA` (F2AR4-SOC-04: no MariaDB 10.4 o `TRIGGER_SCHEMA = ?`
 * varre TODOS os bancos; o gatilho mora no schema da tabela — mesma semântica). O `information_schema` só mostra gatilhos de tabela em que o
 * usuário tem o privilégio TRIGGER: o ato roda com a credencial do DONO do ERP (`cutover-erp.ts`); sem o privilégio a lista volta vazia e o
 * ato RECUSA (falha fechada — nunca "conferido" por não enxergar).
 */
export async function f2aFreezeTriggersMissing(q: { query: (sql: string, p?: unknown[]) => Promise<any> }, s: string): Promise<string[]> {
  const names = Object.keys(F2A_FREEZE_TRIGGERS)
  const [rows] = await q.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, EVENT_MANIPULATION AS ev, ACTION_TIMING AS timing, ACTION_STATEMENT AS body
       FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND TRIGGER_NAME IN (?)`, [s, names])
  const found = new Map<string, any>((rows as any[]).map(r => [String(r.name), r]))
  const missing: string[] = []
  for (const name of names) {
    const [table, event, body] = F2A_FREEZE_TRIGGERS[name]
    const r = found.get(name)
    if (!r) { missing.push(`${name} ausente`); continue }
    if (String(r.tbl) !== table || String(r.ev).toUpperCase() !== event || String(r.timing).toUpperCase() !== 'BEFORE') {
      missing.push(`${name} diferente (${r.timing} ${r.ev} em ${r.tbl})`)
    } else if (normalizeTriggerBody(String(r.body ?? '')) !== body) {
      missing.push(`${name} diferente (o corpo não é o da migration)`)
    }
  }
  return missing
}
