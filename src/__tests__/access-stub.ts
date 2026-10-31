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
  if (access.liveIdentity?.mockImplementation) access.liveIdentity.mockImplementation(async (_q: unknown, p: unknown) => p)
}
