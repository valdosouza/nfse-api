/// <reference types="jest" />
// D-F222 + gate socrático do DEPLOY.E1.P1 (achado 3d): o boot por `node dist` recusa o `dist` de OUTRO commit (migration nova da pasta com
// código velho) e registra a versão do núcleo do pacote instalado.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readBuildCheck, assertBuildCurrent } from '../build-info'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('selo do dist (build-info)', () => {
  it('dist de OUTRO commit que o da pasta: recusa subir, dizendo o que fazer', () => {
    expect(() => assertBuildCurrent({ coreVersion: '1.0.0', distCommit: A, headCommit: B }, true)).toThrow(/npm run build/)
  })
  it('dist do MESMO commit: sobe e registra a versão do núcleo e o commit', () => {
    expect(assertBuildCurrent({ coreVersion: '1.0.0', distCommit: A, headCommit: A }, true)).toBe('núcleo fiscal-api 1.0.0 (pacote instalado) · dist do commit aaaaaaa')
  })
  it('sem git ou sem selo: só registra (cópia exportada / dist antigo sem selo); rodando por tsx não confere selo', () => {
    expect(assertBuildCurrent({ coreVersion: '1.0.0', distCommit: A, headCommit: null }, true)).toMatch(/dist do commit/)
    expect(assertBuildCurrent({ coreVersion: '1.0.0', distCommit: null, headCommit: B }, true)).toMatch(/dist sem selo/)
    expect(assertBuildCurrent({ coreVersion: '1.0.0', distCommit: A, headCommit: B }, false)).toMatch(/tsx \(sem dist\)/)
  })
  it('lê a versão do núcleo do PACOTE INSTALADO e o selo do dist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'))
    try {
      fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit: A }))
      const c = readBuildCheck(dir)
      expect(c.coreVersion).toBe(JSON.parse(fs.readFileSync(require.resolve('fiscal-api/package.json'), 'utf8')).version)
      expect(c.distCommit).toBe(A)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
