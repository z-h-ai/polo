import { DeniedAppCatalogSnapshotSchema } from './schemas.ts'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  DeniedAppCatalogSnapshot,
  DeniedCatalogApp,
} from './types.ts'

export interface AdminAuthorizationErrorLike {
  code?: string
  errorCode?: string
  status?: number
}

export type AdminAuthorizationFailureKind =
  | 'session'
  | 'catalog_scope'
  | 'none'

const SESSION_ENDING_CODES = new Set([
  'ACCOUNT_DISABLED',
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
])

const CATALOG_SCOPE_CODES = new Set([
  'FORBIDDEN',
  'MEMBERSHIP_REMOVED',
  'MEMBERSHIP_SUSPENDED',
  'ORGANIZATION_UNAVAILABLE',
  'NOT_FOUND',
])

export function getAdminAuthorizationErrorCode(
  value: AdminAuthorizationErrorLike,
): string | undefined {
  return value.code || value.errorCode
}

export function classifyAdminAuthorizationFailure(
  value: AdminAuthorizationErrorLike,
  options: { catalogScoped: boolean },
): AdminAuthorizationFailureKind {
  // HTTP authentication status is authoritative even when an untrusted or
  // partial response body contains a conflicting organization-level code.
  if (value.status === 401) return 'session'

  const code = getAdminAuthorizationErrorCode(value)
  if (code && SESSION_ENDING_CODES.has(code)) return 'session'

  if (options.catalogScoped) {
    if ((code && CATALOG_SCOPE_CODES.has(code)) || value.status === 403) {
      return 'catalog_scope'
    }
    return 'none'
  }

  if ((code && CATALOG_SCOPE_CODES.has(code)) || value.status === 403) {
    return 'session'
  }
  return 'none'
}

export function markAppCatalogAccessDenied(
  catalog: AppCatalogCacheEntry,
): DeniedAppCatalogSnapshot {
  const projectApp = (app: CatalogApp): DeniedCatalogApp => ({
    id: app.id,
    organizationId: app.organizationId,
    name: app.name,
    description: app.description,
    ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
    ...(app.creatorName ? { creatorName: app.creatorName } : {}),
    deliveryMode: app.deliveryMode,
    sortOrder: app.sortOrder,
    availability: 'unavailable',
  })
  return DeniedAppCatalogSnapshotSchema.parse({
    accountId: catalog.accountId,
    organizationId: catalog.organizationId,
    appConfigVersion: catalog.appConfigVersion,
    authorizationStatus: 'denied',
    syncedAt: catalog.syncedAt,
    apps: catalog.apps.map(projectApp),
    ...(catalog.withdrawnApps
      ? { withdrawnApps: catalog.withdrawnApps.map(projectApp) }
      : {}),
  })
}
