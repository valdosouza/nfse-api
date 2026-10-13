/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 5 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F154, §22.18). Alvo: nfse-api `5107863..4a1a9a4` — o `mapTx` recusa C/K sem registro.
// Pergunta do atacante: algum fluxo LEGÍTIMO da família grava C/K numa tentativa SEM a chave (K da reserva do cancelamento, N depois do K,
// C pela consulta, a cópia da origem)? E o que uma linha torta derruba além da própria nota?
// Convenção: `it('[RESISTIU] …')` = barrado; `it('[FATO …]')` = comportamento atual que depende de decisão (questão no relatório).
import fs from 'fs'
import path from 'path'
import { mapTx, listRefreshCandidates } from '../nfse/repository'

const KEY = '41069022123456780001990000000000123202610100000123'
const raw = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 7400, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 10, dpsId: 'DPS1',
  accessKey: KEY, authorityRecorded: 'S', nfseNumber: '710', dhProc: '2026-10-10 12:00:05', createdAt: '2026-10-10 12:00:00', ageMinutes: 1,
  lastQueriedAt: null, nfseNotGeneratedAt: null, lastEvent: 2, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P',
  lastDh: null, lastEventAt: null, lastEventAgeMinutes: 1, ...over,
})
const SRC = fs.readFileSync(path.join(__dirname, '..', 'nfse', 'transmission.ts'), 'utf8')
const fnBody = (name: string) => {
  const start = SRC.indexOf(`export async function ${name}(`)
  const next = SRC.indexOf('\nexport async function ', start + 10)
  return SRC.slice(start, next < 0 ? undefined : next)
}

describe('D-F154 nos fluxos LEGÍTIMOS da família (nenhum produz C/K sem registro)', () => {
  it('[RESISTIU] as linhas que os fluxos produzem passam no mapTx: K da reserva (sobre a A com chave), N depois do K, C do nosso pedido (101101), C da consulta (105102)', () => {
    for (const over of [{ lastKind: 'K', lastDh: null }, { lastKind: 'N', lastSource: 'Q' }, { lastKind: 'C', lastCode: '101101' },
      { lastKind: 'C', lastCode: '105102', lastSource: 'Q' }]) {
      expect(mapTx(raw(over)).lastKind).toBe(over.lastKind)
    }
  })

  it('[RESISTIU — analisado] a RESERVA K só nasce sobre a tentativa AUTORIZADA e COM chave (a guarda `!tx.accessKey` vem antes do `reserveCancelRequest`)', () => {
    const body = fnBody('cancelServiceInvoiceAtAuthority')
    const authorized = body.indexOf('!isAuthorized(tx)')
    const keyGuard = body.indexOf('if (!tx.accessKey) throw')
    const reserve = body.indexOf('await reserveCancelRequest(')
    expect([authorized > 0, keyGuard > authorized, reserve > keyGuard]).toEqual([true, true, true])
  })

  it('[RESISTIU — analisado] na CONSULTA a chave pousa (fillAuthorityData) ANTES de qualquer voz — A, N (depois do K) e C — na MESMA transação sob a trava da nota', () => {
    const body = SRC.slice(SRC.indexOf('async function refreshServiceTransmissionInner('), SRC.indexOf('async function archiveCancelEventIfMissing('))
    const fill = body.indexOf('await fillAuthorityData(itx, tx.attempt')
    for (const voice of ["kind: 'A', source, dh: dhA", "kind: 'N', source", 'await recordCancelVoice(itx']) {
      expect([voice, body.indexOf(voice) > fill && fill > 0]).toEqual([voice, true])
    }
  })

  it('[RESISTIU — analisado] a CÓPIA da origem (migrate-from-setes-api) traz a chave da tentativa da origem e nunca a apaga no destino (COALESCE)', () => {
    const mig = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrate-from-setes-api.ts'), 'utf8')
    expect(mig).toMatch(/SELECT tb_institution_id, tb_invoice_id, terminal, attempt, invoice_event, environment, access_key/)
    expect(mig).toMatch(/access_key = COALESCE\(tb_invoice_service_transmission\.access_key, src\.access_key\)/)
  })
})

describe('o RAIO de uma linha incoerente', () => {
  it('[DECIDIDO D-F164 (= Q-F172 (a))] sem o aviso, o leitor segue falhando alto; o RODÍZIO passa o aviso — antes, UMA tentativa K sem registro (justo a classe que o rodízio existe para resolver — K → C ou N) faz `listRefreshCandidates` LANÇAR inteira: a consulta ativa do estabelecimento para para TODAS as notas (a lista é lida fora do try por candidata) até alguém consertar a linha à mão — o D-F136 já fazia isso com A/N; a D-F154 estende a C/K', async () => {
    const rows = [raw({ invoiceId: 7401, lastKind: 'A' }), raw({ invoiceId: 7402, lastKind: 'K', accessKey: null, authorityRecorded: 'N', nfseNumber: null })]
    const q = { query: jest.fn().mockResolvedValue([rows, []]) }
    await expect(listRefreshCandidates(q as any, 'setes_setes', { institutionId: 1, terminal: 0 }, 10, 10, 50)).rejects.toThrow(/D-F154/)
    const seen: { invoiceId: number; attempt: number }[] = []
    const ok = await listRefreshCandidates(q as any, 'setes_setes', { institutionId: 1, terminal: 0 }, 10, 10, 50, {}, row => { seen.push(row) })
    expect([ok.map(t => t.invoiceId), seen]).toEqual([[7401], [{ invoiceId: 7402, attempt: 1 }]])
    expect(fnBody('refreshOpenServiceTransmissions')).toMatch(/INCOERENTE pulada[\s\S]*touchQueriedAt/)
  })
})
