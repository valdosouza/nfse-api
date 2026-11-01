/// <reference types="jest" />
// GATE ADVERSARIAL do leiaute por ambiente (D-IB110…D-IB114 — prompt_fase_ibs_cbs.md §13.8, fim): bordas do calendário (instante da
// virada, fusos, dhEmi sem fuso, datas inválidas, ambiente inválido), leiaute fora da união em EXECUÇÃO, leitura HOSTIL da declaração na
// forma nova (CDATA, vazio, forma partida, trib/grupo duplicado, namespace) e o alarme do E1235 (D-IB111). Testes PUROS — sem banco, sem
// rede, sem fisco.
import { AuthorityHttpError } from 'fiscal-api'
import { buildDpsId, buildDpsXml, buildCancelEventXml, parseNfseDeclaration, nfseDpsHasIbscbs } from '../authority/dps-builder'
import { layoutAt, LAYOUT_CALENDAR, NfseLayout } from '../authority/layout-calendar'
import type { DpsInput } from '../authority/types'
import { isLayoutRejectedInProduction, LAYOUT_REJECTED_ALARM } from '../nfse/transmission'
import { extractDanfseFields } from '../nfse/danfse'

const base: DpsInput = {
  environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00', verAplic: 'nfse-api', serie: 900, nDps: 42, dCompet: '2026-12-20',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000195', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000198', xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal', cNBS: '115021000' } },
  valores: { vServ: 250, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
  ibscbs: { cIndOp: '100301', cClassTrib: '000001' },
}
const DPS_ID = buildDpsId('4106902', '2', '12345678000195', 900, 42)

/** O leiaute que o XML MONTADO tem, lido pela forma (finNFSe no infDPS só existe no pacote de 20/10/2026). */
const shapeOf = (xml: string): NfseLayout => (/<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe>/.test(xml) ? 'xsd-20261020' : 'xsd-20260209')
const dhEmiOf = (xml: string) => /<dhEmi>([^<]+)<\/dhEmi>/.exec(xml)![1]

describe('borda da virada de H (2026-10-20T21:10:00Z) — o leiaute do XML é o do dhEmi ESCRITO nele', () => {
  it('calendário ao milissegundo: 1 ms antes = 09/02; no instante e 1 ms depois = 20/10; P nunca vira', () => {
    expect(layoutAt('DPS', 'H', new Date('2026-10-20T21:09:59.999Z')).layout).toBe('xsd-20260209')
    expect(layoutAt('DPS', 'H', new Date('2026-10-20T21:10:00.000Z')).layout).toBe('xsd-20261020')
    expect(layoutAt('DPS', 'H', new Date('2026-10-20T21:10:00.001Z')).layout).toBe('xsd-20261020')
    expect(layoutAt('DPS', 'P', new Date('2026-10-20T21:10:00.001Z')).layout).toBe('xsd-20260209')
    expect(layoutAt('DPS', 'P', new Date('9999-12-31T23:59:59Z')).layout).toBe('xsd-20260209')
  })

  it.each([
    ['2026-10-20T18:09:59-03:00', 'xsd-20260209'],
    ['2026-10-20T18:10:00-03:00', 'xsd-20261020'],
    ['2026-10-20T21:09:59Z', 'xsd-20260209'],
    ['2026-10-20T21:10:00Z', 'xsd-20261020'],
    ['2026-10-21T00:10:00+03:00', 'xsd-20261020'],          // = 21:10Z noutro fuso
    ['2026-10-20T17:09:59-04:00', 'xsd-20260209'],          // = 21:09:59Z (fuso de Manaus)
    // milissegundo descartado no dhEmi ESCRITO: 18:09:59.999 vira 18:09:59 → o leiaute segue o que o fisco lê, não o instante cru
    ['2026-10-20T18:09:59.999-03:00', 'xsd-20260209'],
    // sem fuso = hora OFICIAL de Brasília (Q-TZ1), nunca o fuso do processo
    ['2026-10-20T18:09:59', 'xsd-20260209'],
    ['2026-10-20T18:10:00', 'xsd-20261020'],
  ] as const)('dhEmi %s → %s, e o leiaute bate com layoutAt(dhEmi escrito)', (dhEmi, expected) => {
    const xml = buildDpsXml({ ...base, environment: 'H', dhEmi }, DPS_ID)
    expect(shapeOf(xml)).toBe(expected)
    expect(layoutAt('DPS', 'H', new Date(dhEmiOf(xml))).layout).toBe(expected)
    // P, no mesmo instante, sempre o pacote de 09/02
    expect(shapeOf(buildDpsXml({ ...base, environment: 'P', dhEmi }, DPS_ID))).toBe('xsd-20260209')
  })

  it('data/hora inválida nunca escolhe leiaute: lança (vira 422 FISCAL_DPS_INVALID no buildSignedDps — nunca o fisco às cegas)', () => {
    for (const dhEmi of ['2026-10-20T25:00:00-03:00', '2026-13-01T10:00:00-03:00', 'amanhã', '', '2026-10-20T18:10:00-03']) {
      expect(() => buildDpsXml({ ...base, dhEmi }, DPS_ID)).toThrow()
    }
  })

  it('antes do piso do calendário (2000-01-01) não há leiaute — falha alta, nunca um default', () => {
    expect(() => buildDpsXml({ ...base, dhEmi: '1999-12-31T20:59:59-03:00' }, DPS_ID)).toThrow(/Sem leiaute/)   // = 23:59:59Z
    expect(buildDpsXml({ ...base, environment: 'P', dhEmi: '1999-12-31T21:00:00-03:00' }, DPS_ID)).toContain('versao="1.01"')   // = 00:00:00Z
  })
})

describe('ambiente inválido — nunca cai no tpAmb 2 por omissão', () => {
  it.each(['X', 'p', 'h', '', undefined, null])('DPS e evento com ambiente %p lançam "Sem leiaute"', env => {
    expect(() => buildDpsXml({ ...base, environment: env as any }, DPS_ID)).toThrow(/Sem leiaute/)
    expect(() => buildCancelEventXml({
      accessKey: '4'.repeat(50), dhEvento: '2026-12-20T10:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissao da nota',
      environment: env as any, verAplic: 'nfse-api', cnpjAutor: '12345678000195',
    })).toThrow(/Sem leiaute/)
  })
})

describe('leiaute FORA da união em execução (o `switch` exaustivo só protege em compilação)', () => {
  it('o montador recusa (DPS com e sem grupo/NBS) e o evento recusa — nunca sai um documento "meio a meio"', () => {
    jest.isolateModules(() => {
      jest.doMock('../authority/layout-calendar', () => {
        const real = jest.requireActual('../authority/layout-calendar')
        return { ...real, layoutAt: () => Object.freeze({ layout: 'xsd-29990101', version: '1.02' }) }
      })
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const b = require('../authority/dps-builder') as typeof import('../authority/dps-builder')
      const { ibscbs: _g, ...semGrupo } = base
      const plain: DpsInput = { ...semGrupo, serv: { ...base.serv, cServ: { cTribNac: '010201', xDescServ: 'x' } } }
      for (const input of [base, semGrupo, plain]) expect(() => b.buildDpsXml(input, DPS_ID)).toThrow(/sem forma no montador: xsd-29990101/)
      expect(() => b.buildCancelEventXml({
        accessKey: '4'.repeat(50), dhEvento: '2026-12-20T10:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissao da nota',
        environment: 'P', verAplic: 'nfse-api', cnpjAutor: '12345678000195',
      })).toThrow(/sem forma no montador/)
    })
    jest.dontMock('../authority/layout-calendar')
  })
})

describe('cerca do calendário para o DEPLOY da linha de P (D-IB111) — linha torta não pode sumir em silêncio', () => {
  // layoutAt ignora a linha cujo validFrom não é data (Date.parse → NaN; `NaN <= t` é false): uma linha de P digitada errado no deploy
  // da virada deixaria P no pacote antigo SEM erro — toda NFS-e recusaria com E1235. A forma canônica e a unicidade ficam cercadas aqui.
  it('todo validFrom é UTC canônico (YYYY-MM-DDTHH:mm:ssZ) e legível; nenhum par (documento, ambiente, validFrom) se repete', () => {
    const seen = new Set<string>()
    for (const l of LAYOUT_CALENDAR) {
      expect({ l, canonical: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(l.validFrom) }).toMatchObject({ canonical: true })
      expect(Number.isFinite(Date.parse(l.validFrom))).toBe(true)
      expect(new Date(Date.parse(l.validFrom)).toISOString().replace('.000Z', 'Z')).toBe(l.validFrom)   // 2026-02-30 etc. não rola de mês
      const k = `${l.document}|${l.environment}|${l.validFrom}`
      expect({ k, repeated: seen.has(k) }).toEqual({ k, repeated: false })
      seen.add(k)
      expect(['xsd-20260209', 'xsd-20261020']).toContain(l.layout)
      expect(l.version).toMatch(/^\d\.\d{2}$/)
    }
    // todo par (documento, ambiente) tem linha no piso — nenhum ambiente fica sem leiaute num instante qualquer depois de 2000
    for (const d of ['DPS', 'EVENT'] as const) for (const e of ['H', 'P'] as const) {
      expect(LAYOUT_CALENDAR.some(l => l.document === d && l.environment === e && l.validFrom === '2000-01-01T00:00:00Z')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// leitura HOSTIL da declaração embutida, forma nova (pacote de 20/10/2026)
// ---------------------------------------------------------------------------------------------------------------------------------------
const NS = 'http://www.sped.fazenda.gov.br/nfse'
function nfseWith(ibscbs: string, cNBS = '<cNBS>115021000</cNBS>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="${NS}" versao="1.01"><infNFSe Id="NFS${'4'.repeat(50)}"><nNFSe>1</nNFSe>`
    + `<DPS versao="1.01"><infDPS Id="${DPS_ID}"><tpAmb>2</tpAmb><serv><cServ><cTribNac>010201</cTribNac>${cNBS}<xDescServ>x</xDescServ></cServ></serv>`
    + `${ibscbs}</infDPS></DPS></infNFSe></NFSe>`
}
const NEW = (trib: string, head = '<cIndOp>100301</cIndOp><indDest>0</indDest>') => `<IBSCBS>${head}<valores>${trib}</valores></IBSCBS>`
const OK_TRIB = '<trib><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS></gIBSCBS></trib>'
const EXPECTED = { cst: '000', classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' }

describe('parseNfseDeclaration — XML hostil na FORMA NOVA (só exibição: nunca adivinha, nunca 500)', () => {
  it('a forma nova legítima (com <gIBSCBS/> auto-fechado e com filhos opcionais) é lida', () => {
    expect(parseNfseDeclaration(nfseWith(NEW(OK_TRIB)))).toEqual(EXPECTED)
    expect(parseNfseDeclaration(nfseWith(NEW('<trib><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS/></trib>')))).toEqual(EXPECTED)
    expect(parseNfseDeclaration(nfseWith(NEW('<trib><CST>000</CST><cClassTrib>000001</cClassTrib></trib>')))).toEqual(EXPECTED)
    expect(parseNfseDeclaration(nfseWith(NEW('<trib><CST>200</CST><cClassTrib>200001</cClassTrib><gIBSCBS><cCredPres>01</cCredPres></gIBSCBS></trib>'))))
      .toEqual({ ...EXPECTED, cst: '200', classificationCode: '200001' })
  })
  it.each([
    ['CST vazio', '<trib><CST></CST><cClassTrib>000001</cClassTrib><gIBSCBS/></trib>'],
    ['CST só espaço', '<trib><CST> </CST><cClassTrib>000001</cClassTrib></trib>'],
    ['sem CST', '<trib><cClassTrib>000001</cClassTrib></trib>'],
    ['forma PARTIDA (CST em trib, cClassTrib em gIBSCBS)', '<trib><CST>000</CST><gIBSCBS><cClassTrib>000001</cClassTrib></gIBSCBS></trib>'],
    ['forma PARTIDA inversa', '<trib><cClassTrib>000001</cClassTrib><gIBSCBS><CST>000</CST></gIBSCBS></trib>'],
    ['mista com o nested VAZIO (CST vazio no gIBSCBS)', '<trib><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><CST/></gIBSCBS></trib>'],
    ['CST de 4 dígitos', '<trib><CST>0000</CST><cClassTrib>000001</cClassTrib></trib>'],
    ['cClassTrib com letra', '<trib><CST>000</CST><cClassTrib>00000A</cClassTrib></trib>'],
    ['CST com prefixo de namespace (o manual veda prefixo — não é o elemento)', '<trib xmlns:n="' + NS + '"><n:CST>000</n:CST><n:cClassTrib>000001</n:cClassTrib></trib>'],
    ['trib vazio', '<trib></trib>'],
  ] as const)('%s → null', (_n, trib) => {
    expect(parseNfseDeclaration(nfseWith(NEW(trib)))).toBeNull()
  })
  it('cIndOp ausente (OPCIONAL no XSD novo) → null; o DPS levou o grupo (nfseDpsHasIbscbs true): a tela diz "ilegível", nunca "sem grupo"', () => {
    const xml = nfseWith(NEW(OK_TRIB, '<indDest>0</indDest>'))
    expect(parseNfseDeclaration(xml)).toBeNull()
    expect(nfseDpsHasIbscbs(xml)).toBe(true)
  })
  it('CDATA / comentário / filho no valor da forma nova = RECUSA do leitor (a tela engole; o DANFSe vira 422 com código) — nunca 500', () => {
    for (const trib of [
      '<trib><CST><![CDATA[000]]></CST><cClassTrib>000001</cClassTrib></trib>',
      '<trib><CST>000</CST><cClassTrib>000<!-- x -->001</cClassTrib></trib>',
      '<trib><CST><b>000</b></CST><cClassTrib>000001</cClassTrib></trib>',
    ]) {
      const xml = nfseWith(NEW(trib))
      expect(() => parseNfseDeclaration(xml)).toThrow()
      expect(() => extractDanfseFields(xml)).toThrow(expect.objectContaining({ statusCode: 422, code: 'FISCAL_DANFSE_XML_UNREADABLE' }))
    }
  })
  it('trib DUPLICADO (fora do XSD): vale o 1º; forma mista ENTRE dois trib não é detectada (só exibição; o XML é do fisco, validado e assinado por ele)', () => {
    const twoTrib = NEW('<trib><CST>000</CST><cClassTrib>000001</cClassTrib></trib><trib><gIBSCBS><CST>410</CST><cClassTrib>410999</cClassTrib></gIBSCBS></trib>')
    expect(parseNfseDeclaration(nfseWith(twoTrib))).toEqual(EXPECTED)
    // o 1º trib sem a classificação e o 2º com ela → null (nunca procura no 2º)
    const firstEmpty = NEW('<trib></trib><trib><CST>000</CST><cClassTrib>000001</cClassTrib></trib>')
    expect(parseNfseDeclaration(nfseWith(firstEmpty))).toBeNull()
  })
  it('grupo IBSCBS DUPLICADO no infDPS: vale o 1º (nunca mistura os dois)', () => {
    const xml = nfseWith(NEW(OK_TRIB) + NEW('<trib><CST>410</CST><cClassTrib>410999</cClassTrib></trib>', '<cIndOp>999999</cIndOp><indDest>0</indDest>'))
    expect(parseNfseDeclaration(xml)).toEqual(EXPECTED)
  })
  it('o grupo IBSCBS do FISCO (filho direto do infNFSe) nunca é lido como a declaração, em nenhuma das formas', () => {
    const fiscoGroup = '<IBSCBS><valores><trib><CST>410</CST><cClassTrib>410999</cClassTrib></trib></valores></IBSCBS>'
    const xml = `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="${NS}" versao="1.01"><infNFSe Id="NFS${'4'.repeat(50)}"><nNFSe>1</nNFSe>${fiscoGroup}`
      + `<DPS versao="1.01"><infDPS Id="${DPS_ID}"><tpAmb>2</tpAmb></infDPS></DPS></infNFSe></NFSe>`
    expect(parseNfseDeclaration(xml)).toBeNull()
    expect(nfseDpsHasIbscbs(xml)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// alarme do E1235 em P (D-IB111)
// ---------------------------------------------------------------------------------------------------------------------------------------
const err = (fieldMsgs: (string | undefined | null)[] | undefined, body?: string | null) =>
  new AuthorityHttpError(422, 'Fisco rejeitou (400)', 'FISCAL_DPS_REJECTED', 400, body as any,
    fieldMsgs ? fieldMsgs.map(m => ({ field: 'dps', message: m as any })) : undefined)

describe('isLayoutRejectedInProduction — o código onde ele aparece de verdade, e nada além', () => {
  it('a forma REAL do https-json do núcleo ("E1235: <descrição>") e o código no corpo JSON, em P → alarme', () => {
    expect(isLayoutRejectedInProduction('P', err(['E1235: Falha no esquema XML do DF-e. (The element \'infDPS\' ... finNFSe)']))).toBe(true)
    expect(isLayoutRejectedInProduction('P', err(['E0312: x', 'E1235: Falha no esquema']))).toBe(true)
    expect(isLayoutRejectedInProduction('P', err(undefined, '{"erros":[{"codigo":"E1235","descricao":"Falha no esquema XML do DF-e."}]}'))).toBe(true)
    expect(isLayoutRejectedInProduction('P', err(undefined, '{"erro":{"codigo":"E1235"}}'))).toBe(true)
  })
  it('H nunca; ambiente torto nunca (só o P exato)', () => {
    for (const env of ['H', 'p', '', undefined] as any[]) expect(isLayoutRejectedInProduction(env, err(['E1235: Falha no esquema']))).toBe(false)
  })
  it.each(['E12350: x', 'XE1235: x', 'E1235A', '_E1235_', 'e1235: minúsculo', 'E 1235', 'E01235: x', '1235'])('código parecido "%s" não dispara', m => {
    expect(isLayoutRejectedInProduction('P', err([m], ''))).toBe(false)
  })
  it('erro sem fields/sem corpo/mensagem ausente, ou que nem é do fisco: false, sem lançar', () => {
    expect(isLayoutRejectedInProduction('P', err(undefined, undefined))).toBe(false)
    expect(isLayoutRejectedInProduction('P', err([undefined, null], null))).toBe(false)
    expect(isLayoutRejectedInProduction('P', new Error('E1235 local') as any)).toBe(false)
    expect(isLayoutRejectedInProduction('P', {} as any)).toBe(false)
  })
  it('LIMITE (LOW, documentado): o código no TEXTO de outro erro também dispara — o alarme manda CONFERIR, nunca muda o leiaute', () => {
    const otherError = '{"erros":[{"codigo":"E0312","descricao":"Codigo de tributacao nao administrado","complemento":"ver regra E1235"}]}'
    expect(isLayoutRejectedInProduction('P', err(undefined, otherError))).toBe(true)
    // retrabalho do gate socrático (MEDIUM — o E1235 não prova troca de pacote): o rótulo manda conferir o validador E a página oficial
    expect(LAYOUT_REJECTED_ALARM).toMatch(/conferir a mensagem do validador[\s\S]*página oficial/)
  })
})
