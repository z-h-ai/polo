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

export function registerTabBrowserHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.tabBrowser.GET_APPS, async () => {
    const { loadStoredConfig } = await import('@polo-ai/shared/config/storage')
    const config = loadStoredConfig()
    return normalizeApps(config?.tabBrowser?.installedApps)
  })

  server.handle(RPC_CHANNELS.tabBrowser.SAVE_APPS, async (_ctx, apps: AppDefinition[]) => {
    const { loadStoredConfig, saveConfig } = await import('@polo-ai/shared/config/storage')
    const config = loadStoredConfig()
    if (!config) return
    config.tabBrowser = { installedApps: normalizeApps(apps) }
    saveConfig(config)
  })
}
