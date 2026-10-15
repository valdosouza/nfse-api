/**
 * D-F36 (Valdo 2026-10-04, = Q-F45 (a)) — SMOKE da nfse-api no ADN de HOMOLOGAÇÃO, ANTES da virada, sem tocar a
 * numeração de produção do setes-api. Forma (parecer do guardião sobre a D-F39 — §16 do prompt): a virada é WRITE-ONCE
 * (`cutover_at`), então o smoke NÃO vira a habilitação real; ele roda num banco fiscal DESCARTÁVEL (`fiscal_api_smoke`,
 * molde do `fiscal_api_f0probe` do §14.5) com storage próprio:
 *   - banco descartável recriado do zero pelas migrations do núcleo + família; A1 COPIADO do `fiscal_api` (mesma
 *     chave-mestra, mesma institution → a cifra abre); habilitação SE em **H**, série **900**, VIRADA no nascimento;
 *     contador do nDPS começando num valor por minuto (Id de DPS novo a cada execução);
 *   - o ERP é só LIDO (a nota de teste, o ramo de serviço, o emitente, o tomador) e a nota é TRAVADA por instantes
 *     (FOR UPDATE — D-F27), como em toda transmissão; nenhuma escrita no ERP; o `fiscal_api` real fica intocado;
 *   - roteiro: transmitir → consultar → XML + DANFSe → cancelar NO FISCO (e101101) → consultar (voz C);
 *   - no fim o banco descartável é APAGADO (--manter o preserva para inspeção); o arquivo fiscal do smoke fica no
 *     storage próprio (evidência).
 * ⚠️ Fala com o fisco (homologação). SEM `--vai` só CONFERE as pré-condições (A1, nota, DPS montável) — nada é enviado.
 *
 * Uso: npm run smoke:adn-h -- --candidatas            (lista notas de teste ELEGÍVEIS — só leitura)
 *      npm run smoke:adn-h -- --nota <invoiceId> [--vai] [--manter] [--descartar-evidencia]
 *   SMOKE_DB_USER / SMOKE_DB_PASSWORD — usuário com CREATE/DROP do banco descartável e SELECT no ERP (o do serviço não
 *   cria banco — D-F31); SMOKE_DB_NAME (padrão fiscal_api_smoke); SMOKE_STORAGE_PATH (padrão storage-smoke/<instante>).
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import {
  createFiscalPool, dbConfigFromEnv, runMigrations, MasterKeyRing, FsFiscalStorage, openIssuer, HttpError, invoiceRef, WEB_TERMINAL,
} from 'fiscal-api'
import { MIGRATION_SETS } from '../src/migrations'
import { adnAdapter } from '../src/authority/adn'
import { readServiceInvoice, buildDpsBase, emitterDisplay } from '../src/facts/service-facts'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, readNfseXml, getServiceFiscalView, NfseDeps,
} from '../src/nfse/transmission'
import { renderDanfse } from '../src/nfse/danfse'

const argAfter = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
const INVOICE = Number(argAfter('--nota'))
/** A borda do script monta a referência INTEIRA da nota da web (NE-1a parte 2 — D-NE12). */
const webRef = (invoiceId: number) => invoiceRef(INST, invoiceId, WEB_TERMINAL)
const VAI = process.argv.includes('--vai')
const KEEP = process.argv.includes('--manter')
const LIST = process.argv.includes('--candidatas')
const DISCARD = process.argv.includes('--descartar-evidencia')
const INST = 1
const SCHEMA = 'setes_setes'
const SERIE = '900'
const SMOKE_DB = process.env.SMOKE_DB_NAME ?? 'fiscal_api_smoke'
const MOTIVE = 'Smoke da nfse-api em homologação (D-F36) — cancelamento de teste'

function step(label: string, data?: unknown): void {
  console.log(`\n== ${label}${data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`}`)
}

/** Notas de serviço E, nunca transmitidas (nem no ERP nem no fiscal_api), cujo DPS de H MONTA hoje — só leitura. */
async function listCandidates(pool: ReturnType<typeof createFiscalPool>, fiscalDb: string): Promise<void> {
  const [rows] = await pool.query<any[]>(
    `SELECT i.id FROM \`${SCHEMA}\`.tb_invoice i
       JOIN \`${SCHEMA}\`.tb_invoice_service sv ON sv.id = i.id AND sv.tb_institution_id = i.tb_institution_id AND sv.terminal = i.terminal AND sv.deleted = 'N'
       JOIN \`${SCHEMA}\`.vw_invoice_life l ON l.tb_institution_id = i.tb_institution_id AND l.tb_invoice_id = i.id AND l.terminal = i.terminal
      WHERE i.tb_institution_id = ? AND i.terminal = ? AND i.deleted = 'N' AND i.issuer = i.tb_institution_id AND l.last_kind = 'E'
        AND NOT EXISTS (SELECT 1 FROM \`${fiscalDb}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM \`${SCHEMA}\`.tb_invoice_service_transmission t WHERE t.tb_institution_id = i.tb_institution_id AND t.tb_invoice_id = i.id)
      ORDER BY i.id DESC LIMIT 300`, [INST, WEB_TERMINAL])
  const ok: { nota: number; numero: string; valor: number }[] = []
  const why = new Map<string, number>()
  for (const r of rows) {
    try {
      const h = await readServiceInvoice(pool, SCHEMA, webRef(Number(r.id)))
      await buildDpsBase(pool, SCHEMA, INST, h, 'H')
      ok.push({ nota: Number(r.id), numero: String(h.number), valor: Number(h.value) })
    } catch (err) {
      const k = (err as HttpError).code ?? 'erro'
      why.set(k, (why.get(k) ?? 0) + 1)
    }
    if (ok.length >= 10) break
  }
  step('NOTAS DE TESTE ELEGÍVEIS (DPS de H monta hoje)', { conferidas: rows.length, elegiveis: ok, recusadas_por: Object.fromEntries(why) })
}

async function main(): Promise<void> {
  if (!LIST && (!Number.isSafeInteger(INVOICE) || INVOICE <= 0)) throw new Error('Informe a nota de teste: --nota <invoiceId> (ou --candidatas)')
  const base = dbConfigFromEnv()
  // o banco descartável é APAGADO: só um nome do molde do smoke, nunca o banco fiscal desta instância (gates R4)
  if (!/^fiscal_api_smoke(_[a-z0-9]+)?$/.test(SMOKE_DB) || SMOKE_DB === base.database) {
    throw new Error(`SMOKE_DB_NAME inválido: ${SMOKE_DB} — tem de ser fiscal_api_smoke[_sufixo] e diferente de ${base.database}`)
  }
  const user = process.env.SMOKE_DB_USER, password = process.env.SMOKE_DB_PASSWORD ?? ''
  if (!user) throw new Error('SMOKE_DB_USER/SMOKE_DB_PASSWORD ausentes — o usuário do serviço não cria banco (D-F31)')
  const keyring = MasterKeyRing.fromEnv()
  if (keyring.currentVersion === null) throw new Error('FISCAL_MASTER_KEYS ausente — o A1 não abre')

  // ---- pré-condições (sem fisco, sem escrita)
  const realPool = createFiscalPool({ ...base, user, password })
  let smokePool: ReturnType<typeof createFiscalPool> | null = null
  let keepEvidence = false
  let completed = false                 // só o caminho feliz COMPLETO apaga o banco descartável (re-prova R4)
  try {
    if (LIST) { await listCandidates(realPool, base.database); return }
    const [cert] = await realPool.query<any[]>(
      `SELECT cnpj, DATE_FORMAT(not_after, '%Y-%m-%d %H:%i:%s') AS notAfter, deleted FROM ${base.database}.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST])
    if (!cert[0] || cert[0].deleted !== 'N') throw new Error('A1 da institution 1 ausente no fiscal_api')
    const header = await readServiceInvoice(realPool, SCHEMA, webRef(INVOICE))
    await buildDpsBase(realPool, SCHEMA, INST, header, 'H')
    step('PRÉ-CONDIÇÕES OK', {
      nota: INVOICE, numero: header.number, valor: header.value, a1: { cnpj: cert[0].cnpj, venceEm: cert[0].notAfter },
      bancoDescartavel: SMOKE_DB, ambiente: 'H', serie: SERIE, fala_com_o_fisco: VAI,
    })
    if (!VAI) { console.log('\nSem --vai: nada enviado ao fisco, nenhum banco criado.'); return }

    // ---- banco descartável: do zero, migrations, A1 copiado, habilitação H/900 VIRADA
    // evidência PRESERVADA de uma execução anterior (NFS-e de H autorizada e não cancelada, ou envio sem voz) não se apaga
    // às cegas (gates R4): cancele/inspecione antes, ou rode com --descartar-evidencia
    const [dbs] = await realPool.query<any[]>(`SHOW DATABASES LIKE ?`, [SMOKE_DB])
    if ((dbs as any[]).length && !DISCARD) {
      const [ev] = await realPool.query<any[]>(
        `SELECT COUNT(*) AS n FROM \`${SMOKE_DB}\`.vw_invoice_service_transmission
          WHERE last_kind IS NULL OR (access_key IS NOT NULL AND COALESCE(last_kind, '-') NOT IN ('C', 'R', 'F'))`)
      if (Number(ev[0]?.n ?? 0) > 0) {
        throw new Error(`${SMOKE_DB} guarda EVIDÊNCIA de uma execução anterior (${ev[0].n} tentativa(s) autorizada(s) sem cancelar ou sem voz) — cancele/inspecione, ou rode com --descartar-evidencia`)
      }
    }
    await realPool.query(`DROP DATABASE IF EXISTS \`${SMOKE_DB}\``)
    await runMigrations({ ...base, user, password, database: SMOKE_DB }, MIGRATION_SETS)
    await realPool.query(
      `INSERT INTO \`${SMOKE_DB}\`.tb_establishment_certificate SELECT * FROM ${base.database}.tb_establishment_certificate WHERE tb_institution_id = ?`, [INST])
    const startN = Math.floor(Date.now() / 1000)                                             // Id de DPS novo a cada execução (por segundo)
    await realPool.query(
      `INSERT INTO \`${SMOKE_DB}\`.tb_establishment_issuer
         (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted, cutover_at)
       VALUES (?, 'SE', 'H', ?, ?, NULL, NOW(), NOW(), 'N', NOW())`, [INST, SERIE, startN])
    smokePool = createFiscalPool({ ...base, user, password, database: SMOKE_DB })
    const storageRoot = path.resolve(process.env.SMOKE_STORAGE_PATH ?? path.join('storage-smoke', new Date().toISOString().replace(/[:.]/g, '-')))
    fs.mkdirSync(storageRoot, { recursive: true })
    const deps: NfseDeps = { pool: smokePool, keyring, storage: new FsFiscalStorage(storageRoot), adapter: adnAdapter, fiscalDb: SMOKE_DB }
    const actor = { schemaName: SCHEMA, institutionId: INST, userId: 0 }
    const opened = await openIssuer({ pool: smokePool, keyring }, INST, 'SE', { schemaName: SCHEMA })   // predicado COMPLETO da cerca (parte 2 da NE-1a)
    step('EMISSOR DO SMOKE', { ambiente: opened.issuer.environment, serie: opened.issuer.serie, a1: opened.info.cnpj, storage: storageRoot })
    if (opened.issuer.environment !== 'H') throw new Error('Habilitação do smoke fora de H — abortado antes do fisco')

    // ---- o roteiro no fisco de HOMOLOGAÇÃO
    try { step('1. TRANSMITIR', await transmitServiceInvoice(deps, actor, webRef(INVOICE))) }
    catch (err) { step('1. TRANSMITIR — recusa/erro', { code: (err as HttpError).code, message: (err as Error).message }) }
    step('2. CONSULTAR', await refreshServiceTransmission(deps, actor, webRef(INVOICE), 'Q').catch(e => ({ code: e.code, message: e.message })))
    const xml = await readNfseXml(deps, actor, webRef(INVOICE)).catch(() => null)
    if (xml) {
      const { name, municipality } = await emitterDisplay(realPool, INST)
      const pdf = await renderDanfse(xml.xml, { issuerName: name, municipality, cancelled: xml.cancelled })
      fs.writeFileSync(path.join(storageRoot, `${xml.accessKey}-danfse.pdf`), pdf)
      step('3. XML + DANFSe', { chave: xml.accessKey, danfse: path.join(storageRoot, `${xml.accessKey}-danfse.pdf`) })
      // IB-3 (D-IB82): o que a NFS-e autorizada levou e o que o fisco calculou — a prova da fase IBS/CBS em H
      step('3b. IBS/CBS (declaração enviada × valores do fisco)', (await getServiceFiscalView(deps, actor, webRef(INVOICE))).ibscbs)
      step('4. CANCELAR NO FISCO (e101101)', await cancelServiceInvoiceAtAuthority(deps, actor, webRef(INVOICE), MOTIVE).catch(e => ({ code: e.code, message: e.message })))
      step('5. CONSULTAR (voz C)', await refreshServiceTransmission(deps, actor, webRef(INVOICE), 'Q').catch(e => ({ code: e.code, message: e.message })))
    } else {
      step('3. sem NFS-e autorizada — cancelamento não se aplica')
    }
    const view = await getServiceFiscalView(deps, actor, webRef(INVOICE))
    step('LINHA DO TEMPO (banco descartável)', { estado: view.state, tentativas: view.transmissions.length, vozes: view.events.map(e => `${e.attempt}:${e.kind}${e.authorityCode ? ` ${e.authorityCode}` : ''}`) })
    // NFS-e de H AUTORIZADA e NÃO cancelada, ou envio AMBÍGUO (sem voz) = a prova fica (o banco não é apagado) — gates R4
    completed = true
    if ((view.state !== 'cancelled' && view.transmissions.some(t => !!t.accessKey)) || view.transmissions.some(t => t.lastKind === null)) {
      keepEvidence = true
      console.log(`
⚠️ NFS-e de homologação autorizada sem cancelar, ou envio sem voz — ${SMOKE_DB} PRESERVADO para cancelar/reconciliar/inspecionar.`)
    }
  } finally {
    if (smokePool) await smokePool.end()
    if (VAI && !completed) {
      console.log(`\n⚠️ O smoke NÃO terminou o roteiro — ${SMOKE_DB} (se criado) PRESERVADO para inspeção (pode guardar NFS-e de H ou envio sem voz).`)
    } else if (VAI && !KEEP && !keepEvidence) {
      await realPool.query(`DROP DATABASE IF EXISTS \`${SMOKE_DB}\``)
      console.log(`\nBanco descartável ${SMOKE_DB} APAGADO (--manter o preserva). O fiscal_api real não foi tocado.`)
    }
    await realPool.end()
  }
}

main().catch(err => { console.error('[smoke:adn-h] FALHA:', err?.message ?? err); process.exit(1) })
