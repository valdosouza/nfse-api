// DEPLOY.E2.P3.T3: `npm run keys:rotate [-- --vai]` (= `node dist/rotate-keys-cli.js`, depois do `npm run build`) — roda no servidor sem
// tsx. Sem `--vai` é ENSAIO (só lê). A lógica e as regras moram em `src/key-rotation.ts`. Imprime só o relatório: nada do segredo.
import 'dotenv/config'
import { createFiscalPool, dbConfigFromEnv, MasterKeyRing } from 'fiscal-api'
import { keyRotationArgumentErrors, runKeyRotation } from './key-rotation'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const errors = keyRotationArgumentErrors(args, process.env)          // ANTES de abrir o banco
  if (errors.length) {
    for (const e of errors) console.error(`keys:rotate: ${e}`)
    return 2
  }
  const keyring = MasterKeyRing.fromEnv(process.env)
  const pool = createFiscalPool(dbConfigFromEnv(process.env))
  try {
    const { lines, exitCode } = await runKeyRotation({ pool, keyring }, { execute: args.includes('--vai') })
    for (const line of lines) console.log(line)
    return exitCode
  } finally {
    await pool.end()
  }
}

main().then(code => process.exit(code), err => {
  console.error('keys:rotate falhou:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
