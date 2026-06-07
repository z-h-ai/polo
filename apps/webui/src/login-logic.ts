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
  | 'platform_mode_disabled'
  | 'admin_not_configured'
  | 'config_error'
  | 'unknown'

export class LoginError extends Error {
  constructor(
    public readonly code: LoginErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
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

export interface PlatformLoginUser {
  id: string
  username: string
  role: string
}

export interface PlatformLoginResult {
  user: PlatformLoginUser
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
// performPlatformLogin
// ---------------------------------------------------------------------------

/**
 * POST credentials to the WebUI platform auth endpoint.
 * The server proxies Admin login and stores the JWT in an HttpOnly cookie;
 * UI code only receives the authenticated user.
 */
export async function performPlatformLogin(
  username: string,
  password: string,
): Promise<PlatformLoginResult> {
  let res: Response
  try {
    res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new LoginError('network_error', '无法连接服务器，请检查网络连接')
  }

  if (res.ok) {
    return await res.json() as PlatformLoginResult
  }

  const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('Retry-After'))
  if (res.status === 401) {
    throw new LoginError('invalid_credentials', '用户名或密码错误')
  }
  if (res.status === 403) {
    throw new LoginError('account_disabled', '账号已被禁用，请联系管理员')
  }
  if (res.status === 429) {
    const seconds = retryAfterSeconds ?? 0
    throw new LoginError('rate_limited', `请 ${seconds} 秒后再试`, seconds)
  }

  throw new LoginError('unknown', `Login failed: ${res.status}`)
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
    throw new LoginError('config_error', `Failed to fetch config: ${res.status}`)
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

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseInt(value, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
