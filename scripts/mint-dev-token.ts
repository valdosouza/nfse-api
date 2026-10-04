// SÓ DEV (F1): emite um JWT RS256 com o MESMO payload do setes-api, assinado com a chave PRIVADA de
// dev do setes-api (D-F13). Existe só até a F2a, quando o próprio setes-api passa a emitir RS256.
// Uso: npm run token:dev -- <institutionId> <userId> <role> <schemaName> [ttl]
//   DEV_JWT_PRIVATE_KEY_PATH = caminho da chave privada (ex.: ../setes-api/secrets/jwt/setes-api.private.pem)
import 'dotenv/config'
import fs from 'fs'
import jwt from 'jsonwebtoken'

const [institutionId = '1', userId = '1', role = 'admin', schemaName = 'setes_setes', ttl = '2h'] = process.argv.slice(2)
const keyPath = process.env.DEV_JWT_PRIVATE_KEY_PATH
if (!keyPath) { console.error('Defina DEV_JWT_PRIVATE_KEY_PATH'); process.exit(1) }
const token = jwt.sign(
  { institutionId: Number(institutionId), userId: Number(userId), role, schemaName },
  fs.readFileSync(keyPath, 'utf8'),
  { algorithm: 'RS256', keyid: process.env.DEV_JWT_KID ?? 'default', expiresIn: ttl as any },
)
process.stdout.write(token)
