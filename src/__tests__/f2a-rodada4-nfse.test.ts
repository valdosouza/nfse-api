/// <reference types="jest" />
// F2a — Rodada 4 / F2b Rodada 1 (Valdo 2026-10-13: "siga as recomendações" — `prompt_apis_fiscais_isoladas.md` §22.16), lado da nfse-api:
// D-F146 (CORS explícito: o boot recusa lista vazia e "*"). D-F145 (filtro do ramo nas pendentes) está no `adversarial-f1r8`; D-F142
// (`currentAttempt` na visão) no teste da visão.
import fs from 'fs'
import path from 'path'
import { assertCorsOrigins } from '../cors-origins'

describe('D-F146 — CORS_ORIGINS explícita por ambiente', () => {
  it('lista vazia → o boot RECUSA (o app cairia em "Failed to fetch" sem diagnóstico)', () => {
    expect(() => assertCorsOrigins([])).toThrow(/CORS_ORIGINS vazia[\s\S]*D-F146/)
  })
  it('"*", caminho, curinga no host, esquema estranho ou lixo → RECUSA (o token do usuário no navegador falaria com qualquer site)', () => {
    for (const bad of ['*', 'http://localhost:5051/', 'https://app.setes.com.br/app', 'https://*.setes.com.br', 'ftp://x', 'localhost:5051', 'http://a b']) {
      expect(() => assertCorsOrigins(['http://localhost:5051', bad])).toThrow(/ORIGEM canônica/)
    }
  })
  it('origens na forma do navegador (esquema://host[:porta]) → passa e o boot as registra', () => {
    expect(assertCorsOrigins(['http://localhost:5051', 'https://app.setes.com.br'])).toBe('http://localhost:5051, https://app.setes.com.br')
  })
  it('o boot confere ANTES das migrations; o exemplo do .env declara a porta do app de dev (5051)', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    expect(server.indexOf('assertCorsOrigins(ctx.corsOrigins)')).toBeGreaterThan(0)
    expect(server.indexOf('assertCorsOrigins(ctx.corsOrigins)')).toBeLessThan(server.indexOf('await runMigrations('))
    expect(fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8')).toMatch(/^CORS_ORIGINS=http:\/\/localhost:5051$/m)
  })
})
