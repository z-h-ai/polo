/**
 * product-closure U11/U12 host page: production useSidebarBrowserSync +
 * RightSidebarPane over the IPC fixture, plus a mounted sonner <Toaster> so
 * the production download toast is observable, and a destroy-all trigger for
 * the U12 logout channel.
 */
import React, { useCallback, useRef, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, useAtomValue, useSetAtom, useStore } from 'jotai'
import { Toaster } from 'sonner'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@polo-ai/ui'
import '@/index.css'
import {
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} from '@/atoms/sidebar-browser'
import { useSidebarBrowserSync } from '@/hooks/use-sidebar-browser-sync'
import { RightSidebarPane } from '@/components/app-shell/RightSidebarPane'

await setupI18n([initReactI18next])
await i18n.changeLanguage('zh-Hans')

const SESSION_ID = 'sess-a'
const WORKSPACE = 'ws-a'

function Harness() {
  const store = useStore()
  const openSlot = useSetAtom(sidebarBrowserOpenAtom)
  const sidebarOpen = useAtomValue(sidebarBrowserOpenAtom)
  const [ready, setReady] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const onSelectSession = useCallback((_sessionId: string) => {}, [])
  useSidebarBrowserSync({
    currentSessionId: SESSION_ID,
    activeWorkspaceId: WORKSPACE,
    remoteWorkspaceId: null,
    onSelectSession,
  })

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__pc = {
      ready: true,
      open: () => ({
        open: store.get(sidebarBrowserOpenAtom),
        instanceId: store.get(sidebarBrowserInstanceIdAtom),
        tab: store.get(rightPaneTabAtom),
      }),
      openBrowser: async () => {
        const api = (window as unknown as { electronAPI: { browserPane: Record<string, (...a: unknown[]) => Promise<unknown>> } }).electronAPI.browserPane
        const id = (await api.create({ show: false, bindToSessionId: SESSION_ID })) as string
        store.set(sidebarBrowserInstanceIdAtom, id)
        store.set(sidebarBrowserOpenAtom, true)
        store.set(rightPaneTabAtom, 'browser')
        await api.embed(id)
        return id
      },
      destroyAll: async () => {
        await (window as unknown as { electronAPI: { browserPaneDestroyAll: () => Promise<void> } }).electronAPI.browserPaneDestroyAll()
      },
    }
    setReady(true)
  }, [openSlot, store])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
        <span data-testid="pc-open-state">{String(ready && sidebarOpen)}</span>
        <span style={{ marginLeft: 12, color: 'var(--muted-foreground)' }}>product-closure harness · ws-a / sess-a</span>
      </header>
      <div ref={shellRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
          <h1>会话工作区</h1>
          <p>下载 toast 与登出销毁钉子的宿主页面。</p>
        </main>
        <RightSidebarPane
          layoutKey="sidebar-browser-only"
          canvasSessionId={null}
          canvasApp={null}
          getLayoutRect={() => shellRef.current?.getBoundingClientRect() ?? null}
          currentSessionId={SESSION_ID}
          activeWorkspaceId={WORKSPACE}
          remoteWorkspaceId={null}
          onSelectSession={onSelectSession}
          onTerminate={async () => {}}
        />
      </div>
      <Toaster position="bottom-right" visibleToasts={4} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </Provider>,
)
