# CLAUDE.md — nfse-api (serviço da família NFS-e)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e
**`Infra-IA/nfse-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F59 em
`Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §7; plano no §12, modelo no §14, execução da F1 no **§15**. O núcleo comum vive
em `D:\Gestao2027\fiscal-api` (biblioteca — `Infra-IA/fiscal-api/INDEX.md`).
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.

## O que este projeto É (D-F12/D-F17, Valdo 2026-10-03)

O serviço que **emite, autoriza, consulta e cancela a NFS-e** pelo Padrão Nacional (ADN / Sefin
Nacional) — porta **3002**, contrato **`/v1`** (D-F8), instância Node própria na SaveInCloud (D-F9).
Compõe o núcleo `fiscal-api` e acrescenta o que é da família: adaptador ADN, montagem do DPS,
DANFSe e a **fonte de fatos do ramo de serviço** (lê a nota e o ramo `tb_invoice_service` no schema
do cliente — D-F10).

Quem chama: o **setes-app** (e qualquer front-end do produto) direto, com o MESMO JWT do setes-api
(RS256 — a nfse-api só tem a chave pública; D-F13). O app manda a REFERÊNCIA da nota; a nfse-api
coleta no banco tudo o que precisa e controla o ciclo inteiro: envio, autorização, consulta,
cancelamento no fisco (D-F10).

## O que este projeto NÃO É

- Não escreve no ERP: usuário MySQL só com SELECT em `setes_central`/`setes_*` (D-F15).
- Não aplica o efeito do cancelamento no ERP — o setes-api lê a voz C nas views do `fiscal_api` e
  aplica (D-F11). O setes-api NUNCA chama esta API (D-F4).
- Não calcula imposto (o ramo chega congelado do faturamento). Não aceita pedido (D-F6).
- Não tem lote no servidor: o app fatia e repete (o `runningBatch` do setes-api morre).

## Regras inegociáveis

1. Toda leitura do ERP vive na fonte de fatos — nenhum `tb_invoice`/`tb_order`/`tb_entity*` fora dela.
2. Privilégio TRANSMITIR/CANCELAR do RAMO conferido no schema do cliente (admin passa); licença =
   interface do ramo contratada (D-F14).
3. Transmitir × cancelar local se serializam pelo `FOR UPDATE` na linha da nota (`tb_invoice` do cliente),
   1ª coisa da transação (D-F27; a trava nomeada do §12.4 foi aposentada). Ordem: nota → emissor → DPS → tentativa.
4. Herdadas da Onda 3 (D-N1…D-N38, `prompt_onda3_nfse_adn.md`): ambíguo nunca fecha, F só conclusivo,
   reconciliação por `dps_id`, vigente = quem detém a chave (D-N26), vida da nota (D-N27), XML de H em
   `<cnpj>/H/…` (Q-N38a), pasta pelo mês da zona (Q-TZ7), dhEmi na zona do estabelecimento (Q-TZ2).
5. Swagger/OpenAPI em todo endpoint; gates socrático ≥ 0,70 + adversarial sem HIGH antes de "pronto".

## Estado (2026-10-10 — reconciliação da sessão 2026-10-10 com a 3ª sessão de 2026-10-04, §20 do prompt)

**F1 + Rodadas 4–9 executadas (D-F46…D-F59 — §17–§20 do prompt; ramo fora do contrato = BLOQUEIO TOTAL, D-F46 (b) — a D-F55 desta
máquina foi REVOGADA na reconciliação)** — `npm test` (240 unit; ao vivo: 8 suítes `*.live.test.ts`, 150 testes
com `NFSE_ADV_LIVE=1 npx jest live --runInBand` — usa o banco do dev com fisco FALSO, em cópias `fiscal_api_adv_*`; o ATAQUE roda com
o DB_USER do .env, que TEM de ser o `fiscal_api` — D-F53, `ops/grants.sql` 1b) · `npm run dev` (porta 3002;
`.env` a partir do `.env.example`) ·
`npm run db:migrate` · `npm run migrate:setes [-- --dry-run]` (re-sincronia até a virada) · `npm run token:dev` (só dev).
⚠️ **A habilitação migrada está em PRODUÇÃO** (cópia do setes-api): nada de transmitir/consultar/cancelar no dev sem
decisão — o setes-api segue sendo o caminho de produção até a virada (F2a). **CERCA DA VIRADA = FATO no banco** (D-F39,
migration 003 do núcleo): `tb_establishment_issuer.cutover_at` NULL = RÉPLICA do ERP → ações e escritas do emitente dão 409
`FISCAL_CUTOVER_PENDING`, e o NÚCLEO recusa abrir o emissor, cunhar nDPS, tomar o aluguel e escrever o A1 da réplica. A
virada é o ato `npm run migrate:setes -- --cutover <id> --confirmo-setes-api-parado --vai` (write-once) — **sem `--vai` é
ENSAIO** (executa e desfaz) e argumento desconhecido FALHA (gate do delta da Rodada 6, M3 — 2026-10-10). ⚠️ **D-F44: o ato
APOSENTA a habilitação SE do ERP** (`deleted='S'` — a única escrita no ERP, `scripts/cutover-erp.ts`): no dev o ERP é o que
emite a produção da Setes — **NUNCA `--cutover` sem `--dry-run` fora da virada decidida**; os testes ao vivo só ensaiam. A variável
`FISCAL_LEGACY_INSTITUTIONS` foi APOSENTADA (definida = boot falha). Ataques ao vivo rodam em CÓPIA descartável
(`src/__tests__/live-harness.ts`) — nunca virar a habilitação real. Scripts: `npm run explain:leituras` (D-F40, usuário de
diagnóstico em `EXPLAIN_DB_USER`) · `npm run smoke:adn-h -- --candidatas | --nota <id> [--vai]` (D-F36, banco descartável;
`--vai` só com o "vai" do Valdo). Relatório: §15–§17 do prompt. Repo GitHub `valdosouza/gestao-2027-nfse-api` (privado, criado 2026-10-04).
