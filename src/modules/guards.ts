import { HttpError, ErrorCodes, InstitutionPayload, isAdmin, erp, emissionStillInErp } from 'fiscal-api'
import type { AppContext } from '../context'

/**
 * Autorização de AÇÃO na porta fiscal (D-F13): a REGRA é do ERP (privilégio TRANSMITIR/CANCELAR na
 * interface do RAMO — Q-G22/Q-G29) e a nfse-api a APLICA lendo o schema do cliente; a interface do
 * ramo vem da VIEW de política `vw_order_interface` (D-F32 — uma verdade só).
 * LICENÇA (D-F14) vale para TODOS — D-F37: o admin passa só o PRIVILÉGIO (D32), nunca a interface do ramo
 * não contratada. Leituras e ações exigem a interface do ramo CONTRATADA (Q-N32).
 */

export async function requireBranchPrivilege(ctx: AppContext, inst: InstitutionPayload, invoiceId: number, privilegeId: number): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, inst.institutionId, invoiceId)
  // licença (D-F14/D-F37) nas AÇÕES, para todos: privilégio (ou admin) em ramo NÃO contratado não emite
  if (!(await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key))) {
    throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
  if (isAdmin(inst)) return                       // admin passa o PRIVILÉGIO (D32), não a licença (D-F37)
  if (!(await erp.userHasPrivilege(ctx.pool, inst.schemaName, inst.userId, key, privilegeId))) {
    throw new HttpError(403, `Privilégio necessário para esta ação na interface ${key}`, undefined, ErrorCodes.PRIVILEGE_REQUIRED)
  }
}

/**
 * CERCA DA VIRADA (D-F18/D-F39): estabelecimento ainda emitido pelo ERP → a nfse-api só lê. FALHA ANTECIPADA na
 * borda (antes de ler o ERP); a garantia é do núcleo — `openIssuer`, `nextDpsNumber` e o aluguel recusam a réplica.
 */
export async function requireCutover(ctx: AppContext, inst: InstitutionPayload): Promise<void> {
  if (await emissionStillInErp(ctx.pool, inst.schemaName, inst.institutionId)) {
    throw new HttpError(409, 'A emissão fiscal desta empresa ainda é feita pelo ERP — esta API só consulta até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
}

/** Ramos (interfaces) que quem pede pode ver: só os CONTRATADOS (D-F14) — inclusive para o admin (D-F37). */
export async function visibleInterfaces(ctx: AppContext, inst: InstitutionPayload, keys: string[]): Promise<string[] | null> {
  const out: string[] = []
  for (const key of keys) if (await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key)) out.push(key)
  return out
}

/**
 * Privilégio em QUALQUER das interfaces (rotas sem nota específica — ex.: passada do rodízio) e DEVOLVE os ramos em
 * que quem pede pode agir: contratados (D-F14/D-F37) E com o privilégio (ou admin). D-F46: quem chama FILTRA as notas
 * por esta lista — ramo não contratado (ou sem privilégio) não ganha serviço fiscal nem de carona na passada de outro.
 * Nenhum ramo → 403 (nada contratado = INTERFACE_NOT_ALLOWED; contratado sem privilégio = PRIVILEGE_REQUIRED).
 */
export async function requireAnyPrivilege(ctx: AppContext, inst: InstitutionPayload, keys: readonly string[], privilegeId: number): Promise<string[]> {
  let contracted = false
  const allowed: string[] = []
  for (const key of keys) {
    if (!(await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key))) continue
    contracted = true
    if (isAdmin(inst) || await erp.userHasPrivilege(ctx.pool, inst.schemaName, inst.userId, key, privilegeId)) allowed.push(key)
  }
  if (allowed.length > 0) return allowed
  if (!contracted) throw new HttpError(403, 'Nenhuma interface fiscal contratada para este estabelecimento', undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  throw new HttpError(403, 'Privilégio necessário para esta ação', undefined, ErrorCodes.PRIVILEGE_REQUIRED)
}

export async function requireBranchInterface(ctx: AppContext, inst: InstitutionPayload, invoiceId: number): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, inst.institutionId, invoiceId)
  if (!(await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key))) {
    throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
}

export async function requireAnyInterface(ctx: AppContext, inst: InstitutionPayload, keys: string[]): Promise<void> {
  for (const key of keys) {
    if (await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key)) return
  }
  throw new HttpError(403, 'Nenhuma interface fiscal contratada para este estabelecimento', undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
}

/** Emitente (A1 + habilitação) é ato do ADMIN do estabelecimento (adminGuard do produto). */
export function requireAdmin(inst: InstitutionPayload): void {
  if (!isAdmin(inst)) throw new HttpError(403, 'Ação exclusiva do administrador do estabelecimento', undefined, ErrorCodes.ADMIN_REQUIRED)
}

/** id de rota: inteiro positivo, senão 400. */
export function parseInvoiceId(raw: string): number {
  const id = Number(raw)
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, 'invoiceId inválido', [{ field: 'invoiceId', message: 'Informe um id (inteiro positivo)' }], ErrorCodes.INVALID_ID)
  }
  return id
}
