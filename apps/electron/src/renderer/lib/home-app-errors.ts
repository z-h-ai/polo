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

/**
 * product-closure U5: structured server codes that mean "the INSTALLATION
 * ARTIFACT cannot be served" — a platform/admin-side condition (POL-277:
 * resolve-launch 200 but download 409 `bundle_bytes_unavailable` because the
 * bundle store volume was missing). Matching is by the code the client
 * ACTUALLY received — never inferred from an HTTP status. Add codes here as
 * the server surfaces them; the mapping turns an endless user-retry loop
 * into the honest next step: contact the enterprise admin, with the real
 * code copyable for the report.
 */
export const BUNDLE_UNAVAILABLE_CODES = new Set([
  'bundle_bytes_unavailable',
  'BUNDLE_BYTES_UNAVAILABLE',
  'bundle_not_found',
  'BUNDLE_NOT_FOUND',
])

export function isBundleUnavailableCode(code: string | null): boolean {
  return code !== null && BUNDLE_UNAVAILABLE_CODES.has(code)
}

export function homeAppOperationErrorText(
  t: TFunction,
  error: unknown,
  operation: HomeAppOperation,
  spaceKind: HomeAppSpaceKind = null,
): string {
  const code = getHomeAppErrorCode(error)
  // product-closure U5: infrastructure-side artifact unavailability. The fix
  // belongs to the enterprise admin/platform, not to another user retry.
  if (isBundleUnavailableCode(code)) {
    return t('infraError.installBundleUnavailable')
  }
  if (code === 'NOT_FOUND') return t('homeApps.status.unavailableGeneric')
  if (code === 'CIRCLE_ENTITLEMENT_REQUIRED') return t('homeApps.errors.circleEntitlementRequired')
  if (
    code === 'NOT_AUTHORIZED'
    || code === 'REMOTE_FORBIDDEN'
    || code === 'FORBIDDEN'
    || code === 'UNAUTHORIZED'
  ) {
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

export interface HomeAppErrorPresentation {
  /** Localized, user-facing text (same as homeAppOperationErrorText). */
  text: string
  /**
   * The structured server code worth surfacing for a report — set ONLY for
   * infrastructure-side conditions (U5: `bundle_bytes_unavailable` family).
   * Business errors keep their regular copy without a code badge.
   */
  copyableCode: string | null
}

/**
 * product-closure U5: presentation wrapper around homeAppOperationErrorText.
 * The toast description renders `copyableCode` as a copyable badge so the
 * user can hand the REAL server code to their admin instead of retyping a
 * paraphrase. Never includes credentials or internal paths — the code is the
 * same string the server put on the wire.
 */
export function homeAppErrorPresentation(
  t: TFunction,
  error: unknown,
  operation: HomeAppOperation,
  spaceKind: HomeAppSpaceKind = null,
): HomeAppErrorPresentation {
  const code = getHomeAppErrorCode(error)
  return {
    text: homeAppOperationErrorText(t, error, operation, spaceKind),
    copyableCode: isBundleUnavailableCode(code) ? code : null,
  }
}
