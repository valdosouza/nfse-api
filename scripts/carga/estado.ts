/**
 * DEPLOY.E3.P1 (D-F255) — o ESTADO da carga entre comandos (`subir`, `semear`, `rodar`, `leituras`, `derrubar` são processos separados).
 * Mora em `<pasta descartável>/carga.json`; `carga-out/estado.json` (fora do git) só aponta a pasta. As chaves de carga (mestra, par JWT,
 * senha do `fiscal_api` da 3307) nascem no `subir`, só aqui — nunca as do `.env`.
 */
import fs from 'fs'
import path from 'path'
import { assertPastaCarga } from './cercas'

export interface LicenciadoCarga { institutionId: number; schema: string; cnpj: string; userId: number; tomadorId: number; notas: number }

export interface EstadoCarga {
  pasta: string
  porta: number
  pid: number | null
  fiscalUser: string
  fiscalPassword: string
  fiscalDb: string
  masterKeyB64: string
  jwtKid: string
  jwtPrivatePem: string
  jwtPublicPath: string
  criadoEm: string
  semeadoEm?: string
  licenciados?: LicenciadoCarga[]
  volume?: LicenciadoCarga
  tempos?: Record<string, number>
}

export const PORTA_CARGA = 3307
export const FISCAL_DB_CARGA = 'fiscal_api_carga'

const ponteiro = (raiz: string) => path.join(raiz, 'carga-out', 'estado.json')

export function gravarEstado(raiz: string, e: EstadoCarga): void {
  assertPastaCarga(e.pasta, true)
  fs.writeFileSync(path.join(e.pasta, 'carga.json'), JSON.stringify(e, null, 2))
  fs.mkdirSync(path.dirname(ponteiro(raiz)), { recursive: true })
  fs.writeFileSync(ponteiro(raiz), JSON.stringify({ pasta: e.pasta }, null, 2))
}

export function lerEstado(raiz: string): EstadoCarga {
  if (!fs.existsSync(ponteiro(raiz))) throw new Error('Nenhuma instância de carga: rode `npm run carga:fiscal -- subir`')
  const { pasta } = JSON.parse(fs.readFileSync(ponteiro(raiz), 'utf8'))
  assertPastaCarga(pasta, true)
  return JSON.parse(fs.readFileSync(path.join(pasta, 'carga.json'), 'utf8'))
}

export function apagarPonteiro(raiz: string): void {
  if (fs.existsSync(ponteiro(raiz))) fs.rmSync(ponteiro(raiz))
}
