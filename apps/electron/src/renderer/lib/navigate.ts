/**
 * Navigation Utilities
 *
 * Provides a unified `navigate()` function for internal navigation.
 * Works by dispatching a custom event that the NavigationContext listens for.
 *
 * Usage:
 *   import { navigate, routes } from '@/lib/navigate'
 *
 *   navigate(routes.tab.settings())
 *   navigate(routes.action.newChat({ agentId: 'claude' }))
 *   navigate(routes.view.allSessions())
 */

import type { SettingsSubpage } from '../../shared/settings-registry'
import { routes, type Route } from '../../shared/routes'

// Re-export routes for convenience
export { routes }
export type { Route }

// Event name for internal navigation
export const NAVIGATE_EVENT = 'polo-ai-navigate'

// POO-125: event name for the shell-level global (Polo-scope) settings surface.
export const GLOBAL_SETTINGS_EVENT = 'polo-ai-global-settings'

export interface NavigateOptions {
  /** Open the target in a new panel instead of navigating the current one */
  newPanel?: boolean
  /**
   * Optional explicit lane target for new-panel opens.
   *
   * This is intentionally generic (not browser-specific) so future lane types
   * can reuse the same API without introducing per-feature navigation flags.
   */
  targetLaneId?: 'main'
  /** Skip auto-selecting first item when navigating to a list view (used when closing panels) */
  skipAutoSelect?: boolean
}

/**
 * Navigate to a route
 *
 * This dispatches a custom event that the NavigationContext listens for.
 * Can be called from anywhere in the app.
 */
export function navigate(route: Route, options?: NavigateOptions): void {
  const event = new CustomEvent(NAVIGATE_EVENT, {
    detail: { route, ...options },
    bubbles: true,
  })
  window.dispatchEvent(event)
}

/**
 * Open the shell-level global (Polo-scope) settings surface — POO-125.
 *
 * Global settings belong to the client shell, not to the assistant tab, so
 * this deliberately does NOT go through the route system: no tab switch, no
 * assistant route change, no history entry. TabShell owns the surface and
 * closes it again when the same subpage is requested (Cmd+, toggle).
 *
 * Assistant-scope categories keep navigating inside the assistant
 * (`navigate(routes.view.settings(...))`) — only the client-shell scope is
 * global.
 */
export function openGlobalSettings(subpage?: SettingsSubpage): void {
  const event = new CustomEvent(GLOBAL_SETTINGS_EVENT, {
    detail: { subpage: subpage ?? null },
    bubbles: true,
  })
  window.dispatchEvent(event)
}
