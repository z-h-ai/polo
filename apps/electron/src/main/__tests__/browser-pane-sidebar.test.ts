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
