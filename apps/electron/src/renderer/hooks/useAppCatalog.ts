import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
} from '@polo-ai/shared/admin'
import type {
  LocalAppInstallRequest,
  LocalAppRuntimeStatus,
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message) return message
  }
  return 'The local app operation failed.'
}

function numericVersionParts(version: string): number[] | null {
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

export function isNewerCatalogVersion(available: string, installed: string): boolean {
  const left = numericVersionParts(available)
  const right = numericVersionParts(installed)
  if (!left || !right) return false
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta > 0
  }
  return false
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

  const refreshRuntimeStatuses = useCallback(async (apps?: CatalogApp[]) => {
    const bundleApps = (apps ?? catalogRef.current?.apps ?? [])
      .filter(app => app.deliveryMode === 'local_bundle')
    if (bundleApps.length === 0) {
      setState(current => ({ ...current, statuses: {} }))
      return
    }
    const statuses = await Promise.all(bundleApps.map(async app => {
      try {
        return await window.electronAPI.localApps.getRuntimeStatus(app.id)
      } catch {
        return {
          appId: app.id,
          status: 'not_installed' as const,
        }
      }
    }))
    setState(current => ({
      ...current,
      statuses: Object.fromEntries(statuses.map(status => [status.appId, status])),
    }))
  }, [])

  const publishAvailableUpdates = useCallback(async (
    catalog: AppCatalogCacheEntry,
  ) => {
    const installed = await window.electronAPI.localApps.getInstalledApps()
    const installedById = new Map(installed.map(app => [app.appId, app]))
    await Promise.allSettled(catalog.apps.map(async app => {
      const installedApp = installedById.get(app.id)
      const release = app.currentRelease
      if (
        app.deliveryMode !== 'local_bundle'
        || !installedApp
        || !release
      ) {
        return
      }
      const available = (
        app.availability !== 'withdrawn'
        && isNewerCatalogVersion(release.version, installedApp.currentVersion)
      )
        ? release
        : null
      await window.electronAPI.localApps.setAvailableRelease(app.id, available)
    }))
  }, [])

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
    .sort()
    .join(','), [state.statuses])

  useEffect(() => {
    if (!busyAppIds) return
    const interval = window.setInterval(() => {
      void refreshRuntimeStatuses()
    }, 500)
    return () => window.clearInterval(interval)
  }, [busyAppIds, refreshRuntimeStatuses])

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
    if (!release || !host) throw new Error('Release or device information is unavailable.')
    if (app.availability === 'withdrawn') throw new Error('This app is no longer available.')
    const request: LocalAppInstallRequest = {
      appId: app.id,
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
      await refreshRuntimeStatuses()
    }
  }), [refreshRuntimeStatuses, runExclusive, state.host])

  const start = useCallback((app: CatalogApp): Promise<LocalAppStartResult> => (
    runExclusive(app.id, async () => {
      if (app.availability === 'withdrawn') {
        throw new Error('This app was withdrawn by your organization.')
      }
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
        return await window.electronAPI.localApps.start(app.id)
      } finally {
        await refreshRuntimeStatuses()
      }
    })
  ), [refreshRuntimeStatuses, runExclusive])

  const stop = useCallback((appId: string) => runExclusive(appId, async () => {
    await window.electronAPI.localApps.stop(appId)
    await refreshRuntimeStatuses()
  }), [refreshRuntimeStatuses, runExclusive])

  const uninstall = useCallback((
    appId: string,
    preserveData: boolean,
  ) => runExclusive(appId, async () => {
    await window.electronAPI.localApps.uninstall(appId, { preserveData })
    await refreshRuntimeStatuses()
  }), [refreshRuntimeStatuses, runExclusive])

  const cancelInstall = useCallback(async (appId: string) => {
    await window.electronAPI.localApps.cancelInstall(appId)
    await refreshRuntimeStatuses()
  }, [refreshRuntimeStatuses])

  const getLogs = useCallback((appId: string) => (
    window.electronAPI.localApps.getLogs(appId, { tail: 300 })
  ), [])

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
