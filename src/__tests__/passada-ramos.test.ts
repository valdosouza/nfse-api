/// <reference types="jest" />
// D-F46 (Q-F52 (b), Valdo 2026-10-04): ramo não contratado = bloqueio total — inclusive na PASSADA do rodízio.
// O filtro pelos ramos de quem pede vive no SQL das candidatas, ANTES do LIMIT (molde do listPendingServiceInvoices:
// filtrar em JS depois do LIMIT prendia linhas no topo — gate socrático HIGH-1).
import { listRefreshCandidates } from '../nfse/repository'

const fakeQ = () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const q = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [[], []] }) }
  return { q: q as any, calls }
}

describe('D-F46 — candidatas da passada filtradas pelo RAMO (vw_order_interface, default "orders")', () => {
  it('com ramos: junta a view de política do schema do cliente e filtra no WHERE, com o parâmetro ANTES do LIMIT', async () => {
    const { q, calls } = fakeQ()
    await listRefreshCandidates(q, 'setes_setes', 1, 5, 10, 8, { authorizedMaxDays: 90, interfaces: ['service-orders', 'orders'] })
    expect(calls).toHaveLength(1)
    const { sql, params } = calls[0]
    expect(sql).toMatch(/LEFT JOIN `setes_setes`\.vw_order_interface oi\s+ON oi\.tb_institution_id = t\.tb_institution_id AND oi\.tb_order_id = t\.tb_invoice_id AND oi\.terminal = t\.terminal/)
    expect(sql).toMatch(/AND COALESCE\(oi\.interface_key, 'orders'\) IN \(\?\)\s+ORDER BY/)
    expect(sql.indexOf('IN (?)')).toBeLessThan(sql.indexOf('LIMIT ?'))
    expect(params).toEqual([1, 10, 5, 5, 90, 24, ['service-orders', 'orders'], 8])
  })

  it('lista vazia → nenhuma candidata e NENHUMA consulta ao banco (nunca "sem filtro")', async () => {
    const { q, calls } = fakeQ()
    expect(await listRefreshCandidates(q, 'setes_setes', 1, 5, 10, 8, { interfaces: [] })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('sem a opção (chamada interna): o SQL é o de antes — sem a view, sem o parâmetro', async () => {
    const { q, calls } = fakeQ()
    await listRefreshCandidates(q, 'setes_setes', 1, 5, 10, 8, { authorizedMaxDays: 90 })
    expect(calls[0].sql).not.toMatch(/vw_order_interface/)
    expect(calls[0].params).toEqual([1, 10, 5, 5, 90, 24, 8])
  })
})
