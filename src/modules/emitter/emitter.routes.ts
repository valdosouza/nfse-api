import { Router } from 'express'
import { route, sendOk, institutionOf, SERVICE_ISSUER_MODEL } from 'fiscal-api'
import type { AppContext } from '../../context'
import { requireAdmin, requireCutover } from '../guards'
import { parseWith } from '../validate'
import { issuerDto, certificateDto } from './emitter.dto'
import * as service from './emitter.service'

/**
 * /v1/emitter — o A1 e a habilitação do estabelecimento do token (contrato: openapi/nfse-api.v1.yaml).
 * Ato do ADMIN da institution. Router fino: a regra está no service.
 */
export function emitterRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/', route('GET /v1/emitter', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst)
    sendOk(res, await service.fetchEmitter(ctx, inst))
  }))

  router.put('/certificate', route('PUT /v1/emitter/certificate', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst); await requireCutover(ctx, inst, 'establishment')   // o A1 é UM (D-N31)
    sendOk(res, await service.saveCertificate(ctx, inst, parseWith(certificateDto, req.body)))
  }))

  router.delete('/certificate', route('DELETE /v1/emitter/certificate', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst); await requireCutover(ctx, inst, 'establishment')
    sendOk(res, await service.removeCertificate(ctx, inst))
  }))

  router.put('/issuers/:model', route('PUT /v1/emitter/issuers/:model', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst); await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)   // a nfse-api só habilita a SE
    sendOk(res, await service.saveIssuer(ctx, inst, req.params.model, parseWith(issuerDto, req.body)))
  }))

  router.delete('/issuers/:model', route('DELETE /v1/emitter/issuers/:model', async (req, res) => {
    const inst = institutionOf(req); requireAdmin(inst); await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    sendOk(res, await service.removeIssuer(ctx, inst, req.params.model))
  }))

  return router
}
