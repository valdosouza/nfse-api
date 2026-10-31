/// <reference types="jest" />
// A-PV1 (Valdo 2026-10-18 — Infra-IA/prompts/prompt_privilegios_interfaces.md, D-PV3 "o super deve escapar de todas as
// verificações"): o SUPER passa também a LICENÇA nas guardas da nfse-api — revê a D-F37 SÓ para ele. Admin e regular seguem
// como estavam (D-F14/D-F37/D-F46/D-F47). A cerca da virada NÃO é licença: vale para o super também.
import * as fiscal from 'fiscal-api'
import { wireAccess } from './access-stub'
import {
  requireBranchPrivilege, requireBranchInterface, requireAnyInterface, visibleInterfaces, passScope, requireCutover,
} from '../modules/guards'
import type { AppContext } from '../context'
import { webRef } from './fixture-ref'

jest.mock('dotenv/config', () => ({}))
jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    access: { ...actual.access, accessVerdict: jest.fn(), reachableKeys: jest.fn(), grantedKeys: jest.fn(), liveIdentity: jest.fn() },
    emissionStillInErp: jest.fn(async () => true),
    erp: {
      ...actual.erp,
      orderInterface: jest.fn(async () => 'service-orders'),
    },
  }
})

const erpM = fiscal.erp as unknown as Record<string, jest.Mock>
const licensedM = jest.fn()   // licença (interface contratada) — costura A1: o veredito é `access.*`, dublado por ./access-stub
const grantedM = jest.fn()    // concessão do verbo (pelo NOME — D-PV53)
wireAccess(fiscal.access, licensedM, grantedM)
const ctx = { pool: {} } as unknown as AppContext
const SUPER = { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' } as any
const FAKE_SUPER = { institutionId: 2, userId: 5, role: 'super', schemaName: 'setes_x' } as any   // isSuper exige a institution 1
const ADMIN = { institutionId: 1, userId: 2, role: 'admin', schemaName: 'setes_setes' } as any
const USER = { institutionId: 1, userId: 9, role: 'user', schemaName: 'setes_setes' } as any
const KEYS = ['service-orders', 'orders', 'order-returns']
const ref = webRef({ institutionId: 1 }, 77)
const outcome = (p: Promise<unknown>) => p.then(r => ['ok', r], (e: any) => [e.statusCode, e.code])

beforeEach(() => {
  jest.clearAllMocks()
  licensedM.mockResolvedValue(false)          // NADA contratado
  grantedM.mockResolvedValue(true)                  // o vínculo existe — a licença é que barra
})

describe('A-PV1 — o super passa a licença em todas as guardas', () => {
  it('ação por nota (TRANSMITIR/CANCELAR) com o ramo NÃO contratado: o super passa; admin e regular 403 INTERFACE_NOT_ALLOWED', async () => {
    expect(await outcome(requireBranchPrivilege(ctx, SUPER, ref, 'TRANSMITIR'))).toEqual(['ok', undefined])
    // o super não consulta contrato nem vínculo (escapa das duas — na view, o ramo 'super' da vw_user_reach/vw_user_access)
    expect(licensedM).not.toHaveBeenCalled()
    expect(grantedM).not.toHaveBeenCalled()
    for (const who of [ADMIN, USER, FAKE_SUPER]) {
      expect(await outcome(requireBranchPrivilege(ctx, who, ref, 'TRANSMITIR'))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    }
    expect(licensedM).toHaveBeenCalled()                           // admin e regular: a licença foi consultada (e barrou)
  })

  it('leituras do ramo (No fisco, XML, DANFSe) e "alguma interface fiscal": o super passa; os outros 403', async () => {
    expect(await outcome(requireBranchInterface(ctx, SUPER, ref))).toEqual(['ok', undefined])
    expect(await outcome(requireAnyInterface(ctx, SUPER, KEYS))).toEqual(['ok', undefined])
    for (const who of [ADMIN, USER]) {
      expect(await outcome(requireBranchInterface(ctx, who, ref))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
      expect(await outcome(requireAnyInterface(ctx, who, KEYS))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
    }
  })

  it('lista de pendentes: o super vê todos os ramos; admin só os contratados', async () => {
    licensedM.mockImplementation(async (_p: any, _s: string, _i: number, k: string) => k === 'orders')
    expect(await visibleInterfaces(ctx, SUPER, KEYS)).toEqual(KEYS)
    expect(await visibleInterfaces(ctx, ADMIN, KEYS)).toEqual(['orders'])
  })

  it('passada do rodízio (D-F46/D-F47): para o super todo ramo é contratado — tudo em [interfaces], nada "só vivas"', async () => {
    expect(await passScope(ctx, SUPER, KEYS, 'TRANSMITIR')).toEqual({ interfaces: KEYS, liveOnlyInterfaces: [] })
    // admin com nada contratado segue a D-F47 (só as vivas dos cortados); regular 403
    expect(await passScope(ctx, ADMIN, KEYS, 'TRANSMITIR')).toEqual({ interfaces: [], liveOnlyInterfaces: KEYS })
    expect(await outcome(passScope(ctx, USER, KEYS, 'TRANSMITIR'))).toEqual([403, 'INTERFACE_NOT_ALLOWED'])
  })

  it('a cerca da virada NÃO é licença: emissão ainda no ERP → 409 FISCAL_CUTOVER_PENDING também para o super', async () => {
    expect(await outcome(requireCutover(ctx, SUPER, 'SE'))).toEqual([409, 'FISCAL_CUTOVER_PENDING'])
  })
})
