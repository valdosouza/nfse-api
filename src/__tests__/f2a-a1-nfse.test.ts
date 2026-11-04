/// <reference types="jest" />
// F2a — etapa A1 na nfse-api (Rodada 1 da F2a e gates da A1, Valdo 2026-10-12 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22):
//  - D-F107/D-F103: migration 005 = CHECK BINÁRIO do `kind` da voz da NFS-e com a lista de ESCRITA da família (UMA fonte com o tipo);
//  - D-F120: CHECK BINÁRIO de `source` (P/Q) da voz e de `environment` (H/P) da tentativa, na mesma 005;
//  - D-F123: a 005 é RE-EXECUTÁVEL (`ADD CONSTRAINT IF NOT EXISTS`);
//  - sonda do boot (`assertServiceVoiceDomainsEnforced`): cada valor recusado pelo CHECK de NOME certo, PK própria por linha, sem a FK;
//  - D-F113: o boot confere as views do catálogo (`assertFamilyViewsReadable`).
// Puro: sem banco (driver simulado), sem fisco.
import fs from 'fs'
import path from 'path'
import {
  SERVICE_VOICE_WRITE_KINDS, SERVICE_VOICE_FAMILY, assertServiceVoiceDomainsEnforced, assertServiceStrictSession, SERVICE_KEY_LENGTH_PROBE_KEY,
} from '../nfse/voice-family'

const SRC = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const checkErr = (name: string) => Object.assign(new Error(`CONSTRAINT \`${name}\` failed for \`fiscal_api\`.\`t\``), { errno: 4025 })
/** A constraint que recusa cada sonda (pelo valor e pela tabela do INSERT) — o motor simulado com os CHECKs da 005. */
function engine(opts: { kindCi?: boolean; noChecks?: boolean; codePadSpace?: boolean; strict?: boolean } = {}) {
  return async (sql: string, p?: unknown[]): Promise<any> => {
    if (!/^INSERT/.test(sql)) return [{}]
    if (/^INSERT INTO tb_invoice_service_transmission \(.*access_key/.test(sql)) {
      // D-NE172: a sessão ESTRITA (padrão) recusa a chave maior que o VARCHAR(50) — 1406; sem ela o motor CORTA calado e aceita
      const key = String((p as unknown[])[0])
      if (key.length > 50 && opts.strict !== false) throw Object.assign(new Error("Data too long for column 'access_key' at row 1"), { errno: 1406, code: 'ER_DATA_TOO_LONG' })
      return [{ affectedRows: 1 }]
    }
    if (opts.noChecks) return [{ affectedRows: 1 }]
    if (sql.includes(SERVICE_VOICE_FAMILY.eventTable) && sql.includes('authority_code')) {
      // F2A3-ADV-02: o CHECK do código da voz C (006 — exato) × o da 002 (colação _ci, PAD SPACE: '105102 ' passava)
      const code = String((p as unknown[])[1])
      const compared = opts.codePadSpace ? code.replace(/ +$/, '') : code
      const ok = ['101101', '105102', '105104', '305101'].includes(compared)
      if (!ok) throw checkErr('ck_invoice_service_transmission_event_cancel_code')
      return [{ affectedRows: 1 }]
    }
    if (sql.includes(SERVICE_VOICE_FAMILY.eventTable)) {
      const [, kind, source] = p as string[]
      const kindOk = opts.kindCi ? ['A', 'R', 'C', 'K', 'F', 'N'].includes(kind.toUpperCase()) : (SERVICE_VOICE_WRITE_KINDS as readonly string[]).includes(kind)
      if (!kindOk) throw checkErr('ck_invoice_service_transmission_event_kind')
      if (!['P', 'Q'].includes(source)) throw checkErr('ck_invoice_service_transmission_event_source')
      return [{ affectedRows: 1 }]
    }
    const [, env] = p as [number, string]
    if (!['H', 'P'].includes(env)) throw checkErr('ck_invoice_service_transmission_environment')
    return [{ affectedRows: 1 }]
  }
}
function poolWith(onQuery: (sql: string, params?: unknown[]) => Promise<any>) {
  const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), destroy: jest.fn(), query: jest.fn(onQuery) }
  return { conn, pool: { getConnection: jest.fn(async () => conn) } as any }
}

describe('D-F107/D-F120 — os CHECKs da 005 são os domínios publicados', () => {
  const sql = read('migrations/sql/005_service_transmission_domains.sql')
  it('UMA fonte: o CHECK de `kind` tem EXATAMENTE `SERVICE_VOICE_WRITE_KINDS` (mesma ordem), em colação BINÁRIA, na tabela da voz do descritor', () => {
    const m = /ALTER TABLE `(\w+)`\s+ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_kind` CHECK \(`kind` COLLATE utf8mb4_bin IN \(([^)]*)\)\),/.exec(sql)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(SERVICE_VOICE_FAMILY.eventTable)
    expect(m![2].split(',').map(s => s.trim().replace(/'/g, ''))).toEqual([...SERVICE_VOICE_WRITE_KINDS])
  })
  it('D-F120: `source` P/Q (voz) e `environment` H/P (tentativa), binários; D-F123: tudo `IF NOT EXISTS` (re-executável)', () => {
    expect(sql).toMatch(/ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_source` CHECK \(`source` COLLATE utf8mb4_bin IN \('P', 'Q'\)\);/)
    expect(sql).toMatch(/ALTER TABLE `tb_invoice_service_transmission`\s+ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_environment` CHECK \(`environment` COLLATE utf8mb4_bin IN \('H', 'P'\)\);/)
    const adds = sql.replace(/--[^\n]*/g, '').match(/ADD CONSTRAINT/g) ?? []
    const ifNotExists = sql.replace(/--[^\n]*/g, '').match(/ADD CONSTRAINT IF NOT EXISTS/g) ?? []
    expect([adds.length, ifNotExists.length]).toEqual([3, 3])
  })
  it('sem S, P nem D no domínio da tabela da NFS-e (D-F102/D-F105) — o vocabulário COMUM segue com eles', () => {
    for (const k of ['S', 'P', 'D']) expect([k, (SERVICE_VOICE_WRITE_KINDS as readonly string[]).includes(k)]).toEqual([k, false])
  })
})

describe('a sonda do boot (D-F107/D-F120)', () => {
  it('kind S/f, source X/q e environment X/p — cada linha com PK PRÓPRIA (F2A1-07), SEM a FK (sessão restaurada), transações desfeitas → passa', async () => {
    const { conn, pool } = poolWith(engine())
    await expect(assertServiceVoiceDomainsEnforced(pool)).resolves.toBeUndefined()
    const inserts = conn.query.mock.calls.filter(c => /^INSERT/.test(c[0] as string))
    expect(inserts.map(c => c[1])).toEqual([[1, 'S', 'P'], [2, 'f', 'P'], [3, 'A', 'X'], [4, 'A', 'q'], [1, 'X'], [2, 'p'], [5, '105102 '], [6, '1051020']])
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls.filter(s => s === 'SET SESSION foreign_key_checks = 0')).toHaveLength(4)
    expect(sqls.filter(s => /^SET SESSION foreign_key_checks = 1$/.test(s))).toHaveLength(4)
    expect([conn.rollback.mock.calls.length, conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([4, 4, 0])
  })
  it('CHECK de `kind` _ci (recusa \'S\', aceita \'f\') → o boot FALHA alto; motor SEM CHECK (aceita tudo) → falha alto com o diagnóstico (nunca "Duplicate entry")', async () => {
    await expect(assertServiceVoiceDomainsEnforced(poolWith(engine({ kindCi: true })).pool)).rejects.toThrow(/NÃO é o domínio publicado/)
    await expect(assertServiceVoiceDomainsEnforced(poolWith(engine({ noChecks: true })).pool)).rejects.toThrow(/não aplica CHECK ou falta a migration/)
  })
  it('F2A3-ADV-02: CHECK do código da voz C ainda o da 002 (PAD SPACE aceita "105102 ") → o boot FALHA alto (a 006 não foi aplicada)', async () => {
    await expect(assertServiceVoiceDomainsEnforced(poolWith(engine({ codePadSpace: true })).pool)).rejects.toThrow(/NÃO é o domínio publicado|não aplica CHECK ou falta a migration/)
  })
  it('o boot da nfse-api roda as sondas (modelo — D-NE84 —, ambiente da habilitação, kind/source/ambiente da tentativa) e confere as views (D-F113) depois das migrations', () => {
    const server = read('server.ts')
    const at = (s: string) => server.indexOf(s)
    expect(at('await runMigrations(')).toBeGreaterThan(0)
    for (const call of ['await assertIssuerModelDomainEnforced(ctx.pool)', 'await assertIssuerEnvironmentDomainEnforced(ctx.pool)',
      'await assertServiceVoiceDomainsEnforced(ctx.pool)', 'await assertServiceStrictSession(ctx.pool)',
      'await assertFamilyViewsReadable(ctx.pool, ctx.fiscalDb)']) {
      expect([call, at(call) > at('await runMigrations(')]).toEqual([call, true])
    }
    // D-NE172: a prova da sessão estrita vem DEPOIS da conferência dos invariantes (que já exige o modo) e antes de ouvir
    expect(at('await assertServiceStrictSession(ctx.pool)')).toBeGreaterThan(at('await assertSessionInvariants(ctx.pool)'))
    expect(at('await assertServiceStrictSession(ctx.pool)')).toBeLessThan(at('.listen('))
  })
})

describe('D-NE172 — a sonda do boot prova a sessão ESTRITA na chave de acesso da NFS-e', () => {
  it('a sonda tem 51 posições (a coluna é VARCHAR(50), a chave do fisco tem 50) e grava sem a FK, numa transação desfeita', async () => {
    expect(SERVICE_KEY_LENGTH_PROBE_KEY).toHaveLength(51)
    const { conn, pool } = poolWith(engine())
    await expect(assertServiceStrictSession(pool)).resolves.toBeUndefined()
    const sqls = conn.query.mock.calls.map(c => c[0] as string)
    expect(sqls).toContain('SET SESSION foreign_key_checks = 0')
    expect([conn.rollback.mock.calls.length, conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([1, 1, 0])
  })
  it('cerca: nenhum código desta API cita sql_mode (o modo é do pool do núcleo — `SET sql_mode` aqui o desligaria sem o boot perceber)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : /\.[cm]?ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const roots = [SRC, path.resolve(SRC, '..', 'scripts')]
    const hits = roots.flatMap(walk).filter(f => /sql_mode/i.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')))
    expect(hits).toEqual([])
  })
  it('motor SEM a sessão estrita (corta nas 50 e aceita): o boot FALHA ALTO', async () => {
    await expect(assertServiceStrictSession(poolWith(engine({ strict: false })).pool))
      .rejects.toThrow(/ACEITOU a chave de acesso da tentativa da NFS-e maior que a coluna \(tb_invoice_service_transmission\.access_key com 51 posições\) — a sessão NÃO é estrita/)
  })
})
