// D-F222 + gate socrático do DEPLOY.E1.P1 (achado 3d): o que roda é conferido na partida — a versão do núcleo (pacote instalado) e o
// SELO do `dist` (`scripts/write-build-info.mjs`, gravado pelo `npm run build`). `dist` de OUTRO commit que o da pasta = recusa subir
// (reiniciar sem compilar aplicaria as migrations NOVAS de `src/migrations/sql` com o código VELHO). Rodando por `tsx` (dev) não há selo.
// Gates do delta (LOW 3/7): o commit é lido na pasta DO PROJETO (nunca no cwd de quem chamou — serviço do Windows, outro usuário); sem git
// a linha do log diz "NÃO conferido" (nunca igual à do caso conferido); `dist` compilado de árvore com alteração é dito no log.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

export interface BuildCheck { coreVersion: string; distCommit: string | null; distDirty: boolean; headCommit: string | null }

/** `distDir` = a pasta do `dist` (onde mora o selo); a raiz do projeto é a pasta acima dela. */
export function readBuildCheck(distDir: string = __dirname, projectRoot: string = path.resolve(distDir, '..')): BuildCheck {
  const coreVersion = String(JSON.parse(fs.readFileSync(require.resolve('fiscal-api/package.json'), 'utf8')).version)
  const sealFile = path.join(distDir, 'build-info.json')
  const seal = fs.existsSync(sealFile) ? JSON.parse(fs.readFileSync(sealFile, 'utf8')) : null
  let headCommit: string | null = null
  try { headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* sem git */ }
  return { coreVersion, distCommit: seal?.commit ?? null, distDirty: seal?.dirty === true, headCommit }
}

/** Recusa o `dist` de outro commit; devolve a linha do log da partida. */
export function assertBuildCurrent(check: BuildCheck, runningFromDist: boolean): string {
  if (runningFromDist && check.distCommit && check.headCommit && check.distCommit !== check.headCommit) {
    throw new Error(`dist compilado do commit ${check.distCommit.slice(0, 7)}, mas a pasta está no ${check.headCommit.slice(0, 7)} — rode \`npm run build\` antes de \`npm start\``)
  }
  let dist = 'tsx (sem dist)'
  if (runningFromDist) {
    if (!check.distCommit) dist = 'dist sem selo — NÃO conferido'
    else {
      dist = `dist do commit ${check.distCommit.slice(0, 7)}${check.distDirty ? ' (compilado de árvore com alteração)' : ''}`
      if (!check.headCommit) dist += ' — commit da pasta NÃO conferido (sem git)'
    }
  }
  return `núcleo fiscal-api ${check.coreVersion} (pacote instalado) · ${dist}`
}
