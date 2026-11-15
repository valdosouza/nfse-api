/// <reference types="jest" />
// DEPLOY.E1.P1.T2 (2026-11-15): a imagem de produção é Node 20 + `npm ci` + build e roda `node dist` (nunca tsx nem watch); variáveis e
// segredos ficam FORA do repositório e FORA da imagem. Esta máquina não tem docker: a cerca lê o Dockerfile e o .dockerignore.
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
const instructions = dockerfile.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

describe('imagem de produção da nfse-api (DEPLOY.E1.P1.T2)', () => {
  it('toda imagem base é Node 20', () => {
    const froms = instructions.filter(l => /^FROM /i.test(l))
    expect(froms.length).toBeGreaterThan(0)
    for (const f of froms) expect(f).toMatch(/^FROM node:20[-.\w]*( AS \w+)?$/i)
  })

  it('instala por `npm ci` (lock e pacote do núcleo do vendor/), compila e o estágio final só tem dependências de produção', () => {
    expect(instructions).toContain('RUN npm ci')
    expect(instructions).toContain('RUN npm run build')
    expect(instructions.some(l => /^RUN npm ci --omit=dev\b/.test(l))).toBe(true)
    expect(instructions.filter(l => l === 'COPY vendor ./vendor')).toHaveLength(2)
    expect(instructions.some(l => /npm install/.test(l))).toBe(false)
  })

  it('roda `node dist/server.js` em produção — o mesmo do `npm start`, nunca tsx nem watch', () => {
    expect(pkg.scripts.start).toBe('node dist/server.js')
    expect(instructions).toContain('ENV NODE_ENV=production')
    const cmd = instructions.filter(l => /^(CMD|ENTRYPOINT) /.test(l))
    expect(cmd).toEqual(['CMD ["node", "dist/server.js"]'])
    expect(instructions.join('\n')).not.toMatch(/\btsx\b|--watch|\bwatch\b/)
  })

  it('leva o que o dist lê do disco: migrations da família e o contrato OpenAPI', () => {
    expect(instructions).toContain('COPY src/migrations/sql ./src/migrations/sql')
    expect(instructions).toContain('COPY openapi ./openapi')
  })

  it('segredos fora do contexto da imagem: .env, secrets/ e storage/ no .dockerignore; nenhum COPY de .env ou chave', () => {
    for (const p of ['.env', '.env.*', 'secrets/', 'storage/', '.git/', 'node_modules/', 'dist/']) expect(ignore).toContain(p)
    expect(instructions.some(l => /^(COPY|ADD) /.test(l) && /\.env|secrets|\.pem|\.pfx|\.p12/.test(l))).toBe(false)
    expect(instructions.some(l => /^ENV /.test(l) && /(PASSWORD|MASTER_KEY|JWT_PUBLIC|DB_)/.test(l))).toBe(false)
  })

  it('não roda como root', () => {
    expect(instructions).toContain('USER node')
  })

  it('o pre-deploy check roda na imagem sem tsx (dist) e o Node exigido é o 20', () => {
    expect(pkg.scripts['predeploy:check']).toBe('node dist/pre-deploy-cli.js')
    expect(pkg.engines?.node).toBe('>=20')
  })
})
