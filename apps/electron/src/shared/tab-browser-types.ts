export type AppDefinitionType = 'builtin' | 'webapp'
// POO-205 Spec §10: a project tab IS the project's assistant workspace —
// its title is the project name, so the user always knows which project
// they are talking in. One open project = one tab; several projects coexist.
export type TabInstanceType = 'home' | 'polo' | 'webapp' | 'project'

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
}

export interface TabInstance {
  id: string
  appId: string
  type: TabInstanceType
  title: string
  favicon?: string
  isLoading?: boolean
  url?: string
  /** Ephemeral ProductSpace App tab. Its local UI URL must never be persisted/restored. */
  productSpaceApp?: { accountId: string; productSpaceId: string; contextVersion: number }
  /** POO-205 §10: the project this tab hosts. Present exactly when
   * type === 'project'; the tab title mirrors `name` and refreshes with it. */
  project?: {
    projectId: string
    name: string
    purpose?: string
    instructions?: string
    organizationEnterpriseId: string
    organizationProductSpaceId: string
    myRole: 'owner' | 'manager' | 'member'
  }
  runtimeError?: string
  /** Explicit background choice hides the tab while retaining its guest. */
  background?: boolean
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

// POO-205 (Spec Q5/Q6): chat is a base capability, not a catalog app. The
// enterprise knowledge base built-in app/tab retired — knowledge now flows
// through the project shared-file area. The catalog's only built-in entry is
// the assistant itself.
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

/** Stable tab id for a project tab — re-entering the same project focuses
 * the existing tab instead of stacking a duplicate. */
export function projectTabId(projectId: string): string {
  return `project-${projectId}`
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

// ── POO-205 C4 (R6): keyboard tab navigation over VISIBLE tabs ──────────────
// Pure helpers so the ⌘-digit and ⌘⇧[ ] mappings are unit-testable. Both take
// the VISIBLE tab list (visibleTabsAtom — the Polo tab already filtered out in
// an enterprise space), never the raw persisted list.

export type TabShortcutTarget =
  | { kind: 'home' }
  | { kind: 'tab'; tabId: string }
  | { kind: 'none' }

/**
 * ⌘1 = Home; ⌘2…⌘9 = the 1st…8th visible tab, in strip order. A digit beyond
 * the strip (and ⌘1's Home is always available) answers 'none' — the shell
 * keeps the previous tab rather than guessing.
 */
export function resolveTabShortcutTarget(digit: number, visibleTabs: ReadonlyArray<Pick<TabInstance, 'id'>>): TabShortcutTarget {
  if (digit === 1) return { kind: 'home' }
  const tab = visibleTabs[digit - 2]
  return tab ? { kind: 'tab', tabId: tab.id } : { kind: 'none' }
}

/**
 * ⌘⇧[ / ⌘⇧] cycles Home ⇄ the visible tabs, in strip order, wrapping at both
 * ends. Unknown active ids (a tab closed between keypress and handler) ride
 * as index 0 — the cycle simply starts over from Home.
 */
export function cycleVisibleTab(activeTabId: string, visibleTabs: ReadonlyArray<Pick<TabInstance, 'id'>>, direction: 1 | -1): TabShortcutTarget {
  const sequence = [HOME_TAB_ID, ...visibleTabs.map((tab) => tab.id)]
  const currentIndex = Math.max(0, sequence.indexOf(activeTabId))
  const nextIndex = (currentIndex + direction + sequence.length) % sequence.length
  const nextId = sequence[nextIndex]!
  return nextId === HOME_TAB_ID ? { kind: 'home' } : { kind: 'tab', tabId: nextId }
}
