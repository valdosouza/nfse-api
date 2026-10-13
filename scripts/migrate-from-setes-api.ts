// D-F18 — MIGRAÇÃO ÚNICA dos dados fiscais do setes-api para o `fiscal_api` (F1 da extração fiscal).
// Para cada institution ativa: habilitação (tb_establishment_issuer) · A1 do cofre em arquivo do setes-api
// (cifrado agora no banco — D-F16) · DPS de cada VIDA (D-F30) · tentativas · vozes. Os XMLs NÃO são
// copiados no dev: a nfse-api aponta para o MESMO STORAGE_PATH do setes-api (§12.6) — o script CONFERE
// que cada XML autorizado/cancelado é achado pelo storage da nfse-api.
//
// Regras: transação ÚNICA (tudo ou nada); IDEMPOTENTE e de RE-SINCRONIA até a virada (F2a): enquanto o
// setes-api for o caminho de produção, ele é a ORIGEM — nos campos mutáveis a origem vence (ambiente/
// série da habilitação, contador nDPS por GREATEST, chave/número/dhProc write-once por COALESCE,
// last_queried_at por GREATEST, A1 renovado = fingerprint diferente → recifra); vozes são append-only
// (INSERT IGNORE) e o DPS da vida é write-once. FALHA ALTO se uma tentativa não tem vida (invoice_event
// NULL — §13.3), se uma vida tem DOIS Ids de DPS (premissa da D-F30) ou se o `fiscal_api` tem fato que a
// origem não tem / diverge dela (DPS de outra vida, tentativa a mais, voz com kind trocado) — isso é
// DUAL-WRITE, que a cerca da virada impede. `--dry-run` desfaz no fim.
// D-F90 (Valdo 2026-10-11): `nfse_not_generated_at` (a PROVA da D-F29 — E2404 explícito) NÃO existe na origem e não é copiado:
// nasce NULL na réplica e o valor do destino é preservado. Um F por consulta migrado do ERP chega SEM prova — depois da virada
// o cancelamento local exige reconferência nova (falha fechada, desejado).
//
// D-F39 (Valdo 2026-10-04): a cerca é o FATO `cutover_at` na habilitação do `fiscal_api` (migration 003 do núcleo) —
// NULL = RÉPLICA do ERP. Escopo DERIVADO DO DADO (sem variável de ambiente): toda institution com habilitação SE no ERP
// (viva ou excluída — o contador tem história). Linha já VIRADA fica CONGELADA: o script nunca a escreve e FALHA ALTO
// se a origem mudou depois da virada (tentativa nova ou contador além do da API = o ERP ainda emitindo).
//
// D-F42 (Valdo 2026-10-04, parecer do guardião no §17): copia e vira SÓ a habilitação do modelo da família
// (`SERVICE_MODEL` = SE — filtro POSITIVO, nunca "tudo menos 55/65"). No ERP a linha 55/65 é só a SÉRIE DA NOTA do
// faturamento (D-F21 — fica no ERP para sempre); a linha SE carrega também a habilitação para falar com o fisco, e só
// isso muda de casa. Réplica de outro modelo no `fiscal_api` (versão anterior do script) = FALHA ALTO: apagar à mão com
// DELETE FÍSICO (soft delete não serve — réplica excluída continua réplica e travaria a institution).
//
// O ATO DA VIRADA (`--cutover <institutionId> --confirmo-setes-api-parado`, uma institution por vez, transação própria):
//   1. a linha SE da habilitação do ERP é travada (FOR UPDATE pela PK) como PRIMEIRO comando da transação — antes de
//      qualquer leitura não travante (o snapshot do REPEATABLE READ nasceria antes e a cópia perderia o último nDPS do
//      ERP); a 55/65 do ERP (série do faturamento) fica livre;
//   2. as linhas do `fiscal_api` da institution, FOR UPDATE POR LINHA (PADROES §9 regra 8); réplica que não seja SE → FALHA;
//   3. transmissão VIVA na origem (sem voz, S ou K) → FALHA ALTO (a voz chegaria depois da cópia);
//   4. a re-sincronia de sempre;
//   5. `cutover_at = NOW()` em TODAS as linhas da institution ainda réplica (o ato é por institution — D-F39; só há SE);
//   6. D-F44: a habilitação SE do ERP é APOSENTADA (`deleted='S'`) na mesma transação — a única escrita de uma API fiscal
//      no ERP (lista fechada da D-F31; `scripts/cutover-erp.ts`), CONFERIDA antes no passo 1: série da NOTA SE ≠ '1' = falha;
//   7. pós-condição na mesma transação: o predicado do núcleo `emissionStillInErp` = falso.
// ⚠️ Pré-condição: o caminho de emissão do setes-api PARADO (F2a). Credencial: a do DONO do ERP (o usuário `fiscal_api` só
// lê o ERP — com ele o UPDATE do passo 6 é negado e o ato inteiro volta atrás). `--dry-run` executa o ato inteiro, inclusive
// a escrita no ERP, e DESFAZ na mesma transação.
// Gate do delta da Rodada 6 (M3): o ATO é irreversível no ERP que guarda a produção — é ENSAIO por padrão (executa a escrita
// e DESFAZ); gravar exige `--vai` explícito; argumento desconhecido FALHA (um `--dry-run` digitado errado não pode virar o
// ato). A re-sincronia (sem `--cutover`) só escreve no `fiscal_api` e continua gravando por padrão.
// D-F50: o ato com `--vai` também exige a F2a do setes-api aplicada no schema (`f2a_fiscal_passivo` em `_migrations`).
// Uso: npm run migrate:setes [-- --dry-run]
//      npm run migrate:setes -- --cutover 1 --confirmo-setes-api-parado            (ENSAIO)
//      npm run migrate:setes -- --cutover 1 --confirmo-setes-api-parado --vai      (o ATO)
//   SETES_SECRETS_PATH (default ../setes-api/secrets) · FISCAL_MASTER_KEYS · DB_* da nfse-api · STORAGE_PATH
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import {
  createFiscalPool, dbConfigFromEnv, MasterKeyRing, FsFiscalStorage, certificateInfo, keyMatchesCertificate,
  validatePrivateKeyPem, certificateAad, assertSchema, PoolConnection, ISSUER_MODELS, anyEmissionStillInErp, erp, CANCEL_EVENT_CODES,
} from 'fiscal-api'
import { SERVICE_MODEL } from '../src/facts/service-facts'
import { SERVICE_VOICE_WRITE_KINDS } from '../src/nfse/voice-family'
import { assertNoteSerieKept, retireErpServiceIssuer, f2aFreezeTriggersMissing, F2A_FREEZE_TRIGGERS } from './cutover-erp'
import { argumentErrors, npmSwallowedFlags } from './migrate-args'

const ARGS = process.argv.slice(2)
const argAfter = (flag: string) => { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : undefined }
const CUTOVER = argAfter('--cutover')
const CONFIRMED = ARGS.includes('--confirmo-setes-api-parado')
// o ATO só grava com `--vai`; sem ele, ensaio (M3) — a re-sincronia segue o `--dry-run` de sempre
const DRY = ARGS.includes('--dry-run') || (CUTOVER !== undefined && !ARGS.includes('--vai'))
const SECRETS = path.resolve(process.env.SETES_SECRETS_PATH ?? path.join(__dirname, '..', '..', 'setes-api', 'secrets'))

interface Report { schema: string; institutionId: number; issuers: number; certificate: string; dps: number; transmissions: number; events: number; xmlMissing: string[] }

const exists = async (c: PoolConnection, schema: string, table: string) => {
  const [r] = await c.query<any[]>(`SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`, [schema, table])
  return r.length > 0
}

async function migrateInstitution(c: PoolConnection, keyring: MasterKeyRing, storage: FsFiscalStorage, institutionId: number, schemaName: string): Promise<Report | null> {
  const s = assertSchema(schemaName)
  if (!(await exists(c, s, 'tb_establishment_issuer'))) return null
  const rep: Report = { schema: s, institutionId, issuers: 0, certificate: '-', dps: 0, transmissions: 0, events: 0, xmlMissing: [] }

  // 1. habilitação SÓ do modelo da família (D-F42); a ORIGEM vence (ambiente/série/deleted), o contador só sobe (GREATEST)
  const [issuers] = await c.query<any[]>(
    `SELECT tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted
       FROM \`${s}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = ?`, [institutionId, SERVICE_MODEL])
  for (const i of issuers) {
    const [r] = await c.query<any>(
      `INSERT INTO tb_establishment_issuer
         (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE environment = VALUES(environment), serie = VALUES(serie),
         dps_last_number = GREATEST(dps_last_number, VALUES(dps_last_number)), deleted = VALUES(deleted), updated_at = VALUES(updated_at)`,
      [i.tb_institution_id, i.model, i.environment, i.serie, i.dps_last_number,
       i.tb_user_id, i.created_at, i.updated_at, i.deleted])
    rep.issuers += Number(r.affectedRows ?? 0)
  }

  // 2. A1 do cofre em arquivo (setes-api: <SECRETS>/<schema>/establishment/<inst>/P/) → cifrado no banco
  const dir = path.join(SECRETS, s, 'establishment', String(institutionId), 'P')
  const certFile = path.join(dir, 'certificate.pem'), keyFile = path.join(dir, 'private.key')
  const [hasCert] = await c.query<any[]>(
    `SELECT fingerprint256 AS fp, DATE_FORMAT(not_after, '%Y-%m-%d %H:%i:%s') AS notAfter FROM tb_establishment_certificate WHERE tb_institution_id = ? AND deleted = 'N'`, [institutionId])
  const source = fs.existsSync(certFile) ? certificateInfo(fs.readFileSync(certFile, 'utf8')) : null
  const sourceNotAfter = source ? source.notAfter.slice(0, 19).replace('T', ' ') : null
  if (hasCert.length && hasCert[0].fp === source?.fingerprint256) rep.certificate = 'já no fiscal_api (mesmo certificado)'
  else if (hasCert.length && sourceNotAfter && String(hasCert[0].notAfter) > sourceNotAfter) {
    // o A1 MAIS NOVO vence (renovação nunca regride — gates da F1); só acontece se o fiscal_api recebeu A1 fora da cerca
    rep.certificate = `mantido o do fiscal_api (vence ${String(hasCert[0].notAfter).slice(0, 10)} > origem ${sourceNotAfter.slice(0, 10)})`
  } else if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const certPem = fs.readFileSync(certFile, 'utf8'), keyPem = fs.readFileSync(keyFile, 'utf8')
    const why = validatePrivateKeyPem(keyPem)
    if (why || !keyMatchesCertificate(certPem, keyPem)) throw new Error(`A1 de ${s}/${institutionId} inconsistente no cofre de origem (${why ?? 'par não casa'}) — nada migrado`)
    const info = certificateInfo(certPem)
    const sealed = keyring.seal(keyPem, certificateAad(institutionId))
    const dt = (iso: string) => iso.slice(0, 19).replace('T', ' ')
    await c.query(
      `INSERT INTO tb_establishment_certificate
         (tb_institution_id, cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version,
          subject, issued_by, not_before, not_after, fingerprint256, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE cnpj = VALUES(cnpj), certificate_pem = VALUES(certificate_pem), private_key_cipher = VALUES(private_key_cipher),
         private_key_iv = VALUES(private_key_iv), private_key_tag = VALUES(private_key_tag), cipher_key_version = VALUES(cipher_key_version),
         subject = VALUES(subject), issued_by = VALUES(issued_by), not_before = VALUES(not_before), not_after = VALUES(not_after),
         fingerprint256 = VALUES(fingerprint256), deleted = 'N', updated_at = NOW()`,
      [institutionId, info.cnpj, certPem, sealed.cipher, sealed.iv, sealed.tag, sealed.version,
       info.subject.slice(0, 512), info.issuer.slice(0, 512), dt(info.notBefore), dt(info.notAfter), info.fingerprint256])
    rep.certificate = `${hasCert.length ? 'RENOVADO' : 'migrado'} (CNPJ ${info.cnpj ?? '?'}, vence ${info.notAfter.slice(0, 10)}${info.expired ? ' — VENCIDO' : ''})`
  } else rep.certificate = 'ausente no cofre de origem'

  if (!(await exists(c, s, 'tb_invoice_service_transmission'))) return rep

  // 3. DPS de cada VIDA — premissas da D-F30 conferidas ANTES de gravar
  const [noLife] = await c.query<any[]>(`SELECT COUNT(*) n FROM \`${s}\`.tb_invoice_service_transmission WHERE tb_institution_id = ? AND invoice_event IS NULL`, [institutionId])
  if (Number(noLife[0].n) > 0) throw new Error(`${s}: ${noLife[0].n} tentativa(s) sem vida (invoice_event NULL) — §13.3 assumiu zero; nada migrado`)
  const [lives] = await c.query<any[]>(
    `SELECT tb_invoice_id AS inv, terminal, invoice_event AS life, COUNT(DISTINCT dps_id) AS ids, MIN(dps_id) AS dpsId,
            MIN(created_at) AS createdAt, MIN(tb_user_id) AS userId
       FROM \`${s}\`.tb_invoice_service_transmission
      WHERE tb_institution_id = ? AND dps_id IS NOT NULL
      GROUP BY tb_invoice_id, terminal, invoice_event`, [institutionId])
  for (const l of lives) {
    if (Number(l.ids) !== 1) throw new Error(`${s}: nota ${l.inv} vida ${l.life} com ${l.ids} Ids de DPS — premissa da D-F30 quebrada; nada migrado`)
    const dpsId = String(l.dpsId)
    if (!/^DPS\d{42}$/.test(dpsId)) throw new Error(`${s}: Id de DPS fora do padrão (${dpsId})`)
    const serie = String(Number(dpsId.slice(25, 30)))          // DPS(3)+cMun(7)+tpInsc(1)+CNPJ(14) = 25 → série(5) → nDPS(15)
    const nDps = Number(dpsId.slice(30))
    const [r] = await c.query<any>(
      `INSERT IGNORE INTO tb_invoice_service_dps (tb_institution_id, tb_invoice_id, terminal, life_event, serie, dps_number, dps_id, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N')`,
      [institutionId, l.inv, l.terminal, l.life, serie, nDps, dpsId, l.userId, l.createdAt, l.createdAt])
    rep.dps += Number(r.affectedRows ?? 0)
    if (!Number(r.affectedRows ?? 0)) {
      // write-once: o que já está tem que ser o MESMO DPS (INSERT IGNORE calaria a divergência)
      const [cur] = await c.query<any[]>(
        `SELECT dps_id AS id FROM tb_invoice_service_dps WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND life_event = ?`,
        [institutionId, l.inv, l.terminal, l.life])
      if (cur[0] && String(cur[0].id) !== dpsId) {
        throw new Error(`${s}: nota ${l.inv} vida ${l.life} tem DPS ${cur[0].id} no fiscal_api e ${dpsId} na origem — dual-write (D-F18); nada migrado`)
      }
    }
  }
  // tentativa no fiscal_api que a origem NÃO tem = emitida pela nfse-api com a institution na cerca → dual-write
  const [extra] = await c.query<any[]>(
    `SELECT f.tb_invoice_id AS inv, f.attempt FROM tb_invoice_service_transmission f
      WHERE f.tb_institution_id = ? AND NOT EXISTS (SELECT 1 FROM \`${s}\`.tb_invoice_service_transmission src
        WHERE src.tb_institution_id = f.tb_institution_id AND src.tb_invoice_id = f.tb_invoice_id AND src.terminal = f.terminal AND src.attempt = f.attempt)
      LIMIT 5`, [institutionId])
  if (extra.length) throw new Error(`${s}: o fiscal_api tem tentativa(s) que a origem não tem (${extra.map(x => `${x.inv}/${x.attempt}`).join(', ')}) — dual-write (D-F18); nada migrado`)

  // 4. tentativas (a vida vira life_event; o nDPS fica no DPS da vida)
  const [t] = await c.query<any>(
    `INSERT INTO tb_invoice_service_transmission
       (tb_institution_id, tb_invoice_id, terminal, attempt, life_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted)
     SELECT tb_institution_id, tb_invoice_id, terminal, attempt, invoice_event, environment, access_key, nfse_number, dh_proc, last_queried_at, tb_user_id, created_at, updated_at, deleted
       FROM \`${s}\`.tb_invoice_service_transmission src WHERE tb_institution_id = ? AND dps_id IS NOT NULL
     ON DUPLICATE KEY UPDATE access_key = COALESCE(tb_invoice_service_transmission.access_key, src.access_key),
       nfse_number = COALESCE(tb_invoice_service_transmission.nfse_number, src.nfse_number),
       dh_proc = COALESCE(tb_invoice_service_transmission.dh_proc, src.dh_proc),
       last_queried_at = GREATEST(COALESCE(tb_invoice_service_transmission.last_queried_at, src.last_queried_at), COALESCE(src.last_queried_at, tb_invoice_service_transmission.last_queried_at)),
       deleted = src.deleted, updated_at = GREATEST(tb_invoice_service_transmission.updated_at, src.updated_at)`, [institutionId])
  rep.transmissions = Number(t.affectedRows ?? 0)

  // 5. vozes (sem a coluna de efeito — D-F28). ANTES, o DOMÍNIO da origem (gates da A1 da F2a, F2A1-08): o `INSERT IGNORE … SELECT` abaixo
  // REBAIXA a violação do CHECK da 005 (kind = lista da família, source = P/Q, binários) a AVISO e a linha SOME calada (provado no MariaDB
  // 10.4.20; no MySQL 8, pela documentação dele, também) — a conferência do passo 6 só vê a ÚLTIMA voz e não acusaria uma voz do meio. Voz fora do domínio na origem
  // = falha ALTO aqui, com o motivo certo (não "dual-write"). Tentativa e habilitação são copiadas SEM IGNORE (o CHECK já falha alto).
  // F2A3-ADV-02 (gate adversarial da A3): o código da voz C também — '105102 ' (espaço no fim) passava no CHECK _ci PAD SPACE da origem e,
  // com a 006 desta API, sumiria calado na cópia; fora da lista EXATA (6 caracteres, binária) = falha ALTO aqui
  const [outOfDomain] = await c.query<any[]>(
    `SELECT ev.tb_invoice_id AS inv, ev.attempt, ev.event, HEX(ev.kind) AS kindHex, HEX(ev.source) AS sourceHex, HEX(ev.authority_code) AS codeHex
       FROM \`${s}\`.tb_invoice_service_transmission_event ev
       JOIN \`${s}\`.tb_invoice_service_transmission t
         ON t.tb_institution_id = ev.tb_institution_id AND t.tb_invoice_id = ev.tb_invoice_id AND t.terminal = ev.terminal AND t.attempt = ev.attempt
      WHERE ev.tb_institution_id = ? AND t.dps_id IS NOT NULL
        AND (ev.kind COLLATE utf8mb4_bin NOT IN (?) OR ev.source COLLATE utf8mb4_bin NOT IN ('P', 'Q')
             OR (ev.kind COLLATE utf8mb4_bin = 'C' AND ev.authority_code IS NOT NULL
                 AND (CHAR_LENGTH(ev.authority_code) <> 6 OR ev.authority_code COLLATE utf8mb4_bin NOT IN (?))))
      LIMIT 5`, [institutionId, [...SERVICE_VOICE_WRITE_KINDS], [...CANCEL_EVENT_CODES]])
  if (outOfDomain.length) {
    throw new Error(`${s}: voz FORA DO DOMÍNIO na origem (${outOfDomain.map(x => `${x.inv}/${x.attempt}#${x.event} kind=0x${x.kindHex} source=0x${x.sourceHex} code=0x${x.codeHex ?? ''}`).join(', ')}) `
      + `— a família NFS-e só grava ${SERVICE_VOICE_WRITE_KINDS.join('/')}, P/Q e, na voz C, o código exato ${[...CANCEL_EVENT_CODES].join('/')} `
      + '(D-F107/D-F120/D-F68); corrija a origem antes; nada migrado')
  }
  const [e] = await c.query<any>(
    `INSERT IGNORE INTO tb_invoice_service_transmission_event
       (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
     SELECT ev.tb_institution_id, ev.tb_invoice_id, ev.terminal, ev.attempt, ev.event, ev.kind, ev.authority_code, ev.message, ev.dh, ev.source, ev.tb_user_id, ev.created_at, ev.updated_at, ev.deleted
       FROM \`${s}\`.tb_invoice_service_transmission_event ev
       JOIN \`${s}\`.tb_invoice_service_transmission t
         ON t.tb_institution_id = ev.tb_institution_id AND t.tb_invoice_id = ev.tb_invoice_id AND t.terminal = ev.terminal AND t.attempt = ev.attempt
      WHERE ev.tb_institution_id = ? AND t.dps_id IS NOT NULL`, [institutionId])
  rep.events = Number(e.affectedRows ?? 0)
  // D-F75 (= Q-F82 (a)): o código da voz C é escrito uma vez e só SOBE para a substituição (105102), nunca volta — o que a
  // origem preencheu ou promoveu depois da cópia chega à réplica pela MESMA regra de mão única do `setCancelEventCode` do
  // setes-api (preenche NULL; sobe para 105102) — o INSERT IGNORE não atualiza voz já copiada (L6 do gate da Rodada 13: só a
  // subida era espelhada e o preenchimento na origem virava falso "dual-write" na conferência abaixo)
  await c.query(
    `UPDATE tb_invoice_service_transmission_event f
       JOIN \`${s}\`.tb_invoice_service_transmission_event src
         ON src.tb_institution_id = f.tb_institution_id AND src.tb_invoice_id = f.tb_invoice_id AND src.terminal = f.terminal
        AND src.attempt = f.attempt AND src.event = f.event
        SET f.authority_code = src.authority_code, f.updated_at = UTC_TIMESTAMP()
      WHERE f.tb_institution_id = ? AND f.kind = 'C' AND src.kind = 'C' AND src.authority_code IS NOT NULL
        AND (f.authority_code IS NULL OR (src.authority_code = '105102' AND f.authority_code <> '105102'))`, [institutionId])
  // INSERT IGNORE calaria voz DIFERENTE no mesmo (tentativa, evento): confere kind a kind — e, na voz C, o código (D-F68)
  const [evDiff] = await c.query<any[]>(
    `SELECT f.tb_invoice_id AS inv, f.attempt, f.event FROM tb_invoice_service_transmission_event f
       JOIN \`${s}\`.tb_invoice_service_transmission_event src
         ON src.tb_institution_id = f.tb_institution_id AND src.tb_invoice_id = f.tb_invoice_id AND src.terminal = f.terminal
        AND src.attempt = f.attempt AND src.event = f.event
      WHERE f.tb_institution_id = ? AND (NOT (src.kind <=> f.kind) OR (f.kind = 'C' AND NOT (src.authority_code <=> f.authority_code))) LIMIT 5`, [institutionId])
  if (evDiff.length) throw new Error(`${s}: voz divergente entre origem e fiscal_api (${evDiff.map(x => `${x.inv}/${x.attempt}#${x.event}`).join(', ')}) — dual-write (D-F18); nada migrado`)

  // 6. conferências: contador do emissor ≥ maior nDPS migrado (D-N18); última voz igual nos dois lados
  const [mx] = await c.query<any[]>(`SELECT COALESCE(MAX(dps_number), 0) m FROM tb_invoice_service_dps WHERE tb_institution_id = ?`, [institutionId])
  const [ctr] = await c.query<any[]>(`SELECT dps_last_number n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE'`, [institutionId])
  if (ctr[0] && Number(ctr[0].n) < Number(mx[0].m)) throw new Error(`${s}: contador do emissor (${ctr[0].n}) < maior nDPS migrado (${mx[0].m}) — D-N18 violada`)
  const [diff] = await c.query<any[]>(
    `SELECT v.tb_invoice_id, v.attempt FROM vw_invoice_service_transmission v
      WHERE v.tb_institution_id = ? AND NOT (v.last_kind <=> (
        SELECT x.kind FROM \`${s}\`.tb_invoice_service_transmission_event x
         WHERE x.tb_institution_id = v.tb_institution_id AND x.tb_invoice_id = v.tb_invoice_id AND x.terminal = v.terminal
           AND x.attempt = v.attempt AND x.deleted = 'N' ORDER BY x.event DESC LIMIT 1))`, [institutionId])
  if (diff.length) throw new Error(`${s}: última voz diverge em ${diff.length} tentativa(s) depois da cópia — nada migrado`)

  // 7. XMLs: conferidos DEPOIS do commit (`checkXmls`) — o INSERT…SELECT trava em modo compartilhado as linhas da origem
  //    (REPEATABLE READ) durante a transação inteira; o disco não precisa estar dentro dela (re-prova R4)
  return rep
}

/**
 * XMLs achados pelo storage da nfse-api (mesmo STORAGE_PATH no dev — §12.6) — fora da transação. DEPOIS do commit nada pode
 * negar o commit (re-prova R4): qualquer falha aqui vira AVISO no relatório, nunca "FALHA (nada gravado)".
 */
async function checkXmls(q: { query: PoolConnection['query'] }, storage: FsFiscalStorage, rep: Report): Promise<void> {
  try { await checkXmlsUnsafe(q, storage, rep) } catch (err) {
    rep.xmlMissing.push(`conferência de XML NÃO concluída (${err instanceof Error ? err.message : String(err)}) — o que foi gravado ESTÁ gravado`)
  }
}

async function checkXmlsUnsafe(q: { query: PoolConnection['query'] }, storage: FsFiscalStorage, rep: Report): Promise<void> {
  const [keyed] = await q.query<any[]>(
    `SELECT t.access_key AS k, t.environment AS env, DATE_FORMAT(t.dh_proc, '%Y-%m-%d %H:%i:%s') AS dh, DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS cr, ce.cnpj
       FROM tb_invoice_service_transmission t LEFT JOIN tb_establishment_certificate ce ON ce.tb_institution_id = t.tb_institution_id
      WHERE t.tb_institution_id = ? AND t.access_key IS NOT NULL`, [rep.institutionId])
  for (const k of keyed) {
    if (!k.cnpj) { rep.xmlMissing.push(`${k.k} (sem CNPJ do A1 para achar a pasta)`); continue }
    if (!storage.find(k.cnpj, `${k.k}-nfse.xml`, [k.dh, k.cr], k.env, 'America/Sao_Paulo')) rep.xmlMissing.push(`${k.k}-nfse.xml (${k.env})`)
  }
}

/**
 * As linhas da habilitação da institution no `fiscal_api`, TRAVADAS por linha (PADROES §9 regra 8) — a decisão "réplica ×
 * congelada" e a virada leem o ATUAL, nunca o snapshot (gate socrático do delta de 2026-10-04: o COUNT não travante deixava
 * o ON DUPLICATE KEY UPDATE da re-sincronia reescrever uma linha virada em paralelo). D-F42: réplica de outro modelo = FALHA.
 */
async function lockApiIssuers(c: PoolConnection, s: string, institutionId: number): Promise<{ rows: number; replicas: number; serviceRows: number; serviceReplicas: number }> {
  const list = await apiIssuerRows(c, institutionId, true)
  assertNoForeignReplica(list, s, institutionId)
  const service = list.filter((r: any) => r.model === SERVICE_MODEL)
  return { rows: list.length, replicas: list.filter((r: any) => r.c == null).length,
    serviceRows: service.length, serviceReplicas: service.filter((r: any) => r.c == null).length }
}

async function apiIssuerRows(c: PoolConnection, institutionId: number, forUpdate: boolean): Promise<any[]> {
  const [list] = await c.query<any[]>(
    `SELECT model, cutover_at AS c FROM tb_establishment_issuer
      WHERE tb_institution_id = ? AND model IN (${ISSUER_MODELS.map(() => '?').join(', ')})${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, ...ISSUER_MODELS])
  return list
}

function assertNoForeignReplica(list: any[], s: string, institutionId: number): void {
  const strange = list.filter((r: any) => r.c == null && r.model !== SERVICE_MODEL).map((r: any) => r.model)
  if (strange.length) {
    throw new Error(`${s}: o fiscal_api tem réplica do ERP de modelo ${strange.join(', ')} — só a ${SERVICE_MODEL} muda de casa (D-F42); `
      + `apague à mão com DELETE físico (soft delete continua réplica): DELETE FROM tb_establishment_issuer WHERE tb_institution_id = ${institutionId} AND model IN (${strange.map((m: string) => `'${m}'`).join(', ')}) AND cutover_at IS NULL`)
  }
}

/**
 * Institution VIRADA: o `fiscal_api` é a verdade e a origem está congelada. Origem com tentativa que o `fiscal_api`
 * não tem, ou contador SE além do da API = o ERP ainda emitindo depois da virada → FALHA ALTO (dual-write).
 */
async function assertFrozen(c: PoolConnection, s: string, institutionId: number): Promise<string> {
  const [ctr] = await c.query<any[]>(
    `SELECT e.dps_last_number AS erp, f.dps_last_number AS api
       FROM \`${s}\`.tb_establishment_issuer e
       JOIN tb_establishment_issuer f ON f.tb_institution_id = e.tb_institution_id AND f.model = e.model
      WHERE e.tb_institution_id = ? AND e.model = 'SE'`, [institutionId])
  if (ctr[0] && Number(ctr[0].erp) > Number(ctr[0].api)) {
    throw new Error(`${s}: VIRADA, mas o contador do ERP (${ctr[0].erp}) passou o da API (${ctr[0].api}) — o ERP cunhou nDPS depois da virada (dual-write)`)
  }
  if (await exists(c, s, 'tb_invoice_service_transmission')) {
    const [extra] = await c.query<any[]>(
      `SELECT src.tb_invoice_id AS inv, src.attempt FROM \`${s}\`.tb_invoice_service_transmission src
        WHERE src.tb_institution_id = ? AND src.dps_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tb_invoice_service_transmission f
          WHERE f.tb_institution_id = src.tb_institution_id AND f.tb_invoice_id = src.tb_invoice_id AND f.terminal = src.terminal AND f.attempt = src.attempt)
        LIMIT 5`, [institutionId])
    if (extra.length) throw new Error(`${s}: VIRADA, mas a origem tem tentativa(s) que o fiscal_api não tem (${extra.map(x => `${x.inv}/${x.attempt}`).join(', ')}) — o ERP emitiu depois da virada (dual-write)`)
    // gate adversarial R4: a VOZ nova da origem (o setes-api ainda consultando/cancelando no fisco) também é dual-write
    const [voice] = await c.query<any[]>(
      `SELECT ev.tb_invoice_id AS inv, ev.attempt, ev.event, ev.kind FROM \`${s}\`.tb_invoice_service_transmission_event ev
         JOIN \`${s}\`.tb_invoice_service_transmission t
           ON t.tb_institution_id = ev.tb_institution_id AND t.tb_invoice_id = ev.tb_invoice_id AND t.terminal = ev.terminal AND t.attempt = ev.attempt
        WHERE ev.tb_institution_id = ? AND t.dps_id IS NOT NULL AND ev.deleted = 'N'
          AND NOT EXISTS (SELECT 1 FROM tb_invoice_service_transmission_event f
                           WHERE f.tb_institution_id = ev.tb_institution_id AND f.tb_invoice_id = ev.tb_invoice_id AND f.terminal = ev.terminal
                             AND f.attempt = ev.attempt AND f.event = ev.event AND f.kind = ev.kind)
        LIMIT 5`, [institutionId])
    if (voice.length) throw new Error(`${s}: VIRADA, mas a origem tem voz que o fiscal_api não tem (${voice.map(x => `${x.inv}/${x.attempt}#${x.event}${x.kind}`).join(', ')}) — o ERP falou com o fisco depois da virada (dual-write)`)
  }
  return 'virada — origem congelada, nada copiado'
}

/**
 * Re-sincronia de TODAS as institutions — D-F48 (= Q-F58 (a), Valdo 2026-10-04): UMA TRANSAÇÃO POR INSTITUTION. O
 * "tudo ou nada" global (D-F18) não protegia nenhum invariante ENTRE institutions e, com a trava por linha (§17.2),
 * segurava FOR UPDATE nas habilitações VIRADAS de todas até o commit final (transmitir/cancelar delas esperavam e voltavam
 * 409). Agora cada institution trava só o tempo dela; a que falha volta SOZINHA (nada dela gravado), as outras seguem, e o
 * script sai com erro listando as que falharam (falha alta preservada).
 */
async function resyncAll(pool: ReturnType<typeof createFiscalPool>, keyring: MasterKeyRing, storage: FsFiscalStorage): Promise<void> {
  let c = await pool.getConnection()
  const reports: (Report | { schema: string; institutionId: number; state: string })[] = []
  const failures: { schema: string; institutionId: number; error: string }[] = []
  try {
    const [insts] = await c.query<any[]>(`SELECT id, schema_name AS schemaName FROM setes_central.tb_institution WHERE deleted = 'N' ORDER BY id`)
    for (const i of insts) {
      const s = assertSchema(String(i.schemaName)), id = Number(i.id)
      try {
        await c.beginTransaction()
        const rep = await resyncInstitution(c, keyring, storage, s, id)
        if (DRY) await c.rollback(); else await c.commit()
        if (rep) reports.push(rep)
      } catch (err) {
        // a CAUSA RAIZ é o erro da institution (gate r9 LOW [r9-resync-rollback-throws]); conexão que não desfaz (caída)
        // é DESCARTADA e a próxima institution usa outra — o laço e o relatório das já gravadas seguem
        failures.push({ schema: s, institutionId: id, error: String((err as Error)?.message ?? err) })
        try { await c.rollback() } catch {
          try { (c as any).destroy?.() } catch { /* já morta */ }
          c = await pool.getConnection()
        }
      }
    }
    for (const r of reports) if ('xmlMissing' in r) await checkXmls(c, storage, r)
  } finally {
    // o relatório sai SEMPRE — inclusive o das institutions já gravadas quando o laço para por erro de infraestrutura
    console.log(JSON.stringify({ dryRun: DRY, committed: !DRY, reports, failures,
      ...(DRY ? { nota: 'dry-run: a conferência de XML lê o estado ATUAL (a cópia foi desfeita)' } : {}) }, null, 2))
    c.release()
  }
  if (failures.length) {
    throw new Error(`re-sincronia: ${failures.length} institution(s) com falha — nada delas gravado`
      + `${DRY ? '' : '; as demais foram gravadas'}: ${failures.map(f => f.error).join(' | ')}`)
  }
}

/** Uma institution, DENTRO da transação dela (D-F48). */
async function resyncInstitution(c: PoolConnection, keyring: MasterKeyRing, storage: FsFiscalStorage, s: string, id: number)
  : Promise<Report | { schema: string; institutionId: number; state: string } | null> {
  if (!(await erp.erpServiceIssuerExists(c, s, id))) {                 // o ERP nunca emitiu por ela (o MESMO predicado da lacuna (b))
    // gate adversarial r8 LOW [r8-resync-55]: mesmo sem SE no ERP, réplica de OUTRO modelo (resíduo de versão antiga do
    // script) trava a institution pela cerca sem saída pelo --cutover → falha alta com a instrução de DELETE (D-F42).
    // Leitura NÃO travante: só detecta (o erro desfaz a institution) — travar aqui pegaria gap lock em institution sem linha.
    assertNoForeignReplica(await apiIssuerRows(c, id, false), s, id)
    return null
  }
  // decide pelo ATUAL (trava por linha), não pelo snapshot; D-F57: CONGELADA = a LINHA SE virada (uma 55/65 virada não congela a SE)
  const { serviceRows, serviceReplicas } = await lockApiIssuers(c, s, id)
  if (serviceRows > 0 && serviceReplicas === 0) return { schema: s, institutionId: id, state: await assertFrozen(c, s, id) }
  return (await migrateInstitution(c, keyring, storage, id, s)) ?? null
}

/** Nome FIXO da migration da F2a no setes-api (arquivo `NNN_f2a_fiscal_passivo.sql` → `_migrations.name`) — D-F50. */
export const F2A_MIGRATION_NAME = 'f2a_fiscal_passivo'
/** A LÁPIDE do aborto da F2a no setes-api (D-F153/D-F162 — versão sentinela `F2A-ABORT`): a F2a foi ABORTADA no schema. */
export const F2A_TOMBSTONE_NAME = 'f2a_fiscal_passivo_abortada'

async function setesApiF2aApplied(q: { query: (sql: string, p?: unknown[]) => Promise<any> }, s: string): Promise<boolean> {
  try {
    const [rows] = await q.query(`SELECT 1 AS x FROM \`${s}\`._migrations WHERE name = ? LIMIT 1`, [F2A_MIGRATION_NAME])
    return Array.isArray(rows) && rows.length > 0
  } catch (err: any) {
    if (err?.errno === 1146 || err?.code === 'ER_NO_SUCH_TABLE') return false    // schema sem controle de migrations = sem F2a
    throw err
  }
}

/**
 * A LÁPIDE da F2a abortada (D-F153/D-F162) no schema. Gate socrático da Rodada 7 (R7-SOC-05): o ato RECUSA sempre que ela existir — mesmo
 * com a linha da migration junto (estado que o aborto, o `--retirar-lapide` e o runner da F2a recusam: só nasce de SQL à mão) — a MESMA
 * resposta dos outros leitores. Por isso falha FECHADO como a leitura da F2a (só "sem controle de migrations" vira "sem lápide").
 */
async function setesApiF2aAborted(q: { query: (sql: string, p?: unknown[]) => Promise<any> }, s: string): Promise<boolean> {
  try {
    const [rows] = await q.query(`SELECT name FROM \`${s}\`._migrations WHERE name = ? LIMIT 1`, [F2A_TOMBSTONE_NAME])
    return Array.isArray(rows) && rows.some((r: any) => r?.name === F2A_TOMBSTONE_NAME)
  } catch (err: any) {
    if (err?.errno === 1146 || err?.code === 'ER_NO_SUCH_TABLE') return false
    throw err
  }
}

async function cutover(pool: ReturnType<typeof createFiscalPool>, keyring: MasterKeyRing, storage: FsFiscalStorage, institutionId: number): Promise<void> {
  if (!CONFIRMED) throw new Error('--cutover exige --confirmo-setes-api-parado: o caminho de emissão do setes-api tem de estar PARADO (F2a) antes da virada')
  // o schema vem ANTES da transação (autocommit) — nenhuma leitura não travante dentro dela antes das travas
  const [inst] = await pool.query<any[]>(`SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N'`, [institutionId])
  if (!inst[0]) throw new Error(`Institution ${institutionId} inexistente/excluída`)
  const s = assertSchema(String(inst[0].schemaName))
  // D-F50 (= Q-F59 (a), Valdo 2026-10-04): a virada exige o FATO de que a F2a do setes-api está aplicada NESTE schema — a
  // migration de nome fixo `F2A_MIGRATION_NAME` no `_migrations` do cliente. Sem ela a tela antiga "Emissor fiscal" ainda
  // gravaria a SE (upsert com deleted='N') e REVIVERIA a linha que o ato aposenta (o contador congelado do ERP voltaria a
  // cunhar nDPS já usados — R2-2). Leitura em autocommit, ANTES da transação. No --dry-run vira BLOQUEIO no relatório (o
  // ensaio segue); no ato real, recusa. O rollback do DEPLOY do setes-api depois da virada continua proibido por procedimento.
  const f2aApplied = await setesApiF2aApplied(pool, s)
  // a LÁPIDE (D-F153/D-F162) = a F2a foi ABORTADA aqui: a mesma recusa, com a frase de COMO voltar (R6-SOC-10) — SEMPRE que ela existir,
  // mesmo com a linha junto (R7-SOC-05)
  const f2aAborted = await setesApiF2aAborted(pool, s)
  const f2aMissing = !f2aApplied || f2aAborted
  // gate adversarial da Rodada 7 (R7-ADV-04): lápide COM gatilhos de trava ainda de pé = o aborto ficou PELA METADE (a lápide nasce antes dos
  // DROPs — R5-SOC-05) — o `--retirar-lapide` recusa esse estado; o caminho é terminar o aborto (rodá-lo de novo termina o serviço)
  const abortHalfway = f2aAborted && !f2aApplied
    ? Object.keys(F2A_FREEZE_TRIGGERS).length - (await f2aFreezeTriggersMissing(pool, s)).filter(m => m.endsWith(' ausente')).length
    : 0
  if (f2aAborted && f2aApplied && !DRY) {
    // R7-SOC-05: a linha E a lápide juntas — o aborto e o runner da F2a recusam esse estado; o ato também (a mesma resposta)
    throw new Error(`${s}: a linha "${F2A_MIGRATION_NAME}" E a lápide "${F2A_TOMBSTONE_NAME}" juntas no _migrations — estado que o aborto `
      + 'e o runner da F2a recusam (SQL à mão?); confira antes — nada foi feito (D-F162)')
  }
  if (f2aMissing && !DRY && abortHalfway > 0) {
    throw new Error(`${s}: a F2a do setes-api foi ABORTADA neste schema, mas o aborto ficou PELA METADE (lápide "${F2A_TOMBSTONE_NAME}" + `
      + `${abortHalfway} gatilho(s) de trava de pé) — termine o aborto: \`scripts/f2a-abort-before-cutover.ts <schema> <institutionId> --vai `
      + '--confirmo-setes-api-parado` no setes-api (rodá-lo de novo termina o serviço); só depois, se for o caso, volte à F2a '
      + '(`--retirar-lapide --vai`) (D-F153/D-F162)')
  }
  if (f2aMissing && !DRY) {
    throw new Error(f2aAborted
      ? `${s}: a F2a do setes-api foi ABORTADA neste schema (lápide "${F2A_TOMBSTONE_NAME}" em _migrations — D-F153/D-F162) — voltar à F2a = `
        + '`scripts/f2a-abort-before-cutover.ts <schema> <institutionId> --retirar-lapide --vai` no setes-api e o merge de novo, antes da virada (D-F50)'
      : `${s}: a F2a do setes-api não está aplicada neste schema (migration "${F2A_MIGRATION_NAME}" ausente em _migrations) — `
        + 'a tela antiga do Emissor fiscal reviveria a habilitação SE aposentada; aplique a F2a antes da virada (D-F50)')
  }
  // D-F110 + F2A3-ADV-04: o nome da migration não basta — os 9 gatilhos de TRAVA conferidos pelo NOME (autocommit, ANTES da transação);
  // faltando = BLOQUEIO no ensaio, recusa no ato (sem eles o ERP antigo voltaria a escrever a voz e a reviver a SE aposentada)
  const triggersMissing = f2aMissing ? [] : await f2aFreezeTriggersMissing(pool, s)
  if (triggersMissing.length && !DRY) {
    throw new Error(`${s}: gatilhos de TRAVA da F2a faltando ou diferentes (${triggersMissing.join('; ')}) — "${F2A_MIGRATION_NAME}" consta em `
      + '_migrations, mas o ERP não está congelado (DROP TRIGGER/dump sem gatilhos/restauração, ou o usuário do ato sem o privilégio TRIGGER); '
      + 'reaplique a trava antes da virada — `scripts/f2a-reapply-freeze.ts <schema> --vai` no setes-api (D-F152; D-F110)')
  }
  const bloqueios = [
    ...(f2aMissing ? [f2aAborted
      ? `D-F50: a virada REAL seria recusada — a F2a do setes-api foi ABORTADA em ${s} (lápide "${F2A_TOMBSTONE_NAME}" — D-F153/D-F162)`
      : `D-F50: a virada REAL seria recusada — migration "${F2A_MIGRATION_NAME}" (F2a do setes-api) ausente em ${s}._migrations`] : []),
    ...(triggersMissing.length ? [`D-F110: a virada REAL seria recusada — gatilhos de TRAVA faltando/diferentes em ${s}: ${triggersMissing.join('; ')}`] : []),
  ]
  const c = await pool.getConnection()
  try {
    await c.beginTransaction()
    // 1. a habilitação SE do ERP travada PRIMEIRO, pela PK (D-F42: a 55/65 do ERP é a série do faturamento — fica livre)
    const [erpRows] = await c.query<any[]>(
      `SELECT model, serie, deleted, dps_last_number AS n FROM \`${s}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = ? FOR UPDATE`,
      [institutionId, SERVICE_MODEL])
    if (!erpRows.length) throw new Error(`${s}: o ERP não tem habilitação ${SERVICE_MODEL} — nada a virar`)
    // D-F44: aposentar a linha muda a série da NOTA das notas novas para o default — conferida ANTES de qualquer escrita
    assertNoteSerieKept(s, { serie: erpRows[0].serie == null ? null : String(erpRows[0].serie), deleted: String(erpRows[0].deleted) })
    // 2. as linhas do fiscal_api, por linha; réplica de outro modelo = FALHA (D-F42)
    const api = await lockApiIssuers(c, s, institutionId)
    // D-F57 + gate adversarial r8 (ADV-R8-08): "já VIRADA" pela LINHA SE (uma 55/65 que nasceu virada não é a virada da SE)
    if (api.serviceRows > 0 && api.serviceReplicas === 0) throw new Error(`${s}: já VIRADA — a virada é write-once (D-F39)`)
    // 3. transmissão VIVA na origem
    const [live] = await c.query<any[]>(
      `SELECT t.tb_invoice_id AS inv, t.attempt FROM \`${s}\`.tb_invoice_service_transmission t
        LEFT JOIN \`${s}\`.tb_invoice_service_transmission_event le
          ON le.tb_institution_id = t.tb_institution_id AND le.tb_invoice_id = t.tb_invoice_id AND le.terminal = t.terminal
         AND le.attempt = t.attempt AND le.deleted = 'N'
         AND le.event = (SELECT MAX(x.event) FROM \`${s}\`.tb_invoice_service_transmission_event x
                          WHERE x.tb_institution_id = t.tb_institution_id AND x.tb_invoice_id = t.tb_invoice_id
                            AND x.terminal = t.terminal AND x.attempt = t.attempt AND x.deleted = 'N')
       WHERE t.tb_institution_id = ? AND t.deleted = 'N' AND t.dps_id IS NOT NULL AND (le.kind IS NULL OR le.kind IN ('S','K'))
       LIMIT 5`, [institutionId])
    if (live.length) throw new Error(`${s}: transmissão VIVA na origem (${live.map((x: any) => `${x.inv}/${x.attempt}`).join(', ')}) — reconcilie no setes-api antes da virada`)
    // 4. a re-sincronia de sempre
    const rep = await migrateInstitution(c, keyring, storage, institutionId, s)
    // 5. a VIRADA — todas as linhas da institution ainda réplica, PELA PK (gate do delta da Rodada 6, L1: o UPDATE pela faixa
    //    da institution pedia next-key na linha já travada por REGISTRO no passo 2 — a promoção de trava da regra 8 do PADROES §9)
    const [u] = await c.query<any>(
      `UPDATE tb_establishment_issuer SET cutover_at = NOW(), updated_at = NOW()
        WHERE tb_institution_id = ? AND model IN (?) AND cutover_at IS NULL`, [institutionId, ISSUER_MODELS])
    // 6. D-F44: a habilitação SE do ERP é APOSENTADA na MESMA transação (a única escrita de uma API fiscal no ERP — D-F31);
    //    a reserva do setes-api que esperava a trava acorda e recebe 409 FISCAL_ISSUER_MISSING
    const retired = await retireErpServiceIssuer(c, s, institutionId, SERVICE_MODEL)
    // 7. pós-condição pelo predicado do ESTABELECIMENTO (D-F39; D-NE10: o ato é por institution — réplica em QUALQUER linha ou a lacuna (b)
    //    da SE; o grão do modelo deixaria passar réplica de outro modelo) — virada que não fecha a cerca não comita
    if (await anyEmissionStillInErp(c, s, institutionId)) throw new Error(`${s}: depois da virada o predicado ainda diz "emissão do ERP" — nada gravado`)
    if (DRY) await c.rollback(); else await c.commit()
    if (rep) await checkXmls(c, storage, rep)
    console.log(JSON.stringify({ dryRun: DRY, committed: !DRY,
      cutover: { institutionId, schema: s, linhasViradas: Number(u.affectedRows ?? 0), habilitacaoErpAposentada: retired }, report: rep,
      ...(bloqueios.length ? { bloqueios } : {}),
      nota: 'D-F44: a habilitação SE do ERP foi aposentada no ato (deleted=S) — o setes-api não emite mais por ela; a série da nota segue \'1\'.' }, null, 2))
  } catch (err) {
    // gate do delta (L6): rollback que falha (conexão morta) não pode esconder a CAUSA RAIZ do ato — molde do r9 da re-sincronia
    try { await c.rollback() } catch (rbErr) { console.error('[migrate:setes] rollback do ato falhou (a conexão morta desfaz sozinha):', (rbErr as Error)?.message ?? rbErr) }
    throw err
  } finally {
    c.release()
  }
}

async function main(): Promise<void> {
  const bad = argumentErrors(ARGS)
  if (bad.length) throw new Error(`${bad.join('; ')} — uso: [--dry-run] | --cutover <id> --confirmo-setes-api-parado [--vai]`)
  const swallowed = npmSwallowedFlags(process.env)
  if (swallowed.length) throw new Error(`o npm engoliu ${swallowed.join(', ')} (faltou o "--"): use \`npm run migrate:setes -- ${swallowed.join(' ')} …\` — nada foi feito`)
  const cfg = dbConfigFromEnv()
  const pool = createFiscalPool(cfg)
  const keyring = MasterKeyRing.fromEnv()
  if (keyring.currentVersion === null) throw new Error('FISCAL_MASTER_KEYS ausente — o A1 não pode ser cifrado')
  const storage = new FsFiscalStorage(path.resolve(process.env.STORAGE_PATH ?? 'storage'))
  try {
    if (CUTOVER !== undefined) {
      const id = Number(CUTOVER)
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`--cutover precisa de um institutionId (veio "${CUTOVER}")`)
      await cutover(pool, keyring, storage, id)
    } else {
      await resyncAll(pool, keyring, storage)
    }
  } finally {
    await pool.end()
  }
}

// virada: uma transação só (nada gravado na falha); re-sincronia: o texto do erro diz o que voltou (D-F48).
// Roda ao ser carregado (os testes de script o carregam com process.argv trocado); as funções puras de argumento vivem em
// `migrate-args.ts` para os testes as importarem sem disparar o main.
main().catch(err => { console.error('[migrate:setes] FALHA:', err?.message ?? err); process.exit(1) })
