import { HttpError, ErrorCodes, InstitutionPayload, isAdmin, erp, emissionStillInErp } from 'fiscal-api'
import type { AppContext } from '../context'
import { hasFiscalObligation, institutionHasFiscalObligation } from '../nfse/repository'

/**
 * Autorização de AÇÃO na porta fiscal (D-F13): a REGRA é do ERP (privilégio TRANSMITIR/CANCELAR na
 * interface do RAMO — Q-G22/Q-G29) e a nfse-api a APLICA lendo o schema do cliente; a interface do
 * ramo vem da VIEW de política `vw_order_interface` (D-F32 — uma verdade só).
 * LICENÇA (D-F14) vale para TODOS — D-F37: o admin passa só o PRIVILÉGIO (D32), nunca a interface do ramo
 * não contratada. D-F47 (= Q-F52 (a), Valdo 2026-10-10): a licença barra só a TRANSMISSÃO NOVA — nota com obrigação
 * fiscal já assumida (tentativa declarada ao fisco) segue consultável, cancelável no fisco e legível: o contrato
 * comercial não impede cumprir a obrigação nascida quando o ramo era contratado. O PRIVILÉGIO vale em tudo.
 */

/** D-F47: ramo contratado OU obrigação fiscal já assumida pela nota (só para o que NÃO é transmissão nova). */
async function licensedOrCommitted(ctx: AppContext, inst: InstitutionPayload, invoiceId: number, key: string): Promise<boolean> {
  if (await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key)) return true
  return hasFiscalObligation(ctx.pool, inst.institutionId, invoiceId)
}

/**
 * [newTransmission] é OBRIGATÓRIO (sem default — esquecer não compila): `true` = declarar ao fisco algo novo (licença
 * estrita); `false` = agir sobre o que já foi declarado (consulta, reconferência, cancelamento no fisco — D-F47).
 */
export async function requireBranchPrivilege(
  ctx: AppContext, inst: InstitutionPayload, invoiceId: number, privilegeId: number, opts: { newTransmission: boolean },
): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, inst.institutionId, invoiceId)
  // licença (D-F14/D-F37) nas AÇÕES, para todos: privilégio (ou admin) em ramo NÃO contratado não emite nada NOVO (D-F47)
  const allowed = opts.newTransmission
    ? await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key)
    : await licensedOrCommitted(ctx, inst, invoiceId, key)
  if (!allowed) {
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
 * Privilégio em QUALQUER das interfaces (rotas sem nota específica — ex.: passada do rodízio). D-F47: a passada só
 * consulta tentativas já declaradas ao fisco (todas são obrigação assumida) — com obrigação na institution ela segue
 * mesmo sem ramo contratado e o privilégio conta em qualquer ramo; sem obrigação, só os ramos contratados contam.
 */
export async function requireAnyPrivilege(ctx: AppContext, inst: InstitutionPayload, keys: string[], privilegeId: number): Promise<void> {
  const contracted: string[] = []
  for (const key of keys) if (await erp.institutionHasInterface(ctx.pool, inst.schemaName, inst.institutionId, key)) contracted.push(key)
  const usable = contracted.length < keys.length && await institutionHasFiscalObligation(ctx.pool, inst.institutionId) ? keys : contracted
  if (!usable.length) throw new HttpError(403, 'Nenhuma interface fiscal contratada para este estabelecimento', undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  if (isAdmin(inst)) return
  for (const key of usable) if (await erp.userHasPrivilege(ctx.pool, inst.schemaName, inst.userId, key, privilegeId)) return
  throw new HttpError(403, 'Privilégio necessário para esta ação', undefined, ErrorCodes.PRIVILEGE_REQUIRED)
}

/** Leitura do que é da nota (tela "No fisco", XML, DANFSe): ramo contratado OU obrigação já assumida (D-F47). */
export async function requireBranchInterface(ctx: AppContext, inst: InstitutionPayload, invoiceId: number): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, inst.institutionId, invoiceId)
  if (!(await licensedOrCommitted(ctx, inst, invoiceId, key))) {
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
