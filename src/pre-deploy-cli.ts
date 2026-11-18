// DEPLOY.E1.P1.T4: `npm run predeploy:check` (= `node dist/pre-deploy-cli.js`, depois do `npm run build`) — roda na máquina/imagem de
// produção sem tsx. SOMENTE LEITURA. Sai com 1 se algum item bloqueia (só em NODE_ENV=production; fora dela, avisa).
import 'dotenv/config'
import { createFiscalPool, dbConfigFromEnv, MasterKeyRing } from 'fiscal-api'
import { preDeployConfigItems, preDeployDbItem, preDeployKeyItem, preDeployReport } from './pre-deploy'

async function main(): Promise<number> {
  const items = preDeployConfigItems(process.env)
  const pool = createFiscalPool(dbConfigFromEnv(process.env))
  try {
    const dbItem = await preDeployDbItem(process.env, async sql => (await pool.query(sql))[0] as Array<Record<string, unknown>>)
    items.push(dbItem)
    // D-F243: a chave do servidor abre os A1 guardados (só com o banco no ar; o anel vem do mesmo env do serviço)
    if (dbItem.ok) {
      let keyring: MasterKeyRing | null = null
      try { keyring = MasterKeyRing.fromEnv(process.env) } catch { keyring = null }   // anel inválido: o item FISCAL_MASTER_KEYS já diz
      if (keyring) items.push(await preDeployKeyItem(process.env, { pool, keyring }))
    }
  } finally {
    await pool.end()
  }
  const { lines, exitCode } = preDeployReport(items)
  console.log(`— pre-deploy da nfse-api (NODE_ENV=${process.env.NODE_ENV ?? '(vazio)'})`)
  for (const line of lines) console.log(`  ${line}`)
  return exitCode
}

main().then(code => process.exit(code), err => {
  console.error('pre-deploy falhou:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
