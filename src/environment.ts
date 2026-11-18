// DEPLOY.E1.P3 (gate adversarial M1, 2026-11-18): o critério de "estamos em produção" da nfse-api é o MESMO do núcleo
// (`isProductionEnv` em `fiscal-api/dist/util/environment.js`, que o pacote 2.0.0 não exporta): o CORS (D-F236) e a raiz do arquivo
// fiscal (D-F241) decidem lá por trim + minúsculas. Com `NODE_ENV=Production` o pre-deploy julgava "não é produção" (aviso, saída 0)
// e o boot recusava — e o selo do dist aceitaria núcleo de rascunho (D-F230). Uma regra só: esta, idêntica à do núcleo (cerca no teste).
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? '').trim().toLowerCase() === 'production'
}
