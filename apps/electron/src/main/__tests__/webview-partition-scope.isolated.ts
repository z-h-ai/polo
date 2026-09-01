import { beforeEach, describe, expect, it, mock } from 'bun:test'

type PartitionSession = {
  partition: string
  permissionChecks: number
  permissionRequests: number
  clearStorageDataCalls: number
  setPermissionCheckHandler(): void
  setPermissionRequestHandler(): void
  clearStorageData(): Promise<void>
}

const sessions = new Map<string, PartitionSession>()

const electronMock = {
  app: {
    on: (_event: string, _listener: (...args: unknown[]) => void) => {},
  },
  shell: { openExternal: async () => {} },
  session: {
    fromPartition: (partition: string) => {
      let ses = sessions.get(partition)
      if (!ses) {
        ses = {
          partition,
          permissionChecks: 0,
          permissionRequests: 0,
          clearStorageDataCalls: 0,
          setPermissionCheckHandler() {
            ses!.permissionChecks += 1
          },
          setPermissionRequestHandler() {
            ses!.permissionRequests += 1
          },
          clearStorageData: async () => {
            ses!.clearStorageDataCalls += 1
          },
        }
        sessions.set(partition, ses)
      }
      return ses
    },
  },
}

mock.module('electron', () => electronMock)
mock.module('../browser-pane-manager', () => ({
  BROWSER_PANE_SESSION_PARTITION: 'persist:browser-pane',
}))
mock.module('../logger', () => ({ windowLog: {
  info() {}, warn() {}, error() {}, debug() {},
} }))
mock.module('../deep-link-log', () => ({ describeUrlForLog: (url: string) => url }))

const { tabAppPartitionForScope, legacyTabAppPartitionForScope } = await import('../../shared/tab-browser-partition')
const {
  __resetWebviewSecurityForTests,
  installWebviewSecurityHandlers,
  setWebviewScopeResolver,
} = await import('../webview-security')
const {
  revokeRuntimeProductSpaceFence,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} = await import('@polo-ai/server-core/runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId, getSyncTrustedProductSpaceAccountId } = await import(
  '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
)
const { getRuntimeActiveProductSpace } = await import(
  '@polo-ai/server-core/runtime/product-space-executions'
)

const trustedAccount = 'account-a'
const fenceSpace = 'space-a'

type GuestContents = { getType: () => string; hostWebContents: { id: number } }
type HostContents = {
  getType: () => string
  id: number
  on: (event: string, handler: (...args: unknown[]) => void) => void
}
let webviewCreatedListener: ((_event: unknown, contents: GuestContents | HostContents) => void) | null = null
;(electronMock.app as unknown as { on: (event: string, listener: unknown) => void }).on = (
  event: string,
  listener: unknown,
) => {
  if (event === 'web-contents-created') {
    webviewCreatedListener = listener as typeof webviewCreatedListener
  }
}

function makeHostWindow(webContentsId: number): HostContents {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const window = {
    getType: () => 'window',
    id: webContentsId,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
    },
    setWindowOpenHandler: () => {},
  }
  return Object.assign(window, {
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  }) as HostContents & { emit: (event: string, ...args: unknown[]) => void }
}

function hostPartition(window: HostContents): string {
  return tabAppPartitionForScope({
    accountId: trustedAccount,
    productSpaceId: fenceSpace,
    workspaceId: `ws-${window.id}`,
  })
}

describe('ProductSpace webview partition policy wiring', () => {
  beforeEach(() => {
    sessions.clear()
    webviewCreatedListener = null
    __resetWebviewSecurityForTests()
    // Production wiring: the Admin session is authenticated for the account
    // (sync mirror) and the fence is committed and bound to it.
    setSyncTrustedProductSpaceAccountId(trustedAccount)
    setRuntimeActiveProductSpaceAccount(trustedAccount)
    setRuntimeActiveProductSpace(fenceSpace)
  })

  it('enforces the exact derived partition and installs its policy at attach', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()
    expect(webviewCreatedListener).toBeTruthy()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const expectedPartition = hostPartition(window)
    const preventDefault = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault },
      { partition: expectedPartition },
      { src: 'https://app.example' },
    )

    expect(preventDefault).not.toHaveBeenCalled()
    const ses = sessions.get(expectedPartition)
    expect(ses).toBeDefined()
    expect(ses!.permissionChecks).toBe(1)
    expect(ses!.permissionRequests).toBe(1)
  })

  it('blocks a guest pointing at another (victim) partition', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const victimPartition = tabAppPartitionForScope({
      accountId: 'account-victim',
      productSpaceId: 'space-victim',
      workspaceId: 'ws-victim',
    })
    const preventDefault = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault },
      { partition: victimPartition },
      { src: 'https://evil.example' },
    )

    expect(preventDefault).toHaveBeenCalledTimes(1)
    // The victim partition receives no policy and is never created.
    expect(sessions.get(victimPartition)).toBeUndefined()
  })

  it('blocks a guest without any partition', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const preventDefault = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault },
      {},
      { src: 'https://app.example' },
    )
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('recomputes the expected partition when the fence account changes', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const oldPartition = hostPartition(window)

    // Account replacement: the fence is now bound to account B on space B,
    // and the replacement login committed B into the authenticated mirror.
    setRuntimeActiveProductSpaceAccount('account-b')
    setRuntimeActiveProductSpace('space-b')
    setSyncTrustedProductSpaceAccountId('account-b')
    const newPartition = tabAppPartitionForScope({
      accountId: 'account-b',
      productSpaceId: 'space-b',
      workspaceId: 'ws-7',
    })

    const preventDefault = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault },
      { partition: oldPartition },
      { src: 'https://app.example' },
    )
    // The stale partition from the previous account is refused.
    expect(preventDefault).toHaveBeenCalledTimes(1)

    const attachB = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: attachB },
      { partition: newPartition },
      { src: 'https://app.example' },
    )
    expect(attachB).not.toHaveBeenCalled()
    expect(sessions.get(newPartition)?.permissionRequests).toBe(1)
  })

  it('allows only the browser-pane partition for local-account windows', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    // A genuinely signed-out window: no authenticated Admin session and no
    // committed fence.
    setSyncTrustedProductSpaceAccountId(null)
    setRuntimeActiveProductSpace(null)
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const tabAppPartition = tabAppPartitionForScope({
      accountId: 'account-a',
      productSpaceId: 'space-a',
      workspaceId: 'ws-7',
    })

    // A scoped partition without a committed fence is refused.
    const preventScoped = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventScoped },
      { partition: tabAppPartition },
      { src: 'https://app.example' },
    )
    expect(preventScoped).toHaveBeenCalledTimes(1)

    // The local-account window may keep the shared browser-pane partition.
    const preventPane = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventPane },
      { partition: 'persist:browser-pane' },
      { src: 'https://app.example' },
    )
    expect(preventPane).not.toHaveBeenCalled()
  })

  it('prevents every partition when a committed fence has no trusted Workspace mapping', () => {
    // Active fence, but the window→Workspace mapping cannot be resolved:
    // the scope is incomplete, so even the shared browser-pane partition is
    // refused (a signed-in renderer must never land in a cross-workspace
    // shared session).
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: () => null,
    })
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)

    const preventPane = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventPane },
      { partition: 'persist:browser-pane' },
      { src: 'https://app.example' },
    )
    expect(preventPane).toHaveBeenCalledTimes(1)

    const preventScoped = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventScoped },
      { partition: tabAppPartitionForScope({ accountId: trustedAccount, productSpaceId: fenceSpace, workspaceId: 'ws-guess' }) },
      { src: 'https://app.example' },
    )
    expect(preventScoped).toHaveBeenCalledTimes(1)
  })

  it('prevents every partition after a real fence revoke while the session stays authenticated', async () => {
    // The production revoke sequence: the fence is revoked (which also
    // clears the fence account) while the Admin session remains
    // authenticated for account-a. This is NOT local-account mode — the
    // shared browser-pane partition must be refused.
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()

    await revokeRuntimeProductSpaceFence()
    expect(getSyncTrustedProductSpaceAccountId()).toBe(trustedAccount)
    expect(getRuntimeActiveProductSpace()).toBeNull()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)

    const preventPane = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventPane },
      { partition: 'persist:browser-pane' },
      { src: 'https://app.example' },
    )
    expect(preventPane).toHaveBeenCalledTimes(1)

    const preventScoped = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventScoped },
      { partition: tabAppPartitionForScope({ accountId: trustedAccount, productSpaceId: fenceSpace, workspaceId: 'ws-7' }) },
      { src: 'https://app.example' },
    )
    expect(preventScoped).toHaveBeenCalledTimes(1)
  })

  it('prevents every partition when signed in but the fence is missing', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    // Contract-blocked / pre-bootstrap state: the fence is gone while the
    // authenticated session mirror still names the account.
    setSyncTrustedProductSpaceAccountId(trustedAccount)
    setRuntimeActiveProductSpace(null)
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    const preventPane = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventPane },
      { partition: 'persist:browser-pane' },
      { src: 'https://app.example' },
    )
    expect(preventPane).toHaveBeenCalledTimes(1)
  })

  it('clears the superseded legacy partition once the scoped gate first engages', () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: mock(() => {}) },
      { partition: hostPartition(window) },
      { src: 'https://app.example' },
    )

    const legacyPartition = legacyTabAppPartitionForScope({
      accountId: trustedAccount,
      productSpaceId: fenceSpace,
      workspaceId: 'ws-7',
    })
    const legacySession = sessions.get(legacyPartition)
    expect(legacySession).toBeDefined()
    expect(legacySession!.clearStorageDataCalls).toBe(1)
  })
})
