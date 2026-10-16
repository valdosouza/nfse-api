/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 13 das APIs fiscais (D-F67…D-F76, Valdo 2026-10-10) — nfse-api (+ núcleo fiscal-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta: D-F68 (`localCancelPending`/`isSubstitutionCancel` do núcleo), D-F69 (adaptador ADN da nfse-api), D-F71
// (código do evento na voz C — migration 002 + `recordCancelVoice`), D-F75 (o código só sobe — re-sincronia do
// `migrate:setes`), D-F76 (chave da substituta na tela "No fisco"), guarda do transmitir para a SUBSTITUIÇÃO.
//
//  * ACHADOS (`it.failing('[SEV R13-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo mockado), nenhum banco (pool/conn/repositório/erp mockados; o
// script `migrate-from-setes-api` roda INTEIRO contra um pool FALSO — molde do `adversarial-f1r10.test.ts`), nenhuma
// migration executada (a 002 é LIDA do disco e interpretada em memória), nenhum script que fale com o fisco.
import { setesApiPath } from './voice-kind-fence'   // D-F117: SETES_API_DIR, falha alto
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync } from 'zlib'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, localCancelPending, isSubstitutionCancel } from 'fiscal-api'
import { refreshServiceTransmission, getServiceFiscalView, NfseDeps } from '../nfse/transmission'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    nextDpsNumber: jest.fn(),
    acquireRefreshLease: jest.fn(),
    releaseRefreshLease: jest.fn(),
    renewRefreshLease: jest.fn(),
    emissionStillInErp: jest.fn(),
    getIssuer: jest.fn(),
    createFiscalPool: jest.fn(),
    dbConfigFromEnv: jest.fn(() => ({ host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' })),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), invoiceLives: jest.fn(), institutionZone: jest.fn(),
      entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), establishmentCnpj: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getLifeDps: jest.fn(), insertLifeDps: jest.fn(), getTransmission: jest.fn(), latestTransmission: jest.fn(),
    findTransmissionByDpsId: jest.fn(), listLifeTransmissions: jest.fn(), insertTransmission: jest.fn(),
    fillAuthorityData: jest.fn(), insertTransmissionEvent: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(), listRefreshCandidates: jest.fn(),
    findKeyHolder: jest.fn(),
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-adv-r13-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000195'
const KEY = '4106902212345678000195000000000012320260921000012345'.slice(0, 50)
const SUBST_KEY = `${KEY.slice(0, -1)}9`
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const nfseXmlFor = (extra = '') =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS>${extra}</infNFSe></NFSe>`
const NFSE_XML = nfseXmlFor()

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-10-10 21:43:04', createdAt: '2026-10-10 21:43:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})

let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  conn.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null }, cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
    info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
  })
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

// ---------------------------------------------------------------------------
// A Sefin REAL (D-F61) pelo transporte do NÚCLEO — nenhum socket (molde do r11 da nfse-api)
// ---------------------------------------------------------------------------
import { transport, HttpsCall } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { webRef } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset() })

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
const notFound = () => ({ status: 404, headers: {}, text: '' })
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')
const arquivo2 = (x: string) => b64(gzipSync(Buffer.from(x, 'utf8')).toString('base64'))
const SEFIN = { dataHoraProcessamento: '2026-10-10T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const sefinNone = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const typedItem = (file: string, code = '101101', key = KEY) =>
  ({ chaveAcesso: key, tipoEvento: Number(code), numeroPedidoRegistroEvento: 1, dataHoraRecebimento: '2026-10-10T18:43:04.82', arquivoXml: file })
const typedOk = (...items: any[]) => ok({ ...SEFIN, eventos: items })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
function generatedEventXml(o: { key?: string; code?: string; inner?: string } = {}): string {
  const key = o.key ?? KEY, code = o.code ?? '101101'
  return `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infEvento Id="EVT${key}${code}001"><verAplic>SEFIN</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-10-10T18:43:05-03:00</dhProc><nDFSe>1</nDFSe>` +
    `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}${code}"><tpAmb>2</tpAmb><verAplic>SETES</verAplic><dhEvento>2026-10-10T18:43:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor><chNFSe>${key}</chNFSe>` +
    `<e${code}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>cliente desistiu do serviço</xMotivo>${o.inner ?? ''}</e${code}></infPedReg></pedRegEvento></infEvento></evento>`
}
const substEventXml = (substitute: string) => generatedEventXml({ code: '105102', inner: `<chSubstituta>${substitute}</chSubstituta>` })
function sefin(o: { nfse?: () => any; typed?: (code: string) => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    const typed = call.url.match(/\/nfse\/\d+\/eventos\/(\d+)\/(\d+)$/)
    if (typed && call.method === 'GET') return (await o.typed?.(typed[1])) ?? sefinNone()
    if (/\/nfse\/\d+$/.test(call.url)) return o.nfse?.() ?? ok({ nfseXmlGZipB64: gz(NFSE_XML) })
    return notFound()
  })
}
const ctxH = { environment: 'H' as const, cert: Buffer.from('CERT'), key: Buffer.from('KEY') }
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const insertedEvents = () => (repo.insertTransmissionEvent as jest.Mock).mock.calls.map((c: any[]) => c[3])
const fiscoCalls = () => mockHttp.mock.calls.filter((c: any[]) => !/convenio/.test(c[0].url)).length

// ---------------------------------------------------------------------------
// `migrate:setes` INTEIRO contra um pool FALSO (molde do adversarial-f1r10). O banco é uma lista de vozes (origem × réplica);
// o UPDATE de promoção e a conferência `evDiff` são aplicados em memória pelos ÁTOMOS do SQL ATUAL do script — átomo
// desconhecido devolve erro (a correção que mudar a forma do SQL atualiza este modelo).
// ---------------------------------------------------------------------------
type Voice = { kind: string; code: string | null }
type Handler = (sql: string, p: any[]) => any
const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)

async function runScript(argv: string[], handler: Handler) {
  const sqls: string[] = []
  const c: any = {
    beginTransaction: jest.fn(async () => undefined), commit: jest.fn(async () => undefined), rollback: jest.fn(async () => undefined), release: jest.fn(),
    query: jest.fn(async (sql: string, p: any[] = []) => {
      sqls.push(sql.replace(/\s+/g, ' ').trim())
      const out = handler(sql, p)
      if (out instanceof Error) throw out
      if (out !== undefined) return out
      return isWrite(sql) ? [{ affectedRows: 0 }] : [[]]
    }),
  }
  let ended!: () => void
  const done = new Promise<void>(r => { ended = r })
  const p: any = { query: c.query, getConnection: jest.fn(async () => c), end: jest.fn(async () => ended()) }
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
  const res = { exitCode: exit.mock.calls[0]?.[0] ?? null, errors, logs, sqls, conn: c }
  exit.mockRestore(); err.mockRestore(); log.mockRestore()
  return res
}

/**
 * Avaliador MÍNIMO de WHERE do MySQL com lógica de TRÊS valores (NULL): AND/OR/NOT/parênteses, `=`, `<>`, `<=>` (null-safe),
 * `IS [NOT] NULL`, sobre as colunas `f.kind/f.authority_code` (réplica) e `src.kind/src.authority_code` (origem). Assim a
 * simulação segue o SQL que ESTIVER no script (o delta mudou durante o gate — L6 às 21:33), sem reescrever a regra no teste.
 */
type Row = { src: Voice; f: Voice }
type V3 = boolean | null
function topSplit(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, q = false, start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") q = !q
    else if (!q && ch === '(') depth++
    else if (!q && ch === ')') depth--
    else if (!q && depth === 0 && s.startsWith(sep, i)) { out.push(s.slice(start, i)); start = i + sep.length; i += sep.length - 1 }
  }
  out.push(s.slice(start)); return out.map(x => x.trim())
}
function wrapped(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false
  let depth = 0, q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") q = !q
    else if (!q && ch === '(') depth++
    else if (!q && ch === ')') { depth--; if (depth === 0 && i < s.length - 1) return false }
  }
  return true
}
function operand(t: string, r: Row): string | null | undefined {
  const m = t.match(/^(f|src)\.(kind|authority_code)$/)
  if (m) { const side = r[m[1] as 'f' | 'src']; return m[2] === 'kind' ? side.kind : side.code }
  const lit = t.match(/^'([^']*)'$/)
  return lit ? lit[1] : undefined
}
function atom(e: string, r: Row): V3 {
  if (e === 'f.tb_institution_id = ?') return true
  let m = e.match(/^(\S+) IS (NOT )?NULL$/)
  if (m) { const v = operand(m[1], r); if (v === undefined) throw new Error(`átomo não modelado: ${e}`); return m[2] ? v != null : v == null }
  m = e.match(/^(\S+) (<=>|<>|=) (\S+)$/)
  if (m) {
    const a = operand(m[1], r), b = operand(m[3], r)
    if (a === undefined || b === undefined) throw new Error(`átomo não modelado: ${e}`)
    if (m[2] === '<=>') return a === b
    if (a == null || b == null) return null
    return m[2] === '=' ? a === b : a !== b
  }
  throw new Error(`átomo não modelado: ${e}`)
}
function evalWhere(expr: string, r: Row): V3 {
  const ors = topSplit(expr, ' OR ')
  if (ors.length > 1) { const v = ors.map(e => evalWhere(e, r)); return v.includes(true) ? true : v.includes(null) ? null : false }
  const ands = topSplit(expr, ' AND ')
  if (ands.length > 1) { const v = ands.map(e => evalWhere(e, r)); return v.includes(false) ? false : v.includes(null) ? null : true }
  const e = expr.trim()
  if (e.startsWith('NOT ')) { const v = evalWhere(e.slice(4), r); return v === null ? null : !v }
  if (wrapped(e)) return evalWhere(e.slice(1, -1), r)
  return atom(e, r)
}

/** Institution 1 (`setes_x`) com SE no ERP e RÉPLICA no fiscal_api; vozes (origem × réplica) na MESMA (tentativa, evento). */
function resyncDb(voices: { src: Voice; f: Voice }[]) {
  const state: Row[] = voices.map(v => ({ src: { ...v.src }, f: { ...v.f } }))
  const handler: Handler = (sql) => {
    const one = sql.replace(/\s+/g, ' ').trim()
    if (/FROM setes_central\.tb_institution WHERE deleted = 'N'/.test(one)) return [[{ id: 1, schemaName: 'setes_x' }]]
    if (/FROM `setes_x`\.tb_establishment_issuer WHERE tb_institution_id = \? AND model = 'SE' LIMIT 1/.test(one)) return [[{ x: 1 }]]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer/.test(one)) return [[{ model: 'SE', c: null }]]
    if (/information_schema\.tables/.test(one)) return [[{ x: 1 }]]
    if (/invoice_event IS NULL/.test(one)) return [[{ n: 0 }]]
    if (/COALESCE\(MAX\(dps_number\), 0\) m/.test(one)) return [[{ m: 0 }]]
    try {
      if (/^UPDATE tb_invoice_service_transmission_event f JOIN `setes_x`\.tb_invoice_service_transmission_event src/.test(one)) {
        const set = one.match(/ SET f\.authority_code = ('(\d+)'|src\.authority_code), /)
        if (!set) return new Error(`SET não modelado: ${one}`)
        const where = one.split(' WHERE ')[1]
        let n = 0
        for (const v of state) if (evalWhere(where, v) === true) { v.f.code = set[2] ?? v.src.code; n++ }
        return [{ affectedRows: n }]
      }
      if (/^SELECT f\.tb_invoice_id AS inv, f\.attempt, f\.event FROM tb_invoice_service_transmission_event f JOIN/.test(one)) {
        const where = one.split(' WHERE ')[1].replace(/ LIMIT \d+$/, '')
        return [state.flatMap((v, i) => (evalWhere(where, v) === true ? [{ inv: INVOICE, attempt: 1, event: i + 1 }] : []))]
      }
    } catch (e) { return e as Error }
    return undefined
  }
  return { handler, state }
}

// ---------------------------------------------------------------------------
// Interpretador MÍNIMO dos UPDATEs de backfill da 002 (lida do disco, aplicada em memória NA ORDEM do arquivo)
// ---------------------------------------------------------------------------
type VoiceRow = { kind: string; source: string; message: string; code: string | null }
function applyBackfill(sqlFile: string, rows: VoiceRow[]): VoiceRow[] {
  const text = fs.readFileSync(sqlFile, 'utf8').split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
  const stmts = text.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => /^UPDATE `tb_invoice_service_transmission_event` SET `authority_code` = '/.test(s))
  const out = rows.map(r => ({ ...r }))
  for (const st of stmts) {
    const value = st.match(/SET `authority_code` = '(\d+)'/)![1]
    const preds = st.split(/ WHERE /)[1].split(/ AND /).map(a => a.trim()).map(a => {
      if (a === "`kind` = 'C'") return (r: VoiceRow) => r.kind === 'C'
      if (a === '`authority_code` IS NULL') return (r: VoiceRow) => r.code == null
      if (a === "`message` LIKE '%(e105102)%'") return (r: VoiceRow) => r.message.includes('(e105102)')
      if (a === "`source` = 'P'") return (r: VoiceRow) => r.source === 'P'
      if (a === "`source` = 'Q'") return (r: VoiceRow) => r.source === 'Q'
      if (a === "`source` <> 'P'") return (r: VoiceRow) => r.source !== 'P'
      throw new Error(`átomo do backfill não modelado: ${a}`)
    })
    for (const r of out) if (preds.every(p => p(r))) r.code = value
  }
  return out
}
const MIGRATION_002 = path.join(__dirname, '..', 'migrations', 'sql', '002_cancel_event_code.sql')

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R13-01 (MEDIUM — CORRIGIDO durante o gate pelo L6, 21:33) — D-F71/D-F75 × `migrate:setes`: a re-sincronia só levava à réplica a PROMOÇÃO para 105102; o PREENCHIMENTO de um código NULL feito na ORIGEM depois da cópia (o `setCancelEventCode` do setes-api grava 101101/105104/305101 numa voz C de consulta sem código ao re-consultá-la — prova no adversarial-r13-gate do setes-api) deixa a réplica NULL e a nova conferência por código ABORTA a institution — e o ATO da virada, que roda a mesma re-sincronia — com "voz divergente … dual-write (D-F18)", que não é dual-write nenhum', () => {
  // CORRIGIDO DURANTE O GATE: a sessão da entrega aplicou "L6 do gate da Rodada 13" no script às 21:33 (SET f.authority_code =
  // src.authority_code — preenche NULL e sobe para 105102), antes da 1ª execução deste arquivo. O SQL anterior (lido no diff do
  // gate) está reproduzido no teste "histórico" abaixo e é avaliado pelo MESMO avaliador: deixava a réplica NULL → divergência.
  it('histórico [R13-01]: o UPDATE anterior ao L6 (só `SET \'105102\'` quando a origem é 105102) NÃO leva o preenchimento 101101 e a conferência por código ACUSA a voz', () => {
    const OLD_SET_WHERE = "f.tb_institution_id = ? AND f.kind = 'C' AND src.kind = 'C' AND src.authority_code = '105102' AND NOT (f.authority_code <=> '105102')"
    const EV_DIFF = "f.tb_institution_id = ? AND (NOT (src.kind <=> f.kind) OR (f.kind = 'C' AND NOT (src.authority_code <=> f.authority_code)))"
    const row: Row = { src: { kind: 'C', code: '101101' }, f: { kind: 'C', code: null } }
    if (evalWhere(OLD_SET_WHERE, row) === true) row.f.code = '105102'
    expect(row.f.code).toBeNull()
    expect(evalWhere(EV_DIFF, row)).toBe(true)                    // = "voz divergente … dual-write (D-F18); nada migrado"
  })
  it('[CORRIGIDO durante o gate — L6] [MEDIUM R13-01] origem C 101101 (preenchida depois da cópia) × réplica C NULL → a re-sincronia CONVERGE (réplica 101101), sem "voz divergente"', async () => {
    const db = resyncDb([{ src: { kind: 'C', code: '101101' }, f: { kind: 'C', code: null } }])
    const r = await runScript([], db.handler)
    expect(r.errors.join(' ')).not.toMatch(/voz divergente/)
    expect(r.exitCode).toBeNull()
    expect(db.state[0].f.code).toBe('101101')
  })
  it('[CORRIGIDO durante o gate — L6] [MEDIUM R13-01] o mesmo vale para 105104 (deferido em análise) e 305101 (de ofício)', async () => {
    for (const code of ['105104', '305101']) {
      const db = resyncDb([{ src: { kind: 'C', code }, f: { kind: 'C', code: null } }])
      const r = await runScript([], db.handler)
      expect([code, r.exitCode, db.state[0].f.code]).toEqual([code, null, code])
    }
  })
})

describe('ACHADO R13-02 (LOW) — backfill da 002 (o MESMO da 067 do setes-api) por TEXTO LIVRE: a regra "(e105102)" roda antes da regra source=P — voz do NOSSO pedido com o motivo digitado contendo "(e105102)" vira SUBSTITUIÇÃO', () => {
  it('[CORRIGIDO] [LOW R13-02] voz C source P "Cancelada no fisco: valor errado (e105102) corrigido" → 101101 (o único evento que o produto pede)', () => {
    const [r] = applyBackfill(MIGRATION_002, [{ kind: 'C', source: 'P', message: 'Cancelada no fisco: valor errado (e105102) corrigido', code: null }])
    expect(r.code).toBe('101101')                               // hoje: 105102
  })
  it('contexto [R13-02]: os casos previstos funcionam e a 002 é idêntica à 067 do setes-api (réplica = origem para a MESMA mensagem)', () => {
    const rows: VoiceRow[] = [
      { kind: 'C', source: 'Q', message: 'Cancelada no fisco por SUBSTITUIÇÃO (e105102): erro no valor', code: null },
      { kind: 'C', source: 'P', message: 'Cancelada no fisco: cliente desistiu do serviço', code: null },
      { kind: 'C', source: 'Q', message: 'Cancelada no fisco: cliente desistiu', code: null },
    ]
    expect(applyBackfill(MIGRATION_002, rows).map(r => r.code)).toEqual(['105102', '101101', null])
    const m067 = setesApiPath('src', 'migrations', 'sql', '067_fiscal_cancel_code_and_cancel_waiver.sql')   // D-F117: tem de existir
    expect(applyBackfill(m067, rows)).toEqual(applyBackfill(MIGRATION_002, rows))
  })
})

describe('ACHADO R13-03 (LOW) — D-F69 no adaptador da nfse-api: o 200 tipado de /eventos/101101/1 com [e101101, e105102] desta chave (contraditório) devolve "cancelled 101101" — o PRIMEIRO que se confere, não o mais restritivo; a voz nasce como cancelamento comum e `localCancelPending` manda o app aplicar o C local', () => {
  const both = () => typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })), '101101'), typedItem(arquivo2(generatedEventXml({ code: '105102' })), '105102'))
  it('[CORRIGIDO — D-F84] [LOW R13-03] adaptador: nunca "cancelled" sem a marca 105102 (unknown/502 ou eventCode 105102)', async () => {
    sefin({ typed: code => (code === '101101' ? both() : undefined) })
    const out = await settle(adnAdapter.queryNfse(ctxH as any, KEY))
    expect(out?.status === 'cancelled' && out?.cancelled?.eventCode !== '105102').toBe(false)
  })
  it('[CORRIGIDO — D-F84] [LOW R13-03] composição: a consulta com essa resposta NÃO devolve localCancelPending=true (o app aplicaria o C local sem humano)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefin({ typed: code => (code === '101101' ? both() : undefined) })
    const r = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(r?.localCancelPending === true).toBe(false)           // hoje: true
  })
})

describe('ACHADO R13-04 (LOW) — D-F76 na nfse-api: `chSubstituta` igual à PRÓPRIA chave é exibida como a substituta', () => {
  it('[CORRIGIDO] [LOW R13-04] tela "No fisco": evento e105102 com chSubstituta = a chave substituída → substituteAccessKey null', async () => {
    const current = tx({ attempt: 1, lastKind: 'C', lastCode: '105102' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })
    deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, substEventXml(KEY), new Date('2026-10-10T21:43:04Z'), 'H', 'America/Sao_Paulo')
    const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
    expect(v.substitution?.substituteAccessKey).toBeNull()       // hoje: a própria KEY
  })
  it('D-F85 (= Q-F91): chSubstituta de OUTRO emitente (posições 9–23 diferentes) → null; do mesmo emitente → exibida', async () => {
    const current = tx({ attempt: 1, lastKind: 'C', lastCode: '105102' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    const otherIssuer = `${SUBST_KEY.slice(0, 8)}2${'98765432000198'}${SUBST_KEY.slice(23)}`
    for (const [key, expected] of [[otherIssuer, null], [SUBST_KEY, SUBST_KEY]] as const) {
      fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })
      deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, substEventXml(key), new Date('2026-10-10T21:43:04Z'), 'H', 'America/Sao_Paulo')
      expect((await getServiceFiscalView(deps, A, webRef(A, INVOICE))).substitution?.substituteAccessKey).toBe(expected)
    }
  })
})

describe('ACHADO R13-05 (LOW) — D-F71 na nfse-api: o caminho "NFS-e com <e101101> embutido" devolvia o cancelamento SEM eventCode — a voz C nascia com authority_code NULL (CORRIGIDO na nfse-api durante o gate — "L6", 21:33; o adaptador do setes-api segue sem o código)', () => {
  const withBlock = nfseXmlFor('<e101101><dhEvento>2026-09-28T09:59:00-03:00</dhEvento><cMotivo>1</cMotivo><xMotivo>cliente desistiu</xMotivo></e101101>')
  it('[CORRIGIDO durante o gate — L6] [LOW R13-05] consulta → a voz C gravada leva authorityCode 101101', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    sefin({ nfse: () => ok({ nfseXmlGZipB64: gz(withBlock) }) })
    await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(insertedEvents().find(e => e?.kind === 'C')?.authorityCode).toBe('101101')   // hoje: null
  })
})

describe('ACHADO R13-06 (LOW, delta NOVO durante o gate — D-F78, 21:33) — "consultar" uma NFS-e já em C relê o fisco para arquivar o XML do evento que faltou, mas o arquivamento NÃO é best-effort: A1 vencido/ausente, fisco fora (503) ou resposta ambígua (502) fazem a consulta de um estado FINAL falhar — antes devolvia a voz C sem tocar o fisco; a regra da casa (Q-N38) é "falhar ao gravar só avisa"', () => {
  const finalSubstitution = () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' }))
    fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })          // o XML do evento NÃO está no disco
  }
  it('[CORRIGIDO] [LOW R13-06] C 105102 + XML do evento ausente + fisco fora (503) → a consulta devolve a voz C (unchanged, localCancelPending=false), nunca 503', async () => {
    finalSubstitution()
    sefin({ nfse: () => ({ status: 503, headers: {}, text: '' }) })
    const r = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(r).toMatchObject({ kind: 'C', changed: false, localCancelPending: false })   // hoje: AuthorityHttpError 503
  })
  it('[CORRIGIDO] [LOW R13-06] C 105102 + XML ausente + A1 vencido no cofre → a consulta devolve a voz C, nunca 409 FISCAL_CERT_EXPIRED', async () => {
    finalSubstitution()
    ;(fiscal.openIssuer as jest.Mock).mockRejectedValue(new fiscal.HttpError(409, 'A1 expirou', undefined, 'FISCAL_CERT_EXPIRED'))
    const r = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q'))
    expect(r).toMatchObject({ kind: 'C', changed: false })                              // hoje: HttpError 409
  })
  it('resistiu [D-F78]: com o fisco no ar, a releitura arquiva o evento e a tela passa a mostrar a chave da substituta; a voz não muda', async () => {
    finalSubstitution()
    sefin({ typed: code => (code === '105102' ? typedOk(typedItem(arquivo2(substEventXml(SUBST_KEY)), '105102')) : undefined) })
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(r).toMatchObject({ kind: 'C', changed: false, localCancelPending: false })
    expect(insertedEvents()).toEqual([])
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' })], events: [] })
    expect((await getServiceFiscalView(deps, A, webRef(A, INVOICE))).substitution).toEqual({ substituteAccessKey: SUBST_KEY })
  })
  it('resistiu [D-F78]: a releitura que traz um evento de OUTRO tipo (101101) para a voz 105102 NÃO arquiva (a marca não se contradiz no arquivo)', async () => {
    finalSubstitution()
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
    await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(deps.storage.find(CNPJ, `${KEY}-evt101101.xml`, ['2026-10-10 21:43:04'], 'H', 'America/Sao_Paulo')).toBeNull()
  })
})

// ===========================================================================
// RESISTIU — ataques que NÃO reproduziram bug (regressão)
// ===========================================================================

describe('RESISTIU — D-F75 na re-sincronia: a promoção chega à réplica e o rebaixamento nunca acontece', () => {
  it('resistiu: origem 105102 (promovida depois da cópia) × réplica 101101 → a réplica SOBE para 105102 e a re-sincronia termina limpa', async () => {
    const db = resyncDb([{ src: { kind: 'C', code: '105102' }, f: { kind: 'C', code: '101101' } }])
    const r = await runScript([], db.handler)
    expect([r.exitCode, r.errors.join(' '), db.state[0].f.code]).toEqual([null, '', '105102'])
  })
  it('resistiu: origem 105102 × réplica NULL → sobe para 105102', async () => {
    const db = resyncDb([{ src: { kind: 'C', code: '105102' }, f: { kind: 'C', code: null } }])
    const r = await runScript([], db.handler)
    expect([r.exitCode, db.state[0].f.code]).toEqual([null, '105102'])
  })
  it('resistiu: origem 101101 × réplica 105102 → a réplica NUNCA é rebaixada (fica 105102); a divergência falha ALTO e nada da institution é gravado', async () => {
    const db = resyncDb([{ src: { kind: 'C', code: '101101' }, f: { kind: 'C', code: '105102' } }])
    const r = await runScript([], db.handler)
    expect(db.state[0].f.code).toBe('105102')
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/voz divergente/)
    expect(r.conn.commit).not.toHaveBeenCalled(); expect(r.conn.rollback).toHaveBeenCalled()
  })
  it('resistiu: origem 105104 × réplica 101101 (dois códigos não-substituição diferentes) → nada é "consertado" em silêncio: falha ALTO', async () => {
    const db = resyncDb([{ src: { kind: 'C', code: '105104' }, f: { kind: 'C', code: '101101' } }])
    const r = await runScript([], db.handler)
    expect([r.exitCode, db.state[0].f.code]).toEqual([1, '101101'])
  })
  it('resistiu: vozes que não são C (R com E0116 × R com E0117) não entram na conferência por código', async () => {
    const db = resyncDb([{ src: { kind: 'R', code: 'E0116' }, f: { kind: 'R', code: 'E0117' } }])
    const r = await runScript([], db.handler)
    expect(r.exitCode).toBeNull()
  })
})

describe('RESISTIU — D-F68: a substituição nunca manda o app aplicar o C local (núcleo + composição)', () => {
  it('resistiu: matriz do núcleo — só C+105102 é substituição; C sem código (voz anterior à D-F68, ou `lastCode` ausente no objeto) é cancelamento comum', () => {
    expect(localCancelPending({ lastKind: 'C', lastCode: '105102' }, 'E')).toBe(false)
    expect(localCancelPending({ lastKind: 'C', lastCode: '105102' }, null)).toBe(false)
    expect(localCancelPending({ lastKind: 'C', lastCode: undefined as any }, 'E')).toBe(true)
    expect(localCancelPending({ lastKind: 'C', lastCode: '105104' }, 'E')).toBe(true)
    expect(isSubstitutionCancel({ lastKind: 'K', lastCode: '105102' })).toBe(false)
    expect(isSubstitutionCancel({ lastKind: 'C', lastCode: ' 105102' })).toBe(false)
  })
  it('resistiu: núcleo com a D-F82 (305101 de ofício também é ato humano, 21:31) — 101101/105104 seguem automáticos', () => {
    expect(['101101', '105102', '105104', '305101'].map(code => localCancelPending({ lastKind: 'C', lastCode: code }, 'E'))).toEqual([true, false, true, false])
  })
  it('resistiu: tentativa JÁ em C 105102 (XML do evento arquivado) → a consulta não volta ao fisco e devolve localCancelPending=false; C 101101 → true', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 2, lastCode: '105102' }))
    fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })
    deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, substEventXml(SUBST_KEY), new Date('2026-10-10T21:43:04Z'), 'H', 'America/Sao_Paulo')
    sefin()
    expect(await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')).toMatchObject({ kind: 'C', changed: false, localCancelPending: false })
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'C', lastEvent: 2, lastCode: '101101' }))
    expect(await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')).toMatchObject({ kind: 'C', localCancelPending: true })
    expect(fiscoCalls()).toBe(0)
  })
  it('resistiu: voz C já gravada (corrida de duas consultas) → a 2ª devolve o CÓDIGO GRAVADO (105102) e não insere outra voz', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue({ attempt: 1, event: 2, kind: 'C', authorityCode: '105102' })
    sefin({ typed: code => (code === '101101' ? typedOk(typedItem(arquivo2(generatedEventXml({ code: '101101' })))) : undefined) })
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q')
    expect(r).toMatchObject({ kind: 'C', localCancelPending: false })
    expect(insertedEvents()).toEqual([])
  })
  it('resistiu: código fora do domínio do CHECK da 002 vindo do adaptador → authorityCode NULL (nunca o 500 do CHECK)', async () => {
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx({ lastKind: 'A' }))
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'cancelled', nfseXml: NFSE_XML, dhProc: null,
      cancelled: { dhEvento: '2026-09-28T10:00:00-03:00', motive: 'x', eventCode: '105103' } })
    await refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q')
    expect(insertedEvents().find(e => e?.kind === 'C')).toMatchObject({ authorityCode: null })
  })
})

describe('RESISTIU — D-F76 na nfse-api: chSubstituta hostil não vira chave', () => {
  it.each([
    ['minúsculas', SUBST_KEY.slice(0, 40) + 'abcdefabcd'], ['44 dígitos', SUBST_KEY.slice(0, 44)], ['CDATA', `<![CDATA[${SUBST_KEY}]]>`],
    ['marcação', `${SUBST_KEY}<x/>`],
  ])('resistiu: %s → substituteAccessKey null', async (_l, hostile) => {
    const current = tx({ attempt: 1, lastKind: 'C', lastCode: '105102' })
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [current], events: [] })
    fs.rmSync(path.join(storageRoot, CNPJ), { recursive: true, force: true })
    deps.storage.save(CNPJ, `${KEY}-evt101101.xml`, substEventXml(hostile), new Date('2026-10-10T21:43:04Z'), 'H', 'America/Sao_Paulo')
    const v = await getServiceFiscalView(deps, A, webRef(A, INVOICE))
    expect(v).toMatchObject({ localCancelPending: false, substitution: { substituteAccessKey: null } })
  })
})
