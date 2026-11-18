/// <reference types="jest" />
// DEPLOY.E1.P3.T2 (D-F241, 2026-11-18 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e1-p3-adocao-pacote-2-0-0.md` no Vault): o script leva
// os XMLs do layout antigo (`<cnpj>/[H/]<ano>/<mês>/`) para o do pacote 2.0.0 (`<cnpj>/[H/]nfse/<série>/<ano>/<mês>/<dia>/`), achando no
// banco a série da DPS e o dia; rodar de novo não muda nada; o DANFSe de uma nota migrada sai igual.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as fiscal from 'fiscal-api'
import { FsFiscalStorage } from 'fiscal-api'
import { migrateXmlLayout, scanOldLayout, XmlFacts, XmlFactsResolver } from '../nfse/xml-layout-migration'
import { renderDanfse, extractDanfseFields } from '../nfse/danfse'
import { xmlLayoutArgumentErrors, sqlResolver } from '../../scripts/migrate-xml-layout'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return { __esModule: true, ...actual, erp: { ...actual.erp, establishmentCnpj: jest.fn(), establishmentCnpjFact: jest.fn(), institutionZone: jest.fn() } }
})
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>

const CNPJ = '12345678000195'
const ZONE = 'America/Sao_Paulo'
const key = (n: number) => `410690221234567800019500000000000${String(n).padStart(3, '0')}26091234567890`.slice(0, 50)
const K = { a: key(1), b: key(2), orphan: key(3), conflict: key(4), outOfMonth: key(5), midnight: key(6) }
const DPS = 'DPS410690221234567800019500001000000000000042'
const NFSE = (k: string) => `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${k}">
<xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><cStat>100</cStat><dhProc>2026-09-15T10:00:00-03:00</dhProc>
<emit><CNPJ>${CNPJ}</CNPJ><IM>777</IM><xNome>SETES SISTEMAS LTDA — ação</xNome></emit>
<valores><vLiq>1230.00</vLiq><vISSQN>24.69</vISSQN><pAliqAplic>2.00</pAliqAplic></valores>
<DPS><infDPS Id="${DPS}"><tpAmb>2</tpAmb><serie>1</serie><nDPS>42</nDPS><dCompet>2026-09-15</dCompet>
<prest><CNPJ>${CNPJ}</CNPJ><IM>777</IM></prest>
<toma><CNPJ>98765432000198</CNPJ><xNome>Cliente &amp; Filhos</xNome><end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro></end></toma>
<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>Licença mensal ERP</xDescServ></cServ></serv>
<valores><vServPrest><vServ>1234.50</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>
`

/** Os fatos que o banco daria (série da DPS com zeros, como no banco; instantes UTC do banco). */
const FACTS: Record<string, XmlFacts> = {
  [K.a]: { serie: '00001', instants: ['2026-09-15 13:00:00', '2026-09-15 12:59:00'], zone: ZONE },
  [K.b]: { serie: '00001', instants: ['2026-11-10 15:00:00'], zone: ZONE },
  [K.conflict]: { serie: '00001', instants: ['2026-09-20 15:00:00'], zone: ZONE },
  [K.outOfMonth]: { serie: '00001', instants: ['2026-10-02 15:00:00'], zone: ZONE },
  [K.midnight]: { serie: '00001', instants: ['2026-10-01 02:00:00'], zone: ZONE },   // 30/09 23:00 na zona: pasta de setembro, dia 30
  [DPS]: { serie: '00001', instants: ['2026-09-15 12:58:00'], zone: ZONE },
}
const resolver: XmlFactsResolver = {
  byAccessKey: async (cnpj, k) => (cnpj === CNPJ ? FACTS[k] ?? null : null),
  byDpsId: async (cnpj, id) => (cnpj === CNPJ ? FACTS[id] ?? null : null),
}

let root: string
const put = (rel: string, body: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }
/** A árvore inteira: caminho relativo + sha256 de cada arquivo. */
const tree = () => (fs.readdirSync(root, { recursive: true } as any) as string[]).map(String).sort()
  .map(rel => [rel.replace(/\\/g, '/'), fs.statSync(path.join(root, rel)).isFile() ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex') : 'dir'])
const NEW = (env: 'H' | 'P', day: string, name: string) =>
  path.join(root, CNPJ, ...(env === 'H' ? ['H'] : []), 'nfse', '1', ...day.split('-'), name)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-xml-layout-'))
  put(`${CNPJ}/2026/09/${K.a}-nfse.xml`, NFSE(K.a))
  put(`${CNPJ}/2026/09/${K.a}-evt101101.xml`, '<evento>101101</evento>')
  put(`${CNPJ}/2026/09/${DPS}-dps.xml`, '<DPS/>')
  put(`${CNPJ}/H/2026/11/${K.b}-nfse.xml`, NFSE(K.b))
  put(`${CNPJ}/2026/09/${K.orphan}-nfse.xml`, NFSE(K.orphan))
  put(`${CNPJ}/2026/09/${K.conflict}-nfse.xml`, NFSE(K.conflict))
  put(`${CNPJ}/nfse/1/2026/09/20/${K.conflict}-nfse.xml`, '<outro/>')
  put(`${CNPJ}/2026/09/${K.outOfMonth}-nfse.xml`, NFSE(K.outOfMonth))
  put(`${CNPJ}/2026/09/${K.midnight}-nfse.xml`, NFSE(K.midnight))
  put(`${CNPJ}/2026/09/leia-me.xml`, '<x/>')
  put('logos/1.png', 'png')                                    // a raiz do dev é a do setes-api: logomarcas nunca entram
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const run = (apply: boolean) => migrateXmlLayout({ root, storage: new FsFiscalStorage(root), resolver, apply })

describe('DEPLOY.E1.P3.T2 — migração dos XMLs para o layout D-F241', () => {
  it('a varredura só pega o layout antigo (CNPJ, [H/], ano, mês) — nem o layout novo nem outras pastas', () => {
    const { files, unknown } = scanOldLayout(root)
    expect(files.map(f => [f.environment, f.year, f.month, f.kind, f.ref]).sort()).toEqual([
      ['H', '2026', '11', 'nfse', K.b],
      ['P', '2026', '09', 'dps', DPS],
      ['P', '2026', '09', 'event', K.a],
      ['P', '2026', '09', 'nfse', K.a], ['P', '2026', '09', 'nfse', K.conflict], ['P', '2026', '09', 'nfse', K.midnight],
      ['P', '2026', '09', 'nfse', K.orphan], ['P', '2026', '09', 'nfse', K.outOfMonth],
    ].sort())
    expect(unknown.map(u => path.basename(u))).toEqual(['leia-me.xml'])
  })

  it('ENSAIO não grava nem apaga nada e diz o plano', async () => {
    const before = tree()
    const r = await run(false)
    expect(tree()).toEqual(before)
    expect(r.moved.map(m => [path.basename(m.from), m.serie, m.day, m.to]).sort()).toEqual([
      [`${DPS}-dps.xml`, '00001', '2026-09-15', null],
      [`${K.a}-evt101101.xml`, '00001', '2026-09-15', null],
      [`${K.a}-nfse.xml`, '00001', '2026-09-15', null],
      [`${K.b}-nfse.xml`, '00001', '2026-11-10', null],
      [`${K.midnight}-nfse.xml`, '00001', '2026-09-30', null],
    ].sort())
  })

  it('APLICA: cada arquivo no caminho novo com os MESMOS bytes; o que não tem fato, conflita ou cai fora do mês FICA; a 2ª corrida não muda nada', async () => {
    const bytes = (rel: string) => fs.readFileSync(path.join(root, rel))
    const old = { a: bytes(`${CNPJ}/2026/09/${K.a}-nfse.xml`), b: bytes(`${CNPJ}/H/2026/11/${K.b}-nfse.xml`) }
    const r = await run(true)
    expect(r.moved.map(m => m.to).sort()).toEqual([
      NEW('P', '2026-09-15', `${DPS}-dps.xml`), NEW('P', '2026-09-15', `${K.a}-evt101101.xml`), NEW('P', '2026-09-15', `${K.a}-nfse.xml`),
      NEW('H', '2026-11-10', `${K.b}-nfse.xml`), NEW('P', '2026-09-30', `${K.midnight}-nfse.xml`),
    ].sort())
    expect(fs.readFileSync(NEW('P', '2026-09-15', `${K.a}-nfse.xml`))).toEqual(old.a)
    expect(fs.readFileSync(NEW('H', '2026-11-10', `${K.b}-nfse.xml`))).toEqual(old.b)
    expect(r.kept.map(k => [path.basename(k.from), k.reason.split(':')[0].split(' ')[0]]).sort()).toEqual([
      ['leia-me.xml', 'fora'], [`${K.conflict}-nfse.xml`, 'conflito'], [`${K.orphan}-nfse.xml`, 'sem'], [`${K.outOfMonth}-nfse.xml`, 'nenhum'],
    ].sort())
    expect(fs.readFileSync(path.join(root, CNPJ, 'nfse', '1', '2026', '09', '20', `${K.conflict}-nfse.xml`), 'utf8')).toBe('<outro/>')   // nunca sobrescreve
    expect(fs.existsSync(path.join(root, CNPJ, 'H', '2026'))).toBe(false)                 // pasta antiga vazia sai
    expect(fs.existsSync(path.join(root, 'logos', '1.png'))).toBe(true)

    const after = tree()
    const again = await run(true)
    expect([again.moved, again.alreadyThere]).toEqual([[], []])
    expect(again.kept.map(k => path.basename(k.from)).sort()).toEqual(r.kept.map(k => path.basename(k.from)).sort())
    expect(tree()).toEqual(after)
  })

  it('o destino já existe com o MESMO conteúdo (a consulta regravou): só o antigo sai', async () => {
    const same = put(`${CNPJ}/nfse/1/2026/09/15/${K.a}-nfse.xml`, NFSE(K.a))
    const r = await run(true)
    expect(r.alreadyThere).toEqual([{ from: path.join(root, CNPJ, '2026', '09', `${K.a}-nfse.xml`), to: same }])
    expect(fs.existsSync(path.join(root, CNPJ, '2026', '09', `${K.a}-nfse.xml`))).toBe(false)
  })

  it('o DANFSe da nota migrada sai IGUAL byte a byte (relógio fixo — o PDFKit carimba a data de geração) e com os mesmos campos', async () => {
    const opts = { issuerName: 'SETES SISTEMAS LTDA', municipality: 'Curitiba' }
    const oldXml = fs.readFileSync(path.join(root, CNPJ, '2026', '09', `${K.a}-nfse.xml`), 'utf8')   // caminho antigo, montado à mão
    await run(true)
    const found = new FsFiscalStorage(root).find({ cnpj: CNPJ, kind: 'nfse', serie: null, environment: 'P', zone: ZONE }, `${K.a}-nfse.xml`, ['2026-09-15 13:00:00'])
    expect(found).toBe(NEW('P', '2026-09-15', `${K.a}-nfse.xml`))
    const newXml = new FsFiscalStorage(root).read(found!)
    expect(newXml).toBe(oldXml)
    expect(extractDanfseFields(newXml)).toEqual(extractDanfseFields(oldXml))
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    try {
      jest.setSystemTime(new Date('2026-11-18T12:00:00Z'))
      const before = await renderDanfse(oldXml, opts)
      const after = await renderDanfse(newXml, opts)
      expect(before.subarray(0, 5).toString()).toBe('%PDF-')
      expect(after.equals(before)).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('DEPLOY.E1.P3.T2 — gates do passo (socrático e adversarial, 2026-11-18)', () => {
  it('[ADV M2] nada fica para trás CALADO: mês sem zero, .XML, arquivo fora do mês, outro arquivo e atalho aparecem como "fica"', async () => {
    const odd = [`${CNPJ}/2026/9/${K.a}-nfse.xml`, `${CNPJ}/2026/09/${K.b}-NFSE.XML`, `${CNPJ}/2026/solto.xml`, `${CNPJ}/H/2026/11/nota.txt`, `${CNPJ}/H/fora.xml`]
    for (const rel of odd) put(rel, '<x/>')
    const r = await run(true)
    const kept = r.kept.map(k => path.relative(root, k.from).replace(/\\/g, '/'))
    for (const rel of odd) expect(kept).toContain(rel)
    for (const rel of odd) expect(fs.existsSync(path.join(root, rel))).toBe(true)
    expect(scanOldLayout(root).unknown.map(u => path.relative(root, u).replace(/\\/g, '/'))).toEqual(expect.arrayContaining(odd))
  })

  it('[ADV L1] o mesmo nome em P e em H: cada um vai para o SEU ambiente (o `find` de H também olha P — não conta como "já no destino")', async () => {
    put(`${CNPJ}/H/2026/09/${DPS}-dps.xml`, '<DPS ambiente="H"/>')
    const r = await run(true)
    expect(r.kept.filter(k => path.basename(k.from) === `${DPS}-dps.xml`)).toEqual([])
    expect(fs.readFileSync(NEW('P', '2026-09-15', `${DPS}-dps.xml`), 'utf8')).toBe('<DPS/>')
    expect(fs.readFileSync(NEW('H', '2026-09-15', `${DPS}-dps.xml`), 'utf8')).toBe('<DPS ambiente="H"/>')
  })

  it('[SOC L2] evento e DPS de HOMOLOGAÇÃO também migram para H/nfse; arquivo que não é UTF-8 FICA (os bytes mudariam)', async () => {
    put(`${CNPJ}/H/2026/11/${K.b}-evt101101.xml`, '<evento>H</evento>')
    const bad = put(`${CNPJ}/2026/09/${K.a}-nfse.xml`, '')
    fs.writeFileSync(bad, Buffer.from([0x3c, 0x78, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x78, 0x3e]))
    const r = await run(true)
    expect(fs.readFileSync(NEW('H', '2026-11-10', `${K.b}-evt101101.xml`), 'utf8')).toBe('<evento>H</evento>')
    expect(r.kept.find(k => k.from === bad)?.reason).toMatch(/não é UTF-8/)
    expect(fs.readFileSync(bad)).toEqual(Buffer.from([0x3c, 0x78, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x78, 0x3e]))
  })

  it('[ADV L2] erro num arquivo (banco caiu para ele) não aborta a corrida: ele fica com o motivo, os outros migram', async () => {
    const flaky: XmlFactsResolver = { ...resolver, byAccessKey: async (c, k) => { if (k === K.b) throw new Error('conexão perdida'); return resolver.byAccessKey(c, k) } }
    const r = await migrateXmlLayout({ root, storage: new FsFiscalStorage(root), resolver: flaky, apply: true })
    expect(r.kept.find(k => path.basename(k.from) === `${K.b}-nfse.xml`)?.reason).toBe('banco: conexão perdida')
    expect(fs.existsSync(NEW('P', '2026-09-15', `${K.a}-nfse.xml`))).toBe(true)
  })
})

describe('DEPLOY.E1.P3.T2 — o script: argumentos e o resolvedor do banco', () => {
  it('só `--vai` existe; desconhecido, repetido ou engolido pelo npm FALHA antes do banco', () => {
    expect(xmlLayoutArgumentErrors([], {})).toEqual([])
    expect(xmlLayoutArgumentErrors(['--vai'], {})).toEqual([])
    expect(xmlLayoutArgumentErrors(['--dry-run'], {})).toEqual(['argumento desconhecido: "--dry-run"'])
    expect(xmlLayoutArgumentErrors(['--vai', '--vai'], {})).toEqual(['argumento repetido: "--vai"'])
    expect(xmlLayoutArgumentErrors([], { npm_config_vai: 'true' })[0]).toMatch(/engoliu --vai/)
  })

  const rows = (over: any[]) => over.map(o => ({ institutionId: 1, schemaName: 'setes_setes', serie: '00001', dh: '2026-09-15 13:00:00', cr: '2026-09-15 12:59:00', ...o }))
  const q = (result: any[]) => ({ query: jest.fn(async () => [result, []] as [any, any]) })
  beforeEach(() => {
    erpM.establishmentCnpj.mockImplementation(async (_q: any, id: number) => (id === 1 ? CNPJ : '98765432000198'))
    erpM.institutionZone.mockResolvedValue(ZONE)
  })

  it('pela chave: filtra o estabelecimento cujo emitente é o CNPJ da pasta; série, instantes e zona dele', async () => {
    const db = q(rows([{}, { institutionId: 2, serie: '00009' }]))
    expect(await sqlResolver(db).byAccessKey(CNPJ, K.a)).toEqual({ serie: '00001', instants: ['2026-09-15 13:00:00', '2026-09-15 12:59:00'], zone: ZONE })
    const [sql, params] = (db.query.mock.calls as any[])[0]
    expect(sql).toMatch(/WHERE t\.access_key = \?/)
    expect(sql).toMatch(/JOIN tb_invoice_service_dps d/)
    expect(sql).toMatch(/JOIN setes_central\.tb_institution i ON i\.id = t\.tb_institution_id/)
    expect(params).toEqual([K.a])
    expect(erpM.institutionZone).toHaveBeenCalledWith(db, 'setes_setes', 1)
  })

  it('pelo Id do DPS: o instante é o `created_at` de cada tentativa (nunca o dh_proc)', async () => {
    const db = q(rows([{ cr: '2026-09-15 12:58:00' }, { cr: '2026-10-02 09:00:00', dh: '2026-10-02 09:01:00' }]))
    expect(await sqlResolver(db).byDpsId(CNPJ, DPS)).toEqual({ serie: '00001', instants: ['2026-09-15 12:58:00', '2026-10-02 09:00:00'], zone: ZONE })
    expect((db.query.mock.calls as any[])[0][0]).toMatch(/WHERE d\.dps_id = \?/)
  })

  it('nenhum, ou mais de um, estabelecimento com o CNPJ da pasta; ou séries diferentes → null (o arquivo fica)', async () => {
    expect(await sqlResolver(q([])).byAccessKey(CNPJ, K.a)).toBeNull()
    expect(await sqlResolver(q(rows([{ institutionId: 2 }]))).byAccessKey(CNPJ, K.a)).toBeNull()
    erpM.establishmentCnpj.mockResolvedValue(CNPJ)
    expect(await sqlResolver(q(rows([{}, { institutionId: 3 }]))).byAccessKey(CNPJ, K.a)).toBeNull()
    expect(await sqlResolver(q(rows([{}, { serie: '00002' }]))).byAccessKey(CNPJ, K.a)).toBeNull()
  })
})
