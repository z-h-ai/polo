import {
  MAX_HOME_RECENT_APP_ID_LENGTH,
  type HomeRecentAppPreference,
} from '@polo-ai/shared/config/home-recent'
import {
  get as getLocalStorage,
  KEYS,
  remove as removeLocalStorage,
} from './local-storage'

export const SIGNED_OUT_HOME_RECENT_CONTEXT_KEY =
  'v2:["signed-out"]'

const MAX_RECENT_APPS = 6

function sanitizeRecentApps(value: unknown): HomeRecentAppPreference[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is HomeRecentAppPreference => (
      item
      && typeof item === 'object'
      && typeof item.id === 'string'
      && item.id.length > 0
      && item.id.length <= MAX_HOME_RECENT_APP_ID_LENGTH
      && ['builtin', 'external', 'organization'].includes(item.kind)
      && typeof item.openedAt === 'number'
      && Number.isFinite(item.openedAt)
      && item.openedAt >= 0
    ))
    .sort((left, right) => right.openedAt - left.openedAt)
    .slice(0, MAX_RECENT_APPS)
}

function mergeRecentApps(
  primary: readonly HomeRecentAppPreference[],
  secondary: readonly HomeRecentAppPreference[],
): HomeRecentAppPreference[] {
  const merged = new Map<string, HomeRecentAppPreference>()
  for (const app of [...primary, ...secondary]) {
    const key = JSON.stringify([app.kind, app.id])
    const previous = merged.get(key)
    if (!previous || app.openedAt > previous.openedAt) {
      merged.set(key, app)
    }
  }
  return sanitizeRecentApps([...merged.values()])
}

function contextKeyForLegacyRecent(
  app: HomeRecentAppPreference,
  fallbackContextKey: string,
): string {
  if (app.kind !== 'organization') return fallbackContextKey
  try {
    const scope = JSON.parse(app.id)
    if (
      Array.isArray(scope)
      && scope.length === 4
      && scope[0] === 'catalog'
      && typeof scope[1] === 'string'
      && typeof scope[2] === 'string'
    ) {
      return createHomeRecentContextKey(JSON.stringify([scope[1], scope[2]]))
    }
  } catch {
    // Invalid legacy organization entries stay in the current context and are
    // later ignored when they cannot resolve against its Catalog.
  }
  return fallbackContextKey
}

export function createHomeRecentContextKey(
  organizationContextKey: string | null | undefined,
): string {
  return organizationContextKey
    ? `v2:${organizationContextKey}`
    : SIGNED_OUT_HOME_RECENT_CONTEXT_KEY
}

/**
 * Reads the config-backed history and performs the one-time renderer migration
 * from the pre-v2 localStorage key. The legacy value is removed only after the
 * merged preferences write succeeds.
 */
export async function loadHomeRecentApps(
  contextKey: string,
): Promise<HomeRecentAppPreference[]> {
  const persisted = sanitizeRecentApps(
    await window.electronAPI.getHomeRecentApps(contextKey),
  )
  const legacy = sanitizeRecentApps(
    getLocalStorage<unknown>(KEYS.homeRecentApps, []),
  )
  if (legacy.length === 0) return persisted

  const legacyByContext = new Map<string, HomeRecentAppPreference[]>()
  for (const app of legacy) {
    const targetContextKey = contextKeyForLegacyRecent(app, contextKey)
    legacyByContext.set(targetContextKey, [
      ...(legacyByContext.get(targetContextKey) ?? []),
      app,
    ])
  }
  let current = persisted
  for (const [targetContextKey, targetApps] of legacyByContext) {
    const existing = targetContextKey === contextKey
      ? persisted
      : sanitizeRecentApps(
          await window.electronAPI.getHomeRecentApps(targetContextKey),
        )
    const saved = sanitizeRecentApps(
      await window.electronAPI.setHomeRecentApps(
        targetContextKey,
        mergeRecentApps(targetApps, existing),
      ),
    )
    if (targetContextKey === contextKey) current = saved
  }
  removeLocalStorage(KEYS.homeRecentApps)
  return current
}

export async function saveHomeRecentApps(
  contextKey: string,
  apps: readonly HomeRecentAppPreference[],
): Promise<HomeRecentAppPreference[]> {
  return window.electronAPI.setHomeRecentApps(
    contextKey,
    sanitizeRecentApps(apps),
  )
}
