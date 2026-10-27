/**
 * Loops B/C/D surfaces page (POO-153 / POO-154 / POO-155).
 * ?loop=settings|canvas|billing — one scenario per page load; main.ts drives
 * and asserts. Production components only; IPC is the fixture preload.
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
import { TabShellProvider, useTabShell } from '@/context/TabShellContext'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { handleTypedError } from '@/event-processor/handlers/session'
import { GlobalSettingsSurface } from '@/components/app-shell/GlobalSettingsSurface'
import { PinnedCanvasApps } from '@/components/tab-browser/PinnedCanvasApps'
import { GenUiAppCard } from '@polo-ai/ui/chat/GenUiAppCard'
import { parseError } from '../../../../../packages/shared/src/agent/errors'
import '@/index.css'

await setupI18n([initReactI18next])

const params = new URLSearchParams(location.search)
const loop = params.get('loop') ?? 'settings'
await i18n.changeLanguage(params.get('lang') || 'zh-Hans')

// ── Loop B: POO-153 settings surface over the Polo assistant tab ───────────
function SettingsLoop() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__settings = { ready: true, open: () => setOpen(true) }
  }, [])
  return (
    <div style={{ height: '100vh' }}>
      <style>{':root{--topbar-height:48px}'}</style>
      <div style={{ position: 'relative', height: 'calc(100vh - 48px)', marginTop: 48, overflow: 'hidden' }}>
        {/* Tab content layer: the Polo assistant panel column with production stacking class */}
        <div data-testid="tab-content" style={{ position: 'absolute', inset: 0, background: 'rgba(127,29,29,0.12)' }}>
          <div
            data-testid="polo-panel"
            className="relative z-panel"
            style={{ width: 380, height: '100%', background: '#fecaca', padding: 16, boxSizing: 'border-box' }}
          >
            <h2 style={{ fontSize: 16 }}>Polo 助手会话列表</h2>
            <p style={{ lineHeight: 1.8 }}>重叠探针文字重叠探针文字重叠探针文字重叠探针文字</p>
            <p>设置面打开时这些字不得透出。</p>
          </div>
        </div>
        {open && (
          <GlobalSettingsSurface subpage="input" onSelectSubpage={() => {}} onClose={() => setOpen(false)} />
        )}
      </div>
    </div>
  )
}

// ── Loop C: POO-154 canvas app card + Home pinned section ──────────────────
function CanvasInner({ bundlePath }: { bundlePath: string }) {
  const { installedApps, openTabs, closeTab, openApp, isReady } = useTabShell()
  const [auditCalls, setAuditCalls] = useState(0)
  const apiRef = useRef({ closeTab, openApp })
  apiRef.current = { closeTab, openApp }

  useEffect(() => {
    const off = (window as unknown as { electronAPI: { onAuditRecorded: (cb: () => void) => () => void } }).electronAPI.onAuditRecorded(() => {
      setAuditCalls((c) => c + 1)
    })
    return off
  }, [])

  const stateRef = useRef<Record<string, unknown>>(null as unknown as Record<string, unknown>)
  stateRef.current = { installedApps, openTabs, auditCalls }
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__canvasState = stateRef.current
    w.__canvasApi = {
      closeTab: (id: string) => apiRef.current.closeTab(id),
      openApp: (id: string) => {
        const app = (stateRef.current.installedApps as { id: string }[]).find((a) => a.id === id)
        if (app) apiRef.current.openApp(app as never)
      },
    }
    w.__canvas = { ready: isReady }
  })

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, height: '100vh', boxSizing: 'border-box' }}>
      <div data-testid="poo154-card" style={{ width: 560, flexShrink: 0 }}>
        <GenUiAppCard
          appId="team-dashboard"
          title="Team Dashboard"
          html="<!doctype html><html><body><h1>Team Dashboard fixture</h1></body></html>"
          indexPath={bundlePath}
          version={3}
          sessionId="poo154-session"
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <PinnedCanvasApps />
      </div>
    </div>
  )
}

function CanvasLoop({ bundlePath }: { bundlePath: string }) {
  return (
    <Provider>
      <TabShellProvider workspaceId="playground-workspace">
        <CanvasInner bundlePath={bundlePath} />
      </TabShellProvider>
    </Provider>
  )
}

// ── Loop D: POO-155 billing error bubble (real ChatDisplay) ────────────────
function BillingLoop() {
  const scenario = params.get('scenario') === 'ordinary' ? 'ordinary' : 'sentinel'
  const mode = params.get('mode') === 'persisted' ? 'persisted' : 'live'
  const raw = scenario === 'ordinary' ? '402 Payment Required' : '402 POLO_INSUFFICIENT_CREDIT: 余额不足，请充值后重试。'
  const parsed = parseError(new Error(raw))
  const errorMessage = {
    id: 'error-fixture',
    role: 'error' as const,
    timestamp: 1793071074533,
    content: parsed.title ? `${parsed.title}: ${parsed.message}` : parsed.message,
    errorCode: parsed.code,
    errorTitle: parsed.title,
    errorOriginal: parsed.originalError,
    errorCanRetry: parsed.canRetry,
    errorActions: parsed.actions.map((a) => ({ key: a.key, label: a.label, action: a.action, url: a.url })),
  }
  const initialSession = {
    id: '261027-vital-oak',
    workspaceId: 'playground-workspace',
    name: '找到polo客户端不合理的交互',
    createdAt: 1793070969000,
    lastMessageAt: 1793071074533,
    isProcessing: true,
    messages: [{ id: 'user-fixture', role: 'user', content: '找到polo客户端不合理的交互', timestamp: 1793070969000 }],
  }
  const processed = handleTypedError(
    { session: initialSession, streaming: null } as never,
    { type: 'typed_error', sessionId: initialSession.id, error: parsed, timestamp: 1793071074533 } as never,
  ).state.session
  const session = mode === 'live' ? processed : JSON.parse(JSON.stringify(processed))
  const no = () => {}

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__billing = { ready: true, scenario, mode }
  }, [scenario, mode])

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '16px 32px', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
        261027-vital-oak · {scenario} / {mode}
      </header>
      <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ChatDisplay
          session={session as never}
          onSendMessage={no}
          onOpenFile={no}
          onOpenUrl={no}
          currentModel="deepseek-flash"
          placeholder="输入消息…"
          inputValue=""
          onInputChange={no}
          compactMode={false}
        />
      </section>
    </main>
  )
}

const bundlePath = params.get('bundle') ?? ''
const inner = loop === 'settings' ? <SettingsLoop /> : loop === 'canvas' ? <CanvasLoop bundlePath={bundlePath} /> : <BillingLoop />

// Shared provider stack — PlaygroundAppShellProvider is the documented
// minimal AppShellProvider stand-in; settings pages and ChatDisplay both
// consume that context.
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
                      {inner}
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
