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

HTMLElement.prototype.scrollIntoView ??= () => {}

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

function fakeAtom(readOrInit?: unknown, write?: unknown): any {
  if (typeof readOrInit === 'function' && write === undefined) return { read: readOrInit }
  return { init: readOrInit, write }
}

// POO-135 r3 去假绿化 — TWO fake stores mirroring the production topology:
// <JotaiProvider> (no store prop) creates its OWN store, so getDefaultStore()
// is a DIFFERENT object than the store useStore()/useAtomValue() resolve
// against. The old single-store fake collapsed the two and masked exactly
// that bug class; every seed and assertion here goes through contextStore,
// the store the pane's provider-tree readers actually see.
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

const stubT = (key: string, opts?: Record<string, unknown>) =>
  opts && typeof opts.session === 'string' ? `Joining: ${opts.session}` : key

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: stubT }),
}))

// motion.div → plain div (animation props dropped), reduced motion always on.
const motionTags = new Map<string, any>()
const motionProxy: any = new Proxy({}, {
  get: (_target, tag: string) => {
    if (!motionTags.has(tag)) motionTags.set(tag, (props: Record<string, unknown>) => {
      const { initial: _i, animate: _a, transition: _t, exit: _e, whileHover: _h, whileTap: _p, ...rest } = props
      return (createElement as any)(tag, { ...rest, 'data-motion-width': (_a as { width?: string } | undefined)?.width })
    })
    return motionTags.get(tag)
  },
})
mock.module('motion/react', () => ({
  motion: motionProxy,
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))

// NOTE: react-dom is intentionally NOT mocked — @testing-library/react reads
// act internals from it. createPortal renders the (inert) drag mask to body.

const toastInfo = mock((_msg: string, _opts?: unknown) => {})
mock.module('sonner', () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: toastInfo },
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

// r1: terminate flows in as the AppShell-resident hook's control (prop).
const terminateBrowser = mock((_instance: unknown) => Promise.resolve())

// --- electronAPI.browserPane capture -----------------------------------------

const apiCalls: Record<string, unknown[][]> = {
  create: [], navigate: [], embed: [], detachToPopup: [], unembed: [], focus: [],
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
      unembed: async (...args: unknown[]) => { apiCalls.unembed.push(args) },
      focus: async (...args: unknown[]) => { apiCalls.focus.push(args) },
      destroy: async (...args: unknown[]) => { apiCalls.destroy.push(args) },
      setElementPicking: async (...args: unknown[]) => { apiCalls.setElementPicking.push(args) },
      goBack: async (...args: unknown[]) => { apiCalls.goBack.push(args) },
      goForward: async (...args: unknown[]) => { apiCalls.goForward.push(args) },
      reload: async (...args: unknown[]) => { apiCalls.reload.push(args) },
      setEmbedBounds: async (...args: unknown[]) => { apiCalls.navigate.push(args) },
    },
  },
})

const { render, cleanup, fireEvent, waitFor, screen } = await import('@testing-library/react')
const { createElement } = await import('react')
const { RightSidebarPane } = await import('../RightSidebarPane')
const { useRightPanePresentation } = await import('@/hooks/use-right-pane-presentation')
const { shouldAutoHideNavigation } = await import('../right-pane-layout')
const {
  activeElementPickingAtom,
  rightPaneTabAtom,
  sidebarBrowserInstanceIdAtom,
  sidebarBrowserOpenAtom,
} = await import('@/atoms/sidebar-browser')
const { browserInstancesMapAtom } = await import('@/atoms/browser-pane')
const { getDefaultStore, useStore } = await import('jotai')

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
  // Direct component mounts represent an explicit open surface; the real
  // AppShell mounts an empty browser only after its open atom was set.
  if (!contextStore.values.has(sidebarBrowserOpenAtom)) contextStore.set(sidebarBrowserOpenAtom, true)
  const props = {
    layoutKey: 'sess-a',
    canvasSessionId: null as string | null,
    canvasApp: null,
    getLayoutRect: () => null,
    currentSessionId: 'sess-a' as string | null,
    activeWorkspaceId: null,
    remoteWorkspaceId: null,
    onSelectSession: () => {},
    onTerminate: terminateBrowser,
    ...overrides,
  }
  return render(createElement(RightSidebarPane, props as any))
}

function setInstances(instances: any[]) {
  contextStore.set(browserInstancesMapAtom, new Map(instances.map((i) => [i.id, i])))
  contextStore.set(sidebarBrowserOpenAtom, true)
  contextStore.set(sidebarBrowserInstanceIdAtom, instances[0]?.id ?? null)
}

afterEach(() => {
  cleanup()
  contextStore.values.clear()
  contextStore.values.clear()
  // The pane reads this everywhere; seed a default so it is never undefined.
  contextStore.values.set(sessionMetaMapAtomRef, new Map())
  for (const key of Object.keys(apiCalls)) apiCalls[key].length = 0
  terminateBrowser.mockClear()
  toastInfo.mockClear()
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
    expect(contextStore.get(rightPaneTabAtom)).toBe('browser')
    second.unmount()

    contextStore.set(rightPaneTabAtom, 'browser')
    const third = mountPane({ canvasSessionId: 'sess-a', canvasApp: { kind: 'preview' } as any })
    expect(third.getByTestId('sidebar-browser-section')).toBeTruthy()
    expect(third.queryByTestId('canvas-pane-card')).toBeNull()
    third.unmount()

    contextStore.set(rightPaneTabAtom, 'canvas')
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
    contextStore.values.set(sessionMetaMapAtomRef, new Map([['sess-a', { name: 'Alpha' }]]))
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
    expect(contextStore.get(activeElementPickingAtom)).toEqual({
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })

    // Re-render so the component re-reads the armed picking atom (the fake
    // store has no subscriptions), then the second click disarms.
    rerender(createElement(RightSidebarPane, {
      layoutKey: 'sess-a', canvasSessionId: null, canvasApp: null, getLayoutRect: () => null,
      currentSessionId: 'sess-a', activeWorkspaceId: null, remoteWorkspaceId: null,
      onSelectSession: () => {}, onTerminate: terminateBrowser,
    } as any))
    const pickActive = getByTestId('sidebar-browser-pick-element') as HTMLButtonElement
    expect(pickActive.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pickActive)
    await waitFor(() => expect(apiCalls.setElementPicking).toEqual([
      ['inst-1', true, { targetSessionId: 'sess-a' }],
      ['inst-1', false],
    ]))
    expect(contextStore.get(activeElementPickingAtom)).toBeNull()
  })

  it('embedded browser: detach pops it out and releases its sidebar slot', async () => {
    const instance = makeInstance({ hostMode: 'embedded' })
    setInstances([instance])
    const { getByTestId, queryByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-embedded-container')).toBeTruthy()
    fireEvent.click(getByTestId('sidebar-browser-detach'))
    await waitFor(() => expect(apiCalls.detachToPopup).toEqual([['inst-1']]))

    expect(contextStore.get(sidebarBrowserOpenAtom)).toBe(false)
  })

  it('popped-out browser leaves its instance alive without sidebar placeholder controls', () => {
    setInstances([makeInstance({ hostMode: 'popup', isVisible: true })])
    const { queryByTestId } = mountPane({ currentSessionId: 'sess-a' })
    expect(queryByTestId('sidebar-browser-popup-placeholder')).toBeNull()
    expect(queryByTestId('sidebar-browser-embed')).toBeNull()
    expect((contextStore.get(browserInstancesMapAtom) as Map<string, unknown>).has('inst-1')).toBe(true)
  })

  it('no browser at all: the empty state creates one WORKSPACE-visible (not session-bound), embedded (r1)', async () => {
    const { getByTestId, queryByTestId } = mountPane({ currentSessionId: 'sess-a' })

    expect(getByTestId('sidebar-browser-empty-state')).toBeTruthy()
    fireEvent.click(getByTestId('sidebar-browser-create'))

    // Spec v0.7 suggested behavior 5: no bindToSessionId — visible workspace-wide.
    await waitFor(() => expect(apiCalls.create).toEqual([[{ show: false }]]))
    await waitFor(() => expect(apiCalls.embed).toEqual([['inst-created']]))
    expect(contextStore.get(sidebarBrowserOpenAtom)).toBe(true)
    expect(contextStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-created')
  })

  it('multiple visible instances: the layer-1 switcher re-points the slot', async () => {
    setInstances([
      makeInstance({ id: 'inst-1', ownerSessionId: 'sess-a' }),
      makeInstance({ id: 'inst-2', ownerSessionId: null }),
    ])
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    const select = getByTestId('sidebar-browser-instance-select')
    expect(select.getAttribute('data-value')).toBe('inst-1')
    fireEvent.keyDown(select, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /inst-2/ }))
    expect(contextStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-2')
  })

  it('a popped-out instance leaves no sidebar placeholder or controls', () => {
    setInstances([makeInstance({ hostMode: 'popup', isVisible: true })])
    const { queryByTestId } = mountPane({ currentSessionId: 'sess-a' })
    expect(queryByTestId('sidebar-browser-nav-layer')).toBeNull()
    expect(queryByTestId('sidebar-browser-pick-element')).toBeNull()
    expect(queryByTestId('sidebar-browser-popup-placeholder')).toBeNull()
  })

  it('hide keeps the instance alive: unembed + slot closed + toast with a show action (r1)', async () => {
    setInstances([makeInstance()])
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    fireEvent.click(getByTestId('sidebar-browser-hide'))

    await waitFor(() => expect(apiCalls.unembed).toEqual([['inst-1']]))
    // Slot closes (back to canvas when one is open) but the object is preserved.
    expect(contextStore.get(sidebarBrowserOpenAtom)).toBe(false)
    expect(contextStore.get(rightPaneTabAtom)).toBe('canvas')
    expect(contextStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-1')
    expect(toastInfo).toHaveBeenCalledTimes(1)
    const [message, opts] = toastInfo.mock.calls[0]
    expect(message).toBe('browserPane.sidebar.hiddenToast')
    const action = (opts as any).action
    expect(action.label).toBe('browserPane.sidebar.show')

    // The toast action restores the slot on the browser tab.
    action.onClick()
    expect(contextStore.get(sidebarBrowserOpenAtom)).toBe(true)
    expect(contextStore.get(rightPaneTabAtom)).toBe('browser')
  })

  it('switching to the canvas tab disarms an armed picker (r1)', async () => {
    setInstances([makeInstance({ ownerSessionId: 'sess-a' })])
    contextStore.set(rightPaneTabAtom, 'browser')
    contextStore.set(activeElementPickingAtom, {
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })
    const { getByTestId } = mountPane({
      currentSessionId: 'sess-a',
      canvasSessionId: 'sess-a',
      canvasApp: { kind: 'preview' } as any,
    })

    fireEvent.click(getByTestId('right-pane-tab-canvas'))

    expect(contextStore.get(activeElementPickingAtom)).toBeNull()
    expect(apiCalls.setElementPicking).toEqual([['inst-1', false]])
  })

  it('switching instances via the switcher disarms an armed picker (r1)', async () => {
    setInstances([
      makeInstance({ id: 'inst-1', ownerSessionId: 'sess-a' }),
      makeInstance({ id: 'inst-2', ownerSessionId: null }),
    ])
    contextStore.set(activeElementPickingAtom, {
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })
    const { getByTestId } = mountPane({ currentSessionId: 'sess-a' })

    const select = getByTestId('sidebar-browser-instance-select')
    fireEvent.keyDown(select, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /inst-2/ }))

    expect(contextStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-2')
    expect(contextStore.get(activeElementPickingAtom)).toBeNull()
    expect(apiCalls.setElementPicking).toEqual([['inst-1', false]])
  })

  it('unmounting the embedded container unhooks the native view (unembed) (r1)', async () => {
    setInstances([makeInstance()])
    const { getByTestId, unmount } = mountPane({ currentSessionId: 'sess-a' })
    expect(getByTestId('sidebar-browser-embedded-container')).toBeTruthy()

    unmount()

    await waitFor(() => expect(apiCalls.unembed).toEqual([['inst-1']]))
  })

  it('topology guard (r3): the pane resolves the PROVIDER store, not getDefaultStore', () => {
    // The r1/r2 fake collapsed both stores into one and masked the production
    // getDefaultStore/Provider split; if they collapse again every cross-store
    // assertion above goes vacuous — fail here first.
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


// Shares the production AppShell geometry hook and the real pane. Native CSS
// measurements remain a separate acceptance; motion exposes its actual width
// prop so a happy-dom zero-rect cannot conceal an unintended resource region.
interface ScopeLayoutProps {
  owner: string
  file?: 'shown' | 'hidden' | 'closed'
  canvas?: boolean
  workspace?: string
  remote?: string | null
}
function ScopeLayout({ owner, file = 'closed', canvas = false, workspace = 'ws-a', remote = null }: ScopeLayoutProps) {
  const presentation = useRightPanePresentation({ currentSessionId: owner, activeWorkspaceId: workspace, remoteWorkspaceId: remote, fileVisible: file === 'shown', canvasVisible: canvas })
  const retainsFile = file !== 'closed'
  return createElement('div', {},
    createElement('output', { 'data-testid': 'shell-right-pane-open', 'data-navigation-collapsed': String(shouldAutoHideNavigation(920, 520, presentation.hasRightPane ? .45 : 0)) }, String(presentation.hasRightPane)),
    (retainsFile || canvas || presentation.browserSlotOpen) && createElement(RightSidebarPane, {
      layoutKey: owner, canvasSessionId: canvas ? owner : null,
      canvasApp: canvas ? { kind: 'preview' } : null,
      visible: presentation.hasRightPane,
      filePreview: retainsFile ? createElement('input', { 'data-testid': 'retained-file-input', defaultValue: 'C draft' }) : undefined,
      filePreviewVisible: file === 'shown',
      getLayoutRect: () => null, currentSessionId: owner, activeWorkspaceId: workspace, remoteWorkspaceId: remote,
      onSelectSession: () => {}, onTerminate: terminateBrowser,
    } as any),
  )
}

describe('scope-correct right pane geometry and real content', () => {
  it('A browser does not reserve C file-hide/close width, and returning A preserves the same resource', () => {
    const page = makeInstance({ ownerSessionId: 'a', workspaceId: 'ws-a', draft: 'A memory', count: 9 })
    setInstances([page])
    const view = render(createElement(ScopeLayout, { owner: 'a' }))
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'shown' }))
    const input = view.getByTestId('retained-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'C retained input' } })
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.getByTestId('shell-right-pane-open').getAttribute('data-navigation-collapsed')).toBe('false')
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
    expect(view.getByTestId('retained-file-input')).toBe(input)
    expect(input.value).toBe('C retained input')
    expect(input.closest('[data-motion-width]')?.getAttribute('data-motion-width')).toBe('0%')
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'shown' }))
    expect(view.getByTestId('retained-file-input')).toBe(input)
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'closed' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
    view.rerender(createElement(ScopeLayout, { owner: 'a' }))
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
    expect((contextStore.get(browserInstancesMapAtom) as Map<string, any>).get(page.id)).toBe(page)
    expect(page).toMatchObject({ draft: 'A memory', count: 9 })
    expect(apiCalls.create).toEqual([])
  })
  it('retains an explicitly open empty browser and its workspace-visible create action', async () => {
    setInstances([])
    const view = render(createElement(ScopeLayout, { owner: 'c' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('true')
    fireEvent.click(view.getByTestId('sidebar-browser-create'))
    await waitFor(() => expect(apiCalls.create).toEqual([[{ show: false }]]))
  })
  it('keeps a workspace manual browser without owner visible in another chat', () => {
    setInstances([makeInstance({ ownerSessionId: null, workspaceId: 'ws-a' })])
    const view = render(createElement(ScopeLayout, { owner: 'c' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('true')
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
  })
  it('rejects foreign-workspace selections in both shell width and content', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-other' })])
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
    expect(view.queryByTestId('sidebar-browser-section')).toBeNull()
  })
  it('accepts a remote mirror workspace when its selected owner matches', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-remote' })])
    const view = render(createElement(ScopeLayout, { owner: 'c', remote: 'ws-remote' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('true')
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
  })
  it('does not fall back from a removed selection to another live browser or an empty slot', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-a' })])
    contextStore.set(sidebarBrowserInstanceIdAtom, 'already-removed')
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
    expect(view.queryByTestId('sidebar-browser-section')).toBeNull()
  })
  it('does not reserve popup selection width or fall back to another embedded browser', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-a', hostMode: 'popup' }), makeInstance({ id: 'other', ownerSessionId: 'c', workspaceId: 'ws-a' })])
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
    expect(view.queryByTestId('sidebar-browser-section')).toBeNull()
  })
  it('preserves a same-owner hidden choice when a retained file is hidden', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-a' })])
    contextStore.set(sidebarBrowserOpenAtom, false)
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('false')
    expect(view.queryByTestId('sidebar-browser-section')).toBeNull()
    expect(apiCalls.embed).toEqual([])
  })
  it('file hide restores a legitimate same-owner browser rather than closing it', () => {
    setInstances([makeInstance({ ownerSessionId: 'c', workspaceId: 'ws-a' })])
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'shown' }))
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'hidden' }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('true')
    expect(view.getByTestId('sidebar-browser-section')).toBeTruthy()
  })
  it('file hide restores its current canvas even when a foreign browser intent remains', () => {
    setInstances([makeInstance({ ownerSessionId: 'a', workspaceId: 'ws-a' })])
    const view = render(createElement(ScopeLayout, { owner: 'c', file: 'shown', canvas: true }))
    view.rerender(createElement(ScopeLayout, { owner: 'c', file: 'hidden', canvas: true }))
    expect(view.getByTestId('shell-right-pane-open').textContent).toBe('true')
    expect(view.getByTestId('canvas-pane-card')).toBeTruthy()
    expect(view.queryByTestId('sidebar-browser-empty-state')).toBeNull()
  })
})
