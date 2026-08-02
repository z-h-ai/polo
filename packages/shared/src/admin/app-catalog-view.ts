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
