import { useEffect, useMemo, useRef, useState } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type {
  HomeQuickAccessApp,
} from '@polo-ai/shared/config/home-quick-access'
import {
  MAX_HOME_QUICK_ACCESS_APPS,
} from '@polo-ai/shared/config/home-quick-access'
import {
  createLocalAppScopeKey,
  type LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import { AppIcon } from './AppIcon'
import type { CatalogPrimaryAction } from './OrganizationAppCard'
import { AllAppsView } from './AllAppsView'
import { ManageHomeAppsDialog } from './ManageHomeAppsDialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppCatalog } from '@/hooks/useAppCatalog'
import { HomeSpaceContext } from '@/components/product-space/HomeSpaceContext'
import { useTabShell } from '@/context/TabShellContext'
import {
  POLO_APP_DEFINITION,
  type AppDefinition,
} from '../../../shared/tab-browser-types'
import {
  catalogStateMessage,
  getHomeAppErrorCode,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'
import {
  createHomeQuickAccessContextKey,
  loadHomeQuickAccess,
  resolveHomeQuickAccessApps,
  saveHomeQuickAccess,
  toggleHomeQuickAccessApp,
} from '@/lib/home-quick-access'
import { stageProductSpaceAppLaunch } from '@/lib/product-space-app-launch-handoff'

export function selectOrganizationAppsForDisplay(
  catalog: AppCatalogCacheEntry | null,
  statuses: Readonly<Record<string, LocalAppRuntimeStatus>>,
  statusErrorScopeKeys: Readonly<Record<string, true>> = {},
): CatalogApp[] {
  if (!catalog) return []
  const withdrawnWithLocalData = (catalog.withdrawnApps ?? []).filter(app => {
    if (app.deliveryMode !== 'local_bundle') return false
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: app.id,
    })
    const status = statuses[scopeKey]
    return Boolean(
      (status && status.status !== 'not_installed')
      || statusErrorScopeKeys[scopeKey],
    )
  })
  return [...catalog.apps, ...withdrawnWithLocalData]
    .sort((left, right) => left.sortOrder - right.sortOrder)
}

export function formatBytes(t: TFunction, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return t('homeApps.install.unknownSize')
  }
  const unitKeys = [
    'homeApps.install.sizeUnit.bytes',
    'homeApps.install.sizeUnit.kilobytes',
    'homeApps.install.sizeUnit.megabytes',
    'homeApps.install.sizeUnit.gigabytes',
  ] as const
  let size = sizeBytes
  let unit = 0
  while (size >= 1024 && unit < unitKeys.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${
    size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)
  } ${t(unitKeys[unit]!)}`
}

function catalogTabDefinition(
  accountId: string,
  app: CatalogApp,
  launch: ResolveLaunchResponse,
): AppDefinition {
  if (
    launch.subject.kind !== 'artifact_instance'
    || launch.subject.artifactType !== 'app'
    || launch.delivery.kind === 'built_in'
  ) {
    throw new Error('Invalid App launch handoff')
  }
  return {
    id: `catalog:${launch.productSpaceId}:${launch.subject.artifactInstanceId}`,
    name: app.name,
    // POO-47 consumes bundle handoffs and replaces this safe placeholder with
    // its runtime URL. Web Apps can already use the resolved URL directly.
    url: launch.delivery.kind === 'web_url' ? launch.delivery.url : 'about:blank',
    iconUrl: app.iconUrl,
    type: 'webapp',
    createdAt: 0,
    order: app.sortOrder,
    launchContext: {
      accountId,
      productSpaceId: launch.productSpaceId,
      catalogEntryId: launch.catalogEntryId,
      artifactInstanceId: launch.subject.artifactInstanceId,
      versionId: launch.subject.versionId,
      version: launch.subject.version,
      deliveryKind: launch.delivery.kind,
      resolvedAt: launch.resolvedAt,
      expiresAt: launch.expiresAt,
    },
  }
}

export function HomePage() {
  const { t } = useTranslation()
  const { openApp } = useTabShell()
  const catalog = useAppCatalog()
  const [view, setView] = useState<'home' | 'all-apps'>('home')
  const [quickEntries, setQuickEntries] = useState<HomeQuickAccessApp[]>([])
  const quickEntriesRef = useRef<HomeQuickAccessApp[]>([])
  quickEntriesRef.current = quickEntries
  const quickLoadGenerationRef = useRef(0)
  const quickMutationGenerationRef = useRef(0)
  const [manageOpen, setManageOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<{
    app: CatalogApp
    appConfigVersion: string
  } | null>(null)
  const installTargetApp = installTarget?.app ?? null
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  const [logsTarget, setLogsTarget] = useState<CatalogApp | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const logsRequestGenerationRef = useRef(0)
  const logsTargetScopeKeyRef = useRef<string | null>(null)

  const activeProductSpace = catalog.productSpace?.activeProductSpace
  const quickContextKey = createHomeQuickAccessContextKey(
    catalog.productSpace?.productSpaceContextKey,
  )
  const scopeKeyForApp = catalog.scopeKeyForApp

  const availableApps = useMemo(
    () => (catalog.state.catalog?.apps ?? []).filter(
      app => app.availability === 'available',
    ),
    [catalog.state.catalog],
  )
  const allApps = useMemo(
    () => selectOrganizationAppsForDisplay(
      catalog.state.catalog,
      catalog.state.statuses,
      catalog.state.statusErrorScopeKeys,
    ),
    [
      catalog.state.catalog,
      catalog.state.statusErrorScopeKeys,
      catalog.state.statuses,
    ],
  )
  const quickApps = useMemo(
    () => resolveHomeQuickAccessApps(quickEntries, availableApps, scopeKeyForApp),
    [availableApps, quickEntries, scopeKeyForApp],
  )

  useEffect(() => {
    // Fail-closed across space transitions: a ProductSpace identity change
    // resets the home view and closes in-place dialogs.
    const generation = ++quickLoadGenerationRef.current
    const mutationGeneration = quickMutationGenerationRef.current
    setView('home')
    setManageOpen(false)
    setQuickEntries([])
    void loadHomeQuickAccess(quickContextKey)
      .then(entries => {
        // A mutation in this same context fences the older hydration result:
        // quick-access slots may never move backwards after a user change.
        if (
          quickLoadGenerationRef.current === generation
          && quickMutationGenerationRef.current === mutationGeneration
        ) {
          setQuickEntries(entries)
        }
      })
      .catch(() => {
        // Quick access is non-critical; keep the section usable.
      })
  }, [quickContextKey])

  // Prune quick-access entries that no longer resolve to an available App
  // of the ACTIVE ProductSpace (space switch, withdrawal, stale ids).
  useEffect(() => {
    if (quickEntries.length === 0) return
    const availableIds = new Set<string>()
    for (const app of availableApps) {
      try {
        availableIds.add(scopeKeyForApp(app))
      } catch {
        continue
      }
    }
    const pruned = quickEntries.filter(entry => availableIds.has(entry.id))
    if (pruned.length === quickEntries.length) return
    quickMutationGenerationRef.current += 1
    const generation = quickMutationGenerationRef.current
    setQuickEntries(pruned)
    void saveHomeQuickAccess(quickContextKey, pruned)
      .then(saved => {
        if (quickMutationGenerationRef.current === generation) {
          setQuickEntries(saved)
        }
      })
      .catch(() => {
        // Persistence failure must not break the home section.
      })
  }, [availableApps, quickContextKey, quickEntries, scopeKeyForApp])

  useEffect(() => {
    // Logs are scoped to the exact account/space/App tuple. Advancing this
    // independent request generation prevents an older space context from
    // publishing into a later dialog.
    logsRequestGenerationRef.current += 1
    logsTargetScopeKeyRef.current = null
    setLogsTarget(null)
    setLogs('')
    setLogsLoading(false)
  }, [catalog.productSpace?.productSpaceContextKey])

  const openPoloAssistant = () => {
    openApp(POLO_APP_DEFINITION)
  }

  const toggleQuickAccess = (
    app: CatalogApp,
    scopeKey: string,
    enabled: boolean,
  ): boolean => {
    const { next, rejected } = toggleHomeQuickAccessApp(
      quickEntriesRef.current,
      scopeKey,
      enabled,
    )
    if (rejected) {
      toast.error(t('homeApps.manage.limitReached', {
        max: MAX_HOME_QUICK_ACCESS_APPS,
      }))
      return false
    }
    quickMutationGenerationRef.current += 1
    const generation = quickMutationGenerationRef.current
    setQuickEntries(next)
    void saveHomeQuickAccess(quickContextKey, next)
      .then(saved => {
        if (quickMutationGenerationRef.current === generation) {
          setQuickEntries(saved)
        }
      })
      .catch(() => {
        // Persistence failure must not break the home section.
      })
    return true
  }

  const openCatalogApp = async (app: CatalogApp) => {
    if (app.availability !== 'available') {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    try {
      const accountId = catalog.state.catalog?.accountId
      if (!accountId) throw new Error(t('homeApps.errors.staleContext'))
      const launch = await catalog.resolveLaunch(app)
      const definition = catalogTabDefinition(accountId, app, launch)
      stageProductSpaceAppLaunch(definition.id, accountId, launch)
      openApp(definition)
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open'),
      })
    }
  }

  const handlePrimaryAction = async (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => {
    if (action === 'install' || action === 'update') {
      const appConfigVersion = catalog.state.catalog?.appConfigVersion
      if (!appConfigVersion) {
        toast.error(t('homeApps.errors.staleContext'))
        return
      }
      setInstallTarget({ app, appConfigVersion })
      return
    }
    if (action === 'cancel') {
      try {
        await catalog.cancelInstall(app)
        toast.success(t('homeApps.toast.installCancelled', { name: app.name }))
      } catch (error) {
        toast.error(t('homeApps.errors.cancelInstall'), {
          description: homeAppOperationErrorText(t, error, 'cancel'),
        })
      }
      return
    }
    if (action === 'retry') {
      const status = catalog.getStatus(app)
      if (!status?.currentVersion) {
        const appConfigVersion = catalog.state.catalog?.appConfigVersion
        if (!appConfigVersion) {
          toast.error(t('homeApps.errors.staleContext'))
          return
        }
        setInstallTarget({ app, appConfigVersion })
        return
      }
    }
    if (action === 'open' || action === 'retry') {
      await openCatalogApp(app)
    }
  }

  const confirmInstall = async () => {
    const target = installTarget
    if (!target) return
    setInstallTarget(null)
    const { app, appConfigVersion } = target
    try {
      await catalog.install(app, appConfigVersion)
      toast.success(t('homeApps.toast.installed', { name: app.name }))
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install'),
        })
      }
    }
  }

  const handleStop = async (app: CatalogApp) => {
    try {
      await catalog.stop(app)
      toast.success(t('homeApps.toast.stopped', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.stopTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'stop'),
      })
    }
  }

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstall(app, preserveData)
      toast.success(t('homeApps.toast.uninstalled', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.uninstallTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'uninstall'),
      })
    } finally {
      setPreserveData(true)
    }
  }

  const showLogs = async (app: CatalogApp) => {
    const scopeKey = catalog.scopeKeyForApp(app)
    const requestGeneration = logsRequestGenerationRef.current + 1
    logsRequestGenerationRef.current = requestGeneration
    logsTargetScopeKeyRef.current = scopeKey
    const isCurrentRequest = () => (
      logsRequestGenerationRef.current === requestGeneration
      && logsTargetScopeKeyRef.current === scopeKey
    )
    setLogsTarget(app)
    setLogs('')
    setLogsLoading(true)
    try {
      const nextLogs = await catalog.getLogs(app)
      if (isCurrentRequest()) setLogs(nextLogs)
    } catch (error) {
      if (isCurrentRequest()) {
        setLogs(homeAppOperationErrorText(t, error, 'logs'))
      }
    } finally {
      if (isCurrentRequest()) setLogsLoading(false)
    }
  }

  const compatibleWithHost = (app: CatalogApp): boolean => {
    if (app.deliveryMode !== 'local_bundle') return true
    const release = app.currentRelease
    const host = catalog.state.host
    if (!release || !host) return true
    return (!release.platform || release.platform === host.platform)
      && (!release.arch || release.arch === host.arch)
  }

  const selectedQuickIds = useMemo(
    () => new Set(quickEntries.map(entry => entry.id)),
    [quickEntries],
  )

  const quickTileFor = (app: CatalogApp) => {
    const scopeKey = catalog.scopeKeyForApp(app)
    return {
      key: scopeKey,
      definition: {
        id: `catalog-tile:${scopeKey}`,
        name: app.name,
        url: 'about:blank',
        iconUrl: app.iconUrl,
        type: 'webapp' as const,
        createdAt: 0,
        order: app.sortOrder,
      },
    }
  }

  return (
    <main
      className="h-full min-h-0 overflow-y-auto bg-background px-4 pb-[72px] pt-6 text-foreground sm:px-7 sm:pt-8 lg:px-11 lg:pt-[46px]"
      data-testid="home-app-hub"
    >
      <div className="mx-auto w-full max-w-[1260px] space-y-[34px]">
        {catalog.productSpace && (
          <HomeSpaceContext
            spaceName={activeProductSpace?.name
              || t('homeApps.organization.current')}
            spaceKind={activeProductSpace?.kind ?? null}
            creatorCircles={catalog.creatorCircles}
            spaceKey={catalog.productSpace.productSpaceContextKey}
          />
        )}
        {view === 'all-apps' && catalog.productSpace ? (
          <AllAppsView
            spaceName={activeProductSpace?.name
              || t('homeApps.organization.current')}
            spaceKind={activeProductSpace?.kind ?? null}
            apps={allApps}
            loading={catalog.state.loading}
            refreshing={catalog.state.refreshing}
            warningCode={catalog.state.warningCode}
            errorCode={catalog.state.errorCode}
            offline={catalog.state.accessMode === 'offline'}
            statusErrorCode={catalog.state.statusErrorCode}
            statusLoadingScopeKeys={catalog.state.statusLoadingScopeKeys}
            statusErrorScopeKeys={catalog.state.statusErrorScopeKeys}
            scopeKeyForApp={catalog.scopeKeyForApp}
            getStatus={catalog.getStatus}
            compatibleWithHost={compatibleWithHost}
            onRefresh={() => { void catalog.sync(true) }}
            onRetryStatuses={() => { void catalog.refreshRuntimeStatuses() }}
            onPrimaryAction={(target, action) => {
              void handlePrimaryAction(target, action)
            }}
            onStop={(target) => { void handleStop(target) }}
            onUninstall={setUninstallTarget}
            onViewLogs={(target) => { void showLogs(target) }}
            onBack={() => setView('home')}
          />
        ) : (
          <section
            aria-labelledby="quick-access-heading"
            data-testid="home-quick-access-section"
          >
            <div className="mb-[18px] flex flex-col items-start justify-between gap-4 sm:flex-row">
              <div>
                <h1
                  id="quick-access-heading"
                  className="text-[22px] font-bold leading-[1.25] tracking-[-0.03em]"
                >
                  {t('homeApps.quick.title')}
                </h1>
                <p className="mt-[7px] text-[13px] leading-[1.5] text-muted-foreground">
                  {t('homeApps.quick.description', {
                    max: MAX_HOME_QUICK_ACCESS_APPS,
                  })}
                </p>
              </div>
              {catalog.productSpace && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setView('all-apps')}
                    data-testid="home-all-apps-open"
                  >
                    <Icons.LayoutGrid />
                    {t('homeApps.quick.allApps')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setManageOpen(true)}
                    data-testid="home-manage-quick-access"
                  >
                    <Icons.SlidersHorizontal />
                    {t('homeApps.quick.manage')}
                  </Button>
                </div>
              )}
            </div>

            {catalog.state.loading && !catalog.state.catalog ? (
              <div
                className="flex min-h-32 items-center justify-center rounded-xl border border-foreground/10"
                data-testid="home-quick-access-loading"
              >
                <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : catalog.state.errorCode && !catalog.state.catalog ? (
              <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-foreground/10 px-6 text-center">
                <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">
                  {t('homeApps.quick.loadFailed')}
                </p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  {catalogStateMessage(t, catalog.state.errorCode, 'error')}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => { void catalog.sync(true) }}
                >
                  {t('homeApps.actions.tryAgain')}
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-[16px] sm:grid-cols-4 md:grid-cols-6">
                <AppIcon
                  app={POLO_APP_DEFINITION}
                  onOpen={openPoloAssistant}
                  testId="home-quick-entry-polo"
                />
                {quickApps.map(app => {
                  const tile = quickTileFor(app)
                  return (
                    <AppIcon
                      key={tile.key}
                      app={tile.definition}
                      onOpen={() => { void openCatalogApp(app) }}
                      testId="home-quick-entry"
                    />
                  )
                })}
                {catalog.productSpace
                  && availableApps.length > 0
                  && quickApps.length < MAX_HOME_QUICK_ACCESS_APPS && (
                  <button
                    type="button"
                    className="titlebar-no-drag group flex min-w-0 flex-col items-center gap-3 rounded-lg border border-transparent p-3 text-center outline-none transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/10 hover:bg-foreground/4 hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setManageOpen(true)}
                    data-testid="home-quick-access-add"
                  >
                    <span className="flex h-[76px] w-[76px] items-center justify-center rounded-lg border border-dashed border-foreground/20 bg-foreground/3 shadow-xs transition-all duration-200 ease-out group-hover:scale-[1.04] group-hover:border-accent/45 group-hover:bg-accent/8">
                      <Icons.Plus className="h-8 w-8 text-foreground/55 group-hover:text-accent" strokeWidth={1.5} />
                    </span>
                    <span className="min-h-9 max-w-[112px] text-sm font-medium leading-[18px] text-foreground/70 group-hover:text-foreground">
                      {t('homeApps.quick.add')}
                    </span>
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      <ManageHomeAppsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        apps={availableApps}
        scopeKeyForApp={catalog.scopeKeyForApp}
        selectedIds={selectedQuickIds}
        maxSlots={MAX_HOME_QUICK_ACCESS_APPS}
        onToggle={toggleQuickAccess}
      />

      <Dialog open={Boolean(installTarget)} onOpenChange={(open) => {
        if (!open) setInstallTarget(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {installTargetApp && catalog.getStatus(installTargetApp)?.availableRelease
                ? t('homeApps.install.updateTitle', {
                    name: installTargetApp.name,
                  })
                : t('homeApps.install.installTitle', {
                    name: installTargetApp?.name ?? t('homeApps.appFallback'),
                  })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.install.description')}
            </DialogDescription>
          </DialogHeader>
          {installTargetApp?.currentRelease && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{installTargetApp.currentRelease.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, installTargetApp.currentRelease.sizeBytes)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('homeApps.install.permissions')}
                </p>
                {installTargetApp.permissions?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {installTargetApp.permissions.map(permission => (
                      <li key={permission} className="flex items-start gap-2">
                        <Icons.ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span>{permission}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    {t('homeApps.install.noPermissions')}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setInstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => { void confirmInstall() }}>
              {installTargetApp && catalog.getStatus(installTargetApp)?.availableRelease
                ? t('homeApps.actions.update')
                : t('homeApps.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => {
        if (!open) {
          setUninstallTarget(null)
          setPreserveData(true)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.uninstall.title', {
                name: uninstallTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.uninstall.description')}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-foreground/10 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preserveData}
              onChange={event => setPreserveData(event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                {t('homeApps.uninstall.keepData')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('homeApps.uninstall.keepDataDescription')}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setUninstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => { void confirmUninstall() }}>
              {t('homeApps.actions.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(logsTarget)} onOpenChange={(open) => {
        if (!open) {
          logsRequestGenerationRef.current += 1
          logsTargetScopeKeyRef.current = null
          setLogsTarget(null)
          setLogs('')
          setLogsLoading(false)
        }
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.logs.title', {
                name: logsTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.logs.description')}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[420px] min-h-40 overflow-auto rounded-lg bg-foreground/5 p-3 text-xs leading-relaxed">
            {logsLoading
              ? t('homeApps.logs.loading')
              : logs || t('homeApps.logs.empty')}
          </pre>
        </DialogContent>
      </Dialog>
    </main>
  )
}
