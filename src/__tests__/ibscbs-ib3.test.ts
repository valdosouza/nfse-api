/// <reference types="jest" />
// Fase IBS/CBS, IB-3 (Infra-IA/prompts/prompt_fase_ibs_cbs.md §13 — D-IB76…D-IB84): a nfse-api LEVA ao fisco a DECLARAÇÃO que o ERP congelou
// e GUARDA os valores que o fisco devolveu. Montador do grupo (ordem e forma contra o XSD OFICIAL do acervo — D-IB84), calendário de leiaute
// (D-IB81), forma da declaração na fonte de fatos, leitura dos valores POR CAMINHO (dois IBSCBS no XML — T2), escritor write-once (D-IB77),
// alarmes (D-IB80) e as cercas (D-IB41: a nfse-api nunca lê a presunção nem o catálogo; escritor único dos valores).
import fs from 'fs'
import path from 'path'
import { withInvoiceTx, invoiceRef, logger } from 'fiscal-api'
import { buildDpsId, buildDpsXml, buildCancelEventXml, parseNfseIbscbs, nfseDpsHasIbscbs } from '../authority/dps-builder'
import { layoutAt, LAYOUT_CALENDAR } from '../authority/layout-calendar'
import type { DpsInput } from '../authority/types'
import { declarationForDps } from '../facts/service-facts'
import { fillAuthorityIbscbs } from '../nfse/repository'
import { readFiscalIbscbs, recordIbscbsValues } from '../nfse/ibscbs-values'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(PROJECT_ROOT, 'src')

/** A pasta Infra-IA do workspace (sobe a partir do projeto — vale na árvore viva e na worktree `ib3`). */
function infraIa(): string {
  let dir = PROJECT_ROOT
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'Infra-IA')
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error('Infra-IA não encontrada acima do projeto')
}
const XSD = fs.readFileSync(path.join(infraIa(), 'setes-api', 'integracoes', 'nfse-adn', 'xsd', 'Schemas', '1.01', 'tiposComplexos_v1.01.xsd'), 'utf8')

/** A sequência de elementos FILHOS do tipo complexo [name] no XSD oficial (os tipos aninhados têm nome próprio). */
function xsdSequence(name: string): string[] {
  const start = XSD.indexOf(`<xs:complexType name="${name}">`)
  if (start < 0) throw new Error(`tipo ${name} não está no XSD`)
  const end = XSD.indexOf('</xs:complexType>', start)
  return [...XSD.slice(start, end).matchAll(/<xs:element name="([^"]+)"/g)].map(m => m[1])
}
/** Os nomes dos filhos DIRETOS do 1º elemento <tag>…</tag> do XML (sem lib — o XML é nosso, sem atributos nos filhos). */
function childrenOf(xml: string, tag: string): string[] {
  const open = xml.indexOf(`<${tag}`)
  const inner = xml.slice(xml.indexOf('>', open) + 1, xml.indexOf(`</${tag}>`, open))
  const out: string[] = []
  let depth = 0
  for (const m of inner.matchAll(/<(\/?)([A-Za-z]+)[^>]*>/g)) {
    if (m[1] === '/') { depth--; continue }
    if (depth === 0) out.push(m[2])
    depth++
  }
  return out
}
/** [got] é subsequência de [seq] (mesma ordem) e contém [required]. */
function followsXsd(got: string[], seq: string[], required: string[]): void {
  let i = 0
  for (const g of got) {
    while (i < seq.length && seq[i] !== g) i++
    expect({ element: g, inXsdOrder: i < seq.length }).toEqual({ element: g, inXsdOrder: true })
    i++
  }
  for (const r of required) expect(got).toContain(r)
}

const base: DpsInput = {
  environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00', verAplic: 'nfse-api', serie: 1, nDps: 42, dCompet: '2026-12-20',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000195', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000198', xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal', cNBS: '115021000' } },
  valores: { vServ: 250, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
  ibscbs: { cIndOp: '100301', cClassTrib: '000001' },
}
const DPS_ID = buildDpsId('4106902', '2', '12345678000195', 1, 42)

describe('montador do grupo IBS/CBS (D-IB2/D-IB62 — ordem e forma contra o XSD oficial, D-IB84)', () => {
  const xml = buildDpsXml(base, DPS_ID)

  it('IBSCBS é o ÚLTIMO filho de infDPS e a ordem dos irmãos segue o TCInfDPS do XSD', () => {
    const got = childrenOf(xml, 'infDPS')
    expect(got[got.length - 1]).toBe('IBSCBS')
    const seq = xsdSequence('TCInfDPS')
    expect(seq[seq.length - 1]).toBe('IBSCBS')
    followsXsd(got, seq, ['tpAmb', 'dhEmi', 'serv', 'valores', 'IBSCBS'])
  })

  it('filhos do grupo na ordem do TCRTCInfoIBSCBS, com os obrigatórios; derivados por construção: finNFSe 0, indDest 0, CST = prefixo', () => {
    followsXsd(childrenOf(xml, 'IBSCBS'), xsdSequence('TCRTCInfoIBSCBS'), ['finNFSe', 'cIndOp', 'indDest', 'valores'])
    expect(xml).toContain('<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><indDest>0</indDest>'
      + '<valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS></infDPS>')
    followsXsd(['CST', 'cClassTrib'], xsdSequence('TCRTCInfoTributosSitClas'), ['CST', 'cClassTrib'])
    // nada fora do 1º release (§5 da fase) nem tpRetPisCofins (D-IB19)
    for (const no of ['indFinal', 'tpOper', 'tpEnteGov', 'dest', 'imovel', 'gReeRepRes', 'cCredPres', 'gTribRegular', 'gDif', 'tpRetPisCofins']) {
      expect(xml).not.toContain(`<${no}>`)
    }
  })

  it('cNBS vai em serv/cServ depois de xDescServ (ordem do TCCServ)', () => {
    followsXsd(childrenOf(xml, 'cServ'), xsdSequence('TCCServ'), ['cTribNac', 'xDescServ', 'cNBS'])
    expect(xml).toContain('<xDescServ>Suporte mensal</xDescServ><cNBS>115021000</cNBS></cServ>')
  })

  it('sem declaração: nenhum grupo (o DPS de hoje); NBS sozinha (D-IB62) sai como cNBS sem o grupo', () => {
    const { ibscbs: _g, ...semGrupo } = base
    const x = buildDpsXml(semGrupo, DPS_ID)
    expect(x).not.toContain('<IBSCBS>')
    expect(x).toContain('<cNBS>115021000</cNBS>')
  })

  it('E0322 como cinto: grupo sem cNBS é erro de programação (a fonte de fatos recusa antes com 422)', () => {
    expect(() => buildDpsXml({ ...base, serv: { ...base.serv, cServ: { cTribNac: '010201', xDescServ: 'x' } } }, DPS_ID)).toThrow(/E0322/)
  })

  it('códigos fora da forma nunca chegam ao XML (6 dígitos)', () => {
    expect(() => buildDpsXml({ ...base, ibscbs: { cIndOp: '10030', cClassTrib: '000001' } }, DPS_ID)).toThrow(/cIndOp/)
    expect(() => buildDpsXml({ ...base, ibscbs: { cIndOp: '100301', cClassTrib: '0000011' } }, DPS_ID)).toThrow(/cClassTrib/)
  })
})

describe('calendário de leiaute (D-IB81)', () => {
  it('versão por documento × ambiente × INSTANTE; o DPS e o evento levam a versão do calendário', () => {
    for (const env of ['H', 'P'] as const) {
      expect(layoutAt('DPS', env, new Date('2026-12-20T13:00:00Z'))).toBe('1.01')
      expect(layoutAt('EVENT', env, new Date('2027-02-01T00:00:00Z'))).toBe('1.01')
    }
    expect(buildDpsXml(base, DPS_ID)).toContain('versao="1.01"')
    expect(buildCancelEventXml({
      accessKey: '4'.repeat(50), dhEvento: '2026-12-20T10:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissao da nota',
      environment: 'H', verAplic: 'nfse-api', cnpjAutor: '12345678000195',
    })).toContain('versao="1.01"')
  })
  it('constante CONGELADA (nunca flag/variável em execução); instante antes de toda linha = falha alta', () => {
    expect(Object.isFrozen(LAYOUT_CALENDAR)).toBe(true)
    expect(Object.isFrozen(LAYOUT_CALENDAR[0])).toBe(true)
    expect(() => layoutAt('DPS', 'P', new Date('1999-01-01T00:00:00Z'))).toThrow(/Sem leiaute/)
    expect(() => layoutAt('DPS', 'P', new Date('x'))).toThrow(/Instante inválido/)
  })
})

describe('forma da declaração na fonte de fatos (declarationForDps — D-IB76…)', () => {
  const d = (classificationCode: string | null, placeIndicatorCode: string | null, nbs: string | null) =>
    declarationForDps({ classificationCode, placeIndicatorCode, nbs })
  it('trio completo = grupo + cNBS; NBS sozinha = só cNBS; nada = nada', () => {
    expect(d('000001', '100301', '115021000')).toEqual({ ibscbs: { cIndOp: '100301', cClassTrib: '000001' }, cNBS: '115021000' })
    expect(d(null, null, '115021000')).toEqual({ cNBS: '115021000' })
    expect(d(null, null, null)).toEqual({})
  })
  it.each([
    ['par incompleto (só cClassTrib)', ['000001', null, '115021000'], 'ibscbs'],
    ['par incompleto (só cIndOp)', [null, '100301', '115021000'], 'ibscbs'],
    ['grupo sem NBS (E0322)', ['000001', '100301', null], 'nbs'],
    ['cClassTrib fora da forma', ['00001', '100301', '115021000'], 'ibscbs.classificationCode'],
    ['NBS fora da forma', ['000001', '100301', '11502100'], 'nbs'],
  ] as const)('%s = 422 FISCAL_DPS_INVALID com o campo — nunca descarta calado', (_n, args, field) => {
    expect(() => d(...(args as unknown as [string | null, string | null, string | null])))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'FISCAL_DPS_INVALID' }))
    try { d(...(args as unknown as [string | null, string | null, string | null])) } catch (e: any) {
      expect(e.fields.map((f: any) => f.field)).toContain(field)
    }
  })
})

/** NFS-e autorizada mínima com os DOIS grupos IBSCBS (T2): o do fisco (filho de infNFSe) e o declarado (dentro do DPS embutido). */
function nfse(opts: { fiscal?: string | null; declared?: boolean; dpsTrap?: boolean } = {}): string {
  const fiscal = opts.fiscal === undefined
    ? '<IBSCBS><cLocalidadeIncid>4106902</cLocalidadeIncid><valores><vBC>250.00</vBC></valores>'
      + '<totCIBS><vTotNF>250.00</vTotNF><gIBS><vIBSTot>0.25</vIBSTot></gIBS><gCBS><vCBS>2.25</vCBS></gCBS></totCIBS></IBSCBS>'
    : (opts.fiscal ?? '')
  const declared = opts.declared === false ? '' : '<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><indDest>0</indDest>'
    + '<valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores>'
    + (opts.dpsTrap ? '<totCIBS><vTotNF>999.99</vTotNF><gIBS><vIBSTot>9.99</vIBSTot></gIBS><gCBS><vCBS>9.99</vCBS></gCBS></totCIBS>' : '')
    + '</IBSCBS>'
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${'4'.repeat(50)}">`
    + `<nNFSe>708</nNFSe><valores><vLiq>250.00</vLiq></valores>${fiscal}`
    + `<DPS versao="1.01"><infDPS Id="DPS${'1'.repeat(42)}"><tpAmb>2</tpAmb>${declared}</infDPS></DPS></infNFSe></NFSe>`
}

describe('valores do fisco lidos POR CAMINHO (parseNfseIbscbs — T2, D-IB80)', () => {
  it('lê só o IBSCBS filho DIRETO de infNFSe; texto TSDec15V2 (nunca número do JS)', () => {
    expect(parseNfseIbscbs(nfse())).toEqual({
      declaredInDps: true, values: { totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' },
    })
    const big = nfse({ fiscal: '<IBSCBS><totCIBS><vTotNF>999999999999999.99</vTotNF><gIBS><vIBSTot>0</vIBSTot></gIBS><gCBS><vCBS>0</vCBS></gCBS></totCIBS></IBSCBS>' })
    expect(parseNfseIbscbs(big).values).toEqual({ totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0', cbsValue: '0' })
  })
  it('o fisco OMITIU o grupo dele: values null — NUNCA lê o grupo declarado do DPS embutido como voz do fisco (mesmo com totCIBS lá dentro)', () => {
    expect(parseNfseIbscbs(nfse({ fiscal: null, dpsTrap: true }))).toEqual({ declaredInDps: true, values: null })
  })
  it('sem o grupo no DPS (E1517): declaredInDps false', () => {
    expect(parseNfseIbscbs(nfse({ fiscal: null, declared: false }))).toEqual({ declaredInDps: false, values: null })
  })
  it.each([
    ['vCBS ausente', '<IBSCBS><totCIBS><vTotNF>1.00</vTotNF><gIBS><vIBSTot>0.10</vIBSTot></gIBS><gCBS></gCBS></totCIBS></IBSCBS>'],
    ['vTotNF com vírgula', '<IBSCBS><totCIBS><vTotNF>1,00</vTotNF><gIBS><vIBSTot>0.10</vIBSTot></gIBS><gCBS><vCBS>0.90</vCBS></gCBS></totCIBS></IBSCBS>'],
    ['negativo', '<IBSCBS><totCIBS><vTotNF>-1.00</vTotNF><gIBS><vIBSTot>0.10</vIBSTot></gIBS><gCBS><vCBS>0.90</vCBS></gCBS></totCIBS></IBSCBS>'],
    ['16 inteiros (além do TSDec15V2 / DECIMAL(17,2))', '<IBSCBS><totCIBS><vTotNF>1000000000000000.00</vTotNF><gIBS><vIBSTot>0</vIBSTot></gIBS><gCBS><vCBS>0</vCBS></gCBS></totCIBS></IBSCBS>'],
    ['valor no lugar errado (fora de totCIBS)', '<IBSCBS><vTotNF>1.00</vTotNF><gIBS><vIBSTot>0.10</vIBSTot></gIBS><gCBS><vCBS>0.90</vCBS></gCBS></IBSCBS>'],
  ])('%s = unreadable (tudo ou nada)', (_n, fiscal) => {
    expect(parseNfseIbscbs(nfse({ fiscal })).values).toBe('unreadable')
  })
  it('documento ilegível para o leitor = unreadable na leitura de fora da transação (a voz A segue)', () => {
    expect(readFiscalIbscbs('<NFSe><infNFSe><![CDATA[x]]>').values).toBe('unreadable')
  })
})

// ---------------------------------------------------------------------------------------------------------
// escritor write-once (D-IB77) e alarmes (D-IB80) — InvoiceTx de verdade, conexão falsa
// ---------------------------------------------------------------------------------------------------------
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
const KEY = '4'.repeat(50)
type Row = { t: string; i: string; c: string }
/** Conexão falsa do fluxo do escritor: tentativa detém a chave? · linha atual · erro do INSERT · linha vista na releitura travante. */
function fakePool(a: { holder?: boolean; current?: Row | null; insertError?: any; raced?: Row | null; savepointGone?: boolean } = {}) {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p })
    if (/^ROLLBACK TO SAVEPOINT/.test(sql) && a.savepointGone) throw Object.assign(new Error('SAVEPOINT does not exist'), { code: 'ER_SP_DOES_NOT_EXIST' })
    if (/FROM tb_invoice_service_transmission\s/.test(sql)) return [a.holder === false ? [] : [{ ok: 1 }]]
    if (/^\s*INSERT INTO tb_invoice_service_transmission_ibscbs/.test(sql)) {
      if (a.insertError) throw a.insertError
      return [{ affectedRows: 1 }]
    }
    if (/FROM tb_invoice_service_transmission_ibscbs[\s\S]*LOCK IN SHARE MODE/.test(sql)) return [a.raced ? [a.raced] : []]
    if (/FROM tb_invoice_service_transmission_ibscbs/.test(sql)) return [a.current ? [a.current] : []]
    return [{ affectedRows: 0 }]
  })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  return { pool: { query, getConnection: jest.fn(async () => conn) } as any, calls }
}
const V = { totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' }
const inTx = <T>(pool: any, fn: (itx: any) => Promise<T>) =>
  withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, invoiceRef(1, 7000, 0), { label: 'ib3', lock: async () => LOCKED as any }, fn)
const write = (pool: any, v = V, key = KEY) => inTx(pool, itx => fillAuthorityIbscbs(itx, 3, key, v))

describe('fillAuthorityIbscbs — write-once na tentativa que DETÉM a chave DESTA NFS-e (D-IB77; gates da IB-3)', () => {
  it('grava o TEXTO conferido por INSERT … VALUES (nunca INSERT … SELECT — o SELECT dele trava o INTERVALO; nunca IGNORE), dentro de um SAVEPOINT', async () => {
    const { pool, calls } = fakePool()
    expect(await write(pool)).toEqual({ result: 'inserted' })
    const sqls = calls.map(c => c.sql.trim().split(/\s+/).slice(0, 3).join(' '))
    expect(sqls[0]).toBe('SAVEPOINT ibscbs_values')
    expect(sqls[sqls.length - 1]).toBe('RELEASE SAVEPOINT ibscbs_values')
    const holder = calls.find(c => /FROM tb_invoice_service_transmission\s/.test(c.sql))!
    expect(holder.sql).toMatch(/access_key = \?/)                     // a chave DESTA NFS-e — nunca "tem alguma chave"
    expect(holder.p).toEqual([1, 7000, 0, 3, KEY])
    const ins = calls.find(c => /INSERT INTO tb_invoice_service_transmission_ibscbs/.test(c.sql))!
    expect(ins.sql).not.toMatch(/IGNORE|SELECT|NOT EXISTS/)
    expect(ins.p).toEqual([1, 7000, 0, 3, '250.00', '0.25', '2.25'])
    // nenhuma leitura travante sobre linha que pode não existir (a trava da NOTA já serializa o escritor — D-F27)
    expect(calls.filter(c => /LOCK IN SHARE MODE|FOR UPDATE/.test(c.sql))).toEqual([])
  })
  it('já gravado igual = same; diferente = divergent (fica o 1º); tentativa sem ESTA chave = no-key — nada inserido', async () => {
    const same = fakePool({ current: { t: '250.00', i: '0.25', c: '2.25' } })
    expect(await write(same.pool)).toEqual({ result: 'same' })
    expect(await write(fakePool({ current: { t: '250.00', i: '0.30', c: '2.25' } }).pool)).toEqual({ result: 'divergent' })
    const nokey = fakePool({ holder: false })
    expect(await write(nokey.pool)).toEqual({ result: 'no-key' })
    expect(await write(fakePool({ current: { t: '0.00', i: '0.00', c: '0.00' } }).pool, { totalInvoiceValue: '0', ibsTotalValue: '0', cbsValue: '0' }))
      .toEqual({ result: 'same' })
    for (const f of [same, nokey]) expect(f.calls.some(c => /INSERT INTO/.test(c.sql))).toBe(false)
  })
  it('corrida sem a trava (1062): releitura TRAVANTE da linha que EXISTE decide same/divergent', async () => {
    const dup = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 })
    expect(await write(fakePool({ insertError: dup, raced: { t: '250.00', i: '0.25', c: '2.25' } }).pool)).toEqual({ result: 'same' })
    expect(await write(fakePool({ insertError: dup, raced: { t: '9.00', i: '0.25', c: '2.25' } }).pool)).toEqual({ result: 'divergent' })
  })
  it('COMPARTIMENTO: erro do banco que não é deadlock = ROLLBACK TO SAVEPOINT e `failed` com o código (a voz A segue)', async () => {
    const gone = Object.assign(new Error("Table doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
    const f = fakePool({ insertError: gone })
    expect(await write(f.pool)).toEqual({ result: 'failed', code: 'ER_NO_SUCH_TABLE' })
    expect(f.calls.some(c => /^ROLLBACK TO SAVEPOINT ibscbs_values/.test(c.sql))).toBe(true)
  })
  it('deadlock = repassa (o InnoDB desfez a transação inteira — seguir rodaria a voz A em AUTOCOMMIT); savepoint perdido = repassa', async () => {
    const dl = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
    const f = fakePool({ insertError: dl })
    await expect(inTx(f.pool, itx => fillAuthorityIbscbs(itx, 3, KEY, V).then(() => 'seguiu'))).rejects.toBeDefined()
    expect(f.calls.some(c => /^ROLLBACK TO SAVEPOINT/.test(c.sql))).toBe(false)
    const lw = Object.assign(new Error('Lock wait timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
    await expect(write(fakePool({ insertError: lw, savepointGone: true }).pool)).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
  })
  it('fora da trava da nota (sem InvoiceTx emitido) = nada gravado', async () => {
    await expect(fillAuthorityIbscbs({ conn: {}, ref: {}, open: true } as any, 1, KEY, V)).rejects.toThrow(/D-NE74/)
  })
})

describe('recordIbscbsValues — alarmes sem conteúdo do XML (D-IB80/D-F100)', () => {
  let spy: jest.SpyInstance
  beforeEach(() => { spy = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any) })
  afterEach(() => spy.mockRestore())
  const at = { institutionId: 1, invoiceId: 7000, origin: 'consulta' as const, accessKey: KEY }
  const ctx = { origin: 'consulta', institutionId: 1, invoiceId: 7000, attempt: 3 }

  it('grupo declarado e valores ausentes (E1515) = alarme, sem linha; nada declarado (E1517) = silêncio', async () => {
    const { pool, calls } = fakePool()
    await inTx(pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: true, values: null }, at))
    await inTx(pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: false, values: null }, at))
    expect(calls).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatch(/AUSENTES[\s\S]*E1515/)
  })
  it('ilegível, de outra NFS-e, divergente, sem a chave = alarme e nada gravado; o alarme leva só ids (nunca valores)', async () => {
    await inTx(fakePool().pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: true, values: 'unreadable' }, at))
    await inTx(fakePool().pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: true, values: 'key-mismatch' }, at))
    await inTx(fakePool({ current: { t: '1.00', i: '0.10', c: '0.90' } }).pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: true, values: V }, at))
    await inTx(fakePool({ holder: false }).pool, itx => recordIbscbsValues(itx, 3, { declaredInDps: true, values: V }, at))
    expect(spy.mock.calls.map(c => c[0])).toEqual([expect.stringMatching(/ILEGÍVEIS/), expect.stringMatching(/não é a NFS-e da chave/),
      expect.stringMatching(/DIVERGENTES/), expect.stringMatching(/não detém a chave/)])
    for (const c of spy.mock.calls) expect(c[1]).toEqual(ctx)
  })
  it('erro do banco isolado = alarme com o CÓDIGO (sem mensagem do banco) e a voz A segue', async () => {
    const gone = Object.assign(new Error("Table 'x' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
    const vozA = jest.fn()
    await expect(inTx(fakePool({ insertError: gone }).pool, async itx => {
      await recordIbscbsValues(itx, 3, { declaredInDps: true, values: V }, at); vozA(); return 'A gravada'
    })).resolves.toBe('A gravada')
    expect(vozA).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatch(/NÃO GRAVADOS \(erro do banco isolado/)
    expect(spy.mock.calls[0][1]).toEqual({ ...ctx, code: 'ER_NO_SUCH_TABLE' })
  })
  it('nunca lança por causa dos valores (a voz A segue)', async () => {
    await expect(inTx(fakePool().pool, itx => recordIbscbsValues(itx, 3, readFiscalIbscbs('lixo', KEY), at))).resolves.toBeUndefined()
  })
})

describe('readFiscalIbscbs — os valores só pousam se o XML É a NFS-e da chave da voz (gate socrático da IB-3, L3)', () => {
  it('chave do documento = a da voz → valores; outra chave ou sem Id → key-mismatch; sem chave pedida → só a leitura', () => {
    const xml = nfse()
    const own = (xml.match(/infNFSe Id="NFS(\d{50})"/) ?? [])[1]
    expect(own).toBeDefined()
    expect(readFiscalIbscbs(xml, own).values).toEqual(V)
    expect(readFiscalIbscbs(xml, '9'.repeat(50)).values).toBe('key-mismatch')
    expect(readFiscalIbscbs(xml.replace(/ Id="NFS\d{50}"/, ''), own).values).toBe('key-mismatch')
    expect(readFiscalIbscbs(xml).values).toEqual(V)
  })
})

// ---------------------------------------------------------------------------------------------------------
// cercas
// ---------------------------------------------------------------------------------------------------------
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

describe('cercas da IB-3', () => {
  it('D-IB41: a nfse-api NUNCA lê a presunção do serviço nem o catálogo IBS/CBS — só o ramo congelado', () => {
    // gate adversarial da IB-3 (LOW): QUALQUER menção solta a `tb_service` (crase, AS, outro alias, concatenação 'tb_service' + …) — a
    // nfse-api lê o serviço só pelo ramo congelado (`tb_invoice_service`, que não casa: `_service` dentro de outra palavra)
    const forbidden = /\b(tb_service_ibscbs|tb_tax_ibscbs\w*|tb_nbs|tb_ibscbs_place_indicator\w*)\b|(?<![A-Za-z0-9_])tb_service(?![A-Za-z0-9_])/
    const offenders = [...tsFiles(SRC), ...tsFiles(path.join(PROJECT_ROOT, 'scripts'))]
      .filter(f => forbidden.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(PROJECT_ROOT, f))
    expect(offenders).toEqual([])
  })

  it('D-IB77: escritor ÚNICO dos valores — só src/nfse/repository.ts escreve tb_invoice_service_transmission_ibscbs', () => {
    const writers = [...tsFiles(SRC), ...tsFiles(path.join(PROJECT_ROOT, 'scripts'))].filter(f => {
      const text = fs.readFileSync(f, 'utf8')
      return /\b(INSERT|REPLACE|UPDATE|DELETE)\b[^`]*tb_invoice_service_transmission_ibscbs/i.test(text)
    }).map(f => path.relative(PROJECT_ROOT, f).replace(/\\/g, '/'))
    expect(writers).toEqual(['src/nfse/repository.ts'])
  })
})

// ---------------------------------------------------------------------------------------------------------
// tela "No fisco" e DANFSe (NT 008) — leitura POR CAMINHO, só exibição
// ---------------------------------------------------------------------------------------------------------
import { parseNfseDeclaration } from '../authority/dps-builder'
import { getIbscbsValues } from '../nfse/repository'
import { extractDanfseFields, renderDanfse, fmtDecText, addDecText } from '../nfse/danfse'

describe('declaração ENVIADA lida do DPS embutido (parseNfseDeclaration — D-F76)', () => {
  it('lê CST/cClassTrib/cIndOp do infDPS/IBSCBS e o cNBS de serv/cServ — nunca do grupo do fisco', () => {
    const xml = nfse().replace('<tpAmb>2</tpAmb>', '<tpAmb>2</tpAmb><serv><cServ><cTribNac>010201</cTribNac><xDescServ>x</xDescServ><cNBS>115021000</cNBS></cServ></serv>')
    expect(parseNfseDeclaration(xml)).toEqual({ cst: '000', classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' })
  })
  it('DPS sem o grupo = null (mesmo com o grupo do fisco presente)', () => {
    expect(parseNfseDeclaration(nfse({ declared: false }))).toBeNull()
  })
})

describe('getIbscbsValues — texto exato do DECIMAL (tela "No fisco")', () => {
  it('lê da tentativa pedida, só viva; ausente = null', async () => {
    const q = { query: jest.fn().mockResolvedValueOnce([[{ t: '999999999999999.99', i: '0.25', c: '2.25' }]]).mockResolvedValueOnce([[]]) }
    expect(await getIbscbsValues(q as any, invoiceRef(1, 7000, 0), 3))
      .toEqual({ totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0.25', cbsValue: '2.25' })
    expect(q.query.mock.calls[0][0]).toMatch(/CAST\(total_invoice_value AS CHAR\)[\s\S]*deleted = 'N'/)
    expect(q.query.mock.calls[0][1]).toEqual([1, 7000, 0, 3])
    expect(await getIbscbsValues(q as any, invoiceRef(1, 7000, 0), 3)).toBeNull()
  })
})

describe('DANFSe com o bloco IBS/CBS (NT 008)', () => {
  const full = nfse({ fiscal: '<IBSCBS><cLocalidadeIncid>4106902</cLocalidadeIncid><xLocalidadeIncid>Curitiba</xLocalidadeIncid>'
    + '<valores><vBC>250.00</vBC><uf><pIBSUF>0.10</pIBSUF><pAliqEfetUF>0.10</pAliqEfetUF></uf><mun><pIBSMun>0.00</pIBSMun><pAliqEfetMun>0.00</pAliqEfetMun></mun>'
    + '<fed><pCBS>0.90</pCBS><pAliqEfetCBS>0.90</pAliqEfetCBS></fed></valores>'
    + '<totCIBS><vTotNF>252.50</vTotNF><gIBS><vIBSTot>0.25</vIBSTot><gIBSUFTot><vIBSUF>0.25</vIBSUF></gIBSUFTot><gIBSMunTot><vIBSMun>0.00</vIBSMun></gIBSMunTot></gIBS>'
    + '<gCBS><vCBS>2.25</vCBS></gCBS></totCIBS></IBSCBS>' })

  it('lê a declaração do DPS embutido e os valores do grupo do FISCO, por caminho', () => {
    expect(extractDanfseFields(full).ibscbs).toEqual({
      cst: '000', cClassTrib: '000001', cIndOp: '100301', nbs: null,
      fiscal: {
        localidade: '4106902 — Curitiba', vBC: '250.00', pIBSUF: '0.10', pAliqEfetUF: '0.10', pIBSMun: '0.00', pAliqEfetMun: '0.00',
        pCBS: '0.90', pAliqEfetCBS: '0.90', vIBSUF: '0.25', vIBSMun: '0.00', vIBSTot: '0.25', vCBS: '2.25', vTotNF: '252.50',
      },
    })
  })
  it('o fisco não devolveu o grupo dele: bloco com a declaração e fiscal null (nunca o grupo declarado como valor)', () => {
    expect(extractDanfseFields(nfse({ fiscal: null, dpsTrap: true })).ibscbs).toMatchObject({ cClassTrib: '000001', fiscal: null })
  })
  it('nota sem a declaração: sem bloco; os valores do serviço seguem lidos do grupo certo (dois "valores" no infDPS)', () => {
    const f = extractDanfseFields(nfse({ declared: false, fiscal: null }))
    expect(f).not.toHaveProperty('ibscbs')   // sem o campo (paridade com o oráculo congelado do N17)
    expect(f.valores.vLiq).toBe('250.00')
  })
  it('o PDF sai com o bloco (sem erro)', async () => {
    const pdf = await renderDanfse(full, { issuerName: 'Setes' })
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  })
})

// ---------------------------------------------------------------------------------------------------------
// gates da IB-3 — DANFSe (D-IB86 + valor exato) e "congelada × enviada" (D-IB90)
// ---------------------------------------------------------------------------------------------------------
describe('DANFSe IBS/CBS — texto EXATO e o bloco pela declaração OU pelo grupo do fisco (D-IB86)', () => {
  it('valor do fisco formatado do TEXTO (15 inteiros sem perder centavo); ausente/fora da forma = "—" (nunca "0,00")', () => {
    expect(fmtDecText('999999999999999.99')).toBe('999.999.999.999.999,99')
    expect(fmtDecText('0')).toBe('0,00')
    expect(fmtDecText('2.5')).toBe('2,50')
    expect(fmtDecText(null)).toBe('—')
    for (const bad of ['NaN', '1e308', '-5', '', ' 1.00', '0001.00']) expect(fmtDecText(bad)).toBe('—')
  })
  it('total IBS + CBS somado em CENTAVOS (BigInt): exato acima de 1e13; parte ausente/fora = null', () => {
    expect(addDecText('999999999999999.99', '0.01')).toBe('1000000000000000.00')
    expect(addDecText('0.25', '2.25')).toBe('2.50')
    expect(addDecText('12345678901234.57', '0.01')).toBe('12345678901234.58')
    expect(addDecText(null, '1.00')).toBeNull()
    expect(addDecText('abc', '1.00')).toBeNull()
  })
  it('só o grupo do FISCO (sem a declaração no DPS embutido) = bloco presente com a declaração "não informada"', () => {
    const f = extractDanfseFields(nfse({ declared: false }))
    expect(f.ibscbs).toMatchObject({ cst: null, cClassTrib: null, cIndOp: null, nbs: null })
    expect(f.ibscbs?.fiscal?.vTotNF).toBe('250.00')
  })
  it('nem declaração nem grupo do fisco = sem o campo (paridade com o oráculo do N17)', () => {
    expect(extractDanfseFields(nfse({ declared: false, fiscal: null }))).not.toHaveProperty('ibscbs')
  })
})

describe('"congelada × enviada" (D-IB90): o DPS autorizado levou o grupo?', () => {
  it('levou = true · DPS sem o grupo = false · documento que nem é NFS-e = null', () => {
    expect(nfseDpsHasIbscbs(nfse())).toBe(true)
    expect(nfseDpsHasIbscbs(nfse({ declared: false }))).toBe(false)
    expect(nfseDpsHasIbscbs('<?xml version="1.0"?><outro/>')).toBeNull()
  })
})
