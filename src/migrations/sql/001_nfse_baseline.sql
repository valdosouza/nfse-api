-- nfse-api 001 — tabelas da FAMÍLIA NFS-e no banco `fiscal_api` + VIEWs publicadas para o setes-api
-- (extração fiscal, F0 — Infra-IA/prompts/prompt_apis_fiscais_isoladas.md §14).
--
-- Dono deste DDL: a família NFS-e (D-F35); o núcleo `fiscal-api` cria certificado e habilitação.
-- Formas herdadas das migrations 058–061 do setes-api (Onda 3) — "muda de casa, não de conceito":
-- a TENTATIVA continua sendo a declaração do ramo de serviço de UMA vida da nota.
-- Mudanças de casa:
--   * o DPS de cada VIDA ganha tabela própria (D-F30) — série + nDPS + Id write-once; o
--     `tb_invoice_service.dps_number` do ERP fica aposentado;
--   * a voz NÃO tem mais a coluna de efeito (`invoice_event` da 058): o C local é do setes-api,
--     e a pendência é DERIVADA (voz C na vida vigente × nota ainda não-C — D-F28);
--   * a vida da tentativa vira `life_event` NOT NULL (19/19 tentativas da Setes têm vida — §13.3).
-- Sem FK para o ERP (outro banco): `tb_institution_id` + `tb_invoice_id` + `terminal` são a
-- referência à nota em setes_<cliente>.

-- ---------------------------------------------------------------------------
-- 1. DPS de UMA VIDA da nota (D-F30; guardião §13.1-2). Vida = intervalo entre um evento E e o
--    C seguinte; `life_event` = o evento E (do ERP) que a abriu. Toda tentativa da vida reusa
--    ESTE Id (D-N3); revive da nota = vida nova = linha nova (nunca herda Id de vida cancelada);
--    a série fica congelada aqui (trocar a série no emissor não muda o Id de quem já tem DPS).
--    UNIQUE (institution, dps_id) volta: o Id é único por construção (a 059 o derrubou porque o
--    Id se repetia entre tentativas).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_invoice_service_dps` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL COMMENT 'Nota no schema do cliente — referência sem FK',
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `life_event`        INT(11) NOT NULL COMMENT 'Evento E da nota que abriu a VIDA (D-N27)',
  `serie`             VARCHAR(5) NOT NULL COMMENT 'Série do emissor SE no momento da cunhagem (congelada)',
  `dps_number`        INT(11) NOT NULL COMMENT 'nDPS cunhado do contador do emissor (D-N18)',
  `dps_id`            VARCHAR(45) NOT NULL COMMENT 'infDPS/@Id: DPS + cMun emitente + tpInsc + CNPJ + série + nDPS',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `life_event`),
  UNIQUE KEY `uk_invoice_service_dps_id` (`tb_institution_id`, `dps_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. TENTATIVA de transmissão (conceito B da Onda 3): N por vida; ambiente CONGELADO;
--    chave/número/dhProc do fisco WRITE-ONCE (a NFS-e existe UMA vez por vida e pousa na
--    tentativa que a obteve — D-N26); `last_queried_at` = "nós olhamos o fisco" (D-I20).
--    Reapresentar = attempt + 1 (numeração contínua por nota, atravessa as vidas).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_invoice_service_transmission` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `attempt`           INT(11) NOT NULL COMMENT 'Sequência 1..N por nota',
  `life_event`        INT(11) NOT NULL COMMENT 'Vida a que a tentativa pertence (D-N27) — o DPS dela',
  `environment`       CHAR(1) NOT NULL COMMENT 'H/P congelado da habilitação no envio',
  `access_key`        VARCHAR(50) DEFAULT NULL COMMENT 'Chave de acesso da NFS-e (50) — do fisco, write-once',
  `nfse_number`       VARCHAR(13) DEFAULT NULL COMMENT 'nNFSe — do fisco, write-once',
  `dh_proc`           DATETIME DEFAULT NULL COMMENT 'dhProc da autorização (instante UTC) — write-once',
  `last_queried_at`   DATETIME DEFAULT NULL COMMENT 'Última consulta ao fisco (rodízio/throttle); NULL = nunca',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  UNIQUE KEY `uk_invoice_service_transmission_key` (`tb_institution_id`, `access_key`),
  KEY `idx_invoice_service_transmission_life` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `life_event`),
  KEY `idx_invoice_service_transmission_query` (`tb_institution_id`, `last_queried_at`),
  CONSTRAINT `fk_invoice_service_transmission_dps` FOREIGN KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `life_event`)
    REFERENCES `tb_invoice_service_dps` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `life_event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. VOZ do fisco (conceito C, append-only). kind = NOSSA leitura: S enviado · A autorizada ·
--    R rejeitada · C cancelada · K cancelamento em voo · F falha explícita · N pedido de
--    cancelamento não consta (D-N17). authority_code = código cru (E0xxx); source P resposta
--    direta / Q consulta; idempotência por (kind, dh) e C por KIND (HIGH-3a). Estado DERIVADO da
--    última voz — nunca coluna. Sem coluna de efeito (D-F28).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tb_invoice_service_transmission_event` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `attempt`           INT(11) NOT NULL,
  `event`             INT(11) NOT NULL COMMENT 'Sequência 1..N por tentativa',
  `kind`              CHAR(1) NOT NULL COMMENT 'S · A · R · C · K · F · N',
  `authority_code`    VARCHAR(10) DEFAULT NULL COMMENT 'Código cru do fisco (E0xxx / HTTP)',
  `message`           VARCHAR(255) DEFAULT NULL,
  `dh`                DATETIME DEFAULT NULL COMMENT 'Instante UTC informado pelo fisco (dhProc/dhEvento — Q-TZ1)',
  `source`            CHAR(1) NOT NULL COMMENT 'P resposta direta · Q consulta',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `event`),
  UNIQUE KEY `uk_invoice_service_transmission_event_dh` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `kind`, `dh`),
  CONSTRAINT `fk_invoice_service_transmission_event_tx` FOREIGN KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
    REFERENCES `tb_invoice_service_transmission` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. VIEWs publicadas para o setes-api (D-F15: o setes-api tem SELECT SÓ nelas). Contrato de
--    leitura versionado como a OpenAPI; tipos e regra da vigente (D-N26) exportados pela
--    biblioteca `fiscal-api` (D-F33). Molde do TX_SELECT: a "última voz" vai no ON (subconsulta
--    no ON não impede a fusão; na LISTA do SELECT impediria) — EXPLAIN no dev antes de publicar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS
SELECT t.`tb_institution_id`, t.`tb_invoice_id`, t.`terminal`, t.`attempt`, t.`life_event`, t.`environment`,
       d.`serie`, d.`dps_number`, d.`dps_id`,
       t.`access_key`, t.`nfse_number`, t.`dh_proc`, t.`last_queried_at`, t.`created_at`,
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

CREATE OR REPLACE VIEW `vw_invoice_service_transmission_event` AS
SELECT e.`tb_institution_id`, e.`tb_invoice_id`, e.`terminal`, e.`attempt`, e.`event`, e.`kind`,
       e.`authority_code`, e.`message`, e.`dh`, e.`source`, e.`tb_user_id`, e.`created_at`,
       t.`life_event`
  FROM `tb_invoice_service_transmission_event` e
  JOIN `tb_invoice_service_transmission` t
    ON t.`tb_institution_id` = e.`tb_institution_id` AND t.`tb_invoice_id` = e.`tb_invoice_id`
   AND t.`terminal` = e.`terminal` AND t.`attempt` = e.`attempt` AND t.`deleted` = 'N'
 WHERE e.`deleted` = 'N';
