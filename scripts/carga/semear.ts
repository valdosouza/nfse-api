/**
 * DEPLOY.E3.P1 (D-F255, D-F256, D-F257, D-F258) — o banco da carga na instância DESCARTÁVEL da 3307.
 *
 * LEITURA da 3306 (o MariaDB que emite a produção da Setes), com o usuário dono do `../setes-api/.env`, em transação READ ONLY:
 *   - CHECKSUM das listas que o harness ao vivo vigia + os seis catálogos, imediatamente antes e depois da janela de leitura;
 *   - a ESTRUTURA por `mysqldump --no-data --single-transaction --skip-lock-tables` (nunca trava a 3306);
 *   - os seis CATÁLOGOS com dados (D-F256).
 * ESCRITA só na 3307 (root da instância descartável), e no ERP sintético só pelos identificadores `CARGA_SCHEMA`/`CARGA_CENTRAL` (D-F257):
 *   - `setes_central` com a estrutura inteira + catálogos + instituições/usuários/entidades sintéticos;
 *   - `setes_carga_NNNN` só com as tabelas que a nfse-api lê e as que as views precisam (D-F258); `setes_carga_volume` com o molde inteiro;
 *   - `fiscal_api_carga` pelas migrations; habilitação SE e A1 pelas peças do NÚCLEO (`writeIssuer`, `storeCertificate`);
 *   - o histórico do volume (200 mil notas): DPS e tentativas em blocos; a VOZ só pelo escritor tipado `insertTransmissionEvent`, sob a
 *     trava da nota (`withInvoiceTx`) — cerca do escritor único (D-F106).
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { generateKeyPairSync } from 'crypto'
import dotenv from 'dotenv'
import forge from 'node-forge'
import mysql from 'mysql2/promise'
import {
  createFiscalPool, runMigrations, MasterKeyRing, writeIssuer, storeCertificate, withInvoiceTx, invoiceRef, erp,
  WEB_TERMINAL,
} from 'fiscal-api'
import { MIGRATION_SETS } from '../../src/migrations'
import { insertTransmissionEvent } from '../../src/nfse/repository'
import { reescreverSchema, comandosDoDump, semColunas } from './reescrita-schema'
import { cnpjSintetico } from './cnpj-sintetico'
import { assertPortaCarga, assertSchemaCarga, portaDoEnvArquivo, PORTA_PRODUCAO_DEV } from './cercas'
import { lerEstado, gravarEstado, EstadoCarga, LicenciadoCarga } from './estado'
import { binDir } from './mariadb-descartavel'

export const MOLDE = 'setes_setes'
const CARGA_CENTRAL = 'setes_central'                // o central SINTÉTICO da 3307 (o nome é o que o código do produto lê)
export const SCHEMA_VOLUME = 'setes_carga_volume'
export const NOTAS_VOLUME = 200_000
export const NOTAS_POR_LICENCIADO = 30                // suposição marcada (ficha §5): ~30 NFS-e/mês por cliente de serviço (§5.9)
export const SERIE_CARGA = '900'
const ID_USUARIO = (inst: number) => 100_000 + inst
const ID_TOMADOR = (inst: number) => 200_000 + inst

/** D-F258: as tabelas do molde que o caminho da nfse-api lê, mais as que as views do molde precisam. */
export const TABELAS_LICENCIADO: readonly string[] = Object.freeze([
  'tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_order', 'tb_service_order', 'tb_order_stock_adjust_return',
  'tb_entity_tax', 'tb_institution_has_interface', 'tb_user_has_privilege', 'tb_institution_has_config', 'tb_establishment_issuer',
  'tb_establishment_ibscbs_assessment',
])
export const VIEWS_MOLDE: readonly string[] = Object.freeze([
  'vw_invoice_life', 'vw_order_interface', 'vw_user_reach', 'vw_user_access', 'vw_establishment_ibscbs_assessment',
])
/** D-F256: os catálogos que vão COM DADOS (só leitura na 3306). */
export const CATALOGOS: readonly string[] = Object.freeze([
  'tb_state', 'tb_city', 'tb_interface', 'tb_privilege', 'tb_interface_has_privilege', 'tb_interface_has_config',
])
/** As listas que o harness ao vivo vigia na 3306 (`src/__tests__/live-harness.ts`: `ERP_WATCH`, `CENTRAL_WATCH`). */
const ERP_WATCH = ['tb_invoice', 'tb_invoice_event', 'tb_invoice_service', 'tb_establishment_issuer', 'tb_institution_has_interface',
  'tb_user_has_privilege', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']
const CENTRAL_WATCH = ['tb_institution', 'tb_company', 'tb_entity']

type Linha = Record<string, unknown>
const agora = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const log = (m: string) => console.log(`[semear ${new Date().toISOString().slice(11, 19)}] ${m}`)

// ---------------------------------------------------------------------------------------------------------------------------------
// LEITURA da 3306
// ---------------------------------------------------------------------------------------------------------------------------------
interface Leitura { ddlCentral: string[]; ddlLicenciado: string[]; ddlVolume: string[]; catalogos: Record<string, Linha[]> }

function donoDaProducao(raiz: string): { user: string; password: string } {
  const env = dotenv.parse(fs.readFileSync(path.resolve(raiz, '..', 'setes-api', '.env')))
  if (!env.DB_USER) throw new Error('../setes-api/.env sem DB_USER')
  return { user: env.DB_USER, password: env.DB_PASSWORD ?? '' }
}

function dump(dono: { user: string; password: string }, schema: string, objetos: readonly string[]): string[] {
  const args = ['-h127.0.0.1', `--port=${PORTA_PRODUCAO_DEV}`, `-u${dono.user}`, '--no-data', '--skip-triggers', '--skip-routines',
    '--single-transaction', '--skip-lock-tables', '--no-create-db', '--skip-comments', '--skip-add-drop-table', '--skip-tz-utc', schema, ...objetos]
  const out = execFileSync(path.join(binDir(), 'mysqldump.exe'), args, {
    env: { ...process.env, MYSQL_PWD: dono.password }, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8',
  })
  return comandosDoDump(out)
}

async function checksums(c: mysql.Connection): Promise<string> {
  const [fiscais] = await c.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'fiscal_api' AND table_type = 'BASE TABLE' ORDER BY table_name`) as any
  const alvos = [
    ...(fiscais as any[]).map(r => `fiscal_api.\`${r.t}\``),
    ...ERP_WATCH.map(t => `${MOLDE}.${t}`),
    ...[...CENTRAL_WATCH, ...CATALOGOS].map(t => `setes_central.${t}`),
  ]
  const [r] = await c.query(`CHECKSUM TABLE ${alvos.join(', ')}`)
  return JSON.stringify(r)
}

async function lerProducao(raiz: string): Promise<Leitura> {
  const dono = donoDaProducao(raiz)
  const c = await mysql.createConnection({ host: '127.0.0.1', port: PORTA_PRODUCAO_DEV, user: dono.user, password: dono.password })
  try {
    const [grants] = await c.query('SHOW GRANTS') as any
    const textoGrants = (grants as any[]).map(g => String(Object.values(g)[0])).join(' ')
    if (!/ALL PRIVILEGES ON \*\.\*|SHOW VIEW/.test(textoGrants)) throw new Error('O usuário dono não tem SHOW VIEW — o dump das views falharia (suposição da ficha §5)')
    const antes = await checksums(c)
    await c.query('START TRANSACTION READ ONLY')
    const catalogos: Record<string, Linha[]> = {}
    for (const t of CATALOGOS) {
      const [rows] = await c.query(`SELECT * FROM setes_central.\`${t}\``)
      catalogos[t] = rows as Linha[]
    }
    await c.query('COMMIT')
    const ddlCentral = dump(dono, 'setes_central', [])
    const ddlLicenciado = dump(dono, MOLDE, [...TABELAS_LICENCIADO, ...VIEWS_MOLDE])
    const ddlVolume = dump(dono, MOLDE, [])
    const depois = await checksums(c)
    if (antes !== depois) throw new Error('D-F255: CHECKSUM da 3306 mudou durante a leitura — a produção gravou no meio; rode o semear de novo')
    log(`3306 lida (só leitura, CHECKSUM igual antes e depois): central ${ddlCentral.length} comandos, licenciado ${ddlLicenciado.length}, volume ${ddlVolume.length}`)
    return { ddlCentral, ddlLicenciado, ddlVolume, catalogos }
  } finally {
    await c.end()
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ESCRITA na 3307
// ---------------------------------------------------------------------------------------------------------------------------------
async function conexaoCarga(raiz: string, e: EstadoCarga, database?: string): Promise<mysql.Connection> {
  assertPortaCarga(e.porta, portaDoEnvArquivo(raiz))
  const c = await mysql.createConnection({ host: '127.0.0.1', port: e.porta, user: 'root', password: '', database, multipleStatements: false })
  await c.query('SET SESSION foreign_key_checks = 0')
  return c
}

async function aplicarDdl(c: mysql.Connection, CARGA_SCHEMA: string, comandos: readonly string[], collation: string): Promise<void> {
  if (CARGA_SCHEMA !== CARGA_CENTRAL) assertSchemaCarga(CARGA_SCHEMA)
  await c.query(`CREATE DATABASE \`${CARGA_SCHEMA}\` CHARACTER SET utf8mb4 COLLATE ${collation}`)
  await c.query(`USE \`${CARGA_SCHEMA}\``)
  for (const cmd of comandos) {
    const sql = CARGA_SCHEMA === CARGA_CENTRAL ? reescreverSchema(cmd, CARGA_CENTRAL, CARGA_CENTRAL) : reescreverSchema(cmd, MOLDE, CARGA_SCHEMA)
    await c.query(sql)
  }
}

async function inserirEmBlocos(c: mysql.Connection, CARGA_SCHEMA: string, tabela: string, linhas: Linha[], bloco = 5000): Promise<void> {
  if (!linhas.length) return
  if (CARGA_SCHEMA !== CARGA_CENTRAL) assertSchemaCarga(CARGA_SCHEMA)
  const cols = Object.keys(linhas[0])
  for (let i = 0; i < linhas.length; i += bloco) {
    const parte = linhas.slice(i, i + bloco).map(l => cols.map(k => l[k]))
    await c.query(`INSERT INTO \`${CARGA_SCHEMA}\`.\`${tabela}\` (${cols.map(k => `\`${k}\``).join(', ')}) VALUES ?`, [parte])
  }
}

/** A1 sintético (receita de `pfxFor`, adversarial-f1.live.test.ts:781) com a chave RSA 1024 gerada pelo `crypto` (rápido). */
function pfxSintetico(nome: string, cnpj: string, senha: string): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const prv = forge.pki.privateKeyFromPem(String(privateKey.export({ type: 'pkcs1', format: 'pem' })))
  const pub = forge.pki.publicKeyFromPem(String(publicKey.export({ type: 'spki', format: 'pem' })))
  const cert = forge.pki.createCertificate()
  cert.publicKey = pub
  cert.serialNumber = '01' + cnpj
  cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: `${nome}:${cnpj}` }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(prv, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(prv, [cert], senha, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
}

interface Catalogo { cidade: { id: number; stateId: number; countryId: number; ibge: string }; serviceOrders: number }

function lerCatalogo(cat: Record<string, Linha[]>): Catalogo {
  const ibgeOk = (v: unknown) => typeof v === 'string' && /^[0-9]{7}$/.test(v)
  const city = cat.tb_city.find(r => ibgeOk(r.ibge) && r.deleted === 'N')
  if (!city) throw new Error('catálogo de cidades sem IBGE de 7 dígitos')
  const state = cat.tb_state.find(s => s.id === city.tb_state_id)
  const so = cat.tb_interface.find(i => i.i18n_key === 'service-orders' && i.deleted === 'N')
  if (!state || !so) throw new Error('catálogo sem o estado da cidade ou sem a interface service-orders')
  return { cidade: { id: Number(city.id), stateId: Number(state.id), countryId: Number(state.tb_country_id), ibge: String(city.ibge) }, serviceOrders: Number(so.id) }
}

/** O lado ERP de uma nota de serviço pendente (nota + vida E + ramo + pedido de OS). */
function notaErp(inst: number, id: number, userId: number, tomador: number, cityId: number, dia: string, ts: string) {
  const value = 100 + (id % 900)
  return {
    invoice: { id, tb_institution_id: inst, terminal: WEB_TERMINAL, issuer: inst, number: String(id), serie: '1', tb_entity_id: tomador,
      dt_emission: dia, value, model: 'SE', status: 'F', created_at: ts, updated_at: ts, deleted: 'N' },
    event: { tb_institution_id: inst, tb_invoice_id: id, terminal: WEB_TERMINAL, event: 1, kind: 'E', dt_record: dia, number: String(id),
      serie: '1', model: 'SE', value, tb_user_id: userId, created_at: ts, updated_at: ts, deleted: 'N' },
    service: { id, tb_institution_id: inst, terminal: WEB_TERMINAL, total_value: value, tb_service_list_id: '01.07', national_code: '010701',
      municipal_code: null, tb_city_id: cityId, base_iss_value: value, aliq_iss: 2, iss_value: Math.round(value * 2) / 100, iss_withheld: 'N',
      liability: '1', description: 'Serviço sintético da carga', created_at: ts, updated_at: ts, deleted: 'N' },
    order: { id, tb_institution_id: inst, terminal: WEB_TERMINAL, tb_user_id: userId, dt_record: dia, status: 'F', created_at: ts, updated_at: ts, deleted: 'N' },
    serviceOrder: { id, tb_institution_id: inst, terminal: WEB_TERMINAL, number: id, created_at: ts, updated_at: ts, deleted: 'N' },
  }
}

async function semearNotasErp(c: mysql.Connection, CARGA_SCHEMA: string, inst: number, ids: number[], userId: number, cityId: number,
  diaDe: (id: number) => string): Promise<void> {
  const ts = agora()
  const linhas = ids.map(id => notaErp(inst, id, userId, ID_TOMADOR(inst), cityId, diaDe(id), ts))
  await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_invoice', linhas.map(l => l.invoice))
  await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_invoice_event', linhas.map(l => l.event))
  await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_invoice_service', linhas.map(l => l.service))
  await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_order', linhas.map(l => l.order))
  await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_service_order', linhas.map(l => l.serviceOrder))
}

/** Situação sintética da nota i do volume — suposição marcada (ficha §5 item 6). */
export function situacaoVolume(i: number): 'A' | 'C' | 'R' | 'voo' | 'pendente' {
  const r = i % 100
  return r < 85 ? 'A' : r < 90 ? 'C' : r < 94 ? 'R' : r < 97 ? 'voo' : 'pendente'
}

export function dpsIdDe(ibge: string, cnpj: string, serie: string, n: number): string {
  return `DPS${ibge}2${cnpj}${serie.padStart(5, '0')}${String(n).padStart(15, '0')}`
}
/** Chave de acesso na forma geral (cMun 7 · amb 1 · tpInsc 1 · CNPJ 14 · nNFSe 13 · AAMM 4 · código 9 · DV 1). */
export function chaveDe(ibge: string, cnpj: string, nNfse: number, aamm: string, codigo: number): string {
  return `${ibge}12${cnpj}${String(nNfse).padStart(13, '0')}${aamm}${String(codigo).padStart(9, '0')}0`
}

async function paralelo<T>(itens: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let k = 0
  await Promise.all(Array.from({ length: n }, async () => { while (k < itens.length) await f(itens[k++]) }))
}

export async function semear(raiz: string, n: number): Promise<EstadoCarga> {
  const e = lerEstado(raiz)
  if (e.semeadoEm) throw new Error('Esta instância já foi semeada — derrube e suba de novo para outra semeadura')
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error(`--licenciados inválido: ${n}`)
  const tempos: Record<string, number> = {}
  const marca = (k: string, t0: number) => { tempos[k] = Math.round((Date.now() - t0) / 1000) }

  let t0 = Date.now()
  const leitura = await lerProducao(raiz)
  marca('leitura_3306_s', t0)
  const cat = lerCatalogo(leitura.catalogos)

  // ---- estrutura + catálogos + central sintético
  t0 = Date.now()
  const c = await conexaoCarga(raiz, e)
  const licenciados: LicenciadoCarga[] = []
  let volume: LicenciadoCarga
  try {
    await aplicarDdl(c, CARGA_CENTRAL, leitura.ddlCentral, 'utf8mb4_general_ci')
    for (const t of CATALOGOS) {
      // colunas GERADAS do destino (ex.: tb_interface.i18n_key_live, sql/77 do setes-api) não recebem valor explícito
      const [geradas] = await c.query(`SELECT column_name AS c FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND extra LIKE '%GENERATED%'`, [CARGA_CENTRAL, t]) as any
      await inserirEmBlocos(c, CARGA_CENTRAL, t, semColunas(leitura.catalogos[t], new Set((geradas as any[]).map(g => String(g.c)))))
    }
    for (let k = 1; k <= n; k++) {
      licenciados.push({ institutionId: k + 1, schema: `setes_carga_${String(k).padStart(4, '0')}`, cnpj: cnpjSintetico(k + 1), userId: ID_USUARIO(k + 1), tomadorId: ID_TOMADOR(k + 1), notas: NOTAS_POR_LICENCIADO })
    }
    volume = { institutionId: n + 2, schema: SCHEMA_VOLUME, cnpj: cnpjSintetico(n + 2), userId: ID_USUARIO(n + 2), tomadorId: ID_TOMADOR(n + 2), notas: NOTAS_VOLUME }
    const todos = [...licenciados, volume]
    const ts = agora()
    const entidades: Linha[] = [{ id: 1, name_company: 'SETES (CARGA)', nick_trade: 'SETES', created_at: ts, updated_at: ts, deleted: 'N' }]
    const empresas: Linha[] = [{ id: 1, cnpj: cnpjSintetico(1), created_at: ts, updated_at: ts, deleted: 'N' }]
    const instituicoes: Linha[] = [{ id: 1, schema_name: 'setes_carga_setes', active: 'S', created_at: ts, updated_at: ts, deleted: 'N' }]
    const enderecos: Linha[] = []
    const usuarios: Linha[] = []
    const vinculos: Linha[] = []
    const endereco = (id: number) => ({ id, kind: 'COMERCIAL', street: 'Rua da Carga', nmbr: '1', neighborhood: 'Centro', zip_code: '87000000',
      tb_country_id: cat.cidade.countryId, tb_state_id: cat.cidade.stateId, tb_city_id: cat.cidade.id, main: 'S', created_at: ts, updated_at: ts, deleted: 'N' })
    for (const l of todos) {
      entidades.push({ id: l.institutionId, name_company: `EMITENTE CARGA ${l.institutionId}`, nick_trade: `CARGA ${l.institutionId}`, created_at: ts, updated_at: ts, deleted: 'N' })
      empresas.push({ id: l.institutionId, cnpj: l.cnpj, im: String(l.institutionId), created_at: ts, updated_at: ts, deleted: 'N' })
      instituicoes.push({ id: l.institutionId, schema_name: l.schema, active: 'S', created_at: ts, updated_at: ts, deleted: 'N' })
      enderecos.push(endereco(l.institutionId))
      entidades.push({ id: l.userId, name_company: `ADMIN CARGA ${l.institutionId}`, nick_trade: '', created_at: ts, updated_at: ts, deleted: 'N' })
      usuarios.push({ id: l.userId, active: 'S', created_at: ts, updated_at: ts, deleted: 'N' })
      vinculos.push({ tb_institution_id: l.institutionId, tb_user_id: l.userId, kind: 'admin', active: 'S', created_at: ts, updated_at: ts, deleted: 'N' })
      entidades.push({ id: l.tomadorId, name_company: `TOMADOR CARGA ${l.institutionId}`, nick_trade: '', created_at: ts, updated_at: ts, deleted: 'N' })
      empresas.push({ id: l.tomadorId, cnpj: cnpjSintetico(500_000 + l.institutionId), created_at: ts, updated_at: ts, deleted: 'N' })
    }
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_entity', entidades)
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_company', empresas)
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_institution', instituicoes)
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_address', enderecos)
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_user', usuarios)
    await inserirEmBlocos(c, CARGA_CENTRAL, 'tb_institution_has_user', vinculos)
    marca('central_s', t0)

    // ---- schemas dos licenciados (D-F258) e do volume
    t0 = Date.now()
    const hoje = ts.slice(0, 10)
    for (const l of todos) {
      const CARGA_SCHEMA = l.schema
      await aplicarDdl(c, CARGA_SCHEMA, l === volume ? leitura.ddlVolume : leitura.ddlLicenciado, 'utf8mb4_general_ci')
      await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_institution_has_interface', [{ tb_institution_id: l.institutionId, tb_interface_id: cat.serviceOrders, active: 'S', created_at: ts, updated_at: ts, deleted: 'N' }])
      await inserirEmBlocos(c, CARGA_SCHEMA, 'tb_entity_tax', [{ id: l.institutionId, tb_institution_id: l.institutionId, simples_regime: '3', simples_assessment: '1',
        simples_total_tax_aliquot: 6, special_tax_regime: '0', created_at: ts, updated_at: ts, deleted: 'N' }])
      const ids = Array.from({ length: l.notas }, (_, i) => i + 1)
      const diaDe = l === volume ? (id: number) => new Date(Date.now() - (id % 730) * 86_400_000).toISOString().slice(0, 10) : () => hoje
      await semearNotasErp(c, CARGA_SCHEMA, l.institutionId, ids, l.userId, cat.cidade.id, diaDe)
      if (l.institutionId % 100 === 0) log(`schemas: ${l.institutionId - 1}/${todos.length}`)
    }
    marca('schemas_s', t0)

    // ---- usuário do serviço na 3307 (as seções 1 e 1a de ops/grants.sql, com o nome do banco de carga)
    for (const sql of grantsDaCarga(raiz, e)) await c.query(sql)
  } finally {
    await c.end()
  }

  // ---- fiscal_api_carga: migrations, habilitação SE e A1 pelas peças do núcleo
  t0 = Date.now()
  const cfg = { host: '127.0.0.1', port: e.porta, user: 'root', password: '', database: e.fiscalDb, connectionLimit: 16 } as any
  await runMigrations(cfg, MIGRATION_SETS)
  const pool = createFiscalPool(cfg)
  const keyring = MasterKeyRing.of({ 1: Buffer.from(e.masterKeyB64, 'base64') })
  try {
    // UM de cada vez: em paralelo, o `writeIssuer` de estabelecimentos DIFERENTES entra em deadlock (gap lock do upsert em REPEATABLE READ)
    // além das 2 novas tentativas do núcleo — achado do passo registrado na árvore (2026-11-20)
    await paralelo([...licenciados, volume!], 1, async l => {
      const actor = { institutionId: l.institutionId, userId: l.userId, schemaName: l.schema }
      await writeIssuer({ pool, keyring }, actor, 'SE', { environment: 'H', serie: SERIE_CARGA })
      const pfx = pfxSintetico(`EMITENTE CARGA ${l.institutionId}`, l.cnpj, 'carga')
      await storeCertificate({ pool, keyring }, l.institutionId, pfx, 'carga', {
        expectedCnpj: (await erp.establishmentCnpj(pool, l.institutionId)) ?? await erp.establishmentCnpjFact(pool, l.institutionId), userId: l.userId, schemaName: l.schema,
      })
    })
    marca('habilitacoes_a1_s', t0)

    // ---- histórico fiscal do volume
    t0 = Date.now()
    await semearHistoricoVolume(pool, volume!, cat.cidade.ibge)
    marca('historico_volume_s', t0)
  } finally {
    await pool.end()
  }
  const novo: EstadoCarga = { ...e, semeadoEm: new Date().toISOString(), licenciados, volume: volume!, tempos }
  gravarEstado(raiz, novo)
  log(`pronto: ${n} licenciados + volume; tempos ${JSON.stringify(tempos)}`)
  return novo
}

/** As seções 1 e 1a de `ops/grants.sql` (lidas do arquivo — ficam em sincronia), com o banco e a senha de carga. */
export function grantsDaCarga(raiz: string, e: Pick<EstadoCarga, 'fiscalDb' | 'fiscalPassword'>): string[] {
  const texto = fs.readFileSync(path.join(raiz, 'ops', 'grants.sql'), 'utf8')
  const fim = texto.indexOf('-- (MySQL 8 apenas')
  const corpo = (fim > 0 ? texto.slice(0, fim) : texto).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
  return corpo.split(';').map(s => s.trim()).filter(s => /^(CREATE USER|GRANT|REVOKE)\b/.test(s))
    .map(s => s.split('`fiscal_api`.*').join(`\`${e.fiscalDb}\`.*`).split('<SENHA_FISCAL_API>').join(e.fiscalPassword))
}

async function semearHistoricoVolume(pool: any, v: LicenciadoCarga, ibge: string): Promise<void> {
  const dps: Linha[] = [], tx: Linha[] = []
  const vozes: { id: number; kind: 'A' | 'C' | 'R'; dh: string }[] = []
  for (let i = 1; i <= v.notas; i++) {
    const s = situacaoVolume(i)
    if (s === 'pendente') continue
    const quando = new Date(Date.now() - (i % 730) * 86_400_000)
    const dh = quando.toISOString().slice(0, 19).replace('T', ' ')
    const aamm = quando.toISOString().slice(2, 4) + quando.toISOString().slice(5, 7)
    const temChave = s === 'A' || s === 'C'
    dps.push({ tb_institution_id: v.institutionId, tb_invoice_id: i, terminal: WEB_TERMINAL, life_event: 1, serie: SERIE_CARGA, dps_number: i,
      dps_id: dpsIdDe(ibge, v.cnpj, SERIE_CARGA, i), tb_user_id: v.userId, created_at: dh, updated_at: dh, deleted: 'N' })
    tx.push({ tb_institution_id: v.institutionId, tb_invoice_id: i, terminal: WEB_TERMINAL, attempt: 1, life_event: 1, environment: 'H',
      access_key: temChave ? chaveDe(ibge, v.cnpj, 9_000_000_000_000 + i, aamm, i) : null,
      nfse_number: temChave ? String(9_000_000_000_000 + i) : null, dh_proc: temChave ? dh : null, last_queried_at: dh,
      tb_user_id: v.userId, created_at: dh, updated_at: dh, deleted: 'N' })
    if (s !== 'voo') vozes.push({ id: i, kind: s, dh })
  }
  const conn = await pool.getConnection()
  try {
    for (const [t, linhas] of [['tb_invoice_service_dps', dps], ['tb_invoice_service_transmission', tx]] as const) {
      const cols = Object.keys(linhas[0])
      for (let k = 0; k < linhas.length; k += 5000) {
        await conn.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES ?`, [linhas.slice(k, k + 5000).map(l => cols.map(c => l[c]))])
      }
    }
    await conn.query('UPDATE tb_establishment_issuer SET dps_last_number = ? WHERE tb_institution_id = ? AND model = ?', [v.notas, v.institutionId, 'SE'])
  } finally {
    conn.release()
  }
  log(`volume: ${dps.length} DPS e tentativas; ${vozes.length} vozes pelo escritor tipado…`)
  const who = { schemaName: v.schema, institutionId: v.institutionId }
  let feitas = 0
  await paralelo(vozes, 8, async x => {
    const ref = invoiceRef(v.institutionId, x.id, WEB_TERMINAL)
    await withInvoiceTx(pool, who, ref, { label: 'carga: voz do volume', lock: erp.lockInvoice }, async itx => {
      if (x.kind === 'R') {
        await insertTransmissionEvent(itx, 1, v.userId, { kind: 'R', source: 'P', authorityCode: 'E0001', message: 'rejeição sintética da carga', dh: x.dh })
        return
      }
      await insertTransmissionEvent(itx, 1, v.userId, { kind: 'A', source: 'P', dh: x.dh })
      if (x.kind === 'C') await insertTransmissionEvent(itx, 1, v.userId, { kind: 'C', source: 'P', authorityCode: '101101', message: 'cancelamento sintético da carga', dh: x.dh })
    })
    if (++feitas % 20_000 === 0) log(`volume: ${feitas}/${vozes.length} vozes`)
  })
}
