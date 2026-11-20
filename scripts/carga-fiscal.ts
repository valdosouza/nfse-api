/**
 * DEPLOY.E3.P1 (D-F23, D-F40, D-F255…D-F258) — o TESTE DE CARGA da nfse-api contra fisco FALSO, numa instância DESCARTÁVEL do MariaDB.
 * Ficha: Vault `projetos/nfse-api/GERAL/ficha-deploy-e3-p1-carga.md`.
 *
 *   npm run carga:fiscal -- subir                       # MariaDB descartável na 3307 (pasta em os.tmpdir()/nfse-carga-*)
 *   npm run carga:fiscal -- semear --licenciados 1000   # estrutura do dev (só leitura) + catálogos + dado sintético
 *   npm run carga:fiscal -- conferir                    # contagens + A1 que abrem
 *   npm run carga:fiscal -- rodar --minutos 30 --rps 5 [--ensaio]   # T1: fisco falso + 2 instâncias + mistura em laço aberto
 *   npm run carga:fiscal -- leituras                    # T2: explain:leituras com 200 mil notas, p95 < 300 ms por chamada
 *   npm run carga:fiscal -- derrubar                    # para a 3307 e apaga a pasta
 *
 * A 3306 (o MariaDB que emite a produção da Setes) só é LIDA, no `semear`, e só com CHECKSUM igual antes e depois. Nenhum byte ao fisco real.
 */
import path from 'path'
import { subir, derrubar } from './carga/mariadb-descartavel'
import { semear } from './carga/semear'
import { conferir } from './carga/conferir'

const RAIZ = path.resolve(__dirname, '..')
const OPCOES = ['--licenciados', '--minutos', '--rps']
const FLAGS = ['--ensaio']

export function argumentos(argv: readonly string[]): { comando: string; opts: Record<string, number>; flags: Set<string> } {
  const [comando, ...resto] = argv
  const opts: Record<string, number> = {}
  const flags = new Set<string>()
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i]
    if (FLAGS.includes(a)) { flags.add(a); continue }
    if (!OPCOES.includes(a)) throw new Error(`argumento desconhecido: ${a}`)
    const v = Number(resto[++i])
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} inválido`)
    opts[a.slice(2)] = v
  }
  if (!comando) throw new Error('comando: subir | semear | conferir | rodar | leituras | derrubar')
  return { comando, opts, flags }
}

async function main(): Promise<void> {
  const { comando, opts, flags } = argumentos(process.argv.slice(2))
  switch (comando) {
    case 'subir': {
      const e = await subir(RAIZ)
      console.log(`3307 de pé: ${e.pasta} (pid ${e.pid})`)
      return
    }
    case 'semear': {
      await semear(RAIZ, opts.licenciados ?? 1000)
      const c = await conferir(RAIZ)
      console.log(JSON.stringify(c, null, 2))
      if (!c.ok) process.exit(1)
      return
    }
    case 'conferir': {
      const c = await conferir(RAIZ)
      console.log(JSON.stringify(c, null, 2))
      if (!c.ok) process.exit(1)
      return
    }
    case 'rodar': {
      const { rodar } = await import('./carga/rodar')
      const ok = await rodar(RAIZ, { minutos: opts.minutos ?? 30, rps: opts.rps ?? 5, ensaio: flags.has('--ensaio'), licenciados: opts.licenciados })
      if (!ok) process.exit(1)
      return
    }
    case 'leituras': {
      const { leituras } = await import('./carga/rodar')
      if (!(await leituras(RAIZ, 'isolada', flags.has('--ensaio')))) process.exit(1)
      return
    }
    case 'derrubar': {
      console.log(`derrubada e apagada: ${await derrubar(RAIZ)}`)
      return
    }
    default:
      throw new Error(`comando desconhecido: ${comando}`)
  }
}

if (require.main === module) main().catch(err => { console.error('[carga-fiscal] FALHA:', err?.stack ?? err); process.exit(1) })
