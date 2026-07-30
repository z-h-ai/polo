import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gt, valid } from 'semver'
import { i18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
} from '@polo-ai/shared/admin'
import {
  createLocalAppScopeKey,
  type CatalogLocalAppScope,
  type LocalAppRuntimeStatus,
  type LocalAppStartResult,
} from '@polo-ai/shared/protocol'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import {
  emitAdminAuthFailure,
  normalizeAdminError,
} from '@/lib/admin-auth-failure'

export interface AppCatalogState {
  catalog: AppCatalogCacheEntry | null
  loading: boolean
  refreshing: boolean
  warning: string | null
  error: string | null
  accessMode: 'online' | 'offline' | 'denied' | null
  statuses: Record<string, LocalAppRuntimeStatus>
  host: {
    platform: 'darwin' | 'win32' | 'linux'
    arch: 'arm64' | 'x64'
  } | null
}

export const CATALOG_RUNTIME_STATUS_CONCURRENCY = 8
export const CATALOG_RUNTIME_STATUS_LIMIT = 10_000
export const BUSY_RUNTIME_STATUS_LIMIT = 32

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message) return message
  }
  return i18n.t('homeApps.errors.localOperation')
}

export type CatalogVersionComparison =
  | { strategy: 'semver'; order: -1 | 0 | 1 }
  | { strategy: 'invalid'; order: null; reason: 'invalid_semver' }

export function normalizeCatalogSemVer(version: string): string | null {
  const normalized = version.trim().replace(/^v(?=\d)/i, '')
  return valid(normalized, { loose: false })
}

export function compareCatalogVersions(
  available: string,
  installed: string,
): CatalogVersionComparison {
  const left = normalizeCatalogSemVer(available)
  const right = normalizeCatalogSemVer(installed)
  if (!left || !right) {
    return { strategy: 'invalid', order: null, reason: 'invalid_semver' }
  }
  if (left === right) return { strategy: 'semver', order: 0 }
  return { strategy: 'semver', order: gt(left, right) ? 1 : -1 }
}

export function isNewerCatalogVersion(available: string, installed: string): boolean {
  return compareCatalogVersions(available, installed).order === 1
}

export function selectRuntimeStatusApps(
  apps: CatalogApp[],
  busyScopeKeys?: ReadonlySet<string>,
  scopeKeyForApp: (app: CatalogApp) => string = app => app.id,
): CatalogApp[] {
  const limit = busyScopeKeys
    ? BUSY_RUNTIME_STATUS_LIMIT
    : CATALOG_RUNTIME_STATUS_LIMIT
  return apps
    .filter(app => (
      app.deliveryMode === 'local_bundle'
      && (!busyScopeKeys || busyScopeKeys.has(scopeKeyForApp(app)))
    ))
    .slice(0, limit)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        results[index] = await callback(values[index]!, index)
      }
    },
  )
  await Promise.all(workers)
  return results
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

interface ContextSnapshot {
  contextKey: string
  generation: number
  catalog: AppCatalogCacheEntry
}

export function useAppCatalog() {
  const organization = useOptionalOrganizationContext()
  const organizationContextKey = organization?.organizationContextKey ?? null
  const [state, setState] = useState<AppCatalogState>({
    catalog: null,
    loading: Boolean(organization),
    refreshing: false,
    warning: null,
    error: null,
    accessMode: null,
    statuses: {},
    host: null,
  })
  const catalogRef = useRef<AppCatalogCacheEntry | null>(null)
  const contextKeyRef = useRef<string | null>(organizationContextKey)
  contextKeyRef.current = organizationContextKey
  const syncGenerationRef = useRef(0)
  const operationsRef = useRef(new Map<string, Promise<unknown>>())

  const isCurrentSnapshot = useCallback((snapshot: ContextSnapshot): boolean => (
    contextKeyRef.current === snapshot.contextKey
    && syncGenerationRef.current === snapshot.generation
    && catalogRef.current?.accountId === snapshot.catalog.accountId
    && catalogRef.current?.organizationId === snapshot.catalog.organizationId
  ), [])

  const currentSnapshotForApp = useCallback((app: CatalogApp): ContextSnapshot => {
    const catalog = catalogRef.current
    if (
      !organizationContextKey
      || !catalog
      || catalog.accountId !== organization?.accountId
      || app.organizationId !== catalog.organizationId
    ) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return {
      contextKey: organizationContextKey,
      generation: syncGenerationRef.current,
      catalog,
    }
  }, [organization?.accountId, organizationContextKey])

  const scopeForApp = useCallback((app: CatalogApp): CatalogLocalAppScope => (
    scopeForCatalogApp(currentSnapshotForApp(app).catalog, app)
  ), [currentSnapshotForApp])

  const scopeKeyForApp = useCallback((app: CatalogApp): string => (
    createLocalAppScopeKey(scopeForApp(app))
  ), [scopeForApp])

  const reconcileVersionStatuses = useCallback(async (
    apps: CatalogApp[],
    statuses: LocalAppRuntimeStatus[],
    snapshot: ContextSnapshot,
  ): Promise<LocalAppRuntimeStatus[]> => mapWithConcurrency(
    statuses,
    CATALOG_RUNTIME_STATUS_CONCURRENCY,
    async (status, index) => {
      const app = apps[index]!
      const release = app.currentRelease
      if (!release) return status
      if (!normalizeCatalogSemVer(release.version)) {
        return { ...status, versionError: 'invalid_semver' }
      }
      if (!status.currentVersion) return status
      const comparison = compareCatalogVersions(release.version, status.currentVersion)
      if (comparison.strategy === 'invalid') {
        // Preserve the last trusted availableRelease already held by POO-12.
        return { ...status, versionError: comparison.reason }
      }
      const desiredRelease = comparison.order === 1 ? release : null
      try {
        const next = await window.electronAPI.localApps.setAvailableRelease(
          scopeForCatalogApp(snapshot.catalog, app),
          desiredRelease,
        )
        return next
      } catch {
        return status
      }
    },
  ), [])

  const refreshRuntimeStatuses = useCallback(async (
    apps?: CatalogApp[],
    busyScopeKeys?: ReadonlySet<string>,
    suppliedSnapshot?: ContextSnapshot,
  ) => {
    const catalog = suppliedSnapshot?.catalog ?? catalogRef.current
    const contextKey = suppliedSnapshot?.contextKey ?? contextKeyRef.current
    if (!catalog || !contextKey) {
      if (!busyScopeKeys) setState(current => ({ ...current, statuses: {} }))
      return
    }
    const snapshot: ContextSnapshot = suppliedSnapshot ?? {
      contextKey,
      generation: syncGenerationRef.current,
      catalog,
    }
    if (!isCurrentSnapshot(snapshot)) return

    const selectedApps = selectRuntimeStatusApps(
      apps ?? catalog.apps,
      busyScopeKeys,
      app => createLocalAppScopeKey(scopeForCatalogApp(catalog, app)),
    )
    if (selectedApps.length === 0) {
      if (!busyScopeKeys && isCurrentSnapshot(snapshot)) {
        setState(current => ({ ...current, statuses: {} }))
      }
      return
    }

    const scopes = selectedApps.map(app => scopeForCatalogApp(catalog, app))
    let statuses: LocalAppRuntimeStatus[]
    try {
      statuses = await window.electronAPI.localApps.getRuntimeStatuses({ scopes })
    } catch {
      statuses = scopes.map(scope => ({
        appId: scope.catalogAppId,
        scope,
        status: 'not_installed',
      }))
    }
    statuses = await reconcileVersionStatuses(selectedApps, statuses, snapshot)
    if (!isCurrentSnapshot(snapshot)) return

    setState(current => ({
      ...current,
      statuses: {
        ...(busyScopeKeys ? current.statuses : {}),
        ...Object.fromEntries(statuses.map(status => {
          const scope = status.scope
          if (!scope || scope.kind !== 'catalog') {
            throw new Error(i18n.t('homeApps.errors.staleContext'))
          }
          return [createLocalAppScopeKey(scope), status]
        })),
      },
    }))
  }, [isCurrentSnapshot, reconcileVersionStatuses])

  const sync = useCallback(async (force = false) => {
    if (
      !organization
      || !organizationContextKey
      || !organization.activeOrganizationId
    ) {
      catalogRef.current = null
      setState(current => ({
        ...current,
        catalog: null,
        loading: false,
        refreshing: false,
        warning: null,
        error: null,
        accessMode: null,
        statuses: {},
      }))
      return
    }
    const generation = ++syncGenerationRef.current
    const contextKey = organizationContextKey
    setState(current => ({
      ...current,
      loading: !current.catalog,
      refreshing: Boolean(current.catalog),
      error: null,
    }))
    try {
      const result = await window.electronAPI.adminSyncAppCatalog(
        organization.activeOrganizationId,
        { force },
      )
      if (
        generation !== syncGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      if (!result.success) {
        emitAdminAuthFailure(normalizeAdminError(result))
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          error: result.message,
        }))
        return
      }
      catalogRef.current = result.catalog
      const snapshot: ContextSnapshot = {
        contextKey,
        generation,
        catalog: result.catalog,
      }
      setState(current => ({
        ...current,
        catalog: result.catalog,
        loading: false,
        refreshing: false,
        warning: result.warning ?? null,
        error: null,
        accessMode: result.accessMode,
      }))
      await refreshRuntimeStatuses(result.catalog.apps, undefined, snapshot)
    } catch (error) {
      if (
        generation !== syncGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      setState(current => ({
        ...current,
        loading: false,
        refreshing: false,
        error: errorMessage(error),
      }))
    }
  }, [
    organization,
    organizationContextKey,
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
    syncGenerationRef.current += 1
    operationsRef.current.clear()
    catalogRef.current = null
    setState(current => ({
      ...current,
      catalog: null,
      loading: Boolean(organizationContextKey),
      refreshing: false,
      warning: null,
      error: null,
      accessMode: null,
      statuses: {},
    }))
    void sync()
    return () => {
      syncGenerationRef.current += 1
    }
  }, [organizationContextKey, sync])

  const busyScopes = useMemo(() => Object.entries(state.statuses)
    .filter(([, status]) => (
      status.status === 'downloading'
      || status.status === 'installing'
      || status.status === 'starting'
      || status.installationStatus !== undefined
    ))
    .slice(0, BUSY_RUNTIME_STATUS_LIMIT)
    .flatMap(([scopeKey, status]) => (
      status.scope?.kind === 'catalog'
        ? [{ scopeKey, scope: status.scope }]
        : []
    )), [state.statuses])
  const busyScopesSignature = JSON.stringify(busyScopes)

  useEffect(() => {
    const selected = JSON.parse(busyScopesSignature) as Array<{
      scopeKey: string
      scope: CatalogLocalAppScope
    }>
    if (selected.length === 0) return
    const busyKeys = new Set(selected.map(item => item.scopeKey))
    const interval = window.setInterval(() => {
      void refreshRuntimeStatuses(undefined, busyKeys)
    }, 500)
    return () => window.clearInterval(interval)
  }, [busyScopesSignature, refreshRuntimeStatuses])

  const runExclusive = useCallback(<T,>(
    scopeKey: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const existing = operationsRef.current.get(scopeKey) as Promise<T> | undefined
    if (existing) return existing
    const promise = operation().finally(() => {
      if (operationsRef.current.get(scopeKey) === promise) {
        operationsRef.current.delete(scopeKey)
      }
    })
    operationsRef.current.set(scopeKey, promise)
    return promise
  }, [])

  const requireCurrent = useCallback((snapshot: ContextSnapshot) => {
    if (!isCurrentSnapshot(snapshot)) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
  }, [isCurrentSnapshot])

  const install = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
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
        await window.electronAPI.localApps.install({ scope })
        requireCurrent(snapshot)
      } finally {
        if (isCurrentSnapshot(snapshot)) {
          await refreshRuntimeStatuses([app], undefined, snapshot)
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
  ])

  const start = useCallback((app: CatalogApp): Promise<LocalAppStartResult> => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      if (app.availability !== 'available') {
        throw new Error(i18n.t('homeApps.errors.unavailable'))
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
      try {
        const result = await window.electronAPI.localApps.start(scope)
        requireCurrent(snapshot)
        return result
      } finally {
        if (isCurrentSnapshot(snapshot)) {
          await refreshRuntimeStatuses([app], undefined, snapshot)
        }
      }
    })
  }, [
    currentSnapshotForApp,
    isCurrentSnapshot,
    refreshRuntimeStatuses,
    requireCurrent,
    runExclusive,
  ])

  const stop = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.stop(scope)
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot)
    })
  }, [currentSnapshotForApp, refreshRuntimeStatuses, requireCurrent, runExclusive])

  const uninstall = useCallback((app: CatalogApp, preserveData: boolean) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.uninstall(scope, { preserveData })
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot)
    })
  }, [currentSnapshotForApp, refreshRuntimeStatuses, requireCurrent, runExclusive])

  const cancelInstall = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.cancelInstall(scope)
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot)
    })
  }, [currentSnapshotForApp, refreshRuntimeStatuses, requireCurrent, runExclusive])

  const getLogs = useCallback(async (app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const result = await window.electronAPI.localApps.getLogs(
      scopeForCatalogApp(snapshot.catalog, app),
      { tail: 300 },
    )
    requireCurrent(snapshot)
    return result
  }, [currentSnapshotForApp, requireCurrent])

  const getStatus = useCallback((app: CatalogApp): LocalAppRuntimeStatus | undefined => {
    try {
      return state.statuses[scopeKeyForApp(app)]
    } catch {
      return undefined
    }
  }, [scopeKeyForApp, state.statuses])

  return {
    organization,
    state,
    sync,
    install,
    start,
    stop,
    uninstall,
    cancelInstall,
    getLogs,
    getStatus,
    scopeForApp,
    scopeKeyForApp,
    refreshRuntimeStatuses,
  }
}
