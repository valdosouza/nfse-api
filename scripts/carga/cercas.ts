/**
 * DEPLOY.E3.P1 (D-F255, D-F257) — as CERCAS da carga. Módulo PURO (o `.env` é lido só quando a função é chamada, e sem carregar).
 * A 3306 é o MariaDB que emite a produção da Setes: nenhuma conexão de ESCRITA da carga e nenhuma instância da carga vai a ela.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'

export const PORTA_PRODUCAO_DEV = 3306
export const MARCADOR = '.nfse-carga'
const PREFIXO_PASTA = 'nfse-carga-'
const SCHEMA_CARGA = /^setes_carga_[a-z0-9_]+$/

/** A porta do `DB_PORT` do arquivo `.env` do projeto (lido sem carregar no ambiente); null se não houver. */
export function portaDoEnvArquivo(raiz: string): number | null {
  const f = path.join(raiz, '.env')
  if (!fs.existsSync(f)) return null
  const v = Number(dotenv.parse(fs.readFileSync(f)).DB_PORT)
  return Number.isInteger(v) && v > 0 ? v : null
}

/** Porta de ESCRITA (ou de instância) da carga: nunca a 3306, nunca a do `.env`. */
export function assertPortaCarga(porta: number, portaEnv: number | null): void {
  if (!Number.isInteger(porta) || porta <= 0) throw new Error(`porta inválida: ${porta}`)
  if (porta === PORTA_PRODUCAO_DEV) throw new Error('D-F255: a carga não escreve na porta 3306 (o MariaDB que emite a produção da Setes)')
  if (portaEnv !== null && porta === portaEnv) throw new Error(`D-F255: a carga não escreve na porta do .env (${portaEnv})`)
}

/** A pasta descartável: dentro de `os.tmpdir()`, com o prefixo da carga. */
export function assertPastaCarga(pasta: string, exigeMarcador: boolean, tmp: string = os.tmpdir()): void {
  const abs = path.resolve(pasta)
  const rel = path.relative(path.resolve(tmp), abs)
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !path.basename(abs).startsWith(PREFIXO_PASTA)) {
    throw new Error(`D-F255: a pasta da carga tem de ser ${path.join(tmp, PREFIXO_PASTA + '*')} (veio ${abs})`)
  }
  if (exigeMarcador && !fs.existsSync(path.join(abs, MARCADOR))) {
    throw new Error(`D-F255: ${abs} não foi criada pela carga (sem ${MARCADOR}) — recuso apagar ou usar`)
  }
}

/** O armazenamento das instâncias fica DENTRO da pasta descartável (nunca o STORAGE_PATH do dev). */
export function assertStorageNaPasta(storage: string, pasta: string): void {
  const rel = path.relative(path.resolve(pasta), path.resolve(storage))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`D-F255: STORAGE_PATH fora da pasta da carga: ${storage}`)
}

/** D-F257: as escritas no ERP sintético só em `setes_carga_*`. */
export function assertSchemaCarga(schema: string): void {
  if (!SCHEMA_CARGA.test(schema)) throw new Error(`D-F257: escrita só em schema setes_carga_* (veio ${schema})`)
}

export function nomePastaNova(carimbo: string, tmp: string = os.tmpdir()): string {
  if (!/^[a-z0-9-]+$/.test(carimbo)) throw new Error(`carimbo inválido: ${carimbo}`)
  return path.join(tmp, PREFIXO_PASTA + carimbo)
}
