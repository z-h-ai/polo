import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Minimal electron mock: partition sessions are cached per name so the
// WeakSet-based guest policy in webview-security sees stable identities.
type BeforeRequest = (details: { url: string; resourceType?: string }, callback: (r: unknown) => void) => void
type FakeSession = {
  partition: string
  permissionChecks: number
  permissionRequests: number
  permissionCheckHandler: ((wc: unknown, permission: string, origin: string) => boolean) | null
  permissionRequestHandler:
    | ((wc: unknown, permission: string, callback: (allow: boolean) => void, details?: { requestingOrigin?: string }) => void)
    | null
  webRequest: { onBeforeRequest: (fn: BeforeRequest) => void }
  setPermissionCheckHandler(fn: FakeSession['permissionCheckHandler']): void
  setPermissionRequestHandler(fn: FakeSession['permissionRequestHandler']): void
}

const sessions = new Map<string, FakeSession>()
const openExternalCalls: string[] = []

// The canvas request fence lives behind ses.webRequest — captured per session.
const beforeRequestByPartition = new Map<string, BeforeRequest>()

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
    fromPartition: (partition: string): FakeSession => {
      let ses = sessions.get(partition)
      if (!ses) {
        ses = {
          partition,
          permissionChecks: 0,
          permissionRequests: 0,
          permissionCheckHandler: null,
          permissionRequestHandler: null,
          setPermissionCheckHandler(fn: FakeSession['permissionCheckHandler']) {
            ses!.permissionChecks += 1
            // Capture the REAL installed handler; tests invoke it directly.
            ses!.permissionCheckHandler = fn
          },
          setPermissionRequestHandler(fn: NonNullable<FakeSession['permissionRequestHandler']>) {
            ses!.permissionRequests += 1
            ses!.permissionRequestHandler = fn
          },
          webRequest: {
            onBeforeRequest: (fn: BeforeRequest) => {
              beforeRequestByPartition.set(partition, fn)
            },
          },
        }
        sessions.set(partition, ses)
      }
      return ses
    },
  },
  // POO-103: the ui-event chain pulls DeepLinkCallbackBridge (its constructor
  // registers an ipcMain listener unless suppressed) — inert here.
  ipcMain: { on: () => {}, off: () => {} },
  webContents: { fromId: () => undefined },
}

mock.module('../app-sdk-service', () => ({ getAppSdkBridge: () => ({ prepareGuest: () => {}, attachGuest: () => {} }), setAppSdkWorkspaceResolver: () => {} }))
mock.module('electron', () => electronMock)
mock.module('../browser-pane-manager', () => ({
  BROWSER_PANE_SESSION_PARTITION: 'persist:browser-pane',
}))
mock.module('../logger', () => {
  const stubLog = { info() {}, warn() {}, error() {}, debug() {} }
  // POO-103: handlers/genui now pulls the ui-event chain (genui-ui-event +
  // deep-link-callback-bridge), which logs through mainLog too.
  return { windowLog: stubLog, mainLog: stubLog }
})
mock.module('../deep-link-log', () => ({ describeUrlForLog: (url: string) => url }))

const {
  __resetWebviewSecurityForTests,
  installWebviewSecurityHandlers,
  setWebviewScopeResolver,
  setGenUiGuestSrcValidator,
  registerGenUiCarrier,
  unregisterGenUiCarrier,
  isGenUiAppPartition,
  GENUI_APP_PARTITION_PATTERN,
} = await import('../webview-security')
const { createGenUiGuestSrcValidator } = await import('../handlers/genui')
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
  let dataRoot: string

  /** A file: src pointing at a real generated bundle of sess-1. */
  function bundleSrc(appId = 'app-1'): string {
    const dir = join(dataRoot, 'sessions', 'sess-1', 'data', 'genui-apps', appId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<html><body>bundle</body></html>', 'utf-8')
    return pathToFileURL(join(dir, 'index.html')).href
  }

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'genui-webview-'))
    sessions.clear()
    beforeRequestByPartition.clear()
    openExternalCalls.length = 0
    webContentsCreated = null
    __resetWebviewSecurityForTests()
    // Signed-in scoped window (same production wiring as the partition tests).
    setSyncTrustedProductSpaceAccountId('account-a')
    setRuntimeActiveProductSpaceAccount('account-a')
    setRuntimeActiveProductSpace('space-a')
    setWebviewScopeResolver({ getWorkspaceForWebContentsId: id => `ws-${id}` })
    installWebviewSecurityHandlers()
    // Production wiring: the genui RPC handler registration installs the real
    // Main-trusted src validator over these session/storage deps.
    setGenUiGuestSrcValidator(createGenUiGuestSrcValidator({
      sessionManager: {
        getWorkspaces: () => [{ id: 'ws-1', rootPath: dataRoot }],
        getSessionPath: (sessionId: string) => join(dataRoot, 'sessions', sessionId),
      },
      sessionStorage: {
        getSessionPath: (root: string, id: string) => join(root, 'sessions', id),
        getDataPath: (root: string, id: string) => join(root, 'sessions', id, 'data'),
      },
    }))
  })

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true })
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

  it('allows a genui-app partition with a trusted bundle src and installs its policy', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)
    const src = bundleSrc()

    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'genui-app-sess-1' },
      { src },
    )

    expect(preventDefault).not.toHaveBeenCalled()
    const ses = sessions.get('genui-app-sess-1')
    expect(ses).toBeDefined()
    expect(ses!.permissionChecks).toBe(1)
    expect(ses!.permissionRequests).toBe(1)
    expect(beforeRequestByPartition.has('genui-app-sess-1')).toBe(true)
  })

  it('installs the same gate before a browserView carrier is registered, then permits only its exact session', () => {
    const carrier = { ...makeWindow(707), getType: () => 'browserView' }
    webContentsCreated!({}, carrier)
    const probe = (partition: string, src: string) => {
      const preventDefault = mock(() => {})
      carrier.emit('will-attach-webview', { preventDefault }, { partition }, { src })
      return preventDefault.mock.calls.length > 0
    }
    expect(probe('genui-app-sess-1', bundleSrc())).toBe(true)
    registerGenUiCarrier(707, 'sess-1')
    expect(probe('genui-app-sess-1', bundleSrc())).toBe(false)
    expect(probe('genui-app-sess-2', bundleSrc())).toBe(true)
    expect(probe('persist:browser-pane', 'https://example.com')).toBe(true)
    expect(probe('genui-app-sess-1', 'file:///etc/hosts')).toBe(true)
    unregisterGenUiCarrier(707)
    expect(probe('genui-app-sess-1', bundleSrc())).toBe(true)
  })

  it('allows an inline data: src without any validator path check', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'genui-app-sess-1' },
      { src: `data:text/html;charset=utf-8,${encodeURIComponent('<p>hi</p>')}` },
    )

    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('refuses a genui webview whose initial src is not a session bundle or data: URL', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    const outside = pathToFileURL(join(dataRoot, 'sessions', 'sess-1', 'secret.txt')).href
    for (const src of [
      outside, // a real file under the session dir, but not a generated bundle
      pathToFileURL('/etc/passwd').href, // arbitrary host file
      'https://evil.example/app.html', // remote document
      'file:///nonexistent/genui-apps/app-1/index.html', // bundle-shaped but wrong root
      '', // empty
    ]) {
      const preventDefault = mock(() => {})
      window.emit(
        'will-attach-webview',
        { preventDefault },
        { partition: 'genui-app-sess-1' },
        { src },
      )
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }
    // A bundle of ANOTHER session never loads either.
    const otherSessionBundle = pathToFileURL(
      join(dataRoot, 'sessions', 'sess-2', 'data', 'genui-apps', 'app-1', 'index.html'),
    ).href
    mkdirSync(join(dataRoot, 'sessions', 'sess-2', 'data', 'genui-apps', 'app-1'), { recursive: true })
    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'genui-app-sess-1' },
      { src: otherSessionBundle },
    )
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('still refuses a persist:-prefixed impersonation of the genui namespace', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)

    const preventDefault = mock(() => {})
    window.emit(
      'will-attach-webview',
      { preventDefault },
      { partition: 'persist:genui-app-sess-1' },
      { src: bundleSrc() },
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
      { src: bundleSrc() },
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
      { src: bundleSrc() },
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
      { src: bundleSrc() },
    )

    const guest = makeGuest('genui-app-sess-1')
    webContentsCreated!({}, guest)
    const preventDefault = mock(() => {})
    guest.emit('will-navigate', { preventDefault }, 'https://evil.example/next')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('installs a deny-all permission policy on genui partitions, separate from browser-pane', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)
    window.emit(
      'will-attach-webview',
      { preventDefault: mock(() => {}) },
      { partition: 'genui-app-sess-1' },
      { src: bundleSrc() },
    )

    const genui = sessions.get('genui-app-sess-1')!
    // The canvas policy is deny-all: no clipboard, geolocation, media,
    // notifications — nothing.
    for (const permission of ['clipboard-read', 'geolocation', 'media', 'notifications', 'fullscreen']) {
      expect(genui.permissionCheckHandler!(null, permission, 'file:///')).toBe(false)
      let requestAllowed = true
      genui.permissionRequestHandler!(null, permission, (allow: boolean) => {
        requestAllowed = allow
      }, { requestingOrigin: 'file:///' })
      expect(requestAllowed).toBe(false)
    }

    // The browser-pane partition keeps its own, deliberately looser set.
    const browserPane = electronMock.session.fromPartition('persist:browser-pane') as FakeSession
    expect(browserPane.permissionCheckHandler!(null, 'clipboard-read', 'https://x')).toBe(true)
    expect(browserPane.permissionCheckHandler!(null, 'geolocation', 'https://x')).toBe(true)
    // ...while a canvas partition is never granted it, even for permissions in
    // the loose set's membership: the redirect guard sent it to the deny-all
    // policy instead (asserted once more for the exact same permission).
    expect(genui.permissionCheckHandler!(null, 'clipboard-read', 'file:///')).toBe(false)
  })

  it('fences genui guest requests to file:/data:/blob: and cancels everything else', () => {
    const window = makeWindow(7)
    webContentsCreated!({}, window)
    window.emit(
      'will-attach-webview',
      { preventDefault: mock(() => {}) },
      { partition: 'genui-app-sess-1' },
      { src: bundleSrc() },
    )

    const fence = beforeRequestByPartition.get('genui-app-sess-1')
    expect(fence).toBeDefined()
    const decide = (url: string): unknown => {
      let result: unknown
      fence!({ url, resourceType: 'xhr' }, r => {
        result = r
      })
      return result
    }

    expect(decide('https://evil.example/beacon')).toEqual({ cancel: true })
    expect(decide('http://evil.example/beacon')).toEqual({ cancel: true })
    expect(decide('wss://evil.example/socket')).toEqual({ cancel: true })
    expect(decide('chrome-extension://abc/x')).toEqual({ cancel: true })
    expect(decide('not a url')).toEqual({ cancel: true })

    expect(decide(`file://${join(dataRoot, 'sessions', 'sess-1', 'data', 'genui-apps', 'app-1', 'index.html')}`)).toEqual({})
    expect(decide(`data:text/html,${encodeURIComponent('<p>x</p>')}`)).toEqual({})
    expect(decide('blob:file:///some-blob-id')).toEqual({})
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
