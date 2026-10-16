import { toUtcDb, nowIsoIn, DEFAULT_TIME_ZONE, parseXml, firstElement, firstText as readFirstText, textOf, attrOf as readAttr, attributeCount, childElementCount, XmlUnreadableError, elementsOf, nameIs, contains, XmlNode, XmlReadOptions } from 'fiscal-api'
import {
  AuthorityEnvironment, CancelEventInput, DpsIbscbs, DpsInput, DpsTpInsc, NfseDeclaredIbscbs, NfseIbscbsValues, ParsedEvent, ParsedNfse,
  ParsedNfseIbscbs,
} from './types'
import { layoutAt } from './layout-calendar'
import { asNfseAccessKey } from './access-key'

/**
 * Montagem do XML do DPS v1.01 e do pedido de registro de evento (cancelamento
 * e101101), FIEL ao XSD (Infra-IA/setes-api/integracoes/nfse-adn/xsd/Schemas/1.01):
 * ordem dos elementos = ordem do `xs:sequence`; opcional só entra se veio;
 * decimais com 2 casas e ponto; strings escapadas; sem espaço/quebra entre
 * tags (Manual 2022 §6.1 d: "não incluir caracteres de formatação").
 * Sem lib de XML: o leiaute é fixo e pequeno — um escapador basta.
 */

export const NFSE_NS      = 'http://www.sped.fazenda.gov.br/nfse'
// a versão do leiaute vem do CALENDÁRIO do adaptador (`layout-calendar.ts` — D-IB81), pelo instante e pelo ambiente — nunca constante global
export const EVENT_CANCEL = '101101'
/**
 * R3-3: tiposEventos_v1.01.xsd tem QUATRO cancelamentos — e101101 (contribuinte) · e105102 (por
 * substituição) · e105104 (deferido por análise fiscal — o único caminho fora do prazo municipal) ·
 * e305101 (de ofício, pelo fisco). Todos chegam por GET /eventos como evento gerado desta chave.
 */
export const CANCEL_EVENT_CODES: ReadonlySet<string> = new Set(['101101', '105102', '105104', '305101'])
/** Faixa de série do aplicativo próprio (Manual: 50000–99999 são do emissor nacional). Fonte ÚNICA — DTO e Id consomem daqui. */
export const DPS_SERIE_MIN = 1
export const DPS_SERIE_MAX = 49_999
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

// ---------------------------------------------------------------------------
// utilitários de formatação
// ---------------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string))
}

export function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'
    if (e === 'quot') return '"'; if (e === 'apos') return "'"
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })
}

/** TSDec*V2: 2 casas, ponto, sem separador de milhar ("0" e "0.50" válidos). */
export function dec2(v: number): string {
  if (!Number.isFinite(v) || v < 0) throw new Error(`Valor decimal inválido para o DPS: ${v}`)
  return v.toFixed(2)
}

/** TSString: sem espaço nas pontas e sem controle; multiline mantém \n (TSStringComQuebraDeLinha). */
/**
 * TSString do XSD (TODO texto do DPS e dos eventos): só U+0020–U+00FF — padrão `[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}`. Tipografia comum
 * vira o ASCII equivalente e o resto fora da faixa (emoji, símbolos, separadores Unicode) SAI — senão o fisco recusa o documento
 * pelo ESQUEMA com 400 sem detalhe (achado em PRODUÇÃO, 2026-10-10: o cancelamento da NFS-e 706 com o motivo "teste" levou o
 * travessão U+2014 do complemento automático).
 */
const TYPOGRAPHY: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u201C': '"', '\u201D': '"', '\u201E': '"',
  '\u2026': '...', '\u2022': '-', '\u2028': ' ', '\u2029': ' ',
}
export function toTsString(s: string): string {
  // D-F66 (= Q-F73 (a), Valdo 2026-10-10): NFC ANTES do filtro — acento digitado decomposto (e + U+0301) vira o 'é' do Latin-1
  // em vez de perder o diacrítico (gate adversarial DF61-06). O filtro Latin-1 vale para TODO texto livre do DPS/evento,
  // inclusive onde o XSD aceitaria mais (xNome, xDescServ): escolha registrada — o fisco serializa mal fora do ASCII (§21.2)
  return String(s ?? '').normalize('NFC')
    .replace(/[\u2010-\u2015\u2212\u2018-\u201E\u2026\u2022\u2028\u2029]/g, c => TYPOGRAPHY[c] ?? '')
    // re-gate R11-04: fora do Latin-1 cai na LETRA-BASE (Š→S, č→c — o NFC tinha juntado letra + marca num caractere só);
    // sem base no Latin-1 (ł, CJK, emoji) o caractere sai
    .replace(/[^\u0000-\u00FF]/g, c => {
      const base = c.normalize('NFD').replace(/[\u0300-\u036F]/g, '')
      return /^[\u0020-\u00FF]+$/.test(base) ? base : ''
    })
}

/** Corte em N SEM espaço no fim: o padrão TSString exige o último caractere não branco (gate DF61-05 / L2). */
function cut(s: string, n: number): string {
  return s.slice(0, n).trimEnd()
}

function text(s: string, multiline = false): string {
  // caractere de CONTROLE é proibido no XML 1.0 (gate adversarial da F1, LOW): nunca vai cru ao XML assinado
  const t = toTsString(String(s ?? '')).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const cleaned = multiline ? t.replace(/[^\S\n]+\n/g, '\n') : t.replace(/[\n\t]+/g, ' ')
  return cleaned.trim()
}

function digits(s: string | number, label: string, len?: number): string {
  const d = String(s ?? '').replace(/\D/g, '')
  if (!d || (len !== undefined && d.length !== len)) throw new Error(`${label} inválido (esperado ${len ?? '≥1'} dígitos): ${s}`)
  return d
}

/**
 * TSDateTimeUTC: AAAA-MM-DDThh:mm:ss±hh:00 (sem milissegundos; 'Z' vira +00:00).
 * Aceita ISO com fuso; sem fuso = hora OFICIAL de Brasília (nunca o fuso do processo — Q-TZ1).
 */
export function formatDateTimeTz(iso: string): string {
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  if (m) return `${m[1]}T${m[2]}${m[3] === 'Z' ? '+00:00' : m[3]}`
  // L2 do gate socrático (onda TZ-1): sem offset = hora OFICIAL de Brasília — nunca o
  // fuso do processo Node (servidor em UTC mandaria -00:00 ao fisco)
  const utc = toUtcDb(iso, DEFAULT_TIME_ZONE)
  if (!utc) throw new Error(`Data/hora inválida para o DPS: ${iso}`)
  return nowIsoIn(DEFAULT_TIME_ZONE, new Date(`${utc.replace(' ', 'T')}Z`))
}

/** tpAmb do XSD: 1 produção · 2 homologação (produção restrita). */
export function tpAmbOf(environment: AuthorityEnvironment): '1' | '2' {
  return environment === 'P' ? '1' : '2'
}

const el = (name: string, value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : `<${name}>${escapeXml(value)}</${name}>`
const grp = (name: string, inner: string, attrs = ''): string => `<${name}${attrs}>${inner}</${name}>`

// ---------------------------------------------------------------------------
// Id do DPS (45) e XML do DPS
// ---------------------------------------------------------------------------

/**
 * "DPS" + cMun(7) + tpInsc(1: 1 CPF · 2 CNPJ) + inscrição(14, zero à esquerda)
 * + série(5) + nDPS(15) = 45 posições (TSIdDPS `DPS[0-9]{42}`).
 *
 * D-CJ8/D-CJ12 (gate socrático da onda 0 do CNPJ alfanumérico): a inscrição entra COMO É — CNPJ de 14 dígitos (tpInsc 2) ou CPF de 11
 * (tpInsc 1, zeros à esquerda); qualquer outra coisa LANÇA. Antes `digits(inscricao)` SEM tamanho tirava as letras e completava com zeros:
 * o Id (write-once na vida da nota) nasceria com a inscrição de OUTRO contribuinte. O CNPJ alfanumérico entra aqui pelo calendário de
 * LEIAUTE na onda 1 (D-CJ7) — até lá a fonte de fatos já recusa antes (`DPS_NUMERIC_CNPJ`) e este é o cinto.
 */
export function buildDpsId(cMun: string, tpInsc: DpsTpInsc, inscricao: string, serie: number | string, nDps: number | string): string {
  const mun = digits(cMun, 'cMun', 7)
  if (tpInsc !== '1' && tpInsc !== '2') throw new Error(`tpInsc inválido: ${tpInsc}`)
  const insc = String(inscricao ?? '')
  if (tpInsc === '2' ? !/^[0-9]{14}$/.test(insc) : !/^[0-9]{11}$/.test(insc)) {
    throw new Error(`inscrição inválida para o Id do DPS (tpInsc ${tpInsc}: esperado ${tpInsc === '2' ? 'CNPJ de 14 dígitos' : 'CPF de 11 dígitos'}, nada é removido): ${inscricao}`)
  }
  const s = Number(serie), n = Number(nDps)
  // séries do aplicativo próprio = 00001–49999 (50000+ são do emissor nacional — §1 do prompt);
  // defesa em profundidade: a linha do emissor pode ter vindo por SQL (ACHADO 3 do gate)
  if (!Number.isInteger(s) || s < DPS_SERIE_MIN || s > DPS_SERIE_MAX) throw new Error(`série inválida (esperado ${DPS_SERIE_MIN}–${DPS_SERIE_MAX}): ${serie}`)
  if (!Number.isInteger(n) || n < 1 || n > 999999999999999) throw new Error(`nDPS inválido: ${nDps}`)
  const id = `DPS${mun}${tpInsc}${insc.padStart(14, '0')}${String(s).padStart(5, '0')}${String(n).padStart(15, '0')}`
  if (id.length !== 45) throw new Error(`Id do DPS com ${id.length} posições (esperado 45)`)
  return id
}

function prestXml(p: DpsInput['prest']): string {
  const inner =
    el('CNPJ', digits(p.cnpj, 'CNPJ do prestador', 14)) +
    el('IM', p.im ? text(p.im) : null) +
    grp('regTrib', el('opSimpNac', p.regTrib.opSimpNac) + el('regApTribSN', p.regTrib.regApTribSN) + el('regEspTrib', p.regTrib.regEspTrib))
  return grp('prest', inner)
}

function tomaXml(t: NonNullable<DpsInput['toma']>): string {
  if (!!t.cnpj === !!t.cpf) throw new Error('Tomador exige CNPJ ou CPF (exatamente um)')
  let inner = t.cnpj ? el('CNPJ', digits(t.cnpj, 'CNPJ do tomador', 14)) : el('CPF', digits(t.cpf!, 'CPF do tomador', 11))
  inner += el('IM', t.im ? text(t.im) : null) + el('xNome', text(t.xNome))
  if (t.end) {
    inner += grp('end',
      grp('endNac', el('cMun', digits(t.end.cMun, 'cMun do tomador', 7)) + el('CEP', digits(t.end.cep, 'CEP do tomador', 8))) +
      el('xLgr', text(t.end.xLgr)) + el('nro', text(t.end.nro)) + el('xCpl', t.end.xCpl ? text(t.end.xCpl) : null) + el('xBairro', text(t.end.xBairro)))
  }
  inner += el('fone', t.fone ? digits(t.fone, 'fone do tomador') : null) + el('email', t.email ? text(t.email) : null)
  return grp('toma', inner)
}

function servXml(s: DpsInput['serv']): string {
  let inner = grp('locPrest', el('cLocPrestacao', digits(s.locPrest.cLocPrestacao, 'cLocPrestacao', 7)))
  inner += grp('cServ',
    el('cTribNac', digits(s.cServ.cTribNac, 'cTribNac', 6)) +
    el('cTribMun', s.cServ.cTribMun ? digits(s.cServ.cTribMun, 'cTribMun', 3) : null) +
    el('xDescServ', cut(text(s.cServ.xDescServ, true), 2000)) +
    el('cNBS', s.cServ.cNBS ? exactDigits(s.cServ.cNBS, 'cNBS', 9) : null))
  if (s.infoCompl && (s.infoCompl.docRef || s.infoCompl.xPed || s.infoCompl.xInfComp)) {
    inner += grp('infoCompl',
      el('docRef', s.infoCompl.docRef ? cut(text(s.infoCompl.docRef), 255) : null) +
      el('xPed', s.infoCompl.xPed ? cut(text(s.infoCompl.xPed), 60) : null) +
      el('xInfComp', s.infoCompl.xInfComp ? cut(text(s.infoCompl.xInfComp), 2000) : null))
  }
  return grp('serv', inner)
}

function valoresXml(v: DpsInput['valores']): string {
  let inner = grp('vServPrest', el('vServ', dec2(v.vServ)))
  if (v.vDescIncond !== undefined || v.vDescCond !== undefined) {
    inner += grp('vDescCondIncond',
      el('vDescIncond', v.vDescIncond !== undefined ? dec2(v.vDescIncond) : null) +
      el('vDescCond', v.vDescCond !== undefined ? dec2(v.vDescCond) : null))
  }
  const tm = v.trib.tribMun
  if (tm.pAliq !== undefined && (tm.pAliq < 0 || tm.pAliq >= 10)) throw new Error(`pAliq fora de TSDec1V2 (0–9.99): ${tm.pAliq}`)
  const tribMun = grp('tribMun', el('tribISSQN', tm.tribISSQN) + el('tpRetISSQN', tm.tpRetISSQN) + el('pAliq', tm.pAliq !== undefined ? dec2(tm.pAliq) : null))
  const tt = v.trib.totTrib
  const totTrib = grp('totTrib', 'indTotTrib' in tt ? el('indTotTrib', tt.indTotTrib) : el('pTotTribSN', dec2(tt.pTotTribSN)))
  inner += grp('trib', tribMun + totTrib)
  return grp('valores', inner)
}

/**
 * TCRTCInfoIBSCBS (IB-3 — D-IB2/D-IB62): o grupo IBS/CBS DECLARADO, ÚLTIMO filho de `infDPS`, na ordem do XSD (`finNFSe`, `indFinal`?,
 * `cIndOp`, `tpOper`?, `gRefNFSe`?, `tpEnteGov`?, `indDest`, `dest`?, `imovel`?, `valores`). Derivados por construção: `finNFSe` = 0 (NFS-e
 * regular — D-IB17), `indDest` = 0 (o destinatário é o próprio tomador; quando o ERP tiver o conceito, vira fato da NOTA) e `CST` = os 3
 * primeiros dígitos do cClassTrib (E0959). Opcionais fora do 1º release (§5 da fase) nunca saem.
 */
/** Cinto ESTRITO (gate adversarial da IB-3, LOW): o código do grupo é CONFERIDO, nunca normalizado — `digits()` descartava o que não é
 *  dígito ("000-001" saía 000001). A fonte de fatos já recusa com 422; aqui é erro de programação de outro chamador. */
function exactDigits(s: string, label: string, len: number): string {
  if (typeof s !== 'string' || !new RegExp(`^\\d{${len}}$`).test(s)) throw new Error(`${label} fora da forma (exatamente ${len} dígitos)`)
  return s
}

function ibscbsXml(g: DpsIbscbs): string {
  const cClassTrib = exactDigits(g.cClassTrib, 'cClassTrib', 6)
  return grp('IBSCBS',
    el('finNFSe', '0') +
    el('cIndOp', exactDigits(g.cIndOp, 'cIndOp', 6)) +
    el('indDest', '0') +
    grp('valores', grp('trib', grp('gIBSCBS', el('CST', cClassTrib.slice(0, 3)) + el('cClassTrib', cClassTrib)))))
}

/**
 * XML do DPS pronto para assinar: `<DPS xmlns versao="1.01"><infDPS Id="…">…</infDPS></DPS>`,
 * com a declaração `<?xml …?>` (Manual 2022 §6.1 a). Sem Signature — quem assina é `signXml`.
 */
export function buildDpsXml(input: DpsInput, id: string): string {
  if (!/^DPS\d{42}$/.test(id)) throw new Error(`Id do DPS inválido: ${id}`)
  if (input.tpEmit !== '1') throw new Error('tpEmit: só o prestador emite nesta onda (E9996)')
  const serie = Number(input.serie), nDps = Number(input.nDps)
  if (!Number.isInteger(serie) || serie < 1 || !Number.isInteger(nDps) || nDps < 1) throw new Error('serie/nDPS inválidos')
  // E0322: o grupo IBS/CBS EXIGE a NBS — a fonte de fatos confere antes (422); aqui é cinto (erro de programação)
  if (input.ibscbs && !input.serv.cServ.cNBS) throw new Error('Grupo IBS/CBS sem cNBS (E0322) — a fonte de fatos deveria ter recusado')
  const dhEmi = formatDateTimeTz(input.dhEmi)
  const inf =
    el('tpAmb', tpAmbOf(input.environment)) +
    el('dhEmi', dhEmi) +
    el('verAplic', cut(text(input.verAplic), 20)) +
    // [INCERTO] série SEM zero à esquerda no elemento (o Id leva 5 posições); TSSerieDPS aceita ambos
    el('serie', String(serie)) +
    el('nDPS', String(nDps)) +
    el('dCompet', /^\d{4}-\d{2}-\d{2}$/.test(input.dCompet) ? input.dCompet : (() => { throw new Error(`dCompet inválida: ${input.dCompet}`) })()) +
    el('tpEmit', input.tpEmit) +
    el('cLocEmi', digits(input.cLocEmi, 'cLocEmi', 7)) +
    prestXml(input.prest) +
    (input.toma ? tomaXml(input.toma) : '') +
    servXml(input.serv) +
    valoresXml(input.valores) +
    (input.ibscbs ? ibscbsXml(input.ibscbs) : '')
  const versao = layoutAt('DPS', input.environment, new Date(dhEmi))
  return XML_DECLARATION + grp('DPS', grp('infDPS', inf, ` Id="${id}"`), ` xmlns="${NFSE_NS}" versao="${versao}"`)
}

// ---------------------------------------------------------------------------
// Pedido de registro de evento — cancelamento e101101
// ---------------------------------------------------------------------------

/** "PRE" + chave(50) + código do evento(6) = 59 (TSIdPedRegEvt `PRE[0-9]{56}`; Anexo II linha 13). */
export function buildEventId(accessKey: string, eventCode: string): string {
  return `PRE${echoAccessKey(accessKey)}${digits(eventCode, 'código do evento', 6)}`
}

/**
 * D-CJ7: a chave do FISCO vai no pedido de evento COMO VEIO (eco), conferida pela forma geral — `digits()` tirava as letras e o
 * cancelamento de uma NFS-e de emitente com CNPJ alfanumérico ficava impossível.
 */
function echoAccessKey(accessKey: string): string {
  const key = asNfseAccessKey(accessKey)
  if (key === null || key !== accessKey) throw new Error(`chave de acesso inválida (esperado a forma geral de 50 posições): ${accessKey}`)
  return key
}

/**
 * `<pedRegEvento xmlns versao="1.01"><infPedReg Id="PRE…">tpAmb, verAplic, dhEvento,
 * CNPJAutor|CPFAutor, chNFSe, e101101{xDesc fixo, cMotivo, xMotivo}</infPedReg></pedRegEvento>`.
 * O XSD não tem número/sequencial do pedido: o sequencial só existe no Id `EVT…` que o fisco cunha.
 */
export function buildCancelEventXml(input: CancelEventInput): string {
  if (!!input.cnpjAutor === !!input.cpfAutor) throw new Error('Autor do evento exige CNPJ ou CPF (exatamente um)')
  const motive = text(input.xMotivo, false)
  if (motive.length < 15 || motive.length > 255) throw new Error('xMotivo do cancelamento deve ter 15 a 255 caracteres')
  if (!['1', '2', '9'].includes(input.cMotivo)) throw new Error(`cMotivo inválido: ${input.cMotivo}`)
  const chave = echoAccessKey(input.accessKey)
  const dhEvento = formatDateTimeTz(input.dhEvento)
  const inf =
    el('tpAmb', tpAmbOf(input.environment)) +
    el('verAplic', cut(text(input.verAplic), 20)) +
    el('dhEvento', dhEvento) +
    (input.cnpjAutor ? el('CNPJAutor', digits(input.cnpjAutor, 'CNPJ do autor', 14)) : el('CPFAutor', digits(input.cpfAutor!, 'CPF do autor', 11))) +
    el('chNFSe', chave) +
    grp(`e${EVENT_CANCEL}`, el('xDesc', 'Cancelamento de NFS-e') + el('cMotivo', input.cMotivo) + el('xMotivo', motive))
  const versao = layoutAt('EVENT', input.environment, new Date(dhEvento))
  return XML_DECLARATION + grp('pedRegEvento', grp('infPedReg', inf, ` Id="${buildEventId(chave, EVENT_CANCEL)}"`), ` xmlns="${NFSE_NS}" versao="${versao}"`)
}

// ---------------------------------------------------------------------------
// Leitura dos XML do fisco (sem prefixo de namespace — vedado pelo manual) — por PARSER (N17, D-NE72; parte 2 da NE-1a, passo 7)
// ---------------------------------------------------------------------------

/**
 * Como a NFS-e LÊ (D-NE72): o nome casa QUALIFICADO (o manual veda prefixo) e o valor é só TEXTO SIMPLES — CDATA (nenhum campo da NFS-e o
 * pede — D-NE87), comentário ou filho no campo lido = RECUSA (`XmlUnreadableError` do núcleo), que o adaptador transforma no ambíguo pela
 * causa que já existe (`nfse-ilegivel`/`evento-ilegivel`). A BUSCA é a mesma do leitor por recorte que este substitui (oráculo congelado em
 * `__tests__/legacy-xml-oracle.ts`; paridade provada no corpus real e nas fixtures — `n17-paridade.test.ts`): o 1º elemento com o nome, em
 * ordem de documento. D-NE85: o VALOR vazio é ausente (pula para o próximo); o GRUPO que decide voz (`<e101101>`, `<eNNNNNN>`) vazio é RECUSA.
 */
export const NFSE_XML: XmlReadOptions = Object.freeze({ match: 'qualified' })

/** Texto do 1º elemento `<name>` NÃO vazio do documento, aparado — o leitor ÚNICO do XML do fisco (D-F96). Recusa = exceção. */
export function firstText(xml: string | XmlNode, name: string): string | null {
  return readFirstText(typeof xml === 'string' ? parseXml(xml) : xml, name, NFSE_XML)
}
/** O atributo [attr] do 1º `<element>` que o TEM (a forma da leitura antiga). */
function attrOfFirst(doc: XmlNode, element: string, attr: string): string | null {
  const el = firstElement(doc, element, NFSE_XML, e => readAttr(e, attr) !== null)
  return el ? readAttr(el, attr) : null
}
/** O texto do 1º elemento [name] NÃO vazio numa LISTA de elementos (já em ordem de documento) — o vazio é ausente (D-NE85). */
function firstTextIn(list: readonly XmlNode[], name: string): string | null {
  for (const e of list) {
    if (!nameIs(e, name, NFSE_XML)) continue
    const v = textOf(e)
    if (v !== '') return v
  }
  return null
}
/** D-NE85: o GRUPO que decide voz sem nenhum filho (`<e101101/>`, `<e101101></e101101>` — sem o que o XSD exige) é RECUSA, nunca "cancelado". */
function assertGroupFilled(group: XmlNode): XmlNode {
  if (childElementCount(group) === 0) throw new XmlUnreadableError('grupo-vazio')
  return group
}

/** Bloco de cancelamento (`<e101101>` sem atributo) se existir. */
function cancelBlock(doc: XmlNode): { dhEvento: string | null; cMotivo: string | null; xMotivo: string | null } | null {
  const found = firstElement(doc, 'e101101', NFSE_XML, e => attributeCount(e) === 0)
  if (!found) return null
  const block = assertGroupFilled(found)
  return { dhEvento: readFirstText(doc, 'dhEvento', NFSE_XML), cMotivo: readFirstText(block, 'cMotivo', NFSE_XML), xMotivo: readFirstText(block, 'xMotivo', NFSE_XML) }
}

/**
 * O CABEÇALHO da NFS-e: os elementos depois de `<infNFSe>` e antes do 1º `<emit>` (sem atributo) que vem depois dele — evita pegar dados do
 * DPS embutido. Sem `<infNFSe>` ou sem esse `<emit>`, o documento inteiro (a forma da leitura antiga).
 */
function headerElements(doc: XmlNode): XmlNode[] {
  const all = elementsOf(doc)
  const inf = all.findIndex(e => nameIs(e, 'infNFSe', NFSE_XML))
  if (inf < 0) return all
  const stop = all.findIndex((e, i) => i > inf && nameIs(e, 'emit', NFSE_XML) && attributeCount(e) === 0)
  if (stop < 0) return all
  return all.slice(inf + 1, stop).filter(e => !contains(e, all[stop]))
}

/** A chave da NFS-e DESTE documento (`infNFSe/@Id` sem "NFS") — null sem o atributo. */
export function nfseAccessKeyOf(doc: XmlNode): string | null {
  const rawId = attrOfFirst(doc, 'infNFSe', 'Id')
  return rawId ? rawId.replace(/^NFS/, '') : null
}

/** NFS-e autorizada: chave (infNFSe/@Id sem "NFS"), número, dhProc, cStat, id do DPS embutido. */
export function parseNfseXml(xml: string): ParsedNfse {
  const doc = parseXml(xml)
  const rawId = attrOfFirst(doc, 'infNFSe', 'Id')
  const accessKey = rawId ? rawId.replace(/^NFS/, '') : null
  const header = headerElements(doc)
  return {
    accessKey,
    nNFSe:  firstTextIn(header, 'nNFSe'),
    dhProc: firstTextIn(header, 'dhProc'),
    cStat:  firstTextIn(header, 'cStat'),
    nDFSe:  firstTextIn(header, 'nDFSe'),
    ambGer: firstTextIn(header, 'ambGer'),
    dpsId:  attrOfFirst(doc, 'infDPS', 'Id'),
    cancelled: cancelBlock(doc),
  }
}

/** Filho DIRETO de [parent] com o nome (a busca por caminho — nunca "o 1º elemento com o nome no documento"). */
export function childOf(parent: XmlNode, name: string): XmlNode | null {
  return firstElement(parent, name, NFSE_XML, e => e.parentNode === parent)
}
export function pathOf(root: XmlNode, ...names: string[]): XmlNode | null {
  let cur: XmlNode | null = root
  for (const n of names) { if (!cur) return null; cur = childOf(cur, n) }
  return cur
}
/** TSDec15V2 do XSD (`0|0\.[0-9]{2}|[1-9]{1}[0-9]{0,14}(\.[0-9]{2})?`) — texto, nunca número do JS. */
const TS_DEC15V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]{0,14}(\.[0-9]{2})?)$/

/**
 * Os valores IBS/CBS que o FISCO calculou (IB-3 — D-IB77/D-IB80), lidos por CAMINHO: só o `IBSCBS` filho DIRETO de `infNFSe` (o grupo do
 * fisco, `TCRTCIBSCBS`) — a NFS-e autorizada também traz o NOSSO grupo declarado dentro do DPS embutido (`infNFSe/DPS/infDPS/IBSCBS`), e
 * "o 1º IBSCBS do documento" leria a nossa declaração como voz do fisco quando o dele faltasse. Tudo ou nada: valor obrigatório
 * ausente ou fora do TSDec15V2 = 'unreadable'. Pura (sem banco) — roda FORA da transação. Documento ilegível = a exceção do leitor.
 */
export function parseNfseIbscbs(xml: string | XmlNode): ParsedNfseIbscbs {
  const doc = typeof xml === 'string' ? parseXml(xml) : xml
  const inf = firstElement(doc, 'infNFSe', NFSE_XML)
  if (!inf) return { declaredInDps: false, values: null }
  const declaredInDps = pathOf(inf, 'DPS', 'infDPS', 'IBSCBS') !== null
  const group = childOf(inf, 'IBSCBS')
  if (!group) return { declaredInDps, values: null }
  const read = (...path: string[]): string | null => {
    const e = pathOf(group, ...path)
    const v = e ? textOf(e) : ''
    return TS_DEC15V2.test(v) ? v : null
  }
  const totalInvoiceValue = read('totCIBS', 'vTotNF')
  const ibsTotalValue = read('totCIBS', 'gIBS', 'vIBSTot')
  const cbsValue = read('totCIBS', 'gCBS', 'vCBS')
  const values: NfseIbscbsValues | 'unreadable' = totalInvoiceValue !== null && ibsTotalValue !== null && cbsValue !== null
    ? { totalInvoiceValue, ibsTotalValue, cbsValue } : 'unreadable'
  return { declaredInDps, values }
}

/**
 * A declaração IBS/CBS que FOI ENVIADA (IB-3 — tela "No fisco" e DANFSe): lida por CAMINHO do DPS embutido na NFS-e autorizada
 * (`infNFSe/DPS/infDPS/IBSCBS` + `serv/cServ/cNBS`). null = o DPS não levou o grupo; texto fora da forma = null (só exibição).
 */
export function parseNfseDeclaration(xml: string | XmlNode): NfseDeclaredIbscbs | null {
  const doc = typeof xml === 'string' ? parseXml(xml) : xml
  const inf = firstElement(doc, 'infNFSe', NFSE_XML)
  const infDps = inf ? pathOf(inf, 'DPS', 'infDPS') : null
  const group = infDps ? childOf(infDps, 'IBSCBS') : null
  if (!group) return null
  const txt = (...p: string[]) => { const e = pathOf(group, ...p); return e ? textOf(e) : '' }
  const cst = txt('valores', 'trib', 'gIBSCBS', 'CST')
  const classificationCode = txt('valores', 'trib', 'gIBSCBS', 'cClassTrib')
  const placeIndicatorCode = txt('cIndOp')
  if (!/^\d{3}$/.test(cst) || !/^\d{6}$/.test(classificationCode) || !/^\d{6}$/.test(placeIndicatorCode)) return null
  const nbsEl = pathOf(infDps!, 'serv', 'cServ', 'cNBS')
  const nbs = nbsEl ? textOf(nbsEl) : ''
  return { cst, classificationCode, placeIndicatorCode, nbs: /^\d{9}$/.test(nbs) ? nbs : null }
}

/**
 * A NFS-e autorizada LEVOU o grupo IBS/CBS no DPS embutido? (D-IB90 — gates da IB-3: "congelada ≠ enviada") true = levou (mesmo que a
 * forma não seja legível) · false = o DPS autorizado NÃO tem o grupo · null = o documento nem é uma NFS-e (`infNFSe` ausente).
 */
export function nfseDpsHasIbscbs(xml: string | XmlNode): boolean | null {
  const doc = typeof xml === 'string' ? parseXml(xml) : xml
  const inf = firstElement(doc, 'infNFSe', NFSE_XML)
  if (!inf) return null
  return pathOf(inf, 'DPS', 'infDPS', 'IBSCBS') !== null
}

/** Evento (gerado pelo fisco) ou pedido de registro: ids, código, chave, datas e motivo. */
export function parseEventXml(xml: string): ParsedEvent {
  return parseEventDoc(parseXml(xml))
}
/** O mesmo, sobre o documento JÁ lido (gate do delta N17-08: a assinatura do evento lê o MESMO documento — um parse só por evento). */
export function parseEventDoc(doc: XmlNode): ParsedEvent {
  // o grupo do TIPO do evento: o 1º `<eNNNNNN>` (6 dígitos, sem atributo) — vazio = recusa (D-NE85)
  const found = elementsOf(doc).find(e => /^e\d{6}$/.test(e.nodeName) && attributeCount(e) === 0) ?? null
  const specific = found ? assertGroupFilled(found) : null
  const cancel = cancelBlock(doc)
  return {
    eventId:    attrOfFirst(doc, 'infEvento', 'Id'),
    pedRegId:   attrOfFirst(doc, 'infPedReg', 'Id'),
    eventCode:  specific ? specific.nodeName.slice(1) : null,
    accessKey:  readFirstText(doc, 'chNFSe', NFSE_XML),
    dhEvento:   readFirstText(doc, 'dhEvento', NFSE_XML),
    dhProc:     readFirstText(doc, 'dhProc', NFSE_XML),
    nSeqEvento: readFirstText(doc, 'nSeqEvento', NFSE_XML),
    cMotivo:    cancel?.cMotivo ?? (specific ? readFirstText(specific, 'cMotivo', NFSE_XML) : null),
    xMotivo:    cancel?.xMotivo ?? (specific ? readFirstText(specific, 'xMotivo', NFSE_XML) : null),
    // D-F76 (= Q-F83): chave da NFS-e SUBSTITUTA (e105102 — TE105102.chSubstituta); só exibição, nunca regra
    substituteKey: specific ? readFirstText(specific, 'chSubstituta', NFSE_XML) : null,
  }
}
