import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseTerminalIntegrationCommand,
  TERMINAL_INTEGRATION_COMMAND_ERROR_CODE,
  TerminalIntegrationCommandParseError,
} from '../terminal-integration-command'

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
    try {
      parseTerminalIntegrationCommand([
        'Polo AI',
        '--polo-terminal-integration',
        'replace',
      ])
      throw new Error('expected command parsing to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalIntegrationCommandParseError)
      expect((error as TerminalIntegrationCommandParseError).errorCode)
        .toBe(TERMINAL_INTEGRATION_COMMAND_ERROR_CODE)
      expect((error as TerminalIntegrationCommandParseError).errorParams).toEqual({
        operations: 'install, repair, uninstall, status',
      })
      expect((error as Error).message).not.toContain('requires')
    }
  })

  it('localizes pre-window command failures behind stable error codes', () => {
    const mainSource = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    expect(mainSource).toContain('[POLO_E_TERMINAL_FILES_MISSING]')
    expect(mainSource).toContain('TERMINAL_INTEGRATION_ERROR_KEYS[payload.errorCode]')
    expect(mainSource).toContain('terminalIntegrationCommandParseError.errorCode')
    expect(mainSource).not.toMatch(/process\.stderr\.write\(\s*`\$\{error instanceof Error/)
    expect(mainSource).not.toContain('`Error: ${translateRegistryMessage')
  })
})
