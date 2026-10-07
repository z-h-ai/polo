/**
 * POO-70 H3 (P70-HOME-01) — the LOCAL hidden-apps surface behind the home
 * directory's "本机隐藏恢复" contract (Spec §13.13: 保留最近使用和本机隐藏恢复).
 *
 * - Hiding is a LOCAL, per-context display preference (account+space keyed,
 *   same convention as the usage records): it never mutates authorization,
 *   never uninstalls, and never leaves the space's circle memberships. A
 *   hidden work simply stops occupying the home directory grid until the
 *   member restores it from the in-page "hidden apps" section.
 * - Persistence follows the SAME fail-closed pattern as the usage records:
 *   renderer localStorage, best-effort writes, bounded set, and a corrupted
 *   or unavailable store degrades to an EMPTY hidden set (everything shows —
 *   fail-open for visibility, fail-closed for never losing a row).
 * - Identity is the stable H1 identity tuple key (never the display name),
 *   so a hidden entry survives version changes and re-issues of the SAME
 *   work, and never hides a DIFFERENT work that shares its name.
 */

const HOME_HIDDEN_APPS_STORAGE_PREFIX = 'poo70.h3:home-hidden-apps:'
const HOME_HIDDEN_APPS_MAX_ENTRIES = 500
const homeHiddenAppsByContext = new Map<string, Set<string>>()

export function loadHomeHiddenApps(contextKey: string): Set<string> {
  const cached = homeHiddenAppsByContext.get(contextKey)
  if (cached) return cached
  const hidden = new Set<string>()
  try {
    const raw = window.localStorage.getItem(HOME_HIDDEN_APPS_STORAGE_PREFIX + contextKey)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item) hidden.add(item)
        }
      }
    }
  } catch {
    // Fail closed to an empty hidden set: a corrupted store never hides a row.
  }
  homeHiddenAppsByContext.set(contextKey, hidden)
  return hidden
}

function persistHomeHiddenApps(contextKey: string, hidden: Set<string>): void {
  try {
    // Bound the set: evict insertion-order first (FIFO) — a bounded local
    // preference list, nothing durable is lost beyond the cap.
    while (hidden.size > HOME_HIDDEN_APPS_MAX_ENTRIES) {
      const first = hidden.values().next().value
      if (first === undefined) break
      hidden.delete(first)
    }
    window.localStorage.setItem(
      HOME_HIDDEN_APPS_STORAGE_PREFIX + contextKey,
      JSON.stringify([...hidden]),
    )
  } catch {
    // Persistence is best-effort: the in-memory set keeps the session state.
  }
}

/** Hides one work from the home directory of the given ProductSpace context. */
export function hideHomeApp(contextKey: string, identityKey: string): void {
  if (!contextKey || !identityKey) return
  const hidden = loadHomeHiddenApps(contextKey)
  if (hidden.has(identityKey)) return
  hidden.add(identityKey)
  persistHomeHiddenApps(contextKey, hidden)
}

/** Restores one hidden work back into the home directory. */
export function restoreHomeApp(contextKey: string, identityKey: string): void {
  if (!contextKey || !identityKey) return
  const hidden = loadHomeHiddenApps(contextKey)
  if (!hidden.delete(identityKey)) return
  persistHomeHiddenApps(contextKey, hidden)
}

/** Test-only: drop every per-context hidden set. */
export function __resetHomeHiddenAppsForTests(): void {
  homeHiddenAppsByContext.clear()
}
