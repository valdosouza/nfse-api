import 'dotenv/config'
import { logger, assertSessionInvariants, assertIssuerModelDomainEnforced, runMigrations } from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { MIGRATION_SETS } from './migrations'

async function main(): Promise<void> {
  const ctx = contextFromEnv()
  // migrations: núcleo primeiro, depois a família (trava nomeada — duas instâncias sobem juntas — D-F35)
  const applied = await runMigrations(ctx.db, MIGRATION_SETS)
  if (applied.length) logger.info('Migrations aplicadas no boot', { applied })
  await assertSessionInvariants(ctx.pool)
  await assertIssuerModelDomainEnforced(ctx.pool)          // D-F45: o motor aplica o CHECK do domínio do modelo (migration 004)
  if (ctx.keyring.currentVersion === null) logger.warn('FISCAL_MASTER_KEYS ausente — o A1 não abre (operações fiscais respondem 503) até configurar')
  const port = Number(process.env.PORT ?? 3002)
  createApp(ctx).listen(port, () => logger.info(`nfse-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfse-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
