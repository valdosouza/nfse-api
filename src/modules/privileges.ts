/**
 * Privilégios que a nfse-api confere (catálogo `setes_central.tb_privilege` — a REGRA é do ERP, D-F13). TRANSMITIR (9) e
 * CANCELAR (7) vêm do núcleo (`fiscal-api` `erp.PRIVILEGE_*`).
 *
 * CONSULTAR (12) — D-PV40 (Valdo 2026-10-20, `Infra-IA/prompts/prompt_privilegios_interfaces.md`): "transmitir e consultar são
 * dois verbos independentes" — perguntar ao FISCO a situação de uma nota sem mudar estado nela (`refresh` por nota e a passada do
 * rodízio) é CONSULTAR; TRANSMITIR fica para o que MUDA estado no terceiro (transmitir); `reconfirm`/`cancel` seguem CANCELAR
 * (a finalidade é cancelar — D-PV27). Seed 68 cria o privilégio e os pares nas interfaces dos ramos (orders, service-orders,
 * order-returns).
 *
 * ⚠️ A constante vive AQUI, e não em `fiscal-api/src/erp/facts.ts` ao lado das irmãs, porque a worktree desta onda não toca o
 * núcleo (junção para a árvore viva — Q-PV56): mover para o núcleo é um ato da fusão/janela, e esta constante sai daqui nesse dia.
 */
export const PRIVILEGE_CONSULTAR = 12
