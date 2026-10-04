// Harness dos ataques AO VIVO (NFSE_ADV_LIVE=1) — gates da Rodada 4 (socrático R4, MEDIUM): o ataque NUNCA vira a
// habilitação REAL. Até aqui as suítes viravam a habilitação P da institution 1 no `fiscal_api` (que guarda o estado
// fiscal de PRODUÇÃO da Setes, A1 real) e a devolviam no `afterAll` — um jest morto no meio deixava a réplica VIRADA (o
// cenário R2-2 que a D-F39 fechou). Agora cada suíte trabalha numa CÓPIA DESCARTÁVEL (`fiscal_api_adv_*`): migrations do
// núcleo + família, as tabelas copiadas linha a linha, a virada aplicada SÓ na cópia; o ERP continua só LIDO (a nota é
// travada por instantes, como em toda transmissão). No fim a cópia é apagada e o CHECKSUM do `fiscal_api` REAL tem de
// ser o mesmo do início — senão a suíte falha. O usuário é o de ../setes-api/.env (o do serviço não cria banco — D-F31):
// ele ESCREVE no ERP, então a garantia da D-F31 por GRANT não vale durante o ataque — por isso o `drop()` confere também o
// CHECKSUM do ERP (tabelas que a nfse-api lê/trava) e a `_migrations` do real (re-prova R4; voltar ao usuário de SELECT
// mínimo nas cópias depende de GRANT no servidor — Q-F53). Cópias `fiscal_api_adv_*` que SOBRARAM de uma execução morta
// (jest matado no meio) são apagadas na criação da próxima — rode as suítes ao vivo com --runInBand.
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { createFiscalPool, dbConfigFromEnv, runMigrations, FiscalDbConfig, Pool } from 'fiscal-api'
import { MIGRATION_SETS } from '../migrations'

const ERP_WATCH = ['tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_establishment_issuer', 'tb_institution_has_interface',
  'tb_user_has_privilege', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']
const CENTRAL_WATCH = ['setes_central.tb_institution', 'setes_central.tb_company', 'setes_central.tb_entity']

export const FISCAL_COPY_TABLES = [
  'tb_establishment_issuer', 'tb_establishment_certificate', 'tb_invoice_service_dps',
  'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event',
]

export interface DisposableFiscalDb {
  cfg:      FiscalDbConfig
  pool:     Pool
  user:     string
  password: string
  /** Variáveis para um processo filho (ex.: `npm run migrate:setes`) apontar para a CÓPIA, nunca para o real. */
  env:      Record<string, string>
  drop():   Promise<void>
}

export async function disposableFiscalDb(root: string, name: string, opts: { turned: boolean }): Promise<DisposableFiscalDb> {
  if (!/^fiscal_api_adv[a-z0-9_]*$/.test(name)) throw new Error(`Banco descartável inválido: ${name}`)
  const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(root, '..', 'setes-api', '.env')))
  const user = setesEnv.DB_USER, password = setesEnv.DB_PASSWORD ?? ''
  const base = dbConfigFromEnv()
  const real = base.database
  if (name === real) throw new Error(`O banco descartável não pode ser o real (${real})`)
  const admin = createFiscalPool({ ...base, user, password })
  const erpSchema = process.env.ADV_ERP_SCHEMA ?? 'setes_setes'
  const realSums = async () => JSON.stringify((await admin.query(
    `CHECKSUM TABLE ${[...FISCAL_COPY_TABLES, '_migrations'].map(t => `\`${real}\`.${t}`).join(', ')}, ${ERP_WATCH.map(t => `\`${erpSchema}\`.${t}`).join(', ')}, ${CENTRAL_WATCH.join(', ')}`))[0])
  // cópias que sobraram de execução MORTA (nunca a de outra suíte em paralelo — rodar com --runInBand)
  // a varredura casa EXATAMENTE o que o validador aceita (re-prova R4: `fiscal_api_adv4` da r4 escapava)
  const [left] = await admin.query(`SHOW DATABASES LIKE 'fiscal\\_api\\_adv%'`)
  for (const r of left as any[]) {
    const db = String(Object.values(r)[0])
    if (/^fiscal_api_adv[a-z0-9_]*$/.test(db)) await admin.query(`DROP DATABASE IF EXISTS \`${db}\``)
  }
  const before = await realSums()
  // CHECKSUM de tabela inexistente é NULL sem erro — vigilância com schema errado "bateria" sempre
  const nulls = (JSON.parse(before) as any[]).filter(r => r.Checksum == null).map(r => r.Table)
  if (nulls.length) throw new Error(`Vigilância do harness com tabela inexistente: ${nulls.join(', ')} (ADV_ERP_SCHEMA?)`)
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
  await runMigrations({ ...base, user, password, database: name }, MIGRATION_SETS)
  for (const t of FISCAL_COPY_TABLES) await admin.query(`INSERT INTO \`${name}\`.${t} SELECT * FROM \`${real}\`.${t}`)
  if (opts.turned) await admin.query(`UPDATE \`${name}\`.tb_establishment_issuer SET cutover_at = NOW() WHERE cutover_at IS NULL`)
  const cfg: FiscalDbConfig = { ...base, user, password, database: name }
  const pool = createFiscalPool(cfg)
  return {
    cfg, pool, user, password,
    env: { FISCAL_DB_NAME: name, DB_USER: user, DB_PASSWORD: password },
    async drop() {
      try { await pool.end() } catch { /* já encerrado */ }
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        const after = await realSums()
        if (after !== before) throw new Error(`O ${real} REAL (ou o ERP ${erpSchema}) mudou durante o ataque — conferir (CHECKSUM antes ${before} | depois ${after})`)
      } finally {
        await admin.end()
      }
    },
  }
}
