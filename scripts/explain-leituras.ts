/**
 * D-F40 (Valdo 2026-10-04, = Q-F49 (a)) — o custo das leituras que CRESCEM COM O HISTÓRICO é critério de aceite.
 * SOMENTE LEITURA. Chama as funções REAIS (o SQL é capturado interceptando `query` — nada é duplicado aqui) e roda
 * `EXPLAIN` + mede o tempo (mediana de N execuções) de:
 *   - a página de pendentes do lote (`listPendingServiceInvoices`: COUNT + página);
 *   - as candidatas do rodízio (`listRefreshCandidates`).
 *
 * Regra (molde da cerca M5 da Pesquisa Avançada — setes-api/scripts/explain-pesquisa-avancada.ts): subconsulta
 * DEPENDENTE (roda uma vez por linha) tem de chegar à tabela POR CHAVE — `DEPENDENT SUBQUERY` com `type` ALL/index =
 * varredura por linha = FALHA. Subconsulta MATERIALIZADA (o otimizador troca EXISTS por IN) que varre (ALL/index) lê a
 * tabela de TODAS as institutions a cada requisição = FALHA (gate adversarial R4: o NOT EXISTS dos pendentes varria o
 * histórico do banco inteiro até ganhar a institution como constante). A tabela que DIRIGE a consulta pode varrer no
 * dev (pouco dado) — AVISO. O teto do
 * critério (p95 < 300 ms com 200 mil notas) é medido no teste de carga da F3 / diagnóstico da S2 (D-F23/D-F24); aqui o
 * tempo é só registrado (dev pequeno não prova escala).
 *
 *   npx tsx --require tsconfig-paths/register scripts/explain-leituras.ts [institutionId=1] [schema=setes_setes]
 * Sai com código 1 se houver FALHA. EXPLAIN de VIEW exige `SHOW VIEW` — o usuário do SERVIÇO não tem (só SELECT, D-F31) e
 * não ganha por causa de diagnóstico: rode com um usuário de diagnóstico em EXPLAIN_DB_USER / EXPLAIN_DB_PASSWORD.
 */
import 'dotenv/config'
import { createFiscalPool, dbConfigFromEnv } from 'fiscal-api'
import { listPendingServiceInvoices } from '../src/facts/service-facts'
import { listRefreshCandidates, DEFAULT_CANCEL_DAYS, REFRESH_AUTHORIZED_MARGIN_DAYS } from '../src/nfse/repository'

const INST = Number(process.argv[2] ?? 1)
const SCHEMA = String(process.argv[3] ?? 'setes_setes')
const RUNS = 7

type Plan = { id: number; select_type: string; table: string; type: string; key: string | null; rows: number; Extra: string | null }

async function main(): Promise<void> {
  const base = dbConfigFromEnv()
  const cfg = process.env.EXPLAIN_DB_USER
    ? { ...base, user: process.env.EXPLAIN_DB_USER, password: process.env.EXPLAIN_DB_PASSWORD ?? '' }
    : base
  const pool = createFiscalPool(cfg)
  const failures: string[] = []
  const warnings: string[] = []
  try {
    const captured: { label: string; sql: string; params: unknown[] }[] = []
    const capture = (label: string) => ({
      query: async (sql: string, params: unknown[] = []) => {
        captured.push({ label: `${label}${captured.filter(c => c.label.startsWith(label)).length ? ' (2)' : ''}`, sql, params })
        return pool.query(sql, params)
      },
    }) as any

    await listPendingServiceInvoices(capture('pendentes'), SCHEMA, INST, cfg.database, { page: 1, pageSize: 25 }, ['service-orders', 'orders'])
    await listRefreshCandidates(capture('rodízio'), SCHEMA, INST, 5, 10, 8, { authorizedMaxDays: DEFAULT_CANCEL_DAYS + REFRESH_AUTHORIZED_MARGIN_DAYS })

    for (const c of captured) {
      const [plan] = await pool.query(`EXPLAIN ${c.sql}`, c.params) as unknown as [Plan[]]
      const times: number[] = []
      for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint()
        await pool.query(c.sql, c.params)
        times.push(Number(process.hrtime.bigint() - t0) / 1e6)
      }
      times.sort((a, b) => a - b)
      console.log(`\n== ${c.label} — mediana ${times[Math.floor(RUNS / 2)].toFixed(1)} ms (máx ${times[RUNS - 1].toFixed(1)} ms)`)
      for (const p of plan) {
        console.log(`   ${String(p.id).padEnd(3)} ${String(p.select_type).padEnd(20)} ${String(p.table).padEnd(28)} ${String(p.type).padEnd(8)} ${String(p.key ?? '-').padEnd(42)} rows=${p.rows} ${p.Extra ?? ''}`)
        const scan = p.type === 'ALL' || p.type === 'index'
        if (scan && /DEPENDENT/.test(String(p.select_type))) failures.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (varredura POR LINHA)`)
        else if (scan && /MATERIALIZED/.test(String(p.select_type))) failures.push(`${c.label}: ${p.select_type} em ${p.table} por ${p.type} (materialização sem o filtro da institution)`)
        else if (scan) warnings.push(`${c.label}: ${p.table} por ${p.type} (rows=${p.rows}) — conferir com volume na F3`)
      }
    }
  } finally {
    await pool.end()
  }
  if (warnings.length) console.log(`\nAVISOS (${warnings.length}):\n - ${warnings.join('\n - ')}`)
  if (failures.length) {
    console.log(`\nFALHAS (${failures.length}):\n - ${failures.join('\n - ')}`)
    process.exit(1)
  }
  console.log('\nOK — nenhuma subconsulta dependente varrendo por linha nem materialização varrendo o banco inteiro.')
}

main().catch(err => { console.error('[explain-leituras] FALHA:', err?.message ?? err); process.exit(1) })
