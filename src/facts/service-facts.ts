import {
  HttpError, FieldError, ErrorCodes, Queryable, assertSchema, erp, nowIsoIn, InvoiceRef, InvoiceScope,
  LIVE_VOICE_KINDS, AUTHORIZED_KINDS, sqlKindList, readFederalIdFact, FederalIdFact, FederalIdKind, normalizeCnpj,
} from 'fiscal-api'
import type { DpsInput, DpsIbscbs, DpsToma, DpsTotTrib, AuthorityEnvironment } from '../authority/types'
import { cnpjAlphanumericAccepted } from '../authority/layout-calendar'

/**
 * FONTE DE FATOS DO RAMO DE SERVIÇO (D-F10) — o que a nfse-api lê do ERP para montar o DPS. Com a
 * base do núcleo (`erp` — cadeia, tributação, fuso, políticas), é o ÚNICO lugar da nfse-api que
 * conhece `tb_invoice`/`tb_entity*` (cerca do critério §12.8-1). Só LÊ (D-F31).
 *
 * Origem: `branches/service.ts` do setes-api (Onda 3) — mesmas regras, mesmos 422 de cadastro:
 *  - ramo congelado no faturamento (`tb_invoice_service`); emitente/tomador lidos AGORA (o XML
 *    assinado é o snapshot); emitente = a institution (D-E3/D-E23);
 *  - matriz do Anexo I (Q-N36/Q-N37) e regra do pAliq no Simples (E0625/E0621);
 *  - L8: base do ISS ≠ valor do serviço → 422 antes de reservar.
 * Mudança da extração: o nDPS NÃO é mais lido do ramo (`dps_number` aposentado — D-F30); a vida e o
 * último evento vêm da VIEW de política `vw_invoice_life` (D-F32).
 */

export const SERVICE_MODEL = 'SE' as const
/** verAplic do DPS (1–20 chars). */
export const VER_APLIC = 'SETES-NFSE-API-1.0'

export interface ServiceBranchRow {
  serviceListId: string | null
  nationalCode:  string | null
  municipalCode: string | null
  cityId:        number | null
  baseIss:       number
  aliqIss:       number
  issValue:      number
  issWithheld:   'S' | 'N'
  liability:     '1' | '2' | '3' | '4'
  description:   string | null
  totalValue:    number
  /** IB-3 (D-IB41/D-IB76…): a DECLARAÇÃO IBS/CBS que o ERP CONGELOU no ramo (IB-2 — escritor único `issueInvoice`), lida CRUA; a forma é
   *  conferida só por quem monta o DPS (`buildDpsBase`). A nfse-api NUNCA re-deriva pela presunção do serviço nem consulta o catálogo. */
  declaration: { classificationCode: string | null; placeIndicatorCode: string | null; nbs: string | null }
}

export interface ServiceInvoiceHeader {
  invoiceId:   number
  number:      string | null
  serie:       string | null
  model:       string | null
  value:       number
  dtEmission:  string
  entityId:    number
  status:      string
  /** Último evento da NOTA (E/C); null = sincronizada (sem história na web). */
  lastInvoiceKind:  string | null
  /** Nº do último evento — conferido de novo SOB a trava da reserva (MEDIUM-3). */
  lastInvoiceEvent: number | null
  /** Vida vigente (evento E mais recente — D-N27). */
  lifeEvent:   number | null
  /** updated_at do ramo lido FORA da transação — conferido de novo dentro (MEDIUM-3). */
  branchUpdatedAt: string | null
  branch:      ServiceBranchRow
}

/**
 * Nota emitida POR ESTE estabelecimento, viva, com o ramo de serviço. Sem ramo → 422
 * INVOICE_SERVICE_BRANCH_MISSING. Leitura fora de transação (a reserva confere de novo sob a trava).
 */
export async function readServiceInvoice(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<ServiceInvoiceHeader> {
  const s = assertSchema(schemaName)
  const { invoiceId } = ref
  const [rows] = await q.query(
    `SELECT i.id, i.number, i.serie, i.model, i.value, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission,
            i.tb_entity_id AS entityId, i.status,
            l.last_kind AS lastKind, l.last_event AS lastEvent, l.life_event AS lifeEvent,
            DATE_FORMAT(sv.updated_at, '%Y-%m-%d %H:%i:%s') AS branchUpdatedAt,
            sv.id AS branchId, sv.tb_service_list_id AS serviceListId, sv.national_code AS nationalCode,
            sv.municipal_code AS municipalCode, sv.tb_city_id AS cityId, sv.base_iss_value AS baseIss,
            sv.aliq_iss AS aliqIss, sv.iss_value AS issValue, sv.iss_withheld AS issWithheld, sv.liability,
            CONVERT(sv.description USING utf8mb4) AS description, sv.total_value AS totalValue,
            sv.classification_code AS classificationCode, sv.place_indicator_code AS placeIndicatorCode, sv.nbs AS nbs
       FROM \`${s}\`.tb_invoice i
       LEFT JOIN \`${s}\`.vw_invoice_life l
         ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = i.terminal
       LEFT JOIN \`${s}\`.tb_invoice_service sv
         ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
      WHERE i.id = ? AND i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  const r = rows[0]
  if (!r) throw new HttpError(404, `Nota ${invoiceId} emitida por este estabelecimento não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  if (r.branchId == null) {
    throw new HttpError(422, `Nota ${invoiceId} não tem ramo de serviço — só nota com serviço gera DPS`,
      [{ field: 'service', message: 'Ramo de serviço ausente' }], ErrorCodes.INVOICE_SERVICE_BRANCH_MISSING)
  }
  return {
    invoiceId: Number(r.id), number: r.number ?? null, serie: r.serie ?? null, model: r.model ?? null,
    value: Number(r.value ?? 0), dtEmission: String(r.dtEmission), entityId: Number(r.entityId),
    status: String(r.status ?? ''), lastInvoiceKind: r.lastKind ?? null,
    lastInvoiceEvent: r.lastEvent == null ? null : Number(r.lastEvent),
    lifeEvent: r.lifeEvent == null ? null : Number(r.lifeEvent),
    branchUpdatedAt: r.branchUpdatedAt ?? null,
    branch: {
      serviceListId: r.serviceListId ?? null, nationalCode: r.nationalCode ?? null, municipalCode: r.municipalCode ?? null,
      cityId: r.cityId == null ? null : Number(r.cityId), baseIss: Number(r.baseIss ?? 0), aliqIss: Number(r.aliqIss ?? 0),
      issValue: Number(r.issValue ?? 0), issWithheld: r.issWithheld === 'S' ? 'S' : 'N',
      liability: (['1', '2', '3', '4'].includes(String(r.liability)) ? String(r.liability) : '1') as ServiceBranchRow['liability'],
      description: r.description ?? null, totalValue: Number(r.totalValue ?? 0),
      declaration: {
        classificationCode: r.classificationCode ?? null, placeIndicatorCode: r.placeIndicatorCode ?? null, nbs: r.nbs ?? null,
      },
    },
  }
}

/**
 * A DECLARAÇÃO IBS/CBS do ramo na forma do DPS (IB-3 — D-IB62/D-IB76…): o par completo vira o grupo (`DpsIbscbs`), a NBS vai como `cNBS`
 * (com o grupo sempre — E0322; sem ele, sozinha — D-IB62). Quem lê dado de OUTRO serviço confere antes de mandar ao fisco: par incompleto,
 * grupo sem NBS ou forma fora de 6/6/9 dígitos = 422 `FISCAL_DPS_INVALID` com o campo — nunca "descartar o grupo calado" (um envio
 * obrigatório perdido sem ninguém ver). O ERP já tem os CHECKs (066/070); isto é a borda da nfse-api.
 */
export function declarationForDps(d: ServiceBranchRow['declaration']): { ibscbs?: DpsIbscbs; cNBS?: string } {
  const cls = d.classificationCode?.trim() || null
  const place = d.placeIndicatorCode?.trim() || null
  const nbs = d.nbs?.trim() || null
  const fields: FieldError[] = []
  if ((cls === null) !== (place === null)) fields.push({ field: 'ibscbs', message: 'Declaração IBS/CBS incompleta no ramo (cClassTrib e cIndOp vêm juntos)' })
  if (cls !== null && nbs === null) fields.push({ field: 'nbs', message: 'Grupo IBS/CBS sem NBS (E0322)' })
  if (cls !== null && !/^\d{6}$/.test(cls)) fields.push({ field: 'ibscbs.classificationCode', message: 'cClassTrib fora da forma (6 dígitos)' })
  if (place !== null && !/^\d{6}$/.test(place)) fields.push({ field: 'ibscbs.placeIndicatorCode', message: 'cIndOp fora da forma (6 dígitos)' })
  if (nbs !== null && !/^\d{9}$/.test(nbs)) fields.push({ field: 'nbs', message: 'NBS fora da forma (9 dígitos)' })
  if (fields.length) {
    throw new HttpError(422, 'Declaração IBS/CBS congelada na nota fora da forma do DPS — cancele e refature a nota no ERP',
      fields, ErrorCodes.FISCAL_DPS_INVALID)
  }
  return {
    ...(cls !== null && place !== null ? { ibscbs: { cIndOp: place, cClassTrib: cls } } : {}),
    ...(nbs !== null ? { cNBS: nbs } : {}),
  }
}

/**
 * Rejeições do Anexo I que o GRUPO IBS/CBS abre e que se sabem NA MONTAGEM (gate adversarial da IB-3, MEDIUM — molde da E0322 e das
 * E0166/E0712 da Onda 3): 422 local com o campo, nunca um DPS que o fisco vai rejeitar. Sem o grupo, a mesma nota segue como antes.
 *  - RN 255 / E0234: com estes cIndOp o ENDEREÇO do tomador é obrigatório (`buildRecipient` omite `toma.end` quando o cadastro está
 *    incompleto — o XSD o deixa opcional) — Anexo I, aba "RN DPS_NFS-e", regra 255;
 *  - RN 547 / E0903: serviço dos subitens 25.05 / 15.09 / 17.12 / 10.05 (cTribNac) exige `tpOper` no grupo — o montador não o emite
 *    (fora do 1º release da IB-3): recusa "ainda não suportado" em vez de rejeição do fisco — Anexo I, regra 547.
 */
export const CIND_OP_REQUIRES_RECIPIENT_ADDRESS: ReadonlySet<string> = new Set([
  '030102', '050102', '100101', '100301', '100501', '030103', '050103', '100102', '100201', '100302', '100401', '100502', '100601',
])
export const TP_OPER_SERVICE_SUBITEMS: ReadonlySet<string> = new Set(['2505', '1509', '1712', '1005'])

export function assertIbscbsGroupDeliverable(g: DpsIbscbs, toma: DpsToma, nationalCode: string): void {
  if (CIND_OP_REQUIRES_RECIPIENT_ADDRESS.has(g.cIndOp) && !toma.end) {
    throw new HttpError(422, `O indicador de operação IBS/CBS ${g.cIndOp} exige o endereço completo do tomador (E0234) — complete o cadastro (CEP, logradouro, número, bairro e cidade)`,
      [{ field: 'recipient.address', message: 'Endereço completo obrigatório para o grupo IBS/CBS (E0234)' }], ErrorCodes.FISCAL_RECIPIENT_INCOMPLETE)
  }
  const subitem = String(nationalCode ?? '').slice(0, 4)
  if (TP_OPER_SERVICE_SUBITEMS.has(subitem)) {
    throw new HttpError(422, `Serviço do subitem ${subitem.slice(0, 2)}.${subitem.slice(2)} exige o tipo de operação (tpOper) no grupo IBS/CBS (E0903) — ainda não suportado pela NFS-e do sistema`,
      [{ field: 'nationalCode', message: 'tpOper obrigatório para este serviço no grupo IBS/CBS (E0903) — não suportado' }], ErrorCodes.FISCAL_DPS_INVALID)
  }
}

/** updated_at do ramo — relido DENTRO da transação da reserva, depois da trava da nota (MEDIUM-3). */
export async function branchUpdatedAt(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<string | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt FROM \`${s}\`.tb_invoice_service
      WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  if (!rows[0]) throw new HttpError(422, `Nota ${ref.invoiceId} não tem ramo de serviço`, undefined, ErrorCodes.INVOICE_SERVICE_BRANCH_MISSING)
  return rows[0].updatedAt ?? null
}

// ---------------------------------------------------------------------------
// Emitente / tomador → DpsInput
// ---------------------------------------------------------------------------

const digitsOf = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '')   // só CEP (D-CJ12: nunca sobre inscrição)

/**
 * D-CJ7 (onda 1 da frente do CNPJ alfanumérico): o ESCRITOR do DPS segue o LEIAUTE vigente do ambiente (`layout-calendar.ts` — pacote XSD
 * publicado: produção restrita aceita CNPJ com letra, produção ainda numérica). A fonte de fatos devolve o FATO (alfanumérico incluído); a
 * recusa legível (422 `FISCAL_DPS_INVALID`, ANTES de reservar o nDPS) é de `buildDpsBase`, que conhece o ambiente e o instante.
 */
function assertCnpjLayout(environment: AuthorityEnvironment, instant: Date, emitter: string, toma: DpsToma): void {
  if (cnpjAlphanumericAccepted('DPS', environment, instant)) return
  const fields: FieldError[] = []
  const hasLetter = (v: string | undefined) => !!v && /[A-Z]/.test(v)
  if (hasLetter(emitter)) fields.push({ field: 'emitter.cnpj', message: 'CNPJ alfanumérico do estabelecimento: o leiaute da NFS-e deste ambiente ainda não aceita CNPJ com letras' })
  if (hasLetter(toma.cnpj)) fields.push({ field: 'recipient.document', message: 'CNPJ alfanumérico do tomador: o leiaute da NFS-e deste ambiente ainda não aceita CNPJ com letras' })
  if (fields.length) {
    throw new HttpError(422, `O leiaute da NFS-e de ${environment === 'P' ? 'PRODUÇÃO' : 'homologação'} ainda não aceita CNPJ com letras — a nota sai quando o fisco publicar o leiaute novo (nada foi reservado)`,
      fields, ErrorCodes.FISCAL_DPS_INVALID)
  }
}

/** O CNPJ do emitente como fato em TRÊS estados (D-CJ2): ausente ≠ inválido — o diagnóstico diz o que corrigir. */
function emitterCnpjProblem(fact: FederalIdFact): FieldError | null {
  if (fact.state === 'absent') return { field: 'emitter.cnpj', message: 'Estabelecimento sem CNPJ (pessoa jurídica)' }
  if (fact.state === 'invalid') return { field: 'emitter.cnpj', message: 'CNPJ do estabelecimento inválido no cadastro (forma ou dígito verificador)' }
  return null
}

/**
 * L4 do socrático da Onda 3: leituras (XML, DANFSe, tela, arquivamento da voz) só precisam do CNPJ do emitente — a PASTA do arquivo fiscal.
 * D-CJ16 (= Q-CJ16 (b), 2026-10-16): leitura de documento JÁ autorizado canonicaliza o CNPJ gravado (máscara sai, minúscula sobe, SEM DV,
 * nunca apaga) — a 2ª via não depende de o cadastro de hoje estar na forma; a EMISSÃO (`buildEmitter`) segue estrita.
 * D-CJ19 (= Q-CJ19 (a), 2026-10-16 — supera em parte a D-CJ16): documento JÁ autorizado tem a pasta pelo emitente EMBUTIDO na chave
 * (`cnpjOfAccessKey`, via `documentCnpj` da transmissão); esta leitura do cadastro é só o RECURSO quando a chave não traz CNPJ na forma.
 */
export async function emitterCnpj(q: Queryable, institutionId: number): Promise<string> {
  const cnpj = await erp.establishmentCnpj(q, institutionId)          // VÁLIDO na forma canônica, ou null
  if (cnpj) return cnpj
  // só no erro: o fato em três estados diz se falta ou se está errado (o caminho feliz segue com UMA leitura)
  const fact = await erp.establishmentCnpjFact(q, institutionId)
  if (fact.state === 'invalid') {
    const canonical = normalizeCnpj(fact.raw)
    // gate adversarial da onda 1 (LOW): a D-CJ16 abre mão do DV, NÃO do veto dos 14 dígitos iguais (o "preenchimento" clássico de lixo)
    if (canonical && !/^(\d)\1{13}$/.test(canonical)) return canonical
  }
  const problem = emitterCnpjProblem(fact) ?? { field: 'emitter.cnpj', message: 'Estabelecimento sem CNPJ (pessoa jurídica)' }
  throw new HttpError(422, `${problem.message} — corrija no Meu Estabelecimento`, [problem], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
}

export interface EmitterIdentity {
  cnpj:    string
  im:      string | null
  name:    string
  cMunEmi: string
  /** Para o DANFSe: cidade / UF do endereço principal. */
  municipality: string
}

/**
 * O emitente É a institution (cadeia + `tb_entity_tax` da própria — D-E3/D-E23). O que falta se
 * corrige no cadastro, não no DPS: 422 com o campo. Só LÊ o regime; a OBRIGAÇÃO do Anexo I vive em
 * `emitterDpsFacts` (o cancelamento passa por aqui e não pode travar por cadastro limpo).
 */
export async function buildEmitter(q: Queryable, schemaName: string, institutionId: number): Promise<{ identity: EmitterIdentity; prest: DpsInput['prest']; simplesTotalTaxAliquot: number | null }> {
  const full = await erp.entityFiscal(q, institutionId)
  const missing: FieldError[] = []
  const fact = readFederalIdFact('cnpj', full?.cnpj)
  const problem = emitterCnpjProblem(fact)
  if (problem) missing.push(problem)
  const cnpj = fact.state === 'valid' ? fact.id.value : ''
  const addr = full?.addresses.find(a => a.main === 'S') ?? full?.addresses[0]
  const cMun = await erp.cityIbge(q, addr?.cityId)
  if (!addr) missing.push({ field: 'emitter.address', message: 'Estabelecimento sem endereço principal' })
  else if (!cMun) missing.push({ field: 'emitter.city', message: 'Cidade do endereço principal sem código IBGE (7 dígitos)' })
  if (missing.length) {
    throw new HttpError(422, 'Cadastro do estabelecimento incompleto para o DPS — complete no Meu Estabelecimento',
      missing, ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  const tax = await erp.entityTax(q, schemaName, institutionId, institutionId)
  // D-N19: opSimpNac é FATO do emitente — sem default silencioso
  if (!['1', '2', '3'].includes(String(tax?.simplesRegime))) {
    throw new HttpError(422, 'Estabelecimento sem o regime do Simples (opSimpNac) na aba Tributação — informe: 1 não optante · 2 MEI · 3 ME/EPP',
      [{ field: 'simplesRegime', message: 'Obrigatório para o DPS (D-N19)' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  const opSimpNac = String(tax!.simplesRegime) as '1' | '2' | '3'
  const regApTribSN = opSimpNac === '3' && ['1', '2', '3'].includes(String(tax?.simplesAssessment))
    ? (String(tax!.simplesAssessment) as '1' | '2' | '3') : undefined
  const regEspTrib = (['0', '1', '2', '3', '4', '5', '6'].includes(String(tax?.specialTaxRegime)) ? String(tax!.specialTaxRegime) : '0') as DpsInput['prest']['regTrib']['regEspTrib']
  const im = (full!.im ?? '').trim() || null
  const aliquot = tax?.simplesTotalTaxAliquot == null ? null : Number(tax.simplesTotalTaxAliquot)
  return {
    identity: {
      cnpj, im, name: (full!.nameCompany ?? full!.nickTrade ?? '').trim(), cMunEmi: cMun!,
      municipality: [addr!.cityName, addr!.stateName].filter(Boolean).join(' / ') || '—',
    },
    prest: { cnpj, ...(im ? { im } : {}), regTrib: { opSimpNac, ...(regApTribSN ? { regApTribSN } : {}), regEspTrib } },
    simplesTotalTaxAliquot: Number.isFinite(aliquot as number) ? aliquot : null,
  }
}

/** Teto do pTotTribSN (TSDec2V2: 2 inteiros + 2 decimais). */
export const SIMPLES_TOTAL_TAX_ALIQUOT_MAX = 99.99

/**
 * Fatos do emitente que o DPS EXIGE pelo regime (Anexo I — conhecimento do FISCO): Q-N36 (E0166:
 * ME/EPP exige regApTribSN) e Q-N37 (E0712: total aproximado de tributos — MEI indTotTrib=0 · ME/EPP
 * pTotTribSN · não optante ainda não suportado). Ausência → 422 local, antes de reservar.
 */
export function emitterDpsFacts(prest: DpsInput['prest'], simplesTotalTaxAliquot: number | null): DpsTotTrib {
  const regime = prest.regTrib.opSimpNac
  if (regime === '2') return { indTotTrib: '0' }
  if (regime === '1') {
    throw new HttpError(422, 'Emissão de NFS-e para empresa não optante do Simples ainda não é suportada — o fisco exige o total aproximado de tributos por esfera',
      [{ field: 'simplesRegime', message: 'Não optante ainda não suportado na NFS-e' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  if (!prest.regTrib.regApTribSN) {
    throw new HttpError(422, 'Informe a "Apuração no Simples" em Meu Estabelecimento → aba Tributação e transmita de novo — o fisco exige esse dado de empresa ME/EPP',
      [{ field: 'simplesAssessment', message: 'Informe em Meu Estabelecimento → Tributação → Apuração no Simples' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  if (simplesTotalTaxAliquot == null || !(simplesTotalTaxAliquot > 0) || simplesTotalTaxAliquot > SIMPLES_TOTAL_TAX_ALIQUOT_MAX) {
    throw new HttpError(422, 'Informe o "% aproximado de tributos do Simples" (alíquota efetiva do DAS) em Meu Estabelecimento → aba Tributação e transmita de novo — o fisco exige esse dado de empresa ME/EPP',
      [{ field: 'simplesTotalTaxAliquot', message: 'Informe em Meu Estabelecimento → Tributação → % aproximado de tributos do Simples' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  return { pTotTribSN: simplesTotalTaxAliquot }
}

/** Tomador: CNPJ ou CPF + nome; endereço só quando COMPLETO (o XSD o deixa opcional). */
export async function buildRecipient(q: Queryable, entityId: number): Promise<DpsToma> {
  const full = await erp.entityFiscal(q, entityId)
  const missing: FieldError[] = []
  // D-CJ2: PF × PJ pelo LUGAR (a especialização que carrega a inscrição — `tb_company` × `tb_person`), nunca pelo comprimento depois de
  // limpar (um CNPJ com 3 letras virava 11 dígitos = "CPF"); três estados: ausente ≠ inválido ≠ válido
  const cnpjFact = readFederalIdFact('cnpj', full?.cnpj)
  const cpfFact = readFederalIdFact('cpf', full?.cpf)
  const doc: { kind: FederalIdKind; fact: FederalIdFact } = cnpjFact.state !== 'absent' ? { kind: 'cnpj', fact: cnpjFact } : { kind: 'cpf', fact: cpfFact }
  if (!full || doc.fact.state === 'absent') missing.push({ field: 'recipient.document', message: 'Tomador sem CPF/CNPJ' })
  else if (doc.fact.state === 'invalid') {
    missing.push({ field: 'recipient.document', message: `${doc.kind === 'cnpj' ? 'CNPJ' : 'CPF'} do tomador inválido no cadastro (forma ou dígito verificador)` })
  }
  const xNome = (full?.nameCompany ?? full?.nickTrade ?? '').trim()
  if (!xNome) missing.push({ field: 'recipient.name', message: 'Tomador sem nome' })
  if (missing.length) {
    throw new HttpError(422, `Cadastro do tomador ${entityId} incompleto para o DPS — complete o cadastro da entidade`,
      missing, ErrorCodes.FISCAL_RECIPIENT_INCOMPLETE)
  }
  const value = doc.fact.state === 'valid' ? doc.fact.id.value : ''
  const toma: DpsToma = doc.kind === 'cnpj' ? { cnpj: value, xNome } : { cpf: value, xNome }
  const im = (full!.im ?? '').trim()
  if (im) toma.im = im
  const addr = full!.addresses.find(a => a.main === 'S') ?? full!.addresses[0]
  if (addr) {
    const cMun = await erp.cityIbge(q, addr.cityId)
    const cep = digitsOf(addr.zipCode)
    const xLgr = (addr.street ?? '').trim(), nro = (addr.nmbr ?? '').trim(), xBairro = (addr.neighborhood ?? '').trim()
    if (cMun && cep.length === 8 && xLgr && nro && xBairro) {
      toma.end = { cMun, cep, xLgr, nro, xBairro, ...(addr.complement ? { xCpl: addr.complement } : {}) }
    }
  }
  return toma
}

export interface DpsBase {
  /** Tudo do DpsInput menos série/nDPS (são da VIDA, cunhados sob a trava — D-F30). */
  input:   Omit<DpsInput, 'serie' | 'nDps'>
  emitter: EmitterIdentity
}

/**
 * Monta o DPS FORA da transação. O ramo já veio congelado no faturamento; emitente/tomador lidos
 * agora; dhEmi na ZONA do estabelecimento (Q-TZ2).
 */
export async function buildDpsBase(
  q: Queryable, schemaName: string, institutionId: number, header: ServiceInvoiceHeader, environment: AuthorityEnvironment,
): Promise<DpsBase> {
  const b = header.branch
  if (!b.nationalCode) {
    throw new HttpError(422, 'Ramo de serviço sem código de tributação nacional (cTribNac) — regra de ISS sem código (D-N11a)',
      [{ field: 'nationalCode', message: 'Obrigatório' }], ErrorCodes.SERVICE_RULE_NATIONAL_CODE_REQUIRED)
  }
  const { identity, prest, simplesTotalTaxAliquot } = await buildEmitter(q, schemaName, institutionId)
  const totTrib = emitterDpsFacts(prest, simplesTotalTaxAliquot)
  // D-F59 (= Q-F67 (a), Valdo 2026-10-10): a IM do PRESTADOR vai ao DPS só em HOMOLOGAÇÃO — o CNC de H a EXIGE (E0116,
  // smoke de 2026-10-10) e o de PRODUÇÃO a RECUSA (E0120 — Q-N35). A IM é FATO do emitente (`tb_company.im`); quem decide se
  // ela entra no DPS é o AMBIENTE da habilitação (dado do fisco, não preferência). A IM do TOMADOR não muda.
  const { im: _prestIm, ...prestWithoutIm } = prest
  const prestDps = environment === 'H' ? prest : prestWithoutIm
  const toma = await buildRecipient(q, header.entityId)
  // D-CJ7: CNPJ alfanumérico do emitente ou do tomador só se o LEIAUTE vigente do ambiente aceita — recusa legível ANTES da reserva
  assertCnpjLayout(environment, new Date(), identity.cnpj, toma)
  const cLocPrestacao = await erp.cityIbge(q, b.cityId)
  if (!cLocPrestacao) {
    throw new HttpError(422, 'Cidade de incidência do serviço sem código IBGE — confira a regra de ISS',
      [{ field: 'cityId', message: 'IBGE ausente' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  // cTribMun tem EXATAMENTE 3 dígitos no leiaute (sonda 2026-09-22); presente e fora da forma = 422 (ACHADO 2)
  const municipalRaw = (b.municipalCode ?? '').trim()
  const municipalDigits = /^\d{3}$/.test(municipalRaw) ? municipalRaw : ''
  if (municipalRaw && !municipalDigits) {
    throw new HttpError(422, `Código de tributação municipal "${b.municipalCode}" fora da forma do DPS (cTribMun = 3 dígitos) — corrija a regra de ISS`,
      [{ field: 'municipalCode', message: 'Esperado 3 dígitos' }], ErrorCodes.FISCAL_DPS_INVALID)
  }
  const tribISSQN = b.liability
  // Anexo I E0625/E0621: ME/EPP com ISSQN pelo Simples (regApTribSN 1) sem retenção → pAliq PROIBIDA
  const issInDas = prest.regTrib.opSimpNac === '3' && prest.regTrib.regApTribSN === '1'
  const sendAliq = tribISSQN === '1' && !(issInDas && b.issWithheld === 'N')
  // L8: o DPS não tem campo de base — vServ É a base
  if (tribISSQN === '1' && Math.abs(Number(b.baseIss) - Number(b.totalValue)) > 0.005) {
    throw new HttpError(422, `Base do ISS (${b.baseIss}) diferente do valor do serviço (${b.totalValue}) — o DPS não tem campo de base; confira a nota`,
      [{ field: 'baseIss', message: 'Base do ISS ≠ valor do serviço' }], ErrorCodes.FISCAL_DPS_INVALID)
  }
  // IB-3: a declaração IBS/CBS do ramo (forma conferida ANTES de tocar o fisco) + as rejeições que o grupo abre (E0234/E0903)
  const declared = declarationForDps(b.declaration)
  if (declared.ibscbs) assertIbscbsGroupDeliverable(declared.ibscbs, toma, b.nationalCode)
  const zone = await erp.institutionZone(q, schemaName, institutionId)
  const input: Omit<DpsInput, 'serie' | 'nDps'> = {
    environment, dhEmi: nowIsoIn(zone), verAplic: VER_APLIC, dCompet: header.dtEmission,
    tpEmit: '1', cLocEmi: identity.cMunEmi, prest: prestDps, toma,
    serv: {
      locPrest: { cLocPrestacao },
      cServ: {
        cTribNac: b.nationalCode,
        ...(municipalDigits ? { cTribMun: municipalDigits } : {}),
        xDescServ: (b.description ?? '').trim() || 'Serviços',
        ...(declared.cNBS ? { cNBS: declared.cNBS } : {}),
      },
    },
    valores: {
      vServ: b.totalValue,
      trib: {
        tribMun: { tribISSQN, tpRetISSQN: b.issWithheld === 'S' ? '2' : '1', ...(sendAliq ? { pAliq: b.aliqIss } : {}) },
        totTrib,
      },
    },
    ...(declared.ibscbs ? { ibscbs: declared.ibscbs } : {}),
  }
  return { input, emitter: identity }
}

/**
 * Notas do ramo de serviço SEM tentativa viva/autorizada/cancelada na VIDA vigente (lote "Transmitir
 * pendentes" — o lote é do APP, que PAGINA: gate adversarial M — sem paginação, notas que falham antes de
 * reservar (422 de cadastro) prendiam a cabeça da fila e o "fatia e repete" nunca progredia). Lista nova
 * nasce paginada (regra da casa — `prompt_paginacao_telas_pesquisa.md`). Cruza o ERP com o `fiscal_api`
 * (mesma instância). Fora: reserva em voo (LOW-3), nota cancelada (D3/D4), nota com voz C (o C local é do
 * setes-api — D-F28) e nota sincronizada da origem. [interfaces] = ramos que quem pede pode ver (null = todos).
 */
export async function listPendingServiceInvoices(
  q: Queryable, schemaName: string, scope: InvoiceScope, fiscalDb: string,
  page: { page: number; pageSize: number }, interfaces: string[] | null,
): Promise<{ rows: { invoiceId: number; number: string; dtEmission: string; interfaceKey: string }[]; total: number }> {
  const s = assertSchema(schemaName)
  if (!/^[a-z0-9_]+$/.test(fiscalDb)) throw new Error(`Banco fiscal inválido: ${fiscalDb}`)
  if (interfaces && interfaces.length === 0) return { rows: [], total: 0 }
  // D-NE69 (= Q-NE69 (a)): "já tem tentativa que barra o lote" = viva com voz (CLASSE — S/K/P) · autorizada (CLASSE — A/N) · a voz C (UM
  // fato: o C local é do setes-api — D-F28) · em voo sem voz ('-'); fora ficam R/F (e D, que a NFS-e não produz)
  const BLOCKING = `${sqlKindList([...LIVE_VOICE_KINDS, ...AUTHORIZED_KINDS, 'C'])},'-'`
  const from = `
       FROM \`${s}\`.tb_invoice i
       JOIN \`${s}\`.tb_invoice_service sv
         ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${s}\`.vw_invoice_life l
         ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = i.terminal
       LEFT JOIN \`${s}\`.vw_order_interface oi
         ON oi.tb_institution_id = i.tb_institution_id AND oi.tb_order_id = i.id AND oi.terminal = i.terminal
      WHERE i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id
        AND l.last_kind = 'E'
        ${interfaces ? `AND COALESCE(oi.interface_key, 'orders') IN (?)` : ''}
        AND NOT EXISTS (
          SELECT 1 FROM \`${fiscalDb}\`.vw_invoice_service_transmission t
           WHERE t.tb_institution_id = ? AND t.tb_invoice_id = i.id AND t.terminal = i.terminal
             AND t.life_event = l.life_event
             AND COALESCE(t.last_kind, '-') IN (${BLOCKING}))`
  // a institution entra também como CONSTANTE no NOT EXISTS: o otimizador o materializa (exists_to_in) e, sem a
  // constante, a materialização varria o histórico de TODAS as institutions (gate adversarial R4 — D-F40)
  const params: unknown[] = [scope.institutionId, scope.terminal, ...(interfaces ? [interfaces] : []), scope.institutionId]
  const [cnt] = await q.query(`SELECT COUNT(*) AS n ${from}`, params)
  const [rows] = await q.query(
    `SELECT i.id AS invoiceId, i.number, DATE_FORMAT(i.dt_emission, '%Y-%m-%d') AS dtEmission,
            COALESCE(oi.interface_key, 'orders') AS interfaceKey ${from}
      ORDER BY i.dt_emission, i.id
      LIMIT ? OFFSET ?`,
    [...params, page.pageSize, (page.page - 1) * page.pageSize])
  return {
    total: Number(cnt?.[0]?.n ?? 0),
    rows: (rows as any[]).map(r => ({ invoiceId: Number(r.invoiceId), number: String(r.number), dtEmission: String(r.dtEmission), interfaceKey: String(r.interfaceKey) })),
  }
}

/** Nome e município do emitente para o DANFSe — LEITURA (L4: nunca exige regime/IBGE de quem só lê). */
export async function emitterDisplay(q: Queryable, institutionId: number): Promise<{ name: string; municipality: string }> {
  const full = await erp.entityFiscal(q, institutionId)
  const addr = full?.addresses.find(a => a.main === 'S') ?? full?.addresses[0]
  return {
    name: (full?.nameCompany ?? full?.nickTrade ?? 'Emitente').trim() || 'Emitente',
    municipality: [addr?.cityName, addr?.stateName].filter(Boolean).join(' / ') || '—',
  }
}
