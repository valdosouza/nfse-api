-- nfse-api 007 — fase IBS/CBS, IB-3 (D-IB10/D-IB77/D-IB80 — Infra-IA/prompts/prompt_fase_ibs_cbs.md §13): os VALORES IBS/CBS que o
-- FISCO calculou e devolveu na NFS-e autorizada (`infNFSe/IBSCBS/totCIBS` — a Calculadora oficial; nós só DECLARAMOS a classificação).
-- Natureza (parecer do guardião §13.2): dado do fisco gravado UMA vez na tentativa que DETÉM a chave (D-N26), irmão de
-- access_key/nfse_number/dh_proc — NÃO é voz (não tem kind/source, não muda estado: a voz A nunca espera estes valores).
-- Só as colunas com CONSUMIDOR (D-IB77): vTotNF, vIBSTot, vCBS — a seção "No fisco", a prova da IB-4 e, na F3, a conferência D-IB12 pela
-- view (D-IB78: a view nasce com o 1º leitor no núcleo). O resto do grupo (alíquotas, efetivas, localidade, vBC, esferas) fica no XML
-- arquivado (o DANFSe lê o XML) até surgir consumidor — carga a partir do XML (molde D-IB27).
-- DECIMAL(17,2): o TSDec15V2 do XSD admite 15 dígitos INTEIROS + 2 decimais (`[1-9][0-9]{0,14}(\.[0-9]{2})?`) — DECIMAL(15,2) truncaria em
-- silêncio (servidor SEM modo estrito); o escritor grava o TEXTO conferido, nunca número do JS (precisão).
-- Escritor ÚNICO: `fillAuthorityIbscbs` (src/nfse/repository.ts) — sob a trava da NOTA (D-F27): confere que a tentativa detém a chave DESTA
-- NFS-e, lê a linha SEM trava e grava por `INSERT … VALUES` dentro de um SAVEPOINT (gates da IB-3: o `INSERT … SELECT … NOT EXISTS` travava o
-- INTERVALO do índice e causou 1213 entre notas DIFERENTES — provado no MariaDB 10.4). Nunca INSERT IGNORE (rebaixa a violação do CHECK a
-- aviso e a linha some — PADROES §11 regra 11 (a)).
-- RE-EXECUTÁVEL: CREATE TABLE IF NOT EXISTS com as constraints no CREATE.
CREATE TABLE IF NOT EXISTS `tb_invoice_service_transmission_ibscbs` (
  `tb_institution_id`   INT(11) NOT NULL,
  `tb_invoice_id`       INT(11) NOT NULL,
  `terminal`            INT(11) NOT NULL DEFAULT 0,
  `attempt`             INT(11) NOT NULL COMMENT 'A tentativa que DETÉM a chave da NFS-e (D-N26)',
  `total_invoice_value` DECIMAL(17,2) NOT NULL COMMENT 'vTotNF — infNFSe/IBSCBS/totCIBS/vTotNF (= vLiq em 2026; vLiq + vCBS + vIBSTot a partir de 2027)',
  `ibs_total_value`     DECIMAL(17,2) NOT NULL COMMENT 'vIBSTot — infNFSe/IBSCBS/totCIBS/gIBS/vIBSTot',
  `cbs_value`           DECIMAL(17,2) NOT NULL COMMENT 'vCBS — infNFSe/IBSCBS/totCIBS/gCBS/vCBS',
  `created_at`          DATETIME DEFAULT NULL,
  `updated_at`          DATETIME DEFAULT NULL,
  `deleted`             CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  CONSTRAINT `fk_invoice_service_transmission_ibscbs_attempt` FOREIGN KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
    REFERENCES `tb_invoice_service_transmission` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  CONSTRAINT `ck_invoice_service_transmission_ibscbs_values`
    CHECK (`total_invoice_value` >= 0 AND `ibs_total_value` >= 0 AND `cbs_value` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
