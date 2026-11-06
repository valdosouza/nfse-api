// D-F222 + gate socrático do DEPLOY.E1.P1 (achado 3d, 2026-11-06): a produção roda `node dist` — reiniciar sem compilar rodaria o `dist`
// VELHO, mas as migrations desta API saem de `src/migrations/sql` (aplicaria migration NOVA com código VELHO). O build grava o SELO de onde
// o `dist` saiu; o boot (`src/build-info.ts`) o confere contra o commit da pasta e recusa subir com `dist` de outro commit.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let commit = null
let dirty = null
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== ''
} catch { /* sem git (cópia exportada): o selo fica sem commit e o boot só registra */ }
writeFileSync('dist/build-info.json', JSON.stringify({ commit, dirty, builtAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`[build-info] dist selado: commit ${commit ?? '(sem git)'}${dirty ? ' (árvore com alteração)' : ''}`)
