/**
 * DEPLOY.E3.P1 (§5.9: "stub do ADN com latência e falhas configuráveis") — o FISCO FALSO da carga: UM processo HTTP local, com o estado em
 * memória COMUM às duas instâncias da nfse-api (com um falso por instância, consulta/cancelamento/reconciliação cairiam na instância que
 * não conhece a chave). Nenhum byte ao fisco real.
 *
 *   POST /transmit {dpsXml}   → 200 {accessKey, nfseNumber, dhProc, nfseXml} · 422 {code} (rejeição sorteada) · 503 (indisponível sorteado)
 *                               o MESMO DPS repetido devolve a MESMA chave e conta como "reenvio"
 *   GET  /nfse/:chave         → 200 {status, nfseXml, dhProc, cancelled?} · 503 para chave que ele não emitiu (as semeadas no volume)
 *   GET  /dps/:id             → 200 {accessKey} · 404 {e2404:true} só para DPS que ele RECUSOU (422) · 503 para DPS nunca visto ou com 503
 *   POST /evento {accessKey}  → 200 {dhEvento, protocol, eventXml} · 503 para chave que ele não emitiu
 *   GET  /estado              → contagens
 *
 * Latência uniforme em [CARGA_FISCO_MIN_MS, CARGA_FISCO_MAX_MS] (padrão 1000–3000, §5.9); falhas CARGA_FISCO_REJEITA (0,02) e
 * CARGA_FISCO_INDISPONIVEL (0,01) — suposição marcada (ficha §5). Cada autorização e cancelamento vai a CARGA_FISCO_LOG (JSONL, zerado na partida).
 */
import fs from 'fs'
import http from 'http'

interface Nfse { accessKey: string; dpsId: string; cnpj: string; nfseNumber: string; dhProc: string; nfseXml: string; cancelada: string | null }

export function dhLocal(d = new Date()): string {
  const t = new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 19)
  return `${t}-03:00`
}

export function nfseXmlFalso(n: Nfse): string {
  return `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${n.accessKey}"><nNFSe>${n.nfseNumber}</nNFSe>`
    + `<dhProc>${n.dhProc}</dhProc><cStat>100</cStat><emit><CNPJ>${n.cnpj}</CNPJ><xNome>EMITENTE CARGA</xNome></emit>`
    + `<DPS><infDPS Id="${n.dpsId}"></infDPS></DPS></infNFSe></NFSe>`
}

/** O Id do DPS no XML assinado e o emitente embutido nele (posições 11–25). */
export function dpsDoXml(xml: string): { dpsId: string; cMun: string; cnpj: string } | null {
  const m = /<infDPS\b[^>]*\sId="(DPS[0-9A-Z]{42})"/.exec(xml)
  if (!m) return null
  return { dpsId: m[1], cMun: m[1].slice(3, 10), cnpj: m[1].slice(11, 25) }
}

export function criarFisco(opts: { minMs: number; maxMs: number; rejeita: number; indisponivel: number; log: string | null; rnd?: () => number }) {
  const rnd = opts.rnd ?? Math.random
  const porDps = new Map<string, Nfse>()
  const porChave = new Map<string, Nfse>()
  const recusados = new Set<string>()
  const cont = { transmit: 0, autorizadas: 0, reenvios: 0, rejeitadas: 0, indisponiveis: 0, consultas: 0, dps: 0, eventos: 0, desconhecidas: 0 }
  let seq = 0
  if (opts.log) fs.writeFileSync(opts.log, '')
  const registrar = (o: object) => { if (opts.log) fs.appendFileSync(opts.log, JSON.stringify(o) + '\n') }
  const latencia = () => new Promise(r => setTimeout(r, opts.minMs + rnd() * (opts.maxMs - opts.minMs)))

  async function atender(metodo: string, url: string, corpo: any): Promise<{ status: number; json: unknown }> {
    if (metodo === 'GET' && url === '/estado') return { status: 200, json: { ...cont, emitidas: porChave.size } }
    await latencia()
    if (metodo === 'POST' && url === '/transmit') {
      cont.transmit++
      const d = dpsDoXml(String(corpo?.dpsXml ?? ''))
      if (!d) return { status: 400, json: { code: 'DPS_SEM_ID' } }
      const ja = porDps.get(d.dpsId)
      if (ja) { cont.reenvios++; return { status: 200, json: { accessKey: ja.accessKey, nfseNumber: ja.nfseNumber, dhProc: ja.dhProc, nfseXml: ja.nfseXml } } }
      const u = rnd()
      if (u < opts.rejeita) { cont.rejeitadas++; recusados.add(d.dpsId); return { status: 422, json: { code: 'E0001', message: 'rejeição sorteada da carga' } } }
      if (u < opts.rejeita + opts.indisponivel) { cont.indisponiveis++; return { status: 503, json: { code: 'INDISPONIVEL' } } }
      recusados.delete(d.dpsId)
      const agora = new Date()
      const nNfse = String(1_000_000_000_000 + ++seq)
      const aamm = agora.toISOString().slice(2, 4) + agora.toISOString().slice(5, 7)
      const accessKey = `${d.cMun}12${d.cnpj}${nNfse.padStart(13, '0')}${aamm}${String(seq).padStart(9, '0')}0`
      const n: Nfse = { accessKey, dpsId: d.dpsId, cnpj: d.cnpj, nfseNumber: nNfse, dhProc: dhLocal(agora), nfseXml: '', cancelada: null }
      n.nfseXml = nfseXmlFalso(n)
      porDps.set(d.dpsId, n); porChave.set(accessKey, n)
      cont.autorizadas++
      registrar({ t: agora.toISOString(), tipo: 'autorizacao', dpsId: d.dpsId, cnpj: d.cnpj, accessKey })
      return { status: 200, json: { accessKey, nfseNumber: nNfse, dhProc: n.dhProc, nfseXml: n.nfseXml } }
    }
    const mNfse = /^\/nfse\/([0-9A-Z]{50})$/.exec(url)
    if (metodo === 'GET' && mNfse) {
      cont.consultas++
      const n = porChave.get(mNfse[1])
      if (!n) { cont.desconhecidas++; return { status: 503, json: { code: 'CHAVE_DESCONHECIDA' } } }
      return { status: 200, json: { status: n.cancelada ? 'cancelled' : 'authorized', nfseXml: n.nfseXml, dhProc: n.dhProc,
        ...(n.cancelada ? { cancelled: { dhEvento: n.cancelada, motive: 'cancelamento da carga', eventCode: '101101', eventXml: `<evento><chNFSe>${n.accessKey}</chNFSe></evento>` } } : {}) } }
    }
    const mDps = /^\/dps\/(DPS[0-9A-Z]{42})$/.exec(url)
    if (metodo === 'GET' && mDps) {
      cont.dps++
      const n = porDps.get(mDps[1])
      if (n) return { status: 200, json: { accessKey: n.accessKey } }
      if (recusados.has(mDps[1])) return { status: 404, json: { e2404: true } }
      cont.desconhecidas++
      return { status: 503, json: { code: 'DPS_DESCONHECIDO' } }
    }
    if (metodo === 'POST' && url === '/evento') {
      cont.eventos++
      const n = porChave.get(String(corpo?.accessKey ?? ''))
      if (!n) { cont.desconhecidas++; return { status: 503, json: { code: 'CHAVE_DESCONHECIDA' } } }
      n.cancelada = n.cancelada ?? dhLocal()
      registrar({ t: new Date().toISOString(), tipo: 'cancelamento', accessKey: n.accessKey })
      return { status: 200, json: { dhEvento: n.cancelada, protocol: `EVT${n.accessKey}`, eventXml: `<evento><chNFSe>${n.accessKey}</chNFSe></evento>` } }
    }
    return { status: 404, json: { code: 'ROTA' } }
  }
  return { atender, cont }
}

if (require.main === module) {
  const num = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]))
  const fisco = criarFisco({
    minMs: num('CARGA_FISCO_MIN_MS', 1000), maxMs: num('CARGA_FISCO_MAX_MS', 3000),
    rejeita: num('CARGA_FISCO_REJEITA', 0.02), indisponivel: num('CARGA_FISCO_INDISPONIVEL', 0.01),
    log: process.env.CARGA_FISCO_LOG ?? null,
  })
  const porta = num('CARGA_FISCO_PORTA', 3199)
  http.createServer((req, res) => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', async () => {
      try {
        const r = await fisco.atender(String(req.method), String(req.url), b ? JSON.parse(b) : null)
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'FISCO_FALSO', message: String(err) }))
      }
    })
  }).listen(porta, '127.0.0.1', () => console.log(`[fisco-falso] ouvindo em 127.0.0.1:${porta}`))
}
