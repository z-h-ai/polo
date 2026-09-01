import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The real credential manager reads this env at backend construction; set it
// before any test drives a restore so the store lives in a temp directory.
const credentialStoreRoot = mkdtempSync(join(tmpdir(), 'webview-partition-credentials-'))
process.env.POLO_AI_SHARED_CREDENTIALS_DIR = credentialStoreRoot

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
const {
  setSyncTrustedProductSpaceAccountId,
  setSyncTrustedProductSpaceAccountState,
  getSyncTrustedProductSpaceAccountId,
  getSyncTrustedProductSpaceAccountState,
} = await import(
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

  it('blocks every partition while the initial credential restore has not completed', () => {
    // Startup sequence regression: a persisted Admin session exists on
    // disk, but the first trusted capture has not completed yet — the sync
    // mirror is `unknown`. Neither the shared browser-pane partition nor a
    // guessed scoped partition may load.
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    setSyncTrustedProductSpaceAccountState({ status: 'unknown' })
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
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
      { partition: tabAppPartitionForScope({ accountId: trustedAccount, productSpaceId: fenceSpace, workspaceId: 'ws-7' }) },
      { src: 'https://app.example' },
    )
    expect(preventScoped).toHaveBeenCalledTimes(1)
    expect(getSyncTrustedProductSpaceAccountState().status).toBe('unknown')
  })

  it('allows the browser-pane partition once the restore confirms no session', () => {
    // Startup sequence regression: the initial capture completed and
    // explicitly found no persisted session — the confirmed signed-out
    // local-account window keeps its shared partition.
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => `ws-${webContentsId}`,
    })
    setSyncTrustedProductSpaceAccountState({ status: 'signed_out' })
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    installWebviewSecurityHandlers()

    const window = makeHostWindow(7)
    webviewCreatedListener!({}, window)
    expect(getSyncTrustedProductSpaceAccountState().status).toBe('signed_out')

    const preventPane = mock(() => {})
    ;(window as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      'will-attach-webview',
      { preventDefault: preventPane },
      { partition: 'persist:browser-pane' },
      { src: 'https://app.example' },
    )
    expect(preventPane).not.toHaveBeenCalled()
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


describe('startup credential restore → webview attach gate (integration)', () => {
  afterAll(() => {
    try {
      rmSync(credentialStoreRoot, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of the temp credential store.
    }
    delete process.env.POLO_AI_SHARED_CREDENTIALS_DIR
  })

  const storeFile = join(credentialStoreRoot, 'credentials.enc')
  const adminHandlersDeps = {
    sessionManager: {},
    oauthFlowStore: {},
    platform: {
      appRootPath: credentialStoreRoot,
      resourcesPath: credentialStoreRoot,
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info() {}, warn() {}, error() {}, debug() {},
      },
      imageProcessor: {
        async getMetadata() { return null },
        async process() { return Buffer.from('') },
      },
    },
  } as never

  beforeEach(() => {
    sessions.clear()
    webviewCreatedListener = null
    __resetWebviewSecurityForTests()
    setSyncTrustedProductSpaceAccountState({ status: 'unknown' })
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    if (existsSync(storeFile)) rmSync(storeFile)
  })

  it('a corrupted credentials.enc keeps the gate unknown and refuses every partition', async () => {
    // A real store file that cannot be decrypted (wrong magic bytes).
    writeFileSync(storeFile, Buffer.from('corrupted-not-a-credential-store-'.repeat(8)))

    const { registerAdminHandlers } = await import('@polo-ai/server-core/handlers/rpc/admin')
    const { whenInitialSyncTrustedProductSpaceAccountRestored } = await import(
      '@polo-ai/server-core/handlers/rpc/admin'
    )
    const server = {
      handle() {},
      push() {},
      async invokeClient() { return null },
    }
    registerAdminHandlers(server as never, adminHandlersDeps)
    await whenInitialSyncTrustedProductSpaceAccountRestored()

    // The unreadable store must NOT have been committed as signed_out.
    expect(getSyncTrustedProductSpaceAccountState()).toEqual({ status: 'unknown' })

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
      { partition: tabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a', workspaceId: 'ws-7' }) },
      { src: 'https://app.example' },
    )
    expect(preventScoped).toHaveBeenCalledTimes(1)
  })

  it('keeps the gate unknown when the credential directory denies access', async () => {
    // A real, valid store exists — but the directory denies traversal
    // (EACCES). existsSync() would report false; the inspect path must
    // classify this as unreadable instead of absent.
    const { getCredentialManager } = await import('@polo-ai/shared/credentials')
    await getCredentialManager().setAdminTokens({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      userId: 'account-a',
      username: 'account-a',
    })
    const { chmodSync } = await import('node:fs')
    chmodSync(credentialStoreRoot, 0o000)
    try {
      const { registerAdminHandlers } = await import('@polo-ai/server-core/handlers/rpc/admin')
      const { whenInitialSyncTrustedProductSpaceAccountRestored } = await import(
        '@polo-ai/server-core/handlers/rpc/admin'
      )
      registerAdminHandlers(
        { handle() {}, push() {}, async invokeClient() { return null } } as never,
        adminHandlersDeps,
      )
      await whenInitialSyncTrustedProductSpaceAccountRestored()

      expect(getSyncTrustedProductSpaceAccountState()).toEqual({ status: 'unknown' })

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
        { partition: tabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a', workspaceId: 'ws-7' }) },
        { src: 'https://app.example' },
      )
      expect(preventScoped).toHaveBeenCalledTimes(1)
    } finally {
      chmodSync(credentialStoreRoot, 0o755)
    }
  })

  it('keeps the gate unknown when the stored admin token entry has malformed field types', async () => {
    // The store decrypts and parses, but the admin_token entry carries a
    // string expiresAt — an invalid, not absent, credential.
    const { getCredentialManager } = await import('@polo-ai/shared/credentials')
    await getCredentialManager().set({
      type: 'admin_token',
    }, {
      type: 'admin_token',
      value: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 'not-a-number' as unknown as number,
      userId: 'account-a',
      username: 'account-a',
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const { registerAdminHandlers } = await import('@polo-ai/server-core/handlers/rpc/admin')
    const { whenInitialSyncTrustedProductSpaceAccountRestored } = await import(
      '@polo-ai/server-core/handlers/rpc/admin'
    )
    registerAdminHandlers(
      { handle() {}, push() {}, async invokeClient() { return null } } as never,
      adminHandlersDeps,
    )
    await whenInitialSyncTrustedProductSpaceAccountRestored()

    expect(getSyncTrustedProductSpaceAccountState()).toEqual({ status: 'unknown' })

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

  it('validates the decrypted store schema before trusting it', async () => {
    const { isCredentialStoreShape } = await import('@polo-ai/shared/credentials')

    expect(typeof isCredentialStoreShape).toBe('function')
    expect(isCredentialStoreShape({
      version: 1,
      credentials: { admin_token: { value: 'v' } },
      metadata: { createdAt: 1, updatedAt: 2 },
    })).toBe(true)
    // Wrong version, array credentials container, missing metadata, and
    // non-object payloads are all rejected instead of asserted.
    expect(validate(false)).toBe(false)
    expect(validate({ version: 2, credentials: {}, metadata: { createdAt: 1, updatedAt: 2 } })).toBe(false)
    expect(validate({ version: 1, credentials: [], metadata: { createdAt: 1, updatedAt: 2 } })).toBe(false)
    expect(validate({ version: 1, credentials: {} })).toBe(false)
    expect(validate(null)).toBe(false)
    expect(validate('store')).toBe(false)

    function validate(value: unknown): boolean {
      return isCredentialStoreShape(value)
    }
  })

    it('a confirmed-empty store commits signed_out and keeps the browser-pane partition', async () => {
    // No credentials.enc at all: the restore explicitly confirms signed-out.
    const { registerAdminHandlers } = await import('@polo-ai/server-core/handlers/rpc/admin')
    const { whenInitialSyncTrustedProductSpaceAccountRestored } = await import(
      '@polo-ai/server-core/handlers/rpc/admin'
    )
    const server = {
      handle() {},
      push() {},
      async invokeClient() { return null },
    }
    registerAdminHandlers(server as never, adminHandlersDeps)
    await whenInitialSyncTrustedProductSpaceAccountRestored()

    expect(getSyncTrustedProductSpaceAccountState()).toEqual({ status: 'signed_out' })

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
    expect(preventPane).not.toHaveBeenCalled()
  })
})
