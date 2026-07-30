import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIR } from '../config/paths.ts'
import {
  AppReleaseSummarySchema,
  AppCatalogResponseSchema,
  CatalogAppSchema,
} from './schemas.ts'
import type {
  AppCatalogCacheEntry,
  AppCatalogResponse,
  AppReleaseSummary,
  CatalogApp,
} from './types.ts'

const CACHE_SCHEMA_VERSION = 2
const MAX_CACHED_APPS = 10_000
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const CachedCatalogAppSchema = CatalogAppSchema.and(z.object({
  availability: z.enum(['available', 'withdrawn', 'unavailable']).optional(),
}))

const AppCatalogCacheEntryV1Schema = AppCatalogResponseSchema.extend({
  accountId: z.string().min(1).max(512),
  organizationId: z.string().min(1).max(512),
  authorizationStatus: z.enum(['authorized', 'denied']).default('authorized'),
  syncedAt: z.number().int().min(0),
  apps: z.array(CachedCatalogAppSchema).max(MAX_CACHED_APPS),
})

const AppCatalogCacheEntrySchema = AppCatalogCacheEntryV1Schema.extend({
  trustedReleases: z.record(z.string(), AppReleaseSummarySchema).default({}),
  warnings: z.array(z.object({
    code: z.literal('invalid_semver'),
    catalogAppId: z.string().min(1).max(512),
  })).max(MAX_CACHED_APPS).default([]),
})

const AppCatalogCacheFileSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  entries: z.record(z.string(), AppCatalogCacheEntrySchema),
})

const AppCatalogCacheFileV1Schema = z.object({
  schemaVersion: z.literal(1),
  entries: z.record(z.string(), AppCatalogCacheEntryV1Schema),
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

function isValidCatalogSemVer(version: string): boolean {
  return SEMVER_PATTERN.test(version.trim().replace(/^v(?=\d)/i, ''))
}

function trustedReleasesFromApps(
  apps: CatalogApp[],
): Record<string, AppReleaseSummary> {
  return Object.fromEntries(apps.flatMap(app => (
    app.deliveryMode === 'local_bundle'
    && app.currentRelease
    && isValidCatalogSemVer(app.currentRelease.version)
      ? [[app.id, app.currentRelease] as const]
      : []
  )))
}

function migrateCacheV1(raw: unknown): AppCatalogCacheFile | null {
  const parsed = AppCatalogCacheFileV1Schema.safeParse(raw)
  if (!parsed.success) return null
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: Object.fromEntries(Object.entries(parsed.data.entries).map(
      ([key, entry]) => [key, {
        ...entry,
        trustedReleases: trustedReleasesFromApps(entry.apps),
        warnings: entry.apps.flatMap(app => (
          app.deliveryMode === 'local_bundle'
          && app.currentRelease
          && !isValidCatalogSemVer(app.currentRelease.version)
            ? [{ code: 'invalid_semver' as const, catalogAppId: app.id }]
            : []
        )),
      }],
    )),
  }
}

function readCache(): AppCatalogCacheFile {
  const path = cachePath()
  if (!existsSync(path)) return emptyCache()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const parsed = AppCatalogCacheFileSchema.safeParse(raw)
    return parsed.success
      ? parsed.data
      : migrateCacheV1(raw) ?? emptyCache()
  } catch {
    return emptyCache()
  }
}

function writeCache(cache: AppCatalogCacheFile): void {
  const validated = AppCatalogCacheFileSchema.parse(cache)
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
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
  const withdrawnCapacity = Math.max(0, MAX_CACHED_APPS - catalog.apps.length)
  const withdrawn = (previous?.apps ?? [])
    .filter(app => !visibleIds.has(app.id))
    .map((app): CatalogApp => ({ ...app, availability: 'withdrawn' }))
    .slice(0, withdrawnCapacity)
  const apps = [
    ...catalog.apps.map((app): CatalogApp => ({
      ...app,
      availability: 'available',
    })),
    ...withdrawn,
  ]
  const retainedIds = new Set(apps
    .filter(app => app.deliveryMode === 'local_bundle')
    .map(app => app.id))
  const trustedReleases = Object.fromEntries(Object.entries({
    ...(previous?.trustedReleases ?? trustedReleasesFromApps(previous?.apps ?? [])),
    ...trustedReleasesFromApps(catalog.apps),
  }).filter(([appId]) => retainedIds.has(appId)))
  const entry: AppCatalogCacheEntry = {
    accountId,
    organizationId,
    authorizationStatus: 'authorized',
    appConfigVersion: catalog.appConfigVersion,
    syncedAt,
    apps,
    trustedReleases,
    warnings: catalog.apps.flatMap(app => (
      app.deliveryMode === 'local_bundle'
      && app.currentRelease
      && !isValidCatalogSemVer(app.currentRelease.version)
        ? [{ code: 'invalid_semver' as const, catalogAppId: app.id }]
        : []
    )),
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

export function denyCachedAppCatalogAuthorizationForAccount(
  accountId: string,
): AppCatalogCacheEntry[] {
  const cache = readCache()
  const denied: AppCatalogCacheEntry[] = []
  for (const [key, previous] of Object.entries(cache.entries)) {
    if (previous.accountId !== accountId) continue
    const entry: AppCatalogCacheEntry = {
      ...previous,
      authorizationStatus: 'denied',
      apps: previous.apps.map(app => ({
        ...app,
        availability: 'unavailable',
      })),
    }
    cache.entries[key] = entry
    denied.push(entry)
  }
  if (denied.length > 0) writeCache(cache)
  return denied
}

export function listCachedAppCatalogs(accountId: string): AppCatalogCacheEntry[] {
  return Object.values(readCache().entries)
    .filter(entry => entry.accountId === accountId)
}

export function getAppCatalogCachePath(): string {
  return cachePath()
}
