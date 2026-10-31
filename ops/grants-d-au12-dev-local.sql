-- D-AU12 — SÓ NO DEV: o mesmo estreitamento da seção 1a do `grants.sql` para os HOSTS LOCAIS do usuário fiscal.
-- Escopo: setes
-- No dev as conexões locais autenticam como 'fiscal_api'@'localhost' (o host mais específico vence — D-F53, seção 5 do grants.sql), e
-- esses hosts têm (conferido em 2026-10-31, só leitura de mysql.db) linhas `setes_central` e `setes_%` com SELECT — o `setes_%` com '_'
-- SEM escape também casa `setes_central`. NUNCA em produção: lá o usuário só existe no '@%' (GRANT a usuário inexistente criaria um
-- usuário sem senha no MariaDB). Rodar na JANELA do bloco de privilégios (passo 4 do plano 10-21), com um usuário ADMINISTRATIVO,
-- DEPOIS do script sql/70 (a view `vw_user_link` tem de existir para o GRANT dela). Idempotente (mesma ordem da seção 1a).
-- Conferência: pela conexão da nfse-api, `SELECT password FROM setes_central.tb_user` → ER_TABLEACCESS_DENIED_ERROR.

GRANT SELECT, SHOW VIEW ON `setes_central`.* TO 'fiscal_api'@'localhost';
REVOKE SELECT ON `setes_central`.* FROM 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_institution`          TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_entity`               TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_company`              TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_person`               TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_address`              TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_city`                 TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_state`                TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_interface`            TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`tb_interface_has_config` TO 'fiscal_api'@'localhost';
GRANT SELECT ON `setes_central`.`vw_user_link`            TO 'fiscal_api'@'localhost';

GRANT SELECT, SHOW VIEW ON `setes_central`.* TO 'fiscal_api'@'127.0.0.1';
REVOKE SELECT ON `setes_central`.* FROM 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_institution`          TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_entity`               TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_company`              TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_person`               TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_address`              TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_city`                 TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_state`                TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_interface`            TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`tb_interface_has_config` TO 'fiscal_api'@'127.0.0.1';
GRANT SELECT ON `setes_central`.`vw_user_link`            TO 'fiscal_api'@'127.0.0.1';

GRANT SELECT, SHOW VIEW ON `setes_central`.* TO 'fiscal_api'@'::1';
REVOKE SELECT ON `setes_central`.* FROM 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_institution`          TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_entity`               TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_company`              TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_person`               TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_address`              TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_city`                 TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_state`                TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_interface`            TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`tb_interface_has_config` TO 'fiscal_api'@'::1';
GRANT SELECT ON `setes_central`.`vw_user_link`            TO 'fiscal_api'@'::1';
