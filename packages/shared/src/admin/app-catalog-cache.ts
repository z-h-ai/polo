import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  AppCatalogResponseSchema,
  CatalogAppSchema,
} from './schemas.ts'
import type {
  AppCatalogCacheEntry,
  AppCatalogResponse,
  CatalogApp,
} from './types.ts'

const CACHE_SCHEMA_VERSION = 1

const AppCatalogCacheEntrySchema = AppCatalogResponseSchema.extend({
  accountId: z.string().min(1).max(512),
  organizationId: z.string().min(1).max(512),
  authorizationStatus: z.enum(['authorized', 'denied']).default('authorized'),
  syncedAt: z.number().int().min(0),
  apps: z.array(CatalogAppSchema.and(z.object({
    availability: z.enum(['available', 'withdrawn', 'unavailable']).optional(),
  }))).max(10_000),
})

const AppCatalogCacheFileSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  entries: z.record(z.string(), AppCatalogCacheEntrySchema),
})

interface AppCatalogCacheFile {
  schemaVersion: typeof CACHE_SCHEMA_VERSION
  entries: Record<string, AppCatalogCacheEntry>
}

function cachePath(): string {
  const configDir = process.env.POLO_AI_CONFIG_DIR || CONFIG_DIR
  return join(configDir, 'admin-app-catalog.json')
}

function cacheKey(accountId: string, organizationId: string): string {
  return `${encodeURIComponent(accountId)}:${encodeURIComponent(organizationId)}`
}

function emptyCache(): AppCatalogCacheFile {
  return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} }
}

function readCache(): AppCatalogCacheFile {
  const path = cachePath()
  if (!existsSync(path)) return emptyCache()
  try {
    const parsed = AppCatalogCacheFileSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    )
    return parsed.success ? parsed.data : emptyCache()
  } catch {
    return emptyCache()
  }
}

function writeCache(cache: AppCatalogCacheFile): void {
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  renameSync(tempPath, path)
}

export function getCachedAppCatalog(
  accountId: string,
  organizationId: string,
): AppCatalogCacheEntry | null {
  return readCache().entries[cacheKey(accountId, organizationId)] ?? null
}

export function saveAppCatalog(
  accountId: string,
  organizationId: string,
  catalog: AppCatalogResponse,
  syncedAt = Date.now(),
): AppCatalogCacheEntry {
  const cache = readCache()
  const previous = cache.entries[cacheKey(accountId, organizationId)]
  const visibleIds = new Set(catalog.apps.map(app => app.id))
  const withdrawn = (previous?.apps ?? [])
    .filter(app => !visibleIds.has(app.id))
    .map((app): CatalogApp => ({ ...app, availability: 'withdrawn' }))
  const entry: AppCatalogCacheEntry = {
    accountId,
    organizationId,
    authorizationStatus: 'authorized',
    appConfigVersion: catalog.appConfigVersion,
    syncedAt,
    apps: [
      ...catalog.apps.map((app): CatalogApp => ({
        ...app,
        availability: 'available',
      })),
      ...withdrawn,
    ],
  }
  cache.entries[cacheKey(accountId, organizationId)] = entry
  writeCache(cache)
  return entry
}

export function denyCachedAppCatalogAuthorization(
  accountId: string,
  organizationId: string,
): AppCatalogCacheEntry | null {
  const cache = readCache()
  const key = cacheKey(accountId, organizationId)
  const previous = cache.entries[key]
  if (!previous) return null
  const entry: AppCatalogCacheEntry = {
    ...previous,
    authorizationStatus: 'denied',
    apps: previous.apps.map(app => ({
      ...app,
      availability: 'unavailable',
    })),
  }
  cache.entries[key] = entry
  writeCache(cache)
  return entry
}

export function listCachedAppCatalogs(accountId: string): AppCatalogCacheEntry[] {
  return Object.values(readCache().entries)
    .filter(entry => entry.accountId === accountId)
}

export function getAppCatalogCachePath(): string {
  return cachePath()
}
