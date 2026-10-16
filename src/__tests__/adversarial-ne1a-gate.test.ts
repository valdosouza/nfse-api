/// <reference types="jest" />
// GATE ADVERSARIAL — NE-1a parte 1 (Rodada 1 da NE-1a, Valdo 2026-10-11: D-NE56 registro = FATO da view · D-NE59 parte 1 · D-NE14 P/D
// · D-NE12 terminal por parâmetro) — nfse-api (o núcleo, os scripts e as migrations lidos como TEXTO ou chamados com conexão FALSA).
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6). Plano: prompt_onda_nfe_sefaz.md §12.9. Gate irmão do núcleo:
// `fiscal-api/src/__tests__/adversarial-ne1a-gate.test.ts` (NE1A-01…07).
//
// Alvo do delta na nfse-api: migration 004 (`CREATE OR REPLACE VIEW vw_invoice_service_transmission` + `authority_recorded`),
// `repository.ts` (`SERVICE_AUTHORITY_RECORDED_SQL` no `TX_SELECT`, `mapTx`), `transmission.ts`/`guards.ts` (`webInvoice` — a borda
// PROVISÓRIA da referência da nota). Critério da fase: "a NFS-e NÃO muda de comportamento".
//
//  * ACHADOS (`it.failing('[SEV NE1A-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual (prova do achado);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: nenhum socket, nenhum banco (os SQL reais são capturados de uma conexão FALSA), nada no disco, nada que fale com o fisco.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as fiscal from 'fiscal-api'
import {
  splitStatements, currentOf, fiscalStateOf, isLiveTransmission, isAuthorized, FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS, WEB_TERMINAL,
} from 'fiscal-api'
import * as repo from '../nfse/repository'
import { SERVICE_AUTHORITY_RECORDED_SQL, SERVICE_VOICE_WRITE_KINDS, mapTx, latestTransmission, findTransmissionByDpsId, listRefreshCandidates } from '../nfse/repository'
import { getServiceFiscalView } from '../nfse/transmission'
import { listPendingServiceInvoices } from '../facts/service-facts'
import { walkTs, WORKSPACE } from './voice-kind-fence'
import { refOf, webRef, webScope } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    erp: { ...actual.erp, invoiceLife: jest.fn(), institutionZone: jest.fn(), establishmentCnpj: jest.fn() },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return { __esModule: true, ...actual, listLifeTransmissions: jest.fn() }
})

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const MIGRATIONS = path.join(SRC_ROOT, 'migrations', 'sql')
const CORE = path.join(WORKSPACE, 'fiscal-api')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => path.relative(WORKSPACE, f).replace(/\\/g, '/')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
const outcome = <T>(f: () => T): T | 'lança' => { try { return f() } catch { return 'lança' } }
const VIEW_RE = /CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS[\s\S]*?;/

/** Conexão FALSA: devolve [[]] e guarda o SQL/parâmetros — o SQL REAL do repositório, sem banco. */
function capture() {
  const calls: { sql: string; params: unknown[] }[] = []
  // NE-1a (correções dos gates): o `mapTx` é estrito — a linha `{ n: 0 }` só para o COUNT; as listas de tentativas voltam vazias
  const q: any = { query: jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql: norm(sql), params }); return [/COUNT\(\*\)/i.test(sql) ? [{ n: 0 }] : []] }) }
  return { q, calls }
}

const KEY = '41069022123456780001950000000000123202609210000123'.slice(0, 50)
/** Linha CRUA do `TX_SELECT` (como o banco a entrega): `authorityRecorded` pela MESMA definição da família (`access_key` não nula). */
const rawTx = (attempt: number, accessKey: string | null, over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 6200, attempt, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey, authorityRecorded: accessKey == null ? 'N' : 'S', nfseNumber: accessKey ? '704' : null, dhProc: null,
  createdAt: '2026-10-01 09:59:00', ageMinutes: 30, lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 1, lastKind: accessKey ? 'A' : 'F', lastCode: null,
  lastMessage: null, lastSource: accessKey ? 'P' : 'Q', lastDh: null, lastEventAt: '2026-10-01 10:00:00', lastEventAgeMinutes: 30, ...over,
})

// ===========================================================================
// A — a migration 004 frente às views e aos consumidores existentes
// ===========================================================================

describe('A — migration 004 (D-NE56) × 003 × consumidores', () => {
  const v003 = norm(read(path.join(MIGRATIONS, '003_transmission_nfse_not_generated.sql')).match(VIEW_RE)![0])
  const v004 = norm(read(path.join(MIGRATIONS, '004_transmission_common_projection.sql')).match(VIEW_RE)![0])
  it('resistiu: a view da 004 é a da 003 + EXATAMENTE a coluna `authority_recorded` (mesmos JOINs, mesma "última voz VIVA", mesmos filtros de soft delete) — os invariantes que os gates anteriores fixaram na 003 valem na view vigente', () => {
    const added = `${norm(SERVICE_AUTHORITY_RECORDED_SQL)} AS \`authority_recorded\`, `
    expect(v004).toContain(added)
    expect(v004.replace(added, '')).toBe(v003)
  })
  it('resistiu: o executor REAL de migrations (`splitStatements` do núcleo) corta a 004 em UM comando — só o CREATE OR REPLACE VIEW (nenhum ALTER/DROP/UPDATE; ";" nos comentários não corta)', () => {
    const stmts = splitStatements(read(path.join(MIGRATIONS, '004_transmission_common_projection.sql')))
    expect(stmts).toHaveLength(1)
    expect(norm(stmts[0])).toMatch(/^CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS SELECT /)
    expect(stmts[0]).not.toMatch(/\b(?:ALTER|DROP|UPDATE|DELETE|INSERT)\b/i)
  })
  it('resistiu: a 004 é a ÚLTIMA definição da view (ordem das migrations) e publica toda coluna que os consumidores existentes leem dela — pendentes do lote (`service-facts.ts`), conferência do `migrate:setes`, smoke de H', () => {
    const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const last = files.filter(f => VIEW_RE.test(read(path.join(MIGRATIONS, f)))).pop()
    expect(last).toBe('004_transmission_common_projection.sql')
    for (const c of ['tb_institution_id', 'tb_invoice_id', 'terminal', 'attempt', 'life_event', 'access_key', 'nfse_not_generated_at']) {
      expect([c, v004.includes(`t.\`${c}\``)]).toEqual([c, true])
    }
    expect(v004).toContain('le.`kind` AS `last_kind`')
    const consumers = [path.join(SRC_ROOT, 'facts', 'service-facts.ts'), path.join(PROJECT_ROOT, 'scripts', 'migrate-from-setes-api.ts'),
      path.join(PROJECT_ROOT, 'scripts', 'smoke-adn-homologacao.ts')]
    for (const f of consumers) expect([rel(f), /vw_invoice_service_transmission\b/.test(read(f))]).toEqual([rel(f), true])
  })
  it('contexto: o r16 confere os invariantes da view lendo a 003 PELO NOME — a cerca por nome de arquivo fica cega à definição que a substitui (a 004 hoje, a da NE-2 amanhã); o teste acima os confere na ÚLTIMA definição', () => {
    const r16 = read(path.join(SRC_ROOT, '__tests__', 'adversarial-r16-gate.test.ts'))
    expect(r16).toContain("'003_transmission_nfse_not_generated.sql'")
  })
})

// ===========================================================================
// B — o registro na família de serviço: a vigente da nfse-api × a do núcleo
// ===========================================================================

describe('B — D-NE56 na nfse-api: uma definição, várias leituras', () => {
  it('resistiu: o SQL da vigente da nfse-api (`latestTransmission`: `ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1`) e o `currentOf` do núcleo sobre as linhas do `mapTx` (fato da MESMA definição) escolhem a MESMA tentativa em TODAS as combinações de chave de 1–4 tentativas', async () => {
    const { q, calls } = capture()
    await latestTransmission(q, refOf(1, 6200), 1)
    expect(calls[0].sql).toContain('ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt DESC LIMIT 1')
    expect(calls[0].sql).toContain(`${norm(SERVICE_AUTHORITY_RECORDED_SQL)} AS authorityRecorded`)
    let combos = 0
    for (let n = 1; n <= 4; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const raw = Array.from({ length: n }, (_, i) => rawTx(i + 1, mask & (1 << i) ? KEY : null)).reverse()      // ordem qualquer
        const bySql = [...raw].sort((a, b) => Number(b.accessKey != null) - Number(a.accessKey != null) || b.attempt - a.attempt)[0]
        expect([n, mask, currentOf(raw.map(mapTx))?.attempt]).toEqual([n, mask, bySql.attempt])
        combos++
      }
    }
    expect(combos).toBe(30)
  })
  it('resistiu: a composição da tela "No fisco" (`getServiceFiscalView`) com linhas na forma de PRODUÇÃO (`mapTx` com o fato) — a NFS-e pousou na tentativa 1 (reconciliada depois) e a 2 fechou F: a vigente é a 1 e o estado é "authorized" (D-N26 mantida)', async () => {
    ;(fiscal.erp.invoiceLife as jest.Mock).mockResolvedValue({ invoiceId: 6200, invoiceDeleted: false, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
    ;(fiscal.erp.institutionZone as jest.Mock).mockResolvedValue('America/Sao_Paulo')
    ;(fiscal.erp.establishmentCnpj as jest.Mock).mockResolvedValue('12345678000195')
    ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [rawTx(1, KEY), rawTx(2, null)].map(mapTx), events: [] })
    const deps: any = { pool: { query: jest.fn(async () => [[]]) }, storage: { find: () => null }, fiscalDb: 'fiscal_api' }
    const v = await getServiceFiscalView(deps, { schemaName: 'setes_setes', institutionId: 1, userId: 7 }, webRef({ schemaName: 'setes_setes', institutionId: 1, userId: 7 }, 6200))
    expect([v.state, v.localCancelPending, v.xmlAvailable]).toEqual(['authorized', false, false])
    // D-F142 (Rodada 1 da F2b): a visão publica a VIGENTE — a tentativa 1 (registrada), nunca a última da lista (2) que o app pegaria
    expect([v.currentAttempt, v.transmissions[v.transmissions.length - 1].attempt]).toEqual([1, 2])
    expect(fiscal.erp.invoiceLife).toHaveBeenCalledWith(deps.pool, 'setes_setes', { institutionId: 1, invoiceId: 6200, terminal: WEB_TERMINAL })
  })
  it('[CORRIGIDO na sessão — gate socrático M2] as fixtures da suíte unitária (`tx()` de `transmission.test.ts` e irmãs) agora trazem o FATO (`withRecord` — derivado da chave, como na produção); um objeto SEM o fato passado ao `currentOf` falha ALTO (D-NE66) em vez de escolher a última calado', () => {
    const fixture = read(path.join(SRC_ROOT, '__tests__', 'transmission.test.ts'))
    expect(fixture).toContain('const tx = (over: any = {}) => withRecord({')
    const shaped = [{ attempt: 1, accessKey: KEY, lastKind: 'A' }, { attempt: 2, accessKey: null, lastKind: 'F' }] as any[]
    expect(outcome(() => currentOf(shaped)?.attempt)).toBe('lança')
    const withFact = shaped.map(s => ({ ...s, authorityRecorded: s.accessKey != null }))
    expect([currentOf(withFact)?.attempt, fiscalStateOf(currentOf(withFact))]).toEqual([1, 'authorized'])
  })
  it('[CORRIGIDO na sessão — D-NE68 (b)] [LOW NE1A-08] `mapTx` era LENIENTE: linha interna sem a coluna (`SELECT` futuro que esqueça `authorityRecorded` — a parte 2 da NE-1a move esse SQL para o núcleo) virava "não registrada" CALADA, mesmo com a chave do fisco; agora falha alto — e também na linha INCOERENTE (registro sem chave ou chave sem registro)', () => {
    const { authorityRecorded: _, ...withoutColumn } = rawTx(1, KEY)
    expect(outcome(() => mapTx(withoutColumn).authorityRecorded)).not.toBe(false)
    expect(outcome(() => mapTx(rawTx(1, KEY, { authorityRecorded: 'N' })))).toBe('lança')
    expect(outcome(() => mapTx(rawTx(1, null, { authorityRecorded: 'S' })))).toBe('lança')
  })
  it('contexto (Q-NE68): na família de serviço o registro ainda é decidido pela CHAVE em vários pontos além da constante — SQL da vigente/minter/revisita (`t.access_key IS [NOT] NULL`), tela/XML/reconferência (`t.accessKey`), smoke de H (`access_key IS NOT NULL` na view) e a `reconfirmationCandidate` do núcleo (NE1A-02); hoje equivalentes por definição, a cerca da D-NE56 (`ne1a-registro.test.ts`) confere só a view × a constante', async () => {
    const repoText = stripComments(read(path.join(SRC_ROOT, 'nfse', 'repository.ts')))
    expect(repoText.match(/\baccess_key IS (?:NOT )?NULL\b/g)).toHaveLength(3)
    const txText = stripComments(read(path.join(SRC_ROOT, 'nfse', 'transmission.ts')))
    expect(txText.match(/\.find\(t => t\.accessKey\)|\.some\(t => !!t\.accessKey\)/g)).toHaveLength(3)
    expect(read(path.join(PROJECT_ROOT, 'scripts', 'smoke-adn-homologacao.ts'))).toMatch(/vw_invoice_service_transmission\s+WHERE last_kind IS NULL OR \(access_key IS NOT NULL/)
    const { q, calls } = capture()
    await findTransmissionByDpsId(q, refOf(1, 6200), 1, 'DPS1', 'P')
    expect(calls[0].sql).toContain('ORDER BY (t.access_key IS NOT NULL) DESC, t.attempt ASC LIMIT 1')
    expect(calls[0].sql).not.toContain(`ORDER BY (${norm(SERVICE_AUTHORITY_RECORDED_SQL)}`)
  })
})

// ===========================================================================
// C — P/D no vocabulário comum × o SQL literal da nfse-api (a NFS-e não muda)
// ===========================================================================

describe('C — D-NE14: P/D × SQL literal da nfse-api', () => {
  it('resistiu: para os SEIS kinds que a NFS-e escreve (A/R/C/K/F/N — D-F106), a classificação é IDÊNTICA à de antes da NE-1a (finais A/R/C/F/N, viva K, autorizadas A/N) e o estado derivado também', () => {
    const before = { final: ['A', 'R', 'C', 'F', 'N'], authorized: ['A', 'N'] }
    for (const k of SERVICE_VOICE_WRITE_KINDS) {
      expect([k, FINAL_TRANSMISSION_KINDS.has(k), AUTHORIZED_KINDS.has(k)]).toEqual([k, before.final.includes(k), before.authorized.includes(k)])
    }
    expect(SERVICE_VOICE_WRITE_KINDS.map(k => fiscalStateOf({ lastKind: k }))).toEqual(['authorized', 'rejected', 'cancelled', 'cancel_in_flight', 'failed', 'authorized'])
    expect([fiscalStateOf({ lastKind: null }), fiscalStateOf(null)]).toEqual(['in_flight', 'none'])
  })
  // parte 2 da NE-1a (D-NE9): a contagem saiu da família para o EMITTER do núcleo (leituras PUBLICADAS — `t.last_kind` da view); a promessa
  // ("deriva a lista do vocabulário") é a mesma
  it('resistiu: `countLiveTransmissions` (guarda do DELETE do A1) DERIVA a lista do vocabulário — o SQL real sai com os finais da classificação total (D entra, P fica viva) e, para os kinds da NFS-e, conta o mesmo que antes', async () => {
    const { q, calls } = capture()
    await fiscal.countLiveTransmissions(q, 1, { branches: 'all' })
    const finals = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
    expect(calls[0].sql).toContain(`AND (t.last_kind IS NULL OR t.last_kind NOT IN (${finals}))`)
    expect(finals.split(',').sort()).toEqual(["'A'", "'C'", "'D'", "'F'", "'N'", "'R'"])
  })
  // parte 2 da NE-1a — D-NE69 (= Q-NE69 (a)) EXECUTADA: as CLASSES vêm da `KIND_CLASS` (P entra nas vivas; D nos finais); as letras de UM
  // fato seguem pelo nome (o C do lote — D-F28; o F da revisita — D-F52; o sentinela '-'). O TEXTO do SQL mudou; para os kinds que a
  // NFS-e escreve (e a reserva sem voz) cada lista tem os MESMOS membros de antes — a NFS-e não muda.
  it('[DECIDIDO — D-NE69] os leitores de "viva/autorizada" da nfse-api DERIVAM as listas da classificação total — rodízio (vivas S/K/P, autorizadas A/N, ordem pelos finais) e pendentes do lote (vivas + autorizadas + C + \'-\'); para os kinds da NFS-e, os mesmos membros de antes', async () => {
    const r = capture()
    await listRefreshCandidates(r.q, 'setes_setes', webScope(1), 5, 10, 8, { interfaces: ['service-orders'], liveOnlyInterfaces: ['orders'] })
    const sql = r.calls[0].sql
    expect(sql).toContain("OR (le.kind IN ('S','K','P')")
    expect(sql).toContain("(le.kind IS NULL OR le.kind IN ('S','K','P'))")
    expect(sql).toContain("OR (le.kind IN ('A','N') AND")
    expect(sql).toContain("ORDER BY (le.kind IN ('A','R','C','F','N','D')) ASC")
    const NFSE = ['A', 'R', 'C', 'K', 'F', 'N']
    const before = { live: ['S', 'K'], authorized: ['A', 'N'], order: ['A', 'N', 'F'] }
    const now = { live: ['S', 'K', 'P'], authorized: ['A', 'N'], order: ['A', 'R', 'C', 'F', 'N', 'D'] }
    // a ordenação só pesa sobre as CANDIDATAS (sem voz, S/K, A/N, F): R/C/D nunca são candidatas — a ordem entre elas é a mesma
    const candidates = [...NFSE.filter(k => k !== 'R' && k !== 'C')]
    expect(NFSE.map(k => [k, now.live.includes(k), now.authorized.includes(k)])).toEqual(NFSE.map(k => [k, before.live.includes(k), before.authorized.includes(k)]))
    expect(candidates.map(k => [k, now.order.includes(k)])).toEqual(candidates.map(k => [k, before.order.includes(k)]))
    const p = capture()
    await listPendingServiceInvoices(p.q, 'setes_setes', webScope(1), 'fiscal_api', { page: 1, pageSize: 10 }, null)
    expect(p.calls[0].sql).toContain("COALESCE(t.last_kind, '-') IN ('S','K','P','A','N','C','-')")
    const pendBefore = ['A', 'N', 'S', 'K', 'C', '-'], pendNow = ['S', 'K', 'P', 'A', 'N', 'C', '-']
    expect([...NFSE, '-'].map(k => [k, pendNow.includes(k)])).toEqual([...NFSE, '-'].map(k => [k, pendBefore.includes(k)]))
  })
  it('contexto: voz P/D gravada POR FORA do código na NFS-e (D-F103: sem CHECK até a F2a — D-F107) MUDOU de leitura com a NE-1a — P era "in_flight" e agora é "processing" (estado fora do contrato da NFS-e); D era VIVA ("in_flight", 409 em andamento, contava para o A1) e agora é FINAL "denied": a barreira da NFS-e (`isLive || isAuthorized`) deixaria nova tentativa passar e o lote a listaria como pendente', () => {
    expect([fiscalStateOf({ lastKind: 'P' }), isLiveTransmission({ lastKind: 'P' })]).toEqual(['processing', true])
    expect([fiscalStateOf({ lastKind: 'D' }), isLiveTransmission({ lastKind: 'D' }), isAuthorized({ lastKind: 'D' })]).toEqual(['denied', false, false])
    expect(read(path.join(SRC_ROOT, 'nfse', 'transmission.ts'))).toContain('if (latest && (isLiveTransmission(latest) || isAuthorized(latest))) throw liveTransmissionError(latest)')
  })
})

// ===========================================================================
// D — D-NE12: a borda da referência (parte 2 da NE-1a: a ROTA monta; `webInvoice` saiu — D-NE59)
// ===========================================================================

describe('D — D-NE12 na nfse-api: o terminal da web só na borda', () => {
  /** Chamadas a leitores do ERP do núcleo que recebem a referência da nota (3º argumento) — e à transação sob a trava do núcleo
   *  (`withInvoiceTx`, importada como `withLockedInvoice`: a trava `erp.lockInvoice` passou para dentro dela no passo 4 da parte 2). */
  function erpRefCalls(): { at: string; ref: string }[] {
    const out: { at: string; ref: string }[] = []
    for (const f of [...walkTs(SRC_ROOT), ...walkTs(path.join(PROJECT_ROOT, 'scripts'))]) {
      const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && /^(?:(?:fiscal\.)?erp\.(?:lockInvoice|invoiceLife|invoiceLives|orderInterface)|withLockedInvoice)$/.test(n.expression.getText(sf))) {
          out.push({ at: `${rel(f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`, ref: n.arguments[2]?.getText(sf) ?? '' })
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return out
  }
  it('[DECIDIDO — D-NE12/D-NE59, parte 2] TODA chamada de produção (src + scripts) a um leitor do ERP do núcleo passa a referência que CHEGOU inteira (`ref`, conferida por `refOf` na trava) — nenhuma montada no meio do caminho, nenhum terminal solto', () => {
    const calls = erpRefCalls()
    expect(calls.length).toBeGreaterThanOrEqual(7)
    expect(calls.filter(c => !/^(?:ref|refOf\(actor, ref\))$/.test(c.ref))).toEqual([])
  })
  it('[DECIDIDO — D-NE12/D-NE59, parte 2] `WEB_TERMINAL` só na BORDA (rotas HTTP e scripts); `webInvoice` não existe mais; dentro da composição a única referência montada é a da candidata do rodízio, com o terminal do ESCOPO dito pela borda', () => {
    const files = [...walkTs(SRC_ROOT), ...walkTs(path.join(PROJECT_ROOT, 'scripts'))]
    const code = (f: string) => stripComments(read(f))
    const border = (f: string) => /\.routes\.ts$/.test(f) || rel(f).startsWith('nfse-api/scripts/')
    expect(files.filter(f => /\bWEB_TERMINAL\b/.test(code(f)) && !border(f)).map(rel)).toEqual([])
    expect(files.filter(f => /\bwebInvoice\b/.test(code(f))).map(rel)).toEqual([])
    const inner = files.filter(f => !border(f)).flatMap(f => [...code(f).matchAll(/\binvoiceRef\(([^)]*)\)/g)].map(m => `${rel(f)}: ${m[1]}`))
    // + a CÓPIA congelada do `refOf` (gate NE1A2-12 da parte 2): a referência que chegou, conferida, não uma montada no caminho
    expect(inner.sort()).toEqual(['nfse-api/src/nfse/transmission.ts: ref.institutionId, ref.invoiceId, ref.terminal',
      'nfse-api/src/nfse/transmission.ts: scope.institutionId, tx.invoiceId, scope.terminal'])
  })
  it('[DECIDIDO — D-NE12/D-NE59, parte 2] nenhum `terminal = 0` LITERAL no SQL da família — as três peças da VOZ (escritor e leitores de idempotência) foram ao núcleo no passo 4 (D-F108/D-NE74) e lá usam o terminal da REFERÊNCIA', () => {
    const LIT = /\bterminal\s*=\s*0\b|VALUES \(\?, \?, 0,/g
    expect((stripComments(read(path.join(SRC_ROOT, 'facts', 'service-facts.ts'))).match(LIT) ?? []).length).toBe(0)
    const file = path.join(SRC_ROOT, 'nfse', 'repository.ts')
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const owners: string[] = []
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && (st.getText(sf).match(LIT) ?? []).length) owners.push(st.name.text)
    }
    expect(owners).toEqual([])
    expect(stripComments(read(file)).match(LIT) ?? []).toEqual([])
    const core = stripComments(read(path.join(CORE, 'src', 'voice', 'event-table.ts')))
    expect(core.match(LIT) ?? []).toEqual([])
    expect((core.match(/\bterminal = \?/g) ?? []).length).toBe(3)                 // escritor (MAX+1) + os dois leitores de idempotência
  })
})

// ===========================================================================
// E — o runtime: a nfse-api de produção (`node dist/server.js`) carrega o `dist/` do núcleo
// ===========================================================================

describe('E — runtime: o dist do núcleo está em dia com o delta', () => {
  const DIST = path.join(CORE, 'dist')
  const distJs = (): string[] => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : [])
    return fs.existsSync(DIST) ? walk(DIST) : []
  }
  it('resistiu: todo nome de VALOR que a nfse-api importa do núcleo e que a NE-1a criou ou MUDOU de arquivo existe no `dist` (sem isso o `start` de produção cairia com "is not a function"); o `dist` já lê o terminal por parâmetro e tem a coluna do registro', () => {
    const files = distJs()
    if (!files.length) return                                                              // núcleo sem build (só o jest mapeia o src)
    const exported = new Set(files.flatMap(f => [...read(f).matchAll(/\bexports\.(\w+)\s*=/g)].map(m => m[1])))
    const needed = ['invoiceRef', 'WEB_TERMINAL', 'invoiceRefFilter', 'currentOf', 'fiscalStateOf', 'isLiveTransmission', 'isAuthorized',
      'localCancelPending', 'isSubstitutionCancel', 'CANCEL_EVENT_CODES', 'reconfirmationCandidate', 'reconfirmationProven',
      'mapTransmissionView', 'transmissionViewSelect', 'FINAL_TRANSMISSION_KINDS', 'SERVICE_VOICE_READING', 'VOICE_READINGS', 'mapCommonView']
    expect(needed.filter(n => !exported.has(n))).toEqual([])
    expect(read(path.join(DIST, 'erp', 'facts.js'))).not.toMatch(/\bterminal\s*=\s*0\b/)
    expect(read(path.join(DIST, 'voice', 'reading.js'))).toContain('authority_recorded')
  })
})
