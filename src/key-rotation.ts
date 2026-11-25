// DEPLOY.E2.P3.T3 (D-F16, D-F243 — 2026-11-18; ficha `projetos/nfse-api/GERAL/ficha-deploy-e2-p3-chave-mestra-health.md` no Vault): o
// comando que roda `rotateStoredKeys` do núcleo (A1 e senha SMTP — dois donos do cofre, DEPLOY.E1.P11) no SERVIDOR e imprime só o relatório. Funções PURAS (os testes as importam sem
// disparar o CLI); o CLI é `src/rotate-keys-cli.ts` (compila para `dist/`, roda na imagem sem tsx).
//
//   npm run keys:rotate              ENSAIO: só lê — versão atual, versões guardadas, quantos segredos a regravar e a prova da chave
//   npm run keys:rotate -- --vai     EXECUTA a rotação (ato do Valdo, pelo runbook) e confere o passo 3 do runbook
//
// Convenção das escritas desta API (`migrate:setes`, `migrate:xml-layout`): sem `--vai` é ENSAIO; argumento desconhecido ou repetido
// FALHA antes de abrir o banco; `--vai` engolido pelo npm (sem o `--`) também. NADA do segredo sai: só versão, institution, código, contagem.
import {
  rotateStoredKeys, verifyStoredKeys, storedKeyVersions, storedSecretsOutsideKeyVersion, StoredKeyRotationAborted,
} from 'fiscal-api'
import type { StoredKeyRotationReport, MasterKeyRing, Pool, Queryable, StoredKeyCheck } from 'fiscal-api'

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
  rotate?: (deps: KeyRotationDeps) => Promise<StoredKeyRotationReport>
  verify?: (deps: KeyRotationDeps) => Promise<StoredKeyCheck>
  versions?: (q: Queryable) => Promise<number[]>
  outside?: (q: Queryable, version: number) => Promise<Array<{ store: string; institutionId: number }>>
}

const RUNBOOK_1 = 'Pré-condição (runbook 1): o anel {antiga, nova} publicado e reiniciado em TODOS os processos que usam o cofre (nfse-api e nfe-api).'
const RUNBOOK_4 = 'Depois (runbook 4): só com `failed` vazio, versões = [atual] e a prova ok, tirar a antiga do anel em TODOS os processos — e guardar a NOVA fora do servidor (é o backup dos certificados A1 e das senhas SMTP). Antes de tirar a antiga, rode o ENSAIO de novo: uma senha gravada por outro processo com anel velho depois da conferência ficaria na chave antiga.'

function proofLines(check: StoredKeyCheck): string[] {
  if (!check.versions.length) return ['  prova da chave: nenhum segredo guardado — nada a provar']
  return [
    `  prova da chave: ${check.ok ? 'ok' : 'FALHOU'}${check.degraded ? ' (há segredo ilegível com a chave certa)' : ''}`,
    ...check.versions.map(v => `    v${v.version}: ${v.ok ? 'abre' : `NÃO abre (${v.code ?? '?'})`}${v.unreadable ? `, ${v.unreadable} amostra(s) ilegível(is)` : ''}`),
  ]
}

function reportLines(r: StoredKeyRotationReport): string[] {
  return [
    `  versão atual do anel: ${r.currentVersion}`,
    `  regravados: ${r.rewrapped.length}`,
    ...r.rewrapped.map(x => `    ${x.store} · institution ${x.institutionId}: v${x.from} → v${r.currentVersion}`),
    `  falharam (intocados): ${r.failed.length}`,
    ...r.failed.map(x => `    ${x.store} · institution ${x.institutionId}: v${x.from ?? '?'} — ${x.code}`),
    `  pulados (linha trocada ou apagada no meio): ${r.skipped.length}${r.skipped.length ? ` (${r.skipped.map(x => `${x.store} · institution ${x.institutionId}`).join(', ')})` : ''}`,
  ]
}

/** Ensaio ou ato; devolve as linhas a imprimir e o código de saída (0 só com a rotação completa e conferida). */
export async function runKeyRotation(deps: KeyRotationDeps, run: KeyRotationRun): Promise<{ lines: string[]; exitCode: number }> {
  const rotate = run.rotate ?? rotateStoredKeys
  const verify = run.verify ?? (d => verifyStoredKeys(d))
  const versionsOf = run.versions ?? storedKeyVersions
  const outside = run.outside ?? storedSecretsOutsideKeyVersion
  const current = deps.keyring.currentVersion
  const lines: string[] = [`— rotação da chave-mestra dos segredos, A1 e senha SMTP (${run.execute ? 'ATO' : 'ENSAIO — nada grava'})`]
  if (current === null) {
    lines.push('  FISCAL_MASTER_KEYS ausente — não há chave atual para regravar')
    return { lines, exitCode: 1 }
  }

  if (!run.execute) {
    const stored = await versionsOf(deps.pool)
    const pending = await outside(deps.pool, current)
    lines.push(
      `  versão atual do anel: ${current}`,
      `  versões guardadas: ${stored.length ? stored.join(', ') : '(nenhum segredo)'}`,
      `  segredos a regravar para v${current}: ${pending.length}`,
      ...pending.map(x => `    ${x.store} · institution ${x.institutionId}`),
    )
    const check = await verify(deps)
    lines.push(...proofLines(check), RUNBOOK_1)
    if (!check.ok) {
      // versão guardada que o anel não tem, ou chave errada: o ato deixaria esses segredos em `failed` — corrija o anel antes
      lines.push('O anel NÃO abre os segredos de alguma versão guardada: o ato não os regravaria. Corrija FISCAL_MASTER_KEYS antes do --vai.')
      return { lines, exitCode: 1 }
    }
    lines.push('Para executar: npm run keys:rotate -- --vai')
    return { lines, exitCode: 0 }
  }

  let report: StoredKeyRotationReport
  try {
    report = await rotate(deps)
  } catch (err) {
    if (err instanceof StoredKeyRotationAborted) {
      lines.push(
        '  INTERROMPIDA por erro de infraestrutura — relatório do que JÁ foi commitado:',
        ...reportLines(err.report),
        `  em dúvida: ${err.inDoubt.store} · institution ${err.inDoubt.institutionId} (se caiu no commit, pode ter sido regravada ou não — rodar de novo resolve)`,
        `  erro: ${err.causeError instanceof Error ? err.causeError.message : String(err.causeError)}`,
      )
      return { lines, exitCode: 1 }
    }
    // erro fora do contrato do núcleo (ex.: a leitura do 2º dono cai depois de o 1º já ter sido regravado): não perde o aviso de que parte pode estar regravada
    lines.push(`  INTERROMPIDA por erro inesperado — parte dos segredos pode JÁ ter sido regravada; rode o ENSAIO antes de qualquer outra coisa (a rotação é idempotente).`, `  erro: ${err instanceof Error ? err.message : String(err)}`)
    return { lines, exitCode: 1 }
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
  lines.push(`  versões guardadas depois: ${stored.length ? stored.join(', ') : '(nenhum segredo)'}`, ...proofLines(check))
  const missing: string[] = []
  if (report.failed.length) missing.push(`${report.failed.length} segredo(s) não regravado(s) (ver "falharam")`)
  if (stored.some(v => v !== report.currentVersion)) missing.push(`ainda há segredo em versão diferente de v${report.currentVersion}`)
  if (!check.ok) missing.push('a prova da chave falhou')
  if (missing.length) {
    lines.push(`NÃO CONCLUÍDA: ${missing.join('; ')}. Não tire a chave antiga do anel; corrija e rode de novo.`)
    return { lines, exitCode: 1 }
  }
  lines.push('Rotação conferida (runbook 3).', RUNBOOK_4)
  return { lines, exitCode: 0 }
}
