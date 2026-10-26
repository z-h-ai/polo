/**
 * POO-135 验收修复 (SB-CANVAS-OUT) — CanvasPopupManager state machine tests.
 *
 * Mocks the electron boundary (same discipline as browser-pane-sidebar.test.ts)
 * and covers: detach creates the popup window with the carrier query, aux
 * registration into the workspace map, mutual exclusion (re-detach focuses),
 * ready-to-show visibility broadcast, close-by-any-route → automatic return
 * (poppedOut:false), explicit attach idempotency, focus, and destroyAll.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

delete process.env.VITE_DEV_SERVER_URL

const createdWindows: any[] = []

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  return {
    id: Math.floor(Math.random() * 1_000_000) + 10,
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    setWindowOpenHandler: mock((_handler: any) => {}),
    loadURL: mock(async (_url: string) => {}),
    _listeners: listeners,
  }
}

function createMockWindow(opts?: any) {
  const listeners: Record<string, Function[]> = {}
  const win: any = {
    webContents: createMockWebContents(),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    once: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]!.push(cb)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of [...(listeners[event] || [])]) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    isVisible: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {
      win.isVisible.mockimpl?.()
    }),
    hide: mock(() => {}),
    focus: mock(() => {}),
    close: mock(() => {
      win._emit('closed')
    }),
    loadURL: mock(async (_url: string) => {}),
    loadFile: mock(async (_path: string, _opts?: unknown) => {}),
    _ctorOpts: opts,
  }
  return win
}

mock.module('electron', () => ({
  app: { getPath: mock((name: string) => `/tmp/mock-${name}`), getName: mock(() => 'Polo AI') },
  BrowserWindow: class MockBrowserWindow {
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      Object.assign(this, win)
      createdWindows.push(this)
    }
  },
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: { handle: mock(() => {}), on: mock(() => {}) },
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

const { CanvasPopupManager } = await import('../canvas-popup-manager')

function createFakeWindowManager() {
  return {
    registerAuxWindow: mock((_win: unknown, _wsId: string | null) => {}),
    unregisterAuxWindow: mock((_wcId: number) => {}),
  }
}

const APP = { appId: 'app-1', title: 'Weather Card', indexPath: '/bundles/app-1/index.html', version: 3 }

let manager: InstanceType<typeof CanvasPopupManager>
let windowManager: ReturnType<typeof createFakeWindowManager>
let states: Array<{ sessionId: string; poppedOut: boolean; isVisible: boolean }>

beforeEach(() => {
  createdWindows.length = 0
  manager = new CanvasPopupManager()
  windowManager = createFakeWindowManager()
  manager.setWindowManager(windowManager as any)
  states = []
  manager.onStateChanged((s) => states.push(s))
})

describe('CanvasPopupManager', () => {
  it('detachToPopup creates an 880×720 popup loading the popout carrier with query', async () => {
    manager.detachToPopup('sess-1', APP, 'ws-main')
    expect(createdWindows).toHaveLength(1)
    const win = createdWindows[0]!
    expect(win._ctorOpts.width).toBe(880)
    expect(win._ctorOpts.height).toBe(720)
    expect(win._ctorOpts.title).toBe('Weather Card')
    expect(win._ctorOpts.webPreferences.webviewTag).toBe(true)
    expect(win._ctorOpts.webPreferences.contextIsolation).toBe(true)
    // Aux registration scopes the popup renderer into the calling workspace
    // (webview attach gate fail-closes unmapped windows).
    expect(windowManager.registerAuxWindow).toHaveBeenCalledWith(win, 'ws-main')
    // Prod carrier entry with the app payload encoded into the query.
    expect(win.loadFile).toHaveBeenCalledTimes(1)
    const [path, loadOpts] = win.loadFile.mock.calls[0] as [string, { query: Record<string, string> }]
    expect(path).toContain('canvas-popout.html')
    expect(loadOpts.query.sessionId).toBe('sess-1')
    expect(JSON.parse(loadOpts.query.app)).toEqual(APP)
    expect(manager.isPoppedOut('sess-1')).toBe(true)
  })

  it('re-detach on a live popup is mutually exclusive: focuses instead of a second window', () => {
    manager.detachToPopup('sess-1', APP, 'ws-main')
    const first = createdWindows[0]!
    manager.detachToPopup('sess-1', APP, 'ws-main')
    expect(createdWindows).toHaveLength(1)
    expect(first.show).toHaveBeenCalled()
    expect(first.focus).toHaveBeenCalled()
    // No duplicate aux registrations either.
    expect(windowManager.registerAuxWindow).toHaveBeenCalledTimes(1)
  })

  it('ready-to-show shows the window and broadcasts poppedOut+visible', () => {
    manager.detachToPopup('sess-1', APP, null)
    const win = createdWindows[0]!
    expect(states).toEqual([])
    win._emit('ready-to-show')
    expect(win.show).toHaveBeenCalled()
    expect(states).toEqual([{ sessionId: 'sess-1', poppedOut: true, isVisible: true }])
  })

  it('closing the window by ANY route returns the canvas to the sidebar', () => {
    manager.detachToPopup('sess-1', APP, 'ws-main')
    const win = createdWindows[0]!
    win._emit('ready-to-show')
    win.close() // system close button / Cmd+W — no explicit attach call
    expect(windowManager.unregisterAuxWindow).toHaveBeenCalledWith(win.webContents.id)
    expect(manager.isPoppedOut('sess-1')).toBe(false)
    expect(states.at(-1)).toEqual({ sessionId: 'sess-1', poppedOut: false, isVisible: false })
  })

  it('attachFromPopup closes the popup (canvas returns via the closed broadcast)', () => {
    manager.detachToPopup('sess-1', APP, 'ws-main')
    const win = createdWindows[0]!
    manager.attachFromPopup('sess-1')
    expect(win.close).toHaveBeenCalledTimes(1)
    expect(manager.isPoppedOut('sess-1')).toBe(false)
    expect(states.at(-1)).toEqual({ sessionId: 'sess-1', poppedOut: false, isVisible: false })
  })

  it('attachFromPopup without a popup emits one reconciling broadcast (idempotent)', () => {
    // Race guard: the renderer may ask to attach after the window already
    // closed by itself — the reconciling broadcast re-syncs the sidebar.
    manager.attachFromPopup('sess-unknown')
    expect(states).toEqual([{ sessionId: 'sess-unknown', poppedOut: false, isVisible: false }])
  })

  it('focus restores a minimized popup', () => {
    manager.detachToPopup('sess-1', APP, 'ws-main')
    const win = createdWindows[0]!
    win.isMinimized = mock(() => true)
    manager.focus('sess-1')
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    // Unknown session is a no-op.
    manager.focus('sess-unknown')
    expect(createdWindows).toHaveLength(1)
  })

  it('destroyAll closes every popup (app-quit reconciliation)', () => {
    manager.detachToPopup('s1', APP, 'ws-main')
    manager.detachToPopup('s2', { ...APP, appId: 'app-2' }, 'ws-main')
    expect(createdWindows).toHaveLength(2)
    manager.destroyAll()
    for (const win of createdWindows) expect(win.close).toHaveBeenCalledTimes(1)
    expect(manager.isPoppedOut('s1')).toBe(false)
    expect(manager.isPoppedOut('s2')).toBe(false)
    expect(states.filter((s) => !s.poppedOut)).toHaveLength(2)
  })
})
