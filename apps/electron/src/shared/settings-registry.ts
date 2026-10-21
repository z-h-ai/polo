/**
 * Settings Registry - Single Source of Truth
 *
 * This file defines all settings pages in one place. All other files that need
 * settings page information should import from here.
 *
 * To add a new settings page:
 * 1. Add an entry to SETTINGS_PAGES below
 * 2. Create the page component in renderer/pages/settings/
 * 3. Add to SETTINGS_PAGE_COMPONENTS in renderer/pages/settings/settings-pages.ts
 * 4. Add icon to SETTINGS_ICONS in renderer/components/icons/SettingsIcons.tsx
 *
 * That's it - types, routes, and validation are derived automatically.
 */

/**
 * Which settings surface a page belongs to, decided by the page's actual
 * consumer:
 * - `assistant` — context, tools and per-workspace behaviour consumed by the
 *   AI assistant (input, tools, workspace, permissions, labels, messaging,
 *   user preferences). Reached from the assistant sidebar Settings entry.
 * - `polo` — client-shell concerns (app behaviour, account security,
 *   appearance, shortcuts). Reached from the TopBar account menu.
 *
 * Scope only affects navigation grouping; it never changes storage location,
 * permission scope or toggle defaults.
 */
export type SettingsScope = 'assistant' | 'polo'

/**
 * Settings page definition
 */
export interface SettingsPageDefinition {
  /** Unique identifier used in routes and navigation */
  id: string
  /** i18n key for display label in settings navigator */
  labelKey: string
  /** i18n key for short description shown in settings navigator */
  descriptionKey: string
  /** Which settings surface this page is listed under */
  scope: SettingsScope
  /** Hide this page unless an Admin account is currently authenticated */
  requiresAdminLogin?: boolean
}

/**
 * The canonical list of all settings pages.
 * Order here determines display order in the settings navigator (per scope —
 * each navigator only lists pages of one scope, in this array's order).
 *
 * ADD NEW PAGES HERE - everything else derives from this list.
 *
 * NOTE: labelKey/descriptionKey are i18n translation keys, resolved at render
 * time via t(). Do NOT call i18n.t() here — this module loads before i18n init.
 */
export const SETTINGS_PAGES = [
  // Polo scope — reached from the TopBar account menu (client shell).
  { id: 'app' as const, labelKey: 'settings.app.title', descriptionKey: 'settings.app.description', scope: 'polo' },
  { id: 'account-security' as const, labelKey: 'settings.accountSecurity.title', descriptionKey: 'settings.accountSecurity.description', scope: 'polo', requiresAdminLogin: true },
  { id: 'appearance' as const, labelKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description', scope: 'polo' },
  { id: 'shortcuts' as const, labelKey: 'settings.shortcuts.title', descriptionKey: 'settings.shortcuts.description', scope: 'polo' },
  // server stays feature-flag gated and belongs to the Polo scope when enabled.
  { id: 'server' as const, labelKey: 'settings.server.title', descriptionKey: 'settings.server.description', scope: 'polo' },
  // Assistant scope — reached from the assistant sidebar Settings entry.
  { id: 'input' as const, labelKey: 'settings.input.title', descriptionKey: 'settings.input.description', scope: 'assistant' },
  { id: 'tools' as const, labelKey: 'settings.tools.title', descriptionKey: 'settings.tools.description', scope: 'assistant' },
  { id: 'workspace' as const, labelKey: 'settings.workspace.title', descriptionKey: 'settings.workspace.description', scope: 'assistant' },
  { id: 'permissions' as const, labelKey: 'settings.permissions.title', descriptionKey: 'settings.permissions.description', scope: 'assistant' },
  { id: 'labels' as const, labelKey: 'settings.labels.title', descriptionKey: 'settings.labels.description', scope: 'assistant' },
  { id: 'messaging' as const, labelKey: 'settings.messaging.title', descriptionKey: 'settings.messaging.description', scope: 'assistant' },
  { id: 'preferences' as const, labelKey: 'settings.preferences.title', descriptionKey: 'settings.preferences.description', scope: 'assistant' },
] satisfies readonly SettingsPageDefinition[]

/**
 * Settings subpage type - derived from SETTINGS_PAGES
 * This replaces the manual union type in types.ts
 */
export type SettingsSubpage = (typeof SETTINGS_PAGES)[number]['id']

/**
 * Array of valid settings subpage IDs - for runtime validation
 */
export const VALID_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = SETTINGS_PAGES.map(p => p.id)

/**
 * Type guard to check if a string is a valid settings subpage
 */
export function isValidSettingsSubpage(value: string): value is SettingsSubpage {
  return VALID_SETTINGS_SUBPAGES.includes(value as SettingsSubpage)
}

/**
 * Get settings page definition by ID
 */
export function getSettingsPage(id: SettingsSubpage): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`Unknown settings page: ${id}`)
  return page
}

/**
 * Default subpage used when a settings route carries no subpage (bare
 * `settings`). Kept in sync with MainContentPanel's `subpage ?? 'app'`
 * fallback so the navigator and the content panel never disagree.
 */
export const DEFAULT_SETTINGS_SUBPAGE: SettingsSubpage = 'app'

/**
 * Landing subpage for the assistant-scope settings entry in the sidebar
 * (first assistant category in SETTINGS_PAGES order).
 */
export const ASSISTANT_SETTINGS_DEFAULT_SUBPAGE: SettingsSubpage = 'input'

/**
 * Get the scope a settings subpage belongs to. Scope is derived from this
 * registry only — callers must not keep their own subpage→scope tables.
 */
export function getSettingsPageScope(id: SettingsSubpage): SettingsScope {
  return getSettingsPage(id).scope
}
