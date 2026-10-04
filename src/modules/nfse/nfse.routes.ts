import { Router } from 'express'
import { route, sendOk, institutionOf, InstitutionPayload, erp } from 'fiscal-api'
import type { AppContext } from '../../context'
import type { Actor } from '../../nfse/transmission'
import * as tx from '../../nfse/transmission'
import { renderDanfse } from '../../nfse/danfse'
import { emitterDisplay } from '../../facts/service-facts'
import { requireBranchPrivilege, requireBranchInterface, requireAnyPrivilege, requireCutover, visibleInterfaces, parseInvoiceId } from '../guards'
import { parseWith } from '../validate'
import { cancelDto, refreshPassDto, pendingQueryDto } from './nfse.dto'

/**
 * /v1/nfse — o ciclo da NFS-e de uma nota do ERP (contrato: openapi/nfse-api.v1.yaml). O app manda só
 * a REFERÊNCIA da nota (D-F10). Ações: privilégio do RAMO (TRANSMITIR/CANCELAR — D-F13); leituras: a
 * interface do ramo contratada (Q-N32/D-F14). Router fino: a política vive em `nfse/transmission.ts`.
 */

const BRANCH_INTERFACES = ['service-orders', 'orders']
/**
 * Passada do rodízio (D-F46): o MESMO domínio da guarda por nota (`erp.orderInterface` → requireBranchPrivilege) — a
 * passada é o "consultar" de várias notas de uma vez, então cada nota só entra se o ramo dela entraria na rota por nota.
 */
const PASS_INTERFACES = ['service-orders', 'orders', 'order-returns'] as const
const actorOf = (inst: InstitutionPayload): Actor => ({ schemaName: inst.schemaName, institutionId: inst.institutionId, userId: inst.userId })

export function nfseRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/invoices/pending', route('GET /v1/nfse/invoices/pending', async (req, res) => {
    const inst = institutionOf(req)
    const page = parseWith(pendingQueryDto, req.query)
    const interfaces = await visibleInterfaces(ctx, inst, BRANCH_INTERFACES)
    // envelope paginado da casa: { ok, data, page, pageSize, total }
    res.status(200).json({ ok: true, ...(await tx.listPending(ctx, actorOf(inst), page, interfaces)) })
  }))

  router.get('/invoices/:invoiceId', route('GET /v1/nfse/invoices/:invoiceId', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireBranchInterface(ctx, inst, invoiceId)
    sendOk(res, await tx.getServiceFiscalView(ctx, actorOf(inst), invoiceId))
  }))

  router.post('/invoices/:invoiceId/transmit', route('POST /v1/nfse/invoices/:invoiceId/transmit', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireCutover(ctx, inst)
    await requireBranchPrivilege(ctx, inst, invoiceId, erp.PRIVILEGE_TRANSMITIR)
    sendOk(res, await tx.transmitServiceInvoice(ctx, actorOf(inst), invoiceId), 201)
  }))

  router.post('/invoices/:invoiceId/refresh', route('POST /v1/nfse/invoices/:invoiceId/refresh', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireCutover(ctx, inst)
    await requireBranchPrivilege(ctx, inst, invoiceId, erp.PRIVILEGE_TRANSMITIR)
    sendOk(res, await tx.refreshServiceTransmission(ctx, actorOf(inst), invoiceId, 'Q'))
  }))

  router.post('/invoices/:invoiceId/reconfirm', route('POST /v1/nfse/invoices/:invoiceId/reconfirm', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireCutover(ctx, inst)
    await requireBranchPrivilege(ctx, inst, invoiceId, erp.PRIVILEGE_CANCELAR)
    sendOk(res, await tx.reconfirmBeforeLocalCancel(ctx, actorOf(inst), invoiceId))
  }))

  router.post('/invoices/:invoiceId/cancel', route('POST /v1/nfse/invoices/:invoiceId/cancel', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireCutover(ctx, inst)
    await requireBranchPrivilege(ctx, inst, invoiceId, erp.PRIVILEGE_CANCELAR)
    const body = parseWith(cancelDto, req.body)
    sendOk(res, await tx.cancelServiceInvoiceAtAuthority(ctx, actorOf(inst), invoiceId, body.reason))
  }))

  router.get('/invoices/:invoiceId/xml', route('GET /v1/nfse/invoices/:invoiceId/xml', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireBranchInterface(ctx, inst, invoiceId)
    const { accessKey, xml } = await tx.readNfseXml(ctx, actorOf(inst), invoiceId)
    sendOk(res, { accessKey, xml })
  }))

  router.get('/invoices/:invoiceId/danfse', route('GET /v1/nfse/invoices/:invoiceId/danfse', async (req, res) => {
    const inst = institutionOf(req)
    const invoiceId = parseInvoiceId(req.params.invoiceId)
    await requireBranchInterface(ctx, inst, invoiceId)
    const { accessKey, xml, cancelled } = await tx.readNfseXml(ctx, actorOf(inst), invoiceId)
    const { name, municipality } = await emitterDisplay(ctx.pool, inst.institutionId)
    const pdf = await renderDanfse(xml, { issuerName: name, municipality, cancelled })
    sendOk(res, { accessKey, pdfBase64: pdf.toString('base64') })
  }))

  router.post('/refresh', route('POST /v1/nfse/refresh', async (req, res) => {
    const inst = institutionOf(req)
    await requireCutover(ctx, inst)
    const interfaces = await requireAnyPrivilege(ctx, inst, PASS_INTERFACES, erp.PRIVILEGE_TRANSMITIR)
    const body = parseWith(refreshPassDto, req.body)
    sendOk(res, await tx.refreshOpenServiceTransmissions(ctx, actorOf(inst), { minMinutes: body.minMinutes, limit: body.limit, interfaces }))
  }))

  return router
}
