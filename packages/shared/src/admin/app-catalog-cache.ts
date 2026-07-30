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
import { isValidCatalogSemVer } from './semver.ts'
import { markAppCatalogAccessDenied } from './authorization-failure.ts'

const CACHE_SCHEMA_VERSION = 3
const MAX_CACHED_APPS = 10_000

const CachedCatalogAppSchema = CatalogAppSchema.and(z.object({
  availability: z.enum(['available', 'withdrawn', 'unavailable']).optional(),
}))

const AppCatalogCacheEntryV1Schema = AppCatalogResponseSchema.safeExtend({
  accountId: z.string().min(1).max(512),
  organizationId: z.string().min(1).max(512),
  authorizationStatus: z.enum(['authorized', 'denied']).default('authorized'),
  syncedAt: z.number().int().min(0),
  apps: z.array(CachedCatalogAppSchema).max(MAX_CACHED_APPS),
})

const AppCatalogCacheEntryV2Schema = AppCatalogCacheEntryV1Schema.safeExtend({
  trustedReleases: z.record(z.string(), AppReleaseSummarySchema).default({}),
  warnings: z.array(z.object({
    code: z.literal('invalid_semver'),
    catalogAppId: z.string().min(1).max(512),
  })).max(MAX_CACHED_APPS).default([]),
})

const AppCatalogCacheEntrySchema = AppCatalogCacheEntryV2Schema.safeExtend({
  withdrawnApps: z.array(CachedCatalogAppSchema).max(MAX_CACHED_APPS).default([]),
})

const AppCatalogCacheFileSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  entries: z.record(z.string(), AppCatalogCacheEntrySchema),
})

const AppCatalogCacheFileV2Schema = z.object({
  schemaVersion: z.literal(2),
  entries: z.record(z.string(), AppCatalogCacheEntryV2Schema),
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

function migrateLegacyCache(raw: unknown): AppCatalogCacheFile | null {
  const v2 = AppCatalogCacheFileV2Schema.safeParse(raw)
  if (v2.success) {
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      entries: Object.fromEntries(Object.entries(v2.data.entries).map(
        ([entryKey, entry]) => [entryKey, {
          ...entry,
          apps: entry.apps.filter(app => app.availability !== 'withdrawn'),
          withdrawnApps: entry.apps
            .filter(app => app.availability === 'withdrawn')
            .map(app => ({ ...app, availability: 'withdrawn' as const })),
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
  const v1 = AppCatalogCacheFileV1Schema.safeParse(raw)
  if (!v1.success) return null
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: Object.fromEntries(Object.entries(v1.data.entries).map(
      ([entryKey, entry]) => [entryKey, {
        ...entry,
        apps: entry.apps.filter(app => app.availability !== 'withdrawn'),
        withdrawnApps: entry.apps
          .filter(app => app.availability === 'withdrawn')
          .map(app => ({ ...app, availability: 'withdrawn' as const })),
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
      : migrateLegacyCache(raw) ?? emptyCache()
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

export { getAppCatalogApps } from './app-catalog-view.ts'

export function saveAppCatalog(
  accountId: string,
  organizationId: string,
  catalog: AppCatalogResponse,
  syncedAt = Date.now(),
  retainedWithdrawnAppIds: ReadonlySet<string> = new Set(),
): AppCatalogCacheEntry {
  const cache = readCache()
  const previous = cache.entries[cacheKey(accountId, organizationId)]
  const visibleIds = new Set(catalog.apps.map(app => app.id))
  const withdrawnById = new Map<string, CatalogApp>()
  for (const app of [
    ...(previous?.apps ?? []).filter(app => !visibleIds.has(app.id)),
    ...(previous?.withdrawnApps ?? []).filter(app => !visibleIds.has(app.id)),
  ]) {
    if (!withdrawnById.has(app.id)) {
      withdrawnById.set(app.id, { ...app, availability: 'withdrawn' })
    }
  }
  const apps = catalog.apps.map((app): CatalogApp => ({
    ...app,
    availability: 'available',
  }))
  const withdrawnCandidates = [...withdrawnById.values()]
  const retainedWithdrawnApps = withdrawnCandidates.filter(app =>
    retainedWithdrawnAppIds.has(app.id))
  if (retainedWithdrawnApps.length > MAX_CACHED_APPS) {
    throw new Error(
      `Cannot retain ${retainedWithdrawnApps.length} installed withdrawn apps`,
    )
  }
  const retainedIds = new Set(retainedWithdrawnApps.map(app => app.id))
  const withdrawnApps = [
    ...retainedWithdrawnApps,
    ...withdrawnCandidates.filter(app => !retainedIds.has(app.id)),
  ].slice(0, MAX_CACHED_APPS)
  const retainedCatalogIds = new Set([...apps, ...withdrawnApps]
    .filter(app => app.deliveryMode === 'local_bundle')
    .map(app => app.id))
  const trustedReleases = Object.fromEntries(Object.entries({
    ...(previous?.trustedReleases ?? trustedReleasesFromApps(previous?.apps ?? [])),
    ...trustedReleasesFromApps(catalog.apps),
  }).filter(([appId]) => retainedCatalogIds.has(appId)))
  const entry: AppCatalogCacheEntry = {
    accountId,
    organizationId,
    authorizationStatus: 'authorized',
    appConfigVersion: catalog.appConfigVersion,
    syncedAt,
    apps,
    withdrawnApps,
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
  const entry = markAppCatalogAccessDenied(previous)
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
    const entry = markAppCatalogAccessDenied(previous)
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
