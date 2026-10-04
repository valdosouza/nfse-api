import { z } from 'zod'
import { HttpError, ErrorCodes } from 'fiscal-api'

/** Valida o corpo com Zod; 400 `{ error, code: VALIDATION_FAILED, fields[] }` (envelope da casa). */
export function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new HttpError(400, 'Validação falhou',
      parsed.error.issues.map(i => ({ field: i.path.join('.') || '(body)', message: i.message })), ErrorCodes.VALIDATION_FAILED)
  }
  return parsed.data
}
