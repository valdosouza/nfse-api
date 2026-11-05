/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA do retrabalho da IB-3 (2026-10-15, rodada "ib3y") — o escritor dos valores IBS/CBS (`fillAuthorityIbscbs`:
// leitura sem trava + INSERT … VALUES + SAVEPOINT + `access_key = ?`) contra o MariaDB REAL, num banco DESCARTÁVEL `fiscal_api_ib3y_<pid>`
// (núcleo + nfse-api 001…007 pelo runner; APAGADO no afterAll). Nunca escreve no `fiscal_api` nem nos `setes_*`.
// Só roda com NFSE_ADV_IB3_DB=1 (credenciais do setes-api — SETES_API_DIR — que criam o banco com o nome autorizado).
//   (y1) duas vozes A da MESMA nota COM a trava real (FOR UPDATE) — mesmos valores e valores divergentes
//   (y2) duas vozes A da MESMA nota SEM a trava, a 1ª desfaz depois de gravar — a 2ª grava (nada perdido)
//   (y3) 1205 de verdade no INSERT dos valores (intervalo travado por outra conexão) — compartimento: a voz A segue e o que veio antes fica
//   (y4) ACHADO (LOW): escritor chamado sem `await` — o INSERT sai DEPOIS do COMMIT, em autocommit, fora da trava da nota (NE1A2-02)
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { createFiscalPool, runMigrations, withInvoiceTx, invoiceRef, logger, FiscalDbConfig } from 'fiscal-api'
import { MIGRATION_SETS } from '../migrations'
import { fillAuthorityIbscbs, fillAuthorityData, insertTransmissionEvent } from '../nfse/repository'
import { recordIbscbsValues } from '../nfse/ibscbs-values'

const LIVE = process.env.NFSE_ADV_IB3_DB === '1'
const d = LIVE ? describe : describe.skip

const DB = `fiscal_api_ib3y_${process.pid}`
const INST = 1
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const keyOf = (n: number) => String(n).padStart(50, '7')

function cfg(): FiscalDbConfig {
  const dir = process.env.SETES_API_DIR ?? path.join(__dirname, '..', '..', '..', 'setes-api')   // __tests__ → src → nfse-api → raiz do workspace (3 níveis; 4 caía em D:/setes-api)
  const env = dotenv.parse(fs.readFileSync(path.join(dir, '.env')))
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: DB, connectionLimit: 20 }
}

d('IB-3 ib3y — escritor dos valores IBS/CBS sob ataque no banco descartável', () => {
  let pool: ReturnType<typeof createFiscalPool>
  let rollbackOnTimeout = 0

  /** Trava REAL da nota (o papel do `erp.lockInvoice`): FOR UPDATE numa linha da vida da nota no banco descartável. */
  const realLock = async (conn: any, _schema: string, ref: any) => {
    const [r] = await conn.query(
      `SELECT 1 AS ok FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? FOR UPDATE`,
      [ref.institutionId, ref.invoiceId, ref.terminal])
    return (r as any[]).length ? (LOCKED as any) : null
  }
  const tx = <T>(invoiceId: number, fn: (itx: any) => Promise<T>, lock: 'real' | 'none' = 'none') =>
    withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: INST }, invoiceRef(INST, invoiceId, 0),
      { label: 'adv-ib3y', lock: lock === 'real' ? realLock : async () => LOCKED as any }, fn)

  async function seed(invoiceId: number, attempt: number, key: string | null): Promise<void> {
    await pool.query(
      `INSERT IGNORE INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, deleted)
       VALUES (?, ?, 0, 1, '1', ?, ?, 'N')`, [INST, invoiceId, invoiceId, `DPS${String(invoiceId).padStart(42, '0')}`])
    await pool.query(
      `INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, 1, 'H', ?, NOW(), NOW(), 'N')`, [INST, invoiceId, attempt, key])
  }
  const rowsOf = async (invoiceId: number) => {
    const [r] = await pool.query(
      `SELECT attempt, CAST(total_invoice_value AS CHAR) t, CAST(ibs_total_value AS CHAR) i, CAST(cbs_value AS CHAR) c
         FROM tb_invoice_service_transmission_ibscbs WHERE tb_institution_id = ? AND tb_invoice_id = ?`, [INST, invoiceId])
    return r as any[]
  }

  /** A sequência REAL da voz A (transmissão P ou consulta Q): chave → valores → voz A. */
  const vozA = (invoiceId: number, v: { totalInvoiceValue: string; ibsTotalValue: string; cbsValue: string }, origin: 'transmissao' | 'consulta',
    lock: 'real' | 'none', after?: () => Promise<void>) =>
    tx(invoiceId, async itx => {
      await fillAuthorityData(itx, 1, { accessKey: keyOf(invoiceId), nfseNumber: String(invoiceId), dhProc: '2026-12-20 13:00:00' })
      const r = await fillAuthorityIbscbs(itx, 1, keyOf(invoiceId), v)
      await insertTransmissionEvent(itx, 1, null, { kind: 'A', source: origin === 'transmissao' ? 'P' : 'Q', dh: origin === 'transmissao' ? '2026-12-20 13:00:00' : '2026-12-20 13:00:07', message: 'adv-ib3y' })
      if (after) await after()
      return r.result
    }, lock)

  beforeAll(async () => {
    const c = cfg()
    expect(c.database).toMatch(/^fiscal_api_ib3y_\d+$/)
    const applied = await runMigrations(c, MIGRATION_SETS)
    expect(applied).toContain('nfse-api/007_transmission_ibscbs_values')
    pool = createFiscalPool(c)
    const [v] = await pool.query('SELECT @@innodb_rollback_on_timeout AS rot')
    rollbackOnTimeout = Number((v as any[])[0].rot)
  }, 120_000)

  afterAll(async () => {
    try { await pool?.end() } catch { /* */ }
    const mysql = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))
    const c = cfg()
    const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password })
    try { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``) } finally { await conn.end() }
  }, 60_000)

  it('(y1) MESMA nota, duas vozes A ao mesmo tempo COM a trava real: serializadas — inserted + same, uma linha, zero erro/reexecução', async () => {
    await seed(8101, 1, null)
    const v = { totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' }
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    try {
      const out = await Promise.all([
        vozA(8101, v, 'transmissao', 'real', () => sleep(200)),
        vozA(8101, v, 'consulta', 'real', () => sleep(200)),
      ])
      expect(out.sort()).toEqual(['inserted', 'same'])
      expect(warn.mock.calls.filter(c => /Deadlock/.test(String(c[0])))).toEqual([])
    } finally { warn.mockRestore() }
    expect(await rowsOf(8101)).toEqual([{ attempt: 1, t: '250.00', i: '0.25', c: '2.25' }])
  })

  it('(y1b) MESMA nota COM a trava real e releituras DIVERGENTES: fica a 1ª gravada, a 2ª vê "divergent" (o alarme é de quem chama)', async () => {
    await seed(8102, 1, null)
    const a = { totalInvoiceValue: '250.00', ibsTotalValue: '0.25', cbsValue: '2.25' }
    const b = { totalInvoiceValue: '250.00', ibsTotalValue: '0.30', cbsValue: '2.25' }
    const out = await Promise.all([vozA(8102, a, 'transmissao', 'real', () => sleep(150)), vozA(8102, b, 'consulta', 'real', () => sleep(150))])
    const winner = out[0] === 'inserted' ? a : b
    expect([...out].sort()).toEqual(['divergent', 'inserted'])
    const rows = await rowsOf(8102)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ attempt: 1, t: winner.totalInvoiceValue, i: winner.ibsTotalValue, c: winner.cbsValue })
  })

  it('(y2) MESMA nota SEM a trava: a 1ª grava e DESFAZ (a voz A dela falhou depois) enquanto a 2ª espera no INSERT — a 2ª grava, nada se perde', async () => {
    await seed(8103, 1, null)
    const a = { totalInvoiceValue: '1.00', ibsTotalValue: '0.00', cbsValue: '0.00' }
    const b = { totalInvoiceValue: '2.00', ibsTotalValue: '0.00', cbsValue: '0.00' }
    const silence = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    try {
      const first = vozA(8103, a, 'transmissao', 'none', async () => { await sleep(400); throw new Error('voz A da 1ª falhou depois dos valores') })
      await sleep(100)
      const second = vozA(8103, b, 'consulta', 'none')
      const [r1, r2] = await Promise.allSettled([first, second])
      expect(r1.status).toBe('rejected')
      expect(r2).toEqual({ status: 'fulfilled', value: 'inserted' })
    } finally { silence.mockRestore() }
    expect(await rowsOf(8103)).toEqual([{ attempt: 1, t: '2.00', i: '0.00', c: '0.00' }])
  })

  it('(y3) 1205 DE VERDADE no INSERT dos valores (outra conexão trava o intervalo): compartimento — `failed` ER_LOCK_WAIT_TIMEOUT, a chave gravada antes FICA e a voz A segue', async () => {
    await seed(8301, 1, null)
    const holder = await pool.getConnection()
    const silence = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    try {
      await holder.query('START TRANSACTION')
      // next-key/gap lock cobrindo a PK que o escritor vai inserir (ninguém na produção faz isto — é o jeito de fabricar o 1205)
      await holder.query(
        `SELECT * FROM tb_invoice_service_transmission_ibscbs WHERE tb_institution_id = ? AND tb_invoice_id BETWEEN 8300 AND 8399 FOR UPDATE`, [INST])
      const run = tx(8301, async itx => {
        await itx.conn.query('SET SESSION innodb_lock_wait_timeout = 1')
        try {
          await fillAuthorityData(itx, 1, { accessKey: keyOf(8301), nfseNumber: '8301', dhProc: '2026-12-20 13:00:00' })
          const r = await fillAuthorityIbscbs(itx, 1, keyOf(8301), { totalInvoiceValue: '9.00', ibsTotalValue: '0.00', cbsValue: '0.00' })
          await insertTransmissionEvent(itx, 1, null, { kind: 'A', source: 'P', dh: '2026-12-20 13:00:00', message: 'adv-ib3y-1205' })
          return r
        } finally { await itx.conn.query('SET SESSION innodb_lock_wait_timeout = DEFAULT') }
      })
      if (rollbackOnTimeout === 1) {
        // innodb_rollback_on_timeout ON: o InnoDB desfaz a transação inteira → o savepoint some → repassa (a voz A não grava AQUI; a consulta reconcilia)
        await expect(run).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
      } else {
        expect(await run).toEqual({ result: 'failed', code: 'ER_LOCK_WAIT_TIMEOUT' })
        const [t] = await pool.query(`SELECT access_key k FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = 8301`, [INST])
        expect((t as any[])[0].k).toBe(keyOf(8301))                                          // o que veio ANTES do savepoint ficou
        const [e] = await pool.query(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = 8301`, [INST])
        expect((e as any[]).map(r => r.kind)).toEqual(['A'])                                  // a voz A seguiu
        expect(await rowsOf(8301)).toEqual([])                                               // sem linha de valores (a consulta seguinte preenche)
      }
    } finally {
      silence.mockRestore()
      try { await holder.query('ROLLBACK') } finally { holder.release() }
    }
  }, 30_000)

  it('(y5) DEADLOCK de verdade DENTRO do escritor dos valores: repassa, o núcleo reexecuta a transação INTEIRA — chave, valores e voz A uma vez só', async () => {
    await seed(8501, 1, null)
    const other = await pool.getConnection()
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    let calls = 0
    let otherVictim = false
    try {
      await other.query('START TRANSACTION')
      // peso: a outra escreve várias linhas — o InnoDB escolhe como vítima a transação mais LEVE (a da voz A)
      for (let i = 0; i < 30; i++) {
        await other.query(
          `INSERT INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, deleted)
           VALUES (?, ?, 0, 1, '1', ?, ?, 'N')`, [INST, 8700 + i, 8700 + i, `DPS${String(8700 + i).padStart(42, '0')}`])
      }
      await other.query(`SELECT * FROM tb_invoice_service_transmission_ibscbs WHERE tb_institution_id = ? AND tb_invoice_id BETWEEN 8500 AND 8599 FOR UPDATE`, [INST])
      const run = tx(8501, async itx => {
        calls++
        await fillAuthorityData(itx, 1, { accessKey: keyOf(8501), nfseNumber: '8501', dhProc: '2026-12-20 13:00:00' })
        if (calls === 1) {
          // fecha o ciclo: a outra quer a linha da tentativa que esta já travou (o UPDATE do fillAuthorityData) enquanto esta espera o intervalo
          setTimeout(() => {
            other.query(`UPDATE tb_invoice_service_transmission SET updated_at = NOW() WHERE tb_institution_id = ? AND tb_invoice_id = 8501`, [INST])
              .catch((e: any) => { otherVictim = e?.code === 'ER_LOCK_DEADLOCK' })
              .finally(() => setTimeout(() => { other.query('ROLLBACK').catch(() => undefined) }, 600))
          }, 300)
        }
        const r = await fillAuthorityIbscbs(itx, 1, keyOf(8501), { totalInvoiceValue: '7.00', ibsTotalValue: '0.07', cbsValue: '0.63' })
        await insertTransmissionEvent(itx, 1, null, { kind: 'A', source: 'P', dh: '2026-12-20 13:00:00', message: 'adv-ib3y-1213' })
        return r.result
      })
      expect(await run).toBe('inserted')
      // eslint-disable-next-line no-console
      console.log('(y5)', JSON.stringify({ calls, otherVictim, deadlockRetries: warn.mock.calls.filter(c => /Deadlock/.test(String(c[0]))).length }))
    } finally {
      warn.mockRestore()
      try { await other.query('ROLLBACK') } catch { /* */ } finally { other.release() }
    }
    expect(await rowsOf(8501)).toEqual([{ attempt: 1, t: '7.00', i: '0.07', c: '0.63' }])
    const [e] = await pool.query(`SELECT kind FROM tb_invoice_service_transmission_event WHERE tb_institution_id = ? AND tb_invoice_id = 8501`, [INST])
    expect((e as any[]).map(r => r.kind)).toEqual(['A'])
    const [t] = await pool.query(`SELECT access_key k FROM tb_invoice_service_transmission WHERE tb_institution_id = ? AND tb_invoice_id = 8501`, [INST])
    expect((t as any[])[0].k).toBe(keyOf(8501))
  }, 30_000)

  it('(y4) ACHADO (LOW — NE1A2-02): escritor dos valores chamado SEM await — o INSERT sai DEPOIS do COMMIT (autocommit, fora da trava da nota); a família exige a 2ª conferência do InvoiceTx logo antes de gravar', async () => {
    await seed(8401, 1, keyOf(8401))
    let floating: Promise<unknown> = Promise.resolve()
    await tx(8401, async itx => {
      // o `await` esquecido (a escrita começada dentro do callback termina depois do COMMIT e da devolução da conexão ao pool)
      floating = fillAuthorityIbscbs(itx, 1, keyOf(8401), { totalInvoiceValue: '5.00', ibsTotalValue: '0.00', cbsValue: '0.00' }).catch(e => e)
    })
    await floating
    await sleep(50)
    // desejado: nada gravado fora da transação da nota (o insertTransmissionEvent da família recusa — NE1A2-02)
    expect(await rowsOf(8401)).toEqual([])
  })
})
