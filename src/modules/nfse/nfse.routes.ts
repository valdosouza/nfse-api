import { Router } from 'express'
import { route, sendOk, institutionOf, InstitutionPayload, InvoiceRef, erp, invoiceRef, SERVICE_ISSUER_MODEL, WEB_TERMINAL } from 'fiscal-api'
import type { AppContext } from '../../context'
import type { Actor } from '../../nfse/transmission'
import * as tx from '../../nfse/transmission'
import { renderDanfse } from '../../nfse/danfse'
import { emitterDisplay } from '../../facts/service-facts'
import { requireBranchPrivilege, requireBranchInterface, passScope, requireCutover, visibleInterfaces, parseInvoiceId } from '../guards'
import { parseWith } from '../validate'
import { cancelDto, refreshPassDto, pendingQueryDto } from './nfse.dto'

/**
 * /v1/nfse — o ciclo da NFS-e de uma nota do ERP (contrato: openapi/nfse-api.v1.yaml). O app manda só
 * a REFERÊNCIA da nota (D-F10). Ações: privilégio do RAMO (TRANSMITIR/CANCELAR — D-F13; D-PV40: consultar o fisco sem mudar
 * estado nele = CONSULTAR — `refresh` por nota e a passada do rodízio); leituras: a
 * interface do ramo contratada (Q-N32/D-F14). Router fino: a política vive em `nfse/transmission.ts`.
 */

const BRANCH_INTERFACES = ['service-orders', 'orders']
/**
 * Passada do rodízio (D-F46): o MESMO domínio da guarda por nota (`erp.orderInterface` → requireBranchPrivilege) — a
 * passada é o "consultar" de várias notas de uma vez, então cada nota só entra se o ramo dela entraria na rota por nota.
 */
const PASS_INTERFACES = ['service-orders', 'orders', 'order-returns'] as const
const actorOf = (inst: InstitutionPayload): Actor => ({ schemaName: inst.schemaName, institutionId: inst.institutionId, userId: inst.userId })
/**
 * NE-1a parte 2 (D-NE12/D-NE59): a BORDA monta a referência INTEIRA da nota — o id da rota + o estabelecimento do token + o terminal das
 * notas da web (`WEB_TERMINAL` só aqui, na borda HTTP); daqui para dentro a nota viaja inteira (guardas, composição, SQL da família).
 */
const webRefOf = (inst: InstitutionPayload, raw: string): InvoiceRef => invoiceRef(inst.institutionId, parseInvoiceId(raw), WEB_TERMINAL)

export function nfseRoutes(ctx: AppContext): Router {
  const router = Router()

  router.get('/invoices/pending', route('GET /v1/nfse/invoices/pending', async (req, res) => {
    const inst = institutionOf(req)
    const { interfaceKey, ...page } = parseWith(pendingQueryDto, req.query)
    const visible = await visibleInterfaces(ctx, inst, BRANCH_INTERFACES)
    // D-F145: o ramo pedido, dentro do que é visível (não contratado → lista vazia)
    const interfaces = interfaceKey ? (visible ?? BRANCH_INTERFACES).filter(k => k === interfaceKey) : visible
    // envelope paginado da casa: { ok, data, page, pageSize, total }
    res.status(200).json({ ok: true, ...(await tx.listPending(ctx, actorOf(inst), WEB_TERMINAL, page, interfaces)) })
  }))

  router.get('/invoices/:invoiceId', route('GET /v1/nfse/invoices/:invoiceId', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)
    sendOk(res, await tx.getServiceFiscalView(ctx, actorOf(inst), ref))
  }))

  router.post('/invoices/:invoiceId/transmit', route('POST /v1/nfse/invoices/:invoiceId/transmit', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    await requireBranchPrivilege(ctx, inst, ref, 'TRANSMITIR')
    sendOk(res, await tx.transmitServiceInvoice(ctx, actorOf(inst), ref), 201)
  }))

  router.post('/invoices/:invoiceId/refresh', route('POST /v1/nfse/invoices/:invoiceId/refresh', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    await requireBranchPrivilege(ctx, inst, ref, 'CONSULTAR')      // D-PV40: consultar ≠ transmitir
    sendOk(res, await tx.refreshServiceTransmission(ctx, actorOf(inst), ref, 'Q', { origin: 'consulta' }))   // D-F95
  }))

  router.post('/invoices/:invoiceId/reconfirm', route('POST /v1/nfse/invoices/:invoiceId/reconfirm', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    await requireBranchPrivilege(ctx, inst, ref, 'CANCELAR')
    sendOk(res, await tx.reconfirmBeforeLocalCancel(ctx, actorOf(inst), ref))
  }))

  router.post('/invoices/:invoiceId/cancel', route('POST /v1/nfse/invoices/:invoiceId/cancel', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    await requireBranchPrivilege(ctx, inst, ref, 'CANCELAR')
    const body = parseWith(cancelDto, req.body)
    sendOk(res, await tx.cancelServiceInvoiceAtAuthority(ctx, actorOf(inst), ref, body.reason))
  }))

  router.get('/invoices/:invoiceId/xml', route('GET /v1/nfse/invoices/:invoiceId/xml', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)
    const { accessKey, xml } = await tx.readNfseXml(ctx, actorOf(inst), ref)
    sendOk(res, { accessKey, xml })
  }))

  router.get('/invoices/:invoiceId/danfse', route('GET /v1/nfse/invoices/:invoiceId/danfse', async (req, res) => {
    const inst = institutionOf(req)
    const ref = webRefOf(inst, req.params.invoiceId)
    await requireBranchInterface(ctx, inst, ref)
    const { accessKey, xml, cancelled } = await tx.readNfseXml(ctx, actorOf(inst), ref)
    const { name, municipality } = await emitterDisplay(ctx.pool, inst.institutionId)
    const pdf = await renderDanfse(xml, { issuerName: name, municipality, cancelled })
    sendOk(res, { accessKey, pdfBase64: pdf.toString('base64') })
  }))

  router.post('/refresh', route('POST /v1/nfse/refresh', async (req, res) => {
    const inst = institutionOf(req)
    await requireCutover(ctx, inst, SERVICE_ISSUER_MODEL)
    const scope = await passScope(ctx, inst, PASS_INTERFACES, 'CONSULTAR')           // D-F46/D-F47 · D-PV40: a passada CONSULTA
    const body = parseWith(refreshPassDto, req.body)
    sendOk(res, await tx.refreshOpenServiceTransmissions(ctx, actorOf(inst), { terminal: WEB_TERMINAL, minMinutes: body.minMinutes, limit: body.limit, ...scope }))
  }))

  return router
}
