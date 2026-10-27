/// <reference types="jest" />
// D-PV40 (Valdo 2026-10-20 — Infra-IA/prompts/prompt_privilegios_interfaces.md): "transmitir e consultar são dois verbos independentes".
// Na nfse-api: `transmit` = TRANSMITIR (9), `refresh` por nota e a PASSADA do rodízio = CONSULTAR (12), `reconfirm`/`cancel` = CANCELAR (7).
// Princípio D-PV27: o verbo nomeia a FINALIDADE do ato, nunca o transporte — nenhum verbo presume outro.
import * as fiscal from 'fiscal-api'
import { passScope, requireBranchPrivilege } from '../modules/guards'
import { PRIVILEGE_CONSULTAR } from '../modules/privileges'
import type { AppContext } from '../context'
import { webRef } from './fixture-ref'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    emissionStillInErp: jest.fn(async () => false),
    erp: { ...actual.erp, orderInterface: jest.fn(async () => 'service-orders'), userHasPrivilege: jest.fn(), institutionHasInterface: jest.fn(async () => true) },
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const ctx = { pool: {} } as unknown as AppContext
const USER = { institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' } as any
const KEYS = ['service-orders', 'orders', 'order-returns']
const ref = webRef({ institutionId: 1 }, 77)
const outcome = (p: Promise<unknown>) => p.then(r => ['ok', r], (e: any) => [e.statusCode, e.code])

beforeEach(() => { jest.clearAllMocks() })

describe('o verbo da nfse-api', () => {
  it('CONSULTAR é o id 12 do catálogo (seed 68) e difere de TRANSMITIR/CANCELAR do núcleo', () => {
    expect(PRIVILEGE_CONSULTAR).toBe(12)
    expect(PRIVILEGE_CONSULTAR).not.toBe(fiscal.erp.PRIVILEGE_TRANSMITIR)
    expect(PRIVILEGE_CONSULTAR).not.toBe(fiscal.erp.PRIVILEGE_CANCELAR)
  })

  it('quem só tem TRANSMITIR não CONSULTA (e vice-versa) — a guarda por nota confere o par exato', async () => {
    erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, _k: string, pid: number) => pid === fiscal.erp.PRIVILEGE_TRANSMITIR)
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, fiscal.erp.PRIVILEGE_TRANSMITIR))).toEqual(['ok', undefined])
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, PRIVILEGE_CONSULTAR))).toEqual([403, 'PRIVILEGE_REQUIRED'])
    erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, _k: string, pid: number) => pid === PRIVILEGE_CONSULTAR)
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, PRIVILEGE_CONSULTAR))).toEqual(['ok', undefined])
    expect(await outcome(requireBranchPrivilege(ctx, USER, ref, fiscal.erp.PRIVILEGE_TRANSMITIR))).toEqual([403, 'PRIVILEGE_REQUIRED'])
  })

  it('a PASSADA do rodízio confere (interface do ramo × CONSULTAR): os ramos em que o usuário só TRANSMITE ficam fora', async () => {
    erpM.userHasPrivilege.mockImplementation(async (_p: any, _s: string, _u: number, key: string, pid: number) =>
      (key === 'service-orders' && pid === PRIVILEGE_CONSULTAR) || (key === 'orders' && pid === fiscal.erp.PRIVILEGE_TRANSMITIR))
    const scope = await passScope(ctx, USER, KEYS, PRIVILEGE_CONSULTAR)
    expect(scope).toEqual({ interfaces: ['service-orders'], liveOnlyInterfaces: [] })
    expect(erpM.userHasPrivilege.mock.calls.map(c => c[4])).toEqual([PRIVILEGE_CONSULTAR, PRIVILEGE_CONSULTAR, PRIVILEGE_CONSULTAR])
  })
})

describe('cerca: as rotas usam o verbo certo (lido do código)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs'), path = require('path')
  const src: string = fs.readFileSync(path.join(__dirname, '..', 'modules', 'nfse', 'nfse.routes.ts'), 'utf8')
  const handler = (route: string) => {
    const i = src.indexOf(route)
    expect([route, i >= 0]).toEqual([route, true])
    return src.slice(i, src.indexOf('}))', i))
  }
  it('transmit = TRANSMITIR; refresh por nota = CONSULTAR; reconfirm/cancel = CANCELAR; a passada = CONSULTAR', () => {
    expect(handler("'/invoices/:invoiceId/transmit'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, erp\.PRIVILEGE_TRANSMITIR\)/)
    expect(handler("'/invoices/:invoiceId/refresh'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, PRIVILEGE_CONSULTAR\)/)
    expect(handler("'/invoices/:invoiceId/reconfirm'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, erp\.PRIVILEGE_CANCELAR\)/)
    expect(handler("'/invoices/:invoiceId/cancel'")).toMatch(/requireBranchPrivilege\(ctx, inst, ref, erp\.PRIVILEGE_CANCELAR\)/)
    expect(handler("'/refresh'")).toMatch(/passScope\(ctx, inst, PASS_INTERFACES, PRIVILEGE_CONSULTAR\)/)
    expect(src).not.toMatch(/refresh[\s\S]{0,200}PRIVILEGE_TRANSMITIR/)
  })
})
