import { atom } from 'jotai'
import {
  createTabId,
  HOME_TAB_ID,
  normalizeInstalledApps,
  POLO_APP_ID,
  POLO_TAB,
  POLO_TAB_ID,
  projectTabId,
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

/** POO-205 Spec §10: open-or-focus the tab hosting ONE project. Entering a
 * project never routes the Polo tab and never opens a drawer — the tab itself
 * (title = project name) is the project's assistant workspace. Idempotent per
 * projectId; re-entering refreshes the carried identity (name/purpose may
 * have been edited) and focuses the existing tab. */
export const openProjectTabAtom = atom(
  null,
  (get, set, project: NonNullable<TabInstance['project']>) => {
    const tabId = projectTabId(project.projectId)
    const tabs = get(openTabsAtom)
    const existing = tabs.find((tab) => tab.id === tabId)
    if (existing) {
      if (existing.title !== project.name
        || existing.project?.purpose !== project.purpose
        || existing.project?.instructions !== project.instructions) {
        set(openTabsAtom, tabs.map(tab => (
          tab.id === tabId ? { ...tab, title: project.name, project } : tab
        )))
      }
    } else {
      const tab: TabInstance = {
        id: tabId,
        appId: tabId,
        type: 'project',
        title: project.name,
        project,
      }
      const poloIndex = tabs.findIndex((tab) => tab.id === POLO_TAB_ID)
      const insertAt = poloIndex >= 0 ? poloIndex + 1 : 0
      const next = [...tabs]
      next.splice(insertAt, 0, tab)
      set(openTabsAtom, next)
    }
    set(activeTabIdAtom, tabId)
  },
)

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

    const existing = get(openTabsAtom).find((tab) => tab.appId === app.id)
    if (existing) {
      set(openTabsAtom, get(openTabsAtom).map(tab => (
        tab.id === existing.id
          ? {
              ...tab,
              title: app.name,
              favicon: app.iconUrl ?? tab.favicon,
              url: app.url,
            }
          : tab
      )))
      set(activeTabIdAtom, existing.id)
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
    if (tabId === HOME_TAB_ID) {
      set(activeTabIdAtom, HOME_TAB_ID)
      return
    }

    // POO-104: the assistant tab is a permanent entry. A close request must
    // be an idempotent no-op — it must never yank the active tab to Home
    // while another app is focused, and never remove the tab itself.
    if (tabId === POLO_TAB_ID) {
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
