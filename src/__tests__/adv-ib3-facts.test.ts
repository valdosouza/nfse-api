/// <reference types="jest" />
// GATE ADVERSARIAL da IB-3 (2026-10-15) — a fonte de fatos monta um DPS com o grupo IBS/CBS que o FISCO vai REJEITAR por regra do Anexo I
// conhecida no momento da montagem (nada local recusa): ACHADO MEDIUM (vermelho até a correção).
//  - RN 255 / E0234: cIndOp ∈ {030102, 050102, 100101, 100301 (o da Setes), 100501, 030103, 050103, 100102, 100201, 100302, 100401, 100502,
//    100601} ⇒ o ENDEREÇO do tomador é obrigatório — e `buildRecipient` OMITE `toma.end` em silêncio quando o endereço está incompleto.
//  - RN 547 / E0903: cTribNac dos subitens 25.05 / 15.09 / 17.12 / 10.05 ⇒ `tpOper` obrigatório — e o montador NUNCA emite `tpOper`.
// Antes da IB-3 a MESMA nota (sem o grupo) era aceita: o grupo abre um caminho novo de rejeição R em vez de 422 com o campo.
// Fonte: Infra-IA/setes-api/integracoes/nfse-adn/anexo1-dps.xlsx (aba "RN DPS_NFS-e", linhas 234/255/547).
import * as fiscal from 'fiscal-api'
import { buildDpsBase, ServiceInvoiceHeader } from '../facts/service-facts'

jest.mock('fiscal-api', () => {
  const actual = jest.requireActual('fiscal-api')
  return {
    __esModule: true, ...actual,
    erp: { ...actual.erp, entityFiscal: jest.fn(), entityTax: jest.fn(), cityIbge: jest.fn(), institutionZone: jest.fn() },
  }
})
const erpM = fiscal.erp as unknown as Record<string, jest.Mock>

const EMITTER = 1, TOMADOR = 501
const header = (over: Partial<ServiceInvoiceHeader['branch']> = {}): ServiceInvoiceHeader => ({
  invoiceId: 7001, number: null, serie: null, model: 'SE', value: 250, dtEmission: '2026-12-20', entityId: TOMADOR, status: 'F',
  lastInvoiceKind: 'E', lastInvoiceEvent: 1, lifeEvent: 1, branchUpdatedAt: '2026-12-20 10:00:00',
  branch: {
    serviceListId: '01.02', nationalCode: '010201', municipalCode: null, cityId: 10, baseIss: 250, aliqIss: 2, issValue: 5,
    issWithheld: 'N', liability: '1', description: 'Suporte mensal', totalValue: 250,
    declaration: { classificationCode: '000001', placeIndicatorCode: '100301', nbs: '115021000' },
    ...over,
  },
})

beforeEach(() => {
  erpM.entityFiscal.mockImplementation(async (_q: unknown, id: number) => id === EMITTER
    ? { cnpj: '12345678000199', nameCompany: 'Setes', addresses: [{ main: 'S', cityId: 10, cityName: 'Curitiba', stateName: 'PR' }] }
    // tomador com endereço INCOMPLETO (sem número) — o XSD deixa `end` opcional e a fonte de fatos o omite calada
    : { cnpj: '98765432000188', nameCompany: 'Cliente', addresses: [{ main: 'S', cityId: 10, zipCode: '80000000', street: 'Rua A', nmbr: '', neighborhood: 'Centro' }] })
  erpM.cityIbge.mockResolvedValue('4106902')
  erpM.entityTax.mockResolvedValue({ simplesRegime: '3', simplesAssessment: '1', specialTaxRegime: '0', simplesTotalTaxAliquot: 6 })
  erpM.institutionZone.mockResolvedValue('America/Sao_Paulo')
})

describe('ACHADO (MEDIUM): rejeições do fisco previsíveis na montagem do grupo IBS/CBS saem ao fisco em vez de 422 local', () => {
  it('E0234 — cIndOp 100301 (o da Setes) com o endereço do tomador incompleto: o DPS iria SEM `toma/end` (o fisco rejeita)', async () => {
    let built: Awaited<ReturnType<typeof buildDpsBase>> | null = null
    let refused: any = null
    try { built = await buildDpsBase({} as any, 'setes_setes', EMITTER, header(), 'P') } catch (e) { refused = e }
    // hoje: monta — com o grupo E sem o endereço que a RN 255 exige para este cIndOp
    if (built) expect({ ibscbs: built.input.ibscbs?.cIndOp, tomaEnd: built.input.toma?.end ?? null }).toEqual({ ibscbs: '100301', tomaEnd: 'exigido (E0234)' })
    else expect(refused).toMatchObject({ statusCode: 422 })
  })

  it('E0903 — serviço do subitem 17.12 classificado: o DPS iria SEM `tpOper` (o montador nunca o emite; o fisco rejeita)', async () => {
    erpM.entityFiscal.mockImplementation(async (_q: unknown, id: number) => id === EMITTER
      ? { cnpj: '12345678000199', nameCompany: 'Setes', addresses: [{ main: 'S', cityId: 10, cityName: 'Curitiba', stateName: 'PR' }] }
      : { cnpj: '98765432000188', nameCompany: 'Cliente', addresses: [{ main: 'S', cityId: 10, zipCode: '80000000', street: 'Rua A', nmbr: '1', neighborhood: 'Centro' }] })
    let refused: any = null
    try { await buildDpsBase({} as any, 'setes_setes', EMITTER, header({ serviceListId: '17.12', nationalCode: '171201' }), 'P') } catch (e) { refused = e }
    expect(refused).toMatchObject({ statusCode: 422 })
  })
})
