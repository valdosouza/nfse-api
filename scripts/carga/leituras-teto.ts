/**
 * DEPLOY.E3.P1 (D-F40) — o teto das leituras que crescem com o histórico, POR CHAMADA. Módulo PURO (sem efeito ao importar).
 * Uma chamada pode ter mais de uma SQL (a página de pendentes = COUNT + página, rotuladas "pendentes" e "pendentes (2)"): as SQLs da
 * mesma chamada rodam na MESMA iteração e o p95 é o da SOMA. Chamadas fora do teto ("vivas do emissor") só são registradas.
 */
import { percentil } from './estatistica'

export const CHAMADAS_COM_TETO: readonly string[] = Object.freeze(['pendentes', 'rodízio'])

/** O rótulo da chamada: o rótulo da SQL sem o sufixo " (n)". */
export function chamadaDe(rotulo: string): string {
  return rotulo.replace(/\s+\(\d+\)$/, '')
}

/** [iteracoes]: em cada iteração, o tempo (ms) de cada SQL pelo rótulo. Devolve, por chamada, os tempos somados por iteração. */
export function temposPorChamada(iteracoes: readonly Readonly<Record<string, number>>[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const it of iteracoes) {
    const soma = new Map<string, number>()
    for (const [rotulo, ms] of Object.entries(it)) soma.set(chamadaDe(rotulo), (soma.get(chamadaDe(rotulo)) ?? 0) + ms)
    for (const [c, ms] of soma) out.set(c, [...(out.get(c) ?? []), ms])
  }
  return out
}

export interface Veredito { chamada: string; mediana: number; p95: number; comTeto: boolean; falha: boolean }

export function avaliarTeto(porChamada: Map<string, number[]>, tetoMs: number | null, comTeto: readonly string[] = CHAMADAS_COM_TETO): Veredito[] {
  return [...porChamada].map(([chamada, tempos]) => {
    const p95 = percentil(tempos, 95)
    const temTeto = comTeto.includes(chamada)
    return { chamada, mediana: percentil(tempos, 50), p95, comTeto: temTeto, falha: tetoMs !== null && temTeto && !(p95 < tetoMs) }
  })
}

/**
 * DEPLOY.E3.P1 (D-F40): opções nomeadas `--inst`, `--schema`, `--runs N` (padrão 7) e `--teto-ms T`; sem opção, os dois posicionais de
 * antes (`[institutionId=1] [schema=setes_setes]`) seguem valendo. O tempo é medido POR CHAMADA (`scripts/carga/leituras-teto.ts`): as SQLs
 * da mesma chamada (COUNT + página dos pendentes) rodam na MESMA iteração e o p95 é o da soma; com `--teto-ms`, p95 ≥ T na página de
 * pendentes ou nas candidatas do rodízio é FALHA ("vivas do emissor" só registrada).
 */
export interface OpcoesLeituras { inst: number; schema: string; runs: number; tetoMs: number | null }
export function opcoesLeituras(argv: readonly string[]): OpcoesLeituras {
  const named = new Map<string, string>()
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (!['--inst', '--schema', '--runs', '--teto-ms'].includes(a)) throw new Error(`opção desconhecida: ${a}`)
      if (argv[i + 1] === undefined) throw new Error(`${a} sem valor`)
      named.set(a, argv[++i])
    } else pos.push(a)
  }
  const inst = Number(named.get('--inst') ?? pos[0] ?? 1)
  const schema = String(named.get('--schema') ?? pos[1] ?? 'setes_setes')
  const runs = Number(named.get('--runs') ?? 7)
  const tetoMs = named.has('--teto-ms') ? Number(named.get('--teto-ms')) : null
  if (!Number.isInteger(inst) || inst <= 0) throw new Error(`instituição inválida: ${inst}`)
  if (!/^setes_[a-z0-9_]+$/.test(schema)) throw new Error(`schema inválido: ${schema}`)
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs inválido: ${runs}`)
  if (tetoMs !== null && !(tetoMs > 0)) throw new Error(`--teto-ms inválido: ${tetoMs}`)
  return { inst, schema, runs, tetoMs }
}
