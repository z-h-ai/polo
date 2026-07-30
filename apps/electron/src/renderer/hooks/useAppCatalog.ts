import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gt, valid } from 'semver'
import { i18n } from '@polo-ai/shared/i18n'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import { getAppCatalogApps } from '@polo-ai/shared/admin/catalog-view'
import {
  createLocalAppScopeKey,
  normalizeLocalAppPermissions,
  type CatalogLocalAppScope,
  type LocalAppRuntimeStatus,
  type LocalAppStartResult,
} from '@polo-ai/shared/protocol'
import { useOptionalOrganizationContext } from '@/context/OrganizationContext'
import {
  emitAdminAuthFailure,
  normalizeAdminError,
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
  accessMode: 'online' | 'offline' | 'denied' | null
  statuses: Record<string, LocalAppRuntimeStatus>
  host: {
    platform: 'darwin' | 'win32' | 'linux'
    arch: 'arm64' | 'x64'
  } | null
}

export const CATALOG_RUNTIME_STATUS_LIMIT = 10_000
export const BUSY_RUNTIME_STATUS_LIMIT = 32
export const CATALOG_SYNC_SUPERSEDED_RETRY_LIMIT = 2

const CATALOG_ACCESS_DENIED_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'ACCOUNT_DISABLED',
  'INVALID_TOKEN',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'MEMBERSHIP_REMOVED',
  'MEMBERSHIP_SUSPENDED',
  'ORGANIZATION_UNAVAILABLE',
  'NOT_FOUND',
])

function isCatalogAccessDenied(
  errorCode: string | null | undefined,
  status?: number,
): boolean {
  return (
    (typeof errorCode === 'string' && CATALOG_ACCESS_DENIED_CODES.has(errorCode))
    || status === 401
    || status === 403
  )
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
    warningCode: null,
    errorCode: null,
    statusErrorCode: null,
    statusErrorScopeKeys: {},
    accessMode: null,
    statuses: {},
    host: null,
  })
  const catalogRef = useRef<AppCatalogCacheEntry | null>(null)
  const contextKeyRef = useRef<string | null>(organizationContextKey)
  contextKeyRef.current = organizationContextKey
  const syncGenerationRef = useRef(0)
  const operationsRef = useRef(new Map<string, Promise<unknown>>())
  const cancellationOperationsRef = useRef(new Map<string, Promise<void>>())

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

  const refreshRuntimeStatuses = useCallback(async (
    apps?: CatalogApp[],
    busyScopeKeys?: ReadonlySet<string>,
    suppliedSnapshot?: ContextSnapshot,
    refreshMode: 'replace' | 'merge' = (
      apps === undefined && busyScopeKeys === undefined ? 'replace' : 'merge'
    ),
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
        }))
      }
      return
    }
    const snapshot: ContextSnapshot = suppliedSnapshot ?? {
      contextKey,
      generation: syncGenerationRef.current,
      catalog,
    }
    if (!isCurrentSnapshot(snapshot)) return

    const selectedApps = selectRuntimeStatusApps(
      apps ?? getAppCatalogApps(catalog),
      busyScopeKeys,
      app => createLocalAppScopeKey(scopeForCatalogApp(catalog, app)),
    )
    if (selectedApps.length === 0) {
      if (refreshMode === 'replace' && isCurrentSnapshot(snapshot)) {
        setState(current => ({
          ...current,
          statuses: {},
          statusErrorCode: null,
          statusErrorScopeKeys: {},
        }))
      }
      return
    }

    const scopes = selectedApps.map(app => scopeForCatalogApp(catalog, app))
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
    if (!isCurrentSnapshot(snapshot)) return

    setState(current => {
      const nextStatuses: Record<string, LocalAppRuntimeStatus> = (
        refreshMode === 'merge' ? { ...current.statuses } : {}
      )
      for (const [scopeKey, status] of successfulStatuses) {
        nextStatuses[scopeKey] = status
      }
      for (const scopeKey of failedScopeKeys) {
        const previousStatus = current.statuses[scopeKey]
        if (previousStatus) {
          nextStatuses[scopeKey] = previousStatus
        }
      }
      const nextStatusErrorScopeKeys: Record<string, true> = (
        refreshMode === 'merge' ? { ...current.statusErrorScopeKeys } : {}
      )
      for (const scopeKey of successfulStatuses.keys()) {
        delete nextStatusErrorScopeKeys[scopeKey]
      }
      for (const scopeKey of failedScopeKeys) {
        nextStatusErrorScopeKeys[scopeKey] = true
      }
      const hasStatusErrors = Object.keys(nextStatusErrorScopeKeys).length > 0
      return {
        ...current,
        statuses: nextStatuses,
        statusErrorCode: hasStatusErrors ? 'status_read_failed' : null,
        statusErrorScopeKeys: nextStatusErrorScopeKeys,
      }
    })
  }, [isCurrentSnapshot])

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
        warningCode: null,
        errorCode: null,
        statusErrorCode: null,
        statusErrorScopeKeys: {},
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
      errorCode: null,
    }))
    try {
      let result = await window.electronAPI.adminSyncAppCatalog(
        organization.activeOrganizationId,
        { force },
      )
      for (
        let retry = 0;
        !result.success
          && result.errorCode === 'REQUEST_SUPERSEDED'
          && retry < CATALOG_SYNC_SUPERSEDED_RETRY_LIMIT;
        retry += 1
      ) {
        if (
          generation !== syncGenerationRef.current
          || contextKeyRef.current !== contextKey
        ) return
        result = await window.electronAPI.adminSyncAppCatalog(
          organization.activeOrganizationId,
          { force },
        )
      }
      if (
        generation !== syncGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      if (!result.success) {
        emitAdminAuthFailure(normalizeAdminError(result))
        if (isCatalogAccessDenied(result.errorCode, result.status)) {
          catalogRef.current = null
          setState(current => ({
            ...current,
            catalog: null,
            loading: false,
            refreshing: false,
            warningCode: null,
            errorCode: result.errorCode || 'request_failed',
            statusErrorCode: null,
            statusErrorScopeKeys: {},
            accessMode: 'denied',
            statuses: {},
          }))
          return
        }
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          errorCode: result.errorCode || 'request_failed',
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
        warningCode: result.warningCode ?? null,
        errorCode: null,
        accessMode: result.accessMode,
      }))
      await refreshRuntimeStatuses(
        getAppCatalogApps(result.catalog),
        undefined,
        snapshot,
        'replace',
      )
    } catch (error) {
      if (
        generation !== syncGenerationRef.current
        || contextKeyRef.current !== contextKey
      ) return
      const errorCode = getHomeAppErrorCode(error) ?? 'request_failed'
      if (isCatalogAccessDenied(errorCode)) {
        catalogRef.current = null
        setState(current => ({
          ...current,
          catalog: null,
          loading: false,
          refreshing: false,
          warningCode: null,
          errorCode,
          statusErrorCode: null,
          statusErrorScopeKeys: {},
          accessMode: 'denied',
          statuses: {},
        }))
      } else {
        setState(current => ({
          ...current,
          loading: false,
          refreshing: false,
          errorCode,
        }))
      }
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
    cancellationOperationsRef.current.clear()
    catalogRef.current = null
    setState(current => ({
      ...current,
      catalog: null,
      loading: Boolean(organizationContextKey),
      refreshing: false,
      warningCode: null,
      errorCode: null,
      statusErrorCode: null,
      statusErrorScopeKeys: {},
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
      void refreshRuntimeStatuses(undefined, busyKeys, undefined, 'merge')
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

  const install = useCallback((
    app: CatalogApp,
    confirmedAppConfigVersion: string,
  ) => {
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
        await window.electronAPI.localApps.install({
          scope,
          appConfigVersion: confirmedAppConfigVersion,
          permissions: normalizeLocalAppPermissions(app.permissions),
          release: {
            version: release.version,
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
  ])

  const stop = useCallback((app: CatalogApp) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.stop(scope)
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
    })
  }, [currentSnapshotForApp, refreshRuntimeStatuses, requireCurrent, runExclusive])

  const uninstall = useCallback((app: CatalogApp, preserveData: boolean) => {
    const snapshot = currentSnapshotForApp(app)
    const scope = scopeForCatalogApp(snapshot.catalog, app)
    const scopeKey = createLocalAppScopeKey(scope)
    return runExclusive(scopeKey, async () => {
      await window.electronAPI.localApps.uninstall(scope, { preserveData })
      requireCurrent(snapshot)
      await refreshRuntimeStatuses([app], undefined, snapshot, 'merge')
    })
  }, [currentSnapshotForApp, refreshRuntimeStatuses, requireCurrent, runExclusive])

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
    const result = await window.electronAPI.localApps.getLogs(
      scopeForCatalogApp(snapshot.catalog, app),
      { tail: 300 },
    )
    requireCurrent(snapshot)
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
    resolveRemoteUrl,
    getStatus,
    scopeForApp,
    scopeKeyForApp,
    refreshRuntimeStatuses,
  }
}
