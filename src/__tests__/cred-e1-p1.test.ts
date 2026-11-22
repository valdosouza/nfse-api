/// <reference types="jest" />
// CRED.E1.P1 (D-NE221…D-NE226, ficha `projetos/nfse-api/SUBJECT/CRED/ficha-cred-e1-p1-rota-credenciais.md`): a nfse-api mantém a credencial
// fiscal do FORNECEDOR por UF (o CSRT do PR) pela peça do núcleo 4.1.0 — e o boot dela sobe SEM o CSRT (é por ela que ele é cadastrado).
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p)
    return /\.ts$/.test(e.name) ? [p] : []
  })
}

describe('CRED.E1.P1.T2 — o boot da nfse-api não depende do CSRT', () => {
  it('o boot confere o domínio da 006 depois das migrations e NÃO exige a credencial do fornecedor', () => {
    const server = read('server.ts')
    expect(server.indexOf('await assertFiscalCodeDomainsEnforced(ctx.pool)')).toBeGreaterThan(server.indexOf('await runMigrations('))
    expect(server).not.toMatch(/assertRequiredProviderCodesPresent|requiredFiscalCredentialsFor/)
  })
  it('nenhum arquivo de src/ (fora dos testes) chama a exigência do CSRT', () => {
    const offenders = sourceFiles(SRC).filter(f => /assertRequiredProviderCodesPresent/.test(fs.readFileSync(f, 'utf8')))
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
  })
})
