/**
 * POO-135 sidebar/popup state machine tests for BrowserPaneManager.
 *
 * Mocks the electron boundary (same discipline as browser-pane-manager.test.ts)
 * and covers the embed ⇄ detach host transitions, embed bounds clamping, the
 * element-picker arm/disarm lifecycle, signal sanitization (untrusted page
 * payloads), and the cancel transitions (navigation / host hide / destroy).
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

const createdWindows: any[] = []
const mockIpcMainHandle = mock(() => {})

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
    }),
    loadFile: mock(async (_path: string, _opts?: unknown) => {}),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    capturePage: mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => ({}),
      toPNG: () => Buffer.from('fake-png'),
      toJPEG: () => Buffer.from('fake-jpeg'),
    })),
    // The element-picker scripts are self-contained IIFEs referencing DOM
    // globals; only short expressions are safe to actually eval here.
    executeJavaScript: mock(async (expr: string) => {
      if (typeof expr === 'string' && expr.length > 400) return undefined
      return eval(expr)
    }),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb({}, ...args)
    },
  }
}

function createMockBrowserView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setAutoResize: mock((_opts: any) => {}),
  }
}

function createMockWindow() {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  const win: any = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of [...(listeners[event] || [])]) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    isVisible: mock(() => true),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setTitle: mock((_title: string) => {}),
    getTitle: mock(() => 'Test'),
    setBrowserView: mock((_view: any) => {}),
    addBrowserView: mock((_view: any) => {}),
    removeBrowserView: mock((_view: any) => {}),
    setTopBrowserView: mock((_view: any) => {}),
    getContentSize: mock(() => [1200, 900]),
    setContentSize: mock((_w: number, _h: number) => {}),
    loadURL: mock(async (_url: string) => {}),
  }
  return win
}

mock.module('electron', () => ({
  dialog: { showMessageBox: mock(async () => ({ response: 0 })) },
  app: {
    getPath: mock((name: string) => `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    constructor(opts?: any) {
      const win = createMockWindow()
      Object.assign(this, win)
      // Register the instance itself (not the inner template object) so tests
      // can locate a manager-owned window via identity comparison.
      createdWindows.push(this)
    }
  },
  BrowserView: class MockBrowserView {
    constructor(_opts?: any) {
      const view = createMockBrowserView()
      Object.assign(this, view)
    }
  },
  ipcMain: { handle: mockIpcMainHandle },
  Menu: { buildFromTemplate: mock(() => ({ popup: mock(() => {}) })) },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: mock(async () => {}) },
  webContents: { fromId: mock(() => undefined) },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock(() => {}),
        onCompleted: mock(() => {}),
        onErrorOccurred: mock(() => {}),
      },
      on: mock(() => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({ url: '', title: '', nodes: [] }))
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
  },
}))

const stubI18nT = (_key: string, opts?: Record<string, unknown>) =>
  `Joining: ${opts && typeof opts.session === 'string' ? opts.session : '?'}`

mock.module('@polo-ai/shared/i18n', () => ({
  i18n: { t: stubI18nT },
  setupI18n: () => ({ t: stubI18nT }),
}))

const { BrowserPaneManager } = await import('../browser-pane-manager')

describe('BrowserPaneManager sidebar/popup state machine (POO-135)', () => {
  let manager: InstanceType<typeof BrowserPaneManager>
  let hostWindow: any

  beforeEach(() => {
    createdWindows.length = 0
    manager = new BrowserPaneManager()
    hostWindow = createMockWindow()
  })

  it('embed moves the page view to the host window, hides the popup, and reports hostMode=embedded', () => {
    const id = manager.createInstance('browser-1', { show: false })
    const ownWindow = createdWindows[0]
    expect(ownWindow).toBeTruthy()

    manager.embedInstance(id, hostWindow as any)

    expect(hostWindow.addBrowserView).toHaveBeenCalled()
    expect(ownWindow.hide).toHaveBeenCalled()
    const info = manager.listInstances().find((i) => i.id === id)!
    expect(info.hostMode).toBe('embedded')
    expect(info.isVisible).toBe(false)
  })

  it('embed is idempotent on the same host and just updates bounds', () => {
    const id = manager.createInstance('browser-2', { show: false })
    manager.embedInstance(id, hostWindow as any)
    hostWindow.addBrowserView.mockClear()

    manager.embedInstance(id, hostWindow as any, { x: -5, y: 0, width: 0, height: 300 })

    expect(hostWindow.addBrowserView).not.toHaveBeenCalled()
    // Clamp: negative x → 0, zero width → 1.
    const view = (manager as any).instances.get(id).pageView
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 300 })
  })

  it('setEmbedBounds is ignored while the instance is a popup', () => {
    const id = manager.createInstance('browser-3', { show: false })
    const view = (manager as any).instances.get(id).pageView
    view.setBounds.mockClear()
    manager.setEmbedBounds(id, { x: 1, y: 2, width: 30, height: 40 })
    expect(view.setBounds).not.toHaveBeenCalled()
  })

  it('unembed detaches the view while staying embedded; the next valid bounds re-attach it (r1)', () => {
    const id = manager.createInstance('browser-3b', { show: false })
    manager.embedInstance(id, hostWindow as any)
    const instance = (manager as any).instances.get(id)
    const view = instance.pageView
    hostWindow.removeBrowserView.mockClear()

    // Container unmounted → view must leave the host window…
    manager.unembedInstance(id)
    expect(hostWindow.removeBrowserView).toHaveBeenCalledWith(view)
    expect(instance.hostMode).toBe('embedded')
    expect(instance.embeddedViewsAttached).toBe(false)

    // …and a valid bounds report (container remounted) re-attaches it.
    hostWindow.addBrowserView.mockClear()
    manager.setEmbedBounds(id, { x: 10, y: 10, width: 300, height: 200 })
    expect(hostWindow.addBrowserView).toHaveBeenCalledWith(view)
    expect(instance.embeddedViewsAttached).toBe(true)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 10, width: 300, height: 200 })
  })

  it('a zero-sized bounds report unhooks the view instead of covering the window (r1)', () => {
    const id = manager.createInstance('browser-3c', { show: false })
    manager.embedInstance(id, hostWindow as any)
    const instance = (manager as any).instances.get(id)
    hostWindow.removeBrowserView.mockClear()

    manager.setEmbedBounds(id, { x: 0, y: 0, width: 0, height: 0 })

    expect(hostWindow.removeBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(instance.embeddedViewsAttached).toBe(false)
  })

  it('unembed is a no-op for popup instances and already-detached embedded ones (r1)', () => {
    const id = manager.createInstance('browser-3d', { show: false })
    // Still a popup — nothing to remove.
    manager.unembedInstance(id)
    expect(hostWindow.removeBrowserView).not.toHaveBeenCalled()

    manager.embedInstance(id, hostWindow as any)
    manager.unembedInstance(id)
    hostWindow.removeBrowserView.mockClear()
    // Already detached — idempotent.
    manager.unembedInstance(id)
    expect(hostWindow.removeBrowserView).not.toHaveBeenCalled()
  })

  it('detachToPopup returns the page view to the own window, applies the ownership title, and shows it', () => {
    manager.setSessionNameResolver((sessionId) => (sessionId === 'sess-alpha' ? 'Alpha' : null))
    const id = manager.createForSession('sess-alpha', { show: false })
    manager.embedInstance(id, hostWindow as any)
    const ownWindow = createdWindows[0]
    ownWindow.addBrowserView.mockClear()
    ownWindow.setTitle.mockClear()

    manager.detachToPopup(id)

    const info = manager.listInstances().find((i) => i.id === id)!
    expect(info.hostMode).toBe('popup')
    // Three views return to the popup window: page, native overlay, toolbar.
    expect(ownWindow.addBrowserView).toHaveBeenCalledTimes(3)
    expect(ownWindow.show).toHaveBeenCalled()
    expect(ownWindow.setTitle).toHaveBeenCalledWith('Joining: Alpha')
  })

  it('detachToPopup on a popup instance just focuses it', () => {
    const id = manager.createInstance('browser-4', { show: true })
    const ownWindow = createdWindows[0]
    ownWindow.addBrowserView.mockClear()
    // Bypass the toolbar-ready gate (the mock toolbar never fires finish-load).
    ;(manager as any).instances.get(id).toolbarReady = true

    manager.detachToPopup(id)

    expect(ownWindow.addBrowserView).not.toHaveBeenCalled()
    expect(ownWindow.focus).toHaveBeenCalled()
  })

  it('arming without any target session is rejected (defense in depth)', async () => {
    const id = manager.createInstance('browser-4b', { show: false })
    // No ownerSessionId and no targetSessionId option.
    await expect(manager.setElementPicking(id, true)).rejects.toThrow(/target session/)
    const instance = (manager as any).instances.get(id)
    expect(instance.elementPicking).toBe(false)
  })

  it('arming the element picker injects the picker script and disarming tears it down', async () => {
    const id = manager.createInstance('browser-5', { show: false })
    const instance = (manager as any).instances.get(id)
    const wc = instance.pageView.webContents
    wc.executeJavaScript.mockClear()

    await manager.setElementPicking(id, true, { targetSessionId: 'sess-target' })
    const injected = wc.executeJavaScript.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(injected.some((expr: string) => expr.includes('__poloElementPicker'))).toBe(true)
    expect(instance.elementPicking).toBe(true)
    expect(instance.elementPickingTargetSessionId).toBe('sess-target')

    await manager.setElementPicking(id, false)
    expect(instance.elementPicking).toBe(false)
    expect(instance.elementPickingTargetSessionId).toBe(null)
    const torn = wc.executeJavaScript.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(torn.some((expr: string) => expr.includes('teardown'))).toBe(true)
  })

  it('a picked signal is sanitized to the whitelist snapshot and stamped with the target session', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-6', { show: false })
    const instance = (manager as any).instances.get(id)
    instance.pageView.getURL = mock(() => 'https://example.com/page')
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-target' })

    const pageWc = instance.pageView.webContents
    pageWc._emit('console-message', 2, '__polo-element-pick:' + JSON.stringify({
      kind: 'picked',
      reference: {
        tag: 'button',
        text: 'Buy now',
        aria: 'Purchase button',
        locator: 'css=.buy',
        pageTitle: 'Example Shop',
        url: 'https://example.com/page',
        // Page-supplied noise that must never survive sanitization:
        password: 'hunter2',
        innerHTML: '<script>alert(1)</script>',
        scriptText: 'steal()',
      },
    }))

    const picked = events.find((e) => e.kind === 'picked')
    expect(picked).toBeTruthy()
    expect(picked.instanceId).toBe(id)
    expect(picked.reference.sessionId).toBe('sess-target')
    expect(picked.reference.browserInstanceId).toBe(id)
    expect(picked.reference.tag).toBe('button')
    expect(picked.reference.text).toBe('Buy now')
    const json = JSON.stringify(picked.reference)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('alert')
    expect(json).not.toContain('steal')
    expect(instance.elementPicking).toBe(false)
  })

  it('a duplicate picked signal after the first does not re-emit and tears the page picker down (r1)', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-6b', { show: false })
    const instance = (manager as any).instances.get(id)
    instance.pageView.getURL = mock(() => 'https://example.com/page')
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-t' })

    const pageWc = instance.pageView.webContents
    const signal = '__polo-element-pick:' + JSON.stringify({
      kind: 'picked',
      reference: { tag: 'a', text: 'Link', locator: 'css=.l', pageTitle: 'P', url: 'https://example.com/page' },
    })
    pageWc._emit('console-message', 2, signal)
    pageWc.executeJavaScript.mockClear()
    // Late duplicate (page listener residue, racing signals) — must be a no-op
    // for events, and the page picker must still be torn down.
    pageWc._emit('console-message', 2, signal)
    pageWc._emit('console-message', 2, signal)

    expect(events.filter((e) => e.kind === 'picked')).toHaveLength(1)
    const tornDown = pageWc.executeJavaScript.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(tornDown.some((expr: string) => expr.includes('teardown'))).toBe(true)
  })

  it('a cancel signal tears the page picker down and emits cancelled once (r1)', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-6c', { show: false })
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-t' })
    const pageWc = (manager as any).instances.get(id).pageView.webContents
    pageWc.executeJavaScript.mockClear()

    const escSignal = '__polo-element-pick:' + JSON.stringify({ kind: 'cancel' })
    pageWc._emit('console-message', 2, escSignal)
    pageWc._emit('console-message', 2, escSignal)

    expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(1)
    const tornDown = pageWc.executeJavaScript.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(tornDown.some((expr: string) => expr.includes('teardown'))).toBe(true)
  })

  it('a picked payload with a non-http(s) URL is dropped (no event)', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-7', { show: false })
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-x' })
    const pageWc = (manager as any).instances.get(id).pageView.webContents
    pageWc._emit('console-message', 2, '__polo-element-pick:' + JSON.stringify({
      kind: 'picked',
      reference: { tag: 'div', url: 'javascript:alert(1)', locator: 'css=.x', pageTitle: '', text: '' },
    }))

    expect(events.find((e) => e.kind === 'picked')).toBeUndefined()
  })

  it('navigation cancels an armed picker with reason=navigation', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-8', { show: false })
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-nav' })

    const instance = (manager as any).instances.get(id)
    instance.pageView.webContents._emit('did-navigate', 'https://example.com/next')

    const cancelled = events.find((e) => e.kind === 'cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled.reason).toBe('navigation')
    expect(instance.elementPicking).toBe(false)
  })

  it('hiding the popup (manager.hide — the system-close interception path) cancels picking with reason=host', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-9', { show: false })
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-hide' })

    // The close→hide keep-alive interception routes through manager.hide.
    manager.hide(id)

    const cancelled = events.find((e) => e.kind === 'cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled.reason).toBe('host')
  })

  it('destroying an armed instance cancels with reason=destroyed and detaches from the embed host', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-10', { show: false })
    manager.embedInstance(id, hostWindow as any)
    hostWindow.removeBrowserView.mockClear()

    await manager.setElementPicking(id, true, { targetSessionId: 'sess-d' })
    manager.destroyInstance(id)

    const cancelled = events.find((e) => e.kind === 'cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled.reason).toBe('destroyed')
    expect(hostWindow.removeBrowserView).toHaveBeenCalled()
  })

  it('an unavailable signal forwards the whitelisted reason', async () => {
    const events: any[] = []
    manager.onElementPickerEvent((e) => events.push(e))

    const id = manager.createInstance('browser-11', { show: false })
    await manager.setElementPicking(id, true, { targetSessionId: 'sess-u' })
    const pageWc = (manager as any).instances.get(id).pageView.webContents
    pageWc._emit('console-message', 2, '__polo-element-pick:' + JSON.stringify({ kind: 'unavailable', reason: 'iframe' }))
    pageWc._emit('console-message', 2, '__polo-element-pick:' + JSON.stringify({ kind: 'unavailable', reason: 'random-garbage' }))

    const unavailables = events.filter((e) => e.kind === 'unavailable')
    expect(unavailables.map((e) => e.reason)).toEqual(['iframe', 'hidden'])
  })
})


describe('POO-157 sidebar-first presentation requests', () => {
  it('focus requests the main sidebar instead of showing a popup, including deferred create(show:true)', async () => {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    manager.setWindowManager({ getFocusedWindow: () => host, getWorkspaceForWindow: () => 'ws-a', getWindowByWorkspace: () => host } as any)
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    const id = manager.createInstance('sidebar-first', { show: true, workspaceId: 'ws-a' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const popup = createdWindows.at(-1)
    expect(requests.some((r) => r.info.id === id && r.target === host && r.reason === 'focus')).toBe(true)
    expect(popup.show).not.toHaveBeenCalled()
    manager.focus(id)
    expect(requests.at(-1).reason).toBe('focus')
    expect(popup.show).not.toHaveBeenCalled()
    manager.destroyInstance(id)
  })

  it('explicit detach opens the popup; hiding keeps it there without sidebar return', async () => {
    const manager = new BrowserPaneManager()
    const original = createMockWindow()
    const other = createMockWindow()
    manager.setWindowManager({ getFocusedWindow: () => other, getWorkspaceForWindow: () => 'ws-b', getWindowByWorkspace: () => other } as any)
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    const id = manager.createInstance('return-host', { workspaceId: 'ws-a' })
    manager.embedInstance(id, original as any)
    manager.detachToPopup(id)
    const popup = createdWindows.at(-1)
    expect(popup.show).toHaveBeenCalledTimes(1)
    manager.hide(id)
    await Promise.resolve()
    expect(requests).toEqual([])
    expect(manager.getInstance(id)?.hostMode).toBe('popup')
    expect(manager.getInstance(id)).toBeDefined()
    manager.destroyInstance(id)
  })

  it('focus of an embedded browser never opens its empty backing window', async () => {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    const id = manager.createInstance('already-embedded')
    manager.embedInstance(id, host as any)
    manager.focus(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests.at(-1).target).toBe(host)
    expect(createdWindows.at(-1).show).not.toHaveBeenCalled()
    manager.destroyInstance(id)
  })
})


describe('POO-157 remote browser presentation', () => {
  it('uses the capability sender as host and exposes the actual session id to the sidebar', async () => {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    const id = await (manager as any).dispatchCapability({ v: 1, method: 'focusBoundForSession', workspaceId: 'remote-ws', sessionId: 'chat-a', args: ['chat-a'] }, host)
    expect(requests.at(-1)?.target).toBe(host)
    expect(requests.at(-1)?.info.ownerSessionId).toBe('chat-a')
    expect(manager.listInstances().find((i) => i.id === id)?.ownerSessionId).toBe('chat-a')
    expect((manager.getInstance(id) as any).ownerSessionId).toBe('remote:remote-ws:chat-a')
    expect(createdWindows.at(-1).show).not.toHaveBeenCalled()
    manager.destroyInstance(id)
  })
})


describe('POO-157 explicit popup while toolbar loads', () => {
  it('keeps an explicit popup request separate from ordinary sidebar focus', async () => {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    manager.setWindowManager({ getFocusedWindow: () => host, getWorkspaceForWindow: () => 'ws-a' } as any)
    const requests: any[] = []
    manager.onOpenRequested((...args) => { requests.push(args) })
    const id = manager.createInstance('deferred-popup', { workspaceId: 'ws-a' })
    manager.detachToPopup(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(createdWindows.at(-1).show).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(0)
    manager.destroyInstance(id)
  })
})

// Real-checklist regressions: these reproduce the renderer/native boundary failures.
describe('POO159 real E2E failures', () => {
  it('sparse ordinary AX is diagnostic only; a real challenge still requests human handling', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('sparse-page')
    const inst = (manager as any).instances.get(id)
    inst.cdp.getAccessibilitySnapshot = async () => ({ nodes: [{ role: 'RootWebArea' }, { role: 'button' }, { role: 'textbox' }] })
    inst.pageView.webContents.executeJavaScript = async () => []
    expect(await manager.detectSecurityChallenge(id)).toMatchObject({ detected: false, provider: 'none' })
    inst.title = 'Just a moment...'
    expect(await manager.detectSecurityChallenge(id)).toMatchObject({ detected: true, provider: 'cloudflare' })
    manager.destroyAll()
  })
  it('account transition revokes a visible manual popup as well as session-owned pages', async () => {
    const { beginAccountTransition, settleAccountTransition } = await import('@polo-ai/server-core/handlers/rpc/trusted-product-space-account')
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('logout-manual')
    const inst = (manager as any).instances.get(id)
    manager.detachToPopup(id)
    const epoch = beginAccountTransition()
    try {
      expect(manager.listInstances()).toHaveLength(0)
      expect(inst.window.destroy).toHaveBeenCalled()
    } finally { settleAccountTransition(epoch, 'abort'); manager.destroyAll() }
  })
  it('popup return IPC is present, verifies toolbar sender, and targets the original sidebar host', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('return-owner')
    const host = createMockWindow()
    const inst = (manager as any).instances.get(id)
    inst.toolbarView.webContents.id = 7001
    const opened = mock(() => {})
    manager.onOpenRequested(opened)
    manager.embedInstance(id, host)
    manager.detachToPopup(id)
    manager.registerToolbarIpc()
    const handler = (mockIpcMainHandle.mock.calls as unknown as [string, Function][]).find(c => c[0] === 'browser-toolbar:return-to-sidebar')?.[1] as any
    expect(handler).toBeTypeOf('function')
    await expect(handler({ sender: { id: 7002 } }, id)).rejects.toThrow()
    expect(opened).not.toHaveBeenCalled()
    await handler({ sender: { id: 7001 } }, id)
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id }), host, 'return')
    manager.destroyAll()
  })
  it('host migration snapshots scroll before native resize and restores the same page afterwards', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('scroll-transfer')
    const host = createMockWindow()
    const inst = (manager as any).instances.get(id)
    manager.embedInstance(id, host)
    let y = 900
    const seen: string[] = []
    inst.pageView.webContents.executeJavaScript = mock(async (script: string) => {
      seen.push(script)
      if (script.includes('scrollX') && script.includes('scrollY')) return { x: 0, y }
      if (script.includes('scrollTo')) y = 900
    })
    inst.pageView.setBounds = mock(() => { y = 875 })
    manager.detachToPopup(id)
    await new Promise(r => setTimeout(r, 30))
    expect(seen.some(script => script.includes('scrollY'))).toBe(true)
    expect(y).toBe(900)
    expect((manager as any).instances.get(id).pageView).toBe(inst.pageView)
    manager.destroyAll()
  })
})

describe('POO159 scroll transfer cancellation', () => {
  it('a snapshot rejection after instance destruction never touches its native view', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('destroy-during-transfer')
    const inst = (manager as any).instances.get(id)
    manager.embedInstance(id, createMockWindow())
    let reject!: (error: Error) => void
    inst.pageView.webContents.executeJavaScript = mock(() => new Promise((_resolve, failure) => { reject = failure }))
    manager.detachToPopup(id)
    inst.pageView.setBounds.mockClear()
    manager.destroyInstance(id)
    reject(new Error('WebContents destroyed'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(inst.pageView.setBounds).not.toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(0)
    manager.destroyAll()
  })
})

describe('POO159 ended browser scope resources', () => {
  it('explicit destruction closes an embedded page after it has been detached from every window', () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('detached-page-destroy')
    const instance = (manager as any).instances.get(id)
    const closePage = mock(() => {})
    instance.pageView.webContents.close = closePage
    manager.embedInstance(id, createMockWindow())
    manager.destroyInstance(id)
    expect(closePage).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(manager.listInstances()).toHaveLength(0)
    manager.destroyAll()
  })
})

describe('POO159 animated scroll transfer', () => {
  it('retains the original pixel position through successive nonzero sidebar animation bounds', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('animated-scroll-transfer')
    const host = createMockWindow()
    const instance = (manager as any).instances.get(id)
    manager.embedInstance(id, host)
    let y = 900
    instance.pageView.webContents.executeJavaScript = mock(async (script: string) => {
      if (script.includes('scrollX') && script.includes('scrollY')) return { x: 0, y }
      if (script.includes('scrollTo')) y = 900
    })
    instance.pageView.setBounds = mock(() => { y = 875 })
    manager.detachToPopup(id)
    await new Promise(resolve => setTimeout(resolve, 140))
    manager.embedInstance(id, host, { x: 400, y: 0, width: 500, height: 600 })
    await new Promise(resolve => setTimeout(resolve, 20))
    manager.setEmbedBounds(id, { x: 450, y: 0, width: 450, height: 600 })
    await new Promise(resolve => setTimeout(resolve, 20))
    manager.setEmbedBounds(id, { x: 500, y: 0, width: 400, height: 600 })
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(y).toBe(900)
    expect((manager as any).instances.get(id).scrollTransfer).toBeNull()
    manager.destroyAll()
  })
})

describe('POO159 scroll lease deadlines', () => {
  it('expires a zero-sized embed even if no later visible bounds arrive', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('zero-sized-scroll-lease')
    const host = createMockWindow()
    const instance = (manager as any).instances.get(id)
    manager.embedInstance(id, host)
    instance.pageView.webContents.executeJavaScript = mock(async (script: string) => script.includes('scrollX') ? { x: 0, y: 900 } : undefined)
    manager.detachToPopup(id)
    await new Promise(resolve => setTimeout(resolve, 140))
    manager.embedInstance(id, host)
    try {
      await new Promise(resolve => setTimeout(resolve, 1600))
      expect(instance.scrollTransfer).toBeNull()
      expect(instance.pageView.webContents.executeJavaScript.mock.calls.some(([script]: [string]) => script.includes('cleanup'))).toBe(true)
    } finally { manager.destroyAll() }
  })
  it('expires before the initial snapshot resolves and removes only that late token hooks', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('pending-scroll-lease')
    const instance = (manager as any).instances.get(id)
    manager.embedInstance(id, createMockWindow())
    let resolveSnapshot!: (position: { x: number; y: number }) => void
    const snapshot = new Promise(resolve => { resolveSnapshot = resolve })
    const cleanupScripts: string[] = []
    instance.pageView.webContents.executeJavaScript = mock((script: string) => {
      if (script.includes('scrollX') && script.includes('scrollY')) return snapshot
      cleanupScripts.push(script)
      return Promise.resolve()
    })
    manager.detachToPopup(id)
    const token = instance.scrollTransfer.token
    try {
      await new Promise(resolve => setTimeout(resolve, 1600))
      expect(instance.scrollTransfer).toBeNull()
      cleanupScripts.length = 0
      resolveSnapshot({ x: 0, y: 900 })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(cleanupScripts.some(script => script.includes(token) && script.includes('cleanup'))).toBe(true)
      expect(instance.scrollTransfer).toBeNull()
    } finally { resolveSnapshot({ x: 0, y: 900 }); manager.destroyAll() }
  })
})

describe('POO159 pending snapshot geometry', () => {
  it('applies the destination bounds when the capture deadline ends an unresponsive snapshot', async () => {
    const manager = new BrowserPaneManager()
    const id = manager.createInstance('pending-scroll-geometry')
    const instance = (manager as any).instances.get(id)
    manager.embedInstance(id, createMockWindow())
    instance.pageView.setBounds.mockClear()
    let resolveSnapshot!: (position: { x: number; y: number }) => void
    instance.pageView.webContents.executeJavaScript = mock((script: string) => script.includes('scrollX') ? new Promise(resolve => { resolveSnapshot = resolve }) : Promise.resolve())
    manager.detachToPopup(id)
    try {
      await new Promise(resolve => setTimeout(resolve, 1600))
      expect(instance.pageView.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
      expect(instance.scrollTransfer).toBeNull()
    } finally { resolveSnapshot({ x: 0, y: 900 }); manager.destroyAll() }
  })
})

describe('POO159 fresh AI browser automatic presentation', () => {
  function setupAutomatic() {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    manager.setWindowManager({ getFocusedWindow: () => host, getWorkspaceForWindow: () => 'ws-a', getWindowByWorkspace: () => host } as any)
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    return { manager, host, requests }
  }
  it('a fresh local AI open requests current-session presentation after binding without focusing an OS window', async () => {
    const { manager, host, requests } = setupAutomatic()
    const id = await manager.createForSessionAsync('session-b', { show: false, presentIfActive: true, workspaceId: 'ws-a' } as any)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ info: { id, ownerType: 'session', ownerSessionId: 'session-b', workspaceId: 'ws-a' }, target: host, reason: 'automatic' })
    expect(host.show).not.toHaveBeenCalled()
    expect(createdWindows.at(-1).show).not.toHaveBeenCalled()
    manager.destroyAll()
  })
  it('remote AI open forwards automatic presentation to the actual sender host with its public owner', async () => {
    const { manager, requests } = setupAutomatic()
    const sender = createMockWindow()
    const id = await (manager as any).dispatchCapability({ v: 1, workspaceId: 'ws-a', sessionId: 'session-b', method: 'createForSession', args: ['session-b', { show: false, presentIfActive: true }] }, sender)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ info: { id, ownerSessionId: 'session-b', workspaceId: 'ws-a' }, target: sender, reason: 'automatic' })
    manager.destroyAll()
  })
  it('opening an existing hidden sidebar page never automatically expands it again or grabs manual pages', () => {
    const { manager, host, requests } = setupAutomatic()
    const manual = manager.createInstance('user-manual', { workspaceId: 'ws-a' })
    const id = manager.createForSession('session-b', { show: false, workspaceId: 'ws-a' })
    manager.embedInstance(id, host)
    manager.hide(id)
    expect(manager.createForSession('session-b', { show: false, presentIfActive: true, workspaceId: 'ws-a' } as any)).toBe(id)
    expect(id).not.toBe(manual)
    expect(requests).toHaveLength(0)
    expect(manager.getInstance(id)?.isVisible).toBe(false)
    manager.destroyAll()
  })
  it('opening an existing hidden popup keeps the user-selected presentation and never wakes its OS window', () => {
    const { manager, host, requests } = setupAutomatic()
    const id = manager.createForSession('session-b', { show: false, workspaceId: 'ws-a' })
    manager.embedInstance(id, host)
    manager.detachToPopup(id)
    manager.hide(id)
    const popup = createdWindows.at(-1)
    popup.show.mockClear()
    manager.createForSession('session-b', { show: false, presentIfActive: true, workspaceId: 'ws-a' } as any)
    expect(requests).toHaveLength(0)
    expect(manager.getInstance(id)?.hostMode).toBe('popup')
    expect(manager.getInstance(id)?.isVisible).toBe(false)
    expect(popup.show).not.toHaveBeenCalled()
    manager.destroyAll()
  })
})

describe('POO159 AI overlay allocation before open', () => {
  it('presents an untouched backing instance allocated by tool_start before the real open command', async () => {
    const manager = new BrowserPaneManager()
    const host = createMockWindow()
    manager.setWindowManager({ getFocusedWindow: () => host, getWorkspaceForWindow: () => 'ws-a', getWindowByWorkspace: () => host } as any)
    const requests: any[] = []
    manager.onOpenRequested((info, target, reason) => { requests.push({ info, target, reason }) })
    const backing = manager.getOrCreateForSession('session-b', { workspaceId: 'ws-a' })
    manager.setAgentControl('session-b', { displayName: 'Browser', intent: 'Open guide' }, { workspaceId: 'ws-a' })
    expect(requests).toHaveLength(0)
    const id = await manager.createForSessionAsync('session-b', { show: false, presentIfActive: true, workspaceId: 'ws-a' } as any)
    expect(id).toBe(backing)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ info: { id, ownerSessionId: 'session-b' }, target: host, reason: 'automatic' })
    manager.destroyAll()
  })
})
