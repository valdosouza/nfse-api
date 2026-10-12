-- nfse-api 005 — F2a: os domínios da TENTATIVA e da VOZ da NFS-e são FATO DO BANCO, em colação BINÁRIA (Rodada 1 da F2a e gates da A1,
-- Valdo 2026-10-12 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22):
--  - `kind` da voz = a lista de ESCRITA da família (`SERVICE_VOICE_WRITE_KINDS` em `src/nfse/voice-family.ts`: A/R/C/K/F/N) — D-F107
--    (= Q-F113 (a)) + D-F103 (= Q-F109 (b) na migration da F2a);
--  - `source` da voz = P (resposta direta) / Q (consulta) e `environment` da tentativa = H/P — D-F120 (= Q-F131 (a)).
--
-- Por quê: as três colunas são CHAR(1) na colação da tabela (utf8mb4_unicode_ci) — um 'f' é F para o SQL do rodízio e VIVA para o código;
-- um 'q' some do seletor da reconferência (`lastSource === 'Q'`) e o veredito diria "não exigida" enquanto o rodízio o lê como Q; um 'p' vira
-- H no mapa interno e derruba o mapa da view (provado ao vivo nos gates da A1). S (sem saída — D-F102) e P/D (da NF-e) gravados por fora do
-- código ficariam na tabela da NFS-e. Os escritores são tipados e o funil do núcleo confere a lista de `kind` em execução (D-F106/D-F108);
-- o CHECK fecha o que passa POR FORA do código (SQL manual, cópia do `migrate:setes`).
-- UMA fonte: a lista do CHECK de `kind` é a constante da família (teste `f2a-a1-nfse.test.ts` compara o DDL com a constante); a sonda do boot
-- (`assertServiceVoiceDomainsEnforced`) grava, numa transação desfeita e sem a FK, 'S'/'f' (kind), 'X'/'q' (source) e 'X'/'p'
-- (environment) — cada uma tem de ser recusada pelo CHECK de NOME certo (nunca 'ZZ' sozinho — um CHECK _ci passaria).
-- Conferência ANTES (2026-10-12, só leitura): no `fiscal_api` e na origem do setes-api (setes_setes) `kind` = só A/C/F/R, `source` = só P,
-- `environment` = só H/P — tudo em maiúscula. Linha existente fora do domínio faz o ALTER FALHAR e a versão NÃO é registrada.
-- ⚠️ CONHECIMENTO NEGATIVO (gates da A1, F2A1-08 — corrige o que a 1ª versão desta migration afirmava): no MariaDB 10.4.20 a forma
-- `INSERT IGNORE … VALUES` dá ERRO 4025, mas a forma `INSERT IGNORE … SELECT` — a da cópia do `migrate:setes` — REBAIXA a violação do CHECK a
-- AVISO e a linha SOME calada. Por isso a cópia confere o domínio da ORIGEM antes de inserir (`scripts/migrate-from-setes-api.ts`).
-- RE-EXECUTÁVEL (D-F123 = Q-F133 (a)): `ADD CONSTRAINT IF NOT EXISTS` (provado no MariaDB 10.4.20; a mesma forma da 002). ⚠️ F3 (MySQL 8):
-- `IF NOT EXISTS` em CONSTRAINT é SÓ do MariaDB — a cadeia é revista na ida para a SaveInCloud se o motor for MySQL 8.
ALTER TABLE `tb_invoice_service_transmission_event`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_kind` CHECK (`kind` COLLATE utf8mb4_bin IN ('A', 'R', 'C', 'K', 'F', 'N')),
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_source` CHECK (`source` COLLATE utf8mb4_bin IN ('P', 'Q'));
ALTER TABLE `tb_invoice_service_transmission`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_environment` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P'));
