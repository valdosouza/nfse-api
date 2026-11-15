/// <reference types="jest" />
// DEPLOY.E1.P1.T4 (2026-11-15): o pre-deploy check (molde do pre-deploy-tz-check do setes-api) confere ANTES de subir o que o boot recusaria.
// Em produção o item que falha BLOQUEIA (saída 1); fora dela é aviso.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { preDeployConfigItems, preDeployDbItem, preDeployReport } from '../pre-deploy'

const ROOT = path.resolve(__dirname, '..', '..')
const HEAD = (() => {
  try { return require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() as string }
  catch { return null }
})()

let tmp: string
let distDir: string
let storage: string
let pem: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-predeploy-'))
  distDir = path.join(tmp, 'dist')
  storage = path.join(tmp, 'storage')
  fs.mkdirSync(distDir)
  fs.mkdirSync(storage)
  fs.writeFileSync(path.join(distDir, 'server.js'), '')
  fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify({ commit: HEAD, dirty: false }))
  pem = path.join(tmp, 'pub.pem')
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  fs.writeFileSync(pem, publicKey.export({ type: 'spki', format: 'pem' }))
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function prodEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://erp.setesgestao.com.br',
    FISCAL_MASTER_KEYS: '1:' + crypto.randomBytes(32).toString('base64'),
    JWT_PUBLIC_KEY_PATH: pem,
    STORAGE_PATH: storage,
    PORT: '3002',
    ...over,
  }
}
const byItem = (items: ReturnType<typeof preDeployConfigItems>, name: string) => items.find(i => i.item === name)!

describe('pre-deploy check da nfse-api (DEPLOY.E1.P1.T4)', () => {
  it('produção bem configurada: nada bloqueia, saída 0', () => {
    const items = preDeployConfigItems(prodEnv(), { distDir, projectRoot: ROOT })
    expect(items.filter(i => !i.ok)).toEqual([])
    expect(preDeployReport(items).exitCode).toBe(0)
  })

  it('CORS vazio ou com curinga: bloqueia em produção (regra do núcleo, D-F146)', () => {
    for (const cors of ['', '*', 'https://erp.setesgestao.com.br,*']) {
      const item = byItem(preDeployConfigItems(prodEnv({ CORS_ORIGINS: cors }), { distDir, projectRoot: ROOT }), 'CORS_ORIGINS')
      expect(item).toMatchObject({ ok: false, blocking: true })
    }
  })

  it('sem chave-mestra, sem chave do JWT ou com variável aposentada: bloqueia em produção', () => {
    const items = preDeployConfigItems(prodEnv({ FISCAL_MASTER_KEYS: undefined, JWT_PUBLIC_KEY_PATH: undefined, FISCAL_LEGACY_INSTITUTIONS: '1' }), { distDir, projectRoot: ROOT })
    expect(byItem(items, 'FISCAL_MASTER_KEYS')).toMatchObject({ ok: false, blocking: true })
    expect(byItem(items, 'chave pública do JWT')).toMatchObject({ ok: false, blocking: true })
    expect(byItem(items, 'variáveis aposentadas')).toMatchObject({ ok: false, blocking: true })
    expect(preDeployReport(items).exitCode).toBe(1)
  })

  it('STORAGE_PATH ausente, relativo em produção ou pasta que não existe: bloqueia', () => {
    for (const s of [undefined, 'storage', path.join(tmp, 'nao-existe')]) {
      expect(byItem(preDeployConfigItems(prodEnv({ STORAGE_PATH: s }), { distDir, projectRoot: ROOT }), 'STORAGE_PATH')).toMatchObject({ ok: false, blocking: true })
    }
  })

  it('dist ausente, sem selo ou de OUTRO commit: bloqueia (D-F222)', () => {
    const empty = fs.mkdtempSync(path.join(tmp, 'vazio-'))
    expect(byItem(preDeployConfigItems(prodEnv(), { distDir: empty, projectRoot: ROOT }), 'dist').detail).toMatch(/npm run build/)
    fs.writeFileSync(path.join(empty, 'server.js'), '')
    expect(byItem(preDeployConfigItems(prodEnv(), { distDir: empty, projectRoot: ROOT }), 'dist').detail).toMatch(/sem selo/)
    if (HEAD) {
      fs.writeFileSync(path.join(empty, 'build-info.json'), JSON.stringify({ commit: 'f'.repeat(40), dirty: false }))
      expect(byItem(preDeployConfigItems(prodEnv(), { distDir: empty, projectRoot: ROOT }), 'dist')).toMatchObject({ ok: false, blocking: true })
    }
  })

  it('fora de produção: o que falha é aviso, nunca bloqueia (saída 0)', () => {
    const items = preDeployConfigItems({ NODE_ENV: 'development', CORS_ORIGINS: '' }, { distDir, projectRoot: ROOT })
    expect(items.some(i => !i.ok)).toBe(true)
    expect(items.every(i => !i.blocking)).toBe(true)
    expect(preDeployReport(items).exitCode).toBe(0)
  })

  it('NODE_ENV fora de production é dito no relatório', () => {
    expect(byItem(preDeployConfigItems(prodEnv({ NODE_ENV: undefined }), { distDir, projectRoot: ROOT }), 'NODE_ENV')).toMatchObject({ ok: false })
  })

  it('banco: responde = ok; falha = bloqueia em produção', async () => {
    await expect(preDeployDbItem(prodEnv(), async () => [{ version: '10.11.3-MariaDB', db: 'fiscal_api' }]))
      .resolves.toMatchObject({ ok: true, detail: '10.11.3-MariaDB · fiscal_api' })
    await expect(preDeployDbItem(prodEnv(), async () => { throw new Error('ECONNREFUSED') }))
      .resolves.toMatchObject({ ok: false, blocking: true, detail: 'ECONNREFUSED' })
  })
})
