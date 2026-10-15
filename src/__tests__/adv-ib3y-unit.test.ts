/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA do retrabalho da IB-3 (2026-10-15, rodada "ib3y") — sem banco (conexão falsa / XML em memória).
//   ACHADO (LOW) ADV-IB3Y-01: `fillAuthorityIbscbs` confere o InvoiceTx só na ENTRADA; com 3 `await` antes do INSERT, uma chamada sem `await`
//                 grava DEPOIS do COMMIT (autocommit / transação de outra requisição). A família já tem a regra (NE1A2-02 — 2ª conferência
//                 logo antes de gravar, `insertTransmissionEvent` do núcleo). Prova no banco real: adv-ib3y-db (y4).
//   ACHADO (LOW) ADV-IB3Y-02: o cabeçalho da migration 007 ainda prescreve o escritor "INSERT … SELECT … AND NOT EXISTS" — exatamente a forma
//                 que o gate PROVOU travar o intervalo (1213 entre notas diferentes, d9). Quem confiar no comentário "restaura" o deadlock.
//   resistiu: E0234/E0903 locais com tomador CPF sem endereço, cIndOp fora da lista, nationalCode nulo/curto; amarra XML × chave.
import fs from 'fs'
import path from 'path'
import { withInvoiceTx, invoiceRef, HttpError } from 'fiscal-api'
import { fillAuthorityIbscbs } from '../nfse/repository'
import { readFiscalIbscbs } from '../nfse/ibscbs-values'
import { assertIbscbsGroupDeliverable, CIND_OP_REQUIRES_RECIPIENT_ADDRESS } from '../facts/service-facts'

const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
const KEY = '4'.repeat(50)
const V = { totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' }
const tick = () => new Promise(r => setImmediate(r))

/** Conexão falsa que registra a ORDEM (inclusive BEGIN/COMMIT/RELEASE) — a tentativa detém a chave e não há linha. */
function orderedPool() {
  const log: string[] = []
  const query = jest.fn(async (sql: string) => {
    await tick()                                                                 // o servidor responde depois (fila da conexão)
    const head = sql.trim().split(/\s+/).slice(0, 2).join(' ')
    log.push(head)
    if (/FROM tb_invoice_service_transmission\s/.test(sql)) return [[{ ok: 1 }]]
    if (/FROM tb_invoice_service_transmission_ibscbs/.test(sql)) return [[]]
    return [{ affectedRows: 1 }]
  })
  const conn = {
    query,
    beginTransaction: jest.fn(async () => { log.push('BEGIN') }),
    commit: jest.fn(async () => { log.push('COMMIT') }),
    rollback: jest.fn(async () => { log.push('ROLLBACK') }),
    release: jest.fn(() => { log.push('RELEASE') }),
  }
  return { pool: { query, getConnection: jest.fn(async () => conn) } as any, log }
}

describe('ADV-IB3Y-01 (LOW) — NE1A2-02 no escritor dos valores IBS/CBS', () => {
  it('chamado SEM await dentro do callback: o INSERT nunca pode sair depois do COMMIT (2ª conferência do InvoiceTx logo antes de gravar)', async () => {
    const { pool, log } = orderedPool()
    let floating: Promise<unknown> = Promise.resolve()
    await withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, invoiceRef(1, 7000, 0), { label: 'ib3y', lock: async () => LOCKED as any },
      async itx => { floating = fillAuthorityIbscbs(itx, 3, KEY, V).catch(e => e) })
    await floating
    for (let i = 0; i < 10; i++) await tick()
    const ins = log.indexOf('INSERT INTO'), commit = log.indexOf('COMMIT')
    expect({ log, insertBeforeCommitOrNone: ins === -1 || ins < commit }).toMatchObject({ insertBeforeCommitOrNone: true })
  })
})

describe('ADV-IB3Y-02 (LOW) — o cabeçalho da migration 007 descreve o escritor que o gate aposentou', () => {
  it('a migration não prescreve INSERT … SELECT … NOT EXISTS para o escritor (a forma provada em deadlock — d9)', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sql', '007_transmission_ibscbs_values.sql'), 'utf8')
    const header = sql.split(/\r?\n/).filter(l => l.startsWith('--')).join('\n')
    expect(header).not.toMatch(/INSERT\s*…\s*SELECT\s*…\s*WHERE[^\n]*NOT EXISTS/)
  })
})

describe('resistiu — E0234/E0903 locais (assertIbscbsGroupDeliverable)', () => {
  const g = { cIndOp: '100301', cClassTrib: '000001' }
  const status = (fn: () => void): number | 'ok' | string => {
    try { fn(); return 'ok' } catch (e) { return e instanceof HttpError ? (e as any).status ?? (e as any).statusCode : String(e) }
  }
  it('cIndOp da lista (todos os 13) + tomador CPF SEM endereço = 422 com o campo; com endereço completo passa', () => {
    for (const op of CIND_OP_REQUIRES_RECIPIENT_ADDRESS) {
      expect(status(() => assertIbscbsGroupDeliverable({ ...g, cIndOp: op }, { cpf: '12345678909', xNome: 'Fulano' } as any, '010201'))).toBe(422)
    }
    expect(status(() => assertIbscbsGroupDeliverable(g, { cpf: '12345678909', xNome: 'F',
      end: { cMun: '4106902', cep: '80000000', xLgr: 'Rua', nro: '1', xBairro: 'Centro' } } as any, '010201'))).toBe('ok')
  })
  it('cIndOp FORA da lista sem endereço passa (a regra 255 é só para os 13 da lista)', () => {
    expect(status(() => assertIbscbsGroupDeliverable({ ...g, cIndOp: '020101' }, { cpf: '12345678909', xNome: 'F' } as any, '010201'))).toBe('ok')
  })
  it('nationalCode nulo/curto/25.05: nunca TypeError (500); 25.05 = 422 E0903', () => {
    const toma = { cnpj: '12345678000199', xNome: 'X', end: { cMun: '4106902', cep: '80000000', xLgr: 'R', nro: '1', xBairro: 'B' } } as any
    expect(status(() => assertIbscbsGroupDeliverable(g, toma, null as any))).toBe('ok')
    expect(status(() => assertIbscbsGroupDeliverable(g, toma, '25' as any))).toBe('ok')
    expect(status(() => assertIbscbsGroupDeliverable(g, toma, '250501'))).toBe(422)
    for (const sub of ['150901', '171201', '100501']) expect(status(() => assertIbscbsGroupDeliverable(g, toma, sub))).toBe(422)
  })
})

describe('resistiu — amarra XML × chave (readFiscalIbscbs)', () => {
  const nfse = (id: string | null) =>
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe${id === null ? '' : ` Id="${id}"`}><nNFSe>1</nNFSe>` +
    `<DPS><infDPS Id="DPS1"><IBSCBS><finNFSe>0</finNFSe></IBSCBS></infDPS></DPS>` +
    `<IBSCBS><totCIBS><vTotNF>250.00</vTotNF><gIBS><vIBSTot>0.25</vIBSTot></gIBS><gCBS><vCBS>2.25</vCBS></gCBS></totCIBS></IBSCBS></infNFSe></NFSe>`
  it('Id exato (NFS + chave) pousa; Id ausente, com espaço, com prefixo minúsculo ou de outra chave = key-mismatch (conservador: nada gravado)', () => {
    expect(readFiscalIbscbs(nfse(`NFS${KEY}`), KEY).values).toEqual(V)
    for (const id of [null, ` NFS${KEY}`, `nfs${KEY}`, `NFS${'5'.repeat(50)}`, `NFSE${KEY}`, `NFS${KEY} `]) {
      expect({ id, values: readFiscalIbscbs(nfse(id), KEY).values }).toEqual({ id, values: 'key-mismatch' })
    }
  })
})
