/// <reference types="jest" />
// D-PV40 (Valdo 2026-10-20 — Infra-IA/prompts/prompt_privilegios_interfaces.md): "transmitir e consultar são dois verbos independentes".
// Na nfse-api: `transmit` = TRANSMITIR, `refresh` por nota e a PASSADA do rodízio = CONSULTAR, `reconfirm`/`cancel` = CANCELAR.
// Princípio D-PV27: o verbo nomeia a FINALIDADE do ato, nunca o transporte — nenhum verbo presume outro.
// D-PV49/D-PV53 (Valdo 2026-10-27) + costura A1 da auth-api (D-AU6, 2026-10-31): a nfse-api NÃO guarda número de privilégio — o verbo é
// citado pelo NOME e o veredito é a biblioteca única do núcleo (`access`); o arquivo local `src/modules/privileges.ts` MORREU.
import fs from 'fs'
import path from 'path'
import * as fiscal from 'fiscal-api'
import { wireAccess } from './access-stub'
import { passScope, requireBranchPrivilege } from '../modules/guards'
import type { AppContext } from '../context'
import { webRef } from './fixture-ref'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    emissionStillInErp: jest.fn(async () => false),
    erp: { ...actual.erp, orderInterface: jest.fn(async () => 'service-orders') },
  }
})

const licensedM = jest.fn()   // licença (interface contratada) — o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const ctx = { pool: {} } as unknown as AppContext
const USER = { institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' } as any
const KEYS = ['service-orders', 'orders', 'order-returns']
const ref = webRef({ institutionId: 1 }, 77)
const outcome = (p: Promise<unknown>) => p.then(r => ['ok', r], (e: any) => [e.statusCode, e.code])

beforeEach(() => {
  jest.clearAllMocks()
  licensedM.mockResolvedValue(true)
})

describe('o verbo da nfse-api', () => {
  it('nenhum número de privilégio nas APIs fiscais (D-PV49/D-PV53): o núcleo não exporta PRIVILEGE_* e a nfse-api não tem catálogo local', () => {
    expect(Object.keys(fiscal.erp).filter(k => k.startsWith('PRIVILEGE_'))).toEqual([])
    expect(fs.existsSync(path.join(__dirname, '..', 'modules', 'privileges.ts'))).toBe(false)
    expect(fiscal.access.PRIVILEGE_NAMES).toEqual(expect.arrayContaining(['TRANSMITIR', 'CONSULTAR', 'CANCELAR']))
  })

  it('quem só tem TRANSMITIR não CONSULTA (e vice-versa) — a guarda por nota confere o par exato', async () => {
    grantedM.mockImplementation(async (_p: any, _s: string, _u: number, _k: string, verb: string) => verb === 'TRANSMITIR')
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, 'TRANSMITIR'))).toEqual(['ok', undefined])
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, 'CONSULTAR'))).toEqual([403, 'PRIVILEGE_REQUIRED'])
    grantedM.mockImplementation(async (_p: any, _s: string, _u: number, _k: string, verb: string) => verb === 'CONSULTAR')
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, 'CONSULTAR'))).toEqual(['ok', undefined])
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, 'TRANSMITIR'))).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('a guarda pergunta à biblioteca pelo NOME do verbo, com a interface do ramo', async () => {
    grantedM.mockResolvedValue(true)
    await requireBranchPrivilege(ctx, USER, ref, 'CONSULTAR')
    expect(fiscal.access.accessVerdict).toHaveBeenCalledWith(ctx.pool, USER, ['service-orders'], 'CONSULTAR')
  })

  it('a PASSADA do rodízio confere (interface do ramo × CONSULTAR): os ramos em que o usuário só TRANSMITE ficam fora', async () => {
    grantedM.mockImplementation(async (_p: any, _s: string, _u: number, key: string, verb: string) =>
      (key === 'service-orders' && verb === 'CONSULTAR') || (key === 'orders' && verb === 'TRANSMITIR'))
    const scope = await passScope(ctx, USER, KEYS, 'CONSULTAR')
    expect(scope).toEqual({ interfaces: ['service-orders'], liveOnlyInterfaces: [] })
    expect(fiscal.access.grantedKeys).toHaveBeenCalledWith(ctx.pool, USER, KEYS, 'CONSULTAR')
  })
})

describe('cerca: as rotas usam o verbo certo (lido do código)', () => {
  const src: string = fs.readFileSync(path.join(__dirname, '..', 'modules', 'nfse', 'nfse.routes.ts'), 'utf8')
  const handler = (route: string) => {
    const i = src.indexOf(route)
    expect([route, i >= 0]).toEqual([route, true])
    return src.slice(i, src.indexOf('}))', i))
  }
  it('transmit = TRANSMITIR; refresh por nota = CONSULTAR; reconfirm/cancel = CANCELAR; a passada = CONSULTAR', () => {
    expect(handler("'/invoices/:invoiceId/transmit'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, 'TRANSMITIR'\)/)
    expect(handler("'/invoices/:invoiceId/refresh'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, 'CONSULTAR'\)/)
    expect(handler("'/invoices/:invoiceId/reconfirm'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, 'CANCELAR'\)/)
    expect(handler("'/invoices/:invoiceId/cancel'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, 'CANCELAR'\)/)
    expect(handler("'/refresh'")).toMatch(/passScope\(ctx, inst, PASS_INTERFACES, 'CONSULTAR'\)/)
    expect(src).not.toMatch(/PRIVILEGE_[A-Z]+/)
  })
})
