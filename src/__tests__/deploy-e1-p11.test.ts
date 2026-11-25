/// <reference types="jest" />
// nfse-api:DEPLOY.E1.P11 — núcleo 5.3.0 (fiscal-api:FAMILIA.E5.P7): a migration 009 cria `tb_establishment_smtp_credential` (a senha da
// conta de e-mail do cliente, cifrada pelo cofre) e a rotação da chave-mestra passa a cobrir os DOIS donos do cofre. Esta API não lê nem
// grava a senha; o que ela faz é (a) conferir no BOOT a sonda do domínio da tabela, depois das migrations e antes de ouvir a porta, e
// (b) rotacionar a chave dos dois donos (`key-rotation.ts`, provado em `key-proof-d-f243.test.ts`). A cerca do `server.ts` lê a ÁRVORE do
// TypeScript (molde `deploy-e1-p10.test.ts`); a tabela é exceção NOMEADA da cópia de teste (`copy-tables-fence.test.ts`).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { FISCAL_COPY_EXCEPTIONS, FISCAL_COPY_TABLES, tablesByMigration } from './live-harness'

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const SERVER = path.join(SRC, 'server.ts')
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => { visit(node); node.forEachChild(c => walk(c, visit)) }
const has = (node: ts.Node, test: (n: ts.Node) => boolean) => { let found = false; walk(node, n => { if (test(n)) found = true }); return found }
const isCall = (n: ts.Node, name: string): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name

/** Onde está a sonda da 009 no `main` de um texto de `server.ts`. A regra inteira num lugar só (real e mutações). */
function smtpProbeFacts(source: string) {
  const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const main = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main')!
  const statements = [...main.body!.statements]
  const calls: ts.CallExpression[] = []
  walk(sf, n => { if (isCall(n, 'assertSmtpCredentialDomainsEnforced')) calls.push(n) })
  /** Instrução DIRETA de `main` que é EXATAMENTE `await assertSmtpCredentialDomainsEnforced(ctx.pool)` (sem `if`, `&&`, `try`, função). */
  const directIndex = calls.length === 1
    ? statements.findIndex(s => ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression) && s.expression.expression === calls[0])
    : -1
  const args = calls.length === 1 ? calls[0].arguments.map(a => a.getText(sf)) : []
  const migrationsIndex = statements.findIndex(s => has(s, n => isCall(n, 'runMigrations')))
  const listenIndex = statements.findIndex(s => has(s, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'listen'))
  const keyProofIndex = statements.findIndex(s => has(s, n => ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'KeyProof'))
  const holds = calls.length === 1 && directIndex >= 0 && args.length === 1 && args[0] === 'ctx.pool' &&
    migrationsIndex >= 0 && listenIndex >= 0 && keyProofIndex >= 0 &&
    migrationsIndex < directIndex && directIndex < keyProofIndex && keyProofIndex < listenIndex
  return { count: calls.length, directIndex, args, migrationsIndex, keyProofIndex, listenIndex, holds }
}

describe('DEPLOY.E1.P11 — a partida confere a sonda da 009 (cerca do `server.ts` pela árvore do TypeScript)', () => {
  const real = fs.readFileSync(SERVER, 'utf8').replace(/\r\n/g, '\n')            // o checkout pode trazer CRLF: a cerca não depende disso
  const CALL = '  await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'

  it('o `server.ts` chama `await assertSmtpCredentialDomainsEnforced(ctx.pool)` UMA vez, como instrução direta do `main`, depois do `runMigrations` e antes da prova da chave e do `listen`', () => {
    const f = smtpProbeFacts(real)
    expect(f.count).toBe(1)
    expect(f.args).toEqual(['ctx.pool'])
    expect(f.migrationsIndex).toBeGreaterThanOrEqual(0)
    expect(f.directIndex).toBeGreaterThan(f.migrationsIndex)
    expect(f.keyProofIndex).toBeGreaterThan(f.directIndex)      // a prova da chave lê a tabela da 009: a sonda antes dela
    expect(f.listenIndex).toBeGreaterThan(f.keyProofIndex)
    expect(f.holds).toBe(true)
  })

  it('a cerca não é enganada: cada mutação do `server.ts` (em memória) quebra a regra', () => {
    expect(real.split(CALL)).toHaveLength(2)
    const without = real.replace(CALL, '')
    const listenAt = without.indexOf('  createApp(ctx, keyProof).listen(')
    const listenEnd = without.indexOf('\n', listenAt) + 1
    expect(listenAt).toBeGreaterThan(0)
    const mutations: Record<string, string> = {
      'sem a chamada': without,
      'chamada em comentário': real.replace(CALL, '  // await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'sem await': real.replace(CALL, '  assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'depois do listen': without.slice(0, listenEnd) + CALL + without.slice(listenEnd),
      'antes das migrations': without.replace('  const applied = await runMigrations(', CALL + '  const applied = await runMigrations('),
      'depois da prova da chave': without.replace('  keyProof.start()\n', '  keyProof.start()\n' + CALL),
      'atrás de if (false)': real.replace(CALL, '  if (false) await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'atrás de false &&': real.replace(CALL, '  false && await assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'dentro de função nunca chamada': real.replace(CALL, '  const later = async () => assertSmtpCredentialDomainsEnforced(ctx.pool)\n'),
      'com falha engolida': real.replace(CALL, '  try { await assertSmtpCredentialDomainsEnforced(ctx.pool) } catch { /* sobe assim */ }\n'),
      'outro pool': real.replace(CALL, '  await assertSmtpCredentialDomainsEnforced(ctx.db)\n'),
      'duas chamadas': real.replace(CALL, CALL + CALL),
    }
    for (const [what, source] of Object.entries(mutations)) {
      expect(source).not.toBe(real)
      expect([what, smtpProbeFacts(source).holds]).toEqual([what, false])
    }
  })
})

describe('DEPLOY.E1.P11 — a tabela da 009 está no pacote e é exceção NOMEADA da cópia de teste', () => {
  it('as migrations do núcleo instalado criam `tb_establishment_smtp_credential` (009); ela não está na lista de cópia, está nas exceções, com o motivo', () => {
    const created = tablesByMigration().map(t => t.table)
    expect(created).toContain('tb_establishment_smtp_credential')
    expect(FISCAL_COPY_TABLES).not.toContain('tb_establishment_smtp_credential')
    expect(FISCAL_COPY_EXCEPTIONS.tb_establishment_smtp_credential).toMatch(/senha SMTP cifrada/)
  })

  it('a NFS-e não lê nem grava a credencial SMTP: nenhum arquivo de `src/` fora de __tests__ chama a peça nem cita a tabela', () => {
    const users: string[] = []
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__') visit(path.join(dir, e.name)) }
        else if (e.name.endsWith('.ts') && /openSmtpCredential|saveSmtpCredential|eraseSmtpCredential|smtpCredentialStatus|tb_establishment_smtp_credential/
          .test(fs.readFileSync(path.join(dir, e.name), 'utf8'))) users.push(path.relative(SRC, path.join(dir, e.name)))
      }
    }
    visit(SRC)
    expect(users).toEqual([])
  })
})
