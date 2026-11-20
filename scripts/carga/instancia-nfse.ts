/**
 * DEPLOY.E3.P1 — UMA instância da nfse-api para a carga. O ambiente vem INTEIRO do orquestrador (sem `dotenv`: o `.env` do dev tem o
 * STORAGE_PATH, a chave-mestra e a porta 3306 reais). O adaptador do fisco é o FALSO (HTTP para o processo único `fisco-falso.ts`) e o
 * transporte HTTPS do núcleo é trocado por um que explode — nenhum byte ao fisco real. Nada de `src/` muda: o app é o `createApp` de sempre,
 * dentro de um app externo que mede o tempo gasto no fisco por requisição (`x-carga-fisco-ms`) e expõe `GET /carga/estado`.
 */
import path from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import express from 'express'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError } from 'fiscal-api'
import { contextFromEnv } from '../../src/context'
import { createApp } from '../../src/app'
import { RefreshWorker, refreshWorkerDeps, refreshWorkerEnabled } from '../../src/worker/refresh-worker'
import type { TaxAuthorityAdapter } from '../../src/authority/types'
import { assertPortaCarga, assertPastaCarga, assertStorageNaPasta, portaDoEnvArquivo } from './cercas'

const RAIZ = path.resolve(__dirname, '..', '..')
const medida = new AsyncLocalStorage<{ fiscoMs: number }>()

async function chamarFisco(base: string, metodo: 'GET' | 'POST', rota: string, corpo?: unknown): Promise<{ status: number; json: any }> {
  const t0 = process.hrtime.bigint()
  try {
    const r = await fetch(`${base}${rota}`, { method: metodo, headers: { 'content-type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) })
    return { status: r.status, json: await r.json().catch(() => null) }
  } catch {
    return { status: 599, json: null }
  } finally {
    const s = medida.getStore()
    if (s) s.fiscoMs += Number(process.hrtime.bigint() - t0) / 1e6
  }
}

const indisponivel = () => new AuthorityHttpError(503, 'Fisco indisponível (falso da carga)', 'FISCAL_AUTHORITY_UNAVAILABLE', 0, '')
const rejeitado = (code: string) => new AuthorityHttpError(422, `Fisco rejeitou (400): ${code}: carga`, 'FISCAL_DPS_REJECTED', 400,
  `{"erros":[{"codigo":"${code}","descricao":"carga"}]}`, [{ field: 'dps', message: `${code}: carga` }])

export function adaptadorFalso(base: string): TaxAuthorityAdapter {
  return {
    authority: 'ADN',
    async transmit(_ctx, signedDpsXml) {
      const r = await chamarFisco(base, 'POST', '/transmit', { dpsXml: signedDpsXml })
      if (r.status === 200) return { accessKey: r.json.accessKey, nfseNumber: r.json.nfseNumber, dhProc: r.json.dhProc, nfseXml: r.json.nfseXml, raw: {} }
      if (r.status === 422) throw rejeitado(String(r.json?.code ?? 'E0001'))
      throw indisponivel()
    },
    async queryNfse(_ctx, accessKey) {
      const r = await chamarFisco(base, 'GET', `/nfse/${accessKey}`)
      if (r.status !== 200) throw indisponivel()
      return { accessKey, status: r.json.status, nfseXml: r.json.nfseXml, dhProc: r.json.dhProc, ...(r.json.cancelled ? { cancelled: r.json.cancelled } : {}) }
    },
    async queryDpsAccessKey(_ctx, dpsId) {
      const r = await chamarFisco(base, 'GET', `/dps/${dpsId}`)
      if (r.status === 200) return String(r.json.accessKey)
      if (r.status === 404 && r.json?.e2404 === true) return null            // E2404 EXPLÍCITO (D-F90) — só para DPS que o falso recusou
      throw indisponivel()
    },
    async registerEvent(_ctx, accessKey) {
      const r = await chamarFisco(base, 'POST', '/evento', { accessKey })
      if (r.status !== 200) throw indisponivel()
      return { dhEvento: r.json.dhEvento, protocol: r.json.protocol, eventXml: r.json.eventXml, raw: {} }
    },
    async municipalTerms() { return { cancelDays: 60, raw: null } },
  }
}

async function main(): Promise<void> {
  const env = process.env
  const pasta = String(env.CARGA_PASTA ?? '')
  assertPastaCarga(pasta, true)
  assertPortaCarga(Number(env.DB_PORT), portaDoEnvArquivo(RAIZ))
  assertStorageNaPasta(String(env.STORAGE_PATH ?? ''), pasta)
  const base = String(env.CARGA_FISCO_URL ?? '')
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base)) throw new Error(`CARGA_FISCO_URL inválida: ${base}`)
  ;(fiscal as any).transport.request = async () => { throw new Error('CARGA: transporte HTTPS ao fisco real bloqueado') }

  const ctx = contextFromEnv(env, { adapter: adaptadorFalso(base) })
  const rodadas = { inicio: 0, fim: 0 }
  if (refreshWorkerEnabled(env)) {
    const deps = refreshWorkerDeps(ctx)
    const contadas = { ...deps, establishments: async () => { rodadas.inicio++; try { return await deps.establishments() } finally { rodadas.fim++ } } }
    const intervalMs = env.CARGA_WORKER_MS ? Number(env.CARGA_WORKER_MS) : undefined
    new RefreshWorker(contadas, intervalMs ? { intervalMs } : {}).start()
  }
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    const store = { fiscoMs: 0 }
    const writeHead = res.writeHead
    res.writeHead = function (this: typeof res, ...args: any[]) {
      if (!res.headersSent) res.setHeader('x-carga-fisco-ms', String(Math.round(store.fiscoMs)))
      return (writeHead as any).apply(this, args)
    } as any
    medida.run(store, next)
  })
  app.get('/carga/estado', (_req, res) => { res.json({ pid: process.pid, rodadasWorker: rodadas }) })
  app.use(createApp(ctx))
  const porta = Number(env.PORT)
  app.listen(porta, '127.0.0.1', () => console.log(`[instancia ${porta}] ouvindo (fisco falso em ${base})`))
}

if (require.main === module) main().catch(err => { console.error('[instancia] FALHA:', err?.stack ?? err); process.exit(1) })
