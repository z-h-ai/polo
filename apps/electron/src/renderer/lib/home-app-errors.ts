import type { TFunction } from 'i18next'

export type HomeAppOperation =
  | 'cancel'
  | 'install'
  | 'logs'
  | 'open'
  | 'stop'
  | 'uninstall'

export function getHomeAppErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  if (typeof record.code === 'string' && record.code) return record.code
  if (typeof record.errorCode === 'string' && record.errorCode) {
    return record.errorCode
  }
  return null
}

export function homeAppOperationErrorText(
  t: TFunction,
  error: unknown,
  operation: HomeAppOperation,
): string {
  const code = getHomeAppErrorCode(error)
  if (code === 'NOT_AUTHORIZED' || code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    return t('homeApps.errors.unavailable')
  }
  if (code === 'PLATFORM_MISMATCH' || code === 'ARCH_MISMATCH') {
    return t('homeApps.status.incompatible')
  }
  if (code === 'INSTALL_CANCELLED') {
    return t('homeApps.errors.installCancelled')
  }
  if (code === 'RELEASE_CHANGED') {
    return t('homeApps.errors.releaseChanged')
  }
  if (code === 'NOT_INSTALLED') {
    return t('homeApps.errors.notInstalled')
  }
  if ([
    'CHECKSUM_MISMATCH',
    'DEPENDENCY_INSTALL_FAILED',
    'DOWNLOAD_FAILED',
    'INSTALL_TIMEOUT',
    'INVALID_MANIFEST',
    'RUNTIME_UNAVAILABLE',
    'SIZE_MISMATCH',
    'UNSAFE_ARCHIVE',
    'UNSUPPORTED_ARCHIVE',
  ].includes(code ?? '')) {
    return t('homeApps.errors.installGeneric')
  }
  if (['PORT_UNAVAILABLE', 'PROCESS_CRASHED', 'START_FAILED', 'START_TIMEOUT']
    .includes(code ?? '')) {
    return t('homeApps.errors.openGeneric')
  }

  const fallbackKeys: Record<HomeAppOperation, string> = {
    cancel: 'homeApps.errors.cancelInstallGeneric',
    install: 'homeApps.errors.installGeneric',
    logs: 'homeApps.errors.logsGeneric',
    open: 'homeApps.errors.openGeneric',
    stop: 'homeApps.errors.stopGeneric',
    uninstall: 'homeApps.errors.uninstallGeneric',
  }
  return t(fallbackKeys[operation])
}

export function catalogStateMessage(
  t: TFunction,
  code: string | null,
  kind: 'warning' | 'error',
): string {
  if (code === 'INVALID_SEMVER') {
    return t('homeApps.organization.invalidVersionWarning')
  }
  if (code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT') {
    return kind === 'warning'
      ? t('homeApps.organization.offlineWarning')
      : t('homeApps.organization.networkError')
  }
  if (
    code === 'FORBIDDEN'
    || code === 'UNAUTHORIZED'
    || code === 'ACCOUNT_DISABLED'
    || code === 'MEMBERSHIP_REMOVED'
    || code === 'MEMBERSHIP_SUSPENDED'
    || code === 'ORGANIZATION_UNAVAILABLE'
  ) {
    return t('homeApps.organization.accessError')
  }
  return kind === 'warning'
    ? t('homeApps.organization.refreshWarning')
    : t('homeApps.organization.loadError')
}
