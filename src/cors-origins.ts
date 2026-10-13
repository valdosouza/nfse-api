/**
 * D-F146 (= Q-F154 (a), Valdo 2026-10-13 — Rodada 1 da F2b, `prompt_apis_fiscais_isoladas.md` §22.14.3/§22.16): o app web chama a nfse-api
 * DIRETO do navegador (D-F4), então a lista de origens é EXPLÍCITA por ambiente — dev `http://localhost:5051` (a porta do app), produção a
 * origem do build no Plesk. A REGRA mora no NÚCLEO (gate do delta da Rodada 4 — F2AR4-SOC-07/ADV-09: a nfe-api herda; o `corsFor` recusa o
 * curinga e a origem torta na montagem): lista vazia recusa; só origem CANÔNICA (a que o navegador manda — a comparação é por igualdade:
 * minúsculas, sem porta padrão explícita, porta ≤ 65535, sem caminho), `http://` só em localhost, nada de `*`.
 */
export { assertCorsOrigins, corsOriginProblem } from 'fiscal-api'
