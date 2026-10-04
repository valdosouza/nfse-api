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
