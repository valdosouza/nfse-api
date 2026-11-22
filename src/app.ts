import fs from 'fs'
import path from 'path'
import express, { Express } from 'express'
import swaggerUi from 'swagger-ui-express'
import YAML from 'yaml'
import { corsFor, productAuth, errorMiddleware, access } from 'fiscal-api'
import type { AppContext } from './context'
import { healthHandler } from './health'
import { KeyProof } from './key-proof'
import { emitterRoutes } from './modules/emitter/emitter.routes'
import { nfseRoutes } from './modules/nfse/nfse.routes'
import { providerRoutes } from './modules/provider/provider.routes'

/** Contrato DESIGN-FIRST (D-F8): o YAML é a fonte; servido em /docs e /v1/openapi.yaml. */
export const OPENAPI_PATH = path.resolve(__dirname, '..', 'openapi', 'nfse-api.v1.yaml')

export function loadOpenApi(): any {
  return YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'))
}

/**
 * [keyProof]: a prova da chave do servidor (D-F243/D-F245) que o boot roda e agenda (`server.ts`). Sem ela (testes), uma prova que
 * nunca rodou — o health diz `masterKey=false` (fecha em falso).
 */
export function createApp(ctx: AppContext, keyProof: KeyProof = new KeyProof(ctx)): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(corsFor(ctx.corsOrigins))
  app.use(express.json({ limit: '128kb' }))          // o maior corpo é o .pfx em base64 (≤ 64 k)

  app.get('/v1/health', healthHandler(ctx, keyProof))
  const doc = loadOpenApi()
  app.get('/v1/openapi.yaml', (_req, res) => { res.type('text/yaml').send(fs.readFileSync(OPENAPI_PATH, 'utf8')) })
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc))

  // D-UC9/D-AU3 (costura A1): a SESSÃO viva a cada requisição — vínculo, credencial e estabelecimento ativos (senão 401 SESSION_REVOKED)
  // e o PERFIL vivo no lugar do `role` do token; substitui a conferência só do schema (`erp.assertInstitutionSchema`)
  const auth = productAuth(ctx.verifier, ctx.checkIdentity
    ? (p, iat) => access.liveIdentity(ctx.pool, p, iat)   // D-EA7: o iat derruba o token anterior à troca de senha
    : undefined)
  app.use('/v1/emitter', auth, emitterRoutes(ctx))
  app.use('/v1/nfse', auth, nfseRoutes(ctx))
  app.use('/v1/provider', auth, providerRoutes(ctx))      // CRED.E1.P1 (D-NE224): a credencial fiscal do fornecedor, só o super da Setes

  app.use((_req, res) => { res.status(404).json({ error: 'Rota não encontrada', code: 'NOT_FOUND' }) })
  app.use(errorMiddleware)
  return app
}
