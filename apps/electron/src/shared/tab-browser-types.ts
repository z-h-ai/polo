export type AppDefinitionType = 'builtin' | 'webapp'
export type TabInstanceType = 'home' | 'polo' | 'webapp'

export interface AppDefinition {
  id: string
  name: string
  url: string
  iconUrl?: string
  type: AppDefinitionType
  createdAt: number
  order: number
}

export interface TabInstance {
  id: string
  appId: string
  type: TabInstanceType
  title: string
  favicon?: string
  isLoading?: boolean
  url?: string
}

export const HOME_TAB_ID = 'home'
export const POLO_APP_ID = 'polo-ai'
export const POLO_TAB_ID = 'polo-ai-tab'

export const POLO_APP_DEFINITION: AppDefinition = {
  id: POLO_APP_ID,
  name: 'Pro Buddy',
  url: 'poloai://app',
  type: 'builtin',
  createdAt: 0,
  order: 0,
}

export const KANBAN_APP_ID = 'kanban'
export const AIRDROP_APP_ID = 'airdrop'

export const KANBAN_APP_DEFINITION: AppDefinition = {
  id: KANBAN_APP_ID,
  name: 'Kanban',
  url: 'https://kb.z-h-ai.com/',
  type: 'builtin',
  createdAt: 0,
  order: 1,
}

export const AIRDROP_APP_DEFINITION: AppDefinition = {
  id: AIRDROP_APP_ID,
  name: 'AirDrop',
  url: 'https://airdrop.z-h-ai.com/',
  type: 'builtin',
  createdAt: 0,
  order: 2,
}

export const BUILTIN_APP_DEFINITIONS: AppDefinition[] = [
  POLO_APP_DEFINITION,
  KANBAN_APP_DEFINITION,
  AIRDROP_APP_DEFINITION,
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
  title: 'Pro Buddy',
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

export function isValidWebAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false

    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    if (host.startsWith('192.168.')) return true
    if (host.startsWith('10.')) return true

    const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    return private172
  } catch {
    return false
  }
}

export function normalizeWebAppUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
