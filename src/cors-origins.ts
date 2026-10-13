/**
 * D-F146 (= Q-F154 (a), Valdo 2026-10-13 — Rodada 1 da F2b, `prompt_apis_fiscais_isoladas.md` §22.14.3/§22.16): o app web chama a nfse-api
 * DIRETO do navegador (D-F4), então a lista de origens é EXPLÍCITA por ambiente — dev `http://localhost:5051` (a porta do app), produção a
 * origem do build no Plesk. O boot RECUSA lista vazia (o app cairia em "Failed to fetch" sem diagnóstico) e `*` (qualquer site com o token
 * do usuário no navegador falaria com a API fiscal). Vale em TODO ambiente — a regra mais estrita cobre a produção sem depender de uma
 * variável de "ambiente" que o dev não tem. Cada item é uma ORIGEM (esquema + host[:porta], sem caminho), como o navegador a manda.
 */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i

export function assertCorsOrigins(origins: readonly string[]): string {
  if (!origins.length) {
    throw new Error('CORS_ORIGINS vazia — declare a(s) origem(ns) do app web (dev: http://localhost:5051; produção: a origem do Plesk) — D-F146')
  }
  const bad = origins.filter(o => o === '*' || !ORIGIN.test(o))
  if (bad.length) {
    throw new Error(`CORS_ORIGINS com valor fora da forma de ORIGEM (esquema://host[:porta], sem curinga nem caminho): ${bad.join(', ')} — D-F146`)
  }
  return origins.join(', ')
}
