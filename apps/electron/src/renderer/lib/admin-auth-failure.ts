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
  return (code ? ADMIN_AUTH_FAILURE_CODES.has(code) : false) || value.status === 401
}

export function emitAdminAuthFailure(value: AdminErrorLike): boolean {
  if (!isAdminAuthFailureResult(value)) return false
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
