// D-F222 + gate socrático do DEPLOY.E1.P1 (achado 3d): o que roda é conferido na partida — a versão do núcleo (pacote instalado) e o
// SELO do `dist` (`scripts/write-build-info.mjs`, gravado pelo `npm run build`). `dist` de OUTRO commit que o da pasta = recusa subir
// (reiniciar sem compilar aplicaria as migrations NOVAS de `src/migrations/sql` com o código VELHO). Rodando por `tsx` (dev) não há selo.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

export interface BuildCheck { coreVersion: string; distCommit: string | null; headCommit: string | null }

export function readBuildCheck(distDir: string = __dirname, cwd: string = process.cwd()): BuildCheck {
  const coreVersion = String(JSON.parse(fs.readFileSync(require.resolve('fiscal-api/package.json'), 'utf8')).version)
  const sealFile = path.join(distDir, 'build-info.json')
  const distCommit = fs.existsSync(sealFile) ? (JSON.parse(fs.readFileSync(sealFile, 'utf8')).commit ?? null) : null
  let headCommit: string | null = null
  try { headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* sem git */ }
  return { coreVersion, distCommit, headCommit }
}

/** Recusa o `dist` de outro commit; devolve a linha do log da partida. */
export function assertBuildCurrent(check: BuildCheck, runningFromDist: boolean): string {
  if (runningFromDist && check.distCommit && check.headCommit && check.distCommit !== check.headCommit) {
    throw new Error(`dist compilado do commit ${check.distCommit.slice(0, 7)}, mas a pasta está no ${check.headCommit.slice(0, 7)} — rode \`npm run build\` antes de \`npm start\``)
  }
  const dist = runningFromDist ? (check.distCommit ? `dist do commit ${check.distCommit.slice(0, 7)}` : 'dist sem selo') : 'tsx (sem dist)'
  return `núcleo fiscal-api ${check.coreVersion} (pacote instalado) · ${dist}`
}
