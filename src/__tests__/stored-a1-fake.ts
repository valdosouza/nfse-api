// DEPLOY.E2.P3 (D-F243): pool FALSO com A1 guardados, para provar a chave com o `verifyStoredKeys` REAL do núcleo sem banco. O SQL do
// `sampleCertificatesPerKeyVersion` (`ROW_NUMBER`) recebe linhas `{v, id, cipher, iv, tag}` seladas em memória com o anel dado e a AAD
// da institution (`certificateAad`) — a mesma forma que o banco devolve. Sem `.test.ts`: fora do `testMatch`.
import { randomBytes } from 'crypto'
import { certificateAad, MasterKeyRing } from 'fiscal-api'

export interface StoredA1 { institutionId: number; sealedWith: MasterKeyRing }

export function storedA1Pool(a1s: StoredA1[]): any {
  const rows = a1s.map(({ institutionId, sealedWith }) => {
    const s = sealedWith.seal(randomBytes(64), certificateAad(institutionId))
    return { v: s.version, id: institutionId, cipher: s.cipher, iv: s.iv, tag: s.tag }
  }).sort((a, b) => a.v - b.v || a.id - b.id)
  const query = jest.fn(async (sql: string) => {
    if (/ROW_NUMBER\(\)/.test(sql)) return [rows]
    if (/SELECT DISTINCT cipher_key_version/.test(sql)) return [[...new Set(rows.map(r => r.v))].map(v => ({ v }))]
    return [[{ x: 1 }]]
  })
  return { query, getConnection: jest.fn() }
}
