/**
 * A peça da CERCA da D-F102 (`voice-kind-fence.ts`) — D-F105 (= Q-F111 (a), Valdo 2026-10-11): a cerca é da FAMÍLIA NFS-e.
 * No núcleo (onde a NE-1a põe a máquina comum) só conta o SQL na tabela da voz da NFS-e; o `kind: 'S'` de lá é da NF-e (S legítimo).
 */
import { tsProducesS, sqlFileProducesS, voiceSProducers, writerCallFlags, voiceWriterViolations } from './voice-kind-fence'

const writer = (kind: string) => `await insertTransmissionEvent(conn, i, n, a, u, { kind: ${kind}, source: 'P' })`

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
      `insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'F', source: 'P', ...extra })`,
      `repo.insertTransmissionEvent(conn, 1, 1, 1, null, { kind: WIDE as ServiceVoiceWriteKind, source: 'P' })`,
      `import { insertTransmissionEvent as put } from '../nfse/repository'
put(conn, 1, 1, 1, null, { kind: k, source: 'P' })`,
      `put(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' } as any)`,
      `;(insertTransmissionEvent as (...a: any[]) => Promise<number>)(conn, 1, 1, 1, null, { kind: WIDE, source: 'P' })`,
      `Object.assign(OUTCOME_KIND, { local: 'S' })`, `Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')`, `delete (OUTCOME_KIND as any).local`,
      "conn.query('INSERT INTO tb_invoice_service_transmission_event (kind, source) VALUES (?, ?)', ['S', 'P'])",
      "const VOICE = 'tb_invoice_service_transmission_event'\n" + "conn.query(`UPDATE ${VOICE} SET message = ? WHERE attempt = ?`, [m, a])",
    ]) expect([src, writerCallFlags(src)]).toEqual([src, true])
  })
  it('gate R22 — o legítimo passa: literal da família, `OUTCOME_KIND[…]`, e o SQL do escritor AUTORIZADO; leitura não é escrita', () => {
    expect(writerCallFlags(`insertTransmissionEvent(conn, 1, 1, 1, null, { kind: 'A', source: 'P', message: m })`)).toBe(false)
    expect(writerCallFlags(`insertTransmissionEvent(conn, 1, 1, 1, null, { kind: OUTCOME_KIND[cls], source: 'P' })`)).toBe(false)
    expect(writerCallFlags("conn.query('INSERT INTO tb_invoice_service_transmission_event (kind) VALUES (?)', [e.kind])", { allowSqlWriter: true })).toBe(false)
    expect(writerCallFlags("conn.query('SELECT kind FROM tb_invoice_service_transmission_event WHERE attempt = ?', [a])")).toBe(false)
  })
})
