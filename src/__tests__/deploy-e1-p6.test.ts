/// <reference types="jest" />
// nfse-api:DEPLOY.E1.P6 — o GRANT das views ao 'setes_api' no script de permissões, a parte da nfse-api (PM-9 do fiscal-api; D-F15).
// Daqui o 'setes_api' recebe SÓ a view de tentativas da NFS-e. As três views da janela da NE-6 (tentativas da NF-e, faixas de numeração
// e habilitação por modelo — D-NE161, D-NE170) ficam num lugar só, o `nfe-api/ops/grants.sql` seção 2: este arquivo APONTA para lá e
// nunca repete as linhas (lista em dois lugares = alguém aplica pela metade). Só o TEXTO do script: nenhum banco é tocado.
import fs from 'fs'
import path from 'path'
import { SERVICE_VOICE_READING, MERCHANDISE_VOICE_READING, WITHDRAWN_RANGES_VIEW, ISSUER_VIEW } from 'fiscal-api'

const sql = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ops', 'grants.sql'), 'utf8')

/**
 * Toda instrução GRANT do arquivo, comentada ou não (a linha do 'setes_api' fica comentada até a janela — o texto é o contrato), JUNTADA
 * até o `;` (gates, L3/LOW-6: um GRANT quebrado em duas linhas escapava do leitor por linha).
 */
export function grantStatements(text: string): string[] {
  const out: string[] = []
  let current: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*--\s?/, '').trim()
    if (current === null && /^GRANT\b/i.test(line)) current = ''
    if (current === null) continue
    current = `${current} ${line}`.trim()
    if (line.includes(';')) { out.push(current.slice(0, current.indexOf(';') + 1)); current = null }
  }
  if (current !== null) out.push(current)
  return out
}
/** O usuário do setes-api, com aspas, crase ou sem nada. */
const toSetesApi = (g: string) => /\bTO\s+['`"]?setes_api\b/i.test(g)
const NE6 = [MERCHANDISE_VOICE_READING.transmissionView, WITHDRAWN_RANGES_VIEW, ISSUER_VIEW]

describe('DEPLOY.E1.P6 — o que o `ops/grants.sql` da nfse-api dá ao setes_api', () => {
  const grants = grantStatements(sql)

  it('uma instrução só para o setes_api: SELECT na view de tentativas da NFS-e, no banco fiscal_api — nunca curinga', () => {
    expect(grants.filter(toSetesApi)).toEqual([`GRANT SELECT ON \`fiscal_api\`.\`${SERVICE_VOICE_READING.transmissionView}\` TO 'setes_api'@'%';`])
    expect(grants.filter(g => /setes_api/i.test(g))).toHaveLength(1)   // nenhuma outra menção em instrução GRANT
  })

  it('nenhuma instrução GRANT deste arquivo cita as três views da janela da NE-6 (as linhas são do nfe-api/ops/grants.sql)', () => {
    expect(NE6).toEqual(['vw_invoice_merchandise_transmission', 'vw_invoice_number_void', 'vw_establishment_issuer'])
    expect(grants.length).toBeGreaterThan(10)
    for (const view of NE6) expect([view, grants.filter(g => g.includes(view))]).toEqual([view, []])
  })

  it('o leitor enxerga o que a cerca tem de recusar: GRANT em duas linhas, usuário sem aspas e curinga', () => {
    const bad = grantStatements([
      '-- GRANT SELECT ON', '--   `fiscal_api`.`vw_establishment_issuer` TO \'setes_api\'@\'%\';',
      'GRANT SELECT ON `fiscal_api`.* TO setes_api@\'%\';',
      'GRANT SELECT ON `fiscal_api`.`x` TO `setes_api`@`%`;',
    ].join('\n'))
    expect(bad).toHaveLength(3)
    expect(bad.every(toSetesApi)).toBe(true)
    expect(bad[0]).toContain('vw_establishment_issuer')
  })

  it('o comentário aponta o lugar único das três linhas, as nomeia e dá a ordem (depois das migrations, antes de reiniciar o setes-api)', () => {
    expect(sql).toContain('`nfe-api/ops/grants.sql`')
    for (const view of NE6) expect(sql).toContain(`\`${view}\``)
    expect(sql).toMatch(/DEPOIS das migrations[^\n]*\n[^\n]*ANTES de reiniciar o setes-api/)
    expect(sql).toMatch(/A nfse-api NÃO precisa de GRANT novo para subir com o 5\.0\.0/)
  })

  it('as linhas novas são só comentário: o script segue com as mesmas instruções executáveis', () => {
    const live = sql.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('--'))
    expect(live.every(l => /^(CREATE USER|GRANT|REVOKE)\b/.test(l.trim()))).toBe(true)
    expect(live.filter(l => /setes_api/.test(l))).toEqual([])          // nada ao setes_api é aplicado por este script sem descomentar
  })
})
