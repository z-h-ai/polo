import { parseCompoundRoute } from '../../../shared/route-parser'
import {
  DEFAULT_SETTINGS_SUBPAGE,
  getSettingsPageScope,
  isValidSettingsSubpage,
  type SettingsSubpage,
} from '../../../shared/settings-registry'

/** Route prefix of the global new-session action (with or without a query). */
const NEW_SESSION_PREFIX = 'action/new-session'

/**
 * Whether a global navigate() route must surface the Polo assistant tab.
 *
 * Assistant-surface routes dispatched from ABOVE NavigationProvider only change
 * the route inside the Polo tab — which stays mounted but hidden while another
 * tab is active — so the user would see no visible change without surfacing:
 *
 * - Assistant-scope settings routes: the assistant sidebar Settings row and the
 *   surface hand-off from the global settings surface (POO-125).
 * - `action/new-session` (POO-117 P117-04): the avatar menu, Cmd+N, the native
 *   New Chat broadcast and deep links all create the session through the global
 *   navigate event. An explicit "new chat" request must open and activate the
 *   assistant, never build a session inside a hidden tab.
 *
 * POO-125: Polo-scope (client-shell) settings routes are NOT assistant routes
 * any more — they open the shell-level global settings surface instead
 * (`getGlobalSettingsSubpageFromRoute`). The top-right account-menu entry is a
 * global entry: it must not yank the user into the assistant tab, and the
 * assistant keeps whatever route it had.
 *
 * All other routes keep their existing tab behaviour (notifications and the
 * session deep links activate the tab themselves).
 */
export function shouldSurfaceAssistantForNavigate(route: unknown): boolean {
  if (typeof route !== 'string') return false
  if (route === NEW_SESSION_PREFIX || route.startsWith(`${NEW_SESSION_PREFIX}?`)) return true
  if (parseCompoundRoute(route)?.navigator !== 'settings') return false
  return getGlobalSettingsSubpageFromRoute(route) === null
}

/**
 * The Polo-scope settings subpage a navigate()/deep-link route requests, or
 * `null` when the route is not a Polo-scope settings route.
 *
 * The bare `settings` route and an unknown subpage both resolve to the same
 * default the route parser and MainContentPanel use, so a legacy deep link
 * (`poloai://settings`) still lands on the global surface instead of
 * silently changing the hidden Polo tab (the pre-R8FIX-01 bug).
 */
export function getGlobalSettingsSubpageFromRoute(route: unknown): SettingsSubpage | null {
  if (typeof route !== 'string') return null
  if (parseCompoundRoute(route)?.navigator !== 'settings') return null
  const raw = route.split('/').filter(Boolean)[1]
  const subpage = raw !== undefined && isValidSettingsSubpage(raw) ? raw : DEFAULT_SETTINGS_SUBPAGE
  return getSettingsPageScope(subpage) === 'polo' ? subpage : null
}
