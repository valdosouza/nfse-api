/// <reference types="jest" />
// GATE ADVERSARIAL da F1 — 2ª RODADA (testar-adversarial.md §4-6, 2026-10-04). Achado CONFIRMADO vira
// teste permanente: `it.failing` = reproduz o bug (PASSA enquanto o bug existe; quando a correção entrar,
// vira `it`). Os 4 achados daqui foram CORRIGIDOS na mesma sessão (cerca estrita, erro técnico com ref,
// YAML com os status reais) — viraram `it`. Aqui ficam as reproduções SEM banco; as que dependem do MVCC/SQL real estão em
// `adversarial-f1r2.live.test.ts` (NFSE_ADV_LIVE=1).
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import forge from 'node-forge'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import { refreshOpenServiceTransmissions, resetMunicipalTermsCache, NfseDeps } from '../nfse/transmission'
import { createApp, loadOpenApi } from '../app'
import type { AppContext } from '../context'
import { WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  const erpFns = Object.fromEntries(Object.entries(actual.erp).map(([k, v]) => [k, typeof v === 'function' ? jest.fn(v as any) : v]))
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    nextDpsNumber: jest.fn(),
    erp: erpFns,
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? jest.fn(v as any) : v]))
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r2-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000042'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 7, role: 'admin', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
const auth = (claims: any = {}) => ({ Authorization: `Bearer ${token(claims)}` })
const appFor = (over: Partial<AppContext> = {}) => createApp({
  ...deps, db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
  verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: false, ...over,
} as AppContext)

const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-09-21 13:15:00', ageMinutes: 30, lastQueriedAt: null,
  lastEvent: null, lastKind: null, lastCode: null, lastMessage: null, lastSource: null, lastDh: null, lastEventAt: null, lastEventAgeMinutes: null, ...over,
})

/** A1 de teste com CN "NOME:CNPJ" (o formato do e-CNPJ que o núcleo lê). */
function pfxFor(cn: string, password = 'senha'): string {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + Math.floor(Math.random() * 1e8).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 5 * 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64')
}

beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  pool.query.mockImplementation(async () => [[]])
  // D-F41: o comando do aluguel chega pela CONEXÃO emprestada (runShortCommand) — ela repassa ao pool o que for do aluguel
  conn.query.mockImplementation(async (sql: string) => (/refresh_lease_until|AS token/.test(String(sql)) ? pool.query(sql) : [[]]))
  erpM.orderInterface.mockResolvedValue('orders')
  erpM.institutionHasInterface.mockResolvedValue(true)
  erpM.userHasPrivilege.mockResolvedValue(true)
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.invoiceLife.mockResolvedValue({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue({
    issuer: { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null },
    cert: Buffer.from('CERT'), key: Buffer.from('KEY'), info: { cnpj: CNPJ, expired: false, notYetValid: false },
  })
  for (const k of ['touchQueriedAt', 'fillAuthorityData']) repoM[k].mockResolvedValue(null)
  repoM.findTransmissionByDpsId.mockResolvedValue(null)
  repoM.listLifeTransmissions.mockResolvedValue({ transmissions: [], events: [] })
})

// ---------------------------------------------------------------------------
describe('[MEDIUM — corrigido; definitivo pela D-F39] CERCA DA VIRADA não depende de configuração de processo', () => {
  // Achado da 2ª rodada: `legacyFromEnv` descartava em silêncio "1;7" / "1 7" e a cerca ABRIA para todo mundo — dois
  // contadores de nDPS (fiscal_api × setes_setes) cunhariam o MESMO Id de DPS para notas diferentes. O retrabalho 2 fez a
  // lista estrita; a D-F39 (Q-F48 (a)) tirou a cerca da configuração: é o FATO `cutover_at` na habilitação (migration
  // 003 do núcleo), lido por todas as instâncias. A variável foi APOSENTADA — defini-la (com qualquer valor) impede o boot.
  const { assertRetiredEnv } = jest.requireActual('../context')

  it('variável antiga definida com QUALQUER valor ("1;7", "1 7", "1|7", "1,7", vazia) → o boot FALHA; ausente → sobe', () => {
    for (const raw of ['1;7', '1 7', '1|7', '1,7', '']) {
      expect(() => assertRetiredEnv({ FISCAL_LEGACY_INSTITUTIONS: raw })).toThrow(/APOSENTADA/)
    }
    expect(() => assertRetiredEnv({})).not.toThrow()
  })

  it('efeito na borda: habilitação RÉPLICA no banco (cutover_at NULL) → transmit 409 FISCAL_CUTOVER_PENDING antes de ler a nota', async () => {
    pool.query.mockImplementation(async (sql: string) => (/SUM\(cutover_at IS NULL\)/.test(sql) ? [[{ n: 1, r: 1 }]] : [[]]))
    const r = await request(appFor()).post(`/v1/nfse/invoices/${INVOICE}/transmit`).set(auth())
    expect([r.status, r.body.code]).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
    expect(erpM.orderInterface).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
describe('[LOW — corrigido] rodízio NÃO engole erro TÉCNICO: mensagem genérica com ref no 200 e logger.error com o ref', () => {
  // `refreshOpenServiceTransmissions` captura QUALQUER erro da nota e devolve `errMsg(err)` no relatório
  // (200 ok) — erro de banco/TypeError do adaptador chega CRU ao app (nome de schema/tabela/coluna, valor de
  // chave) e não passa por `logger.error` com `ref` (regra da casa: erro técnico = 500 + ref no log). Bug
  // persistente do rodízio fica invisível ao suporte. Esperado: técnico → mensagem genérica + ref logado.
  it('erro de banco numa nota da passada → o corpo leva só "Erro interno (ref X)" e o log leva o erro com o MESMO ref', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (/^\s*UPDATE[\s\S]*refresh_lease_until/.test(sql)) return [{ affectedRows: 1 }]
      if (/AS token/.test(sql)) return [[{ token: '2026-10-04 12:01:00' }]]
      return [[]]
    })
    repoM.listRefreshCandidates.mockResolvedValue([tx({ attempt: 3 })])
    const dbErr = Object.assign(new Error("Unknown column 't.secret_col' in 'field list' (setes_setes.tb_invoice_service)"), { code: 'ER_BAD_FIELD_ERROR' })
    repoM.getTransmission.mockRejectedValue(dbErr)
    const report = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB, budgetMs: 1000 })
    expect(report.checked).toBe(1)
    expect(report.errors[0].message).not.toMatch(/Unknown column|setes_setes|tb_invoice_service/)
    expect(report.errors[0]).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/^Erro interno \(ref [0-9A-F]{8}\)$/) })
    const ref = /ref ([0-9A-F]{8})/.exec(report.errors[0].message)![1]
    expect((fiscal.logger.error as jest.Mock).mock.calls.some(c => String(c[0]).includes(ref))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('[LOW — corrigido] CONTRATO (OpenAPI design-first — D-F8): todo status devolvido está declarado no YAML da rota', () => {
  // O YAML é a fonte do contrato (o app gera tratador a partir dele). Rota a rota, o código devolve status
  // que a operação NÃO declara. 401 fica de fora (segurança global). Esperado: YAML declara ou o código
  // devolve um status declarado.
  const doc = loadOpenApi()
  const documented = (method: string, yamlPath: string) => Object.keys(doc.paths?.[yamlPath]?.[method]?.responses ?? {})

  it('PUT issuers/55 → 422 · DELETE issuers/SE sem habilitação → 404 · PUT certificate sem chave-mestra → 503 · transmit id 0 → 400 · XML sem CNPJ do emitente → 422 · cancel com emitente incompleto → 422', async () => {
    const app = appFor()
    erpM.establishmentCnpj.mockImplementation(async () => CNPJ)
    const observed: [string, string, number, string][] = []
    const hit = async (method: 'get' | 'put' | 'delete' | 'post', url: string, yamlPath: string, body?: any) => {
      const r = await (request(app) as any)[method](url).set(auth()).send(body)
      observed.push([method, yamlPath, r.status, r.body?.code ?? ''])
    }
    await hit('put', '/v1/emitter/issuers/55', '/v1/emitter/issuers/{model}', { environment: 'H', serie: '1' })
    await hit('delete', '/v1/emitter/issuers/SE', '/v1/emitter/issuers/{model}')                       // conn.query → sem linha
    await hit('put', '/v1/emitter/certificate', '/v1/emitter/certificate', { pfxBase64: pfxFor(`SETES SISTEMAS LTDA:${CNPJ}`), password: 'senha' })
    await hit('post', '/v1/nfse/invoices/0/transmit', '/v1/nfse/invoices/{invoiceId}/transmit')
    repoM.listLifeTransmissions.mockResolvedValue({ transmissions: [tx({ accessKey: '4'.repeat(50), lastKind: 'A' })], events: [] })
    erpM.establishmentCnpj.mockResolvedValue(null)
    await hit('get', `/v1/nfse/invoices/${INVOICE}/xml`, '/v1/nfse/invoices/{invoiceId}/xml')       // (o DANFSe idem)
    // cancelar NFS-e autorizada com o cadastro do emitente incompleto no PREPARO local → 422 (N libera o K)
    erpM.lockInvoice.mockResolvedValue({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' })
    repoM.latestTransmission.mockResolvedValue(tx({ accessKey: '4'.repeat(50), lastKind: 'A', dhProc: '2026-09-21 13:15:30' }))
    repoM.getTransmission.mockResolvedValue(tx({ accessKey: '4'.repeat(50), lastKind: 'K' }))
    repoM.insertTransmissionEvent.mockResolvedValue(2)
    erpM.entityFiscal.mockResolvedValue(null)
    await hit('post', `/v1/nfse/invoices/${INVOICE}/cancel`, '/v1/nfse/invoices/{invoiceId}/cancel', { reason: 'erro na emissão da nota' })
    const off = observed.filter(([m, p, st]) => st !== 401 && !documented(m, p).includes(String(st)))
    // eslint-disable-next-line no-console
    console.log('[adv-r2] status fora do YAML', JSON.stringify(off))
    expect(observed.map(o => o[2])).toEqual([422, 404, 503, 400, 422, 422])                           // a reprodução em si
    expect(off).toEqual([])
  })
})
