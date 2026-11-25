// DEPLOY.E1.P10 (núcleo 5.2.0 — ficha projetos/nfse-api/GERAL/ficha-deploy-e1-p10-adocao-pacote-5-2-0.md no Vault): o arquivo fiscal é de
// GRAVAÇÃO ÚNICA e o núcleo guarda, por série, um índice (`.once/`) dos nomes já gravados. O `warm()` prepara esse índice de toda série que
// já tem arquivos; sem ele a 1ª gravação de cada série grande varre os dias dentro da requisição. A PARTIDA chama esta função depois das
// migrations e antes de ouvir a porta.
//
// NFSE-API#3 (Valdo, 2026-11-25): na nfse-api a falha do preparo SÓ AVISA e o serviço sobe. O `warm()` olha as pastas dos três tipos (NFS-e,
// NF-e, NFC-e) e lança se a raiz não existe ou se qualquer série falha — uma série ilegível da outra família não tira a NFS-e do ar (na
// nfe-api a partida cai). A série que falhou segue sem índice: as gravações NELA voltam a falhar (e aqui falha de gravação só avisa).
import { logger } from 'fiscal-api'
import type { FiscalStorage } from 'fiscal-api'

type WarmLog = Pick<typeof logger, 'info' | 'warn'>

/**
 * Prepara o índice de gravação única. Devolve quantas séries o núcleo viu; `null` quando o armazenamento não tem `warm` (é opcional na
 * interface `FiscalStorage`) ou quando o preparo falhou — a falha vira aviso e NUNCA sobe para quem chama.
 */
export function warmFiscalStorageAtBoot(storage: Pick<FiscalStorage, 'warm'>, log: WarmLog = logger): number | null {
  try {
    const series = storage.warm?.()
    if (series === undefined) return null
    log.info(`Arquivo fiscal: índice de gravação única preparado (${series} série(s))`)
    return series
  } catch (err) {
    // a mensagem do núcleo junta todas as séries que falharam numa linha só: corta para o log não crescer sem limite
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
    log.warn('Arquivo fiscal: índice de gravação única NÃO preparado — o serviço sobe assim mesmo', { err: message })
    return null
  }
}
