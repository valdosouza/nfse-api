/// <reference types="jest" />
// GATE ADVERSARIAL — NE-1a PARTE 2, passos 1–6 (`prompt_onda_nfe_sefaz.md` §12.9.7.1) — nfse-api (+ o núcleo pela costura de sempre).
// Revisor independente — NÃO fez a entrega (`Infra-IA/skills-genericas/testar-adversarial.md` §4-6). O delta é o working tree.
//
// Promessas atacadas aqui (as do núcleo ficam no gate gêmeo `fiscal-api/src/__tests__/adversarial-ne1a2-gate.test.ts`):
//  - D-F108/D-F106: UM descritor só para a tabela da NFS-e (`nfse/voice-family.ts`); `defineVoiceFamily` "por qualquer grafia" fora dele é
//    violação da cerca; o escritor só sai como VALOR para as políticas do núcleo; a lista da família é UMA fonte (D-F107);
//  - D-NE12/D-NE59: a referência da nota viaja INTEIRA da rota ao SQL; outra institution ou terminal fora do domínio falha ALTO;
//  - D-NE57: a cadeia do servidor é erro do EMISSOR — a passada do rodízio PÁRA;
//  - D-NE69: as listas do SQL da família DERIVAM da classificação — os MESMOS membros para os kinds da NFS-e.
//
//  * ACHADOS (`it.failing('[SEV NE1A2-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual (prova do achado);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (Q-NE80…).
//
// "Compila" é medido de VERDADE: `Program` do TypeScript com o tsconfig REAL da nfse-api e arquivos VIRTUAIS em memória (nada no disco —
// `writeFile` lança; conferido no afterAll). REGRAS DO GATE: nenhum socket, nenhum banco (conexões FALSAS), nada que fale com o fisco.
import path from 'path'
import fs from 'fs'
import ts from 'typescript'
import * as fiscal from 'fiscal-api'
import { AuthorityHttpError, MasterKeyRing, defineVoiceFamily, withInvoiceTx, invoiceRef, SERVICE_VOICE_READING, sqlKindList } from 'fiscal-api'
import * as repo from '../nfse/repository'
import { SERVICE_VOICE_WRITE_KINDS, SERVICE_VOICE_FAMILY } from '../nfse/voice-family'
import {
  transmitServiceInvoice, refreshServiceTransmission, cancelServiceInvoiceAtAuthority, reconfirmBeforeLocalCancel,
  refreshOpenServiceTransmissions, getServiceFiscalView, readNfseXml, listPending, resetMunicipalTermsCache, NfseDeps,
} from '../nfse/transmission'
import { listPendingServiceInvoices } from '../facts/service-facts'
import { tsProducesS, writerCallFlags } from './voice-kind-fence'
import { withRecord } from './fixture-record'

jest.setTimeout(120_000)

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signXml: jest.fn((xml: string) => xml),
    openIssuer: jest.fn(),
    nextDpsNumber: jest.fn(),
    acquireRefreshLease: jest.fn(),
    releaseRefreshLease: jest.fn(),
    renewRefreshLease: jest.fn(),
    emissionStillInErp: jest.fn(),
    getIssuer: jest.fn(),
    erp: {
      ...actual.erp,
      lockInvoice: jest.fn(), invoiceLife: jest.fn(), invoiceLives: jest.fn(), institutionZone: jest.fn(),
      entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), establishmentCnpj: jest.fn(),
    },
  }
})
jest.mock('../nfse/repository', () => {
  const actual = jest.requireActual('../nfse/repository')
  return {
    __esModule: true, ...actual,
    getLifeDps: jest.fn(), insertLifeDps: jest.fn(), getTransmission: jest.fn(), latestTransmission: jest.fn(),
    findTransmissionByDpsId: jest.fn(), listLifeTransmissions: jest.fn(), insertTransmission: jest.fn(),
    fillAuthorityData: jest.fn(), insertTransmissionEvent: jest.fn(), hasTransmissionEvent: jest.fn(),
    findTransmissionEventByKind: jest.fn(), touchQueriedAt: jest.fn(), listRefreshCandidates: jest.fn(),
    findKeyHolder: jest.fn(),
  }
})

const SRC_ROOT = path.resolve(__dirname, '..')
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..')
const norm = (p: string) => path.resolve(p).split(path.sep).join('/')
const VIRTUAL = path.join(SRC_ROOT, '__ne1a2_virtual__')                    // NUNCA criada
afterAll(() => { expect(fs.existsSync(VIRTUAL)).toBe(false) })

/** Compila em MEMÓRIA com o tsconfig REAL da nfse-api (molde do `adversarial-r22-gate`): devolve os diagnósticos de cada trecho. */
function compileInMemory(snippets: [string, string][]): Map<string, string[]> {
  const cfg = ts.readConfigFile(path.join(PROJECT_ROOT, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, PROJECT_ROOT)
  const virt = new Map<string, string>(snippets.map(([, code], i) => [norm(path.join(VIRTUAL, `s${i}.ts`)), code]))
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host), getSourceFile = host.getSourceFile.bind(host)
  host.readFile = f => virt.get(norm(f)) ?? readFile(f)
  host.fileExists = f => virt.has(norm(f)) || fileExists(f)
  host.getSourceFile = (f, lang, onErr, create) => { const t = virt.get(norm(f)); return t !== undefined ? ts.createSourceFile(f, t, lang, true) : getSourceFile(f, lang, onErr, create) }
  host.writeFile = () => { throw new Error('o gate nunca escreve no disco') }
  const program = ts.createProgram([...virt.keys()], { ...parsed.options, noEmit: true }, host)
  return new Map(snippets.map(([label], i) => {
    const sf = program.getSourceFile([...virt.keys()][i])!
    return [label, [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))]
  }))
}

/** Conexão FALSA: o escritor REAL do núcleo roda inteiro (MAX+1 e INSERT) sem banco. */
function fakeConn() {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p })
    if (/MAX\(event\)/.test(sql)) return [[{ next: 1 }]]
    return [{ affectedRows: 1 }]
  })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  return { pool: { query, getConnection: jest.fn(async () => conn) } as any, calls }
}
const LOCKED = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }

// ===========================================================================
// 1 — D-F108: UM descritor só (a cerca "por qualquer grafia") e o escritor como VALOR
// ===========================================================================

const FAMILY_ARGS = `{ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'S'], label: 'NFS-e' }`
/** Grafias de um 2º descritor da tabela da NFS-e — todas compilam (medido no teste de contexto abaixo). */
const DESCRIPTOR_SPELLINGS: [string, string][] = [
  ['nome direto (já pega)', `import { defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'\nexport const F = defineVoiceFamily(${FAMILY_ARGS})`],
  ['alias por const', `import { defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'\nconst make = defineVoiceFamily\nexport const F = make(${FAMILY_ARGS})`],
  ['.call', `import { defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'\nexport const F = defineVoiceFamily.call(null, ${FAMILY_ARGS})`],
  ['vírgula (0, f)', `import { defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'\nexport const F = (0, defineVoiceFamily)(${FAMILY_ARGS})`],
  ['namespace por elemento', `import * as core from 'fiscal-api'\nconst SERVICE_VOICE_READING = core.SERVICE_VOICE_READING\nexport const F = core['defineVoiceFamily'](${FAMILY_ARGS})`],
  ['desestruturação do namespace', `import * as core from 'fiscal-api'\nconst { defineVoiceFamily: make, SERVICE_VOICE_READING } = core\nexport const F = make(${FAMILY_ARGS})`],
  ['Reflect.apply', `import { defineVoiceFamily, SERVICE_VOICE_READING } from 'fiscal-api'\nexport const F = Reflect.apply(defineVoiceFamily, undefined, [${FAMILY_ARGS}])`],
]
/** Grafias do escritor da NFS-e como VALOR (fora das políticas do núcleo). */
const WRITER_VALUE_SPELLINGS: [string, string][] = [
  ['desestruturação (já pega)', `import { SERVICE_VOICE_FAMILY } from '../nfse/voice-family'\nconst { insertTransmissionEvent: put } = SERVICE_VOICE_FAMILY\nexport const w = wrap(put)`],
  ['elemento do descritor', `import { SERVICE_VOICE_FAMILY } from '../nfse/voice-family'\nexport const w = wrap(SERVICE_VOICE_FAMILY['insertTransmissionEvent'])`],
  ['elemento do repositório', `import * as repo from '../nfse/repository'\nexport const w = wrap(repo['insertTransmissionEvent'])`],
  ['Reflect.get', `import { SERVICE_VOICE_FAMILY } from '../nfse/voice-family'\nexport const w = wrap(Reflect.get(SERVICE_VOICE_FAMILY, 'insertTransmissionEvent'))`],
  ['Object.values', `import { SERVICE_VOICE_FAMILY } from '../nfse/voice-family'\nexport const w = Object.values(SERVICE_VOICE_FAMILY).map(wrap)`],
]
const escapesOf = (list: [string, string][]) => list.filter(([, src]) => !writerCallFlags(src)).map(([label]) => label)

describe('1 — D-F108: um descritor só e o escritor só como valor das políticas', () => {
  it('[CORRIGIDO na sessão — D-NE82 (a)] [MEDIUM NE1A2-09] um 2º DESCRITOR da tabela da NFS-e "por qualquer grafia" é violação da cerca — hoje alias por const, `.call`, `(0, f)`, acesso por elemento, desestruturação do namespace e `Reflect.apply` ESCAPAM', () => {
    expect(escapesOf(DESCRIPTOR_SPELLINGS)).toEqual([])
  })

  it('[CORRIGIDO na sessão — D-NE82 (a)] (era o contexto do NE1A2-09: alias por const, `.call`, `(0, f)`, namespace por elemento, desestruturação e `Reflect.apply` escapavam) — o NOME do descritor genérico fora do descritor autorizado é violação em qualquer forma; no autorizado, segue aceito', () => {
    expect(escapesOf(DESCRIPTOR_SPELLINGS)).toEqual([])
    expect(writerCallFlags(DESCRIPTOR_SPELLINGS[0][1], { allowFamilyDescriptor: true })).toBe(false)
  })

  it('[CORRIGIDO na sessão — D-NE82 (a)] [LOW NE1A2-10] o escritor da NFS-e como VALOR por acesso de ELEMENTO (`F[\'insertTransmissionEvent\']`), `Reflect.get` ou `Object.values` escapa da regra "o escritor só vai às políticas do núcleo" — o embrulho que o chama com outro kind fica invisível', () => {
    expect(escapesOf(WRITER_VALUE_SPELLINGS)).toEqual([])
  })

  it('[CORRIGIDO na sessão — D-NE82 (a)] (era o contexto do NE1A2-10: elemento do descritor/do repositório, `Reflect.get` e `Object.values` escapavam) — o nome do escritor em TEXTO, o descritor fora de `DESCRITOR.prop` e a reflexão sobre o namespace do escritor são violação; `wrap(repo.insertTransmissionEvent)` também', () => {
    expect(escapesOf(WRITER_VALUE_SPELLINGS)).toEqual([])
    expect(writerCallFlags(`import * as repo from '../nfse/repository'\nexport const w = wrap(repo.insertTransmissionEvent)`)).toBe(true)
  })

  it('[CORRIGIDO na sessão — D-NE82 (a)] contexto (NE1A2-09 + NE1A2-10): a cadeia INTEIRA sem NENHUM cast — 2º descritor por alias + escritor por elemento + kind por constante — ainda COMPILA (tsconfig real), mas a cerca de chamada da PEÇA a pega; em execução o núcleo NÃO guarda registro de descritores (D-NE82 (c) — registro em execução — segue EM PAUTA): grava S e D na tabela da NFS-e', async () => {
    const chain = `import { defineVoiceFamily, SERVICE_VOICE_READING, InvoiceTx } from 'fiscal-api'
declare const itx: InvoiceTx
const make = defineVoiceFamily
export const WIDE = make({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'S', 'P', 'D'], label: 'NFS-e' })
const put = WIDE['insertTransmissionEvent']
const sent: 'S' = 'S'
export async function produce(): Promise<void> {
  await put(itx, 1, null, { kind: sent, source: 'P' })
  await put(itx, 1, null, { kind: 'D', source: 'Q' })
}
`
    expect(compileInMemory([['cadeia', chain]]).get('cadeia')).toEqual([])
    expect([tsProducesS(chain), writerCallFlags(chain)]).toEqual([false, true])                 // antes [false, false] — escapava das duas
    // a MESMA cadeia em execução, com o escritor GENÉRICO real do núcleo, um InvoiceTx de verdade e uma conexão falsa
    const make = defineVoiceFamily
    const WIDE = make({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'S', 'P', 'D'] as const, label: 'NFS-e' })
    const put = WIDE['insertTransmissionEvent']
    const { pool, calls } = fakeConn()
    await withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, invoiceRef(1, 6200, 0), { label: 'gate', lock: async () => LOCKED }, async itx => {
      const sent: 'S' = 'S'
      await put(itx, 1, null, { kind: sent, source: 'P' })
      await put(itx, 1, null, { kind: 'D', source: 'Q' })
    })
    expect(calls.filter(c => /^\s*INSERT/.test(c.sql)).map(c => [c.sql.match(/INSERT INTO (\S+)/)![1], c.p[5]]))
      .toEqual([['tb_invoice_service_transmission_event', 'S'], ['tb_invoice_service_transmission_event', 'D']])
  })

  it('resistiu: o escritor LIGADO no repositório é o do descritor único; o funil dele recusa S/P/D/"s" em execução; desestruturar o escritor segue pego pela cerca', async () => {
    const actualRepo = jest.requireActual('../nfse/repository')
    expect(actualRepo.insertTransmissionEvent).toBe(SERVICE_VOICE_FAMILY.insertTransmissionEvent)
    const { pool, calls } = fakeConn()
    await withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, invoiceRef(1, 6200, 0), { label: 'gate', lock: async () => LOCKED }, async itx => {
      for (const k of ['S', 'P', 'D', 's']) {
        await expect(SERVICE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { kind: k as any, source: 'P' })).rejects.toThrow(/^D-F106/)
      }
    })
    expect(calls).toEqual([])
    expect(writerCallFlags(WRITER_VALUE_SPELLINGS[0][1])).toBe(true)
  })
})

// ===========================================================================
// 2 — D-F107: a lista da família é UMA fonte
// ===========================================================================

describe('2 — a lista de escrita da família', () => {
  it('[CORRIGIDO na sessão] [LOW NE1A2-11] `SERVICE_VOICE_WRITE_KINDS` — a FONTE ÚNICA que o CHECK e a sonda do boot da F2a vão usar (D-F107) — é MUTÁVEL em execução (`as const` é só tipo; NE1A-06 congelou os conjuntos do núcleo pela mesma razão)', () => {
    expect(Object.isFrozen(SERVICE_VOICE_WRITE_KINDS)).toBe(true)
  })

  it('resistiu [convertido — NE1A2-11 corrigido]: mutar a constante (num registro de módulos isolado) agora LANÇA (congelada) e a fonte única segue igual ao que o funil confere; o descritor guardou uma CÓPIA congelada de qualquer forma', async () => {
    let fresh: typeof import('../nfse/voice-family') | null = null
    jest.isolateModules(() => { fresh = jest.requireActual<typeof import('../nfse/voice-family')>('../nfse/voice-family') })
    expect(() => (fresh!.SERVICE_VOICE_WRITE_KINDS as unknown as string[]).push('S')).toThrow(TypeError)
    expect([...fresh!.SERVICE_VOICE_WRITE_KINDS]).toEqual([...fresh!.SERVICE_VOICE_FAMILY.writeKinds])
    expect([...fresh!.SERVICE_VOICE_FAMILY.writeKinds]).toEqual(['A', 'R', 'C', 'K', 'F', 'N'])
    const { pool } = fakeConn()
    await withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, invoiceRef(1, 6200, 0), { label: 'gate', lock: async () => LOCKED }, async itx => {
      await expect(fresh!.SERVICE_VOICE_FAMILY.insertTransmissionEvent(itx, 1, null, { kind: 'S' as any, source: 'P' })).rejects.toThrow(/^D-F106/)
    })
  })
})

// ===========================================================================
// 3 — a composição (mocks na fronteira, molde do transmission.test): referência, escopo, cadeia no rodízio
// ===========================================================================

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const conn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
const pool = { query: jest.fn(), getConnection: jest.fn(async () => conn) } as any
const adapter = { authority: 'ADN', transmit: jest.fn(), queryNfse: jest.fn(), queryDpsAccessKey: jest.fn(), registerEvent: jest.fn(), municipalTerms: jest.fn() }
const storage = { save: jest.fn(() => 'x'), find: jest.fn(() => null), read: jest.fn(() => ''), probe: jest.fn(() => true) }   // nada no disco
const deps: NfseDeps = { pool, keyring: MasterKeyRing.of({}), storage: storage as any, adapter: adapter as any, fiscalDb: 'fiscal_api' }
const A = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const INVOICE = 6200
const CNPJ = '12345678000195'
const KEY = '4106902221234567800019500000000001232026092100001234'.slice(0, 50)
const DPS_ID = 'DPS410690221234567800019500001000000000000042'
const header = (over: any = {}) => ({
  id: INVOICE, number: '17', serie: '1', model: 'SE', value: 1234.5, dtEmission: '2026-09-21', entityId: 900, status: '0',
  lastKind: 'E', lastEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-09-21 09:00:00',
  branchId: INVOICE, serviceListId: '1.02', nationalCode: '010201', municipalCode: null, cityId: 1, baseIss: 1234.5, aliqIss: 2,
  issValue: 24.69, issWithheld: 'N', liability: '1', description: 'Licença mensal ERP', totalValue: 1234.5, ...over,
})
const entity = (id: number) => ({
  id, nameCompany: id === 1 ? 'SETES SISTEMAS LTDA' : 'Cliente Ltda', nickTrade: null,
  cnpj: id === 1 ? '12345678000195' : '98765432000198', im: id === 1 ? '777' : null, cpf: null,
  addresses: [{ main: 'S', street: 'Rua A', nmbr: '10', complement: null, neighborhood: 'Centro', zipCode: '80.010-000', cityId: 1, cityName: 'Curitiba', stateName: 'Paraná' }],
})
const opened = (env = 'H') => ({
  issuer: { institutionId: 1, model: 'SE', environment: env, serie: '1', userId: null },
  cert: Buffer.from('CERT'), key: Buffer.from('KEY'),
  info: { subject: `CN=SETES:${CNPJ}`, issuer: 'AC', notBefore: '2026-01-01', notAfter: '2027-01-01', daysToExpire: 100, expired: false, notYetValid: false, cnpj: CNPJ, fingerprint256: 'x' },
})
const tx = (over: any = {}) => withRecord({
  institutionId: 1, invoiceId: INVOICE, attempt: 1, lifeEvent: 1, environment: 'H', serie: '1', dpsNumber: 42, dpsId: DPS_ID,
  accessKey: KEY, nfseNumber: '123', dhProc: '2026-09-21 13:15:30', createdAt: '2026-09-21 13:15:00', ageMinutes: 0, lastQueriedAt: null,
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: '2026-09-21 13:15:30', lastEventAt: '2026-09-21 13:15:30', lastEventAgeMinutes: 0, ...over,
})
const rejected = () => new AuthorityHttpError(422, 'Fisco rejeitou (400): E0718: alíquota inválida', 'FISCAL_DPS_REJECTED', 400,
  '{"erros":[{"codigo":"E0718","descricao":"alíquota inválida"}]}', [{ field: 'dps', message: 'E0718: alíquota inválida' }])
const chainUntrusted = () => new AuthorityHttpError(409, 'Certificado do servidor do fisco não reconhecido (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', 'FISCAL_AUTHORITY_CHAIN_UNTRUSTED', 0, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')

let headerRow: any
let locked: any
function setup() {
  jest.clearAllMocks()
  resetMunicipalTermsCache()
  headerRow = header()
  locked = { alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }
  pool.query.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice i/.test(sql)) return [[headerRow]]
    return [[]]
  })
  conn.query.mockImplementation(async (sql: string) => {
    if (/FROM `setes_setes`\.tb_invoice_service\s/.test(sql)) return [[{ updatedAt: headerRow.branchUpdatedAt }]]
    return [[]]
  })
  erpM.lockInvoice.mockImplementation(async () => locked)
  erpM.invoiceLife.mockImplementation(async () => ({ invoiceId: INVOICE, invoiceDeleted: false, lifeEvent: locked.lifeEvent, lastEvent: locked.lastEvent, lastKind: locked.lastKind }))
  erpM.invoiceLives.mockImplementation(async () => new Map())
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
  erpM.entityFiscal.mockImplementation(async (_q: any, id: number) => entity(id))
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', simplesTotalTaxAliquot: 6, specialTaxRegime: '0' })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.establishmentCnpj.mockResolvedValue(CNPJ)
  ;(fiscal.openIssuer as jest.Mock).mockResolvedValue(opened())
  ;(fiscal.nextDpsNumber as jest.Mock).mockResolvedValue(42)
  ;(fiscal.acquireRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.releaseRefreshLease as jest.Mock).mockResolvedValue(true)
  ;(fiscal.renewRefreshLease as jest.Mock).mockResolvedValue('2026-10-04 12:01:00')
  ;(fiscal.emissionStillInErp as jest.Mock).mockResolvedValue(false)
  ;(fiscal.getIssuer as jest.Mock).mockResolvedValue({ institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00' })
  ;(repo.findKeyHolder as jest.Mock).mockResolvedValue(null)
  ;(repo.getLifeDps as jest.Mock).mockResolvedValue(null)
  ;(repo.latestTransmission as jest.Mock).mockResolvedValue(null)
  ;(repo.getTransmission as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionByDpsId as jest.Mock).mockImplementation(async () => (repo.latestTransmission as jest.Mock)())
  ;(repo.findTransmissionEventByKind as jest.Mock).mockResolvedValue(null)
  ;(repo.insertTransmission as jest.Mock).mockResolvedValue(1)
  ;(repo.insertTransmissionEvent as jest.Mock).mockResolvedValue(1)
  ;(repo.hasTransmissionEvent as jest.Mock).mockResolvedValue(false)
  ;(repo.listLifeTransmissions as jest.Mock).mockResolvedValue({ transmissions: [], events: [] })
  adapter.municipalTerms.mockResolvedValue({ cancelDays: null, raw: {} })
}

describe('3 — composição: a referência inteira, o escopo e a cadeia do servidor no rodízio', () => {
  beforeEach(setup)

  it('[CORRIGIDO na sessão] [LOW NE1A2-12] a composição confere a referência (`refOf`) mas segue usando o OBJETO do chamador nas transações seguintes: uma referência MUTÁVEL trocada durante a ida ao fisco faz a voz R pousar em OUTRA nota (trava e escrita na 9999)', async () => {
    // Na rota a referência é congelada (`invoiceRef`), mas a composição é a API interna da família (scripts, rodízio, a futura nfe-api copiando
    // o molde): `refOf` devolve o MESMO objeto e `transmitServiceInvoice` usa `ref` nas três transações (reserva, fisco, voz). O núcleo congela
    // DENTRO de cada `withInvoiceTx` — entre elas, não. A tentativa 1 da 6200 vira "tentativa 1 da 9999".
    const ref = { institutionId: 1, invoiceId: INVOICE, terminal: 0 }
    adapter.transmit.mockImplementation(async () => { ref.invoiceId = 9999; throw rejected() })
    await expect(transmitServiceInvoice(deps, A, ref)).rejects.toMatchObject({ code: 'FISCAL_DPS_REJECTED' })
    const lockedIds = erpM.lockInvoice.mock.calls.map(c => c[2].invoiceId)
    const writtenOn = (repo.insertTransmissionEvent as jest.Mock).mock.calls.map(c => c[0].ref.invoiceId)
    expect({ lockedIds, writtenOn }).toEqual({ lockedIds: [INVOICE, INVOICE], writtenOn: [INVOICE] })
  })

  it('resistiu: referência de OUTRA institution, terminal negativo/fracionário/texto, id não inteiro ou nula falha ALTO antes de qualquer leitura/trava/fisco — nas seis composições por nota e nas duas em lote', async () => {
    const bad: any[] = [
      { institutionId: 2, invoiceId: INVOICE, terminal: 0 }, { institutionId: 1, invoiceId: INVOICE, terminal: -1 },
      { institutionId: 1, invoiceId: INVOICE, terminal: 1.5 }, { institutionId: 1, invoiceId: INVOICE, terminal: '0' },
      { institutionId: 1, invoiceId: Number.NaN, terminal: 0 }, null,
    ]
    for (const ref of bad) {
      for (const run of [
        () => transmitServiceInvoice(deps, A, ref), () => refreshServiceTransmission(deps, A, ref, 'Q', { origin: 'consulta' }),
        () => reconfirmBeforeLocalCancel(deps, A, ref), () => cancelServiceInvoiceAtAuthority(deps, A, ref, 'motivo do cancelamento'),
        () => getServiceFiscalView(deps, A, ref), () => readNfseXml(deps, A, ref),
      ]) await expect(run()).rejects.toThrow(ref === null ? /Referência da nota inválida|Cannot read properties of null/ : /Referência da nota inválida/)   // null: o catch da consulta lê `ref.invoiceId` e troca a mensagem (segue falhando alto)
    }
    for (const terminal of [-1, 1.5, Number.NaN, '0' as any]) {
      await expect(listPending(deps, A, terminal, { page: 1, pageSize: 10 }, null)).rejects.toThrow(/Terminal inválido/)
      await expect(refreshOpenServiceTransmissions(deps, A, { terminal })).rejects.toThrow(/Terminal inválido/)
    }
    expect([pool.query.mock.calls.length, erpM.lockInvoice.mock.calls.length, erpM.invoiceLife.mock.calls.length,
      adapter.transmit.mock.calls.length, (fiscal.acquireRefreshLease as jest.Mock).mock.calls.length]).toEqual([0, 0, 0, 0, 0])
  })

  it('resistiu: D-NE57 no RODÍZIO — a cadeia do servidor é erro do EMISSOR: a passada PÁRA na 1ª candidata, nenhuma voz, nenhum carimbo, o aluguel volta; o escopo vai ao SQL com o terminal da borda', async () => {
    ;(repo.listRefreshCandidates as jest.Mock).mockResolvedValue([tx({ invoiceId: INVOICE }), tx({ invoiceId: INVOICE + 1 })])
    ;(repo.latestTransmission as jest.Mock).mockResolvedValue(tx())
    adapter.queryNfse.mockRejectedValue(chainUntrusted())
    const r = await refreshOpenServiceTransmissions(deps, A, { terminal: 0 })
    expect(r).toMatchObject({ checked: 1, stoppedEarly: true, errors: [{ invoiceId: INVOICE, code: 'FISCAL_AUTHORITY_CHAIN_UNTRUSTED' }] })
    expect(adapter.queryNfse).toHaveBeenCalledTimes(1)
    expect([(repo.insertTransmissionEvent as jest.Mock).mock.calls.length, (repo.touchQueriedAt as jest.Mock).mock.calls.length]).toEqual([0, 0])
    expect(fiscal.releaseRefreshLease).toHaveBeenCalledTimes(1)
    expect((repo.listRefreshCandidates as jest.Mock).mock.calls[0][2]).toEqual({ institutionId: 1, terminal: 0 })
  })
})

// ===========================================================================
// 4 — D-NE69: as listas DERIVADAS têm os MESMOS membros para os kinds da NFS-e (o texto que vai ao banco)
// ===========================================================================

describe('4 — D-NE69 sobre o SQL real da família', () => {
  const NFSE_KINDS = ['A', 'R', 'C', 'K', 'F', 'N', 'S']
  const parse = (s: string) => s.split(',').map(x => x.trim().replace(/'/g, ''))

  it('resistiu: rodízio (vivas, autorizadas, ramo cortado) e pendentes do lote — para A/R/C/K/F/N/S os membros são os das listas literais de antes; a ordenação muda de membros só em R/C, que NUNCA são candidatas (o WHERE não os admite)', async () => {
    const sqls: string[] = []
    const q = { query: jest.fn(async (sql: string) => { sqls.push(sql); return /COUNT\(\*\)/.test(sql) ? [[{ n: 0 }]] : [[]] }) } as any
    const actualRepo = jest.requireActual('../nfse/repository')
    await actualRepo.listRefreshCandidates(q, 'setes_setes', { institutionId: 1, terminal: 0 }, 5, 10, 8, { interfaces: ['orders'], liveOnlyInterfaces: ['order-returns'] })
    const rodizio = sqls[0]
    const live = parse(/OR \(le\.kind IN \(([^)]*)\)\s*AND \(t\.last_queried_at/.exec(rodizio)![1])
    const authorized = parse(/OR \(le\.kind IN \(([^)]*)\) AND COALESCE\(l\.last_kind/.exec(rodizio)![1])
    const liveOnly = parse(/le\.kind IS NULL OR le\.kind IN \(([^)]*)\)\)\)/.exec(rodizio)![1])
    const order = parse(/ORDER BY \(le\.kind IN \(([^)]*)\)\)/.exec(rodizio)![1])
    for (const k of NFSE_KINDS) {
      expect([k, live.includes(k), liveOnly.includes(k), authorized.includes(k)]).toEqual([k, ['S', 'K'].includes(k), ['S', 'K'].includes(k), ['A', 'N'].includes(k)])
    }
    const CANDIDATES = ['S', 'K', 'A', 'N', 'F']                         // o que o WHERE admite (além da sem voz)
    for (const k of CANDIDATES) expect([k, order.includes(k)]).toEqual([k, ['A', 'N', 'F'].includes(k)])
    expect(order.filter(k => !['A', 'N', 'F'].includes(k)).sort()).toEqual(['C', 'D', 'R'])
    expect(/le\.kind = 'C'|le\.kind IN \([^)]*'R'/.test(rodizio.replace(/ORDER BY[\s\S]*$/, ''))).toBe(false)
    sqls.length = 0
    await listPendingServiceInvoices(q, 'setes_setes', { institutionId: 1, terminal: 0 }, 'fiscal_api', { page: 1, pageSize: 10 }, null)
    const blocking = parse(/COALESCE\(t\.last_kind, '-'\) IN \(([^)]*)\)/.exec(sqls[0])![1])
    for (const k of [...NFSE_KINDS, '-']) expect([k, blocking.includes(k)]).toEqual([k, ['A', 'N', 'S', 'K', 'C', '-'].includes(k)])
    expect(() => sqlKindList(["A') OR 1=1 -- "])).toThrow(/fora do vocabulário/)
  })
})
