/// <reference types="jest" />
// NE-1a parte 2 (D-NE12/D-NE59) — peça de TESTE: a nota viaja INTEIRA (`InvoiceRef`, terminal por parâmetro) da borda até o SQL da família.
// Os testes montam a referência da nota da WEB por aqui (a borda de produção é a rota — `WEB_TERMINAL` só lá; testes não são borda).
import { invoiceRef, InvoiceRef, InvoiceScope, InvoiceTx, WEB_TERMINAL, withInvoiceTx } from 'fiscal-api'

export const WEB = WEB_TERMINAL

/** A referência da nota da web de quem pede (o `institutionId` do ator/token). */
export const webRef = (actor: { institutionId: number; [k: string]: unknown }, invoiceId: number): InvoiceRef => invoiceRef(actor.institutionId, invoiceId, WEB_TERMINAL)

/** A mesma referência montada PEÇA a peça — aceita os matchers do Jest (`expect.anything()`) nas asserções de chamada. */
export const refOf = (institutionId: any, invoiceId: any): InvoiceRef => ({ institutionId, invoiceId, terminal: WEB_TERMINAL }) as InvoiceRef

/** Escopo de leitura em lote (estabelecimento + terminal da web). */
export const webScope = (institutionId: number): InvoiceScope => ({ institutionId, terminal: WEB_TERMINAL })

/** Asserção de chamada de composição: a referência da nota [invoiceId] da web (o estabelecimento é conferido pela própria composição). */
export const refLike = (invoiceId: unknown) => expect.objectContaining({ invoiceId, terminal: WEB_TERMINAL })

/**
 * D-NE74 (parte 2 da NE-1a): o escritor da voz EXIGE o `InvoiceTx` (só o `withInvoiceTx` do núcleo o produz). Em TESTE que chama o escritor
 * direto (sem a trava real), a transação é montada aqui — o cast é só da peça de teste (a cerca de produção recusa `as InvoiceTx`).
 */
export const itxOf = (conn: any, institutionId: number, invoiceId: number): InvoiceTx =>
  Object.freeze({ conn, ref: Object.freeze(refOf(institutionId, invoiceId)), locked: Object.freeze({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }), open: true }) as unknown as InvoiceTx

/**
 * Um `InvoiceTx` de VERDADE (D-NE81 — gates da parte 2: o núcleo confere IDENTIDADE; o `itxOf` acima é forjado e só serve para escritor
 * SIMULADO): pela única porta (`withInvoiceTx` do núcleo), com a trava simulada e a conexão [conn] (só o `query` dela é usado);
 * [fn] roda DENTRO da transação.
 */
export function underTx<T>(conn: { query: (...a: any[]) => any }, institutionId: number, invoiceId: number, fn: (itx: InvoiceTx) => Promise<T>): Promise<T> {
  const tx = { query: (...a: any[]) => conn.query(...a), beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => undefined, release: () => undefined }
  return withInvoiceTx({ getConnection: async () => tx } as any, { schemaName: 'setes_setes', institutionId }, invoiceRef(institutionId, invoiceId, WEB_TERMINAL),
    { label: 'teste', lock: async () => ({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }) }, fn)
}

/** Asserção de chamada do escritor: a transação da nota [institutionId/invoiceId] (aceita matchers). */
export const itxLike = (conn: unknown, institutionId: unknown, invoiceId: unknown) =>
  expect.objectContaining({ conn, ref: expect.objectContaining({ institutionId, invoiceId, terminal: WEB_TERMINAL }) })
