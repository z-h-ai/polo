export type AppCatalogAccessMode = 'online' | 'offline' | 'denied'

const accessModes = new Map<string, AppCatalogAccessMode>()
const deniedAccounts = new Set<string>()

function createAppCatalogAccessKey(
  accountId: string,
  organizationId: string,
): string {
  return JSON.stringify([accountId, organizationId])
}

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
    createAppCatalogAccessKey(accountId, organizationId),
  ) ?? 'offline'
}

export function setAppCatalogAccessMode(
  accountId: string,
  organizationId: string,
  mode: AppCatalogAccessMode,
): void {
  accessModes.set(createAppCatalogAccessKey(accountId, organizationId), mode)
}

export function denyAppCatalogAccessForAccount(accountId: string): void {
  // The account gate covers cold-cache scopes that have not yet been
  // materialized in accessModes, so session ending fails closed independently
  // of catalog persistence and scope discovery.
  deniedAccounts.add(accountId)

  for (const [entryKey] of accessModes) {
    try {
      const [entryAccountId] = JSON.parse(entryKey) as [string, string]
      if (entryAccountId === accountId) accessModes.set(entryKey, 'denied')
    } catch {
      accessModes.delete(entryKey)
    }
  }
}

export function resumeAppCatalogAccessForAccount(accountId: string): void {
  deniedAccounts.delete(accountId)
}

export function resetAppCatalogAccessModesForTests(): void {
  accessModes.clear()
  deniedAccounts.clear()
}
