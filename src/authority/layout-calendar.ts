import type { AuthorityEnvironment } from './types'

/**
 * CALENDÁRIO DE LEIAUTE da NFS-e (fase IBS/CBS, IB-3 — D-IB13/D-IB81; absorve a D-NE31): a versão que a AUTORIDADE aceita por
 * DOCUMENTO × AMBIENTE × instante — fato do fisco, constante CONGELADA do adaptador. Uma linha nova (ex.: o XSD da NT 009 em produção
 * restrita antes de produção) entra por DEPLOY ANTES do `validFrom` dela — nunca por variável de ambiente, flag ou chave
 * ("Ativar Reforma" — maquete nº 2 do §3.1).
 *
 * - Consultado pelo INSTANTE da transmissão (o `dhEmi`/`dhEvento` real) e pelo ambiente CONGELADO da tentativa — nunca pela competência
 *   (`dCompet`): leiaute ≠ obrigação (a obrigação é do ERP, por competência — `ibscbsObligationStart`, IB-2).
 * - NÃO decide o grupo IBS/CBS: no 1.01 o grupo é opcional e vai sempre que a declaração está no ramo (D-IB13).
 * - O pedido de EVENTO tem a linha dele (D-IB81) — hoje as duas versões coincidem; nunca uma "versão global".
 */

export type LayoutDocument = 'DPS' | 'EVENT'

export interface LayoutLine {
  readonly document:    LayoutDocument
  readonly environment: AuthorityEnvironment
  /** Instante UTC a partir do qual a autoridade aceita a versão ('YYYY-MM-DDTHH:mm:ssZ'). */
  readonly validFrom:   string
  readonly version:     string
}

/** 1.01 é a única versão desde o 1º envio deste adaptador (produção restrita 2026-09-28, produção 2026-09-29) — piso nomeado. */
const SINCE_FIRST_SEND = '2000-01-01T00:00:00Z'

export const LAYOUT_CALENDAR: readonly LayoutLine[] = Object.freeze([
  { document: 'DPS',   environment: 'H', validFrom: SINCE_FIRST_SEND, version: '1.01' },
  { document: 'DPS',   environment: 'P', validFrom: SINCE_FIRST_SEND, version: '1.01' },
  { document: 'EVENT', environment: 'H', validFrom: SINCE_FIRST_SEND, version: '1.01' },
  { document: 'EVENT', environment: 'P', validFrom: SINCE_FIRST_SEND, version: '1.01' },
].map(l => Object.freeze(l as LayoutLine)))

/** A versão vigente para o documento no ambiente no INSTANTE dado (a linha de maior `validFrom` ≤ instante). Sem linha = falha alta. */
export function layoutAt(document: LayoutDocument, environment: AuthorityEnvironment, instant: Date): string {
  const t = instant.getTime()
  if (!Number.isFinite(t)) throw new Error(`Instante inválido para o calendário de leiaute: ${instant}`)
  let best: LayoutLine | null = null
  for (const l of LAYOUT_CALENDAR) {
    if (l.document !== document || l.environment !== environment) continue
    const from = Date.parse(l.validFrom)
    if (from <= t && (!best || from > Date.parse(best.validFrom))) best = l
  }
  if (!best) throw new Error(`Sem leiaute de ${document} para o ambiente ${environment} em ${instant.toISOString()} (calendário do adaptador)`)
  return best.version
}
