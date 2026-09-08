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

/**
 * MODULE-LEVEL per-context quick-access writer registry. Every context key
 * owns an INDEPENDENT single-writer queue, hydration gate and transaction
 * baseline (intent/confirmed). The lifetime is bound to the CONTEXT, not to
 * any HomePage mount:
 *
 * - a durable acknowledgement always advances its OWN context's baseline,
 *   even while another context is displayed or the component is unmounted —
 *   only the React UI update is gated by the current context + mount;
 * - a hung save in context A never blocks context B (separate queues);
 * - an immediate remount rejoins the SAME writer — no second racing queue;
 * - queued mutations wait for the context's hydration gate, so they build
 *   on the persisted collection instead of an empty intent;
 * - a rejected save rolls the unconfirmed suffix of THAT context back to
 *   its last acknowledgement.
 *
 * Cleanup: idle (busy===0) writers of non-active contexts are swept. Sweeping
 * never loses pending durable writes, and a swept baseline is re-derived
 * from the persisted store on the next activation via the hydration gate.
 */
interface HomeQuickContextWriter {
  queue: Promise<void>
  /** Queued-but-unsettled mutation tasks. */
  busy: number
  /** Mount ids currently owning this context (multiple mounts allowed). */
  owners: Set<number>
  /**
   * Live mount notification channels: hydration, persisted acks and
   * rollbacks are BROADCAST to every owner so all simultaneous mounts of a
   * context display the same confirmed baseline.
   */
  subscribers: Map<number, (entries: HomeQuickAccessApp[]) => void>
  gate: Promise<boolean>
  resolveGate: (hydrated: boolean) => void
  hydrated: boolean
  /** True while an activation load is still in flight. */
  hydrating: boolean
  /** Monotonic activation token: only the CURRENT attempt may settle state. */
  activationToken: number
  /** Observable bounded-retry counter for the activation load. */
  hydrationAttempts: number
  intent: HomeQuickAccessApp[]
  confirmed: HomeQuickAccessApp[]
}

const homeQuickWriters = new Map<string, HomeQuickContextWriter>()
let nextHomeQuickMountId = 0
let homeQuickActivationSequence = 0
/** Bounded hydration retries while owners remain (initial + 1 retry). */
const MAX_HYDRATION_ATTEMPTS = 2

function getHomeQuickWriter(contextKey: string): HomeQuickContextWriter {
  let writer = homeQuickWriters.get(contextKey)
  if (!writer) {
    let resolveGate!: (hydrated: boolean) => void
    const gate = new Promise<boolean>(resolve => { resolveGate = resolve })
    writer = {
      queue: Promise.resolve(),
      busy: 0,
      owners: new Set<number>(),
      subscribers: new Map<number, (entries: HomeQuickAccessApp[]) => void>(),
      gate,
      resolveGate,
      hydrated: false,
      hydrating: false,
      activationToken: 0,
      hydrationAttempts: 0,
      intent: [],
      confirmed: [],
    }
    homeQuickWriters.set(contextKey, writer)
  }
  return writer
}

/**
 * Cleanup: a writer is dropped ONLY when no mount owns it, no mutation task
 * is pending AND no hydration is in flight. Sweeping therefore can never
 * delete a writer another mount still uses, never lose pending durable
 * writes, and never interrupt an activation load; a swept baseline is
 * re-derived from the persisted store on the next activation.
 */
function sweepHomeQuickWriters(): void {
  for (const [key, writer] of homeQuickWriters) {
    if (writer.owners.size === 0 && writer.busy === 0 && !writer.hydrating) {
      homeQuickWriters.delete(key)
    }
  }
}

/** Broadcast one confirmed snapshot to every live owner of the writer. */
function notifyHomeQuickSubscribers(
  writer: HomeQuickContextWriter,
  entries: HomeQuickAccessApp[],
): void {
  for (const notify of writer.subscribers.values()) {
    notify(entries)
  }
}

/** Test-only: drop every writer (tests reset the persisted store too). */
export function __resetHomeQuickWritersForTests(): void {
  homeQuickWriters.clear()
}

/** Test-only: number of retained per-context writers (bounded-registry proof). */
export function __homeQuickWritersCountForTests(): number {
  return homeQuickWriters.size
}

/** Test-only: subscriber/owner/busy snapshot of one writer. */
export function __homeQuickWriterStatsForTests(contextKey: string): {
  owners: number
  subscribers: number
  busy: number
  hydrated: boolean
} | null {
  const writer = homeQuickWriters.get(contextKey)
  if (!writer) return null
  return {
    owners: writer.owners.size,
    subscribers: writer.subscribers.size,
    busy: writer.busy,
    hydrated: writer.hydrated,
  }
}

/**
 * Test-only EVENT-DRIVEN barrier: resolves after the context writer's
 * hydration gate has settled and every queued mutation task has finished —
 * never after an elapsed-time wait. Resolves `false` when work is still
 * pending (busy tasks or an in-flight activation), so tests can assert a
 * deterministic settled lifecycle before negative persistence expectations.
 */
export function __homeQuickWriterSettledForTests(contextKey: string): Promise<boolean> {
  const writer = homeQuickWriters.get(contextKey)
  if (!writer) return Promise.resolve(true)
  return writer.gate
    .catch(() => undefined)
    .then(() => writer.queue)
    .then(() => writer.busy === 0 && !writer.hydrating)
}

export function HomePage() {
  const { t } = useTranslation()
  const { openApp } = useTabShell()
  const launchHandoff = useProductSpaceAppLaunchHandoff()
  const catalog = useAppCatalog()
  const [view, setView] = useState<'home' | 'all-apps'>('home')
  const [quickEntries, setQuickEntries] = useState<HomeQuickAccessApp[]>([])
  /**
   * Display fence for hydration results: a load that started for context X
   * must never display into context Y that was switched to afterwards. The
   * TRANSACTION baseline it advances belongs to the per-context writer (see
   * the module-level registry) and is context-scoped anyway.
   */
  const quickMountedRef = useRef(false)
  /** This mount's registry identity (owner token in the writer registry). */
  const homeQuickMountIdRef = useRef(0)
  if (homeQuickMountIdRef.current === 0) {
    homeQuickMountIdRef.current = ++nextHomeQuickMountId
  }
  /** The context key this mount currently owns in the registry. */
  const ownedHomeQuickContextKeyRef = useRef<string | null>(null)
  /**
   * The ProductSpace context the CURRENT entries were hydrated (or last
   * mutated) for. `null` between a context switch and its hydration, so the
   * prune effect can never judge the previous context's entries against the
   * new context's Catalog and persist a wiped config.
   */
  const quickHydratedContextRef = useRef<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  // The frozen assistant-card Skill count is deliberately omitted: the only
  // Skill store reachable from Home is the process-global workspace
  // skillsAtom, which is not keyed by account/ProductSpace/owner epoch — a
  // target-scope first commit could display the previous scope's count
  // (R39 review). It returns to the frozen neutral "Polo 内置" until a
  // scope-keyed authoritative source exists.
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
  /**
   * THE quick-access transaction primitive (pin, manage toggle and prune
   * all share it). Mutations are appended to the CONTEXT'S OWN single-writer
   * queue: each task awaits that context's hydration gate, applies its
   * change to the context's synchronous intent, and persists IN ORDER. A
   * successful save advances the context's durable baseline UNCONDITIONALLY —
   * only the React UI update is gated by the current context + mount — and a
   * rejected save rolls that context's unconfirmed suffix back to its last
   * acknowledgement. A hung save in one context never blocks another.
   */
  const enqueueQuickMutation = useCallback((
    contextKey: string,
    apply: (entries: HomeQuickAccessApp[]) => {
      next: HomeQuickAccessApp[] | null
      rejected?: boolean
    },
  ): void => {
    const writer = getHomeQuickWriter(contextKey)
    writer.busy += 1
    const task = writer.queue
      .catch(() => {})
      .then(async () => {
        const hydrated = await writer.gate
        if (!hydrated) {
          // HYDRATION LOST: the mutation must NOT be silently dropped. A
          // queued task that could never build on a hydrated baseline takes
          // the visible error path (rollback broadcast + toast) — no pseudo
          // acks.
          toast.error(t('homeApps.quick.loadFailed'))
          throw new Error('hydration unavailable')
        }
        const { next, rejected } = apply(writer.intent)
        if (rejected || next === null) return
        const saved = await saveHomeQuickAccess(contextKey, next)
        // Durable baseline: advances for THIS context regardless of which
        // context is displayed or whether the component is mounted — then
        // BROADCASTS to every live owner of the context.
        writer.intent = saved
        writer.confirmed = saved
        notifyHomeQuickSubscribers(writer, saved)
      })
      .catch(() => {
        // Save rejected (or hydration lost): roll THIS context's unconfirmed
        // suffix back to its last persisted acknowledgement and broadcast
        // the rollback so every live mount converges on the same state.
        writer.intent = writer.confirmed
        notifyHomeQuickSubscribers(writer, writer.confirmed)
      })
      .finally(() => {
        writer.busy -= 1
        // The final owner may have unmounted while this task was in flight:
        // once busy reaches 0 the writer is sweepable.
        sweepHomeQuickWriters()
      })
    writer.queue = task
  }, [t])
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
    // resets the home view and closes in-place dialogs. The DISPLAY is
    // switched to the new context; the OLD context's writer keeps owning its
    // in-flight writes and advances its own baseline independently.
    const contextKey = quickContextKey
    // Ownership transfer for THIS mount: release the previously owned
    // context's writer, acquire the new one. Other mounts' ownership is
    // untouched.
    const mountId = homeQuickMountIdRef.current
    const previousOwned = ownedHomeQuickContextKeyRef.current
    if (previousOwned !== null && previousOwned !== contextKey) {
      const previousWriter = homeQuickWriters.get(previousOwned)
      previousWriter?.owners.delete(mountId)
      previousWriter?.subscribers.delete(mountId)
    }
    const writer = getHomeQuickWriter(contextKey)
    writer.owners.add(mountId)
    ownedHomeQuickContextKeyRef.current = contextKey
    quickHydratedContextRef.current = null
    setView('home')
    setManageOpen(false)
    setQuickEntries([])
    // Every mount of the context subscribes: hydration, persisted acks and
    // rollbacks broadcast to ALL live owners, so simultaneous mounts stay in
    // lockstep on the shared confirmed baseline.
    writer.subscribers.set(mountId, entries => {
      if (
        quickMountedRef.current
        && quickContextKeyRef.current === contextKey
      ) {
        quickHydratedContextRef.current = contextKey
        setQuickEntries(entries)
      }
    })
    if (writer.hydrated) {
      // Same-context remount or A→B→A: the SHARED writer already holds the
      // transaction baseline — display it without a second racing queue.
      setQuickEntries(writer.confirmed)
      quickHydratedContextRef.current = contextKey
      sweepHomeQuickWriters()
      return
    }
    // Fresh activation for THIS mount: only ONE load may be in flight per
    // context (a second mount joining during hydration awaits the SAME gate
    // and displays the shared baseline). Every mount waits for the gate and
    // displays from the baseline through its own state setter.
    //
    // SINGLE TERMINAL ACTIVATION LOOP: the initial attempt and its bounded
    // retry live inside ONE async loop with ONE terminal finally, guarded by
    // an activation epoch. The stable deferred gate is created once per
    // activation and resolves exactly once at the terminal outcome. The
    // loop keeps `hydrating` true across attempts — a third owner joining
    // mid-retry joins the SAME activation instead of starting a duplicate.
    // All stale callbacks / context switches / owner changes fail closed on
    // the activation epoch.
    if (!writer.hydrating) {
      writer.hydrating = true
      writer.hydrationAttempts = 0
      let resolveGate!: (hydrated: boolean) => void
      writer.gate = new Promise<boolean>(resolve => { resolveGate = resolve })
      writer.resolveGate = resolveGate
      const activationEpoch = ++homeQuickActivationSequence
      writer.activationToken = activationEpoch
      void (async (): Promise<void> => {
        try {
          for (let attempt = 1; attempt <= MAX_HYDRATION_ATTEMPTS; attempt++) {
            writer.hydrationAttempts = attempt
            try {
              const entries = await loadHomeQuickAccess(contextKey)
              if (writer.activationToken !== activationEpoch) return
              // Terminal SUCCESS: the baseline ALWAYS advances for this
              // context, then BROADCASTS to every live owner.
              writer.intent = entries
              writer.confirmed = entries
              writer.hydrated = true
              writer.resolveGate(true)
              notifyHomeQuickSubscribers(writer, entries)
              return
            } catch {
              if (writer.activationToken !== activationEpoch) return
              if (attempt === MAX_HYDRATION_ATTEMPTS || writer.owners.size === 0) {
                // Terminal FAILURE: the gate resolves FALSE exactly once so
                // queued mutations take their VISIBLE failure path (rollback
                // broadcast + toast) — never a silent pseudo-ack.
                writer.resolveGate(false)
                return
              }
              // Bounded observable retry — SAME gate, same activation; the
              // loop keeps `hydrating` true so joining owners ride along.
            }
          }
        } finally {
          // ONE terminal cleanup for the WHOLE activation: only the current
          // epoch may clear the in-flight flag or sweep.
          if (writer.activationToken === activationEpoch) {
            writer.hydrating = false
            sweepHomeQuickWriters()
          }
        }
      })()
    }
    sweepHomeQuickWriters()
  }, [quickContextKey])

  useEffect(() => {
    const mountId = homeQuickMountIdRef.current
    quickMountedRef.current = true
    return () => {
      quickMountedRef.current = false
      // Release ONLY this mount's ownership and notification channel:
      // another live mount sharing a context keeps its writer (gate,
      // baseline, queue, remaining subscribers) fully intact.
      const owned = ownedHomeQuickContextKeyRef.current
      if (owned !== null) {
        const writer = homeQuickWriters.get(owned)
        writer?.owners.delete(mountId)
        writer?.subscribers.delete(mountId)
        ownedHomeQuickContextKeyRef.current = null
      }
      sweepHomeQuickWriters()
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
  }, [availableApps, catalogCommitted, enqueueQuickMutation, quickContextKey, quickEntries, uiKeyForApp])

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

  // Frozen POO-41 home-card contract: every server-authoritative
  // catalogSources entry stays visible with its identity — creator_circle
  // entries carry the localized 认证创作者 label, other entries keep their
  // organization/source name, and multiplicity is preserved.
  const renderQuickEntrySource = (app: CatalogApp) => {
    const sources = app.catalogSources?.length
      ? app.catalogSources
      : (app.sourceNames ?? []).map((name) => ({ kind: '', name }))
    if (sources.length === 0) return t('homeApps.allApps.unknownSource')
    return sources
      .map((source) => (
        source.kind === 'creator_circle' && source.name
          ? t('homeApps.home.certifiedCreatorSource', { creator: source.name })
          : source.name || t('homeApps.allApps.unknownSource')
      ))
      .join(' · ')
  }

  return (
    // Frozen POO-41 `.main` mirror: the centered 1260px column with the
    // breakpoint paddings INSIDE it. The column is ALSO the viewport-bounded
    // vertical scroll owner (h-full min-h-0 overflow-y-auto): html/body/#root
    // are overflow-hidden globally, so this element must own scrolling or
    // every launcher row and Catalog App below the fold becomes unreachable
    // (R39 review, hub unreachable-overflow defect).
    <main
      className="mx-auto h-full min-h-0 w-full max-w-[1260px] overflow-y-auto bg-background px-[18px] pb-[50px] pt-[30px] text-[16px] text-foreground min-[761px]:px-[26px] min-[761px]:pb-[58px] min-[761px]:pt-[36px] min-[1081px]:px-[44px] min-[1081px]:pb-[72px] min-[1081px]:pt-[46px]"
      data-testid="home-app-hub"
    >
      <div className="space-y-[34px]">
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
            {/* Frozen launcher hero: row with bottom-aligned side action at
            desktop/tablet; stacks under the text at the ≤760px breakpoint
            exactly like the frozen ≤760px `.hero` column rule. */}
            <div className="flex flex-col items-start justify-between gap-[24px] min-[761px]:flex-row min-[761px]:items-end">
              <div>
                <h1 className="m-0 text-[36px] font-bold leading-[1.08] tracking-[-0.05em]">
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
                  className="inline-flex min-h-[32px] items-center rounded-[8px] px-[10px] text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
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
              <div className="mb-[18px] flex items-start justify-between gap-[16px]">
                <div>
                  <h2 className="m-0 text-[20px] font-bold leading-[normal] tracking-[-0.03em]">{t('homeApps.home.sectionTitle')}</h2>
                  <p className="mt-[6px] text-[14px] leading-[1.45] text-muted-foreground">
                    {t('homeApps.home.sectionDescription')}
                  </p>
                </div>
                {catalog.productSpace && (
                  <div className="flex shrink-0 items-center gap-[8px]">
                    <button
                      type="button"
                      data-testid="home-manage-quick-access"
                      onClick={() => setManageOpen(true)}
                      className="inline-flex min-h-[32px] items-center rounded-[8px] px-[10px] text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    >
                      {t('homeApps.quick.manage')}
                    </button>
                    <button
                      type="button"
                      data-testid="home-all-apps-open"
                      onClick={() => setView('all-apps')}
                      className="inline-flex min-h-[32px] items-center rounded-[8px] px-[10px] text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
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
                  className="flex min-h-[210px] min-[1081px]:min-h-[222px] cursor-pointer flex-col rounded-[17px] border border-foreground/10 bg-surface p-[18px] shadow-xs transition-shadow hover:shadow-minimal min-[1081px]:p-[20px]"
                >
                  <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent text-[17px]">✦</span>
                  <h3 className="m-0 text-[16px] font-bold leading-[normal]">{t('homeApps.home.poloTitle')}</h3>
                  <p className="mt-[4px] text-[12px] leading-[normal] text-muted-foreground">{t('homeApps.home.poloSource')}</p>
                  <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
                    {t('homeApps.home.poloDescription')}
                  </p>
                  <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-[32px] rounded-[8px] border border-accent bg-accent px-[12px] text-[12px] font-semibold text-primary-foreground hover:bg-accent/90"
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
                    className="flex min-h-[210px] min-[1081px]:min-h-[222px] items-center justify-center rounded-[17px] border border-foreground/10 bg-surface"
                    data-testid="home-quick-access-loading"
                  >
                    <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : catalog.state.errorCode && !catalog.state.catalog ? (
                  <div className="flex min-h-[210px] min-[1081px]:min-h-[222px] flex-col items-center justify-center rounded-[17px] border border-foreground/10 bg-surface px-[24px] text-center">
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
                      const artGlyph = index % 2 === 0 ? '▣' : '▦'
                      return (
                        <article
                          key={uiKeyForApp(app)}
                          data-testid="home-quick-entry"
                          data-identity-key={uiKeyForApp(app)}
                          onClick={() => { void openCatalogApp(app) }}
                          className="flex min-h-[210px] min-[1081px]:min-h-[222px] cursor-pointer flex-col rounded-[17px] border border-foreground/10 bg-surface p-[18px] shadow-xs transition-shadow hover:shadow-minimal min-[1081px]:p-[20px]"
                        >
                          <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] bg-[color-mix(in_srgb,var(--success)_11%,transparent)] text-success text-[17px]">{artGlyph}</span>
                          <h3 className="m-0 text-[16px] font-bold leading-[normal]">{app.name}</h3>
                          <p className="mt-[4px] truncate text-[12px] leading-[normal] text-muted-foreground">
                            {renderQuickEntrySource(app)}
                          </p>
                          <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
                            {app.description || t('homeApps.noDescription')}
                          </p>
                          <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-[32px] rounded-[8px] border-0 px-[12px] text-[12px] text-muted-foreground hover:text-foreground"
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
