import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { useProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
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

/**
 * Full "当前空间全部 Apps" projection: current Catalog Apps plus the
 * withdrawn tombstones the Catalog hook retains for explanation. A stopped
 * distribution must never disappear without a trace — installed members keep
 * a visible, non-launchable row with its frozen withdrawn status and, when
 * still installed, its uninstall entry. Dedup uses the full stable Catalog
 * UI identity tuple (organizationId + catalogEntryId + artifactInstanceId):
 * one row per artifact instance, a version upgrade replaces the live row
 * instead of pairing it with a stale withdrawn row, and the same artifact
 * reissued under a DIFFERENT catalog entry keeps its live and withdrawn rows
 * distinct. The live entry wins a key collision and rows keep Catalog order.
 */
export function selectAllAppsForDisplay(
  catalog: AppCatalogCacheEntry | null,
): CatalogApp[] {
  if (!catalog) return []
  const identityKey = (app: CatalogApp): string => JSON.stringify([
    app.organizationId ?? null,
    app.catalogEntryId ?? app.id ?? null,
    app.artifactInstanceId ?? null,
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
  const launchHandoff = useProductSpaceAppLaunchHandoff()
  const catalog = useAppCatalog()
  const [view, setView] = useState<'home' | 'all-apps'>('home')
  const [quickEntries, setQuickEntries] = useState<HomeQuickAccessApp[]>([])
  /**
   * Quick-access transaction state. `quickEntries` (display) commits only
   * through the single-writer queue below; `quickIntentRef` is the
   * synchronous base every mutation builds on, `quickConfirmedRef` the last
   * persisted acknowledgement for precise suffix rollback.
   */
  const quickIntentRef = useRef<HomeQuickAccessApp[]>([])
  const quickConfirmedRef = useRef<HomeQuickAccessApp[]>([])
  const quickLoadGenerationRef = useRef(0)
  const quickMutationGenerationRef = useRef(0)
  /**
   * SINGLE-WRITER serialization for every quick-access disk write (pin,
   * manage toggle, prune). Tasks run strictly in enqueue order, so writes to
   * one persisted slot can never land out of order — a slow earlier save
   * completes before a later one STARTS. Context switches and unmount only
   * gate DISPLAY of a result; they never cancel or reorder queued writes.
   */
  const quickWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  /**
   * Hydration gate of the current context load: mutations enqueued before
   * the persisted collection loaded wait for it, so they build on the
   * stored entries instead of an empty intent (never wiping the stored
   * collection with an unpersisted first click).
   */
  const quickHydrationGateRef = useRef<{ contextKey: string; gate: Promise<boolean> } | null>(null)
  const quickMountedRef = useRef(false)
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
  const [showCirclesCard, setShowCirclesCard] = useState(false)
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

  /**
   * THE quick-access transaction primitive (pin, manage toggle and prune
   * all share it). Mutations are appended to the single-writer queue: each
   * task awaits the context's hydration gate, applies its change to the
   * synchronous intent, and persists IN ORDER. A successful save advances
   * the confirmed snapshot (display only while the same context+generation
   * is still current); a rejected save rolls the unconfirmed suffix back to
   * the last acknowledgement. A superseded context or unmount only gates
   * display — the in-order disk write is never cancelled or reordered.
   */
  const enqueueQuickMutation = useCallback((
    contextKey: string,
    apply: (entries: HomeQuickAccessApp[]) => {
      next: HomeQuickAccessApp[] | null
      rejected?: boolean
    },
  ): void => {
    const task = quickWriteQueueRef.current
      .catch(() => {})
      .then(async () => {
        const hydration = quickHydrationGateRef.current
        if (hydration && hydration.contextKey === contextKey) {
          const hydrated = await hydration.gate
          if (!hydrated) return
        }
        const { next, rejected } = apply(quickIntentRef.current)
        if (rejected || next === null) return
        const generation = ++quickMutationGenerationRef.current
        const saved = await saveHomeQuickAccess(contextKey, next)
        // Display gate only: a superseded context/generation never shows
        // this result, but its disk write already happened in queue order.
        if (
          quickMountedRef.current
          && isCurrentQuickMutation(contextKey, generation)
        ) {
          quickHydratedContextRef.current = contextKey
          quickIntentRef.current = saved
          quickConfirmedRef.current = saved
          setQuickEntries(saved)
        }
      })
      .catch(() => {
        // Save rejected: roll the unconfirmed suffix back to the last
        // persisted acknowledgement. The disk keeps its last in-order
        // write; the display rolls back only in the SAME context.
        if (quickContextKeyRef.current === contextKey) {
          quickIntentRef.current = quickConfirmedRef.current
        }
        if (
          quickMountedRef.current
          && quickContextKeyRef.current === contextKey
        ) {
          setQuickEntries(quickConfirmedRef.current)
        }
      })
    quickWriteQueueRef.current = task
  }, [isCurrentQuickMutation])
  // UI selection + quick-entry persistence use the collision-free stable
  // artifact identity key (account + space + entry + artifact instance), NOT
  // the runtime scope: a catalogEntryId reused across artifact instances
  // must keep its live row, withdrawn row, and quick-entry slot independent,
  // and an artifact swap must fail-closed drop the old shortcut instead of
  // silently re-binding it.
  const uiKeyForApp = catalog.uiIdentityKeyForApp

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
    () => resolveHomeQuickAccessApps(quickEntries, availableApps, uiKeyForApp),
    [availableApps, quickEntries, uiKeyForApp],
  )
  // Authoritative pinned identity keys: derived from the persisted quick
  // entries, never from local All Apps view state.
  const quickPinnedIds = useMemo(
    () => new Set(quickEntries.map(entry => entry.id)),
    [quickEntries],
  )
  // Home work cards render ONLY the persisted quick entries of the current
  // account + ProductSpace context, resolved against its Catalog. There is
  // deliberately NO first-run default curation: an explicitly empty (or
  // unpersisted) collection stays empty — across first mount, remounts and
  // A→B→A context round-trips — instead of silently surfacing Catalog apps
  // the member never pinned.
  const homeWorkCards = quickApps

  useEffect(() => {
    // Fail-closed across space transitions: a ProductSpace identity change
    // resets the home view and closes in-place dialogs. The switch also
    // advances the mutation fence, so a still-in-flight save from the
    // previous context can never DISPLAY its entries into this context (its
    // disk write keeps its in-queue order — it is never reordered).
    const contextKey = quickContextKey
    const generation = ++quickLoadGenerationRef.current
    quickMutationGenerationRef.current += 1
    const mutationGeneration = quickMutationGenerationRef.current
    quickHydratedContextRef.current = null
    quickIntentRef.current = []
    quickConfirmedRef.current = []
    let resolveGate!: (hydrated: boolean) => void
    const gate = new Promise<boolean>(resolve => { resolveGate = resolve })
    quickHydrationGateRef.current = { contextKey, gate }
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
        ) {
          resolveGate(false)
          return
        }
        quickHydratedContextRef.current = contextKey
        quickIntentRef.current = entries
        quickConfirmedRef.current = entries
        setQuickEntries(entries)
        resolveGate(true)
      })
      .catch(() => {
        // Quick access is non-critical; keep the section usable. Queued
        // mutations for this context fail closed on the gate.
        resolveGate(false)
      })
  }, [isCurrentQuickMutation, quickContextKey])

  useEffect(() => {
    quickMountedRef.current = true
    return () => {
      quickMountedRef.current = false
    }
  }, [])

  // Prune quick-access entries that no longer resolve to an available App
  // of the ACTIVE ProductSpace (space switch, withdrawal, stale ids). Runs
  // only for entries that were hydrated in THIS context — during the switch
  // commit the stale previous-context entries must never be pruned against
  // the new Catalog and persisted into the new context. It also requires an
  // AUTHORITATIVE Catalog snapshot to have been committed for this context:
  // before that (loading, catalog=null, failure, denied) the stored entries
  // are preserved untouched — pruning against an empty/unavailable view
  // would permanently destroy valid shortcuts.
  const catalogCommitted = catalog.state.catalog !== null
    && catalog.state.accessMode !== 'denied'
  useEffect(() => {
    if (quickHydratedContextRef.current !== quickContextKey) return
    if (!catalogCommitted) return
    if (quickEntries.length === 0) return
    const availableIds = new Set<string>()
    for (const app of availableApps) {
      try {
        availableIds.add(uiKeyForApp(app))
      } catch {
        continue
      }
    }
    const hasUnresolvable = quickEntries.some(entry => !availableIds.has(entry.id))
    if (!hasUnresolvable) return
    // Prune shares the same single-writer transaction primitive: the filter
    // re-runs against the intent at EXECUTION time, so a concurrent pin is
    // never clobbered, and a no-op second run persists nothing.
    enqueueQuickMutation(quickContextKey, entries => {
      const pruned = entries.filter(entry => availableIds.has(entry.id))
      if (pruned.length === entries.length) return { next: null }
      return { next: pruned }
    })
  }, [availableApps, catalogCommitted, enqueueQuickMutation, quickContextKey, quickEntries])

  const openPoloAssistant = () => {
    openApp(POLO_APP_DEFINITION)
  }


  /**
   * Ack-committed quick-access toggle (pin and manage-dialog both route
   * here) — a queued task on the SAME single-writer primitive as prune. The
   * toggle applies at EXECUTION time against the hydrated intent, so a
   * click before hydration can never wipe the stored collection.
   */
  const persistQuickToggle = useCallback((
    contextKey: string,
    scopeKey: string,
    enabled: boolean,
  ): boolean => {
    enqueueQuickMutation(contextKey, entries => {
      const { next, rejected } = toggleHomeQuickAccessApp(entries, scopeKey, enabled)
      if (rejected) {
        toast.error(t('homeApps.manage.limitReached', {
          max: MAX_HOME_QUICK_ACCESS_APPS,
        }))
        return { next: null, rejected: true }
      }
      return { next }
    })
    return true
  }, [enqueueQuickMutation, t])

  // 显示在首页: pin a catalog App into the home quick access — queued on the
  // same single-writer primitive as every other quick-access mutation.
  const pinApp = useCallback((app: CatalogApp) => {
    persistQuickToggle(quickContextKey, uiKeyForApp(app), true)
  }, [persistQuickToggle, quickContextKey, uiKeyForApp])

  // Authoritative committed-context lease for enterprise workflow jumps:
  // account (from the committed ProductSpaceContext authority — present even
  // while the Catalog snapshot is loading or failed) + enterprise + context
  // key + the MONOTONIC contextVersion (it increases on every committed
  // account/space change and never repeats, so an A→B→A round-trip that
  // restores account/enterprise/contextKey still fails the re-verification).
  interface EnterpriseWorkflowContextLease {
    accountId: string | undefined
    enterpriseId: string | null
    contextKey: string | undefined
    contextVersion: number | undefined
  }
  const liveLeaseRef = useRef<EnterpriseWorkflowContextLease>({
    accountId: undefined,
    enterpriseId: null,
    contextKey: undefined,
    contextVersion: undefined,
  })
  // The live lease is synced ONLY at the committed boundary (layout effect):
  // render — including concurrently discarded ProductSpace renders — never
  // writes the ref, so a committed A continuation always observes the truly
  // committed lease.
  useLayoutEffect(() => {
    liveLeaseRef.current = {
      accountId: catalog.productSpace?.accountId,
      enterpriseId: activeProductSpace?.kind === 'enterprise'
        ? activeProductSpace.enterpriseId
        : null,
      contextKey: catalog.productSpace?.productSpaceContextKey,
      contextVersion: catalog.productSpace?.contextVersion,
    }
  })

  // Click-time lease snapshot of the committed context: the adminGetStatus()
  // await must not outlive it. After the await, the snapshot is compared
  // against the committed live lease — any change to account, enterprise, or
  // the monotonic context lease fails closed, even when a round-trip returns
  // to the click-time identity.
  const openEnterpriseWorkflow = async (workflow: 'members' | 'publishing') => {
    if (activeProductSpace?.kind !== 'enterprise') return
    const clickLease: EnterpriseWorkflowContextLease = {
      accountId: catalog.productSpace?.accountId,
      enterpriseId: activeProductSpace.enterpriseId as string,
      contextKey: catalog.productSpace?.productSpaceContextKey,
      contextVersion: catalog.productSpace?.contextVersion,
    }
    try {
      const status = await window.electronAPI.adminGetStatus()
      const live = liveLeaseRef.current
      if (
        !status.loggedIn
        || !status.adminUrl
        || status.userId !== clickLease.accountId
        || live.accountId !== clickLease.accountId
        || live.enterpriseId !== clickLease.enterpriseId
        || live.contextKey !== clickLease.contextKey
        || live.contextVersion !== clickLease.contextVersion
      ) throw new Error(t('homeApps.errors.staleContext'))
      await window.electronAPI.openUrl(createEnterpriseWorkflowUrl(
        status.adminUrl,
        clickLease.enterpriseId ?? '',
        workflow,
      ))
    } catch (error) {
      toast.error(t('homeSpace.workflows.openFailed'), {
        description: error instanceof Error ? error.message : t('homeApps.errors.openGeneric'),
      })
    }
  }

  const toggleQuickAccess = (
    _app: CatalogApp,
    scopeKey: string,
    enabled: boolean,
  ): boolean => {
    // Ack-based commit, identical to pinApp: the dialog's `enabled` flag is
    // an intent until the persistence resolves; a reject or superseded
    // context/generation rolls the intent back to the last persisted
    // snapshot.
    return persistQuickToggle(quickContextKey, scopeKey, enabled)
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
      launchHandoff.publish(accountId, launch)
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
      launchHandoff.publish(accountId, launch)
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
    const scopeKey = uiKeyForApp(app)
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
            restricted={catalog.state.accessMode === 'denied'}
            pinnedIds={quickPinnedIds}
            identityKeyForApp={uiKeyForApp}
            getInstallState={catalog.getInstallState}
            circleCount={catalog.creatorCircles?.length ?? 0}
            onPin={pinApp}
            onRefresh={() => { void catalog.sync(true) }}
            onOpen={(target) => { void openCatalogApp(target) }}
            onUninstall={setUninstallTarget}
            onBack={() => setView('home')}
          />
        ) : (
          <div data-testid="home-quick-access-section">
            <div className="flex items-end justify-between gap-[24px]">
              <div>
                <h1 className="m-0 text-[36px] font-semibold leading-[1.08] tracking-[-0.05em]">
                  {t('homeApps.home.greeting')}
                </h1>
                <p className="mt-[13px] max-w-[690px] text-[15px] leading-[1.65] text-muted-foreground">
                  {t('homeApps.home.greetingLead', {
                    space: activeProductSpace?.name ?? t('homeApps.organization.current'),
                  })}
                </p>
              </div>
              {catalog.productSpace && activeProductSpace?.kind === 'personal' && (
                <button
                  type="button"
                  data-testid="home-circles-link"
                  onClick={() => setShowCirclesCard(value => !value)}
                  className="inline-flex min-h-[32px] items-center rounded-lg px-[10px] text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  {t('homeApps.home.circlesCount', { count: catalog.creatorCircles?.length ?? 0 })}
                </button>
              )}
            </div>

            {catalog.state.accessMode === 'denied' && (
              <div
                className="mt-[24px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
                data-testid="home-restricted-banner"
              >
                {t('homeApps.organization.accessError')}
              </div>
            )}

            {catalog.productSpace && activeProductSpace?.kind === 'enterprise' && (
              <HomeSpaceContext
                spaceName={activeProductSpace?.name
                  || t('homeApps.organization.current')}
                spaceKind="enterprise"
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

            <section className="mt-[34px]">
              <div className="mb-[18px] flex items-start justify-between gap-4">
                <div>
                  <h2 className="m-0 text-[20px] tracking-[-0.03em]">{t('homeApps.home.sectionTitle')}</h2>
                  <p className="mt-[6px] text-sm leading-[1.45] text-muted-foreground">
                    {t('homeApps.home.sectionDescription')}
                  </p>
                </div>
                {catalog.productSpace && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      data-testid="home-manage-quick-access"
                      onClick={() => setManageOpen(true)}
                      className="inline-flex min-h-[32px] items-center rounded-lg px-[10px] text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    >
                      {t('homeApps.quick.manage')}
                    </button>
                    <button
                      type="button"
                      data-testid="home-all-apps-open"
                      onClick={() => setView('all-apps')}
                      className="inline-flex min-h-[32px] items-center rounded-lg px-[10px] text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    >
                      {t('homeApps.quick.allApps')}
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
                {/* The fixed Polo assistant card always renders — loading and
                    error tiles only occupy the work-App slots beside it. */}
                <article
                  data-testid="home-quick-entry-polo"
                  onClick={openPoloAssistant}
                  className="flex min-h-[222px] max-[1080px]:min-h-[210px] cursor-pointer flex-col rounded-[17px] border border-foreground/10 bg-surface p-5 shadow-xs transition-shadow hover:shadow-minimal max-[1080px]:p-[18px]"
                >
                  <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] bg-accent/12 text-accent text-[17px]">✦</span>
                  <h3 className="m-0 text-base font-semibold">{t('homeApps.home.poloTitle')}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t('homeApps.home.poloSource')}</p>
                  <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
                    {t('homeApps.home.poloDescription')}
                  </p>
                  <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-[32px] rounded-lg border border-accent bg-accent px-3 text-xs font-semibold text-primary-foreground hover:bg-accent/90"
                      onClick={(event) => {
                        event.stopPropagation()
                        openPoloAssistant()
                      }}
                    >
                      {t('homeApps.home.openAssistant')}
                    </Button>
                  </div>
                </article>
                {catalog.state.loading && !catalog.state.catalog ? (
                  <div
                    className="flex min-h-[222px] max-[1080px]:min-h-[210px] items-center justify-center rounded-[17px] border border-foreground/10 bg-surface"
                    data-testid="home-quick-access-loading"
                  >
                    <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : catalog.state.errorCode && !catalog.state.catalog ? (
                  <div className="flex min-h-[222px] max-[1080px]:min-h-[210px] flex-col items-center justify-center rounded-[17px] border border-foreground/10 bg-surface px-6 text-center">
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
                    {homeWorkCards.map((app, index) => {
                      const running = catalog.getStatus(app)?.status === 'running'
                      const artGlyph = index % 2 === 0 ? '▣' : '▦'
                      return (
                        <article
                          key={uiKeyForApp(app)}
                          data-testid="home-quick-entry"
                          data-identity-key={uiKeyForApp(app)}
                          onClick={() => { void openCatalogApp(app) }}
                          className="flex min-h-[222px] max-[1080px]:min-h-[210px] cursor-pointer flex-col rounded-[17px] border border-foreground/10 bg-surface p-5 shadow-xs transition-shadow hover:shadow-minimal max-[1080px]:p-[18px]"
                        >
                          <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] bg-success/12 text-success text-[17px]">{artGlyph}</span>
                          <h3 className="m-0 text-base font-semibold">{app.name}</h3>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {app.sourceNames?.length ? app.sourceNames.join(' · ') : t('homeApps.allApps.unknownSource')}
                          </p>
                          <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
                            {app.description || t('homeApps.noDescription')}
                          </p>
                          <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
                            {running && (
                              <span className="inline-flex min-h-[20px] items-center gap-[5px] rounded-md bg-accent/12 px-[7px] py-[2px] text-[10px] text-accent before:block before:size-[5px] before:rounded-full before:bg-current">
                                {t('homeApps.status.running')}
                              </span>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-[32px] rounded-lg border-0 px-3 text-xs text-muted-foreground hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation()
                                void openCatalogApp(app)
                              }}
                            >
                              {t('common.open')}
                            </Button>
                          </div>
                        </article>
                      )
                    })}
                    {catalog.productSpace
                      && catalogCommitted
                      && homeWorkCards.length < MAX_HOME_QUICK_ACCESS_APPS && (
                      <button
                        type="button"
                        data-testid="home-quick-access-add"
                        onClick={() => setManageOpen(true)}
                        className="flex min-h-[222px] max-[1080px]:min-h-[210px] flex-col items-center justify-center gap-3 rounded-[17px] border border-dashed border-foreground/20 bg-transparent text-center text-muted-foreground hover:border-accent/45 hover:text-accent"
                      >
                        <Icons.Plus className="size-6" strokeWidth={1.5} />
                        <span className="text-xs">{t('homeApps.quick.add')}</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
            {catalog.productSpace && activeProductSpace?.kind === 'personal' && showCirclesCard && (
              <HomeSpaceContext
                spaceName={activeProductSpace?.name
                  || t('homeApps.organization.current')}
                spaceKind="personal"
                creatorCircles={catalog.creatorCircles}
                spaceKey={catalog.productSpace.productSpaceContextKey}
              />
            )}
          </div>
        )}
      </div>

      <ManageHomeAppsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        apps={availableApps}
        identityKeyForApp={uiKeyForApp}
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
