import { get as getLocalStorage, KEYS, set as setLocalStorage } from '@/lib/local-storage'

/**
 * Device-local home surface preferences (POO-70 WS-HOME-APPS).
 *
 * Frequent (pinned) apps and hidden directory entries are personal display
 * preferences for this device only — they never change what a space or circle
 * publishes. Both are scoped by the same context key as the recent-apps
 * history so they follow account/space switches.
 */

export const HOME_FREQUENT_APP_LIMIT = 5

export type PinnedHomeAppKind = 'external' | 'organization' | 'circle'

export interface PinnedHomeAppRef {
  /** External app id / organization scope key / circle app id. */
  id: string
  kind: PinnedHomeAppKind
  /** Captured at pin time; display fallback when the entry leaves the catalog. */
  name?: string
  iconUrl?: string
}

export type HiddenHomeAppKind = 'organization' | 'circle'

export interface HiddenHomeAppRef {
  /** Organization scope key / circle app id. */
  id: string
  kind: HiddenHomeAppKind
  /** Captured at hide time; display fallback when the entry leaves the catalog. */
  name?: string
}

const PINNED_KINDS: readonly PinnedHomeAppKind[] = [
  'external',
  'organization',
  'circle',
]
const HIDDEN_KINDS: readonly HiddenHomeAppKind[] = ['organization', 'circle']

function sanitizeRefs<T extends { id: string; kind: string }>(
  value: unknown,
  kinds: readonly string[],
  limit?: number,
): T[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const refs: T[] = []
  for (const item of value) {
    if (
      !item
      || typeof item !== 'object'
      || typeof (item as T).id !== 'string'
      || (item as T).id.length === 0
      || !kinds.includes((item as T).kind)
    ) continue
    const key = `${(item as T).kind}:${(item as T).id}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(item as T)
    if (limit != null && refs.length >= limit) break
  }
  return refs
}

export function loadHomePinnedApps(contextKey: string): PinnedHomeAppRef[] {
  return sanitizeRefs<PinnedHomeAppRef>(
    getLocalStorage<unknown>(KEYS.homePinnedApps, [], contextKey),
    PINNED_KINDS,
    HOME_FREQUENT_APP_LIMIT,
  )
}

export function saveHomePinnedApps(
  contextKey: string,
  refs: readonly PinnedHomeAppRef[],
): PinnedHomeAppRef[] {
  const sanitized = sanitizeRefs<PinnedHomeAppRef>(
    refs,
    PINNED_KINDS,
    HOME_FREQUENT_APP_LIMIT,
  )
  setLocalStorage(KEYS.homePinnedApps, sanitized, contextKey)
  return sanitized
}

export function loadHiddenHomeApps(contextKey: string): HiddenHomeAppRef[] {
  return sanitizeRefs<HiddenHomeAppRef>(
    getLocalStorage<unknown>(KEYS.homeHiddenApps, [], contextKey),
    HIDDEN_KINDS,
  )
}

export function saveHiddenHomeApps(
  contextKey: string,
  refs: readonly HiddenHomeAppRef[],
): HiddenHomeAppRef[] {
  const sanitized = sanitizeRefs<HiddenHomeAppRef>(refs, HIDDEN_KINDS)
  setLocalStorage(KEYS.homeHiddenApps, sanitized, contextKey)
  return sanitized
}
