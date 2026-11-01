/// <reference types="jest" />
// GATE ADVERSARIAL do leiaute por ambiente (D-IB110…D-IB114) — ACHADOS confirmados, fixados ANTES da correção (skill testar-adversarial §4.6).
// Cada `it` vermelho aqui é um achado ABERTO; ao corrigir, o teste fica verde e permanece como cerca. ADV-NT009-01 CORRIGIDO na mesma
// sessão (2026-11-01): o montador recusa o obrigatório esvaziado e a fonte de fatos decide pelo MESMO saneamento (`dpsText`).
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import forge from 'node-forge'
import { signXml, verifyXml } from 'fiscal-api'
import { buildDpsId, buildDpsXml } from '../authority/dps-builder'
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
const COMPLEX = {
  'xsd-20260209': fs.readFileSync(path.join(ACERVO, 'xsd', 'Schemas', '1.01', 'tiposComplexos_v1.01.xsd'), 'utf8'),
  'xsd-20261020': fs.readFileSync(path.join(ACERVO, 'producao-restrita-20261020', 'xsd', 'tiposComplexos_v1.01.xsd'), 'utf8'),
}
/** O elemento [el] do tipo [type] é obrigatório no XSD (sem minOccurs="0")? */
function requiredIn(xsd: string, type: string, el: string): boolean {
  const start = xsd.indexOf(`<xs:complexType name="${type}">`)
  const body = xsd.slice(start, xsd.indexOf('</xs:complexType>', start))
  const decl = new RegExp(`<xs:element[^>]*\\bname="${el}"[^>]*>`).exec(body)?.[0]
  if (!decl) throw new Error(`${el} não está em ${type}`)
  return !/minOccurs="0"/.test(decl)
}

const base: DpsInput = {
  environment: 'P', dhEmi: '2026-12-20T10:15:30-03:00', verAplic: 'nfse-api', serie: 900, nDps: 42, dCompet: '2026-12-20',
  tpEmit: '1', cLocEmi: '4106902',
  prest: { cnpj: '12345678000195', regTrib: { opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' } },
  toma: { cnpj: '98765432000198', xNome: 'Cliente' },
  serv: { locPrest: { cLocPrestacao: '4106902' }, cServ: { cTribNac: '010201', xDescServ: 'Suporte mensal', cNBS: '115021000' } },
  valores: { vServ: 250, trib: { tribMun: { tribISSQN: '1', tpRetISSQN: '1' }, totTrib: { pTotTribSN: 6 } } },
}
const DPS_ID = buildDpsId('4106902', '2', '12345678000195', 900, 42)

/**
 * ADV-NT009-01 (LOW — pré-existente, agravado pelo alarme D-IB111): texto OBRIGATÓRIO que o saneamento TSString esvazia sai do DPS em
 * SILÊNCIO. A fonte de fatos só cai em "Serviços" quando a descrição é vazia DEPOIS do `trim()` (`service-facts.ts:380`); "🚀", "Сервис"
 * (cirílico sem letra-base no Latin-1) ou "​" passam por ela, e o `toTsString` do montador os remove → `el()` omite o `xDescServ`,
 * OBRIGATÓRIO nos DOIS pacotes. O DPS vai ao fisco fora do esquema (contra a regra LOW-1: "erro de leiaute vira 422 FISCAL_DPS_INVALID,
 * nunca o fisco às cegas") → R E1235; em P o alarme `[D-IB111]` acusa uma troca de LEIAUTE que não houve. O mesmo vale para o `xNome` do
 * tomador (obrigatório no pacote de 09/02; `service-facts.ts:299`). Correção esperada: o montador recusa (lança) o obrigatório vazio.
 */
describe('ADV-NT009-01 — obrigatório esvaziado pelo saneamento sai do DPS sem erro (vai ao fisco fora do esquema)', () => {
  it('o XSD dos DOIS pacotes exige xDescServ; o de 09/02 exige o xNome do tomador (o de 20/10 o deixou opcional — E0233 o exige por regra)', () => {
    expect(requiredIn(COMPLEX['xsd-20260209'], 'TCCServ', 'xDescServ')).toBe(true)
    expect(requiredIn(COMPLEX['xsd-20261020'], 'TCCServ', 'xDescServ')).toBe(true)
    expect(requiredIn(COMPLEX['xsd-20260209'], 'TCInfoPessoa', 'xNome')).toBe(true)
    expect(requiredIn(COMPLEX['xsd-20261020'], 'TCInfoPessoa', 'xNome')).toBe(false)
  })
  it.each([['emoji', '🚀'], ['cirílico', 'Сервис'], ['espaço de largura zero', '​'], ['marca registrada', '™']])(
    'xDescServ só com %s: passa no `trim() || "Serviços"` da fonte de fatos e o montador tem de RECUSAR (hoje omite o elemento)', (_n, desc) => {
      expect(desc.trim()).not.toBe('')                               // a fonte de fatos NÃO cai no "Serviços"
      for (const environment of ['P', 'H'] as const) {
        let xml: string | null = null
        let threw = false
        try { xml = buildDpsXml({ ...base, environment, serv: { ...base.serv, cServ: { ...base.serv.cServ, xDescServ: desc } } }, DPS_ID) } catch { threw = true }
        expect({ environment, desc, threwOrHasXDescServ: threw || /<xDescServ>[^<]+<\/xDescServ>/.test(xml ?? '') })
          .toEqual({ environment, desc, threwOrHasXDescServ: true })
      }
    })
  it('xNome do tomador só com emoji, no pacote de 09/02 (P): o montador tem de RECUSAR (hoje sai <toma> sem xNome)', () => {
    let xml: string | null = null
    let threw = false
    try { xml = buildDpsXml({ ...base, toma: { cnpj: '98765432000198', xNome: '🚀' } }, DPS_ID) } catch { threw = true }
    expect(threw || /<xNome>[^<]+<\/xNome>/.test(xml ?? '')).toBe(true)
  })
})

describe('(informativo, verde) a forma do <gIBSCBS> vazio que de fato vai ao fisco', () => {
  it('o XML ASSINADO leva o grupo vazio numa das duas formas equivalentes pela C14N, e verifica', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const fk = forge.pki.privateKeyFromPem(keyPem)
    const cert = forge.pki.createCertificate()
    cert.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e)
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date(Date.now() - 60_000)
    cert.validity.notAfter = new Date(Date.now() + 86_400_000)
    cert.setSubject([{ name: 'commonName', value: 'T' }]); cert.setIssuer([{ name: 'commonName', value: 'T' }])
    cert.sign(fk, forge.md.sha256.create())
    const certPem = Buffer.from(forge.pki.certificateToPem(cert))
    const xml = buildDpsXml({ ...base, environment: 'H', ibscbs: { cIndOp: '100301', cClassTrib: '000001' } }, DPS_ID)
    expect(xml).toContain('<gIBSCBS></gIBSCBS>')
    const signed = signXml(xml, { referenceId: DPS_ID, cert: certPem, key: Buffer.from(keyPem), algorithm: 'sha1' })
    const form = signed.includes('<gIBSCBS></gIBSCBS>') ? 'aberto-fechado' : signed.includes('<gIBSCBS/>') ? 'auto-fechado' : 'ausente'
    expect(['aberto-fechado', 'auto-fechado']).toContain(form)
    expect(verifyXml(signed, certPem)).toBe(true)
  })
})
