/// <reference types="jest" />
// GATE ADVERSARIAL da F1 (testar-adversarial.md §4-6) — achados CONFIRMADOS viram teste permanente.
// Os achados CORRIGIDOS no retrabalho (2026-10-04) viraram `it` (a regra que os fecha); o admin × licença
// (Q-F46) virou a D-F37 e também é `it`. A prova contra o banco REAL (fisco falso)
// está em `adversarial-f1.live.test.ts` (NFSE_ADV_LIVE=1); aqui ficam as reproduções sem banco.
import { withRecord } from './fixture-record'   // NE-1a (D-NE56): a tentativa traz o FATO do registro
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import * as repo from '../nfse/repository'
import { FsFiscalStorage, MasterKeyRing, ProductTokenVerifier } from 'fiscal-api'
import {
  refreshServiceTransmission, reconfirmBeforeLocalCancel, cancelServiceInvoiceAtAuthority, transmitServiceInvoice,
  refreshOpenServiceTransmissions, resetMunicipalTermsCache, NfseDeps,
} from '../nfse/transmission'
import { createApp } from '../app'
import type { AppContext } from '../context'
import { webRef, WEB } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira

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
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-unit-'))
afterAll(() => fs.rmSync(storageRoot, { recursive: true, force: true }))

const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: new FsFiscalStorage(storageRoot), adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000195'
const KEY = '41069022212345678000195000000000012320260921000012'
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>123</nNFSe><dhProc>2026-09-21T10:15:30-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ></emit><DPS><infDPS Id="${DPS_ID}"></infDPS></DPS></infNFSe></NFSe>`

const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? '12345678000195' : '98765432000198', im: null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
const opened = (env: 'H' | 'P' = 'P') => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
})
const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: null, nfseNumber: null, dhProc: null, createdAt: '2026-09-21 13:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: null, lastCode: null, lastMessage: null, lastSource: 'P', lastDh: null, lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})
const header = () => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 100, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 100, aliqIss: 2,
  issValue: 2, issWithheld: 'N', liability: '1', description: 'Licença', totalValue: 100,
})

let locked: any
beforeEach(() => {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[header()]]
    if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
    return [[]]
  })
  // D-F41: o comando do aluguel chega pela CONEXÃO emprestada (runShortCommand) — ela repassa ao pool o que for do aluguel
  conn.query.mockImplementation(async (sql: string) => {
    if (/refresh_lease_until|AS token/.test(sql)) return pool.query(sql)
    if (/FROM `setes_setes`\.tb_invoice_service\s/.test(sql)) return [[{ updatedAt: header().branchUpdatedAt }]]
    if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
    return [[]]
  })
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened('P'))
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  for (const k of ['getLifeDps', 'insertLifeDps', 'fillAuthorityData', 'touchQueriedAt']) repoM[k].mockResolvedValue(null)
  repoM.latestTransmission.mockResolvedValue(null)
  repoM.findTransmissionEventByKind.mockResolvedValue(null)
  repoM.insertTransmission.mockResolvedValue(1)
  repoM.insertTransmissionEvent.mockResolvedValue(1)
  repoM.hasTransmissionEvent.mockResolvedValue(false)
  repoM.listLifeTransmissions.mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
})

// ---------------------------------------------------------------------------
describe('[HIGH — corrigido] vida que atravessa H → P: a chave de um ambiente só pousa numa tentativa DESSE ambiente', () => {
  // Forma REAL do dado da Setes: a 704 (nota 8011) teve 13 tentativas em H e 4 em P no MESMO Id de DPS;
  // a 8005 tem a 1ª tentativa em H. "Cunhou o Id" (Q-ADV2h) e o holder do findTransmissionByDpsId
  // ignoram o AMBIENTE — a chave de P vai para a tentativa H; o cancelamento sai para o host de H, o
  // XML vai para <cnpj>/H/ e o setes-api (só chave de PRODUÇÃO é registro fiscal — Q-CA5) vê homologação.
  const t1H = tx({ attempt: 1, environment: 'H', lastKind: 'R', lastSource: 'P' })
  const t2P = tx({ attempt: 2, environment: 'P', lastKind: null, ageMinutes: 11 })
  const byAttempt = (list: any[]) => async (_q: any, _ref: any, attempt: number) => list.find(t => t.attempt === attempt) ?? null
  /** O titular do Id é procurado SÓ no ambiente pedido (a consulta SQL real filtra `environment`). */
  const byDpsIdIn = (list: any[]) => async (_q: any, _ref: any, _life: number, dpsId: string, env: string) =>
    list.filter(t => t.dpsId === dpsId && t.environment === env).sort((a, b) => a.attempt - b.attempt)[0] ?? null

  it('refresh de envio ambíguo em P: a chave NÃO pode pousar na tentativa H (fillAuthorityData com a tentativa de P)', async () => {
    repoM.latestTransmission.mockResolvedValue(t2P)
    repoM.findTransmissionByDpsId.mockImplementation(byDpsIdIn([t1H, t2P]))
    repoM.getTransmission.mockImplementation(byAttempt([t1H, t2P]))
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await refreshServiceTransmission(deps, A, webRef(A, INVOICE), 'Q')
    expect(repoM.findTransmissionByDpsId.mock.calls[0][4]).toBe('P')                  // o titular é procurado no ambiente da tentativa
    expect(adapter.queryDpsAccessKey.mock.calls[0][0].environment).toBe('P')          // perguntou ao fisco de P…
    const landedOn = repoM.fillAuthorityData.mock.calls.map(c => c[1])
    expect(landedOn).toEqual([2])                                                       // …e a chave de P tem que pousar na tentativa de P (hoje: [1] — a H)
    expect(repoM.insertTransmissionEvent.mock.calls.filter(c => c[2].kind === 'F').map(c => c[3])).toEqual([])  // a de P não pode virar "órfã" (hoje: F na 2)
  })

  it('reconfirmação (D-F29): o "minter" escolhido para receber a chave de P não pode ser a tentativa H', async () => {
    const t2F = tx({ attempt: 2, environment: 'P', lastKind: 'F', lastSource: 'Q' })
    repoM.listLifeTransmissions.mockResolvedValue({ transmissions: [t1H, t2F], events: [] })
    repoM.latestTransmission.mockResolvedValue(t2F)
    repoM.getTransmission.mockImplementation(byAttempt([t1H, t2F]))
    adapter.queryDpsAccessKey.mockResolvedValue(KEY)
    adapter.queryNfse.mockResolvedValue({ accessKey: KEY, status: 'authorized', nfseXml: NFSE_XML, dhProc: '2026-09-21T10:15:30-03:00' })
    await reconfirmBeforeLocalCancel(deps, A, webRef(A, INVOICE)).catch(() => undefined)
    expect(repoM.fillAuthorityData.mock.calls.map(c => c[1])).toEqual([2])               // hoje: [1] (H)
  })

  it('consequência: o pedido de cancelamento vai ao fisco do ambiente de QUEM DETÉM a chave (P → P; NFS-e de H → H)', async () => {
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-21T11:00:00-03:00', eventXml: null, raw: {} })
    for (const env of ['P', 'H'] as const) {
      repoM.latestTransmission.mockResolvedValue(tx({ attempt: 2, environment: env, lastKind: 'A', accessKey: KEY, dhProc: '2026-09-21 13:15:30' }))
      await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), `cancelar a NFS-e de ${env}`)
    }
    expect(adapter.registerEvent.mock.calls.map(c => c[0].environment)).toEqual(['P', 'H'])
  })
})

// ---------------------------------------------------------------------------
describe('[MEDIUM — corrigido] cancelamento no fisco com RESERVA em voo (K antes do fisco)', () => {
  it('dois "Cancelar NFS-e" simultâneos (duplo clique / dois usuários) → UM só e101101 ao fisco; o outro vê K → 409 CANCEL_IN_FLIGHT', async () => {
    // a TRAVA DA NOTA do banco, emulada: lockInvoice espera o commit/rollback de quem a detém
    let held: Promise<void> | null = null
    let free: (() => void) | null = null
    erpM.lockInvoice.mockImplementation(async () => {
      while (held) await held
      held = new Promise<void>(r => { free = r })
      return locked
    })
    const unlock = async () => { const f = free; held = null; free = null; f?.() }
    conn.commit.mockImplementation(unlock)
    conn.rollback.mockImplementation(unlock)
    // a tentativa ACOMPANHA as vozes gravadas (K da reserva → C)
    let kind: string | null = 'A'
    repoM.insertTransmissionEvent.mockImplementation(async (__itx: any, _a: number, _u: any, ev: any) => { kind = ev.kind; return 2 })
    repoM.latestTransmission.mockImplementation(async () => tx({ lastKind: kind, accessKey: KEY, dhProc: '2026-09-21 13:15:30' }))
    adapter.registerEvent.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); return { dhEvento: '2026-09-21T11:00:00-03:00', eventXml: null, raw: {} } })
    const rs = await Promise.allSettled([
      cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'primeiro clique no cancelar'),
      cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'segundo clique no cancelar'),
    ])
    expect(adapter.registerEvent).toHaveBeenCalledTimes(1)
    expect(rs.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((rs.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'FISCAL_CANCEL_IN_FLIGHT' })
    conn.commit.mockReset(); conn.rollback.mockReset()
  })
})

// ---------------------------------------------------------------------------
describe('[MEDIUM — corrigido] reserva de notas DIFERENTES em paralelo: nenhuma leitura travante por intervalo antes do contador', () => {
  it('a trava do CONTADOR (emissor SE FOR UPDATE) vem antes de qualquer leitura travante por intervalo nas tabelas da família', async () => {
    // Prova ao vivo (MariaDB do dev): 6 notas novas em paralelo → 7 deadlocks na "reserva da transmissão" e 1–2 respostas
    // 409 RESOURCE_BUSY mesmo após os 3 retries. Causa: `latestTransmission(conn, …, FOR UPDATE)` de uma nota SEM tentativa
    // trava o GAP do índice (compartilhado por todas as notas novas — supremum), espera o emissor; quem tem o emissor
    // insere no gap → espera o outro. §14.2 manda contador primeiro (regra 7 do PADROES §9).
    adapter.transmit.mockResolvedValue({ accessKey: KEY, nfseNumber: '1', dhProc: null, nfseXml: NFSE_XML, raw: {} })
    await transmitServiceInvoice(deps, A, webRef(A, INVOICE))
    const issuerLockAt = (fiscal.openIssuer as jest.Mock).mock.invocationCallOrder[(fiscal.openIssuer as jest.Mock).mock.calls.findIndex(c => c[3]?.forUpdate)]
    const gapReads = repoM.latestTransmission.mock.calls
      .map((c, i) => ({ forUpdate: c[3] === true, order: repoM.latestTransmission.mock.invocationCallOrder[i] }))
      .filter(x => x.forUpdate)
    expect(gapReads.every(x => x.order > issuerLockAt)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe('[MEDIUM — corrigido] consulta ativa: ALUGUEL em vez de conexão retida (nenhuma aquisição aninhada)', () => {
  it('com o pool de UMA conexão a passada termina (o aluguel é um UPDATE que devolve a conexão)', async () => {
    // pool de capacidade 1 (o mesmo efeito de 20 passadas de 20 institutions com DB_POOL_SIZE=20): a passada segura a
    // conexão do GET_LOCK e pede OUTRA para listar candidatas. Prova ao vivo: 2 passadas × pool real de 2 → TRAVADO.
    let free = 1
    const waiters: (() => void)[] = []
    const acquire = async () => { while (free === 0) await new Promise<void>(r => waiters.push(r)); free-- }
    const releaseSlot = () => { free++; waiters.shift()?.() }
    // D-F41: o comando do aluguel EMPRESTA a conexão (espera curta na sessão) só durante o UPDATE e a devolve
    const lockConn = { query: jest.fn(async (sql: string) => {
      if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }]
      if (/AS token/.test(sql)) return [[{ token: '2026-10-04 12:01:00' }]]
      return [[]]
    }), release: jest.fn(releaseSlot) }
    const tinyPool = {
      getConnection: jest.fn(async () => { await acquire(); return lockConn }),
      query: jest.fn(async (sql: string) => {
        await acquire()
        try {
          if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }]
          if (/AS token/.test(sql)) return [[{ token: '2026-10-04 12:01:00' }]]
          return [[]]
        } finally { releaseSlot() }
      }),
    } as any
    const run = refreshOpenServiceTransmissions({ ...deps, pool: tinyPool }, A, { terminal: WEB, budgetMs: 200 }).then(() => 'terminou')
    const outcome = await Promise.race([run, new Promise(r => setTimeout(() => r('TRAVADO'), 500))])
    expect(outcome).toBe('terminou')
    // nada retido durante a passada: toda conexão emprestada pelo comando do aluguel volta antes do próximo pedido ao pool
    expect(lockConn.release).toHaveBeenCalledTimes(tinyPool.getConnection.mock.calls.length)
  })
})

// ---------------------------------------------------------------------------
describe('licença (D-F14) nas AÇÕES — usuário (gates da F1) e ADMIN (D-F37) corrigidos', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const token = (claims: any) => jwt.sign({ institutionId: 1, userId: 7, schemaName: 'setes_setes', ...claims }, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })
  const appFor = () => createApp({
    ...deps, db: { host: 'x', port: 0, user: 'x', password: 'x', database: 'fiscal_api' },
    verifier: ProductTokenVerifier.of({ k1: pubPem }), corsOrigins: [], checkIdentity: false,
  } as AppContext)

  beforeEach(() => {
    erpM.orderInterface.mockResolvedValue('service-orders')
    erpM.institutionHasInterface.mockResolvedValue(false)      // ramo NÃO contratado (é o caso real da institution 1 no dev)
    pool.query.mockImplementation(async () => [[]])            // a nota nem existe — basta ver se a guarda deixa passar
  })

  // D-F37 (Q-F46 (b)): a licença vale para TODOS — o admin passa só o privilégio.
  it('[D-F37] ADMIN de institution sem a interface do ramo contratada → 403 INTERFACE_NOT_ALLOWED', async () => {
    const r = await request(appFor()).post(`/v1/nfse/invoices/${INVOICE}/transmit`).set('Authorization', `Bearer ${token({ role: 'admin' })}`)
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
  })

  it('usuário com TRANSMITIR (vínculo antigo) mas ramo não contratado → 403 INTERFACE_NOT_ALLOWED', async () => {
    erpM.userHasPrivilege.mockResolvedValue(true)
    const r = await request(appFor()).post(`/v1/nfse/invoices/${INVOICE}/transmit`).set('Authorization', `Bearer ${token({ role: 'user' })}`)
    expect([r.status, r.body.code]).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
  })
})

// ---------------------------------------------------------------------------
describe('[LOW — corrigido] bordas de contrato', () => {
  it('reconfirmar / consultar nota que NÃO existe → 404', async () => {
    erpM.invoiceLife.mockResolvedValue(null)
    await expect(reconfirmBeforeLocalCancel(deps, A, webRef(A, 2147483648))).rejects.toMatchObject({ statusCode: 404 })
    await expect(refreshServiceTransmission(deps, A, webRef(A, 2147483648))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('motivo do cancelamento com caractere de CONTROLE não vai cru no XML assinado (XML 1.0 o proíbe)', async () => {
    repoM.latestTransmission.mockResolvedValue(tx({ lastKind: 'A', accessKey: KEY, dhProc: '2026-09-21 13:15:30' }))
    adapter.registerEvent.mockResolvedValue({ dhEvento: '2026-09-21T11:00:00-03:00', eventXml: null, raw: {} })
    await cancelServiceInvoiceAtAuthority(deps, A, webRef(A, INVOICE), 'erro\u0001 na emissão \u0007 da nota')
    expect(adapter.registerEvent.mock.calls[0][2]).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/)
  })
})
