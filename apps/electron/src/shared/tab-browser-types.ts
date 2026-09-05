export type AppDefinitionType = 'builtin' | 'webapp'
export type TabInstanceType = 'home' | 'polo' | 'webapp'

/**
 * Non-secret, immutable identity handed to the POO-47 Runtime boundary.
 * Delivery credentials deliberately stay out of persisted tab state.
 */
export interface ProductSpaceAppLaunchContext {
  accountId: string
  productSpaceId: string
  catalogEntryId: string
  artifactInstanceId: string
  versionId: string
  version: string
  deliveryKind: 'web_url' | 'bundle'
  resolvedAt: string
  expiresAt: string
}

export interface AppDefinition {
  id: string
  name: string
  url: string
  iconUrl?: string
  type: AppDefinitionType
  createdAt: number
  order: number
  launchContext?: ProductSpaceAppLaunchContext
}

export interface TabInstance {
  id: string
  appId: string
  type: TabInstanceType
  title: string
  favicon?: string
  isLoading?: boolean
  url?: string
  launchContext?: ProductSpaceAppLaunchContext
}

export const HOME_TAB_ID = 'home'
export const POLO_APP_ID = 'polo-ai'
export const POLO_TAB_ID = 'polo-ai-tab'

export const POLO_APP_DEFINITION: AppDefinition = {
  id: POLO_APP_ID,
  name: 'Polo 助手',
  url: 'poloai://app',
  type: 'builtin',
  createdAt: 0,
  order: 0,
}

export const BUILTIN_APP_DEFINITIONS: AppDefinition[] = [
  POLO_APP_DEFINITION,
]

export const BUILTIN_APP_IDS = new Set(BUILTIN_APP_DEFINITIONS.map((a) => a.id))

export const HOME_TAB: TabInstance = {
  id: HOME_TAB_ID,
  appId: HOME_TAB_ID,
  type: 'home',
  title: 'Home',
}

export const POLO_TAB: TabInstance = {
  id: POLO_TAB_ID,
  appId: POLO_APP_ID,
  type: 'polo',
  title: 'Polo 助手',
}

export function createTabId(prefix = 'tab'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeInstalledApps(apps: AppDefinition[] | undefined | null): AppDefinition[] {
  const webApps = (Array.isArray(apps) ? apps : [])
    .filter((app) => app && !BUILTIN_APP_IDS.has(app.id) && app.type === 'webapp')
    .map((app, index) => ({
      ...app,
      order: Number.isFinite(app.order) ? app.order : index + BUILTIN_APP_DEFINITIONS.length,
    }))
    .sort((a, b) => a.order - b.order)

  return [...BUILTIN_APP_DEFINITIONS, ...webApps]
}
