// SONDA SÓ DE LEITURA (D-F61, 2026-10-10): o adaptador ADN corrigido consulta uma NFS-e no fisco (H = produção restrita, P =
// produção) e mostra a situação lida (autorizada × cancelada). Nada é gravado em banco nenhum; só GETs ao fisco — use só com
// NFS-e do próprio emitente.
// Uso: npx tsx --require tsconfig-paths/register scripts/probe-query.ts <chave50> [H|P] [<dir do A1 em PEM>]
//   (padrão do A1: ../setes-api/secrets/setes_setes/establishment/1/P — certificate.pem + private.key)
import fs from 'fs'
import path from 'path'
import { adnAdapter } from '../src/authority/adn'

async function main(): Promise<void> {
  const [key, envArg = 'H', dirArg] = process.argv.slice(2)
  if (!/^\d{50}$/.test(key ?? '') || !['H', 'P'].includes(envArg)) throw new Error('uso: probe-query.ts <chave de 50 dígitos> [H|P] [dir do A1]')
  const dir = path.resolve(dirArg ?? path.join(__dirname, '..', '..', 'setes-api', 'secrets', 'setes_setes', 'establishment', '1', 'P'))
  const ctx = { environment: envArg as 'H' | 'P', cert: fs.readFileSync(path.join(dir, 'certificate.pem')), key: fs.readFileSync(path.join(dir, 'private.key')) }
  const q = await adnAdapter.queryNfse(ctx as any, key)
  // o console do Windows não mostra UTF-8: fora do ASCII sai como \uXXXX (dá para ver se o texto é ç ou o "Ã§" de dupla codificação)
  const esc = (s: string) => s.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  console.log(esc(JSON.stringify({ chave: q.accessKey, situacao: q.status, dhProc: q.dhProc ?? null,
    cancelamento: q.cancelled ? { dhEvento: q.cancelled.dhEvento, motivo: q.cancelled.motive, eventoXmlBytes: q.cancelled.eventXml?.length ?? 0 } : null }, null, 2)))
}

main().catch(err => { console.error('[probe-query] FALHA:', err?.code ?? '', err?.message ?? err); process.exit(1) })
