/// <reference types="jest" />
// Leiaute POR AMBIENTE (fase IBS/CBS — D-IB110…D-IB114, Infra-IA/prompts/prompt_fase_ibs_cbs.md §13.8, fim): a produção restrita (H) usa
// desde 20/10/2026 o pacote XSD `xsd-20261020` (NT 009, parcial) e a produção (P) segue no `xsd-20260209` — os dois com `versao="1.01"`
// e INCOMPATÍVEIS. Ordem E obrigatórios conferidos contra o XSD OFICIAL de CADA pacote no acervo (D-IB84 — sem validação local), ida e volta
// da declaração pela FORMA do documento, o evento igual nos dois, o alarme do E1235 em P (D-IB111) e as cercas (nunca escolher a forma
// pelo ambiente nem pela versão).
import fs from 'fs'
import path from 'path'
import { AuthorityHttpError } from 'fiscal-api'
import { buildDpsId, buildDpsXml, buildCancelEventXml, parseNfseDeclaration, nfseDpsHasIbscbs, dpsText } from '../authority/dps-builder'
import { buildRecipient } from '../facts/service-facts'
import { layoutAt, LAYOUT_CALENDAR, NfseLayout, assertLayoutCalendar } from '../authority/layout-calendar'
import type { DpsInput } from '../authority/types'
import { isLayoutRejectedInProduction, LAYOUT_REJECTED_ALARM, EVENT_LAYOUT_REJECTED_ALARM } from '../nfse/transmission'
import { extractDanfseFields } from '../nfse/danfse'

const PROJECT_ROOT = path.join(__dirname, '..', '..')

/** A pasta Infra-IA do workspace (sobe a partir do projeto — vale na árvore viva e nas worktrees). */
function infraIa(): string {
  let dir = PROJECT_ROOT
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'Infra-IA')
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error('Infra-IA não encontrada acima do projeto')
}
const ACERVO = path.join(infraIa(), 'setes-api', 'integracoes', 'nfse-adn')
/** O XSD OFICIAL de cada leiaute (D-IB110): o pacote de PRODUÇÃO de 09/02/2026 e o da PRODUÇÃO RESTRITA de 20/10/2026. */
const XSD_DIR: Record<NfseLayout, string> = {
  'xsd-20260209': path.join(ACERVO, 'xsd', 'Schemas', '1.01'),
  'xsd-20261020': path.join(ACERVO, 'producao-restrita-20261020', 'xsd'),
}
const xsdOf = (layout: NfseLayout, file = 'tiposComplexos_v1.01.xsd') => fs.readFileSync(path.join(XSD_DIR[layout], file), 'utf8')

interface XsdChild { name: string; required: boolean }
/**
 * Os elementos FILHOS do tipo complexo [name] no XSD (os tipos aninhados têm nome próprio), com a obrigatoriedade: obrigatório = sem
 * `minOccurs="0"` e fora de `xs:choice`/`xs:sequence minOccurs="0"` (o que está num choice é obrigatório só em grupo — não conferido aqui).
 */
function xsdChildren(xsd: string, name: string): XsdChild[] {
  const start = xsd.indexOf(`<xs:complexType name="${name}">`)
  if (start < 0) throw new Error(`tipo ${name} não está no XSD`)
  const end = xsd.indexOf('</xs:complexType>', start)
  const out: XsdChild[] = []
  const optionalStack: boolean[] = []
  for (const m of xsd.slice(start, end).matchAll(/<(\/?)xs:(element|choice|sequence)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m
    if (tag === 'element') {
      if (close) continue
      const n = /\bname="([^"]+)"/.exec(attrs)?.[1]
      if (!n) continue
      const optional = /\bminOccurs="0"/.test(attrs) || optionalStack.some(Boolean)
      out.push({ name: n, required: !optional })
      continue
    }
    if (close) { optionalStack.pop(); continue }
    if (selfClose) continue
    optionalStack.push(tag === 'choice' || /\bminOccurs="0"/.test(attrs))
  }
  return out
}
/** Os nomes dos filhos DIRETOS do 1º elemento <tag>…</tag> do XML (o XML é nosso, sem atributos nos filhos). */
function childrenOf(xml: string, tag: string): string[] {
  const open = xml.indexOf(`<${tag}>`) >= 0 ? xml.indexOf(`<${tag}>`) : xml.indexOf(`<${tag} `)
  if (open < 0) throw new Error(`<${tag}> não está no XML`)
  const inner = xml.slice(xml.indexOf('>', open) + 1, xml.indexOf(`</${tag}>`, open))
  const out: string[] = []
  let depth = 0
  for (const m of inner.matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    if (m[1] === '/') { depth--; continue }
    if (depth === 0) out.push(m[2])
    if (m[3] !== '/') depth++
  }
  return out
}
/** [got] segue a ordem do tipo [type] do XSD do [layout] e traz TODOS os obrigatórios dele. */
function conforms(layout: NfseLayout, got: string[], type: string): void {
  const seq = xsdChildren(xsdOf(layout), type)
  let i = 0
  for (const g of got) {
    while (i < seq.length && seq[i].name !== g) i++
    expect({ layout, type, element: g, inXsdOrder: i < seq.length }).toEqual({ layout, type, element: g, inXsdOrder: true })
    i++
  }
  for (const r of seq.filter(c => c.required)) expect({ layout, type, missing: r.name, present: got.includes(r.name) }).toMatchObject({ present: true })
}

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
const { ibscbs: _semGrupo, ...semGrupo } = base
const soNbs: DpsInput = semGrupo
const semNbs: DpsInput = { ...semGrupo, serv: { ...base.serv, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal' } } }

/** O instante e o ambiente que caem em cada leiaute HOJE (H depois de 20/10/2026 × P sempre no de 09/02 até a linha nova — D-IB111). */
const AT: Record<NfseLayout, Pick<DpsInput, 'environment' | 'dhEmi'>> = {
  'xsd-20260209': { environment: 'P', dhEmi: '2026-12-20T10:15:30-03:00' },
  'xsd-20261020': { environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00' },
}
const LAYOUTS = Object.keys(XSD_DIR) as NfseLayout[]

describe('calendário de leiaute — o LEIAUTE é o pacote, a versão é o atributo (D-IB110/D-IB111)', () => {
  it('H troca de pacote no instante da publicação (20/10/2026 18h10 BRT); P segue no de 09/02; a versão é 1.01 nos dois', () => {
    expect(layoutAt('DPS', 'H', new Date('2026-10-15T16:33:00Z'))).toEqual({ layout: 'xsd-20260209', version: '1.01' })
    expect(layoutAt('DPS', 'H', new Date('2026-10-20T21:09:59Z'))).toEqual({ layout: 'xsd-20260209', version: '1.01' })
    expect(layoutAt('DPS', 'H', new Date('2026-10-20T21:10:00Z'))).toEqual({ layout: 'xsd-20261020', version: '1.01' })
    expect(layoutAt('DPS', 'H', new Date('2026-11-01T10:50:50Z'))).toEqual({ layout: 'xsd-20261020', version: '1.01' })
    for (const t of ['2026-09-29T23:33:00Z', '2026-11-01T10:50:50Z', '2027-06-01T00:00:00Z']) {
      expect(layoutAt('DPS', 'P', new Date(t))).toEqual({ layout: 'xsd-20260209', version: '1.01' })
    }
  })
  it('o EVENTO segue no pacote de 09/02 nos dois ambientes (pedRegEvento idêntico nos pacotes)', () => {
    for (const env of ['H', 'P'] as const) expect(layoutAt('EVENT', env, new Date('2026-12-20T00:00:00Z'))).toEqual({ layout: 'xsd-20260209', version: '1.01' })
    for (const f of ['tiposEventos_v1.01.xsd', 'pedRegEvento_v1.01.xsd', 'evento_v1.01.xsd', 'DPS_v1.01.xsd', 'NFSe_v1.01.xsd']) {
      expect({ f, same: xsdOf('xsd-20260209', f) === xsdOf('xsd-20261020', f) }).toEqual({ f, same: true })
    }
  })
  it('todo leiaute do calendário tem o XSD oficial no acervo; o resultado é congelado', () => {
    for (const l of LAYOUT_CALENDAR) expect(LAYOUTS).toContain(l.layout)
    expect(Object.isFrozen(layoutAt('DPS', 'H', new Date()))).toBe(true)
    expect(Object.isFrozen(LAYOUT_CALENDAR)).toBe(true)
  })
  it('conhecimento negativo: os dois pacotes dizem a MESMA versão (o leiaute não se distingue por ela)', () => {
    const ver = (l: NfseLayout) => /<xs:simpleType name="TVerNFSe">[\s\S]*?<\/xs:simpleType>/.exec(xsdOf(l, 'tiposSimples_v1.01.xsd'))?.[0]
    expect(ver('xsd-20261020')).toBe(ver('xsd-20260209'))
    expect(xsdOf('xsd-20261020')).not.toBe(xsdOf('xsd-20260209'))
  })
})

describe.each(LAYOUTS)('DPS no leiaute %s — ordem e obrigatórios contra o XSD OFICIAL do pacote (D-IB84)', layout => {
  const at = AT[layout]
  const withGroup = buildDpsXml({ ...base, ...at }, DPS_ID)
  const onlyNbs = buildDpsXml({ ...soNbs, ...at }, DPS_ID)
  const plain = buildDpsXml({ ...semNbs, ...at }, DPS_ID)

  it('o calendário põe este ambiente/instante neste leiaute', () => {
    expect(layoutAt('DPS', at.environment, new Date(at.dhEmi)).layout).toBe(layout)
  })
  it.each([['com o grupo', 'withGroup'], ['só NBS', 'onlyNbs'], ['sem NBS nem grupo', 'plain']] as const)('infDPS %s segue TCInfDPS', (_n, which) => {
    const xml = { withGroup, onlyNbs, plain }[which]
    conforms(layout, childrenOf(xml, 'infDPS'), 'TCInfDPS')
    expect(xml).toContain('versao="1.01"')
  })
  it('cServ segue TCCServ (com e sem NBS)', () => {
    conforms(layout, childrenOf(withGroup, 'cServ'), 'TCCServ')
    conforms(layout, childrenOf(plain, 'cServ'), 'TCCServ')
  })
  it('o grupo IBS/CBS segue TCRTCInfoIBSCBS e o trib segue o tipo do pacote', () => {
    conforms(layout, childrenOf(withGroup, 'IBSCBS'), 'TCRTCInfoIBSCBS')
    const tribType = layout === 'xsd-20261020' ? 'TCRTCInfoTribIBSCBS' : 'TCRTCInfoTributosIBSCBS'
    conforms(layout, childrenOf(withGroup.slice(withGroup.indexOf('<IBSCBS>')), 'trib'), tribType)
    expect(childrenOf(withGroup, 'IBSCBS')[childrenOf(withGroup, 'IBSCBS').length - 1]).toBe('valores')
  })
})

describe('as TRÊS costuras, exatas (D-IB110/D-IB112)', () => {
  const p = buildDpsXml({ ...base, ...AT['xsd-20260209'] }, DPS_ID)
  const h = buildDpsXml({ ...base, ...AT['xsd-20261020'] }, DPS_ID)

  it('pacote de 09/02 (P): igual ao DPS de hoje — finNFSe só dentro do grupo, xDescServ antes do cNBS, CST/cClassTrib em gIBSCBS', () => {
    expect(p).toContain('<tpEmit>1</tpEmit><cLocEmi>4106902</cLocEmi>')
    expect(p).toContain('<cServ><cTribNac>010201</cTribNac><xDescServ>Suporte mensal</xDescServ><cNBS>115021000</cNBS></cServ>')
    expect(p).toContain('<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><indDest>0</indDest>'
      + '<valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS></infDPS>')
    expect(p.match(/<finNFSe>/g)).toHaveLength(1)
  })
  it('pacote de 20/10 (H): finNFSe no infDPS, xDescServ depois do cNBS, CST/cClassTrib em trib + gIBSCBS VAZIO; nenhum finNFSe no grupo', () => {
    expect(h).toContain('<tpEmit>1</tpEmit><finNFSe>0</finNFSe><cLocEmi>4106902</cLocEmi>')
    expect(h).toContain('<cServ><cTribNac>010201</cTribNac><cNBS>115021000</cNBS><xDescServ>Suporte mensal</xDescServ></cServ>')
    expect(h).toContain('<IBSCBS><cIndOp>100301</cIndOp><indDest>0</indDest>'
      + '<valores><trib><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS></gIBSCBS></trib></valores></IBSCBS></infDPS>')
    expect(h.match(/<finNFSe>/g)).toHaveLength(1)
    // nada fora do 1º release (§5 da fase) nem tpRetPisCofins (D-IB19), nem os grupos novos da NT 009
    for (const no of ['indFinal', 'tpOper', 'tpEnteGov', 'dest', 'imovel', 'bensMoveis', 'gReeRepRes', 'vAjusteBC', 'cCredPres', 'gTribRegular', 'gDif', 'tpRetPisCofins']) {
      expect({ no, present: h.includes(`<${no}>`) }).toEqual({ no, present: false })
    }
  })
  it('pacote de 20/10 SEM o grupo também leva o finNFSe (obrigatório em TODO DPS do pacote); sem NBS o cServ fica igual ao antigo', () => {
    const x = buildDpsXml({ ...semNbs, ...AT['xsd-20261020'] }, DPS_ID)
    expect(x).toContain('<tpEmit>1</tpEmit><finNFSe>0</finNFSe><cLocEmi>')
    expect(x).not.toContain('<IBSCBS>')
    expect(x).toContain('<cServ><cTribNac>010201</cTribNac><xDescServ>Suporte mensal</xDescServ></cServ>')
  })
  it('o resto do DPS é IDÊNTICO nos dois pacotes (só as três costuras e o tpAmb mudam)', () => {
    const norm = (x: string) => x
      .replace('<tpAmb>1</tpAmb>', '<tpAmb>?</tpAmb>').replace('<tpAmb>2</tpAmb>', '<tpAmb>?</tpAmb>')
      .replace(/<finNFSe>0<\/finNFSe>/g, '')
      .replace('<cNBS>115021000</cNBS><xDescServ>Suporte mensal</xDescServ>', '<xDescServ>Suporte mensal</xDescServ><cNBS>115021000</cNBS>')
      .replace(/<IBSCBS>[\s\S]*<\/IBSCBS>/, '<IBSCBS/>')
    expect(norm(h)).toBe(norm(p))
  })
})

describe('evento de cancelamento — idêntico nos dois ambientes (só o tpAmb muda)', () => {
  it('pedRegEvento igual em H e P', () => {
    const ev = (environment: 'H' | 'P') => buildCancelEventXml({
      accessKey: '4'.repeat(50), dhEvento: '2026-12-20T10:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissao da nota',
      environment, verAplic: 'nfse-api', cnpjAutor: '12345678000195',
    })
    expect(ev('H').replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>')).toBe(ev('P'))
    expect(ev('H')).toContain('versao="1.01"')
  })
})

/** A NFS-e autorizada mínima que EMBUTE o DPS montado (o fisco devolve o nosso DPS dentro do infNFSe). */
function nfseOf(dpsXml: string): string {
  const dps = dpsXml.replace(/^<\?xml[^>]*\?>/, '')
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${'4'.repeat(50)}">`
    + `<nNFSe>1</nNFSe>${dps}</infNFSe></NFSe>`
}

describe('leitura da declaração pela FORMA do documento — os dois pacotes convivem no arquivo fiscal (D-IB110)', () => {
  const expected = { cst: '000', classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' }
  it.each(LAYOUTS)('ida e volta: o DPS do pacote %s embutido na NFS-e é lido de volta igual (No fisco e DANFSe)', layout => {
    const xml = nfseOf(buildDpsXml({ ...base, ...AT[layout] }, DPS_ID))
    expect(parseNfseDeclaration(xml)).toEqual(expected)
    expect(nfseDpsHasIbscbs(xml)).toBe(true)
    const f = extractDanfseFields(xml)
    expect(f.ibscbs).toMatchObject({ cst: '000', cClassTrib: '000001', cIndOp: '100301', nbs: '115021000' })
  })
  it('forma MISTA (CST em trib E em trib/gIBSCBS) não é legível — null, nunca adivinha', () => {
    const h = nfseOf(buildDpsXml({ ...base, ...AT['xsd-20261020'] }, DPS_ID))
    const mixed = h.replace('<gIBSCBS></gIBSCBS>', '<gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS>')
    expect(parseNfseDeclaration(mixed)).toBeNull()
  })
  it('sem o grupo: null nos dois pacotes', () => {
    for (const layout of LAYOUTS) expect(parseNfseDeclaration(nfseOf(buildDpsXml({ ...soNbs, ...AT[layout] }, DPS_ID)))).toBeNull()
  })
})

describe('E1235 em PRODUÇÃO = alarme do leiaute (D-IB111)', () => {
  const err = (fieldMsg: string | null, body = '') => new AuthorityHttpError(422, 'Fisco recusou o DPS', 'FISCAL_REJECTED', 400, body,
    fieldMsg ? [{ field: 'dps', message: fieldMsg }] as any : undefined)
  it('P + E1235 (no campo ou no corpo) = alarme; H nunca; outro código nunca', () => {
    expect(isLayoutRejectedInProduction('P', err('E1235 — Falha no esquema XML do DF-e.'))).toBe(true)
    expect(isLayoutRejectedInProduction('P', err(null, '{"erros":[{"codigo":"E1235"}]}'))).toBe(true)
    expect(isLayoutRejectedInProduction('H', err('E1235 — Falha no esquema XML do DF-e.'))).toBe(false)
    expect(isLayoutRejectedInProduction('P', err('E0116 — IM'))).toBe(false)
    expect(isLayoutRejectedInProduction('P', err('E12350 x'))).toBe(false)
  })
  it('o alarme é rótulo FIXO (sem placeholder para o corpo da resposta — D-F100) e não afirma troca de pacote (pode ser dado fora do esquema)', () => {
    for (const a of [LAYOUT_REJECTED_ALARM, EVENT_LAYOUT_REJECTED_ALARM]) {
      expect(a).toMatch(/^\[D-IB111\] E1235 em PRODUÇÃO/)
      expect(a).not.toMatch(/\$\{|%s/)
      expect(a).toMatch(/conferir a mensagem do validador/)
    }
  })
  it('ligado nos DOIS pontos de recusa (DPS e pedido de evento), ANTES da gravação da voz / liberação do K (gate socrático L6/Q-c)', () => {
    const tr = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'nfse', 'transmission.ts'), 'utf8')
    const dps = tr.indexOf('logger.error(LAYOUT_REJECTED_ALARM')
    expect(dps).toBeGreaterThan(0)
    expect(dps).toBeLessThan(tr.indexOf("'voz do fisco (recusa)'"))
    const ev = tr.indexOf('logger.error(EVENT_LAYOUT_REJECTED_ALARM')
    expect(ev).toBeGreaterThan(0)
    expect(ev).toBeLessThan(tr.indexOf('await release(`Fisco recusou o cancelamento'))
    expect(tr.match(/isLayoutRejectedInProduction\(/g)).toHaveLength(3)       // a definição + os dois pontos
  })
})

describe('ADV-NT009-01 na fonte de fatos — o que valida é o que grava (`dpsText` = o saneamento do montador)', () => {
  /** ERP falso mínimo para `erp.entityFiscal` (molde de `cnpj-alfa-onda0.test.ts`). */
  const fakeErp = (nameCompany: string) => ({
    query: jest.fn(async (sql: string) => {
      if (/tb_address/.test(sql)) return [[]]
      if (/tb_company/.test(sql)) return [[{ cnpj: '12345678000195', im: null }]]
      if (/tb_person/.test(sql)) return [[]]
      if (/tb_entity/.test(sql)) return [[{ nameCompany, nickTrade: null }]]
      return [[]]
    }),
  }) as any
  it.each([['emoji', '🚀'], ['cirílico', 'Сервис'], ['CJK', '张伟'], ['largura zero', '​']])('nome do tomador só com %s → 422 com o campo (nunca DPS sem xNome)', async (_n, name) => {
    const err = await buildRecipient(fakeErp(name), 900).then(() => null, e => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_RECIPIENT_INCOMPLETE' })
    expect(JSON.stringify(err.fields)).toMatch(/recipient\.name/)
  })
  it('nome com acento e com caractere que cai na letra-base passa (Š → S)', async () => {
    expect(await buildRecipient(fakeErp('José Škoda'), 900)).toMatchObject({ xNome: 'José Škoda' })
    expect(dpsText('José Škoda')).toBe('José Skoda')
  })
})

describe('cercas (D-IB110/D-IB111)', () => {
  const builder = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'authority', 'dps-builder.ts'), 'utf8')
  const calendar = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'authority', 'layout-calendar.ts'), 'utf8')
  it('o montador nunca escolhe a forma pelo AMBIENTE (só o tpAmb o lê) nem pela VERSÃO', () => {
    const withoutTpAmb = builder.replace(/export function tpAmbOf[\s\S]*?\r?\n}\r?\n/, '')
    expect(withoutTpAmb.length).toBeLessThan(builder.length)
    expect(withoutTpAmb).not.toMatch(/environment\s*[!=]==?\s*['"][HP]['"]/)
    expect(builder).not.toMatch(/version\s*[!=]==?|['"]1\.01['"]\s*[!=]==?|[!=]==?\s*['"]1\.01['"]/)
  })
  it('a forma por leiaute só por `switch` exaustivo com o cinto `unknownLayout` (leiaute novo sem forma não compila)', () => {
    const switches = builder.match(/switch \(layout\) \{[\s\S]*?\r?\n  \}/g) ?? []
    expect(switches.length).toBeGreaterThanOrEqual(4)
    for (const s of switches) expect(s).toMatch(/default: (return )?unknownLayout\(layout\)/)
  })
  it('o calendário não lê variável de ambiente nem configuração (a virada é deploy — D-IB111)', () => {
    expect(calendar).not.toMatch(/process\.env|getConfig|interface_config/)
  })
  it('linha de deploy errada falha ALTO no carregamento (validFrom fora da forma/inexistente, repetida, par sem piso)', () => {
    const ok = LAYOUT_CALENDAR.map(l => ({ ...l }))
    expect(() => assertLayoutCalendar(ok)).not.toThrow()
    const line = (validFrom: string) => ({ document: 'DPS' as const, environment: 'P' as const, validFrom, layout: 'xsd-20261020' as const, version: '1.01' })
    for (const bad of ['2027-02-30T03:00:00Z', '2027-01-01', '2027-01-01T00:00:00-03:00', '2027-01-01T00:00:00.000Z', 'amanhã']) {
      expect(() => assertLayoutCalendar([...ok, line(bad)])).toThrow(/validFrom/)
    }
    expect(() => assertLayoutCalendar([...ok, line('2027-01-01T03:00:00Z'), line('2027-01-01T03:00:00Z')])).toThrow(/repetida/)
    expect(() => assertLayoutCalendar(ok.filter(l => !(l.document === 'EVENT' && l.environment === 'P')))).toThrow(/piso/)
  })
})
