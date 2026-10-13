import {
  PoolConnection, Queryable, TransmissionEventKind, TransmissionSource, TransmissionEnvironment,
  assertSchema, InvoiceRef, InvoiceScope, LIVE_VOICE_KINDS, AUTHORIZED_KINDS, AUTHORIZATION_PRESUPPOSED_KINDS, FINAL_TRANSMISSION_KINDS, sqlKindList,
  InvoiceTx, assertInvoiceTx,
} from 'fiscal-api'
import { SERVICE_VOICE_FAMILY } from './voice-family'

/**
 * SQL da FAMÍLIA NFS-e no `fiscal_api` (migration 001 da nfse-api — D-F30/D-F35): o DPS de cada vida,
 * as tentativas e a voz. Banco DEFAULT da conexão (tabelas sem qualificador). Do ERP, só a VIEW de política
 * `vw_invoice_life` (D-F32) e só em leitura NÃO travante (seleção do rodízio); nos caminhos que decidem a
 * vida chega por parâmetro (da trava da nota), para nenhum `FOR UPDATE` daqui travar linha do ERP (D-F31).
 * Sob a TRAVA DA NOTA todo escritor das tabelas da família já está serializado: as leituras daqui são
 * NÃO travantes (gate socrático M-4: `FOR UPDATE` redundante gerava gap lock e deadlock entre notas vizinhas).
 * Molde: `transmission.repository.ts` do setes-api (Onda 3) — mesmas regras D-N26/D-N27/D-I20.
 * NE-1a parte 2 (D-NE12/D-NE59): a nota chega INTEIRA (`InvoiceRef` — o terminal por PARÂMETRO, nunca literal no SQL); as leituras em
 * lote recebem o ESCOPO (estabelecimento + terminal). As três peças da VOZ (escritor e leitores de idempotência) são as GENÉRICAS do núcleo
 * ligadas ao descritor da família (`./voice-family` — D-F108/D-NE74): o escritor recebe o `InvoiceTx` (sob a trava, na nota travada).
 */

type Q = Queryable

export interface TransmissionRow {
  institutionId:  number
  invoiceId:      number
  attempt:        number
  lifeEvent:      number
  environment:    TransmissionEnvironment
  serie:          string | null
  dpsNumber:      number | null
  dpsId:          string | null
  accessKey:      string | null
  /** D-NE56 (NE-1a): o fisco REGISTROU a NFS-e desta tentativa — a MESMA expressão da view 004 (na NFS-e a chave vem do fisco). */
  authorityRecorded: boolean
  nfseNumber:     string | null
  dhProc:         string | null
  createdAt:      string | null
  /** Idade da reserva em minutos, NO BANCO (MEDIUM-2: nunca Date.now() contra string do MySQL). */
  ageMinutes:     number | null
  lastQueriedAt:  string | null
  /** D-F90: último E2404 explícito a uma consulta desta tentativa — a PROVA da reconferência (o veredito da D-F109 a lê; nunca opcional — R20-02). */
  nfseNotGeneratedAt: string | null
  lastEvent:      number | null
  lastKind:       TransmissionEventKind | null
  lastCode:       string | null
  lastMessage:    string | null
  lastSource:     TransmissionSource | null
  lastDh:         string | null
  lastEventAt:    string | null
  /** Idade do último evento em minutos, NO BANCO (D-N28: carência do K antes de virar N). */
  lastEventAgeMinutes: number | null
}

export interface TransmissionEventRow {
  attempt:       number
  event:         number
  kind:          TransmissionEventKind
  authorityCode: string | null
  message:       string | null
  dh:            string | null
  source:        TransmissionSource
  userId:        number | null
  createdAt:     string | null
}

export interface LifeDps {
  lifeEvent: number
  serie:     string
  dpsNumber: number
  dpsId:     string
}

/**
 * D-NE56 (NE-1a): definição do REGISTRO pelo fisco na família de serviço — a MESMA expressão que a view 004 publica como
 * `authority_recorded` (teste confere o texto das duas). A família é a dona dela (D-F35); o núcleo só lê o fato. Colação FIXA
 * (binária): literal sem colação compara mal entre conexões de colações diferentes (erro 1267 — ver a 004).
 */
export const SERVICE_AUTHORITY_RECORDED_SQL = "IF(t.`access_key` IS NULL, 'N', 'S') COLLATE utf8mb4_bin"

const TX_SELECT = `
  SELECT t.tb_institution_id AS institutionId, t.tb_invoice_id AS invoiceId, t.attempt, t.life_event AS lifeEvent,
         t.environment, d.serie, d.dps_number AS dpsNumber, d.dps_id AS dpsId,
         t.access_key AS accessKey, ${SERVICE_AUTHORITY_RECORDED_SQL} AS authorityRecorded, t.nfse_number AS nfseNumber,
         DATE_FORMAT(t.dh_proc, '%Y-%m-%d %H:%i:%s') AS dhProc,
         DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
         TIMESTAMPDIFF(MINUTE, t.created_at, NOW()) AS ageMinutes,
         DATE_FORMAT(t.last_queried_at, '%Y-%m-%d %H:%i:%s') AS lastQueriedAt,
         DATE_FORMAT(t.nfse_not_generated_at, '%Y-%m-%d %H:%i:%s') AS nfseNotGeneratedAt,
         le.event AS lastEvent, le.kind AS lastKind, le.authority_code AS lastCode, le.message AS lastMessage, le.source AS lastSource,
         DATE_FORMAT(le.dh, '%Y-%m-%d %H:%i:%s') AS lastDh,
         DATE_FORMAT(le.created_at, '%Y-%m-%d %H:%i:%s') AS lastEventAt,
         TIMESTAMPDIFF(MINUTE, le.created_at, NOW()) AS lastEventAgeMinutes
    FROM tb_invoice_service_transmission t
    JOIN tb_invoice_service_dps d
      ON d.tb_institution_id = t.tb_institution_id AND d.tb_invoice_id = t.tb_invoice_id
     AND d.terminal = t.terminal AND d.life_event = t.life_event
    LEFT JOIN tb_invoice_service_transmission_event le
      ON le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id
     AND le.terminal = t.terminal AND le.attempt = t.attempt AND le.deleted = 'N'
     AND le.event = (SELECT MAX(x.event) FROM tb_invoice_service_transmission_event x
                      WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                        AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')`

function n(v: unknown): number | null { return v === null || v === undefined ? null : Number(v) }

/**
 * A linha de tentativa é INCOERENTE (registro ⇔ chave; D-F136 A/N ⇒ registro; D-F154 C/K ⇒ registro) — dado torto, não projeção torta.
 * Tipada para o rodízio pular SÓ ela (D-F164); erro ESTRUTURAL (SELECT sem a definição da família) relança — senão uma regressão do
 * `TX_SELECT` faria o rodízio "pular" e carimbar TODAS as linhas (gate socrático da Rodada 6, R6-SOC-07).
 */
export class IncoherentTransmissionError extends Error {
  constructor(message: string) { super(message); this.name = 'IncoherentTransmissionError' }
}

/**
 * Linha interna da família (tabelas do `fiscal_api`). Gates da NE-1a parte 1 (NE1A-08 / D-NE68 (b)): ESTRITO como o mapa do núcleo — a
 * coluna do registro tem de vir ('S'/'N') e COERENTE com a chave (na NFS-e registro ⇔ chave, pela definição da view 004): linha sem a
 * coluna (SELECT novo que a esqueça) falha ALTO (`Error`); a incoerente falha com `IncoherentTransmissionError` — nunca vira "não
 * registrada" calada.
 */
export function mapTx(r: any): TransmissionRow {
  if (r.authorityRecorded !== 'S' && r.authorityRecorded !== 'N') {
    throw new Error(`Linha de tentativa sem authorityRecorded ('S'/'N') — SELECT sem a definição da família? (recebido: ${JSON.stringify(r.authorityRecorded)})`)
  }
  // gates da A1 da F2a: o ambiente decide registro fiscal e prova — fora de H/P falha ALTO (antes virava 'H' calado; o CHECK da 005 fecha o
  // banco, o mapa fecha a projeção — M4 dos gates da NE-1a); a PROVA (D-F90) tem de vir no SELECT (R20-02: projeção que a esquece não pode
  // virar "sem E2404" calado — laço "reconfira")
  if (r.environment !== 'P' && r.environment !== 'H') {
    throw new Error(`Linha de tentativa sem environment ('P'/'H') — projeção torta? (recebido: ${JSON.stringify(r.environment)})`)
  }
  if (!('nfseNotGeneratedAt' in r)) throw new Error('Linha de tentativa sem nfseNotGeneratedAt — SELECT sem a prova da reconferência (D-F90)?')
  if ((r.authorityRecorded === 'S') !== (r.accessKey != null)) {
    throw new IncoherentTransmissionError(`Linha de tentativa INCOERENTE: authorityRecorded=${r.authorityRecorded} com chave ${r.accessKey == null ? 'ausente' : 'presente'} (NFS-e: registro ⇔ chave)`)
  }
  // D-F136 também AQUI (gate socrático do delta da Rodada 4 — F2AR4-SOC-06): o mesmo invariante do mapa comum do núcleo — voz A/N ⇒
  // registro. Antes a mesma linha torta dava 503 no setes-api e `state: authorized` + `currentAttempt` na nfse-api, com a barreira de
  // nova tentativa livre. Dois leitores, uma resposta.
  if (AUTHORIZED_KINDS.has(r.lastKind ?? '') && r.authorityRecorded !== 'S') {
    throw new IncoherentTransmissionError(`Linha de tentativa INCOERENTE: voz ${r.lastKind} (autorizada) SEM registro — a família publica a autorizada sempre registrada (D-F136)`)
  }
  // D-F154 (= Q-F159 (a)): a voz que PRESSUPÕE a autorização (C cancelada, K cancelamento em voo) também exige registro — o mesmo do mapa
  // comum do núcleo (dois leitores, uma resposta)
  if (AUTHORIZATION_PRESUPPOSED_KINDS.has(r.lastKind ?? '') && r.authorityRecorded !== 'S') {
    throw new IncoherentTransmissionError(`Linha de tentativa INCOERENTE: voz ${r.lastKind} (pressupõe a autorização) SEM registro — só se cancela no fisco o que ele registrou (D-F154)`)
  }
  return {
    institutionId: Number(r.institutionId), invoiceId: Number(r.invoiceId), attempt: Number(r.attempt),
    lifeEvent: Number(r.lifeEvent), environment: r.environment,
    serie: r.serie ?? null, dpsNumber: n(r.dpsNumber), dpsId: r.dpsId ?? null,
    accessKey: r.accessKey ?? null, authorityRecorded: r.authorityRecorded === 'S',
    nfseNumber: r.nfseNumber ?? null, dhProc: r.dhProc ?? null, createdAt: r.createdAt ?? null,
    ageMinutes: n(r.ageMinutes), lastQueriedAt: r.lastQueriedAt ?? null, nfseNotGeneratedAt: r.nfseNotGeneratedAt ?? null,
    lastEvent: n(r.lastEvent), lastKind: r.lastKind ?? null, lastCode: r.lastCode ?? null, lastMessage: r.lastMessage ?? null,
    lastSource: r.lastSource ?? null, lastDh: r.lastDh ?? null, lastEventAt: r.lastEventAt ?? null,
    lastEventAgeMinutes: n(r.lastEventAgeMinutes),
  }
}

// ---------------------------------------------------------------------------
// DPS da VIDA (D-F30)
// ---------------------------------------------------------------------------

export async function getLifeDps(q: Q, ref: InvoiceRef, lifeEvent: number, forUpdate = false): Promise<LifeDps | null> {
  const [rows] = await q.query(
    `SELECT life_event AS lifeEvent, serie, dps_number AS dpsNumber, dps_id AS dpsId FROM tb_invoice_service_dps
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND life_event = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  const r = rows[0]
  return r ? { lifeEvent: Number(r.lifeEvent), serie: String(r.serie), dpsNumber: Number(r.dpsNumber), dpsId: String(r.dpsId) } : null
}

/** Write-once: o DPS da vida nasce UMA vez (série + nDPS + Id congelados). */
/** D-NE75: escrita da família sob a trava — recebe o `InvoiceTx` (a nota TRAVADA), nunca `(conn, ref)` soltos. */
export async function insertLifeDps(itx: InvoiceTx, dps: LifeDps, userId: number | null): Promise<void> {
  assertInvoiceTx(itx)
  const { conn, ref } = itx
  await conn.query(
    `INSERT INTO tb_invoice_service_dps
       (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [ref.institutionId, ref.invoiceId, ref.terminal, dps.lifeEvent, dps.serie, dps.dpsNumber, dps.dpsId, userId])
}

// ---------------------------------------------------------------------------
// Leituras das tentativas
// ---------------------------------------------------------------------------

/** Uma tentativa específica (a que CUNHOU o Id, por exemplo — MEDIUM-1). Sem filtro de vida. */
export async function getTransmission(q: Q, ref: InvoiceRef, attempt: number, forUpdate = false): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.attempt = ? AND t.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt])
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * A VIGENTE da vida (D-N26): quem DETÉM a chave; sem chave, a última. Leitor ÚNICO dos decisores da
 * nfse-api (gate do transmit, cancelamento, consulta) — mesma regra do `currentOf` do núcleo (D-F33).
 */
export async function latestTransmission(q: Q, ref: InvoiceRef, lifeEvent: number | null, forUpdate = false): Promise<TransmissionRow | null> {
  if (lifeEvent == null) return null
  const [rows] = await q.query(
    `${TX_SELECT}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.deleted = 'N' AND t.life_event = ?
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * A tentativa da vida que detém a chave deste Id, senão a mais antiga (R3-1/MEDIUM-1) — SEMPRE no MESMO
 * AMBIENTE (gate adversarial HIGH, 2026-10-04): o Id do DPS é o mesmo em H e em P, mas a NFS-e de cada
 * ambiente é OUTRO documento (outro host, outra chave); a chave de P nunca pousa numa tentativa de H.
 */
export async function findTransmissionByDpsId(
  q: Q, ref: InvoiceRef, lifeEvent: number, dpsId: string, environment: TransmissionEnvironment,
): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.deleted = 'N' AND t.life_event = ? AND d.dps_id = ?
        AND t.environment = ?
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt ASC LIMIT 1`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent, dpsId, environment])
  return rows[0] ? mapTx(rows[0]) : null
}

/** Tentativa (da nota) que JÁ detém esta chave do fisco — corrida resposta direta × consulta (gate socrático M-5). */
export async function findKeyHolder(q: Q, ref: InvoiceRef, accessKey: string): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.access_key = ? LIMIT 1`,
    [ref.institutionId, ref.invoiceId, ref.terminal, accessKey])
  return rows[0] ? mapTx(rows[0]) : null
}

/** Tentativas e vozes da VIDA [lifeEvent] (tela "No fisco", XML, DANFSe, reconfirmação). */
export async function listLifeTransmissions(q: Q, ref: InvoiceRef, lifeEvent: number | null): Promise<{ transmissions: TransmissionRow[]; events: TransmissionEventRow[] }> {
  if (lifeEvent == null) return { transmissions: [], events: [] }
  const [txs] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.deleted = 'N' AND t.life_event = ? ORDER BY t.attempt`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  const [events] = await q.query(
    `SELECT e.attempt, e.event, e.kind, e.authority_code AS authorityCode, e.message,
            DATE_FORMAT(e.dh, '%Y-%m-%d %H:%i:%s') AS dh, e.source, e.tb_user_id AS userId,
            DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM tb_invoice_service_transmission_event e
       JOIN tb_invoice_service_transmission t
         ON t.tb_institution_id = e.tb_institution_id AND t.tb_invoice_id = e.tb_invoice_id AND t.terminal = e.terminal AND t.attempt = e.attempt
      WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = ? AND e.deleted = 'N' AND t.deleted = 'N' AND t.life_event = ?
      ORDER BY e.attempt, e.event`,
    [ref.institutionId, ref.invoiceId, ref.terminal, lifeEvent])
  return {
    transmissions: (txs as any[]).map(mapTx),
    events: (events as any[]).map(e => ({
      attempt: Number(e.attempt), event: Number(e.event), kind: e.kind, authorityCode: e.authorityCode ?? null,
      message: e.message ?? null, dh: e.dh ?? null, source: e.source, userId: n(e.userId), createdAt: e.createdAt ?? null,
    })),
  }
}

// ---------------------------------------------------------------------------
// Escritas (sempre sob a trava da nota — quem chama já travou)
// ---------------------------------------------------------------------------

/** Reserva a tentativa N+1 da nota (numeração contínua, atravessa as vidas). */
/** D-NE75: a tentativa nasce sob a trava da nota — `InvoiceTx`. */
export async function insertTransmission(
  itx: InvoiceTx, lifeEvent: number, environment: TransmissionEnvironment, userId: number,
): Promise<number> {
  assertInvoiceTx(itx)
  const { conn, ref } = itx
  // sob a TRAVA DA NOTA (quem chama já travou): leitura não travante — sem gap lock no índice (M-4)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM tb_invoice_service_transmission
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal])
  const attempt = Number(mx[0].next)
  await conn.query(
    `INSERT INTO tb_invoice_service_transmission
       (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt, lifeEvent, environment, userId])
  return attempt
}

/** WRITE-ONCE (D-I6 espelhada): só preenche o que ainda é NULL — chave/número/dhProc do fisco. */
export async function fillAuthorityData(
  itx: InvoiceTx, attempt: number,
  data: { accessKey?: string | null; nfseNumber?: string | null; dhProc?: string | null },
): Promise<void> {
  // D-NE75 (gates da parte 2): a chave de acesso É o registro fiscal da D-NE56 (`authority_recorded`) que a F2a lê — escrita só na nota
  // TRAVADA (`InvoiceTx`), como a voz
  assertInvoiceTx(itx)
  const { conn, ref } = itx
  await conn.query(
    `UPDATE tb_invoice_service_transmission
        SET access_key = COALESCE(access_key, ?), nfse_number = COALESCE(nfse_number, ?), dh_proc = COALESCE(dh_proc, ?), updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ?`,
    [data.accessKey?.slice(0, 50) ?? null, data.nfseNumber?.slice(0, 13) ?? null, data.dhProc ?? null, ref.institutionId, ref.invoiceId, ref.terminal, attempt])
}

// ---------------------------------------------------------------------------
// A VOZ da família: o escritor e os leitores de idempotência são os GENÉRICOS do núcleo (`defineVoiceFamily` — D-F108/D-NE74),
// ligados ao descritor de serviço (`./voice-family` — a tabela da voz e a lista de escrita moram lá). PROPRIEDADE-FUNÇÃO, nunca método:
// o tipo do `kind` é a lista da família; o funil do núcleo a confere em execução; o escritor EXIGE o `InvoiceTx` (sob a trava da nota).
// ---------------------------------------------------------------------------

export { SERVICE_VOICE_WRITE_KINDS, SERVICE_VOICE_FAMILY } from './voice-family'
export type { ServiceVoiceWriteKind, TransmissionEventInput } from './voice-family'

/** Append-only; nº do evento = MAX+1 sob a trava da nota — recebe o `InvoiceTx` do `withInvoiceTx` (D-NE74). */
export const insertTransmissionEvent = SERVICE_VOICE_FAMILY.insertTransmissionEvent
/** Já existe esta fala (kind, dh)? Casa também a forma ANTIGA (parede de Brasília) até o corte (Q-TZ3). */
export const hasTransmissionEvent = SERVICE_VOICE_FAMILY.hasTransmissionEvent
/** Última fala de um KIND nesta tentativa (HIGH-3a: um C por tentativa, qualquer dh). */
export const findTransmissionEventByKind = SERVICE_VOICE_FAMILY.findTransmissionEventByKind

/** "Nós olhamos o fisco" (com ou sem novidade) — só o throttle do rodízio; NUNCA prova (D-F90). */
export async function touchQueriedAt(q: Q, ref: InvoiceRef, attempt: number): Promise<void> {
  await q.query(
    `UPDATE tb_invoice_service_transmission SET last_queried_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt])
}

/**
 * D-F90 (= Q-F96 (c), Valdo 2026-10-11 — parecer do guardião): o fisco respondeu E2404 ("nenhuma NFS-e para este Id de DPS")
 * a uma pergunta desta tentativa — a PROVA da reconfirmação (D-F29). Só pousa se a última voz da tentativa ainda é a que a
 * pergunta VIU (`seenLastEvent`, null = sem voz): resposta velha nunca prova (gate r10 — outro escritor gravou o F depois do GET).
 * Relógio NOSSO (`NOW()`, o mesmo do `created_at` da voz). Comando único, sem trava longa.
 */
export async function recordNfseNotGenerated(
  q: Q, ref: InvoiceRef, attempt: number, seenLastEvent: number | null,
): Promise<boolean> {
  const [r]: any = await q.query(
    `UPDATE tb_invoice_service_transmission t
        SET t.nfse_not_generated_at = NOW()
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = ? AND t.attempt = ?
        AND (SELECT COALESCE(MAX(e.event), 0) FROM tb_invoice_service_transmission_event e
              WHERE e.tb_institution_id = t.tb_institution_id AND e.tb_invoice_id = t.tb_invoice_id
                AND e.terminal = t.terminal AND e.attempt = t.attempt AND e.deleted = 'N') = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal, attempt, seenLastEvent ?? 0])
  return Number(r?.affectedRows ?? 0) > 0
}

/** D-N21: autorizadas revisitadas a cada 24 h (o fisco pode ter cancelado sem nós). */
export const REFRESH_AUTHORIZED_HOURS = 24
/**
 * D-F52 (= Q-F61 (a), Valdo 2026-10-04): o F "sem resposta" gravado por CONSULTA (D-F51) volta ao rodízio UMA vez, depois de
 * 24 h — o ADN pode gerar a NFS-e com atraso de propagação e a voz F mentiria. "Uma vez" = `last_queried_at` anterior ao F +
 * 24 h (a revisita carimba depois disso); só a ÚLTIMA tentativa da vida, sem chave, dentro do teto da D-F38. Achou → A.
 */
export const F_REVISIT_HOURS = 24
/** D-F38: teto de idade das autorizadas no rodízio quando não se sabe o prazo do município (60 = Curitiba) + margem. */
export const DEFAULT_CANCEL_DAYS = 60
export const REFRESH_AUTHORIZED_MARGIN_DAYS = 30
/** Cinto (gates R4): o teto chega ao SQL sempre dentro do domínio — fora dele o DATE_SUB vira NULL e TODAS as autorizadas somem. */
const clampDays = (d: number) => (Number.isFinite(d) ? Math.min(Math.max(Math.trunc(d), 1), 3650 + REFRESH_AUTHORIZED_MARGIN_DAYS) : DEFAULT_CANCEL_DAYS + REFRESH_AUTHORIZED_MARGIN_DAYS)

/**
 * CANDIDATAS da consulta ativa — o filtro inteiro no SQL, ANTES do LIMIT (gate socrático HIGH-1: filtrar
 * em JS depois do LIMIT deixava linhas descartadas presas no topo e o rodízio parava em silêncio):
 *  - só tentativas da VIDA vigente (view `vw_invoice_life` do ERP — D-N27/D-F32, leitura não travante);
 *  - vivas (em voo/S/K) a cada [minMinutes] — a em voo SEM voz só depois de [inFlightMinutes] de idade (o
 *    POST dela pode estar esperando o fisco agora — gate socrático M-5);
 *  - autorizadas (A/N) a cada 24 h, salvo nota já cancelada no ERP (Q-CA5b) e só até o TETO de idade (D-F38: prazo de
 *    cancelamento do município + margem, contado do dh_proc — depois disso o fisco não aceita mais cancelamento pelo
 *    emitente e a voz não muda; a consulta manual continua possível);
 *  - a voz C NÃO volta ao rodízio (o efeito local é do setes-api — D-F28);
 *  - F "sem resposta" por consulta: UMA revisita 24 h depois (D-F52 — `F_REVISIT_HOURS`), no grupo das autorizadas;
 *  - PRIORIDADE: vivas antes das autorizadas; dentro de cada grupo, a menos olhada primeiro;
 *  - [interfaces] (D-F46): só notas cujo RAMO (view de política `vw_order_interface` — D-F32; sem linha = 'orders',
 *    o mesmo default de `erp.orderInterface`) está na lista de quem pede; [liveOnlyInterfaces] (D-F47): ramos cortados
 *    entram SÓ com tentativa viva (sem voz/S/K) — a autorizada (A/N) de ramo cortado não volta ao rodízio. As duas
 *    vazias = nenhuma candidata (nunca "sem filtro").
 */
export async function listRefreshCandidates(
  q: Q, schemaName: string, scope: InvoiceScope, minMinutes: number, inFlightMinutes: number, limit: number,
  opts: { authorizedHours?: number; authorizedMaxDays?: number; interfaces?: readonly string[]; liveOnlyInterfaces?: readonly string[] } = {},
  onIncoherent?: (row: { invoiceId: number; attempt: number }, err: Error) => void,
): Promise<TransmissionRow[]> {
  const s = assertSchema(schemaName)
  const interfaces = opts.interfaces
  const liveOnly = interfaces ? (opts.liveOnlyInterfaces ?? []) : []
  if (interfaces && interfaces.length === 0 && liveOnly.length === 0) return []
  const branch = `COALESCE(oi.interface_key, 'orders')`
  // D-NE69 (= Q-NE69 (a), gates da NE-1a parte 1): as CLASSES vêm da `KIND_CLASS` (vivas com voz S/K/P · autorizadas A/N · finais); as
  // letras de UM fato seguem pelo nome — F da revisita (D-F52) e o C do ERP (`l.last_kind`, a VIDA da nota, não a voz)
  const LIVE = sqlKindList(LIVE_VOICE_KINDS), AUTHORIZED = sqlKindList(AUTHORIZED_KINDS), FINAL = sqlKindList(FINAL_TRANSMISSION_KINDS)
  const branchFilter = !interfaces ? ''
    : `AND (${[
      ...(interfaces.length ? [`${branch} IN (?)`] : []),
      ...(liveOnly.length ? [`(${branch} IN (?) AND (le.kind IS NULL OR le.kind IN (${LIVE})))`] : []),
    ].join(' OR ')})`
  const branchParams = !interfaces ? [] : [...(interfaces.length ? [[...interfaces]] : []), ...(liveOnly.length ? [[...liveOnly]] : [])]
  // D-F52: teto da revisita do F = o MESMO teto das autorizadas (D-F38); inteiro já no domínio (clampDays) — vai literal no SQL
  const revisitDays = clampDays(opts.authorizedMaxDays ?? DEFAULT_CANCEL_DAYS + REFRESH_AUTHORIZED_MARGIN_DAYS)
  const [rows] = await q.query(
    `${TX_SELECT}
      JOIN \`${s}\`.vw_invoice_life l
        ON l.tb_institution_id = t.tb_institution_id AND l.tb_invoice_id = t.tb_invoice_id AND l.terminal = t.terminal
       AND l.life_event = t.life_event
      ${interfaces ? `LEFT JOIN \`${s}\`.vw_order_interface oi
        ON oi.tb_institution_id = t.tb_institution_id AND oi.tb_order_id = t.tb_invoice_id AND oi.terminal = t.terminal` : ''}
      WHERE t.tb_institution_id = ? AND t.terminal = ? AND t.deleted = 'N'
        AND (
          (le.kind IS NULL AND t.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
          OR (le.kind IN (${LIVE})
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
          OR (le.kind IN (${AUTHORIZED}) AND COALESCE(l.last_kind, '-') <> 'C'
             AND COALESCE(t.dh_proc, t.created_at) >= DATE_SUB(NOW(), INTERVAL ? DAY)
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? HOUR)))
          OR (le.kind = 'F' AND le.source = 'Q' AND t.access_key IS NULL
             AND le.created_at <= DATE_SUB(NOW(), INTERVAL ${F_REVISIT_HOURS} HOUR)
             AND le.created_at >= DATE_SUB(NOW(), INTERVAL ${revisitDays} DAY)
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_ADD(le.created_at, INTERVAL ${F_REVISIT_HOURS} HOUR))
             AND NOT EXISTS (SELECT 1 FROM tb_invoice_service_transmission t2
                              WHERE t2.tb_institution_id = t.tb_institution_id AND t2.tb_invoice_id = t.tb_invoice_id
                                AND t2.terminal = t.terminal AND t2.life_event = t.life_event AND t2.attempt > t.attempt))
        )
        ${branchFilter}
      ORDER BY (le.kind IN (${FINAL})) ASC, (t.last_queried_at IS NULL) DESC, t.last_queried_at ASC, t.tb_invoice_id ASC
      LIMIT ?`,
    [scope.institutionId, scope.terminal, inFlightMinutes, minMinutes, minMinutes,
      clampDays(opts.authorizedMaxDays ?? DEFAULT_CANCEL_DAYS + REFRESH_AUTHORIZED_MARGIN_DAYS), opts.authorizedHours ?? REFRESH_AUTHORIZED_HOURS,
      ...branchParams, limit])
  // D-F164 (= Q-F172 (a), Valdo 2026-10-13 — gate adversarial da Rodada 5, R5-ADV-05): UMA linha incoerente (D-F136/D-F154 no `mapTx`)
  // não derruba a lista INTEIRA do rodízio — quem passa [onIncoherent] recebe a linha (para o alarme) e a lista segue com as coerentes.
  // Sem ele, falha alto como sempre (o leitor da NOTA nunca a engole — dois leitores, uma resposta).
  if (!onIncoherent) return (rows as any[]).map(mapTx)
  const out: TransmissionRow[] = []
  for (const r of rows as any[]) {
    try { out.push(mapTx(r)) } catch (err) {
      if (!(err instanceof IncoherentTransmissionError)) throw err                      // R6-SOC-07: projeção torta falha alto
      onIncoherent({ invoiceId: Number(r.invoiceId), attempt: Number(r.attempt) }, err)
    }
  }
  return out
}

// As tentativas VIVAS do emissor (guarda da habilitação e do A1) são contadas pelo EMITTER do núcleo pelas leituras PUBLICADAS de
// todas as famílias (`countLiveTransmissions` do fiscal-api — D-NE9, parte 2 da NE-1a); a família não conta mais as dela aqui.
