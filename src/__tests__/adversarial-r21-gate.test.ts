/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 21 das APIs fiscais (D-F102…D-F104, Valdo 2026-10-11) — nfse-api (+ textos do núcleo e do setes-api).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta (conhecimento negativo, SEM mudança de comportamento):
//  - D-F102 (= Q-F108 (a)): a voz S não tem produtor nem saída; quem criar produtor de S dá a ela a saída da D-F51 na MESMA entrega.
//    A CERCA é o teste "resistiu — CERCA da D-F102 … nenhum produtor de voz S" do `adversarial-r20-gate.test.ts` (regex `kind:\s*'S'`
//    depois de `uncomment`, sobre `walkTs(nfse-api/src) ∪ walkTs(fiscal-api/src)` + o `invoice-transmission.ts` do setes-api); o antigo
//    `it.failing` do R20-01 virou o teste que afirma que a consulta NÃO fecha a irmã S.
//  - D-F103 (= Q-F109 (a)): `kind` sem CHECK de domínio; escritores tipados; CHECK binário só na migration da F2a (ataque no núcleo r21).
//  - D-F104 (= Q-F110 (a)): prova booleana até a F2a (ataque no núcleo r21).
//
// Como a cerca é atacada: ela NÃO é exportável (vive dentro do teste r20) e este gate não pode criar arquivo fora dos dois r21 — então
// ela é REPLICADA aqui (mesmo texto) e aplicada a FONTES SINTÉTICAS em memória e ao texto REAL dos arquivos (com injeção em memória).
// O 1º teste confere, pelo texto do r20, que a réplica É a cerca: quando o corretor endurecer a cerca, esse teste quebra e a réplica
// tem de ser trocada pela nova (de preferência a cerca vira peça de teste compartilhada, molde `fiscal-api/src/__tests__/fence.ts`).
//
//  * ACHADOS (`it.failing('[SEV R21-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual (prova do achado);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket (transport.request do núcleo trocado), nenhum banco (pool/conn/repositório/erp mockados — harness
// copiado do r20), nada no disco (o arquivo fiscal aponta para uma pasta que NUNCA é criada — conferido), nada que fale com o fisco.
// Lê o setes-api, os scripts e as migrations só como TEXTO.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { tsProducesS, voiceFenceScope, setesApiPath, relWorkspace } from './voice-kind-fence'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import type { TransmissionEventInput } from '../nfse/repository'
import type { TransmissionEventKind as SharedKind } from 'fiscal-api'
import { FsFiscalStorage, MasterKeyRing } from 'fiscal-api'
import { refreshServiceTransmission, NfseDeps } from '../nfse/transmission'

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
    // recordNfseNotGenerated fica REAL: o UPDATE dele vai ao `pool.query` falso deste teste
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
// pasta do arquivo fiscal que NUNCA é criada (o construtor não toca o disco) — conferido no afterAll
const storageRoot = path.join(os.tmpdir(), `nfse-api-adv-r21-nunca-criada-${process.pid}`)
afterAll(() => { expect(fs.existsSync(storageRoot)).toBe(false) })

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: {} as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000199'
const DPS_ID = 'DPS410690221234567800019900001000000000000042'

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-10-09 09:59:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 2, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-09 10:00:00', lastEventAgeMinutes: 0, ...over,
})
/** F "envio interrompido" por CONSULTA em PRODUÇÃO — a candidata da reconferência (D-F29). */
const F = (over: any = {}) => tx({ lastQueriedAt: '2026-10-09 10:00:00', ...over })

let maxEvent = 0
let stamps: { attempt: number; seen: number }[] = []
let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  maxEvent = 0; stamps = []
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (/nfse_not_generated_at = NOW\(\)/.test(sql)) {
      const ok = Number(params[4]) === maxEvent
      if (ok) stamps.push({ attempt: Number(params[3]), seen: Number(params[4]) })
      return [{ affectedRows: ok ? 1 : 0 }]
    }
    return /GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]
  })
  conn.query.mockImplementation(async (sql: string) => (/GET_LOCK/.test(sql) ? [[{ ok: 1 }]] : [[]]))
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null }, cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
    info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
  })
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(2)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  ;(repo.touchQueriedAt as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(repo.fillAuthorityData as jest.Mock).mockReset().mockResolvedValue(undefined)
  conn.beginTransaction.mockReset(); conn.commit.mockReset(); conn.rollback.mockReset()
})

// A Sefin REAL (D-F61) pelo transporte do NÚCLEO — nenhum socket
import { transport, HttpsCall } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { isInterruptedInFlight, IN_FLIGHT_MINUTES } from '../nfse/transmission'
import { webRef, refOf, itxOf } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

const realTransport = transport.request
const mockHttp = jest.fn()
beforeAll(() => { transport.request = mockHttp as any })
afterAll(() => { transport.request = realTransport })
beforeEach(() => { mockHttp.mockReset() })

// o log REAL do núcleo (o transporte loga por ele) — calado, como no r20
const coreLogger = (jest.requireActual('fiscal-api') as typeof fiscal).logger
beforeEach(() => {
  jest.spyOn(coreLogger, 'info').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'warn').mockImplementation(() => undefined)
  jest.spyOn(coreLogger, 'error').mockImplementation(() => undefined)
})
afterEach(() => { (coreLogger.info as jest.Mock).mockRestore?.(); (coreLogger.warn as jest.Mock).mockRestore?.(); (coreLogger.error as jest.Mock).mockRestore?.() })

const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj) })
async function settle<T>(p: Promise<T>): Promise<any> { try { return await p } catch (e) { return e } }
const realDeps = (): NfseDeps => ({ ...deps, adapter: adnAdapter as any })
const E2404 = () => ({ status: 404, headers: {}, text: JSON.stringify({
  tipoAmbiente: 1, versaoAplicativo: 'SefinNacional_1.6.0', dataHoraProcessamento: '2026-10-11T10:00:00-03:00',
  erro: { codigo: 'E2404', descricao: 'Não foi gerada uma NFS-e com o identificador de DPS informado' } }) })
/** A Sefin falsa: só o `GET /dps/{id}` (E2404 por padrão) e o convênio. */
function fiscoP(o: { dps?: () => any } = {}) {
  mockHttp.mockImplementation(async (call: HttpsCall) => {
    if (/convenio/.test(call.url)) return ok({ prazoCancelamentoDias: 365 })
    if (/\/dps\//.test(call.url)) return o.dps?.() ?? E2404()
    return { status: 404, headers: {}, text: '' }
  })
}

/** Irmã 2, mesmo Id/ambiente da candidata, reservada 11/10 08:00, SEM chave; voz e idade parametrizadas (molde do r20). */
const sibling = (lastKind: 'S' | null, over: any = {}) => tx({
  attempt: 2, createdAt: '2026-10-11 08:00:00', ageMinutes: IN_FLIGHT_MINUTES + 120, lastQueriedAt: null,
  ...(lastKind === null
    ? { lastEvent: null, lastKind: null, lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null }
    : { lastEvent: 1, lastKind, lastSource: 'P', lastDh: null, lastEventAt: '2026-10-11 08:00:01', lastEventAgeMinutes: IN_FLIGHT_MINUTES + 119 }),
  ...over,
})
function lifeScenario(sib: any) {
  const f1 = F()
  maxEvent = 2
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(sib)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [f1, sib], events: [] })
}
/** O predicado EXATO da asserção do teste de conhecimento negativo do R20-01 (nfse r20:284). */
const r20NegativeHolds = () => !(repo.insertTransmissionEvent as jest.Mock).mock.calls.some(c =>
  c[0].ref.institutionId === 1 && c[0].ref.invoiceId === INVOICE && c[1] === 2 && c[2] === A.userId && c[3]?.kind === 'F')

// ===========================================================================
// A réplica da CERCA da D-F102 (texto conferido contra o r20)
// ===========================================================================

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const WORKSPACE = path.resolve(PROJECT_ROOT, '..')
const R20_FILE = path.join(SRC_ROOT, '__tests__', 'adversarial-r20-gate.test.ts')
const SETES_COMPOSITION = setesApiPath('src', 'shared', 'invoice-transmission', 'invoice-transmission.ts')   // D-F117: tem de existir
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
/** [CORRIGIDO na sessão — R21-01] a réplica deu lugar à peça COMPARTILHADA `voice-kind-fence.ts` (AST): este é o predicado da cerca. */
const fenceFlags = (code: string) => tsProducesS(code)
/** …e este o CONJUNTO dela: todo lugar que escreve na voz (nfse-api src/scripts/migrations, núcleo, setes-api — pasta + migrations). */
const fenceScope = () => new Set(voiceFenceScope())
const rel = (f: string) => relWorkspace(f)
const read = (f: string) => fs.readFileSync(f, 'utf8')

describe('A CERCA da D-F102 é a peça compartilhada `voice-kind-fence.ts` (R21-01 corrigido na sessão — a réplica deixou de existir)', () => {
  it('[CORRIGIDO na sessão — R21-01] o r20 usa a peça compartilhada (AST + escopo de todo escritor da voz), não mais a regex sobre `uncomment`', () => {
    const r20 = read(R20_FILE)
    expect(r20).toContain(`import { voiceSProducers } from './voice-kind-fence'`)
    expect(r20).toContain('expect(voiceSProducers()).toEqual([])')
    expect(r20).not.toMatch(/\.filter\(f => \/kind:\\s\*'S'\//)
  })
  it('resistiu: a réplica, sobre o conjunto REAL, dá o mesmo veredito da cerca hoje — nenhum produtor de S', () => {
    expect([...fenceScope()].filter(f => fs.existsSync(f) && fenceFlags(read(f))).map(rel)).toEqual([])
  })
  it('resistiu: a forma CANÔNICA de um produtor de S (a do precedente real — o registro do boleto no setes-api grava `kind: \'S\', source: \'P\'` na voz do BANCO) É pega pela cerca', () => {
    const bank = setesApiPath('src', 'shared', 'bank-slip-registration', 'bank-slip-registration.ts')
    expect(fenceFlags(read(bank))).toBe(true)
    expect(fenceFlags(`await insertTransmissionEvent(conn, i, n, a, u, { kind: 'S', source: 'P', dh: null })`)).toBe(true)
    expect(fenceFlags(`await insertTransmissionEvent(conn, i, n, a, u, { kind:'S', source: 'P' })`)).toBe(true)
    expect(fenceFlags(`const v = { kind: 'S' as TransmissionEventKind }`)).toBe(true)
  })
})

// ===========================================================================
// ATAQUE 1 — ESCAPE DA CERCA (R21-01: variantes SINTÁTICAS e de ESCOPO; R21-02: produtores SEMÂNTICOS)
// ===========================================================================

/** Produtores de S que só mudam a GRAFIA — uma cerca por AST (ou por regex melhor) os pega. */
const SYNTACTIC: [string, string][] = [
  ['aspas duplas', `await insertTransmissionEvent(conn, i, n, a, u, { kind: "S", source: 'P', dh: null })`],
  ['crase (template sem substituição)', 'await insertTransmissionEvent(conn, i, n, a, u, { kind: `S`, source: \'P\', dh: null })'],
  ['espaço antes dos dois-pontos', `await insertTransmissionEvent(conn, i, n, a, u, { kind : 'S', source: 'P' })`],
  ['ternário (enviado × falha)', `await insertTransmissionEvent(conn, i, n, a, u, { kind: posted ? 'S' : 'F', source: 'P' })`],
  ['parênteses', `await insertTransmissionEvent(conn, i, n, a, u, { kind: ('S'), source: 'P' })`],
  ['cast angular', `await insertTransmissionEvent(conn, i, n, a, u, { kind: <TransmissionEventKind>'S', source: 'P' })`],
  ['propriedade computada', `await insertTransmissionEvent(conn, i, n, a, u, { ['kind']: 'S', source: 'P' })`],
  ['atribuição depois do literal', `const ev: TransmissionEventInput = { kind: 'F', source: 'P' }\nev.kind = 'S'\nawait insertTransmissionEvent(conn, i, n, a, u, ev)`],
  ['SQL cru — INSERT', "await conn.query(`INSERT INTO tb_invoice_service_transmission_event (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source) VALUES (?, ?, 0, ?, ?, 'S', 'P')`, [i, n, a, e])"],
  ['SQL cru — UPDATE', "await conn.query(`UPDATE tb_invoice_service_transmission_event SET kind = 'S' WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [i, n])"],
]
/** Produtores de S cujo literal NÃO está ao lado do `kind` — nenhuma cerca TEXTUAL os pega; só o TIPO do escritor (Q-F111). */
const SEMANTIC: [string, string][] = [
  ['constante nomeada', `const SENT: TransmissionEventKind = 'S'\nawait insertTransmissionEvent(conn, i, n, a, u, { kind: SENT, source: 'P' })`],
  ['shorthand', `const kind: TransmissionEventKind = 'S'\nawait insertTransmissionEvent(conn, i, n, a, u, { kind, source: 'P' })`],
  ['mapa novo (molde do OUTCOME_KIND)', `const PRESENTED_KIND = { posted: 'S' } as const\nawait insertTransmissionEvent(conn, i, n, a, u, { kind: PRESENTED_KIND.posted, source: 'P' })`],
  ['kind dinâmico (parâmetro)', `const voice = (k: TransmissionEventKind) => insertTransmissionEvent(conn, i, n, a, u, { kind: k, source: 'P' })\nawait voice('S')`],
]

/**
 * A ALTERNATIVA que fecha o R21-01 (a lição do gate r8 do núcleo — ADV-R8-06: comentário se tira pelo COMPILADOR, nunca por regex;
 * `fiscal-api/src/__tests__/fence.ts`): AST do TypeScript — `kind` (identificador, string ou computada) cujo valor CONTÉM o literal S
 * em qualquer grafia; atribuição a `.kind`/`['kind']`; e SQL de ESCRITA na voz com 'S'. Só demonstra que a correção cabe na sessão.
 */
function astFlags(code: string): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const isS = (n: ts.Node) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'S'
  const hasS = (n: ts.Node): boolean => isS(n) || !!ts.forEachChild(n, c => (hasS(c) ? true : undefined))
  const nameIsKind = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text === 'kind'
    : ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression) && n.expression.text === 'kind'
  const textOf = (n: ts.Node) => ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n) ? n.text
    : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map(s => s.literal.text)].join('?') : null
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (ts.isPropertyAssignment(n) && nameIsKind(n.name) && hasS(n.initializer)) hit = true
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && hasS(n.right)
      && ((ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'kind')
        || (ts.isElementAccessExpression(n.left) && ts.isStringLiteral(n.left.argumentExpression) && n.left.argumentExpression.text === 'kind'))) hit = true
    else {
      const sql = textOf(n)
      if (sql && /\b(?:INSERT|REPLACE|UPDATE)\b[\s\S]*transmission_event\b[\s\S]*'S'/i.test(sql)) hit = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

describe('ATAQUE 1 — ESCAPE da cerca da D-F102: a promessa é "a cerca quebra no dia em que S ganhar produtor" (kinds.ts do núcleo; teste r20:286)', () => {
  it.each(SYNTACTIC)('[CORRIGIDO na sessão] [LOW R21-01] produtor de S com GRAFIA diferente (%s) → a cerca o pega', (_label, src) => {
    expect(fenceFlags(src)).toBe(true)
  })
  it('[CORRIGIDO na sessão — R21-01] a cerca (AST) pega TODAS as variantes sintáticas — e concorda com a alternativa por AST deste gate', () => {
    expect(SYNTACTIC.filter(([, src]) => !fenceFlags(src)).map(([l]) => l)).toEqual([])
    expect(SYNTACTIC.filter(([, src]) => !astFlags(src)).map(([l]) => l)).toEqual([])
  })
  it('resistiu: a alternativa por AST NÃO acusa nada no código REAL — nem no conjunto da cerca, nem nos escritores fora dela (scripts, setes-api) — e pega a forma canônica', () => {
    const extra = [path.join(PROJECT_ROOT, 'scripts'), setesApiPath('src', 'shared', 'invoice-transmission')].flatMap(walkTs)
    const all = [...new Set([...fenceScope(), ...extra.map(f => path.resolve(f))])].filter(f => fs.existsSync(f))
    expect(all.length).toBeGreaterThan(40)
    expect(all.filter(f => astFlags(read(f))).map(rel)).toEqual([])
    expect(astFlags(`await insertTransmissionEvent(conn, i, n, a, u, { kind: 'S', source: 'P' })`)).toBe(true)
    expect(astFlags(`const r = await conn.query(\`SELECT 1 FROM tb_invoice_service_transmission_event WHERE kind IN ('S','K')\`)`)).toBe(false)   // leitor não é produtor
  })

  it.each(SEMANTIC)('[LIMITE da cerca TEXTUAL — D-F106 (= Q-F112 (b)): quem pega é o TIPO] produtor de S SEMÂNTICO (%s) escapa da cerca por AST', (_label, src) => {
    expect(fenceFlags(src)).toBe(false)
  })
  it('[DECIDIDO — D-F106 (= Q-F112 (b))] o TIPO do escritor da NFS-e (`ServiceVoiceWriteKind` — lista POSITIVA A/R/C/K/F/N) recusa S em TODA forma — testemunhas de COMPILAÇÃO (ts-jest/tsc: um `@ts-expect-error` sem erro QUEBRA a compilação)', () => {
    expect(SEMANTIC.filter(([, src]) => fenceFlags(src) || astFlags(src)).map(([l]) => l)).toEqual([])   // a cerca textual não os vê…
    // …o compilador vê: literal
    // @ts-expect-error — D-F106: o escritor da NFS-e não aceita S
    const literal: TransmissionEventInput = { kind: 'S', source: 'P' }
    // constante nomeada com o tipo COMUM
    const SENT: SharedKind = 'S'
    // @ts-expect-error — D-F106
    const named: TransmissionEventInput = { kind: SENT, source: 'P' }
    // shorthand
    const kind: SharedKind = 'S'
    // @ts-expect-error — D-F106
    const short: TransmissionEventInput = { kind, source: 'P' }
    // mapa novo (molde do OUTCOME_KIND)
    const PRESENTED = { posted: 'S' } as const
    // @ts-expect-error — D-F106
    const mapped: TransmissionEventInput = { kind: PRESENTED.posted, source: 'P' }
    // parâmetro com o tipo comum
    // @ts-expect-error — D-F106
    const voice = (k: SharedKind): TransmissionEventInput => ({ kind: k, source: 'P' })
    // os kinds da família seguem aceitos (o tipo não quebrou a escrita legítima)
    const ok: TransmissionEventInput[] = (['A', 'R', 'C', 'K', 'F', 'N'] as const).map(k => ({ kind: k, source: 'P' as const }))
    expect([literal, named, short, mapped].map(v => v.kind)).toEqual(['S', 'S', 'S', 'S'])        // nunca vão ao escritor — lá o FUNIL os recusaria (R22-03)
    expect(typeof voice).toBe('function')
    expect(ok).toHaveLength(6)
    // S1 (gate socrático da Rodada 22): testemunhas presas à CHAMADA do escritor REAL — a função NÃO roda (só o compilador a lê); se o
    // `repo.insertTransmissionEvent` voltar a aceitar S/P/D ou o vocabulário comum, o `@ts-expect-error` sem erro QUEBRA a compilação
    const neverRun = async (conn: fiscal.PoolConnection) => {
      // @ts-expect-error — D-F106: o escritor REAL recusa S
      await repo.insertTransmissionEvent(itxOf(conn, 1, 1), 1, null, { kind: 'S', source: 'P' })
      // @ts-expect-error — D-F106: P (NF-e, em processamento) não é da família NFS-e
      await repo.insertTransmissionEvent(itxOf(conn, 1, 1), 1, null, { kind: 'P', source: 'Q' })
      // @ts-expect-error — D-F106: D (NF-e, denegada) não é da família NFS-e
      await repo.insertTransmissionEvent(itxOf(conn, 1, 1), 1, null, { kind: 'D', source: 'Q' })
      // @ts-expect-error — D-F106: o vocabulário COMUM não cabe no do escritor
      await repo.insertTransmissionEvent(itxOf(conn, 1, 1), 1, null, { kind: SENT, source: 'P' })
      await repo.insertTransmissionEvent(itxOf(conn, 1, 1), 1, null, { kind: 'F', source: 'P' })        // a família segue aceita
    }
    expect(typeof neverRun).toBe('function')
  })

  it('contexto (histórico — a regex antiga): `uncomment` trata o `/*` do XPath `//*[@Id=…]` (fiscal-api/src/transport/xmldsig.ts:54) como abertura de comentário e engole código de verdade; a cerca nova (AST) não usa mais `uncomment`', () => {
    const f = path.join(WORKSPACE, 'fiscal-api', 'src', 'transport', 'xmldsig.ts')
    const code = read(f)
    const i = code.split('\n').findIndex(l => l.includes('//*[@Id='))
    expect(i).toBeGreaterThanOrEqual(0)
    for (const real of ['privateKey: opts.key', 'sig.computeSignature(']) {         // o corpo do `signXml` (linhas 55–64)
      expect(code).toContain(real)
      expect(uncomment(code)).not.toContain(real)                                   // código REAL some da visão da cerca
    }
  })
  it('[CORRIGIDO na sessão] [LOW R21-01] produtor CANÔNICO (`kind: \'S\'`) escrito logo depois do XPath do xmldsig.ts (texto real, injeção em memória) → a cerca o pega', () => {
    const lines = read(path.join(WORKSPACE, 'fiscal-api', 'src', 'transport', 'xmldsig.ts')).split('\n')
    const i = lines.findIndex(l => l.includes('//*[@Id='))
    const injected = [...lines.slice(0, i + 1), `  const voice = { kind: 'S', source: 'P' }`, ...lines.slice(i + 1)].join('\n')
    expect(fenceFlags([...lines, `const voice = { kind: 'S', source: 'P' }`].join('\n'))).toBe(true)   // no fim do arquivo: pega
    expect(fenceFlags(injected)).toBe(true)                                                             // na janela: NÃO pega
  })

  /** Arquivos que ESCREVEM na voz: chamam o escritor tipado ou têm SQL de escrita na tabela da voz (TS ou .sql). */
  function voiceWriters(): string[] {
    const sqlUnder = (d: string): string[] => (!fs.existsSync(d) ? [] : fs.readdirSync(d).filter(n => n.endsWith('.sql')).map(n => path.join(d, n)))
    const candidates = [
      ...walkTs(SRC_ROOT), ...walkTs(path.join(PROJECT_ROOT, 'scripts')), ...sqlUnder(path.join(SRC_ROOT, 'migrations', 'sql')),
      ...walkTs(path.join(WORKSPACE, 'fiscal-api', 'src')), ...sqlUnder(path.join(WORKSPACE, 'fiscal-api', 'src', 'migrations', 'sql')),
      ...walkTs(setesApiPath('src', 'shared', 'invoice-transmission')),
      ...sqlUnder(setesApiPath('src', 'migrations', 'sql')),
    ]
    // alvo com ou sem qualificador (`${s}`.x, `x`, x — com a crase escapada `\`` dentro de template)
    const WRITE = /\b(?:INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO|UPDATE)\s+(?:\\?`?\$\{\w+\}\\?`?\.|\\?`?\w+\\?`?\.)?\\?`?tb_invoice_service_transmission_event\b/i
    return [...new Set(candidates.map(f => path.resolve(f)))]
      .filter(f => { const c = read(f); return WRITE.test(c) || /\binsertTransmissionEvent\(\s*conn/.test(c) })
  }
  it('[CORRIGIDO na sessão — R21-01] os escritores que ficavam FORA — a cópia do `migrate:setes`, as migrations .sql e o repositório do setes-api — agora estão no conjunto da cerca', () => {
    const scope = fenceScope()
    for (const f of ['nfse-api/scripts/migrate-from-setes-api.ts', 'nfse-api/src/migrations/sql/002_cancel_event_code.sql',
      'setes-api/src/shared/invoice-transmission/transmission.repository.ts']) {
      expect([...scope].map(rel)).toContain(f)
    }
  })
  it('[CORRIGIDO na sessão] [LOW R21-01] ESCOPO: todo arquivo que escreve na voz (escritor tipado, SQL em .ts ou .sql, nas três pastas) está no conjunto que a cerca varre', () => {
    const scope = fenceScope()
    expect(voiceWriters().filter(f => !scope.has(f)).map(rel)).toEqual([])
  })
})

// ===========================================================================
// ATAQUE 2 — existe HOJE caminho que grave S (ou kind fora de A/R/C/K/F/N)?
// ===========================================================================

describe('ATAQUE 2 — os escritores de HOJE: nenhum grava S nem kind fora do domínio', () => {
  /** Todo `insertTransmissionEvent(…)` com o objeto da voz: o valor de `kind` tem de ser literal do domínio ou `OUTCOME_KIND[…]`. NE-1a parte 2
   *  (passo 5): as escritas pelas POLÍTICAS do núcleo contam igual — `recordVoiceOnce(portas, …, {kind…})` pelo objeto, e
   *  `reserveCancelRequest`/`releaseCancelRequest` com o K/N FIXOS na peça (`fiscal-api/src/voice/policy.ts`, conferida no teste). */
  function writerCalls(code: string): { kindText: string; ok: boolean }[] {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: { kindText: string; ok: boolean }[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(?:reserveCancelRequest|releaseCancelRequest)$/.test(n.expression.text)) {
        out.push({ kindText: n.expression.text === 'reserveCancelRequest' ? "kind: 'K' (núcleo)" : "kind: 'N' (núcleo)", ok: true })
      } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(?:insertTransmissionEvent|recordVoiceOnce|recordKindOnce)$/.test(n.expression.text)) {
        const obj = [...n.arguments].reverse().find(ts.isObjectLiteralExpression)        // o objeto da VOZ é o último (recordVoiceOnce: o 1º são as portas)
        const p = obj?.properties.find(q => (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf) === 'kind')
        const init = p && ts.isPropertyAssignment(p) ? p.initializer : null
        const literalOk = !!init && ts.isStringLiteral(init) && ['A', 'R', 'C', 'K', 'F', 'N'].includes(init.text)
        const mapOk = !!init && ts.isElementAccessExpression(init) && init.expression.getText(sf) === 'OUTCOME_KIND'
        out.push({ kindText: p ? p.getText(sf) : '<sem kind>', ok: literalOk || mapOk })
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  it('resistiu: nfse-api (src + scripts) — cada chamada ao escritor tipado passa `kind` LITERAL de {A,R,C,K,F,N} ou `OUTCOME_KIND[…]` (AST, não regex)', () => {
    const calls = [...walkTs(SRC_ROOT), ...walkTs(path.join(PROJECT_ROOT, 'scripts'))].flatMap(f => writerCalls(read(f)).map(c => ({ ...c, f: rel(f) })))
    expect(calls.length).toBeGreaterThanOrEqual(10)
    expect(calls.filter(c => !c.ok)).toEqual([])
    // as políticas do núcleo: K e N LITERAIS, dh NULL, pelo escritor recebido (a lista da família o tipa) — nenhuma outra escrita lá
    const policy = read(path.join(WORKSPACE, 'fiscal-api', 'src', 'voice', 'policy.ts'))
    expect(policy).toMatch(/return write\(itx, attempt, userId, \{ kind: 'K', source: 'P', dh: null, message: CANCEL_REQUEST_IN_FLIGHT \}\)/)
    expect(policy).toMatch(/await write\(itx, attempt, userId, \{ kind: 'N', source: 'P', dh: null, message: message\.slice\(0, 255\) \}\)/)
    expect(policy.match(/\bkind: '[A-Z]'/g)).toEqual(["kind: 'K'", "kind: 'N'"])
  })
  it('resistiu: setes-api (a composição de produção, lida como texto) — idem', () => {
    const calls = writerCalls(read(SETES_COMPOSITION))
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(calls.filter(c => !c.ok)).toEqual([])
  })
  it('resistiu: o mapa `OUTCOME_KIND` só dá R/F; nenhuma rota/DTO recebe `kind`; nenhum cast de `kind` nos escritores', () => {
    const { OUTCOME_KIND } = jest.requireActual('../nfse/transmission') as typeof import('../nfse/transmission')
    expect([...new Set(Object.values(OUTCOME_KIND))].sort()).toEqual(['F', 'R'])
    const modules = walkTs(path.join(SRC_ROOT, 'modules'))
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.filter(f => /\bkind\b/.test(read(f))).map(rel)).toEqual([])
    const writers = [...walkTs(SRC_ROOT), ...walkTs(path.join(PROJECT_ROOT, 'scripts'))]
    expect(writers.filter(f => /\bas\s+TransmissionEventKind\b|[=:(,?]\s*<TransmissionEventKind>\s*['"`\w]/.test(read(f))).map(rel)).toEqual([])
  })
  it('contexto: o ÚNICO escritor que NÃO passa pelo tipo é a cópia do `migrate:setes` — `INSERT IGNORE … SELECT … ev.kind` da origem, sem conferir o domínio (o setes-api também não tem CHECK de `kind`); a garantia "escritores tipados" da D-F103 vale só por TRANSITIVIDADE (o escritor da origem é tipado) — ver R21-05 no núcleo', () => {
    const script = read(path.join(PROJECT_ROOT, 'scripts', 'migrate-from-setes-api.ts')).replace(/\s+/g, ' ')
    expect(script).toMatch(/INSERT IGNORE INTO tb_invoice_service_transmission_event \([^)]*\bkind\b[^)]*\) SELECT [^;]*\bev\.kind\b/)
    expect(script).not.toMatch(/ev\.kind\s+IN\s*\(/)
  })
})

// ===========================================================================
// ATAQUE 3 — o teste de conhecimento negativo do R20-01 passa pelo motivo CERTO?
// ===========================================================================

describe('ATAQUE 3 — o teste "[CONHECIMENTO NEGATIVO — D-F102]" do r20 (nfse r20:280-285)', () => {
  it('resistiu (motivo certo HOJE): a MESMA chamada chega à decisão — devolve S sem mudança, carimba "nós olhamos", pede o carimbo do E2404 na própria S, e NÃO grava voz nenhuma (nem F)', async () => {
    lifeScenario(sibling('S'))
    fiscoP({})
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', { attempt: 2, fromRun: true })
    expect(r).toMatchObject({ attempt: 2, changed: false, kind: 'S' })
    expect(repo.touchQueriedAt).toHaveBeenCalledWith(expect.anything(), refOf(1, INVOICE), 2)
    expect(pool.query.mock.calls.some((c: any[]) => /nfse_not_generated_at = NOW\(\)/.test(c[0]) && Number(c[1]?.[3]) === 2)).toBe(true)
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(r20NegativeHolds()).toBe(true)
  })
  it('contexto: a asserção do r20 também fica VERDE quando a chamada NEM CHEGA à decisão — o `settle` engole o erro (fisco 503 = ambíguo → 502)', async () => {
    lifeScenario(sibling('S'))
    fiscoP({ dps: () => ({ status: 503, headers: {}, text: 'no healthy upstream' }) })
    const out = await settle(refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', { attempt: 2, fromRun: true }))
    expect(out).toBeInstanceOf(Error)
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()
    expect(r20NegativeHolds()).toBe(true)                                         // a asserção do r20 passa sem a decisão ter sido tomada
  })
  it('[CORRIGIDO na sessão] [LOW R21-04] o teste do conhecimento negativo do r20 ANCORA a decisão (aguarda a chamada sem `settle` e afirma o resultado "S sem mudança") — senão fica verde também quando o caminho quebra antes de decidir', () => {
    const r20 = read(R20_FILE)
    const start = r20.indexOf('[CONHECIMENTO NEGATIVO — D-F102')
    expect(start).toBeGreaterThan(0)
    const block = r20.slice(start, r20.indexOf('\n  })', start))
    expect(block).not.toMatch(/settle\(refreshServiceTransmission/)
    expect(block).toMatch(/changed: false/)
  })
})

// ===========================================================================
// ATAQUE 4 — o aviso da D-F102 leva o próximo dev ao lugar CERTO?
// ===========================================================================

describe('ATAQUE 4 — "quem criar produtor de S dá a ela a saída da D-F51": o aviso aponta só o PREDICADO (`isInterruptedInFlight`), mas a saída tem DOIS portões — o predicado e a reconferência SOB A TRAVA (`recordInterruptedFailure`: `cur.lastKind !== null` → não grava)', () => {
  it('contexto: o 2º portão existe no código — a reconferência sob a trava recusa toda tentativa COM voz (nfse transmission.ts `recordInterruptedFailure`; setes-api `reconcileInterrupted`)', () => {
    const code = uncomment(read(path.join(SRC_ROOT, 'nfse', 'transmission.ts')))
    const body = code.slice(code.indexOf('async function recordInterruptedFailure'), code.indexOf('async function recordInterruptedFailure') + 800)
    expect(body).toMatch(/if \(!cur \|\| cur\.lastKind !== null\) return \{ recorded: false, current: cur \}/)
    expect(read(SETES_COMPOSITION)).toMatch(/if \(!cur \|\| cur\.attempt !== tx\.attempt \|\| cur\.lastKind !== null\) return/)
  })
  it('contexto: estender SÓ o predicado (o que o aviso sugere) cai no ramo "perdeu a corrida" A CADA passada — devolve S sem carimbar `last_queried_at` nem o E2404: a S nunca sai do topo do rodízio (consulta o fisco toda passada — "monopoliza o rodízio") e a prova nunca volta', async () => {
    // a tentativa VISTA fora da trava parece "sem voz e velha" (o que o predicado estendido diria da S); sob a trava, ela tem voz S
    const seen = sibling(null)
    const underLock = sibling('S')
    expect(isInterruptedInFlight(seen as any)).toBe(true)
    lifeScenario(seen)
    ;(repo.getTransmission as jest.Mock).mockImplementation(async (q: unknown) => (q === conn ? underLock : seen))
    fiscoP({})
    const r = await refreshServiceTransmission(realDeps(), A, webRef(A, INVOICE), 'Q', { attempt: 2, fromRun: true })
    expect(r).toMatchObject({ attempt: 2, changed: false, kind: 'S' })
    expect(repo.insertTransmissionEvent).not.toHaveBeenCalled()
    expect(repo.touchQueriedAt).not.toHaveBeenCalled()                            // sem o carimbo do throttle
    expect(stamps).toEqual([])                                                     // e sem o E2404 (a prova não volta)
  })
  it('[CORRIGIDO na sessão] [LOW R21-03] o aviso da D-F102 nomeia os DOIS portões da saída (o predicado E a reconferência sob a trava) nos três lugares onde mora (kinds.ts do núcleo; `isInterruptedInFlight` da nfse-api e do setes-api)', () => {
    // o bloco de comentário IMEDIATAMENTE acima da âncora (do último parágrafo em branco até ela)
    const near = (file: string, anchor: string) => { const c = read(file).replace(/\r\n/g, '\n'); const i = c.indexOf(anchor); expect(i).toBeGreaterThan(0); return c.slice(Math.max(0, c.lastIndexOf('\n\n', i)), i) }
    const sites = [
      near(path.join(SRC_ROOT, 'nfse', 'transmission.ts'), 'export function isInterruptedInFlight'),
      near(path.join(WORKSPACE, 'fiscal-api', 'src', 'voice', 'kinds.ts'), 'export type TransmissionEventKind'),
      near(SETES_COMPOSITION, 'export function isInterruptedInFlight'),
    ]
    for (const s of sites) {
      expect(s).toMatch(/D-F102/)
      expect(s).toMatch(/recordInterruptedFailure|reconcileInterrupted|sob a trava/)
    }
  })
})
