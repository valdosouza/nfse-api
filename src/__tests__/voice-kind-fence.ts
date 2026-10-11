/**
 * CERCA da D-F102 (= Q-F108 (a), Valdo 2026-10-11) — peça de teste COMPARTILHADA (gate da Rodada 21, R21-01): "nenhum produtor da voz S
 * ('enviado') na família da NFS-e". S não tem SAÍDA (a D-F51 só fecha tentativa sem voz); quem criar um produtor de S dá a ela a saída
 * na MESMA entrega — e esta cerca quebra nesse dia, apontando o arquivo.
 *
 * Por AST do TypeScript, nunca por regex sobre o texto (lição ADV-R8-06 do núcleo — `fiscal-api/src/__tests__/fence.ts`): o compilador
 * tira os comentários (a regex antiga lia o `/*` do XPath `//*[@Id=…]` do xmldsig como comentário e ficava CEGA a 10 linhas reais) e pega
 * qualquer GRAFIA — aspas simples/duplas/crase, ternário, parênteses, cast, propriedade computada, atribuição a `.kind`/`['kind']` e SQL
 * de escrita na voz com 'S'. Os `.sql` são lidos statement a statement.
 *
 * LIMITE CONHECIDO (Q-F112): produtor SEMÂNTICO (constante nomeada, shorthand, mapa novo, parâmetro) não tem o literal ao lado do `kind`
 * — nenhuma cerca textual o pega; o que o pega é o TIPO do escritor.
 *
 * ESCOPO = todo lugar que escreve na voz da NFS-e: nfse-api (src, scripts, migrations), núcleo (src, migrations) e o caminho de produção
 * do setes-api até a F2a (a pasta inteira da composição + as migrations dele).
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
export const WORKSPACE = path.resolve(PROJECT_ROOT, '..')

/** `.ts` de uma pasta, recursivo, sem `__tests__` nem `node_modules`. */
export const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const sqlUnder = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(n => n.endsWith('.sql')).map(n => path.join(dir, n)))

/** SQL de ESCRITA na voz que grava S: INSERT/REPLACE na tabela da voz com o literal 'S', ou UPDATE que põe `kind = 'S'`. */
function sqlWritesS(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ')
  if (/\b(?:INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO)\b[^;]*transmission_event\b[^;]*'S'/i.test(s)) return true
  return /\bUPDATE\b[^;]*transmission_event\b[^;]*\bkind\s*=\s*'S'/i.test(s)
}

/** Um texto-fonte TypeScript produz a voz S? (AST — comentários fora pelo compilador; qualquer grafia do literal) */
export function tsProducesS(code: string): boolean {
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
      if (sql && sqlWritesS(sql)) hit = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

/** Um `.sql` produz a voz S? (comentários SQL fora; statement a statement) */
export function sqlFileProducesS(sql: string): boolean {
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
  return clean.split(';').some(sqlWritesS)
}

/** O CONJUNTO que a cerca varre — todo lugar que escreve na voz da NFS-e. */
export function voiceFenceScope(): string[] {
  const W = WORKSPACE
  return [...new Set([
    ...walkTs(path.join(W, 'nfse-api', 'src')), ...walkTs(path.join(W, 'nfse-api', 'scripts')),
    ...sqlUnder(path.join(W, 'nfse-api', 'src', 'migrations', 'sql')),
    ...walkTs(path.join(W, 'fiscal-api', 'src')), ...sqlUnder(path.join(W, 'fiscal-api', 'src', 'migrations', 'sql')),
    ...walkTs(path.join(W, 'setes-api', 'src', 'shared', 'invoice-transmission')),
    ...sqlUnder(path.join(W, 'setes-api', 'src', 'migrations', 'sql')),
  ].map(f => path.resolve(f)))]
}

/** Arquivos do escopo que produzem a voz S (relativos ao workspace). Vazio = a D-F102 vale. */
export function voiceSProducers(files: string[] = voiceFenceScope()): string[] {
  return files.filter(f => fs.existsSync(f))
    .filter(f => { const c = fs.readFileSync(f, 'utf8'); return f.endsWith('.sql') ? sqlFileProducesS(c) : tsProducesS(c) })
    .map(f => path.relative(WORKSPACE, f).replace(/\\/g, '/'))
}
