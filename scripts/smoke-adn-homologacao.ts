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
 *      npm run smoke:adn-h -- --nota <invoiceId> --sem-cancelar [--vai]   (D-F254: para depois da autorização — sem o e101101 — e
 *        GUARDA o banco descartável com a NFS-e de H viva, para o cancelamento feito FORA do produto — prova M4)
 *      SMOKE_STORAGE_PATH=<pasta da parte 1> npm run smoke:adn-h -- --nota <invoiceId> --rodizio [--vai]   (D-F254: abre o banco
 *        GUARDADO, roda a passada do rodízio nele e mostra a linha do tempo; grava rodizio-<instante>.json; nunca apaga o banco.
 *        A autorizada só volta ao rodízio 24 h depois da última consulta — D-N21)
 *   SMOKE_DB_USER / SMOKE_DB_PASSWORD — usuário com CREATE/DROP do banco descartável e SELECT no ERP (o do serviço não
 *   cria banco — D-F31); SMOKE_USER_ID — com --vai, o id do usuário que dá o "vai" (transmitir exige usuário — D-F239);
 *   SMOKE_DB_NAME (padrão fiscal_api_smoke); SMOKE_STORAGE_PATH (padrão storage-smoke/<instante>).
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import {
  createFiscalPool, dbConfigFromEnv, runMigrations, MasterKeyRing, FsFiscalStorage, openIssuer, HttpError, invoiceRef, WEB_TERMINAL, access, erp,
} from 'fiscal-api'
import { MIGRATION_SETS } from '../src/migrations'
import { adnAdapter } from '../src/authority/adn'
import { readServiceInvoice, buildDpsBase, emitterDisplay } from '../src/facts/service-facts'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, readNfseXml, getServiceFiscalView, NfseDeps,
  refreshOpenServiceTransmissions, PASS_INTERFACES, Actor,
} from '../src/nfse/transmission'
import { REFRESH_AUTHORIZED_HOURS } from '../src/nfse/repository'
import { renderDanfse } from '../src/nfse/danfse'

const argAfter = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
const INVOICE = Number(argAfter('--nota'))
/** A borda do script monta a referência INTEIRA da nota da web (NE-1a parte 2 — D-NE12). */
const webRef = (invoiceId: number) => invoiceRef(INST, invoiceId, WEB_TERMINAL)
const VAI = process.argv.includes('--vai')
const KEEP = process.argv.includes('--manter')
const LIST = process.argv.includes('--candidatas')
const DISCARD = process.argv.includes('--descartar-evidencia')
const NO_CANCEL = process.argv.includes('--sem-cancelar')                                     // D-F254
const RODIZIO = process.argv.includes('--rodizio')                                            // D-F254
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

/** D-F254: combinações dos modos da prova M4 — falham ANTES de ler ambiente ou abrir banco. */
function checkModeArgs(): void {
  if (NO_CANCEL && RODIZIO) throw new Error('--sem-cancelar e --rodizio não andam juntos')
  if (LIST && (NO_CANCEL || RODIZIO)) throw new Error('--candidatas não anda com --sem-cancelar nem com --rodizio')
  if (RODIZIO && !process.env.SMOKE_STORAGE_PATH) throw new Error('--rodizio exige SMOKE_STORAGE_PATH = a pasta da parte 1')
}

/** Quando a autorizada desta nota volta ao rodízio (D-N21): pelo relógio do MySQL, o mesmo que a passada compara. */
async function revisitDue(pool: ReturnType<typeof createFiscalPool>): Promise<{ revisitaApartir: string | null; agoraNoBanco: string }> {
  const [rows] = await pool.query<any[]>(
    `SELECT DATE_FORMAT(MAX(DATE_ADD(last_queried_at, INTERVAL ${REFRESH_AUTHORIZED_HOURS} HOUR)), '%Y-%m-%d %H:%i:%s') AS due,
            DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now
       FROM tb_invoice_service_transmission
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND access_key IS NOT NULL AND deleted = 'N'`,
    [INST, INVOICE, WEB_TERMINAL])
  return { revisitaApartir: rows[0]?.due ?? null, agoraNoBanco: rows[0]?.now }
}

/** Os ramos da passada pela LICENÇA (D-F240), exatamente como o worker (`src/worker/refresh-worker.ts`). */
async function passScopeOf(pool: ReturnType<typeof createFiscalPool>) {
  const contracted = new Set(await access.licensedKeys(pool, { institutionId: INST, schemaName: SCHEMA }, PASS_INTERFACES))
  return { interfaces: PASS_INTERFACES.filter(k => contracted.has(k)), liveOnlyInterfaces: PASS_INTERFACES.filter(k => !contracted.has(k)) }
}

/**
 * D-F254 — parte 3 da prova M4: abre o banco descartável GUARDADO pelo `--sem-cancelar` (nunca cria, apaga nem recria), confere a
 * habilitação de H e a NFS-e da nota, e com `--vai` roda a MESMA passada do rodízio da rota e do worker. A saída vai para o console e
 * para `<SMOKE_STORAGE_PATH>/rodizio-<instante>.json`.
 */
async function runRefreshPass(
  base: ReturnType<typeof dbConfigFromEnv>, user: string, password: string, keyring: MasterKeyRing,
): Promise<void> {
  const adminPool = createFiscalPool({ ...base, user, password })
  let smokePool: ReturnType<typeof createFiscalPool> | null = null
  try {
    const [dbs] = await adminPool.query<any[]>(`SHOW DATABASES LIKE ?`, [SMOKE_DB])
    if (!(dbs as any[]).length) throw new Error(`banco descartável ${SMOKE_DB} não existe — rode antes o --sem-cancelar`)
    const storageRoot = path.resolve(process.env.SMOKE_STORAGE_PATH as string)
    if (!fs.existsSync(storageRoot)) throw new Error(`SMOKE_STORAGE_PATH ${storageRoot} não existe — use a pasta impressa pelo --sem-cancelar`)
    smokePool = createFiscalPool({ ...base, user, password, database: SMOKE_DB })
    const deps: NfseDeps = { pool: smokePool, keyring, storage: new FsFiscalStorage(storageRoot), adapter: adnAdapter, fiscalDb: SMOKE_DB }
    // a passada é CONSULTA: roda sem autor, como o worker (D-F239 — `userId: null`); o escopo dos ramos é a LICENÇA (D-F240), igual ao worker
    const actor: Actor = { schemaName: SCHEMA, institutionId: INST, userId: null }
    const opened = await openIssuer({ pool: smokePool, keyring }, INST, 'SE', { schemaName: SCHEMA })
    step('EMISSOR DO SMOKE', { ambiente: opened.issuer.environment, serie: opened.issuer.serie, a1: opened.info.cnpj, storage: storageRoot })
    if (opened.issuer.environment !== 'H') throw new Error('Habilitação do smoke fora de H — abortado antes do fisco')
    const before = await getServiceFiscalView(deps, actor, webRef(INVOICE))
    const keyed = before.transmissions.filter(t => !!t.accessKey)
    if (!keyed.length) throw new Error(`a nota ${INVOICE} não tem NFS-e autorizada em ${SMOKE_DB}`)
    // gate adversarial (M1): a pasta tem de ser a da parte 1 — o XML da NFS-e desta chave está nela; senão a evidência se espalha
    if (!before.xmlAvailable) throw new Error(`SMOKE_STORAGE_PATH ${storageRoot} não guarda o XML da NFS-e da nota ${INVOICE} — use a pasta impressa pelo --sem-cancelar`)
    const voices = (v: typeof before) => v.events.map(e => `${e.attempt}:${e.kind}${e.authorityCode ? ` ${e.authorityCode}` : ''}`)
    const scope = await passScopeOf(smokePool)
    // gates (re-gate M2): a autorizada de ramo NÃO contratado nunca volta ao rodízio (D-F47) — a prova seria impossível; diz agora
    const ref = webRef(INVOICE)                                   // D-NE12: a referência inteira, montada na borda
    const branch = await erp.orderInterface(smokePool, SCHEMA, ref)
    if (!(scope.interfaces as readonly string[]).includes(branch)) {
      throw new Error(`o ramo da nota ${INVOICE} (${branch}) não está contratado — a autorizada não volta ao rodízio (D-F47); a prova M4 não fecha com esta nota`)
    }
    const cBefore = before.events.filter(e => e.kind === 'C').length
    step('PRÉ-CONDIÇÕES DO RODÍZIO OK', {
      nota: INVOICE, chaves: keyed.map(t => t.accessKey), estado: before.state, vozes: voices(before), ramoDaNota: branch, ramos: scope,
      ...(await revisitDue(smokePool)), fala_com_o_fisco: VAI,
    })
    if (cBefore > 0) { step('VEREDITO', `PROVA JÁ FECHADA antes desta execução: a nota já tem voz C (${voices(before).filter(v => v.includes(':C')).join(', ')}) — nada a consultar`); return }
    if (!VAI) { console.log('\nSem --vai: nada enviado ao fisco; o banco descartável segue como estava.'); return }

    const report = await refreshOpenServiceTransmissions(deps, actor, { terminal: WEB_TERMINAL, ...scope })
    step('PASSADA DO RODÍZIO', report)
    const view = await getServiceFiscalView(deps, actor, webRef(INVOICE))
    const timeline = { estado: view.state, tentativas: view.transmissions.length, vozes: voices(view), localCancelPending: view.localCancelPending }
    step('LINHA DO TEMPO (banco descartável)', timeline)
    // gate socrático (L): o veredito explícito — o JSON de uma passada que não achou nada não é a prova
    const cAfter = view.events.filter(e => e.kind === 'C').length
    const ownErrors = report.errors.filter(e => e.invoiceId === INVOICE)
    const verdict = cAfter > cBefore
      ? `PROVA M4 FECHADA: a passada gravou a voz C (${voices(view).filter(v => v.includes(':C')).join(', ')})`
      : report.skipped
        ? 'PROVA NÃO FECHADA: outra passada tem o aluguel do rodízio (D-F41) — rode de novo quando ele vencer; nada foi consultado'
        : ownErrors.length
          ? `PROVA NÃO FECHADA: a consulta desta nota falhou (${ownErrors.map(e => e.code).join(', ')}) — o fisco não foi lido; pode repetir`
          : report.checked === 0
            ? 'PROVA NÃO FECHADA: a nota não foi candidata — antes das 24 h da última consulta (D-N21), cancelada no ERP, vida nova ou fora do teto de dias (D-F38)'
            : 'PROVA NÃO FECHADA: a nota foi consultada e o fisco não mostrou cancelamento — a próxima passada espera mais 24 h'
    step('VEREDITO', verdict)
    const at = new Date().toISOString()
    const file = path.join(storageRoot, `rodizio-${at.replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify({
      instante: at, banco: SMOKE_DB, nota: INVOICE, chaves: keyed.map(t => t.accessKey), veredito: verdict, ramoDaNota: branch, ramos: scope,
      vozesAntes: voices(before), passada: report, linhaDoTempo: timeline,
    }, null, 2))
    step('SAÍDA GRAVADA', { arquivo: file })
  } finally {
    if (smokePool) await smokePool.end()
    await adminPool.end()
  }
}

async function main(): Promise<void> {
  checkModeArgs()
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
  // D-F254: o rodízio sobre o banco GUARDADO entra aqui — antes das pré-condições do DPS e do bloco que apaga/recria o banco
  if (RODIZIO) { await runRefreshPass(base, user, password, keyring); return }
  // D-F239: transmitir e cancelar exigem um USUÁRIO (`assertUserActor`); o smoke transmite com o usuário de quem dá o "vai"
  // (Valdo, 2026-11-20: "(a) SMOKE_USER_ID") — o autor fica só no banco descartável
  const smokeUserId = Number(process.env.SMOKE_USER_ID)
  if (VAI && !(Number.isSafeInteger(smokeUserId) && smokeUserId > 0)) {
    throw new Error('SMOKE_USER_ID ausente ou inválido — com --vai o smoke transmite com o id do usuário que dá o "vai" (D-F239)')
  }

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
    // gates (re-gate M2): para a prova M4 a nota tem de voltar ao rodízio — ramo contratado (D-F47); conferido ANTES do fisco
    let branch: string | undefined
    if (NO_CANCEL) {
      const ref = webRef(INVOICE)                                 // D-NE12: a referência inteira, montada na borda
      branch = await erp.orderInterface(realPool, SCHEMA, ref)
      const scope = await passScopeOf(realPool)
      if (!(scope.interfaces as readonly string[]).includes(branch)) {
        throw new Error(`o ramo da nota ${INVOICE} (${branch}) não está contratado — a autorizada não voltaria ao rodízio (D-F47); escolha outra nota`)
      }
    }
    step('PRÉ-CONDIÇÕES OK', {
      nota: INVOICE, numero: header.number, valor: header.value, a1: { cnpj: cert[0].cnpj, venceEm: cert[0].notAfter },
      bancoDescartavel: SMOKE_DB, ambiente: 'H', serie: SERIE, fala_com_o_fisco: VAI, cancelar_no_produto: !NO_CANCEL,
      ...(branch ? { ramoDaNota: branch } : {}),
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
    const actor = { schemaName: SCHEMA, institutionId: INST, userId: smokeUserId }
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
      if (NO_CANCEL) {
        // D-F254: a NFS-e de H fica VIVA para o cancelamento feito FORA do produto (Emissor Nacional) — prova M4
        step('4/5. CANCELAR — pulado (--sem-cancelar, D-F254): cancele pelo Emissor Nacional de homologação', { chave: xml.accessKey })
      } else {
        step('4. CANCELAR NO FISCO (e101101)', await cancelServiceInvoiceAtAuthority(deps, actor, webRef(INVOICE), MOTIVE).catch(e => ({ code: e.code, message: e.message })))
        step('5. CONSULTAR (voz C)', await refreshServiceTransmission(deps, actor, webRef(INVOICE), 'Q').catch(e => ({ code: e.code, message: e.message })))
      }
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
    if (NO_CANCEL && xml && keepEvidence) {
      // D-F254: o que a parte 2 (cancelar no Emissor Nacional) e a parte 3 (o rodízio, depois de 24 h — D-N21) precisam
      step('PROVA M4 — PRÓXIMOS PASSOS', {
        chave: xml.accessKey, storage: storageRoot, ...(await revisitDue(smokePool)),
        rodizio: `$env:SMOKE_DB_NAME='${SMOKE_DB}'; $env:SMOKE_STORAGE_PATH='${storageRoot}'; npm run smoke:adn-h -- --nota ${INVOICE} --rodizio --vai`,
      })
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
