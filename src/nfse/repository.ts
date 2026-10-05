import {
  PoolConnection, Queryable, TransmissionEventKind, TransmissionSource, TransmissionEnvironment,
  FINAL_TRANSMISSION_KINDS, legacyWallBeforeCutover, assertSchema,
} from 'fiscal-api'

/**
 * SQL da FAMÍLIA NFS-e no `fiscal_api` (migration 001 da nfse-api — D-F30/D-F35): o DPS de cada vida,
 * as tentativas e a voz. Banco DEFAULT da conexão (tabelas sem qualificador). Do ERP, só a VIEW de política
 * `vw_invoice_life` (D-F32) e só em leitura NÃO travante (seleção do rodízio); nos caminhos que decidem a
 * vida chega por parâmetro (da trava da nota), para nenhum `FOR UPDATE` daqui travar linha do ERP (D-F31).
 * Sob a TRAVA DA NOTA todo escritor das tabelas da família já está serializado: as leituras daqui são
 * NÃO travantes (gate socrático M-4: `FOR UPDATE` redundante gerava gap lock e deadlock entre notas vizinhas).
 * Molde: `transmission.repository.ts` do setes-api (Onda 3) — mesmas regras D-N26/D-N27/D-I20.
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
  nfseNumber:     string | null
  dhProc:         string | null
  createdAt:      string | null
  /** Idade da reserva em minutos, NO BANCO (MEDIUM-2: nunca Date.now() contra string do MySQL). */
  ageMinutes:     number | null
  lastQueriedAt:  string | null
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

const TX_SELECT = `
  SELECT t.tb_institution_id AS institutionId, t.tb_invoice_id AS invoiceId, t.attempt, t.life_event AS lifeEvent,
         t.environment, d.serie, d.dps_number AS dpsNumber, d.dps_id AS dpsId,
         t.access_key AS accessKey, t.nfse_number AS nfseNumber,
         DATE_FORMAT(t.dh_proc, '%Y-%m-%d %H:%i:%s') AS dhProc,
         DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
         TIMESTAMPDIFF(MINUTE, t.created_at, NOW()) AS ageMinutes,
         DATE_FORMAT(t.last_queried_at, '%Y-%m-%d %H:%i:%s') AS lastQueriedAt,
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

export function mapTx(r: any): TransmissionRow {
  return {
    institutionId: Number(r.institutionId), invoiceId: Number(r.invoiceId), attempt: Number(r.attempt),
    lifeEvent: Number(r.lifeEvent), environment: r.environment === 'P' ? 'P' : 'H',
    serie: r.serie ?? null, dpsNumber: n(r.dpsNumber), dpsId: r.dpsId ?? null,
    accessKey: r.accessKey ?? null, nfseNumber: r.nfseNumber ?? null, dhProc: r.dhProc ?? null, createdAt: r.createdAt ?? null,
    ageMinutes: n(r.ageMinutes), lastQueriedAt: r.lastQueriedAt ?? null,
    lastEvent: n(r.lastEvent), lastKind: r.lastKind ?? null, lastCode: r.lastCode ?? null, lastMessage: r.lastMessage ?? null,
    lastSource: r.lastSource ?? null, lastDh: r.lastDh ?? null, lastEventAt: r.lastEventAt ?? null,
    lastEventAgeMinutes: n(r.lastEventAgeMinutes),
  }
}

// ---------------------------------------------------------------------------
// DPS da VIDA (D-F30)
// ---------------------------------------------------------------------------

export async function getLifeDps(q: Q, institutionId: number, invoiceId: number, lifeEvent: number, forUpdate = false): Promise<LifeDps | null> {
  const [rows] = await q.query(
    `SELECT life_event AS lifeEvent, serie, dps_number AS dpsNumber, dps_id AS dpsId FROM tb_invoice_service_dps
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND life_event = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, lifeEvent])
  const r = rows[0]
  return r ? { lifeEvent: Number(r.lifeEvent), serie: String(r.serie), dpsNumber: Number(r.dpsNumber), dpsId: String(r.dpsId) } : null
}

/** Write-once: o DPS da vida nasce UMA vez (série + nDPS + Id congelados). */
export async function insertLifeDps(conn: PoolConnection, institutionId: number, invoiceId: number, dps: LifeDps, userId: number | null): Promise<void> {
  await conn.query(
    `INSERT INTO tb_invoice_service_dps
       (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, dps.lifeEvent, dps.serie, dps.dpsNumber, dps.dpsId, userId])
}

// ---------------------------------------------------------------------------
// Leituras das tentativas
// ---------------------------------------------------------------------------

/** Uma tentativa específica (a que CUNHOU o Id, por exemplo — MEDIUM-1). Sem filtro de vida. */
export async function getTransmission(q: Q, institutionId: number, invoiceId: number, attempt: number, forUpdate = false): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.attempt = ? AND t.deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, attempt])
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * A VIGENTE da vida (D-N26): quem DETÉM a chave; sem chave, a última. Leitor ÚNICO dos decisores da
 * nfse-api (gate do transmit, cancelamento, consulta) — mesma regra do `currentOf` do núcleo (D-F33).
 */
export async function latestTransmission(q: Q, institutionId: number, invoiceId: number, lifeEvent: number | null, forUpdate = false): Promise<TransmissionRow | null> {
  if (lifeEvent == null) return null
  const [rows] = await q.query(
    `${TX_SELECT}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N' AND t.life_event = ?
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, lifeEvent])
  return rows[0] ? mapTx(rows[0]) : null
}

/**
 * A tentativa da vida que detém a chave deste Id, senão a mais antiga (R3-1/MEDIUM-1) — SEMPRE no MESMO
 * AMBIENTE (gate adversarial HIGH, 2026-10-04): o Id do DPS é o mesmo em H e em P, mas a NFS-e de cada
 * ambiente é OUTRO documento (outro host, outra chave); a chave de P nunca pousa numa tentativa de H.
 */
export async function findTransmissionByDpsId(
  q: Q, institutionId: number, invoiceId: number, lifeEvent: number, dpsId: string, environment: TransmissionEnvironment,
): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT}
      WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N' AND t.life_event = ? AND d.dps_id = ?
        AND t.environment = ?
      ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt ASC LIMIT 1`,
    [institutionId, invoiceId, lifeEvent, dpsId, environment])
  return rows[0] ? mapTx(rows[0]) : null
}

/** Tentativa (da nota) que JÁ detém esta chave do fisco — corrida resposta direta × consulta (gate socrático M-5). */
export async function findKeyHolder(q: Q, institutionId: number, invoiceId: number, accessKey: string): Promise<TransmissionRow | null> {
  const [rows] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.access_key = ? LIMIT 1`,
    [institutionId, invoiceId, accessKey])
  return rows[0] ? mapTx(rows[0]) : null
}

/** Tentativas e vozes da VIDA [lifeEvent] (tela "No fisco", XML, DANFSe, reconfirmação). */
export async function listLifeTransmissions(q: Q, institutionId: number, invoiceId: number, lifeEvent: number | null): Promise<{ transmissions: TransmissionRow[]; events: TransmissionEventRow[] }> {
  if (lifeEvent == null) return { transmissions: [], events: [] }
  const [txs] = await q.query(
    `${TX_SELECT} WHERE t.tb_institution_id = ? AND t.tb_invoice_id = ? AND t.terminal = 0 AND t.deleted = 'N' AND t.life_event = ? ORDER BY t.attempt`,
    [institutionId, invoiceId, lifeEvent])
  const [events] = await q.query(
    `SELECT e.attempt, e.event, e.kind, e.authority_code AS authorityCode, e.message,
            DATE_FORMAT(e.dh, '%Y-%m-%d %H:%i:%s') AS dh, e.source, e.tb_user_id AS userId,
            DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM tb_invoice_service_transmission_event e
       JOIN tb_invoice_service_transmission t
         ON t.tb_institution_id = e.tb_institution_id AND t.tb_invoice_id = e.tb_invoice_id AND t.terminal = e.terminal AND t.attempt = e.attempt
      WHERE e.tb_institution_id = ? AND e.tb_invoice_id = ? AND e.terminal = 0 AND e.deleted = 'N' AND t.deleted = 'N' AND t.life_event = ?
      ORDER BY e.attempt, e.event`,
    [institutionId, invoiceId, lifeEvent])
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
export async function insertTransmission(
  conn: PoolConnection, institutionId: number, invoiceId: number, lifeEvent: number, environment: TransmissionEnvironment, userId: number,
): Promise<number> {
  // sob a TRAVA DA NOTA (quem chama já travou): leitura não travante — sem gap lock no índice (M-4)
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM tb_invoice_service_transmission
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0`,
    [institutionId, invoiceId])
  const attempt = Number(mx[0].next)
  await conn.query(
    `INSERT INTO tb_invoice_service_transmission
       (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, attempt, lifeEvent, environment, userId])
  return attempt
}

/** WRITE-ONCE (D-I6 espelhada): só preenche o que ainda é NULL — chave/número/dhProc do fisco. */
export async function fillAuthorityData(
  conn: PoolConnection, institutionId: number, invoiceId: number, attempt: number,
  data: { accessKey?: string | null; nfseNumber?: string | null; dhProc?: string | null },
): Promise<void> {
  await conn.query(
    `UPDATE tb_invoice_service_transmission
        SET access_key = COALESCE(access_key, ?), nfse_number = COALESCE(nfse_number, ?), dh_proc = COALESCE(dh_proc, ?), updated_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ?`,
    [data.accessKey?.slice(0, 50) ?? null, data.nfseNumber?.slice(0, 13) ?? null, data.dhProc ?? null, institutionId, invoiceId, attempt])
}

export interface TransmissionEventInput {
  kind:           TransmissionEventKind
  authorityCode?: string | null
  message?:       string | null
  dh?:            string | null
  source:         TransmissionSource
}

/** Append-only; nº do evento = MAX+1 sob a trava da nota. */
export async function insertTransmissionEvent(
  conn: PoolConnection, institutionId: number, invoiceId: number, attempt: number, userId: number | null, e: TransmissionEventInput,
): Promise<number> {
  const [mx] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(event), 0) + 1 AS next FROM tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ?`,
    [institutionId, invoiceId, attempt])
  const event = Number(mx[0].next)
  await conn.query(
    `INSERT INTO tb_invoice_service_transmission_event
       (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
    [institutionId, invoiceId, attempt, event, e.kind, e.authorityCode?.slice(0, 10) ?? null,
     e.message ? String(e.message).slice(0, 255) : null, e.dh ?? null, e.source, userId])
  return event
}

/** Já existe esta fala (kind, dh)? Casa também a forma ANTIGA (parede de Brasília) até o corte (Q-TZ3). */
export async function hasTransmissionEvent(
  q: Q, institutionId: number, invoiceId: number, attempt: number, kind: TransmissionEventKind, dh: string | null,
): Promise<boolean> {
  const [rows] = await q.query(
    `SELECT COUNT(*) AS n FROM tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND deleted = 'N'
        AND kind = ? AND ${dh === null ? 'dh IS NULL' : 'dh IN (?, ?)'}`,
    dh === null ? [institutionId, invoiceId, attempt, kind] : [institutionId, invoiceId, attempt, kind, dh, legacyWallBeforeCutover(dh) ?? dh])
  return Number(rows?.[0]?.n ?? 0) > 0
}

/** Última fala de um KIND nesta tentativa (HIGH-3a: um C por tentativa, qualquer dh). */
export async function findTransmissionEventByKind(
  q: Q, institutionId: number, invoiceId: number, attempt: number, kind: TransmissionEventKind, forUpdate = false,
): Promise<TransmissionEventRow | null> {
  const [rows] = await q.query(
    `SELECT attempt, event, kind, authority_code AS authorityCode, message, DATE_FORMAT(dh, '%Y-%m-%d %H:%i:%s') AS dh,
            source, tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
       FROM tb_invoice_service_transmission_event
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ? AND deleted = 'N' AND kind = ?
      ORDER BY event DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, invoiceId, attempt, kind])
  const r = rows[0]
  if (!r) return null
  return { ...r, attempt: Number(r.attempt), event: Number(r.event), userId: n(r.userId) } as TransmissionEventRow
}

/** "Nós olhamos o fisco" (com ou sem novidade) — rodízio e PROVA da reconfirmação (D-F29). */
export async function touchQueriedAt(q: Q, institutionId: number, invoiceId: number, attempt: number): Promise<void> {
  await q.query(
    `UPDATE tb_invoice_service_transmission SET last_queried_at = NOW()
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = 0 AND attempt = ?`,
    [institutionId, invoiceId, attempt])
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
  q: Q, schemaName: string, institutionId: number, minMinutes: number, inFlightMinutes: number, limit: number,
  opts: { authorizedHours?: number; authorizedMaxDays?: number; interfaces?: readonly string[]; liveOnlyInterfaces?: readonly string[] } = {},
): Promise<TransmissionRow[]> {
  const s = assertSchema(schemaName)
  const interfaces = opts.interfaces
  const liveOnly = interfaces ? (opts.liveOnlyInterfaces ?? []) : []
  if (interfaces && interfaces.length === 0 && liveOnly.length === 0) return []
  const branch = `COALESCE(oi.interface_key, 'orders')`
  const branchFilter = !interfaces ? ''
    : `AND (${[
      ...(interfaces.length ? [`${branch} IN (?)`] : []),
      ...(liveOnly.length ? [`(${branch} IN (?) AND (le.kind IS NULL OR le.kind IN ('S','K')))`] : []),
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
      WHERE t.tb_institution_id = ? AND t.terminal = 0 AND t.deleted = 'N'
        AND (
          (le.kind IS NULL AND t.created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
          OR (le.kind IN ('S','K')
             AND (t.last_queried_at IS NULL OR t.last_queried_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)))
          OR (le.kind IN ('A','N') AND COALESCE(l.last_kind, '-') <> 'C'
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
      ORDER BY (le.kind IN ('A','N','F')) ASC, (t.last_queried_at IS NULL) DESC, t.last_queried_at ASC, t.tb_invoice_id ASC
      LIMIT ?`,
    [institutionId, inFlightMinutes, minMinutes, minMinutes,
      clampDays(opts.authorizedMaxDays ?? DEFAULT_CANCEL_DAYS + REFRESH_AUTHORIZED_MARGIN_DAYS), opts.authorizedHours ?? REFRESH_AUTHORIZED_HOURS,
      ...branchParams, limit])
  return (rows as any[]).map(mapTx)
}

/** Tentativas VIVAS (sem voz ou última voz não final) do modelo SE — guarda do emissor (D-I26/D-I27 espelhadas). */
export async function countLiveTransmissions(q: Q, institutionId: number, environment?: TransmissionEnvironment): Promise<number> {
  const finals = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
  const [rows] = await q.query(
    `SELECT COUNT(*) AS n
       FROM tb_invoice_service_transmission t
       LEFT JOIN tb_invoice_service_transmission_event le
         ON le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id
        AND le.terminal = t.terminal AND le.attempt = t.attempt AND le.deleted = 'N'
        AND le.event = (SELECT MAX(x.event) FROM tb_invoice_service_transmission_event x
                         WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                           AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')
      WHERE t.tb_institution_id = ? AND t.deleted = 'N' AND (? IS NULL OR t.environment = ?)
        AND (le.kind IS NULL OR le.kind NOT IN (${finals}))`,
    [institutionId, environment ?? null, environment ?? null])
  return Number(rows?.[0]?.n ?? 0)
}
