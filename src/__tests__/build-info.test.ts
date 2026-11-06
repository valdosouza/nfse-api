/// <reference types="jest" />
// D-F222 + gate socrático do DEPLOY.E1.P1 (achado 3d) e gates do delta (LOW 3/7): o boot por `node dist` recusa o `dist` de OUTRO commit
// (migration nova da pasta com código velho), registra a versão do núcleo do pacote instalado e diz quando NÃO conferiu.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readBuildCheck, assertBuildCurrent } from '../build-info'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const base = { coreVersion: '1.0.0', distDirty: false }

describe('selo do dist (build-info)', () => {
  it('dist de OUTRO commit que o da pasta: recusa subir, dizendo o que fazer', () => {
    expect(() => assertBuildCurrent({ ...base, distCommit: A, headCommit: B }, true)).toThrow(/npm run build/)
  })
  it('dist do MESMO commit: sobe e registra a versão do núcleo e o commit', () => {
    expect(assertBuildCurrent({ ...base, distCommit: A, headCommit: A }, true)).toBe('núcleo fiscal-api 1.0.0 (pacote instalado) · dist do commit aaaaaaa')
  })
  it('sem git ou sem selo: sobe, mas a linha diz NÃO conferido (nunca igual à do caso conferido); tsx não confere selo', () => {
    expect(assertBuildCurrent({ ...base, distCommit: A, headCommit: null }, true)).toMatch(/NÃO conferido \(sem git\)/)
    expect(assertBuildCurrent({ ...base, distCommit: null, headCommit: B }, true)).toMatch(/sem selo — NÃO conferido/)
    expect(assertBuildCurrent({ ...base, distCommit: A, headCommit: B }, false)).toMatch(/tsx \(sem dist\)/)
  })
  it('dist compilado de árvore com alteração: dito na linha do log', () => {
    expect(assertBuildCurrent({ ...base, distDirty: true, distCommit: A, headCommit: A }, true)).toMatch(/árvore com alteração/)
  })
  it('lê a versão do núcleo do PACOTE INSTALADO, o selo do dist e o commit pela pasta do PROJETO (não pelo cwd)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'))
    const cwd = process.cwd()
    try {
      fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit: A, dirty: true }))
      process.chdir(os.tmpdir())                                            // quem chamou está FORA do repositório
      const c = readBuildCheck(dir, path.resolve(__dirname, '..', '..'))
      expect(c.coreVersion).toBe(JSON.parse(fs.readFileSync(require.resolve('fiscal-api/package.json'), 'utf8')).version)
      expect(c.distCommit).toBe(A)
      expect(c.distDirty).toBe(true)
      expect(c.headCommit).toMatch(/^[0-9a-f]{40}$/)
    } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
