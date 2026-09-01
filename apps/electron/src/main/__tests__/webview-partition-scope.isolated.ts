import { beforeEach, describe, expect, it, mock } from 'bun:test'

type PartitionSession = {
  partition: string
  permissionChecks: number
  permissionRequests: number
  setPermissionCheckHandler(): void
  setPermissionRequestHandler(): void
}

const sessions = new Map<string, PartitionSession>()

const electronStub = () => () => {}
const electronMock = {
  app: { on: (_event: string, _listener: unknown) => {} },
  shell: { openExternal: async () => {} },
  webContents: electronStub,
  ipcMain: electronStub,
  BrowserWindow: electronStub,
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

mock.module('electron', () => electronMock)
mock.module('../browser-pane-manager', () => ({
  BROWSER_PANE_SESSION_PARTITION: 'persist:browser-pane',
}))
mock.module('../logger', () => ({ windowLog: {
  info() {}, warn() {}, error() {}, debug() {},
} }))
mock.module('../deep-link-log', () => ({ describeUrlForLog: (url: string) => url }))

const { tabAppPartitionForScope } = await import('../../shared/tab-browser-partition')
const {
  __resetWebviewSecurityForTests,
  installWebviewSecurityHandlers,
  setWebviewScopeResolver,
} = await import('../webview-security')

const trustedAccount = 'account-a'
const fenceSpace = 'space-a'

function makeGuestWebview(webContentsId: number) {
  return {
    getType: () => 'webview',
    hostWebContents: { id: webContentsId },
    setWindowOpenHandler() {},
    on() {},
  }
}

const { app } = electronMock as unknown as {
  app: { on: (event: string, listener: (_event: unknown, contents: ReturnType<typeof makeGuestWebview>) => void) => void }
}
let webviewCreatedListener: ((_event: unknown, contents: ReturnType<typeof makeGuestWebview>) => void) | null = null
;(electronMock.app as unknown as { on: (event: string, listener: unknown) => void }).on = (
  event: string,
  listener: unknown,
) => {
  if (event === 'web-contents-created') {
    webviewCreatedListener = listener as typeof webviewCreatedListener
  }
}

describe('ProductSpace webview partition policy wiring', () => {
  beforeEach(() => {
    sessions.clear()
    webviewCreatedListener = null
    __resetWebviewSecurityForTests()
  })

  it('installs permission check and request handlers on the trusted scoped partition', async () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => (webContentsId === 7 ? 'ws-a' : null),
      getAccountId: () => trustedAccount,
      getProductSpaceId: () => fenceSpace,
    })
    installWebviewSecurityHandlers()
    expect(webviewCreatedListener).toBeTruthy()

    webviewCreatedListener!({}, makeGuestWebview(7))
    // The async resolver attaches the policy before the guest navigates.
    await new Promise(resolve => setTimeout(resolve, 0))

    const expectedPartition = tabAppPartitionForScope({
      accountId: trustedAccount,
      productSpaceId: fenceSpace,
      workspaceId: 'ws-a',
    })
    const ses = sessions.get(expectedPartition)
    expect(ses).toBeDefined()
    expect(ses!.permissionChecks).toBe(1)
    expect(ses!.permissionRequests).toBe(1)
  })

  it('separates partitions per account, ProductSpace, and Workspace', async () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: webContentsId => (webContentsId === 7 ? 'ws-a' : webContentsId === 8 ? 'ws-b' : null),
      getAccountId: () => 'account-b',
      getProductSpaceId: () => 'space-b',
    })
    installWebviewSecurityHandlers()

    webviewCreatedListener!({}, makeGuestWebview(7))
    await new Promise(resolve => setTimeout(resolve, 0))

    const partitionA = tabAppPartitionForScope({ accountId: 'account-b', productSpaceId: 'space-b', workspaceId: 'ws-a' })
    const partitionB = tabAppPartitionForScope({ accountId: 'account-b', productSpaceId: 'space-b', workspaceId: 'ws-b' })
    expect(partitionA).not.toBe(partitionB)
    expect(sessions.get(partitionA)?.permissionRequests).toBe(1)
    // The other workspace's partition is never touched by this webview.
    expect(sessions.get(partitionB)).toBeUndefined()
  })

  it('installs no scoped policy when the scope cannot be resolved (fail-closed)', async () => {
    setWebviewScopeResolver({
      getWorkspaceForWebContentsId: () => null,
      getAccountId: () => null,
      getProductSpaceId: () => null,
    })
    installWebviewSecurityHandlers()

    const before = new Set(sessions.keys())
    webviewCreatedListener!({}, makeGuestWebview(42))
    await new Promise(resolve => setTimeout(resolve, 0))
    // An unresolvable scope creates no scoped partition at all (fail-closed);
    // only the base browser-pane partition may exist.
    expect([...sessions.keys()].filter(key => !before.has(key))).toEqual([])
  })
})
