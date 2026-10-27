/**
 * Loop A host page (POO-157): production RightSidebarPane +
 * useSidebarBrowserSync over the IPC fixture. Mirrors the production open
 * flow: create instance → select it in the sidebar slot → embed.
 */
import React, { useCallback, useRef, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, useAtomValue, useSetAtom, useStore } from 'jotai'
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
    const api = (window as unknown as { electronAPI?: { browserPane?: Record<string, (...a: unknown[]) => Promise<unknown>> } }).electronAPI!.browserPane!
    ;(window as unknown as Record<string, unknown>).__harness = {
      ready: true,
      get: () => ({
        open: store.get(sidebarBrowserOpenAtom),
        instanceId: store.get(sidebarBrowserInstanceIdAtom),
        tab: store.get(rightPaneTabAtom),
      }),
      openBrowser: async () => {
        const id = (await api.create({ show: false })) as string
        store.set(sidebarBrowserInstanceIdAtom, id)
        store.set(sidebarBrowserOpenAtom, true)
        store.set(rightPaneTabAtom, 'browser')
        await api.embed(id)
        return id
      },
      open: () => {
        openSlot(true)
        const id = store.get(sidebarBrowserInstanceIdAtom)
        if (id) void api.embed(id)
      },
      collapse: () => {
        openSlot(false)
      },
    }
    setReady(true)
  }, [openSlot, store])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
        <button data-open type="button">打开浏览器</button>
        <span style={{ marginLeft: 12, color: 'var(--muted-foreground)' }}>POO-157 sidebar harness · ws-a / sess-a</span>
      </header>
      <div ref={shellRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
          <h1>会话工作区</h1>
          <p>右侧栏 harness:浏览器槽位由生产 RightSidebarPane 渲染。</p>
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
        <aside style={{ width: 0, overflow: 'hidden' }} data-testid="sidebar-open-state">{String(ready && sidebarOpen)}</aside>
      </div>
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
