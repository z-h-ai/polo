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
import { TooltipProvider, PlatformProvider } from '@polo-ai/ui'
import '@/index.css'
import {
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} from '@/atoms/sidebar-browser'
import { useSidebarBrowserSync } from '@/hooks/use-sidebar-browser-sync'
import { CodePreviewOverlay } from '@polo-ai/ui'
import { useLinkInterceptor } from '@/hooks/useLinkInterceptor'
import { GenUiCanvasBridge } from '@/components/tab-browser/GenUiCanvasBridge'
import { dispatchGenUiAppCanvasOpen, dispatchGenUiAppCanvasFocus } from '@polo-ai/ui/chat/GenUiAppCard'
import { FilePreviewPane } from '@/components/app-shell/FilePreviewPane'
import { canvasPaneAppAtomFamily, canvasPanePopoutAtomFamily } from '@/atoms/canvas-pane'
import { useCanvasPaneSync } from '@/hooks/use-canvas-pane-sync'
import { RightSidebarPane } from '@/components/app-shell/RightSidebarPane'

await setupI18n([initReactI18next])
await i18n.changeLanguage('zh-Hans')

declare const __POO159_BASELINE__: boolean
const SESSION_ID = 'sess-a'
const WORKSPACE = 'ws-a'

function Harness() {
  const files = useLinkInterceptor({
    scopeKey: () => 'ws-a', openFileExternal: async () => {}, openUrl: async () => {}, showInFolder: async () => {},
    readFile: async () => { await new Promise(r => { (window as any).__releaseFile = r }); return '<!doctype html><html><head><title>阅读指南</title></head><body><h1>阅读指南</h1><img src="relative.png"><input value="未提交笔记"><div style="height:900px"></div><script>window.marker=123</script></body></html>' },
    readFileDataUrl: async () => '', readFileBinary: async () => new Uint8Array(),
  })
  const store = useStore()
  const openSlot = useSetAtom(sidebarBrowserOpenAtom)
  const canvas = useAtomValue(canvasPaneAppAtomFamily(SESSION_ID))
  const canvasState = useAtomValue(canvasPanePopoutAtomFamily(SESSION_ID))
  useCanvasPaneSync({ currentSessionId: SESSION_ID, onPresented: files.hidePreview })
  const sidebarOpen = useAtomValue(sidebarBrowserOpenAtom)
  const [ready, setReady] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const onSelectSession = useCallback((_sessionId: string) => {}, [])
  useSidebarBrowserSync({
    onBrowserPresented: files.hidePreview,
    currentSessionId: SESSION_ID,
    activeWorkspaceId: WORKSPACE,
    remoteWorkspaceId: null,
    onSelectSession,
  })

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { browserPane?: Record<string, (...a: unknown[]) => Promise<unknown>> } }).electronAPI!.browserPane!
    ;(window as unknown as Record<string, unknown>).__harness = {
      ready: true,
      closeFile: () => files.closePreview(),
      openFile: () => files.handleOpenFile("/fixture/guide.html"),
      hideFile: () => files.hidePreview(),
      showFile: () => files.showPreview(),
      openCanvas: (indexPath: string, appId = 'guide-canvas', title = '阅读指南') => dispatchGenUiAppCanvasOpen({ sessionId: SESSION_ID, appId, title, indexPath }),
      focusCanvas: () => { const app = store.get(canvasPaneAppAtomFamily(SESSION_ID)); if (app) dispatchGenUiAppCanvasFocus({ sessionId: SESSION_ID, appId: app.appId }) },
      canvasState: () => ({ app: store.get(canvasPaneAppAtomFamily(SESSION_ID)), presentation: store.get(canvasPanePopoutAtomFamily(SESSION_ID)), tab: store.get(rightPaneTabAtom) }),
      get: () => ({
        open: store.get(sidebarBrowserOpenAtom),
        instanceId: store.get(sidebarBrowserInstanceIdAtom),
        tab: store.get(rightPaneTabAtom),
      }),
      openRequestedBrowser: async () => {
        const id = (await api.create({ show: false })) as string
        await api.focus(id)
        return id
      },
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
  }, [openSlot, store, files.hidePreview, files.showPreview])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GenUiCanvasBridge onPresented={files.hidePreview} />
      <header style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
        <button data-file-entry type="button" onClick={() => files.handleOpenFile("/fixture/guide.html")}>fixture/guide.html</button>
        <span style={{ marginLeft: 12, color: 'var(--muted-foreground)' }}>POO-157 sidebar harness · ws-a / sess-a</span>
      </header>
      <div ref={shellRef} style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
          <h1>会话工作区</h1>
          <p>右侧栏 harness:浏览器槽位由生产 RightSidebarPane 渲染。</p>
        </main>
        <RightSidebarPane
          layoutKey="sidebar-browser-only"
          visible={__POO159_BASELINE__ || Boolean(files.previewVisible || sidebarOpen || canvas && !canvasState?.poppedOut && canvasState?.isVisible !== false)}
          filePreviewVisible={files.previewVisible}
          filePreview={!__POO159_BASELINE__ && files.previewState ? <FilePreviewPane key={files.previewState.filePath} state={files.previewState} onClose={files.hidePreview} onRetry={() => {}} loadDataUrl={files.readFileDataUrl} loadPdfData={files.readFileBinary} isDark={false} /> : null}
          canvasSessionId={SESSION_ID}
          canvasApp={!canvasState?.poppedOut && canvasState?.isVisible !== false ? canvas : null}
          getLayoutRect={() => shellRef.current?.getBoundingClientRect() ?? null}
          currentSessionId={SESSION_ID}
          activeWorkspaceId={WORKSPACE}
          remoteWorkspaceId={null}
          onSelectSession={onSelectSession}
          onTerminate={async () => {}}
        />
        <aside style={{ width: 0, overflow: 'hidden' }} data-testid="sidebar-open-state">{String(ready && sidebarOpen)}</aside>
      </div>
      {__POO159_BASELINE__ && files.previewState && 'content' in files.previewState && <CodePreviewOverlay isOpen onClose={files.closePreview} filePath={files.previewState.filePath} content={files.previewState.content ?? ''} language="html" mode="read" />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider>
    <TooltipProvider>
      <PlatformProvider actions={{ onOpenFileExternal: () => {}, onRevealInFinder: () => {} }}><Harness /></PlatformProvider>
    </TooltipProvider>
  </Provider>,
)
