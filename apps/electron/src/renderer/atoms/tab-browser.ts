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

/** POO-205 C4: the committed ProductSpace kind ('personal' | 'enterprise'),
 * published by TabShellProvider's bridge from the ProductSpaceContext. Null
 * outside a committed space (legacy local-account windows, pre-hydration):
 * every kind-gated behavior fails OPEN to the personal layout. */
export const committedSpaceKindAtom = atom<'personal' | 'enterprise' | null>(null)

export const activeTabIdAtom = atom<string>(HOME_TAB_ID)

/**
 * POO-205 C4 (R4): the SINGLE source of "which tabs exist" for the strip,
 * ⌘-digit / ⌘⇧[ ] cycling and close-tab fallbacks. In an ENTERPRISE committed
 * space the Polo tab retires (chat lives only inside project tabs) — it stays
 * in openTabsAtom (persistence, TabContent mounting, the personal layout all
 * still need it) but every visible-tab consumer reads through this atom.
 */
export const visibleTabsAtom = atom<TabInstance[]>((get) => {
  const tabs = get(openTabsAtom)
  if (get(committedSpaceKindAtom) !== 'enterprise') return tabs
  return tabs.filter((tab) => tab.type !== 'polo')
})

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
      // POO-205 C4 (R6): a new project tab APPENDS — the ⌘-digit mapping is
      // [Home, ...visible tabs], so inserting after the (enterprise-invisible)
      // Polo tab would silently renumber the user's tabs mid-session.
      set(openTabsAtom, [...tabs, tab])
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
    const closingTab = tabs.find((tab) => tab.id === tabId)
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId)
    if (closingIndex === -1) return

    // The closed tab's slot in the PRE-close visible strip decides the
    // replacement — read BEFORE the removal below mutates the atom, or the
    // closing tab would already be gone from the derived list.
    const closingVisibleIndex = get(visibleTabsAtom).findIndex((tab) => tab.id === tabId)

    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    set(openTabsAtom, nextTabs)

    if (get(activeTabIdAtom) !== tabId) return

    // POO-205 C4 (R5): closing the ACTIVE project tab always returns Home —
    // never a neighbor's conversation, and never a stopped-project surprise.
    // (The project's running sessions keep running; only the tab closes.)
    if (closingTab?.type === 'project') {
      set(activeTabIdAtom, HOME_TAB_ID)
      return
    }

    // The neighbor fallback reads the VISIBLE strip (C4-A): in an enterprise
    // space the retired Polo tab is never the replacement, and closing the
    // last visible tab lands Home. The personal space keeps its exact previous
    // behavior (the strip equals the full list there — same slot arithmetic).
    if (closingVisibleIndex !== -1) {
      const visibleAfter = get(visibleTabsAtom)
      const replacement = visibleAfter[Math.min(closingVisibleIndex, visibleAfter.length - 1)]
      set(activeTabIdAtom, replacement?.id ?? HOME_TAB_ID)
      return
    }
    const replacement = nextTabs[Math.min(closingIndex, nextTabs.length - 1)]
    set(activeTabIdAtom, replacement?.id ?? HOME_TAB_ID)
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
