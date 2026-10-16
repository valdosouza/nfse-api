/// <reference types="jest" />
// Frente do CNPJ alfanumérico — ONDA 1 na nfse-api (D-CJ7/D-CJ15, Valdo 2026-10-16): o ESCRITOR segue o LEIAUTE vigente do ambiente. O
// calendário identifica o PACOTE XSD publicado (produção restrita × produção têm a MESMA 1.01 com gramáticas diferentes) e o fato "aceita
// CNPJ com letra" vem do XSD arquivado. A recusa legível antes da reserva está em `transmission.test.ts` ("D-CJ7 — …"); aqui, os FATOS e os
// CINTOS do montador (o que chega até ele fora do leiaute LANÇA — nunca vai ao fisco nem mutilado).
import { LAYOUT_CALENDAR, LAYOUT_SCHEMAS, cnpjAlphanumericAccepted, layoutAt, layoutLineAt } from '../authority/layout-calendar'
import { buildCancelEventXml, buildDpsId, buildDpsXml } from '../authority/dps-builder'
import type { DpsInput } from '../authority/types'

const ALFA = 'PC3D315K000193'
const NUM = '12345678000195'
const NOW = new Date('2026-10-16T12:00:00Z')

describe('D-CJ7 — o calendário por LEIAUTE (pacote XSD), não só por versão', () => {
  it('produção restrita aceita CNPJ com letra desde a implantação (10/08/2026); produção ainda não', () => {
    for (const doc of ['DPS', 'EVENT'] as const) {
      expect(cnpjAlphanumericAccepted(doc, 'H', NOW)).toBe(true)
      expect(cnpjAlphanumericAccepted(doc, 'P', NOW)).toBe(false)
      expect(cnpjAlphanumericAccepted(doc, 'H', new Date('2026-08-10T02:59:59Z'))).toBe(false)
      expect(layoutAt(doc, 'H', NOW)).toBe('1.01')                     // mesma versão, pacotes diferentes
      expect(layoutLineAt(doc, 'H', NOW).schema).not.toBe(layoutLineAt(doc, 'P', NOW).schema)
    }
  })
  it('toda linha aponta para um pacote com FATOS registrados e a fonte arquivada; o calendário e os fatos são congelados', () => {
    for (const l of LAYOUT_CALENDAR) expect([l.schema, LAYOUT_SCHEMAS[l.schema]?.source]).toEqual([l.schema, expect.stringMatching(/^Infra-IA\//)])
    expect(Object.isFrozen(LAYOUT_SCHEMAS)).toBe(true)
    expect(() => { (LAYOUT_SCHEMAS['NFSe-1.01-20260209'] as any).cnpjAlphanumeric = true }).toThrow()
  })
  // gate socrático da onda 1: uma linha NOVA nunca pode ser MENOS permissiva que a anterior do mesmo documento × ambiente — senão a nota
  // autorizada com letra (DPS) não teria mais leiaute para o PEDIDO DE CANCELAMENTO dela (EVENT), e o "aceita letra" voltaria atrás em
  // silêncio. Se o fisco algum dia recuar, é DECISÃO (questão ao Valdo), não uma linha a mais no calendário.
  it('MONOTONIA: por documento × ambiente, aceitar CNPJ com letra nunca volta atrás; e o EVENT aceita sempre que o DPS aceita', () => {
    const groups = new Map<string, typeof LAYOUT_CALENDAR[number][]>()
    for (const l of LAYOUT_CALENDAR) groups.set(`${l.document}/${l.environment}`, [...(groups.get(`${l.document}/${l.environment}`) ?? []), l])
    for (const [key, lines] of groups) {
      const sorted = [...lines].sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))
      for (let i = 1; i < sorted.length; i++) {
        const before = LAYOUT_SCHEMAS[sorted[i - 1].schema].cnpjAlphanumeric
        const after = LAYOUT_SCHEMAS[sorted[i].schema].cnpjAlphanumeric
        expect([key, sorted[i].validFrom, before && !after]).toEqual([key, sorted[i].validFrom, false])
      }
    }
    // em CADA virada do calendário (e um instante depois de todas), quem aceita no DPS aceita no EVENT do mesmo ambiente
    const instants = [...new Set(LAYOUT_CALENDAR.map(l => Date.parse(l.validFrom)))].map(t => new Date(t)).concat(NOW)
    for (const env of ['H', 'P'] as const) {
      for (const t of instants) {
        if (cnpjAlphanumericAccepted('DPS', env, t)) expect([env, t.toISOString(), cnpjAlphanumericAccepted('EVENT', env, t)]).toEqual([env, t.toISOString(), true])
      }
    }
  })
})

const base = (env: 'H' | 'P', prest: string, toma: string): DpsInput => ({
  environment: env, dhEmi: '2026-10-16T09:00:00-03:00', verAplic: 'nfse-api', serie: 1, nDps: 42, dCompet: '2026-10-16', tpEmit: '1',
  cLocEmi: '4106902',
  prest: { cnpj: prest, regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: toma, xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Licença' } },
  valores: { vServ: 100, vDescIncond: 0, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
} as any)

describe('D-CJ7/D-CJ15 — os cintos do montador (forma canônica + leiaute; nunca `digits()` sobre inscrição)', () => {
  it('HOMOLOGAÇÃO: prestador, tomador e Id alfanuméricos vão como são', () => {
    const id = buildDpsId('4106902', '2', ALFA, 1, 42)
    const xml = buildDpsXml(base('H', ALFA, '00000000E08G12'), id)
    expect(xml).toContain(`<prest><CNPJ>${ALFA}</CNPJ>`)
    expect(xml).toContain('<toma><CNPJ>00000000E08G12</CNPJ>')
    expect(xml).toContain(`Id="${id}"`)
  })
  it('PRODUÇÃO: Id, prestador ou tomador com letra LANÇAM (a fonte de fatos já recusou legível antes — isto é o cinto)', () => {
    expect(() => buildDpsXml(base('P', ALFA, NUM), buildDpsId('4106902', '2', ALFA, 1, 42))).toThrow(/não aceita CNPJ com letras/)
    expect(() => buildDpsXml(base('P', ALFA, NUM), buildDpsId('4106902', '2', NUM, 1, 42))).toThrow(/CNPJ do prestador alfanumérico/)
    expect(() => buildDpsXml(base('P', NUM, ALFA), buildDpsId('4106902', '2', NUM, 1, 42))).toThrow(/CNPJ do tomador alfanumérico/)
    expect(buildDpsXml(base('P', NUM, '98765432000198'), buildDpsId('4106902', '2', NUM, 1, 42))).toContain(`<prest><CNPJ>${NUM}</CNPJ>`)
  })
  it('fora da forma canônica (máscara, minúscula) LANÇA em qualquer ambiente — nada é removido no escritor', () => {
    for (const bad of ['12.345.678/0001-95', 'pc3d315k000193']) {
      expect(() => buildDpsXml(base('H', bad, NUM), buildDpsId('4106902', '2', NUM, 1, 42))).toThrow(/fora da forma canônica/)
    }
    expect(() => buildDpsXml({ ...base('H', NUM, NUM), toma: { cpf: '529.982.247-25', xNome: 'X' } } as any, buildDpsId('4106902', '2', NUM, 1, 42)))
      .toThrow(/CPF do tomador fora da forma/)
  })
  it('pedido de cancelamento: CNPJAutor alfanumérico em H vai como é; em P LANÇA (o leiaute do EVENTO é o dele)', () => {
    const key = '4106902' + '2' + '2' + ALFA + '0000000000123' + '2610' + '000000001' + '7'
    const ev = (env: 'H' | 'P') => buildCancelEventXml({ accessKey: key, dhEvento: '2026-10-16T10:00:00-03:00', cMotivo: '2',
      xMotivo: 'Serviço não prestado ao cliente', environment: env, verAplic: 'v', cnpjAutor: ALFA })
    expect(ev('H')).toContain(`<CNPJAutor>${ALFA}</CNPJAutor>`)
    expect(() => ev('P')).toThrow(/CNPJ do autor alfanumérico/)
  })
})
