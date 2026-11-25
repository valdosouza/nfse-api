/// <reference types="jest" />
// DEPLOY.E2.P3 (2026-11-18 — ficha `projetos/nfse-api/GERAL/ficha-deploy-e2-p3-chave-mestra-health.md` no Vault): a prova da chave do
// SERVIDOR abre os segredos guardados — A1 e senha SMTP (D-F243; DEPLOY.E1.P11, núcleo 5.3.0), roda na partida antes do `listen` (D-F250) e a cada 5 min (D-F245/D-F251); o health só lê;
// o pre-deploy prova na hora; o comando da rotação imprime só o relatório, nada do segredo.
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { MasterKeyRing, StoredKeyRotationAborted, storedSecretsOutsideKeyVersion } from 'fiscal-api'
import type { StoredKeyRotationReport, StoredKeyCheck } from 'fiscal-api'
import { KeyProof, KEY_PROOF_INTERVAL_MINUTES, KEY_PROOF_LOG_CODES } from '../key-proof'
import { preDeployKeyItem, preDeployReport } from '../pre-deploy'
import { keyRotationArgumentErrors, runKeyRotation } from '../key-rotation'
import { storedA1Pool } from './stored-a1-fake'

const SRC = path.resolve(__dirname, '..')
const keyA = randomBytes(32)
const keyB = randomBytes(32)
const ringA = MasterKeyRing.of({ 1: keyA })
const ringB = MasterKeyRing.of({ 1: keyB })        // a chave ERRADA de 32 bytes na mesma versão (o `selfTest` passava com ela)
const okCheck: StoredKeyCheck = { ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] }
const degradedCheck: StoredKeyCheck = { ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 2 }] }
const badCheck: StoredKeyCheck = { ok: false, degraded: false, versions: [{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 3 }] }

/** Todas as formas em que uma chave poderia vazar num texto. */
function leakForms(...keys: Buffer[]): string[] {
  return keys.flatMap(k => [k.toString('base64'), k.toString('base64url'), k.toString('hex'), k.toString('hex').toUpperCase()])
}
function silentLog() {
  const calls: Array<[string, string, any]> = []
  return {
    calls,
    log: {
      info: (m: string, meta?: object) => { calls.push(['info', m, meta]) },
      warn: (m: string, meta?: object) => { calls.push(['warn', m, meta]) },
      error: (m: string, meta?: object) => { calls.push(['error', m, meta]) },
    },
  }
}
const pool = { query: jest.fn(), getConnection: jest.fn() } as any

describe('D-F243 KeyProof', () => {
  it('o sinal segue a prova: ok e degraded → true; não abre e exceção → false', async () => {
    for (const [verify, want] of [
      [async () => okCheck, true], [async () => degradedCheck, true], [async () => badCheck, false],
      [async () => { throw new Error('ECONNREFUSED') }, false],
    ] as const) {
      const p = new KeyProof({ pool, keyring: ringA }, { verify, log: silentLog().log })
      expect(await p.run()).toBe(want)
      expect(p.masterKey).toBe(want)
    }
  })

  it('nunca provou → false; anel vazio → false SEM chamar a prova', async () => {
    const verify = jest.fn(async () => okCheck)
    expect(new KeyProof({ pool, keyring: ringA }, { verify }).masterKey).toBe(false)
    const empty = new KeyProof({ pool, keyring: MasterKeyRing.of({}) }, { verify, log: silentLog().log })
    expect(await empty.run()).toBe(false)
    expect(verify).not.toHaveBeenCalled()
  })

  it('resultado VENCIDO (mais de 2 intervalos) → false: rodada travada não deixa o sinal parado calado', async () => {
    let now = 1_000_000
    const p = new KeyProof({ pool, keyring: ringA }, { verify: async () => okCheck, now: () => now })
    await p.run()
    now += 2 * KEY_PROOF_INTERVAL_MINUTES * 60_000
    expect(p.masterKey).toBe(true)
    now += 60_000
    expect(p.masterKey).toBe(false)
  })

  it('o log leva o código que o alarme lê e nada do segredo', async () => {
    const { calls, log } = silentLog()
    await new KeyProof({ pool, keyring: ringA }, { verify: async () => degradedCheck, log }).run()
    await new KeyProof({ pool, keyring: ringA }, { verify: async () => badCheck, log }).run()
    await new KeyProof({ pool, keyring: ringA }, { verify: async () => { throw new Error('ECONNREFUSED') }, log }).run()
    expect(calls.map(c => [c[0], c[2]?.code])).toEqual([
      ['warn', KEY_PROOF_LOG_CODES.degraded], ['error', KEY_PROOF_LOG_CODES.failed], ['error', KEY_PROOF_LOG_CODES.notRun],
    ])
    const text = JSON.stringify(calls)
    for (const form of leakForms(keyA)) expect(text).not.toContain(form)
  })

  it('rodada em curso não é sobreposta; start/stop', async () => {
    let release!: () => void
    const verify = jest.fn(() => new Promise<StoredKeyCheck>(r => { release = () => r(okCheck) }))
    const p = new KeyProof({ pool, keyring: ringA }, { verify })
    const a = p.run(); const b = p.run()
    expect(a).toBe(b)
    expect(verify).toHaveBeenCalledTimes(1)
    release(); expect(await a).toBe(true)
    jest.useFakeTimers()
    try {
      const q = new KeyProof({ pool, keyring: ringA }, { verify: jest.fn(async () => okCheck) })
      const spy = jest.spyOn(q, 'run')
      q.start(); q.start()
      jest.advanceTimersByTime(KEY_PROOF_INTERVAL_MINUTES * 60_000 * 2)
      expect(spy).toHaveBeenCalledTimes(2)
      q.stop()
      jest.advanceTimersByTime(KEY_PROOF_INTERVAL_MINUTES * 60_000 * 2)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally { jest.useRealTimers() }
  })

  it('rodada SEM RESPOSTA no prazo (1 intervalo) → false, log KEY_PROOF_NOT_RUN, e a rodada seguinte pode começar', async () => {
    const { calls, log } = silentLog()
    const verify = jest.fn(() => new Promise<StoredKeyCheck>(() => { /* pendurada para sempre */ }))
    const p = new KeyProof({ pool, keyring: ringA }, { verify, log, intervalMs: 30 })
    expect(await p.run()).toBe(false)
    expect(calls.map(c => c[2]?.code)).toEqual([KEY_PROOF_LOG_CODES.notRun])
    expect(await p.run()).toBe(false)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('o timer não segura o processo (unref)', () => {
    const p = new KeyProof({ pool, keyring: ringA }, { verify: async () => okCheck })
    p.start()
    try { expect((p as any).timer.hasRef()).toBe(false) } finally { p.stop() }
  })

  it('PROVA DE VERDADE (verifyStoredKeys REAL): A1 selado com a chave A — anel A abre, chave B de 32 bytes NÃO', async () => {
    const stored = [{ institutionId: 3, sealedWith: ringA }, { institutionId: 9, sealedWith: ringA }]
    expect(ringB.selfTest()).toBe(true)                                   // o que o health antigo aceitava
    const good = new KeyProof({ pool: storedA1Pool(stored), keyring: ringA }, { log: silentLog().log })
    expect(await good.run()).toBe(true)
    const wrong = new KeyProof({ pool: storedA1Pool(stored), keyring: ringB }, { log: silentLog().log })
    expect(await wrong.run()).toBe(false)
    // versão guardada que o anel não tem (rotação mal feita) → false
    const v2 = MasterKeyRing.of({ 2: keyB })
    expect(await new KeyProof({ pool: storedA1Pool([...stored, { institutionId: 4, sealedWith: v2 }]), keyring: ringA }, { log: silentLog().log }).run()).toBe(false)
  })
})

describe('DEPLOY.E1.P11 prova da chave com os dois donos (verifyStoredKeys REAL do 5.3.0)', () => {
  it('senha SMTP selada com a chave A: o anel A abre, a chave B de 32 bytes NÃO; versão da senha fora do anel derruba; só senha, sem A1, também prova', async () => {
    const smtps = [{ institutionId: 7, sealedWith: ringA }]
    expect(await new KeyProof({ pool: storedA1Pool([], smtps), keyring: ringA }, { log: silentLog().log }).run()).toBe(true)
    expect(await new KeyProof({ pool: storedA1Pool([], smtps), keyring: ringB }, { log: silentLog().log }).run()).toBe(false)
    const v2 = MasterKeyRing.of({ 2: keyB })
    expect(await new KeyProof({ pool: storedA1Pool([], [...smtps, { institutionId: 8, sealedWith: v2 }]), keyring: ringA }, { log: silentLog().log }).run()).toBe(false)
  })
})

describe('D-F250 boot', () => {
  const server = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf8')
  it('a 1ª prova roda (com await) ANTES de ouvir a porta; o timer começa; o app recebe a prova', () => {
    const run = server.indexOf('await keyProof.run()')
    const listen = server.indexOf('.listen(')
    expect(run).toBeGreaterThan(0)
    expect(listen).toBeGreaterThan(run)
    expect(server.indexOf('keyProof.start()')).toBeGreaterThan(run)
    expect(server).toMatch(/createApp\(ctx, keyProof\)\.listen\(/)
  })
  it('o health não usa mais o selfTest nem abre A1 por chamada', () => {
    const health = fs.readFileSync(path.join(SRC, 'health.ts'), 'utf8')
    expect(health).not.toMatch(/\.selfTest\(|verifyStoredKeys\(|storedKeyVersions\(/)
    expect(health).toContain('keyProof.masterKey')
  })
})

describe('D-F243 pre-deploy', () => {
  const prod = { NODE_ENV: 'production' }
  const dev = { NODE_ENV: 'development' }
  it('o pre-deploy não usa mais o selfTest e o CLI chama a prova', () => {
    expect(fs.readFileSync(path.join(SRC, 'pre-deploy.ts'), 'utf8')).not.toMatch(/\.selfTest\(/)
    expect(fs.readFileSync(path.join(SRC, 'pre-deploy-cli.ts'), 'utf8')).toMatch(/preDeployKeyItem\(/)
  })
  it('ok → ✓; não abre → bloqueia em produção, aviso fora; degraded → aviso; exceção → bloqueia em produção, aviso fora', async () => {
    const deps = { pool, keyring: ringA }
    expect(await preDeployKeyItem(prod, deps, async () => okCheck)).toMatchObject({ ok: true, blocking: false })
    const bad = await preDeployKeyItem(prod, deps, async () => badCheck)
    expect(bad).toMatchObject({ ok: false, blocking: true })
    expect(preDeployReport([bad]).exitCode).toBe(1)
    expect(await preDeployKeyItem(dev, deps, async () => badCheck)).toMatchObject({ ok: false, blocking: false })
    expect(await preDeployKeyItem(prod, deps, async () => degradedCheck)).toMatchObject({ ok: false, blocking: false })
    const boom = async () => { throw new Error('ECONNREFUSED') }
    expect(await preDeployKeyItem(prod, deps, boom)).toMatchObject({ ok: false, blocking: true })
    expect(await preDeployKeyItem(dev, deps, boom)).toMatchObject({ ok: false, blocking: false })
  })
  it('com o verifyStoredKeys REAL: a chave B de 32 bytes BLOQUEIA em produção; a A passa; nada do segredo no detalhe', async () => {
    const stored = [{ institutionId: 3, sealedWith: ringA }]
    const wrong = await preDeployKeyItem(prod, { pool: storedA1Pool(stored), keyring: ringB })
    expect(wrong).toMatchObject({ ok: false, blocking: true })
    expect(wrong.detail).toContain('FISCAL_CERT_INVALID')
    expect(await preDeployKeyItem(prod, { pool: storedA1Pool(stored), keyring: ringA })).toMatchObject({ ok: true })
    for (const form of leakForms(keyA, keyB)) expect(wrong.detail).not.toContain(form)
  })
})

describe('D-F243 rotação', () => {
  const ring12 = MasterKeyRing.of({ 1: keyA, 2: keyB })
  const deps = { pool, keyring: ring12 }
  const A1 = 'tb_establishment_certificate'
  const SMTP = 'tb_establishment_smtp_credential'
  const clean: StoredKeyRotationReport = { currentVersion: 2, rewrapped: [{ store: A1, institutionId: 3, from: 1 }, { store: SMTP, institutionId: 9, from: 1 }], failed: [], skipped: [] }
  const okV2: StoredKeyCheck = { ok: true, degraded: false, versions: [{ version: 2, ok: true, unreadable: 0 }] }
  const allText = (r: { lines: string[] }) => r.lines.join('\n')
  const noLeak = (text: string) => {
    for (const form of leakForms(keyA, keyB)) expect(text).not.toContain(form)
    expect(text).not.toContain(`1:${keyA.toString('base64')}`)
  }

  it('argumentos: vazio e --vai valem; desconhecido, repetido e --vai engolido pelo npm falham', () => {
    expect(keyRotationArgumentErrors([], {})).toEqual([])
    expect(keyRotationArgumentErrors(['--vai'], {})).toEqual([])
    expect(keyRotationArgumentErrors(['--x'], {})).toHaveLength(1)
    expect(keyRotationArgumentErrors(['--vai', '--vai'], {})).toHaveLength(1)
    expect(keyRotationArgumentErrors([], { npm_config_vai: 'true' })).toHaveLength(1)
  })

  it('o CLI confere os argumentos ANTES de abrir o banco', () => {
    const cli = fs.readFileSync(path.join(SRC, 'rotate-keys-cli.ts'), 'utf8')
    expect(cli.indexOf('keyRotationArgumentErrors(')).toBeGreaterThan(0)
    expect(cli.indexOf('createFiscalPool(')).toBeGreaterThan(cli.indexOf('keyRotationArgumentErrors('))
  })

  it('ENSAIO não chama a rotação; mostra o que regravaria, a prova e o passo 1 do runbook', async () => {
    const rotate = jest.fn(async () => clean)
    const r = await runKeyRotation(deps, {
      execute: false, rotate, verify: async () => okCheck, versions: async () => [1], outside: async () => [{ store: A1, institutionId: 3 }, { store: SMTP, institutionId: 9 }],
    })
    expect(rotate).not.toHaveBeenCalled()
    expect(r.exitCode).toBe(0)
    expect(allText(r)).toMatch(/ENSAIO/)
    expect(allText(r)).toMatch(/segredos a regravar para v2: 2/)
    expect(allText(r)).toMatch(/tb_establishment_certificate · institution 3/)    // o ensaio diz o dono de cada segredo
    expect(allText(r)).toMatch(/tb_establishment_smtp_credential · institution 9/)
    expect(allText(r)).toMatch(/runbook 1/)
    noLeak(allText(r))
  })

  it('ATO limpo + versões [atual] + prova ok → saída 0 e o passo 4 do runbook', async () => {
    const r = await runKeyRotation(deps, { execute: true, rotate: async () => clean, verify: async () => okV2, versions: async () => [2] })
    expect(r.exitCode).toBe(0)
    expect(allText(r)).toMatch(/tb_establishment_certificate · institution 3: v1 → v2/)
    expect(allText(r)).toMatch(/tb_establishment_smtp_credential · institution 9: v1 → v2/)   // o relatório diz o dono
    expect(allText(r)).toMatch(/runbook 4/)
    noLeak(allText(r))
  })

  it('ATO com falha, versão sobrando ou prova falha → saída 1, "não tire a antiga"', async () => {
    const failed = { ...clean, failed: [{ store: SMTP, institutionId: 5, from: 1, code: 'SMTP_CREDENTIAL_UNREADABLE' }] }
    for (const run of [
      { rotate: async () => failed, verify: async () => okV2, versions: async () => [1, 2] },
      { rotate: async () => clean, verify: async () => okV2, versions: async () => [1, 2] },
      { rotate: async () => clean, verify: async () => badCheck, versions: async () => [2] },
    ]) {
      const r = await runKeyRotation(deps, { execute: true, ...run })
      expect(r.exitCode).toBe(1)
      expect(allText(r)).toMatch(/NÃO CONCLUÍDA/)
      noLeak(allText(r))
    }
  })

  it('ATO só com `failed` (versões já [atual], prova ok) → saída 1: a regra do `failed` vale sozinha', async () => {
    const failed = { ...clean, failed: [{ store: SMTP, institutionId: 5, from: 1, code: 'SMTP_CREDENTIAL_UNREADABLE' }] }
    const r = await runKeyRotation(deps, { execute: true, rotate: async () => failed, verify: async () => okV2, versions: async () => [2] })
    expect(r.exitCode).toBe(1)
    expect(allText(r)).toMatch(/1 segredo\(s\) não regravado/)
  })

  it('ATO com a conferência que CAI depois da rotação → saída 1 SEM perder o relatório do que foi regravado', async () => {
    const r = await runKeyRotation(deps, {
      execute: true, rotate: async () => clean, verify: async () => okV2, versions: async () => { throw new Error('Connection lost') },
    })
    expect(r.exitCode).toBe(1)
    expect(allText(r)).toMatch(/institution 3: v1 → v2/)
    expect(allText(r)).toMatch(/conferência depois da rotação não rodou/)
  })

  it('ENSAIO com a prova falhando (versão guardada fora do anel) → saída 1: o ato não regravaria', async () => {
    const r = await runKeyRotation(deps, {
      execute: false, verify: async () => badCheck, versions: async () => [1], outside: async () => [{ store: A1, institutionId: 3 }],
    })
    expect(r.exitCode).toBe(1)
    expect(allText(r)).toMatch(/Corrija FISCAL_MASTER_KEYS/)
  })

  it('StoredKeyRotationAborted → saída 1 com o relatório parcial e o dono e a institution em dúvida', async () => {
    const partial = { ...clean, rewrapped: [{ store: A1, institutionId: 3, from: 1 }] }
    const r = await runKeyRotation(deps, {
      execute: true, rotate: async () => { throw new StoredKeyRotationAborted(partial, new Error('Connection lost'), { store: SMTP, institutionId: 9 }) },
    })
    expect(r.exitCode).toBe(1)
    expect(allText(r)).toMatch(/INTERROMPIDA/)
    expect(allText(r)).toMatch(/institution 3: v1 → v2/)
    expect(allText(r)).toMatch(/em dúvida: tb_establishment_smtp_credential · institution 9/)
    noLeak(allText(r))
  })

  it('o relatório diz o dono também nas linhas de falharam e de pulados', async () => {
    const rep: StoredKeyRotationReport = { ...clean, failed: [{ store: SMTP, institutionId: 5, from: 1, code: 'SMTP_CREDENTIAL_UNREADABLE' }], skipped: [{ store: A1, institutionId: 6 }] }
    const r = await runKeyRotation(deps, { execute: true, rotate: async () => rep, verify: async () => okV2, versions: async () => [2] })
    expect(allText(r)).toMatch(/tb_establishment_smtp_credential · institution 5: v1 — SMTP_CREDENTIAL_UNREADABLE/)
    expect(allText(r)).toMatch(/pulados .*: 1 \(tb_establishment_certificate · institution 6\)/)
  })

  it('erro inesperado no ato (fora do contrato do núcleo) → saída 1 com o aviso de que parte pode estar regravada; nunca sobe calado', async () => {
    const r = await runKeyRotation(deps, { execute: true, rotate: async () => { throw new Error('Connection lost') } })
    expect(r.exitCode).toBe(1)
    expect(allText(r)).toMatch(/INTERROMPIDA por erro inesperado/)
    expect(allText(r)).toMatch(/rode o ENSAIO/)
  })

  it('anel vazio → saída 1 sem tocar o banco', async () => {
    const rotate = jest.fn()
    const r = await runKeyRotation({ pool, keyring: MasterKeyRing.of({}) }, { execute: true, rotate })
    expect(r.exitCode).toBe(1)
    expect(rotate).not.toHaveBeenCalled()
  })

  it('DEPLOY.E1.P11: o ensaio com a leitura REAL do núcleo lista os dois donos', async () => {
    const poolOld = storedA1Pool([{ institutionId: 3, sealedWith: ringA }], [{ institutionId: 9, sealedWith: ringA }])
    const found = await storedSecretsOutsideKeyVersion(poolOld, 2)
    expect(found).toEqual([{ store: A1, institutionId: 3 }, { store: SMTP, institutionId: 9 }])
    const r = await runKeyRotation({ pool: poolOld, keyring: ring12 }, { execute: false, verify: async () => okCheck, versions: async () => [1] })
    expect(allText(r)).toMatch(/segredos a regravar para v2: 2/)
    expect(allText(r)).toMatch(/tb_establishment_smtp_credential · institution 9/)
  })

  it('DEPLOY.E1.P11 (cerca por texto): `key-rotation.ts` chama só os nomes dos DOIS donos — o código não cita a rotação nem a leitura do A1 sozinho', () => {
    const code = fs.readFileSync(path.join(SRC, 'key-rotation.ts'), 'utf8').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
    expect(code).not.toMatch(/rotateCertificateKeys|certificatesOutsideKeyVersion|\bKeyRotationAborted\b|\bKeyRotationReport\b/)
    // o ato e a conferência padrão são os do núcleo para TODOS os donos: nada de lista reduzida (um dono só deixaria a senha para trás)
    expect(code).toMatch(/const rotate = run\.rotate \?\? rotateStoredKeys\s/)
    expect(code).toMatch(/const versionsOf = run\.versions \?\? storedKeyVersions\s/)
    expect(code).toMatch(/const outside = run\.outside \?\? storedSecretsOutsideKeyVersion\s/)
    expect(code).not.toMatch(/SEALED_STORE|certificateKeyVersions/)
    expect(code).not.toMatch(/rotateStoredKeys\([^)]/)
    expect(code).toMatch(/storedSecretsOutsideKeyVersion/)
    expect(code).toMatch(/StoredKeyRotationAborted/)
  })
})
