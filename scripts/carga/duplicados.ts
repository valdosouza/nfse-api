/**
 * DEPLOY.E3.P1 (§12.8 item 9: "zero documento duplicado") — o DETECTOR. Módulo PURO (sem efeito ao importar).
 * Documento duplicado = mais de uma NFS-e para a MESMA vida da nota (D-N27): (a) no banco, duas chaves de acesso ou duas tentativas com voz
 * A na mesma (instituição, nota, terminal, vida); (b) no fisco falso, dois DPS autorizados para a mesma vida (cruzando o DPS com
 * `tb_invoice_service_dps`), ou um DPS autorizado que o banco não conhece (o fisco emitiu algo que o serviço não registrou).
 */

export interface LinhaTentativa {
  institutionId: number; invoiceId: number; terminal: number; lifeEvent: number; attempt: number
  accessKey: string | null; lastKind: string | null
}
export interface LinhaDps { institutionId: number; invoiceId: number; terminal: number; lifeEvent: number; dpsId: string }
export interface AutorizacaoFisco { institutionId: number; dpsId: string; accessKey: string }

const vida = (r: { institutionId: number; invoiceId: number; terminal: number; lifeEvent: number }) =>
  `${r.institutionId}/${r.invoiceId}/${r.terminal}/${r.lifeEvent}`

export function acharDuplicados(tentativas: readonly LinhaTentativa[], dps: readonly LinhaDps[], fisco: readonly AutorizacaoFisco[]): string[] {
  const achados: string[] = []
  const chaves = new Map<string, Set<string>>()
  const vozA = new Map<string, number>()
  for (const t of tentativas) {
    const v = vida(t)
    if (t.accessKey) chaves.set(v, (chaves.get(v) ?? new Set()).add(t.accessKey))
    if (t.lastKind === 'A') vozA.set(v, (vozA.get(v) ?? 0) + 1)
  }
  for (const [v, ks] of chaves) if (ks.size > 1) achados.push(`banco: vida ${v} com ${ks.size} chaves de acesso`)
  for (const [v, n] of vozA) if (n > 1) achados.push(`banco: vida ${v} com ${n} tentativas de voz A`)

  const vidaDoDps = new Map<string, string>()
  for (const d of dps) vidaDoDps.set(`${d.institutionId}/${d.dpsId}`, vida(d))
  const dpsPorVida = new Map<string, Set<string>>()
  const chavesPorDps = new Map<string, Set<string>>()
  for (const a of fisco) {
    const k = `${a.institutionId}/${a.dpsId}`
    chavesPorDps.set(k, (chavesPorDps.get(k) ?? new Set()).add(a.accessKey))
    const v = vidaDoDps.get(k)
    if (!v) { achados.push(`fisco: DPS ${a.dpsId} (instituição ${a.institutionId}) autorizado e ausente do banco`); continue }
    dpsPorVida.set(v, (dpsPorVida.get(v) ?? new Set()).add(a.dpsId))
  }
  for (const [k, ks] of chavesPorDps) if (ks.size > 1) achados.push(`fisco: DPS ${k} autorizado com ${ks.size} chaves`)
  for (const [v, ds] of dpsPorVida) if (ds.size > 1) achados.push(`fisco: vida ${v} com ${ds.size} DPS autorizados`)
  return achados
}
