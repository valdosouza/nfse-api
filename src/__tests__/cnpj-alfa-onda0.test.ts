/// <reference types="jest" />
// Frente do CNPJ alfanumérico — ONDA 0 na nfse-api (D-CJ7/D-CJ8, Valdo 2026-10-15; `Infra-IA/prompts/prompt_frente_cnpj_alfanumerico.md`).
// O LEITOR da voz entende chave/Id com o CNPJ alfanumérico embutido ANTES de qualquer escritor produzir um — "o escritor nunca produz o que
// o leitor não lê". A Setes é numérica: a D12 não é provável em H; a defesa é por construção, com vetor SINTÉTICO (o 1º CNPJ alfanumérico
// atribuído pela RFB, 00.000.000/E08G-12). Antes desta onda: chave alfanumérica AUTORIZADA → 502 "nfse-sem-chave" (D12), evento nunca
// reconhecido (D13), `GET /dps` fora do contrato (D14), arquivo com o nome de outra chave (D17), pedido de cancelamento impossível (D5).
import { gzipSync } from 'zlib'
import { transport, AuthorityContext, readFederalIdFact, cnpjCheckDigits } from 'fiscal-api'
import { adnAdapter } from '../authority/adn'
import { buildCancelEventXml, buildEventId } from '../authority/dps-builder'
import {
  NFSE_ACCESS_KEY_FORM, DPS_ID_FORM, asNfseAccessKey, asDpsId, findNfseAccessKeyIn, issuerOfAccessKey, issuerOfDpsId, sameEmbeddedIssuer,
  embeddedFederalId,
} from '../authority/access-key'
import { nfseFileName, cancelEventFileName } from '../nfse/transmission'
import { buildRecipient, emitterCnpj } from '../facts/service-facts'

const ALFA = '00000000E08G12'                                   // 1º CNPJ alfanumérico (RFB, 31/07/2026) — DV ASCII − 48 fecha
const NUM = '12345678000195'
const keyOf = (insc: string, tp = '2', nNfse = '0000000000123') => '4106902' + '2' + tp + insc + nNfse + '2610' + '000000001' + '7'
const dpsIdOf = (insc: string, tp = '2') => 'DPS' + '4106902' + tp + insc + '00001' + '000000000000042'
const KEY_ALFA = keyOf(ALFA)
const DPS_ALFA = dpsIdOf(ALFA)

describe('D-CJ7 — a peça da chave de acesso (forma geral, sem tirar caractere, sem DV presumido)', () => {
  it('o vetor sintético tem as posições certas: 50 e 45, inscrição nas posições 10–23 da chave e 12–25 do Id', () => {
    expect(KEY_ALFA).toHaveLength(50)
    expect(DPS_ALFA).toHaveLength(45)
    expect(KEY_ALFA.slice(9, 23)).toBe(ALFA)
    expect(DPS_ALFA.slice(11, 25)).toBe(ALFA)
    expect(readFederalIdFact('cnpj', ALFA).state).toBe('valid')
  })
  it('chave alfanumérica da forma geral é chave; numérica também (o formato de sempre não muda)', () => {
    expect(asNfseAccessKey(KEY_ALFA)).toBe(KEY_ALFA)
    expect(asNfseAccessKey(keyOf(NUM))).toBe(keyOf(NUM))
    expect(asNfseAccessKey(`  ${KEY_ALFA}\n`)).toBe(KEY_ALFA)              // só as pontas são aparadas
    expect(asDpsId(DPS_ALFA)).toBe(DPS_ALFA)
    expect(NFSE_ACCESS_KEY_FORM.test(KEY_ALFA) && DPS_ID_FORM.test(DPS_ALFA)).toBe(true)
  })
  it.each([
    ['minúscula', KEY_ALFA.toLowerCase()],
    ['letra no DV da inscrição (posição 22)', KEY_ALFA.slice(0, 21) + 'A' + KEY_ALFA.slice(22)],
    ['letra no tpInsc (posição 9)', KEY_ALFA.slice(0, 8) + 'A' + KEY_ALFA.slice(9)],
    ['letra no nNFSe', KEY_ALFA.slice(0, 30) + 'A' + KEY_ALFA.slice(31)],
    ['49 posições', KEY_ALFA.slice(1)],
    ['51 posições', KEY_ALFA + '0'],
    ['formatada (espaço no meio)', KEY_ALFA.slice(0, 25) + ' ' + KEY_ALFA.slice(25)],
  ])('não é chave: %s', (_l, v) => {
    expect(asNfseAccessKey(v)).toBeNull()
  })
  it('número em JSON nunca é chave (50 dígitos não cabem num double — seria OUTRA chave)', () => {
    expect(asNfseAccessKey(Number(keyOf(NUM)))).toBeNull()
  })
  it('CONHECIMENTO NEGATIVO: o `TSChaveNFSe` do XSD de produção restrita (posições 7–20, recorte da chave de 44 da NF-e) recusaria esta chave — nunca copiá-lo', () => {
    const xsdHDefeituoso = /^[0-9]{6}([0-9A-Z]{14})[0-9]{30}$/
    expect(xsdHDefeituoso.test(KEY_ALFA)).toBe(false)                    // o 12º caractere do CNPJ ('G') cai na posição 21
    expect(asNfseAccessKey(KEY_ALFA)).toBe(KEY_ALFA)
  })
  it('a chave dentro de um texto qualquer (corpo fora do JSON do contrato), com limites de palavra', () => {
    expect(findNfseAccessKeyIn(`resposta: ${KEY_ALFA}.`)).toBe(KEY_ALFA)
    expect(findNfseAccessKeyIn(`X${KEY_ALFA}`)).toBeNull()
    expect(findNfseAccessKeyIn('nada aqui')).toBeNull()
  })
  it('o emitente embutido: chave × Id do DPS comparados EXATOS; o tipo vem do tpInsc (o LUGAR)', () => {
    expect(issuerOfAccessKey(KEY_ALFA)).toEqual({ tpInsc: '2', inscricao: ALFA })
    expect(issuerOfDpsId(DPS_ALFA)).toEqual({ tpInsc: '2', inscricao: ALFA })
    expect(sameEmbeddedIssuer(issuerOfAccessKey(KEY_ALFA), issuerOfDpsId(DPS_ALFA))).toBe(true)
    expect(sameEmbeddedIssuer(issuerOfAccessKey(KEY_ALFA), issuerOfDpsId(dpsIdOf(NUM)))).toBe(false)
    expect(sameEmbeddedIssuer(issuerOfAccessKey(KEY_ALFA), issuerOfAccessKey(keyOf(ALFA, '1')))).toBe(false)   // tpInsc diferente
    expect(sameEmbeddedIssuer(null, null)).toBe(false)
    expect(embeddedFederalId({ tpInsc: '2', inscricao: ALFA })).toEqual({ kind: 'cnpj', value: ALFA })
    expect(embeddedFederalId({ tpInsc: '1', inscricao: '00052998224725' })).toEqual({ kind: 'cpf', value: '52998224725' })
    expect(embeddedFederalId({ tpInsc: '1', inscricao: ALFA })).toBeNull()
  })
  it('o nome do arquivo fiscal leva a chave COMO É (antes sem as letras — duas chaves podiam virar o mesmo arquivo)', () => {
    expect(nfseFileName(KEY_ALFA)).toBe(`${KEY_ALFA}-nfse.xml`)
    expect(cancelEventFileName(KEY_ALFA)).toBe(`${KEY_ALFA}-evt101101.xml`)
    expect(nfseFileName(keyOf(NUM))).toBe(`${keyOf(NUM)}-nfse.xml`)    // numérica: o mesmo nome de sempre
  })
  it('o pedido de cancelamento ECOA a chave como veio (Id PRE + chave + evento; <chNFSe>) e recusa o que não é chave', () => {
    expect(buildEventId(KEY_ALFA, '101101')).toBe(`PRE${KEY_ALFA}101101`)
    const xml = buildCancelEventXml({ accessKey: KEY_ALFA, dhEvento: '2026-10-15T11:00:00-03:00', cMotivo: '2', xMotivo: 'Serviço não prestado ao cliente',
      environment: 'H', verAplic: 'v', cnpjAutor: NUM })
    expect(xml).toContain(`<chNFSe>${KEY_ALFA}</chNFSe>`)
    expect(xml).toContain(`Id="PRE${KEY_ALFA}101101"`)
    expect(() => buildEventId(KEY_ALFA.toLowerCase(), '101101')).toThrow(/chave de acesso inválida/)
    expect(() => buildEventId(` ${KEY_ALFA}`, '101101')).toThrow(/chave de acesso inválida/)   // o eco é exato — nada aparado no escritor
  })
})

// ---------------------------------------------------------------------------
// adaptador ADN com transporte mockado — a voz com a chave alfanumérica
// ---------------------------------------------------------------------------
const mockHttp = jest.fn()
transport.request = mockHttp as any
const ctx: AuthorityContext = { environment: 'H', cert: Buffer.from('cert-pem'), key: Buffer.from('key-pem') }
const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : JSON.stringify(obj) })
const SEFIN = { dataHoraProcessamento: '2026-10-15T18:45:27.438738-03:00', tipoAmbiente: 2, versaoAplicativo: 'SefinNacional_1.6.0' }
const noEvent = () => ({ status: 404, headers: {}, text: JSON.stringify(SEFIN) })
const arquivoXml = (xml: string) => Buffer.from(gz(xml), 'utf8').toString('base64')

const nfseXmlOf = (key: string, dpsId: string) => '<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${key}"><xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>`
  + `<dhProc>2026-10-15T13:16:01-03:00</dhProc><nDFSe>555</nDFSe><emit><CNPJ>${key.slice(9, 23)}</CNPJ><xNome>Empresa Nova</xNome></emit>`
  + `<DPS versao="1.01"><infDPS Id="${dpsId}"><tpAmb>2</tpAmb><dhEmi>2026-10-15T10:15:30-03:00</dhEmi><nDPS>42</nDPS></infDPS></DPS></infNFSe>`
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>x</SignatureValue></Signature></NFSe>'
const eventXmlOf = (key: string) => '<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infEvento Id="EVT${'0'.repeat(59)}"><verAplic>SNNFSE</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>2026-10-16T09:00:00-03:00</dhProc><nDFSe>556</nDFSe>`
  + `<pedRegEvento versao="1.01"><infPedReg Id="PRE${key}101101"><tpAmb>2</tpAmb><verAplic>v</verAplic><dhEvento>2026-10-16T08:59:00-03:00</dhEvento>`
  + `<CNPJAutor>${key.slice(9, 23)}</CNPJAutor><chNFSe>${key}</chNFSe>`
  + '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emissão da nota fiscal</xMotivo></e101101></infPedReg></pedRegEvento></infEvento></evento>'
const eventsOf = (key: string, file: string) => ok({ ...SEFIN, eventos: [{ chaveAcesso: key, tipoEvento: 101101, numeroPedidoRegistroEvento: 1,
  dataHoraRecebimento: '2026-10-16T08:59:04.82', arquivoXml: file }] })

beforeEach(() => mockHttp.mockReset())

describe('D12 — NFS-e AUTORIZADA de emitente com CNPJ alfanumérico vira voz A (antes: 502 "nfse-sem-chave", autorizada no fisco sem a voz)', () => {
  it('transmitir: a chave do JSON e a do XML (Id sem "NFS") são lidas como vieram; o Id do DPS embutido confere com o enviado', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: KEY_ALFA, nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }, 201))
    const r = await adnAdapter.transmit(ctx, `<DPS><infDPS Id="${DPS_ALFA}"/></DPS>`)
    expect(r.accessKey).toBe(KEY_ALFA)
  })
  it('transmitir: chave do JSON ≠ chave do XML continua resposta TROCADA (502) — a tolerância é à forma, nunca à divergência', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: keyOf(ALFA, '2', '0000000000124'), nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }, 201))
    await expect(adnAdapter.transmit(ctx, `<DPS><infDPS Id="${DPS_ALFA}"/></DPS>`)).rejects.toMatchObject({ statusCode: 502 })
  })
  it('consultar: a NFS-e da chave alfanumérica pedida é a autorizada (os 4 códigos de cancelamento sem evento)', async () => {
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }))
    for (let i = 0; i < 4; i++) mockHttp.mockResolvedValueOnce(noEvent())
    expect(await adnAdapter.queryNfse(ctx, KEY_ALFA)).toMatchObject({ accessKey: KEY_ALFA, status: 'authorized' })
  })
})

describe('D13 — o cancelamento de uma chave alfanumérica é reconhecido (antes: as letras saíam da chave do evento e nada casava)', () => {
  it('evento e101101 com <chNFSe> alfanumérico = desta chave → cancelled', async () => {
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }))
      .mockResolvedValueOnce(eventsOf(KEY_ALFA, arquivoXml(eventXmlOf(KEY_ALFA))))
    expect(await adnAdapter.queryNfse(ctx, KEY_ALFA)).toMatchObject({ status: 'cancelled', cancelled: { eventCode: '101101' } })
  })
  it('D-F88 preservada: <chNFSe> FORMATADO (espaços) ainda é "desta chave"; o de OUTRA chave alfanumérica não é', async () => {
    const spaced = KEY_ALFA.replace(/(.{10})/g, '$1 ').trim()
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }))
      .mockResolvedValueOnce(eventsOf(KEY_ALFA, arquivoXml(eventXmlOf(KEY_ALFA).replace(`<chNFSe>${KEY_ALFA}`, `<chNFSe>${spaced}`))))
    expect((await adnAdapter.queryNfse(ctx, KEY_ALFA)).status).toBe('cancelled')
    // as letras NÃO saem: outra chave que só difere numa LETRA da inscrição é outra chave
    const otherLetter = keyOf('00000000E08H' + '12')
    mockHttp.mockResolvedValueOnce(ok({ nfseXmlGZipB64: gz(nfseXmlOf(KEY_ALFA, DPS_ALFA)) }))
      .mockResolvedValueOnce(eventsOf(KEY_ALFA, arquivoXml(eventXmlOf(KEY_ALFA).replace(`<chNFSe>${KEY_ALFA}`, `<chNFSe>${otherLetter}`))))
    expect((await adnAdapter.queryNfse(ctx, KEY_ALFA)).status).not.toBe('cancelled')
  })
})

describe('D14 — `GET /dps/{id}` com a chave alfanumérica do MESMO emitente (antes: só `\\d{50}` — "dps-fora-do-contrato")', () => {
  it('JSON `chaveAcesso` alfanumérica → a chave; corpo só com a chave no texto → achada pela forma geral', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: KEY_ALFA }))
    expect(await adnAdapter.queryDpsAccessKey(ctx, DPS_ALFA)).toBe(KEY_ALFA)
    mockHttp.mockResolvedValueOnce({ status: 200, headers: {}, text: `{"outro":"${KEY_ALFA}"}` })
    expect(await adnAdapter.queryDpsAccessKey(ctx, DPS_ALFA)).toBe(KEY_ALFA)
  })
  it('chave de OUTRO emitente (resposta trocada) segue recusada pela peça — inclusive quando só uma letra difere', async () => {
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: keyOf('00000000E08H12') }))
    await expect(adnAdapter.queryDpsAccessKey(ctx, DPS_ALFA)).rejects.toMatchObject({ statusCode: 502 })
    mockHttp.mockResolvedValueOnce(ok({ chaveAcesso: keyOf(NUM) }))
    await expect(adnAdapter.queryDpsAccessKey(ctx, DPS_ALFA)).rejects.toMatchObject({ statusCode: 502 })
  })
})

// ---------------------------------------------------------------------------
// D8/D9/D10 — fonte de fatos: três estados e PF × PJ pelo LUGAR
// ---------------------------------------------------------------------------
type Row = { cnpj?: string | null; cpf?: string | null }
/** ERP falso mínimo para `erp.entityFiscal`/`erp.establishmentCnpj*` (só as tabelas que eles leem). */
const fakeErp = (row: Row) => ({
  query: jest.fn(async (sql: string) => {
    if (/tb_address/.test(sql)) return [[]]
    if (/tb_company/.test(sql)) return [row.cnpj === undefined ? [] : [{ cnpj: row.cnpj, im: null }]]
    if (/tb_person/.test(sql)) return [row.cpf === undefined ? [] : [{ cpf: row.cpf }]]
    if (/tb_entity/.test(sql)) return [[{ nameCompany: 'Tomador Ltda', nickTrade: null }]]
    return [[]]
  }),
}) as any
/** CNPJ alfanumérico VÁLIDO com 3 letras: tirando as letras sobravam 11 dígitos — o código antigo o mandava ao fisco como CPF. */
const THREE_LETTERS = (() => { const base = 'ABC123450001'; return base + cnpjCheckDigits(base)! })()

describe('D10 — tomador: PF × PJ pelo LUGAR (`tb_company` × `tb_person`), três estados, nada mutilado', () => {
  it('o vetor do estrago: com 3 letras, o "tira o que não é dígito" dava 11 dígitos', () => {
    expect(THREE_LETTERS.replace(/[A-Z]/g, '')).toHaveLength(11)
  })
  it.each([
    ['CNPJ numérico válido → <CNPJ>', { cnpj: NUM }, { cnpj: NUM }],
    ['só CPF válido → <CPF>', { cpf: '52998224725' }, { cpf: '52998224725' }],
    ['sentinela "0" no CNPJ = ausente → o CPF', { cnpj: '0', cpf: '52998224725' }, { cpf: '52998224725' }],
    // onda 1 (D-CJ7, 2026-10-16): a fonte de fatos devolve o FATO — quem recusa pelo leiaute é o `buildDpsBase` (antes da reserva)
    ['onda 1: CNPJ alfanumérico VÁLIDO → <CNPJ> como é (o leiaute decide depois)', { cnpj: ALFA }, { cnpj: ALFA }],
    ['onda 1: CNPJ com 3 letras e CPF ao lado → <CNPJ> (NUNCA <CPF> nem 11 dígitos)', { cnpj: THREE_LETTERS, cpf: '52998224725' }, { cnpj: THREE_LETTERS }],
  ] as const)('%s', async (_l, row, expected) => {
    const toma = await buildRecipient(fakeErp(row), 900)
    expect(toma).toMatchObject({ ...expected, xNome: 'Tomador Ltda' })
    expect(Object.keys(toma).filter(k => k === 'cnpj' || k === 'cpf')).toEqual(Object.keys(expected))
  })
  it.each([
    ['CNPJ gravado com máscara → inválido no cadastro (o fato gravado é a forma canônica)', { cnpj: '12.345.678/0001-95' }, /CNPJ do tomador inválido no cadastro/],
    ['CNPJ com DV errado → inválido (não "sem documento")', { cnpj: '12345678000199' }, /CNPJ do tomador inválido no cadastro/],
    ['CPF com DV errado → inválido', { cpf: '52998224724' }, /CPF do tomador inválido no cadastro/],
    ['nada → sem CPF/CNPJ', {}, /Tomador sem CPF\/CNPJ/],
  ] as const)('%s', async (_l, row, message) => {
    const err = await buildRecipient(fakeErp(row), 900).then(() => null, e => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'FISCAL_RECIPIENT_INCOMPLETE' })
    expect(JSON.stringify(err.fields)).toMatch(message)
  })
})

describe('D8/D9 — emitente: ausente ≠ inválido; o alfanumérico VÁLIDO serve para LER (pasta, XML, DANFSe)', () => {
  it('válido (numérico ou alfanumérico) → o CNPJ canônico', async () => {
    expect(await emitterCnpj(fakeErp({ cnpj: NUM }), 1)).toBe(NUM)
    expect(await emitterCnpj(fakeErp({ cnpj: ALFA }), 1)).toBe(ALFA)
  })
  it('ausente e inválido dão diagnósticos DIFERENTES (antes os dois eram "Estabelecimento sem CNPJ")', async () => {
    await expect(emitterCnpj(fakeErp({}), 1)).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/sem CNPJ/) })
    await expect(emitterCnpj(fakeErp({ cnpj: '0' }), 1)).rejects.toMatchObject({ message: expect.stringMatching(/sem CNPJ/) })
    for (const bad of ['12ÁBC34501DE35', 'PC3D315K00019Z', '123']) {
      await expect(emitterCnpj(fakeErp({ cnpj: bad }), 1)).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/CNPJ do estabelecimento inválido/) })
    }
  })
  it('D-CJ16 (onda 1): a LEITURA de documento já autorizado canonicaliza o CNPJ gravado fora da forma (sem DV) — a 2ª via não depende do cadastro de hoje', async () => {
    expect(await emitterCnpj(fakeErp({ cnpj: '12.345.678/0001-95' }), 1)).toBe(NUM)
    expect(await emitterCnpj(fakeErp({ cnpj: 'pc3d315k000193' }), 1)).toBe('PC3D315K000193')
    expect(await emitterCnpj(fakeErp({ cnpj: '12345678000199' }), 1)).toBe('12345678000199')   // DV errado: a pasta é a do que foi gravado
  })
})
