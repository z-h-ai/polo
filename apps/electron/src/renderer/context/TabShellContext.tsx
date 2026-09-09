import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  activeTabAtom,
  activeTabIdAtom,
  activateTabAtom,
  closeTabAtom,
  installedAppsAtom,
  openAppTabAtom,
  openTabsAtom,
  reorderTabsAtom,
  setInstalledAppsAtom,
  updateTabInfoAtom,
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
import { tabAppPartitionForScope } from '../../shared/tab-browser-partition'

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
  closeTab: (tabId: string) => void
  reorderTabs: (draggedTabId: string, targetTabId: string) => void
  removeApp: (appId: string) => Promise<void>
  updateTabInfo: (update: { id: string } & Partial<Omit<TabInstance, 'id'>>) => void
  registerWebAppNavigation: (tabId: string, controls: WebAppNavigationControls | null) => void
}

const TabShellContext = createContext<TabShellContextValue | null>(null)

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
  const restored = rawTabs.filter((tab) => {
    if (tab.id === POLO_TAB_ID || tab.type === 'polo') return true
    if (tab.type !== 'webapp') return false
    return appIds.has(tab.appId)
  })

  const hasPolo = restored.some((tab) => tab.id === POLO_TAB_ID || tab.type === 'polo')
  return hasPolo ? restored : [POLO_TAB, ...restored]
}

export function TabShellProvider({ workspaceId, productSpaceScope, children }: TabShellProviderProps) {
  const isProductSpaceWindow = Boolean(productSpaceScope)
  const [installedApps, setInstalledAppsState] = useAtom(installedAppsAtom)
  const [openTabs, setOpenTabs] = useAtom(openTabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const setInstalledApps = useSetAtom(setInstalledAppsAtom)
  const openAppTab = useSetAtom(openAppTabAtom)
  const closeTabWrite = useSetAtom(closeTabAtom)
  const activateTabWrite = useSetAtom(activateTabAtom)
  const reorderTabsWrite = useSetAtom(reorderTabsAtom)
  const updateTabInfo = useSetAtom(updateTabInfoAtom)
  const [isReady, setIsReady] = useState(false)
  const [webAppNavigation, setWebAppNavigation] = useState<Record<string, WebAppNavigationControls>>({})
  const hydratedRef = useRef(false)
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
      const persistedApps = isProductSpaceWindow
        ? []
        : await window.electronAPI.getTabBrowserApps().catch(() => [])
      if (cancelled) return

      const apps = normalizeInstalledApps(persistedApps)
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
      setLocalStorage(KEYS.tabs, openTabs, storageScope)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [openTabs, storageScope])

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

  const activeWebAppNavigation =
    activeTab?.type === 'webapp'
      ? webAppNavigation[activeTab.id] ?? null
      : null

  const value = useMemo<TabShellContextValue>(() => ({
    installedApps,
    openTabs,
    activeTab: activeTab ?? { id: HOME_TAB_ID, appId: HOME_TAB_ID, type: 'home', title: 'Home' },
    activeTabId,
    isReady,
    activeWebAppNavigation,
    webAppPartition,
    activateHome: () => activateTabWrite(HOME_TAB_ID),
    activateTab: activateTabWrite,
    openApp: openAppTab,
    closeTab: closeTabWrite,
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
    activeTab,
    activeTabId,
    activeWebAppNavigation,
    activateTabWrite,
    closeTabWrite,
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
      {children}
    </TabShellContext.Provider>
  )
}

export function useTabShell() {
  const value = useContext(TabShellContext)
  if (!value) {
    throw new Error('useTabShell must be used within TabShellProvider')
  }
  return value
}
