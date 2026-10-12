// Fixture dos testes do ATO da virada (gates da A3 da F2a — F2A3-ADV-04): com a F2a aplicada, o ato confere os 9 gatilhos de TRAVA da
// `f2a_fiscal_passivo` pelo NOME no `information_schema.TRIGGERS` (`scripts/cutover-erp.ts`). Banco simulado = a forma das linhas que o
// motor devolve para o dono do ERP (tabela, evento, BEFORE, corpo que recusa).
import { F2A_FREEZE_TRIGGERS } from '../../scripts/cutover-erp'

export const FREEZE_TRIGGERS_SQL = /FROM information_schema\.TRIGGERS WHERE TRIGGER_SCHEMA = \?/

/** Os 9 gatilhos como o `information_schema` os mostra a quem tem o privilégio TRIGGER. */
export function freezeTriggerRows(): object[] {
  return Object.entries(F2A_FREEZE_TRIGGERS).map(([name, [tbl, ev]]) => ({
    name, tbl, ev, timing: 'BEFORE', body: "BEGIN\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'F2a (D-F110): ...';\nEND",
  }))
}
