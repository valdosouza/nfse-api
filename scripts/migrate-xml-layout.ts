// DEPLOY.E1.P3.T2 (D-F241, 2026-11-18 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p3-adocao-pacote-2-0-0.md` no Vault): migra os XMLs
// do layout antigo (`<cnpj>/[H/]<ano>/<mês>/`) para o do pacote 2.0.0 (`<cnpj>/[H/]nfse/<série>/<ano>/<mês>/<dia>/`), achando no BANCO a
// série da DPS e o dia de cada arquivo. A lógica (e as regras) mora em `src/nfse/xml-layout-migration.ts`.
//
//   npm run migrate:xml-layout              ENSAIO: só lê e imprime o plano (nada grava, nada apaga)
//   npm run migrate:xml-layout -- --vai     EXECUTA (só com o "vai" do Valdo — o arquivo é o da Setes; ficha §6 item 7: com o serviço PARADO)
//
// Lê: STORAGE_PATH (raiz por `fiscalStorageRootFromEnv`: produção exige caminho absoluto) e DB_* do .env (o usuário do fiscal_api).
// Argumento desconhecido ou repetido FALHA antes de abrir o banco; `--vai` engolido pelo npm (sem o `--`) também.
import 'dotenv/config'
import {
  createFiscalPool, dbConfigFromEnv, FsFiscalStorage, fiscalStorageRootFromEnv, erp, Queryable,
} from 'fiscal-api'
import { emitterCnpj } from '../src/facts/service-facts'
import { migrateXmlLayout, XmlFacts, XmlFactsResolver } from '../src/nfse/xml-layout-migration'

export function xmlLayoutArgumentErrors(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const a of args) {
    if (a !== '--vai') errors.push(`argumento desconhecido: "${a}"`)
    else if (seen.has(a)) errors.push(`argumento repetido: "${a}"`)
    seen.add(a)
  }
  if (env.npm_config_vai !== undefined && env.npm_config_vai !== '') errors.push('o npm engoliu --vai (faltou o "--"): use `npm run migrate:xml-layout -- --vai`')
  return errors
}

const DT = (col: string) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`

/**
 * O resolvedor do BANCO: linhas da chave (ou do Id do DPS) em qualquer estabelecimento, filtradas pelo estabelecimento cujo emitente é o
 * CNPJ da pasta (o UNIQUE é por estabelecimento). Exatamente um estabelecimento = os fatos; nenhum ou mais de um = null (o arquivo fica).
 * O schema vem de `setes_central.tb_institution` (no GRANT — D-AU12) e a zona da fonte de fatos do núcleo (`erp.institutionZone`).
 */
export function sqlResolver(q: Queryable): XmlFactsResolver {
  const pick = async (cnpj: string, rows: any[]): Promise<XmlFacts | null> => {
    const byInst = new Map<number, any[]>()
    for (const r of rows) byInst.set(Number(r.institutionId), [...(byInst.get(Number(r.institutionId)) ?? []), r])
    const mine: [number, any[]][] = []
    for (const [id, rs] of byInst) {
      let c: string | null = null
      try { c = await emitterCnpj(q, id) } catch { c = null }
      if (c === cnpj) mine.push([id, rs])
    }
    if (mine.length !== 1) return null
    const [id, rs] = mine[0]
    const series = new Set(rs.map(r => String(r.serie)))
    if (series.size !== 1 || !rs[0].schemaName) return null
    const zone = await erp.institutionZone(q, String(rs[0].schemaName), id)
    const instants = rs.flatMap(r => [r.dh, r.cr]).filter((s): s is string => typeof s === 'string' && s.length > 0)
    return { serie: [...series][0], instants, zone }
  }
  const SELECT = `SELECT t.tb_institution_id AS institutionId, i.schema_name AS schemaName, d.serie, ${DT('t.dh_proc')} AS dh, ${DT('t.created_at')} AS cr
       FROM tb_invoice_service_transmission t
       JOIN tb_invoice_service_dps d
         ON d.tb_institution_id = t.tb_institution_id AND d.tb_invoice_id = t.tb_invoice_id
        AND d.terminal = t.terminal AND d.life_event = t.life_event
       JOIN setes_central.tb_institution i ON i.id = t.tb_institution_id`
  return {
    async byAccessKey(cnpj, accessKey) {
      const [rows]: [any[], unknown] = await q.query(`${SELECT}\n      WHERE t.access_key = ?\n      ORDER BY t.tb_institution_id, t.attempt`, [accessKey])
      return pick(cnpj, rows)
    },
    async byDpsId(cnpj, dpsId) {
      // o DPS é gravado logo depois da reserva de cada tentativa: o instante é o `created_at` dela (o `dh_proc` não vale para o DPS)
      const [rows]: [any[], unknown] = await q.query(`${SELECT}\n      WHERE d.dps_id = ?\n      ORDER BY t.tb_institution_id, t.attempt`, [dpsId])
      return pick(cnpj, rows.map((r: any) => ({ ...r, dh: null })))
    },
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const bad = xmlLayoutArgumentErrors(args, process.env)
  if (bad.length) throw new Error(`${bad.join('; ')} — uso: npm run migrate:xml-layout [-- --vai]`)
  const apply = args.includes('--vai')
  const root = fiscalStorageRootFromEnv()
  const pool = createFiscalPool(dbConfigFromEnv())
  try {
    const r = await migrateXmlLayout({ root, storage: new FsFiscalStorage(root), resolver: sqlResolver(pool), apply })
    console.log(`${apply ? 'EXECUTADO' : 'ENSAIO (nada gravado — `-- --vai` executa)'} · raiz ${root}`)
    for (const m of r.moved) console.log(`  ${apply ? 'movido' : 'moveria'}: ${m.from} → ${m.to ?? `nfse/${m.serie} dia ${m.day}`}`)
    for (const m of r.alreadyThere) console.log(`  já no destino (mesmo conteúdo)${apply ? ', antigo apagado' : ''}: ${m.from} = ${m.to}`)
    for (const k of r.kept) console.log(`  FICA: ${k.from} — ${k.reason}`)
    console.log(`  total: ${r.moved.length} ${apply ? 'movidos' : 'a mover'} · ${r.alreadyThere.length} já no destino · ${r.kept.length} ficam`)
    if (r.kept.length) process.exitCode = 2
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`migrate:xml-layout: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
