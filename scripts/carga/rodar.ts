/**
 * DEPLOY.E3.P1 — T1 (`rodar`) e T2 (`leituras`).
 *
 * T1 (§12.8 item 9, D-F23): o fisco falso ÚNICO + 2 instâncias da nfse-api (processos separados, portas 3102/3103, o MESMO banco da 3307),
 * a mistura em LAÇO ABERTO a [rps] por [minutos], alternando a instância. Cada chamada mede `duração − x-carga-fisco-ms`. REPROVA só pelos
 * critérios do §12.8 e da D-F40: status 500, documento duplicado (banco + log do fisco), p95 global fora do fisco ≥ 5 s, e — em corrida de
 * 10 min ou mais — a T2 rodada no meio da carga. Status fora dos aceitos vão ao relatório como ACHADO, com a contagem.
 * Os alvos vêm só das respostas da própria corrida (o volume e corridas anteriores não são alvo de consultar/cancelar/XML/repetir).
 *
 * T2 (D-F40): `scripts/explain-leituras.ts --inst <volume> --schema setes_carga_volume --runs 50 --teto-ms 300` na 3307 (root da instância,
 * que tem SHOW VIEW). A medida vale sobre código COMMITADO: árvore suja = recusa, salvo `--ensaio` (relatório marcado "não vale como prova").
 */
import fs from 'fs'
import path from 'path'
import { spawn, ChildProcess, execFileSync, spawnSync } from 'child_process'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import { lerEstado, EstadoCarga, LicenciadoCarga } from './estado'
import { assertPortaCarga, portaDoEnvArquivo } from './cercas'
import { agenda, sortearFatia, Fatia, MISTURA_PADRAO } from './mistura'
import { resumo } from './estatistica'
import { acharDuplicados, LinhaTentativa, LinhaDps, AutorizacaoFisco } from './duplicados'
import { situacaoVolume } from './semear'

const PORTAS = [3102, 3103]
const PORTA_FISCO = 3199
const TETO_T1_MS = 5000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (m: string) => console.log(`[carga ${new Date().toISOString().slice(11, 19)}] ${m}`)
const tsxCli = () => require.resolve('tsx/cli')

function commitMedido(raiz: string, ensaio: boolean): { commit: string; limpo: boolean } {
  const commit = execFileSync('git', ['-C', raiz, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const sujo = execFileSync('git', ['-C', raiz, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
  if (sujo && !ensaio) throw new Error(`A medida vale só sobre código commitado — a árvore está suja:\n${sujo}\n(use --ensaio para um ensaio que não vale como prova)`)
  return { commit, limpo: !sujo }
}

function envBase(e: EstadoCarga): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '',
    NODE_ENV: 'development', DB_HOST: '127.0.0.1', DB_PORT: String(e.porta), DB_USER: e.fiscalUser, DB_PASSWORD: e.fiscalPassword,
    FISCAL_DB_NAME: e.fiscalDb,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// T2
// ---------------------------------------------------------------------------------------------------------------------------------
export async function leituras(raiz: string, rotulo: 'isolada' | 'sob-carga', ensaio = false): Promise<boolean> {
  const e = lerEstado(raiz)
  if (!e.volume) throw new Error('Instância não semeada')
  const { commit, limpo } = commitMedido(raiz, ensaio || rotulo === 'sob-carga')
  const env = { ...envBase(e), DB_USER: 'root', DB_PASSWORD: '', EXPLAIN_DB_USER: 'root', EXPLAIN_DB_PASSWORD: '', DB_POOL_SIZE: '4' }
  const script = path.join(raiz, 'scripts', 'explain-leituras.ts')
  const comTeto = spawnSync(process.execPath, [tsxCli(), script, '--inst', String(e.volume.institutionId), '--schema', e.volume.schema, '--runs', '50', '--teto-ms', '300'],
    { cwd: raiz, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let saida = `# T2 (${rotulo}) — commit ${commit}${limpo ? '' : ' (ÁRVORE SUJA — ensaio, não vale como prova)'} — ${new Date().toISOString()}\n${comTeto.stdout}${comTeto.stderr}`
  if (rotulo === 'isolada') {
    // os posicionais de antes (sem opção) — os PLANOS das duas formas têm de ser iguais (ficha §6 item 2)
    const semOpcao = spawnSync(process.execPath, [tsxCli(), script, String(e.volume.institutionId), e.volume.schema], { cwd: raiz, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const planos = (s: string) => s.split('\n').filter(l => /^\s{3}\d/.test(l)).join('\n')
    const iguais = planos(semOpcao.stdout) === planos(comTeto.stdout)
    saida += `\n# Forma posicional (sem opções): planos ${iguais ? 'IGUAIS' : 'DIFERENTES'} aos da forma com opções\n`
    if (!iguais) saida += semOpcao.stdout
  }
  fs.mkdirSync(path.join(raiz, 'carga-out'), { recursive: true })
  const arq = path.join(raiz, 'carga-out', `leituras-${rotulo}-${Date.now()}.txt`)
  fs.writeFileSync(arq, saida)
  console.log(saida)
  log(`T2 (${rotulo}): ${comTeto.status === 0 ? 'OK' : 'FALHOU'} — ${arq}`)
  return comTeto.status === 0
}

// ---------------------------------------------------------------------------------------------------------------------------------
// T1
// ---------------------------------------------------------------------------------------------------------------------------------
interface Chamada { fatia: Fatia; rota: string; instancia: number; status: number; ms: number; fiscoMs: number; semAlvo: boolean; code?: string }

const ACEITOS: Record<Fatia, (s: number) => boolean> = {
  'pendentes': s => s === 200,
  'transmitir': s => s === 201 || s === 422 || s === 502 || s === 503 || s === 504,
  'mesma-nota-duas-instancias': s => s === 201 || s === 409 || s === 422 || s === 502 || s === 503 || s === 504,
  'repetir-autorizada': s => s === 409,
  'consultar': s => s === 200 || s === 409 || s === 502 || s === 503 || s === 504,
  'cancelar': s => s === 200 || s === 201,
  'xml-danfse': s => s === 200,
}

function iniciar(arquivo: string, env: Record<string, string>, nome: string, raiz: string, pasta: string): ChildProcess {
  const out = fs.openSync(path.join(pasta, `${nome}.log`), 'w')
  return spawn(process.execPath, [tsxCli(), arquivo], { cwd: raiz, env, stdio: ['ignore', out, out], windowsHide: true })
}

async function esperarHttp(url: string, ms: number): Promise<void> {
  const fim = Date.now() + ms
  while (Date.now() < fim) {
    try { if ((await fetch(url)).ok) return } catch { /* ainda não */ }
    await sleep(500)
  }
  throw new Error(`não respondeu: ${url}`)
}

export async function rodar(raiz: string, o: { minutos: number; rps: number; ensaio: boolean; licenciados?: number }): Promise<boolean> {
  const e = lerEstado(raiz)
  if (!e.licenciados || !e.volume) throw new Error('Instância não semeada')
  if (o.licenciados !== undefined && o.licenciados !== e.licenciados.length) {
    throw new Error(`--licenciados ${o.licenciados} diverge da semeadura (${e.licenciados.length})`)
  }
  assertPortaCarga(e.porta, portaDoEnvArquivo(raiz))
  const { commit, limpo } = commitMedido(raiz, o.ensaio)
  const fiscoLog = path.join(e.pasta, 'fisco.jsonl')
  const storage = path.join(e.pasta, 'xml')
  fs.mkdirSync(storage, { recursive: true })
  const filhos: ChildProcess[] = []
  const inicioCorrida = new Date()
  try {
    filhos.push(iniciar(path.join(raiz, 'scripts', 'carga', 'fisco-falso.ts'), { ...envBase(e), CARGA_FISCO_PORTA: String(PORTA_FISCO), CARGA_FISCO_LOG: fiscoLog }, 'fisco', raiz, e.pasta))
    await esperarHttp(`http://127.0.0.1:${PORTA_FISCO}/estado`, 60_000)
    for (const porta of PORTAS) {
      filhos.push(iniciar(path.join(raiz, 'scripts', 'carga', 'instancia-nfse.ts'), {
        ...envBase(e), PORT: String(porta), CARGA_PASTA: e.pasta, STORAGE_PATH: storage, CARGA_FISCO_URL: `http://127.0.0.1:${PORTA_FISCO}`,
        FISCAL_MASTER_KEYS: `1:${e.masterKeyB64}`, JWT_PUBLIC_KEYS: `${e.jwtKid}=${e.jwtPublicPath}`, CORS_ORIGINS: 'http://localhost:5051',
        NFSE_REFRESH_WORKER: 'on', ...(o.ensaio ? { CARGA_WORKER_MS: '30000' } : {}), DB_POOL_SIZE: '20',
      }, `instancia-${porta}`, raiz, e.pasta))
    }
    for (const porta of PORTAS) await esperarHttp(`http://127.0.0.1:${porta}/carga/estado`, 120_000)
    log(`fisco falso + 2 instâncias de pé; ${e.licenciados.length} licenciados + volume; ${o.rps} req/s por ${o.minutos} min${o.ensaio ? ' (ENSAIO)' : ''}`)

    // ---- alvos (memória do orquestrador)
    const todos: LicenciadoCarga[] = [...e.licenciados, e.volume]
    const segundos = o.minutos * 60 + 3600
    const token = new Map(todos.map(l => [l.institutionId, jwt.sign(
      { institutionId: l.institutionId, userId: l.userId, role: 'admin', schemaName: l.schema },
      e.jwtPrivatePem, { algorithm: 'RS256', keyid: e.jwtKid, expiresIn: segundos })]))
    const pendentes = new Map<number, number[]>(todos.map(l => [l.institutionId,
      l === e.volume ? Array.from({ length: l.notas }, (_, i) => i + 1).filter(i => situacaoVolume(i) === 'pendente') : Array.from({ length: l.notas }, (_, i) => i + 1)]))
    const autorizadas: { inst: number; id: number }[] = []
    const comTentativa: { inst: number; id: number }[] = []
    const chamadas: Chamada[] = []
    let vez = 0, emVoo = 0
    const sorteio = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

    async function chamar(fatia: Fatia, inst: number, metodo: 'GET' | 'POST', rota: string, corpo: unknown, semAlvo: boolean, instancia?: number): Promise<number> {
      const porta = instancia ?? PORTAS[vez++ % PORTAS.length]
      const t0 = process.hrtime.bigint()
      emVoo++
      try {
        const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
          method: metodo, headers: { authorization: `Bearer ${token.get(inst)}`, 'content-type': 'application/json' },
          body: corpo === undefined ? undefined : JSON.stringify(corpo),
        })
        const texto = await r.text()
        let code: string | undefined
        try { code = JSON.parse(texto)?.code } catch { /* sem JSON */ }
        chamadas.push({ fatia, rota: rota.replace(/\/[0-9]+(\/|$)/, '/:id$1'), instancia: porta, status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6,
          fiscoMs: Number(r.headers.get('x-carga-fisco-ms') ?? 0), semAlvo, code })
        return r.status
      } catch (err) {
        chamadas.push({ fatia, rota, instancia: porta, status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, fiscoMs: 0, semAlvo, code: String(err) })
        return 0
      } finally { emVoo-- }
    }

    async function transmitir(fatia: Fatia, l: LicenciadoCarga, semAlvo: boolean): Promise<void> {
      const fila = pendentes.get(l.institutionId)!
      const id = fila.shift()
      if (id === undefined) { await chamar('pendentes', l.institutionId, 'GET', '/v1/nfse/invoices/pending?page=1&pageSize=25&interfaceKey=service-orders', undefined, true); return }
      const rota = `/v1/nfse/invoices/${id}/transmit`
      const st = fatia === 'mesma-nota-duas-instancias'
        ? Math.min(...(await Promise.all(PORTAS.map(p => chamar(fatia, l.institutionId, 'POST', rota, undefined, semAlvo, p)))).map(s => (s === 201 ? 0 : s)))
        : await chamar(fatia, l.institutionId, 'POST', rota, undefined, semAlvo)
      comTentativa.push({ inst: l.institutionId, id })
      if (st === 0 || st === 201) autorizadas.push({ inst: l.institutionId, id })
    }

    async function disparar(): Promise<void> {
      const fatia = sortearFatia(Math.random())
      const l = sorteio(todos)
      switch (fatia) {
        case 'pendentes':
          await chamar(fatia, l.institutionId, 'GET', '/v1/nfse/invoices/pending?page=1&pageSize=25&interfaceKey=service-orders', undefined, false); return
        case 'transmitir':
        case 'mesma-nota-duas-instancias':
          await transmitir(fatia, l, false); return
        case 'repetir-autorizada': {
          const a = autorizadas.length ? sorteio(autorizadas) : null
          if (!a) return transmitir('transmitir', l, true)
          await chamar(fatia, a.inst, 'POST', `/v1/nfse/invoices/${a.id}/transmit`, undefined, false); return
        }
        case 'consultar': {
          const a = comTentativa.length ? sorteio(comTentativa) : null
          if (!a) return transmitir('transmitir', l, true)
          await chamar(fatia, a.inst, 'POST', `/v1/nfse/invoices/${a.id}/refresh`, undefined, false); return
        }
        case 'cancelar': {
          if (!autorizadas.length) return transmitir('transmitir', l, true)
          const a = autorizadas.splice(Math.floor(Math.random() * autorizadas.length), 1)[0]
          await chamar(fatia, a.inst, 'POST', `/v1/nfse/invoices/${a.id}/cancel`, { reason: 'Cancelamento sintético do teste de carga' }, false); return
        }
        case 'xml-danfse': {
          const a = autorizadas.length ? sorteio(autorizadas) : null
          if (!a) return transmitir('transmitir', l, true)
          await chamar(fatia, a.inst, 'GET', `/v1/nfse/invoices/${a.id}/${Math.random() < 0.5 ? 'xml' : 'danfse'}`, undefined, false); return
        }
      }
    }

    // ---- laço aberto
    const duracao = o.minutos * 60_000
    const instantes = agenda(o.rps, duracao)
    const t0 = Date.now()
    const disparos: Promise<void>[] = []
    let t2SobCarga: boolean | null = null
    const meio = o.minutos >= 10 ? new Promise<void>(r => setTimeout(async () => { t2SobCarga = await leituras(raiz, 'sob-carga', true).catch(() => false); r() }, duracao / 2)) : Promise.resolve()
    let proximoLog = t0 + 60_000
    for (const ms of instantes) {
      const espera = t0 + ms - Date.now()
      if (espera > 0) await sleep(espera)
      disparos.push(disparar().catch(err => { chamadas.push({ fatia: 'pendentes', rota: 'erro-orquestrador', instancia: 0, status: 0, ms: 0, fiscoMs: 0, semAlvo: false, code: String(err) }) }))
      if (Date.now() >= proximoLog) { proximoLog += 60_000; log(`${Math.round((Date.now() - t0) / 60_000)} min — ${chamadas.length} respostas, ${emVoo} em voo, ${autorizadas.length} autorizadas`) }
    }
    await Promise.race([Promise.all(disparos), sleep(180_000)])
    await meio
    const estadoInstancias = await Promise.all(PORTAS.map(async p => { try { return await (await fetch(`http://127.0.0.1:${p}/carga/estado`)).json() } catch { return null } }))
    const estadoFisco = await (await fetch(`http://127.0.0.1:${PORTA_FISCO}/estado`)).json().catch(() => null)

    // ---- duplicado (banco + log do fisco)
    const c = await mysql.createConnection({ host: '127.0.0.1', port: e.porta, user: 'root', password: '', database: e.fiscalDb })
    let duplicados: string[]
    try {
      const [tx] = await c.query(`SELECT tb_institution_id AS institutionId, tb_invoice_id AS invoiceId, terminal, life_event AS lifeEvent, attempt,
          access_key AS accessKey, last_kind AS lastKind FROM vw_invoice_service_transmission`) as any
      const [dps] = await c.query(`SELECT tb_institution_id AS institutionId, tb_invoice_id AS invoiceId, terminal, life_event AS lifeEvent, dps_id AS dpsId FROM tb_invoice_service_dps`) as any
      const porCnpj = new Map(todos.map(l => [l.cnpj, l.institutionId]))
      const fisco: AutorizacaoFisco[] = fs.readFileSync(fiscoLog, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x))
        .filter(x => x.tipo === 'autorizacao').map(x => ({ institutionId: porCnpj.get(x.cnpj) ?? -1, dpsId: x.dpsId, accessKey: x.accessKey }))
      duplicados = acharDuplicados(tx as LinhaTentativa[], dps as LinhaDps[], fisco)
    } finally { await c.end() }

    // ---- relatório
    const foraDoFisco = chamadas.filter(x => x.status > 0).map(x => Math.max(0, x.ms - x.fiscoMs))
    const porFatia: Record<string, unknown> = {}
    for (const f of Object.keys(MISTURA_PADRAO) as Fatia[]) {
      const xs = chamadas.filter(x => x.fatia === f)
      const status: Record<string, number> = {}
      for (const x of xs) status[x.status] = (status[x.status] ?? 0) + 1
      porFatia[f] = { chamadas: xs.length, comAlvo: xs.filter(x => !x.semAlvo).length, status,
        foraDoFisco: resumo(xs.filter(x => x.status > 0).map(x => Math.max(0, x.ms - x.fiscoMs))), total: resumo(xs.map(x => x.ms)) }
    }
    const http500 = chamadas.filter(x => x.status === 500)
    const foraDosAceitos = chamadas.filter(x => !ACEITOS[x.fatia](x.status))
    const achadosStatus: Record<string, number> = {}
    for (const x of foraDosAceitos) { const k = `${x.fatia} ${x.status} ${x.code ?? ''}`.trim(); achadosStatus[k] = (achadosStatus[k] ?? 0) + 1 }
    const global = resumo(foraDoFisco)
    const criterios = {
      zero500: http500.length === 0,
      zeroDuplicado: duplicados.length === 0,
      p95ForaDoFiscoAbaixoDe5s: global.p95 < TETO_T1_MS,
      t2SobCarga: o.minutos >= 10 ? t2SobCarga === true : 'não se aplica (corrida < 10 min)',
    }
    const ok = criterios.zero500 && criterios.zeroDuplicado && criterios.p95ForaDoFiscoAbaixoDe5s && (o.minutos < 10 || t2SobCarga === true)
    const [variaveis] = await (async () => {
      const cc = await mysql.createConnection({ host: '127.0.0.1', port: e.porta, user: 'root', password: '' })
      try { return await cc.query(`SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','innodb_buffer_pool_size','max_connections','table_open_cache','character_set_server','collation_server','transaction_isolation','tx_isolation')`) }
      finally { await cc.end() }
    })()
    const rel = {
      passo: 'nfse-api:DEPLOY.E3.P1.T1', commit, arvoreLimpa: limpo, valeComoProva: limpo && !o.ensaio,
      inicio: inicioCorrida.toISOString(), fim: new Date().toISOString(), minutos: o.minutos, rps: o.rps, licenciados: e.licenciados.length,
      instancias: PORTAS, chamadas: chamadas.length, global, porFatia, criterios, ok,
      duplicados, http500: http500.slice(0, 20), achadosStatus, estadoFisco, estadoInstancias, servidor: variaveis,
    }
    fs.mkdirSync(path.join(raiz, 'carga-out'), { recursive: true })
    const arq = path.join(raiz, 'carga-out', `rodar-${o.minutos}min-${Date.now()}.json`)
    fs.writeFileSync(arq, JSON.stringify(rel, null, 2))
    log(`relatório: ${arq}`)
    console.log(JSON.stringify({ commit, valeComoProva: rel.valeComoProva, chamadas: chamadas.length, global, criterios, ok, achadosStatus, estadoFisco, estadoInstancias }, null, 2))
    return ok
  } finally {
    for (const f of filhos) { try { f.kill() } catch { /* já saiu */ } }
  }
}
