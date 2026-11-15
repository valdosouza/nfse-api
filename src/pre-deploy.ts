// DEPLOY.E1.P1.T4 (2026-11-15 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p1-processo-producao.md` no Vault): PRÉ-CONDIÇÃO DE DEPLOY,
// molde do `pre-deploy-tz-check` do setes-api. SOMENTE LEITURA: confere, ANTES de subir, o que o boot recusaria ou deixaria passar calado
// — o boot só descobre na partida (serviço fora do ar); este check descobre antes de parar o que está rodando.
// Em PRODUÇÃO (NODE_ENV=production) cada item que falha é BLOQUEANTE; fora dela é aviso (o dev roda sem A1, por exemplo).
// O CORS usa a regra do NÚCLEO (`assertCorsOrigins`); o corte "só https em produção" chega com o pacote da D-F236 — nunca aqui (regra única).
import fs from 'fs'
import path from 'path'
import { MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { assertCorsOrigins } from './cors-origins'
import { assertRetiredEnv } from './context'
import { readBuildCheck, assertBuildCurrent } from './build-info'

export interface PreDeployItem {
  item: string
  ok: boolean
  /** Falhou e segura o deploy (só em produção). */
  blocking: boolean
  detail: string
}

export interface PreDeployOptions {
  /** Pasta do `dist` (onde mora o selo). Padrão: `<projeto>/dist`. */
  distDir?: string
  /** Raiz do projeto (onde o git diz o commit da pasta). Padrão: a pasta acima de `src`/`dist`. */
  projectRoot?: string
}

function check(item: string, production: boolean, fn: () => string): PreDeployItem {
  try {
    return { item, ok: true, blocking: false, detail: fn() }
  } catch (err) {
    return { item, ok: false, blocking: production, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Os itens de CONFIGURAÇÃO e de BUILD (sem banco): puros sobre o `env` e o disco. */
export function preDeployConfigItems(env: NodeJS.ProcessEnv, opts: PreDeployOptions = {}): PreDeployItem[] {
  const production = env.NODE_ENV === 'production'
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '..')
  const distDir = opts.distDir ?? path.join(projectRoot, 'dist')
  return [
    check('NODE_ENV', production, () => {
      if (!production) throw new Error(`NODE_ENV=${env.NODE_ENV ?? '(vazio)'} — a produção roda com NODE_ENV=production (D-F230: recusa núcleo de rascunho)`)
      return 'production'
    }),
    check('variáveis aposentadas', production, () => { assertRetiredEnv(env); return 'nenhuma' }),
    check('CORS_ORIGINS', production, () =>
      assertCorsOrigins(String(env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean))),
    check('FISCAL_MASTER_KEYS', production, () => {
      const ring = MasterKeyRing.fromEnv(env)
      if (ring.currentVersion === null) throw new Error('ausente — o A1 não abre e as operações fiscais respondem 503 (D-F16)')
      if (!ring.selfTest()) throw new Error('a chave atual não cifra e decifra o vetor de teste')
      return `versão atual ${ring.currentVersion}`
    }),
    check('chave pública do JWT', production, () => { ProductTokenVerifier.fromEnv(env); return 'carregada (D-F13)' }),
    check('STORAGE_PATH', production, () => {
      const raw = env.STORAGE_PATH
      if (!raw) throw new Error('ausente — o XML fiscal iria para ./storage da pasta de execução (P-DEP-2: disco do servidor)')
      if (production && !path.isAbsolute(raw)) throw new Error(`${raw} é relativo — em produção o caminho é absoluto (não depende da pasta de execução)`)
      const dir = path.resolve(raw)
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} não existe ou não é pasta`)
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
      return dir
    }),
    check('PORT', production, () => {
      const port = Number(env.PORT ?? 3002)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT=${env.PORT} não é uma porta`)
      return String(port)
    }),
    check('dist', production, () => {
      if (!fs.existsSync(path.join(distDir, 'server.js'))) throw new Error(`${distDir}/server.js não existe — rode \`npm run build\``)
      if (!fs.existsSync(path.join(distDir, 'build-info.json'))) throw new Error('dist sem selo — rode `npm run build` (D-F222)')
      return assertBuildCurrent(readBuildCheck(distDir, projectRoot), true, production)
    }),
  ]
}

/** Banco: a conexão do `.env` responde. Os invariantes (sessão estrita, CHECKs, views) seguem com o BOOT, que os confere pelo nome. */
export async function preDeployDbItem(
  env: NodeJS.ProcessEnv,
  query: (sql: string) => Promise<Array<Record<string, unknown>>>,
): Promise<PreDeployItem> {
  const production = env.NODE_ENV === 'production'
  try {
    const rows = await query('SELECT VERSION() AS version, DATABASE() AS db')
    return { item: 'banco', ok: true, blocking: false, detail: `${rows[0]?.version} · ${rows[0]?.db}` }
  } catch (err) {
    return { item: 'banco', ok: false, blocking: production, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Texto do relatório e o código de saída: 1 se algum item bloqueia. */
export function preDeployReport(items: PreDeployItem[]): { lines: string[]; exitCode: number } {
  const lines = items.map(i => `${i.ok ? '✓' : i.blocking ? '✗ BLOQUEIA' : '! aviso'}  ${i.item}: ${i.detail}`)
  const blocking = items.filter(i => i.blocking).length
  lines.push(blocking ? `${blocking} item(ns) bloqueia(m) o deploy.` : 'Nada bloqueia o deploy.')
  return { lines, exitCode: blocking ? 1 : 0 }
}
