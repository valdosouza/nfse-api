/// <reference types="jest" />
// CERCA da inscrição federal (D-CJ12 = Q-CJ12, frente do CNPJ alfanumérico, Valdo 2026-10-15 — molde time-zone-fence/voice-kind-fence):
// "tirar o que não é dígito" (ou "tirar as letras") NUNCA sobre inscrição federal (CPF/CNPJ) nem chave de acesso — aplicado a um CNPJ
// alfanumérico dá OUTRO número (ou vira CPF: com 3 letras sobram 11 dígitos); numa chave de acesso dá OUTRA chave (D12/D13/D17 do
// inventário). Peças: `FederalId` (núcleo) e a chave de acesso (`src/authority/access-key.ts`) — canonicalizam/leem pela forma geral, nunca
// apagam. O PREDICADO mora no arquivo gêmeo `federal-id-fence.ts` (idêntico nos 3 repositórios; alargado no gate adversarial da onda 0).
// Lista BRANCA = os usos legítimos, cada um com o MOTIVO; alarme NOVO fora dela quebra a cerca; entrada que SUMIU também quebra.
import path from 'path'
import { repoStrippingHits, strippingHitsIn, FENCE_PROBES_CAUGHT, FENCE_PROBES_CLEAN } from './federal-id-fence'

const ROOT = path.resolve(__dirname, '..', '..')

/** `arquivo: texto do alarme` (espaços colapsados) → motivo. */
const ALLOWED: Record<string, string> = {
  "src/authority/dps-builder.ts: String(s ?? '').replace(/\\D/g, '')":
    'digits() do montador: cMun/CEP/fone — e, ATÉ A ONDA 1 (D-CJ7, escritor pelo calendário de LEIAUTE), o CNPJ do prestador/tomador/autor '
    + 'SEMPRE com tamanho (`digits(…, 14)` LANÇA em vez de mutilar; o CNPJ alfanumérico é recusado ANTES — service-facts `DPS_NUMERIC_CNPJ`). '
    + 'A inscrição do Id do DPS já saiu daqui (gate socrático da onda 0). A onda 1 tira a inscrição do montador inteiro (Q-CJ15).',
  "src/facts/service-facts.ts: String(v ?? '').replace(/\\D/g, '')":
    'digitsOf do CEP do tomador (8 dígitos) — a inscrição é lida pela peça (readFederalIdFact)',
  // D-CJ15 (cerca alargada pelo setes-api, b40844c — vigia o VALOR): o mesmo digits() acima, agora visto na CHAMADA sobre a inscrição.
  // DÍVIDA DA ONDA 1 (Q-CJ15): sempre com tamanho — LANÇA em vez de mutilar; o CNPJ alfanumérico é recusado ANTES (`DPS_NUMERIC_CNPJ`).
  "src/authority/dps-builder.ts: digits(p.cnpj, 'CNPJ do prestador', 14)":
    'CNPJ do prestador no DPS — dívida da onda 1 (Q-CJ15): tamanho 14 obrigatório, lança em vez de mutilar; alfanumérico recusado antes',
  "src/authority/dps-builder.ts: digits(t.cnpj, 'CNPJ do tomador', 14)":
    'CNPJ do tomador no DPS — dívida da onda 1 (Q-CJ15): tamanho 14 obrigatório, lança em vez de mutilar; alfanumérico recusado antes',
  "src/authority/dps-builder.ts: digits(t.cpf!, 'CPF do tomador', 11)":
    'CPF do tomador no DPS — dívida da onda 1 (Q-CJ15): tamanho 11 obrigatório, lança em vez de mutilar (CPF segue numérico)',
  "src/authority/dps-builder.ts: digits(input.cnpjAutor, 'CNPJ do autor', 14)":
    'CNPJ do autor do evento — dívida da onda 1 (Q-CJ15): tamanho 14 obrigatório, lança em vez de mutilar; alfanumérico recusado antes',
  "src/authority/dps-builder.ts: digits(input.cpfAutor!, 'CPF do autor', 11)":
    'CPF do autor do evento — dívida da onda 1 (Q-CJ15): tamanho 11 obrigatório, lança em vez de mutilar (CPF segue numérico)',
}

describe('D-CJ12 — cerca: nunca "tirar o que não é dígito" de inscrição federal ou chave de acesso', () => {
  const hits = repoStrippingHits(ROOT)
  it('todo alarme está na lista branca (com o motivo)', () => {
    expect(hits.filter(h => !(h in ALLOWED))).toEqual([])
  })
  it('a lista branca não apodrece: toda entrada ainda existe no código', () => {
    expect(Object.keys(ALLOWED).filter(k => !hits.includes(k))).toEqual([])
  })
  it('a cerca enxerga o que deve (sonda — inclui as 9 formas que escapavam da 1ª versão)', () => {
    for (const code of FENCE_PROBES_CAUGHT) expect([code, strippingHitsIn(code).length > 0]).toEqual([code, true])
    for (const code of FENCE_PROBES_CLEAN) expect([code, strippingHitsIn(code)]).toEqual([code, []])
  })
})
