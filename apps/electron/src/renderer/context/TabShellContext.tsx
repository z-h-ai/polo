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
  HOME_TAB_ID,
  POLO_APP_ID,
  POLO_TAB,
  POLO_TAB_ID,
  normalizeInstalledApps,
  type AppDefinition,
  type TabInstance,
} from '../../shared/tab-browser-types'

interface TabShellContextValue {
  installedApps: AppDefinition[]
  openTabs: TabInstance[]
  activeTab: TabInstance
  activeTabId: string
  isReady: boolean
  activateHome: () => void
  activateTab: (tabId: string) => void
  openApp: (app: AppDefinition) => void
  closeTab: (tabId: string) => void
  reorderTabs: (draggedTabId: string, targetTabId: string) => void
  addApp: (app: AppDefinition) => Promise<void>
  removeApp: (appId: string) => Promise<void>
  updateTabInfo: (update: { id: string } & Partial<Omit<TabInstance, 'id'>>) => void
}

const TabShellContext = createContext<TabShellContextValue | null>(null)

interface TabShellProviderProps {
  workspaceId?: string | null
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

export function TabShellProvider({ workspaceId, children }: TabShellProviderProps) {
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
  const hydratedRef = useRef(false)
  const workspaceSuffix = workspaceId || 'default'

  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      const persistedApps = await window.electronAPI.getTabBrowserApps().catch(() => [])
      if (cancelled) return

      const apps = normalizeInstalledApps(persistedApps)
      const rawTabs = getLocalStorage<TabInstance[]>(KEYS.tabs, [POLO_TAB], workspaceSuffix)
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
  }, [setActiveTabId, setInstalledApps, setOpenTabs, workspaceSuffix])

  useEffect(() => {
    if (!hydratedRef.current) return
    const timer = window.setTimeout(() => {
      setLocalStorage(KEYS.tabs, openTabs, workspaceSuffix)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [openTabs, workspaceSuffix])

  const persistApps = useCallback(async (apps: AppDefinition[]) => {
    const normalized = normalizeInstalledApps(apps)
    setInstalledAppsState(normalized)
    await window.electronAPI.saveTabBrowserApps(normalized.filter((app) => app.id !== POLO_APP_ID))
  }, [setInstalledAppsState])

  const addApp = useCallback(async (app: AppDefinition) => {
    await persistApps([...installedApps.filter((item) => item.id !== app.id), app])
  }, [installedApps, persistApps])

  const removeApp = useCallback(async (appId: string) => {
    if (appId === POLO_APP_ID) return
    await persistApps(installedApps.filter((app) => app.id !== appId))
    setOpenTabs((tabs) => tabs.filter((tab) => tab.appId !== appId))
    if (openTabs.some((tab) => tab.appId === appId && tab.id === activeTabId)) {
      setActiveTabId(HOME_TAB_ID)
    }
  }, [activeTabId, installedApps, openTabs, persistApps, setActiveTabId, setOpenTabs])

  const value = useMemo<TabShellContextValue>(() => ({
    installedApps,
    openTabs,
    activeTab: activeTab ?? { id: HOME_TAB_ID, appId: HOME_TAB_ID, type: 'home', title: 'Home' },
    activeTabId,
    isReady,
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
    addApp,
    removeApp,
    updateTabInfo,
  }), [
    activeTab,
    activeTabId,
    activateTabWrite,
    addApp,
    closeTabWrite,
    installedApps,
    isReady,
    openAppTab,
    openTabs,
    reorderTabsWrite,
    removeApp,
    updateTabInfo,
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
