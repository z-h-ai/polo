/**
 * Web UI session authentication.
 *
 * Admin JWT authentication for the browser-served web UI.
 * - Login: proxy username/password to Admin → store Admin JWT in HttpOnly cookie
 * - Validation: check Admin JWT cookies and Bearer headers on protected requests
 */

import { SignJWT, decodeJwt, jwtVerify } from 'jose'
export { isPlatformMode } from '@polo-ai/shared/auth'

// ---------------------------------------------------------------------------
// JWT helpers (via jose library)
// ---------------------------------------------------------------------------

const JWT_EXPIRY_SECONDS = 86_400 // 24 hours

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
}

export interface AdminJwtPayload {
  sub: string
  username: string
  role: string
  iat?: number
  exp?: number
}

export interface WebuiUser {
  id: string
  username: string
  role: string
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub: payload.sub } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key)
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return {
      sub: payload.sub as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    }
  } catch {
    return null
  }
}

export async function verifyAdminJwt(token: string, secret: string): Promise<AdminJwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })

    if (
      typeof payload.sub !== 'string'
      || typeof payload.username !== 'string'
      || typeof payload.role !== 'string'
    ) {
      return null
    }

    return {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    }
  } catch {
    return null
  }
}

export function userFromAdminJwt(payload: AdminJwtPayload): WebuiUser {
  return {
    id: payload.sub,
    username: payload.username,
    role: payload.role,
  }
}

export async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ sub: 'webui', iat: now, exp: now + JWT_EXPIRY_SECONDS }, secret)
}

// ---------------------------------------------------------------------------
// Admin API token store
// ---------------------------------------------------------------------------

export const adminJwtStore = new Map<string, string>()

const adminJwtExpirations = new Map<string, number>()

export function storeAdminJwt(userId: string, token: string, expiresAt = Number.POSITIVE_INFINITY): void {
  adminJwtStore.set(userId, token)
  adminJwtExpirations.set(userId, expiresAt)
}

export function removeAdminJwt(userId: string): void {
  adminJwtStore.delete(userId)
  adminJwtExpirations.delete(userId)
}

export function removeAdminJwtFromToken(token: string): void {
  try {
    const payload = decodeJwt(token)
    if (typeof payload.sub === 'string') {
      removeAdminJwt(payload.sub)
    }
  } catch {
    // Invalid JWTs have no trusted user mapping to remove.
  }
}

export function sweepExpiredAdminJwtStore(now = Math.floor(Date.now() / 1000)): void {
  for (const [userId, expiresAt] of adminJwtExpirations) {
    if (expiresAt <= now) removeAdminJwt(userId)
  }
}

export function clearAdminJwtStore(): void {
  adminJwtStore.clear()
  adminJwtExpirations.clear()
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'polo_ai_session'

export function buildSessionCookie(jwt: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${jwt}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${JWT_EXPIRY_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildLogoutCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE_NAME) return rest.join('=')
  }
  return null
}

// ---------------------------------------------------------------------------
// Admin Bearer token validation
// ---------------------------------------------------------------------------

export type AdminBearerAuthResult =
  | { ok: true; token: string; user: WebuiUser }
  | { ok: false; error: 'missing_token' | 'invalid_token' | 'token_revoked' | 'server_configuration_error' }

export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function isJwtLike(token: string): boolean {
  const parts = token.split('.')
  return parts.length === 3 && parts.every(part => part.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function validateAdminBearerAuth(authorizationHeader: string | null): Promise<AdminBearerAuthResult> {
  const token = extractBearerToken(authorizationHeader)
  if (!token) return { ok: false, error: 'missing_token' }
  if (!isJwtLike(token)) return { ok: false, error: 'invalid_token' }

  const adminApiUrl = process.env.POLO_ADMIN_API_URL
  if (!adminApiUrl) return { ok: false, error: 'server_configuration_error' }

  let response: Response
  try {
    response = await globalThis.fetch(`${adminApiUrl.replace(/\/+$/, '')}/api/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    return { ok: false, error: 'invalid_token' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = {}
  }

  if (!response.ok) {
    const error = isRecord(body) && body.error === 'token_revoked' ? 'token_revoked' : 'invalid_token'
    return { ok: false, error }
  }

  const user = isRecord(body) && isRecord(body.user) ? body.user : null
  if (
    !user
    || typeof user.id !== 'string'
    || typeof user.username !== 'string'
    || typeof user.role !== 'string'
  ) {
    return { ok: false, error: 'invalid_token' }
  }

  storeAdminJwt(user.id, token)
  return {
    ok: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  }
}

// ---------------------------------------------------------------------------
// Password verification (argon2id via Bun.password)
// ---------------------------------------------------------------------------

let hashedPassword: string | null = null

/**
 * Hash the login password at startup. Must be called before any auth requests.
 * The hash is stored in memory — the raw password is not retained.
 */
export async function initPasswordHash(plaintext: string): Promise<void> {
  hashedPassword = await Bun.password.hash(plaintext, { algorithm: 'argon2id' })
}

/**
 * Verify a user-supplied password against the pre-hashed password.
 * Uses Bun's built-in argon2id verification (constant-time).
 */
export async function verifyPassword(input: string): Promise<boolean> {
  if (!hashedPassword) return false
  return Bun.password.verify(input, hashedPassword)
}

// ---------------------------------------------------------------------------
// Rate limiter (per-IP + global, sliding window)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  attempts: number
  windowStart: number
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  /** Global counter — blocks all IPs after too many total failures (defeats IP spoofing). */
  private readonly maxGlobalAttempts: number
  private globalAttempts = 0
  private globalWindowStart = Date.now()

  constructor(maxAttempts = 5, windowMs = 60_000, maxGlobalAttempts = 20) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxGlobalAttempts = maxGlobalAttempts
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now()

    // Reset global window if expired
    if (now - this.globalWindowStart > this.windowMs) {
      this.globalAttempts = 0
      this.globalWindowStart = now
    }

    // Global rate limit — blocks everyone if too many total attempts
    this.globalAttempts++
    if (this.globalAttempts > this.maxGlobalAttempts) return false

    // Per-IP rate limit
    const entry = this.entries.get(ip)

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { attempts: 1, windowStart: now })
      return true
    }

    entry.attempts++
    if (entry.attempts > this.maxAttempts) return false
    return true
  }

  /** Periodic cleanup of stale entries (call on a timer). */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(ip)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session validator (used by both HTTP and WebSocket)
// ---------------------------------------------------------------------------

export async function validateSession(
  cookieHeader: string | null,
  _secret: string,
  options?: { adminJwtSecret?: string },
): Promise<JwtPayload | AdminJwtPayload | null> {
  const token = extractSessionCookie(cookieHeader)
  if (!token) return null

  if (!options?.adminJwtSecret) return null

  const adminSession = await verifyAdminJwt(token, options.adminJwtSecret)
  if (adminSession) {
    storeAdminJwt(adminSession.sub, token, adminSession.exp)
  }
  return adminSession
}
