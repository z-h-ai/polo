import { atom } from 'jotai'
import {
  createTabId,
  HOME_TAB_ID,
  normalizeInstalledApps,
  POLO_APP_ID,
  POLO_TAB,
  POLO_TAB_ID,
  type AppDefinition,
  type TabInstance,
} from '../../shared/tab-browser-types'

export const installedAppsAtom = atom<AppDefinition[]>(normalizeInstalledApps([]))

export const openTabsAtom = atom<TabInstance[]>([POLO_TAB])

export const activeTabIdAtom = atom<string>(HOME_TAB_ID)

export const activeTabAtom = atom<TabInstance | null>((get) => {
  const activeTabId = get(activeTabIdAtom)
  if (activeTabId === HOME_TAB_ID) {
    return {
      id: HOME_TAB_ID,
      appId: HOME_TAB_ID,
      type: 'home',
      title: 'Home',
    }
  }
  return get(openTabsAtom).find((tab) => tab.id === activeTabId) ?? null
})

export const setInstalledAppsAtom = atom(null, (_get, set, apps: AppDefinition[]) => {
  set(installedAppsAtom, normalizeInstalledApps(apps))
})

export const openAppTabAtom = atom(
  null,
  (get, set, app: AppDefinition) => {
    if (app.id === POLO_APP_ID) {
      const tabs = get(openTabsAtom)
      if (!tabs.some((tab) => tab.id === POLO_TAB_ID)) {
        set(openTabsAtom, [POLO_TAB, ...tabs])
      }
      set(activeTabIdAtom, POLO_TAB_ID)
      return
    }

    const tab: TabInstance = {
      id: createTabId('webapp'),
      appId: app.id,
      type: 'webapp',
      title: app.name,
      favicon: app.iconUrl,
      url: app.url,
      isLoading: false,
    }
    set(openTabsAtom, [...get(openTabsAtom), tab])
    set(activeTabIdAtom, tab.id)
  },
)

export const closeTabAtom = atom(
  null,
  (get, set, tabId: string) => {
    if (tabId === HOME_TAB_ID || tabId === POLO_TAB_ID) {
      set(activeTabIdAtom, HOME_TAB_ID)
      return
    }

    const tabs = get(openTabsAtom)
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (closingIndex === -1) return

    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    set(openTabsAtom, nextTabs)

    if (get(activeTabIdAtom) === tabId) {
      const replacement = nextTabs[Math.min(closingIndex, nextTabs.length - 1)]
      set(activeTabIdAtom, replacement?.id ?? HOME_TAB_ID)
    }
  },
)

export const activateTabAtom = atom(null, (_get, set, tabId: string) => {
  set(activeTabIdAtom, tabId)
})

export const reorderTabsAtom = atom(null, (_get, set, tabs: TabInstance[]) => {
  const polo = tabs.find((tab) => tab.id === POLO_TAB_ID) ?? POLO_TAB
  const webTabs = tabs.filter((tab) => tab.id !== POLO_TAB_ID)
  set(openTabsAtom, [polo, ...webTabs])
})

export const updateTabInfoAtom = atom(
  null,
  (get, set, update: { id: string } & Partial<Omit<TabInstance, 'id'>>) => {
    set(
      openTabsAtom,
      get(openTabsAtom).map((tab) => (
        tab.id === update.id ? { ...tab, ...update } : tab
      )),
    )
  },
)
