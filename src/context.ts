import {
  Pool, createFiscalPool, dbConfigFromEnv, FiscalDbConfig, MasterKeyRing, ProductTokenVerifier, FsFiscalStorage, fiscalStorageRootFromEnv,
} from 'fiscal-api'
import type { NfseDeps } from './nfse/transmission'
import type { TaxAuthorityAdapter } from './authority/types'
import { adnAdapter } from './authority/adn'

/**
 * Dependências do serviço (montadas UMA vez no boot; os testes montam as suas). Nada de estado de
 * CONTROLE aqui — só recursos (pool, anel de chaves, storage, verificador do JWT, adaptador).
 */
export interface AppContext extends NfseDeps {
  db:          FiscalDbConfig
  verifier:    ProductTokenVerifier
  corsOrigins: string[]
  /** Confere no banco que o schema do token é o da institution (defesa em profundidade). */
  checkIdentity: boolean
}

/**
 * D-F39: a CERCA DA VIRADA deixou de ser configuração — é FATO na habilitação (`cutover_at`, migration 003 do núcleo).
 * A variável antiga ainda definida = configuração velha que passaria a não significar nada em silêncio: o boot FALHA.
 */
export function assertRetiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FISCAL_LEGACY_INSTITUTIONS !== undefined) {
    throw new Error('FISCAL_LEGACY_INSTITUTIONS foi APOSENTADA (D-F39): a virada agora é o fato `cutover_at` na habilitação do fiscal_api — remova a variável')
  }
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppContext> = {}): AppContext {
  assertRetiredEnv(env)
  const db = dbConfigFromEnv(env)
  const pool: Pool = overrides.pool ?? createFiscalPool(db)
  const adapter: TaxAuthorityAdapter = overrides.adapter ?? adnAdapter
  return {
    db,
    pool,
    keyring:  overrides.keyring ?? MasterKeyRing.fromEnv(env),
    storage:  overrides.storage ?? new FsFiscalStorage(fiscalStorageRootFromEnv(env)),   // D-F241: produção exige STORAGE_PATH absoluto
    adapter,
    fiscalDb: db.database,
    verifier: overrides.verifier ?? ProductTokenVerifier.fromEnv(env),
    corsOrigins: overrides.corsOrigins ?? String(env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    checkIdentity: overrides.checkIdentity ?? true,
  }
}
