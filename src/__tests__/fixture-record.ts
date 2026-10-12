/**
 * Fixture de tentativa da NFS-e com o FATO do registro (NE-1a, D-NE56 — gates da parte 1, M2): as linhas de PRODUÇÃO trazem
 * `authorityRecorded` (o `mapTx` exige; os predicados do núcleo falham alto sem ele — D-NE66). Na NFS-e registro ⇔ chave (definição da
 * view 004): a fixture o deriva da chave; o teste que quer uma linha INCOERENTE passa `authorityRecorded` explícito.
 */
export function withRecord<T extends { accessKey?: string | null; authorityRecorded?: boolean }>(row: T): T & { authorityRecorded: boolean } {
  return { ...row, authorityRecorded: row.authorityRecorded ?? (row.accessKey != null) }
}
