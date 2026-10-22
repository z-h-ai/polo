import {
  type HomeQuickAccessApp,
  MAX_HOME_QUICK_ACCESS_APPS,
  sanitizeHomeQuickAccess,
} from '@polo-ai/shared/config/home-quick-access'
import type { CatalogApp } from '@polo-ai/shared/admin'

export const SIGNED_OUT_HOME_QUICK_ACCESS_CONTEXT_KEY =
  'v1:["signed-out"]'

/**
 * Quick access is scoped to the exact ProductSpace context (account+space),
 * so personal and enterprise home configurations never share state.
 */
export function createHomeQuickAccessContextKey(
  productSpaceContextKey: string | null | undefined,
): string {
  return productSpaceContextKey
    ? `v1:${productSpaceContextKey}`
    : SIGNED_OUT_HOME_QUICK_ACCESS_CONTEXT_KEY
}

export async function loadHomeQuickAccess(
  contextKey: string,
): Promise<HomeQuickAccessApp[]> {
  return sanitizeHomeQuickAccess(
    await window.electronAPI.getHomeQuickAccess(contextKey),
  )
}

export async function saveHomeQuickAccess(
  contextKey: string,
  apps: readonly HomeQuickAccessApp[],
): Promise<HomeQuickAccessApp[]> {
  return window.electronAPI.setHomeQuickAccess(
    contextKey,
    sanitizeHomeQuickAccess(apps),
  )
}

/**
 * Pure reducer for toggling one Catalog App in the quick-access slots.
 * Adding beyond the cap is rejected (fail closed) instead of silently
 * evicting another entry. Order is explicit: additions append.
 */
export function toggleHomeQuickAccessApp(
  current: readonly HomeQuickAccessApp[],
  scopeKey: string,
  enabled: boolean,
  now = Date.now(),
): { next: HomeQuickAccessApp[]; rejected: boolean } {
  const withoutTarget = current.filter(entry => entry.id !== scopeKey)
  if (!enabled) {
    return { next: withoutTarget, rejected: false }
  }
  if (withoutTarget.length >= MAX_HOME_QUICK_ACCESS_APPS) {
    return { next: [...current], rejected: true }
  }
  return {
    next: [...withoutTarget, { id: scopeKey, addedAt: now }],
    rejected: false,
  }
}

/**
 * Fail-closed projection: a persisted quick-access id only becomes a home
 * entry when it resolves to a currently `available` Catalog App of the
 * ACTIVE ProductSpace. Everything else (legacy ids, other spaces, withdrawn
 * Apps) is dropped; callers persist the pruned list back.
 */
export function resolveHomeQuickAccessApps(
  persisted: readonly HomeQuickAccessApp[],
  catalogApps: readonly CatalogApp[],
  scopeKeyForApp: (app: CatalogApp) => string,
): CatalogApp[] {
  const byScopeKey = new Map<string, CatalogApp>()
  for (const app of catalogApps) {
    if (app.availability !== 'available') continue
    try {
      byScopeKey.set(scopeKeyForApp(app), app)
    } catch {
      continue
    }
  }
  const resolved: CatalogApp[] = []
  const seen = new Set<string>()
  for (const entry of persisted) {
    if (seen.has(entry.id)) continue
    const app = byScopeKey.get(entry.id)
    if (!app) continue
    seen.add(entry.id)
    resolved.push(app)
  }
  return resolved
}
