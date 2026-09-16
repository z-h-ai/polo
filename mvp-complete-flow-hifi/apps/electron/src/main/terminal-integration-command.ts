import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  uninstallTerminalIntegration,
  type TerminalIntegrationOptions,
  type TerminalIntegrationStatus,
} from './terminal-integration'

export type TerminalIntegrationCommand = 'install' | 'repair' | 'uninstall' | 'status'

export const TERMINAL_INTEGRATION_COMMAND_ERROR_CODE =
  'POLO_E_TERMINAL_INTEGRATION_INVALID_COMMAND' as const

export class TerminalIntegrationCommandParseError extends Error {
  readonly errorCode = TERMINAL_INTEGRATION_COMMAND_ERROR_CODE
  readonly errorParams = {
    operations: 'install, repair, uninstall, status',
  }

  constructor() {
    super(TERMINAL_INTEGRATION_COMMAND_ERROR_CODE)
    this.name = 'TerminalIntegrationCommandParseError'
  }
}

export function parseTerminalIntegrationCommand(
  argv: string[],
): TerminalIntegrationCommand | null {
  const index = argv.indexOf('--polo-terminal-integration')
  if (index === -1) return null
  const command = argv[index + 1]
  if (
    command === 'install'
    || command === 'repair'
    || command === 'uninstall'
    || command === 'status'
  ) {
    return command
  }
  throw new TerminalIntegrationCommandParseError()
}

export function executeTerminalIntegrationCommand(
  command: TerminalIntegrationCommand,
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if (command === 'uninstall') return uninstallTerminalIntegration(options)
  if (command === 'status') return getTerminalIntegrationStatus(options)
  return installTerminalIntegration(options)
}
