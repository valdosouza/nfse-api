/// <reference types="jest" />
// GATE ADVERSARIAL da ONDA 0 da frente do CNPJ alfanumérico (skill `testar-adversarial.md`, 2026-10-15) — nfse-api.
// Ataque que RESISTIU = teste verde que fixa a garantia. Achado CONFIRMADO = teste que FALHAVA, marcado `[ACHADO <SEVERIDADE>]` no título;
// o LOW deste arquivo foi CORRIGIDO na mesma sessão de entrega (prompt da frente §8.7). Transporte do fisco MOCKADO (nenhuma chamada externa); ERP falso em memória (nenhum banco).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gzipSync } from 'zlib'
import forge from 'node-forge'
import { transport, AuthorityContext, cnpjCheckDigits, FsFiscalStorage } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { buildDpsId, buildEventId } from '../authority/dps-builder'
import { asNfseAccessKey, findNfseAccessKeyIn, issuerOfAccessKey, sameEmbeddedIssuer } from '../authority/access-key'
import { nfseFileName } from '../nfse/transmission'
import { buildEmitter, buildRecipient } from '../facts/service-facts'
import { saveCertificate } from '../modules/emitter/emitter.service'

const ALFA = '00000000E08G12'                                   // 1º CNPJ alfanumérico (RFB) — válido
const NUM = '12345678000195'
const keyOf = (insc: string, tp = '2', nNfse = '0000000000123') => '4106902' + '2' + tp + insc + nNfse + '2610' + '000000001' + '7'
const dpsIdOf = (insc: string, tp = '2') => 'DPS' + '4106902' + tp + insc + '00001' + '000000000000042'
const KEY_A = keyOf(ALFA)
const KEY_A2 = keyOf(ALFA, '2', '0000000000124')                // OUTRA NFS-e do MESMO emitente
const DPS_A = dpsIdOf(ALFA)

// ---------------------------------------------------------------------------------------------------------------------------------------
// transporte mockado + XML do fisco (molde do cnpj-alfa-onda0.test.ts)
// ---------------------------------------------------------------------------------------------------------------------------------------
const mockHttp = jest.fn()
transport.request = mockHttp as any
const ctx: AuthorityContext = { environment: 'H', cert: Buffer.from('cert-pem'), key: Buffer.from('key-pem') }
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : JSON.stringify(obj) })
const SEFIN = { dataHoraProcessamento: '2026-10-15T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const arquivoXml = (xml: string) => Buffer.from(gz(xml), 'utf8').toString('base64')
const nfseXmlOf = (key: string, dpsId: string) => '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${key}"><xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>`
  + `<dhProc>2026-10-15T13:16:01-03:00</dhProc><nDFSe>555</nDFSe><emit><CNPJ>${key.slice(9, 23)}</CNPJ><xNome>Empresa Nova</xNome></emit>`
  + `<DPS versao="1.01"><infDPS Id="${dpsId}"><tpAmb>2</tpAmb><dhEmi>2026-10-15T10:15:30-03:00</dhEmi><nDPS>42</nDPS></infDPS></DPS></infNFSe>`
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>x</SignatureValue></Signature></NFSe>'
const eventXmlOf = (key: string, chNFSe: string) => '<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infEvento Id="EVT${'0'.repeat(59)}"><verAplic>SNNFSE</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-10-16T09:00:00-03:00</dhProc><nDFSe>556</nDFSe>`
  + `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}101101"><tpAmb>2</tpAmb><verAplic>v</verAplic><dhEvento>2026-10-16T08:59:00-03:00</dhEvento>`
  + `<CNPJAutor>${key.slice(9, 23)}</CNPJAutor><chNFSe>${chNFSe}</chNFSe>`
  + '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emissão da nota fiscal</xMotivo></e101101></infPedReg></pedRegEvento></infEvento></evento>'
const eventsOf = (key: string, file: string) => ok({ ...SEFIN, eventos: [{ chaveAcesso: key, tipoEvento: 101101, numeroPedidoRegistroEvento: 1,
  dataHoraRecebimento: '2026-10-16T08:59:04.82', arquivoXml: file }] })
/** consulta da chave A cujo evento de cancelamento traz o `<chNFSe>` dado. */
async function statusWithChNFSe(chNFSe: string): Promise<string> {
  mockHttp.mockReset()
  mockHttp.mockImplementation(async (call: { url: string }) => {
    if (/\/eventos\/101101\/1$/.test(call.url)) return eventsOf(KEY_A, arquivoXml(eventXmlOf(KEY_A, chNFSe)))
    if (/\/eventos\//.test(call.url)) return { status: 404, headers: {}, text: JSON.stringify(SEFIN) }   // a Sefin: não há esse evento
    return ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_A, DPS_A)) })
  })
  return (await adnAdapter.queryNfse(ctx, KEY_A)).status
}
beforeEach(() => mockHttp.mockReset())

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 3 — leitura tolerante da voz
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('P3 — forma geral da chave: letra SÓ nas posições 10–21 (RESISTIU)', () => {
  const at = (k: string, i: number, c: string) => k.slice(0, i) + c + k.slice(i + 1)
  it.each([
    ['letra no cMun (pos. 1)', at(KEY_A, 0, 'A')], ['letra no ambGer (pos. 8)', at(KEY_A, 7, 'A')], ['letra no tpInsc (pos. 9)', at(KEY_A, 8, 'A')],
    ['letra no 1º DV da inscrição (pos. 22)', at(KEY_A, 21, 'A')], ['letra no 2º DV (pos. 23)', at(KEY_A, 22, 'A')], ['letra no DV da chave (pos. 50)', at(KEY_A, 49, 'A')],
    ['dígito de largura total na inscrição', at(KEY_A, 12, '１')], ['letra Unicode (Á) na inscrição', at(KEY_A, 17, 'Á')],
    ['zero-width space no meio', KEY_A.slice(0, 20) + '​' + KEY_A.slice(20)], ['minúscula', KEY_A.toLowerCase()],
  ])('%s → não é chave', (_l, k) => {
    expect(asNfseAccessKey(k)).toBeNull()
    expect(issuerOfAccessKey(k)).toBeNull()
  })
  it('letra em CADA uma das posições 10–21 é aceita e volta como veio (o emitente embutido é comparado exato)', () => {
    for (let i = 9; i <= 20; i++) {
      const k = at(KEY_A, i, 'Z')
      expect([i, asNfseAccessKey(k)]).toEqual([i, k])
      expect(sameEmbeddedIssuer(issuerOfAccessKey(k), issuerOfAccessKey(KEY_A))).toBe(k === KEY_A)
    }
  })
  it('a busca no texto não "fabrica" chave a partir de pedaços: colada em letra/dígito ASCII não conta; em letra NÃO-ASCII conta (limite documentado)', () => {
    expect(findNfseAccessKeyIn(`a${KEY_A}`)).toBeNull()
    expect(findNfseAccessKeyIn(`${KEY_A}0`)).toBeNull()
    expect(findNfseAccessKeyIn(`é${KEY_A}é`)).toBe(KEY_A)
  })
})

describe('P3 — D-F88 × D-CJ7: o `<chNFSe>` do evento "é desta chave" só com FORMATAÇÃO; nunca confunde duas chaves', () => {
  it('formatado (ponto, barra, hífen, espaço, NBSP) e minúsculo contam como desta chave — semântica fixada (RESISTIU)', async () => {
    for (const ch of [KEY_A.replace(/(.{5})/g, '$1.'), KEY_A.replace(/(.{10})/g, '$1 '), KEY_A.toLowerCase(), `${KEY_A.slice(0, 25)}-/${KEY_A.slice(25)}`]) {
      expect([ch, await statusWithChNFSe(ch)]).toEqual([ch, 'cancelled'])
    }
  })
  it('chave que difere numa LETRA, num homóglifo (Ｅ largura total, Е cirílico), no tpInsc ou com zero-width NÃO é desta chave (RESISTIU)', async () => {
    const i = KEY_A.indexOf('E')
    for (const ch of [KEY_A.slice(0, i) + 'F' + KEY_A.slice(i + 1), KEY_A.slice(0, i) + 'Ｅ' + KEY_A.slice(i + 1), KEY_A.slice(0, i) + 'Е' + KEY_A.slice(i + 1),
      keyOf(ALFA, '1'), KEY_A.slice(0, 30) + '​' + KEY_A.slice(30), KEY_A2]) {
      expect([ch, await statusWithChNFSe(ch)]).not.toEqual([ch, 'cancelled'])
    }
  })
})

describe('P3 — `GET /dps/{id}`: a chave tem de ser a DECLARADA e do MESMO emitente', () => {
  it('chave de outro emitente que difere SÓ numa letra da inscrição → 502 (RESISTIU)', async () => {
    const other = '00000000E08H' + cnpjCheckDigits('00000000E08H')
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: keyOf(other) }))
    await expect(adnAdapter.queryDpsAccessKey(ctx, DPS_A)).rejects.toMatchObject({ statusCode: 502 })
  })
  it('chaveAcesso MINÚSCULA (fora da forma) e nenhuma outra chave no corpo → 502, nunca a chave "consertada" (RESISTIU)', async () => {
    mockHttp.mockResolvedValueOnce(ok({ ...SEFIN, idDps: DPS_A, chaveAcesso: KEY_A.toLowerCase() }))
    await expect(adnAdapter.queryDpsAccessKey(ctx, DPS_A)).rejects.toMatchObject({ statusCode: 502 })
  })
  // Mitigação a jusante (analisado): o refresh confere o Id do DPS embutido na NFS-e da chave devolvida (transmission.ts "R2-2 (c)") e dá
  // 502 — a chave errada só viraria voz A se a NFS-e dela viesse SEM o Id do DPS (anomalia dupla). O adaptador, porém, já aceitou a chave.
  it('[CORRIGIDO na sessão — ACHADO LOW] chaveAcesso PRESENTE mas fora da forma + OUTRA chave do mesmo emitente no corpo → 502 (a busca no texto devolvia a OUTRA chave)', async () => {
    mockHttp.mockResolvedValueOnce(ok({ ...SEFIN, idDps: DPS_A, chaveAcesso: KEY_A.toLowerCase(), chaveSubstituta: KEY_A2 }))
    const got: any = await adnAdapter.queryDpsAccessKey(ctx, DPS_A).then(k => k, e => e)
    // hoje: got === KEY_A2 (a busca no texto acha a chave do campo `chaveSubstituta`; o emitente confere → aceita)
    expect(typeof got === 'string' ? `devolveu ${got === KEY_A2 ? 'a OUTRA chave' : got}` : got.statusCode).toBe(502)
  })
})

describe('P3 — o eco no pedido de cancelamento é EXATO (RESISTIU)', () => {
  it.each([[` ${KEY_A}`], [`${KEY_A}﻿`], [KEY_A.toLowerCase()], [KEY_A.replace('E', 'Ｅ')], [KEY_A + '\u0000']])('%j recusado no Id PRE', k => {
    expect(() => buildEventId(k, '101101')).toThrow(/chave de acesso inválida/)
  })
  it('o nome do arquivo leva a chave como é, e uma "chave" hostil nunca sai da pasta do CNPJ (o storage barra o nome)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-nfse-'))
    try {
      const st = new FsFiscalStorage(root)
      expect(() => st.save(NUM, nfseFileName('../../etc/passwd'), '<x/>', new Date(), 'P', 'UTC')).toThrow(/Nome de arquivo fiscal inválido/)
      expect(st.save(ALFA, nfseFileName(KEY_A), '<x/>', new Date('2026-10-15T12:00:00Z'), 'P', 'UTC')).toBe(path.join(root, ALFA, '2026', '10', `${KEY_A}-nfse.xml`))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 4 — fonte de fatos: CNPJ com letra nunca chega mutilado ao montador
// ---------------------------------------------------------------------------------------------------------------------------------------
type Row = { cnpj?: string | null; cpf?: string | null }
const sqlSeen: string[] = []
const fakeErp = (row: Row) => ({
  query: jest.fn(async (sql: string) => {
    sqlSeen.push(sql)
    if (/tb_address/.test(sql)) return [[{ main: 'S', street: 'Rua A', nmbr: '1', complement: null, neighborhood: 'Centro', zipCode: '80000000', cityId: 1, cityName: 'Curitiba', stateName: 'PR' }]]
    if (/tb_city WHERE/.test(sql)) return [[{ ibge: '4106902' }]]
    if (/tb_company/.test(sql)) return [row.cnpj === undefined ? [] : [{ cnpj: row.cnpj, im: null }]]
    if (/tb_person/.test(sql)) return [row.cpf === undefined ? [] : [{ cpf: row.cpf }]]
    if (/tb_entity_tax/.test(sql)) return [[{ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' }]]
    if (/tb_entity/.test(sql)) return [[{ nameCompany: 'Empresa Ltda', nickTrade: null }]]
    return [[]]
  }),
}) as any
const THREE_LETTERS = (() => { const b = 'ABC123450001'; return b + cnpjCheckDigits(b)! })()

describe('P4 — emitente: CNPJ alfanumérico VÁLIDO é recusado legível (422) ANTES de qualquer outra leitura do DPS (RESISTIU)', () => {
  beforeEach(() => { sqlSeen.length = 0 })
  it.each([[ALFA], [THREE_LETTERS], ['PC3D315K000193']])('emitente %s → 422 FISCAL_EMITTER_INCOMPLETE "CNPJ alfanumérico", sem ler a tributação', async cnpj => {
    const err = await buildEmitter(fakeErp({ cnpj }), 'setes_setes', 1).then(() => null, e => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_EMITTER_INCOMPLETE' })
    expect(JSON.stringify(err.fields)).toMatch(/CNPJ alfanumérico/)
    expect(sqlSeen.some(s => /tb_entity_tax/.test(s))).toBe(false)
  })
  it('emitente numérico válido passa e o prest leva o CNPJ intacto', async () => {
    expect((await buildEmitter(fakeErp({ cnpj: NUM }), 'setes_setes', 1)).prest.cnpj).toBe(NUM)
  })
  it('tomador: CNPJ gravado com branco na ponta / NEL / minúscula é INVÁLIDO no cadastro (o fato gravado não é "limpo")', async () => {
    for (const cnpj of [` ${NUM}`, `${NUM}\u0085`, 'pc3d315k000193']) {
      const err = await buildRecipient(fakeErp({ cnpj }), 900).then(() => null, e => e)
      expect([cnpj, err?.statusCode, JSON.stringify(err?.fields)]).toEqual([cnpj, 422, expect.stringMatching(/CNPJ do tomador inválido/)])
    }
  })
  it('tomador com CNPJ de 3 letras e CPF válido ao lado: nunca vira <CPF> nem 11 dígitos', async () => {
    const err = await buildRecipient(fakeErp({ cnpj: THREE_LETTERS, cpf: '52998224725' }), 900).then(() => null, e => e)
    expect(err).toMatchObject({ statusCode: 422 })
  })
})

describe('P4 — o montador do Id do DPS (defesa em profundidade)', () => {
  // Achado deste gate no snapshot de 22:20 (`digits(inscricao)` SEM comprimento devolvia `DPS…2 00000000000812…` — o Id de OUTRO CNPJ);
  // CORRIGIDO em paralelo pelo gate socrático (22:48, inscrição conferida pela forma). O teste fica como garantia.
  it.each([[ALFA], [THREE_LETTERS], ['12.345.678/0001-95'], [' 12345678000195'], ['1234567800019']])('buildDpsId com inscrição %j RECUSA (nunca mutila) (RESISTIU após correção)', insc => {
    let id: string | null = null, err: unknown = null
    try { id = buildDpsId('4106902', '2', insc, 1, 42) } catch (e) { err = e }
    expect({ id, threw: err !== null }).toEqual({ id: null, threw: true })
  })
  it('buildDpsId com CNPJ numérico e CPF: o Id embute a inscrição EXATA (CPF com zeros à esquerda)', () => {
    expect(buildDpsId('4106902', '2', NUM, 1, 42).slice(11, 25)).toBe(NUM)
    expect(buildDpsId('4106902', '1', '52998224725', 1, 42).slice(11, 25)).toBe('00052998224725')
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// D-CJ2 na BORDA real: upload do A1 contra o CNPJ do ERP em três estados
// ---------------------------------------------------------------------------------------------------------------------------------------
function makePfx(cn: string, password: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')
}

describe('D-CJ2 — `PUT` do certificado na nfse-api: o CNPJ do ERP em TRÊS estados chega à conferência do A1', () => {
  const inst = { institutionId: 1, userId: 7, schemaName: 'setes_setes' } as any
  const pfxBase64 = makePfx(`EMPRESA:${NUM}`, 'p').toString('base64')
  const ctxWith = (cnpj: string | undefined) => ({ pool: fakeErp({ cnpj }), keyring: {} }) as any
  it('ausente → "sem CNPJ" (RESISTIU)', async () => {
    await expect(saveCertificate(ctxWith(undefined), inst, { pfxBase64, password: 'p' } as any))
      .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/sem CNPJ/) })
  })
  // Achado deste gate no snapshot de 22:20 (a borda lia `establishmentCnpj` — válido ou null — e o CNPJ com DV errado virava "sem CNPJ");
  // CORRIGIDO em paralelo pelo gate socrático (22:48, `establishmentCnpjFact`). O teste fica como garantia na BORDA real.
  it.each([['12.345.678/0001-95'], ['pc3d315k000193'], ['12345678000199']])(
    'CNPJ %j que EXISTE mas não fecha → "CNPJ do estabelecimento inválido", nunca "sem CNPJ" (RESISTIU após correção)', async cnpj => {
      await expect(saveCertificate(ctxWith(cnpj), inst, { pfxBase64, password: 'p' } as any))
        .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/CNPJ do estabelecimento inválido/) })
    })
})
