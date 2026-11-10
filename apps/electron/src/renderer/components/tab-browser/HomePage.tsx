import { Checkbox } from '@polo-ai/ui/ui/checkbox'
import { WorkbenchSelect } from '@/components/ui/workbench-controls'
import { clientWorkbenchFocusClassName, useClientWorkbenchStyle, clientWorkbenchDialogClassName, clientWorkbenchOverlayClassName, clientWorkbenchPrimaryClassName, clientWorkbenchButtonClassName, clientWorkbenchDestructiveClassName } from '@/components/ui/client-workbench'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import type { HomeAppUsageRecord } from '@/lib/home-app-usage'
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
import { useOptionalMemberCircles } from '@/context/MemberCircleResourceContext'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import {
  isMemberAppBundleLaunch,
  useMemberAppActions,
} from '@/hooks/useMemberAppActions'
import {
  useMyApps,
  type MyAppsErrorCode,
} from '@/hooks/useMyApps'
import type { MyAppSummary } from '@polo-ai/shared/protocol'
import { HomeSpaceContext, type HomeSpaceCategory } from '@/components/product-space/HomeSpaceContext'
import { useProductSpaceAppLaunchHandoff, useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useStore } from 'jotai'
import { enterProjectLightweight } from '@/components/projects/enter-project'
import { getActiveProjectFor } from '@/components/projects/projects-bus'
import { reconcileOpenProjectTabs } from '@/components/projects/reconcile'
import {
  readProjectVisitOrder,
  rememberProjectPurposes,
  sortProjectDirectory,
  type ProjectVisitRecord,
} from '@/lib/project-directory'
import { PinnedCanvasApps } from './PinnedCanvasApps'
import { ProductSpaceSkillsDialog } from '@/components/product-space/ProductSpaceSkillsDialog'
import {
  catalogStateMessage,
  homeAppErrorPresentation,
} from '@/lib/home-app-errors'
import { HomeAppErrorToastDescription } from './HomeAppErrorToastDescription'
import {
  hasOnlyLostCircleSources,
  selectHomeAppDirectory,
  type HomeAppDirectory,
  type HomeAppDirectoryEntry,
} from '@/lib/home-app-directory'
import { useMemberCircleClock } from '@/hooks/useMemberCircleClock'
import { selectLostCircleAuthorizationIds } from '@/lib/member-circle-view'
import {
  formatBytes,
  loadHomeAppUsage,
  recordHomeAppUsage,
} from '@/lib/home-app-usage'
import {
  hideHomeApp,
  loadHomeHiddenApps,
  restoreHomeApp,
} from '@/lib/home-app-hidden'
import { createHomeQuickAccessContextKey } from '@/lib/home-quick-access'

// Re-exported for the established test/import surface (implementation lives
// in the H3 lib layer).
export { formatBytes }

/**
 * POO-196 R3 / POO-70 H3 (P70-HOME-01/02/03) — the 首页 (Home) page.
 *
 * R3 (consensus P1) page order: hero → 「项目」区域 → fixed canvas →
 * 「应用」分区标题 + search/source/sort toolbar + app grid. The page title
 * key (`poo70.h3.home.title`) now reads 首页/Home; search, source and sort
 * keep their APP-ONLY scope — the project section above carries its own
 * name search and never participates in the app filters.
 *
 * Since this card the home IS the complete directory: the H1 projection
 * (`selectHomeAppDirectory`) supplies the FULL authorized directory of the
 * active ProductSpace (no frequently-used cap, no pinning, no
 * add/remove-from-home). POO-205 Catalog v2: no built-in cards remain — the
 * Polo assistant is a base capability and the knowledge base retired into the
 * project shared-file area; the directory splits into the 「我的应用」
 * partition (the member's own saved apps, with the enterprise-only publish /
 * withdraw actions). C11 (R15) IA order: hero → 项目区 (enterprise only) →
 * fixed canvas → 「应用」segment (title + manage-skills → toolbar → banners →
 * shared grid → restore/vacuum faces, all adjacent) → 「我的应用」 (AFTER the
 * shared grid); with both partitions empty ONE merged empty state speaks for
 * both. The former quick-access main
 * flow (writer registry, manage dialog, pin/prune, the nested All-Apps view
 * and the page-internal MemberCatalogProvider mount) is retired from this
 * page: the single `useAppCatalog` instance now lives in the App-level
 * `MemberCatalogProvider` (lifted by this card next to ClientPageProvider)
 * and is consumed here through `useMemberCatalog()`.
 *
 * State contract (P70-HOME-03): loading / vacuum / error / denied / offline /
 * ready come from the H1 `phase`. Per the H1 reviewer contract the phase is
 * consumed TOGETHER with `rejections.length` (a fully-rejected directory is
 * NOT a vacuum) and cached rows are NEVER launchable while
 * denied/offline/error — the open handler fails closed here and the
 * authoritative grant stays with `resolveLaunch` inside the shared action.
 * A REFRESH failure over a retained cache renders the stale rows under an
 * explicit stale banner with retry (a background sync failure must never
 * silently blank the directory); a failure with NO cache keeps the retry
 * tile. Retry is always explicit; nothing auto-executes.
 *
 * Local surfaces (P70-HOME-01 保留最近使用和本机隐藏恢复): the recent/frequent
 * sort ranks REAL open records and every row carries a local HIDE control —
 * both are per-account+space device preferences persisted through
 * `@/lib/home-app-usage` / `@/lib/home-app-hidden` (fail-closed degradation),
 * and hidden works are restored from the in-page section below the grid. The
 * lib contracts are shared so the circle views can record opens too.
 */

// ─── Pure directory search / source-filter / sort (P70-HOME-01) ─────────────

export type HomeAppSortMode = 'recent' | 'frequent' | 'name'

/**
 * Sorts directory entries using ONLY fields that actually exist: `recent`
 * and `frequent` rank the page's REAL open records (never invented data),
 * and entries without records use the confirmed stable name fallback.
 * Equal usage ranks also sort by name; equal names preserve catalog order.
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
    return left.entry.app.name.localeCompare(right.entry.app.name) || left.index - right.index
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
  options?: { literal?: boolean },
): boolean {
  if (sourceKey === 'all' && !options?.literal) return true
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

// ─── The home project directory (POO-205, Spec Q1/Q3/Q8) ────────────────────

/**
 * The card-minimum contract: stable PROJECT id (the POO-205 entity, no
 * longer a product-space id), name, the caller's project role and the
 * optional purpose/member-count facts pm:listProjects carries. Missing facts
 * are OMITTED downstream (P4: 人数未知则省略该行，never a fabricated 0).
 * `organizationProductSpaceId` stamps the owning organization space so the
 * click can tell the lightweight entry (committed org matches) from the
 * legacy space-switch transaction.
 */
export type ProjectDirectoryEntry = {
  id: string
  name: string
  purpose?: string
  /** POO-205: carried so the settings dialog edits the REAL saved value —
   * a projection missing it would blank the field and wipe on save. */
  instructions?: string
  role: 'owner' | 'manager' | 'member'
  memberCount?: number
  organizationEnterpriseId: string
  organizationProductSpaceId: string
}

/**
 * P4 state truthfulness: loading / failure / stale cache are distinct and
 * must never render as the empty state — 「还没有项目」is reserved for a
 * VERIFIED-empty ready collection, nothing else.
 */
export type ProjectDirectoryState =
  | { status: 'loading' }
  | { status: 'error'; reason?: 'generic' | 'version' }
  | { status: 'ready'; stale?: boolean }

/** Case-insensitive name search over the project directory (app-scoped
 * search stays app-only; this one serves the expanded project list). */
export function projectDirectoryMatchesQuery(
  entry: ProjectDirectoryEntry,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true
  return entry.name.toLocaleLowerCase().includes(normalizedQuery)
}

// ─── The page ────────────────────────────────────────────────────────────────

export function HomePage({ onEnterProject }: {
  /**
   * Optional host-provided entry override (isolated test mounts). Production
   * (POO-205, Spec Q8) enters through the LIGHTWEIGHT path below — publish
   * the active project, land the conversation layout, open the project home;
   * never a space-switch transaction. While absent (tests), the card click
   * is deliberately inert (a silent no-op, never a fake navigation).
   */
  onEnterProject?: (productSpaceId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const launchHandoff = useProductSpaceAppLaunchHandoff()
  // R3 (P11): the home project section reaches the EXISTING ProductSpace
  // context instance (the same provider the launch handoff above reads) —
  // never a second one. onOpenCreateProject is hosted by App.
  const spaceContext = useOptionalProductSpaceContext()
  // H3 (card step 4): the catalog instance is owned by the App-level
  // MemberCatalogProvider — this page CONSUMES the shared surface instead of
  // creating its own useAppCatalog instance.
  const catalog = useMemberCatalog()
  // POO-70 visual review R1 F2: the C2 relations (optional — isolated mounts
  // without the provider simply project no lost circles) feed the H1
  // directory's `lostCircleIds`, so a work whose EVERY circle source was
  // lost to a leave/revocation renders as UNAVAILABLE here instead of as a
  // normal launchable card. Same authority the circle list/detail read.
  const circlesResource = useOptionalMemberCircles()
  // N1 navigation contract: the personal "my circles" entry navigates the
  // client-page route stack. Optional: surfaces mounted without the App's
  // provider tree (isolated tests) fall back to the local circles card.
  const clientPage = useOptionalClientPage()
  // U4: the version-unsupported error face offers a「检查客户端更新」shortcut
  // through the App shell's existing settings navigation ONLY when the host
  // provides it (the AppShell context owner). Without it the face keeps just
  // the expandable local guide — never a dead navigation button.
  const settingsNavigationAvailable = useOptionalAppShellContext() !== null
  // POO-205 C9 (R12): the reconciliation needs the jotai store (tab atoms)
  // and the workspace scope (the per-project last-selected cleanup). Read
  // once at the top; the successful directory read below is the authority.
  const appShellForReconcile = useOptionalAppShellContext()
  // U4: expand/collapse state of the in-place version guide (「查看更新指引」
  // → service/admin explanation + optional client-update shortcut). Local and
  // transient: a fresh error face starts collapsed.
  const [versionGuideOpen, setVersionGuideOpen] = useState(false)
  const [showCirclesCard, setShowCirclesCard] = useState(false)
  // C11 (R16): the「应用」section header's manage-skills entry mounts the
  // existing ProductSpaceSkillsDialog — its first production mount (the
  // former assistant card retired). Local and transient.
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  // C12 (R14): publish and delete are EXPLICIT confirmed steps on the
  // 我的应用 rows — publish makes the app space-visible, delete removes the
  // row (and withdraws the shared entry with it). Local and transient.
  const [publishConfirmTarget, setPublishConfirmTarget] = useState<MyAppSummary | null>(null)
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<MyAppSummary | null>(null)
  // Directory toolbar state: search, source filter and sort.
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [sortMode, setSortMode] = useState<HomeAppSortMode>('recent')
  // Local hide/restore updates the current directory immediately; usage
  // ranking stays fixed until the member returns to Home.
  const [hiddenVersion, setHiddenVersion] = useState(0)

  const activeProductSpace = catalog.productSpace?.activeProductSpace
  const spaceKind = activeProductSpace?.kind ?? null
  const usageContextKey = createHomeQuickAccessContextKey(
    catalog.productSpace?.productSpaceContextKey,
  )
  const usageContextKeyRef = useRef(usageContextKey)
  usageContextKeyRef.current = usageContextKey

  // H1 projection: the authoritative full directory of the CURRENT space,
  // with loading/vacuum/error/denied/offline as distinct phases. F2: the C2
  // restricted-circle ids mark the corresponding creator_circle sources lost
  // (the leave/revocation projection of §13.5: only the LAST valid source
  // failing blocks a work).
  const entitlementNow = useMemberCircleClock(circlesResource?.memberships ?? circlesResource?.circles ?? [])
  const lostCircleIds = useMemo(
    () => selectLostCircleAuthorizationIds(
      circlesResource?.circles ?? [],
      circlesResource?.memberships ?? [],
      entitlementNow,
    ),
    [circlesResource?.circles, circlesResource?.memberships, entitlementNow],
  )
  const directory = useMemo<HomeAppDirectory>(
    () => selectHomeAppDirectory(catalog.state.catalog, {
      accountId: catalog.productSpace?.accountId ?? null,
      productSpaceId: catalog.productSpace?.activeProductSpaceId ?? null,
      spaceKind,
      loading: catalog.state.loading,
      errorCode: catalog.state.errorCode,
      accessMode: catalog.state.accessMode,
      // POO-205: the trusted projection's member-row index splits the
      // 我的应用 entries into their own partition.
      memberCatalogEntryIds: new Set(Object.keys(catalog.state.memberCatalogEntryIds ?? {})),
      lostCircleIds,
    }),
    [
      catalog.productSpace?.accountId,
      catalog.productSpace?.activeProductSpaceId,
      catalog.state.accessMode,
      catalog.state.catalog,
      catalog.state.errorCode,
      catalog.state.loading,
      catalog.state.memberCatalogEntryIds,
      lostCircleIds,
      spaceKind,
    ],
  )
  const phase = directory.phase

  // ── The project directory (POO-205 Spec Q1/Q3/Q8) ────────────────────────
  // A project is a LIGHTWEIGHT entity inside ONE organization: the directory
  // is the CURRENT committed organization's projects (pm:listProjects) —
  // enterprise spaces are organizations now, and the old "enterprise space
  // with enterpriseKind==='project'" projection is gone. On a personal home
  // there is no project scope: the section renders the honest org-required
  // face instead of a directory that could only fail. Loading, failure and
  // the version-unsupported face stay distinct states and NEVER render as
  // 「还没有项目」 (P4).
  const [projectsState, setProjectsState] = useState<ProjectDirectoryState>({ status: 'loading' })
  const [projectEntries, setProjectEntries] = useState<ProjectDirectoryEntry[]>([])
  // U14: the negotiated summary's display kind PER SPACE (`enterpriseKind`),
  // verbatim from the R3 wire type — the identity bar classifies the CURRENT
  // committed space from this map and NEVER from the name. (POO-205: after
  // the one-shot migration every enterprise is an organization; the R3
  // metadata remains the switcher/identity-bar source.)
  const [spaceKindsById, setSpaceKindsById] = useState<Record<string, 'organization' | 'project'>>({})
  const projectsAccountId = catalog.productSpace?.accountId ?? spaceContext?.accountId ?? null
  const [projectsReloadTick, setProjectsReloadTick] = useState(0)
  const reloadProjects = useCallback(() => setProjectsReloadTick(tick => tick + 1), [])
  const committedSpace = spaceContext?.activeProductSpace ?? catalog.productSpace?.activeProductSpace ?? null
  const projectsOrgScope = useMemo(() => (
    projectsAccountId && committedSpace?.kind === 'enterprise'
      ? {
        accountId: projectsAccountId,
        productSpaceId: committedSpace.id,
        organizationEnterpriseId: committedSpace.enterpriseId,
      }
      : null
  ), [committedSpace, projectsAccountId])
  // U14 identity classification keeps its account-scoped negotiated read.
  useEffect(() => {
    if (!projectsAccountId) {
      setSpaceKindsById({})
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await window.electronAPI.pmListProductSpacesR3({ accountId: projectsAccountId })
        if (cancelled) return
        const kinds: Record<string, 'organization' | 'project'> = {}
        for (const summary of response.enterpriseSummaries) {
          kinds[summary.productSpaceId] = summary.enterpriseKind
        }
        setSpaceKindsById(kinds)
      } catch {
        if (cancelled) return
        // Fail closed on the identity classification: a failed read leaves
        // the committed space UNCLASSIFIED (neutral face), never a stale
        // guess.
        setSpaceKindsById({})
      }
    })()
    return () => { cancelled = true }
  }, [projectsAccountId])
  // The directory itself: the committed organization's projects.
  useEffect(() => {
    if (!projectsOrgScope) {
      setProjectEntries([])
      setProjectsState({ status: 'ready' })
      return
    }
    let cancelled = false
    setProjectsState({ status: 'loading' })
    void (async () => {
      try {
        const response = await window.electronAPI.pmListProjects(projectsOrgScope)
        if (cancelled) return
        const entries: ProjectDirectoryEntry[] = response.projects.map(project => ({
          id: project.id,
          name: project.name,
          role: project.myRole,
          purpose: project.purpose,
          instructions: project.instructions,
          memberCount: project.memberCount,
          organizationEnterpriseId: projectsOrgScope.organizationEnterpriseId,
          organizationProductSpaceId: project.organizationProductSpaceId,
        }))
        setProjectEntries(entries)
        // P12-5: cache the fetched introductions so the session-creation path
        // can attach the SAME authoritative purpose to new project sessions
        // (POO-205: keyed by the PROJECT id — the sessions' immutable
        // binding).
        if (projectsAccountId) {
          rememberProjectPurposes(projectsAccountId, entries)
        }
        // POO-205 C9 (R12): a SUCCESSFUL read is the directory authority —
        // every open project tab the list no longer carries closes here with
        // one toast (deleted or no-longer-a-member; not distinguished). A
        // failed read never reaches this, so a network blip cannot strip tabs.
        reconcileOpenProjectTabs(jotaiStore, {
          visibleProjects: response.projects,
          workspaceId: appShellForReconcile?.activeWorkspaceId ?? null,
        })
        setProjectsState({ status: 'ready' })
      } catch (error) {
        if (cancelled) return
        setProjectsState({
          status: 'error',
          reason: readRpcErrorCode(error) === 'contract_version_unsupported' ? 'version' : 'generic',
        })
      }
    })()
    return () => { cancelled = true }
  }, [projectsAccountId, projectsOrgScope, projectsReloadTick])
  // U14: the identity-bar category of the CURRENT committed space. Personal
  // spaces classify from the space kind itself; enterprise spaces classify
  // strictly from the negotiated summary (organization aggregate vs project)
  // — anything the summary does not verify stays the neutral「当前空间」face.
  const spaceCategory: HomeSpaceCategory = spaceKind === 'personal'
    ? 'personal'
    : (() => {
        const activeSpaceId = spaceContext?.activeProductSpaceId
          ?? catalog.productSpace?.activeProductSpaceId
          ?? null
        const verifiedKind = activeSpaceId === null ? undefined : spaceKindsById[activeSpaceId]
        return verifiedKind === 'organization' || verifiedKind === 'project' ? verifiedKind : 'unknown'
      })()
  // Device-local visit order (P3): most recent successful entry first. Read
  // per mounted account; a successful entry writes through
  // recordProjectVisit (B4b/project-entry), so the order refreshes on the
  // next mount of the page.
  const projectVisits = useMemo<ProjectVisitRecord[]>(
    () => (projectsAccountId ? readProjectVisitOrder(projectsAccountId) : []),
    [projectsAccountId],
  )
  const sortedProjects = useMemo(
    () => sortProjectDirectory(projectEntries, projectVisits, i18n.language),
    [i18n.language, projectEntries, projectVisits],
  )
  const [projectsExpanded, setProjectsExpanded] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase()
  // U9: an active (non-blank) query shows EVERY match over the full
  // authorized set — the two-row capacity truncation and the expand/collapse
  // controls are suspended for the duration (and nothing may implicitly
  // erase the query; only clearing it does).
  const projectQueryActive = normalizedProjectQuery.length > 0
  // U9: the project query belongs to ONE account's directory — an account
  // change clears it. The expand/collapse preference is a device display
  // preference and is deliberately NOT touched here.
  const previousProjectsAccountIdRef = useRef(projectsAccountId)
  useEffect(() => {
    if (previousProjectsAccountIdRef.current !== projectsAccountId) {
      previousProjectsAccountIdRef.current = projectsAccountId
      setProjectQuery('')
    }
  }, [projectsAccountId])
  const filteredProjects = useMemo(
    () => sortedProjects.filter(entry => projectDirectoryMatchesQuery(entry, normalizedProjectQuery)),
    [normalizedProjectQuery, sortedProjects],
  )
  // Capacity (P3): two rows of cards at the frozen breakpoints — 2×(1|2|3)
  // columns. Collapsed overflow hides via the SAME responsive classes the
  // grid uses, so no JS breakpoint listener can drift from the layout. U9:
  // an active query suspends the truncation — every match renders.
  const cardVisibilityClass = (index: number): string => {
    if (projectQueryActive || projectsExpanded || index < 2) return ''
    // C11 collapse fix: the visibility variants restore `flex` (the card's
    // own display), never `block` — a `:block` variant overrode the card's
    // base `flex` at ≥761px and collapsed the flex-col card (title/meta rows
    // stacked as blocks). Truncation semantics and breakpoints unchanged.
    if (index < 4) return 'hidden min-[761px]:flex'
    return 'hidden min-[761px]:hidden min-[1081px]:flex'
  }
  const projectsOverflow = sortedProjects.length > 2
  const expandRowClass = sortedProjects.length > 6
    ? ''
    : sortedProjects.length > 4
      ? 'min-[1081px]:hidden'
      : 'min-[761px]:hidden'

  /**
   * POO-205 (Spec Q8): entering a project of the CURRENT committed
   * organization is a LIGHTWEIGHT navigation — publish the active project,
   * land the conversation layout, open the project home (detail). Never a
   * space-switch transaction: the directory only lists the committed
   * organization's projects, so `onRequestSwitch` has nothing to do here.
   * The host-provided override (isolated test mounts) keeps its shape.
   */
  const jotaiStore = useStore()
  const [enteringProjectId, setEnteringProjectId] = useState<string | null>(null)
  // POO-205 C8 (R8): the home card's settings button is retired — the ONE
  // settings entry is the project tab sidebar's gear (ProjectTabSidebar), so
  // an edited project is re-read by the tab that is already open.
  const handleEnterProject = useCallback((entry: ProjectDirectoryEntry) => {
    if (onEnterProject) {
      onEnterProject(entry.id)
      return
    }
    if (enteringProjectId) return
    const accountId = projectsAccountId
    if (!accountId || projectsOrgScope === null) return
    setEnteringProjectId(entry.id)
    void enterProjectLightweight(accountId, {
      id: entry.id,
      organizationEnterpriseId: projectsOrgScope.organizationEnterpriseId,
      organizationProductSpaceId: entry.organizationProductSpaceId,
      name: entry.name,
      ...(entry.purpose ? { purpose: entry.purpose } : {}),
      ...(entry.instructions ? { instructions: entry.instructions } : {}),
      myRole: entry.role,
    }, jotaiStore).finally(() => {
      setEnteringProjectId(previous => (previous === entry.id ? null : previous))
    })
  }, [enteringProjectId, onEnterProject, projectsAccountId, projectsOrgScope])

  // H2 shared actions: open / prepare / permission feedback through the SAME
  // trusted flow, driven by the shared catalog instance.
  const memberActions = useMemberAppActions({
    context: { spaceKind, launchHandoff },
    catalog,
  })
  const prepareTargetApp = memberActions.prepareTarget?.app ?? null

  // POO-205 (Q7/Q11): the CURRENT space's 我的应用 — list/create/publish/
  // withdraw through the committed-scope myapps_* RPCs. The publish entry is
  // enterprise-only (a personal space never renders it; the admin wire
  // refuses it anyway — double safeguard).
  const myApps = useMyApps()

  const usage = useMemo(
    () => new Map(loadHomeAppUsage(usageContextKey)),
    [usageContextKey],
  )
  // Local hidden set (本机隐藏): the display preference of THIS device for
  // THIS account+space context. Hidden works drop out of the grid and appear
  // in the in-page restore section (P70-HOME-01 保留本机隐藏恢复).
  const hiddenApps = loadHomeHiddenApps(usageContextKey)
  const matchableEntries = useMemo(
    () => directory.entries.filter(entry => !hiddenApps.has(entry.identityKey)),
    // `hiddenVersion` re-derives after a local hide/restore; `hiddenApps` is
    // the stable module-level cache the mutation writes into.
    [directory.entries, hiddenApps, hiddenVersion],
  )
  const hiddenVisibleEntries = useMemo(
    () => directory.entries.filter(entry => hiddenApps.has(entry.identityKey)),
    [directory.entries, hiddenApps, hiddenVersion],
  )
  const sourceOptions = useMemo(
    () => collectHomeAppSourceOptions(matchableEntries).map(option => ({ ...option, key: `catalog:${option.key}` })),
    [matchableEntries],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => matchableEntries.filter(entry =>
      homeAppMatchesQuery(entry, normalizedQuery)
      && (sourceFilter === 'all' || (sourceFilter.startsWith('catalog:') && homeAppMatchesSource(entry, sourceFilter.slice('catalog:'.length), { literal: true })))),
    [matchableEntries, normalizedQuery, sourceFilter],
  )
  const visibleEntries = useMemo(
    () => sortHomeAppDirectory(filteredEntries, sortMode, usage),
    // Take a stable ordering for this visit. Successful shared opens update
    // the stored records; returning to Home mounts a fresh directory order.
    [filteredEntries, sortMode, usage],
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
    void memberActions.open(entry.app)
  }, [memberActions, phase, t])

  // Local hide (本机隐藏): a display preference of THIS device — never an
  // uninstall, never an authorization change. The work leaves the grid and
  // appears in the in-page restore section.
  const handleHideApp = useCallback((entry: HomeAppDirectoryEntry) => {
    hideHomeApp(usageContextKeyRef.current, entry.identityKey)
    setHiddenVersion(version => version + 1)
  }, [])

  const handleRestoreApp = useCallback((entry: HomeAppDirectoryEntry) => {
    restoreHomeApp(usageContextKeyRef.current, entry.identityKey)
    setHiddenVersion(version => version + 1)
  }, [])

  // ── POO-205 我的应用 partition (C12, R14) ─────────────────────────────────
  // The partition renders the myapps:list rows DIRECTLY — each row IS a
  // MyAppSummary, the count IS the list length. The former
  // catalog-member-row index + name correlation is retired here: two
  // independent sources drifted (a count>0 empty grid, missing badges in
  // personal spaces), and the list alone carries everything the row needs
  // (publishedEntryId drives the badge/withdraw flip).

  /** Localizes a myapps_* failure for toasts (code carries over the bridge). */
  const myAppsErrorText = useCallback((error: unknown): string => {
    const code = (error instanceof Error ? error.message : String(error)) as MyAppsErrorCode
    switch (code) {
      case 'myapps_signin_required':
        return t('poo205.myApps.errors.signinRequired')
      case 'myapps_scope_changed':
        return t('poo205.myApps.errors.scopeChanged')
      case 'myapps_service_unavailable':
        return t('poo205.myApps.errors.serviceUnavailable')
      case 'myapps_publish_unavailable_in_personal':
        return t('poo205.myApps.errors.unavailableInPersonal')
      // POO-205 A3b: the space write gate (409) refuses saves AND publishes.
      case 'myapps_space_restricted':
        return t('poo205.myApps.errors.spaceRestricted')
      default:
        return t('poo205.myApps.errors.generic')
    }
  }, [t])

  // Open by the member-app id DIRECTLY (C12, R14): the A3a admin launch
  // branch keys on `member_app.id + owner`, so the appId itself is the
  // launch key — no catalog-row resolution, no artifact/catalogVersion
  // re-derivation that goes staleContext on a lagging cache. The install
  // confirmation and the handoff publish stay the EXISTING member-app flow
  // (:167-178 shape): an uninstalled (or stale-versioned) row stages the
  // same prepare target; an installed one publishes the fresh grant as-is.
  const handleOpenMyApp = useCallback(async (app: MyAppSummary) => {
    if (phase !== 'ready') {
      toast.error(
        phase === 'offline'
          ? t('homeApps.organization.offlineWarning')
          : t('homeApps.errors.unavailable'),
      )
      return
    }
    const organizationId = catalog.state.catalog?.organizationId
      ?? catalog.productSpace?.activeProductSpaceId
      ?? null
    if (!organizationId) {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    try {
      const result = await window.electronAPI.productSpaceResolveLaunch(organizationId, app.appId)
      if (!result.success) {
        // Same copyable-code failure surface as the shared-grid open (U5).
        const launchError = new Error(result.message)
        Object.assign(launchError, { code: result.errorCode, errorCode: result.errorCode })
        toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
          description: (
            <HomeAppErrorToastDescription
              presentation={homeAppErrorPresentation(t, launchError, 'open', spaceKind)}
            />
          ),
        })
        return
      }
      const launch = result.launch
      if (!isMemberAppBundleLaunch(launch)) {
        // Fail closed: a member app always resolves to a bundle delivery;
        // anything else is a foreign projection and never launches.
        toast.error(t('homeApps.errors.unavailable'))
        return
      }
      const accountId = catalog.state.catalog?.accountId
        ?? catalog.productSpace?.accountId
        ?? null
      if (!accountId) {
        toast.error(t('homeApps.errors.staleContext'))
        return
      }
      // The row may lag (a re-save bumps the version and refreshes ONLY the
      // my-apps list): re-sync before staging the install so confirmPrepare
      // installs the version the fresh grant actually carries.
      let catalogRow = catalog.state.catalog?.apps.find(
        candidate => candidate.catalogEntryId === app.appId,
      ) ?? null
      if (!catalogRow || catalogRow.catalogVersion?.version !== launch.subject.version) {
        await catalog.sync(true)
        catalogRow = catalog.state.catalog?.apps.find(
          candidate => candidate.catalogEntryId === app.appId,
        ) ?? null
      }
      if (!catalogRow) {
        toast.error(t('homeApps.errors.staleContext'))
        return
      }
      const installState = catalog.getInstallState(catalogRow)
      if (installState?.state === 'installed' && installState.currentVersion === launch.subject.version) {
        // Installed at the granted version: hand off the FRESH launch —
        // never a re-resolve through the row.
        launchHandoff.publish(accountId, launch)
        if (usageContextKeyRef.current) {
          recordHomeAppUsage(usageContextKeyRef.current, app.appId)
        }
        return
      }
      memberActions.prepareMyApp(catalogRow, launch)
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: (
          <HomeAppErrorToastDescription
            presentation={homeAppErrorPresentation(t, error, 'open', spaceKind)}
          />
        ),
      })
    }
  }, [catalog, launchHandoff, memberActions, phase, spaceKind, t])

  const handlePublishMyApp = useCallback(async (app: MyAppSummary) => {
    setPublishConfirmTarget(null)
    try {
      await myApps.publish(app.appId)
      toast.success(t('poo205.myApps.toast.published', { name: app.name }))
      // Surface the new shared entry in the space directory immediately.
      await catalog.sync(true)
    } catch (error) {
      toast.error(t('poo205.myApps.errors.publishFailedTitle', { name: app.name }), {
        description: myAppsErrorText(error),
      })
    }
  }, [catalog, myApps, myAppsErrorText, t])

  const handleWithdrawMyApp = useCallback(async (app: MyAppSummary) => {
    try {
      await myApps.withdraw(app.appId)
      toast.success(t('poo205.myApps.toast.withdrawn', { name: app.name }))
      await catalog.sync(true)
    } catch (error) {
      toast.error(t('poo205.myApps.errors.withdrawFailedTitle', { name: app.name }), {
        description: myAppsErrorText(error),
      })
    }
  }, [catalog, myApps, myAppsErrorText, t])

  // Delete removes the member-app row entirely; the admin side withdraws a
  // published app in the same transaction, so the shared entry disappears
  // for every member — hence the explicit confirmation (C12, R14).
  const handleDeleteMyApp = useCallback(async (app: MyAppSummary) => {
    setDeleteConfirmTarget(null)
    try {
      await myApps.delete(app.appId)
      toast.success(t('poo205.myApps.toast.deleted', { name: app.name }))
      // A published row's shared entry is gone too — refresh the directory.
      await catalog.sync(true)
    } catch (error) {
      toast.error(t('poo205.myApps.errors.deleteFailedTitle', { name: app.name }), {
        description: myAppsErrorText(error),
      })
    }
  }, [catalog, myApps, myAppsErrorText, t])

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstallProductSpaceBundle(app, preserveData)
      toast.success(t('homeApps.toast.uninstalled', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.uninstallTitle', { name: app.name }), {
        // product-closure U5: copyable code badge on artifact-unavailability.
        description: <HomeAppErrorToastDescription presentation={homeAppErrorPresentation(t, error, 'uninstall', spaceKind)} />,
      })
    } finally {
      setPreserveData(true)
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

  // Grid body phases. The work-App slots render rows when the projection is
  // authoritative (ready), explains retained rows (denied/offline), or a
  // REFRESH failed over the retained cache (P70-HOME-03: a background sync
  // failure must never silently blank the directory — the stale cache stays
  // visible, non-launchable, under an explicit stale banner with retry). A
  // first load keeps the dedicated loading tile; a failure with NO cache
  // keeps the explicit retry tile (P70-HOME-03: never synthesize, never
  // auto-run).
  const hasCachedCatalog = catalog.state.catalog !== null
  const showDirectoryRows = phase === 'ready'
    || phase === 'denied'
    || phase === 'offline'
    || (phase === 'error' && hasCachedCatalog)
  const directoryEmpty = phase === 'empty'
  // A fully-rejected directory is NOT a vacuum (H1 reviewer contract): the
  // empty phase must be consumed together with rejections.length.
  const directoryRejected = directoryEmpty && directory.rejections.length > 0
  // C11 (R15): the MERGED vacuum — when both partitions are verifiably empty
  // the page renders ONE empty state (in the shared-grid section) speaking
  // for BOTH. The 我的应用 partition counts as verifiably empty only when its
  // own load finished without an error: loading and failure keep their own
  // faces and never merge into an honest-vacuum claim.
  const myAppsReady = !myApps.state.loading && !myApps.state.errorCode
  const bothPartitionsEmpty = directoryEmpty && !directoryRejected
    && myAppsReady && myApps.state.apps.length === 0

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
      style={workbenchStyle}
        className={clientWorkbenchFocusClassName + " mx-auto w-full max-w-[1260px] px-[18px] pb-[50px] pt-[30px] text-[15px] text-foreground min-[761px]:px-[26px] min-[761px]:pb-[58px] min-[761px]:pt-[36px] min-[1081px]:px-[44px] min-[1081px]:pb-[72px] min-[1081px]:pt-[46px]"}
      data-testid="home-app-hub"
    >
      {/* Prototype `.r14-home .home-hero`: 首页 title + space lead at
      left, the personal circles context link bottom-aligned at desktop and
      stacked full-width under the text at ≤760px. Enterprise homes never mix
      in the circles entry (P70-HOME-02). The test id is the long-standing
      HOME-SURFACE marker (see the note above). */}
      <div
        className="flex flex-col items-start justify-between mb-[32px] gap-[16px] min-[761px]:flex-row min-[761px]:items-center min-[851px]:gap-[28px]"
        data-testid="home-quick-access-section"
      >
        <div className="min-w-0">
          <h1
            data-testid="home-directory-title"
            className="m-0 text-[clamp(30px,3vw,38px)] font-[750] leading-[1.08] tracking-[-0.055em]"
          >
            {t('poo70.h3.home.title')}
          </h1>
          {catalog.productSpace && (
            <p className="mt-[13px] max-w-[690px] text-[15px] leading-[1.65] text-foreground-60">
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
              <strong className="text-[14px] font-semibold">{t('homeSpace.context.myCircles')}</strong>
              {/* Review #6: readable 11px metadata — muted token (AA-compliant). */}
              <small className="text-[14px] text-muted-foreground">
                {t('homeSpace.context.circlesCount', { count: catalog.creatorCircles?.length ?? 0 })}
              </small>
            </span>
            {/* Decorative affordance (aria-hidden) — fg-40 intentionally kept
                below AA per the review's decorative-semantics exemption. */}
            <Icons.ChevronRight className="size-3.5 text-foreground-40" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* POO-204: enterprise no longer renders the space-context hint block —
      the space name already lives in the TopBar's CurrentProductSpaceLabel and
      the description duplicated the hero lead above. The personal render below
      (circles card fallback) is the block's only remaining mount. */}

      {/* POO-196 R3 (P1/P2): the「项目」区域 — always present between the hero
      and the fixed canvas on ENTERPRISE homes. POO-205 C11 (R15): a personal
      space has no project scope at all — the whole section (title, resident
      search, the ONLY create entry, states and expand row) stays off the
      page instead of rendering a directory that could only fail. Header =
      title left + the U9 RESIDENT name search middle + the ONLY create entry
      right (P11); the app toolbar below is untouched (search/source/sort
      stay app-scoped). When the container cannot fit all three, the search
      wraps onto its own full-width row — it never degrades into an
      unlabeled icon. */}
      {spaceContext && spaceKind !== 'personal' && (
        <section data-testid="home-projects" className="mb-[36px]">
          <div className="mb-[16px] flex flex-wrap items-end justify-between gap-[12px]">
            <div className="min-w-0">
              <h2 className="m-0 text-[20px] font-[720] tracking-[-0.03em]">
                {t('home.projects.title')}
              </h2>
              <p className="m-0 mt-[6px] text-[13px] leading-[1.5] text-foreground-60">
                {t('home.projects.description')}
              </p>
            </div>
            {/* U9: the project name search is RESIDENT — every loaded
            directory (including the verified-empty one) offers it, fully
            decoupled from the expand/collapse preference. The no-match hint
            sits DIRECTLY below the input (never above it, never in the app
            region) and only ever speaks for a VERIFIED-ready directory —
            loading/failure keep their own faces. */}
            <div className="min-w-[220px] flex-1">
              <input
                type="search"
                value={projectQuery}
                onChange={event => setProjectQuery(event.target.value)}
                placeholder={t('home.projects.searchPlaceholder')}
                aria-label={t('home.projects.searchPlaceholder')}
                data-testid="home-project-search"
                className="min-h-[34px] w-full appearance-none rounded-[8px] border border-border bg-surface client-material-card px-[12px] py-[7px] text-[13px] text-foreground outline-none focus-visible:border-accent [&::-webkit-search-cancel-button]:appearance-none"
              />
              {projectsState.status === 'ready' && sortedProjects.length > 0 && projectQueryActive && filteredProjects.length === 0 && (
                <p
                  className="m-0 mt-[6px] text-[12px] leading-[1.5] text-muted-foreground"
                  data-testid="home-project-no-matches"
                >
                  {t('home.projects.noMatches')}
                </p>
              )}
            </div>
            {/* P11: the sole create entry in the whole client. Rendered only
            while the hosted-dialog callback exists (an isolated mount without
            it must not show a dead button). */}
            {typeof spaceContext.onOpenCreateProject === 'function' && (
              /* C11 (R15): aligned with the client-workbench primary-button
              spec (min-h-[32px] / text-[14px] / rounded-[8px]) instead of the
              former hand-written 12px face. */
              <button
                type="button"
                data-testid="home-project-create"
                className={clientWorkbenchPrimaryClassName + ' shrink-0 whitespace-nowrap'}
                onClick={() => spaceContext.onOpenCreateProject?.()}
              >
                <Icons.Plus className="size-[14px]" aria-hidden="true" />
                {t('home.projects.create')}
              </button>
            )}
          </div>

          {/* P4 state truthfulness: loading = skeletons, failure = an explicit
          in-section reload surface, stale cache = a「可能不是最新」marker —
          none of them ever render as「还没有项目」. */}
          {projectsState.status === 'loading' ? (
            <div
              className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3"
              data-testid="home-project-loading"
            >
              {[0, 1].map(index => (
                <div
                  key={index}
                  aria-hidden="true"
                  className="h-[96px] animate-pulse rounded-[20px] border border-foreground/10 bg-surface client-material-card motion-reduce:animate-none"
                />
              ))}
            </div>
          ) : projectsState.status === 'error' ? (
            <div
              className="grid justify-items-center gap-[8px] rounded-[20px] border border-dashed border-border px-[20px] py-[30px] text-center"
              data-testid="home-project-error"
            >
              <Icons.CloudOff className="size-[20px] text-muted-foreground" aria-hidden="true" />
              {/* P4: the version face is distinct — retrying the same wire
              cannot fix an unsupported negotiation, so it gets copy plus an
              expandable service guide (U4) instead of a retry button. The
              guide never claims a retry/refresh could fix it and never
              reports an update as done (客户端更新不等于服务已更新). */}
              <p className="m-0 text-[13px] font-medium">
                {projectsState.reason === 'version'
                  ? t('home.projects.versionUnsupported')
                  : t('home.projects.loadFailed')}
              </p>
              {projectsState.reason === 'version' && (
                <>
                  <button
                    type="button"
                    data-testid="home-project-update-guide"
                    aria-expanded={versionGuideOpen}
                    className="mt-[2px] inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-accent bg-accent px-[12px] text-[12px] font-medium text-white shadow-minimal transition-[box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:shadow-middle"
                    onClick={() => setVersionGuideOpen(open => !open)}
                  >
                    {versionGuideOpen ? t('home.projects.collapse') : t('home.projects.updateGuideAction')}
                  </button>
                  {versionGuideOpen && (
                    <div data-testid="home-project-update-guide-body" className="flex flex-col items-center gap-[8px] text-[12px] leading-[1.55]">
                      <p className="m-0 max-w-[420px] text-muted-foreground">
                        {t('home.projects.updateGuideBody')}
                      </p>
                      {settingsNavigationAvailable && (
                        <>
                          <button
                            type="button"
                            data-testid="home-project-client-update"
                            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                            onClick={() => navigate(routes.view.settings('app'))}
                          >
                            {t('home.projects.clientUpdateAction')}
                          </button>
                          <p className="m-0 text-[11px] leading-[1.45] text-muted-foreground">
                            {t('home.projects.clientUpdateNote')}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
              {projectsState.reason !== 'version' && (
                <button
                  type="button"
                  data-testid="home-project-error-retry"
                  className="mt-[2px] inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                  onClick={reloadProjects}
                >
                  {t('homeApps.actions.tryAgain')}
                </button>
              )}
            </div>
          ) : (
            <>
              {projectsState.stale && (
                <div
                  className="mb-[12px] inline-flex items-center gap-[6px] rounded-full border border-info/20 bg-info/8 px-[10px] py-[4px] text-[11px] text-info-text"
                  data-testid="home-project-stale"
                >
                  <Icons.AlertTriangle className="size-[12px]" aria-hidden="true" />
                  <span>{t('home.projects.stale')}</span>
                </div>
              )}
              {sortedProjects.length === 0 ? (
                /* P4: the single verified-empty state — the header's create
                button above is the ONE primary action; no second same-weight
                button inside the dashed card. */
                <div
                  className="rounded-[20px] border border-dashed border-border px-[20px] py-[30px] text-center text-[13px] text-muted-foreground"
                  data-testid="home-project-empty"
                >
                  {t('home.projects.empty')}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
                    {filteredProjects.map((entry, index) => {
                      // POO-205: a project is "current" when it is the
                      // ENTERED project (the active-project bus), not when a
                      // space id matches — projects are no longer spaces.
                      const isCurrent = projectsOrgScope !== null
                        && getActiveProjectFor(projectsAccountId ?? '', projectsOrgScope.productSpaceId)?.projectId === entry.id
                      // Lightweight entry is a quick local navigation: only
                      // the TARGET card shows the busy face; a failed history
                      // read still lands the project home (never a dead card),
                      // so no persistent per-card error face is needed.
                      const cardEntering = enteringProjectId === entry.id
                      return (
                        <article
                          key={entry.id}
                          data-testid="home-project-card"
                          data-product-space-id={entry.id}
                          role="button"
                          tabIndex={0}
                          aria-label={entry.name}
                          aria-busy={cardEntering || undefined}
                          onClick={() => handleEnterProject(entry)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              handleEnterProject(entry)
                            }
                          }}
                          className={cardVisibilityClass(index) + ' flex cursor-pointer flex-col gap-[8px] rounded-[20px] border border-border bg-surface client-material-card p-[18px] shadow-xs outline-none transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[1px] hover:border-foreground-20 hover:shadow-middle focus-visible:border-accent'}
                        >
                          <div className="flex items-start justify-between gap-[8px]">
                            {/* U14 card hierarchy: the conversation bubble
                            marks the card as a CHAT project at the name level
                            only — the frozen card chrome (radius / material /
                            hover lift / grid) is untouched. The icon is
                            decorative; the card's aria-label stays the pure
                            project name. */}
                            <h3 className="m-0 flex min-w-0 items-start gap-[6px] text-[15px] font-bold leading-[1.35]">
                              <Icons.MessageSquare className="mt-[2px] size-[15px] shrink-0 text-accent" aria-hidden="true" />
                              <span className="line-clamp-2 min-w-0">{entry.name}</span>
                            </h3>
                            {isCurrent && (
                              <span
                                data-testid="home-project-current"
                                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--accent-soft)] px-[8px] py-[1px] text-[11px] font-semibold leading-[1.6] text-accent"
                              >
                                {t('home.projects.current')}
                              </span>
                            )}
                          </div>
                          {entry.purpose && (
                            <p className="m-0 truncate text-[12px] leading-[1.5] text-muted-foreground">
                              {entry.purpose}
                            </p>
                          )}
                          {cardEntering && (
                            <div
                              data-testid="home-project-entering"
                              className="flex items-center gap-[6px] text-[12px] font-medium text-accent"
                            >
                              <Icons.LoaderCircle className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                              <span>{t('home.projects.entering')}</span>
                            </div>
                          )}
                          <div className="mt-auto flex flex-wrap items-center gap-[6px] pt-[4px] text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center whitespace-nowrap rounded-full bg-foreground-5 px-[7px] py-[1px] leading-[1.6]">
                              {t(`productSpace.role.${entry.role}`)}
                            </span>
                            {/* P4: member count shows only when the data
                            source actually knows it. */}
                            {typeof entry.memberCount === 'number' && (
                              <span className="whitespace-nowrap">
                                {t('home.projects.memberCount', { count: entry.memberCount })}
                              </span>
                            )}
                            {/* U3: the visible「进入项目」label rides bottom-
                            right. It is a NON-nested marker (the card itself
                            stays the single activation target — Enter/Space
                            activate it), shared verbatim by the U14 identity
                            work; never a second interactive element. */}
                            <span
                              data-testid="home-project-enter-label"
                              className="ml-auto inline-flex shrink-0 items-center gap-[2px] whitespace-nowrap text-[12px] font-semibold leading-[1.6] text-accent"
                            >
                              {t('home.projects.enter')}
                              <Icons.ChevronRight className="size-[12px]" aria-hidden="true" />
                            </span>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                  {/* U9: the expand/collapse row exists ONLY while the query
                  is empty — with an active query every match already shows,
                  so both controls would be meaningless. Neither control ever
                  touches the query (implicit erasure is impossible: the
                  collapse path flips the preference and nothing else; the
                  clearing gesture belongs to the input alone). */}
                  {sortedProjects.length > 0 && !projectQueryActive && (
                    projectsExpanded ? (
                      <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                        <button
                          type="button"
                          data-testid="home-project-collapse"
                          className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                          onClick={() => setProjectsExpanded(false)}
                        >
                          {t('home.projects.collapse')}
                        </button>
                      </div>
                    ) : (
                      projectsOverflow && (
                        /* P3: expand in place — the button's own visibility
                        tracks the current breakpoint (2×columns), so a wide
                        window that already shows every card shows no control. */
                        <div className={expandRowClass + ' mt-[12px]'}>
                          <button
                            type="button"
                            data-testid="home-project-expand"
                            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                            onClick={() => setProjectsExpanded(true)}
                          >
                            {t('home.projects.showAll', { count: sortedProjects.length })}
                          </button>
                        </div>
                      )
                    )
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* POO-154: 本机固定的画布应用 — the always-available re-open entry for
      pinned canvas apps. Device-local truth, independent of the catalog
      phases below (a closed pinned tab must never orphan its app). Renders
      nothing while nothing is pinned. */}
      <PinnedCanvasApps />

      {/* POO-196 R3 (P1): the「应用」分区标题 marks the app region so the
      project section above and the app toolbar below have clearly scoped
      labels — search/source/sort keep applying to Apps ONLY. C11 (R16): the
      header row carries the manage-skills entry (enterprise homes only) —
      the ProductSpaceSkillsDialog's production mount (its former assistant
      card retired). The dialog's data source is the OPEN-time
      productSpaceListSkills read with its own fail-visible error face; there
      is no separate pre-open permission probe, so the entry shows for every
      member of a committed enterprise space. */}
      {catalog.productSpace && (
        <div className="mb-[16px] flex flex-wrap items-center justify-between gap-[12px]">
          <h2
            className="m-0 text-[20px] font-[720] tracking-[-0.03em]"
            data-testid="home-apps-title"
          >
            {t('home.apps.title')}
          </h2>
          {spaceKind === 'enterprise' && (
            <button
              type="button"
              data-testid="home-apps-manage-skills"
              className={clientWorkbenchButtonClassName + ' inline-flex items-center justify-center'}
              onClick={() => setSkillsDialogOpen(true)}
            >
              <Icons.Settings2 className="size-[15px]" aria-hidden="true" />
              {t('home.appsSection.manageSkills')}
            </button>
          )}
        </div>
      )}

      {/* Prototype `.r14-toolbar`: search + source filter + sort. Hidden when
      the directory cannot be verified AND nothing cached is retained (a
      refresh failure over a retained cache keeps the toolbar usable over the
      stale rows), matching the prototype LOAD-FAIL state. */}
      {catalog.productSpace && (phase !== 'error' || hasCachedCatalog) && (
        <div
          className="mb-[24px] flex flex-wrap items-end gap-[16px]"
          data-testid="home-directory-toolbar"
        >
          <label className="grid min-w-[220px] flex-1 gap-[6px] text-[14px] text-muted-foreground">
            <span>{t('poo70.h3.home.searchLabel')}</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('poo70.h3.home.searchPlaceholder')}
              data-testid="home-directory-search"
              className="min-h-[38px] w-full appearance-none rounded-[8px] border border-border bg-surface client-material-card px-[12px] py-[9px] text-[15px] text-foreground outline-none focus-visible:border-accent [&::-webkit-search-cancel-button]:appearance-none"
            />
          </label>
          <label className="grid gap-[6px] text-[14px] text-muted-foreground">
            <span>{t('homeApps.allApps.sourceLabel')}</span>
            <WorkbenchSelect
              value={sourceFilter}
              onValueChange={setSourceFilter}
              aria-label={t('homeApps.allApps.sourceLabel')}
              data-testid="home-directory-source"
              options={[{ value: 'all', label: t('poo70.h3.home.sourceAll') }, ...sourceOptions.map(option => ({ value: option.key, label: option.label }))]}
            />
          </label>
          <label className="grid gap-[6px] text-[14px] text-muted-foreground">
            <span>{t('poo70.h3.home.sortLabel')}</span>
            <WorkbenchSelect<HomeAppSortMode>
              value={sortMode}
              onValueChange={setSortMode}
              aria-label={t('poo70.h3.home.sortLabel')}
              data-testid="home-directory-sort"
              options={[
                { value: 'recent', label: t('poo70.h3.home.sortRecent') },
                { value: 'frequent', label: t('poo70.h3.home.sortFrequent') },
                { value: 'name', label: t('poo70.h3.home.sortName') },
              ]}
            />
          </label>
        </div>
      )}

      {phase === 'denied' && (
        <div
          className="mt-[24px] rounded-[13px] border border-destructive/25 bg-destructive/8 px-4 py-3 text-xs text-destructive"
          data-testid="home-restricted-banner"
        >
          <span>{t('homeApps.organization.accessError')}</span>
          <button
            type="button"
            data-testid="home-directory-denied-retry"
            className="ml-[12px] inline-flex min-h-[28px] items-center rounded-[8px] border border-border px-[12px] font-medium text-foreground hover:bg-foreground-5"
            disabled={catalog.state.refreshing}
            onClick={() => { void catalog.sync(true) }}
          >
            {t('homeApps.actions.tryAgain')}
          </button>
        </div>
      )}
      {phase === 'offline' && (
        <div
          className="mt-[24px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="home-directory-offline-banner"
        >
          <span>{t('homeApps.organization.offlineWarning')}</span>
          <button
            type="button"
            data-testid="home-directory-offline-retry"
            className="ml-[12px] inline-flex min-h-[28px] items-center rounded-[8px] border border-border px-[12px] font-medium text-foreground hover:bg-foreground-5"
            disabled={catalog.state.refreshing}
            onClick={() => { void catalog.sync(true) }}
          >
            {t('homeApps.actions.tryAgain')}
          </button>
        </div>
      )}
      {phase === 'error' && hasCachedCatalog && (
        /* P70-HOME-03: a failed refresh over the retained cache must never
        silently blank the directory — the stale-catalog banner explains the
        state and carries the explicit retry. */
        <div
          className="mt-[24px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="home-directory-stale-banner"
        >
          <span>{t('homeApps.organization.refreshWarning')}</span>
          <button
            type="button"
            data-testid="home-directory-stale-retry"
            className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[14px] font-medium text-foreground hover:bg-foreground-5"
            onClick={() => { void catalog.sync(true) }}
          >
            {t('homeApps.actions.tryAgain')}
          </button>
        </div>
      )}

      <section>
        <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
          {/* POO-205 Catalog v2: no built-in cards here anymore — the Polo
          assistant is a base capability (opened from chat) and the enterprise
          knowledge base retired into the project shared-file area. The grid
          renders ONLY catalog rows (shared apps/skills). */}
          {phase === 'loading' && !catalog.state.catalog ? (
            <div
              className="flex min-h-[210px] min-[1081px]:min-h-[222px] items-center justify-center rounded-[20px] border border-foreground/10 bg-surface client-material-card"
              data-testid="home-directory-loading"
            >
              <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : phase === 'error' && !catalog.state.catalog ? (
            <div
              className="flex min-h-[210px] min-[1081px]:min-h-[222px] flex-col items-center justify-center rounded-[20px] border border-foreground/10 bg-surface client-material-card px-[24px] text-center"
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
                className="mt-3 inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[14px] font-medium text-foreground hover:bg-foreground-5"
                onClick={() => { void catalog.sync(true) }}
              >
                {t('homeApps.actions.tryAgain')}
              </button>
            </div>
          ) : (
            <>
              {showDirectoryRows && visibleEntries.map((entry) => {
                // POO-70 visual review R1 F2: a work whose every recorded
                // source is a lost circle authorization renders UNAVAILABLE —
                // disabled open (§13.11 不可用需明确原因) + the reason/rejoin
                // guidance under the card (the C4 不可用作品说明 pattern).
                // Rows with any remaining valid source keep the normal card.
                const sourceLost = hasOnlyLostCircleSources(entry)
                return (
                  <div key={entry.identityKey} className="group relative">
                    <MemberAppCard
                      variant="home"
                      app={entry.app}
                      runtimeStatus={runtimeStatusFor(entry.app)}
                      identityKey={entry.identityKey}
                      busy={Boolean(memberActions.operationStates[entry.identityKey])}
                      testId="home-directory-app"
                      openDisabled={entry.launchBlocked}
                      onOpen={() => handleOpenApp(entry)}
                    />
                    {entry.launchBlocked && (
                      <p
                        className="m-0 mt-[6px] px-[2px] text-[14px] leading-[1.5] text-muted-foreground"
                        data-testid={`home-directory-app-unavailable-${entry.identityKey}`}
                      >
                        {sourceLost
                          ? t('poo70.h3.home.sourceLostReason')
                          : t('homeApps.errors.unavailable')}
                      </p>
                    )}
                    {/* P70-HOME-01 保留本机隐藏恢复: a local hide control on
                    every row — a display preference of THIS device, never an
                    uninstall or an authorization change. The work moves to the
                    in-page restore section below the grid. Rendered on ready
                    rows only (a cached denied/offline/error row must not invite
                    preference writes over a non-authoritative view). */}
                    {phase === 'ready' && (
                      <button
                        type="button"
                        data-testid={`home-directory-hide-${entry.identityKey}`}
                        aria-label={t('poo70.h3.home.hideAction')}
                        title={t('poo70.h3.home.hideAction')}
                        onClick={() => handleHideApp(entry)}
                        className="absolute right-[10px] top-[10px] grid size-[26px] place-items-center rounded-[7px] text-foreground-40 opacity-0 transition-opacity hover:bg-foreground-5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Icons.EyeOff className="size-[13px]" aria-hidden="true" />
                      </button>
                    )}
                    {/* Retained local management: a work App installed on THIS
                    device keeps its uninstall entry even when the directory row
                    is not launchable (withdrawn tombstone / blocked row). The
                    entry is page-level UI on the existing uninstall flow; it
                    sits beside the hide control when both are present. */}
                    {catalog.getInstallState(entry.app)?.state === 'installed' && (
                      <button
                        type="button"
                        data-testid={`home-directory-uninstall-${entry.identityKey}`}
                        aria-label={t('homeApps.actions.uninstall')}
                        title={t('homeApps.actions.uninstall')}
                        onClick={() => setUninstallTarget(entry.app)}
                        className={
                          phase === 'ready'
                            ? 'absolute right-[40px] top-[10px] grid size-[26px] place-items-center rounded-[7px] text-foreground-40 opacity-0 transition-opacity hover:bg-foreground-5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
                            : 'absolute right-[10px] top-[10px] grid size-[26px] place-items-center rounded-[7px] text-foreground-40 opacity-0 transition-opacity hover:bg-foreground-5 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
                        }
                      >
                        <Icons.Trash2 className="size-[13px]" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        {showDirectoryRows && hiddenVisibleEntries.length > 0 && (
          /* P70-HOME-01 保留本机隐藏恢复: the in-page restore surface —
          everything THIS device hid from THIS account+space context, each
          with an explicit restore action back into the directory. */
          <div
            className="mt-[16px] rounded-[20px] border border-dashed border-border px-[20px] py-[18px]"
            data-testid="home-directory-hidden-section"
          >
            <div className="flex items-center gap-[8px]">
              <Icons.EyeOff className="size-[14px] text-muted-foreground" aria-hidden="true" />
              <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em] text-muted-foreground">
                {t('poo70.h3.home.hiddenSectionTitle')}
              </h2>
              <span className="inline-flex min-h-[18px] items-center rounded-full bg-foreground/6 px-[7px] text-[14px] font-medium text-muted-foreground">
                {hiddenVisibleEntries.length}
              </span>
            </div>
            <ul className="m-0 mt-[10px] grid list-none gap-[6px] p-0">
              {hiddenVisibleEntries.map(entry => (
                <li
                  key={entry.identityKey}
                  className="flex min-h-[34px] items-center justify-between gap-[12px] rounded-[10px] px-[10px] hover:bg-foreground-4"
                  data-testid={`home-directory-hidden-item-${entry.identityKey}`}
                >
                  <span className="min-w-0 truncate text-[14px] text-foreground-70">{entry.app.name}</span>
                  <button
                    type="button"
                    data-testid={`home-directory-hidden-restore-${entry.identityKey}`}
                    className="inline-flex min-h-[26px] shrink-0 items-center justify-center whitespace-nowrap rounded-[7px] border border-border bg-transparent px-[10px] text-[14px] font-medium text-foreground hover:bg-foreground-5"
                    onClick={() => handleRestoreApp(entry)}
                  >
                    {t('poo70.h3.home.hiddenRestore')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {directoryRejected && (
          <div
            className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-destructive/30 px-[20px] py-[34px] text-center"
            data-testid="home-directory-rejected"
          >
            <span className="grid size-[52px] place-items-center rounded-[14px] bg-destructive/10 text-destructive">
              <Icons.ShieldQuestion className="size-[25px]" aria-hidden="true" />
            </span>
            <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
              {t('poo70.h3.home.rejectedTitle')}
            </h2>
            <p className="m-0 max-w-[460px] text-[14px] leading-[1.5] text-muted-foreground">
              {t('poo70.h3.home.rejectedHint')}
            </p>
            <button
              type="button"
              className="mt-[4px] inline-flex min-h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[14px] font-medium text-foreground hover:bg-foreground-5"
              onClick={() => { void catalog.sync(true) }}
            >
              {t('homeApps.actions.tryAgain')}
            </button>
          </div>
        )}
        {directoryEmpty && !directoryRejected && catalog.productSpace && (
          /* Honest vacuum (P70-HOME-03) + C11 (R15) merged vacuum: personal
          spaces invite the circles join path, enterprise spaces say plainly
          that nothing has been distributed yet — never a generic "no
          results". With BOTH partitions verifiably empty this is the page's
          ONE empty state and the hint speaks for both (saved AND shared
          apps); the enterprise/personal faces keep their distinct guidance.
          A 我的应用 partition still loading/failed never merges — its own
          face renders in its section instead. */
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
                <p className="m-0 max-w-[460px] text-[14px] leading-[1.5] text-muted-foreground">
                  {bothPartitionsEmpty
                    ? t('home.appsSection.emptyMergedEnterprise')
                    : t('poo70.h3.home.emptyEnterprise')}
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
                <p className="m-0 max-w-[460px] text-[14px] leading-[1.5] text-muted-foreground">
                  {bothPartitionsEmpty
                    ? t('home.appsSection.emptyMergedPersonal')
                    : t('poo70.h3.home.emptyPersonalHint')}
                </p>
              </>
            )}
          </div>
        )}
        {showDirectoryRows && phase === 'ready' && directory.entries.length === 0 && myApps.state.apps.length > 0 && (
          /* POO-205: the space holds ONLY member rows — the shared grid is
          honestly empty while the 我的应用 partition above carries the rows
          (the phase counts both partitions, so this face must exist). */
          <div
            className="mt-[16px] grid justify-items-center gap-[10px] rounded-[20px] border border-dashed border-border px-[20px] py-[34px] text-center"
            data-testid="home-directory-shared-empty"
          >
            <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">
              {t('homeApps.allApps.empty')}
            </h2>
            <p className="m-0 max-w-[460px] text-[14px] leading-[1.5] text-muted-foreground">
              {t('poo70.h3.home.emptyEnterprise')}
            </p>
          </div>
        )}
        {phase === 'ready' && matchableEntries.length > 0 && visibleEntries.length === 0 && (
          /* Prototype `[data-library-empty]`: the search/filter vacuum —
          distinct from the directory vacuum above, with the explicit clear
          action. Fully-hidden directories do NOT show this: the restore
          section below is the accurate feedback for that state. */
          <div
            className="mt-[16px] grid justify-items-center gap-[8px] rounded-[20px] border border-dashed border-border px-[20px] py-[30px] text-center"
            data-testid="home-directory-no-match"
          >
            <h2 className="m-0 text-[16px] font-bold tracking-[-0.02em]">
              {t('poo70.h3.home.noMatch')}
            </h2>
            <p className="m-0 text-[14px] leading-[1.5] text-muted-foreground">
              {t('poo70.h3.home.noMatchHint')}
            </p>
            <button
              type="button"
              className="mt-[2px] inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[14px] font-medium text-foreground hover:bg-foreground-5"
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

      {/* POO-205 (Q7/Q11) 「我的应用」分区 — AFTER the shared directory
      (C11/R15 IA order): the partition sits AFTER the shared app grid so
      the toolbar-filtered grid stays adjacent to its toolbar in one
      segment. The member's own saved canvas apps of THIS space, each with
      the open action and (enterprise spaces only) the explicit publish /
      withdraw actions. The partition carries its own title, vacuum and
      failure faces; a personal space renders the same partition WITHOUT
      the publish entry. C12 (R14): the partition gates on the LIST's
      committed scope — the member apps render in personal AND enterprise
      spaces alike; only the publish entry stays enterprise-only. */}
      {myApps.scope && (
        <section className="mb-[36px]" data-testid="home-my-apps">
          <div className="mb-[16px] flex flex-wrap items-center justify-between gap-[12px]">
            <div className="flex min-w-0 items-center gap-[10px]">
              <h2
                className="m-0 text-[20px] font-[720] tracking-[-0.03em]"
                data-testid="home-my-apps-title"
              >
                {t('poo205.myApps.title')}
              </h2>
              <span className="inline-flex min-h-[20px] items-center rounded-full bg-foreground-5 px-[8px] text-[12px] font-medium text-muted-foreground">
                {myApps.state.apps.length}
              </span>
            </div>
            <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-foreground-60">
              {t('poo205.myApps.subtitle')}
            </p>
          </div>
          {myApps.state.loading ? (
            <div
              className="flex min-h-[120px] items-center justify-center rounded-[20px] border border-foreground/10 bg-surface client-material-card"
              data-testid="home-my-apps-loading"
            >
              <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : myApps.state.errorCode ? (
            <div
              className="grid justify-items-center gap-[8px] rounded-[20px] border border-dashed border-border px-[20px] py-[24px] text-center"
              data-testid="home-my-apps-error"
            >
              <Icons.CloudOff className="size-[18px] text-muted-foreground" aria-hidden="true" />
              <p className="m-0 text-[13px] text-muted-foreground">
                {t('poo205.myApps.loadFailed')}
              </p>
              <button
                type="button"
                data-testid="home-my-apps-retry"
                className="inline-flex min-h-[28px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[10px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
                onClick={() => { void myApps.refresh() }}
              >
                {t('homeApps.actions.tryAgain')}
              </button>
            </div>
          ) : myApps.state.apps.length === 0 && !bothPartitionsEmpty ? (
            /* C11 (R15): this own vacuum only renders when the shared
            directory still has rows — with BOTH partitions empty the page's
            single merged empty state (in the shared-grid section above)
            speaks for both, so the partition keeps just its header row. */
            <div
              className="rounded-[20px] border border-dashed border-border px-[20px] py-[24px] text-center text-[13px] text-muted-foreground"
              data-testid="home-my-apps-empty"
            >
              {t('poo205.myApps.empty')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
              {/* C12 (R14): each row IS a myapps:list entry — no catalog-row
              correlation. The published badge and the withdraw entry read
              `publishedEntryId` straight off the row; open keys on the
              member-app id DIRECTLY. */}
              {myApps.state.apps.map((app) => {
                const publishing = myApps.state.publishingAppIds.has(app.appId)
                const withdrawing = myApps.state.withdrawingAppIds.has(app.appId)
                const deleting = myApps.state.deletingAppIds.has(app.appId)
                const published = Boolean(app.publishedEntryId)
                return (
                  <div key={app.appId} className="group relative">
                    <article
                      data-testid="home-myapp-card"
                      data-identity-key={app.appId}
                      aria-busy={publishing || withdrawing || deleting || undefined}
                      className="flex min-h-[210px] min-[1081px]:min-h-[222px] flex-col rounded-[20px] border border-border bg-surface client-material-card p-[18px] shadow-xs transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[1px] hover:border-foreground-20 hover:shadow-middle min-[1081px]:p-[20px]"
                    >
                      <div className="mb-[18px] flex items-start justify-between gap-[8px]">
                        {/* myapps:list rows carry no iconUrl (admin wire
                        has none) — the letter tile is the only face. */}
                        <span className="grid size-[42px] flex-none place-items-center overflow-hidden rounded-[13px] bg-[var(--accent-soft)] text-accent">
                          <span className="text-[17px] font-semibold">{app.name.slice(0, 1)}</span>
                        </span>
                        {/* Published state reads the ROW (C12, R14): a
                        non-null publishedEntryId IS published — no pairing
                        with the catalog projection. */}
                        <span
                          data-testid={`home-myapp-badge-${app.appId}`}
                          className={
                            published
                              ? 'inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-success/10 px-[8px] py-[1px] text-[11px] font-semibold leading-[1.6] text-success'
                              : 'inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-foreground-5 px-[8px] py-[1px] text-[11px] font-semibold leading-[1.6] text-muted-foreground'
                          }
                        >
                          {published
                            ? t('poo205.myApps.badge.published')
                            : t('poo205.myApps.badge.unpublished')}
                        </span>
                      </div>
                      <h3 className="m-0 text-[16px] font-bold leading-[normal]">{app.name}</h3>
                      <p className="mt-[17px] text-[14px] leading-[1.6] text-muted-foreground">
                        {app.description || t('homeApps.noDescription')}
                      </p>
                      <div className="mt-auto flex items-center justify-end gap-[7px] pt-[14px]">
                        {/* Publish (enterprise only) / withdraw / delete —
                        publish and delete route through their explicit
                        confirmations; withdraw is reversible and stays
                        one-click. A personal space never renders publish. */}
                        {myApps.canPublish && !published && (
                          <button
                            type="button"
                            data-testid={`home-myapp-publish-${app.appId}`}
                            disabled={publishing}
                            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[13px] font-medium text-foreground hover:bg-foreground-5 disabled:opacity-60"
                            onClick={() => { setPublishConfirmTarget(app) }}
                          >
                            {publishing
                              ? t('poo205.myApps.publishingAction')
                              : t('poo205.myApps.publishAction')}
                          </button>
                        )}
                        {published && (
                          <button
                            type="button"
                            data-testid={`home-myapp-withdraw-${app.appId}`}
                            disabled={withdrawing}
                            className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[13px] font-medium text-foreground hover:bg-foreground-5 disabled:opacity-60"
                            onClick={() => { void handleWithdrawMyApp(app) }}
                          >
                            {withdrawing
                              ? t('poo205.myApps.withdrawingAction')
                              : t('poo205.myApps.withdrawAction')}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid={`home-myapp-delete-${app.appId}`}
                          disabled={deleting}
                          className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-transparent bg-transparent px-[12px] text-[13px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                          onClick={() => { setDeleteConfirmTarget(app) }}
                        >
                          {deleting
                            ? t('poo205.myApps.deletingAction')
                            : t('poo205.myApps.deleteAction')}
                        </button>
                        {/* Open keys on the member-app id DIRECTLY (C12,
                        R14): resolve-launch by appId through the A3a admin
                        branch, then the SAME install-confirmation/handoff
                        flow as the shared grid. */}
                        <button
                          type="button"
                          data-testid={`home-myapp-open-${app.appId}`}
                          disabled={deleting}
                          className="inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-accent bg-accent px-[12px] text-[13px] font-semibold text-white shadow-minimal transition-[box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:shadow-middle disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none"
                          onClick={() => { void handleOpenMyApp(app) }}
                        >
                          {t('common.open')}
                        </button>
                      </div>
                    </article>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {catalog.productSpace && spaceKind === 'personal' && showCirclesCard && (
        <HomeSpaceContext
          spaceName={activeProductSpace?.name
            || t('homeApps.organization.current')}
          spaceKind="personal"
          spaceCategory={spaceCategory}
          creatorCircles={catalog.creatorCircles}
          spaceKey={catalog.productSpace.productSpaceContextKey}
        />
      )}

      <Dialog open={Boolean(memberActions.prepareTarget)} onOpenChange={(open) => {
        if (!open) memberActions.cancelPrepare()
      }}>
        <DialogContent style={workbenchStyle} overlayStyle={workbenchStyle} overlayClassName={clientWorkbenchOverlayClassName} className={clientWorkbenchDialogClassName}>
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
          <div className="px-[20px] pb-[18px]">
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
          </div>
          <DialogFooter>
            <Button className={clientWorkbenchButtonClassName} type="button" variant="secondary" onClick={() => memberActions.cancelPrepare()}>
              {t('common.cancel')}
            </Button>
            <Button className={clientWorkbenchPrimaryClassName} type="button" onClick={() => { void memberActions.confirmPrepare() }}>
              {prepareTargetApp && catalog.getInstallState(prepareTargetApp)?.state === 'installed'
                ? t('homeApps.actions.update')
                : t('homeApps.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* POO-205 C12: the publish confirmation — publishing makes the app
      visible to the WHOLE organization's space directory, so the click only
      stages; cancel stages nothing. */}
      <Dialog open={Boolean(publishConfirmTarget)} onOpenChange={(open) => {
        if (!open) setPublishConfirmTarget(null)
      }}>
        <DialogContent style={workbenchStyle} overlayStyle={workbenchStyle} overlayClassName={clientWorkbenchOverlayClassName} className={clientWorkbenchDialogClassName}>
          <DialogHeader>
            <DialogTitle data-testid="home-myapp-publish-confirm-title">
              {t('poo205.myApps.publishConfirmTitle', {
                name: publishConfirmTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('poo205.myApps.publishConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className={clientWorkbenchButtonClassName}
              type="button"
              variant="secondary"
              data-testid="home-myapp-publish-confirm-cancel"
              onClick={() => setPublishConfirmTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className={clientWorkbenchPrimaryClassName}
              type="button"
              data-testid="home-myapp-publish-confirm-action"
              onClick={() => { if (publishConfirmTarget) void handlePublishMyApp(publishConfirmTarget) }}
            >
              {t('poo205.myApps.publishConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* POO-205 C12: the delete confirmation — deleting removes the member
      app AND (admin-side, same transaction) withdraws a published app, so
      the shared directory entry disappears for every member; the copy says
      so for published rows. Cancel stages nothing. */}
      <Dialog open={Boolean(deleteConfirmTarget)} onOpenChange={(open) => {
        if (!open) setDeleteConfirmTarget(null)
      }}>
        <DialogContent style={workbenchStyle} overlayStyle={workbenchStyle} overlayClassName={clientWorkbenchOverlayClassName} className={clientWorkbenchDialogClassName}>
          <DialogHeader>
            <DialogTitle data-testid="home-myapp-delete-confirm-title">
              {t('poo205.myApps.deleteConfirmTitle', {
                name: deleteConfirmTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription data-testid="home-myapp-delete-confirm-body">
              {deleteConfirmTarget?.publishedEntryId
                ? t('poo205.myApps.deleteConfirmPublishedBody')
                : t('poo205.myApps.deleteConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              className={clientWorkbenchButtonClassName}
              type="button"
              variant="secondary"
              data-testid="home-myapp-delete-confirm-cancel"
              onClick={() => setDeleteConfirmTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className={clientWorkbenchButtonClassName}
              type="button"
              variant="destructive"
              data-testid="home-myapp-delete-confirm-action"
              onClick={() => { if (deleteConfirmTarget) void handleDeleteMyApp(deleteConfirmTarget) }}
            >
              {t('poo205.myApps.deleteConfirmAction')}
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
        <DialogContent style={workbenchStyle} overlayStyle={workbenchStyle} overlayClassName={clientWorkbenchOverlayClassName} className={clientWorkbenchDialogClassName}>
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
          <div className="px-[20px] pb-[18px]">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-foreground/10 p-3 text-sm">
            <Checkbox
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
          </div>
          <DialogFooter>
            <Button className={clientWorkbenchButtonClassName} type="button" variant="secondary" onClick={() => setUninstallTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button className={clientWorkbenchDestructiveClassName} type="button" variant="destructive" onClick={() => { void confirmUninstall() }}>
              {t('homeApps.actions.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* C11 (R16): the manage-skills dialog — its FIRST production mount
      (the former assistant card retired). Own close state; the dialog reads
      the committed space through the shared ProductSpace context. */}
      {skillsDialogOpen && (
        <ProductSpaceSkillsDialog onClose={() => setSkillsDialogOpen(false)} />
      )}

    </main>
    </div>
  )
}
