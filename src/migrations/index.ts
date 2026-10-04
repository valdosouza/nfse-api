import path from 'path'
import { CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT, MigrationSet } from 'fiscal-api'

/** Migrations da FAMÍLIA NFS-e (D-F35) — resolve igual de src/ (tsx) e dist/ (node). */
export const NFSE_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'migrations', 'sql')
export const NFSE_MIGRATIONS_PROJECT = 'nfse-api'

/** Ordem: núcleo primeiro (certificado + habilitação), depois a família. */
export const MIGRATION_SETS: MigrationSet[] = [
  { project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR },
  { project: NFSE_MIGRATIONS_PROJECT, dir: NFSE_MIGRATIONS_DIR },
]
