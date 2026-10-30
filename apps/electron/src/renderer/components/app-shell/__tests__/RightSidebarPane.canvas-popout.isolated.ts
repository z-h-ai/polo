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

// --- Fake jotai (two stores mirroring the production Provider topology) -------

function fakeAtom(readOrInit?: unknown, write?: unknown): any {
  if (typeof readOrInit === 'function' && write === undefined) return { read: readOrInit }
  return { init: readOrInit, write }
}

// POO-135 r3 去假绿化 — the earlier fake COLLAPSED getDefaultStore and the
// provider store into one ("the fake collapses both stores into one"), which
// masked the production store-split bug across r1/r2. Production: the
// <JotaiProvider> (no store prop) creates its OWN store, so the sync hook /
// pane / bridge (useStore, useAtomValue, useSetAtom) share contextStore while
// getDefaultStore() hands out a different object nobody in the tree reads.
// Every seed and assertion below goes through contextStore.
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
const { GENUI_APP_CANVAS_OPEN_EVENT, GENUI_APP_CANVAS_FOCUS_EVENT, GENUI_APP_CANVAS_STATE_EVENT } = await import('@polo-ai/ui/chat/GenUiAppCard')
const { getDefaultStore, useStore } = await import('jotai')

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
  contextStore.values.clear()
  contextStore.values.clear()
  contextStore.values.set(sessionMetaMapAtomRef, new Map())
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

  it('popped-out canvas leaves no placeholder or live sidebar card', () => {
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: true, isVisible: true })
    const view = mountPane()
    expect(view.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
    expect(view.queryByTestId('canvas-pane-card')).toBeNull()
  })

  it('explicit return makes the original canvas available in the sidebar', () => {
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: false, isVisible: true })
    const view = mountPane()
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
  })

  it('hiding a popup does not return its canvas to the sidebar', () => {
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: true, isVisible: false })
    const view = mountPane()
    expect(view.queryByTestId('canvas-pane-card')).toBeNull()
    expect(apiCalls.attachFromPopup).toEqual([])
  })

  it('popout flag is per-session: another session keeps its card embedded', () => {
    broadcastCanvasState({ sessionId: 'sess-b', poppedOut: true, isVisible: true })
    const view = mountPane({ canvasSessionId: 'sess-a', layoutKey: 'sess-a' })
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
    expect(view.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
  })

  it('a popped-out canvas does not evict the browser: both tabs stay and switch', () => {
    const instances = [makeInstance()]
    contextStore.set(browserInstancesMapAtom, new Map(instances.map((i) => [i.id, i])))
    contextStore.set(sidebarBrowserOpenAtom, true)
    contextStore.set(sidebarBrowserInstanceIdAtom, 'inst-1')
    contextStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })

    const view = mountPane()
    expect(view.queryByTestId('right-pane-tabs')).toBeNull()
    expect(view.queryByTestId('sidebar-canvas-popup-placeholder')).toBeNull()
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
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
    expect(contextStore.get(canvasPanePopoutAtomFamily('sess-x'))).toEqual({
      sessionId: 'sess-x', poppedOut: true, isVisible: true,
    })
    broadcastCanvasState({ sessionId: 'sess-x', poppedOut: false, isVisible: false })
    expect(contextStore.get(canvasPanePopoutAtomFamily('sess-x'))).toEqual({
      sessionId: 'sess-x', poppedOut: false, isVisible: false,
    })
    view.unmount()
    // Only this test's host unsubscribes; the beforeEach SyncHost is torn
    // down by afterEach cleanup.
    expect(canvasPaneStateCbs.length).toBe(subscribedBefore)
  })
})

describe('GenUiCanvasBridge open-while-popped guard (SB-CANVAS-OUT)', () => {
  it('a new canvas replaces the old presentation and selects its sidebar tab', () => {
    contextStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: true })

    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_OPEN_EVENT, {
      detail: { sessionId: 'sess-a', appId: APP.appId, title: APP.title, indexPath: APP.indexPath, version: 3 },
    }))

    expect(apiCalls.attachFromPopup).toEqual([])
    expect(contextStore.get(canvasPanePopoutAtomFamily('sess-a'))).toBeNull()
    expect(contextStore.get(rightPaneTabAtom)).toBe('canvas')
    expect(contextStore.get(canvasPaneAppAtomFamily('sess-a'))).toEqual(APP)
    view.unmount()
  })

  it('an open while NOT popped out never calls attach', () => {
    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_OPEN_EVENT, {
      detail: { sessionId: 'sess-a', appId: APP.appId, title: APP.title, indexPath: APP.indexPath, version: 3 },
    }))
    expect(apiCalls.attachFromPopup).toEqual([])
    expect(contextStore.get(canvasPaneAppAtomFamily('sess-a'))).toEqual(APP)
    view.unmount()
  })

  it('closed state clears the inline placeholder and a later open resets presentation', () => {
    contextStore.set(canvasPaneAppAtomFamily('sess-a'), APP)
    contextStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: false, isVisible: false })
    const events: any[] = []
    const listener = (event: any) => events.push(event.detail)
    window.addEventListener(GENUI_APP_CANVAS_STATE_EVENT, listener)
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: false, isVisible: false, closed: true })
    expect(contextStore.get(canvasPaneAppAtomFamily('sess-a'))).toBeNull()
    expect(contextStore.get(canvasPanePopoutAtomFamily('sess-a'))).toBeNull()
    expect(events.at(-1)).toEqual({ sessionId: 'sess-a', appId: null })
    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_OPEN_EVENT, { detail: { sessionId: 'sess-a', ...APP } }))
    expect(contextStore.get(canvasPaneAppAtomFamily('sess-a'))).toEqual(APP)
    expect(contextStore.get(canvasPanePopoutAtomFamily('sess-a'))).toBeNull()
    window.removeEventListener(GENUI_APP_CANVAS_STATE_EVENT, listener)
    view.unmount()
  })
  it('the transcript FOCUS request restores a hidden sidebar canvas through Main', () => {
    contextStore.set(canvasPaneAppAtomFamily('sess-a'), APP)
    contextStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: false, isVisible: false })
    contextStore.set(rightPaneTabAtom, 'browser')
    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_FOCUS_EVENT, { detail: { sessionId: 'sess-a', appId: APP.appId } }))
    expect(apiCalls.focus).toEqual([['sess-a']])
    expect(contextStore.get(rightPaneTabAtom)).toBe('canvas')
    expect(apiCalls.attachFromPopup).toEqual([])
    view.unmount()
  })
  it('a transcript FOCUS keeps an existing popup in its chosen location', () => {
    contextStore.set(canvasPaneAppAtomFamily('sess-a'), APP)
    contextStore.set(canvasPanePopoutAtomFamily('sess-a'), { sessionId: 'sess-a', poppedOut: true, isVisible: false })
    contextStore.set(rightPaneTabAtom, 'browser')
    const view = render(createElement(GenUiCanvasBridge))
    window.dispatchEvent(new window.CustomEvent(GENUI_APP_CANVAS_FOCUS_EVENT, { detail: { sessionId: 'sess-a', appId: APP.appId } }))
    expect(apiCalls.focus).toEqual([['sess-a']])
    expect(contextStore.get(rightPaneTabAtom)).toBe('browser')
    expect(apiCalls.attachFromPopup).toEqual([])
    view.unmount()
  })
  it('Main explicit return selects canvas and clears the file surface precedence', () => {
    const onPresented = mock(() => {})
    function Host() { useCanvasPaneSync({ currentSessionId: 'sess-a', onPresented }); return null }
    const view = render(createElement(Host))
    contextStore.set(rightPaneTabAtom, 'browser')
    broadcastCanvasState({ sessionId: 'sess-a', poppedOut: false, isVisible: true })
    expect(contextStore.get(rightPaneTabAtom)).toBe('canvas')
    expect(onPresented).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('topology guard (r3): the sync hook and the pane share the PROVIDER store, distinct from getDefaultStore', () => {
    // The pre-r3 fake collapsed both stores into one and hid the production
    // store split for two review rounds; if they collapse again the mirror
    // and guard assertions above go vacuous — fail here first.
    let probe: unknown
    function StoreProbe() {
      probe = useStore()
      return null
    }
    render(createElement(StoreProbe))
    expect(probe).toBeTruthy()
    expect(probe).not.toBe(getDefaultStore())
  })
})
