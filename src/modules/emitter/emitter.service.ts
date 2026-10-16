import {
  HttpError, ErrorCodes, InstitutionPayload, IssuerModel, erp, IssuerCertificateStatus, EmitterActor, EmitterView, IssuerItemView,
  emitterView, writeIssuer, deleteIssuer, uploadCertificate, deleteCertificate, modelsOf,
} from 'fiscal-api'
import type { AppContext } from '../../context'
import type { IssuerDto, CertificateDto } from './emitter.dto'

/**
 * Emitente do estabelecimento na nfse-api = o EMITTER do núcleo (D-NE9 — parte 2 da NE-1a) montado para a família de SERVIÇO: a
 * política (cerca por modelo, vivas da família na habilitação, vivas de TODAS as famílias no DELETE do A1) mora no núcleo; aqui fica a
 * borda — o DTO (série do DPS) e a recusa do modelo que não é desta API.
 */

export type { EmitterView, IssuerItemView }

const BRANCH = 'service' as const
const MODELS = modelsOf(BRANCH)

const actorOf = (inst: InstitutionPayload): EmitterActor => ({ institutionId: inst.institutionId, userId: inst.userId, schemaName: inst.schemaName })

export async function fetchEmitter(ctx: AppContext, inst: InstitutionPayload): Promise<EmitterView> {
  return emitterView(ctx, inst.institutionId, BRANCH)
}

function assertModel(model: string): IssuerModel {
  const mine = MODELS.find(m => m === model)
  if (!mine) {
    throw new HttpError(422, `A nfse-api só habilita o modelo SE (recebido ${model}) — 55/65 são da nfe-api`,
      [{ field: 'model', message: 'Modelo não suportado nesta API' }], ErrorCodes.FISCAL_MODEL_NOT_SUPPORTED)
  }
  return mine
}

export async function saveIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string, input: IssuerDto): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  await writeIssuer(ctx, actorOf(inst), model, { environment: input.environment, serie: String(Number(input.serie)) })
  return fetchEmitter(ctx, inst)
}

export async function removeIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  await deleteIssuer(ctx, actorOf(inst), model)
  return fetchEmitter(ctx, inst)
}

export async function saveCertificate(ctx: AppContext, inst: InstitutionPayload, input: CertificateDto): Promise<IssuerCertificateStatus> {
  // D-N29: o A1 tem que ser do CNPJ do emitente — o CNPJ vem do ERP (fonte de fatos), lido aqui na borda.
  // D-CJ2 (gate socrático da onda 0 do CNPJ alfanumérico): o FATO em três estados chega à conferência — com o valor já achatado
  // (`establishmentCnpj`, válido ou null) um CNPJ com DV errado virava "Estabelecimento sem CNPJ", o diagnóstico enganoso do §4.4
  // (caminho feliz com UMA leitura — o CNPJ válido; o fato só é lido quando falta ou está errado, para dizer qual dos dois)
  const expectedCnpj = (await erp.establishmentCnpj(ctx.pool, inst.institutionId)) ?? await erp.establishmentCnpjFact(ctx.pool, inst.institutionId)
  return uploadCertificate(ctx, actorOf(inst), input, { expectedCnpj })
}

export async function removeCertificate(ctx: AppContext, inst: InstitutionPayload): Promise<IssuerCertificateStatus> {
  return deleteCertificate(ctx, actorOf(inst))
}
