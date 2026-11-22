/// <reference types="jest" />
// nfse-api:DEPLOY.E1.P5 — núcleo 5.0.0 (fiscal-api:FAMILIA.E5.P3, a janela da NE-6): a família da NF-e (`merchandise`) entrou no catálogo
// `VOICE_READINGS` e `assertFamilyViewsReadable` perdeu o valor padrão (D-NE158 — cada chamador passa o que confere). O boot DESTA API
// confere SÓ a view de tentativas da NFS-e: passar o catálogo inteiro prenderia o boot daqui à migration 001 da nfe-api, o que a D-NE76
// proíbe (nenhum serviço condiciona o boot às migrations de OUTRA família). O que muda SEM código daqui: o DELETE do A1 (a guarda do
// emitter do núcleo) passa a contar também as NF-e vivas. Sem banco: o `query` é falso. As cercas do `server.ts` leem a ÁRVORE do
// TypeScript (gate adversarial, L1: a cerca por texto era enganada por `if (false)`, `.catch()` e por `//` dentro de string).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import {
  assertFamilyViewsReadable, countLiveTransmissions, VOICE_READINGS, SERVICE_VOICE_READING, MERCHANDISE_VOICE_READING,
  CORE_MIGRATIONS_PROJECT,
} from 'fiscal-api'
import { MIGRATION_SETS } from '../migrations'

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => { visit(node); node.forEachChild(c => walk(c, visit)) }

function tsFiles(dir: string, skip: string[] = []): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!skip.includes(e.name)) out.push(...tsFiles(path.join(dir, e.name), skip)) }
    else if (e.name.endsWith('.ts')) out.push(path.join(dir, e.name))
  }
  return out
}
/** Produção = `src/` fora dos testes + `scripts/` (gate socrático, LOW-1). */
const productionFiles = () => [...tsFiles(SRC, ['__tests__']), ...tsFiles(path.join(ROOT, 'scripts'))]
/** Arquivos em que [name] aparece como IDENTIFICADOR no código (comentário e string não contam — é a árvore, não o texto). */
function filesUsing(name: string): string[] {
  return productionFiles().filter(f => {
    let found = false
    walk(parse(f), n => { if (ts.isIdentifier(n) && n.text === name) found = true })
    return found
  }).map(f => path.relative(ROOT, f).replace(/\\/g, '/'))
}

/** As instruções DIRETAS do corpo de `main` do `server.ts`, e as chamadas a [name] em qualquer lugar do arquivo. */
function serverMain() {
  const sf = parse(path.join(SRC, 'server.ts'))
  const main = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main')!
  const statements = [...main.body!.statements]
  const callsTo = (name: string) => {
    const out: ts.CallExpression[] = []
    walk(sf, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n) })
    return out
  }
  /** Índice da instrução direta de `main` que é EXATAMENTE `await <call>` (sem `if`, sem `.catch`, sem atribuição escondendo). */
  const directAwaitIndex = (call: ts.CallExpression) => statements.findIndex(s =>
    ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression) && s.expression.expression === call)
  const indexOfText = (needle: string) => statements.findIndex(s => s.getText(sf).includes(needle))
  return { sf, statements, callsTo, directAwaitIndex, indexOfText }
}

/** Banco falso do boot: registra cada SQL e falha (como o motor sem a view) em toda consulta que cite uma das views de [missing]. */
function fakeDb(missing: string[] = []) {
  const sqls: string[] = []
  const q = {
    query: async (sql: string) => {
      sqls.push(sql)
      if (missing.some(v => sql.includes(v))) throw Object.assign(new Error('Table doesn\'t exist'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      return [[], []]
    },
  }
  return { q: q as never, sqls }
}

describe('DEPLOY.E1.P5 — o boot da nfse-api confere só a leitura da NFS-e (D-NE158, D-NE76)', () => {
  it('o catálogo do núcleo instalado lista as DUAS famílias (por isso o catálogo inteiro não serve ao boot daqui)', () => {
    expect(Object.keys(VOICE_READINGS).sort()).toEqual(['merchandise', 'service'])
    expect(VOICE_READINGS.service).toBe(SERVICE_VOICE_READING)
    expect(VOICE_READINGS.merchandise).toBe(MERCHANDISE_VOICE_READING)
  })

  it('o `server.ts` chama a conferência UMA vez, como `await` direto de `main`, com EXATAMENTE `[SERVICE_VOICE_READING]`, depois das migrations e antes de ouvir a porta', () => {
    const { sf, callsTo, directAwaitIndex, indexOfText } = serverMain()
    const calls = callsTo('assertFamilyViewsReadable')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments.map(a => a.getText(sf))).toEqual(['ctx.pool', 'ctx.fiscalDb', '[SERVICE_VOICE_READING]'])
    const at = directAwaitIndex(calls[0])
    expect(at).toBeGreaterThan(-1)                                    // instrução direta: nada de `if`, `.catch()` ou função aninhada
    expect(at).toBeGreaterThan(indexOfText('await runMigrations('))
    expect(indexOfText('.listen(')).toBeGreaterThan(at)
  })

  it('o `server.ts` aplica no boot o conjunto `MIGRATION_SETS` (é por ele que a 007 do núcleo entra)', () => {
    const { sf, callsTo } = serverMain()
    const calls = callsTo('runMigrations')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments.map(a => a.getText(sf))).toEqual(['ctx.db', 'MIGRATION_SETS'])
  })

  it('nenhum arquivo de produção (src/ e scripts/) usa o catálogo inteiro nem a leitura da NF-e — e só o `server.ts` chama a conferência', () => {
    expect(productionFiles().length).toBeGreaterThan(30)
    expect(filesUsing('VOICE_READINGS')).toEqual([])
    expect(filesUsing('MERCHANDISE_VOICE_READING')).toEqual([])
    expect(filesUsing('assertFamilyViewsReadable')).toEqual(['src/server.ts'])
    expect(filesUsing('SERVICE_VOICE_READING')).toContain('src/server.ts')   // a própria varredura enxerga identificadores
  })

  it('sem a view da NF-e no banco, a conferência com `[SERVICE_VOICE_READING]` PASSA e só consulta a view da NFS-e', async () => {
    const { q, sqls } = fakeDb([MERCHANDISE_VOICE_READING.transmissionView])
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', [SERVICE_VOICE_READING])).resolves.toBeUndefined()
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('FROM `fiscal_api`.vw_invoice_service_transmission v')
    expect(sqls[0]).toMatch(/WHERE 1 = 0$/)
    expect(sqls[0]).not.toContain(MERCHANDISE_VOICE_READING.transmissionView)
  })

  it('no MESMO banco o catálogo inteiro FALHA pela view da NF-e — é o boot preso à outra família que a D-NE76 proíbe', async () => {
    const { q } = fakeDb([MERCHANDISE_VOICE_READING.transmissionView])
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', Object.values(VOICE_READINGS)))
      .rejects.toThrow(/família "merchandise" \(fiscal_api\.vw_invoice_merchandise_transmission\) não responde/)
  })

  it('a view da NFS-e faltando segue derrubando o boot daqui (D-F113)', async () => {
    const { q } = fakeDb([SERVICE_VOICE_READING.transmissionView])
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', [SERVICE_VOICE_READING]))
      .rejects.toThrow(/família "service" \(fiscal_api\.vw_invoice_service_transmission\) não responde/)
  })

  it('a conferência NÃO tem valor padrão: sem a lista o TypeScript recusa e a execução falha alto; lista vazia também', async () => {
    const { q, sqls } = fakeDb()
    // @ts-expect-error D-NE158: o 3º argumento é obrigatório no núcleo 5.0.0
    await expect(assertFamilyViewsReadable(q, 'fiscal_api')).rejects.toThrow(/cada chamador passa a lista que confere \(D-NE158\)/)
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', [])).rejects.toThrow(/catálogo de famílias vazio/)
    expect(sqls).toEqual([])
  })

  it('a migration 007 do núcleo (a view da habilitação — D-NE170) está no conjunto do núcleo, que vem primeiro, e só cria VIEW', () => {
    const core = MIGRATION_SETS.find(s => s.project === CORE_MIGRATIONS_PROJECT)!
    expect(MIGRATION_SETS[0]).toBe(core)
    expect(fs.readdirSync(core.dir)).toContain('007_issuer_view.sql')
    const sql = fs.readFileSync(path.join(core.dir, '007_issuer_view.sql'), 'utf8').replace(/--[^\n]*/g, '')
    expect(sql).toMatch(/CREATE OR REPLACE VIEW `vw_establishment_issuer`/)
    expect(sql).not.toMatch(/CREATE\s+TABLE/i)                        // só view: a cerca das tabelas do harness não ganha linha
  })
})

// O que o 5.0.0 muda na nfse-api SEM código daqui (gate socrático, MEDIUM-2): a guarda do DELETE do A1 (`clearCertificate` do núcleo →
// `countLiveTransmissions(…, { branches: 'all' })`) percorre o catálogo, que agora tem a NF-e. A troca de ambiente e a exclusão da
// habilitação contam só o ramo do modelo (aqui, sempre `service`).
describe('DEPLOY.E1.P5 — a guarda do DELETE do A1 passa a somar as NF-e vivas (núcleo 5.0.0, D-NE9/D-NE76)', () => {
  const NFSE = SERVICE_VOICE_READING.transmissionView
  const NFE = MERCHANDISE_VOICE_READING.transmissionView
  /** [nfe]: número = vivas na view da NF-e; 'absent' = nem view nem tabela (família não instalada); 'table-only' = tabela sem a view. */
  function liveDb(nfse: number, nfe: number | 'absent' | 'table-only') {
    const sqls: string[] = []
    const q = {
      query: async (sql: string) => {
        sqls.push(sql)
        if (sql.includes('information_schema.TABLES')) return [nfe === 'table-only' ? [{ name: `tb_${NFE.slice(3)}` }] : [], []]
        if (sql.includes(NFE)) {
          if (typeof nfe !== 'number') throw Object.assign(new Error(`Table 'fiscal_api.${NFE}' doesn't exist`), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
          return [[{ n: nfe }], []]
        }
        if (sql.includes(NFSE)) return [[{ n: nfse }], []]
        throw new Error(`SQL inesperado: ${sql}`)
      },
    }
    return { q: q as never, sqls }
  }

  it('as duas famílias instaladas: a contagem de TODAS soma NFS-e e NF-e (uma NF-e viva basta para o 409 do DELETE do A1)', async () => {
    const { q, sqls } = liveDb(0, 2)
    expect(await countLiveTransmissions(q, 7, { branches: 'all' })).toBe(2)
    expect(sqls.map(s => (s.includes(NFE) ? NFE : s.includes(NFSE) ? NFSE : '?')).sort()).toEqual([NFE, NFSE].sort())
    expect(await countLiveTransmissions(liveDb(1, 2).q, 7, { branches: 'all' })).toBe(3)
  })

  it('família da NF-e NÃO instalada (nem view nem tabela): conta 0 legítimo — o DELETE do A1 segue como antes', async () => {
    const { q, sqls } = liveDb(1, 'absent')
    expect(await countLiveTransmissions(q, 7, { branches: 'all' })).toBe(1)
    expect(sqls).toHaveLength(3)                                      // NFS-e, NF-e (1146) e a pergunta ao catálogo do banco
  })

  it('tabela da NF-e presente SEM a view: falha FECHADO (o erro sobe; nunca vira 0)', async () => {
    await expect(countLiveTransmissions(liveDb(0, 'table-only').q, 7, { branches: 'all' })).rejects.toMatchObject({ errno: 1146 })
  })

  it('o ramo da casa (`service` — troca de ambiente e exclusão da habilitação SE) NÃO consulta a view da NF-e', async () => {
    const { q, sqls } = liveDb(4, 'table-only')
    expect(await countLiveTransmissions(q, 7, { branches: ['service'] })).toBe(4)
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain(NFSE)
  })
})
