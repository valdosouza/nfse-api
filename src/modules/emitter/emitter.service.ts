import {
  HttpError, ErrorCodes, logger, withTransaction, erp, InstitutionPayload,
  IssuerModel, IssuerEnvironment, IssuerCertificateStatus, IssuerAuthority,
  listIssuers, getIssuer, upsertIssuer, softDeleteIssuer, certificateStatus, isIssuerEnabled, authorityOf,
  storeCertificate, clearCertificate, assertEmitterWritable,
} from 'fiscal-api'
import type { AppContext } from '../../context'
import { countLiveTransmissions } from '../../nfse/repository'
import type { IssuerDto, CertificateDto } from './emitter.dto'

/**
 * Emitente do estabelecimento na nfse-api: o A1 (comum às famílias — D-N31) e a habilitação do
 * modelo SE. Molde: `establishment.issuer.service.ts` do setes-api — mesmas guardas (D-I26/D-I27
 * espelhadas): trocar o AMBIENTE ou excluir com transmissão VIVA → 409.
 */

export interface IssuerItemView {
  model:       IssuerModel
  environment: IssuerEnvironment
  serie:       string | null
  enabled:     boolean
  authority:   IssuerAuthority
  /** D-F39: desde quando esta API emite por esta habilitação; null = réplica do ERP. */
  cutoverAt:   string | null
}

export interface EmitterView {
  issuers:     IssuerItemView[]
  certificate: IssuerCertificateStatus
}

const MODEL: IssuerModel = 'SE'

export async function fetchEmitter(ctx: AppContext, inst: InstitutionPayload): Promise<EmitterView> {
  const rows = await listIssuers(ctx.pool, inst.institutionId)
  const certificate = await certificateStatus(ctx.pool, inst.institutionId)
  return {
    // D-F39: `cutoverAt` null = RÉPLICA do ERP (esta API só lê); habilitada = virada + A1 vigente
    issuers: rows.map(r => ({ model: r.model, environment: r.environment, serie: r.serie, cutoverAt: r.cutoverAt,
      enabled: !!r.cutoverAt && isIssuerEnabled(certificate), authority: authorityOf(r.model) })),
    certificate,
  }
}

function assertModel(model: string): IssuerModel {
  if (model !== MODEL) {
    throw new HttpError(422, `A nfse-api só habilita o modelo SE (recebido ${model}) — 55/65 são da nfe-api`,
      [{ field: 'model', message: 'Modelo não suportado nesta API' }], ErrorCodes.FISCAL_MODEL_NOT_SUPPORTED)
  }
  return MODEL
}

export async function saveIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string, input: IssuerDto): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  const serie = String(Number(input.serie))
  await withTransaction(ctx.pool, 'habilitação do emissor', { institutionId: inst.institutionId, model }, async conn => {
    // D-F39: a CERCA é a 1ª instrução (trava por linha + réplica/lacuna) — antes de qualquer outra leitura; com a linha do
    // modelo travada ANTES dela, dois modelos vivos (SE + 55 da nfe-api) se cruzariam (gates do delta de 2026-10-04)
    await assertEmitterWritable(conn, inst.schemaName, inst.institutionId)
    const current = await getIssuer(conn, inst.institutionId, model, true)
    if (current && current.environment !== input.environment) {
      const live = await countLiveTransmissions(conn, inst.institutionId, current.environment)
      if (live > 0) {
        throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no ambiente ${current.environment === 'P' ? 'produção' : 'homologação'} — aguarde a voz do fisco antes de mudar o ambiente`,
          [{ field: 'environment', message: `${live} transmissão(ões) viva(s) em ${current.environment}` }], ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
      }
    }
    await upsertIssuer(conn, inst.schemaName, inst.institutionId, model, { environment: input.environment, serie, userId: inst.userId })
  })
  logger.info('Habilitação do emissor fiscal salva', { institutionId: inst.institutionId, model, environment: input.environment, serie })
  return fetchEmitter(ctx, inst)
}

export async function removeIssuer(ctx: AppContext, inst: InstitutionPayload, modelRaw: string): Promise<EmitterView> {
  const model = assertModel(modelRaw)
  await withTransaction(ctx.pool, 'excluir habilitação do emissor', { institutionId: inst.institutionId, model }, async conn => {
    await assertEmitterWritable(conn, inst.schemaName, inst.institutionId)          // D-F39: a cerca é a 1ª instrução
    const current = await getIssuer(conn, inst.institutionId, model, true)
    if (!current) throw new HttpError(404, `Estabelecimento não tem habilitação do emissor para o modelo ${model}`, undefined, ErrorCodes.FISCAL_ISSUER_MISSING)
    const live = await countLiveTransmissions(conn, inst.institutionId)
    if (live > 0) {
      throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no fisco — aguarde a voz do fisco antes de excluir a habilitação`,
        undefined, ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
    }
    await softDeleteIssuer(conn, inst.schemaName, inst.institutionId, model)
  })
  logger.info('Habilitação do emissor fiscal excluída (A1 mantido)', { institutionId: inst.institutionId, model })
  return fetchEmitter(ctx, inst)
}

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

export async function saveCertificate(ctx: AppContext, inst: InstitutionPayload, input: CertificateDto): Promise<IssuerCertificateStatus> {
  if (!BASE64_RE.test(input.pfxBase64)) {
    throw new HttpError(400, 'Arquivo .pfx precisa vir em base64', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  const pfx = Buffer.from(input.pfxBase64, 'base64')
  if (pfx.length === 0) throw new HttpError(400, 'Arquivo .pfx vazio', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  // D-N29: o A1 tem que ser do CNPJ do emitente — o CNPJ vem do ERP (fonte de fatos)
  const expectedCnpj = await erp.establishmentCnpj(ctx.pool, inst.institutionId)
  const status = await storeCertificate({ pool: ctx.pool, keyring: ctx.keyring }, inst.institutionId, pfx, input.password,
    { expectedCnpj, userId: inst.userId, schemaName: inst.schemaName })
  logger.info('Certificado A1 do emissor atualizado (cifrado no fiscal_api)', {
    institutionId: inst.institutionId, cnpj: status.certificateInfo?.cnpj ?? null, notAfter: status.certificateInfo?.notAfter ?? null,
  })
  return status
}

export async function removeCertificate(ctx: AppContext, inst: InstitutionPayload): Promise<IssuerCertificateStatus> {
  // gate adversarial da F1: sem o A1 nenhuma tentativa viva (em voo / K) se reconcilia — mesma guarda da habilitação.
  // A trava da habilitação SE serializa com a reserva (que a lê FOR UPDATE antes de abrir o A1).
  const status = await clearCertificate({ pool: ctx.pool, keyring: ctx.keyring }, inst.institutionId, inst.userId, { schemaName: inst.schemaName, guard: async conn => {
    await getIssuer(conn, inst.institutionId, 'SE', true)
    const live = await countLiveTransmissions(conn, inst.institutionId)
    if (live > 0) {
      throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no fisco — aguarde a voz do fisco antes de excluir o certificado`,
        undefined, ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
    }
  } })
  logger.info('Certificado A1 do emissor removido', { institutionId: inst.institutionId })
  return status
}
