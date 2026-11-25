// DEPLOY.E2.P3 (D-F243) + DEPLOY.E1.P11 (núcleo 5.3.0): pool FALSO com segredos guardados (A1 e senha SMTP, os dois donos do cofre), para
// provar a chave com o `verifyStoredKeys` REAL do núcleo sem banco. O SQL de amostra por versão (`ROW_NUMBER`) recebe linhas
// `{v, id, cipher, iv, tag}` seladas em memória com o anel dado e a AAD do dono (`certificateAad` / `smtpCredentialAad`) — a mesma forma
// que o banco devolve; o SQL que cita a tabela da 009 responde com as senhas, o outro com os A1. Sem `.test.ts`: fora do `testMatch`.
import { randomBytes } from 'crypto'
import { certificateAad, smtpCredentialAad, MasterKeyRing } from 'fiscal-api'

export interface StoredA1 { institutionId: number; sealedWith: MasterKeyRing }
/** Senha SMTP guardada: mesma forma do A1 (o conteúdo é gerado na hora, nunca versionado). */
export type StoredSmtp = StoredA1

function rowsOf(list: StoredA1[], aadOf: (id: number) => string) {
  return list.map(({ institutionId, sealedWith }) => {
    const s = sealedWith.seal(randomBytes(64), aadOf(institutionId))
    return { v: s.version, id: institutionId, cipher: s.cipher, iv: s.iv, tag: s.tag }
  }).sort((a, b) => a.v - b.v || a.id - b.id)
}

export function storedA1Pool(a1s: StoredA1[], smtps: StoredSmtp[] = []): any {
  const a1Rows = rowsOf(a1s, certificateAad)
  const smtpRows = rowsOf(smtps, smtpCredentialAad)
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const rows = /tb_establishment_smtp_credential/.test(sql) ? smtpRows : a1Rows
    if (/ROW_NUMBER\(\)/.test(sql)) return [rows]
    if (/SELECT DISTINCT cipher_key_version/.test(sql)) return [[...new Set(rows.map(r => r.v))].map(v => ({ v }))]
    // `...OutsideKeyVersion` de cada dono: os vivos cuja versão é DIFERENTE da pedida
    if (/SELECT tb_institution_id AS id FROM tb_establishment_/.test(sql)) return [rows.filter(r => r.v !== Number(params?.[0])).map(r => ({ id: r.id }))]
    return [[{ x: 1 }]]
  })
  return { query, getConnection: jest.fn() }
}
