/// <reference types="jest" />
// D-NE172 (Valdo 2026-10-31) — a PRÉ-CONDIÇÃO da janela: os escritores do `fiscal_api` medidos na sessão ESTRITA do pool do núcleo, contra o
// MariaDB REAL, num banco DESCARTÁVEL `fiscal_api_strictdb_<pid>` (núcleo + nfse-api 001…007 pelo runner; APAGADO no afterAll). Cada escritor
// do ciclo é chamado pelo CÓDIGO (as funções de produção, nunca SQL copiado), com valores reais e de BORDA (chave de 50, Id do DPS de 45,
// mensagem do fisco maior que a coluna com emoji no corte, número da NFS-e longo, valores do IBS/CBS no teto): nenhum pode depender do corte
// calado que o servidor do dev fazia sem o modo estrito. Nunca escreve no `fiscal_api` nem nos `setes_*` (a trava da nota é simulada, como no
// adv-ib3-db). Só roda com NFSE_ADV_IB3_DB=1 (credenciais do setes-api — SETES_API_DIR — criam o banco com o nome autorizado).
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import {
  createFiscalPool, runMigrations, withInvoiceTx, invoiceRef, assertSessionInvariants, FiscalDbConfig, MasterKeyRing,
  upsertIssuer, softDeleteIssuer, nextDpsNumber, acquireRefreshLease, renewRefreshLease, releaseRefreshLease, saveCertificate, eraseCertificate,
} from 'fiscal-api'
import { MIGRATION_SETS } from '../migrations'
import {
  insertLifeDps, insertTransmission, insertTransmissionEvent, fillAuthorityData, fillAuthorityIbscbs, touchQueriedAt, recordNfseNotGenerated,
} from '../nfse/repository'

const LIVE = process.env.NFSE_ADV_IB3_DB === '1'
const d = LIVE ? describe : describe.skip

const DB = `fiscal_api_strictdb_${process.pid}`
const INST = 1
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }

function cfg(): FiscalDbConfig {
  const dir = process.env.SETES_API_DIR ?? path.join(__dirname, '..', '..', '..', 'setes-api')   // __tests__ → src → nfse-api → raiz do workspace (3 níveis; 4 caía em D:/setes-api)
  const env = dotenv.parse(fs.readFileSync(path.join(dir, '.env')))
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: DB, connectionLimit: 10 }
}

d('D-NE172 — os escritores do fiscal_api na sessão ESTRITA (motor real, banco descartável)', () => {
  let pool: ReturnType<typeof createFiscalPool>
  const tx = <T>(invoiceId: number, fn: (itx: any) => Promise<T>) =>
    withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: INST }, invoiceRef(INST, invoiceId, 0), { label: 'strict-db', lock: async () => LOCKED as any }, fn)
  const q1 = async (sql: string, p: unknown[] = []) => ((await pool.query(sql, p))[0] as any[])[0]

  beforeAll(async () => {
    const c = cfg()
    expect(c.database).toMatch(/^fiscal_api_strictdb_\d+$/)
    await runMigrations(c, MIGRATION_SETS)
    pool = createFiscalPool(c)
  }, 120_000)

  afterAll(async () => {
    try { await pool?.end() } catch { /* */ }
    const mysql = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))
    const c = cfg()
    const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password })
    try { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``) } finally { await conn.end() }
  }, 60_000)

  it('D-NE173: o EXECUTOR de migrations também é estrito — a migration que grava 8 letras num VARCHAR(5) FALHA ALTO (antes gravava "abcde" calada) e não fica registrada', async () => {
    const os = require('os') as typeof import('os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-mig-'))
    try {
      fs.writeFileSync(path.join(dir, '001_corte.sql'),
        'CREATE TABLE IF NOT EXISTS `tb_strict_probe` (`k` VARCHAR(5) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n'
        + "INSERT INTO `tb_strict_probe` (`k`) VALUES ('abcdefgh');\n")
      await expect(runMigrations(cfg(), [{ project: 'strict-probe', dir }])).rejects.toMatchObject({ errno: 1406 })
      const reg = await q1(`SELECT COUNT(*) n FROM _migrations WHERE project = 'strict-probe'`)
      const rows = await q1(`SELECT COUNT(*) n FROM tb_strict_probe`)
      expect([Number(reg.n), Number(rows.n)]).toEqual([0, 0])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      await pool.query('DROP TABLE IF EXISTS tb_strict_probe')
    }
  })

  it('D-NE174 no motor REAL: com NO_BACKSLASH_ESCAPES o escape do driver QUEBRA (o \' de "O\'Brien" fecha o texto) — e a conferência da casa RECUSA a sessão', async () => {
    const conn = await pool.getConnection()
    try {
      await conn.query(`SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')`)
      await expect(conn.query('SELECT ? AS v', ["O'Brien"])).rejects.toMatchObject({ errno: 1064 })   // o driver mandou 'O\'Brien' — o motor leu 'O\' + Brien'
      // gate socrático L3 — o caso PIOR é o SILENCIOSO: a quebra de linha (o PEM do A1, as mensagens do fisco) chega como barra + 'n' LITERAIS, sem erro
      const [r] = await conn.query('SELECT ? AS v', ['a\nb'])
      expect([(r as any)[0].v, String((r as any)[0].v).length]).toEqual(['a\\nb', 4])
      await expect(assertSessionInvariants({ query: (s: string) => conn.query(s) } as any)).rejects.toThrow(/traz NO_BACKSLASH_ESCAPES herdado do servidor — a casa o recusa \(D-NE174/)
    } finally {
      (conn as any).destroy()                                                            // nunca volta ao pool com o modo alterado
    }
  })

  it('D-NE175 no motor REAL: o servidor passa a entregar NO_BACKSLASH_ESCAPES DEPOIS do boot — a conexão nova é DESTRUÍDA e o comando falha alto (nunca grava a quebra de linha como barra + n)', async () => {
    // simula o servidor sem mexer no GLOBAL: um ouvinte registrado ANTES do da casa liga o modo em toda conexão nova do pool
    const m2 = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))
    const original = m2.createPool
    m2.createPool = (opts: unknown) => {
      const p = original(opts)
      p.on('connection', (c: any) => c.query(`SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')`))
      return p
    }
    let bad: ReturnType<typeof createFiscalPool> | null = null
    try {
      bad = createFiscalPool({ ...cfg(), connectionLimit: 2 })
      // ⚠️ conhecimento negativo: a destruição pela conferência chega num nextTick DEPOIS de o 1º comando ter sido despachado — por isso o SET
      // da casa RETIRA o proibido: o comando que escapa roda LIMPO (ou falha alto, se a conexão já caiu). NUNCA grava a barra + 'n'.
      // gate socrático MEDIUM-1: no pool a destruição chega ANTES do comando de quem pediu (há 4 comandos da casa na frente dele na fila) —
      // TODA tentativa falha alto; a RETIRADA no SET (a cinta) é provada à parte, no teste seguinte, isolada
      const outcomes: string[] = []
      for (let i = 0; i < 3; i++) {
        try { await bad.query('SELECT ? AS v, @@SESSION.sql_mode AS m', ['a\nb']); outcomes.push('respondeu') } catch { outcomes.push('falhou alto') }
      }
      expect(outcomes).toEqual(['falhou alto', 'falhou alto', 'falhou alto'])
    } finally {
      m2.createPool = original
      try { await bad?.end() } catch { /* conexões já destruídas */ }
    }
    // o pool da casa, sem o "servidor torto", segue servindo normalmente
    const [ok] = await pool.query('SELECT ? AS v', ['a\nb'])
    expect((ok as any)[0].v).toBe('a\nb')
  })

  it('D-NE175 no motor REAL — a CINTA isolada: o SET da casa RETIRA os proibidos e os combinados que os trazem (ORACLE, ANSI, MSSQL, POSTGRESQL, DB2), e o escape volta a valer', async () => {
    const { STRICT_SESSION_SQL, SQL_MODES_STRIPPED_FROM_SESSION } = require('fiscal-api')
    const conn = await pool.getConnection()
    try {
      for (const herdado of ['ORACLE,NO_BACKSLASH_ESCAPES', 'ANSI', 'MSSQL,NO_BACKSLASH_ESCAPES', 'POSTGRESQL', 'DB2,ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES']) {
        await conn.query(`SET SESSION sql_mode = '${herdado}'`)
        await conn.query(STRICT_SESSION_SQL)
        const [[m]] = await conn.query('SELECT @@SESSION.sql_mode AS m') as any
        const items = String(m.m).split(',')
        expect([herdado, SQL_MODES_STRIPPED_FROM_SESSION.filter((x: string) => items.includes(x)), items.includes('STRICT_ALL_TABLES')]).toEqual([herdado, [], true])
        const [[r]] = await conn.query('SELECT ? AS v', ["a'b\\c\nd"]) as any
        expect([herdado, r.v]).toEqual([herdado, "a'b\\c\nd"])
      }
    } finally {
      (conn as any).destroy()                                                            // a sessão foi mexida — nunca volta ao pool
    }
  })

  it('a sessão do pool é a ESTRITA (o que tudo abaixo mede)', async () => {
    const s = await assertSessionInvariants(pool)
    expect(s.sqlMode.split(',')).toContain('STRICT_ALL_TABLES')
  })

  it('habilitação: criar (55), excluir, reviver; SE virada: nDPS contínuo e o ALUGUEL do rodízio (tomar, renovar, soltar)', async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const row = await upsertIssuer(conn, 'setes_setes', INST, '55', { environment: 'H', serie: '1', userId: 1 })
      expect([row.model, row.environment, row.serie]).toEqual(['55', 'H', '1'])
      expect(await softDeleteIssuer(conn, 'setes_setes', INST, '55')).toBe(true)
      expect((await upsertIssuer(conn, 'setes_setes', INST, '55', { environment: 'P', serie: '999', userId: 2 })).serie).toBe('999')
      await conn.commit()
    } finally { conn.release() }
    // a SE nasce virada (a habilitação real veio da cópia do ERP na virada — semeada aqui como fato)
    await pool.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted, cutover_at)
                      VALUES (?, 'SE', 'P', '1', 706, 1, NOW(), NOW(), 'N', NOW())`, [INST])
    const c2 = await pool.getConnection()
    try {
      await c2.beginTransaction()
      expect(await nextDpsNumber(c2, INST)).toBe(707)
      expect(await nextDpsNumber(c2, INST)).toBe(708)
      await c2.commit()
    } finally { c2.release() }
    const token = await acquireRefreshLease(pool, INST, 'SE', 210)
    expect(typeof token).toBe('string')
    expect(await renewRefreshLease(pool, INST, 'SE', token!, 210)).toBe(token)
    expect(await releaseRefreshLease(pool, INST, 'SE', token!)).toBe(true)
  })

  it('certificado A1: gravar (segredo cifrado, assunto real de 214 posições) e excluir (segredos viram NULL)', async () => {
    const ring = MasterKeyRing.of({ 1: Buffer.alloc(32, 7) })
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await saveCertificate(conn, {
        institutionId: INST, cnpj: '01234567000189', certificatePem: '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(1800) + '\n-----END CERTIFICATE-----',
        sealedKey: ring.seal(Buffer.from('chave-privada-de-teste'), 'a1:1'),
        subject: 'CN=SETES SOLUCOES LTDA:01234567000189,OU=AR ATIVA,OU=Videoconferencia,OU=12345678000199,OU=Secretaria da Receita Federal do Brasil - RFB,OU=RFB e-CNPJ A1,O=ICP-Brasil,L=CURITIBA,ST=PR,C=BR'.padEnd(214, 'X'),
        issuedBy: 'CN=AC SAFEWEB RFB v5,OU=Secretaria da Receita Federal do Brasil - RFB,O=ICP-Brasil,C=BR',
        notBefore: '2025-10-06T12:00:00.000Z', notAfter: '2027-10-05T12:00:00.000Z',
        fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'), userId: 1,
      })
      const r = await (async () => ((await conn.query('SELECT CHAR_LENGTH(subject) s, CHAR_LENGTH(fingerprint256) f FROM tb_establishment_certificate WHERE tb_institution_id = ?', [INST]))[0] as any[])[0])()
      expect([Number(r.s), Number(r.f)]).toEqual([214, 95])
      expect(await eraseCertificate(conn, INST, 1)).toBe(true)
      await conn.commit()
    } finally { conn.release() }
  })

  it('ciclo da NFS-e: DPS da vida, tentativa, vozes A/R/C/K/F/N (mensagem do fisco maior que a coluna, emoji no corte), registro do fisco, IBS/CBS, consulta e E2404', async () => {
    const INV = 7001
    const dpsId = 'DPS' + '4106902' + '2' + '01234567000189' + '00001' + String(707).padStart(15, '0')   // cMun 7 · tpInsc · CNPJ 14 · série 5 · nDPS 15
    expect(dpsId).toHaveLength(45)
    const attempt = await tx(INV, async itx => {
      await insertLifeDps(itx, { lifeEvent: 1, serie: '1', dpsNumber: 707, dpsId }, 1)
      return insertTransmission(itx, 1, 'P', 1)
    })
    expect(attempt).toBe(1)
    // re-gate socrático (LOW 3): o EMOJI fica no CORTE — 254 unidades + '😀' (par substituto nas posições 254–255): o `slice(0, 255)` do
    // escritor parte o par ao meio e o banco recebe o substituto SOLTO (o mysql2 o grava como U+FFFD) — na sessão estrita nada recusa
    const head = ('Rejeição E0001: ' + 'motivo do fisco com acentuação '.repeat(9)).slice(0, 254)
    const longMsg = head + '😀😀😀'
    expect([head.length, longMsg.slice(0, 255).charCodeAt(254) >= 0xd800 && longMsg.slice(0, 255).charCodeAt(254) <= 0xdbff]).toEqual([254, true])
    await tx(INV, async itx => {
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'R', source: 'P', dh: '2026-11-04 12:00:00', message: longMsg, authorityCode: 'E0001' })
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'K', source: 'P', dh: null, message: null })
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'F', source: 'P', dh: null, message: 'envio reconciliado — sem resposta' })
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'A', source: 'P', dh: '2026-11-04 12:00:01', message: 'Autorizada', authorityCode: '100' })
      await fillAuthorityData(itx, attempt, { accessKey: '4' + '1'.repeat(49) + '999', nfseNumber: '12345678901234567', dhProc: '2026-11-04 12:00:01' })
      expect(await fillAuthorityIbscbs(itx, attempt, '4' + '1'.repeat(49), { totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0.01', cbsValue: '123456789012345.67' }))
        .toEqual({ result: 'inserted' })
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'C', source: 'Q', dh: '2026-11-04 13:00:00', message: 'Cancelada por erro na emissão', authorityCode: '101101' })
      await insertTransmissionEvent(itx, attempt, 1, { kind: 'N', source: 'P', dh: null, message: longMsg })
    })
    await touchQueriedAt(pool, invoiceRef(INST, INV, 0), attempt)
    expect(await recordNfseNotGenerated(pool, invoiceRef(INST, INV, 0), attempt, 6)).toBe(true)

    const t = await q1(`SELECT CHAR_LENGTH(access_key) k, nfse_number n, last_queried_at q, nfse_not_generated_at g FROM tb_invoice_service_transmission WHERE tb_invoice_id = ?`, [INV])
    expect([Number(t.k), t.n, t.q != null, t.g != null]).toEqual([50, '1234567890123', true, true])     // o CÓDIGO corta (50/13) — nunca o banco
    const m = await q1(`SELECT MAX(CHAR_LENGTH(message)) mx, COUNT(*) n FROM tb_invoice_service_transmission_event WHERE tb_invoice_id = ?`, [INV])
    expect([Number(m.n), Number(m.mx) <= 255]).toEqual([6, true])
    const dps = await q1(`SELECT dps_id FROM tb_invoice_service_dps WHERE tb_invoice_id = ?`, [INV])
    expect(dps.dps_id).toBe(dpsId)
  })
})
