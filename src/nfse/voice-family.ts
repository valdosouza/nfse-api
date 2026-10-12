import { TransmissionEventKind, VoiceEventInput, defineVoiceFamily, SERVICE_VOICE_READING, assertCheckRefuses } from 'fiscal-api'

/**
 * A FAMÍLIA de SERVIÇO (NFS-e) declara a escrita da voz dela (D-F108 = Q-F114 (a); parte 2 da NE-1a — `prompt_onda_nfe_sefaz.md` §12.8/§12.9.7):
 * a tabela da voz e a LISTA DE ESCRITA moram aqui (a família é a dona — o CHECK da F2a, migration DESTA API, protege EXATAMENTE esta
 * lista: D-F107); o escritor é o GENÉRICO do núcleo (`defineVoiceFamily` — funil, MAX+1 sob a trava, `InvoiceTx` — D-NE74).
 *
 * D-F106 (= Q-F112 (b), Valdo 2026-10-11): vocabulário de ESCRITA da família NFS-e — lista POSITIVA (A/R/C/K/F/N): sem S (a voz S não tem
 * saída — D-F102/D-F105) e sem os kinds que a NE-1a trouxe para o tipo comum (P da NF-e — viva, em processamento — e D — FINAL, denegada).
 * O TIPO pega o produtor SEMÂNTICO (constante, shorthand, mapa, parâmetro) que nenhuma cerca textual pega; o FUNIL do núcleo confere a mesma
 * lista em EXECUÇÃO (cast, spread, JSON: o tipo some no JS). A lista é UMA constante e o tipo DERIVA dela (o `satisfies` garante que cada
 * kind existe no vocabulário comum; se o comum virar `any`/`string`, o tipo da família continua a lista literal). Ampliar = decisão.
 */
// congelada em execução (gate NE1A2-11): é a FONTE ÚNICA que o CHECK e a sonda do boot da F2a usam (D-F107) — `as const` é só tipo
export const SERVICE_VOICE_WRITE_KINDS = Object.freeze(['A', 'R', 'C', 'K', 'F', 'N'] as const satisfies readonly TransmissionEventKind[])
export type ServiceVoiceWriteKind = typeof SERVICE_VOICE_WRITE_KINDS[number]
export type TransmissionEventInput = VoiceEventInput<ServiceVoiceWriteKind>

export const SERVICE_VOICE_FAMILY = defineVoiceFamily({
  reading:    SERVICE_VOICE_READING,
  eventTable: 'tb_invoice_service_transmission_event',
  writeKinds: SERVICE_VOICE_WRITE_KINDS,
  label:      'NFS-e',                     // a família diz o nome dela nas mensagens (o núcleo não tem literal de família)
})

/**
 * Sonda do boot (molde da D-F45, generalizado em `assertCheckRefuses` do núcleo): os domínios da tentativa e da voz da NFS-e são os CHECKs
 * BINÁRIOS da migration 005 desta API, e o MOTOR os aplica — D-F107 (`kind`: 'S' fora da lista da família, sem saída — D-F102 — e 'f', a
 * minúscula de um kind válido) e D-F120 (`source`: 'X' e 'q'; `environment` da tentativa: 'X' e 'p'). Numa transação SEMPRE desfeita, sem a
 * FK (a sonda mira o CHECK), cada linha com PK PRÓPRIA (gates da A1, F2A1-07: com a mesma PK, um motor sem CHECK fazia a 2ª sonda colidir
 * na 1ª e o boot falhava com "Duplicate entry", não com o diagnóstico); cada valor tem de ser recusado pelo CHECK de NOME certo.
 */
export async function assertServiceVoiceDomainsEnforced(pool: Parameters<typeof assertCheckRefuses>[0]): Promise<void> {
  const ev = (event: number, kind: string, source: string, value: string, constraint: string) => ({ value, constraint, params: [event, kind, source],
    sql: `INSERT INTO ${SERVICE_VOICE_FAMILY.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source, deleted)`
      + ` VALUES (0, 0, 0, 0, ?, ?, ?, 'N')` })
  const KIND = 'ck_invoice_service_transmission_event_kind', SOURCE = 'ck_invoice_service_transmission_event_source'
  await assertCheckRefuses(pool, 'o kind da voz da NFS-e', [ev(1, 'S', 'P', 'S', KIND), ev(2, 'f', 'P', 'f', KIND)], { withoutForeignKeys: true })
  await assertCheckRefuses(pool, 'a origem (source) da voz da NFS-e', [ev(3, 'A', 'X', 'X', SOURCE), ev(4, 'A', 'q', 'q', SOURCE)], { withoutForeignKeys: true })
  const tx = (attempt: number, value: string) => ({ value, constraint: 'ck_invoice_service_transmission_environment', params: [attempt, value],
    sql: 'INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, deleted)'
      + ` VALUES (0, 0, 0, ?, 1, ?, 'N')` })
  await assertCheckRefuses(pool, 'o ambiente da tentativa da NFS-e', [tx(1, 'X'), tx(2, 'p')], { withoutForeignKeys: true })
}
