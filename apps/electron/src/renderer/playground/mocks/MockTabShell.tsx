import * as React from 'react'
import {
  TabShellContext,
  type TabShellContextValue,
  type WebAppNavigationControls,
} from '@/context/TabShellContext'
import {
  HOME_TAB,
  HOME_TAB_ID,
  type AppDefinition,
  type TabInstance,
} from '../../../shared/tab-browser-types'

export interface MockTabShellProviderProps {
  /** Open tabs shown in the TabBar. */
  tabs: TabInstance[]
  /** Active tab id; defaults to the first tab. */
  activeTabId?: string
  /** Installed app definitions surfaced via the context (defaults to []). */
  installedApps?: AppDefinition[]
  /**
   * WebApp navigation controls for the active tab. `null` forces no
   * controls (also automatic when the active tab is not a webapp).
   * Partial objects are merged over demo defaults (canGoBack: true,
   * canGoForward: false, isLoading: false, no-op callbacks).
   */
  navigation?: Partial<WebAppNavigationControls> | null
  /** Defaults to true. */
  isReady?: boolean
  children: React.ReactNode
}

const NO_OP = () => {}

/**
 * MockTabShellProvider — feeds the real `TabShellContext` with static demo
 * data for playground components. All callbacks are no-ops. Extracted from
 * the tab-browser-shell demo's inline mock (R8/R9/R10 verification).
 */
export function MockTabShellProvider({
  tabs,
  activeTabId,
  installedApps = [],
  navigation,
  isReady = true,
  children,
}: MockTabShellProviderProps) {
  const value = React.useMemo<TabShellContextValue>(() => {
    const resolvedActiveTabId = activeTabId ?? tabs[0]?.id ?? HOME_TAB_ID
    const activeTab = tabs.find((tab) => tab.id === resolvedActiveTabId) ?? tabs[0] ?? HOME_TAB
    const activeWebAppNavigation =
      navigation === null || activeTab.type !== 'webapp'
        ? null
        : {
            canGoBack: true,
            canGoForward: false,
            isLoading: false,
            goBack: NO_OP,
            goForward: NO_OP,
            reloadOrStop: NO_OP,
            ...navigation,
          }

    return {
      installedApps,
      openTabs: tabs,
      activeTab,
      activeTabId: resolvedActiveTabId,
      isReady,
      activeWebAppNavigation,
      activateHome: NO_OP,
      activateTab: NO_OP,
      openApp: NO_OP,
      closeTab: NO_OP,
      reorderTabs: NO_OP,
      addApp: async () => {},
      removeApp: async () => {},
      updateTabInfo: NO_OP,
      registerWebAppNavigation: NO_OP,
    }
  }, [tabs, activeTabId, installedApps, navigation, isReady])

  return <TabShellContext.Provider value={value}>{children}</TabShellContext.Provider>
}
