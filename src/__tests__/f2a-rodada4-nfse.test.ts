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

// D-F154 (= Q-F159 (a), Valdo 2026-10-13): a voz que PRESSUPÕE a autorização (C cancelada, K cancelamento em voo) sem registro é linha
// incoerente — o `mapTx` falha ALTO como o mapa comum do núcleo (dois leitores, uma resposta); a mesma linha registrada passa.
describe('D-F154 — C/K ⇒ registro também no mapTx da nfse-api', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mapTx } = require('../nfse/repository') as typeof import('../nfse/repository')
  const raw = (over: Record<string, unknown>) => ({
    institutionId: 1, invoiceId: 7400, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 10, dpsId: 'DPS1',
    accessKey: null, authorityRecorded: 'N', nfseNumber: null, dhProc: null, createdAt: '2026-10-10 12:00:00', ageMinutes: 1,
    lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 2, lastKind: 'C', lastCode: '101101', lastMessage: null, lastSource: 'P',
    lastDh: null, lastEventAt: null, lastEventAgeMinutes: 1, ...over,
  })
  it('C e K sem registro → falha ALTO (D-F154); com registro (a chave do fisco) passa', () => {
    for (const lastKind of ['C', 'K']) {
      expect(() => mapTx(raw({ lastKind }))).toThrow(/D-F154/)
      expect(mapTx(raw({ lastKind, authorityRecorded: 'S', accessKey: '4106902'.padEnd(50, '0') })).lastKind).toBe(lastKind)
    }
    for (const lastKind of ['R', 'F', 'S', null]) expect(() => mapTx(raw({ lastKind }))).not.toThrow()
  })
})
