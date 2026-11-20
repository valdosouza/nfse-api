/**
 * DEPLOY.E3.P1 — conferência do banco semeado na 3307: contagens e "o A1 abre" pela peça do núcleo (`openIssuer`) em instituições sorteadas.
 */
import { createFiscalPool, openIssuer, MasterKeyRing } from 'fiscal-api'
import { assertPortaCarga, portaDoEnvArquivo } from './cercas'
import { lerEstado } from './estado'

export interface Conferencia { contagens: Record<string, number>; esperado: Record<string, number>; a1Abrem: string; ok: boolean }

export async function conferir(raiz: string, sorteadas = 10): Promise<Conferencia> {
  const e = lerEstado(raiz)
  if (!e.licenciados || !e.volume) throw new Error('A instância não foi semeada')
  assertPortaCarga(e.porta, portaDoEnvArquivo(raiz))
  const n = e.licenciados.length
  const pool = createFiscalPool({ host: '127.0.0.1', port: e.porta, user: 'root', password: '', database: e.fiscalDb } as any)
  try {
    const um = async (sql: string, p: unknown[] = []) => Number(((await pool.query(sql, p))[0] as any[])[0].n)
    const contagens: Record<string, number> = {
      instituicoes: await um('SELECT COUNT(*) n FROM setes_central.tb_institution'),
      habilitacoes_viradas: await um(`SELECT COUNT(*) n FROM tb_establishment_issuer WHERE model = 'SE' AND deleted = 'N' AND cutover_at IS NOT NULL`),
      certificados: await um(`SELECT COUNT(*) n FROM tb_establishment_certificate WHERE deleted = 'N'`),
      notas_volume: await um(`SELECT COUNT(*) n FROM \`${e.volume.schema}\`.tb_invoice`),
      notas_1o_licenciado: await um(`SELECT COUNT(*) n FROM \`${e.licenciados[0].schema}\`.tb_invoice`),
      tentativas_volume: await um('SELECT COUNT(*) n FROM tb_invoice_service_transmission WHERE tb_institution_id = ?', [e.volume.institutionId]),
      vozes_volume: await um('SELECT COUNT(*) n FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ?', [e.volume.institutionId]),
    }
    const esperado: Record<string, number> = {
      instituicoes: n + 2, habilitacoes_viradas: n + 1, certificados: n + 1, notas_volume: e.volume.notas, notas_1o_licenciado: e.licenciados[0].notas,
    }
    const keyring = MasterKeyRing.of({ 1: Buffer.from(e.masterKeyB64, 'base64') })
    const todos = [...e.licenciados, e.volume]
    const alvo = Array.from({ length: Math.min(sorteadas, todos.length) }, (_, i) => todos[Math.floor((i * todos.length) / Math.min(sorteadas, todos.length))])
    let abrem = 0
    for (const l of alvo) {
      try { await openIssuer({ pool, keyring }, l.institutionId, 'SE', { schemaName: l.schema }); abrem++ } catch (err) {
        console.error(`A1 da instituição ${l.institutionId} não abriu: ${(err as Error).message}`)
      }
    }
    const ok = Object.entries(esperado).every(([k, v]) => contagens[k] === v) && abrem === alvo.length
    return { contagens, esperado, a1Abrem: `${abrem}/${alvo.length}`, ok }
  } finally {
    await pool.end()
  }
}
