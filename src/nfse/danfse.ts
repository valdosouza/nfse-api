import PDFDocument from 'pdfkit'
import { parseXml, firstElement, firstText, textOf, XmlNode, XmlUnreadableError, HttpError, ErrorCodes, FederalIdKind, federalIdOf, formatFederalId } from 'fiscal-api'
import { parseNfseXml, parseNfseDeclaration, childOf, pathOf, NFSE_XML } from '../authority/dps-builder'

/**
 * PEÇA @shared/danfse — Documento Auxiliar da NFS-e renderizado POR NÓS a partir
 * do XML autorizado (D-N13; a API de DANFSe do fisco está suspensa — NT 008).
 * Motor de PDF escolhido UMA vez (pdfkit): o futuro `@shared/danfe` usa o mesmo
 * (D-E13/D-E25). Não conhece nota nem banco: recebe o XML e devolve um Buffer.
 *
 * Leitura dos campos: `parseNfseXml` (cabeçalho) + os grupos do DPS embutido (emit/prest, toma, serv, valores), pelo LEITOR do
 * núcleo (parser — N17, D-NE72; a mesma busca do recorte antigo: o 1º elemento do grupo, depois o 1º campo dentro dele).
 *
 * [INCERTO: QR Code exige lib] — o projeto não tem gerador de QR e a regra é
 * "sem lib nova": a URL de consulta pública vai em TEXTO legível; quando uma
 * lib for aprovada, troca-se só `drawConsultBox`.
 */

export interface DanfseOptions {
  issuerName:   string
  municipality: string
  /** Estado VIGENTE do fisco (voz C da transmissão que detém a chave) — carimba "NFS-e CANCELADA". */
  cancelled?:   boolean
}

export const NFSE_PUBLIC_QUERY_URL = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave='

/** O 1º elemento [name] dentro de [scope] (sem o grupo, nada a ler). */
const group = (scope: XmlNode | null, name: string): XmlNode | null => (scope ? firstElement(scope, name, NFSE_XML) : null)
/** O texto do 1º campo [name] dentro do grupo (recusa se não é texto simples — D-NE72). */
const text = (scope: XmlNode | null, name: string): string | null => (scope ? firstText(scope, name, NFSE_XML) : null)
/**
 * D-CJ7 (S7 do inventário): a inscrição formatada pela peça (`fiscal-api` — `FederalId`) com o tipo que o LUGAR diz (o elemento `<CNPJ>` ou
 * `<CPF>` do XML) — antes era pelo comprimento depois de tirar o que não é dígito (um CNPJ alfanumérico com 3 letras saía com máscara de CPF).
 * Valor que não fecha forma + DV sai como veio (exibir nunca esconde o dado).
 */
const fmtDoc = (v: string | null, kind: FederalIdKind | null): string => {
  if (!v) return '—'
  const id = kind ? federalIdOf(kind, v) : null
  return id ? formatFederalId(id) : v
}
/** O tipo da inscrição do tomador = o ELEMENTO que a carrega no DPS embutido (fora do `DanfseFields` — paridade do N17 com o oráculo). */
function tomaDocKindOf(nfseXml: string): FederalIdKind | null {
  try {
    const toma = group(group(parseXml(nfseXml), 'infDPS'), 'toma')
    return text(toma, 'CNPJ') ? 'cnpj' : text(toma, 'CPF') ? 'cpf' : null
  } catch { return null }
}
/**
 * D-CJ25 (= Q-CJ25 (a), frente do CNPJ alfanumérico — 2026-10-16): o "Município gerador" é do DOCUMENTO — `infNFSe/xLocEmi` (obrigatório no
 * XSD 1.01: "descrição do código do IBGE do município emissor da NFS-e"), nunca o endereço de HOJE do cadastro (que pode ter mudado depois da
 * emissão). Fora do `DanfseFields` (paridade do N17 com o oráculo); XML sem o campo legível = o recurso que quem chama passa.
 */
function emitterMunicipalityOf(nfseXml: string): string | null {
  try {
    return text(group(parseXml(nfseXml), 'infNFSe'), 'xLocEmi')
  } catch { return null }
}
const fmtMoney = (v: string | null): string => {
  const n = Number(v ?? '')
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const fmtKey = (k: string): string => k.replace(/([0-9A-Z]{4})(?=[0-9A-Z])/g, '$1 ')   // D-CJ7: grupos de 4 também com letra

/**
 * IB-3 (gates socrático L2 + adversarial): valor do FISCO no bloco IBS/CBS como TEXTO exato — nunca `Number` (TSDec15V2 tem até 15 inteiros:
 * acima de ~1e13 o ponto flutuante perde centavos) e nunca "0,00" onde o fisco não mandou o valor (ausente/fora da forma = "—").
 */
const DEC_TEXT = /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/
export const fmtDecText = (v: string | null): string => {
  if (v === null || !DEC_TEXT.test(v)) return '—'
  const [i, f = ''] = v.split('.')
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${(f + '00').slice(0, 2)}`
}
/** Soma EXATA de dois valores do fisco em centavos (BigInt); qualquer parte ausente/fora da forma = null. */
export const addDecText = (a: string | null, b: string | null): string | null => {
  if (a === null || b === null || !DEC_TEXT.test(a) || !DEC_TEXT.test(b)) return null
  const cents = (x: string) => { const [i, f = ''] = x.split('.'); return BigInt(i) * BigInt(100) + BigInt((f + '00').slice(0, 2)) }
  const t = cents(a) + cents(b)
  return `${t / BigInt(100)}.${String(t % BigInt(100)).padStart(2, '0')}`
}

export interface DanfseFields {
  accessKey:   string
  nNFSe:       string | null
  dhProc:      string | null
  nDps:        string | null
  serie:       string | null
  dCompet:     string | null
  prest:       { cnpj: string | null; im: string | null; xNome: string | null }
  toma:        { doc: string | null; xNome: string | null; address: string | null }
  serv:        { cTribNac: string | null; cLocPrestacao: string | null; xDescServ: string | null }
  valores:     { vServ: string | null; pAliq: string | null; vISSQN: string | null; tpRetISSQN: string | null; vLiq: string | null }
  /** IB-3 (NT 008 — D-IB76/D-IB77): o bloco IBS/CBS — declaração ENVIADA (DPS embutido) + valores do FISCO (`infNFSe/IBSCBS`), POR CAMINHO
   *  (dois IBSCBS no XML — T2). AUSENTE = nem a declaração nem o grupo do fisco (o oráculo do N17 não tem o campo — paridade).
   *  D-IB86 (= Q-IB86 (a), gates da IB-3): o bloco aparece com a declaração OU com o grupo do fisco — o que faltar sai "não informado"
   *  (o documento legal nunca omite o que a tela "No fisco" mostra). `fiscal` null = o fisco não devolveu o grupo dele; `cst` null = sem a
   *  declaração legível no DPS embutido. */
  ibscbs?:     {
    cst: string | null; cClassTrib: string | null; cIndOp: string | null; nbs: string | null
    fiscal: {
      localidade: string | null; vBC: string | null
      pIBSUF: string | null; pAliqEfetUF: string | null; pIBSMun: string | null; pAliqEfetMun: string | null
      pCBS: string | null; pAliqEfetCBS: string | null
      vIBSUF: string | null; vIBSMun: string | null; vIBSTot: string | null; vCBS: string | null; vTotNF: string | null
    } | null
  }
  cancelled:   boolean
}

/**
 * Campos do DANFSe lidos do XML da NFS-e (público — a peça é pura para os testes). D-NE89 (gates do delta do N17 — Valdo 2026-10-12): o
 * DANFSe lê campos que o transmitir e a consulta não leem (nomes, endereço, descrição); se o leitor recusar um deles, a recusa sai com
 * CÓDIGO PRÓPRIO do catálogo (`FISCAL_DANFSE_XML_UNREADABLE`) — nunca 500; o XML da NFS-e segue disponível pela rota dele.
 */
export function extractDanfseFields(nfseXml: string): DanfseFields {
  try {
    return readDanfseFields(nfseXml)
  } catch (err) {
    if (err instanceof XmlUnreadableError) {
      throw new HttpError(422, 'O XML da NFS-e não pôde ser lido para o DANFSe — o XML segue disponível para download', undefined, ErrorCodes.FISCAL_DANFSE_XML_UNREADABLE)
    }
    throw err
  }
}
function readDanfseFields(nfseXml: string): DanfseFields {
  const parsed = parseNfseXml(nfseXml)
  const doc = parseXml(nfseXml)
  const inf = group(doc, 'infNFSe')
  const emit = group(inf, 'emit')                          // emitente na NFS-e (dados cadastrais do fisco)
  const dps = group(doc, 'infDPS')
  const prest = group(dps, 'prest')
  const toma = group(dps, 'toma')
  const serv = group(dps, 'serv')
  const val = group(dps, 'valores')
  const valNfse = group(inf, 'valores')                    // valores calculados pelo fisco (vLiq, vISSQN…)
  const end = group(toma, 'end')
  const addrParts = [text(end, 'xLgr'), text(end, 'nro'), text(end, 'xCpl'), text(end, 'xBairro'), text(end, 'cMun'), text(end, 'CEP')].filter(Boolean)
  return {
    accessKey: parsed.accessKey ?? '',
    nNFSe: parsed.nNFSe, dhProc: parsed.dhProc,
    nDps: text(dps, 'nDPS'), serie: text(dps, 'serie'), dCompet: text(dps, 'dCompet'),
    prest: { cnpj: text(prest, 'CNPJ') ?? text(emit, 'CNPJ'), im: text(prest, 'IM') ?? text(emit, 'IM'), xNome: text(emit, 'xNome') },
    toma: { doc: text(toma, 'CNPJ') ?? text(toma, 'CPF'), xNome: text(toma, 'xNome'), address: addrParts.length ? addrParts.join(', ') : null },
    serv: { cTribNac: text(serv, 'cTribNac'), cLocPrestacao: text(serv, 'cLocPrestacao'), xDescServ: text(serv, 'xDescServ') },
    valores: {
      vServ: text(val, 'vServ'), pAliq: text(val, 'pAliq') ?? text(valNfse, 'pAliqAplic'),
      vISSQN: text(valNfse, 'vISSQN') ?? text(val, 'vISSQN'), tpRetISSQN: text(val, 'tpRetISSQN'),
      vLiq: text(valNfse, 'vLiq'),
    },
    ...ibscbsField(readIbscbsBlock(doc, inf)),
    cancelled: !!parsed.cancelled,
  }
}

const ibscbsField = (b: DanfseFields['ibscbs'] | null) => (b ? { ibscbs: b } : {})

/** NT 008: declaração do DPS embutido + valores do grupo do FISCO (filho DIRETO de `infNFSe`), sempre por caminho. */
function readIbscbsBlock(doc: XmlNode, inf: XmlNode | null): DanfseFields['ibscbs'] | null {
  const declared = parseNfseDeclaration(doc)
  const g = inf ? childOf(inf, 'IBSCBS') : null
  if (!declared && !g) return null                                       // D-IB86: com a declaração OU com o grupo do fisco
  const at = (...p: string[]): string | null => {
    const e = g ? pathOf(g, ...p) : null
    const v = e ? textOf(e) : ''
    return v === '' ? null : v
  }
  const localidade = [at('cLocalidadeIncid'), at('xLocalidadeIncid')].filter(Boolean).join(' — ') || null
  return {
    cst: declared?.cst ?? null, cClassTrib: declared?.classificationCode ?? null, cIndOp: declared?.placeIndicatorCode ?? null,
    nbs: declared?.nbs ?? null,
    fiscal: g ? {
      localidade, vBC: at('valores', 'vBC'),
      pIBSUF: at('valores', 'uf', 'pIBSUF'), pAliqEfetUF: at('valores', 'uf', 'pAliqEfetUF'),
      pIBSMun: at('valores', 'mun', 'pIBSMun'), pAliqEfetMun: at('valores', 'mun', 'pAliqEfetMun'),
      pCBS: at('valores', 'fed', 'pCBS'), pAliqEfetCBS: at('valores', 'fed', 'pAliqEfetCBS'),
      vIBSUF: at('totCIBS', 'gIBS', 'gIBSUFTot', 'vIBSUF'), vIBSMun: at('totCIBS', 'gIBS', 'gIBSMunTot', 'vIBSMun'),
      vIBSTot: at('totCIBS', 'gIBS', 'vIBSTot'), vCBS: at('totCIBS', 'gCBS', 'vCBS'), vTotNF: at('totCIBS', 'vTotNF'),
    } : null,
  }
}

export async function renderDanfse(nfseXml: string, opts: DanfseOptions): Promise<Buffer> {
  const f = extractDanfseFields(nfseXml)
  // Gate adversarial A8 (2026-09-29): o XML em disco é o da AUTORIZAÇÃO — o cancelamento vem da
  // VOZ do fisco (evento da chave), nunca embutido nele. Quem chama informa o estado vigente.
  if (opts.cancelled) f.cancelled = true
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `DANFSe ${f.nNFSe ?? ''}`.trim() } })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const W = doc.page.width - 80
  const label = (t: string, v: string | null | undefined, x?: number) => {
    doc.font('Helvetica-Bold').fontSize(8).text(t, x === undefined ? { continued: true } : { continued: true, indent: 0 })
    doc.font('Helvetica').fontSize(9).text(`  ${v ?? '—'}`)
  }
  const section = (t: string) => {
    doc.moveDown(0.6)
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222').text(t.toUpperCase())
    doc.moveTo(40, doc.y + 1).lineTo(40 + W, doc.y + 1).lineWidth(0.5).strokeColor('#888').stroke()
    doc.moveDown(0.3)
    doc.fillColor('#000')
  }

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(14).text('DANFSe — Documento Auxiliar da NFS-e', { align: 'center' })
  doc.font('Helvetica').fontSize(9).text('Nota Fiscal de Serviço Eletrônica — Sistema Nacional NFS-e', { align: 'center' })
  if (f.cancelled) {
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#b00').text('NFS-e CANCELADA', { align: 'center' }).fillColor('#000')
  }
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(8).text('Chave de acesso')
  doc.font('Courier').fontSize(10).text(fmtKey(f.accessKey))
  doc.moveDown(0.3)
  label('Número da NFS-e:', f.nNFSe)
  label('Emitida em (dhProc):', f.dhProc)
  label('Competência:', f.dCompet)
  label('DPS (série/número):', `${f.serie ?? '—'} / ${f.nDps ?? '—'}`)
  label('Município gerador:', emitterMunicipalityOf(nfseXml) ?? opts.municipality)          // D-CJ25: do documento

  section('Prestador do serviço')
  label('Razão social:', f.prest.xNome ?? opts.issuerName)
  label('CNPJ:', fmtDoc(f.prest.cnpj, 'cnpj'))
  label('Inscrição municipal:', f.prest.im)

  section('Tomador do serviço')
  label('Nome:', f.toma.xNome)
  label('CPF/CNPJ:', fmtDoc(f.toma.doc, tomaDocKindOf(nfseXml)))
  label('Endereço:', f.toma.address)

  section('Serviço prestado')
  label('Código de tributação nacional:', f.serv.cTribNac)
  label('Local da prestação (IBGE):', f.serv.cLocPrestacao)
  doc.font('Helvetica-Bold').fontSize(8).text('Descrição:')
  doc.font('Helvetica').fontSize(9).text(f.serv.xDescServ ?? '—', { width: W })

  section('Valores')
  label('Valor do serviço (R$):', fmtMoney(f.valores.vServ))
  label('Alíquota ISSQN (%):', f.valores.pAliq ? fmtMoney(f.valores.pAliq) : null)
  label('Valor do ISSQN (R$):', fmtMoney(f.valores.vISSQN))
  label('ISSQN retido:', f.valores.tpRetISSQN === '2' ? 'Sim (pelo tomador)' : f.valores.tpRetISSQN === '3' ? 'Sim (pelo intermediário)' : 'Não')
  if (f.valores.vLiq) label('Valor líquido (R$):', fmtMoney(f.valores.vLiq))

  // IB-3 — bloco IBS/CBS (NT 008): declaração enviada + o que o FISCO calculou; total "Valor Líquido + IBS/CBS" (vTotNF)
  if (f.ibscbs) {
    const b = f.ibscbs
    section('IBS / CBS')
    const ni = 'não informado'
    label('CST / Classificação tributária:', b.cst !== null ? `${b.cst} / ${b.cClassTrib}` : ni)
    label('Indicador da operação (cIndOp):', b.cIndOp ?? ni)
    label('NBS:', b.nbs ?? ni)
    if (b.fiscal) {
      const v = b.fiscal
      const pct = (x: string | null) => (x ? fmtMoney(x) : null)
      label('Localidade de incidência:', v.localidade)
      label('Base de cálculo IBS/CBS (R$):', fmtDecText(v.vBC))
      label('Alíquota IBS UF / efetiva (%):', `${pct(v.pIBSUF) ?? '—'} / ${pct(v.pAliqEfetUF) ?? '—'}`)
      label('Alíquota IBS Município / efetiva (%):', `${pct(v.pIBSMun) ?? '—'} / ${pct(v.pAliqEfetMun) ?? '—'}`)
      label('Alíquota CBS / efetiva (%):', `${pct(v.pCBS) ?? '—'} / ${pct(v.pAliqEfetCBS) ?? '—'}`)
      label('IBS UF (R$):', fmtDecText(v.vIBSUF))
      label('IBS Município (R$):', fmtDecText(v.vIBSMun))
      label('Total do IBS (R$):', fmtDecText(v.vIBSTot))
      label('CBS (R$):', fmtDecText(v.vCBS))
      label('Total do IBS/CBS (R$):', fmtDecText(addDecText(v.vIBSTot, v.vCBS)))
      if (v.vTotNF) {
        const y = doc.y
        doc.rect(40, y - 1, W, 14).fillColor('#e6e6e6').fill().fillColor('#000')
        doc.y = y
        label('Valor Líquido + IBS/CBS (R$):', fmtDecText(v.vTotNF))
      }
    } else {
      doc.font('Helvetica').fontSize(8).text('Valores IBS/CBS não devolvidos pelo fisco neste documento.')
    }
  }

  section('Consulta pública')
  doc.font('Helvetica').fontSize(8).text('Confira a autenticidade desta NFS-e em:')
  doc.font('Courier').fontSize(8).text(`${NFSE_PUBLIC_QUERY_URL}${f.accessKey}`, { width: W })

  doc.moveDown(1)
  doc.font('Helvetica').fontSize(7).fillColor('#666')
    .text(`Documento auxiliar gerado por ${opts.issuerName} — a NFS-e válida é o XML autorizado pelo fisco.`, { align: 'center' })
  doc.end()
  return done
}
