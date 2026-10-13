/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 7 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F164/D-F153/D-F162, §22.22). Alvo: nfse-api `391fef7..7bf6ea9` — `IncoherentTransmissionError`
// (o rodízio pula SÓ a incoerência de DADO; a projeção torta relança — R6-SOC-07/R6-ADV-04) e o ato `migrate:setes --cutover` que
// reconhece a LÁPIDE da F2a abortada para dizer COMO voltar (R6-SOC-10).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R7-ADV-NN SEV] …')` (descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r7-gate --runInBand
// Nada aqui toca banco: o repositório REAL com o `query` simulado; o SCRIPT do ato inteiro com o pool falso (molde do f1r10).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import request from 'supertest'
import { ProductTokenVerifier } from 'fiscal-api'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { listRefreshCandidates, IncoherentTransmissionError, mapTx } from '../nfse/repository'
import { FREEZE_TRIGGERS_SQL, freezeTriggerRows } from './fixture-freeze-triggers'
import { webScope } from './fixture-ref'
import { SETES_API_DIR } from './voice-kind-fence'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
  }
})

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r7-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

/** Linha CRUA como o `TX_SELECT` a devolve — coerente por padrão: autorizada com chave. */
const raw = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: 'K'.repeat(50), authorityRecorded: 'S', nfseNumber: '42', dhProc: '2026-10-01 10:00:00', createdAt: '2026-10-01 10:00:00',
  ageMinutes: 9000, lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null,
  lastSource: 'P', lastDh: '2026-10-01 10:00:00', lastEventAt: '2026-10-01 10:00:00', lastEventAgeMinutes: 9000, ...over,
})
const noKey = { accessKey: null, authorityRecorded: 'N', nfseNumber: null }
const qOf = (rows: unknown[]) => ({ query: jest.fn(async () => [rows]) }) as any

// =================================================================================================
// 1. IncoherentTransmissionError — o rodízio pula só o DADO torto
// =================================================================================================
describe('1 — R6-SOC-07/R6-ADV-04: só a incoerência de DADO é pulada', () => {
  it('[RESISTIU] a linha torta nas DUAS coisas (projeção sem `environment` E voz A sem registro): a checagem ESTRUTURAL vem antes — relança como erro comum (nunca vira "incoerente pulada"); o aviso não é chamado', async () => {
    const both = raw({ ...noKey, environment: undefined })
    const seen: number[] = []
    let err: unknown
    try { await listRefreshCandidates(qOf([both]), 'setes_setes', webScope(1), 5, 10, 50, {}, r => seen.push(r.invoiceId)) } catch (e) { err = e }
    expect([err instanceof Error, err instanceof IncoherentTransmissionError, String((err as Error)?.message)])
      .toEqual([true, false, expect.stringMatching(/sem environment/)])
    expect(seen).toEqual([])
  })

  it('[RESISTIU] as 3 incoerências de DADO (registro × chave; D-F136 A/N sem registro; D-F154 C/K sem registro) são `IncoherentTransmissionError` E continuam `Error` (o leitor da NOTA segue falhando alto — getTransmission/visão); as 3 estruturais (sem authorityRecorded, environment fora de H/P, sem nfseNotGeneratedAt) NÃO são', () => {
    const typeOf = (r: any) => { try { mapTx(r); return 'ok' } catch (e) { return e instanceof IncoherentTransmissionError ? 'dado' : e instanceof Error ? 'estrutura' : '?' } }
    const { nfseNotGeneratedAt: _drop, ...semProva } = raw()
    expect([
      typeOf(raw({ accessKey: null })),                                  // registro S sem chave
      typeOf(raw({ ...noKey, lastKind: 'N' })),                          // D-F136
      typeOf(raw({ ...noKey, lastKind: 'C' })),                          // D-F154
      typeOf(raw({ ...noKey, lastKind: 'K' })),                          // D-F154
      typeOf(raw({ authorityRecorded: 's' })),                           // minúscula = estrutura (o FATO vem binário da view 004)
      typeOf(raw({ environment: 'p' })),
      typeOf(semProva),
      typeOf(raw({ ...noKey, lastKind: 'R' })),                          // R sem chave: coerente
    ]).toEqual(['dado', 'dado', 'dado', 'dado', 'estrutura', 'estrutura', 'estrutura', 'ok'])
    expect(new IncoherentTransmissionError('x')).toBeInstanceOf(Error)
  })

  it('[FATO] incoerentes ANTES de uma projeção torta na mesma página: o aviso já foi chamado para elas ("INCOERENTE pulada" no log da passada) e então a lista inteira falha — a passada sai com erro e NÃO marca `last_queried_at` de nenhuma (nada carimbado — o objetivo do R6-SOC-07); o alarme de "pulada" sai mesmo assim', async () => {
    const rows = [raw({ invoiceId: 1, ...noKey }), raw({ invoiceId: 2, ...noKey, lastKind: 'C' }), raw({ invoiceId: 3, environment: 'X' })]
    const seen: number[] = []
    await expect(listRefreshCandidates(qOf(rows), 'setes_setes', webScope(1), 5, 10, 50, {}, r => seen.push(r.invoiceId)))
      .rejects.toThrow(/sem environment/)
    expect(seen).toEqual([1, 2])
  })
})

// =================================================================================================
// 2. O ato `migrate:setes --cutover` e a LÁPIDE da F2a (script INTEIRO com pool falso)
// =================================================================================================
describe('2 — R6-SOC-10: o ato da virada e a lápide da F2a abortada', () => {
  type Handler = (sql: string, p: any[]) => any
  const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
  const F2A = 'f2a_fiscal_passivo'
  const TOMB = 'f2a_fiscal_passivo_abortada'

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

  /**
   * ERP com a SE viva e o fiscal_api réplica. [names] = as linhas do `_migrations` do schema (a leitura responde pelo NOME pedido);
   * [triggers] = as linhas do information_schema.TRIGGERS.
   */
  const db = (names: string[], triggers: object[] = freezeTriggerRows()): Handler => {
    let turned = false
    return (sql, p) => {
      if (/FROM setes_central\.tb_institution WHERE id = \?/.test(sql)) return [[{ schemaName: 'setes_x' }]]
      if (/\._migrations WHERE name/.test(sql)) {
        const asked = (p ?? []).map(String)
        return [names.filter(n => asked.includes(n)).map(name => ({ x: 1, name }))]
      }
      if (FREEZE_TRIGGERS_SQL.test(sql)) return [triggers]
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

  it('[RESISTIU — R7-SOC-05: a lápide é procurada SEMPRE] F2a aplicada (sem lápide): a leitura ORIGINAL fica intacta (1ª) e a da lápide vem depois; o ato real vira (o caminho feliz não mudou)', async () => {
    const r = await runScript([...CUT, '--vai'], db([F2A]))
    expect(r.exitCode).toBeNull()
    expect(r.sqls.filter(s => /_migrations/.test(s.sql)).map(s => s.p)).toEqual([[F2A], [TOMB]])
    expect(r.conn.commit).toHaveBeenCalled()
  })

  it('[RESISTIU — R7-SOC-05: a leitura da lápide falha FECHADO, como a da F2a] a leitura da lápide que FALHA (sem permissão): o erro sobe CRU, nada escrito; lápide NUMÉRICA antiga (forma anterior à D-F162) é reconhecida pelo NOME', async () => {
    let calls = 0
    const flaky: Handler = (sql, p) => {
      if (/\._migrations WHERE name/.test(sql)) {
        calls += 1
        if (calls === 2) return Object.assign(new Error('SELECT command denied'), { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' })
        return [[]]
      }
      return db([])(sql, p)
    }
    const r = await runScript([...CUT, '--vai'], flaky)
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/SELECT command denied/)
    expect([r.conn.beginTransaction.mock.calls.length, r.sqls.some(s => isWrite(s.sql))]).toEqual([0, false])
    const numeric = await runScript([...CUT, '--vai'], db([TOMB]))                 // a linha antiga tinha versão '069' — o ato lê pelo nome
    expect(numeric.errors.join(' ')).toMatch(/ABORTADA/)
  })

  it('[CORRIGIDO R7-ADV-03 LOW — R7-SOC-05] `_migrations` com a linha `f2a_fiscal_passivo` E a lápide `f2a_fiscal_passivo_abortada` (estado que TODAS as ferramentas do setes-api recusam: o runner da F2a não sobe — "a F2a foi ABORTADA neste schema"; o aborto e o `--retirar-lapide` dizem "estado que o aborto não deixa — confira antes"): o ato da virada só procura a lápide quando a linha FALTA, então com os 9 gatilhos presentes ele VIRA — aposenta a SE do ERP e grava `cutover_at` (irreversível — D-F50) num schema em que o código da F2a se recusa a subir. Dois leitores, duas respostas. Como se chega lá: só por SQL à mão / restauração parcial (o runner e as ferramentas recusam). Correção sugerida (Q-F178-ADV-02): ler as DUAS linhas numa consulta (`name IN (?, ?)` — a forma do `stateOf` do setes-api) e recusar a lápide em qualquer caso', async () => {
    const r = await runScript([...CUT, '--vai'], db([F2A, TOMB]))
    expect(r.exitCode).toBe(1)
    expect(r.conn.beginTransaction).not.toHaveBeenCalled()
    expect(r.errors.join(' ')).toMatch(/lápide|ABORTADA/)
  })

  it('[CORRIGIDO — era o FATO base do R7-ADV-03] linha + lápide + 9 gatilhos: o ato REAL não vira (nada aposentado, sem commit); o --dry-run acusa o bloqueio ABORTADA', async () => {
    const r = await runScript([...CUT, '--vai'], db([F2A, TOMB]))
    expect(r.exitCode).toBe(1)
    expect(r.sqls.some(s => /UPDATE `setes_x`\.tb_establishment_issuer SET deleted = 'S'/.test(s.sql))).toBe(false)
    expect(r.conn.commit).not.toHaveBeenCalled()
    const dry = await runScript([...CUT, '--dry-run'], db([F2A, TOMB]))
    expect(dry.logs.join(' ')).toMatch(/"bloqueios"[\s\S]*ABORTADA/)
  })

  it('[CORRIGIDO R7-ADV-04 LOW] ABORTO INTERROMPIDO (a lápide nasce ANTES dos DROPs — R5-SOC-05 — e a conexão cai: lápide + 4 dos 9 gatilhos, sem a linha): o ato REAL recusa (certo), mas a frase manda "voltar à F2a = `--retirar-lapide --vai`" — e o `--retirar-lapide` do setes-api RECUSA exatamente esse estado ("lápide COM gatilho … estado que o aborto não deixa; confira antes" — o próprio aborto, interrompido, o deixa). O operador na JANELA segue a frase e bate noutra recusa enganosa; o caminho certo é rodar o ABORTO de novo (ele termina o serviço) e só então decidir voltar. Correção sugerida: com a lápide, o ato lê os gatilhos também e, sobrando algum, a frase diz "aborto incompleto — rode `f2a-abort-before-cutover.ts <schema> <id> --vai` de novo"', async () => {
    const half = freezeTriggerRows().slice(0, 4)
    const r = await runScript([...CUT, '--vai'], db([TOMB], half))
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/gatilho/i)
  })

  it.skip('[SUPERADO pelo R7-ADV-04 corrigido — o ato agora LÊ os gatilhos quando acha a lápide e manda terminar o aborto] o FATO de antes: lápide + 4 gatilhos → a frase era a do `--retirar-lapide`; os gatilhos não eram lidos; o --dry-run mostrava só o bloqueio ABORTADA (nenhum D-F110: com a F2a "ausente" os gatilhos nem são conferidos — os 4 que sobraram não aparecem em lugar nenhum)', async () => {
    const half = freezeTriggerRows().slice(0, 4)
    const r = await runScript([...CUT, '--vai'], db([TOMB], half))
    expect(r.errors.join(' ')).toMatch(/--retirar-lapide --vai/)
    expect(r.sqls.some(s => /information_schema\.TRIGGERS/.test(s.sql))).toBe(false)
    const dry = await runScript([...CUT, '--dry-run'], db([TOMB], half))
    expect(dry.logs.join(' ')).toMatch(/ABORTADA/)
    expect(dry.logs.join(' ')).not.toMatch(/D-F110/)
  })

  it('[RESISTIU — cerca nova] o NOME da lápide no ato (`F2A_TOMBSTONE_NAME` do script) é o MESMO do setes-api (`src/migrations/f2a-names.ts` no SETES_API_DIR — D-F117): renomear de um lado sem o outro calaria a frase de COMO voltar (a recusa continua pela ausência da linha). Sem a F2a no SETES_API_DIR, nada a comparar', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
    const ours = /export const F2A_TOMBSTONE_NAME = '([^']+)'/.exec(script)?.[1]
    expect(ours).toBe(TOMB)
    const names = path.join(SETES_API_DIR, 'src', 'migrations', 'f2a-names.ts')
    if (!fs.existsSync(names)) return
    const theirs = /export const F2A_TOMBSTONE_NAME = '([^']+)'/.exec(fs.readFileSync(names, 'utf8'))?.[1]
    const passivo = /export const F2A_PASSIVO_NAME = '([^']+)'/.exec(fs.readFileSync(names, 'utf8'))?.[1]
    expect([theirs, passivo]).toEqual([ours, /export const F2A_MIGRATION_NAME = '([^']+)'/.exec(script)?.[1]])
  })
})

// =================================================================================================
// 3. R7-ADV-01 (núcleo) na PORTA REAL da nfse-api — `createApp` com o `productAuth` e o `errorMiddleware` do núcleo
// =================================================================================================
describe('3 — R7-ADV-01 na porta real da nfse-api (anônimo, nada de banco)', () => {
  const pub = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string
  const appFor = () => createApp({
    pool: { query: jest.fn(async () => [[]]) }, db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
    verifier: ProductTokenVerifier.of({ k1: pub }), corsOrigins: [], checkIdentity: false,
  } as unknown as AppContext)
  const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
  const typJwtNotJson = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'k1' }))}.${b64u('nao-e-json')}.${b64u('lixo')}`

  it('[CORRIGIDO R7-ADV-01 MEDIUM — a mesma raiz no núcleo] `POST /v1/nfse/invoices/1/transmit` anônimo com `{"typ":"JWT"}` + corpo não-JSON: o certo é 401 (como qualquer token que não decodifica — e como o setes-api responde ao MESMO token)', async () => {
    const r = await request(appFor()).post('/v1/nfse/invoices/1/transmit').set('Authorization', `Bearer ${typJwtNotJson}`)
    expect([r.status, r.body.code]).toEqual([401, 'UNAUTHORIZED'])
  })

  it.skip('[SUPERADO pelo R7-ADV-01 corrigido — agora 401] o FATO de antes: 500 `INTERNAL` com ref (o app trata 500 num ATO como desfecho DESCONHECIDO — D-F155); um token que não decodifica SEM `typ` é 401', async () => {
    const r = await request(appFor()).post('/v1/nfse/invoices/1/transmit').set('Authorization', `Bearer ${typJwtNotJson}`)
    expect([r.status, r.body.code, typeof r.body.ref]).toEqual([500, 'INTERNAL', 'string'])
    const semTyp = await request(appFor()).post('/v1/nfse/invoices/1/transmit')
      .set('Authorization', `Bearer ${b64u(JSON.stringify({ alg: 'RS256' }))}.${b64u('nao-e-json')}.${b64u('lixo')}`)
    expect(semTyp.status).toBe(401)
  })
})
