import type { TFunction } from 'i18next'
import type { TerminalIntegrationErrorCode, TerminalIntegrationStatus, TerminalIntegrationErrorPayload } from './types'

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

export const TERMINAL_INTEGRATION_STATUS_KEYS: Record<TerminalIntegrationStatus['statusCode'], string> = {
  command_conflict: 'settings.terminalFeatures.status.commandConflict',
  launcher_conflict: 'settings.terminalFeatures.status.launcherConflict',
  managed_by_installer: 'settings.terminalFeatures.status.managedByInstaller',
  not_installed: 'settings.terminalFeatures.status.notInstalled',
  profile_conflict: 'settings.terminalFeatures.status.profileConflict',
  ready: 'settings.terminalFeatures.status.ready',
  repair_required: 'settings.terminalFeatures.status.repairRequired',
}

export function getTerminalIntegrationStatusMessage(
  status: TerminalIntegrationStatus,
  t: TFunction,
): string {
  if (status.shellCheck?.status === 'timeout') return t('settings.terminalFeatures.status.shellTimeout')
  return t(TERMINAL_INTEGRATION_STATUS_KEYS[status.statusCode], status.statusParams)
}

export function getTerminalIntegrationErrorMessage(
  error: TerminalIntegrationErrorPayload,
  t: TFunction,
): string {
  return t(
    TERMINAL_INTEGRATION_ERROR_KEYS[error.errorCode],
    error.errorParams,
  )
}
