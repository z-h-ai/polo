import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { HomeQuickAccessApp } from '@polo-ai/shared/config/home-quick-access'
import {
  MAX_HOME_QUICK_ACCESS_APPS,
} from '@polo-ai/shared/config/home-quick-access'
import { AppIcon } from './AppIcon'
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
import { POLO_APP_DEFINITION } from '../../../shared/tab-browser-types'
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
import { publishProductSpaceAppLaunch } from '@/lib/product-space-app-launch-handoff'

/**
 * Full "当前空间全部 Apps" projection: current Catalog Apps plus the
 * withdrawn tombstones the Catalog hook retains for explanation. A stopped
 * distribution must never disappear without a trace — installed members keep
 * a visible, non-launchable row with its frozen withdrawn status and, when
 * still installed, its uninstall entry. Same artifact identities appearing
 * in both lists collapse to the live entry; rows keep Catalog order.
 */
export function selectAllAppsForDisplay(
  catalog: AppCatalogCacheEntry | null,
): CatalogApp[] {
  if (!catalog) return []
  const identityKey = (app: CatalogApp): string => JSON.stringify([
    app.organizationId ?? null,
    app.catalogEntryId ?? app.id ?? null,
    app.artifactInstanceId ?? null,
    app.catalogVersion?.versionId ?? null,
    app.catalogVersion?.version ?? null,
  ])
  const merged = new Map<string, CatalogApp>()
  for (const app of [...catalog.apps, ...(catalog.withdrawnApps ?? [])]) {
    const key = identityKey(app)
    const existing = merged.get(key)
    if (!existing
      || (existing.availability === 'withdrawn' && app.availability !== 'withdrawn')
    ) {
      merged.set(key, app)
    }
  }
  return [...merged.values()].sort((left, right) => left.sortOrder - right.sortOrder)
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

type BundleAppLaunch = ResolveLaunchResponse & {
  subject: Extract<ResolveLaunchResponse['subject'], { kind: 'artifact_instance' }>
  delivery: Extract<ResolveLaunchResponse['delivery'], { kind: 'bundle' }>
}

function isBundleAppLaunch(launch: ResolveLaunchResponse): launch is BundleAppLaunch {
  return launch.subject.kind === 'artifact_instance'
    && launch.subject.artifactType === 'app'
    && launch.delivery.kind === 'bundle'
}

export function createEnterpriseWorkflowUrl(
  adminUrl: string,
  enterpriseId: string,
  workflow: 'members' | 'publishing',
): string {
  const url = workflow === 'members'
    ? new URL(`/enterprise/${encodeURIComponent(enterpriseId)}/members`, adminUrl)
    : new URL('/organization-apps', adminUrl)
  if (workflow === 'publishing') url.searchParams.set('organizationId', enterpriseId)
  return url.toString()
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
  /**
   * The ProductSpace context the CURRENT entries were hydrated (or last
   * mutated) for. `null` between a context switch and its hydration, so the
   * prune effect can never judge the previous context's entries against the
   * new context's Catalog and persist a wiped config.
   */
  const quickHydratedContextRef = useRef<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [installTarget, setInstallTarget] = useState<{
    app: CatalogApp
    launch: BundleAppLaunch
  } | null>(null)
  const installTargetApp = installTarget?.app ?? null
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)

  const activeProductSpace = catalog.productSpace?.activeProductSpace
  const spaceKind = activeProductSpace?.kind ?? null
  const quickContextKey = createHomeQuickAccessContextKey(
    catalog.productSpace?.productSpaceContextKey,
  )
  const quickContextKeyRef = useRef(quickContextKey)
  quickContextKeyRef.current = quickContextKey
  // Shared stale-write predicate for every quick-access write-back: a save
  // may only commit state while the SAME context and mutation generation are
  // still current.
  const isCurrentQuickMutation = useCallback((contextKey: string, generation: number): boolean => (
    quickContextKeyRef.current === contextKey
    && quickMutationGenerationRef.current === generation
  ), [])
  const scopeKeyForApp = catalog.scopeKeyForApp

  const availableApps = useMemo(
    () => (catalog.state.catalog?.apps ?? []).filter(
      app => app.availability === 'available',
    ),
    [catalog.state.catalog],
  )
  const allApps = useMemo(
    () => selectAllAppsForDisplay(catalog.state.catalog),
    [catalog.state.catalog],
  )
  const quickApps = useMemo(
    () => resolveHomeQuickAccessApps(quickEntries, availableApps, scopeKeyForApp),
    [availableApps, quickEntries, scopeKeyForApp],
  )

  useEffect(() => {
    // Fail-closed across space transitions: a ProductSpace identity change
    // resets the home view and closes in-place dialogs. The switch also
    // advances the mutation fence, so a still-in-flight save from the
    // previous context can never write its entries into this context.
    const contextKey = quickContextKey
    const generation = ++quickLoadGenerationRef.current
    quickMutationGenerationRef.current += 1
    const mutationGeneration = quickMutationGenerationRef.current
    quickHydratedContextRef.current = null
    setView('home')
    setManageOpen(false)
    setQuickEntries([])
    void loadHomeQuickAccess(contextKey)
      .then(entries => {
        // Apply only while BOTH the context key and the load/mutation
        // generations still match: quick-access slots may never move
        // backwards after a user change, and a stale context's hydration
        // result may never enter the current context's view.
        if (
          !isCurrentQuickMutation(contextKey, mutationGeneration)
          || quickLoadGenerationRef.current !== generation
        ) return
        quickHydratedContextRef.current = contextKey
        setQuickEntries(entries)
      })
      .catch(() => {
        // Quick access is non-critical; keep the section usable.
      })
  }, [isCurrentQuickMutation, quickContextKey])

  // Prune quick-access entries that no longer resolve to an available App
  // of the ACTIVE ProductSpace (space switch, withdrawal, stale ids). Runs
  // only for entries that were hydrated in THIS context — during the switch
  // commit the stale previous-context entries must never be pruned against
  // the new Catalog and persisted into the new context.
  useEffect(() => {
    if (quickHydratedContextRef.current !== quickContextKey) return
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
    const contextKey = quickContextKey
    setQuickEntries(pruned)
    void saveHomeQuickAccess(contextKey, pruned)
      .then(saved => {
        if (!isCurrentQuickMutation(contextKey, generation)) return
        quickHydratedContextRef.current = contextKey
        setQuickEntries(saved)
      })
      .catch(() => {
        // Persistence failure must not break the home section.
      })
  }, [availableApps, isCurrentQuickMutation, quickContextKey, quickEntries, scopeKeyForApp])

  const openPoloAssistant = () => {
    openApp(POLO_APP_DEFINITION)
  }

  const openEnterpriseWorkflow = async (workflow: 'members' | 'publishing') => {
    if (activeProductSpace?.kind !== 'enterprise') return
    try {
      const status = await window.electronAPI.adminGetStatus()
      if (
        !status.loggedIn
        || !status.adminUrl
        || status.userId !== catalog.state.catalog?.accountId
      ) throw new Error(t('homeApps.errors.staleContext'))
      await window.electronAPI.openUrl(createEnterpriseWorkflowUrl(
        status.adminUrl,
        activeProductSpace.enterpriseId,
        workflow,
      ))
    } catch (error) {
      toast.error(t('homeSpace.workflows.openFailed'), {
        description: error instanceof Error ? error.message : t('homeApps.errors.openGeneric'),
      })
    }
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
    const contextKey = quickContextKey
    quickHydratedContextRef.current = contextKey
    setQuickEntries(next)
    void saveHomeQuickAccess(contextKey, next)
      .then(saved => {
        // A context switch (or a newer mutation) invalidates this write-back:
        // the saved entries of the old context must never enter the new one.
        if (!isCurrentQuickMutation(contextKey, generation)) return
        setQuickEntries(saved)
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
      if (isBundleAppLaunch(launch)) {
        const installState = catalog.getInstallState(app)
        if (
          installState?.state !== 'installed'
          || installState.currentVersion !== launch.subject.version
        ) {
          setInstallTarget({ app, launch })
          return
        }
      }
      publishProductSpaceAppLaunch(accountId, launch)
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open', spaceKind),
      })
    }
  }

  const confirmInstall = async () => {
    const target = installTarget
    if (!target) return
    setInstallTarget(null)
    const { app } = target
    try {
      await catalog.installProductSpaceBundle(app)
      toast.success(t('homeApps.toast.installed', { name: app.name }))
      const accountId = catalog.state.catalog?.accountId
      if (!accountId) throw new Error(t('homeApps.errors.staleContext'))
      const launch = await catalog.resolveLaunch(app)
      if (!isBundleAppLaunch(launch)) {
        throw new Error(t('homeApps.errors.staleContext'))
      }
      publishProductSpaceAppLaunch(accountId, launch)
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install', spaceKind),
        })
      }
    }
  }

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstallProductSpaceBundle(app, preserveData)
      toast.success(t('homeApps.toast.uninstalled', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.uninstallTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'uninstall', spaceKind),
      })
    } finally {
      setPreserveData(true)
    }
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
        iconUrl: app.iconUrl,
        type: 'webapp' as const,
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
            enterpriseRole={activeProductSpace?.kind === 'enterprise'
              ? activeProductSpace.role
              : undefined}
            enterpriseAccessMode={activeProductSpace?.kind === 'enterprise'
              ? activeProductSpace.accessMode
              : undefined}
            onOpenMemberManagement={() => { void openEnterpriseWorkflow('members') }}
            onOpenCreatorPublishing={() => { void openEnterpriseWorkflow('publishing') }}
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
            scopeKeyForApp={catalog.scopeKeyForApp}
            getInstallState={catalog.getInstallState}
            onRefresh={() => { void catalog.sync(true) }}
            onOpen={(target) => { void openCatalogApp(target) }}
            onUninstall={setUninstallTarget}
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

            <div className="grid grid-cols-3 gap-[16px] sm:grid-cols-4 md:grid-cols-6">
              <AppIcon
                app={POLO_APP_DEFINITION}
                onOpen={openPoloAssistant}
                testId="home-quick-entry-polo"
              />
              {catalog.state.loading && !catalog.state.catalog ? (
                <div
                  className="col-span-2 flex min-h-28 items-center justify-center rounded-xl border border-foreground/10 sm:col-span-3 md:col-span-5"
                  data-testid="home-quick-access-loading"
                >
                  <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : catalog.state.errorCode && !catalog.state.catalog ? (
                <div className="col-span-2 flex min-h-32 flex-col items-center justify-center rounded-xl border border-foreground/10 px-6 text-center sm:col-span-3 md:col-span-5">
                  <Icons.CloudOff className="mb-2 size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">{t('homeApps.quick.loadFailed')}</p>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {catalogStateMessage(t, catalog.state.errorCode, 'error', spaceKind)}
                  </p>
                  <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => { void catalog.sync(true) }}>
                    {t('homeApps.actions.tryAgain')}
                  </Button>
                </div>
              ) : (
                <>
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
                </>
              )}
            </div>
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
              {installTargetApp && catalog.getInstallState(installTargetApp)?.state === 'installed'
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
          {installTargetApp && installTarget && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{installTarget.launch.subject.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, installTarget.launch.delivery.sizeBytes)}
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
              {installTargetApp && catalog.getInstallState(installTargetApp)?.state === 'installed'
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

    </main>
  )
}
