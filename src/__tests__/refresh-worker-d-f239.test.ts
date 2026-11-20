/// <reference types="jest" />
// DEPLOY.E2.P1.T1 — o WORKER DO RODÍZIO (D-F239/D-F240/D-F252/D-F253), unitário com dublês: quem ele percorre, com que escopo, sem autor,
// o erro de um que não para os outros, o temporizador encadeado e a variável que liga/desliga. A prova com duas instâncias sobre o banco é a
// suíte ao vivo `refresh-worker-d-f239.live.test.ts`.
import fs from 'fs'
import path from 'path'
import { WEB_TERMINAL, HttpError, logger } from 'fiscal-api'
import { RefreshWorker, RefreshWorkerDeps, refreshWorkerEnabled } from '../worker/refresh-worker'
import { PASS_INTERFACES, transmitServiceInvoice, reconfirmBeforeLocalCancel, cancelServiceInvoiceAtAuthority } from '../nfse/transmission'
import { turnedServiceEstablishments } from '../facts/service-facts'
import type { Actor, RefreshRunReport } from '../nfse/transmission'

const ok = (over: Partial<RefreshRunReport> = {}): RefreshRunReport => ({ checked: 1, changed: 0, errors: [], stoppedEarly: false, skipped: false, ...over })
const A = { institutionId: 1, schemaName: 'setes_a' }
const B = { institutionId: 2, schemaName: 'setes_b' }
const C = { institutionId: 3, schemaName: 'setes_c' }

function dubles(over: Partial<RefreshWorkerDeps> = {}) {
  const calls: { actor: Actor; opts: { terminal: number; interfaces: readonly string[]; liveOnlyInterfaces: readonly string[] } }[] = []
  const deps: RefreshWorkerDeps = {
    establishments: async () => [A, B],
    stillTurned: async () => true,
    licensed: async () => [...PASS_INTERFACES],
    pass: async (actor, opts) => { calls.push({ actor, opts }); return ok() },
    ...over,
  }
  return { deps, calls }
}

describe('D-F239 — uma rodada do worker', () => {
  it('passa por cada estabelecimento do leitor, um de cada vez, pela passada com o terminal da web e SEM autor', async () => {
    const { deps, calls } = dubles()
    const out = await new RefreshWorker(deps).runOnce()
    expect(out.map(r => r.institutionId)).toEqual([1, 2])
    expect(calls.map(c => c.actor)).toEqual([{ ...A, userId: null }, { ...B, userId: null }])
    expect(calls.every(c => c.opts.terminal === WEB_TERMINAL)).toBe(true)
  })

  it('escopo pela LICENÇA (D-F46/D-F47 sem privilégio): contratados → todas as candidatas; cortados → só as vivas', async () => {
    const { deps, calls } = dubles({ licensed: async (who, keys) => (who.institutionId === 1 ? ['service-orders'] : []).filter(k => keys.includes(k)) })
    await new RefreshWorker(deps).runOnce()
    expect(calls[0].opts).toMatchObject({ interfaces: ['service-orders'], liveOnlyInterfaces: ['orders', 'order-returns'] })
    expect(calls[1].opts).toMatchObject({ interfaces: [], liveOnlyInterfaces: [...PASS_INTERFACES] })
  })

  it('pergunta a licença com o estabelecimento do leitor e os ramos da passada (a mesma lista da rota)', async () => {
    const asked: unknown[] = []
    const { deps } = dubles({ licensed: async (who, keys) => { asked.push({ who, keys: [...keys] }); return [] } })
    await new RefreshWorker(deps).runOnce()
    expect(asked).toEqual([{ who: A, keys: [...PASS_INTERFACES] }, { who: B, keys: [...PASS_INTERFACES] }])
  })

  it('o erro de um estabelecimento (passada ou licença) vai ao relatório e NÃO para os outros', async () => {
    const { deps, calls } = dubles({
      establishments: async () => [A, B, C],
      licensed: async who => { if (who.institutionId === 2) throw new Error('banco fora'); return [...PASS_INTERFACES] },
      pass: async (actor, opts) => {
        if (actor.institutionId === 1) throw new HttpError(409, 'réplica', undefined, 'FISCAL_CUTOVER_PENDING')
        calls.push({ actor, opts }); return ok()
      },
    })
    const out = await new RefreshWorker(deps).runOnce()
    expect(out).toEqual([
      { institutionId: 1, error: { code: 'FISCAL_CUTOVER_PENDING', message: 'réplica' } },
      { institutionId: 2, error: { code: null, message: 'banco fora' } },
      { institutionId: 3, report: ok() },
    ])
    expect(calls.map(c => c.actor.institutionId)).toEqual([3])
  })

  it('a passada que pulou (aluguel de outra instância — D-F41) entra no relatório como `skipped`', async () => {
    const { deps } = dubles({ pass: async () => ok({ checked: 0, skipped: true }) })
    const out = await new RefreshWorker(deps).runOnce()
    expect(out.every(r => r.report?.skipped)).toBe(true)
  })

  it('sem estabelecimento virado, a rodada não chama licença nem passada', async () => {
    const licensed = jest.fn(async () => [] as string[])
    const { deps, calls } = dubles({ establishments: async () => [], licensed })
    expect(await new RefreshWorker(deps).runOnce()).toEqual([])
    expect(licensed).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('`stop()` durante a rodada corta ENTRE um estabelecimento e outro (o em curso termina)', async () => {
    let worker: RefreshWorker
    const { deps, calls } = dubles({
      establishments: async () => [A, B, C],
      pass: async (actor, opts) => { calls.push({ actor, opts }); worker.stop(); return ok() },
    })
    worker = new RefreshWorker(deps)
    const out = await worker.runOnce()
    expect(out.map(r => r.institutionId)).toEqual([1])
  })
})

describe('D-F247 no worker e a operação (gates de 2026-11-20)', () => {
  it('estabelecimento que deixou de estar virado/ativo/com o mesmo schema entre a lista e a passada: fisco NÃO consultado, os outros seguem', async () => {
    const licensed = jest.fn(async () => [...PASS_INTERFACES])
    const { deps, calls } = dubles({ establishments: async () => [A, B, C], stillTurned: async who => who.institutionId !== 2, licensed })
    const out = await new RefreshWorker(deps).runOnce()
    expect(out.find(r => r.institutionId === 2)).toEqual({ institutionId: 2, dropped: true })
    expect(calls.map(c => c.actor.institutionId)).toEqual([1, 3])
    expect(licensed.mock.calls.map(c => (c as any)[0].institutionId)).toEqual([1, 3])   // nem a licença do que saiu
  })

  it('a reconferência é feita com o estabelecimento da lista, imediatamente antes de cada passada', async () => {
    const order: string[] = []
    const { deps } = dubles({
      stillTurned: async who => { order.push(`check ${who.institutionId}`); return true },
      pass: async actor => { order.push(`pass ${actor.institutionId}`); return ok() },
    })
    await new RefreshWorker(deps).runOnce()
    expect(order).toEqual(['check 1', 'pass 1', 'check 2', 'pass 2'])
  })

  it('a passada que termina com erro por nota ou parada antes vai ao LOG com código (no worker ninguém vê a tela — A1 vencido etc.)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    try {
      const { deps } = dubles({
        establishments: async () => [A],
        pass: async () => ok({ stoppedEarly: true, errors: [{ invoiceId: 7, code: 'FISCAL_CERTIFICATE_EXPIRED', message: 'A1 vencido' }] }),
      })
      await new RefreshWorker(deps).runOnce()
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        code: 'REFRESH_WORKER_PASS_ERRORS', institutionId: 1, stoppedEarly: true, errors: [{ invoiceId: 7, code: 'FISCAL_CERTIFICATE_EXPIRED' }],
      }))
    } finally { warn.mockRestore() }
  })
})

describe('D-F239 — o temporizador encadeado', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('a próxima rodada só é agendada quando a anterior termina — nunca duas na mesma instância', async () => {
    let running = 0, maxRunning = 0, runs = 0
    let release: () => void = () => {}
    const { deps } = dubles({
      establishments: async () => {
        running++; runs++; maxRunning = Math.max(maxRunning, running)
        await new Promise<void>(r => { release = () => { running--; r() } })
        return []
      },
    })
    const w = new RefreshWorker(deps, { intervalMs: 1000 })
    w.start()
    expect(runs).toBe(0)                                     // a 1ª rodada espera o intervalo
    await jest.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    await jest.advanceTimersByTimeAsync(10_000)              // a rodada não terminou: nada novo
    expect(runs).toBe(1)
    release()
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    expect(maxRunning).toBe(1)
    w.stop(); release()
  })

  it('a rodada que falha inteira (lista dos estabelecimentos) não mata o temporizador', async () => {
    let runs = 0
    const { deps } = dubles({ establishments: async () => { runs++; throw new Error('banco fora') } })
    const w = new RefreshWorker(deps, { intervalMs: 1000 })
    w.start()
    await jest.advanceTimersByTimeAsync(1000)
    await jest.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    w.stop()
  })

  it('`stop()` e `start()` com a rodada em curso não abrem uma segunda rodada na mesma instância', async () => {
    let running = 0, maxRunning = 0, runs = 0
    const releases: (() => void)[] = []
    const { deps } = dubles({
      establishments: async () => {
        running++; runs++; maxRunning = Math.max(maxRunning, running)
        await new Promise<void>(r => releases.push(() => { running--; r() }))
        return []
      },
    })
    const w = new RefreshWorker(deps, { intervalMs: 1000 })
    w.start()
    await jest.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(1)
    w.stop(); w.start()
    await jest.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(1)                                     // nada novo enquanto a rodada antiga não termina
    releases.shift()!()
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    expect(maxRunning).toBe(1)
    w.stop(); releases.forEach(r => r())
  })

  it('`stop()` não agenda mais', async () => {
    let runs = 0
    const { deps } = dubles({ establishments: async () => { runs++; return [] } })
    const w = new RefreshWorker(deps, { intervalMs: 1000 })
    w.start()
    await jest.advanceTimersByTimeAsync(1000)
    w.stop()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(runs).toBe(1)
  })

  it('o intervalo padrão é o `REFRESH_MIN_MINUTES` (5 min)', async () => {
    let runs = 0
    const { deps } = dubles({ establishments: async () => { runs++; return [] } })
    const w = new RefreshWorker(deps)
    w.start()
    await jest.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(runs).toBe(0)
    await jest.advanceTimersByTimeAsync(1)
    expect(runs).toBe(1)
    w.stop()
  })
})

describe('D-F252 — onde o worker liga (`NFSE_REFRESH_WORKER`)', () => {
  it('ausente ou vazia: ligado só em produção', () => {
    expect(refreshWorkerEnabled({ NODE_ENV: 'production' })).toBe(true)
    expect(refreshWorkerEnabled({ NODE_ENV: ' Production ' })).toBe(true)
    expect(refreshWorkerEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(refreshWorkerEnabled({})).toBe(false)
    expect(refreshWorkerEnabled({ NODE_ENV: 'development', NFSE_REFRESH_WORKER: '  ' })).toBe(false)
  })
  it('`on` liga fora de produção; `off` desliga em produção', () => {
    expect(refreshWorkerEnabled({ NODE_ENV: 'development', NFSE_REFRESH_WORKER: 'on' })).toBe(true)
    expect(refreshWorkerEnabled({ NODE_ENV: 'production', NFSE_REFRESH_WORKER: 'OFF' })).toBe(false)
  })
  it('valor desconhecido lança (o boot falha)', () => {
    for (const v of ['1', 'true', 'sim', 'ligado', 'no']) {
      expect(() => refreshWorkerEnabled({ NODE_ENV: 'production', NFSE_REFRESH_WORKER: v })).toThrow(/NFSE_REFRESH_WORKER inválida/)
    }
  })
})

describe('cercas do texto (gates de 2026-11-20)', () => {
  const ROOT = path.resolve(__dirname, '..')
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

  it('o leitor dos estabelecimentos do worker exige habilitação SE viva e VIRADA e institution ativa e não excluída (D-F39/D-F247), num predicado só', () => {
    const src = read('facts/service-facts.ts')
    const sql = /const TURNED_SERVICE_SQL =\s*`([^`]*)`/.exec(src)?.[1] ?? ''
    for (const cond of [`e.cutover_at IS NOT NULL`, `e.deleted = 'N'`, `e.model = ?`, `i.active = 'S'`, `i.deleted = 'N'`]) expect(sql).toContain(cond)
    expect(src).toMatch(/\$\{TURNED_SERVICE_SQL\} ORDER BY/)                                       // a lista
    expect(src).toMatch(/\$\{TURNED_SERVICE_SQL\} AND e\.tb_institution_id = \? AND i\.schema_name = \?/)   // a reconferência
  })

  it('o `server.ts` lê a variável ANTES das migrations e liga o worker real só quando ela manda (D-F252 — a parte "roda sozinha")', () => {
    const src = read('server.ts')
    const at = (s: string) => { const i = src.indexOf(s); expect(i).toBeGreaterThan(-1); return i }
    expect(at('refreshWorkerEnabled(process.env)')).toBeLessThan(at('runMigrations('))
    expect(src).toMatch(/if \(workerOn\) \{\s*new RefreshWorker\(refreshWorkerDeps\(ctx\)\)\.start\(\)/)
    expect(at('new RefreshWorker(')).toBeGreaterThan(at('.listen('))
  })
})

describe('gates de 2026-11-20 — leitor linha a linha e o ato que exige usuário', () => {
  it('uma linha com schema inválido NÃO derruba a lista: vai ao `onInvalid` com o id e as outras seguem; sem `onInvalid`, falha alto', async () => {
    const q = { query: async () => [[
      { institutionId: 1, schemaName: 'setes_a' }, { institutionId: 2, schemaName: null }, { institutionId: 3, schemaName: 'x; DROP' }, { institutionId: 4, schemaName: 'setes_d' },
    ]] } as any
    const bad: number[] = []
    expect(await turnedServiceEstablishments(q, id => bad.push(id))).toEqual([{ institutionId: 1, schemaName: 'setes_a' }, { institutionId: 4, schemaName: 'setes_d' }])
    expect(bad).toEqual([2, 3])
    await expect(turnedServiceEstablishments(q)).rejects.toThrow()
  })

  it('transmitir, reconferir e cancelar recusam o ator SEM usuário em execução (o tipo é a 1ª cerca; `as` passaria) — antes de tocar banco ou fisco', async () => {
    const actor = { schemaName: 'setes_a', institutionId: 1, userId: null } as any
    const deps = new Proxy({}, { get: () => { throw new Error('não podia tocar nas dependências') } }) as any
    const ref = { institutionId: 1, invoiceId: 10, terminal: WEB_TERMINAL } as any
    for (const act of [() => transmitServiceInvoice(deps, actor, ref), () => reconfirmBeforeLocalCancel(deps, actor, ref), () => cancelServiceInvoiceAtAuthority(deps, actor, ref, 'motivo de teste qualquer')]) {
      await expect(act()).rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/sem usuário/) })
    }
  })
})
