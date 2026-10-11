-- nfse-api 002 — D-F68 (= Q-F75 (a)) · D-F70 (= Q-F77: o DDL é da FAMÍLIA — a voz nasce na 001 desta família, D-F35; as
-- migrations do núcleo rodam ANTES das da família) · D-F71 (= Q-F78 (a): sem coluna nova — `authority_code` já é "o código cru
-- do fisco" e já sai nas views da D-F15). Valdo 2026-10-10. Parecer do guardião no prompt das APIs fiscais §21.7.
-- Na voz C, `authority_code` passa a guardar o TIPO do evento de cancelamento (escrito uma vez; só sobe para 105102 — D-F75).
-- Backfill determinístico (o MESMO da 067 do setes-api — a réplica fica igual à origem): C por pedido NOSSO = e101101; a marca
-- de texto da D-F64 vira código; C por consulta sem marca fica NULL = voz anterior à D-F68 (lida como cancelamento comum).
-- Re-executável (UPDATE idempotente, MODIFY, ADD CONSTRAINT IF NOT EXISTS — provado no MariaDB 10.4 pela 067 do setes-api).
UPDATE `tb_invoice_service_transmission_event`
   SET `authority_code` = '105102', `updated_at` = UTC_TIMESTAMP()
 WHERE `kind` = 'C' AND `authority_code` IS NULL AND `source` <> 'P' AND `message` LIKE '%(e105102)%';
UPDATE `tb_invoice_service_transmission_event`
   SET `authority_code` = '101101', `updated_at` = UTC_TIMESTAMP()
 WHERE `kind` = 'C' AND `authority_code` IS NULL AND `source` = 'P';
ALTER TABLE `tb_invoice_service_transmission_event`
  MODIFY `authority_code` VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT 'Código cru do fisco: R/F = E0xxx ou HTTP · C = tpEvento do cancelamento (101101 · 105102 substituição · 105104 · 305101), escrito uma vez (D-F68)';
ALTER TABLE `tb_invoice_service_transmission_event`
  ADD CONSTRAINT IF NOT EXISTS `ck_invoice_service_transmission_event_cancel_code`
    CHECK (`kind` <> 'C' OR `authority_code` IS NULL OR `authority_code` IN ('101101', '105102', '105104', '305101'));
