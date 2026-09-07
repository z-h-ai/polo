import { useEffect, type ReactNode } from 'react'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { useTabShell } from '@/context/TabShellContext'
import { useNarrowViewport, WindowWidthGuard } from '@/components/product-space/WindowWidthGuard'
import { HOME_TAB_ID } from '../../../shared/tab-browser-types'

interface TabShellProps {
  renderPolo: () => ReactNode
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

export function TabShell({ renderPolo }: TabShellProps) {
  const { activeTab, activeTabId, isReady, openTabs, activateHome, activateTab, closeTab } = useTabShell()
  // Narrow-route boundary (Review R31/R32), PROVIDER-OWNED: evaluated only
  // with TabShellProvider-hydrated state, never the unhydrated ambient tab
  // atom — lifecycle screens render before this component and can never be
  // blocked by a stale tab route.
  //
  // - Provider hydration ALWAYS re-activates Home first (setActiveTabId
  //   (HOME_TAB_ID) in hydrate()), so a ready narrow session that begins
  //   with a stale non-Home route reaches Home through the production
  //   initialization path; pre-hydration the narrow surface is therefore
  //   the Home-only boundary (no workbench/webview/preview mounts).
  // - Once initialized, a genuinely unsupported non-Home route at narrow
  //   width fails closed to the frozen fullscreen guard.
  const narrowViewport = useNarrowViewport()
  const narrowHome = narrowViewport && (!isReady || activeTab.type === 'home')

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
      if (nav.view || nav.action || nav.joinToken || nav.tabType === 'polo') {
        const poloTab = openTabs.find((tab) => tab.type === 'polo')
        if (poloTab) activateTab(poloTab.id)
      }
    })
  }, [isReady, activateTab, openTabs])

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
  if (narrowViewport && activeTab.type !== 'home') {
    return <WindowWidthGuard />
  }

  return (
    <div className="h-full min-h-0 bg-background">
      <TabBar />
      <TabContent renderPolo={renderPolo} narrowHome={narrowHome} />
    </div>
  )
}
