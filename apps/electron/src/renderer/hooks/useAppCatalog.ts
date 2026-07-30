import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gt, valid } from 'semver'
import { i18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
} from '@polo-ai/shared/admin'
import type {
  LocalAppInstallRequest,
  LocalAppRuntimeStatus,
  LocalAppScope,
  LocalAppStartResult,
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
  statuses: Record<string, LocalAppRuntimeStatus>
  host: {
    platform: 'darwin' | 'win32' | 'linux'
    arch: 'arm64' | 'x64'
  } | null
}

export const CATALOG_RUNTIME_STATUS_CONCURRENCY = 8
export const CATALOG_RUNTIME_STATUS_LIMIT = 1_000
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

function normalizeCatalogSemVer(version: string): string | null {
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
  busyAppIds?: ReadonlySet<string>,
): CatalogApp[] {
  const limit = busyAppIds
    ? BUSY_RUNTIME_STATUS_LIMIT
    : CATALOG_RUNTIME_STATUS_LIMIT
  return apps
    .filter(app => (
      app.deliveryMode === 'local_bundle'
      && (!busyAppIds || busyAppIds.has(app.id))
    ))
    .slice(0, limit)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await callback(values[index]!)
      }
    },
  )
  await Promise.all(workers)
  return results
}

export function useAppCatalog() {
  const organization = useOptionalOrganizationContext()
  const [state, setState] = useState<AppCatalogState>({
    catalog: null,
    loading: Boolean(organization),
    refreshing: false,
    warning: null,
    error: null,
    statuses: {},
    host: null,
  })
  const catalogRef = useRef<AppCatalogCacheEntry | null>(null)
  const syncGenerationRef = useRef(0)
  const operationsRef = useRef(new Map<string, Promise<unknown>>())

  const scopeForApp = useCallback((app: CatalogApp): LocalAppScope => {
    const catalog = catalogRef.current
    if (
      !catalog
      || catalog.accountId !== organization?.accountId
      || app.organizationId !== catalog.organizationId
    ) {
      throw new Error(i18n.t('homeApps.errors.staleContext'))
    }
    return {
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: app.id,
    }
  }, [organization?.accountId])

  const refreshRuntimeStatuses = useCallback(async (
    apps?: CatalogApp[],
    busyAppIds?: ReadonlySet<string>,
  ) => {
    const bundleApps = selectRuntimeStatusApps(
      apps ?? catalogRef.current?.apps ?? [],
      busyAppIds,
    )
    if (bundleApps.length === 0) {
      if (!busyAppIds) {
        setState(current => ({ ...current, statuses: {} }))
      }
      return
    }
    const statuses = await mapWithConcurrency(
      bundleApps,
      CATALOG_RUNTIME_STATUS_CONCURRENCY,
      async app => {
      try {
        return await window.electronAPI.localApps.getRuntimeStatus(scopeForApp(app))
      } catch {
        return {
          appId: app.id,
          status: 'not_installed' as const,
        }
      }
      },
    )
    setState(current => ({
      ...current,
      statuses: {
        ...(busyAppIds ? current.statuses : {}),
        ...Object.fromEntries(statuses.map(status => [status.appId, status])),
      },
    }))
  }, [scopeForApp])

  const publishAvailableUpdates = useCallback(async (
    catalog: AppCatalogCacheEntry,
  ) => {
    if (catalog.authorizationStatus !== 'authorized') return
    const apps = selectRuntimeStatusApps(catalog.apps)
    await mapWithConcurrency(
      apps,
      CATALOG_RUNTIME_STATUS_CONCURRENCY,
      async app => {
        const release = app.currentRelease
        if (!release || app.availability !== 'available') return
        try {
          const scope = scopeForApp(app)
          const status = await window.electronAPI.localApps.getRuntimeStatus(scope)
          if (!status.currentVersion) return
          const available = isNewerCatalogVersion(
            release.version,
            status.currentVersion,
          )
            ? release
            : null
          await window.electronAPI.localApps.setAvailableRelease(scope, available)
        } catch {
          // An individual damaged or stale installation must not block catalog sync.
        }
      },
    )
  }, [scopeForApp])

  const organizationContextKey = organization?.organizationContextKey ?? null

  const sync = useCallback(async (force = false) => {
    if (!organization) {
      catalogRef.current = null
      setState(current => ({
        ...current,
        catalog: null,
        loading: false,
        refreshing: false,
        warning: null,
        error: null,
        statuses: {},
      }))
      return
    }
    const generation = ++syncGenerationRef.current
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
      if (generation !== syncGenerationRef.current) return
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
      setState(current => ({
        ...current,
        catalog: result.catalog,
        loading: false,
        refreshing: false,
        warning: result.warning ?? null,
        error: null,
      }))
      await publishAvailableUpdates(result.catalog)
      if (generation !== syncGenerationRef.current) return
      await refreshRuntimeStatuses(result.catalog.apps)
    } catch (error) {
      if (generation !== syncGenerationRef.current) return
      setState(current => ({
        ...current,
        loading: false,
        refreshing: false,
        error: errorMessage(error),
      }))
    }
  }, [organization, publishAvailableUpdates, refreshRuntimeStatuses])

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
    catalogRef.current = null
    setState(current => ({
      ...current,
      catalog: null,
      loading: Boolean(organizationContextKey),
      refreshing: false,
      warning: null,
      error: null,
      statuses: {},
    }))
    void sync()
    return () => {
      syncGenerationRef.current += 1
    }
  }, [organizationContextKey, sync])

  const busyAppIds = useMemo(() => Object.values(state.statuses)
    .filter(status => (
      status.status === 'downloading'
      || status.status === 'installing'
      || status.status === 'starting'
      || status.installationStatus !== undefined
    ))
    .map(status => status.appId)
    .sort(), [state.statuses])
  const busyAppIdsKey = busyAppIds.join(',')

  useEffect(() => {
    if (!busyAppIdsKey) return
    const selectedBusyAppIds = new Set(
      busyAppIdsKey.split(',').slice(0, BUSY_RUNTIME_STATUS_LIMIT),
    )
    const interval = window.setInterval(() => {
      void refreshRuntimeStatuses(undefined, selectedBusyAppIds)
    }, 500)
    return () => window.clearInterval(interval)
  }, [busyAppIdsKey, refreshRuntimeStatuses])

  const runExclusive = useCallback(<T,>(
    appId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const existing = operationsRef.current.get(appId) as Promise<T> | undefined
    if (existing) return existing
    const promise = operation().finally(() => {
      if (operationsRef.current.get(appId) === promise) {
        operationsRef.current.delete(appId)
      }
    })
    operationsRef.current.set(appId, promise)
    return promise
  }, [])

  const install = useCallback((app: CatalogApp) => runExclusive(app.id, async () => {
    const release = app.currentRelease
    const host = state.host
    if (!release || !host) throw new Error(i18n.t('homeApps.errors.releaseUnavailable'))
    if (app.availability !== 'available') {
      throw new Error(i18n.t('homeApps.errors.unavailable'))
    }
    const scope = scopeForApp(app)
    const request: LocalAppInstallRequest = {
      appId: app.id,
      scope,
      version: release.version,
      downloadUrl: release.downloadUrl,
      checksum: release.checksum,
      sizeBytes: release.sizeBytes,
      platform: release.platform ?? host.platform,
      arch: release.arch ?? host.arch,
    }
    setState(current => ({
      ...current,
      statuses: {
        ...current.statuses,
        [app.id]: {
          appId: app.id,
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
      await window.electronAPI.localApps.install(request)
    } finally {
      await refreshRuntimeStatuses([app])
    }
  }), [refreshRuntimeStatuses, runExclusive, scopeForApp, state.host])

  const start = useCallback((app: CatalogApp): Promise<LocalAppStartResult> => (
    runExclusive(app.id, async () => {
      if (app.availability !== 'available') {
        throw new Error(i18n.t('homeApps.errors.unavailable'))
      }
      const scope = scopeForApp(app)
      setState(current => ({
        ...current,
        statuses: {
          ...current.statuses,
          [app.id]: {
            ...(current.statuses[app.id] ?? { appId: app.id }),
            status: 'starting',
          },
        },
      }))
      try {
        return await window.electronAPI.localApps.start(scope)
      } finally {
        await refreshRuntimeStatuses([app])
      }
    })
  ), [refreshRuntimeStatuses, runExclusive, scopeForApp])

  const stop = useCallback((app: CatalogApp) => runExclusive(app.id, async () => {
    await window.electronAPI.localApps.stop(scopeForApp(app))
    await refreshRuntimeStatuses([app])
  }), [refreshRuntimeStatuses, runExclusive, scopeForApp])

  const uninstall = useCallback((
    app: CatalogApp,
    preserveData: boolean,
  ) => runExclusive(app.id, async () => {
    await window.electronAPI.localApps.uninstall(scopeForApp(app), { preserveData })
    await refreshRuntimeStatuses([app])
  }), [refreshRuntimeStatuses, runExclusive, scopeForApp])

  const cancelInstall = useCallback(async (app: CatalogApp) => {
    await window.electronAPI.localApps.cancelInstall(scopeForApp(app))
    await refreshRuntimeStatuses([app])
  }, [refreshRuntimeStatuses, scopeForApp])

  const getLogs = useCallback((app: CatalogApp) => (
    window.electronAPI.localApps.getLogs(scopeForApp(app), { tail: 300 })
  ), [scopeForApp])

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
    refreshRuntimeStatuses,
  }
}
