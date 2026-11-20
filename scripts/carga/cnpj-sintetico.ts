/**
 * DEPLOY.E3.P1 — CNPJ VÁLIDO e sintético a partir de um número de série. Módulo PURO (sem efeito ao importar).
 * Montado por aritmética (raiz numérica + os DV do núcleo, `cnpjCheckDigits`) — nunca tirando caracteres de um texto (cerca D-CJ12,
 * `src/__tests__/federal-id-fence.ts`). Raiz começando em 9 + ordem 0001: fora das faixas dos clientes reais do dev.
 */
import { cnpjCheckDigits } from 'fiscal-api'

export function cnpjSintetico(serie: number): string {
  if (!Number.isInteger(serie) || serie < 0 || serie > 9_999_999) throw new Error(`série do CNPJ sintético inválida: ${serie}`)
  const base12 = `9${String(serie).padStart(7, '0')}0001`
  const dv = cnpjCheckDigits(base12)
  if (!dv) throw new Error(`raiz sem forma: ${base12}`)
  return base12 + dv
}
