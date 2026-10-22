import { describe, expect, it, mock, beforeEach } from 'bun:test'

// Electron / heavyweight-module mocks — same pattern as
// deep-link-callback-bridge.test.ts. The mutable `focusedWindow` lets each
// test control what BrowserWindow.getFocusedWindow() reports.
let focusedWindow: {
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; id: number }
} | null = null

const appListeners = new Map<string, Array<(...args: unknown[]) => void>>()
const appOn = mock((name: string, handler: (...args: unknown[]) => void) => {
  const handlers = appListeners.get(name) ?? []
  handlers.push(handler)
  appListeners.set(name, handlers)
})
const menuSetApplicationMenu = mock(() => {})

mock.module('electron', () => ({
  app: { on: appOn, isPackaged: true },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: menuSetApplicationMenu },
  shell: { openExternal: () => {} },
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
}))

mock.module('../logger', () => ({
  mainLog: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
  isDebugMode: false,
}))

mock.module('../auto-update', () => ({
  getUpdateInfo: () => ({ available: false, downloadState: 'idle', latestVersion: '0.0.0' }),
  installUpdate: async () => {},
  checkForUpdates: async () => ({ available: false }),
}))

const { matchWebviewMenuShortcut, createApplicationMenu } = await import('../menu')
const { RPC_CHANNELS } = await import('../../shared/types')

/** Pin process.platform so CmdOrCtrl semantics are deterministic. */
function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

function input(partial: Partial<Parameters<typeof matchWebviewMenuShortcut>[0]>) {
  return {
    type: 'keyDown',
    key: 'n',
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...partial,
  }
}

describe('matchWebviewMenuShortcut (pure matcher)', () => {
  it('matches all six renderer-owned menu accelerators on macOS (meta = CmdOrCtrl)', () => {
    withPlatform('darwin', () => {
      expect(matchWebviewMenuShortcut(input({ key: 'n', meta: true }))).toBe('newChat')
      expect(matchWebviewMenuShortcut(input({ key: 'N', meta: true, shift: true }))).toBe('newWindow')
      expect(matchWebviewMenuShortcut(input({ key: ',', meta: true }))).toBe('openSettings')
      expect(matchWebviewMenuShortcut(input({ key: '.', meta: true }))).toBe('toggleFocusMode')
      expect(matchWebviewMenuShortcut(input({ key: 'b', meta: true }))).toBe('toggleSidebar')
      expect(matchWebviewMenuShortcut(input({ key: '/', meta: true }))).toBe('keyboardShortcuts')
    })
  })

  it('matches the same accelerators on Windows/Linux (control = CmdOrCtrl)', () => {
    withPlatform('win32', () => {
      expect(matchWebviewMenuShortcut(input({ key: 'n', control: true }))).toBe('newChat')
      expect(matchWebviewMenuShortcut(input({ key: 'n', control: true, shift: true }))).toBe('newWindow')
      expect(matchWebviewMenuShortcut(input({ key: ',', control: true }))).toBe('openSettings')
      expect(matchWebviewMenuShortcut(input({ key: '.', control: true }))).toBe('toggleFocusMode')
      expect(matchWebviewMenuShortcut(input({ key: 'b', control: true }))).toBe('toggleSidebar')
      expect(matchWebviewMenuShortcut(input({ key: '/', control: true }))).toBe('keyboardShortcuts')
    })
  })

  it('rejects non-keyDown event types', () => {
    withPlatform('darwin', () => {
      expect(matchWebviewMenuShortcut(input({ type: 'keyUp', key: 'n', meta: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ type: 'rawKeyDown', key: 'n', meta: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ type: 'char', key: 'n', meta: true }))).toBeNull()
    })
  })

  it('rejects wrong modifier combinations', () => {
    withPlatform('darwin', () => {
      // No modifier at all.
      expect(matchWebviewMenuShortcut(input({ key: 'n' }))).toBeNull()
      // Alt held alongside the accelerator modifier.
      expect(matchWebviewMenuShortcut(input({ key: 'n', meta: true, alt: true }))).toBeNull()
      // The non-platform cmd/ctrl modifier is also down.
      expect(matchWebviewMenuShortcut(input({ key: 'n', meta: true, control: true }))).toBeNull()
      // Windows modifier on macOS.
      expect(matchWebviewMenuShortcut(input({ key: 'n', control: true }))).toBeNull()
    })
    withPlatform('win32', () => {
      // macOS modifier on Windows.
      expect(matchWebviewMenuShortcut(input({ key: 'n', meta: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ key: ',', control: true, alt: true }))).toBeNull()
    })
  })

  it('rejects unexpected shift and unbound keys', () => {
    withPlatform('darwin', () => {
      // Shift only pairs with N (newWindow); every other combo must miss.
      expect(matchWebviewMenuShortcut(input({ key: 'b', meta: true, shift: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ key: ',', meta: true, shift: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ key: '/', meta: true, shift: true }))).toBeNull()
      // Keys without a menu accelerator.
      expect(matchWebviewMenuShortcut(input({ key: 'x', meta: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ key: 'r', meta: true }))).toBeNull()
      expect(matchWebviewMenuShortcut(input({ key: 'Escape', meta: true }))).toBeNull()
    })
  })
})

describe('webview menu-shortcut forwarding wiring', () => {
  const eventSink = mock(() => {})
  const createNewMainWindow = mock(async (_id: number, _source: string) => ({ ok: true, reason: undefined as string | undefined }))
  const windowManager = { createNewMainWindow }

  /** Lets the void-launched async new-window chain settle before asserting. */
  function flushAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  /** Builds a fake webview contents and returns its before-input-event handler. */
  function attachWebview(getType: () => string): (...args: unknown[]) => void {
    let handler: ((...args: unknown[]) => void) | null = null
    const contents = {
      getType,
      on: (_name: string, cb: (...args: unknown[]) => void) => { handler = cb },
    }
    const created = appListeners.get('web-contents-created')!
    for (const fn of created) fn({}, contents)
    expect(handler).toBeTypeOf('function')
    return handler!
  }

  function dispatch(handler: (...args: unknown[]) => void, payload: ReturnType<typeof input>) {
    const preventDefault = mock(() => {})
    handler({ preventDefault }, payload)
    return preventDefault
  }

  const isDarwin = process.platform === 'darwin'
  const modForPlatform = isDarwin ? { meta: true, control: false } : { meta: false, control: true }

  /** Init the menu with the sink/resolver wired (createApplicationMenu overwrites cached values). */
  function initMenu() {
    createApplicationMenu(windowManager as never, eventSink as never, () => 'client-1')
  }

  beforeEach(() => {
    eventSink.mockClear()
    createNewMainWindow.mockClear()
    createNewMainWindow.mockImplementation(async () => ({ ok: true, reason: undefined }))
    focusedWindow = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, id: 5 },
    }
  })

  it('registers the web-contents-created listener exactly once across menu rebuilds', () => {
    createApplicationMenu(windowManager as never)
    createApplicationMenu(windowManager as never)
    const registrations = (appListeners.get('web-contents-created') ?? []).length
    expect(registrations).toBe(1)
  })

  it('ignores non-webview contents', () => {
    createApplicationMenu(windowManager as never)
    let handler: ((...args: unknown[]) => void) | null = null
    const contents = {
      getType: () => 'window',
      on: (_name: string, cb: (...args: unknown[]) => void) => { handler = cb },
    }
    for (const fn of appListeners.get('web-contents-created')!) fn({}, contents)
    expect(handler).toBeNull()
  })

  it('forwards newChat/openSettings/toggles/keyboardShortcuts to the focused renderer client', () => {
    initMenu()
    const handler = attachWebview(() => 'webview')

    const cases: Array<{ payload: ReturnType<typeof input>; channel: string }> = [
      { payload: input({ key: 'n', ...modForPlatform }), channel: RPC_CHANNELS.menu.NEW_CHAT },
      { payload: input({ key: ',', ...modForPlatform }), channel: RPC_CHANNELS.menu.OPEN_SETTINGS },
      { payload: input({ key: '.', ...modForPlatform }), channel: RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE },
      { payload: input({ key: 'b', ...modForPlatform }), channel: RPC_CHANNELS.menu.TOGGLE_SIDEBAR },
      { payload: input({ key: '/', ...modForPlatform }), channel: RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS },
    ]
    for (const { payload, channel } of cases) {
      eventSink.mockClear()
      const preventDefault = dispatch(handler, payload)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(eventSink).toHaveBeenCalledTimes(1)
      expect(eventSink).toHaveBeenCalledWith(channel, { to: 'client', clientId: 'client-1' })
    }
  })

  it('does not forward or swallow unmatched keystrokes', () => {
    initMenu()
    const handler = attachWebview(() => 'webview')

    for (const payload of [
      input({ key: 'x', ...modForPlatform }),
      input({ key: 'n', type: 'keyUp', ...modForPlatform }),
      input({ key: 'n' }),
    ]) {
      eventSink.mockClear()
      const preventDefault = dispatch(handler, payload)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(eventSink).not.toHaveBeenCalled()
    }
  })

  it('newWindow replicates the native File > New Window click via WindowManager', async () => {
    initMenu()
    const handler = attachWebview(() => 'webview')
    const preventDefault = dispatch(handler, input({ key: 'n', shift: true, ...modForPlatform }))
    expect(preventDefault).toHaveBeenCalledTimes(1)
    await flushAsync()
    expect(createNewMainWindow).toHaveBeenCalledTimes(1)
    expect(createNewMainWindow).toHaveBeenCalledWith(5, 'webview_shortcut')
    // Success: no failure broadcast to the originating window.
    expect(eventSink).not.toHaveBeenCalled()
  })

  it('newWindow surfaces an observable failure when the focused window has no workspace (POO-117)', async () => {
    initMenu()
    const handler = attachWebview(() => 'webview')
    createNewMainWindow.mockImplementation(async () => ({ ok: false, reason: 'workspace_unresolved' }))

    const preventDefault = dispatch(handler, input({ key: 'n', shift: true, ...modForPlatform }))
    expect(preventDefault).toHaveBeenCalledTimes(1)
    await flushAsync()
    expect(createNewMainWindow).toHaveBeenCalledTimes(1)
    expect(createNewMainWindow).toHaveBeenCalledWith(5, 'webview_shortcut')
    // The old behavior was a silent no-op; the originating renderer is now told.
    expect(eventSink).toHaveBeenCalledWith(
      RPC_CHANNELS.menu.NEW_WINDOW_FAILED,
      { to: 'client', clientId: 'client-1' },
      'workspace_unresolved',
    )
  })
})
