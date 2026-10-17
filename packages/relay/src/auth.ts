/**
 * Dual-layer auth for polo-relay (PRD v1.6 §⑥):
 * - Fast path: local HS256 verify (shared secret with polo-admin) incl. iss/aud checks.
 * - Slow path: admin introspection (POST /api/auth/validate, Bearer token) with a
 *   60s TTL cache keyed by token hash — preserves Session revocation semantics;
 *   revocation propagates across the relay within one cache TTL.
 * - Device binding check: GET /api/devices/check-access?macDeviceId=… (Bearer token)
 *   with a 60s TTL cache keyed by `userId:macDeviceId`.
 *
 * The AdminClient tolerates both documented response shapes
 * (`{valid:true,user:{id}}` and `{ok:true,user:{id}}`).
 *
 * Caches are in-memory Maps behind a tiny interface, ready to be swapped for a
 * shared Redis implementation later (no behavior change at call sites).
 */

import { createHash } from 'node:crypto'
import { jwtVerify } from 'jose'

export interface RelayJwtOptions {
  secret: string
  issuer: string
  audience: string
}

export interface LocalClaims {
  sub: string
}

/** Fast path — returns null when signature/exp/iss/aud validation fails. */
export async function verifyTokenLocal(token: string, jwt: RelayJwtOptions): Promise<LocalClaims | null> {
  try {
    const key = new TextEncoder().encode(jwt.secret)
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: jwt.issuer,
      audience: jwt.audience,
    })
    return typeof payload.sub === 'string' ? { sub: payload.sub } : null
  } catch {
    return null
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ---------------------------------------------------------------------------
// TTL cache (interface-able for a future Redis-backed implementation)
// ---------------------------------------------------------------------------

export interface Cache<K, V> {
  get(key: K): V | undefined
  set(key: K, value: V): void
  delete(key: K): void
  clear(): void
}

export class TtlCache<K, V> implements Cache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = Number.POSITIVE_INFINITY,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      this.sweepNow()
      if (this.entries.size >= this.maxEntries) {
        // Evict the oldest insertion (Map preserves order) as a hard memory bound.
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  delete(key: K): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Drops expired entries even if they are never re-read (memory bound). */
  sweepNow(): void {
    const t = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= t) this.entries.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Admin HTTP client
// ---------------------------------------------------------------------------

export interface AdminCallResult<T> {
  /** false when the network itself failed (admin unreachable). */
  reachable: boolean
  httpStatus: number
  data?: T
}

export interface IntrospectionData {
  valid: boolean
  userId?: string
}

export interface CheckAccessData {
  allowed?: boolean
}

export interface AdminClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

export class AdminClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: AdminClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** POST {baseUrl}/api/auth/validate — Bearer JWT introspection. */
  async introspect(token: string): Promise<AdminCallResult<IntrospectionData>> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/api/auth/validate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    } catch {
      return { reachable: false, httpStatus: 0 }
    }
    if (response.status !== 200) {
      return { reachable: true, httpStatus: response.status }
    }
    return { reachable: true, httpStatus: 200, data: parseIntrospection(await safeJson(response)) }
  }

  /** GET {baseUrl}/api/devices/check-access?macDeviceId=… — Bearer JWT. */
  async checkAccess(token: string, macDeviceId: string): Promise<AdminCallResult<CheckAccessData>> {
    let response: Response
    try {
      const url = `${this.options.baseUrl}/api/devices/check-access?macDeviceId=${encodeURIComponent(macDeviceId)}`
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })
    } catch {
      return { reachable: false, httpStatus: 0 }
    }
    if (response.status !== 200) {
      return { reachable: true, httpStatus: response.status }
    }
    const body = await safeJson(response)
    const allowed = body !== null && typeof body === 'object' && typeof (body as { allowed?: unknown }).allowed === 'boolean'
      ? (body as { allowed: boolean }).allowed
      : undefined
    return { reachable: true, httpStatus: 200, data: { allowed } }
  }
}

function parseIntrospection(body: unknown): IntrospectionData {
  if (body === null || typeof body !== 'object') return { valid: false }
  const record = body as Record<string, unknown>
  const user = record.user as { id?: unknown } | undefined
  const userId = typeof user?.id === 'string' ? user.id : undefined
  // Tolerate both `{valid:true,…}` (polo-admin today) and `{ok:true,…}` variants.
  const flag = record.valid === true || record.ok === true
  if (flag) return { valid: true, userId }
  return { valid: false }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Relay auth service (caches included)
// ---------------------------------------------------------------------------

export type AuthenticateResult =
  | { ok: true; userId: string; degraded?: boolean }
  | { ok: false; code: 'unauthorized' }

export type AccessCheckResult = 'allowed' | 'denied' | 'unauthorized' | 'unreachable'

export interface RelayAuthOptions {
  authCacheTtlMs: number
  now?: () => number
}

export class RelayAuth {
  /** token hash → introspection outcome (only valid outcomes are cached). */
  private readonly introspectionCache: TtlCache<string, IntrospectionData>
  /** token hash → recent negative introspection (short TTL; blunts invalid-token floods). */
  private readonly negativeCache: TtlCache<string, true>
  /** `userId:macDeviceId` → binding exists. */
  private readonly accessCache: TtlCache<string, boolean>

  private static readonly CACHE_MAX_ENTRIES = 10_000

  constructor(
    private readonly admin: AdminClient,
    private readonly jwt: RelayJwtOptions,
    private readonly options: RelayAuthOptions,
  ) {
    this.introspectionCache = new TtlCache(options.authCacheTtlMs, options.now, RelayAuth.CACHE_MAX_ENTRIES)
    this.negativeCache = new TtlCache(Math.min(5_000, options.authCacheTtlMs), options.now, RelayAuth.CACHE_MAX_ENTRIES)
    this.accessCache = new TtlCache(options.authCacheTtlMs, options.now, RelayAuth.CACHE_MAX_ENTRIES)
  }

  /** Drops expired cache entries; called from the server heartbeat so caches stay bounded. */
  sweepCaches(): void {
    this.introspectionCache.sweepNow()
    this.negativeCache.sweepNow()
    this.accessCache.sweepNow()
  }

  /**
   * Handshake / periodic re-validation. Always consults the introspection cache
   * (fresh connections trigger at most one admin call per cache TTL per token);
   * falls back to the local signature when admin is unreachable, so a blip in
   * admin availability does not drop already-trusted clients. Degraded
   * (admin-unreachable) acceptances are never cached — the next call retries
   * the admin. Invalid introspection outcomes are negative-cached for a short
   * TTL so a flood of garbage handshakes cannot be amplified 1:1 onto admin.
   */
  async authenticate(token: string): Promise<AuthenticateResult> {
    const cacheKey = hashToken(token)
    let entry = this.introspectionCache.get(cacheKey)
    let degraded = false

    if (!entry) {
      if (this.negativeCache.get(cacheKey)) return { ok: false, code: 'unauthorized' }
      const local = await verifyTokenLocal(token, this.jwt)
      const result = await this.admin.introspect(token)
      if (result.reachable && result.data) {
        entry = result.data
        if (entry.valid) this.introspectionCache.set(cacheKey, entry)
        else this.negativeCache.set(cacheKey, true)
      } else if (!result.reachable) {
        if (local) return { ok: true, userId: local.sub, degraded: true }
        return { ok: false, code: 'unauthorized' }
      }
    }

    if (!entry || !entry.valid) return { ok: false, code: 'unauthorized' }
    if (entry.userId) return { ok: true, userId: entry.userId, degraded }
    const local = await verifyTokenLocal(token, this.jwt)
    if (!local) return { ok: false, code: 'unauthorized' }
    return { ok: true, userId: local.sub, degraded }
  }

  /**
   * Binding check before routing to a Mac. HTTP 401/403 means the session is
   * gone → caller must close the connection. Other failures fail closed.
   */
  async checkAccess(token: string, userId: string, macDeviceId: string): Promise<AccessCheckResult> {
    const cacheKey = `${userId}:${macDeviceId}`
    const cached = this.accessCache.get(cacheKey)
    if (cached !== undefined) return cached ? 'allowed' : 'denied'

    const result = await this.admin.checkAccess(token, macDeviceId)
    if (!result.reachable) return 'unreachable'
    if (result.httpStatus === 401 || result.httpStatus === 403) return 'unauthorized'
    if (result.httpStatus === 200 && typeof result.data?.allowed === 'boolean') {
      this.accessCache.set(cacheKey, result.data.allowed)
      return result.data.allowed ? 'allowed' : 'denied'
    }
    return 'unreachable'
  }
}
