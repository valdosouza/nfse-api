/// <reference types="jest" />
/**
 * ORÁCULO do N17 (parte 2 da NE-1a, passo 7 — D-NE72): o leitor de XML por REGEX COMO ESTAVA PUBLICADO (nfse-api 38980bb, núcleo
 * 27d2aa6 — o `verifyXml` do núcleo tem o oráculo dele em `fiscal-api/src/__tests__/n17-xmldsig.test.ts`), extraído LITERALMENTE do git pelo roteiro do passo 7 — NUNCA editar à mão: é a referência da paridade (`n17-paridade.test.ts`).
 * Fica até a F2a (quando a cópia do setes-api, que segue com regex, morrer).
 */
import type { ParsedNfse, ParsedEvent } from '../authority/types'
import type { DanfseFields } from '../nfse/danfse'

export function legacy_unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'
    if (e === 'quot') return '"'; if (e === 'apos') return "'"
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  })
}

/** Texto do 1º elemento `<name>` (com ou sem atributos), aparado e des-escapado — o leitor ÚNICO do XML do fisco (D-F96). */
export function legacy_firstText(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? legacy_unescapeXml(m[1].trim()) : null
}
function legacy_attrOf(xml: string, element: string, attr: string): string | null {
  const m = xml.match(new RegExp(`<${element}\\b[^>]*\\s${attr}="([^"]*)"`))
  return m ? m[1] : null
}

/** Bloco de cancelamento (e101101) se existir no texto. */
function legacy_cancelBlock(xml: string): { dhEvento: string | null; cMotivo: string | null; xMotivo: string | null } | null {
  const m = xml.match(/<e101101>[\s\S]*?<\/e101101>/)
  if (!m) return null
  return { dhEvento: legacy_firstText(xml, 'dhEvento'), cMotivo: legacy_firstText(m[0], 'cMotivo'), xMotivo: legacy_firstText(m[0], 'xMotivo') }
}

/** NFS-e autorizada: chave (infNFSe/@Id sem "NFS"), número, dhProc, cStat, id do DPS embutido. */
export function legacy_parseNfseXml(xml: string): ParsedNfse {
  const rawId = legacy_attrOf(xml, 'infNFSe', 'Id')
  const accessKey = rawId ? rawId.replace(/^NFS/, '') : null
  const infNfse = xml.match(/<infNFSe\b[\s\S]*?<emit>/)?.[0] ?? xml     // cabeçalho antes do emit (evita pegar dados do DPS embutido)
  return {
    accessKey,
    nNFSe:  legacy_firstText(infNfse, 'nNFSe'),
    dhProc: legacy_firstText(infNfse, 'dhProc'),
    cStat:  legacy_firstText(infNfse, 'cStat'),
    nDFSe:  legacy_firstText(infNfse, 'nDFSe'),
    ambGer: legacy_firstText(infNfse, 'ambGer'),
    dpsId:  legacy_attrOf(xml, 'infDPS', 'Id'),
    cancelled: legacy_cancelBlock(xml),
  }
}

/** Evento (gerado pelo fisco) ou pedido de registro: ids, código, chave, datas e motivo. */

export function legacy_parseEventXml(xml: string): ParsedEvent {
  const codeMatch = xml.match(/<e(\d{6})>/)
  const cancel = legacy_cancelBlock(xml)
  const specific = codeMatch ? xml.match(new RegExp(`<e${codeMatch[1]}>[\\s\\S]*?</e${codeMatch[1]}>`))?.[0] ?? '' : ''
  return {
    eventId:    legacy_attrOf(xml, 'infEvento', 'Id'),
    pedRegId:   legacy_attrOf(xml, 'infPedReg', 'Id'),
    eventCode:  codeMatch ? codeMatch[1] : null,
    accessKey:  legacy_firstText(xml, 'chNFSe'),
    dhEvento:   legacy_firstText(xml, 'dhEvento'),
    dhProc:     legacy_firstText(xml, 'dhProc'),
    nSeqEvento: legacy_firstText(xml, 'nSeqEvento'),
    cMotivo:    cancel?.cMotivo ?? (specific ? legacy_firstText(specific, 'cMotivo') : null),
    xMotivo:    cancel?.xMotivo ?? (specific ? legacy_firstText(specific, 'xMotivo') : null),
    // D-F76 (= Q-F83): chave da NFS-e SUBSTITUTA (e105102 — TE105102.chSubstituta); só exibição, nunca regra
    substituteKey: specific ? legacy_firstText(specific, 'chSubstituta') : null,
  }
}

function legacy_group(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? m[1] : ''
}

function legacy_text(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? legacy_unescapeXml(m[1].trim()) : null
}

export function legacy_extractDanfseFields(nfseXml: string): DanfseFields {
  const parsed = legacy_parseNfseXml(nfseXml)
  const inf = legacy_group(nfseXml, 'infNFSe')
  const emit = legacy_group(inf, 'emit')                          // emitente na NFS-e (dados cadastrais do fisco)
  const dps = legacy_group(nfseXml, 'infDPS')
  const prest = legacy_group(dps, 'prest')
  const toma = legacy_group(dps, 'toma')
  const serv = legacy_group(dps, 'serv')
  const val = legacy_group(dps, 'valores')
  const valNfse = legacy_group(inf, 'valores')                    // valores calculados pelo fisco (vLiq, vISSQN…)
  const end = legacy_group(toma, 'end')
  const addrParts = [legacy_text(end, 'xLgr'), legacy_text(end, 'nro'), legacy_text(end, 'xCpl'), legacy_text(end, 'xBairro'), legacy_text(end, 'cMun'), legacy_text(end, 'CEP')].filter(Boolean)
  return {
    accessKey: parsed.accessKey ?? '',
    nNFSe: parsed.nNFSe, dhProc: parsed.dhProc,
    nDps: legacy_text(dps, 'nDPS'), serie: legacy_text(dps, 'serie'), dCompet: legacy_text(dps, 'dCompet'),
    prest: { cnpj: legacy_text(prest, 'CNPJ') ?? legacy_text(emit, 'CNPJ'), im: legacy_text(prest, 'IM') ?? legacy_text(emit, 'IM'), xNome: legacy_text(emit, 'xNome') },
    toma: { doc: legacy_text(toma, 'CNPJ') ?? legacy_text(toma, 'CPF'), xNome: legacy_text(toma, 'xNome'), address: addrParts.length ? addrParts.join(', ') : null },
    serv: { cTribNac: legacy_text(serv, 'cTribNac'), cLocPrestacao: legacy_text(serv, 'cLocPrestacao'), xDescServ: legacy_text(serv, 'xDescServ') },
    valores: {
      vServ: legacy_text(val, 'vServ'), pAliq: legacy_text(val, 'pAliq') ?? legacy_text(valNfse, 'pAliqAplic'),
      vISSQN: legacy_text(valNfse, 'vISSQN') ?? legacy_text(val, 'vISSQN'), tpRetISSQN: legacy_text(val, 'tpRetISSQN'),
      vLiq: legacy_text(valNfse, 'vLiq'),
    },
    cancelled: !!parsed.cancelled,
  }
}

export function legacy_sentDpsIdOf(signedDpsXml: string): string | null {
  return signedDpsXml.match(/<infDPS\b[^>]*\sId="([^"]*)"/)?.[1] ?? null
}

export const legacy_eventSignature = (e: ReturnType<typeof legacy_parseEventXml>, xml: string): string =>
  JSON.stringify([e.eventCode, e.eventId, e.dhProc, e.dhEvento, e.nSeqEvento, e.cMotivo, e.xMotivo, e.substituteKey ?? null,
    legacy_firstText(xml, 'nDFSe'), legacy_firstText(xml, 'CNPJAutor') ?? legacy_firstText(xml, 'CPFAutor'), legacy_firstText(xml, 'ambGer'), legacy_firstText(xml, 'tpAmb')])
