import {
  HttpError, ErrorCodes, InstitutionPayload, logger, withTransaction,
  saveProviderFiscalCredential, endProviderFiscalCredential, listProviderFiscalCredentials,
  FiscalCodeInvalidError, FiscalCodeConflictError, FiscalCodeStoreError, ProviderFiscalCredentialRow,
} from 'fiscal-api'
import type { AppContext } from '../../context'
import type { SaveCredentialDto, EndCredentialDto } from './provider.dto'

/**
 * Credencial fiscal do FORNECEDOR por UF (o CSRT do PR — D-NE221/D-NE223/D-NE224). A regra mora na peça do núcleo (`fiscal-api` 4.1.0,
 * `fiscal-code`); aqui fica a borda: transação, tradução dos erros da peça para o envelope da casa, instantes em ISO e o registro do ATO.
 * O VALOR é só de escrita: nunca volta em resposta, erro ou log (D-NE224/D-NE223).
 */

/** O que a borda devolve: a linha da peça, com os instantes em ISO `…Z` (a tela devolve ao `/end` o `validFrom` que leu). */
export interface ProviderFiscalCredentialView {
  state:       string
  model:       string
  environment: string
  type:        string
  codeId:      string
  validFrom:   string
  validUntil:  string | null
  userId:      number | null
}

/** `'YYYY-MM-DD HH:MM:SS'` (UTC, como a peça devolve) → `'YYYY-MM-DDTHH:MM:SSZ'`. */
const iso = (utc: string): string => `${utc.replace(' ', 'T')}Z`

/** Monta a resposta campo a campo — nada além do que está aqui sai, mesmo se a peça devolvesse mais. */
function viewOf(r: ProviderFiscalCredentialRow): ProviderFiscalCredentialView {
  return {
    state: r.state, model: r.model, environment: r.environment, type: r.type, codeId: r.codeId,
    validFrom: iso(r.validFrom), validUntil: r.validUntil === null ? null : iso(r.validUntil), userId: r.userId,
  }
}

const CONTENTION = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'])

/**
 * Erros da peça → envelope da casa (o núcleo os deixou fora do catálogo; a família traduz). [renameField] troca o nome do campo da peça
 * pelo do corpo (o `at` do encerramento é o `validUntil` do corpo). A contenção vem embrulhada no `FiscalCodeStoreError` (o
 * `withTransaction` não a reconhece e não reexecuta): sai 409 RESOURCE_BUSY, como a contenção da casa — o app repete.
 */
function translate(err: unknown, renameField: Record<string, string> = {}): never {
  if (err instanceof FiscalCodeInvalidError) {
    const field = renameField[err.field] ?? err.field
    const message = err.message.replace(`: ${err.field} `, `: ${field} `)   // a mensagem da peça traz só o CAMPO, nunca o valor
    throw new HttpError(400, 'Credencial fiscal recusada', [{ field, message }], err.code)
  }
  if (err instanceof FiscalCodeConflictError) {
    throw new HttpError(409, 'Já existe credencial com este início para a mesma UF, modelo, ambiente e tipo', undefined, err.code)
  }
  if (err instanceof FiscalCodeStoreError) {
    if (err.dbCode !== null && CONTENTION.has(err.dbCode)) {
      throw new HttpError(409, 'Registro em uso por outra operação — tente novamente', undefined, ErrorCodes.RESOURCE_BUSY)
    }
    throw new HttpError(503, 'Configuração fiscal indisponível — tente novamente', undefined, err.code)
  }
  // Qualquer outro erro (gates da CRED.E1.P1 — socrático MED-1, adversarial L1/L2): a lista e o SELECT do catálogo não embrulham o erro do
  // banco, e o `getConnection`/`commit` também não. NUNCA repassar cru: o `sendError` do núcleo loga `message` e `stack`, e um erro do motor
  // pode trazer o valor no texto ("Incorrect string value: '…'") ou no `sql`. Ao log vai só a CLASSE (errno/code/nome); a contenção crua é 409.
  const e = err as { errno?: unknown; code?: unknown; name?: unknown }
  const dbCode = typeof e?.code === 'string' ? e.code : null
  if (dbCode !== null && CONTENTION.has(dbCode)) {
    throw new HttpError(409, 'Registro em uso por outra operação — tente novamente', undefined, ErrorCodes.RESOURCE_BUSY)
  }
  logger.error('Configuração fiscal do fornecedor: falha sem classe da peça', {
    errno: typeof e?.errno === 'number' ? e.errno : null, code: dbCode, name: typeof e?.name === 'string' ? e.name : null,
  })
  throw new HttpError(503, 'Configuração fiscal indisponível — tente novamente', undefined, 'FISCAL_CODE_STORE_FAILED')
}

export async function listCredentials(ctx: AppContext): Promise<ProviderFiscalCredentialView[]> {
  try {
    return (await listProviderFiscalCredentials(ctx.pool)).map(viewOf)
  } catch (err) { translate(err) }
}

export async function saveCredential(ctx: AppContext, inst: InstitutionPayload, dto: SaveCredentialDto): Promise<ProviderFiscalCredentialView> {
  const meta = { userId: inst.userId, state: dto.state, model: dto.model, environment: dto.environment, type: dto.type, codeId: dto.codeId }
  let row: ProviderFiscalCredentialRow
  try {
    // INSERT da nova + UPDATE que encerra a anterior, atômicos (a peça pede a conexão em transação para isso)
    row = await withTransaction(ctx.pool, 'credencial fiscal do fornecedor', meta, conn => saveProviderFiscalCredential(conn, {
      state: dto.state, model: dto.model, environment: dto.environment, type: dto.type,
      codeId: dto.codeId, codeValue: dto.codeValue, validFrom: dto.validFrom, validUntil: dto.validUntil ?? null, userId: inst.userId,
    }))
  } catch (err) { translate(err) }
  const view = viewOf(row)
  logger.info('Credencial fiscal do fornecedor gravada', { ...meta, validFrom: view.validFrom })   // o ATO — nunca o valor
  return view
}

export async function endCredential(ctx: AppContext, inst: InstitutionPayload, dto: EndCredentialDto): Promise<{ ended: true }> {
  const at = dto.validUntil ?? new Date()
  let ended: boolean
  try {
    ended = await endProviderFiscalCredential(ctx.pool, {
      state: dto.state, model: dto.model, environment: dto.environment, type: dto.type, validFrom: dto.validFrom,
    }, at)
  } catch (err) {
    // sem `validUntil` no corpo o fim é AGORA — o erro diz isso, em vez de apontar um campo que o cliente não mandou (gate socrático 4)
    if (err instanceof FiscalCodeInvalidError && err.field === 'at' && dto.validUntil === undefined) {
      throw new HttpError(400, 'Credencial fiscal recusada', [{ field: 'validUntil',
        message: 'Sem validUntil o fim é agora, e agora não é depois do início — informe um fim depois do início' }], err.code)
    }
    translate(err, { at: 'validUntil' })
  }
  if (!ended) {
    throw new HttpError(404, 'Nenhuma credencial viva e não encerrada com esta chave', undefined, 'FISCAL_CODE_NOT_FOUND')
  }
  logger.info('Credencial fiscal do fornecedor encerrada', {
    userId: inst.userId, state: dto.state, model: dto.model, environment: dto.environment, type: dto.type,
    validFrom: dto.validFrom.toISOString(), validUntil: at.toISOString(),
  })
  return { ended: true }
}
