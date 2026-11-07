/**
 * poo196-project-context harness host page: mounts the PRODUCTION ChatPage /
 * HomePage / ProjectConversationEmptyState over the fixture electronAPI.
 * Session data is seeded through the production atoms before pages mount;
 * fixture boundaries are the window manager / tab shell / IPC / login state
 * (see README). Every business component under the mounted page is production
 * source.
 *
 * POO-196 R3 (D11/D12): a `?mode=home` mount renders the production HomePage
 * inside the production TabShell + MemberCatalog provider contracts (the
 * catalog instance is the fixture boundary — injected, never fabricated DOM),
 * and the R3 entry flow (useProjectEntry) drives the SAME production surface
 * rule as MainContentPanel: navigate-allSessions(id) → ChatPage, committed
 * enterprise project with no details → ProjectConversationEmptyState. The
 * space context COMMITS switches (active space + contextVersion bump) so the
 * two-phased entry transaction observes a real committed scope, and
 * onRequestSwitch/onSelectProductSpace are both observable through the tagged
 * spaceSwitchLog.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider as JotaiProvider, createStore, useStore } from 'jotai'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@polo-ai/ui'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import { initReactI18next } from 'react-i18next'
import '@/index.css'
import { ThemeProvider, useTheme } from '@/context/ThemeContext'
import { NavigationProvider, useNavigationState } from '@/contexts/NavigationContext'
import { FocusProvider } from '@/context/FocusContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ModalProvider } from '@/context/ModalContext'
import { ProductSpaceProvider, useProductSpaceContext, type ProductSpaceContextValue } from '@/context/ProductSpaceContext'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { TabShellProvider } from '@/context/TabShellContext'
import { MemberCatalogProvider } from '@/context/MemberCatalogContext'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import { ProductSpaceSwitcher } from '@/components/product-space/ProductSpaceSwitcher'
import { DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent } from '@/components/ui/styled-dropdown'
import { replaceLoadedSessionAtom } from '@/atoms/sessions'
import { projectAssetDraftRefsAtomFamily } from '@/atoms/project-context'
import { focusedPanelRouteAtom } from '@/atoms/panel-stack'
import ChatPage from '@/pages/ChatPage'
import { HomePage } from '@/components/tab-browser/HomePage'
import { ProjectConversationEmptyState } from '@/components/project-context/ProjectConversationEmptyState'
import { CreateProjectDialog } from '@/components/product-space/CreateProjectDialog'
import { ProjectEntryHistoryErrorFace } from '@/components/app-shell/MainContentPanel'
import { useProjectEntry } from '@/hooks/useProjectEntry'
import { projectEntryAtom, projectEntryPendingAtom, projectEntrySendNoticesAtom, projectOnboardingIntentAtom } from '@/atoms/project-entry'
import { NAVIGATE_EVENT } from '@/lib/navigate'
import { __resetProjectVisitsForTests } from '@/lib/project-directory'
import {
  SESSION_PERSONAL,
  SESSION_PROJECT,
  SESSION_PROJECT_EMPTY,
  WORKSPACE_ID,
  CURRENT_USER_ID,
  PERSONAL_SPACE_ID,
  PRODUCT_SPACE_ID,
  R3_PROJECT_ALPHA_ID,
  createdSessionFixture,
  initialR3Directory,
  productSpaceContextValue,
  r3Sessions,
  sessionsById,
} from '../fixture-data'

await setupI18n([initReactI18next])

const params = new URLSearchParams(window.location.search)
const initialLang = params.get('lang') ?? 'zh-Hans'
const initialTheme = (params.get('theme') ?? 'light') as 'light' | 'dark'
const initialSession = params.get('session') ?? SESSION_PROJECT
await i18n.changeLanguage(initialLang)
document.documentElement.lang = initialLang

const sendMessageLog: Array<{
  sessionId: string
  message: string
  projectAssetRefs: Array<{ assetId: string; version: number; name: string }>
  attachments: Array<{ name?: string }>
  kbCollectionIds: string[]
  elementReferences: Array<{ id?: string }>
}> = []

const openUrlLog: string[] = []

/** UB1 (U12) evidence channel: every navigator.clipboard.writeText call with
 * its payload length. The Markdown pop-out pin asserts the「Markdown」entry
 * still OPENS THE PREVIEW (no clipboard write), while the Copy button keeps
 * writing — the spy wraps, never replaces, the real clipboard. */
const clipboardLog: string[] = []
if (typeof navigator !== 'undefined' && navigator.clipboard) {
  const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard)
  Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: async (text: string) => {
      clipboardLog.push(String(text ?? ''))
      return originalWriteText(text)
    },
  })
}

/** POO-196 追加轮: the controlled space switches the create dialog hands to
 * the host (D-B 7) — the orchestrator reads this instead of spying on atoms.
 * R3: entries are TAGGED — `select:<id>` (onSelectProductSpace, the legacy
 * switch path), `request:<id>` + `committed:<id>` (onRequestSwitch, the
 * project-entry transaction). */
const spaceSwitchLog: string[] = []

/** R3: the production navigate() channel (window NAVIGATE_EVENT) — the entry
 * flow's landing route is asserted here, not by spying on atoms. */
const routeLog: string[] = []
const navigateLog: Array<{ route: string; skipAutoSelect: boolean }> = []
window.addEventListener(NAVIGATE_EVENT, (event) => {
  const detail = (event as CustomEvent).detail as { route?: unknown; skipAutoSelect?: boolean } | null
  navigateLog.push({
    route: typeof detail?.route === 'string' ? detail.route : String(detail?.route ?? ''),
    skipAutoSelect: Boolean(detail?.skipAutoSelect),
  })
})

/** R3 (D14): the empty state's first trusted send — onCreateSession calls
 * with the productSpaceId the fixture bound the created session to. */
const createSessionLog: Array<{ productSpaceId: string; sessionId: string }> = []
let firstSendSeq = 0
/** `wrongScope` mirrors a create that lands in ANOTHER project — the D14
 * scope fence must refuse the send (project.entry.scopeChanged). */
let createSessionScript: 'ok' | 'wrongScope' = 'ok'

/** D-B 7 failure face: when set to a space id, the refreshed list
 * deliberately OMITS that space, so the auto-enter finds no target and the
 * dialog must KEEP the「项目已创建」page (retry only — never a re-create). */
let refreshMissingId: string | null = null

/** UB2 (U3): the next onRequestSwitch rejects once — the production cancel /
 * failure face (explicit cancel along the original transaction reason). */
let switchRejectOnce = false

/** R2 扩展: viewer-role / space-list overrides for the members two-state and
 * the space-menu reachability surfaces. Mutated ONLY through the
 * window.__poo196Space setters (each bumps the override tick so the context
 * value is rebuilt — the same refresh the real App performs after
 * refreshProductSpaces). */
const spaceOverride = {
  role: 'manager' as 'owner' | 'manager' | 'member',
  personalOnly: false,
  /** R3: the committed active space id (fixture context commit). */
  activeSpaceId: PRODUCT_SPACE_ID,
  /** R3: monotonic context version — bumped on every committed switch, the
   * same productSpaceContextKey/epoch change the real transaction publishes. */
  contextVersion: 7,
  /** R3 (D7): the signed-in account display name. Blank or >64 code units
   * drives ownerNeedsInput (「你的姓名」completion field). */
  adminDisplayName: '林奕',
  /** R3 (D13.1): when true, in-flight switches PARK before committing so the
   * orchestrator can observe the entry send gate mid-transaction. */
  holdSwitch: false,
  /** R3 (P3): the signed-in ACCOUNT id — the home visit ordering is keyed
   * per account, so the isolation check swaps this and re-reads. */
  accountId: 'acct-lin-01',
}
const spaceMenuLog: string[] = []
const spaceRefreshLog: number[] = []

/** R3: ONE shared control-surface object. SpaceContextHost owns the space
 * keys, AppShellHost owns the admin-identity keys — components assign their
 * own keys each render and NEVER replace the object (a sibling render that
 * bails out would otherwise resurrect a stale no-op setter). */
const poo196SpaceBridge: Record<string, unknown> = {}
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__poo196Space = poo196SpaceBridge
}

/** Space records the fixture context commits to (enterprise shape). Created
 * spaces register their display names through the refresh handover. */
const fixtureSpaceRecords = new Map<string, { enterpriseId: string; name: string; role: string; accessMode: string }>()
for (const space of initialR3Directory().spaces.productSpaces as Array<{ id: string; kind: string; enterpriseId?: string; name?: string; role?: string; accessMode?: string }>) {
  if (space.kind === 'enterprise' && space.enterpriseId) {
    fixtureSpaceRecords.set(space.id, {
      enterpriseId: space.enterpriseId,
      name: space.name ?? space.id,
      role: space.role ?? 'member',
      accessMode: space.accessMode ?? 'active',
    })
  }
}
const registerSpaceName = (item: Record<string, unknown>) => {
  const productSpaceId = String(item.id ?? '')
  if (!productSpaceId) return
  const existing = fixtureSpaceRecords.get(productSpaceId)
  if (existing) {
    if (typeof item.name === 'string' && item.name) existing.name = item.name
    return
  }
  // A space that materialized through the refresh handover (e.g. the
  // just-created project): register it so a subsequent commit can host it.
  fixtureSpaceRecords.set(productSpaceId, {
    enterpriseId: String(item.enterpriseId ?? `ent-of-${productSpaceId}`),
    name: typeof item.name === 'string' && item.name ? item.name : productSpaceId,
    role: typeof item.role === 'string' && item.role ? item.role : 'owner',
    accessMode: typeof item.accessMode === 'string' && item.accessMode ? item.accessMode : 'active',
  })
}

function spaceRecordOf(productSpaceId: string) {
  const record = fixtureSpaceRecords.get(productSpaceId)
  if (!record) return null
  const role = (productSpaceId === PRODUCT_SPACE_ID
    ? spaceOverride.role
    : record.role) as 'owner' | 'manager' | 'member'
  return {
    id: productSpaceId,
    kind: 'enterprise' as const,
    enterpriseId: record.enterpriseId,
    name: record.name,
    role,
    accessMode: record.accessMode,
    payer: { enterpriseId: record.enterpriseId, plan: 'enterprise' },
  }
}

/** Applies the override to the fixture context value (fresh object each call).
 * `personalOnly` keeps the ACTIVE space untouched (ChatPage stability) while
 * the switcher LIST shows only the personal space — the D-D 1 reachability
 * claim under test is that the create entry renders from the LIST alone. */
function overriddenSpaceContext(): ProductSpaceContextValue {
  const value = JSON.parse(JSON.stringify(productSpaceContextValue)) as ProductSpaceContextValue
  const record = value as unknown as {
    accountId: string
    activeProductSpaceId: string
    activeProductSpace: { id: string; kind: string; enterpriseId: string; name: string; role: string; accessMode: string; payer: { enterpriseId: string; plan: string } }
    productSpaces: Array<{ id: string; kind: string; role?: string }>
    allProductSpaces: Array<{ id: string; kind: string; role?: string }>
    personalProductSpaceId: string
    productSpaceContextKey: string
    contextVersion: number
  }
  const active = spaceRecordOf(spaceOverride.activeSpaceId) ?? spaceRecordOf(PRODUCT_SPACE_ID)!
  record.accountId = spaceOverride.accountId
  record.activeProductSpaceId = active.id
  record.activeProductSpace = JSON.parse(JSON.stringify(active))
  record.contextVersion = spaceOverride.contextVersion
  record.productSpaceContextKey = `${spaceOverride.accountId}::${active.id}::${spaceOverride.contextVersion}`
  // R3: the authorized list = the FULL directory the account can see (the
  // organization aggregate, the personal space and every project space) —
  // enterProject refuses targets outside it, exactly like production.
  const directorySpaces = [...fixtureSpaceRecords.entries()].map(([id, entry]) => ({
    id,
    kind: 'enterprise',
    enterpriseId: entry.enterpriseId,
    name: entry.name,
    role: id === PRODUCT_SPACE_ID ? spaceOverride.role : entry.role,
    accessMode: entry.accessMode,
    payer: { enterpriseId: entry.enterpriseId, plan: 'enterprise' },
  }))
  const personalSpace = { id: PERSONAL_SPACE_ID, kind: 'personal', name: '我的空间', accessMode: 'active', payer: { userId: record.accountId, plan: 'pro' } }
  record.productSpaces = [...directorySpaces, personalSpace] as unknown as ProductSpaceContextValue['productSpaces']
  record.allProductSpaces = [...directorySpaces, personalSpace] as unknown as ProductSpaceContextValue['allProductSpaces']
  if (spaceOverride.personalOnly) {
    record.productSpaces = record.productSpaces.filter(item => item.kind !== 'enterprise') as ProductSpaceContextValue['productSpaces']
    record.allProductSpaces = record.allProductSpaces.filter(item => item.kind !== 'enterprise') as ProductSpaceContextValue['allProductSpaces']
  }
  return value
}

/** Host-side space context: the fixture value plus the create-project entry
 * the real App hosts once next to the switch dialog. The dialog instance is
 * PERMANENTLY mounted inside the provider (the App pattern), so an in-flight
 * submit and its stored idempotency key survive closing the dialog. */
function SpaceContextHost({ children, onOpenCreateProject }: { children: React.ReactNode; onOpenCreateProject: () => void }) {
  const [overrideTick, setOverrideTick] = useState(0)
  const bumpOverride = () => setOverrideTick(t => t + 1)
  // R2 扩展: imperative control surface for the orchestrator (assigned during
  // render so it is always fresh — never stale-closure bridge state).
  Object.assign(poo196SpaceBridge, {
    setRole: (role: 'owner' | 'manager' | 'member') => { spaceOverride.role = role; bumpOverride() },
    setPersonalOnly: (next: boolean) => { spaceOverride.personalOnly = next; bumpOverride() },
    role: () => spaceOverride.role,
    // R3: commit the active space WITHOUT going through the switch log (used
    // by directory scenarios to move the「当前」badge).
    setActiveSpace: (productSpaceId: string) => {
      if (!spaceRecordOf(productSpaceId)) return false
      spaceOverride.activeSpaceId = productSpaceId
      spaceOverride.contextVersion += 1
      bumpOverride()
      return true
    },
    // R3 (D13.1): park/unpark in-flight switch transactions.
    setHoldSwitch: (next: boolean) => { spaceOverride.holdSwitch = next; return true },
    // UB2 (U3): script the next switch to REJECT once (cancel/failure face).
    setSwitchRejectOnce: (next: boolean) => { switchRejectOnce = next; return true },
    // R3 (P3): swap the signed-in account (visit-order isolation probe).
    setAccountId: (accountId: string) => { spaceOverride.accountId = accountId; bumpOverride(); return true },
    // R3: re-run the home directory read (production refetches through a
    // context refresh; the harness bumps the override tick — the same
    // identity change the real refreshProductSpaces commit produces).
    reloadProjects: () => { bumpOverride(); return true },
  })
  const value = useMemo(() => ({
    ...overriddenSpaceContext(),
    onOpenCreateProject: () => { spaceMenuLog.push('open-create'); onOpenCreateProject() },
    onSelectProductSpace: (productSpaceId: string) => { spaceSwitchLog.push(`select:${productSpaceId}`) },
    // R3 (D13): the project-entry transaction hand. The fixture COMMITS the
    // switch (active space + contextVersion bump + override tick) after an
    // optional orchestrator-controlled hold, so useProjectEntry's committed-
    // scope effect observes a real completion signal. UB2: a scripted ONE-SHOT
    // rejection mirrors the production cancel/failure face — the transaction
    // promise rejects AFTER the request was recorded, so enter-failed keeps
    // the target for「重新进入」(explicit cancel along the ORIGINAL reason,
    // never disguised as a network fault).
    onRequestSwitch: async (productSpaceId: string) => {
      spaceSwitchLog.push(`request:${productSpaceId}`)
      if (!spaceRecordOf(productSpaceId)) {
        throw new Error(`fixture: unknown space ${productSpaceId}`)
      }
      if (switchRejectOnce) {
        switchRejectOnce = false
        await new Promise(resolve => setTimeout(resolve, 30))
        throw new Error('fixture: switch rejected (orchestrator-scripted cancel)')
      }
      const deadline = Date.now() + 30_000
      while (spaceOverride.holdSwitch && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      // The production transaction always crosses a real IPC boundary
      // (listActiveExecutions) BEFORE the commit publishes — keep that
      // ordering so useProjectEntry's committed-scope effect observes the
      // settled request in a LATER task, exactly like the real flow.
      await new Promise(resolve => setTimeout(resolve, 30))
      spaceOverride.activeSpaceId = productSpaceId
      spaceOverride.contextVersion += 1
      bumpOverride()
      spaceSwitchLog.push(`committed:${productSpaceId}`)
    },
    onRefreshProductSpaces: async () => {
      spaceRefreshLog.push(Date.now())
      const list = await (window as unknown as { electronAPI: { productSpaceList: () => Promise<Array<Record<string, unknown>>> } }).electronAPI.productSpaceList()
      if (!Array.isArray(list) || list.length === 0) return null
      for (const item of list) registerSpaceName(item)
      const spaces = list as unknown as ProductSpaceContextValue['productSpaces']
      return refreshMissingId ? spaces.filter(item => item.id !== refreshMissingId) : spaces
    },
  }), [overrideTick])
  return (
    <ProductSpaceProvider value={value as unknown as ProductSpaceContextValue}>
      {children}
      {/* R2 扩展 (D-D 1): the production space switcher, composed exactly as
          the account menu hosts it, but mounted offscreen so screenshots stay
          untouched and no baseline scenario observes it. Assertions are
          DOM-based via the orchestrator probes. */}
      <div style={{ position: 'fixed', left: -9999, top: 0 }} data-testid="poo196-space-menu-rig">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-testid="poo196-space-menu-trigger">space menu</button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="start" sideOffset={4} data-testid="poo196-space-menu-content">
            <ProductSpaceSwitcher />
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </div>
    </ProductSpaceProvider>
  )
}

/** R3: the AppShell boundary owns the signed-in admin identity (the create
 * dialog's owner-name source) and the trusted create/send callbacks. The
 * CreateProjectDialog lives HERE — inside AppShellProvider, exactly where
 * production App mounts it — so useCreateProject reads the live
 * currentAdminUser and ownerNeedsInput flips with it. */
function AppShellHost({ children, createProjectOpen, onSetCreateProjectOpen }: {
  children: React.ReactNode
  createProjectOpen: boolean
  onSetCreateProjectOpen: (next: boolean) => void
}) {
  const [adminDisplayName, setAdminDisplayName] = useState(spaceOverride.adminDisplayName)
  spaceOverride.adminDisplayName = adminDisplayName
  Object.assign(poo196SpaceBridge, {
    // R3 (D7): the signed-in account display name — drives ownerNeedsInput.
    setAdminName: (next: string) => { setAdminDisplayName(next); return true },
    adminName: () => adminDisplayName,
  })
  const shellValue = useMemo(() => {
    const adminName = adminDisplayName
    return {
      workspaces: [{ id: WORKSPACE_ID, name: 'Apollo 项目空间', rootPath: '/tmp/apollo', isDefault: true }],
      activeWorkspaceId: WORKSPACE_ID,
      activeWorkspaceSlug: null,
      llmConnections: [],
      workspaceDefaultLlmConnection: undefined,
      chatAccessStatus: null,
      refreshLlmConnections: noopAsync,
      pendingPermissions: new Map(),
      pendingCredentials: new Map(),
      pendingQuestions: new Map(),
      getDraft: () => '',
      getDraftAttachmentRefs: () => [],
      hydrateDraftAttachments: async () => [],
      enabledSources: [],
      skills: [HARNESS_SKILL],
      labels: [],
      sessionStatuses: [],
      enabledModes: ['safe', 'ask', 'allow-all'],
      sessionOptions: new Map(),
      onCreateSession: async (workspaceIdArg: string, createOptions?: { projectContext?: { name?: string; purpose?: string } }) => {
        const sessionId = `sess-first-send-${++firstSendSeq}`
        const bound = createSessionScript === 'wrongScope' ? R3_PROJECT_ALPHA_ID : spaceOverride.activeSpaceId
        // P12-5 payload assembly: record what the production caller attached.
        createSessionLog.push({ productSpaceId: bound, sessionId, projectContext: createOptions?.projectContext, rawOptions: JSON.stringify(createOptions ?? null) })
        // Production parity: App.handleCreateSession's addSession stamps the
        // session family + meta map — the fixture context bypasses App, so the
        // harness does the SAME bookkeeping (resolveAutoSelection validates the
        // navigate target against this map).
        const created = createdSessionFixture(bound, sessionId)
        // The provider store (module-level harnessStore) — NOT a component
        // scoped useStore(): this handler runs outside HarnessBridge.
        harnessStore.set(replaceLoadedSessionAtom, created)
        return created
      },
      onCreateEditPopoverSession: async () => sessionsById[SESSION_PROJECT],
      onSendMessage: (
        sessionId: string,
        message: string,
        attachments?: unknown[],
        _skillSlugs?: string[],
        _badges?: unknown[],
        kbCollectionIds?: string[],
        elementReferences?: unknown[],
        projectAssetRefs?: Array<{ assetId: string; version: number; name: string }>,
      ) => {
        // UB2 (U11): the send log carries the FULL draft the send committed —
        // text, attachments, KB scope, element references and project-asset
        // mentions — so the retained-draft pins can assert one send carries
        // everything that was typed before the blocked attempt.
        sendMessageLog.push({
          sessionId,
          message,
          projectAssetRefs: projectAssetRefs ?? [],
          attachments: (attachments ?? []).map((a) => ({ name: (a as { name?: string })?.name })),
          kbCollectionIds: [...(kbCollectionIds ?? [])],
          elementReferences: (elementReferences ?? []).map((r) => ({ id: (r as { id?: string })?.id })),
        })
      },
      onGetEditPopoverPendingQuestion: async () => null,
      onRenameSession: noop,
      onFlagSession: noop,
      onUnflagSession: noop,
      onArchiveSession: noop,
      onUnarchiveSession: noop,
      onMarkSessionRead: noop,
      onMarkSessionUnread: noop,
      onSetActiveViewingSession: noop,
      onSessionStatusChange: noop,
      onDeleteSession: noopAsyncTrue,
      onRespondToPermission: noop,
      onRespondToCredential: noop,
      onRespondToQuestion: noopAsync,
      onOpenFile: noop,
      onOpenUrl: (url: string) => { openUrlLog.push(url) },
      onSelectWorkspace: noopAsync,
      onOpenSettings: noop,
      onOpenKeyboardShortcuts: noop,
      onReset: noop,
      onSessionOptionsChange: noop,
      onGoalCommand: noop,
      onInputChange: (_sessionId: string, value: string) => { inputChangeLog.push(value) },
      onAttachmentsChange: noop,
      onSessionSourcesChange: noop,
      onSessionLabelsChange: noop,
      isFocusedPanel: true,
      isCompactMode: false,
      // R3 (D7): the create dialog's owner-name source. The RAW value is
      // passed through — useCreateProject treats blank/over-64 as needing the
      // completion field, mirroring the real admin status payload.
      currentAdminUser: {
        userId: CURRENT_USER_ID,
        username: 'fixture-lin',
        displayName: adminName,
      },
    } as unknown as AppShellContextType
  }, [adminDisplayName])
  return (
    <AppShellProvider value={shellValue}>
      {children}
      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={onSetCreateProjectOpen}
        onVerifyPhone={() => { spaceMenuLog.push('verify-phone'); onSetCreateProjectOpen(false) }}
      />
    </AppShellProvider>
  )
}

/** R-1 证据通道：composer 的 RAW 文本模型经 onInputChange（生产 draft 同步
 * 通道，debounce 300ms）流出——DOM innerText 只能看到徽标 label，看不到
 * `[skill:…]` token 本体。 */
const inputChangeLog: string[] = []

const noop = () => {}
const noopAsync = async () => {}
const noopAsyncTrue = async () => true

/** R-1 回归夹具：统一 @ 浮层里的技能行。走生产 LoadedSkill 形状（name 取
 * metadata.name，@token 落 `[skill:<plugin>:<slug>]`）。 */
const HARNESS_SKILL = {
  slug: 'acceptance-checklist',
  metadata: {
    name: '验收清单',
    description: '生成一份验收要点清单',
  },
  content: '# 验收清单',
  path: '/fixture/skills/acceptance-checklist/SKILL.md',
  source: 'workspace' as const,
}

// One store, created at module scope so both fixture sessions can be seeded
// through the production atom write path BEFORE ChatPage mounts (no
// "session missing" flash), while the page components keep using the ambient
// provider store. R3: the project-entry sessions are seeded the same way so
// a committed entry can mount their ChatPage immediately.
const harnessStore = createStore()
for (const session of [...Object.values(sessionsById), ...r3Sessions]) {
  harnessStore.set(replaceLoadedSessionAtom, session)
}

/** The fixture MemberCatalog instance (H3 injection contract): the catalog is
 * an IPC-derived data boundary (productSpaceGetCatalog / localApps), so the
 * harness injects a never-loaded instance — the app grid stays in its neutral
 * loading face while the R3 project section under test reads its REAL data
 * source (window.electronAPI.pmListProductSpacesR3). */
function useFixtureCatalogStub(spaceContext: ProductSpaceContextValue): AppCatalogInstance {
  return useMemo(() => ({
    productSpace: spaceContext,
    state: {
      catalog: null,
      loading: true,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      statusErrorCode: null,
      statusErrorScopeKeys: {},
      statusLoadingScopeKeys: {},
      accessMode: null,
      statuses: {},
      installStates: {},
      creatorCircles: [],
      host: null,
    },
    creatorCircles: [],
    sync: async () => {},
    getInstallState: () => null,
    scopeKeyForApp: () => 'fixture-catalog-scope',
    uninstallProductSpaceBundle: async () => {},
  }) as unknown as AppCatalogInstance, [spaceContext])
}

/** Exposes harness controls + production-state probes to the orchestrator. */
function HarnessBridge() {
  const store = useStore()
  const theme = useTheme()
  const spaceContext = useProductSpaceContext()
  const navState = useNavigationState()
  const [activeSession, setActiveSession] = useState(initialSession)
  const [ready, setReady] = useState(false)
  // R3 surface modes: 'chat' mounts the production ChatPage on the harness's
  // own activeSession (fixture boundary: the tab shell); 'home' mounts the
  // production HomePage and — after the entry flow navigates — follows the
  // SAME surface rule as production MainContentPanel: session details →
  // ChatPage; committed enterprise project without details → the editable
  // ProjectConversationEmptyState.
  const [mode, setMode] = useState<'chat' | 'home'>(params.get('mode') === 'home' ? 'home' : 'chat')
  const [homeSurface, setHomeSurface] = useState<'home' | 'chats'>('home')
  const [homePageEpoch, setHomePageEpoch] = useState(0)
  const setSessionRef = useRef<(id: string) => void>(() => {})
  const catalogStub = useFixtureCatalogStub(spaceContext)
  const navSessionId = navState.navigator === 'sessions' && navState.details?.type === 'session'
    ? navState.details.sessionId
    : null
  const activeSpace = spaceContext.activeProductSpace
  const committedEnterpriseProject = spaceContext.pendingSwitch === null
    && activeSpace !== null && activeSpace.kind === 'enterprise'
  // UB2 (U3/U10): the host mirrors the production MainContentPanel surface
  // rule — a committed entry whose fresh history read failed pins the
  // history-error face over the conversation area (no stale session view, no
  // sendable empty state) until「重新加载」re-reads. The retry re-enters
  // through the SAME shared entry owner.
  const { retryEntry } = useProjectEntry()
  const entryState = store.get(projectEntryAtom)
  const historyErrorActive = entryState.phase === 'history-failed'
    && entryState.accountId !== null
    && entryState.accountId === spaceContext.accountId
    && activeSpace !== null && activeSpace.kind === 'enterprise'
    && activeSpace.id === entryState.productSpaceId

  useEffect(() => {
    setSessionRef.current = (id: string) => setActiveSession(id)
    // R3: a navigate() lands the entry on the assistant surface — the
    // fixture's openAppTab equivalent (the real tab activation happens in
    // resumeIntoScope; the harness tab shell is the fixture boundary).
    const onNavigate = () => setHomeSurface('chats')
    window.addEventListener(NAVIGATE_EVENT, onNavigate)
    const unsubRoute = store.sub(focusedPanelRouteAtom, () => {
      routeLog.push(String(store.get(focusedPanelRouteAtom)))
      if (routeLog.length > 40) routeLog.shift()
    })
    // Render-timeline observer: records when the pc surfaces mutate, so the
    // orchestrator can correlate RPC completion with DOM updates.
    const renderLog: Array<{ t: number; what: string }> = []
    const mo = new MutationObserver(() => {
      const rows = document.querySelectorAll('[data-testid^="pc-asset-row-"]').length
      const list = document.querySelector('[data-testid="pc-list"]')
      const root = document.querySelector('[data-testid="pc-library"], [data-testid="pc-library-blocked"], [data-testid="pc-library-trash"]')
      const entry = {
        t: Date.now(),
        what: `rows=${rows} list=${Boolean(list)} loading=${Boolean(document.querySelector('[data-testid="pc-loading"]'))} root=${root ? (root.getAttribute('data-testid') ?? '?').replace('pc-library', '') || 'main' : 'none'}`,
      }
      const last = renderLog[renderLog.length - 1]
      if (!last || last.what !== entry.what) renderLog.push(entry)
      if (renderLog.length > 400) renderLog.shift()
    })
    mo.observe(document.body, { childList: true, subtree: true })
    const api = {
      ready: true,
      renderLog: () => renderLog.slice(-30),
      sessions: { project: SESSION_PROJECT, personal: SESSION_PERSONAL, projectEmpty: SESSION_PROJECT_EMPTY },
      session: () => activeSession,
      /** R3 surface control + probes. */
      setMode: (next: 'chat' | 'home') => {
        setMode(next)
        setHomeSurface('home')
        if (next === 'chat') setActiveSession(SESSION_PROJECT)
        return true
      },
      mode: () => mode,
      surface: () => (mode === 'chat' ? 'chat' : homeSurface),
      showChats: () => { setHomeSurface('chats'); return true },
      /** Returning to the home tab REMOUNTS the production page (fresh
       * directory/visit reads — the same fresh mount a tab re-open gives). */
      showHome: () => { setHomeSurface('home'); setHomePageEpoch(e => e + 1); return true },
      navSession: () => navSessionId,
      navRoute: () => String(store.get(focusedPanelRouteAtom)),
      navRouteLog: () => routeLog.slice(),
      chatSession: () => (mode === 'chat' ? activeSession : navSessionId),
      entryPending: () => store.get(projectEntryPendingAtom),
      /** UB2 (U3/U10/U11): the FULL shared entry state + the U11 notice
       * markers — the orchestrator pins phases (switching/resuming/failed),
       * target retention and the blocked-send marker lifecycle on these. */
      entryState: () => store.get(projectEntryAtom),
      sendNotices: () => store.get(projectEntrySendNoticesAtom),
      /** UB4 (U5): the one-time post-create invite intent + a fixture-state
       * injection setter (the same class as setEntryState) so the member/
       * 切型 nails can arm a pending intent without mounting the home flow. */
      onboardingIntent: () => store.get(projectOnboardingIntentAtom),
      setOnboardingIntent: (state: unknown) => { store.set(projectOnboardingIntentAtom, state as never); return true },
      /** UB2 (U11/S18): drive the shared entry atom directly (fixture state
       * injection — the same class as setDraftRefs) so the chat-mode surface
       * can arm a pending entry for the blocked-send/account-cleanup pins
       * without mounting the home flow. */
      setEntryState: (state: unknown) => { store.set(projectEntryAtom, state as never); return true },
      /** UB2 (U11): seed the per-session @ project-asset mention draft the
       * same way a user pick would (the production atom write path). */
      setDraftRefs: (sessionId: string, refs: Array<{ assetId: string; version: number; name: string }>) => {
        store.set(projectAssetDraftRefsAtomFamily(sessionId), refs)
        return true
      },
      navigateLog: () => navigateLog.slice(),
      createSessionLog: () => createSessionLog.slice(),
      visitOrder: (accountId: string) => {
        try {
          const raw = window.localStorage.getItem(`poo196.projects:visit-order:${accountId}`)
          return raw ? (JSON.parse(raw) as Record<string, number>) : {}
        } catch {
          return {}
        }
      },
      clearVisits: (accountId: string) => {
        window.localStorage.removeItem(`poo196.projects:visit-order:${accountId}`)
        // The production module caches visits IN MEMORY per account — the
        // localStorage removal alone would be silently overridden on the next
        // write. The production test hook clears the in-memory cache too.
        __resetProjectVisitsForTests()
        return true
      },
      /** R3: reset the entry/switch observation logs (per-scenario isolation).
       * UB4: the one-time onboarding intent clears too — a stale create
       * intent from an earlier scenario must never pop into a later one. */
      clearLogs: () => {
        navigateLog.length = 0
        spaceSwitchLog.length = 0
        clipboardLog.length = 0
        store.set(projectOnboardingIntentAtom, null)
        return true
      },
      /** UB1 (U12): clipboard write evidence (payload strings, in order). */
      clipboardLog: () => clipboardLog.slice(),
      /** UB1 (U12 Markdown pin): the TurnCard footer「Markdown」entry is the
       * hardcoded pop-out preview trigger (G12 explicitly keeps it — the
       * button executes onPopOut, it is NOT a copy). This probe clicks that
       * production button so the orchestrator can assert the preview opens
       * with zero clipboard writes. */
      clickMarkdownPopOut: () => {
        const button = Array.from(document.querySelectorAll('button'))
          .find(el => (el.textContent ?? '').trim() === 'Markdown')
        if (!button) return false
        ;(button as HTMLElement).click()
        return true
      },
      markdownPopOutPresent: () => {
        return Array.from(document.querySelectorAll('button'))
          .some(el => (el.textContent ?? '').trim() === 'Markdown')
      },
      activeSpaceId: () => spaceContext.activeProductSpaceId,
      /** D-D 1: the create entry lives in the home「项目」区域 (the context
       * call those entries make). Returns whether the entry exists (the
       * context call itself resolves void). */
      openCreateProject: () => {
        if (!spaceContext?.onOpenCreateProject) return false
        spaceContext.onOpenCreateProject()
        return true
      },
      setRefreshMissingFor: (id: string | null) => { refreshMissingId = id; return true },
      setCreateSessionScript: (next: 'ok' | 'wrongScope') => { createSessionScript = next; return true },
      spaceSwitchLog: () => spaceSwitchLog.slice(),
      spaceMenuLog: () => spaceMenuLog.slice(),
      spaceRefreshLog: () => spaceRefreshLog.slice(),
      setSession: (id: string) => setSessionRef.current(id),
      lang: () => i18n.resolvedLanguage ?? i18n.language,
      // changeLanguage resolves with the t function (not structured-cloneable
      // across executeJavaScript) — swallow it and answer with a boolean.
      setLang: async (next: string) => {
        await i18n.changeLanguage(next)
        return true
      },
      setTheme: (mode: 'light' | 'dark') => theme.setMode(mode),
      theme: () => (theme.isDark ? 'dark' : 'light'),
      t: (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts),
      draftRefs: (sessionId: string) => store.get(projectAssetDraftRefsAtomFamily(sessionId)),
      sendMessageLog,
      openUrlLog,
      inputChangeLog,
      q: (selector: string) => Boolean(document.querySelector(selector)),
      count: (selector: string) => document.querySelectorAll(selector).length,
      text: () => document.body.innerText,
      toastText: () => {
        const region = document.querySelector('[data-sonner-toaster]')
        return region ? (region as HTMLElement).innerText : ''
      },
      overflow: () => {
        const doc = document.scrollingElement
        const overflowing: string[] = []
        document.querySelectorAll<HTMLElement>('[data-testid]').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) overflowing.push(el.getAttribute('data-testid') ?? '?')
        })
        return {
          page: doc ? { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth } : null,
          overflowing,
        }
      },
      inputValue: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        return el ? (el.innerText ?? '') : null
      },
      focusInput: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (el) { el.focus(); return true }
        return false
      },
      insertText: (text: string) => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (!el) return false
        el.focus()
        document.execCommand('insertText', false, text)
        return true
      },
      caretToEnd: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (!el) return false
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      },
      click: (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return false
        // Full trusted-shape pointer sequence: Radix triggers select on
        // pointerdown, Radix menu items on click; cover both.
        const rect = el.getBoundingClientRect()
        const base = {
          bubbles: true, cancelable: true, view: window,
          clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0,
        }
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mousedown', base))
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mouseup', base))
        el.click()
        return true
      },
      /** The composer's own production "press Send" simulation event. */
      send: () => {
        window.dispatchEvent(new CustomEvent('craft:submit-input'))
        return true
      },
      /** Keyboard activation fallback: Radix triggers/items respond to Enter. */
      pressEnterOn: (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return false
        el.focus()
        const base = { bubbles: true, cancelable: true, view: window, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
        el.dispatchEvent(new KeyboardEvent('keydown', base))
        el.dispatchEvent(new KeyboardEvent('keyup', base))
        return true
      },
      buttonInfo: (selector: string) => {
        const el = document.querySelector(selector) as HTMLButtonElement | null
        if (!el) return 'missing'
        return `disabled=${el.disabled} visible=${el.getBoundingClientRect().width > 0}`
      },
      blurActive: () => {
        ;(document.activeElement as HTMLElement | null)?.blur()
        return true
      },
    }
    ;(window as unknown as Record<string, unknown>).__poo196 = api
    setReady(true)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, onNavigate)
      unsubRoute()
    }
  }, [activeSession, store, theme, mode, homeSurface, navSessionId, spaceContext])

  // R3: production keeps TAB PAGES mounted across tab switches — the home
  // page (and its in-flight useProjectEntry transaction) must SURVIVE the
  // orchestrator's showChats(), or the committed-scope effect dies mid-entry
  // and the send gate would leak pending forever. The home page stays mounted
  // (hidden) while the assistant surface is visible, exactly like a tab.
  const chatsSurface = historyErrorActive && activeSpace ? (
    <ProjectEntryHistoryErrorFace
      projectName={activeSpace.name}
      createOrigin={entryState.origin === 'create'}
      onRetry={() => retryEntry(entryState.productSpaceId)}
    />
  ) : navSessionId
    ? <ChatPage sessionId={navSessionId} />
    : committedEnterpriseProject && activeSpace.kind === 'enterprise'
      ? (
          <ProjectConversationEmptyState
            accountId={spaceContext.accountId}
            workspaceId={WORKSPACE_ID}
            productSpaceId={activeSpace.id}
            projectName={activeSpace.name}
            viewerRole={activeSpace.role}
            enterpriseId={activeSpace.enterpriseId}
          />
        )
      : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">未选择会话</div>
        )
  const homePage = (
    <TabShellProvider
      workspaceId={WORKSPACE_ID}
      productSpaceScope={{ accountId: spaceContext.accountId, productSpaceId: spaceContext.activeProductSpaceId }}
    >
      <MemberCatalogProvider catalog={catalogStub}>
        <HomePage key={homePageEpoch} />
      </MemberCatalogProvider>
    </TabShellProvider>
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1" data-testid="poo196-shell">
        {mode === 'chat' ? <ChatPage sessionId={activeSession} /> : (
          <>
            <div className={homeSurface === 'home' ? 'h-full min-h-0' : 'hidden'}>
              {homePage}
            </div>
            {homeSurface === 'chats' && (
              <div className="h-full min-h-0">{chatsSurface}</div>
            )}
          </>
        )}
      </div>
      <span data-testid="poo196-ready" style={{ display: 'none' }}>{String(ready)}</span>
      <span data-testid="poo196-active-session" style={{ display: 'none' }}>{activeSession}</span>
    </div>
  )
}

function Root() {
  return (
    <JotaiProvider store={harnessStore}>
      <ThemeProvider defaultMode={initialTheme} activeWorkspaceId={WORKSPACE_ID}>
        <TooltipProvider>
          <EscapeInterruptProvider>
            <FocusProvider>
              <DismissibleLayerProvider>
                <ModalProvider>
                  <NavigationProvider
                    workspaceId={WORKSPACE_ID}
                    workspaceSlug={null}
                    onCreateSession={async () => sessionsById[SESSION_PROJECT]}
                    onInputChange={() => {}}
                    getDraft={() => ''}
                  >
                    <SpaceContextHostWithDialog>
                    <HarnessBridge />
                  </SpaceContextHostWithDialog>
                  </NavigationProvider>
                </ModalProvider>
              </DismissibleLayerProvider>
            </FocusProvider>
          </EscapeInterruptProvider>
          <Toaster position="bottom-right" visibleToasts={4} />
        </TooltipProvider>
      </ThemeProvider>
    </JotaiProvider>
  )
}

/** SpaceContextHost owns the create-dialog open flag; the dialog instance
 * itself mounts INSIDE AppShellProvider (production App shape) so the owner
 * identity and the entry flow read the live shell context. */
function SpaceContextHostWithDialog({ children }: { children: React.ReactNode }) {
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  return (
    <SpaceContextHost onOpenCreateProject={() => setCreateProjectOpen(true)}>
      <AppShellHost createProjectOpen={createProjectOpen} onSetCreateProjectOpen={setCreateProjectOpen}>
        {children}
      </AppShellHost>
    </SpaceContextHost>
  )
}

const reactRoot: Root = createRoot(document.getElementById('root')!)
reactRoot.render(<Root />)
