import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  BUILTIN_APP_DEFINITIONS,
  BUILTIN_APP_IDS,
  HOME_TAB,
  HOME_TAB_ID,
  POLO_APP_ID,
  POLO_TAB,
  POLO_TAB_ID,
  createTabId,
  type AppDefinition,
  type TabInstance,
} from '@tab-browser-types'

const EXTERNAL_APPS: AppDefinition[] = [
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://notion.so',
    type: 'webapp',
    createdAt: 1,
    order: 10,
  },
  {
    id: 'figma',
    name: 'Figma',
    url: 'https://figma.com',
    type: 'webapp',
    createdAt: 2,
    order: 11,
  },
]

interface MockTabShellValue {
  installedApps: AppDefinition[]
  openTabs: TabInstance[]
  activeTab: TabInstance
  activeTabId: string
  isReady: boolean
  activeWebAppNavigation: null
  activateHome: () => void
  activateTab: (tabId: string) => void
  openApp: (app: AppDefinition) => void
  closeTab: (tabId: string) => void
  reorderTabs: (draggedTabId: string, targetTabId: string) => void
  addApp: (app: AppDefinition) => Promise<void>
  removeApp: (appId: string) => Promise<void>
  updateTabInfo: (update: { id: string } & Partial<Omit<TabInstance, 'id'>>) => void
  registerWebAppNavigation: () => void
}

const MockTabShellContext = createContext<MockTabShellValue | null>(null)

export function MockTabShellProvider({ children }: { children: ReactNode }) {
  const [installedApps, setInstalledApps] = useState<AppDefinition[]>([
    ...BUILTIN_APP_DEFINITIONS,
    ...EXTERNAL_APPS,
  ])
  const [openTabs, setOpenTabs] = useState<TabInstance[]>([POLO_TAB])
  const [activeTabId, setActiveTabId] = useState(HOME_TAB_ID)

  const activeTab = useMemo(
    () => activeTabId === HOME_TAB_ID
      ? HOME_TAB
      : openTabs.find(tab => tab.id === activeTabId) ?? HOME_TAB,
    [activeTabId, openTabs],
  )

  const openApp = useCallback((app: AppDefinition) => {
    if (app.id === POLO_APP_ID) {
      setOpenTabs(current => current.some(tab => tab.id === POLO_TAB_ID)
        ? current
        : [POLO_TAB, ...current])
      setActiveTabId(POLO_TAB_ID)
      return
    }
    setOpenTabs(current => {
      const existing = current.find(tab => tab.appId === app.id)
      if (existing) {
        setActiveTabId(existing.id)
        return current
      }
      const tab: TabInstance = {
        id: createTabId('webapp'),
        appId: app.id,
        type: 'webapp',
        title: app.name,
        url: app.url,
      }
      setActiveTabId(tab.id)
      return [...current, tab]
    })
  }, [])

  const closeTab = useCallback((tabId: string) => {
    if (tabId === HOME_TAB_ID || tabId === POLO_TAB_ID) {
      setActiveTabId(HOME_TAB_ID)
      return
    }
    setOpenTabs(current => current.filter(tab => tab.id !== tabId))
    setActiveTabId(current => current === tabId ? HOME_TAB_ID : current)
  }, [])

  const value = useMemo<MockTabShellValue>(() => ({
    installedApps,
    openTabs,
    activeTab,
    activeTabId,
    isReady: true,
    activeWebAppNavigation: null,
    activateHome: () => setActiveTabId(HOME_TAB_ID),
    activateTab: setActiveTabId,
    openApp,
    closeTab,
    reorderTabs: () => {},
    addApp: async app => {
      setInstalledApps(current => [
        ...current.filter(item => item.id !== app.id),
        app,
      ])
    },
    removeApp: async appId => {
      if (BUILTIN_APP_IDS.has(appId)) return
      setInstalledApps(current => current.filter(app => app.id !== appId))
      setOpenTabs(current => current.filter(tab => tab.appId !== appId))
    },
    updateTabInfo: update => {
      setOpenTabs(current => current.map(tab => (
        tab.id === update.id ? { ...tab, ...update } : tab
      )))
    },
    registerWebAppNavigation: () => {},
  }), [activeTab, activeTabId, closeTab, installedApps, openApp, openTabs])

  return (
    <MockTabShellContext.Provider value={value}>
      {children}
    </MockTabShellContext.Provider>
  )
}

export function useTabShell(): MockTabShellValue {
  const value = useContext(MockTabShellContext)
  if (!value) throw new Error('MockTabShellProvider is required')
  return value
}
