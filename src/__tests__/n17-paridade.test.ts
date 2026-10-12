/// <reference types="jest" />
// N17 (parte 2 da NE-1a, passo 7 — D-NE72 = Q-NE72 (a), Valdo 2026-10-12): o leitor de XML da NFS-e por PARSER (núcleo `xml/reader.ts`) ×
// o leitor por regex COMO ESTAVA PUBLICADO (oráculo congelado em `legacy-xml-oracle.ts`).
//  - CORPUS REAL do dev (setes-api/storage = produção; nfse-api/storage-smoke = homologação): saída IDÊNTICA — nada do conteúdo é impresso;
//  - fixtures BEM-FORMADAS (sintéticas): IDÊNTICA;
//  - os casos ESTRANHOS: o leitor RECUSA (CDATA, filho ou comentário no valor, XML ilegível, referência inválida) e o adaptador transforma a
//    recusa no ambíguo pela causa que já existe — a divergência é INTENCIONAL e fica fixada aqui ([DECIDIDO — D-NE72]).
// Medição do passo 7 (instrumentação temporária, revertida): 1014 leituras da suíte inteira, 0 divergência fora dos casos estranhos.
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { parseXml, firstElement, attrOf, elementsOf, XmlUnreadableError } from 'fiscal-api'
import { parseNfseXml, parseEventXml, firstText, NFSE_XML } from '../authority/dps-builder'
import { extractDanfseFields } from '../nfse/danfse'
import {
  legacy_parseNfseXml, legacy_parseEventXml, legacy_firstText, legacy_extractDanfseFields, legacy_sentDpsIdOf, legacy_eventSignature,
} from './legacy-xml-oracle'

const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
const walkXml = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? walkXml(path.join(dir, d.name)) : d.name.endsWith('.xml') ? [path.join(dir, d.name)] : []))
const label = (f: string) => path.basename(f).replace(/\d{20,}/, '<k>')
/** O Id do DPS enviado pelo leitor (a mesma busca do `sentDpsIdOf` do adaptador). */
const sentDpsId = (xml: string) => { const el = firstElement(parseXml(xml), 'infDPS', NFSE_XML, e => attrOf(e, 'Id') !== null); return el ? attrOf(el, 'Id') : null }
/** A assinatura do evento (D-F89/D-F93/D-F96) pelo leitor novo — a MESMA fórmula do adaptador. */
const eventSignature = (xml: string) => {
  const e = parseEventXml(xml)
  return JSON.stringify([e.eventCode, e.eventId, e.dhProc, e.dhEvento, e.nSeqEvento, e.cMotivo, e.xMotivo, e.substituteKey ?? null,
    firstText(xml, 'nDFSe'), firstText(xml, 'CNPJAutor') ?? firstText(xml, 'CPFAutor'), firstText(xml, 'ambGer'), firstText(xml, 'tpAmb')])
}
/** Os nomes das FOLHAS COM CONTEÚDO do documento (sem filho elemento e com texto) — onde o `firstText` é leitura de VALOR. As folhas VAZIAS
 *  ficam de fora: valor vazio = AUSENTE (D-NE85 — fixado abaixo). */
const leafNames = (xml: string) => [...new Set(elementsOf(parseXml(xml)).filter(e => !elementsOf(e).length && e.childNodes.length > 0).map(e => e.nodeName))]
/** As folhas VAZIAS do documento. */
const emptyLeafNames = (xml: string) => [...new Set(elementsOf(parseXml(xml)).filter(e => !elementsOf(e).length && e.childNodes.length === 0).map(e => e.nodeName))]
const refuses = (fn: () => unknown) => { try { fn(); return false } catch (e) { return e instanceof XmlUnreadableError } }

/** Compara o leitor novo com o oráculo em TUDO o que a família lê de um documento. Devolve as divergências (rótulo do campo). */
function divergences(xml: string): string[] {
  const out: string[] = []
  const same = (field: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(field) }
  same('parseNfseXml', parseNfseXml(xml), legacy_parseNfseXml(xml))
  same('parseEventXml', parseEventXml(xml), legacy_parseEventXml(xml))
  same('assinatura do evento', eventSignature(xml), legacy_eventSignature(legacy_parseEventXml(xml), xml))
  same('sentDpsIdOf', sentDpsId(xml), legacy_sentDpsIdOf(xml))
  for (const n of leafNames(xml)) same(`firstText(${n})`, firstText(xml, n), legacy_firstText(xml, n))
  if (/<infNFSe\b/.test(xml)) same('extractDanfseFields', extractDanfseFields(xml), legacy_extractDanfseFields(xml))
  return out
}

describe('N17 — o ORÁCULO é o leitor publicado, congelado (gate socrático do delta)', () => {
  it('o arquivo do oráculo não muda: sha256 do texto (fins de linha normalizados) = o extraído do git 38980bb', () => {
    const text = fs.readFileSync(path.join(__dirname, 'legacy-xml-oracle.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe('16be3da87a580de0cbec4daacfc4e647723047447941c605eab79387cb2c5b24')
  })
})

describe('N17 — paridade no CORPUS REAL do dev (D-NE72)', () => {
  const files = [...walkXml(path.join(WORKSPACE, 'setes-api', 'storage')), ...walkXml(path.join(WORKSPACE, 'nfse-api', 'storage-smoke'))]
  it('saída IDÊNTICA ao leitor publicado em TUDO o que a família lê — NFS-e, eventos e DPS de produção e de homologação (8 + 6 no dev)', () => {
    if (!files.length) return                                       // fora do dev (sem o corpus) não há o que comparar
    expect(files.length).toBeGreaterThanOrEqual(14)
    expect(files.map(f => [label(f), divergences(fs.readFileSync(f, 'utf8'))])).toEqual(files.map(f => [label(f), []]))
    // as folhas VAZIAS do corpus são só os algoritmos da ASSINATURA (auto-fechados — nunca lidos pela família): o auto-fechado não toca dado
    const empties = [...new Set(files.flatMap(f => emptyLeafNames(fs.readFileSync(f, 'utf8'))))].sort()
    expect(empties).toEqual(['CanonicalizationMethod', 'DigestMethod', 'SignatureMethod', 'Transform'])
  })
  it('o corpus é lido de verdade (não empata em nulo): toda NFS-e tem chave de 50 dígitos e Id do DPS; todo evento é 101101 GERADO com chave', () => {
    if (!files.length) return
    for (const f of files.filter(x => x.endsWith('-nfse.xml'))) {
      const p = parseNfseXml(fs.readFileSync(f, 'utf8'))
      expect([label(f), /^\d{50}$/.test(p.accessKey ?? ''), /^DPS\d{42}$/.test(p.dpsId ?? ''), !!p.nNFSe, !!p.dhProc]).toEqual([label(f), true, true, true, true])
    }
    for (const f of files.filter(x => x.includes('-evt'))) {
      const e = parseEventXml(fs.readFileSync(f, 'utf8'))
      expect([label(f), e.eventCode, /^EVT/.test(e.eventId ?? ''), /^\d{50}$/.test(e.accessKey ?? '')]).toEqual([label(f), '101101', true, true])
    }
  })
})

// --- fixtures SINTÉTICAS bem-formadas (nenhum dado real) ---
const KEY = '41069022212345678000199000000000012326090000123451'
const NFSE = (header = '<nNFSe>12</nNFSe><cStat>100</cStat><dhProc>2026-10-10T18:43:05-03:00</dhProc><nDFSe>7</nDFSe><ambGer>2</ambGer>', emit = '<emit>') =>
  `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
  `<xLocEmi>Curitiba &amp; Região</xLocEmi>${header}${emit}<CNPJ>12345678000199</CNPJ><xNome>Setes &#38; Cia</xNome></emit>` +
  `<valores><vLiq>10.00</vLiq><vISSQN>0.20</vISSQN></valores><DPS versao="1.01"><infDPS Id="DPS410690221234567800019900001000000000000042">` +
  `<nDPS>42</nDPS><serie>1</serie><dCompet>2026-10-01</dCompet><prest><CNPJ>12345678000199</CNPJ></prest><toma><CNPJ>98765432000188</CNPJ>` +
  `<xNome>Cliente "A"</xNome><end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac><xLgr>Rua &lt;X&gt;</xLgr><nro>1</nro></end></toma>` +
  `<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>Licença &#x2014; mês</xDescServ></cServ></serv>` +
  `<valores><vServPrest><vServ>10.00</vServ></vServPrest><trib><tribMun><tpRetISSQN>1</tpRetISSQN></tribMun></trib></valores><nNFSe>999</nNFSe></infDPS></DPS></infNFSe></NFSe>`
const EVENT = (code: string, inner: string, id = `EVT${KEY}${code}001`) =>
  `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="${id}"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento>` +
  `<dhProc>2026-10-10T18:43:05-03:00</dhProc><nDFSe>1</nDFSe><pedRegEvento versao="1.01"><infPedReg Id="PRE${KEY}${code}"><tpAmb>2</tpAmb>` +
  `<verAplic>X</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>12345678000199</CNPJAutor><chNFSe>${KEY}</chNFSe>` +
  `<nPedRegEvento>1</nPedRegEvento><e${code}>${inner}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`

describe('N17 — paridade nas fixtures BEM-FORMADAS (D-NE72)', () => {
  const WELL_FORMED: [string, string][] = [
    ['NFS-e típica (entidades predefinidas, de caractere e decimal; o cabeçalho antes do <emit> não pega o nNFSe do DPS)', NFSE()],
    ['NFS-e com <emit> COM atributo (o cabeçalho segue até o próximo <emit> sem atributo, ou o documento inteiro)', NFSE(undefined, '<emit versao="1">')],
    ['NFS-e sem cStat no cabeçalho (o do DPS embutido não vale)', NFSE('<nNFSe>12</nNFSe><dhProc>2026-10-10T18:43:05-03:00</dhProc>')],
    ['NFS-e com espaço nas pontas dos valores e quebra de linha', NFSE('<nNFSe>\n  12  \n</nNFSe><cStat> 100 </cStat>')],
    ['cancelamento e101101 (motivo com entidades)', EVENT('101101', '<xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro &amp; correção &#x2014; ok</xMotivo>')],
    ['substituição e105102 (chave substituta)', EVENT('105102', `<xDesc>Cancelamento por Substituição</xDesc><cMotivo>01</cMotivo><chSubstituta>${KEY.replace(/1$/, '2')}</chSubstituta>`)],
    ['pedido ECOADO (sem Id EVT, sem dhProc no evento)', EVENT('101101', '<cMotivo>1</cMotivo><xMotivo>x</xMotivo>', '').replace(' Id=""', '').replace('<dhProc>2026-10-10T18:43:05-03:00</dhProc>', '')],
    ['tipo de evento fora do domínio de cancelamento (e101103)', EVENT('101103', '<xDesc>Outro</xDesc>')],
    ['autor por CPF', EVENT('101101', '<cMotivo>1</cMotivo>').replace('<CNPJAutor>12345678000199</CNPJAutor>', '<CPFAutor>12345678909</CPFAutor>')],
    ['prefixo de namespace num campo (o nome QUALIFICADO não casa — os dois ignoram)', EVENT('101101', '<cMotivo>1</cMotivo>').replace(`<chNFSe>${KEY}</chNFSe>`, `<n:chNFSe xmlns:n="urn:x">${KEY}</n:chNFSe>`)],
  ]
  it.each(WELL_FORMED)('IDÊNTICA: %s', (_l, xml) => {
    expect(refuses(() => parseXml(xml))).toBe(false)
    expect(divergences(xml)).toEqual([])
  })
})

describe('N17 — os casos ESTRANHOS: o leitor RECUSA (a divergência é intencional — D-NE72)', () => {
  const ev = EVENT('105102', `<cMotivo>01</cMotivo><chSubstituta>${KEY}</chSubstituta>`)
  const STRANGE: [string, string, () => unknown][] = [
    ['CDATA no valor lido (o recorte devolvia o texto com a marcação)', ev.replace(`<chSubstituta>${KEY}</chSubstituta>`, `<chSubstituta><![CDATA[${KEY}]]></chSubstituta>`), () => undefined],
    ['elemento dentro do valor lido (o recorte devolvia a marcação crua)', ev.replace(`<chSubstituta>${KEY}</chSubstituta>`, `<chSubstituta><x>${KEY}</x></chSubstituta>`), () => undefined],
    ['comentário dentro do valor lido', ev.replace('<cMotivo>01</cMotivo>', '<cMotivo>0<!-- c -->1</cMotivo>'), () => undefined],
    ['referência de caractere fora do Unicode (o recorte LANÇAVA RangeError só ao ler aquele campo)', ev.replace('<nDFSe>1</nDFSe>', '<nDFSe>&#x110000;</nDFSe>'), () => undefined],
    ['entidade não predefinida (o recorte a devolvia LITERAL)', ev.replace('<cMotivo>01</cMotivo>', '<cMotivo>&foo;</cMotivo>'), () => undefined],
    ['`&` solto', ev.replace('<cMotivo>01</cMotivo>', '<cMotivo>a & b</cMotivo>'), () => undefined],
    ['DOCTYPE', '<!DOCTYPE evento>' + ev, () => undefined],
    ['texto em UTF-16 lido como UTF-8 (o recorte não achava NADA e respondia "nada")', Buffer.from('﻿' + ev, 'utf16le').toString('latin1'), () => undefined],
    ['lixo depois da raiz', ev + '<lixo/>', () => undefined],
  ]
  it.each(STRANGE)('[DECIDIDO — D-NE72] %s → o leitor novo RECUSA (o adaptador responde ambíguo pela causa existente)', (_l, xml) => {
    expect(refuses(() => { parseEventXml(xml); eventSignature(xml) })).toBe(true)
  })
  it('[DECIDIDO — D-NE85] auto-fechado: valor vazio = AUSENTE — o parser PULA `<x/>` e lê o próximo `<x>…</x>`, como o recorte (paridade)', () => {
    const xml = NFSE('<nNFSe/><cStat>100</cStat><nNFSe>12</nNFSe>')
    expect([parseNfseXml(xml).nNFSe, legacy_parseNfseXml(xml).nNFSe]).toEqual(['12', '12'])
  })
  it('[DECIDIDO — D-NE85] valor vazio EXPLÍCITO (`<xMotivo></xMotivo>`): o recorte devolvia ""; o parser devolve AUSENTE (null) — divergência intencional', () => {
    const xml = EVENT('101101', '<cMotivo>1</cMotivo><xMotivo></xMotivo>')
    expect([parseEventXml(xml).xMotivo, legacy_parseEventXml(xml).xMotivo]).toEqual([null, ''])
  })
  it('[DECIDIDO — D-NE85] GRUPO que decide voz VAZIO (`<e101101/>`, `<e101101></e101101>`, `<e105102/>`) — no evento e embutido na NFS-e — é RECUSA (`grupo-vazio`), nunca cancelamento', () => {
    const reasonOf = (fn: () => unknown) => { try { fn(); return 'leu' } catch (e) { return e instanceof XmlUnreadableError ? e.reason : String(e) } }
    expect(reasonOf(() => parseEventXml(EVENT('101101', '').replace('<e101101></e101101>', '<e101101/>')))).toBe('grupo-vazio')
    expect(reasonOf(() => parseEventXml(EVENT('101101', '')))).toBe('grupo-vazio')
    expect(reasonOf(() => parseEventXml(EVENT('105102', '')))).toBe('grupo-vazio')
    expect(reasonOf(() => parseNfseXml(NFSE().replace('</infNFSe>', '</infNFSe><e101101/>')))).toBe('grupo-vazio')
  })
  it('[DECIDIDO — D-NE72, ratificado na D-NE85] atributo entre aspas SIMPLES: o recorte só via aspas duplas (devolvia nulo); o parser lê o valor — a resposta trocada segue barrada pela conferência da chave/Id (adaptador)', () => {
    const xml = NFSE().replace(`<infNFSe Id="NFS${KEY}">`, `<infNFSe Id='NFS${KEY}'>`)
    expect([parseNfseXml(xml).accessKey, legacy_parseNfseXml(xml).accessKey]).toEqual([KEY, null])
  })
})
