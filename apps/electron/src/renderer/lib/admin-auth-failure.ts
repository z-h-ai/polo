export interface AdminErrorLike {
  code?: string
  errorCode?: string
  status?: number
}

export interface NormalizedAdminError {
  code: string
  status?: number
}

export const ADMIN_AUTH_FAILURE_EVENT = 'polo:admin-auth-failure'

const ADMIN_AUTH_FAILURE_CODES = new Set([
  'ACCOUNT_DISABLED',
  'FORBIDDEN',
  'MEMBERSHIP_REMOVED',
  'MEMBERSHIP_SUSPENDED',
  'ORGANIZATION_UNAVAILABLE',
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
])

const CATALOG_SCOPE_AUTHORIZATION_CODES = new Set([
  'FORBIDDEN',
  'MEMBERSHIP_REMOVED',
  'MEMBERSHIP_SUSPENDED',
  'ORGANIZATION_UNAVAILABLE',
  'NOT_FOUND',
])

const CATALOG_SESSION_ENDING_CODES = new Set([
  'ACCOUNT_DISABLED',
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
])

export function getAdminErrorCode(value: AdminErrorLike): string | undefined {
  return value.code || value.errorCode
}

export function normalizeAdminError(
  value: AdminErrorLike,
  fallbackCode = 'request_failed',
): NormalizedAdminError {
  return {
    code: getAdminErrorCode(value) || fallbackCode,
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  }
}

export function isAdminAuthFailureResult(value: AdminErrorLike): boolean {
  const code = getAdminErrorCode(value)
  return (
    (code ? ADMIN_AUTH_FAILURE_CODES.has(code) : false)
    || value.status === 401
    || value.status === 403
  )
}

export function emitAdminAuthFailure(value: AdminErrorLike): boolean {
  if (!isAdminAuthFailureResult(value)) return false
  window.dispatchEvent(new CustomEvent<NormalizedAdminError>(
    ADMIN_AUTH_FAILURE_EVENT,
    { detail: normalizeAdminError(value) },
  ))
  return true
}

export function isAdminCatalogSessionAuthFailure(
  value: AdminErrorLike,
): boolean {
  const code = getAdminErrorCode(value)
  if (code && CATALOG_SESSION_ENDING_CODES.has(code)) return true
  if (code && CATALOG_SCOPE_AUTHORIZATION_CODES.has(code)) return false
  return value.status === 401
}

export function emitAdminCatalogSessionAuthFailure(
  value: AdminErrorLike,
): boolean {
  if (!isAdminCatalogSessionAuthFailure(value)) return false
  window.dispatchEvent(new CustomEvent<NormalizedAdminError>(
    ADMIN_AUTH_FAILURE_EVENT,
    { detail: normalizeAdminError(value) },
  ))
  return true
}

export function subscribeToAdminAuthFailures(
  listener: (error: NormalizedAdminError) => void,
): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<NormalizedAdminError>).detail)
  }
  window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, handleEvent)
  return () => window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, handleEvent)
}
