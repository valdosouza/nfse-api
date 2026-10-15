/// <reference types="jest" />
// Cerca do harness ao vivo (gate socrático da IB-3, L1 — 2026-10-15): toda tabela que as migrations da família CRIAM está na cópia
// descartável e na vigilância do `fiscal_api` REAL (`FISCAL_COPY_TABLES`) — ou numa exceção NOMEADA com o motivo. Tabela nova esquecida
// fora da lista = esta cerca vermelha (antes: entrava na cópia pelas migrations e ficava fora do CHECKSUM, calada).
import { FISCAL_COPY_TABLES, FISCAL_COPY_EXCEPTIONS, tablesByMigration } from './live-harness'

describe('cerca do harness: tabelas da família × FISCAL_COPY_TABLES', () => {
  it('toda tabela criada pelas migrations (núcleo + nfse-api) está na lista ou numa exceção nomeada', () => {
    const created = [...new Set(tablesByMigration().map(t => t.table))].sort()
    expect(created).toContain('tb_invoice_service_transmission_ibscbs')
    expect(created.filter(t => !FISCAL_COPY_TABLES.includes(t) && !(t in FISCAL_COPY_EXCEPTIONS))).toEqual([])
  })
  it('a lista não cita tabela que nenhuma migration cria (nome errado = vigilância de tabela inexistente)', () => {
    const created = new Set(tablesByMigration().map(t => t.table))
    expect(FISCAL_COPY_TABLES.filter(t => !created.has(t))).toEqual([])
  })
  it('comentário com "CREATE TABLE" não conta como tabela', () => {
    expect(tablesByMigration().map(t => t.table)).not.toContain('com')
  })
})
