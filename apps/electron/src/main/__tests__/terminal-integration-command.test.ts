import { describe, expect, it } from 'bun:test'
import { parseTerminalIntegrationCommand } from '../terminal-integration-command'

describe('terminal integration command entrypoint', () => {
  it.each(['install', 'repair', 'uninstall', 'status'] as const)(
    'parses %s',
    (command) => {
      expect(parseTerminalIntegrationCommand([
        '/Applications/Polo AI.app/Contents/MacOS/Polo AI',
        '--polo-terminal-integration',
        command,
      ])).toBe(command)
    },
  )

  it('does not intercept a normal application launch', () => {
    expect(parseTerminalIntegrationCommand(['Polo AI'])).toBeNull()
  })

  it('rejects an incomplete or unknown operation', () => {
    expect(() => parseTerminalIntegrationCommand([
      'Polo AI',
      '--polo-terminal-integration',
      'replace',
    ])).toThrow('requires install, repair, uninstall, or status')
  })
})
