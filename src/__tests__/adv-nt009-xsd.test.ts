/// <reference types="jest" />
// GATE ADVERSARIAL do leiaute por ambiente (D-IB110…D-IB114 — prompt_fase_ibs_cbs.md §13.8, fim). O `leiaute-nt009.test.ts` confere a
// ORDEM e os obrigatórios com um extrator de XSD por regex; aqui o XML montado é VALIDADO DE VERDADE contra o XSD oficial de cada pacote
// pelo libxml2 (`xmllint` do Git for Windows — já instalado, nada baixado; `--nonet`: nenhum acesso à rede). Sem o xmllint, os testes
// pulam (dizem por quê). Matriz: TODO opcional que o montador sabe emitir × com/sem grupo × com/sem NBS × assinado/não assinado; e a prova
// NEGATIVA de que os pacotes são incompatíveis (o DPS de um recusa no outro — o E1235 da nota 8014).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { spawnSync } from 'child_process'
import { signXml, verifyXml } from 'fiscal-api'
import { buildDpsId, buildDpsXml, buildCancelEventXml, buildEventId } from '../authority/dps-builder'
import { layoutAt, NfseLayout } from '../authority/layout-calendar'
import type { DpsInput } from '../authority/types'

const PROJECT_ROOT = path.join(__dirname, '..', '..')
function infraIa(): string {
  let dir = PROJECT_ROOT
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'Infra-IA')
    if (fs.existsSync(cand)) return cand
    dir = path.dirname(dir)
  }
  throw new Error('Infra-IA não encontrada acima do projeto')
}
const ACERVO = path.join(infraIa(), 'setes-api', 'integracoes', 'nfse-adn')
const XSD_DIR: Record<NfseLayout, string> = {
  'xsd-20260209': path.join(ACERVO, 'xsd', 'Schemas', '1.01'),
  'xsd-20261020': path.join(ACERVO, 'producao-restrita-20261020', 'xsd'),
}

/** O xmllint (libxml2) — PATH do Git Bash ou o caminho padrão do Git for Windows. null = indisponível (os testes pulam). */
function findXmllint(): string | null {
  for (const cand of ['xmllint', 'D:\\Program Files\\Git\\mingw64\\bin\\xmllint.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\xmllint.exe']) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8' })
    if (r.status === 0 || /libxml/.test(String(r.stderr ?? ''))) return cand
  }
  return null
}
const XMLLINT = findXmllint()
const itX = XMLLINT ? it : it.skip

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-nt009-'))
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* temporário */ } })

/**
 * CONHECIMENTO NEGATIVO do validador (não do montador): o pacote de 09/02/2026 traz `TSSerieDPS` com `^0{0,4}\d{1,5}$`. Na regex do XSD
 * `^`/`$` são caracteres LITERAIS (o padrão já é ancorado) — o libxml2 segue a especificação e recusa TODA série; o validador do fisco os
 * trata como âncoras (a NFS-e 704 foi autorizada em P com a nossa série). O pacote de 20/10/2026 corrigiu (`[0-9]{1,4}|[0-8][0-9]{4}`).
 * Para validar o resto, a cópia TEMPORÁRIA do pacote antigo tira só as duas âncoras desse padrão (o acervo não é tocado).
 */
const XSD_FOR_LINT: Record<NfseLayout, string> = { ...XSD_DIR }
{
  const copy = path.join(TMP, 'xsd-20260209')
  fs.mkdirSync(copy)
  for (const f of fs.readdirSync(XSD_DIR['xsd-20260209'])) fs.copyFileSync(path.join(XSD_DIR['xsd-20260209'], f), path.join(copy, f))
  const simple = path.join(copy, 'tiposSimples_v1.01.xsd')
  const src = fs.readFileSync(simple, 'utf8')
  const patched = src.replace('<xs:pattern value="^0{0,4}\\d{1,5}$"/>', '<xs:pattern value="0{0,4}\\d{1,5}"/>')
  if (patched === src) throw new Error('o padrão de TSSerieDPS do pacote de 09/02 mudou — rever a cópia do validador')
  fs.writeFileSync(simple, patched, 'utf8')
  XSD_FOR_LINT['xsd-20260209'] = copy
}

let seq = 0
/** Valida [xml] contra o XSD raiz [root] do pacote [layout]; devolve { ok, out } (a saída do libxml2, para o diagnóstico). */
function validate(layout: NfseLayout, xml: string, root = 'DPS_v1.01.xsd'): { ok: boolean; out: string } {
  const file = path.join(TMP, `doc-${++seq}.xml`)
  fs.writeFileSync(file, xml, 'utf8')
  const r = spawnSync(XMLLINT!, ['--noout', '--nonet', '--schema', path.join(XSD_FOR_LINT[layout], root), file], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r/g, '').trim()
  return { ok: r.status === 0 && / validates$/m.test(out), out }
}
function expectValid(layout: NfseLayout, xml: string, label: string, root?: string): void {
  const v = validate(layout, xml, root)
  expect({ label, layout, ok: v.ok, out: v.ok ? '' : v.out }).toEqual({ label, layout, ok: true, out: '' })
}

function selfSigned(): { cert: Buffer; key: Buffer } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const fk = forge.pki.privateKeyFromPem(keyPem)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const attrs = [{ name: 'commonName', value: 'SETES TESTE:12345678000195' }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(fk, forge.md.sha256.create())
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(keyPem) }
}
const pair = selfSigned()
const other = selfSigned()

const base: DpsInput = {
  environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00', verAplic: 'nfse-api', serie: 900, nDps: 42, dCompet: '2026-12-20',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000195', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000198', xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal', cNBS: '115021000' } },
  valores: { vServ: 250, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
  ibscbs: { cIndOp: '100301', cClassTrib: '000001' },
}
const DPS_ID = buildDpsId('4106902', '2', '12345678000195', 900, 42)
const AT: Record<NfseLayout, Pick<DpsInput, 'environment' | 'dhEmi'>> = {
  'xsd-20260209': { environment: 'P', dhEmi: '2026-12-20T10:15:30-03:00' },
  'xsd-20261020': { environment: 'H', dhEmi: '2026-12-20T10:15:30-03:00' },
}
const LAYOUTS = Object.keys(XSD_DIR) as NfseLayout[]
const { ibscbs: _g, ...noGroup } = base

/** TODO opcional que o montador sabe emitir (o maior DPS possível) — com e sem o grupo. */
const full: DpsInput = {
  ...base,
  prest: { cnpj: '12345678000195', im: '50136779', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: {
    cnpj: '98765432000198', im: '123', xNome: 'Cliente & Filhos <Ltda>',
    end: { cMun: '4106902', cep: '80010000', xLgr: 'Rua A', nro: '10', xCpl: 'Sala 2', xBairro: 'Centro' },
    fone: '4133331234', email: 'cliente@exemplo.com.br',
  },
  serv: {
    locPrest: { cLocPrestacao: '4106902' },
    cServ: { cTribNac: '010201', cTribMun: '001', xDescServ: 'Licença mensal <ERP> & suporte\nlinha 2', cNBS: '115021000' },
    infoCompl: { docRef: 'OS 7374', xPed: 'PED-1', xInfComp: 'Observação\nlinha 2' },
  },
  valores: { vServ: 1234.5, vDescIncond: 0, vDescCond: 1.5, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '2', pAliq: 2 }, totTrib: { pTotTribSN: 6 } } },
}
const { ibscbs: _g2, ...fullNoGroup } = full
const cases: Record<string, DpsInput> = {
  'mínimo com grupo': base,
  'só NBS (sem grupo)': noGroup,
  'sem NBS nem grupo': { ...noGroup, serv: { ...base.serv, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal' } } },
  'sem tomador': { ...noGroup, toma: undefined },
  'tomador CPF + MEI (indTotTrib)': {
    ...noGroup, prest: { cnpj: '12345678000195', regTrib: { opSimpNac: '2', regEspTrib: '0' } },
    toma: { cpf: '12345678909', xNome: 'Pessoa' }, valores: { vServ: 10, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { indTotTrib: '0' } } },
  },
  'completo com grupo': full,
  'completo sem grupo': fullNoGroup,
}

describe.each(LAYOUTS)('o DPS montado no leiaute %s VALIDA no XSD oficial do pacote (libxml2)', layout => {
  it('o calendário põe o ambiente/instante da matriz neste leiaute', () => {
    expect(layoutAt('DPS', AT[layout].environment, new Date(AT[layout].dhEmi)).layout).toBe(layout)
  })
  itX.each(Object.keys(cases))('%s — não assinado', name => {
    expectValid(layout, buildDpsXml({ ...cases[name], ...AT[layout] }, DPS_ID), name)
  })
  itX.each(Object.keys(cases))('%s — ASSINADO (sha1 e sha256): valida e a assinatura confere', name => {
    for (const algorithm of ['sha1', 'sha256'] as const) {
      const signed = signXml(buildDpsXml({ ...cases[name], ...AT[layout] }, DPS_ID), { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm })
      expectValid(layout, signed, `${name} (${algorithm})`)
      expect(verifyXml(signed, pair.cert, { element: 'infDPS' })).not.toBeNull()
      expect(verifyXml(signed, other.cert, { element: 'infDPS' })).toBeNull()
    }
  })
})

describe('INCOMPATIBILIDADE dos pacotes (mesma versao="1.01") — o DPS de um recusa no esquema do outro (o E1235 da 8014)', () => {
  itX.each(Object.keys(cases))('%s: montado no leiaute de P × XSD de H e montado no de H × XSD de P', name => {
    const p = buildDpsXml({ ...cases[name], ...AT['xsd-20260209'] }, DPS_ID)
    const h = buildDpsXml({ ...cases[name], ...AT['xsd-20261020'] }, DPS_ID)
    // todo DPS do pacote novo leva o finNFSe no infDPS (obrigatório lá, inexistente no antigo) — a recusa cruzada é TOTAL
    const pInH = validate('xsd-20261020', p), hInP = validate('xsd-20260209', h)
    expect({ name, pInH: pInH.ok }).toEqual({ name, pInH: false })
    expect({ name, hInP: hInP.ok }).toEqual({ name, hInP: false })
    // a recusa é a da COSTURA 1 (o finNFSe no infDPS) — a mesma do E1235 da 8014 ("expected: cMotivoEmisTI, finNFSe"), não outro erro
    expect(pInH.out).toMatch(/finNFSe/)
    expect(hInP.out).toMatch(/finNFSe/)
  })
})

describe('assinatura sobre o <gIBSCBS></gIBSCBS> vazio (D-IB112)', () => {
  const xml = buildDpsXml({ ...base, ...AT['xsd-20261020'] }, DPS_ID)
  it('o grupo vazio sobrevive à assinatura e a verificação passa; adulterar o vazio (vira filho) quebra a assinatura', () => {
    const signed = signXml(xml, { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    expect(signed).toMatch(/<gIBSCBS(><\/gIBSCBS>|\/>)<\/trib>/)
    expect(verifyXml(signed, pair.cert, { element: 'infDPS' })).not.toBeNull()
    // a forma auto-fechada é a MESMA após C14N — quem a reescrever (proxy, ferramenta) não quebra a assinatura
    const selfClosed = signed.replace('<gIBSCBS></gIBSCBS>', '<gIBSCBS/>')
    expect(verifyXml(selfClosed, pair.cert, { element: 'infDPS' })).not.toBeNull()
    const tampered = signed.replace(/<gIBSCBS(><\/gIBSCBS>|\/>)/, '<gIBSCBS><cCredPres>01</cCredPres></gIBSCBS>')
    expect(tampered).not.toBe(signed)
    expect(verifyXml(tampered, pair.cert, { element: 'infDPS' })).toBeNull()
  })
  it('o digest do infDPS é o mesmo com <gIBSCBS/> e <gIBSCBS></gIBSCBS> (C14N inclusiva — o fisco recanonicaliza)', () => {
    const a = signXml(xml, { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha256' })
    const b = signXml(xml.replace('<gIBSCBS></gIBSCBS>', '<gIBSCBS/>'), { referenceId: DPS_ID, cert: pair.cert, key: pair.key, algorithm: 'sha256' })
    const digest = (s: string) => /<DigestValue>([^<]+)<\/DigestValue>/.exec(s)?.[1]
    expect(digest(a)).toBeTruthy()
    expect(digest(a)).toBe(digest(b))
  })
})

describe('evento de cancelamento: o pedido VALIDA nos dois pacotes (o evento não muda — D-IB110)', () => {
  const key = '41069022' + '12345678000195'.padStart(14, '0') + '0'.repeat(28)
  itX.each(['H', 'P'] as const)('ambiente %s: valida no pedRegEvento dos DOIS pacotes, assinado', environment => {
    const ev = buildCancelEventXml({
      accessKey: key.slice(0, 50), dhEvento: '2026-12-20T10:00:00-03:00', cMotivo: '1', xMotivo: 'Erro na emissao da nota',
      environment, verAplic: 'nfse-api', cnpjAutor: '12345678000195',
    })
    const signed = signXml(ev, { referenceId: buildEventId(key.slice(0, 50), '101101'), cert: pair.cert, key: pair.key, algorithm: 'sha1' })
    for (const layout of LAYOUTS) expectValid(layout, signed, `evento ${environment}`, 'pedRegEvento_v1.01.xsd')
  })
})
