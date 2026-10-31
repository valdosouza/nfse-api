// Harness dos ataques AO VIVO (NFSE_ADV_LIVE=1) — gates da Rodada 4 (socrático R4, MEDIUM): o ataque NUNCA vira a
// habilitação REAL. Até aqui as suítes viravam a habilitação P da institution 1 no `fiscal_api` (que guarda o estado
// fiscal de PRODUÇÃO da Setes, A1 real) e a devolviam no `afterAll` — um jest morto no meio deixava a réplica VIRADA (o
// cenário R2-2 que a D-F39 fechou). Agora cada suíte trabalha numa CÓPIA DESCARTÁVEL (`fiscal_api_adv_*`): migrations do
// núcleo + família, as tabelas copiadas linha a linha, a virada aplicada SÓ na cópia; o ERP continua só LIDO (a nota é
// travada por instantes, como em toda transmissão). No fim a cópia é apagada e o CHECKSUM do `fiscal_api` REAL tem de
// ser o mesmo do início — senão a suíte falha. D-F53 (= Q-F53 (a), Valdo 2026-10-04; GRANT completado nos 4 hosts com o "vai" de 2026-10-10): o ATAQUE roda com o usuário
// do SERVIÇO (`fiscal_api`, do .env da nfse-api — só SELECT no ERP; ALL nas cópias `fiscal_api_adv*` por GRANT do dev,
// `ops/grants.sql` seção 1b): a defesa do ERP volta a ser por CONSTRUÇÃO. O DONO (usuário do ../setes-api/.env) só cria,
// copia e apaga a cópia e vigia os CHECKSUMs; o ENSAIO do ato (`--cutover` sem `--vai`, que escreve no ERP e desfaz) é o
// único que recebe a credencial do dono — e só por `ownerEnv`, EXPLÍCITO. LIMITE: o `fiscal_api` REAL é do próprio usuário
// do serviço (é o banco dele) — ali a defesa segue sendo DETECÇÃO (CHECKSUM do real e da `_migrations` no `drop()`).
// Cópias `fiscal_api_adv*` que SOBRARAM de uma execução morta (jest matado no meio) são apagadas na criação da próxima —
// rode as suítes ao vivo com --runInBand.
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
  'tb_invoice_service_transmission_ibscbs',
]

/**
 * Gate socrático da IB-3 (L1, 2026-10-15): tabela nova da família entrava na cópia (pelas migrations) mas ficava FORA do CHECKSUM que vigia o
 * `fiscal_api` REAL — "incluir depois do deploy" dependia de alguém lembrar. Agora: (1) a cerca `copy-tables-fence.test.ts` exige toda tabela
 * criada pelas migrations da família na lista (ou numa exceção NOMEADA); (2) a cópia tolera a ausência no REAL só da tabela cuja migration
 * ainda NÃO foi aplicada nele (`_migrations`) — tabela da lista ausente com a migration aplicada segue falhando alto (schema errado).
 */
export const FISCAL_COPY_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({})

/** Tabelas que cada migration da família CRIA (`CREATE TABLE …` fora de comentário), com o projeto e a versão. */
export function tablesByMigration(): { project: string; version: string; table: string }[] {
  const out: { project: string; version: string; table: string }[] = []
  for (const set of MIGRATION_SETS) {
    for (const file of fs.readdirSync(set.dir).filter(f => f.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(set.dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
      for (const m of sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([A-Za-z0-9_]+)`?/gi)) {
        out.push({ project: set.project, version: file.split('_')[0], table: m[1] })
      }
    }
  }
  return out
}

export interface DisposableFiscalDb {
  cfg:      FiscalDbConfig
  pool:     Pool
  user:     string
  password: string
  /** Processo filho (ex.: re-sincronia `npm run migrate:setes`) na CÓPIA, com o usuário do SERVIÇO (nunca escreve no ERP). */
  env:      Record<string, string>
  /** D-F53: SÓ para o ENSAIO do ato (`--cutover` sem `--vai`) — credencial do DONO do ERP (o ato escreve no ERP e desfaz). */
  ownerEnv: Record<string, string>
  drop():   Promise<void>
}

export async function disposableFiscalDb(root: string, name: string, opts: { turned: boolean }): Promise<DisposableFiscalDb> {
  if (!/^fiscal_api_adv[a-z0-9_]*$/.test(name)) throw new Error(`Banco descartável inválido: ${name}`)
  const setesEnv = dotenv.parse(fs.readFileSync(path.resolve(root, '..', 'setes-api', '.env')))
  const user = setesEnv.DB_USER, password = setesEnv.DB_PASSWORD ?? ''
  const base = dbConfigFromEnv()                                        // usuário do SERVIÇO (nfse-api/.env)
  const real = base.database
  if (name === real) throw new Error(`O banco descartável não pode ser o real (${real})`)
  if (!base.user || base.user === user) {
    throw new Error(`D-F53: DB_USER do .env da nfse-api (${base.user || 'vazio'}) tem de ser o usuário do SERVIÇO ('fiscal_api'), `
      + 'não o dono do ERP — aplique ops/grants.sql (seção 1b) e configure o .env')
  }
  const admin = createFiscalPool({ ...base, user, password })
  const erpSchema = process.env.ADV_ERP_SCHEMA ?? 'setes_setes'
  // a tabela da lista cuja migration o REAL ainda não aplicou (antes do deploy) fica fora da cópia e da vigilância — só ela
  const [appliedRows] = await admin.query(`SELECT project, version FROM \`${real}\`._migrations`)
  const applied = new Set((appliedRows as any[]).map(r => `${r.project}/${r.version}`))
  const pendingInReal = new Set(tablesByMigration().filter(t => !applied.has(`${t.project}/${t.version}`)).map(t => t.table))
  const copyTables = FISCAL_COPY_TABLES.filter(t => !pendingInReal.has(t))
  const realSums = async () => JSON.stringify((await admin.query(
    `CHECKSUM TABLE ${[...copyTables, '_migrations'].map(t => `\`${real}\`.${t}`).join(', ')}, ${ERP_WATCH.map(t => `\`${erpSchema}\`.${t}`).join(', ')}, ${CENTRAL_WATCH.join(', ')}`))[0])
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
  await runMigrations({ ...base, database: name }, MIGRATION_SETS)        // como o serviço faz no boot (D-F53)
  for (const t of copyTables) await admin.query(`INSERT INTO \`${name}\`.${t} SELECT * FROM \`${real}\`.${t}`)
  if (opts.turned) await admin.query(`UPDATE \`${name}\`.tb_establishment_issuer SET cutover_at = NOW() WHERE cutover_at IS NULL`)
  const cfg: FiscalDbConfig = { ...base, database: name }              // D-F53: o ataque com o usuário do SERVIÇO
  const pool = createFiscalPool(cfg)
  return {
    cfg, pool, user: base.user, password: base.password,
    env: { FISCAL_DB_NAME: name, DB_USER: base.user, DB_PASSWORD: base.password },
    ownerEnv: { FISCAL_DB_NAME: name, DB_USER: user, DB_PASSWORD: password },
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

/**
 * Costura A1 da auth-api (D-AU6, 2026-10-31): o veredito de acesso é a biblioteca `access` do núcleo (views do produto). Os ataques ao
 * vivo que SIMULAM "o contrato do ramo encerrou" (sem escrever no ERP) espiam as TRÊS leituras dela — alcance, verbo por ramo e
 * veredito —, no lugar da antiga `erp.institutionHasInterface`.
 */
export function spyContractCut(fiscalApi: any): { mockRestore(): void } {
  const spies = [
    jest.spyOn(fiscalApi.access, 'reachableKeys').mockResolvedValue([]),
    jest.spyOn(fiscalApi.access, 'grantedKeys').mockResolvedValue([]),
    jest.spyOn(fiscalApi.access, 'accessVerdict').mockResolvedValue('not-contracted'),
  ]
  return { mockRestore: () => spies.forEach(s => s.mockRestore()) }
}

/** O FATO do contrato (a interface está contratada para o estabelecimento?) — só para o teste calcular o esperado. */
export async function licensedFact(q: Pool, schemaName: string, institutionId: number, key: string): Promise<boolean> {
  if (!/^setes_[a-z0-9_]+$/.test(schemaName)) throw new Error(`schema inválido: ${schemaName}`)
  const [rows] = await q.query(
    `SELECT 1 FROM \`${schemaName}\`.tb_institution_has_interface ihi
       JOIN setes_central.tb_interface i ON i.id = ihi.tb_interface_id AND i.deleted = 'N'
      WHERE ihi.tb_institution_id = ? AND i.i18n_key = ? AND ihi.active = 'S' AND ihi.deleted = 'N' LIMIT 1`,
    [institutionId, key]) as any
  return Array.isArray(rows) && rows.length > 0
}
