/// <reference types="jest" />
// GATE ADVERSARIAL r10 — delta NÃO COMITADO de 2026-10-04: D-F51 (a consulta grava F "sem resposta" com o MESMO critério do
// transmitir — `refreshServiceTransmission` × `recordInterruptedFailure`) + D-F50 (a virada exige o FATO de que a F2a do
// setes-api está aplicada — `_migrations.name = 'f2a_fiscal_passivo'` no schema do cliente).
// Revisor independente — não fez a entrega (testar-adversarial.md §4-6).
// Achado CONFIRMADO = `it.failing('[r10-…]')` (PASSA enquanto o bug existe; quando a correção entrar, vira `it`), com um
// `it` de CENÁRIO ao lado. Ataque que o código RESISTIU = `it` normal. Só unitário (mocks na fronteira) — nenhum banco,
// nenhum fisco (o adaptador ADN REAL roda com o `transport` do núcleo trocado).
//
// Achados deste arquivo:
//  - [LOW — r10-lost-race-stale — CORRIGIDO 2026-10-04] a consulta que PERDE a corrida do F (sob a trava a tentativa já tem voz — outra consulta
//    ou o `reconcileInterrupted` do transmitir gravou antes) devolve `kind: null` ("em voo") embora a trava tenha acabado
//    de LER a voz final; e ainda grava `last_queried_at` DEPOIS do F do vencedor com o GET /dps feito ANTES dele — a prova
//    D-F29 (`last_queried_at` > instante do F) nasce de uma consulta que não é posterior ao F. Variante nova da D-F51
//    (rodízio × tela, ambos escritores de F); a do transmitir × consulta já existia.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import * as txMod from '../nfse/transmission'
import { FsFiscalStorage, MasterKeyRing } from 'fiscal-api'
import type { NfseDeps } from '../nfse/transmission'
import { adnAdapter } from '../authority/adn'

/** Gate da Rodada 18 (R18-03/R18-04): a prova exige a IDENTIDADE da candidata e a VIDA — os testes antigos de 1 argumento passam por aqui. */
const proven = (c: any, life?: any[]) => {
  const cc = { dpsId: 'DPS-TESTE', environment: 'P', lastKind: 'F', ...c }   // D-F101: a candidata é a F por consulta (lastKind ausente = viva)
  return actualFiscal.reconfirmationProven(cc, life ?? [cc])
}

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    openIssuer: jest.fn(actual.openIssuer),
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), institutionZone: jest.fn(),
      orderInterface: jest.fn(), userHasPrivilege: jest.fn(), institutionHasInterface: jest.fn(), assertInstitutionSchema: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getTransmission: jest.fn(), latestTransmission: jest.fn(), findTransmissionEventByKind: jest.fn(), insertTransmissionEvent: jest.fn(),
    findTransmissionByDpsId: jest.fn(), touchQueriedAt: jest.fn(), fillAuthorityData: jest.fn(), hasTransmissionEvent: jest.fn(),
    emitterCnpj: jest.fn(),
  }
})

const actualFiscal = jest.requireActual('fiscal-api')
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const fM = fiscal as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r10-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const realTransportRequest = actualFiscal.transport.request
beforeEach(() => {
  jest.clearAllMocks()
  fM.openIssuer.mockImplementation(actualFiscal.openIssuer)
  actualFiscal.transport.request = realTransportRequest
})
afterAll(() => { actualFiscal.transport.request = realTransportRequest })

// ===========================================================================
// Montagem comum da consulta (rota por nota e passada usam a MESMA função)
// ===========================================================================
const INVOICE = 7200
const DPS = 'DPS' + '4'.repeat(42)
const KEY = '4'.repeat(50)
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const pool = { query: jest.fn(async () => [[]]), getConnection: jest.fn() } as any
const mkDeps = (a: any = adapter): NfseDeps =>
  ({ pool, keyring: MasterKeyRing.of({ 1: Buffer.alloc(32, 9) }), storage: new FsFiscalStorage(storageRoot), adapter: a, fiscalDb: 'fiscal_api' })
const deps = mkDeps()
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990010 }

const tx = (over: Record<string, any> = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 72, dpsId: DPS,
  accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-10-04 10:00:00', ageMinutes: 15, lastQueriedAt: null,
  lastEvent: null, lastKind: null, lastCode: null, lastMessage: null, lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null,
  ...over,
})
const conn = { beginTransaction: jest.fn(), query: jest.fn(async () => [[]]), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }

/** Em voo [over] (pool) e, sob a trava, [underLock] (default: a mesma, ainda sem voz). */
function arrange(over: Record<string, any> = {}, underLock?: Record<string, any> | null, issuerEnv: 'H' | 'P' = 'P') {
  const t0 = tx(over)
  pool.getConnection.mockResolvedValue(conn)
  erpM.invoiceLife.mockResolvedValue({ lifeEvent: 1, lastEvent: 1, lastKind: 'E', alive: true })
  erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
  repoM.latestTransmission.mockResolvedValue(t0)
  repoM.getTransmission.mockImplementation(async (q: any) => (q === conn ? (underLock === null ? null : tx({ ...over, ...(underLock ?? {}) })) : t0))
  repoM.findTransmissionByDpsId.mockResolvedValue(null)
  repoM.touchQueriedAt.mockResolvedValue(undefined)
  repoM.insertTransmissionEvent.mockResolvedValue(1)
  fM.openIssuer.mockResolvedValue({ issuer: { model: 'SE', environment: issuerEnv, serie: '1', cutoverAt: '2026-10-04 09:00:00' }, cert: 'c', key: 'k' })
  adapter.queryDpsAccessKey.mockResolvedValue(null)
  return t0
}
const fKinds = () => repoM.insertTransmissionEvent.mock.calls.map(c => c[5]?.kind)

// ===========================================================================
// 1. D-F51 — "ambíguo nunca fecha": o F só nasce do E2404 estruturado
// ===========================================================================
describe('D-F51 — fisco lento/fora: só o "não gerada" CONCLUSIVO vira F', () => {
  const unavailable = new actualFiscal.AuthorityHttpError(503, 'Fisco indisponível', actualFiscal.ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, '')
  const unknown = new actualFiscal.AuthorityHttpError(502, '404 sem resposta estruturada', actualFiscal.ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 404, '<html/>')
  const authFailed = new actualFiscal.AuthorityHttpError(409, 'Fisco recusou a autenticação (403)', actualFiscal.ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, 403, '')

  it.each([
    ['503 indisponível (timeout/5xx/429)', unavailable],
    ['502 resposta ilegível (404 de gateway)', unknown],
    ['409 credencial recusada (403 do ADN)', authFailed],
    ['erro técnico cru', new Error('ECONNRESET')],
  ])('resistiu: em voo há 4000 min + queryDpsAccessKey LANÇA (%s) → erro sobe, nenhuma transação, nenhum F, nenhum touch', async (_n, err) => {
    arrange({ ageMinutes: 4000 })
    adapter.queryDpsAccessKey.mockRejectedValue(err)
    await expect(txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })).rejects.toBe(err)
    expect(pool.getConnection).not.toHaveBeenCalled()
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repoM.touchQueriedAt).not.toHaveBeenCalled()
  })

  describe('adaptador ADN REAL (transport do núcleo trocado) — o null só sai do E2404', () => {
    const real = mkDeps(adnAdapter)
    const respond = (status: number, text: string) => { actualFiscal.transport.request = jest.fn(async () => ({ status, headers: {}, text })) }

    it.each([
      ['404 HTML do gateway', 404, '<html><body>Not Found</body></html>'],
      ['404 vazio', 404, ''],
      ['404 JSON sem código', 404, '{"mensagem":"rota inexistente"}'],
      ['404 JSON com OUTRO código', 404, '{"erro":{"codigo":"E0001","descricao":"x"}}'],
      ['200 sem chave', 200, '{"tipoAmbiente":1}'],
      ['500', 500, '{"erro":{"codigo":"E2404"}}'],
    ])('resistiu: %s → ambíguo (lança), a tentativa fica em voo', async (_n, status, text) => {
      arrange({ ageMinutes: 4000 })
      respond(status, text)
      await expect(txMod.refreshServiceTransmission(real, ACTOR, INVOICE, 'Q', { attempt: 1 })).rejects.toBeInstanceOf(actualFiscal.AuthorityHttpError)
      expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
      expect(pool.getConnection).not.toHaveBeenCalled()
    })

    it('resistiu (controle): 404 com E2404 estruturado do fisco, ≥ 10 min → F "sem resposta" (source Q) sob a trava', async () => {
      arrange({ ageMinutes: 10 })
      respond(404, '{"tipoAmbiente":1,"dataHoraProcessamento":"2026-10-04T10:00:00-03:00","erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e com o identificador de DPS informado"}}')
      const r = await txMod.refreshServiceTransmission(real, ACTOR, INVOICE, 'Q', { attempt: 1 })
      expect(r).toMatchObject({ changed: true, kind: 'F', accessKey: null, localCancelPending: false })
      expect(repoM.insertTransmissionEvent).toHaveBeenCalledWith(conn, 1, INVOICE, 1, ACTOR.userId, expect.objectContaining({ kind: 'F', source: 'Q' }))
      const call = (actualFiscal.transport.request as jest.Mock).mock.calls[0][0]
      expect(call.url).toBe(`https://sefin.nfse.gov.br/SefinNacional/dps/${DPS}`)       // produção: host do ambiente da TENTATIVA
    })
  })
})

// ===========================================================================
// 2. D-F51 — relógio, ambiente congelado, irmã que detém a chave
// ===========================================================================
describe('D-F51 — idade (do BANCO), ambiente da tentativa, holder', () => {
  it.each([
    [9, false], [10, true], [null, false],
  ])('resistiu: ageMinutes=%s (TIMESTAMPDIFF no banco, created_at = reserva) → F=%s', async (age, wantF) => {
    arrange({ ageMinutes: age })
    const r = await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })
    expect(r.kind).toBe(wantF ? 'F' : null)
    expect(fKinds()).toEqual(wantF ? ['F'] : [])
    if (!wantF) {
      expect(pool.getConnection).not.toHaveBeenCalled()
      expect(repoM.touchQueriedAt).toHaveBeenCalledWith(pool, 1, INVOICE, 1)
    }
  })

  it('resistiu: a idade vem do SQL (NOW() do servidor do banco − created_at da RESERVA), nunca do relógio do Node', () => {
    // o SELECT comum (TX_SELECT) é o único produtor do campo; mapTx só o converte
    const src = fs.readFileSync(path.join(__dirname, '..', 'nfse', 'repository.ts'), 'utf8')
    expect(src).toMatch(/TIMESTAMPDIFF\(MINUTE, t\.created_at, NOW\(\)\) AS ageMinutes/)
    expect(src).toMatch(/VALUES \(\?, \?, 0, \?, \?, \?, \?, NOW\(\), NOW\(\), 'N'\)/)     // created_at da tentativa = NOW() do banco
  })

  it('resistiu: tentativa de HOMOLOGAÇÃO com o emissor hoje em PRODUÇÃO → pergunta no ambiente CONGELADO (H); o F de H não prende a nota (D-F29)', async () => {
    arrange({ environment: 'H' }, undefined, 'P')
    await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })
    expect(adapter.queryDpsAccessKey.mock.calls[0][0].environment).toBe('H')
    expect(repoM.findTransmissionByDpsId).toHaveBeenCalledWith(pool, 1, INVOICE, 1, DPS, 'H')
    expect(fKinds()).toEqual(['F'])
    const fH = { attempt: 1, lastKind: 'F', lastSource: 'Q', environment: 'H', accessKey: null, authorityRecorded: false, dpsId: DPS }   // NE-1a: o fato do registro
    expect(actualFiscal.reconfirmationCandidate([fH])).toBeNull()
    expect(actualFiscal.reconfirmationCandidate([{ ...fH, environment: 'P' }])).toMatchObject({ attempt: 1 })   // o de P exige a reconfirmação
  })

  it('resistiu: irmã que DETÉM a chave → consulta pela chave, nenhum GET /dps, nenhum F "sem resposta"', async () => {
    arrange({ attempt: 2 })
    repoM.findTransmissionByDpsId.mockResolvedValue(tx({ attempt: 1, accessKey: KEY, lastKind: 'A' }))
    adapter.queryNfse.mockRejectedValue(new actualFiscal.AuthorityHttpError(503, 'fora', actualFiscal.ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, 0, ''))
    await expect(txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 2 })).rejects.toBeTruthy()
    expect(adapter.queryDpsAccessKey).not.toHaveBeenCalled()
    expect(adapter.queryNfse).toHaveBeenCalledWith(expect.anything(), KEY)
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it('resistiu: irmã SEM chave (tentativa 1 já F, mesmo Id da vida) → o F da D-F51 pousa na tentativa EM VOO (2), nunca na irmã', async () => {
    arrange({ attempt: 2 })
    repoM.findTransmissionByDpsId.mockResolvedValue(tx({ attempt: 1, lastKind: 'F', lastSource: 'Q' }))
    await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 2 })
    expect(repoM.insertTransmissionEvent).toHaveBeenCalledTimes(1)
    expect(repoM.insertTransmissionEvent.mock.calls[0][3]).toBe(2)
    expect(repoM.touchQueriedAt.mock.calls.every(c => c[3] === 2)).toBe(true)
  })
})

// ===========================================================================
// 3. D-F51 — travas, corrida com o transmitir, prova D-F29
// ===========================================================================
describe('D-F51 — ordem de travas, corrida com o POST em curso, prova da reconfirmação', () => {
  it('resistiu: nota → tentativa (lockInvoice 1º; nada de emissor/DPS na transação) e touch ANTES do F (a consulta que gera o F nunca se auto-prova)', async () => {
    arrange()
    await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })
    const lock = erpM.lockInvoice.mock.invocationCallOrder[0]
    const read = repoM.getTransmission.mock.calls.findIndex(c => c[0] === conn)
    const readOrder = repoM.getTransmission.mock.invocationCallOrder[read]
    const touchIdx = repoM.touchQueriedAt.mock.calls.findIndex(c => c[0] === conn)
    const touchOrder = repoM.touchQueriedAt.mock.invocationCallOrder[touchIdx]
    const insOrder = repoM.insertTransmissionEvent.mock.invocationCallOrder[0]
    expect(lock).toBeLessThan(readOrder)
    expect(readOrder).toBeLessThan(touchOrder)
    expect(touchOrder).toBeLessThan(insOrder)
    expect(erpM.lockInvoice.mock.calls[0][0]).toBe(conn)
    expect(fM.openIssuer.mock.calls.every(c => !c[3]?.forUpdate && !c[3]?.conn)).toBe(true)       // emissor fora da transação
    // D-F90: a prova é o E2404 explícito (`nfseNotGeneratedAt`), não o touch; e mesmo ele, no mesmo segundo do F (a consulta que o
    // GEROU) ou antes, não prova — estritamente maior. O F que fecha a reserva nunca grava a prova (recordInterruptedFailure)
    expect(proven({ nfseNotGeneratedAt: '2026-10-04 10:00:00', lastEventAt: '2026-10-04 10:00:00' })).toBe(false)
    expect(proven({ nfseNotGeneratedAt: '2026-10-04 10:00:00', lastEventAt: '2026-10-04 10:00:01' })).toBe(false)
    expect(conn.query.mock.calls.some((c: any[]) => /nfse_not_generated_at/.test(String(c[0])))).toBe(false)
    expect(conn.commit).toHaveBeenCalled()
  })

  it('resistiu: passada com a candidata VELHA (tentativa 3) enquanto o transmitir já a fechou e POSTA a 4 → reconfere a 3 sob a trava, nada escrito, a 4 intocada', async () => {
    arrange({ attempt: 3 }, { lastKind: 'F', lastSource: 'Q' })
    const r = await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 3 })
    expect(repoM.getTransmission).toHaveBeenCalledWith(conn, 1, INVOICE, 3)
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repoM.touchQueriedAt.mock.calls.every(c => c[3] === 3)).toBe(true)
    expect(r.attempt).toBe(3)
  })

  it('resistiu: rota por nota SEM attempt durante o POST da tentativa nova (idade 0) → só "olhamos"; nenhuma transação', async () => {
    arrange({ attempt: 4, ageMinutes: 0 })
    const r = await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q')
    expect(r).toMatchObject({ attempt: 4, changed: false, kind: null })
    expect(pool.getConnection).not.toHaveBeenCalled()
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
  })

  it('resistiu: nota sumida no ERP entre a leitura e a trava → 404, nada gravado', async () => {
    arrange()
    erpM.lockInvoice.mockResolvedValue(null)
    await expect(txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })).rejects.toMatchObject({ statusCode: 404 })
    expect(repoM.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('resistiu: o F da D-F51 é sempre source Q em produção → candidato da reconfirmação D-F29 (o setes-api exige consulta POSTERIOR)', async () => {
    arrange()
    await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })
    const ev = repoM.insertTransmissionEvent.mock.calls[0][5]
    expect(ev).toMatchObject({ kind: 'F', source: 'Q' })
    expect(actualFiscal.reconfirmationCandidate([{ attempt: 1, lastKind: ev.kind, lastSource: ev.source, environment: 'P', accessKey: null, authorityRecorded: false, dpsId: DPS }]))
      .toMatchObject({ attempt: 1 })
  })

  // --- r10-lost-race-stale ---
  // [corrigido 2026-10-04] devolve a voz lida sob a trava e não carimba
  it('[r10-lost-race-stale][corrigido] quem perde a corrida devolve a voz que a trava LEU (F/A) e não carimba last_queried_at com uma consulta anterior ao F', async () => {
    arrange({}, { lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-04 10:15:00' })
    const r = await txMod.refreshServiceTransmission(deps, ACTOR, INVOICE, 'Q', { attempt: 1 })
    expect(r.kind).toBe('F')
    expect(repoM.touchQueriedAt.mock.calls.some(c => c[0] === pool)).toBe(false)
  })
})

// ===========================================================================
// 4. D-F50 — `migrate:setes --cutover` confere a F2a do setes-api (script INTEIRO com pool falso)
// ===========================================================================
describe('D-F50 — a virada confere `_migrations.name = f2a_fiscal_passivo` no schema do cliente', () => {
  type Handler = (sql: string, p: any[]) => any
  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)

  async function runScript(argv: string[], handler: Handler) {
    const sqls: { sql: string; p: any[]; tx: boolean }[] = []
    let inTx = false
    const conn: any = {
      beginTransaction: jest.fn(async () => { inTx = true }), commit: jest.fn(async () => { inTx = false }),
      rollback: jest.fn(async () => { inTx = false }), release: jest.fn(),
      query: jest.fn(async (sql: string, p: any[] = []) => {
        sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), p, tx: inTx })
        const out = handler(sql, p)
        if (out instanceof Error) throw out
        if (out !== undefined) return out
        return isWrite(sql) ? [{ affectedRows: 0 }] : [[]]
      }),
    }
    let ended!: () => void
    const done = new Promise<void>(r => { ended = r })
    const p: any = { query: conn.query, getConnection: jest.fn(async () => conn), end: jest.fn(async () => ended()) }
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    const errors: string[] = [], logs: string[] = []
    const err = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.map(String).join(' ')) })
    const log = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')) })
    const prevArgv = process.argv
    process.env.SETES_SECRETS_PATH = path.join(storageRoot, 'sem-cofre')
    process.argv = ['node', 'migrate-from-setes-api.ts', ...argv]
    try {
      jest.isolateModules(() => {
        const f = require('fiscal-api')
        f.createFiscalPool.mockReturnValue(p)
        jest.spyOn(f.MasterKeyRing, 'fromEnv').mockReturnValue(f.MasterKeyRing.of({ 1: Buffer.alloc(32, 3) }))
        require('../../scripts/migrate-from-setes-api')
      })
      await done
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    } finally {
      process.argv = prevArgv
    }
    const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, conn, pool: p, sqls }
    exit.mockRestore(); err.mockRestore(); log.mockRestore()
    return res
  }

  const mysqlErr = (errno: number, code: string, message: string) => Object.assign(new Error(message), { errno, code })
  /** ERP com a SE viva e fiscal_api réplica; [f2a] decide a leitura do `_migrations`. */
  const cutoverDb = (f2a: () => any, schema = 'setes_x'): Handler => {
    let turned = false
    return (sql) => {
      if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: schema }]]
      if (/\._migrations WHERE name = \?/.test(sql)) return f2a()
      if (/dps_last_number AS n FROM `setes_x`\.tb_establishment_issuer .*FOR UPDATE/s.test(sql)) return [[{ model: 'SE', serie: '1', deleted: 'N', n: 10 }]]
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(sql)) return [[{ model: 'SE', c: null }]]
      if (/information_schema\.tables/.test(sql)) return [[{ x: 1 }]]
      if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = \?$/.test(sql.trim())) {
        return [[{ tb_institution_id: 1, model: 'SE', environment: 'P', serie: '1', dps_last_number: 10, tb_user_id: null, created_at: null, updated_at: null, deleted: 'N' }]]
      }
      if (/invoice_event IS NULL/.test(sql)) return [[{ n: 0 }]]
      if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(sql)) return [[{ m: 0 }]]
      if (/SUM\(cutover_at IS NULL\)/.test(sql)) return [[{ n: 1, r: turned ? 0 : 1 }]]
      if (/^\s*UPDATE tb_establishment_issuer SET cutover_at/.test(sql)) { turned = true; return [{ affectedRows: 1 }] }
      if (/UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(sql)) return [{ affectedRows: 1 }]
      return undefined
    }
  }
  const CUT = ['--cutover', '1', '--confirmo-setes-api-parado']
  const noTable = () => mysqlErr(1146, 'ER_NO_SUCH_TABLE', "Table 'setes_x._migrations' doesn't exist")
  const denied = () => mysqlErr(1142, 'ER_TABLEACCESS_DENIED_ERROR', "SELECT command denied to user 'fiscal_api'@'%' for table '_migrations'")
  const lost = () => mysqlErr(0, 'PROTOCOL_CONNECTION_LOST', 'Connection lost: The server closed the connection.')

  it('resistiu: a leitura é PARAMETRIZADA, no schema da institution, pelo nome que o runner do setes-api grava, em AUTOCOMMIT antes da transação', async () => {
    const r = await runScript([...CUT, '--dry-run'], cutoverDb(() => [[{ x: 1 }]]))
    const q = r.sqls.find(s => /_migrations/.test(s.sql))!
    expect(q.sql).toBe('SELECT 1 AS x FROM `setes_x`._migrations WHERE name = ? LIMIT 1')
    expect(q.p).toEqual(['f2a_fiscal_passivo'])
    expect(q.tx).toBe(false)
    // runner.ts do setes-api (linhas 20-22): `const [version, ...rest] = file.replace('.sql', '').split('_'); name = rest.join('_')`
    const runnerName = (file: string) => { const [, ...rest] = file.replace('.sql', '').split('_'); return rest.join('_') }
    expect(runnerName('066_f2a_fiscal_passivo.sql')).toBe(q.p[0])
    expect(runnerName('0661_f2a_fiscal_passivo.sql')).toBe(q.p[0])                // versão com mais dígitos também casa
    expect(r.logs.join(' ')).not.toMatch(/bloqueios/)
  })

  it.each([
    ['tabela ausente (errno 1146)', noTable],
    ['tabela ausente só pelo code', () => Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' })],
    ['migration não registrada', () => [[]]],
  ])('resistiu: %s → o ato REAL recusa antes de abrir a transação (nada escrito); o --dry-run reporta o bloqueio', async (_n, f2a) => {
    const real = await runScript([...CUT, '--vai'], cutoverDb(f2a))
    expect(real.exitCode).toBe(1)
    expect(real.errors.join(' ')).toMatch(/F2a do setes-api não está aplicada/)
    expect(real.conn.beginTransaction).not.toHaveBeenCalled()
    expect(real.sqls.some(s => isWrite(s.sql))).toBe(false)
    const dry = await runScript([...CUT, '--dry-run'], cutoverDb(f2a))
    expect(dry.exitCode).toBeNull()
    expect(dry.logs.join(' ')).toMatch(/"bloqueios"[\s\S]*D-F50/)
    expect(dry.conn.commit).not.toHaveBeenCalled()
  })

  it.each([
    ['permissão negada (1142)', denied, /SELECT command denied/],
    ['conexão perdida', lost, /Connection lost/],
  ])('resistiu: %s NÃO vira "sem F2a" nem "F2a presente" — sobe cru, real E dry-run, antes de qualquer transação (fail-closed)', async (_n, f2a, msg) => {
    for (const argv of [[...CUT, '--vai'], [...CUT, '--dry-run']]) {
      const r = await runScript(argv, cutoverDb(f2a))
      expect(r.exitCode).toBe(1)
      expect(r.errors.join(' ')).toMatch(msg)
      expect(r.errors.join(' ')).not.toMatch(/não está aplicada/)
      expect(r.conn.beginTransaction).not.toHaveBeenCalled()
      expect(r.logs.join(' ')).not.toMatch(/"committed"/)
    }
  })

  it('resistiu: schema hostil vindo do tb_institution → assertSchema recusa ANTES de montar o SQL do _migrations', async () => {
    const r = await runScript([...CUT, '--vai'], cutoverDb(() => [[{ x: 1 }]], 'setes_x`._migrations; --'))
    expect(r.exitCode).toBe(1)
    expect(r.sqls.some(s => /_migrations/.test(s.sql))).toBe(false)
    expect(r.conn.beginTransaction).not.toHaveBeenCalled()
  })

  it('resistiu: sem --confirmo a conferência nem roda (recusa antes de qualquer leitura)', async () => {
    const r = await runScript(['--cutover', '1'], cutoverDb(() => [[{ x: 1 }]]))
    expect(r.exitCode).toBe(1)
    expect(r.sqls).toHaveLength(0)
  })

  it('resistiu: a re-sincronia (sem --cutover) não depende da F2a — nunca lê o _migrations', async () => {
    const r = await runScript(['--dry-run'], (sql) => {
      if (/SELECT id, schema_name AS schemaName FROM setes_central\.tb_institution WHERE deleted = 'N'/.test(sql)) return [[]]
      return undefined
    })
    expect(r.sqls.some(s => /_migrations/.test(s.sql))).toBe(false)
  })
})
