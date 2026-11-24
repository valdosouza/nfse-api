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
const OPS_DIR = path.resolve(__dirname, '../../ops')
const GRANTS = fs.readFileSync(path.join(OPS_DIR, 'grants.sql'), 'utf8')

/** A ÚNICA forma de conta aceita em `ops/`: `'<usuário>'@'%'` com aspas simples fechadas, sem espaço, precedida de espaço. */
const CANONICAL_ACCOUNT = /(?<=[\s(,])'[A-Za-z_][A-Za-z0-9_]*'@'%'(?=[\s;,)`]|$)/g

/**
 * DEPLOY.E1.P8 (PM-22, Valdo 2026-11-24): o que um texto de `ops/` tem FORA da forma aceita de conta — lista POSITIVA (gate adversarial:
 * caçar as formas erradas de `usuário@host` deixava escapar palavra-chave colada na aspa, comentário entre o usuário e o `@`, host com
 * aspa dobrada, escape no nome e SQL montado). Lê o texto INTEIRO — comentário também: neste arquivo GRANT comentado é linha pronta para
 * descomentar. Recusa: (1) todo `@` que não esteja numa conta na forma exata `'<usuário>'@'%'` — outro host, outra aspa, espaço,
 * comentário no meio, variável `@x`, e-mail; (2) SQL montado em tempo de execução (`PREPARE`, `EXECUTE IMMEDIATE`); (3) as tabelas de
 * contas do servidor (`mysql.user`, `mysql.global_priv`, `mysql.db`…). Usuário sem `@` é a conta do '%' para o motor e passa.
 */
export function strayAccountMarks(text: string): string[] {
  const ok = new Set<number>()
  for (const m of text.matchAll(CANONICAL_ACCOUNT)) ok.add(m.index! + m[0].indexOf('@'))
  const out: string[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (!ok.has(i)) out.push(`@ fora da forma '<usuário>'@'%': …${text.slice(Math.max(0, i - 24), i + 24).replace(/\s+/g, ' ')}…`)
  }
  for (const m of text.matchAll(/\b(PREPARE|EXECUTE\s+IMMEDIATE)\b|\bmysql`?\s*\.\s*`?(user|global_priv|db|tables_priv|columns_priv|procs_priv|proxies_priv|roles_mapping)\b/gi)) {
    out.push(`SQL montado ou tabela de contas: ${m[0].replace(/\s+/g, ' ')}`)
  }
  return out
}

/** Todo arquivo de `ops/`, com as subpastas (caminho relativo, com `/`). */
function opsFiles(dir = OPS_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? opsFiles(path.join(dir, e.name))
    : [path.relative(OPS_DIR, path.join(dir, e.name)).replace(/\\/g, '/')]).sort()
}

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
  it('as tabelas da fonte de fatos da nfe-api (unidade, forma de pagamento, CFOP) estão na lista', () => {
    const granted = grantedTables('%')
    expect(NFE_ONLY.filter(t => !granted.has(t))).toEqual([])
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
    expect([...grantedTables('%')].filter(t => forbidden.includes(t))).toEqual([])
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

  // DEPLOY.E1.P8 (PM-22, Valdo 2026-11-24): no dev a conexão local autentica na conta do '%' (leitura de 2026-11-24: `CURRENT_USER()` pelos
  // três endereços locais). GRANT a conta que não existe CRIA a conta sem senha (incidente de 2026-11-23): o script só do dev saiu, e
  // nenhum script de `ops/` escreve a conta do usuário fiscal em outro host — nem em comentário.
  describe('DEPLOY.E1.P8 — o usuário fiscal é UMA conta, a do host %', () => {
    const ACEITA = [
      "GRANT ALL PRIVILEGES ON `fiscal_api`.* TO 'fiscal_api'@'%';",
      "CREATE USER IF NOT EXISTS 'fiscal_api'@'%' IDENTIFIED BY '<SENHA>';",
      "-- GRANT SELECT ON `fiscal_api`.`vw_x` TO 'setes_api'@'%';",
      "--    `SHOW GRANTS FOR 'fiscal_api'@'%'` lista as 4.",
      "GRANT SELECT ON a.b TO 'fiscal_api';   -- sem host = a conta do '%'",
      "GRANT ALL PRIVILEGES ON `fiscal\\_api\\_adv%`.* TO 'fiscal_api'@'%';",
    ]
    const RECUSA = [
      "GRANT SELECT ON `setes_central`.`tb_city` TO 'fiscal_api'@'localhost';",
      'GRANT SELECT ON setes_central.tb_city TO `fiscal_api`@`127.0.0.1`;',
      'GRANT SELECT ON setes_central.tb_city TO fiscal_api@::1;',
      'REVOKE SELECT ON x.* FROM "fiscal_api" @ "localhost";',
      "CREATE USER 'fiscal_api'@localhost;",
      "-- GRANT ALL PRIVILEGES ON `fiscal\\_api\\_adv%`.* TO 'fiscal_api'@'::1';",
      "GRANT SELECT ON a.b TO 'fiscal_api'@'%';   -- nota\nGRANT SELECT ON a.c TO 'fiscal_api'@'localhost';",
      // gate adversarial (HIGH): palavra-chave colada na aspa; comentário entre o usuário e o `@`
      "GRANT SELECT ON a.b TO'fiscal_api'@'localhost';",
      'GRANT SELECT ON a.*TO`fiscal_api`@`localhost`;',
      "SET PASSWORD FOR'fiscal_api'@'localhost'=PASSWORD('x');",
      "GRANT SELECT ON a.b TO 'fiscal_api'/**/@'localhost';",
      "GRANT SELECT ON a.b TO 'fiscal_api' -- x\n@'localhost';",
      // gate adversarial (MEDIUM): host que só COMEÇA por %; escape no nome; SQL montado; tabela de contas; curinga parcial
      "GRANT SELECT ON a.b TO 'fiscal_api'@'% ';",
      "GRANT SELECT ON a.b TO 'fiscal_api'@'%''localhost';",
      "GRANT SELECT ON a.b TO 'fiscal_api'@'%;x';",
      "GRANT SELECT ON a.b TO 'fiscal_ap\\i'@'localhost';",
      "GRANT SELECT ON a.b TO 'fiscal_ap\\i'@'%';",
      "GRANT SELECT ON a.b TO 'fiscal_api'@'192.168.%';",
      "SET @s=CONCAT('GRANT SELECT ON a.b TO ''fiscal_api''@''localhost''');",
      "SELECT CONCAT('GRANT SELECT ON a.b TO ', QUOTE('fiscal_api'), '@', QUOTE('localhost'));",
      "PREPARE s FROM 'GRANT SELECT ON a.b TO fiscal_api';",
      "EXECUTE  IMMEDIATE CONCAT('GRANT ', x);",
      "INSERT INTO mysql.global_priv(Host,User,Priv) VALUES('localhost','fiscal_api','{}');",
      "UPDATE `mysql`.`user` SET Host='localhost' WHERE User='fiscal_api';",
      // outra conta em host local também nasce sem senha
      "GRANT SELECT ON a.b TO 'setes_api'@'localhost';",
      "TO 'fiscal_api'@;",
    ]
    it('o leitor aceita só a forma exata da conta no host % e recusa todo o resto, também em comentário', () => {
      expect(ACEITA.filter(sql => strayAccountMarks(sql).length > 0)).toEqual([])
      expect(RECUSA.filter(sql => strayAccountMarks(sql).length === 0)).toEqual([])
    })

    it('nenhum arquivo de ops/ (subpastas também) escreve conta fora do host % (GRANT a conta inexistente cria conta sem senha)', () => {
      const files = opsFiles()
      expect(files).toContain('grants.sql')
      expect(files.flatMap(f => strayAccountMarks(fs.readFileSync(path.join(OPS_DIR, f), 'utf8')).map(s => `${f}: ${s}`))).toEqual([])
      // o leitor enxerga as contas do '%' (não passa por não ler nada)
      expect([...GRANTS.matchAll(CANONICAL_ACCOUNT)].length).toBeGreaterThan(10)
    })

    it('o script só do dev não volta', () => {
      expect(opsFiles().filter(f => /dev-local/i.test(f))).toEqual([])
      expect(fs.existsSync(path.join(OPS_DIR, 'grants-d-au12-dev-local.sql'))).toBe(false)
    })

    it('a seção 5 do grants.sql diz o fato do dev, como conferir a conta e por que não conceder a conta inexistente', () => {
      expect(GRANTS).toContain('-- 5. D-F53')
      const s5 = GRANTS.slice(GRANTS.indexOf('-- 5. D-F53')).replace(/\r?\n--\s+/g, ' ')
      for (const trecho of ['NENHUM GRANT a host local', "A conexão local autentica na conta do host '%'", 'CURRENT_USER()',
        'NO_AUTO_CREATE_USER', 'CRIA a conta, SEM SENHA', "NUNCA a do '%'", 'motivo para PARAR']) {
        expect([trecho, s5.includes(trecho)]).toEqual([trecho, true])
      }
    })
  })
})
