import { z } from 'zod'

/** Cancelamento NO FISCO (e101101): motivo vira xMotivo (15–255; curto ganha complemento). */
export const cancelDto = z.object({
  reason: z.string().trim().min(1).max(255),
})

/** Passada da consulta ativa — D-N22: nunca 0 (reconsulta a cada clique). */
export const refreshPassDto = z.object({
  minMinutes: z.number().int().min(1).max(1440).optional(),
  limit:      z.number().int().min(1).max(50).optional(),
})

/** Lista nova nasce PAGINADA (regra da casa): page ≥ 1, pageSize 1–100 (default 25). */
export const pendingQueryDto = z.object({
  page:     z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * D-F145 (= Q-F153 (a), Valdo 2026-10-13): o lote é da tela que o pede — o filtro do RAMO é do SERVIDOR (o cliente filtrando uma página
   * paginada esconderia notas). Sem o parâmetro: todos os ramos visíveis (como antes). Ramo não contratado = lista vazia (nunca 403: a
   * lista é do que se pode ver).
   */
  interfaceKey: z.enum(['service-orders', 'orders']).optional(),
})
