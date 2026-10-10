-- Permissões MySQL da topologia fiscal (D-F9/D-F15/D-F27/D-F31) — rodar com um usuário ADMINISTRATIVO
-- na instância MySQL única, UMA vez por ambiente. Substitua as senhas (nunca versione as reais).
-- Plano: Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §14 · prova no dev: §15.
--
-- 1. Usuário das APIs fiscais (nfse-api hoje; nfe-api amanhã):
--    - controle TOTAL só no banco `fiscal_api` (D-F7) — cria o banco e aplica as migrations no boot;
--    - LEITURA no ERP: setes_central + todos os schemas de cliente (`setes\_%` — o '\_' casa o '_' literal);
--    - D-F31: a API fiscal NÃO escreve dado no ERP — a única coisa além de ler é a trava `SELECT … FOR UPDATE`
--      na linha da nota (`tb_invoice`) + `LOCK IN SHARE MODE` no último evento.
--    ⚠️ MariaDB 10.4 (dev, provado em 2026-10-04): FOR UPDATE / LOCK IN SHARE MODE funcionam só com SELECT.
--    ⚠️ MySQL 8.0.22+: leitura travante exige, além de SELECT, um de DELETE / LOCK TABLES / UPDATE na tabela.
--       Se a instância da SaveInCloud for MySQL 8, conceda o MÍNIMO: `LOCK TABLES` nos schemas de cliente
--       (não dá escrita de dado) — conferir na F3 (risco (3) do §12.7).
CREATE USER IF NOT EXISTS 'fiscal_api'@'%' IDENTIFIED BY '<SENHA_FISCAL_API>';
GRANT ALL PRIVILEGES ON `fiscal_api`.* TO 'fiscal_api'@'%';
GRANT SELECT ON `setes_central`.* TO 'fiscal_api'@'%';
GRANT SELECT ON `setes\_%`.* TO 'fiscal_api'@'%';
-- (MySQL 8 apenas, se a leitura travante for recusada:)
-- GRANT LOCK TABLES ON `setes\_%`.* TO 'fiscal_api'@'%';

-- 1b. D-F53 (= Q-F53 (a), Valdo 2026-10-04): controle TOTAL nas CÓPIAS DESCARTÁVEIS dos ataques ao vivo
--     (`fiscal_api_adv*` — `src/__tests__/live-harness.ts`, validador `^fiscal_api_adv[a-z0-9_]*$`: inclui `fiscal_api_adv4`,
--     `fiscal_api_advr6`, `fiscal_api_adv_r11`), e SÓ nelas. O padrão casa apenas bancos com esse prefixo ('\_' = '_' literal;
--     2026-10-10: `adv%` no lugar de `adv\_%`, que não cobria adv4/advr6): o ERP (`setes_*`, `setes_central`) e o `fiscal_api` real não ganham nada. Assim os ataques
--     podem rodar com o usuário 'fiscal_api' (que só LÊ o ERP) e um teste errado fica fisicamente impedido de escrever
--     no ERP — a defesa deixa de ser só DETECÇÃO (o CHECKSUM do harness). Em produção é inócuo: lá não existem cópias.
GRANT ALL PRIVILEGES ON `fiscal\_api\_adv%`.* TO 'fiscal_api'@'%';

-- 2. Usuário do setes-api (F2a): lê a voz fiscal SÓ pelas VIEWs publicadas (contrato — D-F15); nunca as
--    tabelas internas do fiscal_api. As views são SQL SECURITY DEFINER (definidor = quem rodou a migration
--    da família, o 'fiscal_api'), então o SELECT na view basta.
-- GRANT SELECT ON `fiscal_api`.`vw_invoice_service_transmission`       TO 'setes_api'@'%';
-- GRANT SELECT ON `fiscal_api`.`vw_invoice_service_transmission_event` TO 'setes_api'@'%';

-- 3. Conferência (critério §12.8-2): pela conexão do 'fiscal_api', um INSERT em setes_<cliente>.tb_invoice_event
--    tem que dar ER_TABLEACCESS_DENIED_ERROR; um SELECT … FOR UPDATE em setes_<cliente>.tb_invoice tem que passar.
--    D-F53: `CREATE DATABASE fiscal_api_adv_conferencia` + `DROP DATABASE fiscal_api_adv_conferencia` têm que passar;
--    `CREATE DATABASE setes_conferencia` tem que dar ER_DBACCESS_DENIED_ERROR. `SHOW GRANTS FOR 'fiscal_api'@'%'` lista as 4.
--
-- Ordem na implantação: este script ANTES do 1º boot da nfse-api (o boot cria o `fiscal_api` e aplica as migrations).
-- É idempotente (CREATE USER IF NOT EXISTS; GRANT repetido não duplica) — pode rodar de novo a cada ambiente.
--
-- 4. O ATO da virada (`npm run migrate:setes -- --cutover <id> --confirmo-setes-api-parado --vai` — D-F39/D-F44; sem `--vai` é
--    ENSAIO) roda com a
--    credencial do DONO do ERP (a do setes-api), passada SÓ ao processo do ato (DB_USER/DB_PASSWORD na linha de comando,
--    nunca no .env do serviço): ele APOSENTA a habilitação SE do ERP (`UPDATE setes_<cliente>.tb_establishment_issuer SET
--    deleted='S'`) — a única escrita de uma API fiscal no ERP (lista fechada da D-F31). Com o usuário 'fiscal_api' esse
--    UPDATE é negado e o ato INTEIRO volta atrás (nada vira) — o GRANT acima NÃO ganha escrita no ERP.

-- 5. D-F53 — SÓ NO DEV (achado de 2026-10-10 ao rodar os ataques ao vivo): as conexões LOCAIS do MySQL autenticam como
--    'fiscal_api'@'localhost' (o host mais específico vence), que NÃO herda o GRANT do '@%' da seção 1b — no dev o mesmo
--    GRANT vai também para os hosts locais do usuário. Aplicado em 2026-10-10 ("vai" do Valdo) nos quatro hosts
--    (localhost, 127.0.0.1, ::1, %) e provado: cria/escreve/apaga a cópia; UPDATE no ERP → ER_TABLEACCESS_DENIED_ERROR;
--    banco fora do padrão → ER_DBACCESS_DENIED_ERROR. O '@%' já tinha `fiscal\_api\_adv\_%` desde 2026-10-04 (a seção 1b,
--    aplicada pelo Valdo naquela sessão). NUNCA em produção: lá o usuário só existe no '@%' (GRANT a usuário inexistente
--    criaria um usuário sem senha no MariaDB).
-- GRANT ALL PRIVILEGES ON `fiscal\_api\_adv%`.* TO 'fiscal_api'@'localhost';
-- GRANT ALL PRIVILEGES ON `fiscal\_api\_adv%`.* TO 'fiscal_api'@'127.0.0.1';
-- GRANT ALL PRIVILEGES ON `fiscal\_api\_adv%`.* TO 'fiscal_api'@'::1';
