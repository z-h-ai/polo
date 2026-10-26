/**
 * POO-135 验收修复 (SB-CANVAS-OUT) — canvas popout interactions in the unified
 * right sidebar + the canvas-pane sync + the open-while-popped guard.
 *
 * Real atoms + real pane/bridge/sync on the same fake jotai store discipline
 * as RightSidebarPane.interaction.isolated.ts (no subscriptions: click →
 * assert store write / captured call, broadcast → remount to observe).
 * Run per-file: `bun test ./apps/electron/src/renderer/components/app-shell/__tests__/RightSidebarPane.canvas-popout.isolated.ts`
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// --- Fake jotai (single store — the component tree reads/writes all land here) -

const storeValues = new Map<object, unknown>()

function fakeAtom(readOrInit?: unknown, write?: unknown): any {
  if (typeof readOrInit === 'function' && write === undefined) return { read: readOrInit }
  return { init: readOrInit, write }
}

const defaultStore = {
  get(a: any): unknown {
    if (!storeValues.has(a)) storeValues.set(a, typeof a.read === 'function' ? undefined : a.init)
    return storeValues.get(a)
  },
  set(a: any, ...args: unknown[]): unknown {
    if (typeof a.write === 'function') {
      a.write((x: any) => defaultStore.get(x), (x: any, v: unknown) => defaultStore.set(x, v), ...args)
      return undefined
    }
    storeValues.set(a, args[0])
    return args[0]
  },
}

mock.module('jotai', () => ({
  atom: fakeAtom,
  getDefaultStore: () => defaultStore,
  // The sync hook and GenUiCanvasBridge resolve the CONTEXT store — the fake
  // collapses both stores into one, matching the production single-Provider
  // topology the sidebar reads/writes through.
  useStore: () => defaultStore,
  useAtomValue: (a: any) => defaultStore.get(a),
  useSetAtom: (a: any) => (...args: unknown[]) => defaultStore.set(a, ...args),
  useAtom: (a: any) => [defaultStore.get(a), (...args: unknown[]) => defaultStore.set(a, ...args)],
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

const stubT = (key: string) => key

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: stubT }),
}))

const motionProxy: any = new Proxy({}, {
  get: (_target, tag: string) => (props: Record<string, unknown>) => {
    const { initial: _i, animate: _a, transition: _t, exit: _e, whileHover: _h, whileTap: _p, ...rest } = props
    return (createElement as any)(tag, rest)
  },
})
mock.module('motion/react', () => ({
  motion: motionProxy,
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

mock.module('sonner', () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
}))

// The card stub exposes the onPopOut wiring as a button; the placeholder is
// real pane code (that is the surface under test).
mock.module('../CanvasPane', () => ({
  CanvasPaneCard: (props: { onPopOut?: () => void }) =>
    (createElement as any)('div', { 'data-testid': 'canvas-pane-card' },
      (createElement as any)('button', {
        'data-testid': 'canvas-pane-card-popout',
        onClick: () => props.onPopOut?.(),
      }, 'popout')),
}))

const sessionMetaMapAtomRef: object = { id: 'sessionMetaMapAtom' }
mock.module('@/atoms/sessions', () => ({
  sessionMetaMapAtom: sessionMetaMapAtomRef,
}))

// --- electronAPI capture (browserPane + canvasPane) ---------------------------

const apiCalls: Record<string, unknown[][]> = {
  detachToPopup: [], attachFromPopup: [], focus: [],
  create: [], embed: [], unembed: [], navigate: [], destroy: [],
  setElementPicking: [],
}
let canvasPaneStateCbs: Array<(state: unknown) => void> = []

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    isChannelAvailable: () => true,
    browserPane: {
      list: async () => [],
      onStateChanged: (_cb: unknown) => () => {},
      onRemoved: (_cb: unknown) => () => {},
      onElementPickerEvent: (_cb: unknown) => () => {},
      create: async (opts: unknown) => { apiCalls.create.push([opts]); return 'inst-created' },
      navigate: async (...args: unknown[]) => { apiCalls.navigate.push(args) },
      embed: async (...args: unknown[]) => { apiCalls.embed.push(args) },
      unembed: async (...args: unknown[]) => { apiCalls.unembed.push(args) },
      destroy: async (...args: unknown[]) => { apiCalls.destroy.push(args) },
      setElementPicking: async (...args: unknown[]) => { apiCalls.setElementPicking.push(args) },
      setEmbedBounds: async () => {},
    },
    canvasPane: {
      detachToPopup: async (...args: unknown[]) => { apiCalls.detachToPopup.push(args) },
      attachFromPopup: async (...args: unknown[]) => { apiCalls.attachFromPopup.push(args) },
      focus: async (...args: unknown[]) => { apiCalls.focus.push(args) },
      onStateChanged: (cb: (state: unknown) => void) => {
        canvasPaneStateCbs.push(cb)
        return () => {
          canvasPaneStateCbs = canvasPaneStateCbs.filter((x) => x !== cb)
        }
      },
    },
  },
})

const { render, cleanup, fireEvent } = await import('@testing-library/react')
const { createElement } = await import('react')
const { RightSidebarPane } = await import('../RightSidebarPane')
const { useCanvasPaneSync } = await import('@/hooks/use-canvas-pane-sync')
const { GenUiCanvasBridge } = await import('@/components/tab-browser/GenUiCanvasBridge')
const {
  canvasPaneAppAtomFamily,
  canvasPanePopoutAtomFamily,
} = await import('@/atoms/canvas-pane')
const {
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} = await import('@/atoms/sidebar-browser')
const { browserInstancesMapAtom } = await import('@/atoms/browser-pane')
const { GENUI_APP_CANVAS_OPEN_EVENT } = await import('@polo-ai/ui/chat/GenUiAppCard')

const APP = { appId: 'app-1', title: 'Weather Card', indexPath: '/bundles/app-1/index.html', version: 3 }

function broadcastCanvasState(state: unknown) {
  for (const cb of [...canvasPaneStateCbs]) cb(state)
}

function mountPane(overrides: Record<string, unknown> = {}) {
  const props = {
    layoutKey: 'sess-a',
    canvasSessionId: 'sess-a' as string | null,
    canvasApp: APP,
    getLayoutRect: () => null,
    currentSessionId: 'sess-a' as string | null,
    activeWorkspaceId: null,
    remoteWorkspaceId: null,
    onSelectSession: () => {},
    onTerminate: () => Promise.resolve(),
    ...overrides,
  }
  return render(createElement(RightSidebarPane, props as any))
}

function makeInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'inst-1',
    url: 'https://example.com/page',
    title: 'Example',
    hostMode: 'embedded',
    isVisible: true,
    canGoBack: false,
    canGoForward: false,
    ownerSessionId: null,
    workspaceId: null,
    ...overrides,
  }
}

// Production topology: the sync hook lives at the always-mounted AppShell
// layer, NOT inside the pane — mount it here too, or broadcasts reach nothing.
beforeEach(() => {
  function SyncHost() {
    useCanvasPaneSync()
    return null
  }
  render(createElement(SyncHost))
})

afterEach(() => {
  cleanup()
  storeValues.clear()
  storeValues.set(sessionMetaMapAtomRef, new Map())
  canvasPaneStateCbs = []
  for (const key of Object.keys(apiCalls)) apiCalls[key].length = 0
})

describe('canvas popout in the unified right sidebar (SB-CANVAS-OUT)', () => {
  it('embedded canvas exposes the popout entry which calls detachToPopup with the app payload', () => {
    const view = mountPane()
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
    fireEvent.click(view.getByTestId('canvas-pane-card-popout'))
    expect(apiCalls.detachToPopup).toEqual([['sess-a', APP]])
    // The card stays until Main's broadcast confirms the detach.
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
  })

  it('popped-out canvas shows the placeholder with 收回/显示窗口; the card is gone', () => {
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: true, isVisible: true })
    const view = mountPane()
    expect(view.getByTestId('sidebar-canvas-popup-placeholder')).toBeTruthy()
    expect(view.queryByTestId('canvas-pane-card')).toBeNull()
    expect(defaultStore.get(canvasPanePopoutAtomFamily('sess-a'))).toEqual({
      sessionId: 'sess-a', poppedOut: true, isVisible: true,
    })
  })

  it('placeholder 收回 → attachFromPopup; the closed broadcast returns the card', () => {
    defaultStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })
    const view = mountPane()
    fireEvent.click(view.getByTestId('sidebar-canvas-attach'))
    expect(apiCalls.attachFromPopup).toEqual([['sess-a']])

    // System close / explicit attach both funnel into the same broadcast.
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: false, isVisible: false })
    view.unmount()
    const restored = mountPane()
    expect(restored.getByTestId('canvas-pane-card')).toBeTruthy()
    expect(restored.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
  })

  it('placeholder 显示窗口 → focus', () => {
    defaultStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })
    const view = mountPane()
    fireEvent.click(view.getByTestId('sidebar-canvas-show-window'))
    expect(apiCalls.focus).toEqual([['sess-a']])
  })

  it('popout flag is per-session: another session keeps its card embedded', () => {
    broadcastCanvasState({ sessionId: 'sess-b', poppedOut: true, isVisible: true })
    const view = mountPane({ canvasSessionId: 'sess-a', layoutKey: 'sess-a' })
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
    expect(view.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
  })

  it('a popped-out canvas does not evict the browser: both tabs stay and switch', () => {
    const instances = [makeInstance()]
    defaultStore.set(browserInstancesMapAtom, new Map(instances.map((i) => [i.id, i])))
    defaultStore.set(sidebarBrowserOpenAtom, true)
    defaultStore.set(sidebarBrowserInstanceIdAtom, 'inst-1')
    defaultStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })

    const view = mountPane()
    // Both content kinds reachable → tab strip, canvas tab shows the placeholder.
    expect(view.getByTestId('right-pane-tabs')).toBeTruthy()
    expect(view.getByTestId('sidebar-canvas-popup-placeholder')).toBeTruthy()

    fireEvent.click(view.getByTestId('right-pane-tab-browser'))
    expect(defaultStore.get(rightPaneTabAtom)).toBe('browser')
    view.unmount()

    const switched = mountPane()
    expect(switched.getByTestId('sidebar-browser-section')).toBeTruthy()
    expect(switched.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
  })
})

describe('useCanvasPaneSync (SB-CANVAS-OUT)', () => {
  it('mirrors canvas-pane:state-changed broadcasts into the per-session popout atom', () => {
    function Host() {
      useCanvasPaneSync()
      return null
    }
    const subscribedBefore = canvasPaneStateCbs.length
    const view = render(createElement(Host))
    expect(canvasPaneStateCbs.length).toBe(subscribedBefore + 1)

    broadcastCanvasState({ sessionId: 'sess-x', poppedOut: true, isVisible: true })
    expect(defaultStore.get(canvasPanePopoutAtomFamily('sess-x'))).toEqual({
      sessionId: 'sess-x', poppedOut: true, isVisible: true,
    })
    broadcastCanvasState({ sessionId: 'sess-x', poppedOut: false, isVisible: false })
    expect(defaultStore.get(canvasPanePopoutAtomFamily('sess-x'))).toEqual({
      sessionId: 'sess-x', poppedOut: false, isVisible: false,
    })
    view.unmount()
    // Only this test's host unsubscribes; the beforeEach SyncHost is torn
    // down by afterEach cleanup.
    expect(canvasPaneStateCbs.length).toBe(subscribedBefore)
  })
})

describe('GenUiCanvasBridge open-while-popped guard (SB-CANVAS-OUT)', () => {
  it('an explicit canvas open while popped out first returns the popup', () => {
    defaultStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })

    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_OPEN_EVENT, {
      detail: { sessionId: 'sess-a', appId: APP.appId, title: APP.title, indexPath: APP.indexPath, version: 3 },
    }))

    expect(apiCalls.attachFromPopup).toEqual([['sess-a']])
    expect(defaultStore.get(canvasPaneAppAtomFamily('sess-a'))).toEqual(APP)
    view.unmount()
  })

  it('an open while NOT popped out never calls attach', () => {
    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_OPEN_EVENT, {
      detail: { sessionId: 'sess-a', appId: APP.appId, title: APP.title, indexPath: APP.indexPath, version: 3 },
    }))
    expect(apiCalls.attachFromPopup).toEqual([])
    expect(defaultStore.get(canvasPaneAppAtomFamily('sess-a'))).toEqual(APP)
    view.unmount()
  })
})
