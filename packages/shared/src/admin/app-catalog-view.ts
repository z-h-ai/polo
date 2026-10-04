import type { AppCatalogCacheEntry, CatalogApp } from './types.ts'

/**
 * Returns both currently visible catalog apps and retained withdrawn metadata.
 *
 * This module intentionally has no Node dependencies so renderer code can use
 * the cache projection without pulling the filesystem-backed cache into Vite.
 */
export function getAppCatalogApps(
  catalog: Pick<AppCatalogCacheEntry, 'apps' | 'withdrawnApps'>,
): CatalogApp[] {
  return [...catalog.apps, ...(catalog.withdrawnApps ?? [])]
}

/**
 * Collision-free STABLE Catalog identity for full-directory projections
 * (POO-70 H1): account + productSpace + catalogEntry + artifact instance.
 *
 * Deliberately NEVER the display name or the version id: two works may share
 * a name (they must stay separate rows), and one work keeps its identity
 * across a version change. Opaque IDs may contain any delimiter, so the key
 * is a JSON tuple, not delimiter concatenation. A live entry and a withdrawn
 * tombstone that share the tuple are the SAME row (the tombstone is the same
 * work); the same artifact reissued under a DIFFERENT catalogEntryId stays a
 * DIFFERENT row.
 */
export function getCatalogAppIdentityKey(
  catalog: Pick<AppCatalogCacheEntry, 'accountId' | 'organizationId'>,
  app: Pick<CatalogApp, 'catalogEntryId' | 'id' | 'artifactInstanceId'>,
): string {
  return JSON.stringify([
    'catalog-app-identity',
    catalog.accountId,
    catalog.organizationId,
    app.catalogEntryId ?? app.id,
    app.artifactInstanceId ?? null,
  ])
}

/**
 * Full-directory dedup over the STABLE Catalog identity: one row per work.
 * Catalog entries are already unique per identity within a space, but the
 * retained withdrawn tombstones can duplicate a live row after a version
 * upgrade (same tuple) — the live entry wins that collision and rows keep
 * first-seen Catalog order otherwise. Returns the deduped rows plus the
 * number of collapsed duplicates so projections can account for every input.
 */
export function dedupeCatalogAppsByIdentity(
  catalog: Pick<
    AppCatalogCacheEntry,
    'accountId' | 'organizationId' | 'apps' | 'withdrawnApps'
  >,
): { apps: CatalogApp[]; duplicatesDropped: number } {
  const merged = new Map<string, CatalogApp>()
  let duplicatesDropped = 0
  for (const app of getAppCatalogApps(catalog)) {
    const key = getCatalogAppIdentityKey(catalog, app)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, app)
      continue
    }
    duplicatesDropped += 1
    // A withdrawn tombstone never replaces its live row; among tombstones the
    // first seen (Catalog order) is retained.
    if (existing.availability === 'withdrawn' && app.availability !== 'withdrawn') {
      merged.set(key, app)
    }
  }
  return { apps: [...merged.values()], duplicatesDropped }
}
