/**
 * DEPLOY.E3.P1 (D-F23, D-F40) — percentis da carga. Módulo PURO (sem efeito ao importar).
 * Posto mais próximo: p-ésimo percentil de n valores = o valor de posto ⌈p/100 · n⌉ na ordem crescente (p95 de [1..100] = 95).
 */

/** Percentil p (0 < p ≤ 100) pelo posto mais próximo; NaN para a lista vazia. Não altera a lista recebida. */
export function percentil(valores: readonly number[], p: number): number {
  if (!(p > 0 && p <= 100)) throw new Error(`percentil fora de (0, 100]: ${p}`)
  if (valores.length === 0) return NaN
  const ordenados = [...valores].sort((a, b) => a - b)
  const posto = Math.ceil((p / 100) * ordenados.length)
  return ordenados[Math.max(1, posto) - 1]
}

export interface Resumo { n: number; p50: number; p95: number; p99: number; max: number }

export function resumo(valores: readonly number[]): Resumo {
  return {
    n: valores.length,
    p50: percentil(valores, 50),
    p95: percentil(valores, 95),
    p99: percentil(valores, 99),
    max: valores.length ? Math.max(...valores) : NaN,
  }
}
