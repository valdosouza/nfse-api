/// <reference types="jest" />
// GATE ADVERSARIAL da F1 — 3ª RODADA ao vivo (re-prova do delta do retrabalho 2, 2026-10-04): BANCO REAL do
// dev + FISCO FALSO. ⚠️ Só roda com NFSE_ADV_LIVE=1. Mesmo isolamento das rodadas 1/2: adaptador falso E
// transporte HTTPS do núcleo trocado por um que explode (nenhum byte ao fisco real); escreve SÓ no `fiscal_api`
// (o usuário do .env só tem SELECT no ERP — a trava da nota é FOR UPDATE de leitura) e num storage temporário.
// Linhas do ataque marcadas com tb_user_id 990003; o afterAll devolve o `fiscal_api` ao estado de antes
// (habilitação e A1 COMPLETOS, inclusive os blobs) e CONFERE por CHECKSUM TABLE (falha a suíte se sobrar resíduo).
// Alvo: a ORDEM NOVA de travas da reserva (nota → emissor FOR UPDATE → A1 LOCK IN SHARE MODE → DPS → tentativa)
// contra cada escritor concorrente do emitente e contra o cancelamento local do setes-api (trava só a nota).
//
// Uso: NFSE_ADV_LIVE=1 npx jest src/__tests__/adversarial-f1r3.live.test.ts --runInBand
import fs from 'fs'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'
import forge from 'node-forge'
import request from 'supertest'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, FsFiscalStorage, FiscalStorage, HttpError } from 'fiscal-api'
import { contextFromEnv, AppContext } from '../context'
import { disposableFiscalDb, DisposableFiscalDb, attackSession } from './live-harness'
import { createApp } from '../app'
import type { TaxAuthorityAdapter, AuthorityContext } from '../authority/types'
import { resetMunicipalTermsCache } from '../nfse/transmission'
import { refOf } from './fixture-ref'   // NE-1a parte 2: a nota viaja inteira
// parte 2 da NE-1a (D-NE9): as vivas são contadas pelo EMITTER do núcleo (leituras PUBLICADAS de todas as famílias)
const countLiveTransmissions = (q: any, inst: number, environment?: 'H' | 'P') => fiscal.countLiveTransmissions(q, inst, { branches: 'all', environment })

// mesma normalização EM MEMÓRIA das rodadas 1/2: o ramo congelado das notas do dev tem cTribMun "0102"
// (anterior à D-N26b) → 422 antes de reservar. Nada é escrito no ERP.
jest.mock('../facts/service-facts', () => {
  const actual = jest.requireActual('../facts/service-facts')
  return {
    __esModule: true, ...actual,
    readServiceInvoice: async (...args: any[]) => {
      // D-F231: cTribMun normalizado e ramo do ERP Desktop completado pelo ramo-molde da web — SÓ em memória (live-harness)
      return jest.requireActual('./live-harness').completeBranchForAttack(await actual.readServiceInvoice(...args), args)
    },
  }
})

const LIVE = process.env.NFSE_ADV_LIVE === '1'
const d = LIVE ? describe : describe.skip
jest.setTimeout(180_000)

const ROOT = path.resolve(__dirname, '..', '..')
const INST = 1
const SCHEMA = 'setes_setes'
const ADV_USER = 990003                    // marca as linhas do ataque
const CNPJ = '07742094000113'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// FISCO FALSO (registra o contexto mTLS e o XML de cada envio)
// ---------------------------------------------------------------------------
type TransmitMode = 'authorize' | 'reject'
interface Rec { key: string; xml: string; n: string; dpsId: string; env: string }
interface Sent { env: string; cert: string; xml: string }
const fisco = {
  recs: new Map<string, Rec>(),
  transmitMode: 'reject' as TransmitMode,
  sent: [] as Sent[],
  calls: { transmit: 0, query: 0, dps: 0, event: 0 },
}
let seq = 0
const newKey = (dpsId: string) => (`7${dpsId.slice(-12)}${String(Date.now()).slice(-9)}${String(++seq).padStart(4, '0')}`).padEnd(50, '3').slice(0, 50)
const nfseXml = (key: string, dpsId: string, n: string) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><nNFSe>${n}</nNFSe><dhProc>2026-10-04T10:00:00-03:00</dhProc><cStat>100</cStat><emit><CNPJ>${CNPJ}</CNPJ><xNome>ADV</xNome></emit><DPS><infDPS Id="${dpsId}"></infDPS></DPS></infNFSe></NFSe>`
const rejected = () => new AuthorityHttpError(422, 'Fisco rejeitou (400): E0001: teste adversarial r3', 'FISCAL_DPS_REJECTED', 400,
  '{"erros":[{"codigo":"E0001","descricao":"teste adversarial r3"}]}', [{ field: 'dps', message: 'E0001: teste adversarial r3' }])
const notFound = () => new AuthorityHttpError(404, 'Fisco não encontrou o recurso (falso)', 'FISCAL_NFSE_NOT_FOUND', 404, '')

const fakeAdapter: TaxAuthorityAdapter = {
  authority: 'ADN',
  async transmit(ctx: AuthorityContext, xml: string) {
    fisco.calls.transmit++
    fisco.sent.push({ env: ctx.environment, cert: ctx.cert.toString('utf8'), xml })
    const dpsId = /<infDPS\b[^>]*\sId="([^"]*)"/.exec(xml)![1]
    if (fisco.transmitMode === 'reject') throw rejected()
    const k = `${ctx.environment}:${dpsId}`
    let rec = fisco.recs.get(k)
    if (!rec) {
      const key = newKey(dpsId)
      const n = String(700000 + seq)
      rec = { key, xml: nfseXml(key, dpsId, n), n, dpsId, env: ctx.environment }
      fisco.recs.set(k, rec)
    }
    return { accessKey: rec.key, nfseNumber: rec.n, dhProc: '2026-10-04T10:00:00-03:00', nfseXml: rec.xml, raw: {} }
  },
  async queryNfse(ctx: AuthorityContext, accessKey: string) {
    fisco.calls.query++
    const rec = [...fisco.recs.values()].find(r => r.key === accessKey && r.env === ctx.environment)
    if (!rec) throw notFound()
    return { accessKey, status: 'authorized' as const, nfseXml: rec.xml, dhProc: '2026-10-04T10:00:00-03:00' }
  },
  async queryDpsAccessKey(ctx: AuthorityContext, dpsId: string) {
    fisco.calls.dps++
    return fisco.recs.get(`${ctx.environment}:${dpsId}`)?.key ?? null
  },
  async registerEvent() { fisco.calls.event++; throw notFound() },
  async municipalTerms() { return { cancelDays: null, raw: null } },
}
function resetFisco(mode: TransmitMode = 'reject'): void {
  fisco.transmitMode = mode
  fisco.sent = []
  fisco.calls = { transmit: 0, query: 0, dps: 0, event: 0 }
}

// storage: LÊ o arquivo fiscal real, ESCREVE só num temporário
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-adv-r3-'))
class SandboxStorage implements FiscalStorage {
  constructor(private real: FiscalStorage, private tmp: FsFiscalStorage) {}
  save(...a: Parameters<FiscalStorage['save']>) { return this.tmp.save(...a) }
  find(...a: Parameters<FiscalStorage['find']>) { return this.tmp.find(...a) ?? this.real.find(...a) }
  read(ref: string) { return fs.readFileSync(ref, 'utf8') }
  probe() { return this.tmp.probe() }
}

let privPem = ''
const tok = (claims: any = {}) =>
  jwt.sign({ institutionId: INST, userId: ADV_USER, role: 'admin', schemaName: SCHEMA, ...claims }, privPem, { algorithm: 'RS256', keyid: 'default', expiresIn: '1h' })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })

let ctx: AppContext
let harness: DisposableFiscalDb
let attack: { liveAdmin: number; restore(): void } | null = null   // D-F231: a sessão do ataque (live-harness)
let app: any            // cerca DESLIGADA (o ataque exercita a máquina da reserva — fisco falso)
const q = async (sql: string, params: any[] = []) => (await ctx.pool.query(sql, params))[0] as any[]

const TABLES = ['tb_establishment_issuer', 'tb_establishment_certificate', 'tb_invoice_service_dps', 'tb_invoice_service_transmission', 'tb_invoice_service_transmission_event']
const checksums = async () => Object.fromEntries((await q(`CHECKSUM TABLE ${TABLES.join(', ')}`)).map(r => [r.Table, String(r.Checksum)]))

let sumsBefore: Record<string, string> = {}
let issuerBefore: any
let certBefore: any
const maxAttemptBefore = new Map<number, number>()
const dpsBefore = new Set<number>()
const TOUCHED: number[] = []

const CERT_COLS = `cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version, subject, issued_by,
  DATE_FORMAT(not_before, '%Y-%m-%d %H:%i:%s') AS not_before, DATE_FORMAT(not_after, '%Y-%m-%d %H:%i:%s') AS not_after, fingerprint256, tb_user_id,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at, deleted`
async function restoreCertificate(): Promise<void> {
  const c = certBefore
  await q(`UPDATE tb_establishment_certificate SET cnpj = ?, certificate_pem = ?, private_key_cipher = ?, private_key_iv = ?, private_key_tag = ?,
             cipher_key_version = ?, subject = ?, issued_by = ?, not_before = ?, not_after = ?, fingerprint256 = ?, tb_user_id = ?,
             created_at = ?, updated_at = ?, deleted = ? WHERE tb_institution_id = ?`,
    [c.cnpj, c.certificate_pem, c.private_key_cipher, c.private_key_iv, c.private_key_tag, c.cipher_key_version, c.subject, c.issued_by,
     c.not_before, c.not_after, c.fingerprint256, c.tb_user_id, c.created_at, c.updated_at, c.deleted, INST])
}
async function restoreIssuer(): Promise<void> {
  const i = issuerBefore
  await q(`UPDATE tb_establishment_issuer SET environment = ?, serie = ?, dps_last_number = ?, refresh_lease_until = ?, tb_user_id = ?,
             created_at = ?, updated_at = ?, deleted = ?, cutover_at = ? WHERE tb_institution_id = ? AND model = 'SE'`,
    [i.environment, i.serie, i.dps_last_number, i.refresh_lease_until, i.tb_user_id, i.created_at, i.updated_at, i.deleted, i.cutover_at, INST])
}

/** Devolve SÓ a coluna que o "escritor concorrente" mudou (o contador nDPS que a reserva cunhou fica — só o afterAll volta tudo). */
async function revertIssuerColumn(col: 'environment' | 'deleted'): Promise<void> {
  await q(`UPDATE tb_establishment_issuer SET ${col} = ? WHERE tb_institution_id = ? AND model = 'SE'`, [issuerBefore[col], INST])
}

async function txRows(invoiceId: number) {
  return q(`SELECT attempt, environment, access_key AS accessKey, last_kind AS lastKind, dps_id AS dpsId, dps_number AS dpsNumber
              FROM vw_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? ORDER BY attempt`, [INST, invoiceId])
}
const newAttempts = async (id: number) => (await txRows(id)).filter(r => Number(r.attempt) > (maxAttemptBefore.get(id) ?? 0))
const lastOf = async (id: number) => { const r = await txRows(id); return r[r.length - 1] }

/** Espera até o processo da API aparecer BLOQUEADO num SQL que casa com todos os [patterns]. */
async function waitBlocked(blockerCid: number, patterns: RegExp[], ms = 20_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const pl = (await q('SHOW FULL PROCESSLIST')) as any[]
    if (pl.some(p => Number(p.Id) !== blockerCid && patterns.every(re => re.test(String(p.Info ?? ''))))) return true
    await sleep(40)
  }
  return false
}
const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; out: T }> => { const t0 = Date.now(); const out = await fn(); return { ms: Date.now() - t0, out } }

/** A1 de TESTE com o CN do e-CNPJ do emitente (mesmo CNPJ) — o "PUT do A1" concorrente grava ESTE par. */
function testA1(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '0a' + Math.floor(Math.random() * 1e8).toString(16)
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 30 * 86_400_000)
  const attrs = [{ name: 'commonName', value: `ADV R3 TESTE:${CNPJ}` }, { name: 'countryName', value: 'BR' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) }
}

d('GATE ADVERSARIAL F1 — 3ª rodada — ordem de travas da reserva × escritores do emitente (banco real + fisco falso)', () => {
  let X = 0, W = 0
  let rest: number[] = []

  beforeAll(async () => {
    require('dotenv').config({ path: path.join(ROOT, '.env') })
    ;(fiscal as any).transport.request = async () => { throw new Error('ADVERSARIAL r3: rede bloqueada — nenhum fisco real') }
    const cwd = process.cwd(); process.chdir(ROOT)
    // gates R4: o ataque roda numa CÓPIA descartável do fiscal_api (virada SÓ na cópia) — o real nunca é virado
    harness = await disposableFiscalDb(ROOT, 'fiscal_api_adv_r3', { turned: true })
    const base = contextFromEnv(process.env, { adapter: fakeAdapter, checkIdentity: true, pool: harness.pool })
    process.chdir(cwd)
    ctx = { ...base, db: harness.cfg, fiscalDb: harness.cfg.database, storage: new SandboxStorage(base.storage, new FsFiscalStorage(tmpRoot)) }
    attack = await attackSession(fiscal, harness!.pool, SCHEMA, INST)   // D-F231: acesso VIVO de um admin real — depois do ctx (falhar aqui ainda passa pelo afterAll)
    expect(ctx.adapter).toBe(fakeAdapter)
    app = createApp(ctx)
    privPem = fs.readFileSync(path.resolve(ROOT, process.env.DEV_JWT_PRIVATE_KEY_PATH ?? '../setes-api/secrets/jwt/setes-api.private.pem'), 'utf8')

    sumsBefore = await checksums()
    issuerBefore = (await q(`SELECT environment, serie, dps_last_number, tb_user_id, deleted,
                                    DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
                                    DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS refresh_lease_until,
                                    DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutover_at
                               FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0]
    certBefore = (await q(`SELECT ${CERT_COLS} FROM tb_establishment_certificate WHERE tb_institution_id = ?`, [INST]))[0]
    expect(issuerBefore?.deleted).toBe('N')
    expect(certBefore?.certificate_pem).toBeTruthy()
    expect(Buffer.isBuffer(certBefore.private_key_cipher)).toBe(true)
    for (const r of await q(`SELECT tb_invoice_id AS id, MAX(attempt) AS m FROM tb_invoice_service_transmission WHERE tb_institution_id = ? GROUP BY tb_invoice_id`, [INST])) maxAttemptBefore.set(Number(r.id), Number(r.m))
    for (const r of await q(`SELECT tb_invoice_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])) dpsBefore.add(Number(r.id))
    expect(await countLiveTransmissions(ctx.pool, INST)).toBe(0)        // os ataques de travas partem de "nenhuma viva"

    const svc = await import('../facts/service-facts')
    const rows = await q(`SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = 0
      WHERE i.tb_institution_id = ? AND i.terminal = 0 AND i.deleted = 'N' AND l.last_kind = 'E' ORDER BY i.id DESC LIMIT 400`, [INST])
    const fresh: number[] = []
    for (const r of rows) {
      const id = Number(r.id)
      if (maxAttemptBefore.has(id) || dpsBefore.has(id)) continue
      try {
        const h = await svc.readServiceInvoice(ctx.pool, SCHEMA, refOf(INST, id))
        await svc.buildDpsBase(ctx.pool, SCHEMA, INST, h, 'H')
        fresh.push(id)
      } catch { /* cadastro incompleto — não serve de alvo */ }
      if (fresh.length >= 6) break
    }
    // eslint-disable-next-line no-console
    console.log('[adv-r3] notas-alvo frescas', fresh.join(','))
    expect(fresh.length).toBeGreaterThanOrEqual(4)
    ;[X, W, ...rest] = fresh
    TOUCHED.push(...fresh)
  })

  beforeEach(() => { resetFisco(); resetMunicipalTermsCache(); fiscal.erp.resetErpFactsCache() })

  afterAll(async () => {
    if (!ctx) return
    let after: Record<string, string> = {}
    try {
      for (const id of TOUCHED) {
        const before = maxAttemptBefore.get(id) ?? 0
        await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        await q(`DELETE FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = ? AND attempt > ?`, [INST, id, before])
        if (!dpsBefore.has(id)) await q(`DELETE FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, id])
      }
      await q(`DELETE FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_user_id = ?`, [INST, ADV_USER])
      await restoreIssuer()
      await restoreCertificate()
      after = await checksums()
    } finally {
      // eslint-disable-next-line no-console
      console.log('[adv-r3] CHECKSUM antes', JSON.stringify(sumsBefore), '| depois', JSON.stringify(after))
      attack?.restore(); attack = null
      await harness.drop()                                 // apaga a cópia e confere o fiscal_api REAL intocado
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    if (JSON.stringify(after) !== JSON.stringify(sumsBefore)) throw new Error('RESÍDUO no fiscal_api depois do ataque — conferir as tabelas')
  })

  // =========================================================================
  describe('A. PUT do A1 (storeCertificate: X no A1, sem tocar a habilitação) × reserva em curso', () => {
    const out = { blockedSeen: false, status: 0, code: '', sentCert: '', newCert: '', oldCert: '', attempts: [] as any[] }

    it('cenário: o "PUT" grava um A1 NOVO (mesmo CNPJ) e segura a linha; a reserva para na leitura TRAVANTE do A1; o PUT confirma', async () => {
      const a1 = testA1()
      const info = fiscal.certificateInfo(a1.certPem)
      const sealed = ctx.keyring.seal(a1.keyPem, fiscal.certificateAad(INST))
      out.newCert = a1.certPem.trim(); out.oldCert = String(certBefore.certificate_pem).trim()
      const blocker = await ctx.pool.getConnection()
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        const dt = (iso: string) => iso.slice(0, 19).replace('T', ' ')
        await blocker.query(`UPDATE tb_establishment_certificate SET certificate_pem = ?, private_key_cipher = ?, private_key_iv = ?, private_key_tag = ?,
                               cipher_key_version = ?, subject = ?, issued_by = ?, not_before = ?, not_after = ?, fingerprint256 = ?, tb_user_id = ?, updated_at = NOW()
                              WHERE tb_institution_id = ?`,
          [a1.certPem, sealed.cipher, sealed.iv, sealed.tag, sealed.version, info.subject, info.issuer, dt(info.notBefore), dt(info.notAfter), info.fingerprint256, ADV_USER, INST])
        const pending = request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(r => r)
        out.blockedSeen = await waitBlocked(Number(cid), [/tb_establishment_certificate/, /LOCK IN SHARE MODE/i])
        await blocker.commit()
        const r = await pending
        out.status = r.status; out.code = r.body?.code ?? ''
        out.sentCert = fisco.sent[0]?.cert.trim() ?? ''
        out.attempts = await newAttempts(X)
      } finally {
        try { await blocker.rollback() } catch { /* já comitado */ }
        blocker.release()
        await restoreCertificate()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r3] PUT do A1 × reserva:', JSON.stringify({ blockedSeen: out.blockedSeen, status: out.status, code: out.code, envios: fisco.calls.transmit,
        assinouCom: out.sentCert === out.newCert ? 'A1 NOVO' : out.sentCert === out.oldCert ? 'A1 ANTIGO' : '?', tentativas: out.attempts.map(a => `${a.attempt}:${a.environment}:${a.lastKind}`) }))
      expect(out.blockedSeen).toBe(true)
      expect([out.status, out.code]).toEqual([422, 'FISCAL_DPS_REJECTED'])          // fisco falso recusou: a tentativa fechou com R
      expect(fisco.calls.transmit).toBe(1)
    })

    it('regressão (fix R2): a reserva que esperava o A1 assina e fala com o fisco com o A1 ATUAL (o do PUT), nunca o do snapshot', () => {
      expect(out.sentCert).toBe(out.newCert)
      expect(out.attempts.map(a => a.lastKind)).toEqual(['R'])
    })
  })

  // =========================================================================
  describe('B. PUT da habilitação (troca de AMBIENTE P→H) × reserva em curso', () => {
    const out = { blockedSeen: false, status: 0, sentEnv: '', tpAmb: '', attempts: [] as any[] }

    it('cenário: o "PUT" trava a habilitação, confere zero viva e muda o ambiente; a reserva para no FOR UPDATE da habilitação', async () => {
      const blocker = await ctx.pool.getConnection()
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        await blocker.query(`SELECT tb_institution_id FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N' FOR UPDATE`, [INST])
        expect(await countLiveTransmissions(blocker, INST, issuerBefore.environment)).toBe(0)   // a guarda do PUT deixaria trocar
        const pending = request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(r => r)
        out.blockedSeen = await waitBlocked(Number(cid), [/tb_establishment_issuer/, /FOR UPDATE/i])
        await blocker.query(`UPDATE tb_establishment_issuer SET environment = 'H' WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
        await blocker.commit()
        const r = await pending
        out.status = r.status
        out.sentEnv = fisco.sent[0]?.env ?? ''
        out.tpAmb = /<tpAmb>(\d)<\/tpAmb>/.exec(fisco.sent[0]?.xml ?? '')?.[1] ?? ''
        out.attempts = (await newAttempts(X)).slice(1)
      } finally {
        try { await blocker.rollback() } catch { /* já comitado */ }
        blocker.release()
        await revertIssuerColumn('environment')
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r3] PUT da habilitação P→H × reserva:', JSON.stringify({ ...out, attempts: out.attempts.map(a => `${a.attempt}:${a.environment}:${a.lastKind}`) }))
      expect(out.blockedSeen).toBe(true)
      expect(out.status).toBe(422)
    })

    it('regressão (MEDIUM-3 + ordem nova): tentativa, mTLS e tpAmb no ambiente ATUAL (H) — nada no ambiente do snapshot', () => {
      expect(out.attempts.map(a => a.environment)).toEqual(['H'])
      expect([out.sentEnv, out.tpAmb]).toEqual(['H', '2'])
    })
  })

  // =========================================================================
  describe('C. DELETE da habilitação × reserva em curso', () => {
    it('a reserva que esperava a trava acorda, vê a habilitação EXCLUÍDA: 409 FISCAL_ISSUER_MISSING, nada reservado, nada ao fisco, contador intacto', async () => {
      const before = (await txRows(X)).length
      const ctrBefore = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      const blocker = await ctx.pool.getConnection()
      let r: any
      let blockedSeen = false
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        await blocker.query(`SELECT tb_institution_id FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N' FOR UPDATE`, [INST])
        expect(await countLiveTransmissions(blocker, INST)).toBe(0)
        const pending = request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(x => x)
        blockedSeen = await waitBlocked(Number(cid), [/tb_establishment_issuer/, /FOR UPDATE/i])
        await blocker.query(`UPDATE tb_establishment_issuer SET deleted = 'S' WHERE tb_institution_id = ? AND model = 'SE'`, [INST])
        await blocker.commit()
        r = await pending
      } finally {
        try { await blocker.rollback() } catch { /* já comitado */ }
        blocker.release()
        await revertIssuerColumn('deleted')
      }
      const ctrAfter = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      // eslint-disable-next-line no-console
      console.log('[adv-r3] DELETE da habilitação × reserva:', blockedSeen, r.status, r.body.code, '| envios', fisco.calls.transmit, '| tentativas novas', (await txRows(X)).length - before)
      expect(blockedSeen).toBe(true)
      expect([r.status, r.body.code]).toEqual([409, 'FISCAL_ISSUER_MISSING'])
      expect(fisco.calls.transmit).toBe(0)
      expect((await txRows(X)).length).toBe(before)
      expect(ctrAfter).toBe(ctrBefore)
    })
  })

  // =========================================================================
  describe('D. cancelamento LOCAL do setes-api (FOR UPDATE só na NOTA) × reserva × escritores do emitente', () => {
    it('a reserva parada na trava da NOTA não segura o emitente: PUT habilitação, aluguel, guarda do DELETE do A1 e leitura do emitente passam; liberada a nota, a reserva conclui', async () => {
      const blocker = await ctx.pool.getConnection()
      const lat: Record<string, number> = {}
      let r: any
      let blockedSeen = false
      let stillPending = false
      try {
        const [[{ cid }]] = await blocker.query('SELECT CONNECTION_ID() AS cid') as any
        await blocker.beginTransaction()
        await blocker.query(`SELECT id FROM \`${SCHEMA}\`.tb_invoice WHERE id = ? AND tb_institution_id = ? AND terminal = 0 FOR UPDATE`, [X, INST])
        let done = false
        const pending = request(app).post(`/v1/nfse/invoices/${X}/transmit`).set(bearer(tok())).then(x => { done = true; return x })
        blockedSeen = await waitBlocked(Number(cid), [/tb_invoice\b/, /FOR UPDATE/i])
        const a = bearer(tok())
        lat.putIssuer = (await timed(async () => {
          const p = await request(app).put('/v1/emitter/issuers/SE').set(a).send({ environment: issuerBefore.environment, serie: issuerBefore.serie })
          expect(p.status).toBe(200)
        })).ms
        lat.lease = (await timed(async () => {
          const t = await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 60)
          expect(t).toBeTruthy()
          expect(await fiscal.releaseRefreshLease(ctx.pool, INST, 'SE', t!)).toBe(true)
        })).ms
        lat.deleteA1Guard = (await timed(() => fiscal.withTransaction(ctx.pool, 'adv-r3 guarda do DELETE do A1', {}, async conn => {
          await fiscal.getIssuer(conn, INST, 'SE', true)
          await countLiveTransmissions(conn, INST)
          throw Object.assign(new Error('adv-r3: rollback proposital'), { advRollback: true })
        }).catch(e => { if (!e?.advRollback) throw e }))).ms
        lat.getEmitter = (await timed(async () => { expect((await request(app).get('/v1/emitter').set(a)).status).toBe(200) })).ms
        stillPending = !done
        await blocker.commit()
        r = await pending
      } finally {
        try { await blocker.rollback() } catch { /* já comitado */ }
        blocker.release()
      }
      // eslint-disable-next-line no-console
      console.log('[adv-r3] nota travada pelo "setes-api":', JSON.stringify({ blockedSeen, latenciasMs: lat, reservaAindaParada: stillPending, desfecho: [r.status, r.body.code] }))
      expect(blockedSeen).toBe(true)
      expect(stillPending).toBe(true)
      for (const ms of Object.values(lat)) expect(ms).toBeLessThan(3000)
      expect([r.status, r.body.code]).toEqual([422, 'FISCAL_DPS_REJECTED'])
    })
  })

  // =========================================================================
  describe('E. lote de notas JÁ autorizadas (custo da trava do emissor ANTES do 409 — resíduo conhecido, medido)', () => {
    it('12 transmits simultâneos da MESMA nota autorizada + PUT da habilitação no meio: todos 409 FISCAL_ALREADY_AUTHORIZED, nenhum 500/RESOURCE_BUSY, contador intacto', async () => {
      resetFisco('authorize')
      const a = bearer(tok())
      const first = await request(app).post(`/v1/nfse/invoices/${W}/transmit`).set(a)
      expect(first.status).toBe(201)
      const ctr0 = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      const t0 = Date.now()
      const burst = Array.from({ length: 12 }, () => request(app).post(`/v1/nfse/invoices/${W}/transmit`).set(a).then(r => [r.status, r.body.code] as [number, string]))
      const put = timed(() => request(app).put('/v1/emitter/issuers/SE').set(a).send({ environment: issuerBefore.environment, serie: issuerBefore.serie }))
      const outs = await Promise.all(burst)
      const totalMs = Date.now() - t0
      const p = await put
      const ctr1 = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      // eslint-disable-next-line no-console
      console.log('[adv-r3] 12 × transmit de nota autorizada em', totalMs, 'ms |', [...new Set(outs.map(o => o.join(':')))].join(' '), '| PUT habilitação no meio', p.out.status, 'em', p.ms, 'ms | envios', fisco.calls.transmit)
      expect(outs.every(([st, code]) => st === 409 && code === 'FISCAL_ALREADY_AUTHORIZED')).toBe(true)
      expect(p.out.status).toBe(200)
      expect(ctr1).toBe(ctr0)
      expect(fisco.calls.transmit).toBe(1)
    })
  })

  // =========================================================================
  describe('F. estresse misto na ORDEM NOVA de travas (nota → emissor → A1 S → DPS → tentativa)', () => {
    it('N notas em paralelo + PUT habilitação + guarda do DELETE do A1 + aluguel + PUT-sem-escrita do A1: zero 500, zero RESOURCE_BUSY, nDPS únicos e contíguos ao contador', async () => {
      resetFisco('authorize')
      const warn = jest.spyOn(fiscal.logger, 'warn')
      const a = bearer(tok())
      const notes = [X, ...rest]
      const ctr0 = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      const dps0 = new Set((await q(`SELECT tb_invoice_id id FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])).map(r => Number(r.id)))
      const jobs: Promise<[string, number, string]>[] = []
      for (const id of notes) jobs.push(request(app).post(`/v1/nfse/invoices/${id}/transmit`).set(a).then(r => [`transmit ${id}`, r.status, r.body.code ?? 'ok']))
      for (let i = 0; i < 2; i++) {
        jobs.push(request(app).put('/v1/emitter/issuers/SE').set(a).send({ environment: issuerBefore.environment, serie: issuerBefore.serie }).then(r => ['put issuer', r.status, r.body.code ?? 'ok']))
        jobs.push(fiscal.withTransaction(ctx.pool, 'adv-r3 guarda do DELETE do A1', {}, async conn => {
          await fiscal.getIssuer(conn, INST, 'SE', true)
          const live = await countLiveTransmissions(conn, INST)
          await conn.query(`SELECT tb_institution_id FROM tb_establishment_certificate WHERE tb_institution_id = ? FOR UPDATE`, [INST])   // o X do erase
          throw Object.assign(new Error('rollback'), { advRollback: true, live })
        }).then(() => ['delete-a1 guard', 0, '?'] as [string, number, string], e => (e?.advRollback ? ['delete-a1 guard', 200, `vivas=${e.live}`] : ['delete-a1 guard', 500, String(e?.code)]) as [string, number, string]))
        jobs.push(fiscal.withTransaction(ctx.pool, 'adv-r3 PUT do A1 sem escrita', {}, async conn => {
          await conn.query(`UPDATE tb_establishment_certificate SET tb_user_id = tb_user_id WHERE tb_institution_id = ?`, [INST])   // X no A1 (como o saveCertificate), sem mudar dado
          await sleep(150)
        }).then(() => ['put-a1 lock', 200, 'ok'] as [string, number, string], e => ['put-a1 lock', 500, String(e?.code)] as [string, number, string]))
        jobs.push((async () => {
          const t = await fiscal.acquireRefreshLease(ctx.pool, INST, 'SE', 60)
          if (t) await fiscal.releaseRefreshLease(ctx.pool, INST, 'SE', t)
          return ['lease', 200, t ? 'tomado' : 'ocupado'] as [string, number, string]
        })().catch(e => ['lease', 500, String(e?.code)] as [string, number, string]))
      }
      const outs = await Promise.all(jobs)
      const deadlocks = warn.mock.calls.filter(c => /Deadlock/.test(String(c[0]))).length
      warn.mockRestore()
      const ctr1 = Number((await q(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [INST]))[0].n)
      const newDps = (await q(`SELECT tb_invoice_id id, dps_number n FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [INST])).filter(r => !dps0.has(Number(r.id)))
      const nums = newDps.map(r => Number(r.n)).sort((x, y) => x - y)
      const lasts = await Promise.all(notes.map(async id => `${id}:${(await lastOf(id))?.lastKind}`))
      // eslint-disable-next-line no-console
      console.log('[adv-r3] estresse:', JSON.stringify(outs), '| deadlocks reexecutados', deadlocks, '| nDPS novos', nums.join(','), '| contador', ctr0, '→', ctr1, '| última voz', lasts.join(' '))
      expect(outs.filter(o => o[1] >= 500)).toEqual([])
      expect(outs.filter(o => o[2] === 'RESOURCE_BUSY')).toEqual([])
      expect(outs.filter(o => o[0].startsWith('transmit')).every(o => o[1] === 201)).toBe(true)
      expect(new Set(nums).size).toBe(nums.length)
      expect(ctr1 - ctr0).toBe(nums.length)
      if (nums.length) expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => ctr0 + 1 + i))
    })
  })
})

// sanity para o describe.skip não deixar o arquivo "vazio" quando NFSE_ADV_LIVE não está ligado
if (!LIVE) it('adversarial r3 live: desligado (NFSE_ADV_LIVE=1 liga)', () => { expect(HttpError).toBeDefined() })
