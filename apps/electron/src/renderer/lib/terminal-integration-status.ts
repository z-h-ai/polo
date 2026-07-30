import type { TFunction } from 'i18next'
import type { TerminalIntegrationStatus } from '../../shared/types'

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
