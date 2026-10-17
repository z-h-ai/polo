import { describe, expect, it, mock, beforeEach } from 'bun:test'

// Minimal electron mock: partition sessions are cached per name so the
// WeakSet-based guest policy in webview-security sees stable identities.
type FakeSession = {
  partition: string
  permissionChecks: number
  permissionRequests: number
  setPermissionCheckHandler(): void
  setPermissionRequestHandler(): void
}

const sessions = new Map<string, FakeSession>()
const openExternalCalls: string[] = []

const electronMock = {
  app: {
    on: (_event: string, _listener: (...args: unknown[]) => void) => {},
  },
  shell: {
    openExternal: async (url: string) => {
      openExternalCalls.push(url)
    },
  },
  session: {
    fromPartition: (partition: string) => {
      let ses = sessions.get(partition)
      if (!ses) {
        ses = {
          partition,
          permissionChecks: 0,
          permissionRequests: 0,
          setPermissionCheckHandler() {
            ses!.permissionChecks += 1
          },
          setPermissionRequestHandler() {
            ses!.permissionRequests += 1
          },
        }
        sessions.set(partition, ses)
      }
      return ses
    },
  },
}

mock.module('../app-sdk-service', () => ({ getAppSdkBridge: () => ({ prepareGuest: () => {}, attachGuest: () => {} }), setAppSdkWorkspaceResolver: () => {} }))
mock.module('electron', () => electronMock)
mock.module('../browser-pane-manager', () => ({
  BROWSER_PANE_SESSION_PARTITION: 'persist:browser-pane',
}))
mock.module('../logger', () => ({ windowLog: {
  info() {}, warn() {}, error() {}, debug() {},
} }))
mock.module('../deep-link-log', () => ({ describeUrlForLog: (url: string) => url }))

const {
  __resetWebviewSecurityForTests,
  installWebviewSecurityHandlers,
  setWebviewScopeResolver,
  isGenUiAppPartition,
  GENUI_APP_PARTITION_PATTERN,
} = await import('../webview-security')
const {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} = await import('@polo-ai/server-core/runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId } = await import(
  '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
)

let webContentsCreated: ((_event: unknown, contents: Record<string, unknown>) => void) | null = null
;(electronMock.app as unknown as { on: (event: string, listener: unknown) => void }).on = (
  event: string,
  listener: unknown,
) => {
  if (event === 'web-contents-created') webContentsCreated = listener as typeof webContentsCreated
}

interface Emitting {
  emit: (event: string, ...args: unknown[]) => void
}

function makeWindow(id: number): Record<string, unknown> & Emitting {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    getType: () => 'window',
    id,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    },
    setWindowOpenHandler: () => {},
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  }
}

/** A webview guest contents whose session is the given partition's session. */
function makeGuest(partition: string | null): Record<string, unknown> & Emitting {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  let openHandler: ((details: { url: string }) => { action: string }) | null = null
  const guest = {
    getType: () => 'webview',
    id: Math.floor(Math.random() * 1e6),
    session: partition ? electronMock.session.fromPartition(partition) : undefined,
    hostWebContents: { id: 1 },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    },
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
      openHandler = handler
    },
    windowOpen: (url: string) => openHandler?.({ url }),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  }
  return guest
}

describe('genui canvas webview partition policy', () => {
  beforeEach(() => {
    sessions.clear()
    openExternalCalls.length = 0
    webContentsCreated = null
    __resetWebviewSecurityForTests()
    // Signed-in scoped window (same production wiring as the partition tests).
    setSyncTrustedProductSpaceAccountId('account-a')
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')
    setWebviewScopeResolver({ getWorkspaceForWebContentsId: id => `ws-${id}` })
    installWebviewSecurityHandlers()
  })

  it('recognizes only the strict genui partition namespace', () => {
    expect(isGenUiAppPartition('genui-app-sess-1')).toBe(true)
    expect(isGenUiAppPartition('genui-app-a.b_c-d')).toBe(true)
    expect(isGenUiAppPartition('persist:genui-app-sess-1')).toBe(false)
    expect(isGenUiAppPartition('genui-app-../escape')).toBe(false)
    expect(isGenUiAppPartition('persist:browser-pane')).toBe(false)
    expect(isGenUiAppPartition(undefined)).toBe(false)
    expect('persist:genui-app-x').not.toMatch(GENUI_APP_PARTITION_PATTERN)
  })

  it('allows a genui-app partition for a scoped window and installs its policy', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'genui-app-sess-1' },
      { src: 'file:///tmp/genui-apps/app-1/index.html' },
    )

    expect(preventDefault).not.toHaveBeenCalled()
    const ses = sessions.get('genui-app-sess-1')
    expect(ses).toBeDefined()
    expect(ses!.permissionChecks).toBe(1)
    expect(ses!.permissionRequests).toBe(1)
  })

  it('still refuses a persist:-prefixed impersonation of the genui namespace', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'persist:genui-app-sess-1' },
      { src: 'file:///tmp/index.html' },
    )
    // Not the scoped tab-app partition, not the browser-pane partition.
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('refuses genui partitions while the window scope is incomplete (closed mode)', async () => {
    // Force closed mode: authenticated but the fence is gone.
    const { revokeRuntimeProductSpaceFence } = await import(
      '@polo-ai/server-core/runtime/product-space-executions'
    )
    await revokeRuntimeProductSpaceFence()

    const window = makeWindow(7)
    webContentsCreated!({}, window)
    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'genui-app-sess-1' },
      { src: 'file:///tmp/index.html' },
    )
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(sessions.get('genui-app-sess-1')).toBeUndefined()
  })

  it('denies popups from a genui guest without opening them externally', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)
    window.emit(
      'will-attach-webview',
      { preventDefault: mock(() => {}) },
      { partition: 'genui-app-sess-1' },
      { src: 'file:///tmp/index.html' },
    )

    const guest = makeGuest('genui-app-sess-1')
    webContentsCreated!({}, guest)
    const decision = (guest as unknown as { windowOpen: (url: string) => { action: string } })
      .windowOpen('https://evil.example/popup')
    expect(decision.action).toBe('deny')
    expect(openExternalCalls).toEqual([])
  })

  it('blocks every navigation from a genui guest, including http(s)', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)
    window.emit(
      'will-attach-webview',
      { preventDefault: mock(() => {}) },
      { partition: 'genui-app-sess-1' },
      { src: 'file:///tmp/index.html' },
    )

    const guest = makeGuest('genui-app-sess-1')
    webContentsCreated!({}, guest)
    const preventDefault = mock(() => {})
    guest.emit('will-navigate', { preventDefault }, 'https://evil.example/next')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('keeps the normal guest policy for non-genui sessions (http allowed)', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    // A regular window-policy contents: session is the scoped tab-app
    // partition (never registered as a genui guest).
    const scopedPartition = 'persist:tab-app-regular'
    const guest = makeGuest(scopedPartition)
    guest.getType = () => 'window'
    webContentsCreated!({}, guest)

    const preventDefault = mock(() => {})
    guest.emit('will-navigate', { preventDefault }, 'https://app.example/next')
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
