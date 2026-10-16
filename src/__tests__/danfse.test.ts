/// <reference types="jest" />
// Onda 3 — peça @shared/danfse (D-N13: DANFSe é PDF NOSSO do XML autorizado).
// O que se fixa: o PDF nasce (magic "%PDF-"), a chave de acesso e os campos do
// DPS embutido entram no conteúdo (texto do fluxo do pdfkit), e a extração dos
// campos lê emit/prest/toma/serv/valores sem parser XML novo.
import { inflateSync } from 'zlib'
import { renderDanfse, extractDanfseFields, NFSE_PUBLIC_QUERY_URL } from '../nfse/danfse'
import { cnpjCheckDigits } from 'fiscal-api'

/** Infla os fluxos FlateDecode do PDF (pdfkit comprime as páginas) para procurar texto. */
function zlibSync(pdf: Buffer): string {
  const out: string[] = []
  const src = pdf.toString('latin1')
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const start = m.index + m[0].indexOf(m[1])
    const raw = pdf.subarray(start, start + Buffer.byteLength(m[1], 'latin1'))
    try { out.push(inflateSync(raw).toString('latin1')) } catch { out.push(m[1]) }
  }
  // o pdfkit escreve `[<hex> kern <hex>] TJ`: junta os chunks hex de cada array em texto
  return out.join('\n').replace(/\[((?:<[0-9a-fA-F]*>|[\s\-\d.])+)\]\s*TJ/g, (_, arr: string) =>
    (arr.match(/<([0-9a-fA-F]*)>/g) ?? []).map(h => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''))
}

const KEY = '41069021212345678000195000000000012320260921000012345'.slice(0, 50)
const NFSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">
<xLocEmi>Curitiba</xLocEmi><nNFSe>123</nNFSe><cStat>100</cStat><dhProc>2026-09-21T10:15:30-03:00</dhProc>
<emit><CNPJ>12345678000195</CNPJ><IM>777</IM><xNome>SETES SISTEMAS LTDA</xNome></emit>
<valores><vLiq>1230.00</vLiq><vISSQN>24.69</vISSQN><pAliqAplic>2.00</pAliqAplic></valores>
<DPS><infDPS Id="DPS4106902212345678000195000010000000000000042"><tpAmb>2</tpAmb><serie>1</serie><nDPS>42</nDPS><dCompet>2026-09-21</dCompet>
<prest><CNPJ>12345678000195</CNPJ><IM>777</IM></prest>
<toma><CNPJ>98765432000198</CNPJ><xNome>Cliente &amp; Filhos</xNome><end><endNac><cMun>4106902</cMun><CEP>80010000</CEP></endNac><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro></end></toma>
<serv><locPrest><cLocPrestacao>4106902</cLocPrestacao></locPrest><cServ><cTribNac>010201</cTribNac><xDescServ>Licença mensal ERP</xDescServ></cServ></serv>
<valores><vServPrest><vServ>1234.50</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>`

describe('extractDanfseFields', () => {
  it('lê chave, número, prestador (emit + prest), tomador com endereço, serviço e valores', () => {
    const f = extractDanfseFields(NFSE_XML)
    expect(f.accessKey).toBe(KEY)
    expect(f.nNFSe).toBe('123')
    expect(f.prest).toEqual({ cnpj: '12345678000195', im: '777', xNome: 'SETES SISTEMAS LTDA' })
    expect(f.toma.doc).toBe('98765432000198')
    expect(f.toma.xNome).toBe('Cliente & Filhos')
    expect(f.toma.address).toBe('Rua A, 10, Centro, 4106902, 80010000')
    expect(f.serv.cTribNac).toBe('010201')
    expect(f.valores).toEqual({ vServ: '1234.50', pAliq: '2.00', vISSQN: '24.69', tpRetISSQN: '1', vLiq: '1230.00' })
    expect(f.cancelled).toBe(false)
  })
})

describe('renderDanfse', () => {
  it('PDF nasce (%PDF-) e traz a chave, o título e a URL de consulta pública no conteúdo', async () => {
    const pdf = await renderDanfse(NFSE_XML, { issuerName: 'SETES', municipality: 'Curitiba / Paraná' })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
    // o pdfkit comprime os fluxos de página: inflar para procurar o texto
    const text = zlibSync(pdf)
    expect(text).toContain('DANFSe')
    expect(text).toContain(KEY.replace(/(\d{4})(?=\d)/g, '$1 '))
    expect(text).toContain(NFSE_PUBLIC_QUERY_URL.slice(0, 30))
  })

  it('NFS-e com e101101 no XML → selo CANCELADA', async () => {
    const xml = NFSE_XML.replace('</infNFSe>', '<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>erro na emissão do documento</xMotivo></e101101></infNFSe>')
    expect(extractDanfseFields(xml).cancelled).toBe(true)
    const text = zlibSync(await renderDanfse(xml, { issuerName: 'SETES', municipality: 'Curitiba' }))
    expect(text).toContain('CANCELADA')
  })
})

// D-CJ7 (S7 do inventário, frente do CNPJ alfanumérico): o tipo da inscrição vem do ELEMENTO (<CNPJ>/<CPF>), nunca do comprimento depois de
// tirar o que não é dígito — um CNPJ com 3 letras sobrava com 11 dígitos e saía com máscara de CPF; a chave agrupa de 4 em 4 também com letra
describe('DANFSe — inscrição pelo elemento (D-CJ7)', () => {
  const THREE = (() => { const base = 'ABC123450001'; return base + cnpjCheckDigits(base)! })()
  const render = async (xml: string) => zlibSync(await renderDanfse(xml, { issuerName: 'SETES', municipality: 'Curitiba' }))
  it('tomador com CNPJ alfanumérico de 3 letras → máscara de CNPJ (nunca a de CPF); os campos extraídos seguem como vieram (paridade N17)', async () => {
    const xml = NFSE_XML.replace('<toma><CNPJ>98765432000198</CNPJ>', `<toma><CNPJ>${THREE}</CNPJ>`)
    expect(extractDanfseFields(xml).toma.doc).toBe(THREE)
    const text = await render(xml)
    expect(text).toContain(`${THREE.slice(0, 2)}.${THREE.slice(2, 5)}.${THREE.slice(5, 8)}/${THREE.slice(8, 12)}-${THREE.slice(12)}`)
    expect(text).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/)
  })
  it('tomador com CPF → máscara de CPF; CNPJ com DV errado sai como veio (exibir nunca esconde o dado)', async () => {
    expect(await render(NFSE_XML.replace('<toma><CNPJ>98765432000198</CNPJ>', '<toma><CPF>52998224725</CPF>'))).toContain('529.982.247-25')
    expect(await render(NFSE_XML.replace('<toma><CNPJ>98765432000198</CNPJ>', '<toma><CNPJ>98765432000199</CNPJ>'))).toContain('98765432000199')
  })
  it('chave alfanumérica: grupos de 4 também com letra', async () => {
    const alfaKey = KEY.slice(0, 9) + '00000000E08G12' + KEY.slice(23)
    expect(await render(NFSE_XML.split(KEY).join(alfaKey))).toContain(alfaKey.replace(/([0-9A-Z]{4})(?=[0-9A-Z])/g, '$1 '))
  })
})
