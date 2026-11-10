import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  activeTabAtom,
  activeTabIdAtom,
  activateTabAtom,
  closeTabAtom,
  committedSpaceKindAtom,
  installedAppsAtom,
  openAppTabAtom,
  openTabsAtom,
  reorderTabsAtom,
  setInstalledAppsAtom,
  updateProjectTabSnapshotAtom,
  updateTabInfoAtom,
  visibleTabsAtom,
} from '@/atoms/tab-browser'
import { KEYS, get as getLocalStorage, set as setLocalStorage } from '@/lib/local-storage'
import {
  BUILTIN_APP_IDS,
  HOME_TAB_ID,
  POLO_TAB,
  POLO_TAB_ID,
  normalizeInstalledApps,
  type AppDefinition,
  type TabInstance,
} from '../../shared/tab-browser-types'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { ProductSpaceAppLaunchBridge } from '@/components/tab-browser/ProductSpaceAppLaunchBridge'
import { GenUiAppPinBridge } from '@/components/tab-browser/GenUiAppPinBridge'
import { GenUiAppPublishBridge } from '@/components/tab-browser/GenUiAppPublishBridge'
import { GenUiCardRegistryBridge } from '@/components/tab-browser/GenUiCardRegistryBridge'
import { GenUiCanvasBridge } from '@/components/tab-browser/GenUiCanvasBridge'
import { GENUI_PINNED_APP_ID_PREFIX } from '../../shared/types'
import { tabAppPartitionForScope } from '../../shared/tab-browser-partition'
import {
  activeProjectRefOf,
  clearActiveProjectIfStale,
  getActiveProjectRaw,
  setActiveProject,
  subscribeProjectDirectory,
} from '@/components/projects/projects-bus'
import { closeProjectTabForLostProject } from '@/components/projects/reconcile'

export interface WebAppNavigationControls {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  goBack: () => void
  goForward: () => void
  reloadOrStop: () => void
}

interface TabShellContextValue {
  installedApps: AppDefinition[]
  openTabs: TabInstance[]
  /** Mounted App guests hidden by an explicit background choice. */
  backgroundTabs?: TabInstance[]
  activeTab: TabInstance
  activeTabId: string
  isReady: boolean
  activeWebAppNavigation: WebAppNavigationControls | null
  /**
   * Session partition for tab webapps, scoped to the account+ProductSpace so
   * webapp cookies/storage from one space never surface in another. Null
   * keeps the shared legacy partition (local-account windows).
   */
  webAppPartition: string | null
  activateHome: () => void
  activateTab: (tabId: string) => void
  openApp: (app: AppDefinition) => void
  /** Install (or update) an app in the launcher and persist it. */
  installApp: (app: AppDefinition) => Promise<void>
  closeTab: (tabId: string) => void
  registerProductSpaceTabClose?: (handler: ((tabId: string) => boolean) | null) => void
  reorderTabs: (draggedTabId: string, targetTabId: string) => void
  removeApp: (appId: string) => Promise<void>
  updateTabInfo: (update: { id: string } & Partial<Omit<TabInstance, 'id'>>) => void
  registerWebAppNavigation: (tabId: string, controls: WebAppNavigationControls | null) => void
}

/** Exported for the component playground, which mocks the context value directly. */
export const TabShellContext = createContext<TabShellContextValue | null>(null)
export type { TabShellContextValue }

interface TabShellProviderProps {
  workspaceId?: string | null
  /**
   * Verified ProductSpace scope (account + space ids). Tab and installed-app
   * persistence is partitioned by this scope: the same local Workspace
   * entered from a different ProductSpace never restores the other space's
   * tabs, URLs or app launchers. Null only for the legacy local-account
   * window, which keeps the global store.
   */
  productSpaceScope?: { accountId: string; productSpaceId: string } | null
  children: React.ReactNode
}

function restoreTabs(rawTabs: TabInstance[], apps: AppDefinition[]): TabInstance[] {
  const appIds = new Set(apps.map((app) => app.id))
  // POO-205: the retired KB tab type fails the `webapp` check and
  // is silently dropped, so legacy persisted snapshots never restore it.
  const restored = rawTabs.filter((tab) => {
    if (tab.id === POLO_TAB_ID || tab.type === 'polo') return true
    // POO-205 §10: project tabs persist (title refreshes from the projects
    // list when the user re-enters; a stale title for a DELETED project is
    // harmless — the tab just sits until closed).
    if (tab.type === 'project' && tab.project?.projectId) return true
    if (tab.type !== 'webapp') return false
    return appIds.has(tab.appId)
  })

  const hasPolo = restored.some((tab) => tab.id === POLO_TAB_ID || tab.type === 'polo')
  return hasPolo ? restored : [POLO_TAB, ...restored]
}

export function TabShellProvider({ workspaceId, productSpaceScope, children }: TabShellProviderProps) {
  const shellContext = useOptionalAppShellContext()
  const isProductSpaceWindow = Boolean(productSpaceScope)
  const liveProductSpace = useOptionalProductSpaceContext()
  const [installedApps, setInstalledAppsState] = useAtom(installedAppsAtom)
  const [openTabs, setOpenTabs] = useAtom(openTabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  // POO-205 C4: the committed-space kind feeds visibleTabsAtom (the single
  // source every visible-tab consumer reads) — see CommittedSpaceKindBridge.
  const setCommittedSpaceKind = useSetAtom(committedSpaceKindAtom)
  const setInstalledApps = useSetAtom(setInstalledAppsAtom)
  const openAppTab = useSetAtom(openAppTabAtom)
  const closeTabWrite = useSetAtom(closeTabAtom)
  const activateTabWrite = useSetAtom(activateTabAtom)
  const reorderTabsWrite = useSetAtom(reorderTabsAtom)
  const updateTabInfo = useSetAtom(updateTabInfoAtom)
  const [isReady, setIsReady] = useState(false)
  const [webAppNavigation, setWebAppNavigation] = useState<Record<string, WebAppNavigationControls>>({})
  const hydratedRef = useRef(false)
  const managedCloseRef = useRef<((tabId: string) => boolean) | null>(null)
  const registerProductSpaceTabClose = useCallback((handler: ((tabId: string) => boolean) | null) => { managedCloseRef.current = handler }, [])
  const closeTab = useCallback((tabId: string) => {
    if (!managedCloseRef.current?.(tabId)) closeTabWrite(tabId)
  }, [closeTabWrite])
  // The persistence scope: account+ProductSpace first, workspace second.
  // Storage keys (tabs) and the webview partition are both derived from this
  // scope, so a space switch can never rehydrate the other space's tab
  // strip, webapp URLs or WebView state.
  const storageScope = productSpaceScope
    ? `${tabAppPartitionForScope({
        accountId: productSpaceScope.accountId,
        productSpaceId: productSpaceScope.productSpaceId,
        workspaceId: workspaceId || 'default',
      })}::${workspaceId || 'default'}`
    : (workspaceId || 'default')
  // Deterministic, Electron-safe session partition for the ProductSpace
  // scope — identical to what Main re-derives to install the webview
  // permission policy.
  const webAppPartition = productSpaceScope
    ? tabAppPartitionForScope({
        accountId: productSpaceScope.accountId,
        productSpaceId: productSpaceScope.productSpaceId,
        workspaceId: workspaceId || 'default',
      })
    : null

  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      // The Main side derives the installed-apps partition from trusted
      // state (account + fence + window workspace) — the renderer never
      // names the scope.
      // ProductSpace member windows never hydrate the legacy External App
      // sideload store. Keeping the old records on disk is migration-safe,
      // but they cannot restore a launcher or tab and bypass the Catalog.
      // POO-154: the pinned canvas apps (gen-ui-app-*) are the one exception
      // — they are session-local artifacts the user pinned themselves, not
      // sideloaded works, and their Home entry must survive a restart or the
      // pinned tab becomes permanently unreachable after it is closed.
      const persistedApps = await window.electronAPI.getTabBrowserApps().catch(() => [])
      const apps = normalizeInstalledApps(
        isProductSpaceWindow
          ? persistedApps.filter((app) => app.id.startsWith(GENUI_PINNED_APP_ID_PREFIX))
          : persistedApps,
      )
      if (cancelled) return

      const rawTabs = getLocalStorage<TabInstance[]>(KEYS.tabs, [POLO_TAB], storageScope)
      const tabs = restoreTabs(rawTabs, apps)
      setInstalledApps(apps)
      setOpenTabs(tabs)
      setActiveTabId(HOME_TAB_ID)
      hydratedRef.current = true
      setIsReady(true)
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [isProductSpaceWindow, setActiveTabId, setInstalledApps, setOpenTabs, storageScope])

  useEffect(() => {
    if (!hydratedRef.current) return
    const timer = window.setTimeout(() => {
      setLocalStorage(KEYS.tabs, openTabs.filter(tab => !tab.productSpaceApp), storageScope)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [openTabs, storageScope])

  // POO-205 C4 (A): the committed space kind is an ATOM input, not a prop —
  // TopBar/TabShell/NavigationContext and the tab atoms themselves all read
  // the same single source (visibleTabsAtom), the same way
  // ProjectTabActiveProjectBridge publishes the active project. Null outside
  // a committed space → every kind-gated behavior fails open to personal.
  const committedSpaceKind = liveProductSpace?.activeProductSpace?.kind ?? null
  useEffect(() => {
    setCommittedSpaceKind(committedSpaceKind)
    return () => { setCommittedSpaceKind(null) }
  }, [committedSpaceKind, setCommittedSpaceKind])

  // POO-205 C4 (A) guard: in an enterprise space the Polo tab must never be
  // the active tab — it is hidden from the strip, so "active" would mean an
  // invisible surface with a home-scope route. This is the catch-all for any
  // entry the visible-tab rewire below cannot see (stray deep links, a stale
  // snapshot restore); legit entries no longer produce this state.
  useEffect(() => {
    if (committedSpaceKind === 'enterprise' && activeTabId === POLO_TAB_ID) {
      setActiveTabId(HOME_TAB_ID)
    }
  }, [committedSpaceKind, activeTabId, setActiveTabId])

  const persistApps = useCallback(async (apps: AppDefinition[]) => {
    const normalized = normalizeInstalledApps(apps)
    setInstalledAppsState(normalized)
    await window.electronAPI.saveTabBrowserApps(
      normalized.filter((app) => !BUILTIN_APP_IDS.has(app.id)),
    )
  }, [setInstalledAppsState])

  const removeApp = useCallback(async (appId: string) => {
    if (BUILTIN_APP_IDS.has(appId)) return
    await persistApps(installedApps.filter((app) => app.id !== appId))
    setOpenTabs((tabs) => tabs.filter((tab) => tab.appId !== appId))
    if (openTabs.some((tab) => tab.appId === appId && tab.id === activeTabId)) {
      setActiveTabId(HOME_TAB_ID)
    }
  }, [activeTabId, installedApps, openTabs, persistApps, setActiveTabId, setOpenTabs])

  // Install a new launcher app or update one with the same id in place (a
  // re-pinned canvas app at a newer version rewrites its entry).
  const installApp = useCallback(async (app: AppDefinition) => {
    const existing = installedApps.some((candidate) => candidate.id === app.id)
    await persistApps(
      existing
        ? installedApps.map((candidate) => (candidate.id === app.id ? app : candidate))
        : [...installedApps, app],
    )
  }, [installedApps, persistApps])

  const registerWebAppNavigation = useCallback((tabId: string, controls: WebAppNavigationControls | null) => {
    setWebAppNavigation((current) => {
      if (!controls) {
        if (!current[tabId]) return current
        const next = { ...current }
        delete next[tabId]
        return next
      }
      if (current[tabId] === controls) return current
      return { ...current, [tabId]: controls }
    })
  }, [])

  // Generation-bound runtime tabs never surface during a context transition,
  // even before passive hydration or while a late start is settling.
  const tabIsCurrent = (tab: TabInstance) => !tab.productSpaceApp || Boolean(liveProductSpace
    && tab.productSpaceApp.accountId === liveProductSpace.accountId
    && tab.productSpaceApp.productSpaceId === liveProductSpace.activeProductSpaceId
    && tab.productSpaceApp.contextVersion === liveProductSpace.contextVersion)
  const currentTabs = useMemo(() => openTabs.filter(tabIsCurrent), [openTabs, liveProductSpace])
  const visibleTabs = useMemo(() => currentTabs.filter(tab => !tab.background), [currentTabs])
  const backgroundTabs = useMemo(() => currentTabs.filter(tab => tab.background), [currentTabs])
  // POO-205 C4 (A): the context's openTabs is the SPACE-VISIBLE list — the
  // retired Polo tab drops out in an enterprise space, so the strip, ⌘-digit
  // / ⌘⇧[ ] mapping and drag-reorder all read one consistent surface. (The
  // TabContent mounting and persistence keep reading the atoms directly.)
  const spaceVisibleTabs = useMemo(
    () => (committedSpaceKind === 'enterprise' ? visibleTabs.filter(tab => tab.type !== 'polo') : visibleTabs),
    [visibleTabs, committedSpaceKind],
  )
  const visibleActiveTab = activeTab && tabIsCurrent(activeTab) && !activeTab.background ? activeTab : null
  // While the guard effect snaps the active id back to Home, context readers
  // already see Home — one render of an invisible-active Polo tab is too many.
  const poloActiveInEnterprise = committedSpaceKind === 'enterprise' && activeTabId === POLO_TAB_ID
  const contextActiveTab = poloActiveInEnterprise
    ? { id: HOME_TAB_ID, appId: HOME_TAB_ID, type: 'home' as const, title: 'Home' }
    : (visibleActiveTab ?? { id: HOME_TAB_ID, appId: HOME_TAB_ID, type: 'home' as const, title: 'Home' })
  const contextActiveTabId = poloActiveInEnterprise
    ? HOME_TAB_ID
    : (visibleActiveTab ? activeTabId : HOME_TAB_ID)
  const activeWebAppNavigation =
    visibleActiveTab?.type === 'webapp'
      ? webAppNavigation[visibleActiveTab.id] ?? null
      : null

  const value = useMemo<TabShellContextValue>(() => ({
    installedApps,
    openTabs: spaceVisibleTabs,
    backgroundTabs,
    activeTab: contextActiveTab,
    activeTabId: contextActiveTabId,
    isReady,
    activeWebAppNavigation,
    webAppPartition,
    activateHome: () => activateTabWrite(HOME_TAB_ID),
    activateTab: activateTabWrite,
    openApp: openAppTab,
    installApp,
    closeTab,
    registerProductSpaceTabClose,
    reorderTabs: (draggedTabId, targetTabId) => {
      if (draggedTabId === targetTabId || targetTabId === POLO_TAB_ID) return
      const draggedIndex = openTabs.findIndex((tab) => tab.id === draggedTabId)
      const targetIndex = openTabs.findIndex((tab) => tab.id === targetTabId)
      if (draggedIndex < 0 || targetIndex < 0) return
      const nextTabs = [...openTabs]
      const [dragged] = nextTabs.splice(draggedIndex, 1)
      nextTabs.splice(targetIndex, 0, dragged)
      reorderTabsWrite(nextTabs)
    },
    removeApp,
    updateTabInfo,
    registerWebAppNavigation,
  }), [
    contextActiveTab,
    contextActiveTabId,
    spaceVisibleTabs,
    backgroundTabs,
    activeTabId,
    activeWebAppNavigation,
    activateTabWrite,
    closeTab,
    installApp,
    registerProductSpaceTabClose,
    installedApps,
    isReady,
    openAppTab,
    openTabs,
    reorderTabsWrite,
    removeApp,
    registerWebAppNavigation,
    updateTabInfo,
    webAppPartition,
  ])

  return (
    <TabShellContext.Provider value={value}>
      {liveProductSpace && <ProductSpaceAppLaunchBridge />}
      {liveProductSpace && <ProjectTabActiveProjectBridge scope={{ accountId: liveProductSpace.accountId, productSpaceId: liveProductSpace.activeProductSpaceId }} />}
      {liveProductSpace && <ProjectDirectoryTabSyncBridge scope={{ accountId: liveProductSpace.accountId, productSpaceId: liveProductSpace.activeProductSpaceId }} />}
      <GenUiAppPinBridge />
      <GenUiAppPublishBridge />
      <GenUiCardRegistryBridge />
      <GenUiCanvasBridge onPresented={shellContext?.onHideFilePreview} />
      {children}
    </TabShellContext.Provider>
  )
}

/**
 * POO-205 Spec §10: the ACTIVE TAB drives the renderer-wide active project.
 * Activating a `project` tab publishes its project (the conversation layout
 * and zero-write first sends bind to it); activating any other tab clears
 * the binding, so "新建会话" can never attach a project the user navigated
 * away from. The host hygiene (clearActiveProjectIfStale) stays as the
 * scope-drift backstop.
 */
function ProjectTabActiveProjectBridge({ scope }: { scope: { accountId: string; productSpaceId: string } }) {
  const activeTab = useAtomValue(activeTabAtom)
  useEffect(() => {
    if (activeTab?.type === 'project' && activeTab.project) {
      const project = activeTab.project
      setActiveProject({
        accountId: scope.accountId,
        organizationProductSpaceId: scope.productSpaceId,
        organizationEnterpriseId: project.organizationEnterpriseId,
        projectId: project.projectId,
        name: project.name,
        ...(project.purpose ? { purpose: project.purpose } : {}),
        ...(project.instructions ? { instructions: project.instructions } : {}),
        myRole: project.myRole,
      })
      return
    }
    // Non-project tab: clear only what a project tab set (same scope) —
    // enterProjectLightweight's eager pre-navigation binding is replaced by
    // this authoritative tab-driven value.
    if (getActiveProjectRaw()) setActiveProject(null)
    else clearActiveProjectIfStale(scope.accountId, scope.productSpaceId)
  }, [activeTab, scope.accountId, scope.productSpaceId])
  return null
}

/**
 * POO-205 C9 (R12): a project DIRECTORY event keeps the open project tabs
 * and the active-project ref consistent with the freshest directory facts.
 *
 * - `updated` (a settings save landed): every ALREADY-OPEN tab carrying that
 *   project refreshes its snapshot + strip title (updateProjectTabSnapshot —
 *   never opens a tab, never moves focus). When the project is also the
 *   ACTIVE project, the bus ref is swapped for the fresh one so the C8
 *   sidebar header re-renders without a tab switch.
 * - `removed`: the lost-project closing move (close + toast + last-selected
 *   cleanup). The list reconciliation closes tabs itself; this branch backs
 *   any direct publisher of the event.
 *
 * Scope-stamped like ProjectTabActiveProjectBridge: the swap publishes under
 * THIS account + committed space only.
 */
function ProjectDirectoryTabSyncBridge({ scope }: { scope: { accountId: string; productSpaceId: string } }) {
  const store = useStore()
  useEffect(() => subscribeProjectDirectory((event) => {
    if (event.type === 'updated') {
      const fresh = event.project
      const changed = store.set(updateProjectTabSnapshotAtom, {
        projectId: fresh.id,
        name: fresh.name,
        ...(fresh.purpose !== undefined ? { purpose: fresh.purpose } : {}),
        ...(fresh.instructions !== undefined ? { instructions: fresh.instructions } : {}),
        organizationEnterpriseId: fresh.organizationEnterpriseId,
        organizationProductSpaceId: fresh.organizationProductSpaceId,
        myRole: fresh.myRole,
      })
      if (changed && getActiveProjectRaw()?.projectId === fresh.id) {
        setActiveProject(activeProjectRefOf(scope.accountId, fresh))
      }
      return
    }
    closeProjectTabForLostProject(store, {
      projectId: event.projectId,
      // The last-selected cleanup is workspace-keyed and the event carries no
      // workspace; the list reconciliation (which knows the workspace) is the
      // path that normally fires. Tab close + toast stay correct here.
    })
  }), [store, scope.accountId, scope.productSpaceId])
  return null
}

export function useTabShell() {
  const value = useContext(TabShellContext)
  if (!value) {
    throw new Error('useTabShell must be used within TabShellProvider')
  }
  return value
}
