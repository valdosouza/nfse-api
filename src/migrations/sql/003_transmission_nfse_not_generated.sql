-- nfse-api 003 — D-F90 (= Q-F96 (c), Valdo 2026-10-11): a prova da reconfirmação (D-F29) passa a exigir o "não gerada"
-- EXPLÍCITO do fisco (E2404), nunca o carimbo do rodízio (`last_queried_at` volta a ser só throttle). Fato da TENTATIVA
-- (a pergunta é feita no ambiente congelado dela — D-N6), nunca voz: E2404 depois do F não muda o estado derivado.
-- Instante no NOSSO relógio (o mesmo do created_at da voz), nunca o dataHoraProcessamento do fisco (PADROES §11 regra 9).
-- Gravada só quando a última voz da tentativa ainda é a que a pergunta viu (resposta velha não pousa — gate r10).
-- Sem backfill: o last_queried_at antigo não distingue E2404 de 502 (não se prova no escuro). Re-executável.
-- Parecer do guardião: prompt das APIs fiscais §21.10.
ALTER TABLE `tb_invoice_service_transmission`
  ADD COLUMN IF NOT EXISTS `nfse_not_generated_at` DATETIME DEFAULT NULL
    COMMENT 'Última resposta E2404 do fisco (nenhuma NFS-e para o Id do DPS) a consulta desta tentativa, em UTC, relógio nosso. NULL = nunca. Prova da D-F29 (D-F90)'
    AFTER `last_queried_at`;

CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS
SELECT t.`tb_institution_id`, t.`tb_invoice_id`, t.`terminal`, t.`attempt`, t.`life_event`, t.`environment`,
       d.`serie`, d.`dps_number`, d.`dps_id`,
       t.`access_key`, t.`nfse_number`, t.`dh_proc`, t.`last_queried_at`, t.`nfse_not_generated_at`, t.`created_at`,
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
