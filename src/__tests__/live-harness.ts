// Harness dos ataques AO VIVO (NFSE_ADV_LIVE=1) — gates da Rodada 4 (socrático R4, MEDIUM): o ataque NUNCA vira a
// habilitação REAL. Até aqui as suítes viravam a habilitação P da institution 1 no `fiscal_api` (que guarda o estado
// fiscal de PRODUÇÃO da Setes, A1 real) e a devolviam no `afterAll` — um jest morto no meio deixava a réplica VIRADA (o
// cenário R2-2 que a D-F39 fechou). Agora cada suíte trabalha numa CÓPIA DESCARTÁVEL (`fiscal_api_adv_*`): migrations do
// núcleo + família, as tabelas copiadas linha a linha, a virada aplicada SÓ na cópia; o ERP continua só LIDO (a nota é
// travada por instantes, como em toda transmissão). No fim a cópia é apagada e o CHECKSUM do `fiscal_api` REAL tem de
// ser o mesmo do início — senão a suíte falha. D-F53 (= Q-F53 (a), Valdo 2026-10-04; GRANT de 2026-10-10 conforme registrado; hoje a conta é só a do host % — `ops/grants.sql` seção 5, DEPLOY.E1.P8): o ATAQUE roda com o usuário
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
import jwt from 'jsonwebtoken'
import { createFiscalPool, dbConfigFromEnv, runMigrations, FiscalDbConfig, Pool, ProductTokenVerifier, InstitutionPayload } from 'fiscal-api'
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
export const FISCAL_COPY_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // CRED.E1.P1 (2026-11-22) — núcleo 4.1.0, migration 006 (D-NE221). Nenhuma das quatro é copiada do real; o real segue vigiado pelo
  // CHECKSUM de toda tabela-base (D-F231). Catálogo e regra: a própria 006 os semeia na cópia (copiar do real duplicaria a PK). Credenciais:
  // o VALOR fica em texto puro (D-NE223) — nunca vai aos bancos descartáveis do ataque; a cópia nasce com a tabela VAZIA.
  tb_fiscal_code_type:                'semeada pela migration 006 na própria cópia',
  tb_fiscal_code_requirement:         'semeada pela migration 006 na própria cópia',
  tb_provider_fiscal_credential:      'valor do CSRT em texto puro (D-NE223) — não sai do fiscal_api real',
  tb_establishment_fiscal_credential: 'valor do código do contribuinte em texto puro (D-NE223) — não sai do fiscal_api real',
})

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
  /** D-F231: as tabelas-base do `fiscal_api` REAL que o CHECKSUM do `drop()` vigia — TODAS (lidas do information_schema), não uma lista. */
  watched:  readonly string[]
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
  // D-F231 (gate socrático): o `--runInBand` só põe em fila DENTRO de um processo jest — duas sessões (ou dois terminais) rodando suítes ao
  // vivo ao mesmo tempo apagavam a cópia uma da outra na varredura abaixo. Trava NOMEADA do MariaDB numa conexão PRÓPRIA, presa até o
  // `drop()` (processo morto = conexão fechada = trava solta). Espera até 15 min pela outra suíte; senão falha alto.
  const lockConn = await admin.getConnection()
  const [[got]] = await lockConn.query(`SELECT GET_LOCK('nfse_api_live_harness', 900) AS ok`) as any
  if (Number(got?.ok) !== 1) {
    lockConn.release(); await admin.end()
    throw new Error('Outra suíte ao vivo da nfse-api está rodando (trava nfse_api_live_harness) — rode uma de cada vez')
  }
  const unlock = async () => { try { await lockConn.query(`DO RELEASE_LOCK('nfse_api_live_harness')`) } finally { lockConn.release() } }
  try {
  const erpSchema = process.env.ADV_ERP_SCHEMA ?? 'setes_setes'
  // a tabela da lista cuja migration o REAL ainda não aplicou (antes do deploy) fica fora da cópia e da vigilância — só ela
  const [appliedRows] = await admin.query(`SELECT project, version FROM \`${real}\`._migrations`)
  const applied = new Set((appliedRows as any[]).map(r => `${r.project}/${r.version}`))
  const pendingInReal = new Set(tablesByMigration().filter(t => !applied.has(`${t.project}/${t.version}`)).map(t => t.table))
  const copyTables = FISCAL_COPY_TABLES.filter(t => !pendingInReal.has(t))
  // D-F231: a vigilância cobre TODA tabela-base do real (lida do information_schema) — a lista fixa deixou de fora as tabelas da família NF-e
  // (nfe-api/001, 2026-11-04) no mesmo banco; a cópia continua só com as da família NFS-e
  const [baseRows] = await admin.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, [real])
  const watched = Object.freeze((baseRows as any[]).map(r => String(r.t)))
  const missing = [...copyTables, '_migrations'].filter(t => !watched.includes(t))
  if (missing.length) throw new Error(`Vigilância do harness: o ${real} real não tem ${missing.join(', ')}`)
  const realSums = async () => JSON.stringify((await admin.query(
    `CHECKSUM TABLE ${[...watched].map(t => `\`${real}\`.\`${t.replace(/`/g, '``')}\``).join(', ')}, ${ERP_WATCH.map(t => `\`${erpSchema}\`.${t}`).join(', ')}, ${CENTRAL_WATCH.join(', ')}`))[0])
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
  // D-F231: o estado da virada da CÓPIA é o que a suíte PEDE, nunca herdado do real. As suítes nasceram com o real como RÉPLICA (cutover_at
  // NULL); a JANELA da F2a (2026-10-14/15) virou o real → com `turned: false` a cópia herdava a virada e as suítes da cerca caíam. Agora:
  // `turned: true` = toda habilitação virada; `turned: false` = toda habilitação RÉPLICA (cutover_at NULL) — o estado de antes da virada.
  if (opts.turned) await admin.query(`UPDATE \`${name}\`.tb_establishment_issuer SET cutover_at = NOW() WHERE cutover_at IS NULL`)
  else {
    await admin.query(`UPDATE \`${name}\`.tb_establishment_issuer SET cutover_at = NULL WHERE cutover_at IS NOT NULL`)
    await trimToOrigin(admin, name, erpSchema)
  }
  const cfg: FiscalDbConfig = { ...base, database: name }              // D-F53: o ataque com o usuário do SERVIÇO
  const pool = createFiscalPool(cfg)
  return {
    cfg, pool, user: base.user, password: base.password, watched,
    env: { FISCAL_DB_NAME: name, DB_USER: base.user, DB_PASSWORD: base.password },
    ownerEnv: { FISCAL_DB_NAME: name, DB_USER: user, DB_PASSWORD: password },
    async drop() {
      try { await pool.end() } catch { /* já encerrado */ }
      try {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``)
        const after = await realSums()
        if (after !== before) throw new Error(`O ${real} REAL (ou o ERP ${erpSchema}) mudou durante o ataque — conferir (CHECKSUM antes ${before} | depois ${after})`)
      } finally {
        try { await unlock() } finally { await admin.end() }
      }
    },
  }
  } catch (err) {                                                      // a criação falhou: solta a trava e o pool do dono
    try { await unlock() } finally { await admin.end() }
    throw err
  }
}

/**
 * D-F231 — a CÓPIA no estado de ANTES DA VIRADA tem só o que a ORIGEM (o ERP — as tabelas fiscais próprias do setes-api, congeladas pela
 * F2a) conhece: tentativa (com voz, valores IBS/CBS e DPS da vida) que a origem NÃO tem foi feita pela nfse-api DEPOIS da virada (ex.: a
 * NFS-e 707 de 2026-10-15) — na réplica ela seria o "dual-write" que a re-sincronia recusa com razão. Escreve SÓ em [db] (descartável).
 */
export async function trimToOrigin(q: { query: (sql: string, p?: any[]) => Promise<any> }, db: string, erpSchema: string): Promise<void> {
  if (!/^fiscal_api_adv[a-z0-9_]*$/.test(db)) throw new Error(`trimToOrigin só em cópia descartável: ${db}`)
  if (!/^setes_[a-z0-9_]+$/.test(erpSchema)) throw new Error(`schema inválido: ${erpSchema}`)
  const notInOrigin = (a: string) => `NOT EXISTS (SELECT 1 FROM \`${erpSchema}\`.tb_invoice_service_transmission src
    WHERE src.tb_institution_id = ${a}.tb_institution_id AND src.tb_invoice_id = ${a}.tb_invoice_id AND src.terminal = ${a}.terminal AND src.attempt = ${a}.attempt)`
  for (const t of ['tb_invoice_service_transmission_event', 'tb_invoice_service_transmission_ibscbs', 'tb_invoice_service_transmission']) {
    await q.query(`DELETE x FROM \`${db}\`.${t} x WHERE ${notInOrigin('x')}`)
  }
  await q.query(`DELETE d FROM \`${db}\`.tb_invoice_service_dps d WHERE NOT EXISTS (SELECT 1 FROM \`${db}\`.tb_invoice_service_transmission t
    WHERE t.tb_institution_id = d.tb_institution_id AND t.tb_invoice_id = d.tb_invoice_id AND t.terminal = d.terminal AND t.life_event = d.life_event)`)
  // gate adversarial (LOW): o contador da habilitação SE volta ao da origem — o nDPS cunhado depois da virada (a 707) não fica "queimado"
  await q.query(`UPDATE \`${db}\`.tb_establishment_issuer f JOIN \`${erpSchema}\`.tb_establishment_issuer src
                    ON src.tb_institution_id = f.tb_institution_id AND src.model = f.model
                   SET f.dps_last_number = src.dps_last_number WHERE f.model = 'SE'`)
}

/**
 * D-F231 (2026-11-06) — RAMO COMPLETADO EM MEMÓRIA para o ataque. Os ataques ao vivo exercitam a MÁQUINA DA VOZ (reserva, tentativa, voz,
 * travas, cancelamento) e precisam de notas E da web cujo ramo monte o DPS. Até 2026-10-10 elas existiam (as notas da trilha faturadas
 * pela web); a janela da F2a cancelou essas notas (D-F207) e as notas E que SOBRARAM no dev vieram do ERP Desktop pelo sincronizador — o
 * ramo de serviço delas não tem os fatos do ISS (sem cTribNac, sem cidade de incidência, base 0) → `buildDpsBase` recusa TODAS com 422
 * (`SERVICE_RULE_NATIONAL_CODE_REQUIRED`) e as 8 suítes caíam no `beforeAll` ("notas-alvo frescas" vazio). Conhecimento negativo: escolher
 * nota por id FIXO ou contar com "notas frescas" do faturamento da web deixa a suíte refém do dado do dev.
 *
 * Regra (o mesmo princípio da normalização do cTribMun, que já vivia aqui): o ramo lido de VERDADE do ERP é COMPLETADO só EM MEMÓRIA,
 * nunca no banco:
 *  - cTribMun fora da forma (3 dígitos) → ausente (anterior à D-N26b);
 *  - ramo SEM cTribNac (o do ERP Desktop) → os fatos do ISS vêm do RAMO-MOLDE: o ramo mais recente que a WEB congelou para o mesmo
 *    estabelecimento (com cTribNac e cidade; vivo ou não — é o FATO de como o faturamento congela), mantendo o VALOR da própria nota
 *    (base = valor, ISS pela alíquota do molde). Sem molde nenhum o harness FALHA ALTO (não inventa número).
 * Ramo que já monta (faturado pela web) passa intacto. Locks, views, repositório e banco fiscal (cópia) continuam REAIS.
 */
const branchTemplates = new Map<string, Promise<BranchTemplate>>()
interface BranchTemplate {
  serviceListId: string | null; nationalCode: string; municipalCode: string | null; cityId: number
  aliqIss: number; issWithheld: 'S' | 'N'; liability: '1' | '2' | '3' | '4'
}
async function branchTemplate(q: { query: (sql: string, p?: any[]) => Promise<any> }, schemaName: string, institutionId: number): Promise<BranchTemplate> {
  if (!/^setes_[a-z0-9_]+$/.test(schemaName)) throw new Error(`schema inválido: ${schemaName}`)
  const [rows] = await q.query(
    `SELECT sv.tb_service_list_id AS serviceListId, sv.national_code AS nationalCode, sv.municipal_code AS municipalCode,
            sv.tb_city_id AS cityId, sv.aliq_iss AS aliqIss, sv.iss_withheld AS issWithheld, sv.liability
       FROM \`${schemaName}\`.tb_invoice_service sv
      WHERE sv.tb_institution_id = ? AND sv.national_code IS NOT NULL AND sv.tb_city_id IS NOT NULL
      ORDER BY sv.updated_at DESC, sv.id DESC LIMIT 1`, [institutionId])
  const r = (rows as any[])[0]
  if (!r) {
    throw new Error(`D-F231: nenhum ramo de serviço faturado pela WEB (com cTribNac e cidade) em ${schemaName}/${institutionId} — `
      + 'sem ramo-molde o harness não completa o ramo das notas do ERP Desktop; fature UMA nota de serviço pela web no dev')
  }
  return {
    serviceListId: r.serviceListId ?? null, nationalCode: String(r.nationalCode),
    municipalCode: /^\d{3}$/.test(String(r.municipalCode ?? '').trim()) ? String(r.municipalCode).trim() : null,
    cityId: Number(r.cityId), aliqIss: Number(r.aliqIss ?? 0), issWithheld: r.issWithheld === 'S' ? 'S' : 'N',
    liability: (['1', '2', '3', '4'].includes(String(r.liability)) ? String(r.liability) : '1') as BranchTemplate['liability'],
  }
}

/** O mock de `readServiceInvoice` das suítes ao vivo chama isto com o cabeçalho LIDO do ERP (args = os mesmos da leitura real). */
export async function completeBranchForAttack(header: any, args: any[]): Promise<any> {
  const b = header.branch
  if (b.municipalCode && !/^\d{3}$/.test(String(b.municipalCode).trim())) b.municipalCode = null
  if (!b.nationalCode) {
    const [q, schemaName, ref] = args
    const key = `${schemaName}/${ref.institutionId}`
    // gate adversarial (LOW): a leitura que FALHA não fica no cache (um erro passageiro não envenena as notas seguintes do arquivo)
    if (!branchTemplates.has(key)) {
      branchTemplates.set(key, branchTemplate(q, schemaName, ref.institutionId).catch(err => { branchTemplates.delete(key); throw err }))
    }
    const t = await branchTemplates.get(key)!
    const value = Number(b.totalValue ?? 0)
    Object.assign(b, {
      serviceListId: t.serviceListId, nationalCode: t.nationalCode, municipalCode: t.municipalCode, cityId: t.cityId,
      aliqIss: t.aliqIss, issWithheld: t.issWithheld, liability: t.liability,
      baseIss: value, issValue: Math.round(value * t.aliqIss) / 100,
    })
  }
  return header
}

/** Nota-alvo pelo ESTADO (D-F231): ids que a suíte usa como "fixos" passam a ser escolhidos por um predicado — nunca por número. */
export async function noteByState(q: { query: (sql: string, p?: any[]) => Promise<any> }, label: string, sql: string, params: any[]): Promise<number> {
  const [rows] = await q.query(sql, params)
  const id = Number((rows as any[])[0]?.id ?? 0)
  if (!id) throw new Error(`D-F231: o dev não tem nota no estado "${label}" — a suíte ao vivo precisa dela (ver o predicado em ${label})`)
  return id
}

/**
 * D-F231: nota CANCELADA no fisco de PRODUÇÃO e no ERP — viva no ERP (`deleted = 'N'`, emitida aqui, com ramo), vida local C e, na cópia do
 * `fiscal_api` ([q] = o pool da cópia), a tentativa de P com a chave e a voz C (a antiga 8011 era a da NFS-e 704). O XML dela está no arquivo
 * fiscal real (o storage do ataque só o LÊ). [except] = nota que não serve (para pegar uma 2ª).
 */
export function cancelledAtAuthorityNote(q: { query: (sql: string, p?: any[]) => Promise<any> }, schemaName: string, institutionId: number, except = 0): Promise<number> {
  if (!/^setes_[a-z0-9_]+$/.test(schemaName)) throw new Error(`schema inválido: ${schemaName}`)
  const s = schemaName
  return noteByState(q, 'cancelada no fisco de P e no ERP', `SELECT i.id FROM \`${s}\`.tb_invoice i
       JOIN \`${s}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = i.terminal AND l.last_kind = 'C'
       JOIN \`${s}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN vw_invoice_service_transmission t ON t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id AND t.terminal = i.terminal
                                             AND t.environment = 'P' AND t.access_key IS NOT NULL AND t.last_kind = 'C'
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND i.issuer = i.tb_institution_id AND i.id <> ?
      ORDER BY i.id DESC LIMIT 1`, [institutionId, except])
}

/** D-F231: os usuários do ATAQUE são marcadores sintéticos (990001…990999 — marcam as linhas que o ataque grava na cópia). */
export const isAttackUser = (userId: unknown): boolean => Number.isInteger(userId) && (userId as number) >= 990000 && (userId as number) <= 990999

/**
 * DEPLOY.E1.P4.T3 (núcleo 3.0.0+, D-AU3/D-AU19): o verificador do núcleo DESCARTA o `role` do token (devolve `role: ''`); o perfil é só o
 * da sessão viva. Os ataques ao vivo declaram o perfil do usuário SINTÉTICO no próprio token (`role: 'user'` = comum; senão o do admin
 * real que ele empresta — `attackSession`) e há apps sem sessão viva (`checkIdentity: false`) que contam com o perfil declarado. Este
 * verificador de TESTE devolve ao payload o `role` declarado SÓ para os usuários do ataque (990000–990999 — `isAttackUser`): a
 * assinatura, o `kid`, o `exp`, o `iat` e a forma continuam pelo verificador REAL; todo outro usuário segue o núcleo (`role: ''`).
 * Nunca em produção: o `context.ts` monta o verificador do núcleo direto.
 */
export function attackVerifier(env: NodeJS.ProcessEnv = process.env): ProductTokenVerifier {
  const real = ProductTokenVerifier.fromEnv(env)
  const declared = (token: string, p: InstitutionPayload): InstitutionPayload => {
    if (!isAttackUser(p.userId)) return p
    const role = (jwt.decode(token) as { role?: unknown } | null)?.role
    return typeof role === 'string' ? { ...p, role } : p
  }
  const v = Object.create(real) as ProductTokenVerifier
  v.verify = (token: string) => declared(token, real.verify(token))
  v.verifyWithIat = (token: string) => { const r = real.verifyWithIat(token); return { ...r, payload: declared(token, r.payload) } }
  return v
}

/**
 * D-F231 — SESSÃO DO ATAQUE pela costura A1. Desde a costura (D-AU3/D-AU6, 2026-11-01) a nfse-api lê a SESSÃO VIVA a cada requisição
 * (`access.liveIdentity` → `setes_central.vw_user_link`) e o veredito pelas views do produto; os usuários sintéticos do ataque não existem
 * no ERP → toda rota respondia 401 `SESSION_REVOKED` (a outra metade das 149 falhas — as suítes nasceram antes da costura e não rodaram ao
 * vivo depois dela). O ERP não é escrito; o dev não tem usuário comum na Setes. Então o usuário do ataque EMPRESTA o acesso VIVO de um
 * ADMIN REAL do mesmo estabelecimento, escolhido pelo ESTADO (perfil `admin` em `vw_user_link` — nunca o super, que escapa da licença):
 *  - perfil = o `role` que o token do ataque declara (como antes da costura): `user` = comum SEM concessão nenhuma (veredito
 *    'no-privilege' onde o admin alcança a interface, 'not-contracted' onde não alcança; nada concedido); senão o perfil VIVO do admin;
 *  - sessão, alcance e veredito do admin = as views REAIS (o token de outro estabelecimento/schema continua sem sessão → 401);
 *  - usuário que NÃO é do ataque passa direto pela biblioteca real.
 * Troca por ATRIBUIÇÃO (não `jest.spyOn`): o `spyContractCut` espia por cima e, no `mockRestore`, devolve ESTE invólucro.
 */
export async function attackSession(fiscalApi: any, q: { query: (sql: string, p?: any[]) => Promise<any> }, schemaName: string, institutionId: number): Promise<{ liveAdmin: number; restore(): void }> {
  const liveAdmin = await noteByState(q, 'admin vivo do estabelecimento (vw_user_link)',
    `SELECT tb_user_id AS id FROM setes_central.vw_user_link WHERE tb_institution_id = ? AND schema_name = ? AND profile = 'admin'
      ORDER BY tb_user_id LIMIT 1`, [institutionId, schemaName])
  const a = fiscalApi.access
  const orig = { liveIdentity: a.liveIdentity, reachableKeys: a.reachableKeys, accessVerdict: a.accessVerdict, grantedKeys: a.grantedKeys }
  // ataque que se declarou `user`: o perfil viaja no PRÓPRIO `who` (o middleware põe o perfil da sessão no payload que as guardas repassam)
  const isRegular = (who: any) => who?.role === 'user'
  const asAdmin = (who: any) => ({ ...who, userId: liveAdmin })
  a.liveIdentity = async (qq: any, p: any, iat: number) => {
    if (!isAttackUser(p?.userId)) return orig.liveIdentity(qq, p, iat)
    const live = await orig.liveIdentity(qq, asAdmin(p), iat)         // a sessão REAL do admin (outro estabelecimento/schema → 401)
    return { ...p, role: p.role === 'user' ? 'user' : live.role }
  }
  a.reachableKeys = (qq: any, who: any, keys: any) => orig.reachableKeys(qq, isAttackUser(who?.userId) ? asAdmin(who) : who, keys)
  a.accessVerdict = async (qq: any, who: any, keys: any, priv: any) => {
    if (!isAttackUser(who?.userId)) return orig.accessVerdict(qq, who, keys, priv)
    if (!isRegular(who)) return orig.accessVerdict(qq, asAdmin(who), keys, priv)
    return (await orig.reachableKeys(qq, asAdmin(who), keys)).length > 0 ? 'no-privilege' : 'not-contracted'
  }
  a.grantedKeys = async (qq: any, who: any, keys: any, priv: any) => {
    if (!isAttackUser(who?.userId)) return orig.grantedKeys(qq, who, keys, priv)
    return isRegular(who) ? [] : orig.grantedKeys(qq, asAdmin(who), keys, priv)
  }
  return { liveAdmin, restore: () => Object.assign(a, orig) }
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
