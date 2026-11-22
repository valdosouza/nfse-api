import { Router } from 'express'
import { route, sendOk, institutionOf } from 'fiscal-api'
import type { AppContext } from '../../context'
import { requireVendorSuper } from '../guards'
import { parseWith } from '../validate'
import { saveCredentialDto, endCredentialDto } from './provider.dto'
import * as service from './provider.service'

/**
 * /v1/provider — a configuração fiscal do FORNECEDOR do produto (a Setes), simétrica a /v1/emitter (a do estabelecimento). Hoje: a
 * credencial fiscal por UF (o CSRT do PR — D-NE221/D-NE224). Só o super com vínculo à Setes (D-NE224); a leitura também (escolha da
 * ficha CRED.E1.P1). Contrato: openapi/nfse-api.v1.yaml. Router fino: a regra está na peça do núcleo e a borda no service.
 */
export function providerRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/fiscal-credentials', route('GET /v1/provider/fiscal-credentials', async (req, res) => {
    requireVendorSuper(institutionOf(req))
    sendOk(res, await service.listCredentials(ctx))
  }))

  router.post('/fiscal-credentials', route('POST /v1/provider/fiscal-credentials', async (req, res) => {
    const inst = institutionOf(req); requireVendorSuper(inst)
    sendOk(res, await service.saveCredential(ctx, inst, parseWith(saveCredentialDto, req.body)), 201)
  }))

  router.post('/fiscal-credentials/end', route('POST /v1/provider/fiscal-credentials/end', async (req, res) => {
    const inst = institutionOf(req); requireVendorSuper(inst)
    sendOk(res, await service.endCredential(ctx, inst, parseWith(endCredentialDto, req.body)))
  }))

  return router
}
