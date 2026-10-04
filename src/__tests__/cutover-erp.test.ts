/// <reference types="jest" />
// nfse-api — D-F44 (Valdo 2026-10-04): o ATO da virada aposenta a habilitação SE do ERP; conferência da série da NOTA.
import { assertNoteSerieKept, retireErpServiceIssuer, ERP_DEFAULT_NOTE_SERIE } from '../../scripts/cutover-erp'

describe('D-F44 — conferência da série da NOTA antes de aposentar a habilitação SE do ERP', () => {
  it('série efetiva = o default que o setes-api usará depois → segue (inclusive série NULL, que já é o default)', () => {
    expect(ERP_DEFAULT_NOTE_SERIE).toBe('1')
    expect(() => assertNoteSerieKept('setes_x', { serie: '1', deleted: 'N' })).not.toThrow()
    expect(() => assertNoteSerieKept('setes_x', { serie: null, deleted: 'N' })).not.toThrow()
  })
  it('série da nota ≠ default → FALHA ALTA antes de qualquer escrita (nunca mudar a série das notas novas em silêncio)', () => {
    for (const serie of ['2', '900', ' 1', '', '01']) {                    // espelho exato do setes-api: sem trim, sem número
      expect(() => assertNoteSerieKept('setes_x', { serie, deleted: 'N' })).toThrow(/série da NOTA SE do ERP/)
    }
  })
  it('linha já aposentada → nada muda na série (o setes-api já usa o default)', () => {
    expect(() => assertNoteSerieKept('setes_x', { serie: '7', deleted: 'S' })).not.toThrow()
  })
  it('aposentar = UPDATE deleted=S só na linha VIVA do modelo, no schema do cliente; devolve as linhas', async () => {
    const c = { query: jest.fn(async () => [{ affectedRows: 1 }]) } as any
    expect(await retireErpServiceIssuer(c, 'setes_x', 7, 'SE')).toBe(1)
    const [sql, params] = c.query.mock.calls[0]
    expect(sql).toMatch(/UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S', updated_at = NOW\(\)\s+WHERE tb_institution_id = \? AND model = \? AND deleted = 'N'/)
    expect(params).toEqual([7, 'SE'])
  })
})
