import { HttpError, ErrorCodes, InstitutionPayload, isAdmin, erp, access, emissionStillInErp, anyEmissionStillInErp, IssuerModel, InvoiceRef } from 'fiscal-api'
import type { AppContext } from '../context'

/**
 * Autorização de AÇÃO na porta fiscal (D-F13): a REGRA é do ERP (privilégio TRANSMITIR/CANCELAR na
 * interface do RAMO — Q-G22/Q-G29) e a nfse-api a APLICA lendo o schema do cliente; a interface do
 * ramo vem da VIEW de política `vw_order_interface` (D-F32 — uma verdade só).
 * LICENÇA (D-F14) vale para TODOS — D-F37: o admin passa só o PRIVILÉGIO (D32), nunca a interface do ramo
 * não contratada. Leituras e ações exigem a interface do ramo CONTRATADA (Q-N32).
 *
 * A-PV1 (Valdo 2026-10-18 — `Infra-IA/prompts/prompt_privilegios_interfaces.md`, D-PV3: "o super deve escapar de todas as
 * verificações"): o SUPER passa também a LICENÇA — revê a D-F37 SÓ para ele. A cerca da virada (`requireCutover`) NÃO é licença — vale para
 * o super como para todos.
 *
 * COSTURA A1 da auth-api (D-AU3/D-AU6/D-AU8, Valdo 2026-10-31 — `prompt_frente_auth_api.md`): a REGRA deixou de ser copiada aqui. O
 * veredito (licença × perfil × concessão) é a biblioteca ÚNICA do núcleo (`access` — a pilha de views publicada no banco do produto, lida
 * VIVA, sem cache); a "licença sozinha" das leituras (Q-N32) é o ALCANCE (`access.reachableKeys`). O privilégio é citado pelo NOME do verbo
 * (D-PV49/D-PV53 — nenhum número de privilégio nas APIs fiscais). O perfil (`isAdmin` do `requireAdmin`) é o VIVO: o middleware troca o
 * `role` do token pelo da sessão (`access.liveIdentity`).
 */

/** A-PV1/D-F14/D-F37: a interface está ao ALCANCE de quem pede? (super → todas; admin e regular → CONTRATADA). */
async function licensed(ctx: AppContext, inst: InstitutionPayload, key: string): Promise<boolean> {
  return (await access.reachableKeys(ctx.pool, inst, [key])).length > 0
}

export async function requireBranchPrivilege(
  ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef, privilege: access.PrivilegeName,
): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, ref)
  // licença (D-F14/D-F37) antes do privilégio — a ordem do diagnóstico mora na biblioteca (403 INTERFACE_NOT_ALLOWED × PRIVILEGE_REQUIRED)
  const verdict = await access.accessVerdict(ctx.pool, inst, [key], privilege)
  if (verdict === 'not-contracted') {
    throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
  if (verdict === 'no-privilege') {
    throw new HttpError(403, `Privilégio necessário para esta ação na interface ${key}`, undefined, ErrorCodes.PRIVILEGE_REQUIRED)
  }
}

/**
 * CERCA DA VIRADA (D-F18/D-F39): emissão ainda feita pelo ERP → a nfse-api só lê. FALHA ANTECIPADA na borda (antes de ler o
 * ERP); a garantia é do núcleo — `openIssuer`, `nextDpsNumber`, o aluguel e as guardas de escrita recusam a réplica.
 * [grain] (D-NE10 (a) — parte 2 da NE-1a): o MODELO de quem age no fisco ou na habilitação (a nfse-api = SE) × o ESTABELECIMENTO
 * para o A1 (UM por estabelecimento — "a escrita do A1 segue barrada enquanto houver réplica" em qualquer linha).
 */
export async function requireCutover(ctx: AppContext, inst: InstitutionPayload, grain: IssuerModel | 'establishment'): Promise<void> {
  const stillInErp = grain === 'establishment'
    ? await anyEmissionStillInErp(ctx.pool, inst.schemaName, inst.institutionId)
    : await emissionStillInErp(ctx.pool, inst.schemaName, inst.institutionId, grain)
  if (stillInErp) {
    throw new HttpError(409, 'A emissão fiscal desta empresa ainda é feita pelo ERP — esta API só consulta até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
}

/** Ramos (interfaces) que quem pede pode ver: só os ao ALCANCE (contratados — D-F14 —, inclusive para o admin — D-F37; o super vê todos). */
export async function visibleInterfaces(ctx: AppContext, inst: InstitutionPayload, keys: string[]): Promise<string[] | null> {
  return access.reachableKeys(ctx.pool, inst, keys)
}

/**
 * Escopo da PASSADA do rodízio (rota sem nota específica). D-PV40 (2026-10-20): o par conferido é (interface do ramo ×
 * CONSULTAR) — a passada PERGUNTA ao fisco, não transmite; quem chama passa o privilégio (`PRIVILEGE_CONSULTAR`).
 *  - [interfaces] = ramos em que quem pede pode agir — contratados (D-F14/D-F37) E com o privilégio (ou admin): TODAS as
 *    candidatas deles (D-F46 — ramo não contratado não ganha serviço fiscal de carona);
 *  - [liveOnlyInterfaces] = ramos NÃO contratados: só as tentativas JÁ VIVAS (sem voz/S/K) — D-F47 (= Q-F57 (b), Valdo
 *    2026-10-04): fechar o que estava em curso quando o ramo saiu do contrato não é serviço novo; sem isso a nota órfã
 *    ficava viva para sempre e travava o emitente inteiro (trocar ambiente, excluir habilitação/A1). Consultar, cancelar
 *    e ler continuam 403 para todos (D-F46).
 * Nenhum ramo com privilégio → 403 (nada contratado = INTERFACE_NOT_ALLOWED; contratado sem privilégio =
 * PRIVILEGE_REQUIRED), SALVO o admin com NADA contratado: ele roda a passada só sobre as vivas dos ramos cortados (D-F47).
 * A-PV1: para o super todo ramo conta como contratado — todas as chaves vão para [interfaces] (nenhuma "só vivas").
 */
export async function passScope(ctx: AppContext, inst: InstitutionPayload, keys: readonly string[], privilege: access.PrivilegeName)
  : Promise<{ interfaces: string[]; liveOnlyInterfaces: string[] }> {
  const reach = new Set(await access.reachableKeys(ctx.pool, inst, keys))
  const liveOnlyInterfaces = keys.filter(k => !reach.has(k))
  const contracted = reach.size > 0
  const interfaces = contracted ? await access.grantedKeys(ctx.pool, inst, keys.filter(k => reach.has(k)), privilege) : []
  if (interfaces.length > 0 || (isAdmin(inst) && !contracted)) return { interfaces, liveOnlyInterfaces }
  if (!contracted) throw new HttpError(403, 'Nenhuma interface fiscal contratada para este estabelecimento', undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  throw new HttpError(403, 'Privilégio necessário para esta ação', undefined, ErrorCodes.PRIVILEGE_REQUIRED)
}

export async function requireBranchInterface(ctx: AppContext, inst: InstitutionPayload, ref: InvoiceRef): Promise<void> {
  const key = await erp.orderInterface(ctx.pool, inst.schemaName, ref)
  if (!(await licensed(ctx, inst, key))) {
    throw new HttpError(403, `Interface ${key} não contratada para este estabelecimento`, undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
  }
}

export async function requireAnyInterface(ctx: AppContext, inst: InstitutionPayload, keys: string[]): Promise<void> {
  if ((await access.reachableKeys(ctx.pool, inst, keys)).length > 0) return
  throw new HttpError(403, 'Nenhuma interface fiscal contratada para este estabelecimento', undefined, ErrorCodes.INTERFACE_NOT_ALLOWED)
}

/** Emitente (A1 + habilitação) é ato do ADMIN do estabelecimento (adminGuard do produto) — pelo perfil VIVO (`access.liveIdentity`). */
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
