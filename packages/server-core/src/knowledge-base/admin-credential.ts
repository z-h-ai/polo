import { AdminClient } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import type { OpenVikingConfig, OpenVikingTenantAuth } from './openviking-client'
import { readOpenVikingConfig } from './openviking-client'

/**
 * The admin-side per-space library credential (POO-108 v5 §B).
 *
 * In the auto-provisioned deployment the ADMIN service owns the library
 * lifecycle (it creates the enterprise-edition OpenViking library when the
 * ProductSpace is created, brief v5 §1.A) and hands the client the data-plane
 * credential on demand: `GET /api/kb/credential?productSpaceId=` answered with
 * `{baseUrl, resourceId, apiKey}` for a READY library the caller's session is
 * a member of. Unlike the OSS tenant (`tenant.ts`) there is NO client-side
 * provisioning plane and NO ownership marker to verify — the admin-side
 * `kb_libraries` mapping (product_space_id unique) IS the ownership record —
 * and unlike the v4 managed mode the library is DEDICATED to one space, so the
 * space's data lives at the library root (`viking://resources/`), not under a
 * per-space directory.
 *
 * Cost discipline: the resolution sits on EVERY KB entry (it is the highest
 * credential priority), so it never issues a request per RPC —
 *
 * - a fresh answer is served from the in-memory map with zero requests;
 * - a TTL-expired answer is served stale while ONE background refresh runs
 *   (single-flight, cadence-bounded, failures swallowed — a refresh that
 *   cannot complete never blocks the read, and a 409 "still provisioning" or
 *   a network error never discards the last good credential);
 * - a miss is remembered briefly (`ADMIN_KB_CREDENTIAL_MISS_TTL_MS`) so a
 *   deployment the admin cannot answer for does not hammer it per RPC. A 404
 *   ("no such library for this member") IS allowed to replace a stale
 *   credential — that answer can never become good again — while a 409 or a
 *   transport failure keeps the stale value.
 *
 * The last good answer is also persisted in the CredentialManager under the
 * tenant credential id (`kb_openviking_tenant::{productSpaceId}`, payload
 * marked `source: 'admin'` — `tenant.ts` refuses that marker, so the two
 * modes can share the id without ever adopting each other's key). The
 * encrypted store survives a process restart: the first KB call after a
 * restart serves the persisted answer and refreshes in the background.
 *
 * Failure semantics (brief D7, read-path discipline): this module NEVER
 * throws — an unconfigured admin URL, a signed-out session, a 404/409, a
 * timeout and a transport failure all resolve to `null`, and the caller falls
 * through to the env-configured modes. The raw cause is logged server-side
 * only; nothing names the vendor on the wire.
 */

/** One admin-issued library credential — everything a data-plane call needs. */
export interface AdminKbLibraryCredential {
  /** The OpenViking ResourceID of the space's dedicated library. */
  resourceId: string
  /** The library's data-plane key (the Bearer credential). */
  apiKey: string
  /** The library's data-plane base URL; OVERRIDES the env-configured one. */
  baseUrl: string
}

/** The fresh-answer lifetime. Ten minutes keeps one admin call per space per
 * ten minutes at most — never one per RPC. */
export const ADMIN_KB_CREDENTIAL_TTL_MS = 10 * 60 * 1000

/**
 * How long a `null` answer (404, not-ready 409, transport failure, no admin
 * URL, no session) is remembered. Short by design: a 409 means the library is
 * still provisioning and must be picked up within a minute of readiness.
 */
export const ADMIN_KB_CREDENTIAL_MISS_TTL_MS = 30 * 1000

/**
 * The admin fetch's own ceiling — well under the send path's 4s resolution
 * budget, so a hung admin costs one send its references, not every send its
 * deadline.
 */
export const ADMIN_KB_CREDENTIAL_TIMEOUT_MS = 3_000

interface AdminKbCacheEntry {
  /** The last good answer; `null` while the admin answers "nothing usable". */
  credential: AdminKbLibraryCredential | null
  /** The trusted enterprise the answer was resolved for. */
  enterpriseId: string
  fetchedAt: number
}

const cache = new Map<string, AdminKbCacheEntry>()
const inflight = new Map<string, Promise<AdminKbLibraryCredential | null>>()
/** Per-space background-refresh cadence gate (one attempt per miss TTL). */
const lastRefreshAttemptAt = new Map<string, number>()

let ttlMs = ADMIN_KB_CREDENTIAL_TTL_MS
let missTtlMs = ADMIN_KB_CREDENTIAL_MISS_TTL_MS
/** Re-armed by the test reset so each file sees the precedence warning once. */
let warnedOnce = false

/** Production source of the admin origin; tests pin it explicitly. */
let resolveAdminUrl: () => string | null = () => getAdminUrl() ?? null

/** Test seam: pin the admin origin (and clear every cache) for one file. */
export function setAdminKbCredentialAdminUrlForTests(adminUrl: string | null): void {
  resolveAdminUrl = () => adminUrl
}

/** Test seam: shrink the fresh-answer lifetime so expiry is observable. */
export function setAdminKbCredentialTtlForTests(ms: number): void {
  ttlMs = ms
}

export function setAdminKbCredentialMissTtlForTests(ms: number): void {
  missTtlMs = ms
}

/** Test seam: forget every cached answer, cadence gate and warning flag. */
export function resetAdminKbCredentialCacheForTests(): void {
  cache.clear()
  inflight.clear()
  lastRefreshAttemptAt.clear()
  ttlMs = ADMIN_KB_CREDENTIAL_TTL_MS
  missTtlMs = ADMIN_KB_CREDENTIAL_MISS_TTL_MS
  warnedOnce = false
  resolveAdminUrl = () => getAdminUrl() ?? null
}

/**
 * The stored payload: one JSON blob keeps the binding atomic, and the
 * `source` marker is what keeps this mode's payload from ever being adopted
 * by the OSS tenant path (`tenant.ts` refuses it) — the two modes share the
 * credential id, never the key.
 */
interface AdminKbStoredPayload extends AdminKbLibraryCredential {
  source: 'admin'
  enterpriseId: string
  fetchedAt: string
}

function credentialId(productSpaceId: string): { type: 'kb_openviking_tenant'; name: string } {
  return { type: 'kb_openviking_tenant', name: productSpaceId }
}

function decodeStoredPayload(value: string): AdminKbStoredPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<AdminKbStoredPayload>
    if (parsed.source !== 'admin') return null
    if (typeof parsed.resourceId !== 'string' || parsed.resourceId.length === 0) return null
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) return null
    if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl.length === 0) return null
    if (typeof parsed.enterpriseId !== 'string' || parsed.enterpriseId.length === 0) return null
    if (typeof parsed.fetchedAt !== 'string') return null
    return parsed as AdminKbStoredPayload
  } catch {
    return null
  }
}

/** Reads the persisted answer off the encrypted store; `null` on any trouble. */
async function readPersistedEntry(
  productSpaceId: string,
  expectedEnterpriseId: string,
): Promise<{ credential: AdminKbLibraryCredential; fetchedAt: number } | null> {
  try {
    const stored = await getCredentialManager().get(credentialId(productSpaceId))
    if (!stored || typeof stored.value !== 'string') return null
    const payload = decodeStoredPayload(stored.value)
    // A payload naming a DIFFERENT enterprise is never adopted — the same
    // fail-closed rule as the tenant read (brief D1), just silent: this
    // module answers `null` and lets the network decide.
    if (!payload || payload.enterpriseId !== expectedEnterpriseId) return null
    const stamp = Date.parse(payload.fetchedAt)
    return {
      credential: { resourceId: payload.resourceId, apiKey: payload.apiKey, baseUrl: payload.baseUrl },
      fetchedAt: Number.isNaN(stamp) ? 0 : stamp,
    }
  } catch {
    // An unreadable credential store degrades to the network path.
    return null
  }
}

async function persistCredential(productSpaceId: string, entry: AdminKbCacheEntry): Promise<void> {
  if (!entry.credential) return
  const payload: AdminKbStoredPayload = {
    source: 'admin',
    resourceId: entry.credential.resourceId,
    apiKey: entry.credential.apiKey,
    baseUrl: entry.credential.baseUrl,
    enterpriseId: entry.enterpriseId,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
  }
  try {
    await getCredentialManager().set(credentialId(productSpaceId), {
      value: JSON.stringify(payload),
    })
  } catch (error) {
    // The in-memory answer still serves this run; only the restart warm-up
    // loses it. Server log only — the store error carries no credential value.
    console.warn(`[KbAdminCredential] persist failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * One admin round trip, single-flight per space. A success refreshes both
 * cache tiers; a 404 replaces even a stale positive answer (that library is
 * gone for this member); every other failure keeps the stale answer and is
 * remembered as a miss only when there is nothing to keep.
 */
async function fetchAdminCredential(
  productSpaceId: string,
  expectedEnterpriseId: string,
): Promise<AdminKbLibraryCredential | null> {
  const existing = inflight.get(productSpaceId)
  if (existing) return existing
  const run = (async (): Promise<AdminKbLibraryCredential | null> => {
    const adminUrl = resolveAdminUrl()
    if (!adminUrl) {
      rememberMiss(productSpaceId, expectedEnterpriseId)
      return null
    }
    let accessToken: string | null = null
    try {
      const tokens = await getCredentialManager().getAdminTokens()
      accessToken = tokens?.accessToken ?? null
    } catch {
      accessToken = null
    }
    if (!accessToken) {
      rememberMiss(productSpaceId, expectedEnterpriseId)
      return null
    }
    try {
      const credential = await new AdminClient(adminUrl, {
        requestTimeoutMs: ADMIN_KB_CREDENTIAL_TIMEOUT_MS,
      }).getKbCredential(accessToken, productSpaceId)
      const entry: AdminKbCacheEntry = {
        credential: {
          resourceId: credential.resourceId,
          apiKey: credential.apiKey,
          baseUrl: credential.baseUrl.replace(/\/+$/, ''),
        },
        enterpriseId: expectedEnterpriseId,
        fetchedAt: Date.now(),
      }
      cache.set(productSpaceId, entry)
      await persistCredential(productSpaceId, entry)
      return entry.credential
    } catch (error) {
      const status = error instanceof Error && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined
      if (typeof status === 'number' && status === 404) {
        // Gone for good — no such library for this member any more. A stale
        // key would only produce data-plane 401s, so it is dropped even at
        // the cost of losing the warm answer — from BOTH tiers, memory and
        // the encrypted store.
        cache.delete(productSpaceId)
        await deletePersistedCredential(productSpaceId)
      }
      rememberMiss(productSpaceId, expectedEnterpriseId)
      return null
    }
  })()
  inflight.set(productSpaceId, run)
  try {
    return await run
  } finally {
    inflight.delete(productSpaceId)
  }
}

/**
 * Drops the persisted copy too. A 404 means the library is gone for this
 * member; without this, the next cold read would serve the dead key straight
 * off the encrypted store and the "404 wins over a stale answer" rule would
 * only hold until the process restarts. Best-effort: a failed delete keeps
 * the dead key around and the next 404 retries.
 */
async function deletePersistedCredential(productSpaceId: string): Promise<void> {
  try {
    await getCredentialManager().delete(credentialId(productSpaceId))
  } catch (error) {
    console.warn(`[KbAdminCredential] persist delete failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Records a `null` answer WITHOUT discarding a still-held positive one — the
 * stale credential keeps serving while the admin is unavailable (the whole
 * point of stale-while-revalidate).
 */
function rememberMiss(productSpaceId: string, expectedEnterpriseId: string): void {
  const existing = cache.get(productSpaceId)
  if (existing?.credential) return
  cache.set(productSpaceId, { credential: null, enterpriseId: expectedEnterpriseId, fetchedAt: Date.now() })
}

/**
 * Kicks ONE background refresh for a stale-but-held answer. Failures are
 * absorbed by `fetchAdminCredential` itself; the cadence gate keeps a long
 * admin outage from turning every RPC into a refresh attempt.
 */
function scheduleBackgroundRefresh(productSpaceId: string, expectedEnterpriseId: string): void {
  const now = Date.now()
  const last = lastRefreshAttemptAt.get(productSpaceId) ?? 0
  if (now - last < missTtlMs) return
  lastRefreshAttemptAt.set(productSpaceId, now)
  void fetchAdminCredential(productSpaceId, expectedEnterpriseId)
}

/**
 * The ONE admin credential lookup every KB entry rides (brief v5 §B).
 * Resolves to `null` — never throws — when the admin cannot answer, so the
 * caller falls through to the env-configured credential modes unchanged.
 *
 * Cache policy (see module doc): fresh in-memory → zero requests; TTL-expired
 * → serve stale + one cadence-bounded background refresh; expired miss → one
 * retry; cold → the persisted answer if it survives, then the network.
 */
export async function readAdminKbCredential(
  productSpaceId: string,
  expectedEnterpriseId: string,
): Promise<AdminKbLibraryCredential | null> {
  const entry = cache.get(productSpaceId)
  if (entry && entry.enterpriseId !== expectedEnterpriseId) {
    // The trusted scope moved the space to another enterprise: the cached key
    // is not this enterprise's any more. Drop it — never serve it, never let
    // a background refresh pin it back.
    cache.delete(productSpaceId)
    lastRefreshAttemptAt.delete(productSpaceId)
  }
  const current = cache.get(productSpaceId)
  if (current?.credential) {
    if (Date.now() - current.fetchedAt < ttlMs) return current.credential
    scheduleBackgroundRefresh(productSpaceId, expectedEnterpriseId)
    return current.credential
  }
  if (current && Date.now() - current.fetchedAt < missTtlMs) return null
  // Cold (or an expired miss): the persisted answer — if any — is served
  // immediately and refreshed in the background, so a restarted process does
  // not block its first KB call on the admin. A stamp of 0 (unparseable) simply
  // counts as stale — the background refresh re-stamps it.
  const persisted = await readPersistedEntry(productSpaceId, expectedEnterpriseId)
  if (persisted) {
    cache.set(productSpaceId, {
      credential: persisted.credential,
      enterpriseId: expectedEnterpriseId,
      fetchedAt: persisted.fetchedAt,
    })
    scheduleBackgroundRefresh(productSpaceId, expectedEnterpriseId)
    return persisted.credential
  }
  return fetchAdminCredential(productSpaceId, expectedEnterpriseId)
}

/**
 * The resolved OpenViking config for an admin-issued library (brief v5 §B):
 * the ADMIN baseUrl replaces the env one, and NEITHER env key applies — the
 * library is dedicated to this space and the admin-issued key is its only
 * credential. `managedApiKey` deliberately stays UNSET: the managed mode
 * nests each space under a derived directory inside ONE shared library,
 * while a dedicated library's space root is the library root itself.
 */
export function adminKbSpaceConfig(credential: AdminKbLibraryCredential): OpenVikingConfig {
  const env = readOpenVikingConfig()
  if (env && !warnedOnce) {
    warnedOnce = true
    // Server log only — no key values, just the precedence decision.
    console.warn(
      '[OpenViking] the admin-managed per-space library credential is in effect;'
      + ` ignoring the env-configured ${env.managedApiKey ? 'POLO_OPENVIKING_API_KEY' : 'POLO_OPENVIKING_ROOT_API_KEY'} for knowledge-base spaces`,
    )
  }
  return {
    baseUrl: credential.baseUrl,
    managedApiKey: undefined,
    rootApiKey: undefined,
    processingMode: env?.processingMode ?? 'vectors_only',
  }
}

/** The data-plane auth derived from an admin-issued credential. */
export function adminKbAuth(credential: AdminKbLibraryCredential): OpenVikingTenantAuth {
  // The account id is the library's ResourceID — the label the cloud model
  // assigns, unused by the data plane (the bearer key is the credential).
  return { accountId: credential.resourceId, userKey: credential.apiKey }
}
