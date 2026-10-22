import { parseCompoundRoute } from '../../../shared/route-parser'

/**
 * Whether a global navigate() route must surface the Polo assistant tab.
 *
 * Settings routes are assistant-surface routes, but their entry points (the
 * account menu, the Polo app menu, Cmd+, and the native Settings menu) live
 * above NavigationProvider and only change the route inside the Polo tab —
 * which stays mounted but hidden while another tab is active. Scope is kept
 * to the settings navigator on purpose: other routes keep their existing
 * tab behaviour (notifications and deep links activate the tab themselves).
 */
export function shouldSurfaceAssistantForNavigate(route: unknown): boolean {
  if (typeof route !== 'string') return false
  return parseCompoundRoute(route)?.navigator === 'settings'
}
