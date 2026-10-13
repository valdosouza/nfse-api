/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 6 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F164, §22.20). Alvo: nfse-api `5e61686..391fef7` — `listRefreshCandidates` com o aviso opcional
// `onIncoherent`; a passada do rodízio (`refreshOpenServiceTransmissions`) pula a linha INCOERENTE com alarme (log + relatório com ref) e
// marca `last_queried_at`; sem o aviso, a lista falha alto como antes (o leitor da NOTA nunca a engole).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R6-ADV-NN SEV] …')` (descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Parte 1: o repositório REAL com o banco simulado na fronteira (só o `query`). Parte 2 (opt-in NFSE_ADV_LIVE=1): banco DESCARTÁVEL
// `fiscal_api_adv_r6` (cópia pelo harness — o `fiscal_api` real é vigiado por CHECKSUM), ERP só LIDO, fisco FALSO e rede bloqueada.
//   NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-r6-gate.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage } from 'fiscal-api'
import { listRefreshCandidates } from '../nfse/repository'
import { webScope, WEB } from './fixture-ref'

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

/** Linha CRUA como o `TX_SELECT` a devolve (aliases do SQL) — coerente por padrão: autorizada com chave. */
const raw = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: 'K'.repeat(50), authorityRecorded: 'S', nfseNumber: '42', dhProc: '2026-10-01 10:00:00', createdAt: '2026-10-01 10:00:00',
  ageMinutes: 9000, lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null,
  lastSource: 'P', lastDh: '2026-10-01 10:00:00', lastEventAt: '2026-10-01 10:00:00', lastEventAgeMinutes: 9000, ...over,
})
const noKey = { accessKey: null, authorityRecorded: 'N', nfseNumber: null }
const qOf = (rows: unknown[]) => ({ query: jest.fn(async () => [rows]) }) as any

// =================================================================================================
// 1. O aviso da linha incoerente na LISTA (repositório real, banco simulado)
// =================================================================================================
describe('1 — D-F164: `listRefreshCandidates` com e sem o aviso', () => {
  it('[RESISTIU] VÁRIAS incoerentes misturadas (A sem chave — D-F136; K e C sem chave — D-F154) entre coerentes: com o aviso, voltam só as coerentes NA ORDEM do SQL e o aviso recebe cada torta uma vez (nota + tentativa); sem o aviso, a lista inteira falha alto', async () => {
    const rows = [
      raw({ invoiceId: 1, ...noKey }), raw({ invoiceId: 2 }), raw({ invoiceId: 3, lastKind: 'K', ...noKey, attempt: 2 }),
      raw({ invoiceId: 4, lastKind: 'S', ...noKey }), raw({ invoiceId: 5, lastKind: 'C', ...noKey }), raw({ invoiceId: 6, lastKind: null, ...noKey }),
    ]
    const seen: [number, number, string][] = []
    const out = await listRefreshCandidates(qOf(rows), 'setes_setes', webScope(1), 5, 10, 50, {}, (r, e) => seen.push([r.invoiceId, r.attempt, e.message]))
    expect(out.map(t => t.invoiceId)).toEqual([2, 4, 6])
    expect(seen.map(s => [s[0], s[1]])).toEqual([[1, 1], [3, 2], [5, 1]])
    expect(seen[0][2]).toMatch(/D-F136/)
    expect(seen[1][2]).toMatch(/D-F154/)
    await expect(listRefreshCandidates(qOf(rows), 'setes_setes', webScope(1), 5, 10, 50, {})).rejects.toThrow(/INCOERENTE/)
  })

  it('[CORRIGIDO R6-ADV-04 LOW] o aviso engole também a PROJEÇÃO torta (a linha sem `nfseNotGeneratedAt`/`environment`/`authorityRecorded` — o SELECT que esqueceu a coluna, não o DADO): com o aviso, TODA linha vira "incoerente", a lista volta VAZIA e a passada marca `last_queried_at` em TODAS sem consultar o fisco — o rodízio para de consultar parecendo funcionar (N alarmes "tentativa incoerente" em vez de UMA falha alta; a revisita única do F da D-F52 é gasta sem pergunta; as autorizadas esperam 24 h). A D-F164 fala da LINHA incoerente (o dado: voz × registro). Correção sugerida: o aviso só para os erros de DADO (uma classe própria — ex.: `IncoherentRowError`); o resto sobe', async () => {
    const torta = [raw({ invoiceId: 1 }), raw({ invoiceId: 2 })].map(r => { const { nfseNotGeneratedAt: _x, ...rest } = r; return rest })
    const seen: number[] = []
    await expect(listRefreshCandidates(qOf(torta), 'setes_setes', webScope(1), 5, 10, 50, {}, r => seen.push(r.invoiceId)))
      .rejects.toThrow(/nfseNotGeneratedAt/)
  })

  it('[FATO] o aviso que LANÇA derruba a lista inteira (o comportamento de antes da D-F164) — hoje o aviso da passada só faz log/relatório/push e não lança', async () => {
    const rows = [raw({ invoiceId: 1, ...noKey }), raw({ invoiceId: 2 })]
    await expect(listRefreshCandidates(qOf(rows), 'setes_setes', webScope(1), 5, 10, 50, {}, () => { throw new Error('alarme quebrado') }))
      .rejects.toThrow(/alarme quebrado/)
  })
})

// =================================================================================================
// 2. PARTE VIVA (opt-in): NFSE_ADV_LIVE=1 — cópia descartável `fiscal_api_adv_r6`, ERP só lido, fisco falso
// =================================================================================================
const LIVE = process.env.NFSE_ADV_LIVE === '1'
if (!LIVE) it('ao vivo desligado (NFSE_ADV_LIVE=1 liga a parte 2)', () => { expect(LIVE).toBe(false) })
if (LIVE) describe('ao vivo — a passada REAL do rodízio sobre a cópia descartável (D-F164)', () => {
  jest.setTimeout(300_000)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { disposableFiscalDb } = require('./live-harness') as typeof import('./live-harness')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { contextFromEnv } = require('../context') as typeof import('../context')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tx = require('../nfse/transmission') as typeof import('../nfse/transmission')
  const ROOT = path.resolve(__dirname, '..', '..')
  const INST = 1
  const SCHEMA = 'setes_setes'
  const ACTOR = { schemaName: SCHEMA, institutionId: INST, userId: 990006 }
  const CNPJ = '07742094000113'
  const byKey = new Map<string, string>()
  const calls = { query: 0, dps: 0 }
  const nfseXml = (key: string, dpsId: string) =>
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>990001</nNFSe><dhProc>2026-10-12T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV R6</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
  const fakeAdapter: any = {
    authority: 'ADN',
    async transmit() { throw new Error('ADV R6: transmitir não é alvo') },
    async queryNfse(_c: unknown, key: string) {
      calls.query++
      const dpsId = byKey.get(key)
      if (!dpsId) throw new AuthorityHttpError(404, 'não encontrada (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')
      return { accessKey: key, status: 'authorized', nfseXml: nfseXml(key, dpsId), dhProc: '2026-10-12T10:00:00-03:00' }
    },
    async queryDpsAccessKey() { calls.dps++; return null },
    async registerEvent() { throw new Error('ADV R6: evento não é alvo') },
    async municipalTerms() { return { cancelDays: 60, raw: null } },
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r6-'))
  class SandboxStorage implements FiscalStorage {
    constructor(private real: FiscalStorage, private tmp: FsFiscalStorage) {}
    save(...a: Parameters<FiscalStorage['save']>) { return this.tmp.save(...a) }
    find(...a: Parameters<FiscalStorage['find']>) { return this.tmp.find(...a) ?? this.real.find(...a) }
    read(ref: string) { return fs.readFileSync(ref, 'utf8') }
    probe() { return this.tmp.probe() }
  }
  let harness: any
  let ctx: any
  const q = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p))[0] as any[]
  let B = 0, C = 0, A = 0                         // B = A sem chave (D-F136) · C = K sem chave (D-F154) · A = autorizada coerente
  const errorSpy = jest.spyOn(fiscal.logger, 'error').mockImplementation(() => undefined)
  const warnSpy = jest.spyOn(fiscal.logger, 'warn').mockImplementation(() => undefined)

  async function seed(inv: number, kind: 'A' | 'K', withKey: boolean): Promise<void> {
    const life = (await fiscal.erp.invoiceLife(ctx.pool, SCHEMA, fiscal.invoiceRef(INST, inv, WEB)))!.lifeEvent!
    const nDps = 980_000_000 + inv
    const dpsId = `DPS4106902${'2'}${CNPJ}00998${String(nDps).padStart(15, '0')}`
    const key = withKey ? (`41069022${CNPJ}98${String(inv).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50) : null
    await q(`INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
             VALUES (?, ?, 0, ?, '998', ?, ?, ?, NOW(), NOW(), 'N')`, [INST, inv, life, nDps, dpsId, ACTOR.userId])
    await q(`INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
             VALUES (?, ?, 0, 1, ?, 'H', ?, ?, DATE_SUB(NOW(), INTERVAL 1 DAY), NULL, ?, DATE_SUB(NOW(), INTERVAL 1 DAY), NOW(), 'N')`,
      [INST, inv, life, key, key ? '990001' : null, ACTOR.userId])
    await q(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
             VALUES (?, ?, 0, 1, 1, ?, NULL, 'SINTÉTICA (adversarial r6)', DATE_SUB(NOW(), INTERVAL 1 DAY), 'P', ?, DATE_SUB(NOW(), INTERVAL 1 DAY), NOW(), 'N')`,
      [INST, inv, kind, ACTOR.userId])
    if (key) byKey.set(key, dpsId)
  }
  const queriedAt = async (inv: number) =>
    (await q(`SELECT last_queried_at AS t FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = 1`, [INST, inv]))[0]?.t ?? null
  const mine = (r: any) => r.errors.filter((e: any) => [A, B, C].includes(e.invoiceId)).map((e: any) => e.invoiceId)

  beforeAll(async () => {
    dotenv.config({ path: path.join(ROOT, '.env') })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r6: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_r6', { turned: true })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    process.chdir(cwd)
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    expect(ctx.fiscalDb).toBe('fiscal_api_adv_r6')
    // 3 notas FRESCAS do ERP (só LIDO): vida vigente, sem tentativa em lugar nenhum — ordem crescente: B < C < A
    const used = new Set((await q(`SELECT DISTINCT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])).map(r => Number(r.id)))
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E'
        AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
      ORDER BY i.id ASC LIMIT 50`, [INST])
    const fresh = rows.map(r => Number(r.id)).filter(id => !used.has(id)).slice(0, 3)
    expect(fresh).toHaveLength(3)
    ;[B, C, A] = fresh
    await seed(B, 'A', false)
    await seed(C, 'K', false)
    await seed(A, 'A', true)
  })

  afterAll(async () => {
    errorSpy.mockRestore(); warnSpy.mockRestore()
    try { if (harness) await harness.drop() } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }) }
  })

  it('[RESISTIU] as duas incoerentes no TOPO do LIMIT (limite 1): cada passada pula UMA com alarme (log com ref + relatório INTERNAL) e a marca; a 3ª passada chega à coerente (sem fome); a passada seguinte não alarma de novo (24 h da autorizada / minutos da viva)', async () => {
    errorSpy.mockClear()
    // a ordem do SQL: vivas (K) antes das autorizadas; dentro do grupo, a menos olhada e o id — C (K), depois B, depois A
    const p1 = await tx.refreshOpenServiceTransmissions(ctx, ACTOR, { terminal: WEB, limit: 1 })
    expect([mine(p1), p1.checked]).toEqual([[C], 0])
    expect(p1.errors.find((e: any) => e.invoiceId === C)).toEqual({ invoiceId: C, code: 'INTERNAL', message: expect.stringMatching(/incoerente — pulada \(ref /) })
    expect(await queriedAt(C)).not.toBeNull()
    const p2 = await tx.refreshOpenServiceTransmissions(ctx, ACTOR, { terminal: WEB, limit: 1 })
    expect([mine(p2), p2.checked]).toEqual([[B], 0])
    expect(await queriedAt(B)).not.toBeNull()
    const before = calls.query
    const p3 = await tx.refreshOpenServiceTransmissions(ctx, ACTOR, { terminal: WEB, limit: 1 })
    expect([mine(p3), p3.checked, calls.query - before]).toEqual([[], 1, 1])           // a coerente foi CONSULTADA no fisco (falso)
    const p4 = await tx.refreshOpenServiceTransmissions(ctx, ACTOR, { terminal: WEB, limit: 50 })
    expect(mine(p4)).toEqual([])
    const alarms = errorSpy.mock.calls.filter(c => /INCOERENTE pulada/.test(String(c[0]))).map(c => (c[1] as any).invoiceId)
    expect(alarms).toEqual([C, B])
  })

  it('[RESISTIU] o leitor da NOTA segue falhando ALTO na incoerente (dois leitores, uma resposta) e lê a coerente', async () => {
    await expect(tx.getServiceFiscalView(ctx, ACTOR, fiscal.invoiceRef(INST, B, WEB))).rejects.toThrow(/INCOERENTE/)
    await expect(tx.getServiceFiscalView(ctx, ACTOR, fiscal.invoiceRef(INST, C, WEB))).rejects.toThrow(/INCOERENTE/)
    const v = await tx.getServiceFiscalView(ctx, ACTOR, fiscal.invoiceRef(INST, A, WEB))
    expect([v.state, v.currentAttempt]).toEqual(['authorized', 1])
  })

  it('[FATO — D-F164] a marca da incoerente é o carimbo "consultada" SEM consulta: depois de corrigida a linha (a chave posta à mão), ela fica fora do rodízio até o prazo da classe passar (24 h na autorizada) — e a tela, quando voltar a ler, diz "Última consulta" com a hora do pulo', async () => {
    const stamp = await queriedAt(B)
    await q(`UPDATE tb_invoice_service_transmission SET access_key = ? WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt = 1`,
      [(`41069022${CNPJ}97${String(B).padStart(8, '0')}` + '0'.repeat(50)).slice(0, 50), INST, B])
    const ids = (await listRefreshCandidates(ctx.pool, SCHEMA, webScope(INST), 5, 10, 50, { authorizedMaxDays: 90 })).map(t => t.invoiceId)
    expect(ids).not.toContain(B)
    const v = await tx.getServiceFiscalView(ctx, ACTOR, fiscal.invoiceRef(INST, B, WEB))
    expect(v.transmissions[0].lastQueriedAt).not.toBeNull()
    expect(stamp).not.toBeNull()
  })
})
