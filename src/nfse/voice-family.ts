import { TransmissionEventKind, VoiceEventInput, defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'

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
