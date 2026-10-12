# CLAUDE.md — nfse-api (serviço da família NFS-e)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e
**`Infra-IA/nfse-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F108 em
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
máquina foi REVOGADA na reconciliação; D-F61…D-F66 = leitura de eventos pelo contrato REAL da Sefin — `GET /nfse/{chave}/eventos/{tipo}/1`,
o `GET /eventos` dá 405 — + Rodada 11, §21; D-F67…D-F82 = a substituição e105102 com fim humano, código do evento na voz C — migration 002 —, §21.7; D-F90 = prova da reconferência pelo E2404 explícito — migration 003, §21.10; D-F91…D-F97, §21.11–§21.12; D-F98 = causa FECHADA do ambíguo (`tagAmbiguous` em todo produtor) e D-F99, §21.13; D-F100 = a resposta trocada nunca é guardada, nem no erro, e D-F101, §21.14; D-F102…D-F104 = voz S sem saída e `kind` sem CHECK como conhecimento negativo — cerca por AST em `src/__tests__/voice-kind-fence.ts` —, §21.15; D-F105 = a cerca da voz S é só da família NFS-e e D-F106 = o escritor da voz (`insertTransmissionEvent`) aceita só a lista POSITIVA da família — `SERVICE_VOICE_WRITE_KINDS` A/R/C/K/F/N, tipo derivado + FUNIL em execução + `OUTCOME_KIND` congelado + cerca de chamada/ESCRITOR ÚNICO na peça (`writerCallFlags`, `VOICE_SQL_WRITERS`), §21.16; D-F107 = o CHECK da F2a protege ESSA lista e D-F108 = na NE-1a ela vira o `writeKinds` do descritor da família no núcleo, §21.17)** — `npm test` (561 unit; ao vivo: 8 suítes `*.live.test.ts`, 150 testes
com `NFSE_ADV_LIVE=1 npx jest live --runInBand` — usa o banco do dev com fisco FALSO, em cópias `fiscal_api_adv_*`; o ATAQUE roda com
o DB_USER do .env, que TEM de ser o `fiscal_api` — D-F53, `ops/grants.sql` 1b) · `npm run dev` (porta 3002;
`.env` a partir do `.env.example`) ·
`npm run db:migrate` · `npm run migrate:setes [-- --dry-run]` (re-sincronia até a virada) · `npm run token:dev` (só dev) · `npx tsx --require tsconfig-paths/register scripts/probe-query.ts <chave> [H|P]` (sonda SÓ DE LEITURA
do adaptador contra o fisco — só NFS-e do próprio emitente).
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
