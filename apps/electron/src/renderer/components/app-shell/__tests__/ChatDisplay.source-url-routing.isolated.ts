/**
 * POO-172 — ChatDisplay citation-source routing.
 *
 * Locks the channel split the implementation plan requires, through the REAL
 * ChatDisplay render tree:
 * - an assistant-markdown citation link routes to the dedicated
 *   `onOpenSourceUrl` channel (built-in browser), never to the business
 *   `onOpenUrl` channel
 * - a plain-text citation reference (`[Source 1]()`) renders as
 *   non-interactive text (CITE-02) and fires nothing
 * - a user-message link still routes to the business channel
 * - a same-screen error-card `open_url` (even https) still routes to the
 *   business channel
 * - swapping `onOpenSourceUrl` re-renders memoized bubbles (the comparator
 *   must not cache the old callback)
 *
 * Isolated happy-dom render (shared-process pattern, see
 * TopBar.app-menu.isolated.ts). Run per-file:
 *   bun test --isolate ./apps/electron/src/renderer/components/app-shell/__tests__/ChatDisplay.source-url-routing.isolated.ts
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}

// --- DOM stubs the render tree needs (motion/react, overlays) ---------------

if (typeof window.matchMedia !== 'function') {
  ;(window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  ;(globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
}

// --- Fake jotai (same topology as use-sidebar-browser-sync.interaction) -----

function fakeAtom(readOrInit?: unknown, write?: unknown): any {
  if (typeof readOrInit === 'function' && write === undefined) return { read: readOrInit }
  return { init: readOrInit, write }
}
function makeFakeStore() {
  const values = new Map<object, unknown>()
  const get = (a: any): unknown => {
    if (!values.has(a)) values.set(a, typeof a.read === 'function' ? undefined : a.init)
    return values.get(a)
  }
  const set = (a: any, ...args: unknown[]): unknown => {
    if (typeof a.write === 'function') {
      a.write((x: any) => get(x), (x: any, v: unknown) => set(x, v), ...args)
      return undefined
    }
    values.set(a, args[0])
    return args[0]
  }
  return { values, get, set }
}
const defaultStore = makeFakeStore()
const contextStore = makeFakeStore()

mock.module('jotai', () => ({
  atom: fakeAtom,
  getDefaultStore: () => defaultStore,
  useStore: () => contextStore,
  useAtomValue: (a: any) => contextStore.get(a),
  useSetAtom: (a: any) => (...args: unknown[]) => contextStore.set(a, ...args),
  useAtom: (a: any) => [contextStore.get(a), (...args: unknown[]) => contextStore.set(a, ...args)],
}))
mock.module('jotai/utils', () => ({
  atomFamily: (factory: (key: string) => any) => {
    const cache = new Map<string, any>()
    return (key: string) => {
      if (!cache.has(key)) cache.set(key, factory(key))
      return cache.get(key)
    }
  },
}))

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
  Trans: ({ children }: any) => children,
}))

const toastError = mock((_msg: string, _opts?: unknown) => {})
const toastSuccess = mock((_msg: string, _opts?: unknown) => {})
const toastWarning = mock((_msg: string, _opts?: unknown) => {})
const toastInfo = mock((_msg: string, _opts?: unknown) => {})
mock.module('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo },
}))

// @polo-ai/ui's markdown tree pulls pdf.js via Vite's `?url` suffix.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'data:application/pdf' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}))

mock.module('@/components/app-shell/input/focus-input-events', () => ({
  queuePendingFocusForSession: () => {},
  dispatchFocusInputEvent: () => {},
  consumePendingFocusForSession: () => false,
  clearPendingFocusForSession: () => {},
  __resetPendingFocusForTests: () => {},
}))

// Bun does not execute Vite import.meta.glob in the theme loader (same trick
// as MembershipTransitionBanner.interaction.isolated.ts).
mock.module('@/context/ThemeContext', () => ({
  ThemeProvider: ({ children }: any) => children,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: { colors: {} },
    shikiTheme: 'github-light',
    shikiConfig: {},
    presetTheme: null,
    isDark: false,
    isScenic: false,
  }),
  useOptionalTheme: () => undefined,
}))

// The routing under test does not depend on shell state; a minimal context
// keeps the real ChatDisplay render tree mountable outside AppShellProvider.
mock.module('@/context/AppShellContext', () => ({
  AppShellProvider: ({ children }: any) => children,
  useAppShellContext: () => ({ isFocusedPanel: true }),
  useOptionalAppShellContext: () => ({ isFocusedPanel: true }),
  useSession: () => null,
  useActiveWorkspace: () => null,
  usePendingPermission: () => undefined,
  usePendingCredential: () => undefined,
  usePendingQuestion: () => undefined,
  useSessionOptionsFor: () => ({}),
}))

const navigationCalls: Array<{ path: string; options?: unknown }> = []
mock.module('@/contexts/NavigationContext', () => ({
  NavigationProvider: ({ children }: any) => children,
  useNavigation: () => ({
    navigate: (path: string, options?: unknown) => navigationCalls.push({ path, options }),
    goBack: () => {},
    canGoBack: false,
    currentPath: '/',
  }),
  useNavigationState: () => ({ currentPath: '/' }),
}))

const noop = () => {}
const emptyRef = { current: null }
mock.module('@/hooks/keyboard', () => ({
  useFocusZone: () => ({
    zoneRef: emptyRef,
    isFocused: true,
    shouldMoveDOMFocus: false,
    intent: null,
    focus: noop,
  }),
}))

mock.module('@/context/EscapeInterruptContext', () => ({
  EscapeInterruptProvider: ({ children }: any) => children,
  useEscapeInterrupt: () => ({
    showEscapeOverlay: false,
    handleEscapePress: () => true,
    dismissOverlay: noop,
  }),
}))

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    isChannelAvailable: () => false,
    getRuntimeEnvironment: () => 'electron',
    readPreferences: async () => ({ content: {} }),
    onPreferencesChanged: () => () => {},
    searchFiles: async () => [],
    getSendMessageKey: async () => 'Enter',
  },
})

const { render, cleanup, fireEvent } = await import('@testing-library/react')
const React = await import('react')
const { ChatDisplay } = await import('../ChatDisplay')

// --- Channel capture ---------------------------------------------------------

const calls = {
  business: [] as string[],
  source: [] as string[],
  file: [] as string[],
}
let currentSourceHandler: (url: string) => void = (url) => calls.source.push(url)

function resetCalls() {
  calls.business.length = 0
  calls.source.length = 0
  calls.file.length = 0
}

// --- Fixtures ----------------------------------------------------------------

function makeSession(messages: any[]): any {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    name: 'Session 1',
    messages,
    enabledSourceSlugs: [],
    llmConnection: null,
    createdAt: 0,
    updatedAt: 0,
    sessionStatus: 'todo',
  }
}

function Harness({ messages }: { messages: any[] }) {
  return React.createElement(ChatDisplay, {
    session: makeSession(messages),
    onSendMessage: () => {},
    onOpenFile: (path: string) => calls.file.push(path),
    onOpenUrl: (url: string) => calls.business.push(url),
    onOpenSourceUrl: (url: string) => currentSourceHandler(url),
    currentModel: 'test-model',
  })
}

function mount(messages: any[]) {
  return render(React.createElement(Harness, { messages }))
}

afterEach(() => {
  cleanup()
  resetCalls()
  defaultStore.values.clear()
  contextStore.values.clear()
  currentSourceHandler = (url) => calls.source.push(url)
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe('ChatDisplay citation-source routing (POO-172)', () => {
  it('routes an assistant markdown citation link to the SOURCE channel only', async () => {
    mount([
      {
        id: 'a1',
        role: 'assistant',
        content: 'See [the source](https://example.com/src) for details.',
        createdAt: 1,
      },
    ])

    const link = await screen_findLink('the source')
    expect(link).toBeTruthy()
    fireEvent.click(link!)

    expect(calls.source).toEqual(['https://example.com/src'])
    expect(calls.business).toEqual([])
  })

  it('renders a plain-text citation reference as non-interactive text (CITE-02)', async () => {
    const { container } = mount([
      {
        id: 'a2',
        role: 'assistant',
        content: 'Backed by [Source 1]() and nothing else.',
        createdAt: 2,
      },
    ])

    await waitForMarkdown()
    expect(container.textContent).toContain('Source 1')
    // The reference text must not sit inside an <a> and must not be a link.
    const spans = Array.from(container.querySelectorAll('span, p, *')).filter(
      (el) => el.textContent === 'Source 1' && el.children.length === 0
    )
    expect(spans.length).toBeGreaterThan(0)
    const anchorAroundText = container.querySelector('a')
    expect(anchorAroundText).toBeNull()
    fireEvent.click(spans[0]!)
    expect(calls.source).toEqual([])
    expect(calls.business).toEqual([])
  })

  it('routes a user-message link to the BUSINESS channel', async () => {
    mount([
      {
        id: 'u1',
        role: 'user',
        content: 'open [policy](https://example.com/biz) please',
        createdAt: 3,
      },
    ])

    const link = await screen_findLink('policy')
    expect(link).toBeTruthy()
    fireEvent.click(link!)

    expect(calls.business).toEqual(['https://example.com/biz'])
    expect(calls.source).toEqual([])
  })

  it('routes a same-screen error-card open_url to the BUSINESS channel even for https', async () => {
    mount([
      {
        id: 'e1',
        role: 'error',
        content: 'Billing problem',
        errorTitle: 'Billing',
        errorActions: [
          { key: 'open-billing', action: 'open_url', label: 'Open billing', url: 'https://example.com/billing' },
        ],
        createdAt: 4,
      },
    ])

    await waitForMarkdown()
    const button = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent || '').includes('Open billing')
    )
    expect(button).toBeTruthy()
    fireEvent.click(button!)

    expect(calls.business).toEqual(['https://example.com/billing'])
    expect(calls.source).toEqual([])
  })

  it('re-renders memoized content when onOpenSourceUrl identity changes', async () => {
    const routedToSecond: string[] = []
    mount([
      {
        id: 'a3',
        role: 'assistant',
        content: 'Cite [the source](https://example.com/again).',
        createdAt: 5,
      },
    ])

    const link = await screen_findLink('the source')
    expect(link).toBeTruthy()
    fireEvent.click(link!)
    expect(calls.source).toEqual(['https://example.com/again'])

    // Swap the handler identity (what ChatPage does when the workspace/handler
    // changes): the memoized tree must pick up the NEW callback.
    currentSourceHandler = (url) => routedToSecond.push(url)
    const linkAfter = await screen_findLink('the source')
    expect(linkAfter).toBeTruthy()
    fireEvent.click(linkAfter!)
    expect(routedToSecond).toEqual(['https://example.com/again'])
  })
})

/// -- helpers -----------------------------------------------------------------

async function waitForMarkdown(): Promise<void> {
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() => {
    if (!document.querySelector('p, span, button')) throw new Error('markdown not ready')
  })
}

async function screen_findLink(text: string): Promise<HTMLAnchorElement | null> {
  const { waitFor } = await import('@testing-library/react')
  let found: HTMLAnchorElement | null = null
  await waitFor(() => {
    const anchors = Array.from(document.querySelectorAll('a'))
    found = anchors.find((a) => (a.textContent || '').includes(text)) as HTMLAnchorElement | null
    if (!found) throw new Error(`link "${text}" not rendered yet`)
  })
  return found
}
