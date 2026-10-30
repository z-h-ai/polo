/**
 * BrowserPaneManager popup geometry after native-view migration.
 * Electron 39.2.7 appends BrowserView's resize listener on each owner attach,
 * then adds window delta to the CURRENT view bounds. This boundary model
 * preserves that event order; a call-count-only setAutoResize mock misses it.
 * Sources (pinned to the installed Electron version):
 * https://github.com/electron/electron/blob/v39.2.7/lib/browser/api/browser-view.ts#L64-L74
 * https://github.com/electron/electron/blob/v39.2.7/lib/browser/api/browser-view.ts#L113-L124
 * https://github.com/electron/electron/blob/v39.2.7/lib/browser/api/browser-window.ts#L187-L213
 * This is an isolated model regression; real native resize acceptance is separate.
 */

import { describe, it, expect, mock } from 'bun:test'

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
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  let flags = { width: false, height: false }
  let owner: any = null
  let last = { width: 0, height: 0 }
  // Electron 39.2.7 browser-view.ts: listener appends on ownerWindow attach;
  // native resize adds window delta to the CURRENT view bounds.
  const autoResize = () => {
    const next = owner.getBounds()
    bounds = { ...bounds, width: bounds.width + (flags.width ? next.width - last.width : 0), height: bounds.height + (flags.height ? next.height - last.height : 0) }
    last = next
  }
  return {
    webContents,
    setBounds: mock((next: any) => { bounds = { ...next } }),
    getBounds: () => ({ ...bounds }),
    setAutoResize: mock((next: any) => { flags = { ...next } }),
    _attach: (next: any) => { if (owner) owner.off('resize', autoResize); owner = next; last = next.getBounds(); next.on('resize', autoResize) },
    _detach: () => { if (owner) owner.off('resize', autoResize); owner = null },
  }
}

function createMockWindow() {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let nativeBounds = { x: 0, y: 0, width: 1200, height: 841 }
  const attached = new Set<any>()
  const win: any = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    off: (event: string, cb: Function) => { listeners[event] = (listeners[event] || []).filter(fn => fn !== cb) },
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
    addBrowserView: mock((view: any) => { if (!attached.has(view)) { attached.add(view); view._attach(win) } }),
    removeBrowserView: mock((view: any) => { if (attached.delete(view)) view._detach() }),
    setTopBrowserView: mock((_view: any) => {}),
    getBounds: () => ({ ...nativeBounds }),
    getContentSize: mock(() => [nativeBounds.width, nativeBounds.height]),
    _resize: (width: number, height: number) => { nativeBounds = { ...nativeBounds, width, height }; win._emit('resize') },
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


// Every fixture imports the real manager; only Electron and its dependencies are mocked.
async function readyPopup(detach: boolean) {
  const manager = new BrowserPaneManager()
  const id = manager.createInstance('resize-diagnostic-' + Math.random())
  const inst = (manager as any).instances.get(id)
  if (detach) {
    manager.embedInstance(id, createMockWindow() as any, { x: 0, y: 0, width: 610, height: 635 })
    inst.pageView.webContents.executeJavaScript = mock(async (script: string) => script.includes('return { x: scrollX, y: scrollY }') ? { x: 0, y: 900 } : undefined)
    manager.detachToPopup(id)
    await Bun.sleep(130)
  }
  return { manager, inst }
}
describe('BrowserPaneManager native popup resize after migration', () => {
  it('fresh popup manual layout wins after the original native listener', async () => {
    const { manager, inst } = await readyPopup(false)
    try {
      inst.window._resize(1200, 782)
      expect(inst.pageView.getBounds()).toEqual({ x: 0, y: 48, width: 1200, height: 734 })
    } finally { manager.destroyAll() }
  })
  it('after detach page height must be content height minus toolbar exactly once', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      inst.window._resize(1200, 782)
      expect(inst.pageView.getBounds()).toEqual({ x: 0, y: 48, width: 1200, height: 734 })
    } finally { manager.destroyAll() }
  })
  it('after detach page width must not receive the native delta twice', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      inst.window._resize(1280, 841)
      expect(inst.pageView.getBounds()).toEqual({ x: 0, y: 48, width: 1280, height: 793 })
    } finally { manager.destroyAll() }
  })
  it('keeps the existing toolbar width/height correct after migration and resize', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      inst.window._resize(1280, 782)
      expect(inst.toolbarView.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 48 })
      inst.window._resize(1200, 840)
      expect(inst.toolbarView.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 48 })
    } finally { manager.destroyAll() }
  })
  it('keeps the active menu overlay inside the popup after migration and resize', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      // Exercise the production menu-overlay layout, without agent activity.
      inst.toolbarMenuOverlayActive = true
      inst.window._resize(1280, 782)
      expect(inst.nativeOverlayView.getBounds()).toEqual({ x: 0, y: 48, width: 1280, height: 734 })
      inst.window._resize(1200, 840)
      expect(inst.nativeOverlayView.getBounds()).toEqual({ x: 0, y: 48, width: 1200, height: 792 })
    } finally { manager.destroyAll() }
  })
  it('keeps an expanded toolbar menu inside the popup after migration and resize', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      inst.toolbarMenuOpen = true
      inst.window._resize(1280, 782)
      expect(inst.toolbarView.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 782 })
      inst.window._resize(1200, 840)
      expect(inst.toolbarView.getBounds()).toEqual({ x: 0, y: 0, width: 1200, height: 840 })
    } finally { manager.destroyAll() }
  })

})

describe('BrowserPaneManager native popup grow-back geometry', () => {
  it('growing back after a shrink uses the current popup height once', async () => {
    const { manager, inst } = await readyPopup(true)
    try {
      inst.window._resize(1200, 782)
      inst.window._resize(1200, 840)
      expect(inst.pageView.getBounds()).toEqual({ x: 0, y: 48, width: 1200, height: 792 })
    } finally { manager.destroyAll() }
  })
})
