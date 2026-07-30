const ACTIVE_ORGANIZATION_PREFIX = 'polo-active-organization:'
const PENDING_JOIN_TOKEN_KEY = 'polo-pending-organization-join-token'

function activeOrganizationKey(accountId: string): string {
  return `${ACTIVE_ORGANIZATION_PREFIX}${accountId}`
}

export function getStoredActiveOrganizationId(accountId: string): string | null {
  try {
    return localStorage.getItem(activeOrganizationKey(accountId))
  } catch {
    return null
  }
}

export function setStoredActiveOrganizationId(
  accountId: string,
  organizationId: string,
): void {
  try {
    localStorage.setItem(activeOrganizationKey(accountId), organizationId)
  } catch {
    // The in-memory context still works when storage is unavailable.
  }
}

export function clearStoredActiveOrganizationId(accountId: string): void {
  try {
    localStorage.removeItem(activeOrganizationKey(accountId))
  } catch {
    // Nothing else to clear.
  }
}

export function getPendingOrganizationJoinToken(): string | null {
  try {
    return sessionStorage.getItem(PENDING_JOIN_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setPendingOrganizationJoinToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_JOIN_TOKEN_KEY, token)
  } catch {
    // The hook also keeps the token in memory.
  }
}

export function clearPendingOrganizationJoinToken(): void {
  try {
    sessionStorage.removeItem(PENDING_JOIN_TOKEN_KEY)
  } catch {
    // Nothing else to clear.
  }
}

export function createOrganizationContextKey(
  accountId: string,
  organizationId: string,
): string {
  return `${accountId}:${organizationId}`
}

export function createOrganizationScopedStorageKey(
  accountId: string,
  organizationId: string,
  namespace: string,
): string {
  return `polo-organization:${createOrganizationContextKey(accountId, organizationId)}:${namespace}`
}

export function createOrganizationJoinDeepLink(token: string): string {
  return `poloai://join/${encodeURIComponent(token)}`
}
