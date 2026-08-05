import type { TerminalIntegrationErrorCode } from './types'

export const TERMINAL_INTEGRATION_ERROR_KEYS: Record<
  TerminalIntegrationErrorCode,
  string
> = {
  install_failed: 'settings.terminalFeatures.error.installFailed',
  ipc_failed: 'settings.terminalFeatures.error.ipcFailed',
  profile_malformed: 'settings.terminalFeatures.error.profileMalformed',
  status_failed: 'settings.terminalFeatures.error.statusFailed',
  uninstall_failed: 'settings.terminalFeatures.error.uninstallFailed',
  unsupported_platform: 'settings.terminalFeatures.error.unsupportedPlatform',
}
