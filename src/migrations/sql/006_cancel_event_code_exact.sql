-- nfse-api 006 — F2a, gate adversarial da A3 (F2A3-ADV-02, 2026-10-13 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22.13): o
-- CHECK do código da voz C (002 — D-F68) comparava na colação da coluna (utf8mb4_unicode_ci, PAD SPACE): '105102 ' (espaço no fim)
-- PASSAVA no CHECK (provado ao vivo no MariaDB 10.4.20), e o núcleo compara EXATO (`isSubstitutionCancel` — '105102 ' ≠ '105102'): a
-- substituição virava efeito AUTOMÁTICO ("apply") em vez da decisão humana ("decide") — contra a D-F64. Só por escrita POR FORA do código
-- (os escritores tipados gravam o código do evento lido do XML). ⚠️ CONHECIMENTO NEGATIVO: `COLLATE utf8mb4_bin` NÃO resolve — no MariaDB
-- 10.4 o `_bin` também é PAD SPACE; o que fecha é o COMPRIMENTO (`CHAR_LENGTH` conta o espaço do VARCHAR) somado à lista binária.
-- Conferência ANTES (2026-10-13, só leitura): no `fiscal_api` e na origem (setes_setes) as vozes C têm só '101101' com 6 caracteres — a
-- linha existente fora do domínio faria o ALTER falhar e a versão NÃO seria registrada. A cópia do `migrate:setes` confere o MESMO domínio
-- na ORIGEM antes do `INSERT IGNORE … SELECT` (que rebaixa a violação a aviso — F2A1-08) e a sonda do boot grava '105102 ' numa transação
-- desfeita: tem de ser recusado por ESTE CHECK (`assertServiceVoiceDomainsEnforced`).
-- RE-EXECUTÁVEL (D-F123): DROP IF EXISTS + ADD IF NOT EXISTS (só MariaDB — a F3 revê a cadeia se o motor for MySQL 8). Processo morto entre
-- os dois comandos = o próximo boot reaplica (a versão só é registrada depois do último).
ALTER TABLE `tb_invoice_service_transmission_event`
  DROP CONSTRAINT IF EXISTS `ck_invoice_service_transmission_event_cancel_code`;
ALTER TABLE `tb_invoice_service_transmission_event`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_cancel_code`
    CHECK (`kind` COLLATE utf8mb4_bin <> 'C' OR `authority_code` IS NULL
           OR (CHAR_LENGTH(`authority_code`) = 6 AND `authority_code` COLLATE utf8mb4_bin IN ('101101', '105102', '105104', '305101')));
