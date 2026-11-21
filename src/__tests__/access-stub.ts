/**
 * Dublê do VEREDITO de acesso para as guardas da nfse-api (costura A1 da auth-api — D-AU3/D-AU6, 2026-10-31). As guardas leem o veredito
 * pela biblioteca única do núcleo (`access.accessVerdict` / `reachableKeys` / `grantedKeys` — a pilha de views publicada no banco do
 * produto); aqui dois predicados respondem por elas, no MESMO formato: super (role 'super' na institution 1) alcança e pode tudo; admin
 * pode tudo o que alcança (sem consultar concessão); regular só o concedido; alcance = contratado. A semântica REAL das views é provada ao
 * vivo em banco descartável pelo setes-api (`scripts/prove-user-access-views.ts`).
 *
 * Os predicados têm a forma dos dublês de antes da A1 (licença por estabelecimento; concessão por usuário × interface × VERBO pelo NOME —
 * D-PV53), para cada teste seguir provando o que provava:
 *   licensed(pool, schemaName, institutionId, key) · granted(pool, schemaName, userId, key, verbo)
 * Uso: no `jest.mock('fiscal-api', …)`, `access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(),
 * grantedKeys: jest.fn(), liveIdentity: jest.fn() }`; no `beforeEach`, `wireAccess(fiscal.access, licensedM, grantedM)`.
 */
type Who = { institutionId: number; userId: number; schemaName: string; role?: string }
type Licensed = (q: unknown, schemaName: string, institutionId: number, key: string) => unknown
type Granted = (q: unknown, schemaName: string, userId: number, key: string, verb: string) => unknown

export function profileOf(who: Who): 'super' | 'admin' | 'user' {
  if (who.role === 'super' && who.institutionId === 1) return 'super'
  return who.role === 'admin' ? 'admin' : 'user'
}

export function wireAccess(access: any, licensed: Licensed, granted: Granted): void {
  const reach = async (q: unknown, who: Who, k: string) =>
    profileOf(who) === 'super' || Boolean(await licensed(q, who.schemaName, who.institutionId, k))
  const allows = async (q: unknown, who: Who, k: string, v: string) =>
    (await reach(q, who, k)) && (profileOf(who) !== 'user' || Boolean(await granted(q, who.schemaName, who.userId, k, v)))
  const filter = async (keys: readonly string[], test: (k: string) => Promise<boolean>) => {
    const out: string[] = []
    for (const k of new Set(keys)) if (await test(k)) out.push(k)
    return out
  }
  access.reachableKeys.mockImplementation(async (q: unknown, who: Who, keys: readonly string[]) => filter(keys, k => reach(q, who, k)))
  access.grantedKeys.mockImplementation(async (q: unknown, who: Who, keys: readonly string[], v: string) =>
    filter(keys, k => allows(q, who, k, v)))
  access.accessVerdict.mockImplementation(async (q: unknown, who: Who, keys: readonly string[], v: string) => {
    if ((await filter(keys, k => allows(q, who, k, v))).length > 0) return 'ok'
    return (await filter(keys, k => reach(q, who, k))).length > 0 ? 'no-privilege' : 'not-contracted'
  })
  if (access.liveIdentity?.mockImplementation) access.liveIdentity.mockImplementation(async (_q: unknown, p: any) => {
    const role = liveProfiles.get(liveKey(p))
    return role === undefined ? p : { ...p, role }
  })
}

/**
 * Núcleo 3.0.0+ (D-AU3/D-AU19, nfse-api:AUTH.E2.P2 absorvido pelo DEPLOY.E1.P4): o verificador IGNORA o `role` do token (devolve
 * `role: ''`) — o perfil (admin/super) vem SÓ da sessão viva (`access.liveIdentity`, com `checkIdentity: true`). Os testes declaram o
 * perfil VIVO do usuário com `liveAs` (o `role` das claims de quem cunha o token vira o perfil vivo daquele institutionId:userId); o
 * `role` que viaja no token é só o legado que o núcleo descarta.
 */
// CONHECIMENTO NEGATIVO (gates de 2026-11-21): o mapa é por arquivo (o jest isola os módulos) e NÃO é limpo entre testes — a última
// cunhagem do mesmo institutionId:userId vence; quem guarda um token numa variável e cunha outro do MESMO usuário antes de usá-lo herda o
// perfil do segundo. A prova de que o `role` do TOKEN nunca concede é do `auth-e2-p2-token-contract.test.ts` (o vivo recebe `role: ''`).
const liveProfiles = new Map<string, string>()
const liveKey = (p: { institutionId?: unknown; userId?: unknown }) => `${String(p.institutionId)}:${String(p.userId)}`
export function liveAs(claims: { institutionId?: unknown; userId?: unknown; role?: unknown }): void {
  // id que não é inteiro (o "institutionId como texto" do pv2-gate) o verificador recusa (401) — não pode gravar perfil na chave do numérico
  if (!Number.isSafeInteger(claims.institutionId) || !Number.isSafeInteger(claims.userId)) return
  if (typeof claims.role === 'string') liveProfiles.set(liveKey(claims), claims.role)
  else liveProfiles.delete(liveKey(claims))
}
/** Cunhar o token e declarar o perfil VIVO do mesmo usuário num passo só: `jwt.sign(live(claims), …)`. */
export function live<T extends { institutionId?: unknown; userId?: unknown; role?: unknown }>(claims: T): T {
  liveAs(claims)
  return claims
}
