import type { TFunction } from 'i18next'

/**
 * Locale-aware formatting helper for install sizes (kept in the H3 lib layer
 * so HomePage and any future member surface share one implementation).
 */
export function formatBytes(t: TFunction, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return t('homeApps.install.unknownSize')
  }
  const unitKeys = [
    'homeApps.install.sizeUnit.bytes',
    'homeApps.install.sizeUnit.kilobytes',
    'homeApps.install.sizeUnit.megabytes',
    'homeApps.install.sizeUnit.gigabytes',
  ] as const
  let size = sizeBytes
  let unit = 0
  while (size >= 1024 && unit < unitKeys.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${
    size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)
  } ${t(unitKeys[unit]!)}`
}

/**
 * POO-70 H3 (P70-HOME-01) — per-ProductSpace-context "recently used" records
 * for the home directory sort.
 *
 * Extracted from HomePage into a lib so the circle detail views (and any
 * other member surface that opens a work App) can record opens through the
 * SAME stable contract — Spec line "圈子打开也更新最近记录" — instead of
 * importing a page component.
 *
 * - One record is UI-level usage evidence (the member pressed open on THIS
 *   device), never an authorization or entitlement fact — sort-only.
 * - Records are keyed by the SAME ProductSpace context-key convention as the
 *   retired quick-access registry (`v1:account|space`), so personal and
 *   enterprise usage never mix and an account switch cannot leak records
 *   across accounts.
 * - Records persist in the renderer's localStorage (best-effort, bounded);
 *   a corrupted or unavailable store fails closed to an empty record set and
 *   the sort simply degrades to the authoritative Catalog order.
 */

export interface HomeAppUsageRecord {
  lastUsedAt: number
  openCount: number
}

const HOME_APP_USAGE_STORAGE_PREFIX = 'poo70.h3:home-app-usage:'
const HOME_APP_USAGE_MAX_ENTRIES = 200
const homeAppUsageByContext = new Map<string, Map<string, HomeAppUsageRecord>>()

export function loadHomeAppUsage(contextKey: string): Map<string, HomeAppUsageRecord> {
  const cached = homeAppUsageByContext.get(contextKey)
  if (cached) return cached
  const records = new Map<string, HomeAppUsageRecord>()
  try {
    const raw = window.localStorage.getItem(HOME_APP_USAGE_STORAGE_PREFIX + contextKey)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!value || typeof value !== 'object') continue
          const { lastUsedAt, openCount } = value as {
            lastUsedAt?: unknown
            openCount?: unknown
          }
          if (
            typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt) && lastUsedAt >= 0
            && typeof openCount === 'number' && Number.isFinite(openCount) && openCount >= 0
          ) {
            records.set(key, { lastUsedAt, openCount })
          }
        }
      }
    }
  } catch {
    // Fail closed to an empty record set — never block the directory.
  }
  homeAppUsageByContext.set(contextKey, records)
  return records
}

function persistHomeAppUsage(
  contextKey: string,
  records: Map<string, HomeAppUsageRecord>,
): void {
  try {
    // Bound the record set: evict the OLDEST last-use first.
    while (records.size > HOME_APP_USAGE_MAX_ENTRIES) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [key, record] of records) {
        if (record.lastUsedAt < oldestAt) {
          oldestAt = record.lastUsedAt
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      records.delete(oldestKey)
    }
    const payload: Record<string, HomeAppUsageRecord> = {}
    for (const [key, record] of records) payload[key] = record
    window.localStorage.setItem(
      HOME_APP_USAGE_STORAGE_PREFIX + contextKey,
      JSON.stringify(payload),
    )
  } catch {
    // Persistence is best-effort: the in-memory records keep the session sort.
  }
}

/**
 * Records one open action for an App of the given ProductSpace context.
 * UI-preference data only (never an authorization fact) and scoped to the
 * exact account+space context key.
 */
export function recordHomeAppUsage(
  contextKey: string,
  identityKey: string,
  now = Date.now(),
): void {
  if (!contextKey || !identityKey) return
  const records = loadHomeAppUsage(contextKey)
  const previous = records.get(identityKey)
  records.set(identityKey, {
    lastUsedAt: now,
    openCount: (previous?.openCount ?? 0) + 1,
  })
  persistHomeAppUsage(contextKey, records)
}

/**
 * Test-only: drop every per-context usage record.
 */
export function __resetHomeAppUsageForTests(): void {
  homeAppUsageByContext.clear()
}
