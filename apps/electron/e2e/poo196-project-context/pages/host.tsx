/**
 * poo196-project-context harness host page: mounts the PRODUCTION ChatPage
 * (which composes ProjectContextTabs / ProjectFileLibrary / ProjectPinPane /
 * ChatDisplay + FreeFormInput with the @ mention popover and reference chips)
 * over the fixture electronAPI. Session data is seeded through the production
 * atoms before ChatPage mounts; fixture boundaries are the window manager /
 * IPC / login state (see README). Every business component under ChatPage is
 * production source.
 */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider as JotaiProvider, createStore, useStore } from 'jotai'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@polo-ai/ui'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import { initReactI18next } from 'react-i18next'
import '@/index.css'
import { ThemeProvider, useTheme } from '@/context/ThemeContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { FocusProvider } from '@/context/FocusContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ModalProvider } from '@/context/ModalContext'
import { ProductSpaceProvider, type ProductSpaceContextValue } from '@/context/ProductSpaceContext'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { replaceLoadedSessionAtom } from '@/atoms/sessions'
import { projectAssetDraftRefsAtomFamily } from '@/atoms/project-context'
import ChatPage from '@/pages/ChatPage'
import {
  SESSION_PERSONAL,
  SESSION_PROJECT,
  WORKSPACE_ID,
  productSpaceContextValue,
  sessionsById,
} from '../fixture-data'

await setupI18n([initReactI18next])

const params = new URLSearchParams(window.location.search)
const initialLang = params.get('lang') ?? 'zh-Hans'
const initialTheme = (params.get('theme') ?? 'light') as 'light' | 'dark'
const initialSession = params.get('session') ?? SESSION_PROJECT
await i18n.changeLanguage(initialLang)
document.documentElement.lang = initialLang

const sendMessageLog: Array<{
  sessionId: string
  message: string
  projectAssetRefs: Array<{ assetId: string; version: number; name: string }>
}> = []

const openUrlLog: string[] = []

/** R-1 证据通道：composer 的 RAW 文本模型经 onInputChange（生产 draft 同步
 * 通道，debounce 300ms）流出——DOM innerText 只能看到徽标 label，看不到
 * `[skill:…]` token 本体。 */
const inputChangeLog: string[] = []

const noop = () => {}
const noopAsync = async () => {}
const noopAsyncTrue = async () => true

/** R-1 回归夹具：统一 @ 浮层里的技能行。走生产 LoadedSkill 形状（name 取
 * metadata.name，@token 落 `[skill:<plugin>:<slug>]`）。 */
const HARNESS_SKILL = {
  slug: 'acceptance-checklist',
  metadata: {
    name: '验收清单',
    description: '生成一份验收要点清单',
  },
  content: '# 验收清单',
  path: '/fixture/skills/acceptance-checklist/SKILL.md',
  source: 'workspace' as const,
}

/** Stub callbacks object for the shell context (window manager / IPC boundary). */
const shellValue = {
  workspaces: [{ id: WORKSPACE_ID, name: 'Apollo 项目空间', rootPath: '/tmp/apollo', isDefault: true }],
  activeWorkspaceId: WORKSPACE_ID,
  activeWorkspaceSlug: null,
  llmConnections: [],
  workspaceDefaultLlmConnection: undefined,
  chatAccessStatus: null,
  refreshLlmConnections: noopAsync,
  pendingPermissions: new Map(),
  pendingCredentials: new Map(),
  pendingQuestions: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  enabledSources: [],
  skills: [HARNESS_SKILL],
  labels: [],
  sessionStatuses: [],
  enabledModes: ['safe', 'ask', 'allow-all'],
  sessionOptions: new Map(),
  onCreateSession: async () => sessionsById[SESSION_PROJECT],
  onCreateEditPopoverSession: async () => sessionsById[SESSION_PROJECT],
  onSendMessage: (
    sessionId: string,
    message: string,
    _attachments?: unknown[],
    _skillSlugs?: string[],
    _badges?: unknown[],
    _kbCollectionIds?: string[],
    _elementReferences?: unknown[],
    projectAssetRefs?: Array<{ assetId: string; version: number; name: string }>,
  ) => {
    sendMessageLog.push({ sessionId, message, projectAssetRefs: projectAssetRefs ?? [] })
  },
  onGetEditPopoverPendingQuestion: async () => null,
  onRenameSession: noop,
  onFlagSession: noop,
  onUnflagSession: noop,
  onArchiveSession: noop,
  onUnarchiveSession: noop,
  onMarkSessionRead: noop,
  onMarkSessionUnread: noop,
  onSetActiveViewingSession: noop,
  onSessionStatusChange: noop,
  onDeleteSession: noopAsyncTrue,
  onRespondToPermission: noop,
  onRespondToCredential: noop,
  onRespondToQuestion: noopAsync,
  onOpenFile: noop,
  onOpenUrl: (url: string) => { openUrlLog.push(url) },
  onSelectWorkspace: noopAsync,
  onOpenSettings: noop,
  onOpenKeyboardShortcuts: noop,
  onReset: noop,
  onSessionOptionsChange: noop,
  onGoalCommand: noop,
  onInputChange: (_sessionId: string, value: string) => { inputChangeLog.push(value) },
  onAttachmentsChange: noop,
  onSessionSourcesChange: noop,
  onSessionLabelsChange: noop,
  isFocusedPanel: true,
  isCompactMode: false,
} as unknown as AppShellContextType

// One store, created at module scope so both fixture sessions can be seeded
// through the production atom write path BEFORE ChatPage mounts (no
// "session missing" flash), while the page components keep using the ambient
// provider store.
const harnessStore = createStore()
for (const session of Object.values(sessionsById)) {
  harnessStore.set(replaceLoadedSessionAtom, session)
}

/** Exposes harness controls + production-state probes to the orchestrator. */
function HarnessBridge() {
  const store = useStore()
  const theme = useTheme()
  const [activeSession, setActiveSession] = useState(initialSession)
  const [ready, setReady] = useState(false)
  const setSessionRef = useRef<(id: string) => void>(() => {})

  useEffect(() => {
    setSessionRef.current = (id: string) => setActiveSession(id)
    // Render-timeline observer: records when the pc surfaces mutate, so the
    // orchestrator can correlate RPC completion with DOM updates.
    const renderLog: Array<{ t: number; what: string }> = []
    const mo = new MutationObserver(() => {
      const rows = document.querySelectorAll('[data-testid^="pc-asset-row-"]').length
      const list = document.querySelector('[data-testid="pc-list"]')
      const root = document.querySelector('[data-testid="pc-library"], [data-testid="pc-library-blocked"], [data-testid="pc-library-trash"]')
      const entry = {
        t: Date.now(),
        what: `rows=${rows} list=${Boolean(list)} loading=${Boolean(document.querySelector('[data-testid="pc-loading"]'))} root=${root ? (root.getAttribute('data-testid') ?? '?').replace('pc-library', '') || 'main' : 'none'}`,
      }
      const last = renderLog[renderLog.length - 1]
      if (!last || last.what !== entry.what) renderLog.push(entry)
      if (renderLog.length > 400) renderLog.shift()
    })
    mo.observe(document.body, { childList: true, subtree: true })
    const api = {
      ready: true,
      renderLog: () => renderLog.slice(-30),
      sessions: { project: SESSION_PROJECT, personal: SESSION_PERSONAL },
      session: () => activeSession,
      setSession: (id: string) => setSessionRef.current(id),
      lang: () => i18n.resolvedLanguage ?? i18n.language,
      // changeLanguage resolves with the t function (not structured-cloneable
      // across executeJavaScript) — swallow it and answer with a boolean.
      setLang: async (next: string) => {
        await i18n.changeLanguage(next)
        return true
      },
      setTheme: (mode: 'light' | 'dark') => theme.setMode(mode),
      theme: () => (theme.isDark ? 'dark' : 'light'),
      t: (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts),
      draftRefs: (sessionId: string) => store.get(projectAssetDraftRefsAtomFamily(sessionId)),
      sendMessageLog,
      openUrlLog,
      inputChangeLog,
      q: (selector: string) => Boolean(document.querySelector(selector)),
      count: (selector: string) => document.querySelectorAll(selector).length,
      text: () => document.body.innerText,
      toastText: () => {
        const region = document.querySelector('[data-sonner-toaster]')
        return region ? (region as HTMLElement).innerText : ''
      },
      overflow: () => {
        const doc = document.scrollingElement
        const overflowing: string[] = []
        document.querySelectorAll<HTMLElement>('[data-testid]').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1) overflowing.push(el.getAttribute('data-testid') ?? '?')
        })
        return {
          page: doc ? { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth } : null,
          overflowing,
        }
      },
      inputValue: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        return el ? (el.innerText ?? '') : null
      },
      focusInput: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (el) { el.focus(); return true }
        return false
      },
      insertText: (text: string) => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (!el) return false
        el.focus()
        document.execCommand('insertText', false, text)
        return true
      },
      caretToEnd: () => {
        const el = document.querySelector('[data-tutorial="chat-input"]') as HTMLElement | null
        if (!el) return false
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      },
      click: (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return false
        // Full trusted-shape pointer sequence: Radix triggers select on
        // pointerdown, Radix menu items on click; cover both.
        const rect = el.getBoundingClientRect()
        const base = {
          bubbles: true, cancelable: true, view: window,
          clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0,
        }
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mousedown', base))
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mouseup', base))
        el.click()
        return true
      },
      /** The composer's own production "press Send" simulation event. */
      send: () => {
        window.dispatchEvent(new CustomEvent('craft:submit-input'))
        return true
      },
      /** Keyboard activation fallback: Radix triggers/items respond to Enter. */
      pressEnterOn: (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return false
        el.focus()
        const base = { bubbles: true, cancelable: true, view: window, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
        el.dispatchEvent(new KeyboardEvent('keydown', base))
        el.dispatchEvent(new KeyboardEvent('keyup', base))
        return true
      },
      buttonInfo: (selector: string) => {
        const el = document.querySelector(selector) as HTMLButtonElement | null
        if (!el) return 'missing'
        return `disabled=${el.disabled} visible=${el.getBoundingClientRect().width > 0}`
      },
      blurActive: () => {
        ;(document.activeElement as HTMLElement | null)?.blur()
        return true
      },
    }
    ;(window as unknown as Record<string, unknown>).__poo196 = api
    setReady(true)
  }, [activeSession, store, theme])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1" data-testid="poo196-shell">
        <ChatPage sessionId={activeSession} />
      </div>
      <span data-testid="poo196-ready" style={{ display: 'none' }}>{String(ready)}</span>
      <span data-testid="poo196-active-session" style={{ display: 'none' }}>{activeSession}</span>
    </div>
  )
}

function Root() {
  return (
    <JotaiProvider store={harnessStore}>
      <ThemeProvider defaultMode={initialTheme} activeWorkspaceId={WORKSPACE_ID}>
        <TooltipProvider>
          <EscapeInterruptProvider>
            <FocusProvider>
              <DismissibleLayerProvider>
                <ModalProvider>
                  <NavigationProvider
                    workspaceId={WORKSPACE_ID}
                    workspaceSlug={null}
                    onCreateSession={async () => sessionsById[SESSION_PROJECT]}
                    onInputChange={() => {}}
                    getDraft={() => ''}
                  >
                    <ProductSpaceProvider value={productSpaceContextValue as unknown as ProductSpaceContextValue}>
                      <AppShellProvider value={shellValue}>
                        <HarnessBridge />
                      </AppShellProvider>
                    </ProductSpaceProvider>
                  </NavigationProvider>
                </ModalProvider>
              </DismissibleLayerProvider>
            </FocusProvider>
          </EscapeInterruptProvider>
          <Toaster position="bottom-right" visibleToasts={4} />
        </TooltipProvider>
      </ThemeProvider>
    </JotaiProvider>
  )
}

const reactRoot: Root = createRoot(document.getElementById('root')!)
reactRoot.render(<Root />)
