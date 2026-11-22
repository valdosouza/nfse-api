import { z } from 'zod'

/**
 * Corpos da credencial fiscal do FORNECEDOR (D-NE224). Os limites são os da peça do núcleo (`fiscal-code.ts`); o DOMÍNIO (UF, modelo,
 * ambiente, tipo do catálogo, forma do `codeId` pelo tipo, forma do valor) é conferido pela peça, cujo erro nunca traz o valor.
 * `codeValue` é só `z.string()`: nada de enum/literal/regex nele — o zod ecoaria o recebido na mensagem.
 */
const instant = z.string().datetime({ offset: true }).transform(s => new Date(s))

const keyFields = {
  state:       z.string().length(2),
  model:       z.string().min(1).max(2),
  environment: z.string().length(1),
  type:        z.string().min(1).max(20),
  validFrom:   instant,
}

export const saveCredentialDto = z.object({
  ...keyFields,
  codeId:     z.string().min(1).max(10),
  codeValue:  z.string(),
  validUntil: instant.optional(),
})

/** Encerrar = a chave + o fim (padrão: agora — escolha da ficha). */
export const endCredentialDto = z.object({
  ...keyFields,
  validUntil: instant.optional(),
})

export type SaveCredentialDto = z.infer<typeof saveCredentialDto>
export type EndCredentialDto = z.infer<typeof endCredentialDto>
