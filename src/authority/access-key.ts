import { FederalId, federalIdOf } from 'fiscal-api'

/**
 * CHAVE DE ACESSO da NFS-e e Id do DPS — a identidade de um DOCUMENTO (frente do CNPJ alfanumérico, D-CJ7 = Q-CJ7 (a), Valdo 2026-10-15;
 * parecer do guardião §4.2/§4.5 do `prompt_frente_cnpj_alfanumerico.md`). É OUTRA peça que a inscrição federal (`fiscal-api` — `FederalId`):
 * a chave EMBUTE a inscrição do emitente em posições fixas.
 *
 *   chave (50)  = cMun(7) + ambGer(1) + tpInsc(1: 1 CPF · 2 CNPJ) + inscrição(14) + nNFSe(13) + AAMM(4) + código(9) + DV(1)
 *   Id do DPS   = "DPS" + cMun(7) + tpInsc(1) + inscrição(14, CPF com zeros à esquerda) + série(5) + nDPS(15)  (45)
 *
 * (FAQ nacional 18.4 e os XSD 1.01 de produção restrita — `Infra-IA/setes-api/integracoes/cnpj-alfanumerico/`; conferido nas chaves reais
 * de produção 704–707.) A inscrição segue a forma GERAL da RFB: CNPJ `[0-9A-Z]{12}[0-9]{2}`; CPF = 14 dígitos.
 *
 * REGRA DA LEITURA (a voz é do TERCEIRO): a chave entra pela forma geral e volta como veio — sem tirar caractere, sem DV presumido, em
 * qualquer ambiente/versão. Ler mais estrito que o fisco faria de uma NFS-e AUTORIZADA um 502 ambíguo (D12 do inventário — a nota ficaria
 * autorizada no fisco sem a voz A). Conhecimento NEGATIVO:
 *   - o DV da chave da NFS-e é do FISCO (o Anexo VI só fala em "representação numérica dos caracteres") — nunca se calcula nem se confere;
 *   - nunca copiar o `TSChaveNFSe` do XSD de produção restrita (`[0-9]{6}([0-9A-Z]{14})[0-9]{30}`): é o recorte da chave de 44 da NF-e
 *     (posições 7–20) colado na de 50 — a inscrição da NFS-e mora nas posições 10–23;
 *   - nunca `replace(/\D/g, '')` numa chave: o CNPJ alfanumérico embutido vira OUTRA chave (ou nenhuma).
 */

/**
 * Forma geral da chave de acesso da NFS-e (50): letra SÓ nas 12 primeiras posições da inscrição (posições 10–21); o resto, dígito. Não
 * presume o domínio do tpInsc nem a forma por tipo — a coerência com o que perguntamos (`sameEmbeddedIssuer`) é que decide de quem é.
 */
export const NFSE_ACCESS_KEY_FORM = /^[0-9]{9}[0-9A-Z]{12}[0-9]{29}$/
/** Forma geral do Id do DPS (45): "DPS" + cMun(7) + tpInsc(1) + inscrição (letra só nas 12 primeiras) + série(5) + nDPS(15). */
export const DPS_ID_FORM = /^DPS[0-9]{8}[0-9A-Z]{12}[0-9]{22}$/

/** Mesma forma, para procurar a chave dentro de um texto (corpo que não é o JSON do contrato) — limites de "palavra" ASCII. */
const ACCESS_KEY_IN_TEXT = /(?<![0-9A-Za-z])[0-9]{9}[0-9A-Z]{12}[0-9]{29}(?![0-9A-Za-z])/

/** O emitente embutido numa chave ou num Id: o tipo de inscrição + as 14 posições, como vieram. */
export interface EmbeddedIssuer {
  /** 1 CPF · 2 CNPJ (como veio — a forma geral não presume o domínio). */
  readonly tpInsc:    string
  readonly inscricao: string
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : null)

/**
 * A chave de acesso como VEIO (só sem espaço nas pontas) quando tem a forma geral; senão null. Número em JSON nunca é chave (50 dígitos
 * não cabem num double — o JSON.parse já teria arredondado: aceitar seria aceitar OUTRA chave).
 */
export function asNfseAccessKey(v: unknown): string | null {
  const s = str(v)
  return s !== null && NFSE_ACCESS_KEY_FORM.test(s) ? s : null
}

/** Id do DPS como veio quando tem a forma geral; senão null. */
export function asDpsId(v: unknown): string | null {
  const s = str(v)
  return s !== null && DPS_ID_FORM.test(s) ? s : null
}

/** Primeira chave de acesso (forma geral) dentro de um texto qualquer; null se nenhuma. */
export function findNfseAccessKeyIn(text: string): string | null {
  return ACCESS_KEY_IN_TEXT.exec(String(text ?? ''))?.[0] ?? null
}

/** Emitente embutido na chave (posições 9–23); null se a chave não tem a forma geral. */
export function issuerOfAccessKey(key: string): EmbeddedIssuer | null {
  if (!NFSE_ACCESS_KEY_FORM.test(key)) return null
  return { tpInsc: key[8], inscricao: key.slice(9, 23) }
}

/** Emitente embutido no Id do DPS (posições 11–25); null se o Id não tem a forma geral. */
export function issuerOfDpsId(id: string): EmbeddedIssuer | null {
  if (!DPS_ID_FORM.test(id)) return null
  return { tpInsc: id[10], inscricao: id.slice(11, 25) }
}

/** Mesmo emitente = mesmo tipo de inscrição e as mesmas 14 posições, comparadas EXATAMENTE (nada normalizado). */
export function sameEmbeddedIssuer(a: EmbeddedIssuer | null, b: EmbeddedIssuer | null): boolean {
  return !!a && !!b && a.tpInsc === b.tpInsc && a.inscricao === b.inscricao
}

/** A inscrição embutida como `FederalId` (o tipo vem do tpInsc — o LUGAR); CPF = as 11 últimas das 14. null se não fecha a forma + DV. */
export function embeddedFederalId(i: EmbeddedIssuer): FederalId | null {
  if (i.tpInsc === '2') return federalIdOf('cnpj', i.inscricao)
  if (i.tpInsc === '1') return /^000[0-9]{11}$/.test(i.inscricao) ? federalIdOf('cpf', i.inscricao.slice(3)) : null
  return null
}
