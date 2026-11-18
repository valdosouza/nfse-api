// DEPLOY.E2.P3.T2 (D-F243, D-F244, D-F245, D-F250, D-F251 — 2026-11-18; ficha `projetos/nfse-api/GERAL/ficha-deploy-e2-p3-chave-mestra-health.md`
// no Vault): a prova de que a chave-mestra do SERVIDOR é a que cifrou os A1 guardados. Abre UM A1 por versão em uso (`verifyStoredKeys` do
// núcleo), na partida (antes do `listen` — D-F250) e a cada 5 minutos (D-F251); o `/v1/health` só LÊ o último resultado (D-F245) e mostra
// um sinal só, sim ou não (D-F244). O `selfTest` do anel cifra e decifra um vetor que ele mesmo criou — passa com QUALQUER chave de 32
// bytes; por isso saiu do health e do pre-deploy.
//
// Nada do segredo sai daqui: o log leva só versão, ok, código e contagem. O alarme (`DEPLOY.E2.P2.T4`) lê o `code` do log.
import { logger as coreLogger, verifyStoredKeys } from 'fiscal-api'
import type { Logger, MasterKeyRing, Pool, StoredKeyCheck } from 'fiscal-api'

/** D-F251: intervalo da prova — constante própria (não é o `REFRESH_MIN_MINUTES` do rodízio). Mudar pede commit. */
export const KEY_PROOF_INTERVAL_MINUTES = 5
/** Resultado mais velho que isto conta como "sem prova" (rodada travada não deixa o sinal parado calado — D-F245: "em até 5 minutos"). */
export const KEY_PROOF_STALE_AFTER_MS = 2 * KEY_PROOF_INTERVAL_MINUTES * 60_000

/** Códigos do log que o alarme lê (`DEPLOY.E2.P2.T4`). */
export const KEY_PROOF_LOG_CODES = {
  /** a chave do servidor NÃO abre os A1 de alguma versão em uso (ou o anel está vazio) */
  failed: 'KEY_PROOF_FAILED',
  /** a chave abre, mas há A1 ilegível (D-F243 — alarme, não queda) */
  degraded: 'KEY_PROOF_DEGRADED',
  /** a prova NÃO RODOU (banco fora, rodada sem resposta no prazo): o sinal fica falso, mas a causa não é a chave */
  notRun: 'KEY_PROOF_NOT_RUN',
} as const

export interface KeyProofDeps {
  pool: Pool
  keyring: MasterKeyRing
}

export interface KeyProofOptions {
  verify?: (deps: KeyProofDeps) => Promise<StoredKeyCheck>
  log?: Logger
  now?: () => number
  intervalMs?: number
}

export class KeyProof {
  private readonly verify: (deps: KeyProofDeps) => Promise<StoredKeyCheck>
  private readonly log: Logger
  private readonly now: () => number
  private readonly intervalMs: number
  private last: { ok: boolean; at: number } | null = null
  private running: Promise<boolean> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: KeyProofDeps, opts: KeyProofOptions = {}) {
    this.verify = opts.verify ?? (d => verifyStoredKeys(d))
    this.log = opts.log ?? coreLogger
    this.now = opts.now ?? Date.now
    this.intervalMs = opts.intervalMs ?? KEY_PROOF_INTERVAL_MINUTES * 60_000
  }

  /** O sinal do health (D-F244): o último resultado, se recente; nunca provou ou vencido = falso (fecha em falso). Não abre A1. */
  get masterKey(): boolean {
    if (!this.last) return false
    if (this.now() - this.last.at > KEY_PROOF_STALE_AFTER_MS) return false
    return this.last.ok
  }

  /** Uma rodada da prova. Rodada em curso → devolve a mesma (nunca duas ao mesmo tempo). */
  run(): Promise<boolean> {
    if (!this.running) {
      this.running = this.round().finally(() => { this.running = null })
    }
    return this.running
  }

  /** A prova com prazo: uma rodada sem resposta em 1 intervalo (pool esgotado, socket meio aberto) vira "não rodou", com log. */
  private withDeadline(p: Promise<StoredKeyCheck>): Promise<StoredKeyCheck> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sem resposta em ${Math.round(this.intervalMs / 1000)} s`)), this.intervalMs)
      timer.unref()
    })
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
  }

  private async round(): Promise<boolean> {
    let ok = false
    // Anel sem versão atual: sem chave nenhuma o serviço não abre A1 nenhum — "a chave está certa" seria falso positivo
    // (herdado do health anterior e da cerca `adversarial-f1.live.test.ts`: anel vazio → 503).
    if (this.deps.keyring.currentVersion === null) {
      this.log.error('Prova da chave-mestra: FISCAL_MASTER_KEYS ausente — nenhum A1 abre', { code: KEY_PROOF_LOG_CODES.failed })
    } else {
      try {
        const check = await this.withDeadline(this.verify(this.deps))
        ok = check.ok
        if (!check.ok) {
          this.log.error('Prova da chave-mestra: a chave do servidor NÃO abre os A1 de alguma versão em uso (D-F243)', {
            code: KEY_PROOF_LOG_CODES.failed,
            versions: check.versions.map(v => ({ version: v.version, ok: v.ok, code: v.code ?? null, unreadable: v.unreadable })),
          })
        }
        if (check.degraded) {
          this.log.warn('Prova da chave-mestra: A1 ilegível com a chave certa (D-F243 — alarme, não queda)', {
            code: KEY_PROOF_LOG_CODES.degraded,
            versions: check.versions.filter(v => v.ok && v.unreadable > 0).map(v => ({ version: v.version, unreadable: v.unreadable })),
          })
        }
      } catch (err) {
        // erro de infraestrutura (banco, prazo): sem prova = falso (D-F250 no boot; aqui por analogia) — código próprio: a causa não é a chave
        this.log.error('Prova da chave-mestra não rodou', {
          code: KEY_PROOF_LOG_CODES.notRun, err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.last = { ok, at: this.now() }
    return ok
  }

  /** D-F245: a cada intervalo; o timer não segura o processo. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.run() }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
