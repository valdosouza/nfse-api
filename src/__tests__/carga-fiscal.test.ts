// DEPLOY.E3.P1 (D-F23, D-F40, D-F255, D-F257) — as peças PURAS do teste de carga (`scripts/carga/`). A corrida em si (instância 3307,
// fisco falso, duas instâncias) é a prova `suíte` do passo e roda pelo `npm run carga:fiscal`, fora do jest.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isValidCnpj } from 'fiscal-api'
import { percentil, resumo } from '../../scripts/carga/estatistica'
import { sortearFatia, agenda, MISTURA_PADRAO, Fatia } from '../../scripts/carga/mistura'
import { acharDuplicados, LinhaTentativa } from '../../scripts/carga/duplicados'
import { reescreverSchema, comandosDoDump } from '../../scripts/carga/reescrita-schema'
import { cnpjSintetico } from '../../scripts/carga/cnpj-sintetico'
import {
  assertPortaCarga, assertPastaCarga, assertStorageNaPasta, assertSchemaCarga, portaDoEnvArquivo, MARCADOR,
} from '../../scripts/carga/cercas'
import { chamadaDe, temposPorChamada, avaliarTeto, opcoesLeituras } from '../../scripts/carga/leituras-teto'

describe('carga — percentis (posto mais próximo)', () => {
  const um_a_cem = Array.from({ length: 100 }, (_, i) => i + 1)
  it('p95 de [1..100] = 95, p50 = 50, p99 = 99; a lista recebida não muda', () => {
    const embaralhada = [...um_a_cem].reverse()
    expect(percentil(embaralhada, 95)).toBe(95)
    expect(percentil(embaralhada, 50)).toBe(50)
    expect(resumo(embaralhada)).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 })
    expect(embaralhada[0]).toBe(100)
  })
  it('lista vazia = NaN; p fora de (0, 100] recusa', () => {
    expect(percentil([], 95)).toBeNaN()
    expect(() => percentil([1], 0)).toThrow()
    expect(() => percentil([1], 101)).toThrow()
  })
})

describe('carga — mistura e laço aberto', () => {
  it('10 mil sorteios ficam a ±2 pontos de cada peso', () => {
    let seed = 42
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const n = 10_000
    const cont = new Map<Fatia, number>()
    for (let i = 0; i < n; i++) { const f = sortearFatia(rnd()); cont.set(f, (cont.get(f) ?? 0) + 1) }
    for (const [f, w] of Object.entries(MISTURA_PADRAO) as [Fatia, number][]) {
      expect(Math.abs(((cont.get(f) ?? 0) / n) * 100 - w)).toBeLessThanOrEqual(2)
    }
  })
  it('sorteio nas bordas e fora de [0, 1)', () => {
    expect(sortearFatia(0)).toBe('pendentes')
    expect(sortearFatia(0.999999)).toBe('xml-danfse')
    expect(() => sortearFatia(1)).toThrow()
  })
  it('5 rps em 2 s = 10 instantes a cada 200 ms, fixos (nunca esperam a resposta)', () => {
    expect(agenda(5, 2000)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800])
    expect(agenda(5, 30 * 60_000)).toHaveLength(9000)
    expect(() => agenda(0, 1000)).toThrow()
  })
})

describe('carga — detector de documento duplicado (§12.8 item 9)', () => {
  const t = (over: Partial<LinhaTentativa>): LinhaTentativa =>
    ({ institutionId: 2, invoiceId: 10, terminal: 0, lifeEvent: 1, attempt: 1, accessKey: null, lastKind: null, ...over })
  const dps = [{ institutionId: 2, invoiceId: 10, terminal: 0, lifeEvent: 1, dpsId: 'DPS-A' }]
  it('caso limpo: uma chave e uma voz A por vida, DPS conhecido', () => {
    expect(acharDuplicados([t({ accessKey: 'K1', lastKind: 'A' }), t({ attempt: 2, lastKind: 'R' })], dps,
      [{ institutionId: 2, dpsId: 'DPS-A', accessKey: 'K1' }])).toEqual([])
  })
  it('acha a vida com duas chaves e com duas vozes A', () => {
    const achados = acharDuplicados([t({ accessKey: 'K1', lastKind: 'A' }), t({ attempt: 2, accessKey: 'K2', lastKind: 'A' })], dps, [])
    expect(achados).toEqual(['banco: vida 2/10/0/1 com 2 chaves de acesso', 'banco: vida 2/10/0/1 com 2 tentativas de voz A'])
  })
  it('acha o DPS autorizado fora do banco, o DPS com duas chaves e a vida com dois DPS', () => {
    const dps2 = [...dps, { institutionId: 2, invoiceId: 10, terminal: 0, lifeEvent: 1, dpsId: 'DPS-B' }]
    const achados = acharDuplicados([], dps2, [
      { institutionId: 2, dpsId: 'DPS-X', accessKey: 'K9' },
      { institutionId: 2, dpsId: 'DPS-A', accessKey: 'K1' },
      { institutionId: 2, dpsId: 'DPS-A', accessKey: 'K2' },
      { institutionId: 2, dpsId: 'DPS-B', accessKey: 'K3' },
    ])
    expect(achados).toEqual([
      'fisco: DPS DPS-X (instituição 2) autorizado e ausente do banco',
      'fisco: DPS 2/DPS-A autorizado com 2 chaves',
      'fisco: vida 2/10/0/1 com 2 DPS autorizados',
    ])
  })
})

describe('carga — reescrita do schema-molde (D-F255)', () => {
  const view = 'CREATE ALGORITHM=UNDEFINED DEFINER=`setes`@`localhost` SQL SECURITY DEFINER VIEW `vw_invoice_life` AS select `e`.`event` AS `event` from `setes_setes`.`tb_invoice_event` `e` where `e`.`kind` = \'setes_setes\''
  it('troca o nome entre crases e o DEFINER; texto fora de crase não muda', () => {
    expect(reescreverSchema(view, 'setes_setes', 'setes_carga_0001')).toBe(
      'CREATE ALGORITHM=UNDEFINED DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW `vw_invoice_life` AS select `e`.`event` AS `event` from `setes_carga_0001`.`tb_invoice_event` `e` where `e`.`kind` = \'setes_setes\'')
  })
  it('recusa nome que não é setes_*', () => {
    expect(() => reescreverSchema(view, 'setes_setes', 'fiscal_api')).toThrow()
  })
  it('separa os comandos CREATE do dump e ignora comentários, SET e USE', () => {
    const dump = '-- MySQL dump\n/*!40101 SET NAMES utf8mb4 */;\nUSE `setes_setes`;\nDROP TABLE IF EXISTS `tb_x`;\nCREATE TABLE `tb_x` (\n  `id` int\n);\n/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50013 DEFINER=`setes`@`localhost` SQL SECURITY DEFINER */\n/*!50001 VIEW `vw_y` AS select 1 AS `a` */;\n'
    const cmds = comandosDoDump(dump)
    expect(cmds[0]).toBe('DROP TABLE IF EXISTS `tb_x`')
    expect(cmds[1]).toMatch(/^CREATE TABLE `tb_x`/)
    expect(cmds[2]).toMatch(/^CREATE ALGORITHM=UNDEFINED\s+DEFINER=`setes`@`localhost` SQL SECURITY DEFINER\s+VIEW `vw_y`/)
    expect(cmds).toHaveLength(3)
  })
})

describe('carga — CNPJ sintético', () => {
  it('é válido, distinto por série, e recusa série fora da faixa', () => {
    const a = cnpjSintetico(1), b = cnpjSintetico(2)
    expect(isValidCnpj(a)).toBe(true)
    expect(isValidCnpj(cnpjSintetico(1000))).toBe(true)
    expect(a).not.toBe(b)
    expect(a).toHaveLength(14)
    expect(() => cnpjSintetico(-1)).toThrow()
    expect(() => cnpjSintetico(1.5)).toThrow()
  })
})

describe('carga — cercas (D-F255, D-F257)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cercas-teste-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  it('recusa a porta 3306 e a porta do .env; aceita a 3307', () => {
    expect(() => assertPortaCarga(3306, null)).toThrow(/3306/)
    expect(() => assertPortaCarga(3310, 3310)).toThrow(/\.env/)
    expect(() => assertPortaCarga(3307, 3306)).not.toThrow()
  })
  it('lê a porta do .env sem carregar no ambiente', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'DB_PORT=3399\nNADA_CARGA_TESTE=1\n')
    expect(portaDoEnvArquivo(tmp)).toBe(3399)
    expect(process.env.NADA_CARGA_TESTE).toBeUndefined()
  })
  it('pasta só em tmp/nfse-carga-*, e o marcador quando exigido', () => {
    const boa = path.join(tmp, 'nfse-carga-x1')
    fs.mkdirSync(boa)
    expect(() => assertPastaCarga(boa, false, tmp)).not.toThrow()
    expect(() => assertPastaCarga(boa, true, tmp)).toThrow(/marcador|\.nfse-carga/)
    fs.writeFileSync(path.join(boa, MARCADOR), '')
    expect(() => assertPastaCarga(boa, true, tmp)).not.toThrow()
    expect(() => assertPastaCarga(path.join(tmp, 'outra'), false, tmp)).toThrow()
    expect(() => assertPastaCarga(path.join(tmp, 'nfse-carga-x1', 'sub'), false, tmp)).toThrow()
    expect(() => assertPastaCarga('C:\\Windows\\nfse-carga-x', false, tmp)).toThrow()
  })
  it('STORAGE_PATH só dentro da pasta; escrita só em setes_carga_*', () => {
    expect(() => assertStorageNaPasta(path.join(tmp, 'nfse-carga-x1', 'xml'), path.join(tmp, 'nfse-carga-x1'))).not.toThrow()
    expect(() => assertStorageNaPasta('D:\\fiscal-storage', path.join(tmp, 'nfse-carga-x1'))).toThrow()
    expect(() => assertSchemaCarga('setes_carga_0001')).not.toThrow()
    expect(() => assertSchemaCarga('setes_setes')).toThrow()
    expect(() => assertSchemaCarga('setes_central')).toThrow()
  })
})

describe('carga — teto das leituras por CHAMADA (D-F40)', () => {
  it('"pendentes" + "pendentes (2)" da mesma iteração somam numa chamada', () => {
    expect(chamadaDe('pendentes (2)')).toBe('pendentes')
    const porChamada = temposPorChamada([
      { 'pendentes': 100, 'pendentes (2)': 150, 'rodízio': 10 },
      { 'pendentes': 120, 'pendentes (2)': 130, 'rodízio': 20 },
    ])
    expect(porChamada.get('pendentes')).toEqual([250, 250])
    expect(porChamada.get('rodízio')).toEqual([10, 20])
  })
  it('p95 ≥ teto falha só nas chamadas com teto; "vivas do emissor" acima do teto é só registrada; sem teto nada falha', () => {
    const porChamada = temposPorChamada([{ 'pendentes': 200, 'pendentes (2)': 150, 'rodízio': 10, 'vivas do emissor': 900 }])
    const v = avaliarTeto(porChamada, 300)
    expect(v.find(x => x.chamada === 'pendentes')).toMatchObject({ p95: 350, falha: true })
    expect(v.find(x => x.chamada === 'rodízio')).toMatchObject({ falha: false })
    expect(v.find(x => x.chamada === 'vivas do emissor')).toMatchObject({ comTeto: false, falha: false })
    expect(avaliarTeto(porChamada, null).some(x => x.falha)).toBe(false)
  })
  it('explain:leituras — os posicionais de antes seguem valendo; opções nomeadas; opção desconhecida ou valor inválido falham', () => {
    expect(opcoesLeituras([])).toEqual({ inst: 1, schema: 'setes_setes', runs: 7, tetoMs: null })
    expect(opcoesLeituras(['5', 'setes_x'])).toEqual({ inst: 5, schema: 'setes_x', runs: 7, tetoMs: null })
    expect(opcoesLeituras(['--inst', '1002', '--schema', 'setes_carga_volume', '--runs', '50', '--teto-ms', '300']))
      .toEqual({ inst: 1002, schema: 'setes_carga_volume', runs: 50, tetoMs: 300 })
    expect(() => opcoesLeituras(['--teto', '300'])).toThrow(/desconhecida/)
    expect(() => opcoesLeituras(['--runs'])).toThrow(/sem valor/)
    expect(() => opcoesLeituras(['--schema', 'fiscal_api'])).toThrow()
    expect(() => opcoesLeituras(['--runs', '0'])).toThrow()
  })
})
