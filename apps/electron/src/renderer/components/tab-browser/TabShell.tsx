import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { TabContent } from './TabContent'
import { TopBar } from '@/components/app-shell/TopBar'
import { GlobalSettingsSurface } from '@/components/app-shell/GlobalSettingsSurface'
import { useTabShell } from '@/context/TabShellContext'
import { useNarrowViewport, WindowWidthGuard } from '@/components/product-space/WindowWidthGuard'
import { useClientMaterialScope } from '@/lib/client-workbench-style'
import { GLOBAL_SETTINGS_EVENT, NAVIGATE_EVENT, navigate, routes } from '@/lib/navigate'
import {
  getGlobalSettingsSubpageFromRoute,
  shouldSurfaceAssistantForNavigate,
} from './settings-navigate'
import {
  DEFAULT_SETTINGS_SUBPAGE,
  getSettingsPageScope,
  type SettingsSubpage,
} from '../../../shared/settings-registry'
import { HOME_TAB_ID, POLO_APP_DEFINITION } from '../../../shared/tab-browser-types'
import { useWorkbenchReady } from '@/hooks/useWorkbenchReady'

interface TabShellProps {
  renderPolo: () => ReactNode
  /**
   * POO-100 C8 (P2-2, integration-owner authorized): the App-threaded A1
   * re-login entry for the circle-return account-mismatch recovery,
   * forwarded verbatim to TabContent → ClientHomeRouter → CircleDetailPage.
   * Strictly optional; unset keeps the panel's honest manual-recovery note.
   */
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

export function TabShell({ renderPolo, onReauthenticateRequest }: TabShellProps) {
  const { activeTab, activeTabId, isReady, openTabs, activateHome, activateTab, closeTab, openApp } = useTabShell()
  // POO-125: the shell-level global (Polo-scope) settings surface. `null` is
  // closed. Owned HERE — above every tab — so opening it never switches the
  // active tab and never touches the assistant's route, and the explicit
  // 返回 hands the previous surface back unchanged. The keyed TabShellProvider
  // remount drops it on an account/ProductSpace switch.
  const [globalSettingsSubpage, setGlobalSettingsSubpage] = useState<SettingsSubpage | null>(null)
  // POO-105 默认浅色微透材质（Spec §13.14）：宿主根承载材质标记与派生令牌，
  // 深色/未标记宿主保持既有不透明样式。放在窄窗判定之前，hook 顺序不受早退影响。
  useClientMaterialScope()
  // Frozen narrow-window boundary (Review R38, restores the POO-41 contract):
  // at/below the frozen 640px line EVERY route fails closed to the frozen
  // WindowWidthGuard — the POO-41 authoritative 390x844 result is the guard
  // screen, not a narrow work surface. Hook order is untouched: the hook is
  // read before every early return and the decision renders after all hooks.
  const narrowViewport = useNarrowViewport()
  useWorkbenchReady(isReady && !narrowViewport)

  // Assistant-scope categories live in the assistant tab (their pages consume
  // workspace-scoped providers), so a hand-off from the global surface closes
  // it and lets the normal assistant-scope navigation take over.
  const handleGlobalSettingsSubpageSelect = useCallback((subpage: SettingsSubpage) => {
    if (getSettingsPageScope(subpage) === 'assistant') {
      setGlobalSettingsSubpage(null)
      openApp(POLO_APP_DEFINITION)
      navigate(routes.view.settings(subpage))
      return
    }
    setGlobalSettingsSubpage(subpage)
  }, [openApp])

  useEffect(() => {
    const root = document.documentElement
    // Scope-neutral pre-hydration (Review R33/R34): the process-global tab
    // atoms still hold the PREVIOUS scope's route until hydration completes —
    // never publish a stale route marker; leave the root marker neutral.
    if (!isReady) {
      delete root.dataset.activeTab
      return () => {
        delete root.dataset.activeTab
      }
    }
    root.dataset.activeTab = activeTab.type
    return () => {
      delete root.dataset.activeTab
    }
  }, [isReady, activeTab.type])

  useEffect(() => {
    // Scope-neutral pre-hydration (Review R33/R34): do not register the
    // deep-link handler with closures over the previous scope's tabs.
    if (!isReady) return
    return window.electronAPI.onDeepLinkNavigate((nav) => {
      // POO-125: a Polo-scope settings deep link (poloai://settings/...,
      // including the "open in new window" entries) shows the shell-level
      // global surface — it does not activate the assistant tab.
      const poloSettingsSubpage = getGlobalSettingsSubpageFromRoute(nav.view)
      if (poloSettingsSubpage) {
        setGlobalSettingsSubpage(poloSettingsSubpage)
        return
      }
      if (nav.view || nav.action || nav.joinToken || nav.tabType === 'polo') {
        const poloTab = openTabs.find((tab) => tab.type === 'polo')
        if (poloTab) activateTab(poloTab.id)
      }
    })
  }, [isReady, activateTab, openTabs])

  useEffect(() => {
    // POO-103: the account menu, the Polo app menu, Cmd+, and the native
    // Settings menu all dispatch from ABOVE NavigationProvider (the TopBar
    // sits inside TabShell). POO-125: global (Polo-scope) settings requests
    // open the shell-level surface here — same visibility contract as before,
    // but without dragging the user into the assistant tab. Re-requesting the
    // open subpage (Cmd+, again) closes it and hands the previous surface
    // back. Assistant-scope settings and `action/new-session` still surface
    // the Polo tab (openApp also restores a closed Polo tab).
    if (!isReady) return
    const openGlobalSettingsSubpage = (requested: SettingsSubpage | null) => {
      const subpage = requested ?? DEFAULT_SETTINGS_SUBPAGE
      setGlobalSettingsSubpage((prev) => (prev === subpage ? null : subpage))
    }
    const handleNavigate = (event: Event) => {
      const route = (event as CustomEvent<{ route?: unknown }>).detail?.route
      // Fail-closed fallback: a stray Polo-scope settings route (a call site
      // that still navigate()s instead of openGlobalSettings()) must produce a
      // visible global surface, not a silent change inside the hidden Polo tab.
      const poloSettingsSubpage = getGlobalSettingsSubpageFromRoute(route)
      if (poloSettingsSubpage) {
        openGlobalSettingsSubpage(poloSettingsSubpage)
        return
      }
      if (!shouldSurfaceAssistantForNavigate(route)) return
      openApp(POLO_APP_DEFINITION)
    }
    const handleGlobalSettings = (event: Event) => {
      openGlobalSettingsSubpage((event as CustomEvent<{ subpage?: SettingsSubpage | null }>).detail?.subpage ?? null)
    }
    window.addEventListener(NAVIGATE_EVENT, handleNavigate)
    window.addEventListener(GLOBAL_SETTINGS_EVENT, handleGlobalSettings)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigate)
      window.removeEventListener(GLOBAL_SETTINGS_EVENT, handleGlobalSettings)
    }
  }, [isReady, openApp])

  useEffect(() => {
    // Scope-neutral pre-hydration (Review R33/R34): keyboard shortcuts stay
    // unregistered until the keyed provider establishes the new scope.
    if (!isReady) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey || isEditableTarget(event.target)) return

      if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        activateHome()
        return
      }

      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        closeTab(activeTabId)
        return
      }

      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const tab = openTabs[index]
        if (tab) {
          event.preventDefault()
          activateTab(tab.id)
        } else if (index === 0) {
          event.preventDefault()
          activateHome()
        }
        return
      }

      if (event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        const sequence = [HOME_TAB_ID, ...openTabs.map((tab) => tab.id)]
        const currentIndex = Math.max(0, sequence.indexOf(activeTabId))
        const delta = event.key === ']' ? 1 : -1
        const nextIndex = (currentIndex + delta + sequence.length) % sequence.length
        const nextId = sequence[nextIndex]
        if (nextId === HOME_TAB_ID) activateHome()
        else activateTab(nextId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isReady, activateHome, activateTab, activeTabId, closeTab, openTabs])

  // PRE-HYDRATION FAIL-CLOSED boundary (Review R33 security finding):
  // `openTabsAtom`/`activeTabAtom` are process-global and still hold the
  // PREVIOUS account/ProductSpace scope's tab titles, URLs and active route
  // until this keyed provider's hydration establishes the NEW scope. The
  // hook-order-safe early return renders a scope-neutral boundary on EVERY
  // width — the stale TabBar/TabContent/webview/active route can never be
  // mounted or displayed, and it must not resurface on scope switches.
  if (!isReady) {
    return (
      <div
        className="h-full min-h-0 bg-background"
        data-testid="shell-scope-loading"
      />
    )
  }

  // Narrow-route guard decision lives AFTER every hook in this component:
  // rendering the frozen guard must not change the hook count between
  // renders (React "fewer hooks" crash on route transitions).
  if (narrowViewport) {
    return <WindowWidthGuard />
  }

  return (
    // 材质作用域内 shell 根是唯一画布板：页面画布不再自绘不透明背景，
    // 93% 底板直接承在窗口原生材质上；未标记宿主保持 bg-background。
    <div className="relative h-full min-h-0 bg-background client-material-canvas">
      {/* The unified workbench bar (brand + tabs + space/account actions).
          Rendered inside the hydration gate: pre-hydration the boundary above
          returns first, so a stale previous-scope bar never surfaces. */}
      <TopBar />
      <TabContent
        renderPolo={renderPolo}
        onReauthenticateRequest={onReauthenticateRequest}
      />
      {/* POO-125: the global (Polo-scope) settings surface. Mounted over the
          active tab's content — the tab keeps its state underneath, and 返回
          (or Cmd+, again) closes it, handing that surface back unchanged. */}
      {globalSettingsSubpage !== null && (
        <GlobalSettingsSurface
          subpage={globalSettingsSubpage}
          onSelectSubpage={handleGlobalSettingsSubpageSelect}
          onClose={() => setGlobalSettingsSubpage(null)}
        />
      )}
    </div>
  )
}
