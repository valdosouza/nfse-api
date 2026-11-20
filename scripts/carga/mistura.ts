/**
 * DEPLOY.E3.P1 (D-F23) — a MISTURA da carga e a agenda em LAÇO ABERTO. Módulo PURO (sem efeito ao importar).
 * Suposição marcada (ficha §5): o §5.9 só dá o total (5 req/s no pico); a divisão por fatia é do orquestrador, não do app.
 */

export type Fatia =
  | 'pendentes' | 'transmitir' | 'mesma-nota-duas-instancias' | 'repetir-autorizada' | 'consultar' | 'cancelar' | 'xml-danfse'

export const MISTURA_PADRAO: Readonly<Record<Fatia, number>> = Object.freeze({
  'pendentes': 40,
  'transmitir': 30,
  'mesma-nota-duas-instancias': 5,
  'repetir-autorizada': 5,
  'consultar': 10,
  'cancelar': 5,
  'xml-danfse': 5,
})

/** A fatia sorteada por peso; [u] uniforme em [0, 1). */
export function sortearFatia(u: number, pesos: Readonly<Record<Fatia, number>> = MISTURA_PADRAO): Fatia {
  if (!(u >= 0 && u < 1)) throw new Error(`sorteio fora de [0, 1): ${u}`)
  const itens = Object.entries(pesos) as [Fatia, number][]
  const total = itens.reduce((s, [, w]) => s + w, 0)
  if (!(total > 0)) throw new Error('mistura sem peso')
  let alvo = u * total
  for (const [fatia, w] of itens) {
    if (alvo < w) return fatia
    alvo -= w
  }
  return itens[itens.length - 1][0]
}

/**
 * LAÇO ABERTO: os instantes (ms desde o início) em que cada requisição PARTE, fixos a 1/rps — a agenda nunca espera a resposta
 * (um serviço lento acumula requisições em voo, como na produção; laço fechado esconderia a fila).
 */
export function agenda(rps: number, duracaoMs: number): number[] {
  if (!(rps > 0)) throw new Error(`rps inválido: ${rps}`)
  if (!(duracaoMs >= 0)) throw new Error(`duração inválida: ${duracaoMs}`)
  const passo = 1000 / rps
  const n = Math.floor((duracaoMs * rps) / 1000 + 1e-9)
  return Array.from({ length: n }, (_, i) => Math.round(i * passo))
}
