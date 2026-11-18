// DEPLOY.E1.P3.T2 (D-F241, 2026-11-18 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p3-adocao-pacote-2-0-0.md` no Vault): leva os XMLs
// gravados no layout ANTIGO (`<raiz>/<cnpj>/[H/]<ano>/<mês>/<nome>`, herdado do setes-api — D-F16) para o layout do pacote 2.0.0
// (`<raiz>/<cnpj>/[H/]nfse/<série da DPS>/<ano>/<mês>/<dia>/<nome>`). A série e o dia vêm do BANCO (a chave da NFS-e não leva a série):
// quem os acha é o RESOLVEDOR injetado (o do script lê o fiscal_api; os testes passam um falso).
//
// Regras (a ficha §6 item 4):
//  - só o layout antigo: pasta de CNPJ (14 posições), `H/` opcional, ano de 4 e mês de 2 dígitos, arquivo `.xml`;
//  - o CNPJ e o ambiente são os da pasta antiga (o layout novo não muda nenhum dos dois);
//  - o dia é o de um instante do banco, NA ZONA do estabelecimento, que caia no MESMO ano/mês da pasta antiga — senão o arquivo FICA;
//  - destino que já existe: mesmo sha256 = só apaga o antigo; diferente = conflito, FICA (nunca sobrescreve);
//  - depois do `save` o destino é RELIDO e conferido por sha256 com o original; só então o antigo é apagado;
//  - ENSAIO (`apply: false`) não grava nem apaga nada. Rodar de novo depois de aplicar não muda nada (não sobra layout antigo).
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { FiscalStorage, FiscalFileEnvironment } from 'fiscal-api'
import { nfseFileKey } from './transmission'

export type XmlFileKind = 'nfse' | 'event' | 'dps'

export interface OldLayoutFile {
  file: string
  cnpj: string
  environment: FiscalFileEnvironment
  year: string
  month: string
  name: string
  kind: XmlFileKind
  /** a chave de acesso (NFS-e, evento) ou o Id do DPS */
  ref: string
}

/** O que o banco sabe do arquivo: a série da DPS, os instantes (UTC do banco, 'YYYY-MM-DD HH:MM:SS') e a zona do estabelecimento. */
export interface XmlFacts {
  serie: string
  instants: string[]
  zone: string
}

export interface XmlFactsResolver {
  byAccessKey(cnpj: string, accessKey: string): Promise<XmlFacts | null>
  byDpsId(cnpj: string, dpsId: string): Promise<XmlFacts | null>
}

export interface MigrationReport {
  /** ensaio: o que seria movido; aplicado: o que foi movido (antigo → novo) */
  moved: { from: string; to: string | null; serie: string; day: string }[]
  /** o destino já existia com o mesmo conteúdo: o antigo sai (aplicado) */
  alreadyThere: { from: string; to: string }[]
  /** ficou onde está, com o motivo */
  kept: { from: string; reason: string }[]
}

const CNPJ_DIR = /^[0-9A-Z]{12}[0-9]{2}$/
const YEAR = /^\d{4}$/
const MONTH = /^(0[1-9]|1[0-2])$/

function kindOf(name: string): { kind: XmlFileKind; ref: string } | null {
  let m = /^(.+)-nfse\.xml$/.exec(name)
  if (m) return { kind: 'nfse', ref: m[1] }
  m = /^(.+)-evt101101\.xml$/.exec(name)
  if (m) return { kind: 'event', ref: m[1] }
  m = /^(DPS[0-9A-Z]+)-dps\.xml$/.exec(name)
  if (m) return { kind: 'dps', ref: m[1] }
  return null
}

const dirs = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [])

/**
 * Arquivos no layout ANTIGO debaixo da raiz. Gate adversarial (M2): TUDO debaixo de cada pasta de CNPJ que não seja o layout novo
 * (`[H/]nfse/`) aparece — o que não é `[H/]<aaaa>/<mm>/<nome conhecido>` (mês sem zero, `.XML`, arquivo fora do mês, atalho/junção…)
 * vem em `unknown` e o relatório o lista como "fica": nada fica para trás calado. Atalho/junção nunca é seguido.
 */
export function scanOldLayout(root: string): { files: OldLayoutFile[]; unknown: string[] } {
  const files: OldLayoutFile[] = []
  const unknown: string[] = []
  const walk = (cnpj: string, rel: string[]): void => {
    const dir = path.join(root, cnpj, ...rel)
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const parts = [...rel, e.name]
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const isNew = (parts.length === 1 && e.name === 'nfse') || (parts.length === 2 && parts[0] === 'H' && e.name === 'nfse')
        if (!isNew) walk(cnpj, parts)
        continue
      }
      // [H/]<aaaa>/<mm>/<nome>
      const env = parts[0] === 'H' ? 'H' : 'P'
      const p = env === 'H' ? parts.slice(1) : parts
      const k = e.isFile() && p.length === 3 && YEAR.test(p[0]) && MONTH.test(p[1]) ? kindOf(p[2]) : null
      if (!k) { unknown.push(full); continue }
      files.push({ file: full, cnpj, environment: env, year: p[0], month: p[1], name: p[2], ...k })
    }
  }
  for (const cnpj of dirs(root).filter(d => CNPJ_DIR.test(d)).sort()) walk(cnpj, [])
  return { files, unknown }
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')

/** Data de parede (ano, mês, dia) de um instante na zona. */
function wallDate(at: Date, zone: string): { y: string; m: string; d: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: string) => parts.find(p => p.type === t)!.value
  return { y: get('year'), m: get('month'), d: get('day') }
}

const fromDbUtc = (s: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function removeEmptyUpwards(dir: string, stop: string): void {
  let cur = dir
  while (cur.startsWith(stop) && cur !== stop) {
    if (fs.readdirSync(cur).length) return
    fs.rmdirSync(cur)
    cur = path.dirname(cur)
  }
}

export interface MigrationOptions {
  root: string
  storage: FiscalStorage
  resolver: XmlFactsResolver
  apply: boolean
}

/** Dentro da raiz DESTE ambiente (`<raiz>/<cnpj>/[H/]nfse/`), pelo caminho REAL (junção/atalho que aponte para fora não vale). */
function insideEnvRoot(file: string, root: string, cnpj: string, env: FiscalFileEnvironment): boolean {
  const envRoot = path.join(root, cnpj, ...(env === 'H' ? ['H'] : []), 'nfse')
  if (!fs.existsSync(envRoot)) return false                 // a raiz deste ambiente ainda não existe: nada está dentro dela
  const base = fs.realpathSync(envRoot)
  const real = fs.realpathSync(file)
  return real.startsWith(base + path.sep)
}

async function migrateOne(f: OldLayoutFile, opts: MigrationOptions, report: MigrationReport): Promise<void> {
  let facts: XmlFacts | null
  try {
    facts = f.kind === 'dps' ? await opts.resolver.byDpsId(f.cnpj, f.ref) : await opts.resolver.byAccessKey(f.cnpj, f.ref)
  } catch (err) {
    report.kept.push({ from: f.file, reason: `banco: ${err instanceof Error ? err.message : String(err)}` }); return
  }
  if (!facts) { report.kept.push({ from: f.file, reason: 'sem linha no banco para este CNPJ (ou mais de um estabelecimento)' }); return }

  // o dia: o 1º instante do banco que, na zona, cai no mês da pasta antiga
  let when: Date | null = null
  let day = ''
  for (const s of facts.instants) {
    const at = fromDbUtc(s)
    if (!at) continue
    const w = wallDate(at, facts.zone)
    if (w.y === f.year && w.m === f.month) { when = at; day = `${w.y}-${w.m}-${w.d}`; break }
  }
  if (!when) { report.kept.push({ from: f.file, reason: `nenhum instante do banco cai em ${f.year}-${f.month} na zona ${facts.zone}` }); return }

  const key = nfseFileKey(f.cnpj, facts.serie, f.environment, facts.zone)
  const original = fs.readFileSync(f.file)
  let existing: string | null
  try {
    existing = opts.storage.find(key, f.name, [when])
  } catch (err) {
    report.kept.push({ from: f.file, reason: `série/busca: ${err instanceof Error ? err.message : String(err)}` }); return
  }
  // gate adversarial (L1): o `find` de H também olha P — só conta o que está na raiz DESTE ambiente
  if (existing && !insideEnvRoot(existing, opts.root, f.cnpj, f.environment)) existing = null
  if (existing) {
    if (sha256(fs.readFileSync(existing)) !== sha256(original)) {
      report.kept.push({ from: f.file, reason: `conflito: ${existing} já existe com outro conteúdo` }); return
    }
    if (opts.apply) { fs.unlinkSync(f.file); removeEmptyUpwards(path.dirname(f.file), path.join(opts.root, f.cnpj)) }
    report.alreadyThere.push({ from: f.file, to: existing }); return
  }
  if (!opts.apply) { report.moved.push({ from: f.file, to: null, serie: facts.serie, day }); return }

  // o `save` grava texto UTF-8: o conteúdo só sai do antigo se o destino tiver EXATAMENTE os mesmos bytes
  const text = original.toString('utf8')
  if (sha256(Buffer.from(text, 'utf8')) !== sha256(original)) {
    report.kept.push({ from: f.file, reason: 'o arquivo não é UTF-8 válido (os bytes mudariam ao gravar)' }); return
  }
  let to: string
  try {
    to = opts.storage.save(key, f.name, text, when)
  } catch (err) {
    report.kept.push({ from: f.file, reason: `gravação: ${err instanceof Error ? err.message : String(err)}` }); return
  }
  // gate adversarial (L3): o destino tem de estar DENTRO da raiz pelo caminho real (junção para fora = o XML sairia do backup)
  if (!insideEnvRoot(to, opts.root, f.cnpj, f.environment)) {
    report.kept.push({ from: f.file, reason: `conferência: ${to} está fora da raiz pelo caminho real — o antigo fica` }); return
  }
  if (sha256(fs.readFileSync(to)) !== sha256(original)) {
    report.kept.push({ from: f.file, reason: `conferência: ${to} não tem os mesmos bytes — o antigo fica` }); return
  }
  fs.unlinkSync(f.file)
  removeEmptyUpwards(path.dirname(f.file), path.join(opts.root, f.cnpj))
  report.moved.push({ from: f.file, to, serie: facts.serie, day })
}

export async function migrateXmlLayout(opts: MigrationOptions): Promise<MigrationReport> {
  const report: MigrationReport = { moved: [], alreadyThere: [], kept: [] }
  const { files, unknown } = scanOldLayout(opts.root)
  for (const f of unknown) report.kept.push({ from: f, reason: 'fora do layout antigo ou nome que não é de NFS-e, evento 101101 nem DPS' })

  for (const f of files) {
    // gate adversarial (L2): um erro de E/S num arquivo (apagado no meio, travado, zona inválida) não aborta a corrida — ele FICA
    try { await migrateOne(f, opts, report) } catch (err) {
      report.kept.push({ from: f.file, reason: `erro: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return report
}
