// Argumentos do `migrate:setes` — funções PURAS, num módulo próprio para os testes as importarem sem disparar o script
// (o `migrate-from-setes-api.ts` roda o `main()` ao ser carregado — os testes de script da 3ª sessão de 2026-10-04 o carregam
// com `process.argv` trocado e esperam a execução).

export const KNOWN_FLAGS = new Set(['--dry-run', '--cutover', '--confirmo-setes-api-parado', '--vai'])

/**
 * Gate do delta da Rodada 6 (M3): lista FECHADA de argumentos — o desconhecido falha antes de abrir o banco. Gate adversarial
 * r8/r11 (ADV-R8-03): argumento REPETIDO falha (qual `--cutover` vale seria adivinhação) e o id é decimal canônico (`0x1`,
 * `1e0`, ` 1` não viram a institution 1).
 */
export function argumentErrors(args: readonly string[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    if (seen.has(args[i]) && KNOWN_FLAGS.has(args[i])) errors.push(`argumento repetido: "${args[i]}"`)
    seen.add(args[i])
    if (args[i] === '--cutover') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) errors.push('--cutover precisa de um institutionId')
      else if (!/^[1-9][0-9]{0,9}$/.test(v)) errors.push(`--cutover precisa de um institutionId decimal positivo (veio "${v}")`)
      i++; continue
    }
    if (!KNOWN_FLAGS.has(args[i])) errors.push(`argumento desconhecido: "${args[i]}"`)
  }
  if (args.includes('--vai') && !args.includes('--cutover')) errors.push('--vai só existe para o ato (--cutover)')
  if (args.includes('--vai') && args.includes('--dry-run')) errors.push('--vai e --dry-run juntos: escolha o ato OU o ensaio')
  return errors
}

/**
 * Gate adversarial r8/r11 (ADV-R8-04): `npm run migrate:setes --dry-run` (SEM o `--`) faz o npm ENGOLIR a flag (vira
 * `npm_config_dry_run`) e o script rodaria a re-sincronia GRAVANDO. Flag deste script vista como config do npm = recusa.
 */
export function npmSwallowedFlags(env: NodeJS.ProcessEnv): string[] {
  return ['dry_run', 'cutover', 'vai', 'confirmo_setes_api_parado']
    .filter(k => env[`npm_config_${k}`] !== undefined && env[`npm_config_${k}`] !== '')
    .map(k => `--${k.replace(/_/g, '-')}`)
}
