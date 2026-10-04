import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CatalogApp } from '@polo-ai/shared/admin'
import { MemberAppCard } from './MemberAppCard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useMemberCatalog } from '@/context/MemberCatalogContext'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import { useMemberAppActions } from '@/hooks/useMemberAppActions'
import { HomeSpaceContext } from '@/components/product-space/HomeSpaceContext'
import { useTabShell } from '@/context/TabShellContext'
import { useProductSpaceAppLaunchHandoff } from '@/context/ProductSpaceContext'
import { POLO_APP_DEFINITION } from '../../../shared/tab-browser-types'
import {
  catalogStateMessage,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'
import {
  selectHomeAppDirectory,
  type HomeAppDirectory,
  type HomeAppDirectoryEntry,
} from '@/lib/home-app-directory'
import { createHomeQuickAccessContextKey } from '@/lib/home-quick-access'

/**
 * POO-70 H3 (P70-HOME-01/02/03) — the "我的应用" home page.
 *
 * Since this card the home IS the complete directory: the H1 projection
 * (`selectHomeAppDirectory`) supplies the FULL authorized directory of the
 * active ProductSpace (no frequently-used cap, no pinning, no
 * add/remove-from-home), topped by the fixed Polo assistant card (P70-HOME-02,
 * open action along the existing code). The former quick-access main flow
 * (writer registry, manage dialog, pin/prune, the nested All-Apps view and
 * the page-internal MemberCatalogProvider mount) is retired from this page:
 * the single `useAppCatalog` instance now lives in the App-level
 * `MemberCatalogProvider` (lifted by this card next to ClientPageProvider)
 * and is consumed here through `useMemberCatalog()`.
 *
 * State contract (P70-HOME-03): loading / vacuum / error / denied / offline /
 * ready come from the H1 `phase`. Per the H1 reviewer contract the phase is
 * consumed TOGETHER with `rejections.length` (a fully-rejected directory is
 * NOT a vacuum) and cached rows are NEVER launchable while
 * denied/offline/error — the open handler fails closed here and the
 * authoritative grant stays with `resolveLaunch` inside the shared action.
 * Retry is always explicit; nothing auto-executes.
 */

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

// ─── Per-context "recently used" records (P70-HOME-01) ──────────────────────

/**
 * One REAL open action recorded by this page. This is UI-level usage
 * evidence (the member pressed open on THIS device), never an authorization
 * or entitlement fact — sort-only.
 */
export interface HomeAppUsageRecord {
  lastUsedAt: number
  openCount: number
}

/**
 * Module-level per-ProductSpace-context usage records, keyed by the SAME
 * context-key convention as the retired quick-access registry
 * (`v1:account|space`), so personal and enterprise usage never mix and an
 * account switch cannot leak records across accounts. Records persist in the
 * renderer's localStorage (best-effort, bounded); a corrupted or unavailable
 * store fails closed to an empty record set and the sort simply degrades to
 * the authoritative Catalog order.
 */
const HOME_APP_USAGE_STORAGE_PREFIX = 'poo70.h3:home-app-usage:'
const HOME_APP_USAGE_MAX_ENTRIES = 200
const homeAppUsageByContext = new Map<string, Map<string, HomeAppUsageRecord>>()

export function loadHomeAppUsage(contextKey: string): Map<string, HomeAppUsageRecord> {
  const cached = homeAppUsageByContext.get(contextKey)
  if (cached) return cached
  const records = new Map<string, HomeAppUsageRecord>()
  try {
    const raw = window.localStorage.getItem(HOME_APP_USAGE_STORAGE_PREFIX + contextKey)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!value || typeof value !== 'object') continue
          const { lastUsedAt, openCount } = value as {
            lastUsedAt?: unknown
            openCount?: unknown
          }
          if (
            typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt) && lastUsedAt >= 0
            && typeof openCount === 'number' && Number.isFinite(openCount) && openCount >= 0
          ) {
            records.set(key, { lastUsedAt, openCount })
          }
        }
      }
    }
  } catch {
    // Fail closed to an empty record set — never block the directory.
  }
  homeAppUsageByContext.set(contextKey, records)
  return records
}

function persistHomeAppUsage(
  contextKey: string,
  records: Map<string, HomeAppUsageRecord>,
): void {
  try {
    // Bound the record set: evict the OLDEST last-use first.
    while (records.size > HOME_APP_USAGE_MAX_ENTRIES) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [key, record] of records) {
        if (record.lastUsedAt < oldestAt) {
          oldestAt = record.lastUsedAt
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      records.delete(oldestKey)
    }
    const payload: Record<string, HomeAppUsageRecord> = {}
    for (const [key, record] of records) payload[key] = record
    window.localStorage.setItem(
      HOME_APP_USAGE_STORAGE_PREFIX + contextKey,
      JSON.stringify(payload),
    )
  } catch {
    // Persistence is best-effort: the in-memory records keep the session sort.
  }
}

/**
 * Records one open action for an App of the given ProductSpace context.
 * UI-preference data only (never an authorization fact) and scoped to the
 * exact account+space context key.
 */
export function recordHomeAppUsage(
  contextKey: string,
  identityKey: string,
  now = Date.now(),
): void {
  if (!contextKey || !identityKey) return
  const records = loadHomeAppUsage(contextKey)
  const previous = records.get(identityKey)
  records.set(identityKey, {
    lastUsedAt: now,
    openCount: (previous?.openCount ?? 0) + 1,
  })
  persistHomeAppUsage(contextKey, records)
}

/** Test-only: drop every per-context usage record. */
export function __resetHomeAppUsageForTests(): void {
  homeAppUsageByContext.clear()
}

// ─── Pure directory search / source-filter / sort (P70-HOME-01) ─────────────

export type HomeAppSortMode = 'recent' | 'frequent' | 'name'

/**
 * Sorts directory entries using ONLY fields that actually exist: `recent`
 * and `frequent` rank the page's REAL open records (never invented data),
 * and entries without records keep the authoritative Catalog order after
 * the used ones (H1 contract: the default order IS the authoritative
 * order). The sort is stable — ties always resolve to the authoritative
 * order.
 */
export function sortHomeAppDirectory(
  entries: readonly HomeAppDirectoryEntry[],
  mode: HomeAppSortMode,
  usage: ReadonlyMap<string, HomeAppUsageRecord>,
): HomeAppDirectoryEntry[] {
  const decorated = entries.map((entry, index) => ({ entry, index }))
  decorated.sort((left, right) => {
    if (mode === 'name') {
      const byName = left.entry.app.name.localeCompare(right.entry.app.name)
      if (byName !== 0) return byName
      return left.index - right.index
    }
    const leftRecord = usage.get(left.entry.identityKey)
    const rightRecord = usage.get(right.entry.identityKey)
    if (mode === 'recent') {
      const leftAt = leftRecord?.lastUsedAt ?? -1
      const rightAt = rightRecord?.lastUsedAt ?? -1
      if (leftAt !== rightAt) return rightAt - leftAt
    } else {
      const leftCount = leftRecord?.openCount ?? 0
      const rightCount = rightRecord?.openCount ?? 0
      if (leftCount !== rightCount) return rightCount - leftCount
    }
    return left.index - right.index
  })
  return decorated.map(item => item.entry)
}

/** Stable source label of one catalog source (display name, kind fallback). */
function homeAppSourceLabel(source: { kind: string; name?: string }): string {
  return (typeof source.name === 'string' ? source.name.trim() : '') || source.kind
}

function catalogSourcesOf(entry: HomeAppDirectoryEntry): Array<{ kind: string; name?: string }> {
  return entry.app.catalogSources?.length
    ? [...entry.app.catalogSources]
    : (entry.app.sourceNames ?? []).map(name => ({ kind: '', name }))
}

/**
 * Source filter options derived from the CURRENT directory's actual sources
 * (never a fixed list): first-appearance order, deduplicated by label.
 */
export function collectHomeAppSourceOptions(
  entries: readonly HomeAppDirectoryEntry[],
): Array<{ key: string; label: string }> {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const source of catalogSourcesOf(entry)) {
      const label = homeAppSourceLabel(source)
      if (!label || seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }
  }
  return labels.map(label => ({ key: label, label }))
}

export function homeAppMatchesSource(
  entry: HomeAppDirectoryEntry,
  sourceKey: string,
): boolean {
  if (sourceKey === 'all') return true
  return catalogSourcesOf(entry).some(source => homeAppSourceLabel(source) === sourceKey)
}

/** Case-insensitive search over name, description, creator and source names. */
export function homeAppMatchesQuery(
  entry: HomeAppDirectoryEntry,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true
  return [
    entry.app.name,
    entry.app.description,
    entry.app.creatorName,
    ...catalogSourcesOf(entry).map(source => homeAppSourceLabel(source)),
  ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
}

// ─── The page ────────────────────────────────────────────────────────────────

export function HomePage() {
  const { t } = useTranslation()
  const { openApp } = useTabShell()
  const launchHandoff = useProductSpaceAppLaunchHandoff()
  // H3 (card step 4): the catalog instance is owned by the App-level
  // MemberCatalogProvider — this page CONSUMES the shared surface instead of
  // creating its own useAppCatalog instance.
  const catalog = useMemberCatalog()
  // N1 navigation contract: the personal "my circles" entry navigates the
  // client-page route stack. Optional: surfaces mounted without the App's
  // provider tree (isolated tests) fall back to the local circles card.
  const clientPage = useOptionalClientPage()
  const [showCirclesCard, setShowCirclesCard] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  // Directory toolbar state: search, source filter and sort.
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [sortMode, setSortMode] = useState<HomeAppSortMode>('recent')
  // Bumped after every recorded open so the sort re-ranks from the mutated
  // usage records (the records map itself is a stable module-level cache).
  const [usageVersion, setUsageVersion] = useState(0)

  const activeProductSpace = catalog.productSpace?.activeProductSpace
  const spaceKind = activeProductSpace?.kind ?? null
  const usageContextKey = createHomeQuickAccessContextKey(
    catalog.productSpace?.productSpaceContextKey,
  )
  const usageContextKeyRef = useRef(usageContextKey)
  usageContextKeyRef.current = usageContextKey
  const uiKeyForApp = catalog.uiIdentityKeyForApp

  // H1 projection: the authoritative full directory of the CURRENT space,
  // with loading/vacuum/error/denied/offline as distinct phases.
  const directory = useMemo<HomeAppDirectory>(
    () => selectHomeAppDirectory(catalog.state.catalog, {
      accountId: catalog.productSpace?.accountId ?? null,
      productSpaceId: catalog.productSpace?.activeProductSpaceId ?? null,
      spaceKind,
      loading: catalog.state.loading,
      errorCode: catalog.state.errorCode,
      accessMode: catalog.state.accessMode,
    }),
    [
      catalog.productSpace?.accountId,
      catalog.productSpace?.activeProductSpaceId,
      catalog.state.accessMode,
      catalog.state.catalog,
      catalog.state.errorCode,
      catalog.state.loading,
      spaceKind,
    ],
  )
  const phase = directory.phase

  // The Polo assistant card and its launch action stay on the existing code
  // path (P70-HOME-02). The prototype's 管理技能 entry targets the deferred
  // skills page — an unbuilt entry must not pretend to succeed, so it is NOT
  // rendered this batch.
  const openPoloAssistant = () => {
    openApp(POLO_APP_DEFINITION)
  }

  // H2 shared actions: open / prepare / permission feedback through the SAME
  // trusted flow, driven by the shared catalog instance.
  const memberActions = useMemberAppActions({
    context: { spaceKind, launchHandoff },
    catalog,
  })
  const prepareTargetApp = memberActions.prepareTarget?.app ?? null

  const usage = loadHomeAppUsage(usageContextKey)
  const sourceOptions = useMemo(
    () => collectHomeAppSourceOptions(directory.entries),
    [directory.entries],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => directory.entries.filter(entry =>
      homeAppMatchesQuery(entry, normalizedQuery)
      && homeAppMatchesSource(entry, sourceFilter)),
    [directory.entries, normalizedQuery, sourceFilter],
  )
  const visibleEntries = useMemo(
    () => sortHomeAppDirectory(filteredEntries, sortMode, usage),
    // `usageVersion` re-ranks after a recorded open; `usage` is the stable
    // module-level record cache the mutation writes into.
    [filteredEntries, sortMode, usage, usageVersion],
  )

  // Open handler: the fail-closed gate demanded by the H1 reviewer contract.
  // A cached row NEVER carries launch authority: offline/denied/error phases
  // and per-row launchBlocked facts stop HERE with visible feedback (the
  // card stays in place, nothing navigates, nothing auto-executes). The
  // authoritative grant stays with resolveLaunch inside the shared action.
  const handleOpenApp = useCallback((entry: HomeAppDirectoryEntry) => {
    if (phase !== 'ready') {
      toast.error(
        phase === 'offline'
          ? t('homeApps.organization.offlineWarning')
          : t('homeApps.errors.unavailable'),
      )
      return
    }
    if (entry.launchBlocked) {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    recordHomeAppUsage(usageContextKeyRef.current, entry.identityKey)
    setUsageVersion(version => version + 1)
    void memberActions.open(entry.app)
  }, [memberActions, phase, t])

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

  // Runtime status for a directory card (prototype 运行中 badge): looked up
  // through the runtime scope key, never the UI identity key. A failed scope
  // derivation simply means "no badge".
  const runtimeStatusFor = (app: CatalogApp) => {
    try {
      return catalog.state.statuses[catalog.scopeKeyForApp(app)] ?? null
    } catch {
      return null
    }
  }

  // Grid body phases. The work-App slots render rows ONLY when the projection
  // is authoritative (ready) or explains retained rows (denied/offline); a
  // first load keeps the dedicated loading tile and a transport failure keeps
  // the explicit retry tile (P70-HOME-03: never synthesize, never auto-run).
  const showDirectoryRows = phase === 'ready' || phase === 'denied' || phase === 'offline'
  const directoryEmpty = phase === 'empty'
  // A fully-rejected directory is NOT a vacuum (H1 reviewer contract): the
  // empty phase must be consumed together with rejections.length.
  const directoryRejected = directoryEmpty && directory.rejections.length > 0

  return (
    // Frozen POO-41 `.main` mirror: the centered 1260px column with the
    // breakpoint paddings INSIDE it, content-sized exactly like the frozen
    // `.main` element. Scrolling is owned by the DEDICATED wrapper above
    // (h-full min-h-0 overflow-y-auto): html/body/#root are overflow-hidden
    // globally and the region element must stay content-sized, so the
    // wrapper — never the region — owns viewport-bounded scrolling. Every
    // launcher row and directory row below the fold stays reachable
    // (R39/R40 review). The `home-quick-access-section` test id is the
    // long-standing HOME-SURFACE marker consumed by the narrow-window guard
    // and scope-isolation tests — it marks the home content region, not the
    // retired quick-access feature.
    <div className="h-full min-h-0 overflow-y-auto">
    <main
      className="mx-auto w-full max-w-[1260px] bg-background px-[18px] pb-[50px] pt-[30px] text-[16px] text-foreground min-[761px]:px-[26px] min-[761px]:pb-[58px] min-[761px]:pt-[36px] min-[1081px]:px-[44px] min-[1081px]:pb-[72px] min-[1081px]:pt-[46px]"
      data-testid="home-app-hub"
    >
      {/* Prototype `.r14-home .home-hero`: 我的应用 title + space lead at
      left, the personal circles context link bottom-aligned at desktop and
      stacked full-width under the text at ≤760px. Enterprise homes never mix
      in the circles entry (P70-HOME-02). The test id is the long-standing
      HOME-SURFACE marker (see the note above). */}
      <div
        className="flex flex-col items-start justify-between gap-[24px] min-[761px]:flex-row min-[761px]:items-end"
        data-testid="home-quick-access-section"
      >
        <div className="min-w-0">
          <h1
            data-testid="home-directory-title"
            className="m-0 text-[30px] font-bold leading-[1.08] tracking-[-0.055em] min-[761px]:text-[36px]"
          >
            {t('poo70.h3.home.title')}
          </h1>
          {catalog.productSpace && (
            <p className="mt-[13px] max-w-[690px] text-[15px] leading-[1.65] text-muted-foreground">
              {spaceKind === 'enterprise'
                ? t('poo70.h3.home.leadEnterprise')
                : t('poo70.h3.home.leadPersonal')}
            </p>
          )}
        </div>
        {catalog.productSpace && spaceKind === 'personal' && (
          <button
            type="button"
            data-testid="home-circles-link"
            onClick={() => {
              if (clientPage) {
                // N1 (POO-89) navigation contract: the circles route is a
                // typed navigation candidate; the real circles page mounts
                // through POO-100.
                clientPage.navigate({ kind: 'circles' })
                return
              }
              // Isolated-mount fallback (tests/probes without the App's
              // provider tree): the local circles card instead of a silent
              // no-op.
              setShowCirclesCard(value => !value)
            }}
            className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[12px] px-[10px] py-[9px] text-left text-foreground-70 hover:bg-foreground-5 hover:text-foreground min-[761px]:w-auto min-[761px]:min-w-[210px]"
          >
            <Icons.UserRoundPlus className="size-4 text-accent" aria-hidden="true" />
            <span className="grid gap-[3px]">
              <strong className="text-[13px] font-semibold">{t('homeSpace.context.myCircles')}</strong>
              <small className="text-[11px] text-foreground-50">
                {t('homeSpace.context.circlesCount', { count: catalog.creatorCircles?.length ?? 0 })}
              </small>
            </span>
            <Icons.ChevronRight className="size-3.5 text-foreground-40" aria-hidden="true" />
          </button>
        )}
      </div>

      {catalog.productSpace && spaceKind === 'enterprise' && (
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

      {/* Prototype `.r14-toolbar`: search + source filter + sort. Hidden
      while the directory cannot be verified (transport failure), matching
      the prototype LOAD-FAIL state. */}
      {catalog.productSpace && phase !== 'error' && (
        <div
          className="mt-[24px] flex flex-wrap items-end gap-[16px]"
          data-testid="home-directory-toolbar"
        >
          <label className="grid min-w-[220px] flex-1 gap-[6px] text-[12px] text-muted-foreground">
            <span>{t('poo70.h3.home.searchLabel')}</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('poo70.h3.home.searchPlaceholder')}
              data-testid="home-directory-search"
              className="min-h-[38px] w-full appearance-none rounded-[10px] border border-border bg-surface px-[12px] text-[16px] text-foreground outline-none focus-visible:border-accent [&::-webkit-search-cancel-button]:appearance-none"
            />
          </label>
          <label className="grid gap-[6px] text-[12px] text-muted-foreground">
            <span>{t('homeApps.allApps.sourceLabel')}</span>
            <select
              value={sourceFilter}
              onChange={event => setSourceFilter(event.target.value)}
              data-testid="home-directory-source"
              className="min-h-[38px] rounded-[10px] border border-border bg-surface px-[12px] text-[16px] text-foreground"
            >
              <option value="all">{t('poo70.h3.home.sourceAll')}</option>
              {sourceOptions.map(option => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-[6px] text-[12px] text-muted-foreground">
            <span>{t('poo70.h3.home.sortLabel')}</span>
            <select
              value={sortMode}
              onChange={event => setSortMode(event.target.value as HomeAppSortMode)}
              data-testid="home-directory-sort"
              className="min-h-[38px] rounded-[10px] border border-border bg-surface px-[12px] text-[16px] text-foreground"
            >
              <option value="recent">{t('poo70.h3.home.sortRecent')}</option>
              <option value="frequent">{t('poo70.h3.home.sortFrequent')}</option>
              <option value="name">{t('poo70.h3.home.sortName')}</option>
            </select>
          </label>
        </div>
      )}

      {phase === 'denied' && (
        <div
          className="mt-[24px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
          data-testid="home-restricted-banner"
        >
          {t('homeApps.organization.accessError')}
        </div>
      )}
      {phase === 'offline' && (
        <div
          className="mt-[24px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="home-directory-offline-banner"
        >
          {t('homeApps.organization.offlineWarning')}
        </div>
      )}

      <section className="mt-[34px]">
        <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
          {/* The fixed Polo assistant card always renders — loading, error
          and empty states only occupy the work-App slots beside it. */}
          <article
            data-testid="home-quick-entry-polo"
            onClick={openPoloAssistant}
            className="flex min-h-[210px] min-[1081px]:min-h-[222px] cursor-pointer flex-col rounded-[17px] border border-foreground/10 bg-surface p-[18px] shadow-xs transition-shadow hover:shadow-minimal min-[1081px]:p-[20px]"
          >
            <span className="mb-[26px] grid size-[42px] place-items-center rounded-[13px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent">
              <Icons.Sparkles className="size-[18px]" aria-hidden="true" />
            </span>
            <h3 className="m-0 text-[16px] font-bold leading-[normal]">{t('homeApps.home.poloTitle')}</h3>
            <p className="mt-[4px] text-[12px] leading-[normal] text-muted-foreground">{t('homeApps.home.poloSource')}</p>
            <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
              {t('homeApps.home.poloDescription')}
            </p>
            <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
              {/* Prototype `.home-app-grid .assistant-card
              .home-primary-action`: solid accent, weight 650, lifts with
              shadow-middle on hover. */}
              <button
                type="button"
                className="inline-flex min-h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] border border-accent bg-accent px-[12px] text-[12px] font-semibold text-white shadow-minimal transition-[box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:shadow-middle"
                onClick={(event) => {
                  event.stopPropagation()
                  openPoloAssistant()
                }}
              >
                {t('homeApps.home.openAssistant')}
              </button>
            </div>
          </article>
          {phase === 'loading' && !catalog.state.catalog ? (
            <div
              className="flex min-h-[210px] min-[1081px]:min-h-[222px] items-center justify-center rounded-[17px] border border-foreground/10 bg-surface"
              data-testid="home-directory-loading"
            >
              <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : phase === 'error' && !catalog.state.catalog ? (
            <div
              className="flex min-h-[210px] min-[1081px]:min-h-[222px] flex-col items-center justify-center rounded-[17px] border border-foreground/10 bg-surface px-[24px] text-center"
              data-testid="home-directory-load-failed"
            >
              <Icons.CloudOff className="mb-2 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">{t('homeApps.allApps.loadFailed')}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {catalogStateMessage(t, catalog.state.errorCode, 'error', spaceKind)}
              </p>
              {/* Explicit retry only — a failure never auto-executes. */}
              <button
                type="button"
                className="mt-3 inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                onClick={() => { void catalog.sync(true) }}
              >
                {t('homeApps.actions.tryAgain')}
              </button>
            </div>
          ) : (
            <>
              {showDirectoryRows && visibleEntries.map((entry) => (
                <div key={entry.identityKey} className="group relative">
                  <MemberAppCard
                    variant="home"
                    app={entry.app}
                    runtimeStatus={runtimeStatusFor(entry.app)}
                    identityKey={entry.identityKey}
                    testId="home-directory-app"
                    onOpen={() => handleOpenApp(entry)}
                  />
                  {/* Retained local management: a work App installed on THIS
                  device keeps its uninstall entry even when the directory row
                  is not launchable (withdrawn tombstone / blocked row). The
                  entry is page-level UI on the existing uninstall flow. */}
                  {catalog.getInstallState(entry.app)?.state === 'installed' && (
                    <button
                      type="button"
                      data-testid={`home-directory-uninstall-${entry.identityKey}`}
                      aria-label={t('homeApps.actions.uninstall')}
                      title={t('homeApps.actions.uninstall')}
                      onClick={() => setUninstallTarget(entry.app)}
                      className="absolute right-[10px] top-[10px] grid size-[26px] place-items-center rounded-[7px] text-foreground-40 opacity-0 transition-opacity hover:bg-foreground-5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Icons.Trash2 className="size-[13px]" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>

        {directoryRejected && (
          <div
            className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-danger/30 px-[20px] py-[34px] text-center"
            data-testid="home-directory-rejected"
          >
            <span className="grid size-[52px] place-items-center rounded-[14px] bg-danger/10 text-danger">
              <Icons.ShieldQuestion className="size-[25px]" aria-hidden="true" />
            </span>
            <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
              {t('poo70.h3.home.rejectedTitle')}
            </h2>
            <p className="m-0 max-w-[460px] text-[12px] leading-[1.5] text-muted-foreground">
              {t('poo70.h3.home.rejectedHint')}
            </p>
            <button
              type="button"
              className="mt-[4px] inline-flex min-h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
              onClick={() => { void catalog.sync(true) }}
            >
              {t('homeApps.actions.tryAgain')}
            </button>
          </div>
        )}
        {directoryEmpty && !directoryRejected && catalog.productSpace && (
          /* Honest vacuum (P70-HOME-03): personal spaces invite the circles
          join path, enterprise spaces say plainly that nothing has been
          distributed yet — never a generic "no results". */
          <div
            className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-border px-[20px] py-[34px] text-center"
            data-testid={spaceKind === 'enterprise'
              ? 'home-directory-empty-enterprise'
              : 'home-directory-empty-personal'}
          >
            {spaceKind === 'enterprise' ? (
              <>
                <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
                  {t('homeApps.allApps.empty')}
                </h2>
                <p className="m-0 max-w-[460px] text-[12px] leading-[1.5] text-muted-foreground">
                  {t('poo70.h3.home.emptyEnterprise')}
                </p>
              </>
            ) : (
              <>
                <span className="grid size-[52px] place-items-center rounded-[14px] bg-info/10 text-info">
                  <Icons.LayoutGrid className="size-[25px]" aria-hidden="true" />
                </span>
                <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
                  {t('poo70.h3.home.emptyPersonalTitle')}
                </h2>
                <p className="m-0 max-w-[460px] text-[12px] leading-[1.5] text-muted-foreground">
                  {t('poo70.h3.home.emptyPersonalHint')}
                </p>
              </>
            )}
          </div>
        )}
        {phase === 'ready' && directory.entries.length > 0 && visibleEntries.length === 0 && (
          /* Prototype `[data-library-empty]`: the search/filter vacuum —
          distinct from the directory vacuum above, with the explicit clear
          action. */
          <div
            className="mt-[16px] grid justify-items-center gap-[8px] rounded-[20px] border border-dashed border-border px-[20px] py-[30px] text-center"
            data-testid="home-directory-no-match"
          >
            <h2 className="m-0 text-[16px] font-bold tracking-[-0.02em]">
              {t('poo70.h3.home.noMatch')}
            </h2>
            <p className="m-0 text-[12px] leading-[1.5] text-muted-foreground">
              {t('poo70.h3.home.noMatchHint')}
            </p>
            <button
              type="button"
              className="mt-[2px] inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
              onClick={() => {
                setQuery('')
                setSourceFilter('all')
              }}
            >
              {t('poo70.h3.home.clearFilters')}
            </button>
          </div>
        )}
      </section>
      {catalog.productSpace && spaceKind === 'personal' && showCirclesCard && (
        <HomeSpaceContext
          spaceName={activeProductSpace?.name
            || t('homeApps.organization.current')}
          spaceKind="personal"
          creatorCircles={catalog.creatorCircles}
          spaceKey={catalog.productSpace.productSpaceContextKey}
        />
      )}

      <Dialog open={Boolean(memberActions.prepareTarget)} onOpenChange={(open) => {
        if (!open) memberActions.cancelPrepare()
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {prepareTargetApp && catalog.getInstallState(prepareTargetApp)?.state === 'installed'
                ? t('homeApps.install.updateTitle', {
                    name: prepareTargetApp.name,
                  })
                : t('homeApps.install.installTitle', {
                    name: prepareTargetApp?.name ?? t('homeApps.appFallback'),
                  })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.install.description')}
            </DialogDescription>
          </DialogHeader>
          {prepareTargetApp && memberActions.prepareTarget && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{memberActions.prepareTarget.launch.subject.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, memberActions.prepareTarget.launch.delivery.sizeBytes)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('homeApps.install.permissions')}
                </p>
                {prepareTargetApp.permissions?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {prepareTargetApp.permissions.map(permission => (
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
            <Button type="button" variant="secondary" onClick={() => memberActions.cancelPrepare()}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => { void memberActions.confirmPrepare() }}>
              {prepareTargetApp && catalog.getInstallState(prepareTargetApp)?.state === 'installed'
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
    </div>
  )
}
