/**
 * POO-135 useSidebarBrowserSync — the sidebar's single sync + reaction point.
 *
 * Real atoms (atoms/browser-pane.ts, atoms/sidebar-browser.ts) run on a fake
 * jotai store so the actual draft/ownership-filter/picking logic is exercised;
 * only the electron boundary, toasts and i18n are stubbed.
 *
 * Isolated happy-dom render (shared-process pattern, see TopBar.app-menu.isolated.ts).
 * Run per-file: `bun test ./apps/electron/src/renderer/hooks/__tests__/use-sidebar-browser-sync.interaction.isolated.ts`
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

// --- Fake jotai (primitive + writable atoms are enough for the real atoms) --

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
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastSuccess = mock((_msg: string, _opts?: unknown) => {})
const toastError = mock((_msg: string, _opts?: unknown) => {})
const toastWarning = mock((_msg: string, _opts?: unknown) => {})
const toastInfo = mock((_msg: string, _opts?: unknown) => {})
mock.module('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo },
}))

const focusQueued: Array<string | null | undefined> = []
mock.module('@/components/app-shell/input/focus-input-events', () => ({
  queuePendingFocusForSession: (sessionId?: string | null) => { focusQueued.push(sessionId) },
  dispatchFocusInputEvent: (_detail?: unknown) => {},
  consumePendingFocusForSession: (_sessionId?: string | null) => false,
  clearPendingFocusForSession: (_sessionId?: string | null) => {},
  __resetPendingFocusForTests: () => {},
}))

// --- electronAPI.browserPane capture ----------------------------------------

let stateHandler: ((info: any) => void) | null = null
let removedHandler: ((id: string) => void) | null = null
let pickerHandler: ((event: any) => void) | null = null
const apiCalls = {
  create: [] as Array<Record<string, unknown>>,
  navigate: [] as Array<[string, string]>,
  embed: [] as string[],
  destroy: [] as string[],
  setElementPicking: [] as Array<[string, boolean]>,
}
let listedInstances: any[] = []
let nextInstanceId = 'inst-new'

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    isChannelAvailable: (_channel: string) => true,
    browserPane: {
      list: async () => [...listedInstances],
      onStateChanged: (cb: (info: any) => void) => { stateHandler = cb; return () => { stateHandler = null } },
      onRemoved: (cb: (id: string) => void) => { removedHandler = cb; return () => { removedHandler = null } },
      onElementPickerEvent: (cb: (event: any) => void) => { pickerHandler = cb; return () => { pickerHandler = null } },
      create: async (opts: Record<string, unknown>) => { apiCalls.create.push(opts); return nextInstanceId },
      navigate: async (id: string, url: string) => { apiCalls.navigate.push([id, url]) },
      embed: async (id: string) => { apiCalls.embed.push(id) },
      destroy: async (id: string) => { apiCalls.destroy.push(id) },
      setElementPicking: async (id: string, armed: boolean) => { apiCalls.setElementPicking.push([id, armed]) },
    },
  },
})

const { render, cleanup } = await import('@testing-library/react')
const { createElement } = await import('react')
const { useSidebarBrowserSync } = await import('../use-sidebar-browser-sync')
const {
  activeElementPickingAtom,
  elementDraftRefsAtomFamily,
  filterSidebarBrowserInstances,
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
    hostMode: 'popup',
    isVisible: true,
    ownerSessionId: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeReference(sessionId: string, id = 'element-1'): any {
  return {
    id,
    browserInstanceId: 'inst-1',
    sessionId,
    tag: 'button',
    text: 'Buy now',
    locator: 'html>body>button',
    pageTitle: 'Example Shop',
    url: 'https://example.com/page',
  }
}

// Harness exposes the hook's controls and re-renders on prop changes.
let capturedControls: { terminateBrowser: (instance: any) => Promise<void> } | null = null
function Harness(props: { currentSessionId: string | null; onSelectSession: (id: string) => void }) {
  capturedControls = useSidebarBrowserSync({
    currentSessionId: props.currentSessionId,
    activeWorkspaceId: null,
    remoteWorkspaceId: null,
    onSelectSession: props.onSelectSession,
  })
  return null
}

function mount(currentSessionId: string | null, onSelectSession: (id: string) => void = () => {}) {
  return render(createElement(Harness, { currentSessionId, onSelectSession }))
}

function resetAll() {
  cleanup()
  storeValues.clear()
  stateHandler = null
  removedHandler = null
  pickerHandler = null
  focusQueued.length = 0
  listedInstances = []
  apiCalls.create.length = 0
  apiCalls.navigate.length = 0
  apiCalls.embed.length = 0
  apiCalls.destroy.length = 0
  apiCalls.setElementPicking.length = 0
  toastSuccess.mockClear()
  toastError.mockClear()
  toastWarning.mockClear()
  toastInfo.mockClear()
  capturedControls = null
}

afterEach(resetAll)

describe('useSidebarBrowserSync (POO-135)', () => {
  it('picked element for the CURRENT session lands in that session draft (no chat switch)', () => {
    const onSelectSession = mock((_id: string) => {})
    mount('sess-a', onSelectSession)

    pickerHandler!({ kind: 'picked', reference: makeReference('sess-a') })

    const draft = defaultStore.get(elementDraftRefsAtomFamily('sess-a')) as any[]
    expect(draft).toHaveLength(1)
    expect(draft[0].id).toBe('element-1')
    expect(defaultStore.get(activeElementPickingAtom)).toBeNull()
    expect(onSelectSession).not.toHaveBeenCalled()
    expect(focusQueued).toHaveLength(0)
  })

  it('picked element for ANOTHER session appends there, queues focus, and switches chats', () => {
    const onSelectSession = mock((_id: string) => {})
    mount('sess-a', onSelectSession)

    pickerHandler!({ kind: 'picked', reference: makeReference('sess-b') })

    expect((defaultStore.get(elementDraftRefsAtomFamily('sess-b')) as any[])).toHaveLength(1)
    expect((defaultStore.get(elementDraftRefsAtomFamily('sess-a')) as any[])).toHaveLength(0)
    expect(focusQueued).toEqual(['sess-b'])
    expect(onSelectSession).toHaveBeenCalledWith('sess-b')
  })

  it('switching chats while picking cancels the armed picker with an explicit toast', () => {
    defaultStore.set(activeElementPickingAtom, {
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })
    const { rerender } = mount('sess-a')

    // User switches to sess-b while the picker is armed for sess-a.
    rerender(createElement(Harness, { currentSessionId: 'sess-b', onSelectSession: () => {} }))

    expect(defaultStore.get(activeElementPickingAtom)).toBeNull()
    expect(apiCalls.setElementPicking).toEqual([['inst-1', false]])
    expect(toastInfo).toHaveBeenCalledWith('browserPane.elementPicker.cancelledSwitchChat')
  })

  it('switching within the same origin session does NOT cancel picking', () => {
    defaultStore.set(activeElementPickingAtom, {
      instanceId: 'inst-1',
      targetSessionId: 'sess-a',
      originSessionId: 'sess-a',
    })
    const { rerender } = mount('sess-a')
    rerender(createElement(Harness, { currentSessionId: 'sess-a', onSelectSession: () => {} }))

    expect(defaultStore.get(activeElementPickingAtom)).not.toBeNull()
    expect(apiCalls.setElementPicking).toHaveLength(0)
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('system-close of the detached popup returns the browser to the sidebar (embed)', () => {
    listedInstances = [makeInstance({ id: 'inst-1' })]
    mount('sess-a')
    defaultStore.set(sidebarBrowserOpenAtom, true)
    defaultStore.set(sidebarBrowserInstanceIdAtom, 'inst-1')

    // Main reports the popup window disappeared (system close button).
    stateHandler!(makeInstance({ id: 'inst-1', hostMode: 'popup', isVisible: false }))

    expect(apiCalls.embed).toEqual(['inst-1'])
  })

  it('unavailable picks toast the whitelisted reason (cross-origin iframe vs generic)', () => {
    mount('sess-a')

    pickerHandler!({ kind: 'unavailable', reason: 'iframe' })
    pickerHandler!({ kind: 'unavailable', reason: 'hidden' })

    expect(toastWarning).toHaveBeenCalledTimes(2)
    expect(toastWarning).toHaveBeenNthCalledWith(1, 'browserPane.elementPicker.unavailableFrame')
    expect(toastWarning).toHaveBeenNthCalledWith(2, 'browserPane.elementPicker.unavailableGeneric')
  })

  it('navigation cancellations toast; silent cancellations (Esc/host) do not', () => {
    mount('sess-a')

    pickerHandler!({ kind: 'cancelled', reason: 'navigation' })
    pickerHandler!({ kind: 'cancelled', reason: 'host' })
    pickerHandler!({ kind: 'cancelled', reason: 'navigation' })

    expect(toastInfo).toHaveBeenCalledTimes(2)
    expect(toastInfo).toHaveBeenCalledWith('browserPane.elementPicker.cancelledNavigation')
  })

  it('terminating the LAST visible browser closes the slot and toasts with a reopen action', async () => {
    listedInstances = [makeInstance({ id: 'inst-1' })]
    mount('sess-a')
    defaultStore.set(browserInstancesMapAtom, new Map([['inst-1', makeInstance({ id: 'inst-1' })]]))
    defaultStore.set(sidebarBrowserOpenAtom, true)
    defaultStore.set(sidebarBrowserInstanceIdAtom, 'inst-1')

    await capturedControls!.terminateBrowser(makeInstance({ id: 'inst-1' }))

    expect(apiCalls.destroy).toEqual(['inst-1'])
    expect(defaultStore.get(sidebarBrowserOpenAtom)).toBe(false)
    expect(defaultStore.get(rightPaneTabAtom)).toBe('canvas')
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0][0]).toBe('browserPane.ended')
    const action = (toastSuccess.mock.calls[0][1] as any).action
    expect(action.label).toBe('browserPane.reopen')

    // Clicking「重新打开」recreates a NEW instance at the same address, embedded.
    // onClick fires reopenBrowser without awaiting — flush its async chain.
    await action.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(apiCalls.create).toEqual([{ show: false, bindToSessionId: undefined }])
    expect(apiCalls.navigate).toEqual([['inst-new', 'https://example.com/page']])
    expect(apiCalls.embed).toEqual(['inst-new'])
    expect(defaultStore.get(sidebarBrowserOpenAtom)).toBe(true)
    expect(defaultStore.get(sidebarBrowserInstanceIdAtom)).toBe('inst-new')
    expect(defaultStore.get(rightPaneTabAtom)).toBe('browser')
  })

  it('reopen re-binds the ORIGINAL owning session even from a different chat', async () => {
    const onSelectSession = mock((_id: string) => {})
    listedInstances = [makeInstance({ id: 'inst-1', ownerSessionId: 'sess-owned' })]
    mount('sess-a', onSelectSession)
    defaultStore.set(browserInstancesMapAtom, new Map([['inst-1', listedInstances[0]]]))

    await capturedControls!.terminateBrowser(listedInstances[0])
    const action = (toastSuccess.mock.calls[0][1] as any).action
    await action.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Ownership isolation: the new instance is created for its owner, and the
    // app switches to that owner chat first (drafts stay in their session).
    expect(onSelectSession).toHaveBeenCalledWith('sess-owned')
    expect(apiCalls.create).toEqual([{ show: false, bindToSessionId: 'sess-owned' }])
  })

  it('terminating one of SEVERAL visible browsers is silent (no ended toast, slot stays)', async () => {
    const a = makeInstance({ id: 'inst-a' })
    const b = makeInstance({ id: 'inst-b' })
    listedInstances = [a, b]
    mount('sess-a')
    defaultStore.set(browserInstancesMapAtom, new Map([['inst-a', a], ['inst-b', b]]))
    defaultStore.set(sidebarBrowserOpenAtom, true)
    defaultStore.set(sidebarBrowserInstanceIdAtom, 'inst-a')

    await capturedControls!.terminateBrowser(a)

    expect(apiCalls.destroy).toEqual(['inst-a'])
    expect(defaultStore.get(sidebarBrowserOpenAtom)).toBe(true)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('ownership filter: a session-owned browser is only visible from its own session', () => {
    const owned = makeInstance({ id: 'inst-owned', ownerSessionId: 'sess-a' })
    const free = makeInstance({ id: 'inst-free' })

    // From the owning session: both visible.
    expect(filterSidebarBrowserInstances([owned, free], 'sess-a', null, null).map((i) => i.id))
      .toEqual(['inst-owned', 'inst-free'])
    // From another session: the owned pane is isolated away.
    expect(filterSidebarBrowserInstances([owned, free], 'sess-b', null, null).map((i) => i.id))
      .toEqual(['inst-free'])
    // Workspace filter: out-of-workspace panes are hidden.
    expect(
      filterSidebarBrowserInstances(
        [free, makeInstance({ id: 'inst-other-ws', workspaceId: 'ws-other' })],
        null,
        'ws-here',
        null,
      ).map((i) => i.id),
    ).toEqual(['inst-free'])
  })
})
