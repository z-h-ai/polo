import { createOrganizationContextKey } from './context-key.ts'

export type AppCatalogAccessMode = 'online' | 'offline' | 'denied'

interface AppCatalogAccessEntry {
  accountId: string
  organizationId: string
  mode: AppCatalogAccessMode
}

const accessModes = new Map<string, AppCatalogAccessEntry>()
const deniedAccounts = new Set<string>()

/**
 * Process-local authorization freshness. It intentionally starts offline on
 * every cold boot; only a successful Admin response upgrades a catalog to
 * online and permits downloads or updates.
 */
export function getAppCatalogAccessMode(
  accountId: string,
  organizationId: string,
): AppCatalogAccessMode {
  if (deniedAccounts.has(accountId)) return 'denied'

  return accessModes.get(
    createOrganizationContextKey(accountId, organizationId),
  )?.mode ?? 'offline'
}

export function setAppCatalogAccessMode(
  accountId: string,
  organizationId: string,
  mode: AppCatalogAccessMode,
): void {
  accessModes.set(createOrganizationContextKey(accountId, organizationId), {
    accountId,
    organizationId,
    mode,
  })
}

export function denyAppCatalogAccessForAccount(accountId: string): void {
  // The account gate covers cold-cache scopes that have not yet been
  // materialized in accessModes, so session ending fails closed independently
  // of catalog persistence and scope discovery.
  deniedAccounts.add(accountId)

  for (const [entryKey, entry] of accessModes) {
    if (entry.accountId === accountId) {
      accessModes.set(entryKey, {
        ...entry,
        mode: 'denied',
      })
    }
  }
}

export function isAppCatalogAccessDeniedForAccount(accountId: string): boolean {
  return deniedAccounts.has(accountId)
}

export function resumeAppCatalogAccessForAccount(accountId: string): void {
  deniedAccounts.delete(accountId)
}

export function resetAppCatalogAccessModesForTests(): void {
  accessModes.clear()
  deniedAccounts.clear()
}
