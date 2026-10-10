/// <reference types="jest" />
// Gate do delta da Rodada 6 (M3): o ATO da virada é irreversível no ERP que guarda a produção da Setes — lista FECHADA de
// argumentos (o desconhecido falha antes de abrir o banco) e `--vai` explícito para gravar (sem ele, ensaio).
import { argumentErrors } from '../../scripts/migrate-args'

describe('migrate:setes — argumentos (M3)', () => {
  it('os usos válidos passam', () => {
    for (const a of [[], ['--dry-run'], ['--cutover', '1', '--confirmo-setes-api-parado'], ['--cutover', '1', '--confirmo-setes-api-parado', '--dry-run'],
      ['--cutover', '1', '--confirmo-setes-api-parado', '--vai']]) {
      expect([a, argumentErrors(a)]).toEqual([a, []])
    }
  })

  it('um --dry-run digitado errado NÃO vira o ato: argumento desconhecido falha', () => {
    for (const typo of ['--dryrun', '--dry_run', '-dry-run', '--dry-run=1', 'dry-run']) {
      expect(argumentErrors(['--cutover', '1', '--confirmo-setes-api-parado', typo]).join()).toMatch(/argumento desconhecido/)
    }
  })

  it('--vai só com --cutover e nunca junto com --dry-run; --cutover sem id falha', () => {
    expect(argumentErrors(['--vai']).join()).toMatch(/só existe para o ato/)
    expect(argumentErrors(['--cutover', '1', '--confirmo-setes-api-parado', '--vai', '--dry-run']).join()).toMatch(/juntos/)
    expect(argumentErrors(['--cutover']).join()).toMatch(/precisa de um institutionId/)
    expect(argumentErrors(['--cutover', '--vai']).join()).toMatch(/precisa de um institutionId/)
  })
})
