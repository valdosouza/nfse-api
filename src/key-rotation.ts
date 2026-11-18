// DEPLOY.E2.P3.T3 (D-F16, D-F243 — 2026-11-18; ficha `projetos/nfse-api/GERAL/ficha-deploy-e2-p3-chave-mestra-health.md` no Vault): o
// comando que roda `rotateCertificateKeys` do núcleo no SERVIDOR e imprime só o relatório. Funções PURAS (os testes as importam sem
// disparar o CLI); o CLI é `src/rotate-keys-cli.ts` (compila para `dist/`, roda na imagem sem tsx).
//
//   npm run keys:rotate              ENSAIO: só lê — versão atual, versões guardadas, quantos A1 a regravar e a prova da chave
//   npm run keys:rotate -- --vai     EXECUTA a rotação (ato do Valdo, pelo runbook) e confere o passo 3 do runbook
//
// Convenção das escritas desta API (`migrate:setes`, `migrate:xml-layout`): sem `--vai` é ENSAIO; argumento desconhecido ou repetido
// FALHA antes de abrir o banco; `--vai` engolido pelo npm (sem o `--`) também. NADA do segredo sai: só versão, institution, código, contagem.
import {
  rotateCertificateKeys, verifyStoredKeys, storedKeyVersions, certificatesOutsideKeyVersion, KeyRotationAborted,
} from 'fiscal-api'
import type { KeyRotationReport, MasterKeyRing, Pool, Queryable, StoredKeyCheck } from 'fiscal-api'

export function keyRotationArgumentErrors(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const a of args) {
    if (a !== '--vai') errors.push(`argumento desconhecido: "${a}"`)
    else if (seen.has(a)) errors.push(`argumento repetido: "${a}"`)
    seen.add(a)
  }
  if (env.npm_config_vai !== undefined && env.npm_config_vai !== '') errors.push('o npm engoliu --vai (faltou o "--"): use `npm run keys:rotate -- --vai`')
  return errors
}

export interface KeyRotationDeps {
  pool: Pool
  keyring: MasterKeyRing
}

export interface KeyRotationRun {
  execute: boolean
  rotate?: (deps: KeyRotationDeps) => Promise<KeyRotationReport>
  verify?: (deps: KeyRotationDeps) => Promise<StoredKeyCheck>
  versions?: (q: Queryable) => Promise<number[]>
  outside?: (q: Queryable, version: number) => Promise<number[]>
}

const RUNBOOK_1 = 'Pré-condição (runbook 1): o anel {antiga, nova} publicado e reiniciado em TODOS os processos que usam o cofre (nfse-api e nfe-api).'
const RUNBOOK_4 = 'Depois (runbook 4): só com `failed` vazio, versões = [atual] e a prova ok, tirar a antiga do anel em TODOS os processos — e guardar a NOVA fora do servidor (é o backup do A1).'

function proofLines(check: StoredKeyCheck): string[] {
  if (!check.versions.length) return ['  prova da chave: nenhum A1 guardado — nada a provar']
  return [
    `  prova da chave: ${check.ok ? 'ok' : 'FALHOU'}${check.degraded ? ' (há A1 ilegível com a chave certa)' : ''}`,
    ...check.versions.map(v => `    v${v.version}: ${v.ok ? 'abre' : `NÃO abre (${v.code ?? '?'})`}${v.unreadable ? `, ${v.unreadable} amostra(s) ilegível(is)` : ''}`),
  ]
}

function reportLines(r: KeyRotationReport): string[] {
  return [
    `  versão atual do anel: ${r.currentVersion}`,
    `  regravados: ${r.rewrapped.length}`,
    ...r.rewrapped.map(x => `    institution ${x.institutionId}: v${x.from} → v${r.currentVersion}`),
    `  falharam (intocados): ${r.failed.length}`,
    ...r.failed.map(x => `    institution ${x.institutionId}: v${x.from ?? '?'} — ${x.code}`),
    `  pulados (linha trocada ou apagada no meio): ${r.skipped.length}${r.skipped.length ? ` (${r.skipped.join(', ')})` : ''}`,
  ]
}

/** Ensaio ou ato; devolve as linhas a imprimir e o código de saída (0 só com a rotação completa e conferida). */
export async function runKeyRotation(deps: KeyRotationDeps, run: KeyRotationRun): Promise<{ lines: string[]; exitCode: number }> {
  const rotate = run.rotate ?? rotateCertificateKeys
  const verify = run.verify ?? (d => verifyStoredKeys(d))
  const versionsOf = run.versions ?? storedKeyVersions
  const outside = run.outside ?? certificatesOutsideKeyVersion
  const current = deps.keyring.currentVersion
  const lines: string[] = [`— rotação da chave-mestra do A1 (${run.execute ? 'ATO' : 'ENSAIO — nada grava'})`]
  if (current === null) {
    lines.push('  FISCAL_MASTER_KEYS ausente — não há chave atual para regravar')
    return { lines, exitCode: 1 }
  }

  if (!run.execute) {
    const stored = await versionsOf(deps.pool)
    const pending = await outside(deps.pool, current)
    lines.push(
      `  versão atual do anel: ${current}`,
      `  versões guardadas: ${stored.length ? stored.join(', ') : '(nenhum A1)'}`,
      `  A1 a regravar para v${current}: ${pending.length}`,
    )
    const check = await verify(deps)
    lines.push(...proofLines(check), RUNBOOK_1)
    if (!check.ok) {
      // versão guardada que o anel não tem, ou chave errada: o ato deixaria esses A1 em `failed` — corrija o anel antes
      lines.push('O anel NÃO abre os A1 de alguma versão guardada: o ato não os regravaria. Corrija FISCAL_MASTER_KEYS antes do --vai.')
      return { lines, exitCode: 1 }
    }
    lines.push('Para executar: npm run keys:rotate -- --vai')
    return { lines, exitCode: 0 }
  }

  let report: KeyRotationReport
  try {
    report = await rotate(deps)
  } catch (err) {
    if (err instanceof KeyRotationAborted) {
      lines.push(
        '  INTERROMPIDA por erro de infraestrutura — relatório do que JÁ foi commitado:',
        ...reportLines(err.report),
        `  em dúvida: institution ${err.inDoubt} (se caiu no commit, pode ter sido regravada ou não — rodar de novo resolve)`,
        `  erro: ${err.causeError instanceof Error ? err.causeError.message : String(err.causeError)}`,
      )
      return { lines, exitCode: 1 }
    }
    throw err
  }
  lines.push(...reportLines(report))

  // runbook 3: `failed` vazio, versões guardadas = [atual] e a prova ok. A conferência que cai NÃO apaga o relatório do que já foi regravado.
  let stored: number[]
  let check: StoredKeyCheck
  try {
    stored = await versionsOf(deps.pool)
    check = await verify(deps)
  } catch (err) {
    lines.push(`NÃO CONCLUÍDA: a conferência depois da rotação não rodou (${err instanceof Error ? err.message : String(err)}). O que está acima JÁ foi regravado; confira com o ensaio antes de tirar a chave antiga.`)
    return { lines, exitCode: 1 }
  }
  lines.push(`  versões guardadas depois: ${stored.length ? stored.join(', ') : '(nenhum A1)'}`, ...proofLines(check))
  const missing: string[] = []
  if (report.failed.length) missing.push(`${report.failed.length} A1 não regravado(s) (ver "falharam")`)
  if (stored.some(v => v !== report.currentVersion)) missing.push(`ainda há A1 em versão diferente de v${report.currentVersion}`)
  if (!check.ok) missing.push('a prova da chave falhou')
  if (missing.length) {
    lines.push(`NÃO CONCLUÍDA: ${missing.join('; ')}. Não tire a chave antiga do anel; corrija e rode de novo.`)
    return { lines, exitCode: 1 }
  }
  lines.push('Rotação conferida (runbook 3).', RUNBOOK_4)
  return { lines, exitCode: 0 }
}
