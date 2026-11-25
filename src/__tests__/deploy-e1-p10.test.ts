/// <reference types="jest" />
// nfse-api:DEPLOY.E1.P10 — núcleo 5.2.0 (fiscal-api:FAMILIA.E5.P6): o arquivo fiscal é de GRAVAÇÃO ÚNICA (índice `.once/` por série) e o
// `warm()` prepara esse índice de toda série que já tem arquivos. A PARTIDA daqui chama o `warm()` depois das migrations e antes de ouvir a
// porta; a falha SÓ AVISA e o serviço sobe (NFSE-API#3, Valdo 2026-11-25 — o preparo olha as pastas dos três tipos e uma série ilegível da
// NF-e não tira a NFS-e do ar; na nfe-api a partida cai). A captura mora em `src/storage-warm.ts` (testada EXECUTANDO a falha); a cerca do
// `server.ts` lê a ÁRVORE do TypeScript (molde `deploy-e1-p5.test.ts`) e exige a chamada direta, sem condição.
// O conflito na transmissão e na consulta e o DPS por tentativa (NFSE-API#2) estão em `transmission.test.ts` (describe DEPLOY.E1.P10).
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { FsFiscalStorage, FiscalFileConflictError } from 'fiscal-api'
import { dpsFileName } from '../nfse/transmission'
import { warmFiscalStorageAtBoot } from '../storage-warm'

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const SERVER = path.join(SRC, 'server.ts')
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => { visit(node); node.forEachChild(c => walk(c, visit)) }
const has = (node: ts.Node, test: (n: ts.Node) => boolean) => { let found = false; walk(node, n => { if (test(n)) found = true }); return found }

/** Lê o `main` de um texto de `server.ts` e diz onde está a chamada do preparo. A regra inteira num lugar só (real e mutações). */
function warmCallFacts(source: string) {
  const sf = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const main = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main')!
  const statements = [...main.body!.statements]
  const calls: ts.CallExpression[] = []
  walk(sf, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'warmFiscalStorageAtBoot') calls.push(n) })
  /** Índice da instrução DIRETA de `main` que é EXATAMENTE a chamada (sem `if`, `&&`, `try`, função, atribuição escondendo). */
  const directIndex = calls.length === 1 ? statements.findIndex(s => ts.isExpressionStatement(s) && s.expression === calls[0]) : -1
  const args = calls.length === 1 ? calls[0].arguments.map(a => a.getText(sf)) : []
  const migrationsIndex = statements.findIndex(s => has(s, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'runMigrations'))
  const listenIndex = statements.findIndex(s => has(s, n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'listen'))
  /** Ninguém no `server.ts` chama o `warm` do armazenamento por fora da função (a captura da falha mora nela). */
  const rawWarm = has(sf, n => ts.isPropertyAccessExpression(n) && n.name.text === 'warm')
  const holds = calls.length === 1 && directIndex >= 0 && args.length === 1 && args[0] === 'ctx.storage' && !rawWarm &&
    migrationsIndex >= 0 && listenIndex >= 0 && migrationsIndex < directIndex && directIndex < listenIndex
  return { count: calls.length, directIndex, args, migrationsIndex, listenIndex, rawWarm, holds }
}

describe('DEPLOY.E1.P10 — a partida prepara o índice de gravação única (cerca do `server.ts` pela árvore do TypeScript)', () => {
  const real = fs.readFileSync(SERVER, 'utf8').replace(/\r\n/g, '\n')            // o checkout pode trazer CRLF: a cerca não depende disso
  const CALL = '  warmFiscalStorageAtBoot(ctx.storage)\n'

  it('o `server.ts` chama `warmFiscalStorageAtBoot(ctx.storage)` UMA vez, como instrução direta do `main`, depois do `runMigrations` e antes do `listen`, e não chama o `warm` por fora', () => {
    const f = warmCallFacts(real)
    expect(f.count).toBe(1)
    expect(f.args).toEqual(['ctx.storage'])
    expect(f.rawWarm).toBe(false)
    expect(f.migrationsIndex).toBeGreaterThanOrEqual(0)
    expect(f.directIndex).toBeGreaterThan(f.migrationsIndex)
    expect(f.listenIndex).toBeGreaterThan(f.directIndex)
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
      'chamada em comentário': real.replace(CALL, '  // warmFiscalStorageAtBoot(ctx.storage)\n'),
      'depois do listen': without.slice(0, listenEnd) + CALL + without.slice(listenEnd),
      'antes das migrations': without.replace('  const applied = await runMigrations(', CALL + '  const applied = await runMigrations('),
      'atrás de if (false)': real.replace(CALL, '  if (false) warmFiscalStorageAtBoot(ctx.storage)\n'),
      'atrás de false &&': real.replace(CALL, '  false && warmFiscalStorageAtBoot(ctx.storage)\n'),
      'dentro de função nunca chamada': real.replace(CALL, '  const later = () => warmFiscalStorageAtBoot(ctx.storage)\n'),
      'outro armazenamento': real.replace(CALL, '  warmFiscalStorageAtBoot({})\n'),
      'duas chamadas': real.replace(CALL, CALL + CALL),
      'warm cru ao lado (a falha derrubaria a partida)': real.replace(CALL, CALL + '  ctx.storage.warm?.()\n'),
    }
    for (const [what, source] of Object.entries(mutations)) {
      expect(source).not.toBe(real)
      expect([what, warmCallFacts(source).holds]).toEqual([what, false])
    }
  })

  it('só o `server.ts` chama o preparo em produção (src/ fora de __tests__)', () => {
    const users: string[] = []
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__') visit(path.join(dir, e.name)) }
        else if (e.name.endsWith('.ts') && e.name !== 'storage-warm.ts' && /warmFiscalStorageAtBoot|\.warm\b/.test(fs.readFileSync(path.join(dir, e.name), 'utf8'))) {
          users.push(path.relative(SRC, path.join(dir, e.name)))
        }
      }
    }
    visit(SRC)
    expect(users).toEqual(['server.ts'])
  })
})

describe('DEPLOY.E1.P10 — a falha do preparo só AVISA e nunca sobe (NFSE-API#3) — `warmFiscalStorageAtBoot` executada', () => {
  const log = () => ({ info: jest.fn(), warn: jest.fn() })

  it('preparo que deu certo: devolve a contagem do núcleo e registra a linha do roteiro de implantação', () => {
    const l = log()
    expect(warmFiscalStorageAtBoot({ warm: () => 7 }, l)).toBe(7)
    expect(l.info).toHaveBeenCalledWith('Arquivo fiscal: índice de gravação única preparado (7 série(s))')
    expect(l.warn).not.toHaveBeenCalled()
  })

  it('o `warm` LANÇA (raiz ausente, série ilegível): a função NÃO lança, devolve null e avisa com a mensagem do erro', () => {
    const l = log()
    const boom = () => { throw new Error('warm: 1 série(s) sem índice — X/H/nfe/5: EPERM') }
    expect(() => warmFiscalStorageAtBoot({ warm: boom }, l)).not.toThrow()
    expect(warmFiscalStorageAtBoot({ warm: boom }, l)).toBeNull()
    expect(l.warn).toHaveBeenCalledWith('Arquivo fiscal: índice de gravação única NÃO preparado — o serviço sobe assim mesmo',
      { err: 'warm: 1 série(s) sem índice — X/H/nfe/5: EPERM' })
    expect(l.info).not.toHaveBeenCalled()
  })

  it('com o `FsFiscalStorage` REAL e a raiz ausente (volume desmontado): avisa e não lança; a mensagem longa é cortada', () => {
    const l = log()
    const missing = path.join(os.tmpdir(), `nfse-api-p10-nao-existe-${process.pid}`)
    expect(warmFiscalStorageAtBoot(new FsFiscalStorage(missing), l)).toBeNull()
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('NÃO preparado'), { err: expect.stringContaining('Raiz do arquivo fiscal não existe') })
    const l2 = log()
    warmFiscalStorageAtBoot({ warm: () => { throw new Error('x'.repeat(5000)) } }, l2)
    expect((l2.warn.mock.calls[0][1] as { err: string }).err).toHaveLength(2000)
  })

  it('armazenamento sem `warm` (é opcional na interface do núcleo): nada acontece, nada é registrado', () => {
    const l = log()
    expect(warmFiscalStorageAtBoot({}, l)).toBeNull()
    expect(l.info).not.toHaveBeenCalled()
    expect(l.warn).not.toHaveBeenCalled()
  })
})

describe('DEPLOY.E1.P10 — o que o núcleo 5.2.0 faz no disco (FsFiscalStorage real, pasta temporária)', () => {
  const CNPJ = '12345678000195'
  const key = { cnpj: CNPJ, kind: 'nfse' as const, serie: '1', environment: 'H' as const, zone: 'America/Sao_Paulo' }
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-api-p10-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('mesmo nome com os MESMOS bytes devolve o caminho; com bytes DIFERENTES lança `FiscalFileConflictError` (FISCAL_FILE_CONFLICT) e o arquivo fica como estava', () => {
    const storage = new FsFiscalStorage(root)
    const when = new Date('2026-11-25T12:00:00Z')
    const first = storage.save(key, 'CHAVE-nfse.xml', '<a>1</a>', when)
    expect(storage.save(key, 'CHAVE-nfse.xml', '<a>1</a>', when)).toBe(first)
    let caught: unknown
    try { storage.save(key, 'CHAVE-nfse.xml', '<a>2</a>', when) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(FiscalFileConflictError)
    expect((caught as FiscalFileConflictError).code).toBe('FISCAL_FILE_CONFLICT')
    expect(String((caught as Error).message)).not.toContain('<a>')                           // a mensagem leva o caminho, nunca o conteúdo
    expect(fs.readFileSync(first, 'utf8')).toBe('<a>1</a>')
  })

  it('`warm()` devolve quantas séries viu (NFS-e, NF-e e NFC-e na MESMA raiz) e é idempotente; com a raiz ausente LANÇA — é o erro que a partida daqui captura e avisa', () => {
    const storage = new FsFiscalStorage(root)
    const when = new Date('2026-11-25T12:00:00Z')
    storage.save(key, 'A-nfse.xml', '<a/>', when)
    storage.save({ ...key, serie: '2', environment: 'P' }, 'B-nfse.xml', '<b/>', when)
    storage.save({ ...key, kind: 'nfe', serie: '5' }, 'C-procNFe.xml', '<c/>', when)         // a outra família mora na MESMA raiz
    storage.save({ ...key, kind: 'nfce', serie: '9' }, 'D-procNFe.xml', '<d/>', when)
    expect(storage.warm()).toBe(4)
    expect(storage.warm()).toBe(4)
    expect(() => new FsFiscalStorage(path.join(root, 'nao-existe')).warm()).toThrow(/Raiz do arquivo fiscal não existe/)
  })

  it('NFSE-API#2: o nome do arquivo do DPS leva a tentativa e cabe na regra de nome do núcleo (o `save` aceita)', () => {
    const id = 'DPS410690221234567800019500001000000000000042'
    expect(dpsFileName(id, 1)).toBe(`${id}-t1-dps.xml`)
    expect(dpsFileName(id, 2)).not.toBe(dpsFileName(id, 1))
    const storage = new FsFiscalStorage(root)
    const when = new Date('2026-11-25T12:00:00Z')
    const one = storage.save(key, dpsFileName(id, 1), '<dps>1</dps>', when)
    const two = storage.save(key, dpsFileName(id, 2), '<dps>2</dps>', when)                  // mesmo Id, outro conteúdo: NÃO é conflito
    expect(fs.readFileSync(one, 'utf8')).toBe('<dps>1</dps>')
    expect(fs.readFileSync(two, 'utf8')).toBe('<dps>2</dps>')
  })
})
