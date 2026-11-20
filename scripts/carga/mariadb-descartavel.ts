/**
 * DEPLOY.E3.P1 (D-F255) — a 2ª instância do MariaDB, DESCARTÁVEL, na porta 3307: mesmos binários do XAMPP (10.4), pasta de dados própria
 * em `os.tmpdir()/nfse-carga-*`. Nada da 3306 é tocado aqui.
 */
import fs from 'fs'
import net from 'net'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import { generateKeyPairSync, randomBytes } from 'crypto'
import { assertPastaCarga, assertPortaCarga, portaDoEnvArquivo, nomePastaNova, MARCADOR } from './cercas'
import { EstadoCarga, gravarEstado, lerEstado, apagarPonteiro, PORTA_CARGA, FISCAL_DB_CARGA } from './estado'

export const binDir = (): string => process.env.CARGA_MYSQL_BIN ?? 'C:\\xampp\\mysql\\bin'
const bin = (n: string) => path.join(binDir(), `${n}.exe`)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function portaResponde(porta: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: porta }, () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.setTimeout(1000, () => { s.destroy(); resolve(false) })
  })
}

/** Os argumentos do servidor descartável (as variáveis que a medida depende vão ao relatório). */
export function argsServidor(dataDir: string, porta: number): string[] {
  return [
    '--no-defaults', `--datadir=${dataDir}`, `--port=${porta}`, '--bind-address=127.0.0.1',
    '--character-set-server=utf8mb4', '--collation-server=utf8mb4_general_ci',
    '--innodb-buffer-pool-size=1G', '--max-connections=500', '--table-open-cache=4000',
    '--skip-name-resolve', '--console',
  ]
}

export async function subir(raiz: string): Promise<EstadoCarga> {
  assertPortaCarga(PORTA_CARGA, portaDoEnvArquivo(raiz))
  if (await portaResponde(PORTA_CARGA)) throw new Error(`A porta ${PORTA_CARGA} já responde — derrube a instância anterior (npm run carga:fiscal -- derrubar)`)
  const pasta = nomePastaNova(Date.now().toString(36))
  assertPastaCarga(pasta, false)
  fs.mkdirSync(pasta, { recursive: true })
  fs.writeFileSync(path.join(pasta, MARCADOR), 'pasta descartável do teste de carga da nfse-api (D-F255)\n')
  const dataDir = path.join(pasta, 'data')
  execFileSync(bin('mysql_install_db'), [`--datadir=${dataDir}`, `--port=${PORTA_CARGA}`, '--silent'], { stdio: 'inherit' })
  const log = fs.openSync(path.join(pasta, 'mysqld.log'), 'a')
  const child = spawn(bin('mysqld'), argsServidor(dataDir, PORTA_CARGA), { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  child.unref()
  for (let i = 0; i < 120 && !(await portaResponde(PORTA_CARGA)); i++) await sleep(500)
  if (!(await portaResponde(PORTA_CARGA))) throw new Error(`mysqld não respondeu na ${PORTA_CARGA} — ver ${path.join(pasta, 'mysqld.log')}`)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwtPublicPath = path.join(pasta, 'jwt-pub.pem')
  fs.writeFileSync(jwtPublicPath, publicKey.export({ type: 'spki', format: 'pem' }))
  const estado: EstadoCarga = {
    pasta, porta: PORTA_CARGA, pid: child.pid ?? null,
    fiscalUser: 'fiscal_api', fiscalPassword: randomBytes(18).toString('base64url'), fiscalDb: FISCAL_DB_CARGA,
    masterKeyB64: randomBytes(32).toString('base64'),
    jwtKid: 'carga', jwtPrivatePem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })), jwtPublicPath,
    criadoEm: new Date().toISOString(),
  }
  gravarEstado(raiz, estado)
  return estado
}

export async function derrubar(raiz: string): Promise<string> {
  const e = lerEstado(raiz)
  assertPastaCarga(e.pasta, true)
  assertPortaCarga(e.porta, portaDoEnvArquivo(raiz))
  if (await portaResponde(e.porta)) {
    try { execFileSync(bin('mysqladmin'), ['-h127.0.0.1', `--port=${e.porta}`, '-uroot', 'shutdown'], { stdio: 'inherit' }) } catch { /* cai abaixo */ }
    for (let i = 0; i < 60 && (await portaResponde(e.porta)); i++) await sleep(500)
  }
  if (await portaResponde(e.porta)) throw new Error(`A porta ${e.porta} ainda responde — não apago a pasta com o servidor vivo`)
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(e.pasta, { recursive: true, force: true }); break } catch { await sleep(1000) }
  }
  apagarPonteiro(raiz)
  return e.pasta
}
