/// <reference types="jest" />
// GATE ADVERSARIAL da IB-3 (2026-10-15) — migration 007 e o escritor write-once dos valores IBS/CBS contra o MariaDB REAL, num banco
// DESCARTÁVEL `fiscal_api_ib3adv_<pid>` (criado pelo runner de migrations do núcleo — núcleo + nfse-api 001…007 — e APAGADO no afterAll).
// Nunca escreve no `fiscal_api` nem nos `setes_*`. Só roda com NFSE_ADV_IB3_DB=1 (usa as credenciais do setes-api — SETES_API_DIR —, que
// podem criar o banco com o nome autorizado; o usuário da nfse-api só cria `fiscal_api_adv%`).
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { createFiscalPool, runMigrations, splitStatements, withInvoiceTx, invoiceRef, logger, FiscalDbConfig } from 'fiscal-api'
import { MIGRATION_SETS, NFSE_MIGRATIONS_DIR } from '../migrations'
import { fillAuthorityIbscbs, getIbscbsValues, fillAuthorityData, insertTransmissionEvent } from '../nfse/repository'
import { recordIbscbsValues } from '../nfse/ibscbs-values'
import { assertServiceStrictSession } from '../nfse/voice-family'

const LIVE = process.env.NFSE_ADV_IB3_DB === '1'
const d = LIVE ? describe : describe.skip

const DB = `fiscal_api_ib3adv_${process.pid}`
const INST = 1
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function cfg(): FiscalDbConfig {
  const dir = process.env.SETES_API_DIR ?? path.join(__dirname, '..', '..', '..', 'setes-api')   // __tests__ → src → nfse-api → raiz do workspace (3 níveis; 4 caía em D:setes-api)
  const env = dotenv.parse(fs.readFileSync(path.join(dir, '.env')))
  return { host: env.DB_HOST, port: Number(env.DB_PORT ?? 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: DB, connectionLimit: 40 }
}

d('migration 007 + escritor dos valores IBS/CBS no banco descartável', () => {
  let pool: ReturnType<typeof createFiscalPool>
  const tx = <T>(invoiceId: number, fn: (itx: any) => Promise<T>) =>
    withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: INST }, invoiceRef(INST, invoiceId, 0), { label: 'adv-ib3', lock: async () => LOCKED as any }, fn)

  async function seed(invoiceId: number, attempt: number, key: string | null): Promise<void> {
    await pool.query(
      `INSERT IGNORE INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, deleted)
       VALUES (?, ?, 0, 1, '1', ?, ?, 'N')`, [INST, invoiceId, invoiceId, `DPS${String(invoiceId).padStart(42, '0')}`])
    await pool.query(
      `INSERT INTO tb_invoice_service_transmission (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, created_at, updated_at, deleted)
       VALUES (?, ?, 0, ?, 1, 'H', ?, NOW(), NOW(), 'N')`, [INST, invoiceId, attempt, key])
  }
  const keyOf = (n: number) => String(n).padStart(50, '9')

  beforeAll(async () => {
    const c = cfg()
    expect(c.database).toMatch(/^fiscal_api_ib3adv_\d+$/)
    const applied = await runMigrations(c, MIGRATION_SETS)
    expect(applied).toContain('nfse-api/007_transmission_ibscbs_values')
    pool = createFiscalPool(c)
  }, 120_000)

  afterAll(async () => {
    try { await pool?.end() } catch { /* */ }
    // o banco descartável SEMPRE sai (inclusive em falha)
    const mysql = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))
    const c = cfg()
    const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password })
    try { await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``) } finally { await conn.end() }
  }, 60_000)

  it('(d1) forma da tabela: DECIMAL(17,2) NOT NULL ×3, PK = a da tentativa, FK para ela e o CHECK de não-negativo', async () => {
    const [r] = await pool.query('SHOW CREATE TABLE tb_invoice_service_transmission_ibscbs')
    const ddl = String((r as any)[0]['Create Table'])
    expect(ddl).toMatch(/`total_invoice_value` decimal\(17,2\) NOT NULL/)
    expect(ddl).toMatch(/`ibs_total_value` decimal\(17,2\) NOT NULL/)
    expect(ddl).toMatch(/`cbs_value` decimal\(17,2\) NOT NULL/)
    expect(ddl).toMatch(/PRIMARY KEY \(`tb_institution_id`,`tb_invoice_id`,`terminal`,`attempt`\)/)
    expect(ddl).toMatch(/CONSTRAINT `fk_invoice_service_transmission_ibscbs_attempt` FOREIGN KEY/)
    expect(ddl).toMatch(/CONSTRAINT `ck_invoice_service_transmission_ibscbs_values` CHECK/)
  })

  it('(d2) RE-EXECUTÁVEL: a 007 roda de novo por cima (runner com a linha apagada do _migrations e os comandos crus) sem erro', async () => {
    await pool.query(`DELETE FROM _migrations WHERE project = 'nfse-api' AND version = '007'`)
    expect(await runMigrations(cfg(), MIGRATION_SETS)).toEqual(['nfse-api/007_transmission_ibscbs_values'])
    const sql = fs.readFileSync(path.join(NFSE_MIGRATIONS_DIR, '007_transmission_ibscbs_values.sql'), 'utf8')
    for (const st of splitStatements(sql)) await pool.query(st)
  })

  it('(d3) CHECK e FK do banco: negativo e tentativa inexistente são RECUSADOS (cinto além do TSDec15V2)', async () => {
    await seed(9001, 1, keyOf(9001))
    await expect(pool.query(
      `INSERT INTO tb_invoice_service_transmission_ibscbs (tb_institution_id, tb_invoice_id, terminal, attempt, total_invoice_value, ibs_total_value, cbs_value)
       VALUES (?, 9001, 0, 1, '-0.01', '0', '0')`, [INST])).rejects.toThrow(/CONSTRAINT|ck_invoice_service_transmission_ibscbs_values/i)
    await expect(pool.query(
      `INSERT INTO tb_invoice_service_transmission_ibscbs (tb_institution_id, tb_invoice_id, terminal, attempt, total_invoice_value, ibs_total_value, cbs_value)
       VALUES (?, 9001, 0, 77, '1', '0', '0')`, [INST])).rejects.toThrow(/foreign key/i)
  })

  // D-NE172 (Valdo 2026-10-31): a sessão do pool do núcleo é ESTRITA — o que antes o servidor do dev CORTAVA calado agora é RECUSADO.
  const BIG_INSERT = `INSERT INTO tb_invoice_service_transmission_ibscbs (tb_institution_id, tb_invoice_id, terminal, attempt, total_invoice_value, ibs_total_value, cbs_value)
         VALUES (?, 9001, 0, 1, '1000000000000000.00', '0', '0')`
  /** Uma conexão SEPARADA (fora do pool) com o modo do servidor SEM o estrito — o que qualquer escrita por fora do núcleo teria. */
  async function looseConnection() {
    const mysql = require(path.join(__dirname, '..', '..', '..', 'fiscal-api', 'node_modules', 'mysql2', 'promise'))
    const c = cfg()
    const conn = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: DB, timezone: 'Z' })
    await conn.query(`SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',STRICT_ALL_TABLES,', ','))`)
    const [[m]] = await conn.query('SELECT @@SESSION.sql_mode AS m')
    expect(String(m.m)).not.toMatch(/STRICT_ALL_TABLES/)
    return conn
  }
  it('(d4) D-NE172: pela sessão do pool (ESTRITA) 16 inteiros direto no banco são RECUSADOS (1264) — antes, o servidor do dev os CORTAVA calado', async () => {
    const conn = await pool.getConnection()
    try {
      await conn.query('START TRANSACTION')
      await expect(conn.query(BIG_INSERT, [INST])).rejects.toMatchObject({ errno: 1264 })
    } finally {
      await conn.query('ROLLBACK'); conn.release()
    }
  })
  it('(d4b) CONHECIMENTO NEGATIVO: numa sessão SEM o modo estrito (escrita por fora do pool) os 16 inteiros ainda são CORTADOS para 999999999999999.99 — o TSDec15V2 do leitor segue sendo a guarda de quem escreve por fora', async () => {
    const conn = await looseConnection()
    try {
      await conn.query('START TRANSACTION')
      await conn.query(BIG_INSERT, [INST])
      const [w] = await conn.query('SHOW WARNINGS')
      const [r] = await conn.query(`SELECT CAST(total_invoice_value AS CHAR) t FROM tb_invoice_service_transmission_ibscbs WHERE tb_invoice_id = 9001`)
      expect((r as any)[0].t).toBe('999999999999999.99')
      expect(JSON.stringify(w)).toMatch(/Out of range/i)
    } finally {
      await conn.query('ROLLBACK'); await conn.end()
    }
  })
  it('(d4c) D-NE172 no motor REAL: a sonda do boot da NFS-e passa pelo pool estrito e FALHA ALTO numa sessão sem o modo (a chave de 51 seria cortada nas 50)', async () => {
    await expect(assertServiceStrictSession(pool)).resolves.toBeUndefined()
    const conn = await looseConnection()
    const loosePool = { getConnection: async () => Object.assign(conn, { release: () => undefined }) } as any
    try {
      await expect(assertServiceStrictSession(loosePool)).rejects.toThrow(/ACEITOU a chave de acesso da tentativa da NFS-e maior que a coluna .* a sessão NÃO é estrita/)
      const [[left]] = await conn.query(`SELECT COUNT(*) AS n FROM tb_invoice_service_transmission WHERE CHAR_LENGTH(access_key) >= 50 AND attempt = 7`)
      expect(Number(left.n)).toBe(0)                                                    // a sonda foi DESFEITA
    } finally {
      await conn.end()
    }
  })

  it('(d5) o maior TSDec15V2 (15 inteiros) grava e volta EXATO pelo escritor e pela tela; same/divergent/no-key no banco de verdade', async () => {
    const big = { totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0.01', cbsValue: '123456789012345.67' }
    expect(await tx(9001, itx => fillAuthorityIbscbs(itx, 1, keyOf(9001), big))).toEqual({ result: 'inserted' })
    expect(await getIbscbsValues(pool, invoiceRef(INST, 9001, 0), 1)).toEqual(big)
    expect(await tx(9001, itx => fillAuthorityIbscbs(itx, 1, keyOf(9001), { ...big }))).toEqual({ result: 'same' })
    expect(await tx(9001, itx => fillAuthorityIbscbs(itx, 1, keyOf(9001), { ...big, cbsValue: '0' }))).toEqual({ result: 'divergent' })
    expect(await getIbscbsValues(pool, invoiceRef(INST, 9001, 0), 1)).toEqual(big)        // fica a 1ª
    await seed(9001, 2, null)
    expect(await tx(9001, itx => fillAuthorityIbscbs(itx, 2, keyOf(9001), big))).toEqual({ result: 'no-key' })
    expect(await tx(9001, itx => fillAuthorityIbscbs(itx, 1, keyOf(9999), big))).toEqual({ result: 'no-key' })   // a tentativa tem OUTRA chave
    const [n] = await pool.query(`SELECT COUNT(*) n FROM tb_invoice_service_transmission_ibscbs WHERE tb_invoice_id = 9001`)
    expect(Number((n as any)[0].n)).toBe(1)
  })

  it('(d6) corrida na MESMA tentativa (duas conexões, sem a trava da nota): uma linha só, nenhum erro (o 1213 é reexecutado pelo núcleo)', async () => {
    await seed(9002, 1, keyOf(9002))
    const v = { totalInvoiceValue: '10.00', ibsTotalValue: '0.10', cbsValue: '0.90' }
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    try {
      const out = await Promise.all([1, 2].map(() => tx(9002, async itx => { const r = await fillAuthorityIbscbs(itx, 1, keyOf(9002), v); await sleep(150); return r.result })))
      expect(out.sort()).toEqual(['inserted', 'same'])
    } finally { warn.mockRestore() }
    const [n] = await pool.query(`SELECT COUNT(*) n FROM tb_invoice_service_transmission_ibscbs WHERE tb_invoice_id = 9002`)
    expect(Number((n as any)[0].n)).toBe(1)
  })

  /**
   * Corrida entre NOTAS DIFERENTES da mesma institution: a sequência REAL da voz A (fillAuthorityData → valores → insertTransmissionEvent A) em [conc] notas da MESMA
   * institution ao mesmo tempo, [rounds] rodadas, retenção curta. withIbscbs=false = a linha de base pré-IB-3 (só os escritores antigos).
   */
  async function vozA(conc: number, rounds: number, withIbscbs: boolean, base: number) {
    const v = { totalInvoiceValue: '10.00', ibsTotalValue: '0.10', cbsValue: '0.90' }
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    const silence = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    let failed = 0, ok = 0
    try {
      for (let r = 0; r < rounds; r++) {
        const ids = Array.from({ length: conc }, (_, i) => base + r * conc + i)
        for (const id of ids) await seed(id, 1, null)
        const out = await Promise.allSettled(ids.map(id => tx(id, async itx => {
          await fillAuthorityData(itx, 1, { accessKey: keyOf(id), nfseNumber: String(id), dhProc: '2026-12-20 13:00:00' })
          if (withIbscbs) await recordIbscbsValues(itx, 1, { declaredInDps: true, values: v }, { institutionId: INST, invoiceId: id, origin: 'transmissao', accessKey: keyOf(id) })
          await sleep(20)
          await insertTransmissionEvent(itx, 1, null, { kind: 'A', source: 'P', dh: '2026-12-20 13:00:00', message: 'adv' })
        })))
        for (const o of out) o.status === 'fulfilled' ? ok++ : failed++
      }
      return { ok, failed, deadlockRetries: warn.mock.calls.filter(c => /Deadlock/.test(String(c[0]))).length }
    } finally { warn.mockRestore(); silence.mockRestore() }
  }

  it('(d8) LINHA DE BASE pré-IB-3 (sem os valores): vozes A concorrentes da mesma institution nunca se travam', async () => {
    const r2 = await vozA(2, 30, false, 20000)
    const r5 = await vozA(5, 30, false, 30000)
    // eslint-disable-next-line no-console
    console.log('(d8) base', JSON.stringify({ r2, r5 }))
    expect([r2.failed, r5.failed, r2.deadlockRetries, r5.deadlockRetries]).toEqual([0, 0, 0, 0])
  }, 120_000)

  it('(d9) ACHADO (MEDIUM) — com a IB-3 (valores dentro da voz A): o INSERT … SELECT … NOT EXISTS trava o INTERVALO do índice e vozes A de notas DIFERENTES entram em deadlock', async () => {
    const r2 = await vozA(2, 30, true, 40000)
    const r5 = await vozA(5, 30, true, 50000)
    const r10 = await vozA(10, 15, true, 60000)
    // eslint-disable-next-line no-console
    console.log('(d9) ib3', JSON.stringify({ r2, r5, r10 }))
    expect({ failed: r2.failed + r5.failed + r10.failed, deadlockRetries: r2.deadlockRetries + r5.deadlockRetries + r10.deadlockRetries }).toEqual({ failed: 0, deadlockRetries: 0 })
  }, 120_000)

  it('(d10) cenário REALISTA: 5 lotes sequenciais em paralelo (5 abas/operadores da mesma institution), fisco 300–1200 ms entre uma voz A e a próxima', async () => {
    const v = { totalInvoiceValue: '10.00', ibsTotalValue: '0.10', cbsValue: '0.90' }
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as any)
    const silence = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    let ok = 0, failed = 0
    try {
      await Promise.all(Array.from({ length: 5 }, async (_, w) => {
        for (let i = 0; i < 15; i++) {
          const id = 70000 + w * 100 + i
          await seed(id, 1, null)
          await sleep(300 + Math.floor(Math.random() * 900))                // o POST /nfse do fisco (fora da transação)
          try {
            await tx(id, async itx => {
              await fillAuthorityData(itx, 1, { accessKey: keyOf(id), nfseNumber: String(id), dhProc: '2026-12-20 13:00:00' })
              await recordIbscbsValues(itx, 1, { declaredInDps: true, values: v }, { institutionId: INST, invoiceId: id, origin: 'transmissao', accessKey: keyOf(id) })
              await sleep(20)
              await insertTransmissionEvent(itx, 1, null, { kind: 'A', source: 'P', dh: '2026-12-20 13:00:00', message: 'adv' })
            })
            ok++
          } catch { failed++ }
        }
      }))
      // eslint-disable-next-line no-console
      console.log('(d10) realista', JSON.stringify({ ok, failed, deadlockRetries: warn.mock.calls.filter(c => /Deadlock/.test(String(c[0]))).length }))
      expect(failed).toBe(0)                                                // no realista a reexecução do núcleo absorve (o achado é o (d9))
    } finally { warn.mockRestore(); silence.mockRestore() }
  }, 120_000)

  it('(c) ACHADO (MEDIUM — mesma raiz do d9): um erro do banco no INSERT dos valores DERRUBA a transação da voz A (a peça promete "nunca lança por causa dos valores")', async () => {
    // a 007 sumiu (ou: 1205 na espera do intervalo, deadlock esgotado, FK…) — o efeito é o mesmo: a exceção sai do recordIbscbsValues
    await seed(9200, 1, keyOf(9200))
    const vozA = jest.fn()
    await pool.query('RENAME TABLE tb_invoice_service_transmission_ibscbs TO tb_invoice_service_transmission_ibscbs_off')
    const silence = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any)
    try {
      const run = tx(9200, async itx => {
        await recordIbscbsValues(itx, 1, { declaredInDps: true, values: { totalInvoiceValue: '1.00', ibsTotalValue: '0.00', cbsValue: '0.00' } },
          { institutionId: INST, invoiceId: 9200, origin: 'transmissao', accessKey: keyOf(9200) })
        vozA()                                                               // o recordVoiceOnce('A') que vem DEPOIS na transmissão
        return 'A gravada'
      })
      await expect(run).resolves.toBe('A gravada')
      expect(vozA).toHaveBeenCalledTimes(1)
    } finally {
      silence.mockRestore()
      await pool.query('RENAME TABLE tb_invoice_service_transmission_ibscbs_off TO tb_invoice_service_transmission_ibscbs')
    }
  })
})
