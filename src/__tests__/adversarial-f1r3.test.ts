/// <reference types="jest" />
// GATE ADVERSARIAL da F1 — 3ª RODADA (re-prova do delta do retrabalho 2 — testar-adversarial.md §4-6,
// 2026-10-04). Achado CONFIRMADO vira teste permanente: `it.failing` = reproduz o bug (PASSA enquanto o bug
// existe; quando a correção entrar, vira `it`). Cada achado tem um `it` de CENÁRIO antes (pré-condições
// normais — se o cenário não se monta, falha de verdade; o `it.failing` só confere o desfecho). Os 4 LOW daqui
// foram CORRIGIDOS na mesma sessão (cerca só de separadores, YAML da consulta, 415 no envelope, contenção = RESOURCE_BUSY).
// Aqui ficam as reproduções SEM banco; as que dependem do MVCC/SQL real estão em
// `adversarial-f1r3.live.test.ts` (NFSE_ADV_LIVE=1).
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { wireAccess } from './access-stub'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier, transport } from 'fiscal-api'
import { refreshOpenServiceTransmissions, resetMunicipalTermsCache, NfseDeps } from '../nfse/transmission'
import { adnAdapter } from '../authority/adn'
import { createApp, loadOpenApi } from '../app'
import type { AppContext } from '../context'
import { WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  const erpFns = Object.fromEntries(Object.entries(actual.erp).map(([k, v]) => [k, typeof v === 'function' ? jest.fn(v as any) : v]))
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
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
const licensedM = jest.fn()   // licença (interface contratada) — costura A1: o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const repoM = repo as unknown as Record<string, jest.Mock>
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r3-'))
const realRequest = transport.request
afterAll(() => { fs.rmSync(storageRoot, { recursive: true, force: true }); transport.request = realRequest })

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const fakeAdapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: fakeAdapter as any, fiscalDb: 'fiscal_api' }
const ACTOR = { schemaName: 'setes_setes', institutionId: 1, userId: 990003 }
const INVOICE = 6200
const CNPJ = '07742094000113'
const DPS_ID = 'DPS410690220774209400011300001000000000000042'
const KEY = ('4106902' + '2' + CNPJ + '0'.repeat(50)).slice(0, 50)
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}"><nNFSe>42</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const token = (claims: any = {}) => jwt.sign({ institutionId: 1, userId: 990003, role: 'admin', schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
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

beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  transport.request = realRequest
  pool.query.mockImplementation(async () => [[]])
  // D-F41: o comando do aluguel chega pela CONEXÃO emprestada (runShortCommand) — ela repassa ao pool o que for do aluguel
  conn.query.mockImplementation(async (sql: string) => (/refresh_lease_until|AS token/.test(String(sql)) ? pool.query(sql) : [[]]))
  erpM.orderInterface.mockResolvedValue('orders')
  licensedM.mockResolvedValue(true)
  grantedM.mockResolvedValue(true)
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

// ===========================================================================
describe('[LOW — corrigido; definitivo pela D-F39] CERCA DA VIRADA: valor feito só de separadores não abre a cerca', () => {
  // Achado da 3ª rodada: "," / " , " / ",,," passava pelo parser estrito e virava cerca VAZIA. Corrigido na sessão; a
  // D-F39 tirou a cerca da configuração (fato `cutover_at` na habilitação) — QUALQUER valor da variável aposentada
  // impede o boot, então "só separadores" também.
  const { assertRetiredEnv } = jest.requireActual('../context')
  const ONLY_SEPARATORS = [',', ' , ', ',,,', ', ,']

  it('lista feita SÓ de separadores (e qualquer outro valor) → o boot FALHA (variável aposentada)', () => {
    for (const raw of [...ONLY_SEPARATORS, '1,7', '+1', '１']) {
      expect(() => assertRetiredEnv({ FISCAL_LEGACY_INSTITUTIONS: raw })).toThrow(/APOSENTADA/)
    }
  })
})

// ===========================================================================
describe('[LOW] CONTRATO (OpenAPI design-first — D-F8): status REAIS de refresh/reconfirm fora do YAML (resíduo do LOW da R2)', () => {
  // O retrabalho 2 declarou os 6 status que a R2 observou, mas o caminho da CONSULTA ao fisco tem mais dois:
  //  - reconfirm: GET /dps/{id} com 404 SEM o corpo E2404 (gateway/proxy/HTML — Q-ADV1a) → o adaptador ADN
  //    devolve 502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE → a rota responde 502, que o YAML do reconfirm NÃO declara;
  //  - reconfirm/refresh: o fisco responde 400 a uma CONSULTA (ex.: Id/chave fora do leiaute) → o transporte
  //    traduz em 422 FISCAL_DPS_REJECTED → nenhuma das duas rotas declara 422.
  // Exercitado com o ADAPTADOR ADN REAL e o transporte trocado (nenhum socket).
  const doc = loadOpenApi()
  const documented = (method: string, yamlPath: string) => Object.keys(doc.paths?.[yamlPath]?.[method]?.responses ?? {})
  const observed: [string, string, number, string][] = []

  it('cenário: reconfirm com 404 vazio do gateway → 502; reconfirm com 400 do fisco → 422; refresh com 400 do fisco → 422', async () => {
    const app = appFor({ adapter: adnAdapter })
    const candidate = tx({ lastKind: 'F', lastSource: 'Q', environment: 'P', lastEventAt: '2026-10-04 10:00:00' })
    repoM.listLifeTransmissions.mockResolvedValue({ transmissions: [candidate], events: [] })
    const hit = async (url: string, yamlPath: string, reply: { status: number; text: string }) => {
      transport.request = jest.fn(async () => ({ status: reply.status, headers: {}, text: reply.text })) as any
      const r = await request(app).post(url).set(auth())
      observed.push(['post', yamlPath, r.status, r.body?.code ?? ''])
    }
    await hit(`/v1/nfse/invoices/${INVOICE}/reconfirm`, '/v1/nfse/invoices/{invoiceId}/reconfirm', { status: 404, text: '<html>Not Found</html>' })
    await hit(`/v1/nfse/invoices/${INVOICE}/reconfirm`, '/v1/nfse/invoices/{invoiceId}/reconfirm', { status: 400, text: '{"erros":[{"codigo":"E0001","descricao":"Id inválido"}]}' })
    repoM.latestTransmission.mockResolvedValue(tx({ accessKey: KEY, lastKind: 'A', lastSource: 'P', nfseNumber: '42' }))
    await hit(`/v1/nfse/invoices/${INVOICE}/refresh`, '/v1/nfse/invoices/{invoiceId}/refresh', { status: 400, text: '{"erros":[{"codigo":"E0002","descricao":"Chave inválida"}]}' })
    // eslint-disable-next-line no-console
    console.log('[adv-r3] status observados', JSON.stringify(observed), '| declarados reconfirm', documented('post', '/v1/nfse/invoices/{invoiceId}/reconfirm'), '| refresh', documented('post', '/v1/nfse/invoices/{invoiceId}/refresh'))
    expect(observed.map(o => [o[2], o[3]])).toEqual([[502, 'FISCAL_AUTHORITY_UNKNOWN_RESPONSE'], [422, 'FISCAL_DPS_REJECTED'], [422, 'FISCAL_DPS_REJECTED']])
  })

  it('[corrigido — LOW] todo status observado está declarado no YAML da operação', () => {
    expect(observed).toHaveLength(3)
    expect(observed.filter(([m, p, st]) => !documented(m, p).includes(String(st)))).toEqual([])
  })
})

// ===========================================================================
describe('[LOW] borda: corpo com charset/encoding não suportado vira 500 + logger.error — SEM autenticação', () => {
  // `express.json()` roda ANTES da autenticação (app.ts). O body-parser recusa charset ≠ utf-* e encoding
  // fora de gzip/deflate/identity com erro 415 de `type` próprio ('charset.unsupported' / 'encoding.unsupported');
  // o `errorMiddleware` do núcleo só conhece 'entity.parse.failed' e 'entity.too.large' — o resto cai no
  // `sendError` → 500 INTERNAL com ref e `logger.error` com stack. Erro do CLIENTE tratado como crash do
  // servidor (regra da casa: 500 só para erro técnico), disparável por qualquer um sem token (ruído de log).
  const observed: [string, number, string][] = []
  let errorLogs = -1

  it('cenário: sem token, POST com charset latin1 e com Content-Encoding br chegam ao middleware de erro', async () => {
    const app = appFor()
    // o errorMiddleware usa o logger INTERNO do núcleo (não o mock desta suíte) — conta-se no console.error
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const a = await request(app).post('/v1/nfse/refresh').set('Content-Type', 'application/json; charset=latin1').send('{}')
    const b = await request(app).post('/v1/nfse/refresh').set('Content-Type', 'application/json').set('Content-Encoding', 'br').send('{}')
    observed.push(['charset latin1', a.status, a.body?.code ?? ''], ['encoding br', b.status, b.body?.code ?? ''])
    errorLogs = spy.mock.calls.filter(c => /\[ERROR\]/.test(String(c[0]))).length
    spy.mockRestore()
    // eslint-disable-next-line no-console
    console.log('[adv-r3] corpo não suportado sem token', JSON.stringify(observed), '| logger.error (console) chamado', errorLogs, 'vez(es)')
    expect(observed.every(([, st]) => st !== 401)).toBe(true)                 // nem chega à autenticação
  })

  it('[corrigido — LOW] erro de corpo do cliente responde 4xx (415/400) no envelope, sem logger.error', () => {
    expect(observed).toHaveLength(2)
    for (const [, st] of observed) expect(st >= 400 && st < 500).toBe(true)
    expect(errorLogs).toBe(0)
  })
})

// ===========================================================================
describe('[LOW] rodízio: CONTENÇÃO numa nota vira "Erro interno (ref X)" + logger.error (fix 5 da R2 classifica contenção como crash)', () => {
  // Retrabalho 2: "só HttpError vai com a mensagem; o resto vira Erro interno (ref X) + logger.error". Lock
  // wait (1205) e deadlock esgotado (1213) não são HttpError → o relatório da passada diz INTERNAL e o log
  // registra ERRO com stack. A regra da casa (Q-A3, `contentionToHttpError` do núcleo) é: contenção que chega
  // à borda é 409 RESOURCE_BUSY, nunca erro interno. Caso real: a passada visita uma nota cujo cancelamento
  // LOCAL está em curso no setes-api (FOR UPDATE na mesma linha, D-F27) — `lockInvoice` espera 50 s e estoura.
  const lockWait = () => Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 })
  let report: any
  let errorLogs = -1

  it('cenário: nota candidata autorizada, fisco responde, a trava da nota estoura por espera (1205)', async () => {
    pool.query.mockImplementation(async (sql: string) => {
      if (/^\s*UPDATE[\s\S]*refresh_lease_until/.test(sql)) return [{ affectedRows: 1 }]
      if (/AS token/.test(sql)) return [[{ token: '2026-10-04 12:01:00' }]]
      return [[]]
    })
    repoM.listRefreshCandidates.mockResolvedValue([tx({ accessKey: KEY, lastKind: 'A', attempt: 1 })])
    repoM.getTransmission.mockResolvedValue(tx({ accessKey: KEY, lastKind: 'A', attempt: 1 }))
    fakeAdapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-10-04T10:00:00-03:00' })
    erpM.lockInvoice.mockRejectedValue(lockWait())
    report = await refreshOpenServiceTransmissions(deps, ACTOR, { terminal: WEB, budgetMs: 1000 })
    errorLogs = (fiscal.logger.error as jest.Mock).mock.calls.length
    // eslint-disable-next-line no-console
    console.log('[adv-r3] passada com contenção', JSON.stringify(report.errors), '| logger.error', (fiscal.logger.error as jest.Mock).mock.calls.length)
    expect(report.checked).toBe(1)
    expect(report.errors).toHaveLength(1)
    expect(fiscal.contentionToHttpError(lockWait())?.code).toBe('RESOURCE_BUSY')   // a regra da casa para o MESMO erro
  })

  // D-F238 (2026-11-15): a trava estourou DEPOIS de o fisco responder — o código é o da resposta não gravada, nunca INTERNAL
  it('[corrigido — LOW] contenção no relatório da passada sai como código de contenção (FISCAL_OUTCOME_NOT_RECORDED depois do fisco — D-F238), sem logger.error de crash', () => {
    expect(report.errors[0].code).toBe('FISCAL_OUTCOME_NOT_RECORDED')
    expect(errorLogs).toBe(0)
  })
})
