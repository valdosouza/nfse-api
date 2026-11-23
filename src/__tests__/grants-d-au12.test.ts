/// <reference types="jest" />
// D-AU12 (Valdo 2026-10-31 — Infra-IA/prompts/prompt_frente_auth_api.md; costura A1): em `setes_central` o usuário das APIs fiscais LISTA
// só as tabelas que o código LÊ — nunca `tb_user` (o hash da senha), a recuperação de senha, o vínculo ou as concessões (o veredito vem
// das views, SQL SECURITY DEFINER). CERCA: toda tabela/view de `setes_central` citada pelo código de PRODUÇÃO do núcleo e da nfse-api
// está na lista do `ops/grants.sql` (tabela nova lida = linha nova no GRANT, junto) — e a lista nunca abre o que é da credencial/acesso.
// A lista serve também a nfe-api (mesmo usuário; a cerca dela lê este `grants.sql`): o que só ela lê é fixado por nome (DEPLOY.E1.P7).
// ⚠️ O curinga `setes\_%` casa `setes_central`: a seção exige a linha ESPECÍFICA do central SEM o SELECT (provado em banco descartável
// pelo setes-api — `scripts/prove-user-access-views.ts`, item 6).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const NFSE_SRC = path.resolve(__dirname, '..')
// D-F222 (2026-11-05): o núcleo entra pelo PACOTE versionado — a cerca lê o `dist` INSTALADO (o que vai para produção), nunca a pasta irmã
const CORE_DIST = path.join(path.dirname(require.resolve('fiscal-api/package.json')), 'dist')
const GRANTS = fs.readFileSync(path.resolve(__dirname, '../../ops/grants.sql'), 'utf8')
  // o estreitamento dos hosts LOCAIS do dev mora em arquivo próprio (nunca roda em produção)
  + '\n' + fs.readFileSync(path.resolve(__dirname, '../../ops/grants-d-au12-dev-local.sql'), 'utf8')

function codeFiles(dir: string, ext: 'ts' | 'js'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...codeFiles(p, ext)) }
    else if (e.name.endsWith(`.${ext}`) && !/\.(test|d)\.[jt]s$/.test(e.name)) out.push(p)
  }
  return out
}

/** Código sem comentários (o printer do compilador; texto com `//` fica intacto). */
function codeOf(file: string): string {
  const kind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  return ts.createPrinter({ removeComments: true }).printFile(sf)
}

/**
 * DEPLOY.E1.P3 (Valdo 2026-11-18, "Cerca daqui resolve"): o pacote 2.0.0 do núcleo monta o nome da view pela constante PUBLICADA
 * (`setes_central.${exports.ACCESS_VIEWS.interfaceCatalog}` — `access.licensedKeys`). A cerca resolve SÓ essa forma, pelo `ACCESS_VIEWS`
 * do pacote INSTALADO; chave que não existe nele, valor que não é um nome simples ou qualquer outro `${` seguem recusados.
 */
const CORE_ACCESS_VIEWS: Record<string, unknown> = require('fiscal-api').access.ACCESS_VIEWS
export function resolvePublishedViews(code: string): string {
  return code.replace(/setes_central(`?)\.(`?)\$\{exports\.ACCESS_VIEWS\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, a, b, key: string) => {
    const name = Object.prototype.hasOwnProperty.call(CORE_ACCESS_VIEWS, key) ? CORE_ACCESS_VIEWS[key] : undefined
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `setes_central${a}.${b}${name}` : all
  })
}

/** `setes_central.<nome>` (com ou sem crase) lido pelo código de produção — arquivo → nomes. */
function centralReads(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const f of [...codeFiles(NFSE_SRC, 'ts'), ...codeFiles(CORE_DIST, 'js')]) {
    for (const m of resolvePublishedViews(codeOf(f)).matchAll(/setes_central`?\.`?(\$\{|[A-Za-z_][A-Za-z0-9_]*)/g)) {
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

  it('só a constante PUBLICADA do núcleo é resolvida; chave inexistente ou outra expressão seguem como nome montado', () => {
    expect(resolvePublishedViews('JOIN setes_central.${exports.ACCESS_VIEWS.interfaceCatalog} c')).toBe('JOIN setes_central.vw_interface_catalog c')
    expect(resolvePublishedViews('setes_central.`${exports.ACCESS_VIEWS.userLink}`')).toBe('setes_central.`vw_user_link`')
    for (const keep of ['setes_central.${exports.ACCESS_VIEWS.naoExiste}', 'setes_central.${exports.ACCESS_VIEWS.constructor}',
      'setes_central.${exports.OUTRA.interfaceCatalog}', 'setes_central.${nome}', 'setes_central.${exports.ACCESS_VIEWS[k]}']) {
      expect(resolvePublishedViews(keep)).toBe(keep)
    }
  })

  it('toda tabela/view de setes_central lida pelo código de produção está no GRANT (tabela nova lida = linha nova no grants.sql)', () => {
    const granted = grantedTables('%')
    const missing = [...centralReads()].filter(([name]) => !granted.has(name)).map(([name, files]) => `${name} ← ${[...files].join(', ')}`)
    expect(missing).toEqual([])
  })

  // DEPLOY.E1.P7 (PM-21, Valdo 2026-11-23): o usuário é o MESMO da nfe-api e a cerca dela (`acesso-e1-p1-sessao-viva.test.ts`) lê esta
  // lista. As três tabelas da fonte de fatos da mercadoria (nfe-api:NFE.E5.P2.T1) não são lidas pelo código daqui — por isso a varredura
  // acima não as protege, e este teste as fixa (quando o leitor de lá existir, tirar uma linha quebra também a suíte da nfe-api).
  const NFE_ONLY = ['tb_measure', 'tb_payment_types', 'tb_cfop']
  it('as tabelas da fonte de fatos da nfe-api (unidade, forma de pagamento, CFOP) estão na lista, nos quatro hosts', () => {
    for (const host of ['%', 'localhost', '127.0.0.1', '::1']) {
      const granted = grantedTables(host)
      expect([host, NFE_ONLY.filter(t => !granted.has(t))]).toEqual([host, []])
    }
  })

  // Gate adversarial da DEPLOY.E1.P7: o ambiente de carga monta os GRANTs por `grantsDaCarga` (`scripts/carga/semear.ts`), que tira as
  // linhas de comentário, corta em `;` e só aceita o pedaço que COMEÇA pela instrução — uma linha posta depois de um comentário de fim
  // de linha (o `-- D-F240` da `vw_interface_catalog`) some em silêncio. As três têm de sobreviver a essa leitura.
  it('as três chegam ao ambiente de carga (a leitura de `grantsDaCarga` não as perde)', () => {
    const { grantsDaCarga } = require('../../scripts/carga/semear')
    const carga: string[] = grantsDaCarga(path.resolve(__dirname, '../..'), { fiscalDb: 'fiscal_api_carga', fiscalPassword: 'x' })
    expect(NFE_ONLY.filter(t => !carga.some(s => s.startsWith(`GRANT SELECT ON \`setes_central\`.\`${t}\``)))).toEqual([])
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
