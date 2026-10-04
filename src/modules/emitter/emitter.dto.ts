import { z } from 'zod'
import { DPS_SERIE_MIN, DPS_SERIE_MAX } from '../../authority/dps-builder'

/** Habilitação do modelo SE (ambiente + série do DPS). A nfse-api só habilita SE (55/65 são da nfe-api). */
export const issuerDto = z.object({
  environment: z.enum(['H', 'P']),
  // ACHADO 3 do gate da Onda 3: a PORTA já recusa 0/00000/50000+ (50000+ são do emissor nacional)
  serie: z.string().trim().min(1).max(5).regex(/^\d{1,5}$/, 'Série com 1 a 5 dígitos')
    .refine(s => Number(s) >= DPS_SERIE_MIN && Number(s) <= DPS_SERIE_MAX, `Série entre ${DPS_SERIE_MIN} e ${DPS_SERIE_MAX}`),
})

/** Upload WRITE-ONLY do A1 (D-N5): o .pfx em base64 e a senha existem só nesta requisição. */
export const certificateDto = z.object({
  pfxBase64: z.string().min(1).max(64_000),
  password:  z.string().max(200),
})

export type IssuerDto = z.infer<typeof issuerDto>
export type CertificateDto = z.infer<typeof certificateDto>
