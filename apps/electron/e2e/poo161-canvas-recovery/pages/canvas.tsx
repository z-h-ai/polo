/**
 * POO-161 canvas-recovery harness page. Production components only
 * (GenUiAppCard inline entry + CanvasPaneCard sidebar/popout entry); IPC is
 * the fixture preload. main.ts drives phases and asserts guest rendering.
 */
import '@/playground/mock-utils'
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from '@/context/ThemeContext'
import { FocusProvider } from '@/context/FocusContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ModalProvider } from '@/context/ModalContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { PlaygroundAppShellProvider } from '@/playground/PlaygroundAppShellProvider'
import { TooltipProvider } from '@polo-ai/ui'
import { TabShellProvider } from '@/context/TabShellContext'
import { GenUiAppCard } from '@polo-ai/ui/chat/GenUiAppCard'
import { CanvasPaneCard } from '@/components/app-shell/CanvasPane'
import type { CanvasPaneApp } from '@/shared/types'
import '@/index.css'

await setupI18n([initReactI18next])
await i18n.changeLanguage('zh-Hans')

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'all'
const raw = params.get('bundle') ?? '{}'
const bundles = JSON.parse(raw) as Record<string, { sessionId: string; app: CanvasPaneApp; html: string }>

type GuestState = { domReady: boolean; failed: boolean; loadEvents: string[] }

// Renderer-side observers: the production hook inside the cards runs its own
// handlers; these extra listeners only RECORD what happened for assertions.
function observeGuests() {
  const state: Record<string, GuestState> = {}
  for (const el of Array.from(document.querySelectorAll('webview'))) {
    const key = el.closest('[data-poo161-key]')?.getAttribute('data-poo161-key') ?? 'unknown'
    const s: GuestState = { domReady: false, failed: false, loadEvents: [] }
    el.addEventListener('dom-ready', () => { s.domReady = true })
    el.addEventListener('did-fail-load', (ev) => {
      const main = (ev as Event & { isMainFrame?: boolean }).isMainFrame !== false
      s.loadEvents.push(`did-fail-load main=${main}`)
      if (main) s.failed = true
    })
    el.addEventListener('did-finish-load', () => { s.loadEvents.push('did-finish-load') })
    state[key] = s
  }
  return state
}

function Inner() {
  const [tick, setTick] = useState(0)
  const reported = useRef(false)
  useEffect(() => {
    const timer = window.setInterval(() => setTick(t => t + 1), 500)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (reported.current) return
    // Publish as soon as the guest <webview> elements exist; main asserts the
    // actual render by reading guest body text via the guest webContents.
    const webviews: Record<string, string> = {}
    for (const el of Array.from(document.querySelectorAll('webview'))) {
      const host = el.closest('[data-poo161-key]')
      const key = host?.getAttribute('data-poo161-key') ?? 'unknown'
      webviews[key] = el.getAttribute('src') ?? ''
    }
    if (Object.keys(webviews).length === 0) return
    const guestIds: Record<string, number> = {}
    for (const el of Array.from(document.querySelectorAll('webview'))) {
      const host = el.closest('[data-poo161-key]')
      const key = host?.getAttribute('data-poo161-key') ?? 'unknown'
      // Production API pattern (POO-103): getWebContentsId throws before the
      // guest attaches; once it returns a positive id the guest is live.
      try {
        const id = (el as unknown as { getWebContentsId?: () => number }).getWebContentsId?.()
        if (typeof id === 'number' && id > 0) guestIds[key] = id
      } catch { /* not attached yet — retried on next tick */ }
    }
    if (Object.keys(guestIds).length < Object.keys(webviews).length) return
    reported.current = true
    const state = observeGuests()
    ;(window as unknown as { __poo161: unknown }).__poo161 = { webviews, guestIds, guests: state }
  }, [tick])

  const main = bundles.main
  const legacy = bundles.legacy
  if (mode === 'popout') {
    return (
      <div style={{ width: '100vw', height: '100vh', padding: 12, boxSizing: 'border-box' }}>
        {main && (
          <div data-poo161-key="popout-main" style={{ height: '100%' }}>
            <CanvasPaneCard sessionId={main.sessionId} app={main.app} />
          </div>
        )}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 20, padding: 16, height: '100vh', boxSizing: 'border-box' }}>
      {main && (
        <>
          <section data-poo161-key="inline-main" style={{ width: 560, flexShrink: 0 }}>
            <GenUiAppCard
              appId={main.app.appId}
              title={main.app.title}
              html={main.html}
              indexPath={main.app.indexPath}
              version={main.app.version ?? 1}
              sessionId={main.sessionId}
            />
          </section>
          <section data-poo161-key="sidebar-main" style={{ width: 420, flexShrink: 0 }}>
            <CanvasPaneCard sessionId={main.sessionId} app={main.app} onPopOut={() => {}} />
          </section>
        </>
      )}
      {legacy && (
        <section data-poo161-key="sidebar-legacy" style={{ width: 420, flexShrink: 0 }}>
          <CanvasPaneCard sessionId={legacy.sessionId} app={legacy.app} onPopOut={() => {}} />
        </section>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider>
    <TooltipProvider>
      <ThemeProvider defaultMode="light">
        <FocusProvider>
          <ActionRegistryProvider>
            <EscapeInterruptProvider>
              <DismissibleLayerProvider>
                <ModalProvider>
                  <PlaygroundAppShellProvider>
                    <NavigationProvider
                      workspaceId="playground-workspace"
                      workspaceSlug="playground"
                      onCreateSession={async () => null as never}
                      isReady={false}
                    >
                      <TabShellProvider workspaceId="playground-workspace">
                        <Inner />
                      </TabShellProvider>
                    </NavigationProvider>
                  </PlaygroundAppShellProvider>
                </ModalProvider>
              </DismissibleLayerProvider>
            </EscapeInterruptProvider>
          </ActionRegistryProvider>
        </FocusProvider>
      </ThemeProvider>
    </TooltipProvider>
  </Provider>,
)
