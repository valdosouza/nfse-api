import type { RequestHandler } from 'express'
import type { AppContext } from './context'
import type { KeyProof } from './key-proof'

/**
 * /v1/health (sem autenticação): prova banco, chave-mestra e storage — critério §12.8-1. 200 só com os três; 503 diz qual falhou
 * (nunca conteúdo, nunca qual versão).
 *
 * Chave-mestra (D-F243/D-F244/D-F245 — DEPLOY.E2.P3): o sinal é o último resultado da `KeyProof`, que abre UM segredo guardado (A1 ou senha SMTP) por versão em
 * uso na partida e a cada 5 minutos. Chamar o health NÃO abre certificado nenhum (o endereço é aberto e o monitor chama a cada poucos
 * segundos). Segredo ilegível com a chave certa (`degraded`) não aparece aqui: vai para o log e para o alarme.
 */
export function healthHandler(ctx: AppContext, keyProof: KeyProof): RequestHandler {
  return async (_req, res) => {
    let db = false
    try { await ctx.pool.query('SELECT 1 FROM tb_establishment_issuer LIMIT 1'); db = true } catch { db = false }
    const masterKey = keyProof.masterKey
    const storage = ctx.storage.probe()
    const ok = db && masterKey && storage
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, masterKey, storage })
  }
}
