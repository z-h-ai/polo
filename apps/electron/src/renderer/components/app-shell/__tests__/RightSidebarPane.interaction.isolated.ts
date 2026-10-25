/**
 * POO-135 unified right sidebar — two-layer header integration.
 *
 * Real atoms + real pane component on a fake jotai store; CanvasPaneCard, the
 * sync hook, sessions atoms and motion are stubbed (their behavior has its own
 * dedicated tests/files). Run per-file (shared happy-dom process):
 * `bun test ./apps/electron/src/renderer/components/app-shell/__tests__/RightSidebarPane.interaction.isolated.ts`
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

// EmbeddedBrowserContainer observes its rect; happy-dom rects are 0-sized and
// ResizeObserver may be absent — a stub keeps the effect inert but exercised.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// --- Fake jotai --------------------------------------------------------------

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

const stubT = (key: string, opts?: Record<string, unknown>) =>
  opts && typeof opts.session === 'string' ? `Joining: ${opts.session}` : key

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: stubT }),
}))

// motion.div → plain div (animation props dropped), reduced motion always on.
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

// NOTE: react-dom is intentionally NOT mocked — @testing-library/react reads
// act internals from it. createPortal renders the (inert) drag mask to body.

mock.module('sonner', () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
}))

// Relative to THIS test file (bun resolves mock.module specifiers from here).
mock.module('../CanvasPane', () => ({
  CanvasPaneCard: () => (createElement as any)('div', { 'data-testid': 'canvas-pane-card' }, 'canvas'),
}))

// Plain object (not a Symbol) so it can key the fake store's Map<object, _>.
const sessionMetaMapAtomRef: object = { id: 'sessionMetaMapAtom' }
mock.module('@/atoms/sessions', () => ({
  sessionMetaMapAtom: sessionMetaMapAtomRef,
}))

const terminateBrowser = mock((_instance: unknown) => Promise.resolve())
mock.module('@/hooks/use-sidebar-browser-sync', () => ({
  useSidebarBrowserSync: () => ({ terminateBrowser }),
}))

// --- electronAPI.browserPane capture -----------------------------------------

const apiCalls: Record<string, unknown[][]> = {
  create: [], navigate: [], embed: [], detachToPopup: [],
  destroy: [], setElementPicking: [], goBack: [], goForward: [], reload: [],
}
let nextInstanceId = 'inst-created'

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    isChannelAvailable: () => true,
    browserPane: {
      list: async () => [],
      onStateChanged: (_cb: unknown) => () => {},
      onRemoved: (_cb: unknown) => () => {},
      onElementPickerEvent: (_cb: unknown) => () => {},
      create: async (opts: unknown) => { apiCalls.create.push([opts]); return nextInstanceId },
      navigate: async (...args: unknown[]) => { apiCalls.navigate.push(args) },
      embed: async (...args: unknown[]) => { apiCalls.embed.push(args) },
      detachToPopup: async (...args: unknown[]) => { apiCalls.detachToPopup.push(args) },
      destroy: async (...args: unknown[]) => { apiCalls.destroy.push(args) },
      setElementPicking: async (...args: unknown[]) => { apiCalls.setElementPicking.push(args) },
      goBack: async (...args: unknown[]) => { apiCalls.goBack.push(args) },
      goForward: async (...args: unknown[]) => { apiCalls.goForward.push(args) },
      reload: async (...args: unknown[]) => { apiCalls.reload.push(args) },
      setEmbedBounds: async (...args: unknown[]) => { apiCalls.navigate.push(args) },
    },
  },
})

const { render, cleanup, fireEvent, waitFor } = await import('@testing-library/react')
const { createElement } = await import('react')
const { RightSidebarPane } = await import('../RightSidebarPane')
const {
  activeElementPickingAtom,
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} = await import('@/atoms/sidebar-browser')
const { browserInstancesMapAtom } = await import('@/atoms/browser-pane')

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

function mountPane(overrides: Record<string, unknown> = {}) {
  const props = {
    layoutKey: 'sess-a',
    canvasSessionId: null as string | null,
    canvasApp: null,
    getLayoutRect: () => null,
    currentSessionId: 'sess-a' as string | null,
    activeWorkspaceId: null,
    remoteWorkspaceId: null,
    onSelectSession: () => {},
    ...overrides,
  }
  return render(createElement(RightSidebarPane, props as any))
}

function setInstances(instances: any[]) {
  defaultStore.set(browserInstancesMapAtom, new Map(instances.map((i) => [i.id, i])))
  defaultStore.set(sidebarBrowserOpenAtom, true)
  defaultStore.set(sidebarBrowserInstanceIdAtom, instances[0]?.id ?? null)
}

afterEach(() => {
  cleanup()
  storeValues.clear()
  // The pane reads this everywhere; seed a default so it is never undefined.
  storeValues.set(sessionMetaMapAtomRef, new Map())
  for (const key of Object.keys(apiCalls)) apiCalls[key].length = 0
  terminateBrowser.mockClear()
  nextInstanceId = 'inst-created'
})

describe('RightSidebarPane header integration (POO-135)', () => {
  it('with BOTH canvas and browser open, the two-tab layer switches content', () => {
    setInstances([makeInstance()])
    const first = mountPane({
      canvasSessionId: 'sess-a',
      canvasApp: { kind: 'preview' } as any,
    })

    // Both open → the tab strip exists and defaults to the stored tab (canvas).
    expect(first.getByTestId('right-pane-tabs')).toBeTruthy()
    expect(first.getByTestId('canvas-pane-card')).toBeTruthy()
    first.unmount()

    // Tab clicks write the stored tab (the fake store has no subscriptions —
    // content-following is driven by the stored value on the next render).
    const second = mountPane({ canvasSessionId: 'sess-a', canvasApp: { kind: 'preview' } as any })
    fireEvent.click(second.getByTestId('right-pane-tab-browser'))
    expect(defaultStore.get(rightPaneTabAtom)).toBe('browser')
    second.unmount()

    defaultStore.set(rightPaneTabAtom, 'browser')
    const third = mountPane({ canvasSessionId: 'sess-a', canvasApp: { kind: 'preview' } as any })
    expect(third.getByTestId('sidebar-browser-section')).toBeTruthy()
    expect(third.queryByTestId('canvas-pane-card')).toBeNull()
    third.unmount()

    defaultStore.set(rightPaneTabAtom, 'canvas')
    const fourth = mountPane({ canvasSessionId: 'sess-a', canvasApp: { kind: 'preview' } as any })
    expect(fourth.getByTestId('canvas-pane-card')).toBeTruthy()
  })

  it('browser-only: no tab strip, the browser section fills the pane', () => {
    setInstances([makeInstance()])
    const { getByTestId, queryByTestId } = mountPane({ canvasApp: null })

    expect(queryByTestId('right-pane-tabs')).toBeNull()
    expect(getByTestId('sidebar-browser-section')).toBeTruthy()
  })

  it('canvas-only: no tab strip, the canvas card fills the pane', () => {
    const { getByTestId, queryByTestId } = mountPane({
      canvasSessionId: 'sess-a',
      canvasApp: { kind: 'preview' } as any,
    })
    expect(queryByTestId('right-pane-tabs')).toBeNull()
    expect(getByTestId('canvas-pane-card')).toBeTruthy()
    expect(queryByTestId('sidebar-browser-section')).toBeNull()
  })

  it('layer 1 shows the ownership title (加入：<会话名>) for a session-owned browser', () => {
    setInstances([makeInstance({ ownerSessionId: 'sess-a' })])
    storeValues.set(sessionMetaMapAtomRef, new Map([['sess-a', { name: 'Alpha' }]]))
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-title').textContent).toBe('Joining: Alpha')
  })

  it('a workspace browser (no owner) shows the workspace title instead', () => {
    setInstances([makeInstance({ ownerSessionId: null })])
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-title').textContent).toBe('browserPane.sidebar.workspaceTitle')
  })

  it('layer 2: the picking entry is disabled without a target session (请先选择目标会话)', () => {
    setInstances([makeInstance({ ownerSessionId: null })])
    const { getByTestId } = mountPane({ currentSessionId: null })

    const pick = getByTestId('sidebar-browser-pick-element') as HTMLButtonElement
    expect(pick.disabled).toBe(true)
    expect(pick.title).toBe('browserPane.sidebar.noTargetSession')
  })

  it('picking arms through the API with the resolved target, and toggles off', async () => {
    setInstances([makeInstance({ ownerSessionId: null })])
    const { getByTestId, rerender } = mountPane({ currentSessionId: 'sess-a' })

    const pick = getByTestId('sidebar-browser-pick-element')
    fireEvent.click(pick)
    await waitFor(() =>
      expect(apiCalls.setElementPicking).toEqual([['inst-1', true, { targetSessionId: 'sess-a' }]]),
    )
    expect(defaultStore.get(activeElementPickingAtom)).toEqual({
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })

    // Re-render so the component re-reads the armed picking atom (the fake
    // store has no subscriptions), then the second click disarms.
    rerender(createElement(RightSidebarPane, {
      layoutKey: 'sess-a', canvasSessionId: null, canvasApp: null, getLayoutRect: () => null,
      currentSessionId: 'sess-a', activeWorkspaceId: null, remoteWorkspaceId: null,
      onSelectSession: () => {},
    } as any))
    const pickActive = getByTestId('sidebar-browser-pick-element') as HTMLButtonElement
    expect(pickActive.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pickActive)
    await waitFor(() => expect(apiCalls.setElementPicking).toEqual([
      ['inst-1', true, { targetSessionId: 'sess-a' }],
      ['inst-1', false],
    ]))
    expect(defaultStore.get(activeElementPickingAtom)).toBeNull()
  })

  it('embedded browser: detach pops it out; terminate reaches the sync hook', async () => {
    const instance = makeInstance({ hostMode: 'embedded' })
    setInstances([instance])
    const { getByTestId, queryByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-embedded-container')).toBeTruthy()
    fireEvent.click(getByTestId('sidebar-browser-detach'))
    await waitFor(() => expect(apiCalls.detachToPopup).toEqual([['inst-1']]))

    fireEvent.click(getByTestId('sidebar-browser-terminate'))
    await waitFor(() => expect(terminateBrowser).toHaveBeenCalledWith(instance))
  })

  it('popped-out browser: placeholder card + 收回 button embeds it back', async () => {
    setInstances([makeInstance({ hostMode: 'popup', isVisible: true })])
    const { getByTestId, queryByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(queryByTestId('sidebar-browser-embedded-container')).toBeNull()
    expect(getByTestId('sidebar-browser-popup-placeholder').textContent)
      .toContain('browserPane.sidebar.popupTitle')

    fireEvent.click(getByTestId('sidebar-browser-embed'))
    await waitFor(() => expect(apiCalls.embed).toEqual([['inst-1']]))
  })

  it('no browser at all: the empty state creates one bound to the CURRENT session, embedded', async () => {
    const { getByTestId, queryByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-empty-state')).toBeTruthy()
    fireEvent.click(getByTestId('sidebar-browser-create'))

    await waitFor(() => expect(apiCalls.create).toEqual([[{ show: false, bindToSessionId: 'sess-a' }]]))
    await waitFor(() => expect(apiCalls.embed).toEqual([['inst-created']]))
    expect(defaultStore.get(sidebarBrowserOpenAtom)).toBe(true)
    expect(defaultStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-created')
  })

  it('multiple visible instances: the layer-1 switcher re-points the slot', async () => {
    setInstances([
      makeInstance({ id: 'inst-1', ownerSessionId: 'sess-a' }),
      makeInstance({ id: 'inst-2', ownerSessionId: null }),
    ])
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    const select = getByTestId('sidebar-browser-instance-select') as HTMLSelectElement
    expect(select.value).toBe('inst-1')
    fireEvent.change(select, { target: { value: 'inst-2' } })
    expect(defaultStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-2')
  })
})
