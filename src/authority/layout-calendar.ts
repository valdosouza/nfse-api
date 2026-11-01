import type { AuthorityEnvironment } from './types'

/**
 * CALENDÁRIO DE LEIAUTE da NFS-e (fase IBS/CBS, IB-3 — D-IB13/D-IB81; absorve a D-NE31; evoluído pela D-IB110/D-IB111): o LEIAUTE que a
 * AUTORIDADE aceita por DOCUMENTO × AMBIENTE × instante — fato do fisco, constante CONGELADA do adaptador. Uma linha nova (ex.: o pacote da
 * produção restrita chegando à produção) entra por DEPLOY ANTES do `validFrom` dela — nunca por variável de ambiente, flag ou chave ("Ativar
 * Reforma" — maquete nº 2 do §3.1) e nunca pela voz do fisco (reenviar no outro leiaute ao receber E1235 é maquete — D-IB111).
 *
 * - Consultado pelo INSTANTE da transmissão (o `dhEmi`/`dhEvento` real) e pelo ambiente CONGELADO da tentativa — nunca pela competência
 *   (`dCompet`): leiaute ≠ obrigação (a obrigação é do ERP, por competência — `ibscbsObligationStart`, IB-2).
 * - NÃO decide o grupo IBS/CBS: o grupo vai sempre que a declaração está no ramo (D-IB13); o leiaute só decide a FORMA dele.
 * - O pedido de EVENTO tem a linha dele (D-IB81) — nunca uma "versão global".
 * - D-IB110: o LEIAUTE é o PACOTE XSD oficial, nomeado pela publicação; a VERSÃO é o atributo `versao` do documento. CONHECIMENTO NEGATIVO:
 *   os dois pacotes vigentes dizem `versao="1.01"` e são INCOMPATÍVEIS (o DPS de um recusa no outro com E1235 — nota 8014 em H, 2026-11-01):
 *   nunca escolher a forma pela versão, nem pelo ambiente (`environment === 'H'`) — quando a produção adotar o pacote novo, ela usa o MESMO id.
 *   O nome não é "NT 009": o pacote de 20/10/2026 traz a NT 009 só em parte (sem `regApIBSCBSSN`, sem notas de ajuste no XSD).
 *   Acervo: `Infra-IA/setes-api/integracoes/nfse-adn/xsd/Schemas/1.01/` (09/02) e `…/producao-restrita-20261020/xsd/` (20/10) +
 *   `…/producao-restrita-20261020/DIFERENCA.md`.
 */

export type LayoutDocument = 'DPS' | 'EVENT'

/** O pacote XSD oficial (D-IB110). União FECHADA: leiaute novo = id novo + os `switch` exaustivos do montador acusam onde falta a forma. */
export type NfseLayout = 'xsd-20260209' | 'xsd-20261020'

export interface LayoutLine {
  readonly document:    LayoutDocument
  readonly environment: AuthorityEnvironment
  /** Instante UTC a partir do qual a autoridade aceita o leiaute ('YYYY-MM-DDTHH:mm:ssZ'). */
  readonly validFrom:   string
  readonly layout:      NfseLayout
  /** O atributo `versao` do documento nesse leiaute — explícito na linha, nunca derivado do id. */
  readonly version:     string
}

export interface LayoutAt {
  readonly layout:  NfseLayout
  readonly version: string
}

/** O pacote de 09/02/2026 é o único desde o 1º envio deste adaptador (produção restrita 2026-09-28, produção 2026-09-29) — piso nomeado. */
const SINCE_FIRST_SEND = '2000-01-01T00:00:00Z'
/**
 * A produção restrita adotou o pacote `NFSe-ESQUEMAS_XSD-PRODREST-v1.01` de 20/10/2026 — publicação na página oficial "Documentação Técnica
 * (Homologação/testes)" em 20/10/2026 18h10 (Brasília) = 21:10 UTC. O instante exato da troca no servidor de H não é publicado (a última
 * transmissão em H registrada antes dele — 15/10, pacote antigo — passou o esquema; a de 2026-11-01 no pacote antigo levou E1235).
 */
const PRODREST_20261020 = '2026-10-20T21:10:00Z'

// tipado SEM `as` (gates do leiaute, 2026-11-01): documento, ambiente e leiaute de cada linha conferidos pelo compilador
const LINES: LayoutLine[] = [
  { document: 'DPS',   environment: 'H', validFrom: SINCE_FIRST_SEND,  layout: 'xsd-20260209', version: '1.01' },
  { document: 'DPS',   environment: 'H', validFrom: PRODREST_20261020, layout: 'xsd-20261020', version: '1.01' },
  // D-IB111: P segue no pacote de 09/02 até o fisco ANUNCIAR a data — a linha de P entra por deploy antes dela (sem data publicada em 2026-11-01)
  { document: 'DPS',   environment: 'P', validFrom: SINCE_FIRST_SEND,  layout: 'xsd-20260209', version: '1.01' },
  // o pedido de evento é IDÊNTICO nos dois pacotes (`tiposEventos`/`pedRegEvento` iguais byte a byte; os padrões de Id só passaram a aceitar
  // letras na inscrição) — a linha do evento segue no pacote de 09/02 nos dois ambientes; linha nova só quando o EVENTO mudar
  { document: 'EVENT', environment: 'H', validFrom: SINCE_FIRST_SEND,  layout: 'xsd-20260209', version: '1.01' },
  { document: 'EVENT', environment: 'P', validFrom: SINCE_FIRST_SEND,  layout: 'xsd-20260209', version: '1.01' },
]

/**
 * Cerca do DEPLOY de uma linha nova (gates socrático/adversarial do leiaute, 2026-11-01): a linha de P chega por deploy, possivelmente sob
 * pressão (D-IB111) — `validFrom` fora da forma UTC canônica ou de data inexistente (o `Date` "rola" 30/02 para 02/03), linha repetida
 * (documento × ambiente × `validFrom` — a 1ª venceria em silêncio) ou par sem o piso = FALHA ALTA no carregamento do módulo (o boot não
 * sobe), nunca P seguindo em silêncio no pacote antigo.
 */
export function assertLayoutCalendar(lines: readonly LayoutLine[]): void {
  const seen = new Set<string>()
  for (const l of lines) {
    const parsed = Date.parse(l.validFrom)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(l.validFrom) || !Number.isFinite(parsed)
      || `${new Date(parsed).toISOString().slice(0, 19)}Z` !== l.validFrom) {
      throw new Error(`Calendário de leiaute: validFrom fora da forma UTC 'AAAA-MM-DDThh:mm:ssZ' ou data inexistente: ${l.validFrom}`)
    }
    const key = `${l.document}|${l.environment}|${l.validFrom}`
    if (seen.has(key)) throw new Error(`Calendário de leiaute: linha repetida ${key}`)
    seen.add(key)
  }
  for (const document of ['DPS', 'EVENT'] as const) {
    for (const environment of ['H', 'P'] as const) {
      if (!lines.some(l => l.document === document && l.environment === environment && l.validFrom === SINCE_FIRST_SEND)) {
        throw new Error(`Calendário de leiaute: ${document} × ${environment} sem a linha-piso`)
      }
    }
  }
}

assertLayoutCalendar(LINES)
export const LAYOUT_CALENDAR: readonly LayoutLine[] = Object.freeze(LINES.map(l => Object.freeze({ ...l })))

/** O leiaute vigente para o documento no ambiente no INSTANTE dado (a linha de maior `validFrom` ≤ instante). Sem linha = falha alta. */
export function layoutAt(document: LayoutDocument, environment: AuthorityEnvironment, instant: Date): LayoutAt {
  const t = instant.getTime()
  if (!Number.isFinite(t)) throw new Error(`Instante inválido para o calendário de leiaute: ${instant}`)
  let best: LayoutLine | null = null
  for (const l of LAYOUT_CALENDAR) {
    if (l.document !== document || l.environment !== environment) continue
    const from = Date.parse(l.validFrom)
    if (from <= t && (!best || from > Date.parse(best.validFrom))) best = l
  }
  if (!best) throw new Error(`Sem leiaute de ${document} para o ambiente ${environment} em ${instant.toISOString()} (calendário do adaptador)`)
  return Object.freeze({ layout: best.layout, version: best.version })
}

/** Cinto dos `switch` exaustivos sobre o leiaute: um id novo na união sem a forma no montador não compila; em execução, falha alta. */
export function unknownLayout(layout: never): never {
  throw new Error(`Leiaute de NFS-e sem forma no montador: ${String(layout)}`)
}
