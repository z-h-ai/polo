import { beforeEach, describe, expect, it, mock } from 'bun:test'

const logEntries: unknown[][] = []
const appListeners = new Map<string, (...args: unknown[]) => void>()
const openExternal = mock(async (_url: string) => {})
const capture = (...args: unknown[]) => {
  logEntries.push(args)
}

mock.module('electron', () => ({
  app: {
    on: mock((event: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(event, listener)
    }),
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
    })),
  },
  shell: {
    openExternal,
  },
}))

mock.module('../browser-pane-manager', () => ({
  BROWSER_PANE_SESSION_PARTITION: 'persist:browser-pane',
}))

mock.module('../logger', () => ({
  windowLog: {
    debug: capture,
    error: capture,
    info: capture,
    warn: capture,
  },
}))

const { installWebviewSecurityHandlers } = await import('../webview-security')

beforeEach(() => {
  logEntries.length = 0
  appListeners.clear()
  openExternal.mockClear()
})

describe('webview security deep-link logging', () => {
  it('redacts join tokens from popup and will-navigate logs', () => {
    installWebviewSecurityHandlers()
    const webContentsCreated = appListeners.get('web-contents-created')
    expect(webContentsCreated).toBeDefined()

    let windowOpenHandler!: (details: { url: string }) => { action: string }
    let willNavigateHandler!: (
      event: { preventDefault: () => void },
      url: string,
    ) => void
    const contents = {
      getType: () => 'webview',
      setWindowOpenHandler: (handler: typeof windowOpenHandler) => {
        windowOpenHandler = handler
      },
      on: (event: string, handler: typeof willNavigateHandler) => {
        if (event === 'will-navigate') willNavigateHandler = handler
      },
    }
    webContentsCreated?.({}, contents)

    const popupToken = 'webview-popup-token-abcdefghijklmnopqrstuvwxyz'
    const popupUrl = `poloai://join/${popupToken}`
    expect(windowOpenHandler({ url: popupUrl })).toEqual({ action: 'deny' })

    const navigationToken = 'webview-navigation-token-abcdefghijklmnopqrstuvwxyz'
    const navigationUrl = `poloai://join/${navigationToken}`
    const preventDefault = mock(() => {})
    willNavigateHandler({ preventDefault }, navigationUrl)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(openExternal).not.toHaveBeenCalled()
    const serializedLogs = JSON.stringify(logEntries)
    expect(serializedLogs).not.toContain(popupToken)
    expect(serializedLogs).not.toContain(popupUrl)
    expect(serializedLogs).not.toContain(navigationToken)
    expect(serializedLogs).not.toContain(navigationUrl)
    expect(serializedLogs.match(/"routeType":"join"/g)?.length).toBe(2)
    expect(serializedLogs.match(/"fingerprint":"[a-f0-9]{12}"/g)?.length).toBe(2)
  })
})
