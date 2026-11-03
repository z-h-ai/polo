import { workspace, sessions, MOCK_LLM_CONNECTIONS, MOCK_SESSION_STATUSES } from './fixtures'
import React, { useEffect, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, createStore } from 'jotai'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ActionRegistryProvider } from '@/actions'
import { ThemeProvider } from '@/context/ThemeContext'
import { FocusProvider } from '@/context/FocusContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'
import { MemberCatalogProvider } from '@/context/MemberCatalogContext'
import { MemberCircleResourceProvider } from '@/context/MemberCircleResourceContext'
import { ModalProvider } from '@/context/ModalContext'
import { TabShellProvider, useTabShell } from '@/context/TabShellContext'
import { ClientPageProvider } from '@/context/ClientPageContext'
import { TooltipProvider, PlatformProvider, ShikiThemeProvider } from '@polo-ai/ui'
import { PlaygroundAppShellProvider } from '@/playground/PlaygroundAppShellProvider'
import { AppShellProvider, useOptionalAppShellContext, type AppShellContextType } from '@/context/AppShellContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { TabShell } from '@/components/tab-browser/TabShell'
import { AppShell } from '@/components/app-shell/AppShell'
import { initializeSessionsAtom } from '@/atoms/sessions'
import { productSpaceFixture } from '../../source-baseline/entries/fixtures'
import './baseline.css'

setupI18n([initReactI18next])
void i18n.changeLanguage('zh-Hans')
// Seed once in an isolated browser page/profile; reload preserves user changes.
// In particular, never seed nav:more closed to disguise the production default.
if (!sessionStorage.getItem('polo178-fixture-initialized')) {
  const savedWidth = new URLSearchParams(location.search).get('savedWidth')
  if (savedWidth === null) localStorage.removeItem('craft-sidebar-width')
  else {
    const value = Number(savedWidth)
    if (!Number.isFinite(value) || value < 180 || value > 320) throw new Error('fixture savedWidth must be valid 180..320')
    localStorage.setItem('craft-sidebar-width', JSON.stringify(value))
  }
  localStorage.removeItem('craft-focus-mode-enabled')
  localStorage.removeItem('craft-collapsed-sidebar-items:playground-workspace')
  sessionStorage.setItem('polo178-fixture-initialized', '1')
}
const store = createStore()
store.set(initializeSessionsAtom, sessions)

function ActivateAssistant() {
  const tabs = useTabShell()
  useEffect(() => { if (tabs.isReady) tabs.activateTab('polo-ai-tab') }, [tabs.isReady])
  return null
}

function Shell() {
  const base = useOptionalAppShellContext()!
  const value = useMemo<AppShellContextType>(() => ({
    ...base, workspaces: [workspace], activeWorkspaceId: workspace.id, activeWorkspaceSlug: workspace.slug,
    sessionStatuses: MOCK_SESSION_STATUSES, llmConnections: MOCK_LLM_CONNECTIONS, isCompactMode: false,
    currentAdminUser: { userId: 'fixture-member', username: 'review-member', displayName: '林同学' },
    getDraft: () => '', onSetActiveViewingSession: () => {}, onSessionLabelsChange: () => {}, onSendMessage: () => {},
  }), [base])
  return <AppShellProvider value={value}><ProductSpaceProvider value={productSpaceFixture}>
    <MemberCatalogProvider><MemberCircleResourceProvider>
      <ClientPageProvider scope={{ accountId: productSpaceFixture.accountId, productSpaceId: productSpaceFixture.activeProductSpaceId, epoch: 0 }}>
        <TabShellProvider workspaceId={workspace.id}>
          <ActivateAssistant />
          <TabShell renderPolo={() => <NavigationProvider workspaceId={workspace.id} workspaceSlug={workspace.slug}
            onCreateSession={value.onCreateSession} getDraft={value.getDraft} isReady isSessionsReady>
            <AppShell contextValue={value} />
          </NavigationProvider>} />
        </TabShellProvider>
      </ClientPageProvider>
    </MemberCircleResourceProvider></MemberCatalogProvider>
  </ProductSpaceProvider></AppShellProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <JotaiProvider store={store}><PlatformProvider><ShikiThemeProvider shikiTheme={null}><ThemeProvider defaultMode="light">
    <ActionRegistryProvider><FocusProvider><EscapeInterruptProvider><DismissibleLayerProvider>
      <ModalProvider><TooltipProvider><PlaygroundAppShellProvider><Shell /></PlaygroundAppShellProvider></TooltipProvider></ModalProvider>
    </DismissibleLayerProvider></EscapeInterruptProvider></FocusProvider></ActionRegistryProvider>
  </ThemeProvider></ShikiThemeProvider></PlatformProvider></JotaiProvider>,
)
