/**
 * A peça da CERCA da D-F102 (`voice-kind-fence.ts`) — D-F105 (= Q-F111 (a), Valdo 2026-10-11): a cerca é da FAMÍLIA NFS-e.
 * No núcleo (onde a NE-1a põe a máquina comum) só conta o SQL na tabela da voz da NFS-e; o `kind: 'S'` de lá é da NF-e (S legítimo).
 */
import fs from 'fs'
import path from 'path'
import { tsProducesS, sqlFileProducesS, voiceSProducers, writerCallFlags, voiceWriterViolations, lockFlags, walkTs, WORKSPACE } from './voice-kind-fence'

const writer = (kind: string) => `await insertTransmissionEvent(itx, a, u, { kind: ${kind}, source: 'P' })`

describe('voice-kind-fence — a cerca da voz S da família NFS-e (D-F102/D-F105)', () => {
  it('pega o literal S ao lado de `kind` em qualquer grafia (fora do núcleo)', () => {
    for (const k of [`'S'`, `"S"`, '`S`', `('S')`, `posted ? 'S' : 'F'`]) expect(tsProducesS(writer(k))).toBe(true)
    expect(tsProducesS(`const ev = { kind: 'F', source: 'P' }\nev.kind = 'S'`)).toBe(true)
    expect(tsProducesS(writer(`'F'`))).toBe(false)
  })
  it('comentário sai pelo compilador — nem o `/*` de um XPath cega a cerca, nem o S num comentário a dispara', () => {
    expect(tsProducesS(`const x = '//*[@Id="a"]'\n${writer(`'S'`)}`)).toBe(true)
    expect(tsProducesS(`// ${writer(`'S'`)}\n/* kind: 'S' */\n${writer(`'A'`)}`)).toBe(false)
  })
  it('D-F105: no NÚCLEO (`sqlOnly`) o `kind: \'S\'` em TypeScript NÃO conta (é da NF-e) — só o SQL na tabela da NFS-e', () => {
    expect(tsProducesS(writer(`'S'`), { sqlOnly: true })).toBe(false)
    expect(tsProducesS("await q.query(`INSERT INTO tb_invoice_service_transmission_event (kind) VALUES ('S')`)", { sqlOnly: true })).toBe(true)
  })
  it('D-F105: SQL na voz de OUTRA família (a futura tabela da NF-e) não conta; na da NFS-e, conta', () => {
    expect(sqlFileProducesS("INSERT INTO tb_invoice_merchandise_transmission_event (kind) VALUES ('S');")).toBe(false)
    expect(sqlFileProducesS("INSERT INTO tb_invoice_service_transmission_event (kind) VALUES ('S');")).toBe(true)
    expect(sqlFileProducesS("UPDATE tb_invoice_service_transmission_event SET kind = 'S' WHERE id = 1;")).toBe(true)
  })
  it('`.sql` é lido statement a statement — um `\'S\'` de OUTRO statement não vira produtor; comentário SQL não conta', () => {
    expect(sqlFileProducesS("INSERT INTO tb_invoice_service_transmission_event (kind) VALUES ('A');\nUPDATE tb_x SET active = 'S';")).toBe(false)
    expect(sqlFileProducesS("-- INSERT INTO tb_invoice_service_transmission_event (kind) VALUES ('S');\n/* idem 'S' */ SELECT 1;")).toBe(false)
  })
  it('leitor não é produtor (o SQL do rodízio lê S/K como vivas)', () => {
    expect(tsProducesS("await q.query(`SELECT 1 FROM tb_invoice_service_transmission_event WHERE kind IN ('S','K')`)")).toBe(false)
  })
  it('o código REAL de hoje: nenhum produtor de S da NFS-e em todo o escopo (D-F102 vale)', () => {
    expect(voiceSProducers()).toEqual([])
  })
  it('gate R22 — cerca de CHAMADA + ESCRITOR ÚNICO: o código REAL não tem violação (toda chamada ao escritor com objeto literal sem spread/cast e kind da família ou OUTCOME_KIND[…]; SQL na voz só nos escritores autorizados)', () => {
    expect(voiceWriterViolations()).toEqual([])
  })
  it('gate R22 — a cerca de chamada pega o que escapava (spread posterior, namespace/alias/cast, mutação do OUTCOME_KIND, SQL cru com placeholder)', () => {
    for (const src of [
      `insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P', ...extra })`,
      `repo.insertTransmissionEvent(itx, 1, null, { kind: WIDE as ServiceVoiceWriteKind, source: 'P' })`,
      `import { insertTransmissionEvent as put } from '../nfse/repository'
put(itx, 1, null, { kind: k, source: 'P' })`,
      `put(itx, 1, null, { kind: WIDE, source: 'P' } as any)`,
      `;(insertTransmissionEvent as (...a: any[]) => Promise<number>)(itx, 1, null, { kind: WIDE, source: 'P' })`,
      `Object.assign(OUTCOME_KIND, { local: 'S' })`, `Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')`, `delete (OUTCOME_KIND as any).local`,
      "conn.query('INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES (?, ?)', ['S', 'P'])",
      "const VOICE = 'tb_invoice_service_transmission_event'\n" + "conn.query(`UPDATE ${VOICE} SET message = ? WHERE attempt = ?`, [m, a])",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
  })
  it('gate R22 — o legítimo passa: literal da família, `OUTCOME_KIND[…]`, e o SQL do escritor AUTORIZADO; leitura não é escrita', () => {
    expect(writerCallFlags(`insertTransmissionEvent(itx, 1, null, { kind: 'A', source: 'P', message: m })`)).toBe(false)
    expect(writerCallFlags(`insertTransmissionEvent(itx, 1, null, { kind: OUTCOME_KIND[cls], source: 'P' })`)).toBe(false)
    expect(writerCallFlags("conn.query('INSERT INTO tb_invoice_service_transmission_event (kind) VALUES (?)', [e.kind])", { allowSqlWriter: true })).toBe(false)
    expect(writerCallFlags("conn.query('SELECT kind FROM tb_invoice_service_transmission_event WHERE attempt = ?', [a])")).toBe(false)
  })
  it('NE-1a parte 2 — escrita na voz = a voz é o ALVO (INSERT/REPLACE com ou sem schema, lista de tabelas do UPDATE antes do SET, DELETE antes do WHERE); a voz LIDA no subselect de outra escrita não é escrita na voz', () => {
    const flags = (sql: string) => writerCallFlags(`conn.query('${sql}', [])`)
    // o schema por SUBSTITUIÇÃO (a forma do setes-api): o template vira `?`.tabela
    expect(writerCallFlags('conn.query(`INSERT INTO \\`${db}\\`.tb_invoice_service_transmission_event (kind) VALUES (?)`, [k])')).toBe(true)
    for (const sql of [
      'INSERT INTO tb_invoice_service_transmission_event (kind) VALUES (?)',
      'REPLACE tb_invoice_service_transmission_event (kind) VALUES (?)',
      'UPDATE tb_invoice_service_transmission_event SET message = ? WHERE attempt = ?',
      'UPDATE tb_invoice_service_transmission t JOIN tb_invoice_service_transmission_event e ON e.attempt = t.attempt SET e.message = ?',
      'DELETE FROM tb_invoice_service_transmission_event WHERE attempt = ?',
      'DELETE e FROM tb_invoice_service_transmission t JOIN tb_invoice_service_transmission_event e ON e.attempt = t.attempt WHERE t.attempt = ?',
    ]) expect([sql, flags(sql)]).toEqual([sql, true])
    for (const sql of [
      // o `recordNfseNotGenerated` (D-F90): grava a TENTATIVA conferindo a última voz num subselect
      'UPDATE tb_invoice_service_transmission t SET t.nfse_not_generated_at = NOW() WHERE t.attempt = ? AND (SELECT COALESCE(MAX(e.event), 0) FROM tb_invoice_service_transmission_event e WHERE e.attempt = t.attempt) = ?',
      'INSERT INTO tb_x (n) SELECT COUNT(*) FROM tb_invoice_service_transmission_event',
      'UPDATE tb_invoice_service_transmission SET message = ? WHERE attempt = ?',
    ]) expect([sql, flags(sql)]).toEqual([sql, false])
  })
  it('NE-1a parte 2 (passo 5) — o ESCRITOR como VALOR só vai às políticas do núcleo (1º argumento de reserva/liberação; propriedade das portas do `recordVoiceOnce`); embrulho, guarda, retorno ou outra posição = violação', () => {
    for (const src of [
      'wrap(insertTransmissionEvent)', 'const w = { f: insertTransmissionEvent }', 'const f = () => insertTransmissionEvent', 'arr.push(insertTransmissionEvent)',
      'other({ insertTransmissionEvent, hasTransmissionEvent }, itx, 1, null, e)', 'recordVoiceOnce(x, { insertTransmissionEvent })',
      'reserveCancelRequest(itx, insertTransmissionEvent)', 'const g = insertTransmissionEvent as any',
      "import { insertTransmissionEvent as put } from '../nfse/repository'\nwrap(put)",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
    for (const src of [
      'await reserveCancelRequest(insertTransmissionEvent, itx, tx.attempt, userId)',
      'await releaseCancelRequest(insertTransmissionEvent, itx, tx.attempt, userId, message, cur)',
      "await recordVoiceOnce({ insertTransmissionEvent, hasTransmissionEvent }, itx, 1, null, { kind: 'A', source: 'P', dh })",
      "export { insertTransmissionEvent } from './repository'", 'export const insertTransmissionEvent = SERVICE_VOICE_FAMILY.insertTransmissionEvent',
    ]) expect([src, writerCallFlags(src)]).toEqual([src, false])
  })
  it('NE-1a parte 2 (D-F108) — um 2º DESCRITOR de família fora do autorizado (`defineVoiceFamily` por qualquer grafia) é violação: furaria a lista de escrita da NFS-e sem SQL nenhum', () => {
    for (const src of [
      "export const F = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['S'] })",
      "import { defineVoiceFamily as def } from 'fiscal-api'\nexport const F = def({ reading: R, eventTable: T, writeKinds: K })",
      "import * as core from 'fiscal-api'\nexport const F = core.defineVoiceFamily({ reading: R, eventTable: T, writeKinds: K })",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
    const legit = "export const SERVICE_VOICE_FAMILY = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: SERVICE_VOICE_WRITE_KINDS })"
    expect(writerCallFlags(legit, { allowFamilyDescriptor: true })).toBe(false)
  })
  it('D-NE80 (gates da parte 2) — a TRAVA do `withInvoiceTx` numa família é só `erp.lockInvoice`: outro "travante", atalho ou opções espalhadas = violação; o código REAL (nfse-api src + scripts, nfe-api) está limpo', () => {
    for (const src of [
      "withLockedInvoice(pool, actor, ref, { label, lock: async () => LOCKED }, fn)",
      "withInvoiceTx(pool, who, ref, { label, lock: myLock }, fn)",
      "const lock = erp.lockInvoice\nwithInvoiceTx(pool, who, ref, { label, lock }, fn)",
      "withInvoiceTx(pool, who, ref, { label, ...opts }, fn)",
    ]) expect([src, lockFlags(src)]).toEqual([src, true])
    expect(lockFlags("withLockedInvoice(deps.pool, actor, refOf(actor, ref), { label, requireAlive: opts.requireAlive, lock: erp.lockInvoice }, fn)")).toBe(false)
    // D-F228 ("Cada um no seu"): cada repositório vigia o próprio código — a nfe-api tem a mesma cerca na suíte dela
    // (`nfe-api/src/__tests__/voice-kind-fence.test.ts`, `lockFlags` sobre o `voiceFenceScope` dela)
    const PROJECT = path.resolve(__dirname, '..', '..')
    const files = [...walkTs(path.join(PROJECT, 'src')), ...walkTs(path.join(PROJECT, 'scripts'))]
    expect(files.length).toBeGreaterThan(20)
    expect(files.filter(f => lockFlags(fs.readFileSync(f, 'utf8'))).map(f => path.relative(WORKSPACE, f))).toEqual([])
  })
})
