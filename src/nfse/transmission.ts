import {
  Pool, PoolConnection, HttpError, ErrorCodes, logger, withTransaction, isDeadlock, isLockWaitTimeout,
  MasterKeyRing, FiscalStorage, OpenedIssuer, openIssuer, nextDpsNumber, erp, AuthorityHttpError,
  signXml, isLocalCredentialError, toDbDateTime, nowIsoIn, withZoneWall, DEFAULT_TIME_ZONE,
  isLiveTransmission, isAuthorized, fiscalStateOf, localCancelPending, isSubstitutionCancel, CANCEL_EVENT_CODES, reconfirmationCandidate, currentOf,
  acquireRefreshLease, releaseRefreshLease, renewRefreshLease, getIssuer, newCrashRef, contentionToHttpError, emissionStillInErp,
  ServiceFiscalState, TransmissionEventKind, TransmissionSource, AuthorityEnvironment, AuthorityContext, Queryable, runShortCommand,
  tagAmbiguous, ambiguousCauseOf,
} from 'fiscal-api'
import type { TaxAuthorityAdapter, NfseQuery, MunicipalTerms } from '../authority/types'
import fs from 'fs'
import { buildDpsId, buildDpsXml, buildCancelEventXml, buildEventId, parseNfseXml, parseEventXml } from '../authority/dps-builder'
import { ADN_SIGN_ALGORITHM } from '../authority/adn'
import {
  SERVICE_MODEL, VER_APLIC, ServiceInvoiceHeader, DpsBase, EmitterIdentity,
  readServiceInvoice, branchUpdatedAt, buildDpsBase, buildEmitter, emitterCnpj, listPendingServiceInvoices,
} from '../facts/service-facts'
import {
  TransmissionRow, TransmissionEventRow, getLifeDps, insertLifeDps, getTransmission, latestTransmission,
  findTransmissionByDpsId, findKeyHolder, listLifeTransmissions, insertTransmission, fillAuthorityData, insertTransmissionEvent,
  hasTransmissionEvent, findTransmissionEventByKind, touchQueriedAt, recordNfseNotGenerated, listRefreshCandidates,
  DEFAULT_CANCEL_DAYS, REFRESH_AUTHORIZED_MARGIN_DAYS,
} from './repository'
import { toTsString } from '../authority/dps-builder'

/**
 * COMPOSIÇÃO DA NFS-e na nfse-api (F1 da extração fiscal — prompt_apis_fiscais_isoladas.md §12/§14).
 * Origem: `@shared/invoice-transmission` do setes-api (Onda 3) — a POLÍTICA da voz é a mesma, provada
 * por três rodadas adversariais: reserva sob trava → fisco FORA da transação → A/R/F; ambíguo nunca
 * fecha (D-I21); vigente = quem detém a chave (D-N26); vida da nota (D-N27); K→N só depois da
 * carência (D-N28); órfã encerrada com F (R3-1); resposta conferida CONTRA A PERGUNTA (R2-2).
 *
 * O que a extração mudou (decisões do Valdo):
 *  - D-F10: os fatos vêm do ERP pela fonte de fatos; a API só LÊ o ERP e TRAVA a linha da nota (D-F31);
 *  - D-F30: o DPS de cada VIDA (série + nDPS + Id) nasce UMA vez em `tb_invoice_service_dps`;
 *  - D-F11/D-F28: NENHUM efeito no ERP — a voz C é gravada e devolvida; o C local é do setes-api, e a
 *    pendência (voz C × nota ainda não-C) é DERIVADA; a voz C não volta ao rodízio;
 *  - D-F29: a reconfirmação no fisco (Q-ADV1b) virou ato próprio, e grava a PROVA — o E2404 EXPLÍCITO
 *    (`nfse_not_generated_at`, D-F90), nunca o carimbo do rodízio (`last_queried_at`);
 *  - sem `Map/Set` de controle em memória: o rodízio usa um ALUGUEL na linha do emissor; o lote é do app.
 * Gates da F1 (2026-10-04 — §15.4): titular da chave só no MESMO ambiente; nenhuma leitura travante
 * redundante sob a trava da nota; cancelamento com RESERVA em voo (K antes do fisco); rodízio filtrado no SQL.
 */

export interface NfseDeps {
  pool:     Pool
  keyring:  MasterKeyRing
  storage:  FiscalStorage
  adapter:  TaxAuthorityAdapter
  /** Nome do banco da casa (D-F7) — para as consultas que cruzam ERP × fiscal. */
  fiscalDb: string
}

/** Quem pede: institution + schema + usuário do JWT do produto (autoria opaca — D-F13). */
export interface Actor {
  schemaName:    string
  institutionId: number
  userId:        number
}

/** Consulta ativa: não reconsulta transmissão viva vista há menos de N minutos. */
export const REFRESH_MIN_MINUTES = 5
/** Aluguel da passada do rodízio (segundos): cobre UMA candidata no PIOR caso e é RENOVADO antes de cada uma (gates R4);
 *  queda do processo = vence sozinho. D-F62 (= Q-F69 (a), Valdo 2026-10-10): com a leitura tipada dos eventos (D-F61) uma
 *  candidata faz até 6 idas ao fisco (GET /dps + GET /nfse + 4 eventos) × 30 s de timeout = 180 s, + 30 s de folga. */
export const REFRESH_LEASE_SECONDS = 210
export const REFRESH_MAX_PER_RUN = 8
/** Orçamento TOTAL de uma passada — é a requisição de quem abriu a tela. */
export const REFRESH_BUDGET_MS = 20_000
/** Reserva sem voz há mais de N minutos = envio interrompido (crash/timeout): pergunta ao fisco antes de nova tentativa. */
export const IN_FLIGHT_MINUTES = 10
/** Motivo padrão do evento e101101: cMotivo 1 = erro na emissão. */
export const CANCEL_MOTIVE_CODE = '1' as const
const XMOTIVO_MIN = 15
const XMOTIVO_MAX = 255

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 255)
const estDeps = (d: NfseDeps) => ({ pool: d.pool, keyring: d.keyring })

export const dpsFileName = (dpsId: string) => `${dpsId}-dps.xml`
export const nfseFileName = (accessKey: string) => `${String(accessKey).replace(/\D/g, '')}-nfse.xml`
export const cancelEventFileName = (accessKey: string) => `${String(accessKey).replace(/\D/g, '')}-evt101101.xml`

// ---------------------------------------------------------------------------
// Transação sob a TRAVA DA NOTA (D-F27/D-F31): a 1ª coisa que a transação faz no ERP
// ---------------------------------------------------------------------------

async function withInvoiceTx<T>(
  deps: NfseDeps, label: string, actor: Actor, invoiceId: number,
  fn: (conn: PoolConnection, locked: erp.LockedInvoice) => Promise<T>,
  opts: { requireAlive?: boolean } = {},
): Promise<T> {
  return withTransaction(deps.pool, label, { institutionId: actor.institutionId, invoiceId }, async conn => {
    const locked = await erp.lockInvoice(conn, actor.schemaName, actor.institutionId, invoiceId)
    if (!locked || (opts.requireAlive && !locked.alive)) {
      throw new HttpError(404, `Nota ${invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
    }
    return fn(conn, locked)
  })
}

function assertTransmittable(header: ServiceInvoiceHeader): void {
  if (header.lastInvoiceKind == null || header.lifeEvent == null) {
    throw new HttpError(409, `Nota ${header.invoiceId} sem evento de emissão na web (sincronizada da origem) — transmite-se na origem`,
      undefined, ErrorCodes.INVOICE_NOT_TRANSMITTABLE)
  }
  if (header.lastInvoiceKind === 'C') {
    throw new HttpError(409, `Nota ${header.number ?? header.invoiceId} cancelada — nada a transmitir`, undefined, ErrorCodes.INVOICE_NOT_TRANSMITTABLE)
  }
}

/** Reservada e sem voz há mais de IN_FLIGHT_MINUTES (idade medida NO BANCO — MEDIUM-2). */
// CONHECIMENTO NEGATIVO (D-F102 = Q-F108 (a), Valdo 2026-10-11): só a tentativa SEM voz tem esta saída; a voz S ("enviado") não tem
// produtor hoje — quem criar um dá a S esta mesma saída (idade da voz S + E2404 → F) na mesma entrega (ver `kinds.ts` do núcleo).
// R21-03: são DOIS portões — este predicado E a reconferência sob a trava (`recordInterruptedFailure` / `reconcileInterrupted`), que
// recusa tentativa com voz; abrir só este faz a S cair a cada passada no ramo "perdeu a corrida" (sem carimbo) e monopolizar o rodízio.
export function isInterruptedInFlight(tx: TransmissionRow | null): boolean {
  return !!tx && isLiveTransmission(tx) && tx.lastKind === null && (tx.ageMinutes ?? 0) >= IN_FLIGHT_MINUTES
}

function liveTransmissionError(tx: TransmissionRow): HttpError {
  if (isAuthorized(tx)) {
    return new HttpError(409, `NFS-e ${tx.nfseNumber ?? ''} já autorizada no fisco (tentativa ${tx.attempt}, chave ${tx.accessKey ?? '?'})`,
      undefined, ErrorCodes.FISCAL_ALREADY_AUTHORIZED)
  }
  if (tx.lastKind === 'K') {
    return new HttpError(409, `Pedido de cancelamento ao fisco sem resposta (tentativa ${tx.attempt}) — consulte a NFS-e para reconciliar`,
      undefined, ErrorCodes.FISCAL_CANCEL_IN_FLIGHT)
  }
  return new HttpError(409, `Transmissão desta nota ao fisco em andamento (tentativa ${tx.attempt}) — aguarde e consulte`,
    undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
}

const changedDuringTransmit = () =>
  new HttpError(409, 'Nota mudou durante a transmissão (evento ou ramo alterados) — tente de novo', undefined, ErrorCodes.RESOURCE_BUSY)

const substituted = (attempt: number) =>
  new HttpError(409, `A NFS-e desta nota (tentativa ${attempt}) foi SUBSTITUÍDA no fisco (e105102) — não há nova transmissão do mesmo DPS; decida no ERP: cancelar a nota ou mantê-la`,
    [{ field: 'fiscal', message: 'NFS-e substituída' }], ErrorCodes.FISCAL_NFSE_SUBSTITUTED)

const effectPending = (attempt: number) =>
  new HttpError(409, `NFS-e cancelada no fisco (tentativa ${attempt}) e a nota ainda não foi cancelada no ERP — aplique o cancelamento no sistema antes de qualquer nova ação`,
    [{ field: 'fiscal', message: 'Cancelamento local pendente' }], ErrorCodes.FISCAL_EFFECT_PENDING)

// ---------------------------------------------------------------------------
// DPS assinado, contexto mTLS, tradução da voz
// ---------------------------------------------------------------------------

/** Id do DPS: cMun do EMITENTE + CNPJ + série + nDPS (45 posições). */
export function serviceDpsId(emitter: EmitterIdentity, serie: string | number, nDps: number): string {
  return buildDpsId(emitter.cMunEmi, '2', emitter.cnpj, serie, nDps)
}

/** R3-7: credencial LOCAL ilegível/inconsistente é 409 FISCAL_CERT_INVALID, nunca Error cru (500). */
function signLocal(xml: string, referenceId: string, opened: OpenedIssuer): string {
  try {
    return signXml(xml, { referenceId, cert: opened.cert, key: opened.key, algorithm: ADN_SIGN_ALGORITHM })
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (isLocalCredentialError(err)) {
      throw new HttpError(409, 'Certificado/chave do emissor no cofre não assinam (par inconsistente ou ilegível) — envie o .pfx novamente',
        [{ field: 'certificate', message: 'Par PEM inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
    }
    throw err
  }
}

/** LOW-1: erro de leiaute vira 422 FISCAL_DPS_INVALID com o campo — nunca 500, nunca o fisco às cegas. */
export function buildSignedDps(base: DpsBase, serie: string | number, nDps: number, opened: OpenedIssuer, environment?: AuthorityEnvironment): { dpsId: string; xml: string } {
  let dpsId: string, xml: string
  try {
    dpsId = serviceDpsId(base.emitter, serie, nDps)
    xml = buildDpsXml({ ...base.input, environment: environment ?? base.input.environment, serie, nDps }, dpsId)
  } catch (err) {
    if (err instanceof HttpError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new HttpError(422, `DPS inválido: ${msg}`, [{ field: 'dps', message: msg.slice(0, 255) }], ErrorCodes.FISCAL_DPS_INVALID)
  }
  return { dpsId, xml: signLocal(xml, dpsId, opened) }
}

/** xMotivo 15–255: motivo curto ganha o complemento padrão; longo é cortado. */
export function normalizeCancelMotive(reason: string): string {
  let m = toTsString(String(reason ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''))
    // gate adversarial r8 (ADV-R8-07) + TSString do XSD (só U+0020–U+00FF): não-caractere, surrogate solto, invisível e TODO
    // caractere acima de U+00FF saem (tipografia vira ASCII) ANTES do piso — o piso de 15 não pode ser cumprido por eles
    .replace(/\s+/g, ' ').trim()
  // complemento com hífen ASCII — o travessão (U+2014) estava FORA do TSString e o fisco recusava o evento (NFS-e 706, 2026-10-10)
  if (m.length < XMOTIVO_MIN) m = `${m}${m ? ' - ' : ''}Cancelamento solicitado pelo emissor`
  const cut = m.slice(0, XMOTIVO_MAX)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut          // o corte em 255 nunca parte um par (emoji)
}

function buildSignedCancel(accessKey: string, reason: string, dhEvento: string, environment: AuthorityEnvironment, cnpjAutor: string, opened: OpenedIssuer): { xml: string; xMotivo: string } {
  const xMotivo = normalizeCancelMotive(reason)
  const xml = buildCancelEventXml({ accessKey, dhEvento, cMotivo: CANCEL_MOTIVE_CODE, xMotivo, environment, verAplic: VER_APLIC, cnpjAutor })
  return { xml: signLocal(xml, buildEventId(accessKey, '101101'), opened), xMotivo }
}

/** Contexto mTLS no ambiente CONGELADO da tentativa (D-N6); o A1 é UM para H e P (D-N31). */
const ctxFor = (opened: OpenedIssuer, environment: AuthorityEnvironment): AuthorityContext => ({ environment, cert: opened.cert, key: opened.key })

export type AuthorityOutcome = 'rejected' | 'auth_failed' | 'ambiguous' | 'local'

/** Recusa EXPLÍCITA → R; credencial recusada → F; credencial LOCAL → F (Q-N30b); o resto é AMBÍGUO (D-I21). */
export function classifyAuthorityError(err: unknown): AuthorityOutcome {
  if (!(err instanceof AuthorityHttpError)) return 'ambiguous'
  if (err.code === ErrorCodes.FISCAL_DPS_REJECTED) return 'rejected'
  if (err.code === ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED) return 'auth_failed'
  if (err.code === ErrorCodes.FISCAL_CERT_INVALID) return 'local'
  return 'ambiguous'
}

export const OUTCOME_KIND: Record<Exclude<AuthorityOutcome, 'ambiguous'>, TransmissionEventKind> = { rejected: 'R', auth_failed: 'F', local: 'F' }

export function firstAuthorityCode(err: AuthorityHttpError): string | null {
  for (const f of err.fields ?? []) {
    const m = /\b(E\d{4})\b/.exec(f.message)
    if (m) return m[1]
  }
  const m = /\b(E\d{4})\b/.exec(err.body ?? '')
  return m ? m[1] : (err.authorityStatus ? String(err.authorityStatus) : null)
}

export function authorityMessage(err: AuthorityHttpError): string {
  const parts = (err.fields ?? []).map(f => f.message).filter(Boolean)
  return (parts.length ? parts.join(' — ') : err.message).slice(0, 255)
}

/** Erros do EMISSOR, não da nota (LOW-A): a passada do rodízio pára no 1º. */
export const EMITTER_FAILURE_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, ErrorCodes.FISCAL_CERT_INVALID,
  ErrorCodes.FISCAL_ISSUER_MISSING, ErrorCodes.FISCAL_CERT_MISSING, ErrorCodes.FISCAL_CERT_EXPIRED,
  ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE,
])

// Prazo de cancelamento do PAM (D-N15) — cache de DADO (não é controle): 1 h por município/ambiente; a FALHA também é
// guardada (10 min — gates da Rodada 4: convênio lento/fora não pode ser re-perguntado a cada passada do rodízio)
const TERMS_TTL_MS = 60 * 60 * 1000
const TERMS_FAIL_TTL_MS = 10 * 60 * 1000
const termsCache = new Map<string, { at: number; terms: MunicipalTerms | null; pending?: Promise<MunicipalTerms | null>; pendingAt?: number }>()
/** Consulta em curso mais velha que isto é dada por perdida (o transporte só tem timeout de INATIVIDADE — re-prova R4). */
const PENDING_MAX_AGE_MS = 60_000

/**
 * Prazo do município (cache de DADO). Gates da Rodada 4: UMA consulta por vez por município/ambiente (quem chega com uma
 * em curso espera a mesma — convênio pendurado não vira N chamadas vivas); e a FALHA nunca apaga o último prazo conhecido
 * (fica valendo por mais 10 min — uma falha só pode deixar o teto onde estava, nunca encolhê-lo, A13).
 */
function municipalTermsCached(adapter: TaxAuthorityAdapter, ctx: AuthorityContext, cMun: string): Promise<MunicipalTerms | null> {
  const key = `${ctx.environment}:${cMun}`
  const hit = termsCache.get(key)
  if (hit && hit.at > 0 && Date.now() - hit.at < (hit.terms ? TERMS_TTL_MS : TERMS_FAIL_TTL_MS)) return Promise.resolve(hit.terms)
  if (hit?.pending && Date.now() - (hit.pendingAt ?? 0) < PENDING_MAX_AGE_MS) return hit.pending
  const pending = adapter.municipalTerms(ctx, cMun).then(t => t as MunicipalTerms | null, () => null).then(terms => {
    const known = termsCache.get(key)?.terms ?? null
    if (terms) termsCache.set(key, { at: Date.now(), terms })
    else if (known) termsCache.set(key, { at: Date.now() - TERMS_TTL_MS + TERMS_FAIL_TTL_MS, terms: known })   // falha: o último prazo vale +10 min
    else termsCache.set(key, { at: Date.now(), terms: null })
    return terms ?? known                          // o prazo é AVISO; a recusa definitiva é a do fisco (E0822)
  })
  termsCache.set(key, { at: hit?.at ?? 0, terms: hit?.terms ?? null, pending, pendingAt: Date.now() })
  return pending
}

/** O prazo do município com espera LIMITADA (bulkhead): passado o limite segue-se sem ele (null). */
async function termsWithin(adapter: TaxAuthorityAdapter, ctx: AuthorityContext, cMun: string): Promise<MunicipalTerms | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), CEILING_LOOKUP_TIMEOUT_MS) })
  try { return await Promise.race([municipalTermsCached(adapter, ctx, cMun), timeout]) } finally { if (timer) clearTimeout(timer) }
}

export function resetMunicipalTermsCache(): void { termsCache.clear(); ceilingCache.clear() }

/** Arquivo fiscal: falha ao gravar só AVISA (o fato já existe no fisco; a consulta regrava). */
async function saveXmlSafe(deps: NfseDeps, actor: Actor, cnpj: string, name: string, xml: string, when: Date, environment: AuthorityEnvironment, label: string): Promise<void> {
  try {
    const zone = await erp.institutionZone(deps.pool, actor.schemaName, actor.institutionId)
    deps.storage.save(cnpj, name, xml, when, environment, zone)
  } catch (err) {
    logger.warn(`${label} não gravado no arquivo fiscal`, { institutionId: actor.institutionId, name, err: errMsg(err) })
  }
}

const utcDate = (dbUtc: string | null) => (dbUtc ? new Date(`${dbUtc.replace(' ', 'T')}Z`) : new Date())

// ---------------------------------------------------------------------------
// A. Transmitir
// ---------------------------------------------------------------------------

export interface TransmitResult {
  invoiceId:  number
  attempt:    number
  dpsId:      string
  accessKey:  string | null
  nfseNumber: string | null
  kind:       TransmissionEventKind
}

export async function transmitServiceInvoice(deps: NfseDeps, actor: Actor, invoiceId: number): Promise<TransmitResult> {
  const { schemaName: s, institutionId, userId } = actor
  // (a) tudo que é do ERP e pode faltar falha ANTES de reservar e antes do fisco
  const header = await readServiceInvoice(deps.pool, s, institutionId, invoiceId)
  assertTransmittable(header)
  // (b) habilitação + A1 válido (409 legíveis — nunca chamada às cegas)
  const opened0 = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { schemaName: actor.schemaName })
  if (!opened0.issuer.serie) {
    throw new HttpError(409, 'Habilitação do emissor SE sem série — configure na aba Emissor fiscal',
      [{ field: 'serie', message: 'Obrigatória para o DPS' }], ErrorCodes.FISCAL_ISSUER_MISSING)
  }
  // (c) DPS montado FORA da transação; o leiaute é validado já aqui com um nDPS provisório (LOW-1)
  const base = await buildDpsBase(deps.pool, s, institutionId, header, opened0.issuer.environment)
  buildSignedDps(base, opened0.issuer.serie, 1, opened0)

  // (0b) reserva INTERROMPIDA (sem voz há mais de 10 min — HIGH-3 da Onda 2): pergunta ao fisco ANTES
  const latest0 = await latestTransmission(deps.pool, institutionId, invoiceId, header.lifeEvent)
  // D-F95 (= Q-F101 (b)): o ambíguo do passo 0b (GET /dps ou a consulta pela chave) vai ao alarme com a origem "transmissao"
  if (latest0 && isInterruptedInFlight(latest0)) {
    try { await reconcileInterrupted(deps, actor, latest0, opened0) }
    catch (err) { logAmbiguousFiscal('transmissao', { institutionId: actor.institutionId, invoiceId, attempt: latest0.attempt }, err); throw err }
  }

  // (d) TRANSAÇÃO 1 — reserva: a NOTA (ERP) primeiro, depois o EMISSOR (FOR UPDATE: ambiente/série desta
  // leitura — MEDIUM-3) e o A1 (travante), o DPS DA VIDA (write-once — D-F30) e a tentativa.
  // Gate adversarial R2: o emissor e o A1 são travados ANTES de qualquer leitura não travante — o snapshot do
  // REPEATABLE READ nasce na 1ª leitura consistente; nascendo antes da trava do emissor, a reserva que esperava
  // um DELETE do A1 acordava e assinava com o A1 já apagado.
  const reserved = await withInvoiceTx(deps, 'reserva da transmissão', actor, invoiceId, async (conn, locked) => {
    if (!locked.alive || locked.lastEvent !== header.lastInvoiceEvent || locked.lifeEvent !== header.lifeEvent) throw changedDuringTransmit()
    const life = locked.lifeEvent!
    const opened = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { conn, forUpdate: true, schemaName: actor.schemaName })
    // sob a TRAVA DA NOTA todo escritor das tentativas está serializado: leitura NÃO travante (gate M-4 —
    // o FOR UPDATE aqui gerava gap lock ANTES do contador e deadlock entre notas vizinhas)
    const latest = await latestTransmission(conn, institutionId, invoiceId, life)
    if (latest && (isLiveTransmission(latest) || isAuthorized(latest))) throw liveTransmissionError(latest)
    // M2 do socrático da Onda 3 (Q-N33): voz C do fisco com o C local ainda pendente — reenviar o MESMO Id
    // não tem desfecho bom (o fisco ecoa a NFS-e cancelada). Resolve-se no ERP antes (D-F28).
    // D-F67/D-F68: SUBSTITUÍDA no fisco (e105102) = nunca reenviar o mesmo DPS, mantida ou não a nota
    if (isSubstitutionCancel(latest)) throw substituted(latest!.attempt)
    if (latest?.lastKind === 'C' && locked.lastKind !== 'C') throw effectPending(latest.attempt)
    if ((await branchUpdatedAt(conn, s, institutionId, invoiceId)) !== header.branchUpdatedAt) throw changedDuringTransmit()
    let dps = await getLifeDps(conn, institutionId, invoiceId, life)
    if (!dps) {
      // D-N3/D-F30: a 1ª transmissão DESTA VIDA cunha série + nDPS (contador do emissor — D-N18) e o Id
      if (!opened.issuer.serie) throw new HttpError(409, 'Habilitação do emissor SE sem série', undefined, ErrorCodes.FISCAL_ISSUER_MISSING)
      const nDps = await nextDpsNumber(conn, institutionId)
      dps = { lifeEvent: life, serie: opened.issuer.serie, dpsNumber: nDps, dpsId: serviceDpsId(base.emitter, opened.issuer.serie, nDps) }
      await insertLifeDps(conn, institutionId, invoiceId, dps, userId)
    } else if (serviceDpsId(base.emitter, dps.serie, dps.dpsNumber) !== dps.dpsId) {
      // o fisco já conhece o Id desta vida; município/CNPJ do emitente mudaram desde então (D-F30)
      throw new HttpError(409, `O Id do DPS desta nota (${dps.dpsId}) mudaria com o cadastro atual do estabelecimento — o fisco já conhece o Id antigo; nada enviado`,
        [{ field: 'emitter', message: 'Município ou CNPJ do emitente mudou desde a 1ª tentativa' }], ErrorCodes.FISCAL_DPS_ID_CHANGED)
    }
    const attempt = await insertTransmission(conn, institutionId, invoiceId, life, opened.issuer.environment, userId)
    const { dpsId, xml } = buildSignedDps(base, dps.serie, dps.dpsNumber, opened, opened.issuer.environment)
    return { attempt, dpsId, xml, opened }
  }, { requireAlive: true })
  const environment = reserved.opened.issuer.environment
  const ctx = ctxFor(reserved.opened, environment)

  // (e) o DPS assinado no arquivo fiscal — snapshot do que foi dito ao fisco
  await saveXmlSafe(deps, actor, base.emitter.cnpj, dpsFileName(reserved.dpsId), reserved.xml, new Date(), environment, 'DPS assinado')

  // (f) o FISCO — fora de qualquer transação
  let outcome
  try {
    outcome = await deps.adapter.transmit(ctx, reserved.xml)
  } catch (err) {
    const cls = classifyAuthorityError(err)
    // (g') AMBÍGUO: o fisco PODE ter gerado a NFS-e — a reserva fica EM VOO; a consulta por dps_id reconcilia
    if (cls === 'ambiguous') throw err
    const aerr = err as AuthorityHttpError
    await withInvoiceTx(deps, 'voz do fisco (recusa)', actor, invoiceId, async conn => {
      await insertTransmissionEvent(conn, institutionId, invoiceId, reserved.attempt, userId, {
        kind: OUTCOME_KIND[cls], source: 'P', authorityCode: firstAuthorityCode(aerr), message: authorityMessage(aerr),
      })
    })
    logger.info('Fisco recusou o DPS', { institutionId, invoiceId, attempt: reserved.attempt, kind: OUTCOME_KIND[cls], code: aerr.code })
    throw err
  }

  // (g) AUTORIZADA: write-once do fisco + voz A + XML da NFS-e
  const dh = toDbDateTime(outcome.dhProc)
  const holderAttempt = await withInvoiceTx(deps, 'voz do fisco (autorizada)', actor, invoiceId, async conn => {
    // gate socrático M-5: a consulta (rodízio/outra tela) pode ter pousado ESTA chave numa irmã durante o
    // POST — a chave é UMA (UNIQUE); a reservada fecha como envio reconciliado, nunca 500
    const holder = await findKeyHolder(conn, institutionId, invoiceId, outcome.accessKey)
    if (holder && holder.attempt !== reserved.attempt) {
      const cur = await getTransmission(conn, institutionId, invoiceId, reserved.attempt)
      if (cur && cur.lastKind === null) {
        await insertTransmissionEvent(conn, institutionId, invoiceId, reserved.attempt, userId, {
          kind: 'F', source: 'P', message: `A NFS-e deste DPS pertence à tentativa ${holder.attempt} (chave ${outcome.accessKey}) — envio reconciliado`,
        })
      }
      return holder.attempt
    }
    await fillAuthorityData(conn, institutionId, invoiceId, reserved.attempt, { accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber, dhProc: dh })
    if (!(await hasTransmissionEvent(conn, institutionId, invoiceId, reserved.attempt, 'A', dh))) {
      await insertTransmissionEvent(conn, institutionId, invoiceId, reserved.attempt, userId, {
        kind: 'A', source: 'P', dh, message: `NFS-e ${outcome.nfseNumber ?? ''} chave ${outcome.accessKey}`.trim(),
      })
    }
    return reserved.attempt
  })
  await saveXmlSafe(deps, actor, base.emitter.cnpj, nfseFileName(outcome.accessKey), outcome.nfseXml, new Date(), environment, 'XML da NFS-e autorizada')
  logger.info('NFS-e autorizada', { institutionId, invoiceId, attempt: holderAttempt, accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber })
  return { invoiceId, attempt: holderAttempt, dpsId: reserved.dpsId, accessKey: outcome.accessKey, nfseNumber: outcome.nfseNumber, kind: 'A' }
}

/**
 * Envio interrompido (reserva sem voz > 10 min): GET /dps/{id}. Achou → A pela consulta; não achou →
 * F "sem resposta" (o POST /nfse é síncrono — 10 min depois, ou a NFS-e existe ou nunca chegou).
 */
async function reconcileInterrupted(deps: NfseDeps, actor: Actor, tx: TransmissionRow, opened: OpenedIssuer): Promise<void> {
  if (!tx.dpsId) return
  const key = await deps.adapter.queryDpsAccessKey(ctxFor(opened, tx.environment), tx.dpsId)
  if (key) {
    await refreshServiceTransmission(deps, actor, tx.invoiceId, 'Q', { attempt: tx.attempt })
    return
  }
  await recordInterruptedFailure(deps, actor, tx)
}

/**
 * F "sem resposta" por CONSULTA: tentativa EM VOO (sem voz) há ≥ IN_FLIGHT_MINUTES e o fisco NÃO conhece o DPS = envio
 * interrompido (conclusivo — o mesmo critério da Onda 2, HIGH-3). Um veredito só, nos dois caminhos (D-F51 = Q-F60 (a),
 * Valdo 2026-10-04): o transmitir (reserva interrompida) e o consultar (rota por nota e passada do rodízio — sem isso a
 * em voo de ramo cortado nunca fechava e travava o emitente; D-F47). Sob a trava da nota; reconfere que segue sem voz.
 * Devolve true se gravou.
 */
async function recordInterruptedFailure(deps: NfseDeps, actor: Actor, tx: TransmissionRow): Promise<{ recorded: boolean; current: TransmissionRow | null }> {
  return withInvoiceTx(deps, 'reconciliação do envio interrompido', actor, tx.invoiceId, async conn => {
    // sob a trava da nota a leitura é não travante (o snapshot nasce DEPOIS da trava — PADROES §9 regra 2)
    const cur = await getTransmission(conn, actor.institutionId, tx.invoiceId, tx.attempt)
    if (!cur || cur.lastKind !== null) return { recorded: false, current: cur }
    await touchQueriedAt(conn, actor.institutionId, tx.invoiceId, tx.attempt)
    await insertTransmissionEvent(conn, actor.institutionId, tx.invoiceId, tx.attempt, actor.userId, {
      kind: 'F', source: 'Q', message: 'Sem resposta do fisco e nenhuma NFS-e gerada para este DPS — envio interrompido',
    })
    return { recorded: true, current: cur }
  })
}

// ---------------------------------------------------------------------------
// B. Consultar o fisco e gravar a voz (sem efeito no ERP — D-F28)
// ---------------------------------------------------------------------------

export interface RefreshResult {
  invoiceId: number
  attempt:   number
  changed:   boolean
  kind:      TransmissionEventKind | null
  accessKey: string | null
  /** Voz C do fisco com a nota ainda não cancelada no ERP: o app envia o cancelamento ao setes-api (D-F28). */
  localCancelPending: boolean
}

/** Voz C desta tentativa — idempotente por KIND (HIGH-3a: um C por tentativa, qualquer dh). Sem efeito. */
async function recordCancelVoice(
  conn: PoolConnection, institutionId: number, userId: number | null, invoiceId: number, attempt: number,
  source: TransmissionSource, dh: string | null, motive: string | null, eventCode: string | null = null,
): Promise<{ event: number; inserted: boolean; code: string | null }> {
  const existing = await findTransmissionEventByKind(conn, institutionId, invoiceId, attempt, 'C')   // sob a trava da nota
  if (existing) return { event: existing.event, inserted: false, code: existing.authorityCode ?? null }
  // D-F64: a SUBSTITUIÇÃO (e105102) fica escrita na voz — o efeito local (do setes-api, D-F28) NÃO é automático para ela
  const voiceText = `Cancelada no fisco${eventCode === '105102' ? ' por SUBSTITUIÇÃO (e105102)' : ''}${motive ? ': ' + motive : ''}`
  const event = await insertTransmissionEvent(conn, institutionId, invoiceId, attempt, userId, {
    // D-F68/D-F71: o TIPO do evento de cancelamento vai em `authority_code` (escrito uma vez; fora do domínio = NULL, nunca
    // o 500 do CHECK — o adaptador só entrega códigos de CANCEL_EVENT_CODES)
    kind: 'C', source, dh, message: voiceText.slice(0, 255), authorityCode: eventCode && CANCEL_EVENT_CODES.has(eventCode) ? eventCode : null,
  })
  return { event, inserted: true, code: eventCode && CANCEL_EVENT_CODES.has(eventCode) ? eventCode : null }
}

/**
 * D-F87/D-F91 (= Q-F93 (a)/Q-F97 (a), Valdo 2026-10-11): resposta AMBÍGUA do fisco é fail-closed (nada grava) — a saída é o ALARME
 * da F3, que AGREGA por nota; só a composição sabe QUAL nota: o log leva institution, nota, tentativa (quando conhecida) e a ORIGEM
 * (rodízio, consulta pela tela, reconferência). Nunca a chave de acesso.
 */
/** D-F95 (= Q-F101 (b)): a origem é dita EXPLICITAMENTE por quem chama — nunca deduzida pela ausência de flags. */
export type AmbiguousOrigin = 'rodizio' | 'consulta' | 'reconferencia' | 'transmissao'
// CONHECIMENTO NEGATIVO (D-F100 = Q-F106 (a), Valdo 2026-10-11): não "enriquecer" este alarme com texto, hash ou corpo da resposta —
// a causa da lista FECHADA (D-F98) + institution, nota, tentativa, origem e instante bastam para o chamado à Sefin.
export function logAmbiguousFiscal(
  origin: AmbiguousOrigin,
  at: { institutionId: number; invoiceId: number; attempt?: number | null; lastKind?: string | null }, err: unknown,
): void {
  if (!(err instanceof HttpError) || err.code !== ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE) return
  logger.error('Fisco ambíguo persistente: a nota não pôde ser concluída no fisco',
    // D-F94 (= Q-F100 (b)) → D-F98 (= Q-F104 (b), Valdo 2026-10-11): só o CÓDIGO + a CAUSA da lista FECHADA (`ambiguousCauseOf`) —
    // nunca texto da mensagem/resposta: a máscara de dígitos da D-F94 deixava passar as LETRAS de um CNPJ alfanumérico (R18-01)
    { origin, institutionId: at.institutionId, invoiceId: at.invoiceId, attempt: at.attempt ?? null, lastKind: at.lastKind ?? null,
      code: err.code, reason: ambiguousCauseOf(err) })
}

export async function refreshServiceTransmission(
  deps: NfseDeps, actor: Actor, invoiceId: number, source: Exclude<TransmissionSource, 'P'> = 'Q',
  opts: { query?: NfseQuery; attempt?: number; fromRun?: boolean; origin?: 'consulta' } = {},
): Promise<RefreshResult> {
  try {
    return await refreshServiceTransmissionInner(deps, actor, invoiceId, source, opts)
  } catch (err) {
    // D-F91/D-F95: registra quem DISSE a origem (consulta da tela); o rodízio e a reconferência/transmissão registram por si, com mais
    // contexto — sem origem dita, nada (nunca deduzida pela ausência de flags — R17-03)
    if (opts.origin) logAmbiguousFiscal(opts.origin, { institutionId: actor.institutionId, invoiceId, attempt: opts.attempt ?? null }, err)
    throw err
  }
}

async function refreshServiceTransmissionInner(
  deps: NfseDeps, actor: Actor, invoiceId: number, source: Exclude<TransmissionSource, 'P'>,
  opts: { query?: NfseQuery; attempt?: number; fromRun?: boolean },
): Promise<RefreshResult> {
  const { schemaName: s, institutionId, userId } = actor
  const life = await erp.invoiceLife(deps.pool, s, institutionId, invoiceId)
  if (!life) throw new HttpError(404, `Nota ${invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  // R3-1: quem sabe qual tentativa quer olhar diz — senão a vigente da vida
  const tx0 = (opts.attempt != null ? await getTransmission(deps.pool, institutionId, invoiceId, opts.attempt) : null)
    ?? await latestTransmission(deps.pool, institutionId, invoiceId, life?.lifeEvent ?? null)
  if (!tx0) throw new HttpError(409, `Nota ${invoiceId} nunca foi transmitida ao fisco`, undefined, ErrorCodes.FISCAL_NOT_TRANSMITTED)
  const pendingOf = (kind: TransmissionEventKind | null, code: string | null = null) => localCancelPending({ lastKind: kind, lastCode: code }, life?.lastKind ?? null)
  const unchanged = (tx: TransmissionRow): RefreshResult =>
    ({ invoiceId, attempt: tx.attempt, changed: false, kind: tx.lastKind, accessKey: tx.accessKey, localCancelPending: pendingOf(tx.lastKind, tx.lastCode) })
  if (!tx0.dpsId) return unchanged(tx0)
  if (tx0.lastKind === 'C') {                                // C é o fim da história da tentativa (o efeito é do ERP)
    // D-F78 (= Q-F85 (a), Valdo 2026-10-10): a consulta relê o fisco SÓ para arquivar o XML do evento que faltou (Q-N38 —
    // e, na substituição, a chave da substituta — D-F76); a voz não muda
    if (!opts.query) await archiveCancelEventIfMissing(deps, actor, invoiceId, tx0)
    return unchanged(tx0)
  }

  // o fisco — fora da transação, no ambiente CONGELADO da tentativa
  let query = opts.query ?? null
  let target = tx0
  let accessKey = tx0.accessKey
  if (!query) {
    const opened = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { schemaName: actor.schemaName })
    const ctx = ctxFor(opened, tx0.environment)
    if (!accessKey) {
      // a chave é da tentativa que CUNHOU o Id: se uma irmã JÁ a detém (R3-1: esta é órfã), consulta-se por ela
      const holder = await findTransmissionByDpsId(deps.pool, institutionId, invoiceId, tx0.lifeEvent, tx0.dpsId, tx0.environment)
      if (holder?.accessKey) {
        accessKey = holder.accessKey
        target = holder
      } else {
        // MEDIUM-1: sem chave (em voo, R ou F) a pergunta é pelo Id do DPS
        accessKey = await deps.adapter.queryDpsAccessKey(ctx, tx0.dpsId)
        if (!accessKey) {
          // D-F51: em voo há ≥ IN_FLIGHT_MINUTES e o fisco sem o DPS = envio interrompido → F (o mesmo veredito do transmitir)
          if (isInterruptedInFlight(tx0)) {
            const closed = await recordInterruptedFailure(deps, actor, tx0)
            if (closed.recorded) return { invoiceId, attempt: tx0.attempt, changed: true, kind: 'F', accessKey: null, localCancelPending: pendingOf('F') }
            // gate r10 LOW [r10-lost-race-stale]: outro escritor gravou a voz antes (sob a trava ela já existe) — devolve a voz
            // LIDA e NÃO carimba last_queried_at: este GET /dps é ANTERIOR à voz do vencedor (a prova da D-F29 exige posterior)
            if (closed.current) return unchanged(closed.current)
          }
          await touchQueriedAt(deps.pool, institutionId, invoiceId, tx0.attempt)   // em voo recente (ou já com voz): "nós olhamos"
          // D-F90: o E2404 desta pergunta é fato (inclusive na revisita do F — D-F52); só pousa se a voz vista ainda é a última
          await recordNfseNotGenerated(deps.pool, institutionId, invoiceId, tx0.attempt, tx0.lastEvent ?? null)
          return unchanged(tx0)
        }
        target = holder ?? tx0
      }
    }
    query = await deps.adapter.queryNfse(ctx, accessKey)
  }
  const nfse = query
  const parsed = parseNfseXml(nfse.nfseXml)
  // R2-2 (c): a NFS-e embute o DPS — tem que ser o DESTA tentativa; resposta trocada nunca grava chave alheia
  if (parsed.dpsId && target.dpsId && parsed.dpsId !== target.dpsId) {
    // D-F98 (c) (= Q-F104, Valdo 2026-10-11): o Id que veio é de TERCEIRO (embute o CPF/CNPJ dele) — nunca na mensagem (que vai ao app)
    // CONHECIMENTO NEGATIVO (D-F100 = Q-F106 (a), Valdo 2026-10-11): NADA da resposta alheia é guardado — nem hash do Id (CPF se
    // quebra por força bruta), nem o corpo cru; o alarme (institution, nota, causa, instante) basta para o chamado à Sefin e o caso se
    // reproduz consultando de novo. Reabrir só se a resposta trocada acontecer de verdade.
    throw tagAmbiguous(new HttpError(502, 'Fisco devolveu a NFS-e de OUTRO DPS para a consulta desta tentativa (Id divergente) — nada gravado',
      undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE), 'nfse-de-outro-dps')
  }
  const dhA = toDbDateTime(nfse.dhProc ?? parsed.dhProc)

  const result = await withInvoiceTx(deps, 'voz do fisco (consulta)', actor, invoiceId, async (conn, locked): Promise<RefreshResult> => {
    const pendingNow = (kind: TransmissionEventKind | null, code: string | null = null) => localCancelPending({ lastKind: kind, lastCode: code }, locked.lastKind)
    const tx = await getTransmission(conn, institutionId, invoiceId, target.attempt)      // sob a trava da nota
    if (!tx) return { ...unchanged(target), localCancelPending: pendingNow(target.lastKind, target.lastCode) }
    await touchQueriedAt(conn, institutionId, invoiceId, tx.attempt)
    // R3-1: a tentativa que perguntou está em voo e a NFS-e deste Id é de OUTRA — órfã: encerra com F
    if (tx0.attempt !== tx.attempt && tx0.lastKind === null) {
      const orphan = await getTransmission(conn, institutionId, invoiceId, tx0.attempt)
      if (orphan && orphan.lastKind === null) {
        await touchQueriedAt(conn, institutionId, invoiceId, orphan.attempt)
        await insertTransmissionEvent(conn, institutionId, invoiceId, orphan.attempt, userId, {
          kind: 'F', source, message: `A NFS-e deste DPS pertence à tentativa ${tx.attempt} (chave ${accessKey}) — envio reconciliado`,
        })
      }
    }
    if (nfse.status === 'unknown') {
      throw tagAmbiguous(new HttpError(502, 'Fisco respondeu sem situação legível para a NFS-e — nada gravado; verifique o adaptador',
        undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE), nfse.unknownCause ?? 'situacao-ilegivel')   // gate R19 (S3)
    }
    await fillAuthorityData(conn, institutionId, invoiceId, tx.attempt, { accessKey: nfse.accessKey, nfseNumber: parsed.nNFSe, dhProc: dhA })
    let changed = false
    let kind: TransmissionEventKind | null = tx.lastKind
    // A: quando a tentativa ainda não a tem — inclusive depois de R/F (MEDIUM-1); nunca depois de C/K
    if (!isAuthorized(tx) && tx.lastKind !== 'C' && tx.lastKind !== 'K'
        && !(await hasTransmissionEvent(conn, institutionId, invoiceId, tx.attempt, 'A', dhA))) {
      await insertTransmissionEvent(conn, institutionId, invoiceId, tx.attempt, userId, {
        kind: 'A', source, dh: dhA, message: `NFS-e ${parsed.nNFSe ?? ''} chave ${nfse.accessKey}`.trim(),
      })
      changed = true; kind = 'A'
    }
    if (nfse.status !== 'cancelled') {
      // D-N17/D-N28: K sem cancelamento no fisco → N "pedido não consta" — só depois da CARÊNCIA
      if (tx.lastKind === 'K' && (tx.lastEventAgeMinutes ?? 0) >= IN_FLIGHT_MINUTES) {
        const zone = await erp.institutionZone(conn, s, institutionId)
        await insertTransmissionEvent(conn, institutionId, invoiceId, tx.attempt, userId, {
          kind: 'N', source, dh: toDbDateTime(nowIsoIn(zone)), message: 'Pedido de cancelamento não consta no fisco — NFS-e segue autorizada',
        })
        changed = true; kind = 'N'
      }
      return { invoiceId, attempt: tx.attempt, changed, kind, accessKey: nfse.accessKey, localCancelPending: false }
    }
    // C do fisco: só a VOZ (por KIND). O C local é do setes-api (D-F28).
    const v = await recordCancelVoice(conn, institutionId, userId, invoiceId, tx.attempt, source,
      toDbDateTime(nfse.cancelled?.dhEvento), nfse.cancelled?.motive ?? null, nfse.cancelled?.eventCode ?? null)
    return { invoiceId, attempt: tx.attempt, changed: changed || v.inserted, kind: 'C', accessKey: nfse.accessKey,
      localCancelPending: pendingNow('C', v.code) }
  })

  // XML no arquivo fiscal (regrava se faltar — o transmit pode ter falhado ao gravar) e evento de cancelamento (Q-N38)
  if (nfse.nfseXml && result.accessKey) {
    try {
      const cnpj = await emitterCnpj(deps.pool, institutionId)
      const zone = await erp.institutionZone(deps.pool, s, institutionId)
      const when = utcDate(target.dhProc)
      const hints = [target.dhProc, target.createdAt]
      if (!deps.storage.find(cnpj, nfseFileName(result.accessKey), hints, target.environment, zone)) {
        deps.storage.save(cnpj, nfseFileName(result.accessKey), nfse.nfseXml, when, target.environment, zone)
      }
      const eventXml = nfse.cancelled?.eventXml
      if (eventXml && !deps.storage.find(cnpj, cancelEventFileName(result.accessKey), hints, target.environment, zone)) {
        deps.storage.save(cnpj, cancelEventFileName(result.accessKey), eventXml, when, target.environment, zone)
      }
    } catch (err) {
      logger.warn('XML da NFS-e não gravado na consulta', { institutionId, invoiceId, err: errMsg(err) })
    }
  }
  return result
}

/**
 * D-F78 (= Q-F85 (a)): XML do evento de cancelamento que não foi arquivado na 1ª leitura (disco/CNPJ falharam) — relê o fisco
 * e grava SÓ o arquivo, se a resposta for o cancelamento DESTE código (ou a voz não tiver código). Nada de voz: a C é final.
 */
async function archiveCancelEventIfMissing(deps: NfseDeps, actor: Actor, invoiceId: number, tx: TransmissionRow): Promise<void> {
  if (!tx.accessKey) return
  const { schemaName: s, institutionId } = actor
  // R13-06 do gate adversarial: best-effort (Q-N38: falhar ao gravar só avisa) — fisco fora ou A1 vencido não fazem a consulta
  // de um estado FINAL falhar; a próxima consulta tenta de novo
  try {
    const cnpj = await emitterCnpj(deps.pool, institutionId)
    const zone = await erp.institutionZone(deps.pool, s, institutionId)
    const hints = [tx.dhProc, tx.createdAt]
    if (deps.storage.find(cnpj, cancelEventFileName(tx.accessKey), hints, tx.environment, zone)) return
    const opened = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { schemaName: s })
    const q = await deps.adapter.queryNfse(ctxFor(opened, tx.environment), tx.accessKey)
    const xml = q.status === 'cancelled' ? q.cancelled?.eventXml : null
    if (!xml || (tx.lastCode && q.cancelled?.eventCode !== tx.lastCode)) {
      logger.warn('Consulta de C: o fisco não devolveu o evento deste cancelamento para arquivar', { institutionId, invoiceId, attempt: tx.attempt, code: tx.lastCode, got: q.cancelled?.eventCode ?? q.status })
      return
    }
    deps.storage.save(cnpj, cancelEventFileName(tx.accessKey), xml, utcDate(tx.dhProc), tx.environment, zone)
  } catch (err) {
    logger.warn('XML do evento de cancelamento não arquivado na consulta', { institutionId, invoiceId, attempt: tx.attempt, err: errMsg(err) })
  }
}

// ---------------------------------------------------------------------------
// C. Reconfirmar no fisco antes do cancelamento LOCAL (Q-ADV1b → D-F29)
// ---------------------------------------------------------------------------

export interface ReconfirmResult {
  invoiceId: number
  /** false = nada a reconfirmar (sem F por consulta em produção na vida, ou já há chave). */
  needed:    boolean
  /** true = o fisco tem a NFS-e: reconciliada como A — o cancelamento passa a exigir "Cancelar NFS-e". */
  found:     boolean
  attempt:   number | null
  accessKey: string | null
}

/**
 * A conferência que o setes-api fazia dentro do cancelamento local agora é pedida pelo APP aqui. Não
 * achou (E2404 explícito) → grava `nfse_not_generated_at` na candidata: é a PROVA que o setes-api exige (resposta
 * POSTERIOR ao F — D-F90) antes de cancelar localmente. Fisco fora/ambíguo → o erro sobe (fail-closed: não se prova
 * no escuro) e nada é carimbado como prova.
 */
export async function reconfirmBeforeLocalCancel(deps: NfseDeps, actor: Actor, invoiceId: number): Promise<ReconfirmResult> {
  const { schemaName: s, institutionId } = actor
  const life = await erp.invoiceLife(deps.pool, s, institutionId, invoiceId)
  if (!life) throw new HttpError(404, `Nota ${invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  const { transmissions } = await listLifeTransmissions(deps.pool, institutionId, invoiceId, life.lifeEvent)
  const cand = reconfirmationCandidate(transmissions)
  if (!cand) return { invoiceId, needed: false, found: false, attempt: null, accessKey: null }
  try {
    return await reconfirmCandidate(deps, actor, invoiceId, cand, transmissions, life.lifeEvent)
  } catch (err) {
    logAmbiguousFiscal('reconferencia', { institutionId, invoiceId, attempt: cand.attempt }, err)   // D-F91
    throw err
  }
}

async function reconfirmCandidate(
  deps: NfseDeps, actor: Actor, invoiceId: number, cand: TransmissionRow, transmissions: TransmissionRow[], lifeEvent: number | null,
): Promise<ReconfirmResult> {
  const { institutionId } = actor
  const opened = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { schemaName: actor.schemaName })
  const ctx = ctxFor(opened, cand.environment)
  const key = await deps.adapter.queryDpsAccessKey(ctx, cand.dpsId!)
  if (!key) {
    await touchQueriedAt(deps.pool, institutionId, invoiceId, cand.attempt)
    // D-F90: a prova é o E2404 desta pergunta, gravado só se a voz vista (o F da candidata) ainda é a última. LOW-4 do gate da
    // Rodada 16: se a guarda recusou (outra voz nasceu durante a pergunta), a resposta NÃO afirma a reconferência — o app consulta
    // de novo (a F2a recusaria o cancelamento local de qualquer jeito; a resposta não pode dizer um fato que não foi gravado)
    if (!(await recordNfseNotGenerated(deps.pool, institutionId, invoiceId, cand.attempt, cand.lastEvent ?? null))) {
      throw new HttpError(409, 'A tentativa mudou durante a reconferência no fisco — consulte a nota de novo antes de cancelar',
        [{ field: 'fiscal', message: 'Tentativa mudou' }], ErrorCodes.RESOURCE_BUSY)
    }
    return { invoiceId, needed: true, found: false, attempt: cand.attempt, accessKey: null }
  }
  logger.warn('NFS-e achada no fisco para DPS dado como sem resposta — reconciliando antes do cancelamento local',
    { institutionId, invoiceId, attempt: cand.attempt, dpsId: cand.dpsId })
  // Q-ADV2d: a consulta pela CHAVE vai pronta ao refresh (um GET /dps só); Q-ADV2h: a chave pousa na que CUNHOU o Id
  const query = await deps.adapter.queryNfse(ctx, key)
  // a chave de um ambiente só pousa numa tentativa DESSE ambiente (gate adversarial HIGH)
  const minter = [...transmissions].sort((a, b) => a.attempt - b.attempt)
    .find(t => t.dpsId === cand.dpsId && t.environment === cand.environment) ?? cand
  await refreshServiceTransmission(deps, actor, invoiceId, 'Q', { attempt: minter.attempt, query })
  const after = await listLifeTransmissions(deps.pool, institutionId, invoiceId, lifeEvent)
  if (!after.transmissions.some(t => !!t.accessKey)) {
    throw new HttpError(409, `A NFS-e deste DPS existe no fisco (chave ${key}) mas não foi reconciliada — consulte a nota antes de cancelar`,
      [{ field: 'fiscal', message: 'NFS-e existe no fisco' }], ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
  }
  return { invoiceId, needed: true, found: true, attempt: minter.attempt, accessKey: key }
}

// ---------------------------------------------------------------------------
// D. Cancelar NO FISCO — operação em linha (D-F28): ok → o app envia ao setes-api
// ---------------------------------------------------------------------------

export interface CancelAtAuthorityResult {
  invoiceId:         number
  attempt:           number
  /** false = a voz C já existia (idempotente: o app segue para o setes-api do mesmo jeito). */
  atAuthority:       boolean
  transmissionEvent: number
  warnings:          string[]
  nextStep:          'apply-local-cancel'
}

export async function cancelServiceInvoiceAtAuthority(deps: NfseDeps, actor: Actor, invoiceId: number, reason: string): Promise<CancelAtAuthorityResult> {
  const { schemaName: s, institutionId, userId } = actor
  const motive = String(reason ?? '').trim()
  if (!motive) throw new HttpError(400, 'Motivo do cancelamento é obrigatório', [{ field: 'reason', message: 'Obrigatório' }], ErrorCodes.INVOICE_REASON_REQUIRED)
  // (0) D-F39: RÉPLICA do ERP recusa ANTES de qualquer voz (gate adversarial R4: o K da reserva era gravado na tentativa
  // copiada e só depois o `openIssuer` recusava — a próxima re-sincronia acusaria dual-write)
  // (gates R4, re-prova): o predicado COMPLETO — réplica viva OU excluída, e a lacuna sem linha com SE no ERP
  if (await emissionStillInErp(deps.pool, s, institutionId)) {
    throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — a API fiscal só consulta até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }

  // (1) estado fiscal da vida vigente, SOB a trava da nota (o plano LOCAL o app já consultou no setes-api —
  // D-F29) + RESERVA do pedido: a voz K ("cancelamento em voo") nasce AQUI, ANTES da chamada ao fisco (gate
  // adversarial M: sem a reserva, dois "Cancelar NFS-e" simultâneos mandavam dois e101101 e o 2º voltava
  // "recusado" com a NFS-e já cancelada). Quem chega depois vê K → 409 FISCAL_CANCEL_IN_FLIGHT.
  type Decision = { already: { attempt: number; event: number } } | { authorized: TransmissionRow; dhEvento: string }
  const decision = await withInvoiceTx(deps, 'decisão do cancelamento fiscal', actor, invoiceId, async (conn, locked): Promise<Decision> => {
    // as saídas que NÃO falam com o fisco (C já gravada = idempotente; R/F/sem tentativa = "cancele no ERP"; viva) vêm
    // ANTES de abrir o emissor — leituras não travantes da tentativa (gate adversarial r8 MEDIUM [r8-cancel-idem]: com o
    // openIssuer primeiro, o retry com voz C e A1 vencido virava 409 FISCAL_CERT_* e o app não seguia ao setes-api)
    const tx = await latestTransmission(conn, institutionId, invoiceId, locked.lifeEvent)
    if (tx?.lastKind === 'C') {
      const voice = await findTransmissionEventByKind(conn, institutionId, invoiceId, tx.attempt, 'C')
      return { already: { attempt: tx.attempt, event: voice?.event ?? tx.lastEvent ?? 0 } }
    }
    if (!tx || tx.lastKind === 'R' || tx.lastKind === 'F') {
      throw new HttpError(409, 'Não há NFS-e autorizada para cancelar no fisco — cancele a nota direto no sistema',
        [{ field: 'fiscal', message: tx ? `Última voz ${tx.lastKind}` : 'Nunca transmitida' }], ErrorCodes.FISCAL_NOT_AUTHORIZED)
    }
    if (tx.lastKind === null || tx.lastKind === 'S' || tx.lastKind === 'K') throw liveTransmissionError(tx)
    if (!tx.accessKey) throw new HttpError(409, `Transmissão ${tx.attempt} autorizada sem chave de acesso — consulte antes`, undefined, ErrorCodes.FISCAL_TRANSMISSION_IN_PROGRESS)
    // re-prova final R4 (MEDIUM): a reserva K passa pela TRAVA da habilitação (ordem nota → habilitação → A1, a da reserva
    // da transmissão) — sem ela o DELETE do A1 contava as vivas antes do K e apagava o certificado com o pedido em curso.
    // Gates do delta de 2026-10-04: e confere o A1 SOB essa trava, logo ANTES do K (A1 ausente/vencido/ilegível = 409 sem K —
    // o K→N deixava uma janela: processo caído entre os dois = K vivo sem A1, o estado que a guarda do DELETE impede)
    await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { conn, forUpdate: true, schemaName: s })
    const zone = await erp.institutionZone(conn, s, institutionId)
    const dhEvento = nowIsoIn(zone)
    // K e o N de liberação são fatos NOSSOS, não voz do fisco: dh NULL — a chave única (kind, dh) é a
    // idempotência da VOZ do fisco; K → N → K no mesmo segundo colidia nela (500 — adversarial ao vivo, retrabalho)
    await insertTransmissionEvent(conn, institutionId, invoiceId, tx.attempt, userId, {
      kind: 'K', source: 'P', dh: null, message: 'Pedido de cancelamento ao fisco em andamento',
    })
    return { authorized: tx, dhEvento }                                                 // A, ou N depois de K (D-N17)
  }, { requireAlive: true })
  if ('already' in decision) {
    return { invoiceId, attempt: decision.already.attempt, atAuthority: false, transmissionEvent: decision.already.event, warnings: [], nextStep: 'apply-local-cancel' }
  }
  const tx = decision.authorized
  const dhEvento = decision.dhEvento

  /** O pedido NÃO vigora (recusado pelo fisco ou nem enviado): N devolve a NFS-e a autorizada (D-N17). */
  const release = (message: string) => withInvoiceTx(deps, 'pedido de cancelamento não vigora', actor, invoiceId, async conn => {
    const cur = await getTransmission(conn, institutionId, invoiceId, tx.attempt)
    if (!cur || cur.lastKind !== 'K') return
    await insertTransmissionEvent(conn, institutionId, invoiceId, tx.attempt, userId, {
      kind: 'N', source: 'P', dh: null, message: message.slice(0, 255),                // fato nosso (ver o K acima)
    })
  })

  // (2) preparo LOCAL — falhou aqui, o fisco não foi chamado: o pedido não vigora
  let opened: OpenedIssuer, ctx: AuthorityContext, identity: EmitterIdentity, signed: { xml: string; xMotivo: string }
  const warnings: string[] = []
  try {
    opened = await openIssuer(estDeps(deps), institutionId, SERVICE_MODEL, { schemaName: actor.schemaName })
    ctx = ctxFor(opened, tx.environment)
    identity = (await buildEmitter(deps.pool, s, institutionId)).identity
    // prazo do PAM: AVISO — a recusa definitiva é a do fisco (D-N15)
    const terms = await termsWithin(deps.adapter, ctx, identity.cMunEmi)      // ≤ 3 s com o K reservado (gates R4)
    const cancelDays = Number(terms?.cancelDays)
    if (Number.isInteger(cancelDays) && cancelDays >= 1 && cancelDays <= MAX_PLAUSIBLE_CANCEL_DAYS && tx.dhProc) {
      const limit = utcDate(tx.dhProc).getTime() + cancelDays * 86_400_000
      if (limit < Date.now()) warnings.push(`Prazo de cancelamento do município (${cancelDays} dias após ${tx.dhProc}) já passou — o fisco pode recusar`)
    }
    signed = buildSignedCancel(tx.accessKey!, motive, dhEvento, tx.environment, identity.cnpj, opened)
  } catch (err) {
    await release(`Pedido de cancelamento não enviado: ${err instanceof HttpError ? errMsg(err) : 'falha interna no preparo'}`)
    throw err
  }

  // (3) pedido ao fisco — FORA de transação
  let registered
  try {
    registered = await deps.adapter.registerEvent(ctx, tx.accessKey!, signed.xml)
  } catch (err) {
    const cls = classifyAuthorityError(err)
    if (cls === 'rejected') {
      const aerr = err as AuthorityHttpError
      await release(`Fisco recusou o cancelamento: ${authorityMessage(aerr)}`)
      throw new HttpError(409, `Fisco recusou o cancelamento: ${authorityMessage(aerr)}`, aerr.fields, ErrorCodes.FISCAL_CANCEL_REFUSED)
    }
    if (cls === 'auth_failed' || cls === 'local') {                   // R3-2: o fisco NÃO processou o pedido
      await release(`Pedido de cancelamento não aceito (credencial): ${err instanceof HttpError ? errMsg(err) : 'falha de credencial'}`)
      throw err
    }
    // AMBÍGUO: o fisco PODE ter cancelado — o K da reserva FICA e bloqueia tudo até a consulta reconciliar (C ou N)
    logger.warn('Pedido de cancelamento sem resposta — K em voo', { institutionId, invoiceId, attempt: tx.attempt, err: errMsg(err) })
    throw err
  }

  // (4) Q-N38: o evento GERADO pelo fisco no arquivo fiscal (mesma pasta da NFS-e — mês da autorização)
  if (registered.eventXml) {
    await saveXmlSafe(deps, actor, identity.cnpj, cancelEventFileName(tx.accessKey!), registered.eventXml, utcDate(tx.dhProc), tx.environment, 'XML do evento de cancelamento')
  }

  // (5) o fisco cancelou (irreversível): a VOZ C. O C local é do setes-api, que o app chama em seguida.
  const dhC = toDbDateTime(registered.dhEvento ?? dhEvento)
  const out = await withInvoiceTx(deps, 'voz C do fisco', actor, invoiceId, conn =>
    recordCancelVoice(conn, institutionId, userId, invoiceId, tx.attempt, 'P', dhC, signed.xMotivo, '101101'))   // D-F68: o pedido é NOSSO (e101101)
  logger.info('NFS-e cancelada no fisco', { institutionId, invoiceId, attempt: tx.attempt, accessKey: tx.accessKey })
  return { invoiceId, attempt: tx.attempt, atAuthority: true, transmissionEvent: out.event, warnings, nextStep: 'apply-local-cancel' }
}

// ---------------------------------------------------------------------------
// E. Consulta ativa — uma passada por estabelecimento (ALUGUEL na linha do emissor, não Map em memória)
// ---------------------------------------------------------------------------

export interface RefreshRunReport {
  checked: number
  changed: number
  errors: { invoiceId: number; code: string | null; message: string }[]
  stoppedEarly: boolean
  /** Outra passada do mesmo estabelecimento estava em curso (qualquer instância) — esta não rodou. */
  skipped: boolean
  /** D-F38: teto de idade (dias) das autorizadas nesta passada e de onde veio (prazo do município × padrão). */
  authorizedMaxDays?: number
  ceilingSource?: 'municipio' | 'padrao'
}

/** Quanto a passada (e o cancelamento) esperam pelo prazo do município antes de seguir sem ele (bulkhead — gates da Rodada 4). */
export const CEILING_LOOKUP_TIMEOUT_MS = 3_000
/** Prazo de cancelamento plausível (dias); fora disso a leitura [INCERTO] do convênio é descartada (gate R4: 20261231). */
const MAX_PLAUSIBLE_CANCEL_DAYS = 3650

type Ceiling = { days: number; source: 'municipio' | 'padrao' }
const ceilingCache = new Map<number, { at: number; value: Ceiling | null; pending?: Promise<Ceiling>; pendingAt?: number }>()

/**
 * D-F38: prazo de cancelamento do município do EMITENTE (PAM) para o teto das autorizadas no rodízio. Dado de
 * MANUTENÇÃO — fora do caminho crítico (gates da Rodada 4): cache por institution (o A1 não é decifrado a cada passada),
 * UMA consulta por vez (quem chega espera a mesma), espera de no máximo CEILING_LOOKUP_TIMEOUT_MS, valor implausível
 * descartado e o teto NUNCA menor que o padrão (60 — Curitiba) nem menor que o último prazo conhecido por causa de uma
 * falha: uma leitura errada ou ausente do convênio só pode ALARGAR a revisita (assunção A13).
 */
async function cancelDaysOf(deps: NfseDeps, actor: Actor): Promise<Ceiling> {
  const inst = actor.institutionId
  const fallback: Ceiling = { days: DEFAULT_CANCEL_DAYS, source: 'padrao' }
  const hit = ceilingCache.get(inst)
  if (hit?.value && hit.at > 0 && Date.now() - hit.at < (hit.value.source === 'municipio' ? TERMS_TTL_MS : TERMS_FAIL_TTL_MS)) return hit.value
  let pending = hit?.pending && Date.now() - (hit.pendingAt ?? 0) < PENDING_MAX_AGE_MS ? hit.pending : undefined
  if (!pending) {
    pending = (async (): Promise<Ceiling> => {
      const opened = await openIssuer(estDeps(deps), inst, SERVICE_MODEL, { schemaName: actor.schemaName })
      const { identity } = await buildEmitter(deps.pool, actor.schemaName, inst)
      const terms = await municipalTermsCached(deps.adapter, ctxFor(opened, opened.issuer.environment), identity.cMunEmi)
      const days = Number(terms?.cancelDays)
      if (!Number.isInteger(days) || days < 1 || days > MAX_PLAUSIBLE_CANCEL_DAYS) return fallback
      return { days: Math.max(days, DEFAULT_CANCEL_DAYS), source: 'municipio' }
    })().catch(() => fallback).then(fresh => {
      const known = ceilingCache.get(inst)?.value ?? null
      // falha/implausível nunca encolhe o último prazo conhecido do município (vale +10 min)
      const value = fresh.source === 'padrao' && known?.source === 'municipio' ? known : fresh
      const at = value === known ? Date.now() - TERMS_TTL_MS + TERMS_FAIL_TTL_MS : Date.now()
      ceilingCache.set(inst, { at, value })
      return value
    })
    ceilingCache.set(inst, { at: hit?.at ?? 0, value: hit?.value ?? null, pending, pendingAt: Date.now() })
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<Ceiling>(resolve => { timer = setTimeout(() => resolve(hit?.value ?? fallback), CEILING_LOOKUP_TIMEOUT_MS) })
  try { return await Promise.race([pending, timeout]) } finally { if (timer) clearTimeout(timer) }
}

const stopsTheRun = (err: unknown): boolean => err instanceof HttpError && !!err.code && EMITTER_FAILURE_CODES.has(err.code)

const isPersistentRefreshFailure = (err: unknown): boolean =>
  err instanceof HttpError && !stopsTheRun(err) && err.code !== ErrorCodes.RESOURCE_BUSY
  && !isLockWaitTimeout(err) && !isDeadlock(err) && err.statusCode !== 503

/**
 * Comando do ALUGUEL (sessão 2026-10-04 — 1213 cru na passada concorrente com PUT da habilitação; D-F41 espera curta):
 * UM UPDATE em AUTOCOMMIT pela peça `runShortCommand` do núcleo — espera a linha no máximo poucos segundos, deadlock
 * reexecuta 1× com aviso, o que sobra é 409 RESOURCE_BUSY (também para quem chama a peça direto).
 */
const leaseCommand = <T>(deps: NfseDeps, actor: Actor, label: string, op: (q: Queryable) => Promise<T>): Promise<T> =>
  runShortCommand(deps.pool, `aluguel do rodízio (${label})`, { institutionId: actor.institutionId }, op)
const isBusy = (err: unknown) => err instanceof HttpError && err.code === ErrorCodes.RESOURCE_BUSY

/**
 * Uma passada da consulta ativa. Gates da F1: o ALUGUEL é um UPDATE atômico na linha do emissor SE (nenhuma
 * conexão retida — a trava nomeada antiga segurava uma conexão e pedia outra: pool cheio = serviço travado);
 * as candidatas já vêm filtradas pela VIDA vigente no SQL, antes do LIMIT (o filtro em JS depois do LIMIT
 * prendia linhas no topo e o rodízio parava em silêncio).
 * [interfaces] (D-F46): ramos em que quem pede pode agir (contratados + privilégio — `passScope`); [liveOnlyInterfaces]
 * (D-F47): ramos cortados, só as tentativas JÁ VIVAS. A rota HTTP SEMPRE passa os dois — o filtro vai no SQL das
 * candidatas, antes do LIMIT. Ausentes = sem filtro (só chamada interna).
 */
export async function refreshOpenServiceTransmissions(
  deps: NfseDeps, actor: Actor,
  opts: { minMinutes?: number; limit?: number; budgetMs?: number; interfaces?: readonly string[]; liveOnlyInterfaces?: readonly string[] } = {},
): Promise<RefreshRunReport> {
  const report: RefreshRunReport = { checked: 0, changed: 0, errors: [], stoppedEarly: false, skipped: false }
  let lease = await leaseCommand(deps, actor, 'tomar', q => acquireRefreshLease(q, actor.institutionId, SERVICE_MODEL, REFRESH_LEASE_SECONDS))
  if (!lease) {
    // sem aluguel: dizer "outra passada em curso" só quando for verdade (gates R2/R4). D-F39 PRIMEIRO, pelo predicado
    // COMPLETO (gates do delta de 2026-10-04 — F1/F2: réplica EXCLUÍDA e lacuna (b) diziam "configure a habilitação")
    if (await emissionStillInErp(deps.pool, actor.schemaName, actor.institutionId)) {
      throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — a API fiscal só consulta até a virada',
        undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
    }
    if (!(await getIssuer(deps.pool, actor.institutionId, SERVICE_MODEL))) {
      throw new HttpError(409, 'Estabelecimento sem habilitação do emissor SE — nada a consultar no fisco',
        [{ field: 'model', message: 'Configure ambiente e série na aba Emissor fiscal' }], ErrorCodes.FISCAL_ISSUER_MISSING)
    }
    return { ...report, skipped: true }                                // duas telas/instâncias = UMA passada
  }
  try {
    const ceiling = await cancelDaysOf(deps, actor)                                                  // D-F38 (≤ 3 s)
    // o orçamento é das CANDIDATAS: conta depois do teto (gates R4 — o prazo do PAM não come a passada)
    const deadline = Date.now() + (opts.budgetMs ?? REFRESH_BUDGET_MS)
    const authorizedMaxDays = ceiling.days + REFRESH_AUTHORIZED_MARGIN_DAYS
    report.authorizedMaxDays = authorizedMaxDays
    report.ceilingSource = ceiling.source
    const list = await listRefreshCandidates(deps.pool, actor.schemaName, actor.institutionId,
      opts.minMinutes ?? REFRESH_MIN_MINUTES, IN_FLIGHT_MINUTES, opts.limit ?? REFRESH_MAX_PER_RUN,
      opts.interfaces ? { authorizedMaxDays, interfaces: opts.interfaces, liveOnlyInterfaces: opts.liveOnlyInterfaces ?? [] } : { authorizedMaxDays })
    for (const tx of list) {
      if (Date.now() >= deadline) { report.stoppedEarly = true; break }
      // o aluguel cobre UMA candidata: renovado antes de cada uma; perdido (outra passada o tomou) = esta para
      let renewed: string | null
      try {
        renewed = await leaseCommand(deps, actor, 'renovar', q => renewRefreshLease(q, actor.institutionId, SERVICE_MODEL, lease!, REFRESH_LEASE_SECONDS))
      } catch (err) {
        if (!isBusy(err)) throw err
        // a habilitação está sendo escrita (PUT do A1/habilitação, virada): a passada para aqui com o que já consultou
        logger.warn('Consulta ativa: habilitação ocupada por outra operação — a passada para aqui', { institutionId: actor.institutionId })
        report.stoppedEarly = true; break
      }
      if (!renewed) { report.stoppedEarly = true; break }
      lease = renewed
      try {
        report.checked += 1
        const r = await refreshServiceTransmission(deps, actor, tx.invoiceId, 'Q', { attempt: tx.attempt, fromRun: true })
        if (r.changed) report.changed += 1
      } catch (err) {
        const busy = err instanceof HttpError ? null : contentionToHttpError(err)
        if (err instanceof HttpError || busy) {
          // contenção (lock wait / deadlock esgotado — ex.: cancelamento LOCAL em curso no setes-api, D-F27) é a
          // regra da casa RESOURCE_BUSY, nunca "erro interno" (gate adversarial R3); a próxima passada tenta de novo
          const e = (busy ?? err) as HttpError
          if (busy) logger.warn('Consulta ativa: nota ocupada por outra operação — fica para a próxima passada', { institutionId: actor.institutionId, invoiceId: tx.invoiceId })
          report.errors.push({ invoiceId: tx.invoiceId, code: e.code ?? null, message: errMsg(e) })
        } else {
          // erro TÉCNICO (banco, adaptador): nunca cru no corpo — vai ao log com ref, o relatório leva só o ref (gate R2)
          const ref = newCrashRef()
          logger.error(`Consulta ativa: erro inesperado [ref ${ref}]`, { institutionId: actor.institutionId, invoiceId: tx.invoiceId,
            err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) })
          report.errors.push({ invoiceId: tx.invoiceId, code: ErrorCodes.INTERNAL, message: `Erro interno (ref ${ref})` })
        }
        if (stopsTheRun(err)) { report.stoppedEarly = true; break }
        // falha PERSISTENTE também conta como "tentamos olhar" — senão monopoliza o rodízio
        if (isPersistentRefreshFailure(err)) {
          logAmbiguousFiscal('rodizio', { institutionId: actor.institutionId, invoiceId: tx.invoiceId, attempt: tx.attempt, lastKind: tx.lastKind ?? null }, err)   // D-F87
          try { await touchQueriedAt(deps.pool, actor.institutionId, tx.invoiceId, tx.attempt) }
          catch (touchErr) { logger.warn('Consulta ativa: não marcou last_queried_at', { institutionId: actor.institutionId, invoiceId: tx.invoiceId, err: errMsg(touchErr) }) }
        }
      }
    }
    return report
  } finally {
    try {
      if (!(await leaseCommand(deps, actor, 'devolver', q => releaseRefreshLease(q, actor.institutionId, SERVICE_MODEL, lease!)))) {
        logger.warn('Consulta ativa: a passada passou do aluguel (outra já o tomou) — nada devolvido', { institutionId: actor.institutionId })
      }
    } catch (err) { logger.warn('Consulta ativa: aluguel não devolvido (vence sozinho)', { institutionId: actor.institutionId, err: errMsg(err) }) }
  }
}

// ---------------------------------------------------------------------------
// Leituras: tela "No fisco", XML, DANFSe, pendentes
// ---------------------------------------------------------------------------

export interface ServiceFiscalView {
  invoiceId:          number
  state:              ServiceFiscalState
  transmissions:      TransmissionRow[]
  events:             TransmissionEventRow[]
  /** Voz C do fisco com a nota ainda não cancelada no ERP (pendência DERIVADA — D-F28); nunca na substituição (D-F68). */
  localCancelPending: boolean
  /** D-F67/D-F76: NFS-e SUBSTITUÍDA no fisco (e105102) — chave da substituta lida do XML do evento (null = XML ausente). */
  substitution:       { substituteAccessKey: string | null } | null
  xmlAvailable:       boolean
  danfseAvailable:    boolean
}

export async function getServiceFiscalView(deps: NfseDeps, actor: Actor, invoiceId: number): Promise<ServiceFiscalView> {
  const { schemaName: s, institutionId } = actor
  const life = await erp.invoiceLife(deps.pool, s, institutionId, invoiceId)
  if (!life) throw new HttpError(404, `Nota ${invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
  const { transmissions, events } = await listLifeTransmissions(deps.pool, institutionId, invoiceId, life.lifeEvent)
  const current = currentOf(transmissions)          // D-N26 — a MESMA regra do núcleo (D-F33)
  const zone = await erp.institutionZone(deps.pool, s, institutionId)
  let xmlAvailable = false
  const withKey = [...transmissions].reverse().find(t => t.accessKey) ?? null
  if (withKey?.accessKey) {
    try {
      xmlAvailable = !!deps.storage.find(await emitterCnpj(deps.pool, institutionId), nfseFileName(withKey.accessKey), [withKey.dhProc, withKey.createdAt], withKey.environment, zone)
    } catch { xmlAvailable = false }
  }
  const txKeys = ['dhProc', 'createdAt', 'lastQueriedAt', 'lastDh', 'lastEventAt'] as const
  const evKeys = ['dh', 'createdAt'] as const
  return {
    invoiceId, state: fiscalStateOf(current),
    transmissions: transmissions.map(t => withZoneWall(t, txKeys, zone)),
    events: events.map(e => withZoneWall(e, evKeys, zone)),
    localCancelPending: localCancelPending(current, life.lastKind),
    substitution: isSubstitutionCancel(current) ? { substituteAccessKey: await substituteKeyOf(deps, institutionId, current!, zone) } : null,
    xmlAvailable, danfseAvailable: xmlAvailable,
  }
}

/**
 * D-F85: duas chaves de acesso da NFS-e são do MESMO emitente — chave 50 = cMun(7) + ambGer(1) + tpInsc(1) + inscrição(14) +
 * nNFSe(13) + AAMM(4) + código(9) + DV(1) (Infra-IA/setes-api/integracoes/nfse-adn/README.md; provado nas chaves 704–706).
 */
function sameIssuerKey(a: string, b: string): boolean {
  return a.length === 50 && b.length === 50 && a.slice(8, 23) === b.slice(8, 23)
}

/** D-F76: chave da SUBSTITUTA no XML do evento arquivado — só exibição; XML ausente/ilegível = null (a tela diz "indisponível"). */
async function substituteKeyOf(deps: NfseDeps, institutionId: number, tx: TransmissionRow, zone: string): Promise<string | null> {
  if (!tx.accessKey) return null
  try {
    const file = deps.storage.find(await emitterCnpj(deps.pool, institutionId), cancelEventFileName(tx.accessKey), [tx.dhProc, tx.createdAt], tx.environment, zone)
    if (!file) return null
    const key = parseEventXml(fs.readFileSync(file, 'utf8')).substituteKey
    // R13-04 do gate adversarial: a própria chave não é a substituta. D-F85 (= Q-F91, Valdo 2026-10-10): a substituta é do MESMO
    // emitente — tipo de inscrição + inscrição embutidos na chave (posições 9–23 da chave de 50) iguais aos da substituída
    return key && /^[0-9A-Z]{50}$/.test(key) && key !== tx.accessKey && sameIssuerKey(key, tx.accessKey!) ? key : null
  } catch { return null }
}

/** XML da NFS-e autorizada (ou cancelada — o documento existiu); 404 se não há. */
export async function readNfseXml(deps: NfseDeps, actor: Actor, invoiceId: number): Promise<{ accessKey: string; xml: string; cancelled: boolean }> {
  const { schemaName: s, institutionId } = actor
  const life = await erp.invoiceLife(deps.pool, s, institutionId, invoiceId)
  const { transmissions } = await listLifeTransmissions(deps.pool, institutionId, invoiceId, life?.lifeEvent ?? null)
  const withKey = [...transmissions].reverse().find(t => t.accessKey) ?? null
  if (!withKey?.accessKey) throw new HttpError(404, `Nota ${invoiceId} sem NFS-e autorizada no fisco`, undefined, ErrorCodes.FISCAL_NFSE_NOT_FOUND)
  const zone = life ? await erp.institutionZone(deps.pool, s, institutionId) : DEFAULT_TIME_ZONE
  const file = deps.storage.find(await emitterCnpj(deps.pool, institutionId), nfseFileName(withKey.accessKey), [withKey.dhProc, withKey.createdAt], withKey.environment, zone)
  if (!file) throw new HttpError(404, `XML da NFS-e ${withKey.accessKey} não está no arquivo fiscal — consulte a nota para regravar`, undefined, ErrorCodes.FISCAL_NFSE_NOT_FOUND)
  // A8: cancelada = a voz vigente de quem DETÉM a chave é C (o arquivo não sabe do cancelamento)
  return { accessKey: withKey.accessKey, xml: deps.storage.read(file), cancelled: fiscalStateOf(withKey) === 'cancelled' }
}

/** Pendentes do lote, PAGINADOS (envelope da casa); [interfaces] = ramos visíveis a quem pede (null = todos). */
export async function listPending(deps: NfseDeps, actor: Actor, page: { page: number; pageSize: number }, interfaces: string[] | null) {
  const { rows, total } = await listPendingServiceInvoices(deps.pool, actor.schemaName, actor.institutionId, deps.fiscalDb, page, interfaces)
  return { data: rows, page: page.page, pageSize: page.pageSize, total }
}
