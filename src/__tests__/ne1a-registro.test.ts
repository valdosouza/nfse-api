/// <reference types="jest" />
// NE-1a — parte 1 (D-NE56, Valdo 2026-10-11): o REGISTRO pelo fisco é FATO — a família de serviço é dona da definição (D-F35) e a publica
// na view 004 (`authority_recorded`); a leitura interna da nfse-api (tabelas) usa a MESMA expressão. Puro: sem banco, sem fisco.
import fs from 'fs'
import path from 'path'
import { currentOf, mapTransmissionView, isFiscalRecord } from 'fiscal-api'
import { SERVICE_AUTHORITY_RECORDED_SQL, mapTx } from '../nfse/repository'

const MIGRATION = path.resolve(__dirname, '..', 'migrations', 'sql', '004_transmission_common_projection.sql')
const REPOSITORY = path.resolve(__dirname, '..', 'nfse', 'repository.ts')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('D-NE56 na família de serviço — uma definição do registro, nas duas leituras', () => {
  it('a view 004 publica `authority_recorded` com EXATAMENTE a expressão que a leitura interna usa', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8')
    expect(norm(sql)).toContain(`${norm(SERVICE_AUTHORITY_RECORDED_SQL)} AS \`authority_recorded\``)
    expect(fs.readFileSync(REPOSITORY, 'utf8')).toMatch(/\$\{SERVICE_AUTHORITY_RECORDED_SQL\} AS authorityRecorded/)
    // colação FIXA binária — sem ela a comparação com 'S' numa conexão de outra colação dá erro 1267 (achado da conferência no dev)
    expect(SERVICE_AUTHORITY_RECORDED_SQL).toBe("IF(t.`access_key` IS NULL, 'N', 'S') COLLATE utf8mb4_bin")
  })
  it('a 004 só troca a VIEW (nenhuma tabela) e é re-executável', () => {
    const statements = fs.readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '').split(';').map(norm).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS SELECT /)
  })
  it('a linha interna mapeia o fato ("S" → registrado) e a vigente segue a regra da NFS-e (a tentativa que obteve a NFS-e)', () => {
    const base = { institutionId: 1, invoiceId: 6200, lifeEvent: 1, environment: 'P', lastKind: 'R', nfseNotGeneratedAt: null }   // gates da A1: a prova vem no SELECT
    const withNfse = mapTx({ ...base, attempt: 1, accessKey: 'K'.repeat(50), authorityRecorded: 'S', lastKind: 'A' })
    const later = mapTx({ ...base, attempt: 2, accessKey: null, authorityRecorded: 'N' })
    expect([withNfse.authorityRecorded, later.authorityRecorded]).toEqual([true, false])
    expect(currentOf([later, withNfse])?.attempt).toBe(1)
    expect(isFiscalRecord(withNfse)).toBe(true)
  })
  it('a linha da VIEW sem a coluna nova falha alto no leitor do núcleo (a F2a nunca lê registro "por omissão")', () => {
    expect(() => mapTransmissionView({ attempt: 1, accessKey: 'K' })).toThrow(/authority_recorded/)
  })
  it('D-NE68 (b), gates da parte 1: DENTRO da nfse-api o SQL decide o registro pela CHAVE (lá chave ⇔ registro) e é a MESMA definição da view — `t.access_key IS [NOT] NULL` é a negação exata do IF da 004; a regra que o NÚCLEO exporta ao setes-api lê o FATO', () => {
    const repoSql = fs.readFileSync(REPOSITORY, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    expect((repoSql.match(/\bt\.access_key IS (?:NOT )?NULL\b/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(repoSql).not.toMatch(/\baccess_key\s*(?:<>|!=|=)\s*''/)                     // nenhuma 2ª definição ("chave vazia")
    expect(SERVICE_AUTHORITY_RECORDED_SQL).toMatch(/^IF\(t\.`access_key` IS NULL, 'N', 'S'\)/)
    // a regra que o NÚCLEO exporta (`lifeList.some(t => authorityRecordedOf(t))`, sem `!!t.accessKey`) — D-F228 ("Cada um no seu"):
    // conferida na suíte do núcleo (`fiscal-api/src/__tests__/cercas-portadas-dos-consumidores.test.ts`, bloco E)
  })
  it('gates da parte 1 (NE1A-08): a linha INTERNA também falha alto sem o fato ou incoerente com a chave', () => {
    const base = { institutionId: 1, invoiceId: 6200, lifeEvent: 1, environment: 'P', attempt: 1, nfseNotGeneratedAt: null }
    expect(() => mapTx({ ...base, accessKey: 'K' })).toThrow(/authorityRecorded/)
    expect(() => mapTx({ ...base, accessKey: 'K', authorityRecorded: 'N' })).toThrow(/INCOERENTE/)
    expect(() => mapTx({ ...base, accessKey: null, authorityRecorded: 'S' })).toThrow(/INCOERENTE/)
  })
})
