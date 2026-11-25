// DEPLOY.E1.P1.T4 (2026-11-15 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p1-processo-producao.md` no Vault): PRÉ-CONDIÇÃO DE DEPLOY,
// molde do `pre-deploy-tz-check` do setes-api. SOMENTE LEITURA: confere, ANTES de subir, o que o boot recusaria ou deixaria passar calado
// — o boot só descobre na partida (serviço fora do ar); este check descobre antes de parar o que está rodando.
// Em PRODUÇÃO (NODE_ENV=production) cada item que falha é BLOQUEANTE; fora dela é aviso (o dev roda sem segredo guardado, por exemplo).
// O CORS usa a regra do NÚCLEO (`assertCorsOrigins` com o ambiente — D-F236: em produção só `https://` e nada de localhost); regra única.
import fs from 'fs'
import path from 'path'
import { MasterKeyRing, ProductTokenVerifier, fiscalStorageRootFromEnv, verifyStoredKeys } from 'fiscal-api'
import type { Pool, StoredKeyCheck } from 'fiscal-api'
import { assertCorsOrigins } from './cors-origins'
import { assertRetiredEnv } from './context'
import { readBuildCheck, assertBuildCurrent } from './build-info'
import { isProductionEnv } from './environment'
import { scanOldLayout } from './nfse/xml-layout-migration'
import { refreshWorkerEnabled } from './worker/refresh-worker'

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

/**
 * D-F252: a variável do worker do rodízio. Valor fora de on/off derruba o boot em QUALQUER ambiente — bloqueia sempre (gate L5). Em
 * produção com `off` o worker não roda e ninguém consulta o fisco sozinho: aviso (não bloqueia — a D-F252 permite desligar), para um
 * `.env` feito do `.env.example` não desligar calado (gate L4).
 */
function workerItem(env: NodeJS.ProcessEnv, production: boolean): PreDeployItem {
  const item = 'NFSE_REFRESH_WORKER'
  let on: boolean
  try { on = refreshWorkerEnabled(env) }
  catch (err) { return { item, ok: false, blocking: true, detail: err instanceof Error ? err.message : String(err) } }
  if (on) return { item, ok: true, blocking: false, detail: 'ligado — consulta o fisco 5 min depois de cada rodada, pelas habilitações viradas (D-F239)' }
  if (production) return { item, ok: false, blocking: false, detail: 'DESLIGADO em produção (NFSE_REFRESH_WORKER=off) — ninguém consulta o fisco sozinho; só numa janela de manutenção' }
  return { item, ok: true, blocking: false, detail: 'desligado' }
}

/** Os itens de CONFIGURAÇÃO e de BUILD (sem banco): puros sobre o `env` e o disco. */
export function preDeployConfigItems(env: NodeJS.ProcessEnv, opts: PreDeployOptions = {}): PreDeployItem[] {
  const production = isProductionEnv(env.NODE_ENV)
  const projectRoot = opts.projectRoot ?? path.resolve(__dirname, '..')
  const distDir = opts.distDir ?? path.join(projectRoot, 'dist')
  return [
    check('NODE_ENV', production, () => {
      if (!production) throw new Error(`NODE_ENV=${env.NODE_ENV ?? '(vazio)'} — a produção roda com NODE_ENV=production (D-F230: recusa núcleo de rascunho)`)
      return 'production'
    }),
    check('variáveis aposentadas', production, () => { assertRetiredEnv(env); return 'nenhuma' }),
    check('CORS_ORIGINS', production, () =>
      assertCorsOrigins(String(env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean), env.NODE_ENV)),
    check('FISCAL_MASTER_KEYS', production, () => {
      const ring = MasterKeyRing.fromEnv(env)
      if (ring.currentVersion === null) throw new Error('ausente — o A1 e a senha SMTP não abrem e as operações fiscais respondem 503 (D-F16)')
      // D-F243: a prova de que a chave é a CERTA (abre os segredos guardados) é o item `chave-mestra × segredos guardados`, com o banco
      return `versão atual ${ring.currentVersion}`
    }),
    check('chave pública do JWT', production, () => { ProductTokenVerifier.fromEnv(env); return 'carregada (D-F13)' }),
    check('STORAGE_PATH', production, () => {
      // DEPLOY.E1.P3 (D-F241): a MESMA raiz que o serviço usa — critério do núcleo (`fiscalStorageRootFromEnv`): em produção
      // `STORAGE_PATH` obrigatório e absoluto; fora dela, `STORAGE_PATH` resolvido ou `<cwd>/storage`. O pacote 2.0.0 NUNCA cria a raiz
      // (`save` e `probe` recusam pasta ausente — volume desmontado não vira pasta nova), então ela tem de existir e gravar.
      const dir = fiscalStorageRootFromEnv(env)
      const from = env.STORAGE_PATH ? '' : ' (STORAGE_PATH ausente — padrão do núcleo fora de produção)'
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} não existe ou não é pasta${from}`)
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
      return dir + from
    }),
    check('XML no layout D-F241', production, () => {
      // DEPLOY.E1.P3 (gate socrático M2): o `find` do pacote 2.0.0 não acha o layout ANTIGO (`<cnpj>/[H/]<ano>/<mês>/`) — subir o build
      // novo com arquivo lá deixa `/xml`, `/danfse` e "No fisco" sem o XML. Sobrou arquivo = rode a migração antes (GERAL/INDEX.md, 4a).
      const dir = fiscalStorageRootFromEnv(env)
      if (!fs.existsSync(dir)) throw new Error(`${dir} não existe (ver o item STORAGE_PATH)`)
      const { files, unknown } = scanOldLayout(dir)
      const left = files.length + unknown.length
      if (left) throw new Error(`${left} arquivo(s) fora do layout novo em ${dir} — \`npm run migrate:xml-layout\` (ensaio) e \`-- --vai\` com o serviço parado`)
      return 'nenhum arquivo no layout antigo'
    }),
    workerItem(env, production),
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
  const production = isProductionEnv(env.NODE_ENV)
  try {
    const rows = await query('SELECT VERSION() AS version, DATABASE() AS db')
    return { item: 'banco', ok: true, blocking: false, detail: `${rows[0]?.version} · ${rows[0]?.db}` }
  } catch (err) {
    return { item: 'banco', ok: false, blocking: production, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * DEPLOY.E2.P3.T2 (D-F243/D-F245): a chave do SERVIDOR abre UM segredo guardado (A1 ou senha SMTP) por versão em uso — na hora, uma vez. Chave errada de 32
 * bytes (que o `selfTest` deixava passar) BLOQUEIA em produção. Segredo ilegível com a chave certa (`degraded`) é aviso, por analogia à
 * D-F243 (não derruba o health). O console do operador vê versão, código e contagem — nada do segredo (D-F243).
 */
export async function preDeployKeyItem(
  env: NodeJS.ProcessEnv,
  deps: { pool: Pool; keyring: MasterKeyRing },
  verify: (d: { pool: Pool; keyring: MasterKeyRing }) => Promise<StoredKeyCheck> = d => verifyStoredKeys(d),
): Promise<PreDeployItem> {
  const production = isProductionEnv(env.NODE_ENV)
  const item = 'chave-mestra × segredos guardados'
  if (deps.keyring.currentVersion === null) return { item, ok: false, blocking: production, detail: 'sem chave-mestra — nada a provar (ver FISCAL_MASTER_KEYS)' }
  try {
    const check = await verify(deps)
    const describe = (v: StoredKeyCheck['versions'][number]) =>
      `v${v.version} ${v.ok ? 'abre' : `NÃO abre (${v.code ?? '?'})`}${v.unreadable ? `, ${v.unreadable} amostra(s) ilegível(is)` : ''}`
    const detail = check.versions.length ? check.versions.map(describe).join('; ') : 'nenhum segredo guardado — nada a provar'
    if (!check.ok) return { item, ok: false, blocking: production, detail: `a chave do servidor não abre os segredos: ${detail}` }
    if (check.degraded) return { item, ok: false, blocking: false, detail: `chave certa, mas há segredo ilegível (alarme, não bloqueia): ${detail}` }
    return { item, ok: true, blocking: false, detail }
  } catch (err) {
    return { item, ok: false, blocking: production, detail: `a prova não rodou: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Texto do relatório e o código de saída: 1 se algum item bloqueia. */
export function preDeployReport(items: PreDeployItem[]): { lines: string[]; exitCode: number } {
  const lines = items.map(i => `${i.ok ? '✓' : i.blocking ? '✗ BLOQUEIA' : '! aviso'}  ${i.item}: ${i.detail}`)
  const blocking = items.filter(i => i.blocking).length
  lines.push(blocking ? `${blocking} item(ns) bloqueia(m) o deploy.` : 'Nada bloqueia o deploy.')
  return { lines, exitCode: blocking ? 1 : 0 }
}
