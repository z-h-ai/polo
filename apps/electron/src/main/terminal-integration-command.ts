import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  uninstallTerminalIntegration,
  type TerminalIntegrationOptions,
  type TerminalIntegrationStatus,
} from './terminal-integration'

export type TerminalIntegrationCommand = 'install' | 'repair' | 'uninstall' | 'status'

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
  throw new Error(
    '--polo-terminal-integration requires install, repair, uninstall, or status',
  )
}

export function executeTerminalIntegrationCommand(
  command: TerminalIntegrationCommand,
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if (command === 'uninstall') return uninstallTerminalIntegration(options)
  if (command === 'status') return getTerminalIntegrationStatus(options)
  return installTerminalIntegration(options)
}
