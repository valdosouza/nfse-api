import 'dotenv/config'
import {
  logger, assertSessionInvariants, assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced, assertFamilyViewsReadable, runMigrations,
  access,
} from 'fiscal-api'
import { contextFromEnv } from './context'
import { createApp } from './app'
import { KeyProof } from './key-proof'
import { MIGRATION_SETS } from './migrations'
import { assertServiceVoiceDomainsEnforced, assertServiceStrictSession } from './nfse/voice-family'
import { assertCorsOrigins } from './cors-origins'
import { readBuildCheck, assertBuildCurrent } from './build-info'
import { isProductionEnv } from './environment'

async function main(): Promise<void> {
  // D-F222 (achado 3d do gate): versão do núcleo + selo do dist ANTES de qualquer migration (dist de outro commit = não sobe)
  logger.info(assertBuildCurrent(readBuildCheck(), __filename.endsWith('.js'), isProductionEnv(process.env.NODE_ENV)))
  const ctx = contextFromEnv()
  logger.info(`CORS (origens do app — D-F146): ${assertCorsOrigins(ctx.corsOrigins, process.env.NODE_ENV)}`)
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
  // D-F250: a 1ª prova da chave (abre UM A1 guardado por versão — D-F243) roda ANTES de ouvir a porta: não há health "sem prova".
  // Falhou = sobe assim mesmo com masterKey=false e o motivo no log. Depois, a cada 5 minutos (D-F245/D-F251).
  const keyProof = new KeyProof(ctx)
  logger.info(`Prova da chave-mestra na partida (D-F243): ${await keyProof.run() ? 'ok' : 'FALHOU — /v1/health com masterKey=false (ver o log)'}`)
  keyProof.start()
  const port = Number(process.env.PORT ?? 3002)
  createApp(ctx, keyProof).listen(port, () => logger.info(`nfse-api ouvindo na porta ${port}`, { fiscalDb: ctx.fiscalDb }))
}

main().catch(err => {
  logger.error('Falha no boot da nfse-api', { err: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
