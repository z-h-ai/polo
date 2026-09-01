import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { AppDefinition } from '../../shared/tab-browser-types'

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

function isValidScope(scope: unknown): scope is string {
  return typeof scope === 'string' && scope.length > 0 && scope.length <= 256
}

/**
 * Installed tab-browser apps are account+ProductSpace scoped: the renderer
 * passes its verified ProductSpace context key, and every scope reads and
 * writes only its own partition. A scopeless call keeps the pre-ProductSpace
 * legacy global store for local-account windows only — a ProductSpace-scoped
 * window never falls back to (or writes) the legacy global list, so a
 * personal-space app can never reappear after switching to an enterprise.
 */
export function registerTabBrowserHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.tabBrowser.GET_APPS, async (_ctx, rawScope?: unknown) => {
    const { loadStoredConfig } = await import('@polo-ai/shared/config/storage')
    const config = loadStoredConfig()
    if (isValidScope(rawScope)) {
      const scoped = config?.tabBrowser?.installedAppsByScope?.[rawScope]
      return normalizeApps(scoped ?? [])
    }
    return normalizeApps(config?.tabBrowser?.installedApps)
  })

  server.handle(RPC_CHANNELS.tabBrowser.SAVE_APPS, async (_ctx, apps: AppDefinition[], rawScope?: unknown) => {
    const { updateStoredConfig } = await import('@polo-ai/shared/config/storage')
    const normalized = normalizeApps(apps)
    updateStoredConfig(config => {
      config.tabBrowser ??= { installedApps: [] }
      if (isValidScope(rawScope)) {
        const byScope = { ...(config.tabBrowser.installedAppsByScope ?? {}) }
        byScope[rawScope] = normalized
        config.tabBrowser.installedAppsByScope = byScope
        return
      }
      config.tabBrowser.installedApps = normalized
    })
  })
}
