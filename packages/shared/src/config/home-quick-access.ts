/**
 * Home quick-access preference (POO-43).
 *
 * The member home always shows the fixed Polo assistant plus at most
 * MAX_HOME_QUICK_ACCESS_APPS work Apps from the active ProductSpace Catalog.
 * A quick-access entry is ONLY a home shortcut — it never implies an install,
 * uninstall, or sideload, and it is only rendered when the referenced Catalog
 * entry is still available in the current space.
 *
 * Preferences are isolated by a versioned account/product-space context key,
 * so personal and enterprise home configurations never share state.
 */

export interface HomeQuickAccessApp {
  /** Catalog scope key (JSON tuple) of the referenced Catalog entry. */
  id: string
  /** Epoch millis when the entry was added to the home quick access. */
  addedAt: number
}

export type HomeQuickAccessByContext = Record<string, HomeQuickAccessApp[]>

/** Fixed Polo assistant slot is implicit; this caps the work-App slots only. */
export const MAX_HOME_QUICK_ACCESS_APPS = 5

const MAX_ADMIN_ENTITY_ID_LENGTH = 512
const MAX_ESCAPED_ENTITY_ID_LENGTH = MAX_ADMIN_ENTITY_ID_LENGTH * 6

// Same ceiling contract as home-recent: covers the complete Catalog scope
// tuple JSON for the entry id and the versioned <account, product-space>
// context key without weakening the shared 512-character entity ID contract.
export const MAX_HOME_QUICK_ACCESS_CONTEXT_KEY_LENGTH =
  'v1:'.length + JSON.stringify(['', '']).length
  + (2 * MAX_ESCAPED_ENTITY_ID_LENGTH)

export const MAX_HOME_QUICK_ACCESS_APP_ID_LENGTH =
  JSON.stringify(['catalog', '', '', '']).length
  + (3 * MAX_ESCAPED_ENTITY_ID_LENGTH)

/**
 * Validates and clips a quick-access list while PRESERVING the user's
 * explicit slot order (unlike launcher history, order is managed, not
 * recency). Duplicates collapse to the first occurrence.
 */
export function sanitizeHomeQuickAccess(
  apps: readonly unknown[],
): HomeQuickAccessApp[] {
  if (!Array.isArray(apps)) return []
  const seen = new Set<string>()
  const sanitized: HomeQuickAccessApp[] = []
  for (const raw of apps) {
    if (
      !raw
      || typeof raw !== 'object'
      || typeof (raw as HomeQuickAccessApp).id !== 'string'
    ) continue
    const id = (raw as HomeQuickAccessApp).id
    const addedAt = (raw as HomeQuickAccessApp).addedAt
    if (
      id.length === 0
      || id.length > MAX_HOME_QUICK_ACCESS_APP_ID_LENGTH
      || !Number.isFinite(addedAt)
      || (addedAt as number) < 0
      || seen.has(id)
    ) continue
    seen.add(id)
    sanitized.push({ id, addedAt: addedAt as number })
    if (sanitized.length >= MAX_HOME_QUICK_ACCESS_APPS) break
  }
  return sanitized
}
