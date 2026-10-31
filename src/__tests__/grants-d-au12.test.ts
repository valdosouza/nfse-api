/// <reference types="jest" />
// D-AU12 (Valdo 2026-10-31 — Infra-IA/prompts/prompt_frente_auth_api.md; costura A1): em `setes_central` o usuário das APIs fiscais LISTA
// só as tabelas que o código LÊ — nunca `tb_user` (o hash da senha), a recuperação de senha, o vínculo ou as concessões (o veredito vem
// das views, SQL SECURITY DEFINER). CERCA: toda tabela/view de `setes_central` citada pelo código de PRODUÇÃO do núcleo e da nfse-api
// está na lista do `ops/grants.sql` (tabela nova lida = linha nova no GRANT, junto) — e a lista nunca abre o que é da credencial/acesso.
// ⚠️ O curinga `setes\_%` casa `setes_central`: a seção exige a linha ESPECÍFICA do central SEM o SELECT (provado em banco descartável
// pelo setes-api — `scripts/prove-user-access-views.ts`, item 6).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const NFSE_SRC = path.resolve(__dirname, '..')
const CORE_SRC = path.resolve(__dirname, '../../../fiscal-api/src')
const GRANTS = fs.readFileSync(path.resolve(__dirname, '../../ops/grants.sql'), 'utf8')
  // o estreitamento dos hosts LOCAIS do dev mora em arquivo próprio (nunca roda em produção)
  + '\n' + fs.readFileSync(path.resolve(__dirname, '../../ops/grants-d-au12-dev-local.sql'), 'utf8')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...tsFiles(p)) }
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/** Código sem comentários (o printer do compilador; texto com `//` fica intacto). */
function codeOf(file: string): string {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return ts.createPrinter({ removeComments: true }).printFile(sf)
}

/** `setes_central.<nome>` (com ou sem crase) lido pelo código de produção — arquivo → nomes. */
function centralReads(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const f of [...tsFiles(NFSE_SRC), ...tsFiles(CORE_SRC)]) {
    for (const m of codeOf(f).matchAll(/setes_central`?\.`?(\$\{|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1]
      if (!out.has(name)) out.set(name, new Set())
      out.get(name)!.add(path.relative(path.resolve(__dirname, '../../..'), f).replace(/\\/g, '/'))
    }
  }
  return out
}

const grantedTables = (host: string) => new Set(
  [...GRANTS.matchAll(new RegExp(`^GRANT SELECT ON \`setes_central\`\\.\`(\\w+)\`\\s+TO 'fiscal_api'@'${host.replace(/[.:]/g, '\\$&')}';`, 'gm'))]
    .map(m => m[1]))

describe('D-AU12 — GRANT do usuário fiscal em setes_central: só o que o código lê', () => {
  it('o código não monta nome de tabela de setes_central dinamicamente (a cerca precisa ler o nome)', () => {
    expect(centralReads().get('${') ?? new Set()).toEqual(new Set())
  })

  it('toda tabela/view de setes_central lida pelo código de produção está no GRANT (tabela nova lida = linha nova no grants.sql)', () => {
    const granted = grantedTables('%')
    const missing = [...centralReads()].filter(([name]) => !granted.has(name)).map(([name, files]) => `${name} ← ${[...files].join(', ')}`)
    expect(missing).toEqual([])
  })

  it('o GRANT não abre o que é da credencial, do vínculo ou das concessões (o veredito vem da view)', () => {
    const forbidden = ['tb_user', 'tb_user_password_reset', 'tb_user_password_reset_notice', 'tb_institution_has_user',
      'tb_privilege', 'tb_interface_has_privilege', 'tb_user_credential', 'tb_user_login_failure']
    for (const host of ['%', 'localhost', '127.0.0.1', '::1']) {
      expect([host, [...grantedTables(host)].filter(t => forbidden.includes(t))]).toEqual([host, []])
    }
    expect(GRANTS).not.toMatch(/^GRANT SELECT ON `setes_central`\.\* TO 'fiscal_api'@'%';/m)
  })

  it('a linha ESPECÍFICA do central existe e fica SEM o SELECT (sombreia o curinga `setes\\_%`), na ordem idempotente', () => {
    const lines = GRANTS.split(/\r?\n/)
    const at = (re: RegExp) => lines.findIndex(l => re.test(l))
    const keep = at(/^GRANT SELECT, SHOW VIEW ON `setes_central`\.\* TO 'fiscal_api'@'%';/)
    const revoke = at(/^REVOKE SELECT ON `setes_central`\.\* FROM 'fiscal_api'@'%';/)
    const first = at(/^GRANT SELECT ON `setes_central`\.`\w+`\s+TO 'fiscal_api'@'%';/)
    expect([keep >= 0, revoke > keep, first > revoke]).toEqual([true, true, true])
  })

  it('no DEV os hosts locais (onde a conexão local autentica — D-F53) recebem o MESMO estreitamento, com a mesma lista', () => {
    const prod = [...grantedTables('%')].sort()
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect([host, [...grantedTables(host)].sort()]).toEqual([host, prod])
      expect(GRANTS).toMatch(new RegExp(`^REVOKE SELECT ON \`setes_central\`\\.\\* FROM 'fiscal_api'@'${host.replace(/[.:]/g, '\\$&')}';`, 'm'))
    }
  })
})
