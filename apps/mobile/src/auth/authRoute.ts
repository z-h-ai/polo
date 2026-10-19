// Pure auth routing decision for the root guard (POL-244).
//
// Extracted from AuthGate so the guard matrix is unit-testable without a
// navigator: hydrated=false holds navigation, signed-in users bounced off
// /login land on the tabs root (/ = 消息 Tab), signed-out users on any other
// path are sent to /login.

import type { AuthStatus } from './session';

export const LOGIN_ROUTE = '/login';
/** Tabs root route: (tabs)/index = 消息 Tab (post-login landing page). */
export const TABS_ROOT_ROUTE = '/';

export type AuthRouteTarget = typeof LOGIN_ROUTE | typeof TABS_ROOT_ROUTE | null;

export interface AuthRouteInput {
  hydrated: boolean;
  status: AuthStatus;
  pathname: string;
}

/**
 * Returns the route to replace() with, or null to stay put:
 *   - store not hydrated yet            -> null (never flash a screen)
 *   - authenticated + on /login        -> '/'  (tabs, 消息 Tab)
 *   - authenticated + elsewhere        -> null (stay)
 *   - signed out    + on /login        -> null (stay)
 *   - signed out    + elsewhere        -> '/login'
 */
export function authRouteTarget(input: AuthRouteInput): AuthRouteTarget {
  if (!input.hydrated) return null;
  const onLoginRoute = input.pathname === LOGIN_ROUTE;
  if (input.status === 'authenticated') {
    return onLoginRoute ? TABS_ROOT_ROUTE : null;
  }
  return onLoginRoute ? null : LOGIN_ROUTE;
}
