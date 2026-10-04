// Aplica as migrations do banco `fiscal_api`: núcleo (`fiscal-api`) e família (`nfse-api`) — D-F35.
// Uso: npm run db:migrate
import 'dotenv/config'
import { dbConfigFromEnv, runMigrations } from 'fiscal-api'
import { MIGRATION_SETS } from '../src/migrations'

runMigrations(dbConfigFromEnv(), MIGRATION_SETS)
  .then(applied => { console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Nada pendente'); process.exit(0) })
  .catch(err => { console.error('[db:migrate] FALHA:', err?.message ?? err); process.exit(1) })
