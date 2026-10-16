/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA — passo 7 da NE-1a parte 2 (dívida N17: leitura de XML do fisco por PARSER — D-NE72; `prompt_onda_nfe_sefaz.md`
// §12.9.7.3) — FAMÍLIA NFS-e (nfse-api: `dps-builder.ts` firstText/parseNfseXml/parseEventXml, `adn.ts` sentDpsIdOf + os `try` do adaptador,
// `danfse.ts`). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
//  * ACHADOS (`it.failing('[SEV N17-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou o marca `[DECIDIDO]` se o Valdo decidir manter). NUNCA corrigir o teste
//    para passar.
//  CONVERSÃO (2026-10-12, mesma sessão): N17-01/02/05/08 [CORRIGIDO na sessão]; N17-04 e Q-NE90 [DECIDIDO — D-NE90] (divergência intencional);
//    Q-NE92 [DECIDIDO — D-NE85] (grupo vazio = recusa; valor vazio = ausente); Q-NE91 = D-NE89 (DANFSe com código próprio).
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (Q-NE90…).
//
// REGRAS DO GATE: nenhum socket (`transport.request` do núcleo trocado — molde do r18), nenhum banco, nada do corpus real (fixtures SINTÉTICAS);
// o ORÁCULO é o leitor por regex publicado (`legacy-xml-oracle.ts`).
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import { transport, HttpsCall, ambiguousCauseOf, AuthorityHttpError, XmlUnreadableError, HttpError, sendError } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { parseNfseXml, parseEventXml, firstText } from '../authority/dps-builder'
import { extractDanfseFields, renderDanfse } from '../nfse/danfse'
import {
  legacy_parseNfseXml, legacy_parseEventXml, legacy_extractDanfseFields, legacy_eventSignature,
} from './legacy-xml-oracle'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    parseXml: jest.fn(actual.parseXml),                               // conta os parses (custo — N17-08); comportamento real
  }
})

// ---------------------------------------------------------------------------
// a Sefin FALSA pelo transporte do núcleo (nenhum socket)
// ---------------------------------------------------------------------------
const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset(); (fiscal.parseXml as unknown as jest.Mock).mockClear() })

const CNPJ = '12345678000195'
const KEY = '4106902' + '2' + '2' + CNPJ + '0000000000123' + '2609' + '000012345' + '1'
const KEY_B = `${KEY.slice(0, -1)}8`
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const DPS_ID_B = 'DPS410690221234567800019500001000000000000043'
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
const SIGNED_DPS = `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${DPS_ID}"><nDPS>42</nDPS></infDPS></DPS>`

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: JSON.stringify(obj) })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const typedItem = (xml: string, code = '101101') =>
  ({ chaveAcesso: KEY, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: b64(gz(xml)) })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
/** A causa do ambíguo (lista fechada — D-F98) ou o que NÃO é ambíguo, por extenso. */
const verdict = (r: any): string => r instanceof AuthorityHttpError ? `ambiguo:${ambiguousCauseOf(r)}`
  : r instanceof Error ? `EXCECAO CRUA: ${r.constructor.name}` : r?.status === 'unknown' ? `unknown:${r.unknownCause}` : `${r?.status ?? 'autorizada'}`

/** NFS-e sintética no leiaute do XSD v1.01 (cabeçalho, emit, valores do fisco, DPS embutido). */
function nfseXml(o: { key?: string; header?: string; emit?: string; dpsId?: string; xNomeToma?: string; xDescServ?: string; xLgr?: string; tail?: string; idAttr?: string } = {}): string {
  const key = o.key ?? KEY
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">` +
    `${o.idAttr ?? `<infNFSe Id="NFS${key}">`}<xLocEmi>Curitiba</xLocEmi>` +
    `${o.header ?? '<nNFSe>123</nNFSe><cStat>100</cStat><dhProc>2026-09-21T10:15:30-03:00</dhProc><nDFSe>7</nDFSe><ambGer>2</ambGer>'}` +
    `${o.emit ?? `<emit><CNPJ>${CNPJ}</CNPJ><xNome>Setes</xNome></emit>`}<valores><vLiq>10.00</vLiq><vISSQN>0.20</vISSQN></valores>` +
    `<DPS versao="1.01"><infDPS Id="${o.dpsId ?? DPS_ID}"><nDPS>42</nDPS><serie>1</serie><dCompet>2026-09-01</dCompet><prest><CNPJ>${CNPJ}</CNPJ></prest>` +
    `<toma><CNPJ>98765432000198</CNPJ><xNome>${o.xNomeToma ?? 'Cliente'}</xNome><end><xLgr>${o.xLgr ?? 'Rua A'}</xLgr><nro>1</nro></end></toma>` +
    `<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>${o.xDescServ ?? 'Licença'}</xDescServ></cServ></serv>` +
    `<valores><vServPrest><vServ>10.00</vServ></vServPrest></valores></infDPS></DPS></infNFSe>${o.tail ?? ''}</NFSe>`
}
/** Evento GERADO pelo fisco (Id EVT + dhProc + chNFSe desta chave). */
function eventXml(o: { code?: string; inner?: string; dhProc?: string; id?: string; around?: (body: string) => string } = {}): string {
  const code = o.code ?? '101101'
  const group = `<e${code}>${o.inner ?? '<xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu</xMotivo>'}</e${code}>`
  const body = `<tpAmb>2</tpAmb><verAplic>SETES</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${KEY}</chNFSe>` +
    `<nPedRegEvento>1</nPedRegEvento>${group}`
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento${o.id === '' ? '' : ` Id="${o.id ?? `EVT${KEY}${code}001`}"`}><verAplic>SEFIN</verAplic>` +
    `<ambGer>2</ambGer><nSeqEvento>1</nSeqEvento>${o.dhProc ?? '<dhProc>2026-10-10T18:43:05-03:00</dhProc>'}<nDFSe>1</nDFSe><pedRegEvento versao="1.01">` +
    `<infPedReg Id="PRE${KEY}${code}">${o.around ? o.around(body) : body}</infPedReg></pedRegEvento></infEvento></evento>`
}
/** A Sefin falsa: `GET /nfse/{chave}` devolve [nfse]; o GET tipado devolve os eventos do código; o resto, "não há". */
function fisco(o: { nfse?: string; typed?: Record<string, string[]>; post?: () => any }) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (call.method === 'POST') return o.post?.() ?? sefinNone()
    const typed = call.url.match(/\/nfse\/(\d+)\/eventos\/(\d+)\/1$/)
    if (typed) { const xs = o.typed?.[typed[2]]; return xs ? ok({ ...SEFIN, eventos: xs.map(x => typedItem(x, typed[2])) }) : sefinNone() }
    if (/\/nfse\/\d+$/.test(call.url)) return ok({ ...SEFIN, nfseXmlGZipB64: gz(o.nfse ?? nfseXml()) })
    return sefinNone()
  })
}
const transmitWith = (nfse: string, extra: object = {}) => { fisco({ post: () => ok({ ...SEFIN, chaveAcesso: KEY, nfseXmlGZipB64: gz(nfse), ...extra }, 201) }); return settle(adnAdapter.transmit(ctxH, SIGNED_DPS)) }
const registerWith = (ev: string) => { fisco({ post: () => ok({ ...SEFIN, eventoXmlGZipB64: gz(ev) }, 201) }); return settle(adnAdapter.registerEvent(ctxH, KEY, '<pedRegEvento/>')) }
const queryWith = (o: { nfse?: string; typed?: Record<string, string[]> }) => { fisco(o); return settle(adnAdapter.queryNfse(ctxH, KEY)) }

/** O truque do pré-filtro de referências (N17-01 — provado no gate do núcleo): `<![CDATA[` num comentário, `]]>` noutro. */
const hide = (inner: string) => `<!-- <![CDATA[ -->${inner}<!-- ]]> -->`

// ===========================================================================
// [N17-01] MEDIUM — a recusa que o pré-filtro deixa passar chega à VOZ: o recorte publicado LANÇAVA (ambíguo pela causa); o parser LÊ lixo
// ===========================================================================
describe('[N17-01] referência inválida escondida → voz', () => {
  const badMotive = eventXml({ inner: '<xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>x&#x110000;</xMotivo>' })
  const hiddenMotive = eventXml({ inner: `<xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>${hide('<xMotivo>x&#x110000;</xMotivo>')}` })
  it('resistiu (controle): SEM o truque, referência fora do Unicode no evento do GET tipado → ambíguo `evento-ilegivel` (D-NE72)', async () => {
    expect(verdict(await queryWith({ typed: { '101101': [badMotive] } }))).toBe('unknown:evento-ilegivel')
  })
  it('[CORRIGIDO na sessão] (era o contexto do N17-01: o parser lia o motivo como surrogates soltos) — o ORÁCULO lançava RangeError no XML com o truque; o leitor novo RECUSA (varredura única da gramática)', () => {
    expect(() => legacy_parseEventXml(hiddenMotive)).toThrow(RangeError)
    expect(() => parseEventXml(hiddenMotive)).toThrow(XmlUnreadableError)
  })
  it('[CORRIGIDO na sessão] [MEDIUM N17-01] consulta: evento de cancelamento com referência fora do Unicode ESCONDIDA → devia ser ambíguo (`evento-ilegivel`, como o publicado); hoje vira CANCELADA (C irreversível) com motivo-lixo', async () => {
    expect(verdict(await queryWith({ typed: { '101101': [hiddenMotive] } }))).toBe('unknown:evento-ilegivel')
  })
  it('[CORRIGIDO na sessão] [MEDIUM N17-01] transmitir: NFS-e com número que traz referência fora do Unicode ESCONDIDA → devia ser ambíguo `nfse-ilegivel` (o publicado lançava); hoje vira AUTORIZADA com nNFSe-lixo', async () => {
    const nfse = nfseXml({ header: `${hide('<nNFSe>123&#x110000;</nNFSe>')}<cStat>100</cStat><dhProc>2026-09-21T10:15:30-03:00</dhProc>` })
    expect(() => legacy_parseNfseXml(nfse)).toThrow(RangeError)
    const r = await transmitWith(nfse)
    expect(r instanceof Error ? verdict(r) : `AUTORIZADA nNFSe=${JSON.stringify(r.nfseNumber)}`).toBe('ambiguo:nfse-ilegivel')
  })
})

// ===========================================================================
// [N17-02] MEDIUM — DANFSe: o leitor recusa um campo que SÓ o DANFSe lê, fora de qualquer `try` → a rota responde 500 "Erro interno"
// ===========================================================================
describe('[N17-02] DANFSe de NFS-e AUTORIZADA', () => {
  const OPTS = { issuerName: 'SETES', municipality: 'Curitiba / Paraná' }
  const VARIANTS: [string, string][] = [
    ['CDATA no xNome do TOMADOR', nfseXml({ xNomeToma: '<![CDATA[Cliente]]>' })],
    ['comentário dentro do xDescServ', nfseXml({ xDescServ: 'Lic<!-- x -->ença' })],
    ['elemento dentro do xLgr', nfseXml({ xLgr: 'Rua <b>A</b>' })],
    ['CDATA no xNome do EMITENTE', nfseXml({ emit: `<emit><CNPJ>${CNPJ}</CNPJ><xNome><![CDATA[Setes]]></xNome></emit>` })],
  ]
  it('contexto: o transmitir AUTORIZA essas NFS-e (o cabeçalho, o Id e o bloco de cancelamento são legíveis) — elas vão ao arquivo fiscal; o oráculo gerava o DANFSe (com a marcação crua no campo)', async () => {
    for (const [l, xml] of VARIANTS) {
      const r = await transmitWith(xml)
      expect([l, r instanceof Error ? verdict(r) : r.accessKey]).toEqual([l, KEY])
      expect([l, typeof legacy_extractDanfseFields(xml).toma.xNome]).toEqual([l, 'string'])
    }
  })
  it('resistiu (controle): a NFS-e típica gera o PDF', async () => {
    expect((await renderDanfse(nfseXml(), OPTS)).subarray(0, 4).toString()).toBe('%PDF')
  })
  it('[CORRIGIDO na sessão — D-NE89] (era o contexto do N17-02: a recusa subia CRUA e virava 500 "Erro interno") — a recusa sai com CÓDIGO PRÓPRIO do catálogo e o `sendError` da borda responde 422', async () => {
    const err = await settle(renderDanfse(VARIANTS[0][1], OPTS))
    expect(err).toBeInstanceOf(HttpError)
    const res: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this }, json(b: unknown) { this.body = b; return this } }
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try { sendError(res, err, 'GET /v1/nfse/invoices/:invoiceId/danfse') } finally { spy.mockRestore() }
    expect([res.statusCode, res.body.code]).toEqual([422, fiscal.ErrorCodes.FISCAL_DANFSE_XML_UNREADABLE])
  })
  it.each(VARIANTS)('[CORRIGIDO na sessão — D-NE89] [MEDIUM N17-02] %s → o DANFSe NUNCA é exceção crua (500): PDF ou erro com código (HttpError) — Q-NE91', async (_l, xml) => {
    const r = await settle(renderDanfse(xml, OPTS))
    expect(Buffer.isBuffer(r) || r instanceof HttpError).toBe(true)
  })
})

// ===========================================================================
// [N17-04] LOW — promessa (a): saída IDÊNTICA ao oráculo em XML BEM-FORMADO. Classes bem-formadas FORA das divergências fixadas pela
// D-NE72 (auto-fechado, aspas simples) — em todas o parser dá a leitura CORRETA do XML; falta decidir/fixar (Q-NE90)
// ===========================================================================
const eventSignature = (xml: string) => {
  const e = parseEventXml(xml)
  return JSON.stringify([e.eventCode, e.eventId, e.dhProc, e.dhEvento, e.nSeqEvento, e.cMotivo, e.xMotivo, e.substituteKey ?? null,
    firstText(xml, 'nDFSe'), firstText(xml, 'CNPJAutor') ?? firstText(xml, 'CPFAutor'), firstText(xml, 'ambGer'), firstText(xml, 'tpAmb')])
}
function divergences(xml: string): string[] {
  const out: string[] = []
  const same = (f: string, a: () => unknown, b: () => unknown) => {
    let x: string, y: string
    try { x = JSON.stringify(a()) } catch (e) { x = `LANÇOU ${(e as Error).name}` }
    try { y = JSON.stringify(b()) } catch (e) { y = `LANÇOU ${(e as Error).name}` }
    if (x !== y) out.push(f)
  }
  same('parseNfseXml', () => parseNfseXml(xml), () => legacy_parseNfseXml(xml))
  same('parseEventXml', () => parseEventXml(xml), () => legacy_parseEventXml(xml))
  same('assinatura do evento', () => eventSignature(xml), () => legacy_eventSignature(legacy_parseEventXml(xml), xml))
  if (/<infNFSe\b/.test(xml)) same('extractDanfseFields', () => extractDanfseFields(xml), () => legacy_extractDanfseFields(xml))
  return out
}
describe('[N17-04] paridade em XML BEM-FORMADO', () => {
  const DIVERGENT: [string, string][] = [
    ['espaço antes do `>` no grupo do tipo (`<e101101 >`) — o recorte não via o evento', eventXml().replace('<e101101>', '<e101101 >')],
    ['espaço na tag de FECHAMENTO (`</nNFSe >`) — o recorte perdia o número', nfseXml({ header: '<nNFSe>123</nNFSe ><cStat>100</cStat>' })],
    ['comentário com `<emit>` no cabeçalho — o recorte cortava o cabeçalho no comentário', nfseXml({ header: '<!-- <emit> --><nNFSe>123</nNFSe><cStat>100</cStat>' })],
    ['comentário com `<cStat>999</cStat>` antes do real — o recorte lia o comentário', nfseXml({ header: '<!-- <cStat>999</cStat> --><nNFSe>123</nNFSe><cStat>100</cStat>' })],
    ['comentário com `<e101101>…</e101101>` numa NFS-e — o recorte a dava por CANCELADA', nfseXml({ tail: '<!-- <e101101><cMotivo>1</cMotivo><xMotivo>x</xMotivo></e101101> -->' })],
    ['referência de ESPAÇO na ponta do valor (`&#32;x&#32;`) — o recorte apara ANTES de decodificar', eventXml({ inner: '<cMotivo>1</cMotivo><xMotivo>&#32;x&#32;</xMotivo>' })],
    ['CR LF dentro do valor — o parser normaliza para LF (XML 1.0 §2.11)', eventXml({ inner: '<cMotivo>1</cMotivo><xMotivo>a\r\nb</xMotivo>' })],
    ['referência de caractere em ATRIBUTO (`Id="NFS&#52;…"`) — o recorte devolvia a referência crua', nfseXml({ idAttr: `<infNFSe Id="NFS&#52;${KEY.slice(1)}">` })],
    ['espaço em volta do `=` do atributo (`Id = "…"`) — o recorte não via o Id', nfseXml({ idAttr: `<infNFSe Id = "NFS${KEY}">` })],
    ['`>` literal em OUTRO atributo antes do Id — o recorte não via o Id', nfseXml({ idAttr: `<infNFSe a=">" Id="NFS${KEY}">` })],
  ]
  it.each(DIVERGENT)('[DECIDIDO — D-NE90] [LOW N17-04] DIVERGÊNCIA INTENCIONAL do oráculo — o parser dá a leitura CORRETA do XML (sem recusa): %s', (_l, xml) => {
    expect(() => { parseNfseXml(xml); parseEventXml(xml) }).not.toThrow()
    expect(divergences(xml)).not.toEqual([])
  })
  it('[DECIDIDO — D-NE90] contexto: a divergência muda VOZ — no GET tipado, dois eventos que diferem só por espaço CODIFICADO na ponta do motivo: o recorte dava contradição (ambíguo, D-F89); o parser, repetição (CANCELADA)', async () => {
    const a = eventXml(), b = eventXml({ inner: '<xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu&#32;</xMotivo>' })
    expect(legacy_eventSignature(legacy_parseEventXml(a), a) === legacy_eventSignature(legacy_parseEventXml(b), b)).toBe(false)
    expect(verdict(await queryWith({ typed: { '101101': [a, b] } }))).toBe('cancelled')
  })
  it('[DECIDIDO — D-NE90] contexto: `<e101101 >` no evento gerado — o recorte não o conferia (ambíguo `evento-nao-conferido`); o parser o dá por CANCELADO', async () => {
    const ev = eventXml().replace('<e101101>', '<e101101 >')
    expect(legacy_parseEventXml(ev).eventCode).toBeNull()
    expect(verdict(await queryWith({ typed: { '101101': [ev] } }))).toBe('cancelled')
  })
  it('resistiu: classes bem-formadas em que a paridade VALE — grupo e101101 dentro de e105102, infNFSe repetido, emit com atributo, chNFSe noutro namespace padrão, TAB antes do atributo, quebra de linha antes do `>`', () => {
    const SAME: [string, string][] = [
      ['e101101 dentro de e105102', eventXml({ code: '105102', inner: `<cMotivo>01</cMotivo><chSubstituta>${KEY_B}</chSubstituta><e101101><cMotivo>1</cMotivo><xMotivo>m</xMotivo></e101101>` })],
      ['infNFSe repetido', nfseXml({ tail: `<infNFSe Id="NFS${KEY_B}"><nNFSe>77</nNFSe><emit></emit></infNFSe>` })],
      ['emit com atributo', nfseXml({ emit: `<emit versao="1"><CNPJ>${CNPJ}</CNPJ><xNome>Setes</xNome></emit>` })],
      ['chNFSe noutro namespace padrão', eventXml().replace(`<chNFSe>${KEY}</chNFSe>`, `<chNFSe xmlns="urn:x">${KEY}</chNFSe>`)],
      ['TAB antes do atributo', nfseXml({ idAttr: `<infNFSe\tId="NFS${KEY}">` })],
      ['quebra de linha antes do `>`', nfseXml({ header: '<nNFSe\n>123</nNFSe><cStat>100</cStat>' })],
    ]
    expect(SAME.map(([l, x]) => [l, divergences(x)])).toEqual(SAME.map(([l]) => [l, []]))
  })
})

// ===========================================================================
// [N17-05] LOW — auto-fechado: "o vazio vira nulo nos consumidores" (D-NE72) não vale para os `??` — '' não é nulo
// ===========================================================================
describe('[N17-05] auto-fechado × `??`', () => {
  it('[CORRIGIDO na sessão — D-NE85] [LOW N17-05] registrar evento: `<dhProc/>` no evento GERADO → o C devia levar o dhEvento do XML (como o publicado); hoje leva "" (o `??` não cai) e a voz C nasce sem instante', async () => {
    const r = await registerWith(eventXml({ dhProc: '<dhProc/>' }))
    expect(r instanceof Error ? verdict(r) : r.dhEvento).toBe('2026-10-10T18:43:00-03:00')
  })
  it('[CORRIGIDO na sessão — D-NE85] [LOW N17-05] transmitir: `<dhProc/>` no cabeçalho da NFS-e → devia cair no `dataHoraProcessamento` do JSON (como o publicado); hoje ""', async () => {
    const r = await transmitWith(nfseXml({ header: '<nNFSe>123</nNFSe><cStat>100</cStat><dhProc/>' }))
    expect(r instanceof Error ? verdict(r) : r.dhProc).toBe(SEFIN.dataHoraProcessamento)
  })
  it('[DECIDIDO — D-NE85] (era o contexto da Q-NE92: o grupo VAZIO virava CANCELAMENTO) — grupo do tipo VAZIO (`<e101101/>` ou `<e101101></e101101>`, sem xDesc/cMotivo/xMotivo que o XSD exige) no evento gerado é RECUSA → ambíguo `evento-ilegivel` nos DOIS caminhos (GET tipado e registrar); nunca C', async () => {
    const selfClosed = eventXml().replace(/<e101101>[\s\S]*<\/e101101>/, '<e101101/>')
    const explicitEmpty = eventXml({ inner: '' })
    expect(legacy_parseEventXml(selfClosed).eventCode).toBeNull()                       // o recorte não o via (ambíguo `evento-nao-conferido`)
    expect(legacy_parseEventXml(explicitEmpty).eventCode).toBe('101101')                // o recorte dava a forma explícita por cancelamento
    for (const ev of [selfClosed, explicitEmpty]) {
      expect(() => parseEventXml(ev)).toThrow(XmlUnreadableError)
      expect(verdict(await queryWith({ typed: { '101101': [ev] } }))).toBe('unknown:evento-ilegivel')
      expect(verdict(await registerWith(ev))).toBe('ambiguo:evento-ilegivel')
    }
    // o bloco de cancelamento EMBUTIDO na NFS-e: vazio = recusa da NFS-e (`nfse-ilegivel`), nunca "cancelada"
    expect(verdict(await queryWith({ nfse: nfseXml({ tail: '<e101101/>' }) }))).toBe('ambiguo:nfse-ilegivel')
  })
})

// ===========================================================================
// RESISTIU — (b) recusa → ambíguo pela causa existente, nunca exceção crua; (c) qualificado + texto simples; resposta trocada
// ===========================================================================
describe('resistiu — o adaptador', () => {
  it('resistiu: CDATA, filho ou comentário no VALOR lido → ambíguo pela causa existente (transmitir `nfse-ilegivel`; GET tipado `evento-ilegivel`; registrar `evento-ilegivel`; bloco embutido na consulta `nfse-ilegivel`)', async () => {
    expect(verdict(await transmitWith(nfseXml({ header: '<nNFSe><![CDATA[123]]></nNFSe><cStat>100</cStat>' })))).toBe('ambiguo:nfse-ilegivel')
    expect(verdict(await transmitWith(nfseXml({ dpsId: DPS_ID }).replace('<cStat>100</cStat>', '<cStat>1<!-- -->00</cStat>')))).toBe('ambiguo:nfse-ilegivel')
    expect(verdict(await queryWith({ typed: { '105102': [eventXml({ code: '105102', inner: `<cMotivo>01</cMotivo><chSubstituta><x>${KEY_B}</x></chSubstituta>` })] } }))).toBe('unknown:evento-ilegivel')
    expect(verdict(await registerWith(eventXml({ dhProc: '<dhProc>2026-10-10T18:43:05-03:00<!-- x --></dhProc>' })))).toBe('ambiguo:evento-ilegivel')
    expect(verdict(await queryWith({ nfse: nfseXml({ tail: '<e101101><cMotivo>1</cMotivo><xMotivo><![CDATA[x]]></xMotivo></e101101>' }) }))).toBe('ambiguo:nfse-ilegivel')
  })
  it('resistiu: XML ILEGÍVEL do fisco (DOCTYPE/XXE, truncado, lixo depois da raiz, CDATA depois da raiz — o @xmldom lança Error CRU —, 30 000 níveis — RangeError) → ambíguo pela causa, nunca exceção crua, nos três caminhos', async () => {
    const strange = (x: string) => [
      `<!DOCTYPE NFSe [<!ENTITY e SYSTEM "file:///etc/passwd">]>${x.replace(/^<\?xml[^>]*>/, '')}`,
      x.slice(0, x.length - 20), `${x}lixo`, `${x}<![CDATA[x]]>`, x.replace('<xLocEmi>', `${'<a>'.repeat(30000)}${'</a>'.repeat(30000)}<xLocEmi>`),
    ]
    for (const n of strange(nfseXml())) expect(verdict(await transmitWith(n))).toBe('ambiguo:nfse-ilegivel')
    for (const n of strange(nfseXml())) expect(verdict(await queryWith({ nfse: n }))).toBe('ambiguo:nfse-ilegivel')
    const ev = eventXml()
    const evStrange = [`<!DOCTYPE evento>${ev}`, ev.slice(0, ev.length - 20), `${ev}lixo`, `${ev}<![CDATA[x]]>`, ev.replace('<verAplic>SEFIN', `${'<a>'.repeat(30000)}${'</a>'.repeat(30000)}<verAplic>SEFIN`)]
    for (const e of evStrange) expect(verdict(await queryWith({ typed: { '101101': [e] } }))).toBe('unknown:evento-ilegivel')
    for (const e of evStrange) expect(verdict(await registerWith(e))).toBe('ambiguo:evento-ilegivel')
  })
  it('resistiu: resposta TROCADA com aspas simples — NFS-e de OUTRO DPS (`Id=\'…\'`) no transmitir e de OUTRA chave na consulta continuam barradas (foreign)', async () => {
    const other = nfseXml({ dpsId: DPS_ID_B }).replace(`<infDPS Id="${DPS_ID_B}">`, `<infDPS Id='${DPS_ID_B}'>`)
    expect(verdict(await transmitWith(other, { chaveAcesso: undefined }))).toBe('ambiguo:nfse-de-outro-dps')
    expect(verdict(await queryWith({ nfse: nfseXml({ idAttr: `<infNFSe Id='NFS${KEY_B}'>` }) }))).toBe('ambiguo:nfse-chave-divergente')
  })
  it('resistiu: chamariz em COMENTÁRIO com o NOSSO Id antes do Id real de outro DPS — o parser lê o real (foreign); o recorte publicado lia o do comentário e AUTORIZAVA a NFS-e alheia', async () => {
    const decoy = nfseXml({ dpsId: DPS_ID_B }).replace('<DPS versao="1.01">', `<!-- <infDPS Id="${DPS_ID}"> --><DPS versao="1.01">`)
    expect(legacy_parseNfseXml(decoy).dpsId).toBe(DPS_ID)
    expect(verdict(await transmitWith(decoy, { chaveAcesso: undefined }))).toBe('ambiguo:nfse-de-outro-dps')
  })
  it('resistiu: o eco do NOSSO pedido com `<dhProc/>` (sem Id EVT) não vira aceite (`evento-sem-retorno`); nome com prefixo não casa (qualificado)', async () => {
    expect(verdict(await registerWith(eventXml({ id: '', dhProc: '<dhProc/>' })))).toBe('ambiguo:evento-sem-retorno')
    const prefixed = eventXml().replace(`<chNFSe>${KEY}</chNFSe>`, `<n:chNFSe xmlns:n="urn:x">${KEY}</n:chNFSe>`)
    expect(verdict(await registerWith(prefixed))).toBe('ambiguo:evento-sem-retorno')
  })
})

// ===========================================================================
// contexto [N17-08] — custo: a assinatura do evento (D-F93) re-parseia o documento INTEIRO a cada campo
// ===========================================================================
describe('[N17-08] custo', () => {
  it('[CORRIGIDO na sessão] (era o contexto do N17-08: 6 parses com UM evento, 1 + 5N com N) — UM parse por documento: consulta com UM evento no GET tipado = 2 (NFS-e 1 + evento 1, a assinatura D-F93 lê o MESMO documento); com N eventos, 1 + N', async () => {
    expect(verdict(await queryWith({ typed: { '101101': [eventXml()] } }))).toBe('cancelled')
    expect((fiscal.parseXml as unknown as jest.Mock).mock.calls.length).toBe(2)
    ;(fiscal.parseXml as unknown as jest.Mock).mockClear()
    expect(verdict(await queryWith({ typed: { '101101': [eventXml(), eventXml(), eventXml()] } }))).toBe('cancelled')
    expect((fiscal.parseXml as unknown as jest.Mock).mock.calls.length).toBe(4)
  })
})
