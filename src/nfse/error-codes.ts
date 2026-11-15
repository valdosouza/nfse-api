/**
 * Códigos PRÓPRIOS da família NFS-e — o que ainda não está no catálogo do núcleo (`ErrorCodes`, D-F17). Quando a nfe-api tiver o mesmo
 * caso, o código sobe para o núcleo com o mesmo nome (D-F238).
 */
export const NfseErrorCodes = {
  /**
   * D-F238 (executa a reserva da D-F166): o fisco foi chamado e respondeu, mas a voz NÃO foi gravada porque a nota estava travada por
   * outra operação (contenção na transação DEPOIS do fisco). O desfecho no fisco pode ter acontecido (inclusive autorizado/cancelado):
   * o app trata como INCERTO — "consulte a nota antes de repetir" — e nunca como recusa. A consulta (tela ou rodízio) reconcilia.
   * `RESOURCE_BUSY` fica só para a contenção ANTES do fisco ("tente de novo").
   */
  FISCAL_OUTCOME_NOT_RECORDED: 'FISCAL_OUTCOME_NOT_RECORDED',
} as const

export type NfseErrorCode = (typeof NfseErrorCodes)[keyof typeof NfseErrorCodes]
