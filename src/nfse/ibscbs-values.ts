import { InvoiceTx, logger, parseXml } from 'fiscal-api'
import { parseNfseIbscbs, nfseAccessKeyOf } from '../authority/dps-builder'
import type { ParsedNfseIbscbs } from '../authority/types'
import { fillAuthorityIbscbs } from './repository'

/**
 * Os VALORES IBS/CBS do fisco na NFS-e autorizada (fase IBS/CBS, IB-3 — D-IB77/D-IB80): leitura PURA fora da transação + gravação
 * write-once dentro dela, nos MESMOS pontos de `fillAuthorityData` (transmissão — fonte P — e consulta/rodízio — fonte Q).
 * A voz A NUNCA espera os valores: ausente/ilegível/erro do banco = sem linha + ALARME no log (rótulo fixo + institution/nota/tentativa — nunca
 * conteúdo do XML: D-F100); a consulta seguinte preenche; releitura divergente = fica a 1ª + alarme. Nenhuma causa nova de ambíguo (a lista
 * fechada mora no núcleo — D-F133), nenhuma coluna de motivo.
 * Amarra (gate socrático da IB-3, L3): os valores só pousam se o XML lido É a NFS-e da chave que a voz grava (`infNFSe/@Id`) E a tentativa
 * detém essa chave — XML sem a chave ou de outra NFS-e = `key-mismatch` (alarme, nada gravado).
 */

export type FiscalIbscbsReading =
  | (ParsedNfseIbscbs & { accessKey?: string | null })
  | { declaredInDps: boolean | null; values: 'unreadable' | 'key-mismatch' }

/** Pura — chamar FORA da transação. Documento que o leitor recusa = ilegível (a NFS-e já foi lida pelo adaptador; isto é só o grupo). */
export function readFiscalIbscbs(nfseXml: string, accessKey?: string | null): FiscalIbscbsReading {
  try {
    const doc = parseXml(nfseXml)
    const parsed = parseNfseIbscbs(doc)
    // a chave que a voz grava tem de ser a DESTE documento (o XML sem a chave ou de outra NFS-e nunca pousa valores)
    if (accessKey !== undefined && parsed.values !== null && nfseAccessKeyOf(doc) !== accessKey) {
      return { declaredInDps: parsed.declaredInDps, values: 'key-mismatch' }
    }
    return parsed
  } catch {
    return { declaredInDps: null, values: 'unreadable' }
  }
}

/** Dentro da transação (nota travada): grava ou alarma — a voz A segue. Única exceção que sai daqui: o DEADLOCK (o InnoDB desfez a transação
 *  inteira; o `withTransaction` reexecuta — seguir adiante gravaria a A em AUTOCOMMIT, fora da trava da nota). */
export async function recordIbscbsValues(
  itx: InvoiceTx, attempt: number, reading: FiscalIbscbsReading,
  at: { institutionId: number; invoiceId: number; origin: 'transmissao' | 'consulta'; accessKey: string },
): Promise<void> {
  const ctx = { origin: at.origin, institutionId: at.institutionId, invoiceId: at.invoiceId, attempt }
  if (reading.values === null) {
    // E1515: DPS com o grupo ⇒ a NFS-e TEM de trazer os valores; sem o grupo no DPS (E1517) não há o que gravar
    if (reading.declaredInDps) logger.error('Valores IBS/CBS do fisco AUSENTES na NFS-e autorizada (E1515) — sem linha; a consulta seguinte tenta de novo (D-IB80)', ctx)
    return
  }
  if (reading.values === 'unreadable') {
    logger.error('Valores IBS/CBS do fisco ILEGÍVEIS na NFS-e autorizada — sem linha; a consulta seguinte tenta de novo (D-IB80)', ctx)
    return
  }
  if (reading.values === 'key-mismatch') {
    logger.error('Valores IBS/CBS do fisco NÃO GRAVADOS: o XML não é a NFS-e da chave desta tentativa (D-IB80)', ctx)
    return
  }
  const r = await fillAuthorityIbscbs(itx, attempt, at.accessKey, reading.values)
  if (r.result === 'divergent') logger.error('Valores IBS/CBS do fisco DIVERGENTES da 1ª leitura — fica a 1ª gravada (D-IB80)', ctx)
  else if (r.result === 'no-key') logger.error('Valores IBS/CBS do fisco NÃO GRAVADOS: a tentativa não detém a chave desta NFS-e (D-IB80)', ctx)
  else if (r.result === 'failed') {
    logger.error('Valores IBS/CBS do fisco NÃO GRAVADOS (erro do banco isolado — a voz A segue); a consulta seguinte tenta de novo (D-IB80)', { ...ctx, code: r.code })
  }
}
