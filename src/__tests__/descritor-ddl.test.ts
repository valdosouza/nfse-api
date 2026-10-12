/// <reference types="jest" />
// Gates da parte 2 da NE-1a (socrático #8 + D-NE76): o DESCRITOR da família e a leitura publicada AMARRADOS ao DDL da família — sem isto, só a
// suíte ao vivo pegaria um nome errado, e nada no `defineVoiceFamily` amarra `reading` × `eventTable`.
//  - a tabela da voz do descritor (`SERVICE_VOICE_FAMILY.eventTable`) é a BASE da view de vozes e o JOIN da última voz na view de tentativas;
//  - a view de tentativas `vw_<x>` está sobre a tabela `tb_<x>` (a CONVENÇÃO que o "família instalada?" da D-NE76 usa no núcleo).
import fs from 'fs'
import path from 'path'
import { SERVICE_VOICE_READING } from 'fiscal-api'
import { SERVICE_VOICE_FAMILY } from '../nfse/voice-family'

const SQL_DIR = path.resolve(__dirname, '..', 'migrations', 'sql')
const statements = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort()
  .flatMap(f => fs.readFileSync(path.join(SQL_DIR, f), 'utf8').replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean))
/** A ÚLTIMA definição da view (a vigente — as migrations são aplicadas em ordem). */
const viewBody = (view: string): string => {
  const defs = statements.filter(s => new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+\`?${view}\`?\\s+AS`, 'i').test(s))
  expect(defs.length).toBeGreaterThan(0)
  return defs[defs.length - 1]
}
const tablesCreated = statements.map(s => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i.exec(s)?.[1]).filter(Boolean)
const mainFrom = (body: string) => /\bFROM\s+`?(\w+)`?\s+\w+/i.exec(body)?.[1]
const joins = (body: string) => [...body.matchAll(/\bJOIN\s+`?(\w+)`?\s+\w+/gi)].map(m => m[1])

describe('o descritor da NFS-e × o DDL da família', () => {
  it('a tabela da voz do descritor existe, é a BASE da view de vozes publicada e o JOIN da última voz na view de tentativas', () => {
    const table = SERVICE_VOICE_FAMILY.eventTable
    expect(table).toBe('tb_invoice_service_transmission_event')
    expect(tablesCreated).toContain(table)
    expect(mainFrom(viewBody(SERVICE_VOICE_READING.voiceView))).toBe(table)
    expect(joins(viewBody(SERVICE_VOICE_READING.transmissionView))).toContain(table)
    expect(SERVICE_VOICE_FAMILY.reading).toBe(SERVICE_VOICE_READING)
  })
  it('D-NE76: a view de tentativas `vw_<x>` está sobre a tabela `tb_<x>` (o "família instalada?" do núcleo deriva a tabela da view)', () => {
    const view = SERVICE_VOICE_READING.transmissionView
    expect(view).toMatch(/^vw_/)
    const table = `tb_${view.slice(3)}`
    expect(tablesCreated).toContain(table)
    expect(mainFrom(viewBody(view))).toBe(table)
  })
})
