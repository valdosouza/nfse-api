import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable, runMigrations,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { MIGRATION_SETS } from './migrations'
import { assertServiceVoiceDomainsEnforced } from './nfse/voice-family'
import { assertCorsOrigins } from './cors-origins'

async function main(): Promise<void> {
  const ctx = contextFromEnv()
  logger.info(`CORS (origens do app — D-F146): ${assertCorsOrigins(ctx.corsOrigins)}`)
  // migrations: núcleo primeiro, depois a família (trava nomeada — duas instâncias sobem juntas — D-F35)
  const applied = await runMigrations(ctx.db, MIGRATION_SETS)
  if (applied.length) logger.info('Migrations aplicadas no boot', { applied })
  await assertSessionInvariants(ctx.pool)
  await assertIssuerModelDomainEnforced(ctx.pool)          // D-F45/D-NE84: CHECK BINÁRIO do domínio do modelo (migrations 004/005 do núcleo)
  await assertIssuerEnvironmentDomainEnforced(ctx.pool)    // D-F120: CHECK BINÁRIO do ambiente da habilitação (migration 005 do núcleo)
  await assertServiceVoiceDomainsEnforced(ctx.pool)        // D-F107/D-F120: kind (lista da família), source e ambiente da tentativa (005 desta API)
  await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb)  // D-F113: as views de cada família do catálogo respondem ao SELECT publicado
  if (ctx.keyring.currentVersion === null) logger.warn('FISCAL_MASTER_KEYS ausente — o A1 não abre (operações fiscais respondem 503) até configurar')
  const port = Number(process.env.PORT ?? 3002)
  createApp(ctx).listen(port, () => logger.info(`nfse-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfse-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
