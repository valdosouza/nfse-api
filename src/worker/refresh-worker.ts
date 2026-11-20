import { logger, access, WEB_TERMINAL, HttpError } from 'fiscal-api'
import type { NfseDeps, Actor, RefreshRunReport } from '../nfse/transmission'
import { refreshOpenServiceTransmissions, PASS_INTERFACES, REFRESH_MIN_MINUTES } from '../nfse/transmission'
import { turnedServiceEstablishments, serviceEstablishmentStillTurned, TurnedServiceEstablishment } from '../facts/service-facts'
import { isProductionEnv } from '../environment'

/**
 * WORKER DO RODÍZIO (D-F239 — fim do `runningRefresh` em memória do setes-api): um TEMPORIZADOR em cada instância da nfse-api que passa
 * por todo estabelecimento com a habilitação SE VIRADA (D-F39 — a réplica nunca), um de cada vez, pela MESMA passada da rota
 * `POST /v1/nfse/refresh` (que fica como o "consultar agora" do app). Duas instâncias não consultam a mesma nota: o aluguel na linha da
 * habilitação (D-F41) faz a outra pular o estabelecimento em curso (`skipped`), e a nota consultada sai das candidatas pelo
 * `last_queried_at` (a janela de `REFRESH_MIN_MINUTES`).
 * EXCEÇÃO (gates, 2026-11-20 — desejada): a passada NÃO carimba `last_queried_at` quando a consulta falha de modo passageiro (nota ocupada
 * — RESOURCE_BUSY/trava —, resposta não gravada — FISCAL_OUTCOME_NOT_RECORDED —, fisco fora — 503 —, ou o GET /dps anterior à voz de
 * outro escritor). A outra instância que chegar depois ao estabelecimento consulta essa nota de novo — é a reconciliação, não duplicidade.
 *
 * Sem usuário, o escopo é a LICENÇA (D-F240 — `access.licensedKeys`): ramos contratados = todas as candidatas, ramos cortados = só as
 * tentativas já vivas (D-F46/D-F47, sem privilégio — o sistema não tem perfil). D-F247: antes de cada passada o estabelecimento é
 * RECONFERIDO (virado, vivo, mesmo schema) — a licença vazia não separa "inativo" de "nada contratado". A voz da consulta é gravada SEM
 * autor (`userId` null, fonte Q); o tipo `UserActor` impede este ator de transmitir, reconferir ou cancelar. Nenhum efeito no ERP (D-F28).
 *
 * CADÊNCIA (suposição marcada — ficha §5.1): o temporizador é ENCADEADO — a próxima rodada começa `REFRESH_MIN_MINUTES` DEPOIS do fim da
 * anterior, e a 1ª rodada sai esse tempo depois do boot. Cada passada segue com o teto de candidatas (`REFRESH_MAX_PER_RUN`) e o orçamento
 * (`REFRESH_BUDGET_MS`) da rota; com muitos clientes (D-F3) a rodada sequencial estica a cadência — nada se sobrepõe, e a 2ª instância
 * divide a fila pelo aluguel. Se a carga real mostrar atraso, vira decisão (orçamento próprio do worker ou paralelismo).
 *
 * D-F253: este arquivo é uma BORDA de entrada, como a rota HTTP e o script — só ele diz à passada o terminal das notas da web
 * (`WEB_TERMINAL`); daqui para dentro a nota viaja inteira (cerca da D-NE12/D-NE59 em `adversarial-ne1a-gate.test.ts`).
 */

/** O que o worker precisa — injetável (o teste unitário usa dublês; a suíte ao vivo restringe os estabelecimentos). */
export interface RefreshWorkerDeps {
  /** Os estabelecimentos a percorrer (habilitação SE virada, institution viva). */
  establishments: () => Promise<TurnedServiceEstablishment[]>
  /** D-F247: o estabelecimento segue virado, vivo e com o mesmo schema — relido imediatamente antes da passada. */
  stillTurned: (who: TurnedServiceEstablishment) => Promise<boolean>
  /** Das [keys], os ramos que o estabelecimento contratou — sem usuário (D-F240). */
  licensed: (who: TurnedServiceEstablishment, keys: readonly string[]) => Promise<string[]>
  /** A passada da rota (a mesma função). */
  pass: (actor: Actor, opts: { terminal: number; interfaces: readonly string[]; liveOnlyInterfaces: readonly string[] }) => Promise<RefreshRunReport>
}

/** As peças reais: os leitores da fonte de fatos, o `licensedKeys` do núcleo e a passada da composição. */
export function refreshWorkerDeps(deps: NfseDeps): RefreshWorkerDeps {
  return {
    establishments: () => turnedServiceEstablishments(deps.pool, (institutionId, err) =>
      logger.error('Worker do rodízio: estabelecimento com schema inválido no cadastro — fica fora da rodada', {
        code: 'REFRESH_WORKER_INVALID_ESTABLISHMENT', institutionId, err: err.message,
      })),
    stillTurned: who => serviceEstablishmentStillTurned(deps.pool, who),
    licensed: (who, keys) => access.licensedKeys(deps.pool, who, keys),
    pass: (actor, opts) => refreshOpenServiceTransmissions(deps, actor, opts),
  }
}

/** O resultado de um estabelecimento numa rodada: o relatório da passada, a reconferência que o tirou, ou o erro (que não para os outros). */
export interface EstablishmentRun {
  institutionId: number
  report?:       RefreshRunReport
  /** D-F247: deixou de estar virado/vivo/com o mesmo schema entre a lista e a passada — o fisco não foi consultado. */
  dropped?:      true
  error?:        { code: string | null; message: string }
}

/**
 * D-F252 (Valdo, 2026-11-19, "Só em produção"): `NFSE_REFRESH_WORKER` = `on` | `off`. Ausente (ou vazia) = ligado só em produção
 * (`isProductionEnv(NODE_ENV)`) — no dev a habilitação SE está virada e o A1 é o de produção: ligado por padrão consultaria o fisco real.
 * Qualquer outro valor = erro (o boot falha — configuração que não significa nada nunca passa calada).
 */
export function refreshWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.NFSE_REFRESH_WORKER ?? '').trim().toLowerCase()
  if (raw === '') return isProductionEnv(env.NODE_ENV)
  if (raw === 'on') return true
  if (raw === 'off') return false
  throw new Error(`NFSE_REFRESH_WORKER inválida (${JSON.stringify(env.NFSE_REFRESH_WORKER)}): use "on" ou "off" (D-F252)`)
}

const errOf = (err: unknown): { code: string | null; message: string } =>
  err instanceof HttpError ? { code: err.code ?? null, message: err.message } : { code: null, message: err instanceof Error ? err.message : String(err) }

export class RefreshWorker {
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  /** A rodada em curso — `start()` depois de `stop()` não abre uma segunda enquanto ela não termina (gates L3). */
  private running: Promise<unknown> | null = null
  private readonly intervalMs: number

  constructor(private readonly deps: RefreshWorkerDeps, opts: { intervalMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? REFRESH_MIN_MINUTES * 60_000
  }

  /** Uma rodada: cada estabelecimento virado, um de cada vez. Erro de um vai ao log e não para os outros; `stop()` corta entre eles. */
  async runOnce(): Promise<EstablishmentRun[]> {
    const out: EstablishmentRun[] = []
    const list = await this.deps.establishments()
    for (const est of list) {
      if (this.stopped) break
      try {
        if (!(await this.deps.stillTurned(est))) {                         // D-F247: a lista pode ter minutos
          logger.warn('Worker do rodízio: estabelecimento deixou de estar virado/ativo durante a rodada — fisco não consultado', {
            code: 'REFRESH_WORKER_ESTABLISHMENT_DROPPED', institutionId: est.institutionId,
          })
          out.push({ institutionId: est.institutionId, dropped: true })
          continue
        }
        const contracted = new Set(await this.deps.licensed(est, PASS_INTERFACES))
        const interfaces = PASS_INTERFACES.filter(k => contracted.has(k))
        const liveOnlyInterfaces = PASS_INTERFACES.filter(k => !contracted.has(k))
        const actor: Actor = { schemaName: est.schemaName, institutionId: est.institutionId, userId: null }   // voz sem autor (D-F239)
        const report = await this.deps.pass(actor, { terminal: WEB_TERMINAL, interfaces, liveOnlyInterfaces })
        // gates M4: na rota o usuário via o erro por nota na tela; no worker ninguém vê — vai ao log (A1 vencido, credencial, fisco fora…)
        if (report.errors.length || report.stoppedEarly) {
          logger.warn('Worker do rodízio: a passada do estabelecimento terminou com falhas', {
            code: 'REFRESH_WORKER_PASS_ERRORS', institutionId: est.institutionId, stoppedEarly: report.stoppedEarly,
            errors: report.errors.map(e => ({ invoiceId: e.invoiceId, code: e.code })),
          })
        }
        out.push({ institutionId: est.institutionId, report })
      } catch (err) {
        const error = errOf(err)
        logger.error('Worker do rodízio: a passada do estabelecimento falhou — segue para o próximo', {
          code: 'REFRESH_WORKER_PASS_FAILED', institutionId: est.institutionId, errCode: error.code, err: error.message,
        })
        out.push({ institutionId: est.institutionId, error })
      }
    }
    const sum = (f: (r: RefreshRunReport) => number) => out.reduce((n, r) => n + (r.report ? f(r.report) : 0), 0)
    logger.info('Worker do rodízio: rodada concluída', {
      establishments: out.length, checked: sum(r => r.checked), changed: sum(r => r.changed),
      skipped: out.filter(r => r.report?.skipped).length, dropped: out.filter(r => r.dropped).length, failed: out.filter(r => r.error).length,
    })
    return out
  }

  /** Liga o temporizador ENCADEADO: a próxima rodada só é agendada quando esta termina — nunca duas rodadas na mesma instância. */
  start(): void {
    this.stopped = false
    if (!this.running) this.schedule()                                     // com rodada em curso, o `finally` dela reagenda
  }

  /**
   * Não agenda mais; a rodada em curso para entre um estabelecimento e outro. Sem tratador de SIGTERM (ficha §0, recusado): morte
   * abrupta deixa o aluguel em mãos vencer sozinho (`REFRESH_LEASE_SECONDS`) e a voz não gravada é reconciliada na próxima passada.
   */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.running = this.runOnce()
        .catch(err => logger.error('Worker do rodízio: a rodada falhou (lista dos estabelecimentos)', { code: 'REFRESH_WORKER_RUN_FAILED', err: errOf(err).message }))
        .finally(() => { this.running = null; this.schedule() })
    }, this.intervalMs)
    this.timer.unref()
  }
}
