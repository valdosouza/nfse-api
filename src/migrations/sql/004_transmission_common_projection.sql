-- nfse-api 004 — NE-1a, D-NE56 (= Q-NE56 (a), Valdo 2026-10-11 — `prompt_onda_nfe_sefaz.md` §12.9): o REGISTRO pelo fisco passa a
-- ser FATO publicado na view (coluna `authority_recorded` da PROJEÇÃO COMUM — `fiscal-api/src/voice/reading.ts`), nunca a presença da
-- chave lida pelo consumidor: na NF-e a chave de acesso é NOSSA e existe desde a reserva da tentativa (D-NE7). A família é dona da
-- definição (D-F35): na NFS-e a chave vem do fisco — `authority_recorded = (access_key IS NOT NULL)`; a NF-e (NE-2) publicará pelo
-- protocolo. Só a view muda (nenhuma tabela); mesma lista de colunas da 003 + a nova; nenhum JOIN novo; segue FUNDÍVEL (expressão na
-- lista do SELECT não impede a fusão — PADROES §11 regra 3; conferir com `npm run explain:leituras`). Flag 'S'/'N' (padrão da casa).
-- COLAÇÃO FIXA (achado da conferência no dev, 2026-10-11): sem o COLLATE, a coluna derivada de literal sai COERCÍVEL na colação do
-- banco (utf8mb4_unicode_ci) e `authority_recorded = 'S'` numa conexão utf8mb4_general_ci (o padrão do mysql2 — setes-api e núcleo
-- não fixam colação) dá o erro 1267 "Illegal mix of collations" — a F2a quebraria na 1ª leitura. COLLATE explícito vence o literal
-- de qualquer colação; binário como o CHECK de `kind` da D-F107 ('s' minúsculo não é 'S').
-- Rodar com o usuário dono de sempre (o DEFINER da view é quem a recria; o GRANT de SELECT sobrevive ao REPLACE). Re-executável.
CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS
SELECT t.`tb_institution_id`, t.`tb_invoice_id`, t.`terminal`, t.`attempt`, t.`life_event`, t.`environment`,
       d.`serie`, d.`dps_number`, d.`dps_id`,
       t.`access_key`,
       IF(t.`access_key` IS NULL, 'N', 'S') COLLATE utf8mb4_bin AS `authority_recorded`,
       t.`nfse_number`, t.`dh_proc`, t.`last_queried_at`, t.`nfse_not_generated_at`, t.`created_at`,
       le.`event`          AS `last_event`,
       le.`kind`           AS `last_kind`,
       le.`authority_code` AS `last_code`,
       le.`message`        AS `last_message`,
       le.`source`         AS `last_source`,
       le.`dh`             AS `last_dh`,
       le.`created_at`     AS `last_event_at`
  FROM `tb_invoice_service_transmission` t
  JOIN `tb_invoice_service_dps` d
    ON d.`tb_institution_id` = t.`tb_institution_id` AND d.`tb_invoice_id` = t.`tb_invoice_id`
   AND d.`terminal` = t.`terminal` AND d.`life_event` = t.`life_event`
  LEFT JOIN `tb_invoice_service_transmission_event` le
    ON le.`tb_institution_id` = t.`tb_institution_id` AND le.`tb_invoice_id` = t.`tb_invoice_id`
   AND le.`terminal` = t.`terminal` AND le.`attempt` = t.`attempt` AND le.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_service_transmission_event` x
                    WHERE x.`tb_institution_id` = le.`tb_institution_id` AND x.`tb_invoice_id` = le.`tb_invoice_id`
                      AND x.`terminal` = le.`terminal` AND x.`attempt` = le.`attempt` AND x.`deleted` = 'N'
                      AND x.`event` > le.`event`)
 WHERE t.`deleted` = 'N';
