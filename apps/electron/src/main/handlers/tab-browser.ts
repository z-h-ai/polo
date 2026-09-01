import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { createProductSpaceContextKey } from '@polo-ai/shared/product-spaces'
import type { AppDefinition } from '../../shared/tab-browser-types'
import type { HandlerDeps } from './handler-deps'
import { resolveTrustedProductSpaceAccountId } from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  isRuntimeFenceBoundToAccount,
} from '@polo-ai/server-core/runtime/product-space-executions'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.tabBrowser.GET_APPS,
  RPC_CHANNELS.tabBrowser.SAVE_APPS,
] as const

function normalizeApps(apps: unknown): AppDefinition[] {
  if (!Array.isArray(apps)) return []

  return apps
    .filter((app): app is AppDefinition => (
      Boolean(app)
      && typeof app.id === 'string'
      && typeof app.name === 'string'
      && typeof app.url === 'string'
      && (app.type === 'builtin' || app.type === 'webapp')
      && typeof app.createdAt === 'number'
      && typeof app.order === 'number'
    ))
    .map((app) => ({
      id: app.id,
      name: app.name,
      url: app.url,
      iconUrl: typeof app.iconUrl === 'string' ? app.iconUrl : undefined,
      type: app.type,
      createdAt: app.createdAt,
      order: app.order,
    }))
}

export interface TabBrowserDeps {
  windowManager?: HandlerDeps['windowManager']
}

/**
 * Derives the installed-apps partition key from Main-trusted state only:
 * the Admin session account, the committed ProductSpace fence bound to it,
 * and the calling window's Workspace. The renderer never names the scope —
 * a forged contextKey for another account/space cannot read or overwrite
 * that partition. Returns null for the pre-ProductSpace local-account
 * window (no committed fence), which keeps the legacy global store.
 */
async function deriveTrustedTabBrowserScope(
  webContentsId: number | null | undefined,
  deps: TabBrowserDeps,
): Promise<string | null> {
  const accountId = await resolveTrustedProductSpaceAccountId()
  if (!accountId) {
    // A genuinely signed-out local-account window: the legacy global store
    // is the only state this renderer ever owned.
    return null
  }
  // A signed-in window without a committed fence — contract-blocked, an
  // in-flight logout revoke, or startup before bootstrap — must never reach
  // the legacy fallback: the old Organization-era global list is not a
  // valid source for a ProductSpace renderer.
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(accountId)) {
    throw new Error('TAB_BROWSER_SCOPE_REQUIRED')
  }
  if (webContentsId == null) {
    throw new Error('TAB_BROWSER_SCOPE_REQUIRED')
  }
  const workspaceId = deps.windowManager?.getWorkspaceForWindow(webContentsId)
  if (!workspaceId) {
    throw new Error('TAB_BROWSER_SCOPE_REQUIRED')
  }
  return `${createProductSpaceContextKey(accountId as never, activeProductSpaceId as never)}::${workspaceId}`
}

/**
 * Installed tab-browser apps are account+ProductSpace+Workspace scoped. The
 * scope is always derived Main-side from trusted state; a ProductSpace
 * window can never fall back to (or write) the legacy global store, so a
 * personal-space app can never reappear after switching to an enterprise or
 * be planted into another account's partition.
 */
export function registerTabBrowserHandlers(server: RpcServer, deps: TabBrowserDeps = {}): void {
  server.handle(RPC_CHANNELS.tabBrowser.GET_APPS, async (ctx) => {
    const { loadStoredConfig } = await import('@polo-ai/shared/config/storage')
    const config = loadStoredConfig()
    const scope = await deriveTrustedTabBrowserScope(ctx.webContentsId, deps)
    if (scope === null) {
      return normalizeApps(config?.tabBrowser?.installedApps)
    }
    const scoped = config?.tabBrowser?.installedAppsByScope?.[scope]
    return normalizeApps(scoped ?? [])
  })

  server.handle(RPC_CHANNELS.tabBrowser.SAVE_APPS, async (ctx, apps: AppDefinition[]) => {
    const { updateStoredConfig } = await import('@polo-ai/shared/config/storage')
    const normalized = normalizeApps(apps)
    const scope = await deriveTrustedTabBrowserScope(ctx.webContentsId, deps)
    updateStoredConfig(config => {
      config.tabBrowser ??= { installedApps: [] }
      if (scope === null) {
        config.tabBrowser.installedApps = normalized
        return
      }
      const byScope = { ...(config.tabBrowser.installedAppsByScope ?? {}) }
      byScope[scope] = normalized
      config.tabBrowser.installedAppsByScope = byScope
    })
  })
}
