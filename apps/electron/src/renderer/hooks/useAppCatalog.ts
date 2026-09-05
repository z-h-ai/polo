import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { i18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  DeniedAppCatalogSnapshot,
} from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import {
  classifyAdminAuthorizationFailure,
  markAppCatalogAccessDenied,
} from '@polo-ai/shared/admin/authorization'
import {
  compareCatalogSemVer,
  normalizeCatalogSemVer,
} from '@polo-ai/shared/admin/semver'
import { getAppCatalogApps } from '@polo-ai/shared/admin/catalog-view'
import {
  createLocalAppScopeKey,
  normalizeLocalAppPermissions,
  type CatalogLocalAppScope,
  type LocalAppRuntimeStatus,
  type LocalAppStartResult,
  type ProductSpaceAppIdentity,
  type ProductSpaceAppInstallState,
} from '@polo-ai/shared/protocol'
import { createLocalAppScopeKey as createIdentityScopeKey } from '@polo-ai/shared/protocol'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import {
  isProductSpaceContractUnsupported,
  reportProductSpaceContractFailure,
} from '@/lib/product-space-contract-failure'
import {
  emitAdminCatalogSessionAuthFailure,
} from '@/lib/admin-auth-failure'
import { getHomeAppErrorCode } from '@/lib/home-app-errors'

export interface AppCatalogState {
  catalog: AppCatalogCacheEntry | null
  loading: boolean
  refreshing: boolean
  warningCode: string | null
  errorCode: string | null
  statusErrorCode: 'status_read_failed' | null
  statusErrorScopeKeys: Record<string, true>
  statusLoadingScopeKeys: Record<string, true>
  accessMode: 'online' | 'offline' | 'denied' | null
  statuses: Record<string, LocalAppRuntimeStatus>
  /** Installation-only projection. Runtime lifecycle remains owned by POO-47. */
  installStates: Record<string, ProductSpaceAppInstallState>
  /**
   * CreatorCircle relations visible in the active space's Catalog, derived
   * from the entries' creator_circle sources (REQ-022: the "我的圈子"
   * relation entry). Empty for enterprise spaces and when nothing was
   * derived yet.
   */
  creatorCircles: CreatorCircleRelation[]
  host: {
    platform: 'darwin' | 'win32' | 'linux'
    arch: 'arm64' | 'x64'
  } | null
}

export interface CreatorCircleRelation {
  circleId: string
  name: string
}

/**
 * Distinct creator_circle sources across the space's Catalog entries — the
 * account's visible CreatorCircle relations (REQ-022). Deduplicated by
 * circleId; entries without such sources contribute nothing.
 */
export function selectCreatorCircleRelations(
  entries: ReadonlyArray<Record<string, unknown>>,
): CreatorCircleRelation[] {
  const byCircleId = new Map<string, CreatorCircleRelation>()
  for (const rawEntry of entries) {
    const sources = rawEntry.sources
    if (!Array.isArray(sources)) continue
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue
      const candidate = source as { kind?: unknown; circleId?: unknown; name?: unknown }
      if (candidate.kind !== 'creator_circle') continue
      const circleId = typeof candidate.circleId === 'string' && candidate.circleId
        ? candidate.circleId
        : (typeof candidate.name === 'string' ? candidate.name : '')
      if (!circleId) continue
      if (!byCircleId.has(circleId)) {
        byCircleId.set(circleId, {
          circleId,
          name: typeof candidate.name === 'string' && candidate.name ? candidate.name : circleId,
        })
      }
    }
  }
  return [...byCircleId.values()]
}

export const CATALOG_RUNTIME_STATUS_LIMIT = 10_000
export const BUSY_RUNTIME_STATUS_LIMIT = 32
export const CATALOG_SYNC_SUPERSEDED_RETRY_LIMIT = 2
export const BUSY_RUNTIME_STATUS_POLL_INTERVAL_MS = 500

export interface BusyStatusPollRequest {
  requestGeneration: number
  isCurrent(): boolean
}

interface BusyStatusPollTimers {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clear(timer: ReturnType<typeof setTimeout>): void
}

export interface BusyStatusPoller {
  replace(task: ((request: BusyStatusPollRequest) => Promise<void>) | null): void
  stop(): void
}

/**
 * Runs a replaceable status poll with one shared in-flight slot.
 *
 * A busy-set change invalidates the old loop immediately, but the replacement
 * still waits for the old request to settle. The request generation is a
 * second commit fence, so an invalidated response cannot publish stale state.
 */
export function createBusyStatusPoller(
  intervalMs = BUSY_RUNTIME_STATUS_POLL_INTERVAL_MS,
  timers: BusyStatusPollTimers = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: timer => clearTimeout(timer),
  },
): BusyStatusPoller {
  let stopped = false
  let loopGeneration = 0
  let requestGeneration = 0
  let task: ((request: BusyStatusPollRequest) => Promise<void>) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const clearTimer = () => {
    if (timer === null) return
    timers.clear(timer)
    timer = null
  }

  const schedule = (generation: number) => {
    clearTimer()
    if (stopped || generation !== loopGeneration || !task) return
    timer = timers.set(() => {
      timer = null
      void run(generation)
    }, intervalMs)
  }

  const run = async (generation: number) => {
    const previous = inFlight
    if (previous) {
      try {
        await previous
      } catch {
        // Poll failures are represented in hook state; they must not break the loop.
      }
    }
    if (stopped || generation !== loopGeneration || !task) return

    const currentTask = task
    const currentRequestGeneration = ++requestGeneration
    const isCurrent = () => (
      !stopped
      && generation === loopGeneration
      && currentRequestGeneration === requestGeneration
      && task === currentTask
    )
    const active = Promise.resolve().then(() => currentTask({
      requestGeneration: currentRequestGeneration,
      isCurrent,
    }))
    inFlight = active
    try {
      await active
    } catch {
      // The next single-flight cycle retries busy status reads.
    } finally {
      if (inFlight === active) inFlight = null
      if (isCurrent()) schedule(generation)
    }
  }

  return {
    replace(nextTask) {
      if (stopped) return
      loopGeneration += 1
      task = nextTask
      clearTimer()
      if (task) schedule(loopGeneration)
    },
    stop() {
      if (stopped) return
      stopped = true
      loopGeneration += 1
      task = null
      clearTimer()
    },
  }
}

function isCatalogAccessDenied(
  errorCode: string | null | undefined,
  status?: number,
): boolean {
  return classifyAdminAuthorizationFailure(
    { errorCode: errorCode ?? undefined, status },
    { catalogScoped: true },
  ) === 'catalog_scope'
}

export function markCatalogAccessDenied(
  catalog: AppCatalogCacheEntry,
): DeniedAppCatalogSnapshot {
  return markAppCatalogAccessDenied(catalog)
}

export type CatalogVersionComparison =
  | { strategy: 'semver'; order: -1 | 0 | 1 }
  | { strategy: 'invalid'; order: null; reason: 'invalid_semver' }

export { normalizeCatalogSemVer }

export function compareCatalogVersions(
  available: string,
  installed: string,
): CatalogVersionComparison {
  const left = normalizeCatalogSemVer(available)
  const right = normalizeCatalogSemVer(installed)
  if (!left || !right) {
    return { strategy: 'invalid', order: null, reason: 'invalid_semver' }
  }
  return {
    strategy: 'semver',
    order: compareCatalogSemVer(left, right)!,
  }
}

export function isNewerCatalogVersion(available: string, installed: string): boolean {
  return compareCatalogVersions(available, installed).order === 1
}

export function selectRuntimeStatusApps(
  apps: CatalogApp[],
  busyScopeKeys?: ReadonlySet<string>,
  scopeKeyForApp: (app: CatalogApp) => string = app => app.id,
): CatalogApp[] {
  const selected = apps
    .filter(app => (
      app.deliveryMode === 'local_bundle'
      && (!busyScopeKeys || busyScopeKeys.has(scopeKeyForApp(app)))
    ))
  return busyScopeKeys
    ? selected.slice(0, BUSY_RUNTIME_STATUS_LIMIT)
    : selected
}

function scopeForCatalogApp(
  catalog: AppCatalogCacheEntry,
  app: CatalogApp,
): CatalogLocalAppScope {
  if (app.organizationId !== catalog.organizationId) {
    throw new Error(i18n.t('homeApps.errors.staleContext'))
  }
  return {
    kind: 'catalog',
    accountId: catalog.accountId,
    organizationId: catalog.organizationId,
    catalogAppId: app.id,
  }
}

function identityForProductSpaceApp(
  catalog: AppCatalogCacheEntry,
  app: CatalogApp,
): ProductSpaceAppIdentity {
  if (
    app.organizationId !== catalog.organizationId
    || !app.catalogEntryId
    || !app.artifactInstanceId
    || !app.catalogVersion
  ) throw new Error(i18n.t('homeApps.errors.staleContext'))
  return {
    accountId: catalog.accountId,
    productSpaceId: catalog.organizationId,
    catalogEntryId: app.catalogEntryId,
    artifactInstanceId: app.artifactInstanceId,
    versionId: app.catalogVersion.versionId,
    version: app.catalogVersion.version,
  }
}

interface ContextSnapshot {
  contextKey: string
  contextGeneration: number
  catalog: AppCatalogCacheEntry
  syncGeneration?: number
}

/**
 * Projects a validated ProductSpace Catalog into the home App grid view
 * model. Delivery data is deliberately absent: launching requires a fresh
 * resolve-launch grant, so the projection never carries runnable URLs.
 */
function mapProductSpaceCatalogToCacheEntry(
  productSpaceId: string,
  accountId: string,
  catalogResult: {
    catalogRevision?: string
    entries: ReadonlyArray<Record<string, unknown>>
    withdrawnEntries?: ReadonlyArray<Record<string, unknown>>
  },
): AppCatalogCacheEntry {
  const apps: CatalogApp[] = []
  const withdrawnApps: CatalogApp[] = []
  const mapEntry = (
    rawEntry: Record<string, unknown>,
    index: number,
    availability: 'available' | 'withdrawn' | 'unavailable',
  ): CatalogApp | null => {
    const entry = rawEntry as {
      kind?: string
      catalogEntryId?: string
      artifactInstanceId?: string
      version?: {
        versionId: string
        version: string
        checksum?: string
      }
      name?: string
      description?: string
      iconUrl?: string
      availability?: string
      sources?: ReadonlyArray<{ kind: string; name?: string }>
      unavailableReason?: string
      permissions?: string[]
    }
    if (entry.kind !== 'app' || !entry.catalogEntryId || !entry.name) return null
    const effectiveAvailability = entry.availability === 'available'
      ? 'available'
      : availability === 'withdrawn'
      ? 'withdrawn'
      : 'unavailable'
    const sourceNames = [...new Set(
      (entry.sources ?? [])
        .map(source => source.name?.trim())
        .filter((name): name is string => Boolean(name)),
    )]
    return {
      id: entry.catalogEntryId,
      catalogEntryId: entry.catalogEntryId,
      artifactInstanceId: entry.artifactInstanceId,
      catalogVersion: entry.version,
      sourceNames,
      unavailableReason: entry.unavailableReason,
      organizationId: productSpaceId,
      name: entry.name,
      description: entry.description ?? '',
      iconUrl: entry.iconUrl,
      creatorName: sourceNames.join(' · ') || undefined,
      // ProductSpace delivery is intentionally unknown until resolve-launch.
      // It must never be inferred from fixture-only Catalog fields.
      deliveryMode: 'resolve_launch',
      permissions: entry.permissions,
      sortOrder: index,
      availability: effectiveAvailability,
    }
  }
  for (const [index, rawEntry] of catalogResult.entries.entries()) {
    const app = mapEntry(rawEntry, index, 'available')
    if (app) apps.push(app)
  }
  for (const [index, rawEntry] of (catalogResult.withdrawnEntries ?? []).entries()) {
    const app = mapEntry(rawEntry, apps.length + index, 'withdrawn')
    if (app) withdrawnApps.push(app)
  }
  return {
    accountId,
    organizationId: productSpaceId,
    appConfigVersion: catalogResult.catalogRevision ?? '',
    authorizationStatus: 'authorized',
    syncedAt: Date.now(),
    apps,
    trustedReleases: {},
    warnings: [],
    withdrawnApps,
  }
}

export function useAppCatalog() {
  const productSpace = useOptionalProductSpaceContext()
  const catalogContextKey = productSpace?.productSpaceContextKey ?? null
  const [state, setState] = useState<AppCatalogState>({
    catalog: null,
    loading: Boolean(productSpace),
    refreshing: false,
    warningCode: null,
    errorCode: null,
    statusErrorCode: null,
    statusErrorScopeKeys: {},
    statusLoadingScopeKeys: {},
    accessMode: null,
    statuses: {},
    installStates: {},
    creatorCircles: [],
    host: null,
  })
  const catalogRef = useRef<AppCatalogCacheEntry | null>(null)
  const contextKeyRef = useRef<string | null>(catalogContextKey)
  contextKeyRef.current = catalogContextKey
  const knownCatalogRevisionRef = useRef<string | null>(null)
  // Context generation invalidates lifecycle results only when account/org
  // authorization changes. Sync generation is intentionally separate so an
  // ordinary same-context Catalog refresh cannot discard a successful start.
  const contextGenerationRef = useRef(0)
  const syncGenerationRef = useRef(0)
  const operationsRef = useRef(new Map<string, Promise<unknown>>())
  const cancellationOperationsRef = useRef(new Map<string, Promise<void>>())
  const lifecycleActionGenerationRef = useRef(new Map<string, number>())
  const statusReadGenerationRef = useRef(new Map<string, number>())
  const busyStatusPollerRef = useRef<BusyStatusPoller | null>(null)

  const isCurrentSnapshot = useCallback((snapshot: ContextSnapshot): boolean => (
    contextKeyRef.current === snapshot.contextKey
    && contextGenerationRef.current === snapshot.contextGeneration
    && (
      snapshot.syncGeneration === undefined
      || syncGenerationRef.current === snapshot.syncGeneration
    )
    && catalogRef.current?.accountId === snapshot.catalog.accountId
    && catalogRef.current?.organizationId === snapshot.catalog.organizationId
  ), [])

  const currentSnapshotForApp = useCallback((app: CatalogApp): ContextSnapshot => {
    const catalog = catalogRef.current
    if (
      !catalogContextKey
      || !catalog
      || catalog.accountId !== productSpace?.accountId
      || app.organizationId !== catalog.organizationId
    ) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return {
      contextKey: catalogContextKey,
      contextGeneration: contextGenerationRef.current,
      catalog,
    }
  }, [productSpace?.accountId, catalogContextKey])

  const scopeForApp = useCallback((app: CatalogApp): CatalogLocalAppScope => (
    scopeForCatalogApp(currentSnapshotForApp(app).catalog, app)
  ), [currentSnapshotForApp])

  const scopeKeyForApp = useCallback((app: CatalogApp): string => (
    createLocalAppScopeKey(scopeForApp(app))
  ), [scopeForApp])

  const refreshProductSpaceInstallStates = useCallback(async (
    apps: CatalogApp[],
    suppliedSnapshot?: ContextSnapshot,
  ) => {
    const catalog = suppliedSnapshot?.catalog ?? catalogRef.current
    const contextKey = suppliedSnapshot?.contextKey ?? contextKeyRef.current
    if (!catalog || !contextKey) return
    const snapshot = suppliedSnapshot ?? {
      contextKey,
      contextGeneration: contextGenerationRef.current,
      catalog,
    }
    if (!isCurrentSnapshot(snapshot)) return
    try {
      // Installation state is secondary to Catalog visibility. A malformed
      // or stale identity fails this cache read closed without turning a
      // successfully loaded Catalog into a page-level failure.
      const activeIdentities: ProductSpaceAppIdentity[] = []
      const withdrawnIdentities: ProductSpaceAppIdentity[] = []
      for (const app of apps) {
        if (app.availability === 'withdrawn') {
          // A withdrawn tombstone is no longer in the fresh Catalog, so the
          // authoritative-tuple channel would fail the whole batch closed.
          // Its retained local installation is read through the restricted
          // withdrawn-management identity (artifact instance scope) instead;
          // an identity that cannot be built is skipped, never fatal.
          try {
            withdrawnIdentities.push(identityForProductSpaceApp(catalog, app))
          } catch {
            continue
          }
          continue
        }
        activeIdentities.push(identityForProductSpaceApp(catalog, app))
      }
      if (activeIdentities.length === 0 && withdrawnIdentities.length === 0) {
        setState(current => ({ ...current, installStates: {} }))
        return
      }
      const [activeStates, withdrawnStates] = await Promise.all([
        activeIdentities.length > 0
          ? window.electronAPI.localApps.getProductSpaceInstallStates(activeIdentities)
          : Promise.resolve([]),
        withdrawnIdentities.length > 0
          ? window.electronAPI.localApps.getProductSpaceWithdrawnInstallStates(withdrawnIdentities)
          : Promise.resolve([]),
      ])
      if (!isCurrentSnapshot(snapshot)) return
      const states = [...activeStates, ...withdrawnStates]
      // Keyed by the authority's collision-free stable identity (scope key
      // over accountId + productSpaceId + artifactInstanceId) — NEVER by
      // catalogEntryId alone, so a live entry and a withdrawn tombstone that
      // happen to share a catalogEntryId can never overwrite each other.
      const identityScopeKey = (identity: ProductSpaceAppIdentity): string => (
        createIdentityScopeKey({
          kind: 'catalog',
          accountId: identity.accountId,
          organizationId: identity.productSpaceId,
          catalogAppId: identity.artifactInstanceId,
        })
      )
      const requested = new Map<string, ProductSpaceAppIdentity>()
      for (const identity of withdrawnIdentities) {
        requested.set(identityScopeKey(identity), identity)
      }
      // A live entry always wins its identity key over a withdrawn one.
      for (const identity of activeIdentities) {
        requested.set(identityScopeKey(identity), identity)
      }
      const next: Record<string, ProductSpaceAppInstallState> = {}
      for (const installState of states) {
        const expected = requested.get(identityScopeKey(installState.app))
        if (!expected || JSON.stringify(expected) !== JSON.stringify(installState.app)) {
          throw new Error(i18n.t('homeApps.errors.staleContext'))
        }
        next[identityScopeKey(installState.app)] = installState
      }
      if (Object.keys(next).length !== requested.size) {
        throw new Error(i18n.t('homeApps.errors.staleContext'))
      }
      setState(current => isCurrentSnapshot(snapshot)
        ? { ...current, installStates: next }
        : current)
    } catch {
      if (isCurrentSnapshot(snapshot)) {
        setState(current => ({ ...current, installStates: {} }))
      }
    }
  }, [isCurrentSnapshot])

  const refreshRuntimeStatuses = useCallback(async (
    apps?: CatalogApp[],
    busyScopeKeys?: ReadonlySet<string>,
    suppliedSnapshot?: ContextSnapshot,
    refreshMode: 'replace' | 'merge' = (
      apps === undefined && busyScopeKeys === undefined ? 'replace' : 'merge'
    ),
    commitGuard?: () => boolean,
  ) => {
    const catalog = suppliedSnapshot?.catalog ?? catalogRef.current
    const contextKey = suppliedSnapshot?.contextKey ?? contextKeyRef.current
    if (!catalog || !contextKey) {
      if (refreshMode === 'replace') {
        setState(current => ({
          ...current,
          statuses: {},
          statusErrorCode: null,
          statusErrorScopeKeys: {},
          statusLoadingScopeKeys: {},
        }))
      }
      return
    }
    const snapshot: ContextSnapshot = suppliedSnapshot ?? {
      contextKey,
      contextGeneration: contextGenerationRef.current,
      catalog,
    }
    if (!isCurrentSnapshot(snapshot) || (commitGuard && !commitGuard())) return

    const selectedApps = selectRuntimeStatusApps(
      apps ?? getAppCatalogApps(catalog),
      busyScopeKeys,
      app => createLocalAppScopeKey(scopeForCatalogApp(catalog, app)),
    )
    if (selectedApps.length === 0) {
      if (
        refreshMode === 'replace'
        && isCurrentSnapshot(snapshot)
        && (!commitGuard || commitGuard())
      ) {
        setState(current => ({
          ...current,
          statuses: {},
          statusErrorCode: null,
          statusErrorScopeKeys: {},
          statusLoadingScopeKeys: {},
        }))
      }
      return
    }

    const scopes = selectedApps.map(app => scopeForCatalogApp(catalog, app))
    const requestedScopeKeys = new Set(scopes.map(createLocalAppScopeKey))
    // Every source of runtime status (full sync, lifecycle finally, and busy
    // polling) shares this per-scope generation. A newer read permanently
    // fences an older snapshot even when their batches or sources differ.
    const statusReadGenerations = new Map<string, number>()
    for (const scopeKey of requestedScopeKeys) {
      const next = (statusReadGenerationRef.current.get(scopeKey) ?? 0) + 1
      statusReadGenerationRef.current.set(scopeKey, next)
      statusReadGenerations.set(scopeKey, next)
    }
    const successfulStatuses = new Map<string, LocalAppRuntimeStatus>()
    const failedScopeKeys = new Set<string>()
    for (let offset = 0; offset < scopes.length; offset += CATALOG_RUNTIME_STATUS_LIMIT) {
      const batch = scopes.slice(offset, offset + CATALOG_RUNTIME_STATUS_LIMIT)
      const requestedKeys = new Set(batch.map(createLocalAppScopeKey))
      try {
        const statuses = await window.electronAPI.localApps.getRuntimeStatuses({
          scopes: batch,
        })
        for (const status of statuses) {
          const scope = status.scope
          if (!scope || scope.kind !== 'catalog') {
            throw new Error(i18n.t('homeApps.errors.staleContext'))
          }
          const scopeKey = createLocalAppScopeKey(scope)
          if (!requestedKeys.has(scopeKey)) {
            throw new Error(i18n.t('homeApps.errors.staleContext'))
          }
          successfulStatuses.set(scopeKey, status)
        }
        for (const scopeKey of requestedKeys) {
          if (!successfulStatuses.has(scopeKey)) failedScopeKeys.add(scopeKey)
        }
      } catch {
        for (const scopeKey of requestedKeys) failedScopeKeys.add(scopeKey)
      }
    }
    if (!isCurrentSnapshot(snapshot) || (commitGuard && !commitGuard())) return

    setState(current => {
      if (!isCurrentSnapshot(snapshot) || (commitGuard && !commitGuard())) {
        return current
      }
      const latestRequestedScopeKeys = new Set([...requestedScopeKeys]
        .filter(scopeKey => (
          statusReadGenerationRef.current.get(scopeKey)
          === statusReadGenerations.get(scopeKey)
        )))
      if (latestRequestedScopeKeys.size === 0) return current
      const nextStatuses: Record<string, LocalAppRuntimeStatus> = (
        refreshMode === 'merge'
          ? { ...current.statuses }
          : Object.fromEntries([...requestedScopeKeys]
            .filter(scopeKey => !latestRequestedScopeKeys.has(scopeKey))
            .flatMap(scopeKey => {
              const status = current.statuses[scopeKey]
              return status ? [[scopeKey, status]] : []
            }))
      )
      for (const [scopeKey, status] of successfulStatuses) {
        if (!latestRequestedScopeKeys.has(scopeKey)) continue
        nextStatuses[scopeKey] = status
      }
      for (const scopeKey of failedScopeKeys) {
        if (!latestRequestedScopeKeys.has(scopeKey)) continue
        const previousStatus = current.statuses[scopeKey]
        if (previousStatus) {
          // A later 10,000-item chunk may fail after earlier chunks succeeded.
          // Preserve the last known value per failed scope instead of replacing
          // installed withdrawn apps with an invented not-installed status.
          nextStatuses[scopeKey] = previousStatus
        }
      }
      const nextStatusErrorScopeKeys: Record<string, true> = (
        refreshMode === 'merge'
          ? { ...current.statusErrorScopeKeys }
          : Object.fromEntries([...requestedScopeKeys]
            .filter(scopeKey => !latestRequestedScopeKeys.has(scopeKey))
            .flatMap(scopeKey => (
              current.statusErrorScopeKeys[scopeKey]
                ? [[scopeKey, true as const]]
                : []
            )))
      )
      const nextStatusLoadingScopeKeys = {
        ...current.statusLoadingScopeKeys,
      }
      for (const scopeKey of requestedScopeKeys) {
        if (latestRequestedScopeKeys.has(scopeKey)) {
          delete nextStatusLoadingScopeKeys[scopeKey]
        }
      }
      for (const scopeKey of successfulStatuses.keys()) {
        if (!latestRequestedScopeKeys.has(scopeKey)) continue
        delete nextStatusErrorScopeKeys[scopeKey]
      }
      for (const scopeKey of failedScopeKeys) {
        if (!latestRequestedScopeKeys.has(scopeKey)) continue
        nextStatusErrorScopeKeys[scopeKey] = true
      }
      const hasStatusErrors = Object.keys(nextStatusErrorScopeKeys).length > 0
      return {
        ...current,
        statuses: nextStatuses,
        statusErrorCode: hasStatusErrors ? 'status_read_failed' : null,
        statusErrorScopeKeys: nextStatusErrorScopeKeys,
        statusLoadingScopeKeys: nextStatusLoadingScopeKeys,
      }
    })
  }, [isCurrentSnapshot])

  const sync = useCallback(async (force = false) => {
    if (
      !productSpace
      || !catalogContextKey
      || !productSpace.activeProductSpaceId
    ) {
      catalogRef.current = null
      setState(current => ({
        ...current,
        catalog: null,
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        statusErrorCode: null,
        statusErrorScopeKeys: {},
        statusLoadingScopeKeys: {},
        accessMode: null,
        statuses: {},
        installStates: {},
        creatorCircles: [],
      }))
      return
    }
    const syncGeneration = ++syncGenerationRef.current
    const contextGeneration = contextGenerationRef.current
    const contextKey = catalogContextKey
    setState(current => ({
      ...current,
      loading: !current.catalog,
      refreshing: Boolean(current.catalog),
      errorCode: null,
    }))
    try {
      // Unified ProductSpace Catalog (S01). The response was already parsed
      // against the shared ProductSpace schema at the server boundary; a
      // catalog for another space is rejected there and never hydrated here.
      // The legacy Organization Catalog is not consulted as a fallback.
      let catalogResult = await window.electronAPI.productSpaceGetCatalog(
        productSpace.activeProductSpaceId,
        force ? undefined : knownCatalogRevisionRef.current ?? undefined,
      )
      for (
        let retry = 0;
        !catalogResult.success
          && catalogResult.errorCode === 'REQUEST_SUPERSEDED'
          && retry < CATALOG_SYNC_SUPERSEDED_RETRY_LIMIT;
        retry += 1
      ) {
        if (
          syncGeneration !== syncGenerationRef.current
          || contextGeneration !== contextGenerationRef.current
          || contextKeyRef.current !== contextKey
        ) return
        catalogResult = await window.electronAPI.productSpaceGetCatalog(
          productSpace.activeProductSpaceId,
          force ? undefined : knownCatalogRevisionRef.current ?? undefined,
        )
      }
      if (
        syncGeneration !== syncGenerationRef.current
        || contextGeneration !== contextGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      if (!catalogResult.success) {
        // PC-F11: a contract-incompatible Catalog is never a local load
        // error — it goes through the global contract channel.
        if (isProductSpaceContractUnsupported(catalogResult)) {
          reportProductSpaceContractFailure({
            errorCode: 'product_space_contract_unsupported',
            source: 'catalog',
          })
          return
        }
        emitAdminCatalogSessionAuthFailure(catalogResult)
        const failureCode = catalogResult.errorCode || 'request_failed'
        // Authorization loss keeps a denied catalog tombstone: visible for
        // explanation, never launchable. A returned denied snapshot is
        // authoritative even alongside a transient network error.
        const hasDeniedSnapshot = catalogResult.accessMode === 'denied'
          && 'catalog' in catalogResult
          && Boolean(catalogResult.catalog)
        if (hasDeniedSnapshot || isCatalogAccessDenied(failureCode, catalogResult.status)) {
          const deniedContextGeneration = ++contextGenerationRef.current
          const deniedSnapshot = catalogResult.accessMode === 'denied'
            && 'catalog' in catalogResult
            && catalogResult.catalog
            ? catalogResult.catalog
            : null
          const deniedCatalog = deniedSnapshot
            ?? (catalogRef.current
              ? markAppCatalogAccessDenied(catalogRef.current)
              : null)
          catalogRef.current = deniedCatalog
          setState(current => ({
            ...current,
            catalog: deniedCatalog,
            loading: false,
            refreshing: false,
            warningCode: null,
            errorCode: failureCode,
            statusLoadingScopeKeys: {},
            accessMode: 'denied',
            installStates: {},
            creatorCircles: [],
          }))
          if (deniedCatalog) {
            await refreshRuntimeStatuses(
              getAppCatalogApps(deniedCatalog),
              undefined,
              {
                contextKey,
                contextGeneration: deniedContextGeneration,
                catalog: deniedCatalog,
              },
              'replace',
            )
          }
          return
        }
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          errorCode: failureCode,
          // A failed refresh invalidates stale circle relations (fail-closed):
          // the relation entry must not re-echo the previous Catalog.
          creatorCircles: [],
        }))
        return
      }
      if (catalogResult.notModified && catalogRef.current) {
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          errorCode: null,
          accessMode: catalogResult.accessMode ?? 'online',
        }))
        return
      }
      const result = {
        catalog: mapProductSpaceCatalogToCacheEntry(
          productSpace.activeProductSpaceId,
          productSpace.accountId,
          catalogResult,
        ),
        accessMode: catalogResult.accessMode ?? 'online',
        warningCode: catalogResult.warningCode ?? null,
      }
      // Withdrawn tombstones are NOT diffed renderer-side: Main records the
      // verified Catalog into its persisted authority and emits credential-
      // stripped tombstones (catalogResult.withdrawnEntries) that survive
      // renderer restarts. mapProductSpaceCatalogToCacheEntry has already
      // projected them into withdrawnApps.
      // REQ-022: creator_circle sources of the active space's Catalog are
      // the account's visible CreatorCircle relations.
      const creatorCircles = selectCreatorCircleRelations(catalogResult.entries)
      knownCatalogRevisionRef.current = result.catalog.appConfigVersion
      catalogRef.current = result.catalog
      const snapshot: ContextSnapshot = {
        contextKey,
        contextGeneration,
        catalog: result.catalog,
        syncGeneration,
      }
      setState(current => {
        const sameCatalogContext = (
          current.catalog?.accountId === result.catalog.accountId
          && current.catalog.organizationId === result.catalog.organizationId
        )
        const knownStatuses = sameCatalogContext ? current.statuses : {}
        const knownStatusErrors = sameCatalogContext
          ? current.statusErrorScopeKeys
          : {}
        const statusLoadingScopeKeys: Record<string, true> = {}
        for (const app of getAppCatalogApps(result.catalog)) {
          if (app.deliveryMode !== 'local_bundle') continue
          const scopeKey = createLocalAppScopeKey(
            scopeForCatalogApp(result.catalog, app),
          )
          if (!knownStatuses[scopeKey] && !knownStatusErrors[scopeKey]) {
            statusLoadingScopeKeys[scopeKey] = true
          }
        }
        return {
          ...current,
          catalog: result.catalog,
          loading: false,
          refreshing: false,
          warningCode: result.warningCode ?? null,
          errorCode: null,
          accessMode: result.accessMode,
          statusLoadingScopeKeys,
          creatorCircles,
        }
      })
      await refreshRuntimeStatuses(
        getAppCatalogApps(result.catalog),
        undefined,
        snapshot,
        'replace',
      )
      await refreshProductSpaceInstallStates(getAppCatalogApps(result.catalog), snapshot)
    } catch (error) {
      if (
        syncGeneration !== syncGenerationRef.current
        || contextGeneration !== contextGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      const errorCode = getHomeAppErrorCode(error) ?? 'request_failed'
      if (isCatalogAccessDenied(errorCode)) {
        const deniedContextGeneration = ++contextGenerationRef.current
        const deniedCatalog = catalogRef.current
          ? markCatalogAccessDenied(catalogRef.current)
          : null
        catalogRef.current = deniedCatalog
        setState(current => ({
          ...current,
          catalog: deniedCatalog,
          loading: false,
          refreshing: false,
          warningCode: null,
          errorCode,
          statusLoadingScopeKeys: {},
          accessMode: 'denied',
          installStates: {},
          creatorCircles: [],
        }))
        if (deniedCatalog) {
          await refreshRuntimeStatuses(
            getAppCatalogApps(deniedCatalog),
            undefined,
            {
              contextKey,
              contextGeneration: deniedContextGeneration,
              catalog: deniedCatalog,
            },
            'replace',
          )
        }
      } else {
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          errorCode,
          creatorCircles: [],
        }))
      }
    }
  }, [
    productSpace,
    catalogContextKey,
    refreshProductSpaceInstallStates,
    refreshRuntimeStatuses,
  ])

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.localApps.getHostInfo()
      .then(host => {
        if (!cancelled) setState(current => ({ ...current, host }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    contextGenerationRef.current += 1
    syncGenerationRef.current += 1
    operationsRef.current.clear()
    cancellationOperationsRef.current.clear()
    lifecycleActionGenerationRef.current.clear()
    statusReadGenerationRef.current.clear()
    catalogRef.current = null
    knownCatalogRevisionRef.current = null
    setState(current => ({
      ...current,
      catalog: null,
      loading: Boolean(catalogContextKey),
      refreshing: false,
      warningCode: null,
      errorCode: null,
      statusErrorCode: null,
      statusErrorScopeKeys: {},
      statusLoadingScopeKeys: {},
      accessMode: null,
      statuses: {},
      installStates: {},
      creatorCircles: [],
    }))
    void sync()
    return () => {
      contextGenerationRef.current += 1
      syncGenerationRef.current += 1
    }
  }, [catalogContextKey, sync])

  const busyScopes = useMemo(() => Object.entries(state.statuses)
    .filter(([, status]) => (
      status.status === 'downloading'
      || status.status === 'installing'
      || status.status === 'starting'
      || status.installationStatus !== undefined
    ))
    // The 500ms loop is only for a bounded active set. Full Catalog state is
    // loaded once or after operations, never polled item-by-item.
    .slice(0, BUSY_RUNTIME_STATUS_LIMIT)
    .flatMap(([scopeKey, status]) => (
      status.scope?.kind === 'catalog'
        ? [{ scopeKey, scope: status.scope }]
        : []
    )), [state.statuses])
  const busyScopesSignature = JSON.stringify(busyScopes)

  useEffect(() => {
    const poller = createBusyStatusPoller()
    busyStatusPollerRef.current = poller
    return () => {
      if (busyStatusPollerRef.current === poller) {
        busyStatusPollerRef.current = null
      }
      poller.stop()
    }
  }, [])

  useEffect(() => {
    const selected = JSON.parse(busyScopesSignature) as Array<{
      scopeKey: string
      scope: CatalogLocalAppScope
    }>
    const poller = busyStatusPollerRef.current
    if (selected.length === 0) {
      poller?.replace(null)
      return
    }
    const busyKeys = new Set(selected.map(item => item.scopeKey))
    // Replacing the task advances the poller's loop generation. The shared
    // in-flight slot prevents overlapping 500ms reads even when this busy set
    // changes while the previous request is still pending.
    poller?.replace(request => refreshRuntimeStatuses(
      undefined,
      busyKeys,
      undefined,
      'merge',
      request.isCurrent,
    ))
    return () => poller?.replace(null)
  }, [busyScopesSignature, refreshRuntimeStatuses])

  const runExclusive = useCallback(<T,>(
    scopeKey: string,
    operationKind: 'install' | 'start' | 'stop' | 'uninstall',
    operation: () => Promise<T>,
  ): Promise<T> => {
    // Only identical lifecycle commands are single-flight. A stop must remain
    // able to cross an entered start so the main process can serialize and
    // stop the process as soon as startup completes.
    const operationKey = JSON.stringify([scopeKey, operationKind])
    const existing = operationsRef.current.get(operationKey) as
      | Promise<T>
      | undefined
    if (existing) return existing
    const promise = operation().finally(() => {
      if (operationsRef.current.get(operationKey) === promise) {
        operationsRef.current.delete(operationKey)
      }
    })
    operationsRef.current.set(operationKey, promise)
    return promise
  }, [])

  const runCancellationExclusive = useCallback((
    scopeKey: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const existing = cancellationOperationsRef.current.get(scopeKey)
    if (existing) return existing
    const promise = operation().finally(() => {
      if (cancellationOperationsRef.current.get(scopeKey) === promise) {
        cancellationOperationsRef.current.delete(scopeKey)
      }
    })
    cancellationOperationsRef.current.set(scopeKey, promise)
    return promise
  }, [])

  const requireCurrent = useCallback((snapshot: ContextSnapshot) => {
    if (!isCurrentSnapshot(snapshot)) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
  }, [isCurrentSnapshot])

  const advanceLifecycleActionGeneration = useCallback((scopeKey: string) => {
    const next = (lifecycleActionGenerationRef.current.get(scopeKey) ?? 0) + 1
    lifecycleActionGenerationRef.current.set(scopeKey, next)
    return next
  }, [])

  const isCurrentLifecycleAction = useCallback((
    scopeKey: string,
    generation: number,
  ) => (
    (lifecycleActionGenerationRef.current.get(scopeKey) ?? 0) === generation
  ), [])

  const requireCurrentLifecycleAction = useCallback((
    scopeKey: string,
    generation: number,
  ) => {
    if (!isCurrentLifecycleAction(scopeKey, generation)) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
  }, [isCurrentLifecycleAction])

  const install = useCallback((
    app: CatalogApp,
    confirmedAppConfigVersion: string,
  ) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, 'install', async () => {
      const release = app.currentRelease
      if (!release || !state.host) {
        throw new Error(i18n.t('homeApps.errors.releaseUnavailable'))
      }
      if (!normalizeCatalogSemVer(release.version)) {
        throw new Error(i18n.t('homeApps.errors.invalidVersion'))
      }
      if (state.accessMode !== 'online') {
        throw new Error(i18n.t('homeApps.errors.offlineInstall'))
      }
      if (app.availability !== 'available') {
        throw new Error(i18n.t('homeApps.errors.unavailable'))
      }
      requireCurrent(snapshot)
      setState(current => ({
        ...current,
        statuses: {
          ...current.statuses,
          [scopeKey]: {
            appId: app.id,
            scope,
            status: 'downloading',
            progress: {
              phase: 'downloading',
              bytesDownloaded: 0,
              sizeBytes: release.sizeBytes,
              percent: 0,
            },
          },
        },
      }))
      try {
        await window.electronAPI.localApps.install({
          scope,
          appConfigVersion: confirmedAppConfigVersion,
          permissions: normalizeLocalAppPermissions(app.permissions),
          release: {
            version: release.version,
            runtime: release.runtime,
            checksum: release.checksum,
            sizeBytes: release.sizeBytes,
            platform: release.platform ?? null,
            arch: release.arch ?? null,
          },
        })
        requireCurrent(snapshot)
      } catch (error) {
        if (
          getHomeAppErrorCode(error) === 'RELEASE_CHANGED'
          && isCurrentSnapshot(snapshot)
        ) {
          await sync(true)
        }
        throw error
      } finally {
        if (isCurrentSnapshot(snapshot)) {
          await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
        }
      }
    })
  }, [
    currentSnapshotForApp,
    isCurrentSnapshot,
    refreshRuntimeStatuses,
    requireCurrent,
    runExclusive,
    state.accessMode,
    state.host,
    sync,
  ])

  const start = useCallback((app: CatalogApp): Promise<LocalAppStartResult> => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, 'start', async () => {
      const lifecycleActionGeneration = (
        lifecycleActionGenerationRef.current.get(scopeKey) ?? 0
      )
      if (app.availability !== 'available') {
        throw new Error(i18n.t('homeApps.errors.unavailable'))
      }
      if (state.accessMode !== 'online') {
        throw new Error(i18n.t('homeApps.errors.offlineInstall'))
      }
      requireCurrent(snapshot)
      setState(current => ({
        ...current,
        statuses: {
          ...current.statuses,
          [scopeKey]: {
            ...(current.statuses[scopeKey] ?? { appId: app.id, scope }),
            status: 'starting',
          },
        },
      }))
      let result: LocalAppStartResult | undefined
      try {
        result = await window.electronAPI.localApps.start(scope)
        requireCurrent(snapshot)
        // STOP/UNINSTALL are newer user intent for this exact scope. A late
        // START may refresh diagnostics, but its URL must not escape to HomePage.
        requireCurrentLifecycleAction(scopeKey, lifecycleActionGeneration)
      } finally {
        if (
          isCurrentSnapshot(snapshot)
          && isCurrentLifecycleAction(scopeKey, lifecycleActionGeneration)
        ) {
          await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
        }
      }
      requireCurrent(snapshot)
      requireCurrentLifecycleAction(scopeKey, lifecycleActionGeneration)
      return result!
    })
  }, [
    currentSnapshotForApp,
    isCurrentLifecycleAction,
    isCurrentSnapshot,
    refreshRuntimeStatuses,
    requireCurrent,
    requireCurrentLifecycleAction,
    runExclusive,
    state.accessMode,
  ])

  const stop = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    advanceLifecycleActionGeneration(scopeKey)
    return runExclusive(scopeKey, 'stop', async () => {
      await window.electronAPI.localApps.stop(scope)
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
    })
  }, [
    advanceLifecycleActionGeneration,
    currentSnapshotForApp,
    refreshRuntimeStatuses,
    requireCurrent,
    runExclusive,
  ])

  const uninstall = useCallback((app: CatalogApp, preserveData: boolean) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    advanceLifecycleActionGeneration(scopeKey)
    return runExclusive(scopeKey, 'uninstall', async () => {
      await window.electronAPI.localApps.uninstall(scope, { preserveData })
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
    })
  }, [
    advanceLifecycleActionGeneration,
    currentSnapshotForApp,
    refreshRuntimeStatuses,
    requireCurrent,
    runExclusive,
  ])

  const cancelInstall = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runCancellationExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.cancelInstall(scope)
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
    })
  }, [
    currentSnapshotForApp,
    refreshRuntimeStatuses,
    requireCurrent,
    runCancellationExclusive,
  ])

  const getLogs = useCallback(async (app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const admittedWithDeliveryAccess = (
      app.availability === undefined
      || app.availability === 'available'
    )
    const result = await window.electronAPI.localApps.getLogs(
      scopeForCatalogApp(snapshot.catalog, app),
      { tail: 300 },
    )
    requireCurrent(snapshot)
    const currentApp = catalogRef.current
      ? getAppCatalogApps(catalogRef.current)
          .find(candidate => candidate.id === app.id)
      : undefined
    const currentlyHasDeliveryAccess = Boolean(
      currentApp
      && (
        currentApp.availability === undefined
        || currentApp.availability === 'available'
      ),
    )
    // A same-organization refresh intentionally preserves lifecycle results,
    // but a log read is bound to its admitted delivery/retained capability.
    // Do not let an older retained response publish after re-authorization.
    if (currentlyHasDeliveryAccess !== admittedWithDeliveryAccess) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return result
  }, [currentSnapshotForApp, requireCurrent])

  const resolveRemoteUrl = useCallback(async (app: CatalogApp) => {
    if (app.deliveryMode !== 'remote_url' || app.availability !== 'available') {
      throw new Error(i18n.t('homeApps.errors.unavailable'))
    }
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const result = await window.electronAPI.localApps.resolveRemoteUrl(scope)
    requireCurrent(snapshot)
    if (
      result.appId !== app.id
      || createLocalAppScopeKey(result.scope) !== createLocalAppScopeKey(scope)
    ) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return result.url
  }, [currentSnapshotForApp, requireCurrent])

  /**
   * Resolves a fresh, fixed ProductSpace launch context for POO-47. No URL or
   * bundle metadata from the Catalog projection is trusted here.
   */
  const resolveLaunch = useCallback(async (
    app: CatalogApp,
  ): Promise<ResolveLaunchResponse> => {
    if (
      app.availability !== 'available'
      || !app.catalogEntryId
      || !app.artifactInstanceId
      || !app.catalogVersion
      || state.accessMode !== 'online'
    ) {
      throw new Error(i18n.t('homeApps.errors.unavailable'))
    }
    const snapshot = currentSnapshotForApp(app)
    requireCurrent(snapshot)
    const result = await window.electronAPI.productSpaceResolveLaunch(
      snapshot.catalog.organizationId,
      app.catalogEntryId,
    )
    requireCurrent(snapshot)
    if (!result.success) {
      const error = new Error(result.message)
      Object.assign(error, { code: result.errorCode, errorCode: result.errorCode })
      throw error
    }
    const launch = result.launch
    const currentApp = catalogRef.current?.apps.find(
      candidate => candidate.catalogEntryId === app.catalogEntryId,
    )
    if (
      !currentApp
      || currentApp.availability !== 'available'
      || currentApp.artifactInstanceId !== app.artifactInstanceId
      || currentApp.catalogVersion?.versionId !== app.catalogVersion.versionId
      || currentApp.catalogVersion?.version !== app.catalogVersion.version
      || launch.productSpaceId !== snapshot.catalog.organizationId
      || launch.catalogEntryId !== app.catalogEntryId
      || launch.subject.kind !== 'artifact_instance'
      || launch.subject.artifactType !== 'app'
      || launch.subject.artifactInstanceId !== app.artifactInstanceId
      || launch.subject.versionId !== app.catalogVersion.versionId
      || launch.subject.version !== app.catalogVersion.version
      || Date.parse(launch.expiresAt) <= Date.now()
    ) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return launch
  }, [currentSnapshotForApp, requireCurrent, state.accessMode])

  const installProductSpaceBundle = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const identity = identityForProductSpaceApp(snapshot.catalog, app)
    // Collision-free operation key: full identity, never catalogEntryId
    // alone (a reused entry id across artifact instances must not merge
    // lifecycle operations).
    const operationKey = `product-space:${identity.artifactInstanceId}:${identity.catalogEntryId}:${identity.versionId}`
    return runExclusive(operationKey, 'install', async () => {
      if (state.accessMode !== 'online' || app.availability !== 'available') {
        throw new Error(i18n.t('homeApps.errors.unavailable'))
      }
      requireCurrent(snapshot)
      const installed = await window.electronAPI.localApps.installProductSpaceBundle({
        app: identity,
      })
      requireCurrent(snapshot)
      if (
        installed.scope?.kind !== 'catalog'
        || installed.scope.accountId !== identity.accountId
        || installed.scope.organizationId !== identity.productSpaceId
        || installed.scope.catalogAppId !== identity.artifactInstanceId
        || installed.currentVersion !== identity.version
      ) throw new Error(i18n.t('homeApps.errors.staleContext'))
      await refreshProductSpaceInstallStates(getAppCatalogApps(snapshot.catalog), snapshot)
      return installed
    })
  }, [
    currentSnapshotForApp,
    refreshProductSpaceInstallStates,
    requireCurrent,
    runExclusive,
    state.accessMode,
  ])

  const uninstallProductSpaceBundle = useCallback((
    app: CatalogApp,
    preserveData = true,
  ) => {
    const snapshot = currentSnapshotForApp(app)
    const identity = identityForProductSpaceApp(snapshot.catalog, app)
    const operationKey = `product-space:${identity.artifactInstanceId}:${identity.catalogEntryId}:${identity.versionId}`
    return runExclusive(operationKey, 'uninstall', async () => {
      requireCurrent(snapshot)
      await window.electronAPI.localApps.uninstallProductSpaceBundle(
        identity,
        { preserveData },
      )
      requireCurrent(snapshot)
      await refreshProductSpaceInstallStates(getAppCatalogApps(snapshot.catalog), snapshot)
    })
  }, [
    currentSnapshotForApp,
    refreshProductSpaceInstallStates,
    requireCurrent,
    runExclusive,
  ])

  const getInstallState = useCallback((app: CatalogApp): ProductSpaceAppInstallState | undefined => {
    // Look up by the collision-free artifact identity scope key — a live
    // entry and a withdrawn tombstone that share a catalogEntryId keep
    // separate install states.
    const catalog = catalogRef.current
    if (!catalog || !app.artifactInstanceId) return undefined
    try {
      const snapshot = currentSnapshotForApp(app)
      const identityScopeKey = createIdentityScopeKey({
        kind: 'catalog',
        accountId: snapshot.catalog.accountId,
        organizationId: snapshot.catalog.organizationId,
        catalogAppId: app.artifactInstanceId,
      })
      return state.installStates[identityScopeKey]
    } catch {
      return undefined
    }
  }, [currentSnapshotForApp, state.installStates])

  const getStatus = useCallback((app: CatalogApp): LocalAppRuntimeStatus | undefined => {
    try {
      return state.statuses[scopeKeyForApp(app)]
    } catch {
      return undefined
    }
  }, [scopeKeyForApp, state.statuses])

  return {
    productSpace,
    state,
    creatorCircles: state.creatorCircles,
    sync,
    install,
    start,
    stop,
    uninstall,
    cancelInstall,
    getLogs,
    resolveLaunch,
    installProductSpaceBundle,
    uninstallProductSpaceBundle,
    getInstallState,
    resolveRemoteUrl,
    getStatus,
    scopeForApp,
    scopeKeyForApp,
    refreshRuntimeStatuses,
  }
}
