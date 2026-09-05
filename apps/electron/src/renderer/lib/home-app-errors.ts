import type { TFunction } from 'i18next'

/**
 * POO-43 member operations only: runtime stop/log/cancel controls belong to
 * the POO-47 Runtime and must never resurface through these home messages.
 */
export type HomeAppOperation = 'install' | 'open' | 'uninstall'

export type HomeAppSpaceKind = 'personal' | 'enterprise' | null

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
  spaceKind: HomeAppSpaceKind = null,
): string {
  const code = getHomeAppErrorCode(error)
  if (code === 'NOT_AUTHORIZED' || code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    // Personal-space circle grants never use organization phrasing.
    return spaceKind === 'enterprise'
      ? t('homeApps.errors.unavailable')
      : t('homeApps.status.unauthorizedPersonal')
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
    install: 'homeApps.errors.installGeneric',
    open: 'homeApps.errors.openGeneric',
    uninstall: 'homeApps.errors.uninstallGeneric',
  }
  return t(fallbackKeys[operation])
}

export function catalogStateMessage(
  t: TFunction,
  code: string | null,
  kind: 'warning' | 'error',
  spaceKind: HomeAppSpaceKind = null,
): string {
  if (code === 'INVALID_SEMVER') {
    return t('homeApps.organization.invalidVersionWarning')
  }
  if (code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT') {
    if (kind === 'warning') return t('homeApps.organization.offlineWarning')
    return spaceKind === 'enterprise'
      ? t('homeApps.organization.networkError')
      : t('homeApps.space.networkError')
  }
  if (
    code === 'FORBIDDEN'
    || code === 'UNAUTHORIZED'
    || code === 'ACCOUNT_DISABLED'
    || code === 'MEMBERSHIP_REMOVED'
    || code === 'MEMBERSHIP_SUSPENDED'
    || code === 'ORGANIZATION_UNAVAILABLE'
  ) {
    return spaceKind === 'enterprise'
      ? t('homeApps.organization.accessError')
      : t('homeApps.space.accessError')
  }
  if (kind === 'warning') return t('homeApps.organization.refreshWarning')
  return spaceKind === 'enterprise'
    ? t('homeApps.organization.loadError')
    : t('homeApps.space.loadError')
}
