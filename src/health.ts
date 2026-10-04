import type { RequestHandler } from 'express'
import { storedKeyVersions } from 'fiscal-api'
import type { AppContext } from './context'

/**
 * /v1/health (sem autenticação): prova banco, chave-mestra (cifra e decifra um vetor E todas as versões
 * que cifram A1 vivo estão no anel — rotação mal feita aparece aqui, não na 1ª emissão) e storage —
 * critério §12.8-1. 200 só com os três; 503 diz qual falhou (nunca conteúdo, nunca qual versão).
 */
export function healthHandler(ctx: AppContext): RequestHandler {
  return async (_req, res) => {
    let db = false
    try { await ctx.pool.query('SELECT 1 FROM tb_establishment_issuer LIMIT 1'); db = true } catch { db = false }
    let masterKey = ctx.keyring.selfTest()
    if (masterKey && db) {
      try { masterKey = (await storedKeyVersions(ctx.pool)).every(v => ctx.keyring.hasVersion(v)) } catch { masterKey = false }
    }
    const storage = ctx.storage.probe()
    const ok = db && masterKey && storage
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, masterKey, storage })
  }
}
