/**
 * DEPLOY.E3.P1 (D-F255) — o DDL do schema-molde (lido da 3306 por `mysqldump --no-data`) vira o DDL de um schema SINTÉTICO da 3307.
 * Módulo PURO (sem efeito ao importar). Troca só o nome ENTRE CRASES (o nome qualificado que o dump escreve nas views) e o `DEFINER`
 * (o usuário da 3306 não existe na instância descartável) — texto fora de crase não muda.
 */

const SCHEMA_NAME = /^setes_[a-z0-9_]+$/

export function reescreverSchema(ddl: string, molde: string, novo: string): string {
  if (!SCHEMA_NAME.test(molde) || !SCHEMA_NAME.test(novo)) throw new Error(`schema inválido: ${molde} → ${novo}`)
  return ddl
    .split(`\`${molde}\``).join(`\`${novo}\``)
    .replace(/DEFINER=`[^`]*`@`[^`]*`/g, 'DEFINER=CURRENT_USER')
}

/** Os comandos `CREATE TABLE`/`CREATE VIEW` de um dump, sem comentários de versão nem `USE`/`CREATE DATABASE`. */
export function comandosDoDump(dump: string): string[] {
  return dump
    .replace(/\/\*![0-9]+\s*([\s\S]*?)\*\//g, '$1')        // comentários condicionais do mysqldump: o conteúdo vale
    .replace(/^--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map(c => c.trim())
    .filter(c => /^(CREATE\s+(TABLE|(ALGORITHM\S*\s+)?(DEFINER\S*\s+)?(SQL\s+SECURITY\s+\w+\s+)?VIEW)|DROP\s+(TABLE|VIEW))/i.test(c))
}

/**
 * As linhas copiadas por `SELECT *` sem as colunas GERADAS do destino — o MariaDB recusa valor explícito nelas (1906 em modo estrito).
 * Ex.: `setes_central.tb_interface.i18n_key_live` (STORED GENERATED, sql/77 do setes-api, PRIV.E7.P1 — aviso de 2026-11-20).
 */
export function semColunas<T extends Record<string, unknown>>(linhas: readonly T[], excluir: ReadonlySet<string>): Record<string, unknown>[] {
  if (!excluir.size) return [...linhas]
  return linhas.map(l => Object.fromEntries(Object.entries(l).filter(([k]) => !excluir.has(k))))
}
