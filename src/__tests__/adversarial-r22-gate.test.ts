/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 22 das APIs fiscais (D-F105…D-F106, Valdo 2026-10-11) — nfse-api (+ setes-api e núcleo lidos/COMPILADOS em
// memória). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta:
//  - D-F105 (= Q-F111 (a)): a cerca da voz S vale só para a família NFS-e — `voice-kind-fence.ts`: SQL só em
//    `invoice_service_transmission_event`; no NÚCLEO (`fiscal-api/`) só SQL (`sqlOnly`) — o `kind: 'S'` de lá é da NF-e.
//  - D-F106 (= Q-F112 (b)): a lista POSITIVA da família — `SERVICE_VOICE_WRITE_KINDS = ['A','R','C','K','F','N'] as const satisfies
//    readonly TransmissionEventKind[]`, `ServiceVoiceWriteKind` DERIVADO dela — tipa `TransmissionEventInput.kind` (nfse-api
//    `src/nfse/repository.ts` e setes-api `transmission.repository.ts`) e o `OUTCOME_KIND`.
//
// As camadas que protegem a voz S da NFS-e e que este gate ataca em conjunto:
//  (T) o TIPO do escritor (D-F106) · (A) a cerca por AST (`tsProducesS`/`sqlFileProducesS`, D-F102/D-F105) · (W) a cerca de CHAMADA
//  (`writerCallFlags` da peça `voice-kind-fence.ts` — a `writerCalls` do r21 promovida e endurecida na sessão: R22-01/02/04/05) ·
//  (R) o FUNIL em execução do escritor e o `OUTCOME_KIND` congelado (R22-03/R22-02).
//
// CONVERSÃO PÓS-CORREÇÃO (2026-10-11, §21.16 do prompt): os achados R22-01…R22-07 foram corrigidos NA SESSÃO — cada `it.failing` virou
// `it('[CORRIGIDO na sessão] …')` e os "contexto" que fixavam o comportamento ANTIGO passaram a fixar o NOVO (marcados igual). A réplica
// local da cerca do r21 (`callFenceFlags`) saiu: (W) é a PEÇA. O que escapava antes está em `ESCAPED_BEFORE` (histórico).
// "Compila" é medido de VERDADE: um `Program` do TypeScript com o tsconfig REAL do projeto e arquivos VIRTUAIS em memória (nada no disco —
// `writeFile` lança; conferido no afterAll); a simulação da NE-1a troca o `kinds.ts` do núcleo EM MEMÓRIA.
//
//  * ACHADOS (`it.failing('[SEV R22-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual (prova do achado);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket, nenhum banco (o escritor real roda contra uma conexão FALSA em memória), nada no disco, nada que fale
// com o fisco. Lê o setes-api, o núcleo, os scripts e as migrations só como TEXTO (ou os compila em memória, sem emitir).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { tsProducesS, sqlFileProducesS, voiceFenceScope, voiceSProducers, walkTs, writerCallFlags, VOICE_SQL_WRITERS, WORKSPACE } from './voice-kind-fence'
import { insertTransmissionEvent } from '../nfse/repository'
import type { TransmissionEventInput, ServiceVoiceWriteKind } from '../nfse/repository'
import { OUTCOME_KIND } from '../nfse/transmission'
import type { TransmissionEventKind as SharedKind, PoolConnection } from 'fiscal-api'

jest.setTimeout(180_000)

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const NFSE = PROJECT_ROOT
const SETES = path.join(WORKSPACE, 'setes-api')
const SETES_IT = path.join(SETES, 'src', 'shared', 'invoice-transmission')
const CORE_KINDS = path.join(WORKSPACE, 'fiscal-api', 'src', 'voice', 'kinds.ts')
const R21_FILE = path.join(SRC_ROOT, '__tests__', 'adversarial-r21-gate.test.ts')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => path.relative(WORKSPACE, f).replace(/\\/g, '/')
const norm = (p: string) => path.resolve(p).split(path.sep).join('/')

// ===========================================================================
// Ferramentas do gate
// ===========================================================================

const VIRTUAL_NFSE = path.join(SRC_ROOT, '__r22_virtual__')                 // NUNCA criada
const VIRTUAL_SETES = path.join(SETES_IT, '__r22_virtual__')               // NUNCA criada
afterAll(() => { expect([fs.existsSync(VIRTUAL_NFSE), fs.existsSync(VIRTUAL_SETES)]).toEqual([false, false]) })

/**
 * Compila em MEMÓRIA, com o tsconfig REAL do projeto: `snippets` viram arquivos virtuais (cabeçalho + código) e `overrides` trocam o texto
 * de arquivos reais (a NE-1a simulada). Devolve, por snippet, os diagnósticos; e por arquivo real pedido em `alsoCheck`, os dele.
 */
function compileInMemory(projectDir: string, virtualDir: string, header: string, snippets: [string, string][],
  opts: { overrides?: Record<string, string>; alsoCheck?: string[] } = {}): { snippet: Map<string, string[]>; real: Map<string, string[]> } {
  const cfg = ts.readConfigFile(path.join(projectDir, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, projectDir)
  const virt = new Map<string, string>(snippets.map(([, code], i) => [norm(path.join(virtualDir, `s${i}.ts`)), `${header}\n${code}\n`]))
  const over = new Map<string, string>(Object.entries(opts.overrides ?? {}).map(([k, v]) => [norm(k), v]))
  const textOf = (f: string) => virt.get(norm(f)) ?? over.get(norm(f))
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host), getSourceFile = host.getSourceFile.bind(host)
  host.readFile = f => textOf(f) ?? readFile(f)
  host.fileExists = f => textOf(f) !== undefined || fileExists(f)
  host.getSourceFile = (f, lang, onErr, create) => { const t = textOf(f); return t !== undefined ? ts.createSourceFile(f, t, lang, true) : getSourceFile(f, lang, onErr, create) }
  host.writeFile = () => { throw new Error('o gate nunca escreve no disco') }
  const roots = [...virt.keys(), ...(opts.alsoCheck ?? []).map(norm)]
  const program = ts.createProgram(roots, { ...parsed.options, noEmit: true }, host)
  const diags = (f: string) => { const sf = program.getSourceFile(f)!; return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')) }
  return {
    snippet: new Map(snippets.map(([label], i) => [label, diags([...virt.keys()][i])])),
    real: new Map((opts.alsoCheck ?? []).map(f => [rel(f), diags(norm(f))])),
  }
}

/** Trecho EXECUTÁVEL deste próprio arquivo entre `// <r22:nome>` e `// </r22:nome>` — o texto que as cercas leem É o código que roda. */
function region(name: string): string {
  const src = read(__filename).replace(/\r\n/g, '\n')
  const a = src.indexOf(`// <r22:${name}>`), b = src.indexOf(`// </r22:${name}>`)
  expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a)
  return src.slice(src.indexOf('\n', a) + 1, b)
}

/** Conexão FALSA: o escritor REAL roda inteiro (MAX+1 e INSERT) sem banco; devolve os parâmetros do INSERT. */
function fakeConn() {
  const inserts: unknown[][] = []
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/MAX\(event\)/.test(sql)) return [[{ next: 1 }]]
    if (/^\s*INSERT INTO tb_invoice_service_transmission_event/.test(sql)) inserts.push(params)
    return [{ affectedRows: 1 }]
  })
  // parâmetros do INSERT (repository.ts): [institution, nota, tentativa, evento, KIND, …]
  return { conn: { query } as unknown as PoolConnection, query, inserts, kindsWritten: () => inserts.map(p => p[4]) }
}

// ===========================================================================
// 0 — (W) é a cerca da PEÇA; o predicado do r21 segue contido nela
// ===========================================================================

describe('0 — a cerca de CHAMADA (W) é a da peça `voice-kind-fence.ts`', () => {
  it('[CORRIGIDO na sessão] a réplica local saiu: (W) = `writerCallFlags` da peça — tudo o que o predicado do r21 (`writerCalls`: identificador nu, literal da família ou `OUTCOME_KIND[…]`) recusa, a peça recusa; o legítimo segue aceito', () => {
    const r21 = read(R21_FILE)
    expect(r21).toContain(`ts.isIdentifier(n.expression) && n.expression.text === 'insertTransmissionEvent'`)   // o r21 continua com o predicado dele
    expect(read(__filename)).not.toContain('function ' + 'callFenceFlags')
    const call = (kind: string) => `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: ${kind}, source: 'P' })`
    for (const k of [`'S'`, `'P'`, `'D'`, 'WIDE', 'k', 'M.posted', `p ? WIDE : 'F'`]) expect([k, writerCallFlags(call(k))]).toEqual([k, true])
    for (const k of [`'A'`, `'R'`, `'C'`, `'K'`, `'F'`, `'N'`, `OUTCOME_KIND['local']`, 'OUTCOME_KIND[cls]']) expect([k, writerCallFlags(call(k))]).toEqual([k, false])
  })
})

// ===========================================================================
// ATAQUE 1 — furar o TIPO: quais formas passam no tsc E escapam das cercas (A) e (W)?
// ===========================================================================

const HEADER_NFSE = `import { insertTransmissionEvent, TransmissionEventInput, ServiceVoiceWriteKind } from '../nfse/repository'
import * as repo from '../nfse/repository'
import { insertTransmissionEvent as put } from '../nfse/repository'
import { OUTCOME_KIND } from '../nfse/transmission'
import type { TransmissionEventKind } from 'fiscal-api'
declare const conn: any
declare const WIDE: TransmissionEventKind        // um kind do vocabulário COMUM vindo de qualquer lugar (pode ser S)
declare const p: boolean
export {}`

/** [rótulo, código, compila? (medido), cerca AST (A)?, cerca de chamada da peça (W)?] — o esperado DEPOIS das correções da sessão. */
const ATTACKS: [string, string, boolean, boolean, boolean][] = [
  // --- o tipo pega (D-F106 cumpre o prometido) ---
  ['literal', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'S', source: 'P' })`, false, true, true],
  ['constante comum', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' })`, false, false, true],
  ['shorthand', `const kind: TransmissionEventKind = 'S'\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind, source: 'P' })`, false, false, true],
  ['mapa novo', `const M = { posted: 'S' } as const\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: M.posted, source: 'P' })`, false, false, true],
  ['parâmetro', `const v = (k: TransmissionEventKind) => insertTransmissionEvent(conn, 1, 1, 1, null, { kind: k, source: 'P' })`, false, false, true],
  ['ternário', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: p ? WIDE : 'F', source: 'P' })`, false, false, true],
  ['não-nulo', `const k: TransmissionEventKind | null = WIDE\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: k!, source: 'P' })`, false, false, true],
  ['genérico', `function g<K extends TransmissionEventKind>(k: K) { return insertTransmissionEvent(conn, 1, 1, 1, null, { kind: k, source: 'P' }) }`, false, false, true],
  ['spread ANTES do kind', `const b = { kind: WIDE }\ninsertTransmissionEvent(conn, 1, 1, 1, null, { ...b, source: 'P' })`, false, false, true],
  ['spread Partial<comum>', `declare const o: Partial<{ kind: TransmissionEventKind }>\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P', ...o })`, false, false, true],
  ['mapa da família atribuído', `OUTCOME_KIND.local = WIDE`, false, false, true],
  ['literal as Input', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'S', source: 'P' } as TransmissionEventInput)`, false, true, true],
  // --- o tipo NÃO pega, mas a cerca AST (A) ou a de chamada (W) pega ---
  ['as any (objeto)', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'S', source: 'P' } as any)`, true, true, true],
  ["'S' as WriteKind", `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'S' as ServiceVoiceWriteKind, source: 'P' })`, true, true, true],
  ['comum as WriteKind', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE as ServiceVoiceWriteKind, source: 'P' })`, true, false, true],
  ['comum as Input', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' } as TransmissionEventInput)`, true, false, true],
  ['unknown + cast', `const u: unknown = { kind: WIDE, source: 'P' }\ninsertTransmissionEvent(conn, 1, 1, 1, null, u as TransmissionEventInput)`, true, false, true],
  ['JSON.parse', `insertTransmissionEvent(conn, 1, 1, 1, null, JSON.parse('{"kind":"S","source":"P"}'))`, true, false, true],
  ['Object.assign inline', `insertTransmissionEvent(conn, 1, 1, 1, null, Object.assign({ kind: 'F' as const, source: 'P' as const }, { kind: WIDE }))`, true, false, true],
  ['SQL cru com S no texto', "conn.query(`INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES ('S', 'P')`)", true, true, true],
  // --- ESCAPAVAM das três camadas ANTES da sessão (ESCAPED_BEFORE); hoje a cerca de chamada da PEÇA pega todas ---
  ['spread POSTERIOR de Record<string, unknown>', `declare const extra: Record<string, unknown>\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P', ...extra })`, true, false, true],
  ['spread POSTERIOR de {}', `const extra: {} = { kind: WIDE }\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P', ...extra })`, true, false, true],
  ['spread POSTERIOR de any', `declare const extra: any\ninsertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P', ...extra })`, true, false, true],
  ['Object.assign no OUTCOME_KIND', `Object.assign(OUTCOME_KIND, { local: WIDE })`, true, false, true],
  ['Object.assign no OUTCOME_KIND (literal S)', `Object.assign(OUTCOME_KIND, { local: 'S' })`, true, false, true],
  ['Reflect.set no OUTCOME_KIND', `Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')`, true, false, true],
  ['namespace + cast', `repo.insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE as ServiceVoiceWriteKind, source: 'P' })`, true, false, true],
  ['alias + as any', `put(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' } as any)`, true, false, true],
  ['escritor com cast de função', `;(insertTransmissionEvent as (...a: any[]) => Promise<number>)(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' })`, true, false, true],
  ['SQL cru com placeholder (S nos parâmetros)', "conn.query('INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES (?, ?)', ['S', 'P'])", true, false, true],
  ['SQL cru com placeholder (kind comum)', "conn.query('INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES (?, ?)', [WIDE, 'P'])", true, false, true],
]
/** Histórico: o conjunto que escapava das três camadas ANTES das correções da sessão (com a réplica da cerca do r21). */
const ESCAPED_BEFORE = [
  'spread POSTERIOR de Record<string, unknown>', 'spread POSTERIOR de {}', 'spread POSTERIOR de any',
  'Object.assign no OUTCOME_KIND', 'Object.assign no OUTCOME_KIND (literal S)', 'Reflect.set no OUTCOME_KIND',
  'namespace + cast', 'alias + as any', 'escritor com cast de função',
  'SQL cru com placeholder (S nos parâmetros)', 'SQL cru com placeholder (kind comum)',
]
const ESCAPES = ATTACKS.filter(([, , c, a, w]) => c && !a && !w)
const codeOf = (label: string) => ATTACKS.find(([l]) => l === label)![1]

describe('ATAQUE 1 — furar o TIPO do escritor da NFS-e (D-F106) × as cercas (A) e (W)', () => {
  let compiled: Map<string, string[]>
  beforeAll(() => { compiled = compileInMemory(NFSE, VIRTUAL_NFSE, HEADER_NFSE, ATTACKS.map(([l, c]) => [l, c])).snippet })

  it('resistiu (MEDIDO): o cabeçalho dos ataques compila sozinho e o escritor legítimo (literal da família, `OUTCOME_KIND[…]`) segue aceito', () => {
    const ok = compileInMemory(NFSE, VIRTUAL_NFSE, HEADER_NFSE, [
      ['A', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'A', source: 'P' })`],
      ['mapa', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: OUTCOME_KIND['local'], source: 'P' })`],
    ]).snippet
    expect([...ok.values()]).toEqual([[], []])
  })
  it('[CORRIGIDO na sessão] a MATRIZ medida — compila? (programa real em memória) · cerca AST? · cerca de chamada da PEÇA? — confere com o esperado linha a linha', () => {
    const got = ATTACKS.map(([l, c]) => [l, (compiled.get(l) ?? ['?']).length === 0, tsProducesS(c), writerCallFlags(c)])
    expect(got).toEqual(ATTACKS.map(([l, , c, a, w]) => [l, c, a, w]))
  })
  it('[CORRIGIDO na sessão] D-F106 cumpre o prometido — TODA forma SEM cast que põe um kind fora da família DIRETO no objeto do escritor (literal, constante, shorthand, mapa, parâmetro, ternário, não-nulo, genérico, spread antes, Partial do comum) NÃO compila com o erro do tipo da família; e `OUTCOME_KIND.local = …` não compila porque o mapa agora é `Readonly` (R22-02)', () => {
    const typed = ['literal', 'constante comum', 'shorthand', 'mapa novo', 'parâmetro', 'ternário', 'não-nulo', 'genérico', 'spread ANTES do kind', 'spread Partial<comum>']
    // o tipo DERIVADO da constante aparece no erro pelo nome ou expandido na lista literal da família
    const familyType = /ServiceVoiceWriteKind|'"A" \| "R" \| "C" \| "K" \| "F" \| "N"'/
    for (const l of typed) {
      expect(compiled.get(l)!.length).toBeGreaterThan(0)
      expect(compiled.get(l)!.join(' ')).toMatch(familyType)
    }
    expect(compiled.get('mapa da família atribuído')!.join(' ')).toMatch(/read-only/)
  })
  it('[CORRIGIDO na sessão] NADA escapa das camadas estáticas — o que escapava antes (spread POSTERIOR de bolsa larga, mutação do `OUTCOME_KIND`, chamada por namespace/alias/cast, SQL cru com placeholder) a cerca de chamada da PEÇA pega', () => {
    expect(ESCAPES.map(([l]) => l)).toEqual([])
    expect(ESCAPED_BEFORE.filter(l => !writerCallFlags(codeOf(l)))).toEqual([])
  })

  it.each(ESCAPED_BEFORE.filter(l => /spread POSTERIOR/.test(l)))(
    '[CORRIGIDO na sessão] [LOW R22-01] spread POSTERIOR ao `kind` no objeto do escritor (%s) — compila SEM cast e sobrescreveria o kind em execução → a cerca de chamada pega (objeto com spread) e o funil recusa em execução (R22-03)',
    (label) => {
      expect((compiled.get(label) ?? []).length > 0 || tsProducesS(codeOf(label)) || writerCallFlags(codeOf(label))).toBe(true)
    })
  it.each(ESCAPED_BEFORE.filter(l => /OUTCOME_KIND/.test(l)))(
    '[CORRIGIDO na sessão] [LOW R22-02] mutação do `OUTCOME_KIND` exportado (%s) — compila SEM cast → a cerca de chamada pega e o mapa CONGELADO lança em execução',
    (label) => {
      expect((compiled.get(label) ?? []).length > 0 || tsProducesS(codeOf(label)) || writerCallFlags(codeOf(label))).toBe(true)
    })
  it.each(ESCAPED_BEFORE.filter(l => /namespace|alias|cast de função/.test(l)))(
    '[CORRIGIDO na sessão] [LOW R22-04] chamada ao escritor por namespace/alias/cast da função (%s) → a cerca de chamada pega (alias de import/`const`, `x.insertTransmissionEvent`, cast da função, objeto com `kind` sob cast em qualquer chamada)',
    (label) => {
      expect(tsProducesS(codeOf(label)) || writerCallFlags(codeOf(label))).toBe(true)
    })
  it.each(ESCAPED_BEFORE.filter(l => /placeholder/.test(l)))(
    '[CORRIGIDO na sessão] [LOW R22-05] SEGUNDO escritor por SQL cru com placeholder (%s) → a cerca pega: SQL de escrita na voz da NFS-e só nos escritores autorizados (`VOICE_SQL_WRITERS` — ESCRITOR ÚNICO)',
    (label) => {
      expect(tsProducesS(codeOf(label)) || writerCallFlags(codeOf(label))).toBe(true)
      expect(writerCallFlags(codeOf(label), { allowSqlWriter: true })).toBe(false)     // no escritor autorizado, o SQL dele é legítimo
    })
})

// ===========================================================================
// ATAQUE 1b — o efeito em EXECUÇÃO: o escritor REAL grava S quando o tipo é furado (conexão falsa, nenhum banco)
// ===========================================================================

describe('ATAQUE 1b — o escritor REAL (`insertTransmissionEvent`) em execução', () => {
  it('[CORRIGIDO na sessão] o spread POSTERIOR de uma bolsa `Record<string, unknown>` ainda compila NESTE arquivo (o ts-jest confere tipos), mas o escritor REAL RECUSA o S em execução (R22-03) sem nenhuma query — e a cerca de chamada da peça vê o trecho (R22-01; lido deste próprio arquivo)', async () => {
    const { conn, query, kindsWritten } = fakeConn()
    // <r22:spread>
    const extra: Record<string, unknown> = JSON.parse('{"kind":"S"}')
    await expect(insertTransmissionEvent(conn, 1, 6200, 1, 7, { kind: 'F', source: 'P', ...extra })).rejects.toThrow(/D-F106/)
    // </r22:spread>
    expect(kindsWritten()).toEqual([])
    expect(query).not.toHaveBeenCalled()
    const code = region('spread')
    expect([tsProducesS(code), writerCallFlags(code)]).toEqual([false, true])
  })
  it('[CORRIGIDO na sessão] [LOW R22-03] o funil ÚNICO da voz da NFS-e (`insertTransmissionEvent` — nfse-api `src/nfse/repository.ts` · setes-api `transmission.repository.ts`) recusa EM EXECUÇÃO kind fora da lista da família ANTES de qualquer query — fecha de uma vez R22-01/R22-02/R22-04 e todo cast (o tipo some no JS)', async () => {
    const { conn, query, inserts } = fakeConn()
    const ev = { kind: 'S', source: 'P' } as unknown as TransmissionEventInput
    await expect(insertTransmissionEvent(conn, 1, 6200, 1, 7, ev)).rejects.toThrow(/D-F106: kind fora do vocabulário de escrita da NFS-e \("S"\) — nada gravado/)
    expect(inserts).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })
  it('[CORRIGIDO na sessão] o escritor confere em execução — S, P, D, "s" minúsculo (que a colação _ci leria como S — D-F103), vazio e ausente são recusados sem query; os seis da família gravam', async () => {
    const { conn, query, kindsWritten } = fakeConn()
    for (const k of ['S', 'P', 'D', 's', 'a', '', undefined, null]) {
      await expect(insertTransmissionEvent(conn, 1, 6200, 1, 7, { kind: k, source: 'P' } as unknown as TransmissionEventInput)).rejects.toThrow(/D-F106/)
    }
    expect(query).not.toHaveBeenCalled()
    for (const k of ['A', 'R', 'C', 'K', 'F', 'N'] as const) await insertTransmissionEvent(conn, 1, 6200, 1, 7, { kind: k, source: 'P' })
    expect(kindsWritten()).toEqual(['A', 'R', 'C', 'K', 'F', 'N'])
  })
  it('[CORRIGIDO na sessão] `Object.assign(OUTCOME_KIND, { local: … })` ainda compila NESTE arquivo SEM cast, mas LANÇA em execução (mapa CONGELADO — R22-02) e o mapa do processo não muda; a cerca de chamada da peça vê o trecho', () => {
    // <r22:map>
    expect(() => Object.assign(OUTCOME_KIND, { local: 'S' })).toThrow(TypeError)
    // </r22:map>
    expect(OUTCOME_KIND).toEqual({ rejected: 'R', auth_failed: 'F', local: 'F' })
    const code = region('map')
    expect([tsProducesS(code), writerCallFlags(code)]).toEqual([false, true])
  })
  it('[CORRIGIDO na sessão] [LOW R22-02] o `OUTCOME_KIND` (o mapa que grava na voz) é IMUTÁVEL em execução — nfse-api `transmission.ts` e setes-api `branches/service.ts` (`Object.freeze`)', () => {
    expect(Object.isFrozen(OUTCOME_KIND)).toBe(true)
    expect(Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')).toBe(false)         // objeto congelado: o Reflect.set não muda nada
    expect(OUTCOME_KIND.auth_failed).toBe('F')
    const setes = path.join(SETES_IT, 'branches', 'service.ts')
    if (fs.existsSync(setes)) expect(read(setes)).toMatch(/OUTCOME_KIND[^=\n]*=\s*Object\.freeze\(/)
  })
})

// ===========================================================================
// ATAQUE 2 — a cerca com `sqlOnly` (D-F105): produtor de S da NFS-e escrito no NÚCLEO
// ===========================================================================

describe('ATAQUE 2 — D-F105: no núcleo a cerca só olha SQL na tabela da NFS-e', () => {
  const core = (code: string) => tsProducesS(code, { sqlOnly: true })
  it('resistiu: SQL de escrita na tabela da NFS-e com o S no texto É pego no núcleo — inclusive com o schema por substituição (a forma do setes-api)', () => {
    expect(core("await q.query(`INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES ('S', 'P')`)")).toBe(true)
    expect(core("await q.query(`INSERT INTO \\`${db}\\`.tb_invoice_service_transmission_event (kind, source) VALUES ('S', 'P')`)")).toBe(true)
    expect(core("await q.query(`UPDATE \\`${db}\\`.tb_invoice_service_transmission_event SET kind = 'S' WHERE attempt = ?`, [a])")).toBe(true)
    // texto REAL do repositório do setes-api com o kind do INSERT trocado por 'S' (injeção em memória): pego
    const setesRepo = path.join(SETES_IT, 'transmission.repository.ts')
    if (fs.existsSync(setesRepo)) {
      const real = read(setesRepo)
      expect(core(real)).toBe(false)
      const injected = real.replace("VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')", "VALUES (?, ?, 0, ?, ?, 'S', ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')")
      expect(injected).not.toBe(real)
      expect(core(injected)).toBe(true)
    }
  })
  it('resistiu: o caminho do núcleo é decidido pelo CAMINHO RESOLVIDO (`fiscal-api` + separador) — um irmão de nome parecido (`fiscal-api-x`) não herda o `sqlOnly`; o código REAL segue sem produtor', () => {
    const fence = read(path.join(SRC_ROOT, '__tests__', 'voice-kind-fence.ts'))
    expect(fence).toMatch(/path\.resolve\(f\)\.startsWith\(CORE_ROOT \+ path\.sep\)/)
    expect(voiceSProducers()).toEqual([])
    expect(voiceFenceScope().filter(f => f.startsWith(path.resolve(WORKSPACE, 'fiscal-api') + path.sep)).length).toBeGreaterThan(10)
  })
  it('[CORRIGIDO na sessão] [LOW R22-06] tabela da NFS-e por CONSTANTE (o nome é estático, só não está no literal do SQL) → a cerca pega (no núcleo e fora dele) — a constante string do mesmo arquivo é resolvida no template', () => {
    const src = "const VOICE = 'tb_invoice_service_transmission_event'\nawait q.query(`INSERT INTO ${VOICE} (kind, source) VALUES ('S', 'P')`)"
    expect(tsProducesS(src)).toBe(true)
    expect(core(src)).toBe(true)
  })
  it('contexto (Q-F114, R22-08 — Rodada 23): a forma NATURAL da NE-1a (D-NE13: máquina tentativa × voz no núcleo; tabelas irmãs POR FAMÍLIA — `tb_invoice_<ramo>_transmission_event`; D-NE14: vocabulário comum com P/D) é INVISÍVEL às defesas da NFS-e: a cerca no núcleo (sqlOnly: o `kind: \'S\'` é ignorado e a tabela vem do descritor da família), a cerca de chamada (só conhece `insertTransmissionEvent`) e o tipo (o escritor do núcleo é tipado pelo vocabulário COMUM — S/P/D)', () => {
    const generic = [
      'export async function insertVoice(conn: Conn, family: VoiceFamily, at: Attempt, e: { kind: TransmissionEventKind; source: TransmissionSource }) {',
      "  await conn.query(`INSERT INTO ${family.eventTable} (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,",
      '    [at.institutionId, at.invoiceId, at.terminal, at.attempt, at.event, e.kind, e.source])',
      '}',
      "export const SERVICE_FAMILY = { eventTable: 'tb_invoice_service_transmission_event' }",
      "export const markSent = (conn: Conn, at: Attempt) => insertVoice(conn, SERVICE_FAMILY, at, { kind: 'S', source: 'P' })",
    ].join('\n')
    expect(core(generic)).toBe(false)                     // no núcleo: cego (por desenho da D-F105 + tabela por descritor)
    expect(tsProducesS(generic)).toBe(true)               // a MESMA linha na nfse-api seria pega — só pelo literal ao lado de `kind`
    expect(writerCallFlags(generic)).toBe(false)          // a cerca de chamada só conhece `insertTransmissionEvent` (a tabela vem do descritor)
  })
})

// ===========================================================================
// ATAQUE 3 — a lista POSITIVA (constante + tipo derivado) quando a NE-1a alargar o tipo comum (simulada EM MEMÓRIA no `kinds.ts` do núcleo)
// ===========================================================================

describe('ATAQUE 3 — NE-1a simulada: o tipo comum ganha P/D (e casos-limite)', () => {
  const kinds = read(CORE_KINDS)
  const widen = (decl: string) => {
    const t = kinds.replace(/export type TransmissionEventKind = [^\n]*/, decl)
    expect(t).not.toBe(kinds)
    return t
  }
  const PROD = [path.join(SRC_ROOT, 'nfse', 'repository.ts'), path.join(SRC_ROOT, 'nfse', 'transmission.ts')]
  const PROBES: [string, string][] = [
    ['P', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'P', source: 'P' })`],
    ['D', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'D', source: 'P' })`],
    ['S', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'S', source: 'P' })`],
    ['comum', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' })`],
    ['mapa P', `const M: Record<'x', ServiceVoiceWriteKind> = { x: 'P' }`],
    ['F', `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P' })`],
  ]
  it('resistiu: com `TransmissionEventKind` += P/D, o escritor da NFS-e RECUSA P, D, S, o comum e o mapa com P; aceita F; e a produção da nfse-api (repository.ts, transmission.ts) segue compilando sem erro', () => {
    const r = compileInMemory(NFSE, VIRTUAL_NFSE, HEADER_NFSE, PROBES, {
      overrides: { [CORE_KINDS]: widen(`export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N' | 'P' | 'D'`) }, alsoCheck: PROD,
    })
    expect(PROBES.map(([l]) => [l, r.snippet.get(l)!.length > 0])).toEqual([['P', true], ['D', true], ['S', true], ['comum', true], ['mapa P', true], ['F', false]])
    expect([...r.real.values()]).toEqual([[], []])
  })
  it('[CORRIGIDO na sessão] se o tipo comum virar `string`, a lista da família CONTINUA A/R/C/K/F/N (deriva da constante literal; o `satisfies` aceita): o escritor recusa P, D, S, o comum e o mapa com P; aceita F — nada passa calado e nada quebra à toa', () => {
    const r = compileInMemory(NFSE, VIRTUAL_NFSE, HEADER_NFSE, PROBES, { overrides: { [CORE_KINDS]: widen('export type TransmissionEventKind = string') }, alsoCheck: PROD })
    expect(PROBES.map(([l]) => [l, r.snippet.get(l)!.length > 0])).toEqual([['P', true], ['D', true], ['S', true], ['comum', true], ['mapa P', true], ['F', false]])
  })
  it('[CORRIGIDO na sessão] ressalva do adversarial fechada: se o tipo comum virar `any`, o `Extract<any, …>` dava `any` e a D-F106 EVAPORAVA; DERIVADA da constante, a família continua a lista literal — o escritor recusa P, D, S e o mapa com P; aceita F; o comum `any` (atribuível a tudo) compila, e o FUNIL em execução o pega (R22-03)', () => {
    const r = compileInMemory(NFSE, VIRTUAL_NFSE, HEADER_NFSE, PROBES, { overrides: { [CORE_KINDS]: widen('export type TransmissionEventKind = any') }, alsoCheck: PROD })
    expect(PROBES.map(([l]) => [l, r.snippet.get(l)!.length > 0])).toEqual([['P', true], ['D', true], ['S', true], ['comum', false], ['mapa P', true], ['F', false]])
    expect([...r.real.values()]).toEqual([[], []])
  })
  it('[CORRIGIDO na sessão] a definição é a lista POSITIVA numa CONSTANTE (`SERVICE_VOICE_WRITE_KINDS = [\'A\', \'R\', \'C\', \'K\', \'F\', \'N\'] as const satisfies readonly TransmissionEventKind[]`) com o tipo DERIVADO dela, IDÊNTICA na nfse-api e no setes-api — nunca `Exclude<…, \'S\'>` (deixaria P/D entrarem com a NE-1a) nem `Extract` (evaporava com `any`)', () => {
    const list = /export const SERVICE_VOICE_WRITE_KINDS = \['A', 'R', 'C', 'K', 'F', 'N'\] as const satisfies readonly TransmissionEventKind\[\]/
    const derived = /export type ServiceVoiceWriteKind = typeof SERVICE_VOICE_WRITE_KINDS\[number\]/
    const setesRepo = path.join(SETES_IT, 'transmission.repository.ts')
    for (const f of [path.join(SRC_ROOT, 'nfse', 'repository.ts'), setesRepo].filter(f => fs.existsSync(f))) {
      const t = read(f)
      expect(t).toMatch(list)
      expect(t).toMatch(derived)
      expect(t).not.toMatch(/ServiceVoiceWriteKind\s*=\s*(?:Exclude|Extract)</)
    }
  })
  // testemunhas de COMPILAÇÃO no tipo REAL (o ts-jest confere): o escritor recusa S; a família aceita os seis
  it('resistiu: testemunhas de compilação no tipo REAL — S fora; A/R/C/K/F/N dentro; e o comum NÃO cabe na família', () => {
    // @ts-expect-error — D-F106: S fora da família
    const s: ServiceVoiceWriteKind = 'S'
    const six: ServiceVoiceWriteKind[] = ['A', 'R', 'C', 'K', 'F', 'N']
    const wide = 'S' as SharedKind
    // @ts-expect-error — o vocabulário comum não cabe no da família
    const narrowed: ServiceVoiceWriteKind = wide
    expect([s, six.length, narrowed]).toEqual(['S', 6, 'S'])
  })
})

// ===========================================================================
// ATAQUE 3b — o setes-api (PRODUÇÃO até a F2a): o delta COMPILA e o tipo pega lá também (compilado em memória, nada tocado)
// ===========================================================================

const HEADER_SETES = `import { insertTransmissionEvent, TransmissionEventInput, ServiceVoiceWriteKind } from '../transmission.repository'
import { OUTCOME_KIND } from '../branches/service'
import type { TransmissionEventKind } from '../transmission-kinds'
declare const conn: any
declare const WIDE: TransmissionEventKind
export {}`

describe('ATAQUE 3b — setes-api', () => {
  const has = fs.existsSync(path.join(SETES_IT, 'transmission.repository.ts'))
  const prod = () => [...walkTs(SETES_IT)]
  it('resistiu: os arquivos da composição do setes-api (o delta da D-F106 incluso) compilam SEM erro com o tsconfig dele — e o tipo recusa literal, constante, shorthand, mapa, parâmetro e `OUTCOME_KIND.local = …`', () => {
    if (!has) return
    const r = compileInMemory(SETES, VIRTUAL_SETES, HEADER_SETES, [
      ['literal', `insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: 'S', source: 'P' })`],
      ['constante', `insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: WIDE, source: 'P' })`],
      ['shorthand', `const kind: TransmissionEventKind = 'S'\ninsertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind, source: 'P' })`],
      ['mapa', `const M = { posted: 'S' } as const\ninsertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: M.posted, source: 'P' })`],
      ['parâmetro', `const v = (k: TransmissionEventKind) => insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: k, source: 'P' })`],
      ['OUTCOME_KIND.local', `OUTCOME_KIND.local = 'S'`],
      ['A (legítimo)', `insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: 'A', source: 'P' })`],
    ], { alsoCheck: prod() })
    expect([...r.snippet.entries()].map(([l, d]) => [l, d.length > 0])).toEqual([
      ['literal', true], ['constante', true], ['shorthand', true], ['mapa', true], ['parâmetro', true], ['OUTCOME_KIND.local', true], ['A (legítimo)', false]])
    expect([...r.real.entries()].filter(([, d]) => d.length > 0)).toEqual([])
    expect(r.real.size).toBeGreaterThanOrEqual(5)
  })
  it('contexto: no setes-api as mesmas fugas SEM cast COMPILAM (o tipo não as vê — spread POSTERIOR e `Object.assign(OUTCOME_KIND, …)`); quem as fecha lá é o FUNIL em execução e o mapa CONGELADO (R22-03/R22-02 — testemunha própria em `setes-api/src/__tests__/service-voice-write-kind.test.ts`) e a cerca de chamada da peça, que varre a pasta da composição', () => {
    if (!has) return
    const r = compileInMemory(SETES, VIRTUAL_SETES, HEADER_SETES, [
      ['spread', `declare const extra: Record<string, unknown>\ninsertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: 'F', source: 'P', ...extra })`],
      ['assign', `Object.assign(OUTCOME_KIND, { local: 'S' })`],
    ]).snippet
    expect([...r.values()]).toEqual([[], []])
  })
  it('resistiu: NE-1a não toca o setes-api, mas se o vocabulário DELE ganhar P/D o escritor recusa (lista positiva) e a composição segue compilando', () => {
    if (!has) return
    const kindsFile = path.join(SETES_IT, 'transmission-kinds.ts')
    const t = read(kindsFile).replace(/export type TransmissionEventKind = [^\n]*/, `export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N' | 'P' | 'D'`)
    const r = compileInMemory(SETES, VIRTUAL_SETES, HEADER_SETES, [
      ['P', `insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: 'P', source: 'P' })`],
      ['D', `insertTransmissionEvent(conn, 's', 1, 1, 1, null, { kind: 'D', source: 'P' })`],
    ], { overrides: { [kindsFile]: t }, alsoCheck: prod() })
    expect([...r.snippet.values()].every(d => d.length > 0)).toBe(true)
    expect([...r.real.entries()].filter(([, d]) => d.length > 0)).toEqual([])
  })
})

// ===========================================================================
// ATAQUE 4 — os casts de `kind` no código REAL (núcleo, nfse-api, setes-api): algum anula a D-F106?
// ===========================================================================

describe('ATAQUE 4 — casts e formas de chamada no código REAL', () => {
  const scope = () => [
    ...walkTs(path.join(NFSE, 'src')), ...walkTs(path.join(NFSE, 'scripts')),
    ...walkTs(path.join(WORKSPACE, 'fiscal-api', 'src')), ...walkTs(SETES_IT),
  ]
  /** Toda asserção de tipo (`as X`/`<X>`) que (a) está DENTRO de uma chamada ao escritor, (b) nomeia um tipo da voz ou (c) é o valor de `kind`. */
  function kindCasts(code: string): string[] {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const inWriter = (n: ts.Node): boolean => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && /insertTransmissionEvent$/.test(p.expression.getText(sf))) return true; return false }
    const visit = (n: ts.Node): void => {
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
        const t = n.type.getText(sf)
        const isKindValue = ts.isPropertyAssignment(n.parent) && n.parent.name.getText(sf) === 'kind'
        if (inWriter(n) || /ServiceVoiceWriteKind|TransmissionEventInput|TransmissionEventKind|TransmissionEventRow/.test(t) || isKindValue) out.push(`${t} @ ${n.getText(sf).slice(0, 60)}`)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  it('resistiu: NENHUM cast toca a escrita — os únicos casts com tipo da voz são de LEITURA (`… as TransmissionEventRow[]`/`as TransmissionEventRow` nos dois repositórios); nada dentro de chamada ao escritor nem no valor de `kind`', () => {
    const files = scope()
    expect(files.length).toBeGreaterThan(40)
    const hits = files.flatMap(f => kindCasts(read(f)).map(h => `${rel(f)}: ${h}`))
    expect(hits.filter(h => !/^(?:nfse-api\/src\/nfse\/repository\.ts|setes-api\/src\/shared\/invoice-transmission\/transmission\.repository\.ts): TransmissionEventRow(?:\[\])? @/.test(h))).toEqual([])
    expect(hits).toHaveLength(fs.existsSync(SETES_IT) ? 4 : 1)
  })
  it('resistiu: toda chamada REAL ao escritor é por identificador NU, com objeto literal SEM spread e `kind` literal da família ou `OUTCOME_KIND[…]` — nfse-api (src+scripts) e a pasta INTEIRA da composição do setes-api (o r21 lia só `invoice-transmission.ts`)', () => {
    const calls: { f: string; text: string; ok: boolean }[] = []
    for (const f of [...walkTs(path.join(NFSE, 'src')), ...walkTs(path.join(NFSE, 'scripts')), ...walkTs(SETES_IT)]) {
      const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && /insertTransmissionEvent$/.test(n.expression.getText(sf)) && !ts.isFunctionDeclaration(n.parent)) {
          const obj = n.arguments[n.arguments.length - 1]
          const lit = obj && ts.isObjectLiteralExpression(obj) ? obj : null
          const kind = lit?.properties.find(q => ts.isPropertyAssignment(q) && q.name.getText(sf) === 'kind') as ts.PropertyAssignment | undefined
          const ok = ts.isIdentifier(n.expression) && !!lit && !lit.properties.some(ts.isSpreadAssignment) && !!kind
            && ((ts.isStringLiteral(kind.initializer) && ['A', 'R', 'C', 'K', 'F', 'N'].includes(kind.initializer.text))
              || (ts.isElementAccessExpression(kind.initializer) && kind.initializer.expression.getText(sf) === 'OUTCOME_KIND'))
          calls.push({ f: rel(f), text: n.getText(sf).slice(0, 80), ok })
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(calls.filter(c => c.f.startsWith('nfse-api/')).length).toBeGreaterThanOrEqual(10)
    if (fs.existsSync(SETES_IT)) expect(calls.filter(c => c.f.startsWith('setes-api/')).length).toBeGreaterThanOrEqual(8)
    expect(calls.filter(c => !c.ok)).toEqual([])
  })
  it('resistiu: o escritor tem UMA assinatura (sem sobrecarga) e o último parâmetro é `TransmissionEventInput` — nfse-api e setes-api', () => {
    const sigs = (f: string) => {
      const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      return sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'insertTransmissionEvent')
        .map(d => d.parameters[d.parameters.length - 1].type?.getText(sf))
    }
    expect(sigs(path.join(SRC_ROOT, 'nfse', 'repository.ts'))).toEqual(['TransmissionEventInput'])
    const setesRepo = path.join(SETES_IT, 'transmission.repository.ts')
    if (fs.existsSync(setesRepo)) expect(sigs(setesRepo)).toEqual(['TransmissionEventInput'])
  })
  it('[CORRIGIDO na sessão] os escritores SQL da voz da NFS-e são EXATAMENTE os dois funis tipados + a cópia do `migrate:setes` = a lista `VOICE_SQL_WRITERS` da peça (ESCRITOR ÚNICO, R22-05); nenhum UPDATE põe `kind`', () => {
    /** Textos SQL (literais e templates, substituição = '?') de um fonte TS, pelo AST. */
    const sqlTexts = (code: string): string[] => {
      const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const out: string[] = []
      const visit = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
        else if (ts.isTemplateExpression(n)) out.push([n.head.text, ...n.templateSpans.map(s => s.literal.text)].join('?'))
        ts.forEachChild(n, visit)
      }
      visit(sf)
      return out.map(s => s.replace(/\s+/g, ' '))
    }
    const TABLE = '(?:`?[?\\w]*`?\\.)?`?tb_invoice_service_transmission_event\\b'
    const INSERT = new RegExp(`\\b(?:INSERT|REPLACE)\\b(?:\\s+(?:IGNORE|LOW_PRIORITY|HIGH_PRIORITY|DELAYED))*\\s+(?:INTO\\s+)?${TABLE}`, 'i')
    const UPDATE_SET = new RegExp(`\\bUPDATE\\s+${TABLE}[\\s\\S]*?\\bSET\\b([\\s\\S]*?)(?:\\bWHERE\\b|$)`, 'i')
    const files = voiceFenceScope().filter(f => f.endsWith('.ts') && fs.existsSync(f))
    const inserters = files.filter(f => sqlTexts(read(f)).some(s => INSERT.test(s))).map(rel).sort()
    expect(inserters).toEqual([
      'nfse-api/scripts/migrate-from-setes-api.ts', 'nfse-api/src/nfse/repository.ts',
      ...(fs.existsSync(SETES_IT) ? ['setes-api/src/shared/invoice-transmission/transmission.repository.ts'] : []),
    ].sort())
    if (fs.existsSync(SETES_IT)) expect(inserters).toEqual([...VOICE_SQL_WRITERS].sort())
    const kindUpdates = files.flatMap(f => sqlTexts(read(f)).filter(s => { const m = UPDATE_SET.exec(s); return !!m && /\bkind`?\s*=/i.test(m[1]) }).map(s => `${rel(f)}: ${s.slice(0, 80)}`))
    expect(kindUpdates).toEqual([])
  })
})

// ===========================================================================
// ATAQUE 5 — a cerca SQL (`sqlWritesS`): grafias de MySQL que gravam S e passam
// ===========================================================================

describe('ATAQUE 5 — grafias de SQL de escrita com S que a cerca não lia (R22-07, corrigido na sessão)', () => {
  const T = 'tb_invoice_service_transmission_event'
  it('resistiu: as formas canônicas — INSERT/INSERT IGNORE/REPLACE INTO com \'S\', UPDATE … SET kind = \'S\', alias `e.kind`, minúscula \'s\' (a cerca é /i), INSERT … SET, ON DUPLICATE KEY UPDATE', () => {
    for (const s of [
      `INSERT INTO ${T} (kind) VALUES ('S');`, `INSERT IGNORE INTO ${T} (kind) VALUES ('S');`, `REPLACE INTO ${T} (kind) VALUES ('S');`,
      `UPDATE ${T} SET kind = 'S' WHERE attempt = 1;`, `UPDATE tb_invoice_service_transmission t JOIN ${T} e ON e.attempt = t.attempt SET e.kind = 'S';`,
      `UPDATE ${T} SET kind = 's';`, `INSERT INTO ${T} SET kind = 'S', source = 'P';`, `INSERT INTO ${T} (kind) VALUES ('F') ON DUPLICATE KEY UPDATE kind = 'S';`,
    ]) expect([s, sqlFileProducesS(s)]).toEqual([s, true])
  })
  const GAPS: [string, string][] = [
    ['aspas DUPLAS (string no MySQL sem ANSI_QUOTES)', `INSERT INTO ${T} (kind, source) VALUES ("S", "P");`],
    ['INSERT sem INTO (opcional no MySQL)', `INSERT ${T} (kind) VALUES ('S');`],
    ['INSERT LOW_PRIORITY/HIGH_PRIORITY', `INSERT HIGH_PRIORITY IGNORE INTO ${T} (kind) VALUES ('S');`],
    ['REPLACE sem INTO', `REPLACE ${T} (kind) VALUES ('S');`],
    ['coluna com crase (`kind`) — o estilo das migrations da casa', 'UPDATE `' + T + "` SET `kind` = 'S' WHERE attempt = 1;"],
    ['CASE no SET (o molde de backfill)', `UPDATE ${T} SET kind = CASE WHEN dh IS NULL THEN 'S' ELSE kind END;`],
    ['IF() no SET', `UPDATE ${T} SET kind = IF(dh IS NULL, 'S', kind);`],
  ]
  it.each(GAPS)('[CORRIGIDO na sessão] [LOW R22-07] %s → a cerca SQL pega', (_l, s) => {
    expect(sqlFileProducesS(s)).toBe(true)
  })
})
