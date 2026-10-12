/**
 * CERCA da D-F102 (= Q-F108 (a), Valdo 2026-10-11) — peça de teste COMPARTILHADA (gate da Rodada 21, R21-01): "nenhum produtor da voz S
 * ('enviado') na família da NFS-e". D-F105 (= Q-F111 (a)): vale SÓ para a família NFS-e (`tb_invoice_service_transmission_event`) — a
 * NF-e produz S LEGÍTIMO (NE-3) e define a saída dele na própria rodada (consulta pela chave/recibo — D-NE33); por isso, no NÚCLEO (onde a
 * NE-1a põe a máquina comum), a cerca só olha SQL na tabela da NFS-e — nunca o literal `kind: 'S'`. S não tem SAÍDA (a D-F51 só fecha tentativa sem voz); quem criar um produtor de S dá a ela a saída
 * na MESMA entrega — e esta cerca quebra nesse dia, apontando o arquivo.
 *
 * Por AST do TypeScript, nunca por regex sobre o texto (lição ADV-R8-06 do núcleo — `fiscal-api/src/__tests__/fence.ts`): o compilador
 * tira os comentários (a regex antiga lia o `/*` do XPath `//*[@Id=…]` do xmldsig como comentário e ficava CEGA a 10 linhas reais) e pega
 * qualquer GRAFIA — aspas simples/duplas/crase, ternário, parênteses, cast, propriedade computada, atribuição a `.kind`/`['kind']` e SQL
 * de escrita na voz com 'S'. Os `.sql` são lidos statement a statement.
 *
 * LIMITE CONHECIDO: produtor SEMÂNTICO (constante nomeada, shorthand, mapa novo, parâmetro) não tem o literal ao lado do `kind` —
 * nenhuma cerca textual o pega; quem o pega é o TIPO do escritor (D-F106 — `ServiceVoiceWriteKind`, lista positiva da família).
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
const CORE_ROOT = path.resolve(WORKSPACE, 'fiscal-api')

/** `.ts` de uma pasta, recursivo, sem `__tests__` nem `node_modules`. */
export const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const sqlUnder = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(n => n.endsWith('.sql')).map(n => path.join(dir, n)))

const VOICE_TABLE = 'invoice_service_transmission_event'
/** O 'S' em qualquer aspa do MySQL (simples; duplas sem ANSI_QUOTES) — gate R22, R22-07. */
const S_LIT = String.raw`(?:'S'|"S")`
/** INSERT/REPLACE com ou sem INTO e com os modificadores do MySQL (LOW_PRIORITY/HIGH_PRIORITY/DELAYED/IGNORE) — R22-07. */
const INSERT_HEAD = String.raw`\b(?:INSERT|REPLACE)\b(?:\s+(?:LOW_PRIORITY|HIGH_PRIORITY|DELAYED|IGNORE))*(?:\s+INTO)?\s`
/** SQL de ESCRITA na voz DA NFS-e — qualquer (escritor único — R22-05). */
function sqlWritesVoice(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ')
  return new RegExp(String.raw`(?:${INSERT_HEAD}|\bUPDATE\b|\bDELETE\b)[^;]*${VOICE_TABLE}\b`, 'i').test(s)
}
/** SQL de ESCRITA na voz DA NFS-e que grava S (D-F105: só a tabela da família de serviço). */
function sqlWritesS(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ')
  if (new RegExp(String.raw`${INSERT_HEAD}[^;]*${VOICE_TABLE}\b[^;]*${S_LIT}`, 'i').test(s)) return true
  // UPDATE … SET [alias.]`kind` = 'S' — com crase, CASE ou IF() no SET (R22-07)
  return new RegExp(String.raw`\bUPDATE\b[^;]*${VOICE_TABLE}\b[^;]*\b(?:\w+\.)?` + '`?kind`?' + String.raw`\s*=\s*(?:(?:CASE\b|IF\s*\()[^;]*?)?${S_LIT}`, 'i').test(s)
}

/** Texto de um literal/template; `${X}` vira o valor de uma CONSTANTE string do mesmo arquivo quando houver (R22-06), senão `?`. */
function sqlTextOf(n: ts.Node, consts: Map<string, string>): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text
  if (!ts.isTemplateExpression(n)) return null
  return [n.head.text, ...n.templateSpans.map(sp => (ts.isIdentifier(sp.expression) && consts.get(sp.expression.text)) || '?') .map((v, i) => v + n.templateSpans[i].literal.text)].join('')
}
function stringConsts(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) m.set(n.name.text, n.initializer.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
}

/** Um texto-fonte TypeScript produz a voz S? (AST — comentários fora pelo compilador; qualquer grafia do literal). `sqlOnly`: só o SQL
 *  na tabela da NFS-e (o NÚCLEO — D-F105: o `kind: 'S'` de lá é da NF-e). */
export function tsProducesS(code: string, opts: { sqlOnly?: boolean } = {}): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const isS = (n: ts.Node) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'S'
  const hasS = (n: ts.Node): boolean => isS(n) || !!ts.forEachChild(n, c => (hasS(c) ? true : undefined))
  const nameIsKind = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text === 'kind'
    : ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression) && n.expression.text === 'kind'
  const consts = stringConsts(sf)
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (!opts.sqlOnly && ts.isPropertyAssignment(n) && nameIsKind(n.name) && hasS(n.initializer)) hit = true
    else if (!opts.sqlOnly && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && hasS(n.right)
      && ((ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'kind')
        || (ts.isElementAccessExpression(n.left) && ts.isStringLiteral(n.left.argumentExpression) && n.left.argumentExpression.text === 'kind'))) hit = true
    else {
      const sql = sqlTextOf(n, consts)
      if (sql && sqlWritesS(sql)) hit = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

const WRITER = 'insertTransmissionEvent'
const FAMILY = new Set(['A', 'R', 'C', 'K', 'F', 'N'])
const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isTypeAssertionExpression(x) || ts.isNonNullExpression(x)
    || ts.isSatisfiesExpression(x)) x = x.expression
  return x
}
const isCast = (e: ts.Expression): boolean => ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)
  || (ts.isParenthesizedExpression(e) && isCast(e.expression))
/**
 * CERCA DE CHAMADA do escritor da voz da NFS-e (gates R21/R22 — a `writerCalls` do r21 promovida e endurecida). true = violação:
 *  - chamada ao escritor (`insertTransmissionEvent` nu, por namespace `x.insertTransmissionEvent`, por ALIAS — import `as`/`const = …` —
 *    ou com CAST da função) cujo objeto da voz NÃO é um objeto literal sem cast e sem SPREAD (R22-01/R22-04), ou cujo `kind` não é literal
 *    da família nem `OUTCOME_KIND[…]`;
 *  - objeto com `kind` sob CAST passado a qualquer chamada (o alias que este texto não declara — R22-04);
 *  - MUTAÇÃO do `OUTCOME_KIND` (`Object.assign`/`defineProperty`/`Reflect.set`/atribuição/`delete` — R22-02);
 *  - SQL de escrita na voz da NFS-e — salvo nos escritores autorizados (`allowSqlWriter` — ESCRITOR ÚNICO, R22-05).
 */
export function writerCallFlags(code: string, opts: { allowSqlWriter?: boolean } = {}): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = stringConsts(sf)
  const aliases = new Set([WRITER])
  const collect = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === WRITER) aliases.add(n.name.text)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = unwrap(n.initializer)
      if ((ts.isIdentifier(v) && v.text === WRITER) || (ts.isPropertyAccessExpression(v) && v.name.text === WRITER)) aliases.add(n.name.text)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const isWriter = (callee: ts.Expression) => {
    const c = unwrap(callee)
    return (ts.isIdentifier(c) && aliases.has(c.text)) || (ts.isPropertyAccessExpression(c) && c.name.text === WRITER)
  }
  const isOutcomeKind = (e: ts.Expression) => {
    const x = unwrap(e)
    return (ts.isIdentifier(x) && x.text === 'OUTCOME_KIND') || (ts.isPropertyAccessExpression(x) && x.name.text === 'OUTCOME_KIND')
  }
  const kindOk = (obj: ts.ObjectLiteralExpression): boolean => {
    if (obj.properties.some(ts.isSpreadAssignment)) return false
    const p = obj.properties.find(q => (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf) === 'kind')
    if (!p || !ts.isPropertyAssignment(p)) return false
    const init = p.initializer
    if (ts.isStringLiteral(init)) return FAMILY.has(init.text)
    return ts.isElementAccessExpression(init) && isOutcomeKind(init.expression)
  }
  const hasKindProp = (o: ts.ObjectLiteralExpression) => o.properties.some(q =>
    (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && q.name.getText(sf) === 'kind')
  let bad = false
  const visit = (n: ts.Node): void => {
    if (bad) return
    if (ts.isCallExpression(n)) {
      if (isWriter(n.expression)) {
        const arg = n.arguments[n.arguments.length - 1]
        if (!arg || isCast(arg) || !ts.isObjectLiteralExpression(unwrap(arg)) || !kindOk(unwrap(arg) as ts.ObjectLiteralExpression)) bad = true
      }
      for (const a of n.arguments) if (isCast(a) && ts.isObjectLiteralExpression(unwrap(a)) && hasKindProp(unwrap(a) as ts.ObjectLiteralExpression)) bad = true
      const callee = unwrap(n.expression)
      if (ts.isPropertyAccessExpression(callee) && /^(?:Object|Reflect)$/.test(callee.expression.getText(sf))
        && /^(?:assign|defineProperty|defineProperties|set|deleteProperty|setPrototypeOf)$/.test(callee.name.text)
        && n.arguments[0] && isOutcomeKind(n.arguments[0])) bad = true
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = unwrap(n.left)
      if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && isOutcomeKind(l.expression)) bad = true
    }
    if (ts.isDeleteExpression(n)) {
      const x = unwrap(n.expression)
      if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && isOutcomeKind(x.expression)) bad = true
    }
    if (!opts.allowSqlWriter) {
      const sql = sqlTextOf(n, consts)
      if (sql && sqlWritesVoice(sql)) bad = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return bad
}

/** Os escritores AUTORIZADOS do SQL na voz da NFS-e (ESCRITOR ÚNICO — R22-05): os dois repositórios e a cópia do `migrate:setes`. */
export const VOICE_SQL_WRITERS = [
  'nfse-api/src/nfse/repository.ts',
  'nfse-api/scripts/migrate-from-setes-api.ts',
  'setes-api/src/shared/invoice-transmission/transmission.repository.ts',
]

/** Violações da cerca de chamada/escritor único no escopo (fora do NÚCLEO — D-F105; migrations `.sql` ficam fora: DDL, revisar-ddl). */
export function voiceWriterViolations(files: string[] = voiceFenceScope()): string[] {
  return files.filter(f => fs.existsSync(f) && f.endsWith('.ts') && !path.resolve(f).startsWith(CORE_ROOT + path.sep))
    .filter(f => writerCallFlags(fs.readFileSync(f, 'utf8'), {
      allowSqlWriter: VOICE_SQL_WRITERS.includes(path.relative(WORKSPACE, f).replace(/\\/g, '/')),
    }))
    .map(f => path.relative(WORKSPACE, f).replace(/\\/g, '/'))
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

/** Arquivos do escopo que produzem a voz S da NFS-e (relativos ao workspace). Vazio = a D-F102 vale. No núcleo, só SQL (D-F105). */
export function voiceSProducers(files: string[] = voiceFenceScope()): string[] {
  return files.filter(f => fs.existsSync(f))
    .filter(f => {
      const c = fs.readFileSync(f, 'utf8')
      return f.endsWith('.sql') ? sqlFileProducesS(c) : tsProducesS(c, { sqlOnly: path.resolve(f).startsWith(CORE_ROOT + path.sep) })
    })
    .map(f => path.relative(WORKSPACE, f).replace(/\\/g, '/'))
}
