/// <reference types="jest" />
// GATE ADVERSARIAL da IB-3 (2026-10-15) — ataques PUROS (sem banco, sem fisco): XML hostil na leitura dos valores do fisco e da declaração,
// o cinto do montador, o calendário de leiaute, o DANFSe e as cercas (D-IB41 / escritor único). Os `it` com "ACHADO" ficam VERMELHOS até a
// correção; os demais documentam ataques que a entrega SEGUROU.
import fs from 'fs'
import path from 'path'
import { buildDpsId, buildDpsXml, parseNfseIbscbs, parseNfseDeclaration } from '../authority/dps-builder'
import { layoutAt, LAYOUT_CALENDAR } from '../authority/layout-calendar'
import type { DpsInput } from '../authority/types'
import { declarationForDps } from '../facts/service-facts'
import { readFiscalIbscbs } from '../nfse/ibscbs-values'
import { extractDanfseFields, renderDanfse } from '../nfse/danfse'

const PROJECT_ROOT = path.join(__dirname, '..', '..')

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const DECL = '<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><indDest>0</indDest>'
  + '<valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS>'
const TOT = (t: string, i = '0.25', c = '2.25') => `<totCIBS><vTotNF>${t}</vTotNF><gIBS><vIBSTot>${i}</vIBSTot></gIBS><gCBS><vCBS>${c}</vCBS></gCBS></totCIBS>`
const FISCO = (t = '250.00', i = '0.25', c = '2.25') => `<IBSCBS><cLocalidadeIncid>4106902</cLocalidadeIncid>${TOT(t, i, c)}</IBSCBS>`
/** NFS-e mínima: [beforeDps] entra como filhos de infNFSe antes do DPS; [inDps] dentro do infDPS; [afterInf] depois de infNFSe. */
function nfse(o: { beforeDps?: string; inDps?: string; afterInf?: string; serv?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="${NS}" versao="1.01"><infNFSe Id="NFS${'4'.repeat(50)}">`
    + `<nNFSe>708</nNFSe><valores><vLiq>250.00</vLiq></valores>${o.beforeDps ?? ''}`
    + `<DPS versao="1.01"><infDPS Id="DPS${'1'.repeat(42)}"><tpAmb>2</tpAmb>${o.serv ?? ''}${o.inDps ?? DECL}</infDPS></DPS></infNFSe>${o.afterInf ?? ''}</NFSe>`
}

// ---------------------------------------------------------------------------------------------------------
// (b) os valores do FISCO nunca vêm da declaração — XML hostil
// ---------------------------------------------------------------------------------------------------------
describe('(b) parseNfseIbscbs — o grupo DECLARADO nunca vira voz do fisco', () => {
  const trap = `<IBSCBS>${TOT('999.99', '9.99', '9.99')}</IBSCBS>`
  it.each([
    ['grupo do fisco AUSENTE, armadilha com totCIBS dentro do grupo declarado', { inDps: DECL.replace('</IBSCBS>', `${TOT('999.99')}</IBSCBS>`) }],
    ['armadilha como filho direto de DPS (fora do infDPS)', { beforeDps: '', inDps: DECL + '' , serv: '' , afterInf: '' , x: 1 }],
    ['armadilha ANINHADA em infNFSe/valores', { beforeDps: `<xOutInf>x</xOutInf>`, inDps: DECL, x: 2 }],
    ['armadilha DEPOIS de infNFSe (irmã, fora do caminho)', { afterInf: `<Signature>${trap}</Signature>` }],
  ] as const)('%s → values null', (_n, o: any) => {
    let xml = nfse(o)
    if (o.x === 1) xml = xml.replace('<DPS versao="1.01">', `<DPS versao="1.01">${trap}`)
    if (o.x === 2) xml = xml.replace('<valores><vLiq>250.00</vLiq></valores>', `<valores><vLiq>250.00</vLiq>${trap}</valores>`)
    expect(parseNfseIbscbs(xml)).toEqual({ declaredInDps: true, values: null })
  })

  it('o grupo do fisco vem DEPOIS do DPS (fora da ordem do XSD) — ainda é o filho direto de infNFSe: lido (posição não decide)', () => {
    const xml = nfse().replace('</DPS></infNFSe>', `</DPS>${FISCO()}</infNFSe>`)
    expect(parseNfseIbscbs(xml).values).toEqual({ totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' })
  })

  it('namespace: prefixo (vedado pelo manual) não casa; default redeclarado casa pelo nome QUALIFICADO (regra da família D-NE72 — conhecimento, não falha)', () => {
    const prefixed = nfse({ beforeDps: `<x:IBSCBS xmlns:x="${NS}">${TOT('1.00')}</x:IBSCBS>` })
    expect(parseNfseIbscbs(prefixed).values).toBeNull()
    const foreign = nfse({ beforeDps: `<IBSCBS xmlns="urn:evil">${TOT('1.00').replace(/<(\/?)/g, '<$1')}</IBSCBS>` })
    expect(parseNfseIbscbs(foreign).values).toEqual({ totalInvoiceValue: '1.00', ibsTotalValue: '0.25', cbsValue: '2.25' })
  })

  it.each([
    ['vazio', ''], ['só espaço', '   '], ['notação científica', '1e3'], ['notação científica maiúscula', '1E3'], ['sinal +', '+1.00'],
    ['negativo', '-0.01'], ['zero à esquerda', '01.00'], ['uma casa', '1.0'], ['três casas', '1.000'], ['sem inteiro', '.50'],
    ['vírgula', '1,00'], ['milhar com ponto', '1.000,00'], ['16 inteiros', '1000000000000000'], ['16 inteiros com centavos', '1000000000000000.00'],
    ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['hexa', '0x10'], ['dígitos árabes', '١٠'], ['dígitos largos', '１０'], ['espaço no meio', '1 000.00'],
  ])('vTotNF %s (%j) = unreadable (tudo ou nada)', (_n, v) => {
    expect(parseNfseIbscbs(nfse({ beforeDps: FISCO(v) })).values).toBe('unreadable')
  })

  it('15 inteiros + 2 decimais (teto do TSDec15V2) e "0"/"0.00" passam como TEXTO exato', () => {
    expect(parseNfseIbscbs(nfse({ beforeDps: FISCO('999999999999999.99', '0', '0.00') })).values)
      .toEqual({ totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0', cbsValue: '0.00' })
  })

  it('espaço/quebra de linha em volta do valor é aparado (o XSD diz whiteSpace=preserve — leitura tolerante, sem efeito no número)', () => {
    expect(parseNfseIbscbs(nfse({ beforeDps: FISCO('\n 250.00\t') })).values).toMatchObject({ totalInvoiceValue: '250.00' })
  })

  it.each([
    ['CDATA', '<![CDATA[250.00]]>'], ['comentário no meio', '250<!-- x -->.00'], ['filho elemento', '<v>250.00</v>'],
  ])('valor com %s: o leitor do núcleo recusa → readFiscalIbscbs = unreadable (a voz A segue; nunca exceção)', (_n, v) => {
    expect(readFiscalIbscbs(nfse({ beforeDps: FISCO(v) })).values).toBe('unreadable')
  })

  it('entidade numérica decodificada (&#49;0.00) é o mesmo texto 10.00 — aceito', () => {
    expect(parseNfseIbscbs(nfse({ beforeDps: FISCO('&#49;0.00') })).values).toMatchObject({ totalInvoiceValue: '10.00' })
  })

  it('XML gigante / DOCTYPE / entidade externa: o leitor do núcleo recusa → unreadable, nunca exceção', () => {
    expect(readFiscalIbscbs('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///c:/windows/win.ini">]><NFSe>&e;</NFSe>').values).toBe('unreadable')
    expect(readFiscalIbscbs(nfse({ beforeDps: `<IBSCBS>${'<a>'.repeat(5000)}</IBSCBS>` })).values).toBe('unreadable')
    expect(readFiscalIbscbs(undefined as any).values).toBe('unreadable')
  })

  it('CONHECIMENTO: grupo do fisco DUPLICADO (o XSD admite UM) — o 1º vence (mesma política do leitor da família; ex.: cancelBlock); só o fisco fora do XSD produz isto', () => {
    const xml = nfse({ beforeDps: FISCO('250.00') + FISCO('999.00') })
    expect(parseNfseIbscbs(xml).values).toMatchObject({ totalInvoiceValue: '250.00' })
  })
})

// ---------------------------------------------------------------------------------------------------------
// (a) o montador — o grupo só com o trio, na forma
// ---------------------------------------------------------------------------------------------------------
const base: DpsInput = {
  environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00', verAplic: 'nfse-api', serie: 1, nDps: 42, dCompet: '2026-12-20',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000199', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000188', xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal', cNBS: '115021000' } },
  valores: { vServ: 250, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
  ibscbs: { cIndOp: '100301', cClassTrib: '000001' },
}
const ID = buildDpsId('4106902', '2', '12345678000199', 1, 42)

describe('(a) montador e fonte de fatos', () => {
  it('grupo sem cNBS ("" ou ausente) nunca sai; NBS fora da forma no cServ nunca sai', () => {
    expect(() => buildDpsXml({ ...base, serv: { ...base.serv, cServ: { ...base.serv.cServ, cNBS: '' } } }, ID)).toThrow(/E0322/)
    expect(() => buildDpsXml({ ...base, serv: { ...base.serv, cServ: { ...base.serv.cServ, cNBS: '11502100' } } }, ID)).toThrow(/cNBS/)
  })

  it('a fonte de fatos recusa (422) toda forma torta antes do montador: espaços internos, dígitos largos, letras, 7 dígitos', () => {
    for (const [c, p, n] of [['000 001', '100301', '115021000'], ['０００００１', '100301', '115021000'], ['00000A', '100301', '115021000'],
      ['000001', '1003011', '115021000'], ['000001', '100301', '1.1502.10.00']] as const) {
      expect(() => declarationForDps({ classificationCode: c, placeIndicatorCode: p, nbs: n })).toThrow(expect.objectContaining({ statusCode: 422 }))
    }
  })

  it('injeção pelo código: nada de marcação chega ao XML', () => {
    expect(() => buildDpsXml({ ...base, ibscbs: { cIndOp: '100301', cClassTrib: '</cClassTrib><x>' } }, ID)).toThrow()
  })

  it('ACHADO (LOW): o CINTO do montador NORMALIZA em vez de conferir — digits() descarta o que não é dígito ("000-001", "10.03.01" saem como 000001/100301)', () => {
    expect(() => buildDpsXml({ ...base, ibscbs: { cIndOp: '10.03.01', cClassTrib: '000-001' } }, ID)).toThrow()
  })
})

// ---------------------------------------------------------------------------------------------------------
// (f) calendário de leiaute
// ---------------------------------------------------------------------------------------------------------
describe('(f) calendário de leiaute', () => {
  it('ambiente/documento/instante inválidos falham ALTO', () => {
    expect(() => layoutAt('DPS', 'X' as any, new Date('2026-12-20T00:00:00Z'))).toThrow(/Sem leiaute/)
    expect(() => layoutAt('NFSE' as any, 'P', new Date('2026-12-20T00:00:00Z'))).toThrow(/Sem leiaute/)
    expect(() => layoutAt('DPS', 'P', new Date(NaN))).toThrow(/Instante inválido/)
    expect(() => layoutAt('DPS', 'P', null as any)).toThrow()
  })
  it('a constante não se altera em execução (push/escrita numa linha lançam)', () => {
    expect(() => (LAYOUT_CALENDAR as any).push({ document: 'DPS', environment: 'P', validFrom: '2026-01-01T00:00:00Z', version: '9.99' })).toThrow()
    expect(() => { (LAYOUT_CALENDAR[1] as any).version = '9.99' }).toThrow()
    expect(layoutAt('DPS', 'P', new Date())).toBe('1.01')
  })
  it('nada liga o grupo por DATA nem por variável: presença do grupo = presença da declaração, em qualquer instante/ambiente', () => {
    process.env.IBSCBS_ENABLED = '0'; process.env.NFSE_IBSCBS = 'off'
    try {
      for (const dhEmi of ['2021-01-01T00:00:00-03:00', '2026-12-31T23:59:59-03:00', '2027-01-01T00:00:00-03:00', '2035-06-01T12:00:00Z']) {
        for (const environment of ['H', 'P'] as const) {
          expect(buildDpsXml({ ...base, dhEmi, environment }, ID)).toContain('<IBSCBS>')
          const { ibscbs: _g, ...sem } = base
          expect(buildDpsXml({ ...sem, dhEmi, environment }, ID)).not.toContain('<IBSCBS>')
        }
      }
    } finally { delete process.env.IBSCBS_ENABLED; delete process.env.NFSE_IBSCBS }
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'authority', 'layout-calendar.ts'), 'utf8')
    expect(src).not.toMatch(/process\.env|getConfig|interface_config/)
  })
})

// ---------------------------------------------------------------------------------------------------------
// (e) DANFSe e declaração enviada com XML ausente/ilegível/hostil
// ---------------------------------------------------------------------------------------------------------
describe('(e) DANFSe / "No fisco" com XML hostil — nunca 500', () => {
  it('declaração ilegível no DPS embutido: parseNfseDeclaration lança XmlUnreadable (a tela "No fisco" engole — try/catch); o DANFSe vira 422 com código', () => {
    const cdata = nfse({ inDps: DECL.replace('<CST>000</CST>', '<CST><![CDATA[000]]></CST>') })
    expect(() => parseNfseDeclaration(cdata)).toThrow()
    expect(() => extractDanfseFields(cdata)).toThrow(expect.objectContaining({ statusCode: 422, code: 'FISCAL_DANFSE_XML_UNREADABLE' }))
  })
  it('declaração com código fora da forma no XML: sem bloco (null), sem erro; valores do fisco hostis no DANFSe só viram "—"', async () => {
    expect(parseNfseDeclaration(nfse({ inDps: DECL.replace('000001', '00001') }))).toBeNull()
    const hostile = nfse({ beforeDps: `<IBSCBS><valores><vBC>abc</vBC></valores>${TOT('NaN', '1e308', '-5')}</IBSCBS>` })
    const f = extractDanfseFields(hostile)
    expect(f.ibscbs?.fiscal?.vTotNF).toBe('NaN')
    const pdf = await renderDanfse(hostile, { issuerName: 'Setes', municipality: 'Curitiba / PR' })
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  })
  it('nota sem declaração (forma REAL das NFS-e 704–707 de produção): sem o campo ibscbs', () => {
    expect(extractDanfseFields(nfse({ inDps: '' }))).not.toHaveProperty('ibscbs')
  })
})

// ---------------------------------------------------------------------------------------------------------
// (g) cercas estáticas — contornáveis
// ---------------------------------------------------------------------------------------------------------
describe('(g) cerca D-IB41 e escritor único (regex sobre o texto)', () => {
  const fenceSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'src', '__tests__', 'ibscbs-ib3.test.ts'), 'utf8')
  const forbidden = new RegExp(fenceSrc.match(/const forbidden = \/(.+)\/\n/)![1])
  it('ACHADO (LOW): a cerca D-IB41 só pega `tb_service` com alias sv/s — outros aliases/AS/crase/concatenação lêem a presunção sem acusar', () => {
    const bypasses = [
      'SELECT p.nbs FROM `${s}`.tb_service p WHERE p.id = ?',
      'LEFT JOIN `${s}`.tb_service AS sv ON sv.id = it.tb_product_id',
      'JOIN `${s}`.`tb_service` sv ON …',
      "const t = 'tb_service' + '_ibscbs'",
      'FROM setes_central.tb_tax_ibscbs_classification c',                 // este a cerca pega (controle)
    ]
    expect(bypasses.map(b => forbidden.test(b))).toEqual([true, true, true, true, true])
  })
})
