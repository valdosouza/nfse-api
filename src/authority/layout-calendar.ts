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
 *
 * D-CJ7 (frente do CNPJ alfanumérico, onda 1 — 2026-10-16; parecer do guardião §4.5): a linha identifica o LEIAUTE — o PACOTE XSD
 * publicado (`schema`) —, não só a versão: produção restrita e produção têm a MESMA 1.01 com gramáticas DIFERENTES (o XSD de H aceita
 * CNPJ com letra, o de P não). O que cada pacote aceita é FATO lido do XSD arquivado (`LAYOUT_SCHEMAS`), nunca presumido; quando o XSD de
 * produção mudar, entra uma LINHA nova de P por deploy (onda 2 da frente) — nunca uma flag "aceita alfanumérico".
 */

export type LayoutDocument = 'DPS' | 'EVENT'

export interface LayoutLine {
  readonly document:    LayoutDocument
  readonly environment: AuthorityEnvironment
  /** Instante UTC a partir do qual a autoridade aceita a versão ('YYYY-MM-DDTHH:mm:ssZ'). */
  readonly validFrom:   string
  readonly version:     string
  /** O pacote XSD publicado (chave de `LAYOUT_SCHEMAS`) — a identidade do leiaute. */
  readonly schema:      string
}

/** Fatos de um pacote XSD publicado, lidos do arquivo arquivado (a fonte vai junto). */
export interface LayoutSchemaFacts {
  /** `TSCNPJ` (e a inscrição do Id do DPS/da NFS-e/do pedido de evento) admite letra? */
  readonly cnpjAlphanumeric: boolean
  readonly source:           string
}

export const LAYOUT_SCHEMAS: Readonly<Record<string, LayoutSchemaFacts>> = Object.freeze({
  'NFSe-1.01-20260209': Object.freeze({
    cnpjAlphanumeric: false,
    source: 'Infra-IA/setes-api/integracoes/nfse-adn/xsd/Schemas/1.01 (PRODUÇÃO, 09/02/2026): TSCNPJ [0-9]{14}, TSIdDPS DPS[0-9]{42}',
  }),
  'NFSe-1.01-RTC-20260727': Object.freeze({
    cnpjAlphanumeric: true,
    source: 'Infra-IA/setes-api/integracoes/cnpj-alfanumerico/xsd-nfse-producao-restrita-v1.01-20260727 (PRODUÇÃO RESTRITA): TSCNPJ [0-9A-Z]{14}, '
      + 'TSIdDPS DPS[0-9]{7}(1[0-9]{14}|2[0-9A-Z]{14})[0-9]{20}',
  }),
})

/** 1.01 é a única versão desde o 1º envio deste adaptador (produção restrita 2026-09-28, produção 2026-09-29) — piso nomeado. */
const SINCE_FIRST_SEND = '2000-01-01T00:00:00Z'
/** Produção restrita com o XSD de 27/07/2026 (CNPJ alfanumérico): a página "Atualizações e Implantações" registra a implantação em
 *  10/08/2026 — 00:00 de Brasília (§2 do prompt da frente). Antes dela, o pacote de produção. */
const H_ALPHANUMERIC_FROM = '2026-08-10T03:00:00Z'

export const LAYOUT_CALENDAR: readonly LayoutLine[] = Object.freeze([
  { document: 'DPS',   environment: 'H', validFrom: SINCE_FIRST_SEND,    version: '1.01', schema: 'NFSe-1.01-20260209' },
  { document: 'DPS',   environment: 'H', validFrom: H_ALPHANUMERIC_FROM, version: '1.01', schema: 'NFSe-1.01-RTC-20260727' },
  { document: 'DPS',   environment: 'P', validFrom: SINCE_FIRST_SEND,    version: '1.01', schema: 'NFSe-1.01-20260209' },
  { document: 'EVENT', environment: 'H', validFrom: SINCE_FIRST_SEND,    version: '1.01', schema: 'NFSe-1.01-20260209' },
  { document: 'EVENT', environment: 'H', validFrom: H_ALPHANUMERIC_FROM, version: '1.01', schema: 'NFSe-1.01-RTC-20260727' },
  { document: 'EVENT', environment: 'P', validFrom: SINCE_FIRST_SEND,    version: '1.01', schema: 'NFSe-1.01-20260209' },
].map(l => Object.freeze(l as LayoutLine)))

/** A LINHA vigente para o documento no ambiente no INSTANTE dado (a de maior `validFrom` ≤ instante). Sem linha = falha alta. */
export function layoutLineAt(document: LayoutDocument, environment: AuthorityEnvironment, instant: Date): LayoutLine {
  const t = instant.getTime()
  if (!Number.isFinite(t)) throw new Error(`Instante inválido para o calendário de leiaute: ${instant}`)
  let best: LayoutLine | null = null
  for (const l of LAYOUT_CALENDAR) {
    if (l.document !== document || l.environment !== environment) continue
    const from = Date.parse(l.validFrom)
    if (from <= t && (!best || from > Date.parse(best.validFrom))) best = l
  }
  if (!best) throw new Error(`Sem leiaute de ${document} para o ambiente ${environment} em ${instant.toISOString()} (calendário do adaptador)`)
  return best
}

/** A versão vigente para o documento no ambiente no INSTANTE dado. */
export function layoutAt(document: LayoutDocument, environment: AuthorityEnvironment, instant: Date): string {
  return layoutLineAt(document, environment, instant).version
}

/** D-CJ7: o leiaute vigente aceita CNPJ com LETRA (no documento, no Id e na inscrição)? Pacote sem fatos = falha alta. */
export function cnpjAlphanumericAccepted(document: LayoutDocument, environment: AuthorityEnvironment, instant: Date): boolean {
  const line = layoutLineAt(document, environment, instant)
  const facts = LAYOUT_SCHEMAS[line.schema]
  if (!facts) throw new Error(`Leiaute ${line.schema} sem fatos registrados (LAYOUT_SCHEMAS) — calendário do adaptador inconsistente`)
  return facts.cnpjAlphanumeric
}
