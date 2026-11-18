/// <reference types="jest" />
// DEPLOY.E1.P3 (2026-11-18 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p3-adocao-pacote-2-0-0.md` no Vault): adoção do pacote 2.0.0
// do núcleo. (1) D-F241: a RAIZ do arquivo fiscal vem de `fiscalStorageRootFromEnv` — produção exige `STORAGE_PATH` absoluto (o layout
// por tipo, série e dia está em `transmission.test.ts`, describe D-F241). (2) D-F236: o boot e o pre-deploy passam o AMBIENTE ao
// `assertCorsOrigins` — em produção só `https://` e nada de localhost; fora dela, como antes (D-F146).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MasterKeyRing } from 'fiscal-api'
import { contextFromEnv } from '../context'
import { preDeployConfigItems } from '../pre-deploy'
import { isProductionEnv } from '../environment'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-deploy-e1-p3-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const DB = { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'fiscal_api' }
const overrides = { pool: {} as any, keyring: MasterKeyRing.of({}), verifier: {} as any }

describe('D-F241 — a raiz do arquivo fiscal pelo critério do núcleo', () => {
  it('produção com STORAGE_PATH relativo ou ausente → o contexto NÃO monta (o XML nunca cai na pasta de execução)', () => {
    for (const STORAGE_PATH of ['rel/x', undefined]) {
      expect(() => contextFromEnv({ ...DB, NODE_ENV: 'production', STORAGE_PATH }, overrides)).toThrow(/STORAGE_PATH/)
    }
  })

  it('produção com caminho absoluto → a gravação cai debaixo dele, no layout <cnpj>/nfse/<série>/<ano>/<mês>/<dia>', () => {
    const ctx = contextFromEnv({ ...DB, NODE_ENV: 'production', STORAGE_PATH: tmp }, overrides)
    const ref = ctx.storage.save({ cnpj: '12345678000195', kind: 'nfse', serie: '00001', environment: 'P', zone: 'America/Sao_Paulo' },
      'DPS410690221234567800019500001000000000000042-dps.xml', '<DPS/>', new Date('2026-11-18T02:30:00Z'))
    expect(ref).toBe(path.join(tmp, '12345678000195', 'nfse', '1', '2026', '11', '17', 'DPS410690221234567800019500001000000000000042-dps.xml'))
    expect(ctx.storage.probe()).toBe(true)
  })
})

describe('D-F236 — CORS por ambiente no boot e no pre-deploy', () => {
  const corsItem = (env: NodeJS.ProcessEnv) => preDeployConfigItems(env).find(i => i.item === 'CORS_ORIGINS')!

  it('produção: origem http:// ou localhost (mesmo https) BLOQUEIA o deploy', () => {
    for (const CORS_ORIGINS of ['http://app.setes.com.br', 'https://localhost', 'https://app.setes.com.br,http://localhost:5051', 'https://127.0.0.1:8443']) {
      expect([CORS_ORIGINS, corsItem({ NODE_ENV: 'production', CORS_ORIGINS })]).toEqual([CORS_ORIGINS, expect.objectContaining({ ok: false, blocking: true })])
    }
  })

  it('produção: só origens https públicas → passa', () => {
    expect(corsItem({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.setes.com.br' })).toMatchObject({ ok: true, detail: 'https://app.setes.com.br' })
  })

  it('fora de produção a origem do dev segue aceita (D-F146 como antes)', () => {
    expect(corsItem({ NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5051' })).toMatchObject({ ok: true, blocking: false })
  })

  it('o boot confere com o AMBIENTE, antes das migrations e do listen (estático)', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const at = server.indexOf('assertCorsOrigins(ctx.corsOrigins, process.env.NODE_ENV)')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(server.indexOf('await runMigrations('))
    expect(at).toBeLessThan(server.search(/\.listen\(/))
    expect(server).not.toMatch(/assertCorsOrigins\(ctx\.corsOrigins\)/)
  })

  it('[gate ADV M1] o critério de produção é o do NÚCLEO (trim + minúsculas): `Production`/` production ` bloqueiam no pre-deploy como o boot recusa', () => {
    const core = require(path.join(path.dirname(require.resolve('fiscal-api/package.json')), 'dist', 'util', 'environment.js'))
    for (const v of [undefined, '', 'production', 'Production', ' production ', 'PRODUCTION', 'prod', 'development', 'production1']) {
      expect([v, isProductionEnv(v)]).toEqual([v, core.isProductionEnv(v)])
    }
    for (const NODE_ENV of ['Production', ' production ']) {
      expect(corsItem({ NODE_ENV, CORS_ORIGINS: 'http://app.setes.com.br' })).toMatchObject({ ok: false, blocking: true })
      expect(preDeployConfigItems({ NODE_ENV }).find(i => i.item === 'NODE_ENV')).toMatchObject({ ok: true })
    }
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    expect(server).toContain('isProductionEnv(process.env.NODE_ENV)')
    expect(server).not.toMatch(/NODE_ENV\s*===/)
  })

  it('[gate SOC M2] pre-deploy em produção BLOQUEIA com XML ainda no layout antigo (o build novo não o acharia); sem nenhum, passa', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'xml-'))
    const env = { NODE_ENV: 'production', STORAGE_PATH: root }
    const item = () => preDeployConfigItems(env).find(i => i.item === 'XML no layout D-F241')!
    fs.mkdirSync(path.join(root, '12345678000195', 'nfse', '1', '2026', '11', '17'), { recursive: true })
    expect(item()).toMatchObject({ ok: true, detail: 'nenhum arquivo no layout antigo' })
    fs.mkdirSync(path.join(root, '12345678000195', 'H', '2026', '09'), { recursive: true })
    fs.writeFileSync(path.join(root, '12345678000195', 'H', '2026', '09', 'DPS4106902212345678000195000010000000000000042-dps.xml'), '<DPS/>')
    expect(item()).toMatchObject({ ok: false, blocking: true, detail: expect.stringMatching(/1 arquivo\(s\) fora do layout novo[\s\S]*migrate:xml-layout/) })
  })

  it('pre-deploy, item STORAGE_PATH fora de produção sem a variável: confere <cwd>/storage (o padrão do núcleo) e só avisa', () => {
    const item = preDeployConfigItems({ NODE_ENV: 'development' }).find(i => i.item === 'STORAGE_PATH')!
    const dir = path.join(process.cwd(), 'storage')
    expect(item.blocking).toBe(false)
    expect(item.detail).toContain(dir)
    expect(item.ok).toBe(fs.existsSync(dir))
  })
})
