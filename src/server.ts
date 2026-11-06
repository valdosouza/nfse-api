import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable, runMigrations,
  access,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { MIGRATION_SETS } from './migrations'
import { assertServiceVoiceDomainsEnforced, assertServiceStrictSession } from './nfse/voice-family'
import { assertCorsOrigins } from './cors-origins'
import { readBuildCheck, assertBuildCurrent } from './build-info'

async function main(): Promise<void> {
  // D-F222 (achado 3d do gate): versão do núcleo + selo do dist ANTES de qualquer migration (dist de outro commit = não sobe)
  logger.info(assertBuildCurrent(readBuildCheck(), __filename.endsWith('.js'), process.env.NODE_ENV === 'production'))
  const ctx = contextFromEnv()
  logger.info(`CORS (origens do app — D-F146): ${assertCorsOrigins(ctx.corsOrigins)}`)
  // migrations: núcleo primeiro, depois a família (trava nomeada — duas instâncias sobem juntas — D-F35)
  const applied = await runMigrations(ctx.db, MIGRATION_SETS)
  if (applied.length) logger.info('Migrations aplicadas no boot', { applied })
  await assertSessionInvariants(ctx.pool)
  await assertIssuerModelDomainEnforced(ctx.pool)          // D-F45/D-NE84: CHECK BINÁRIO do domínio do modelo (migrations 004/005 do núcleo)
  await assertIssuerEnvironmentDomainEnforced(ctx.pool)    // D-F120: CHECK BINÁRIO do ambiente da habilitação (migration 005 do núcleo)
  await assertServiceVoiceDomainsEnforced(ctx.pool)        // D-F107/D-F120: kind (lista da família), source e ambiente da tentativa (005 desta API)
  await assertServiceStrictSession(ctx.pool)               // D-NE172: a sessão é ESTRITA — a chave de 51 posições é RECUSADA (1406), nunca cortada calada
  await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb)  // D-F113: as views de cada família do catálogo respondem ao SELECT publicado
  // costura A1 (D-AU3/D-AU12): a sessão viva lida em TODA rota — sem a vw_user_link (script sql/70) ou sem o GRANT nela, o serviço NÃO sobe
  logger.info(`Sessão viva (setes_central.vw_user_link): ${await access.assertSessionViewReadable(ctx.pool)}`)
  if (ctx.keyring.currentVersion === null) logger.warn('FISCAL_MASTER_KEYS ausente — o A1 não abre (operações fiscais respondem 503) até configurar')
  const port = Number(process.env.PORT ?? 3002)
  createApp(ctx).listen(port, () => logger.info(`nfse-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfse-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
