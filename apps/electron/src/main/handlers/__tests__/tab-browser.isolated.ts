import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { createProductSpaceContextKey } from '@polo-ai/shared/product-spaces'

type Handler = (
  context: { clientId: string; webContentsId: number | null; signal: AbortSignal },
  ...args: unknown[]
) => unknown

const trustedAccount = 'account-trusted'
const otherAccount = 'account-other'
const fenceSpace = 'space-fence'
const victimContextKey = createProductSpaceContextKey(
  'account-victim' as never,
  'space-victim' as never,
)

const { registerTabBrowserHandlers } = await import('../tab-browser')
const {
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} = await import('@polo-ai/server-core/runtime/product-space-executions')
const { setTrustedProductSpaceAccountProvider } = await import(
  '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
)

describe('tab-browser installed-apps scope derivation (Main-trusted)', () => {
  const handlers = new Map<string, Handler>()
  const windowWorkspaces = new Map<number, string>([[1, 'ws-a'], [2, 'ws-b']])
  const context = {
    clientId: 'renderer',
    webContentsId: 1 as number | null,
    signal: new AbortController().signal,
  }

  beforeEach(() => {
    handlers.clear()
    const server = {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler)
      },
      push() {},
      async invokeClient() {
        return null
      },
    } as unknown as RpcServer
    registerTabBrowserHandlers(server, {
      windowManager: {
        getWorkspaceForWindow: (webContentsId: number) => windowWorkspaces.get(webContentsId) ?? null,
      },
    } as never)
    setTrustedProductSpaceAccountProvider(async () => trustedAccount)
    setRuntimeActiveProductSpace(fenceSpace)
    setRuntimeActiveProductSpaceAccount(trustedAccount)
    // Seed two partitions plus the legacy store.
    const { updateStoredConfig, loadStoredConfig } = require('@polo-ai/shared/config/storage') as {
      updateStoredConfig: (mutate: (config: {
        tabBrowser?: {
          installedApps?: unknown[]
          installedAppsByScope?: Record<string, unknown[]>
        }
      }) => void) => void
      loadStoredConfig: () => {
        tabBrowser?: {
          installedApps?: unknown[]
          installedAppsByScope?: Record<string, unknown[]>
        }
      } | null
    }
    updateStoredConfig(config => {
      config.tabBrowser = {
        installedApps: [{ id: 'legacy-app', name: 'Legacy', url: 'https://legacy.example', type: 'webapp', createdAt: 1, order: 0 }],
        installedAppsByScope: {
          [victimContextKey]: [{ id: 'victim-app', name: 'Victim', url: 'https://victim.example', type: 'webapp', createdAt: 1, order: 0 }],
          [`${createProductSpaceContextKey(trustedAccount as never, fenceSpace as never)}::ws-a`]: [
            { id: 'own-app', name: 'Own', url: 'https://own.example', type: 'webapp', createdAt: 1, order: 0 },
          ],
        },
      }
    })
    expect(loadStoredConfig()?.tabBrowser?.installedAppsByScope?.[victimContextKey]).toBeDefined()
  })

  it('derives the partition Main-side and ignores any renderer-named scope', async () => {
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    // A forged victim scope argument is ignored: only the trusted derived
    // partition is read.
    expect(await getApps(context, victimContextKey)).toEqual([
      expect.objectContaining({ id: 'own-app' }),
    ])
    expect(await getApps(context, { scope: victimContextKey })).toEqual([
      expect.objectContaining({ id: 'own-app' }),
    ])
    expect(await getApps(context, '')).toEqual([
      expect.objectContaining({ id: 'own-app' }),
    ])
    // A different window workspace derives a different partition.
    const otherWindow = { ...context, webContentsId: 2 }
    expect(await getApps(otherWindow)).toEqual([])
  })

  it('keeps another account partition unreachable and unwritable', async () => {
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    const saveApps = handlers.get(RPC_CHANNELS.tabBrowser.SAVE_APPS)!
    const planted = [{ id: 'planted', name: 'Planted', url: 'https://evil.example', type: 'webapp' as const, createdAt: 2, order: 0 }]

    // A save can only ever land in the trusted derived partition — the
    // renderer cannot target the victim partition even by passing its key.
    await saveApps(context, planted as never, victimContextKey)
    const { loadStoredConfig } = require('@polo-ai/shared/config/storage') as {
      loadStoredConfig: () => {
        tabBrowser?: {
          installedAppsByScope?: Record<string, unknown[]>
        }
      } | null
    }
    const byScope = loadStoredConfig()?.tabBrowser?.installedAppsByScope ?? {}
    expect(byScope[victimContextKey]).toEqual([
      expect.objectContaining({ id: 'victim-app' }),
    ])
    expect(byScope[`${createProductSpaceContextKey(trustedAccount as never, fenceSpace as never)}::ws-a`])
      .toEqual([expect.objectContaining({ id: 'planted' })])
    expect(await getApps(context)).toEqual([expect.objectContaining({ id: 'planted' })])
  })

  it('fails closed for a fence bound to another account instead of the legacy store', async () => {
    setTrustedProductSpaceAccountProvider(async () => otherAccount)
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    await expect(getApps(context)).rejects.toThrow('TAB_BROWSER_SCOPE_REQUIRED')
  })

  it('fails closed when the calling window has no trusted Workspace', async () => {
    context.webContentsId = null
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    await expect(getApps(context)).rejects.toThrow('TAB_BROWSER_SCOPE_REQUIRED')
    context.webContentsId = 99
    await expect(getApps(context)).rejects.toThrow('TAB_BROWSER_SCOPE_REQUIRED')
    context.webContentsId = 1
  })

  it('fails closed when a signed-in window has no committed fence (no legacy fallback)', async () => {
    // Contract-blocked, mid-revoke, or pre-bootstrap: a signed-in renderer
    // with a trusted account but no committed fence must never read the
    // legacy Organization-era global store.
    setRuntimeActiveProductSpace(null)
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    const saveApps = handlers.get(RPC_CHANNELS.tabBrowser.SAVE_APPS)!
    await expect(getApps(context)).rejects.toThrow('TAB_BROWSER_SCOPE_REQUIRED')
    await expect(saveApps(context, [
      { id: 'planted', name: 'P', url: 'https://evil.example', type: 'webapp', createdAt: 1, order: 0 },
    ] as never)).rejects.toThrow('TAB_BROWSER_SCOPE_REQUIRED')
    const { loadStoredConfig } = require('@polo-ai/shared/config/storage') as {
      loadStoredConfig: () => {
        tabBrowser?: { installedApps?: Array<{ id: string }> }
      } | null
    }
    expect(loadStoredConfig()?.tabBrowser?.installedApps?.some(app => app.id === 'planted')).toBe(false)
  })

  it('keeps the legacy store for a genuinely signed-out local-account window', async () => {
    setRuntimeActiveProductSpace(null)
    setTrustedProductSpaceAccountProvider(async () => null)
    const getApps = handlers.get(RPC_CHANNELS.tabBrowser.GET_APPS)!
    expect(await getApps(context)).toEqual([
      expect.objectContaining({ id: 'legacy-app' }),
    ])
  })
})
