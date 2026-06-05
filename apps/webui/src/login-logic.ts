/**
 * Login flow logic for the Polo AI WebUI login page.
 *
 * Pure functions that handle authentication state checks, Admin login,
 * and session establishment. All HTTP communication is done via fetch()
 * so it can be tested with mocked fetch.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type LoginErrorCode =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'rate_limited'
  | 'network_error'
  | 'session_failed'
  | 'platform_mode_disabled'
  | 'admin_not_configured'
  | 'unknown'

export class LoginError extends Error {
  constructor(
    public readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

export interface PublicConfig {
  adminUrl: string | null
  platformMode: boolean
}

export interface PostLoginConfig {
  wsUrl: string
}

// ---------------------------------------------------------------------------
// checkExistingSession
// ---------------------------------------------------------------------------

/**
 * Check if the browser already has a valid session by hitting /auth/me.
 * Returns { authenticated: true } if session is valid, { authenticated: false } otherwise.
 * Never throws — network failures are treated as unauthenticated.
 */
export async function checkExistingSession(): Promise<{ authenticated: boolean }> {
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' })
    return { authenticated: res.ok }
  } catch {
    return { authenticated: false }
  }
}

// ---------------------------------------------------------------------------
// fetchPublicConfig
// ---------------------------------------------------------------------------

/**
 * Fetch the public configuration from /api/public-config.
 * Returns adminUrl and platformMode.
 * Throws LoginError with code 'network_error' on fetch failures.
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  let res: Response
  try {
    res = await fetch('/api/public-config')
  } catch {
    throw new LoginError('network_error', 'Service temporarily unavailable')
  }

  if (!res.ok) {
    throw new LoginError('network_error', `Failed to fetch config: ${res.status}`)
  }

  const data = await res.json() as PublicConfig
  return { adminUrl: data.adminUrl ?? null, platformMode: Boolean(data.platformMode) }
}

// ---------------------------------------------------------------------------
// performAdminLogin
// ---------------------------------------------------------------------------

/**
 * POST credentials to the Admin service's /api/auth/login endpoint.
 * Returns the JWT token on success.
 * Throws LoginError with appropriate code on failure.
 */
export async function performAdminLogin(
  adminUrl: string,
  username: string,
  password: string,
): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${adminUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new LoginError('network_error', 'Service temporarily unavailable')
  }

  if (res.ok) {
    const data = await res.json() as { token: string }
    return data.token
  }

  if (res.status === 401) {
    throw new LoginError('invalid_credentials', 'Username or password incorrect')
  }
  if (res.status === 403) {
    throw new LoginError('account_disabled', 'Account disabled, contact administrator')
  }
  if (res.status === 429) {
    throw new LoginError('rate_limited', 'Too many attempts, try again later')
  }

  throw new LoginError('unknown', `Login failed: ${res.status}`)
}

// ---------------------------------------------------------------------------
// setPoloSession
// ---------------------------------------------------------------------------

/**
 * POST the Admin JWT to /auth/session to set the Polo AI session cookie.
 * Resolves on success; throws LoginError on failure.
 */
export async function setPoloSession(token: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
  } catch {
    throw new LoginError('network_error', 'Service temporarily unavailable')
  }

  if (res.ok) {
    return
  }

  if (res.status === 401) {
    throw new LoginError('session_failed', 'Authentication failed')
  }

  throw new LoginError('session_failed', `Session creation failed: ${res.status}`)
}

// ---------------------------------------------------------------------------
// fetchPostLoginConfig
// ---------------------------------------------------------------------------

/**
 * Fetch /api/config after a successful login to get the WebSocket URL.
 * Throws on network failure or non-OK response.
 */
export async function fetchPostLoginConfig(): Promise<PostLoginConfig> {
  let res: Response
  try {
    res = await fetch('/api/config', { credentials: 'same-origin' })
  } catch {
    throw new LoginError('network_error', 'Service temporarily unavailable')
  }

  if (!res.ok) {
    throw new LoginError('unknown', `Failed to fetch config: ${res.status}`)
  }

  const data = await res.json() as PostLoginConfig
  return { wsUrl: data.wsUrl }
}

// ---------------------------------------------------------------------------
// Redirect URL helper
// ---------------------------------------------------------------------------

/**
 * Extract the redirect URL from the login page URL search params.
 * Returns '/' if none is set or it's empty.
 */
export function extractRedirectUrl(url: URL): string {
  const redirect = url.searchParams.get('redirect')
  return redirect && redirect.length > 0 ? redirect : '/'
}
