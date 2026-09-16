import type { TFunction } from 'i18next'
import type {
  TerminalIntegrationErrorPayload,
  TerminalIntegrationStatus,
} from '../../shared/types'
import { TERMINAL_INTEGRATION_ERROR_KEYS } from '../../shared/terminal-integration'

const STATUS_KEYS: Record<TerminalIntegrationStatus['statusCode'], string> = {
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
  return t(STATUS_KEYS[status.statusCode], status.statusParams)
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
