import { parseCompoundRoute } from '../../../shared/route-parser'

/** Route prefix of the global new-session action (with or without a query). */
const NEW_SESSION_PREFIX = 'action/new-session'

/**
 * Whether a global navigate() route must surface the Polo assistant tab.
 *
 * Assistant-surface routes dispatched from ABOVE NavigationProvider only change
 * the route inside the Polo tab — which stays mounted but hidden while another
 * tab is active — so the user would see no visible change without surfacing:
 *
 * - Settings routes: the account menu, Cmd+, and the native Settings menu.
 * - `action/new-session` (POO-117 P117-04): the avatar menu, Cmd+N, the native
 *   New Chat broadcast and deep links all create the session through the global
 *   navigate event. An explicit "new chat" request must open and activate the
 *   assistant, never build a session inside a hidden tab.
 *
 * All other routes keep their existing tab behaviour (notifications and the
 * session deep links activate the tab themselves).
 */
export function shouldSurfaceAssistantForNavigate(route: unknown): boolean {
  if (typeof route !== 'string') return false
  if (route === NEW_SESSION_PREFIX || route.startsWith(`${NEW_SESSION_PREFIX}?`)) return true
  return parseCompoundRoute(route)?.navigator === 'settings'
}
