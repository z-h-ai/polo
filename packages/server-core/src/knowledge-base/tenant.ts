import { createHash } from 'crypto'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  isOpenVikingAlreadyExists,
  openVikingAttrs,
  openVikingCreateAccount,
  openVikingListUsers,
  openVikingSetTags,
  type OpenVikingConfig,
  type OpenVikingTenantAuth,
} from './openviking-client'
import { isTrustedSessionScopeTokenCurrent, type TrustedSessionScopeToken } from '../handlers/rpc/trusted-product-space-account'
import {
  auditedRemoteWrite,
  kbDirectoryTagBackoffMs,
  kbTagHexDecode,
  kbTagHexEncode,
  type KbRemoteAuditRecord,
} from './store'
import { KB_SERVICE_UNAVAILABLE_MESSAGE, KbStoreError } from './errors'

/**
 * Tenant provisioning for the enterprise knowledge base (POO-108 v3.1).
 *
 * ONE OpenViking account IS one Polo enterprise ProductSpace (brief D1): the
 * account id is derived deterministically from the space (`polo-<slug>-<hash8>`)
 * so every device derives the SAME account for the SAME space without a
 * registry. Ownership is pinned by two tags written to the account's resource
 * root at creation time (`polo_space`, `polo_enterprise`); any path that
 * re-uses an EXISTING account must read those tags back and compare them
 * BEFORE touching the account — a mismatch or a missing marker fails closed
 * (`kb_service_unavailable` + an `openviking.binding_mismatch` audit entry),
 * never a silent takeover of a foreign tenant (review BLOCKER, brief D1).
 *
 * The tenant's data-plane credential (the account's `polo-service` user key)
 * is bound to the ProductSpace id through the CredentialManager (encrypted
 * backend, `kb_openviking_tenant` credential type) — never UserPreferences,
 * which is plaintext and reaches display/export paths (brief D2). Provisioning
 * is serialized per space with the CredentialManager's exclusive lease, and
 * is IDEMPOTENT end to end: create → `ALREADY_EXISTS` → verify marker →
 * read the existing key back (a read — re-signing would invalidate the key
 * every other device holds).
 *
 * Trust boundary: the root key never enters this module's callers — it lives
 * in the config and is used ONLY for the admin-plane calls here. Deployment
 * scope: the root-key distribution model is a controlled-dev / single-tenant
 * pilot path; multi-enterprise GA requires the admin-side key custody
 * (follow-up card #1, brief D2).
 */

/** The trusted enterprise facts a tenant is derived from. */
export interface KbTenantIdentity {
  productSpaceId: string
  enterpriseId: string
  /** The human-readable space name; feeds the account slug only. */
  spaceName: string
}

/**
 * The tenant binding cached in the CredentialManager: everything a data-plane
 * call needs plus the facts the ownership check compares against.
 */
export interface KbTenantCredential {
  accountId: string
  userId: string
  apiKey: string
  enterpriseId: string
  provisionedAt: string
}

/**
 * The service user every account gets (brief D2). One identity per ACCOUNT —
 * member-level users are follow-up card #2.
 */
export const KB_TENANT_SERVICE_USER_ID = 'polo-service'

/** The ownership tags on the account's resource root (brief §1.6). */
const KB_TENANT_SPACE_TAG = 'polo_space'
const KB_TENANT_ENTERPRISE_TAG = 'polo_enterprise'

/** The resource root every account owns; tags pinning ownership live here. */
export const KB_TENANT_ROOT_URI = 'viking://resources/'

/**
 * ProductSpace ids are opaque (any non-blank string up to 512 chars), so the
 * account suffix is a deterministic short hash — collision-resistant,
 * ASCII-only (the service refuses non-alpha-numeric account ids) and stable
 * across processes.
 */
export function kbTenantSpaceHash(productSpaceId: string): string {
  return createHash('sha256').update(productSpaceId).digest('hex').slice(0, 8)
}

/** ASCII slug for the readable part of the account id (CJK → dropped). */
function asciiSlug(name: string, maxLength: number, fallback: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || fallback
}

/**
 * The deterministic account id for a ProductSpace (brief D1). The readable
 * slug carries the space NAME (≤24 chars, ASCII-folded) for Studio
 * legibility; uniqueness comes from the hash.
 *
 * Review fix round R1: the derivation names the account ONLY at first
 * provision. Once a binding exists — cached on this device or recovered
 * through the verified `ALREADY_EXISTS` path — that binding is AUTHORITATIVE
 * and is reused verbatim, even when the slug no longer matches (the space was
 * renamed, or the derivation changed between versions). Re-deriving would
 * build a SECOND, empty account and strand the data in the old one, so
 * slug-only drift is recorded as `openviking.binding_name_drift` and the
 * established binding always wins.
 */
export function kbTenantAccountId(identity: KbTenantIdentity): string {
  return `polo-${asciiSlug(identity.spaceName, 24, 'space')}-${kbTenantSpaceHash(identity.productSpaceId)}`
}

function credentialId(productSpaceId: string): { type: 'kb_openviking_tenant'; name: string } {
  return { type: 'kb_openviking_tenant', name: productSpaceId }
}

/**
 * The audit sink, injected by the caller (the store owns the audit trail —
 * this module stays free of storage-layer imports).
 */
export type KbTenantAudit = (action: string, target: string, detail?: Record<string, unknown>) => void

export interface EnsureKbTenantParams {
  config: OpenVikingConfig
  identity: KbTenantIdentity
  /** The actor recorded on provisioning audit entries. */
  actor: string
  audit: KbTenantAudit
  /**
   * The await-spanning scope token captured at the RPC entry; revalidated
   * before every remote WRITE the provisioning performs (brief §3 item 5).
   */
  scopeToken?: TrustedSessionScopeToken
}

function unavailable(message: string, detail: unknown): KbStoreError {
  return new KbStoreError('kb_service_unavailable', message, detail)
}

/** The stored credential shape: one JSON payload keeps the binding atomic. */
function encodeCredential(credential: KbTenantCredential): string {
  return JSON.stringify(credential)
}

function decodeCredential(value: string): KbTenantCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<KbTenantCredential>
    if (
      typeof parsed.accountId !== 'string' || typeof parsed.userId !== 'string'
      || typeof parsed.apiKey !== 'string' || typeof parsed.enterpriseId !== 'string'
      || typeof parsed.provisionedAt !== 'string'
    ) return null
    return parsed as KbTenantCredential
  } catch {
    return null
  }
}

/**
 * Reads the cached tenant credential for a ProductSpace, WITHOUT any remote
 * call and WITHOUT provisioning — the read/send path's only tenant lookup.
 * A cache entry naming a DIFFERENT enterprise fails closed: the local cache
 * is proof the space was bound elsewhere, and reusing the key would hand one
 * enterprise's tenant to another (the same fail-closed rule as the remote
 * marker check, brief D1).
 */
export async function readKbTenantCredential(productSpaceId: string, expectedEnterpriseId?: string): Promise<KbTenantCredential | null> {
  let stored: { value?: unknown } | null
  try {
    stored = await getCredentialManager().get(credentialId(productSpaceId))
  } catch (error) {
    // An unreadable credential store is an availability failure, not an
    // empty answer — the caller must not treat it as "never provisioned".
    throw unavailable(
      KB_SERVICE_UNAVAILABLE_MESSAGE,
      `credential store read failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!stored || typeof stored.value !== 'string') return null
  const credential = decodeCredential(stored.value)
  if (!credential) return null
  if (expectedEnterpriseId !== undefined && credential.enterpriseId !== expectedEnterpriseId) {
    throw new KbStoreError(
      'kb_space_mismatch',
      'The knowledge base tenant is bound to a different enterprise',
    )
  }
  return credential
}

/** The data-plane auth derived from a cached/created tenant credential. */
export function kbTenantAuth(credential: KbTenantCredential): OpenVikingTenantAuth {
  return { accountId: credential.accountId, userKey: credential.apiKey }
}

async function storeCredential(identity: KbTenantIdentity, credential: KbTenantCredential): Promise<void> {
  await getCredentialManager().set(credentialId(identity.productSpaceId), {
    value: encodeCredential(credential),
  })
}

/** Revalidates the scope token before a remote write is initiated. */
function assertScopeTokenCurrent(token: TrustedSessionScopeToken | undefined): void {
  if (token && !isTrustedSessionScopeTokenCurrent(token)) {
    throw new KbStoreError('PRODUCT_SPACE_CONTEXT_REQUIRED', 'The trusted scope changed during the operation')
  }
}

/** Reads the ownership tags off the account root; `null` when the root has none. */
async function readOwnershipTags(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
): Promise<Record<string, string> | null> {
  try {
    const root = await openVikingAttrs(config, auth, KB_TENANT_ROOT_URI)
    return root?.tags ?? null
  } catch (error) {
    throw unavailable(
      KB_SERVICE_UNAVAILABLE_MESSAGE,
      `ownership tag read failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Pins the ownership marker onto the account root, with the discipline the
 * store applies to every directory write:
 *
 * - **Audited** (B8 residual): the marker write is a remote write that may
 *   land past a timeout — it carries the same intent/result/unknown trail as
 *   the store's writes.
 * - **Verified** (e2e round 2026-10-21, E1): a `set_tags` issued right after
 *   the account's creation answers `ok` while silently dropping the tags.
 *   The write is read back through `fs/attrs` and retried with the store's
 *   bounded backoff — an unverified marker here would fail-closed the NEXT
 *   provisioning attempt forever (`binding_mismatch`, marker missing).
 * - **Hex-carried** (E2): the marker values are exact ids the server's tag
 *   lower-casing would distort, so they travel hex-encoded (see
 *   `kbTagHexEncode` in the store).
 *
 * The scope token is revalidated before EVERY physical write, retries
 * included (brief §3 item 5).
 */
async function pinOwnershipTags(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  identity: KbTenantIdentity,
  actor: string,
  audit: KbTenantAudit,
  scopeToken: TrustedSessionScopeToken | undefined,
): Promise<void> {
  const record: KbRemoteAuditRecord = entry => audit(entry.action, entry.target, entry.detail)
  const tags = [
    `${KB_TENANT_SPACE_TAG}=${kbTagHexEncode(identity.productSpaceId)}`,
    `${KB_TENANT_ENTERPRISE_TAG}=${kbTagHexEncode(identity.enterpriseId)}`,
  ]
  for (let attempt = 1; ; attempt += 1) {
    await auditedRemoteWrite(record, actor, {
      action: 'remote.set_tags',
      target: KB_TENANT_ROOT_URI,
      detail: { kind: 'ownership_marker', attempt },
    }, async () => {
      assertScopeTokenCurrent(scopeToken)
      await openVikingSetTags(config, auth, {
        uri: KB_TENANT_ROOT_URI,
        tags,
        mode: 'append',
      })
    })
    const root = await openVikingAttrs(config, auth, KB_TENANT_ROOT_URI).catch(() => null)
    if (root?.tags[KB_TENANT_SPACE_TAG] === kbTagHexEncode(identity.productSpaceId)
      && root?.tags[KB_TENANT_ENTERPRISE_TAG] === kbTagHexEncode(identity.enterpriseId)) {
      return
    }
    if (attempt >= KB_MARKER_ATTEMPTS) {
      throw unavailable(
        KB_SERVICE_UNAVAILABLE_MESSAGE,
        `ownership marker did not stick after ${KB_MARKER_ATTEMPTS} attempts`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, kbDirectoryTagBackoffMs(attempt)))
  }
}

const KB_MARKER_ATTEMPTS = 3

/**
 * The one idempotent provisioning entry point (brief D2). Safe to call from
 * any collection-creating RPC on any device:
 *
 * 1. cached binding → verified against the expected enterprise → reuse.
 * 2. under the per-space exclusive lease: create the account; on
 *    `ALREADY_EXISTS` verify the OWNERSHIP MARKER before anything else —
 *    mismatch or missing marker → fail closed with an audit entry; match →
 *    read the existing service-user key back (never re-signed) and rebind.
 *
 * Provisioning failure is ALWAYS `kb_service_unavailable` with the raw cause
 * in `detail` — the caller logs it and surfaces the neutral text (brief D7).
 */
/**
 * Review fix round R1: an established binding is AUTHORITATIVE. A slug-only
 * account-id drift (renamed space, derivation changed between versions) is
 * recorded and the binding reused — never rebuilt, which would strand the
 * data in a second, empty account. The enterprise check has already passed by
 * the time this runs (readKbTenantCredential throws `kb_space_mismatch`),
 * so the drift cannot hide a cross-enterprise swap.
 */
function adoptCachedBinding(
  cached: KbTenantCredential,
  identity: KbTenantIdentity,
  derivedAccountId: string,
  audit: KbTenantAudit,
): KbTenantCredential {
  if (cached.accountId !== derivedAccountId) {
    audit('openviking.binding_name_drift', identity.productSpaceId, {
      derived: derivedAccountId,
      bound: cached.accountId,
    })
  }
  return cached
}

export async function ensureKbTenant(params: EnsureKbTenantParams): Promise<KbTenantCredential> {
  const { config, identity, actor, audit } = params
  const accountId = kbTenantAccountId(identity)

  // Fast path: a cached binding for THIS space skips the remote plane
  // entirely — including when the slug has drifted (R1, above).
  const cached = await readKbTenantCredential(identity.productSpaceId, identity.enterpriseId)
  if (cached) return adoptCachedBinding(cached, identity, accountId, audit)

  const manager = getCredentialManager()
  return manager.withExclusiveLease(`kb-ov:${identity.productSpaceId}`, async () => {
    // Double-check: a concurrent waiter may have provisioned while this call
    // waited for the lease. The raced binding wins under the same R1 rule.
    const raced = await readKbTenantCredential(identity.productSpaceId, identity.enterpriseId)
    if (raced) return adoptCachedBinding(raced, identity, accountId, audit)

    const adminUserId = KB_TENANT_SERVICE_USER_ID
    // B8 residual: the provisioning plane's remote writes (account creation,
    // ownership marker) carry the SAME intent/result/unknown trail as every
    // store write — a timeout there may also have landed.
    const auditRecord: KbRemoteAuditRecord = entry => audit(entry.action, entry.target, entry.detail)
    try {
      const created = await auditedRemoteWrite(auditRecord, actor, {
        action: 'remote.create_account',
        target: accountId,
        detail: { adminUserId },
      }, async () => {
        assertScopeTokenCurrent(params.scopeToken)
        return openVikingCreateAccount(config, { accountId, adminUserId })
      })
      // Pin ownership IMMEDIATELY: between create and marker the account is an
      // orphan a crash cannot distinguish from a foreign one — the next
      // provisioning attempt fails closed and needs manual repair. Accepted:
      // the window is one remote call wide and fail-closed beats takeover.
      const auth: OpenVikingTenantAuth = { accountId, userKey: created.userKey }
      await pinOwnershipTags(config, auth, identity, actor, audit, params.scopeToken)
      const credential: KbTenantCredential = {
        accountId,
        userId: created.adminUserId,
        apiKey: created.userKey,
        enterpriseId: identity.enterpriseId,
        provisionedAt: new Date().toISOString(),
      }
      await storeCredential(identity, credential)
      audit('openviking.tenant_provisioned', accountId, {
        productSpaceId: identity.productSpaceId,
        enterpriseId: identity.enterpriseId,
        userId: created.adminUserId,
      })
      return credential
    } catch (error) {
      if (error instanceof KbStoreError) {
        // The scope-token guard (a local refusal) and prior availability
        // failures pass through unchanged.
        if (error.code === 'PRODUCT_SPACE_CONTEXT_REQUIRED' || error.code === 'kb_service_unavailable') throw error
      }
      if (!isOpenVikingAlreadyExists(error)) {
        throw unavailable(
          KB_SERVICE_UNAVAILABLE_MESSAGE,
          `provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      // The account exists. Whose is it? The marker decides — without a
      // matching marker this call must NOT adopt the account (review BLOCKER).
      const existing = await findExistingTenantKey(config, identity, accountId, adminUserId, audit)
      const credential: KbTenantCredential = {
        accountId,
        userId: existing.userId,
        apiKey: existing.userKey,
        enterpriseId: identity.enterpriseId,
        provisionedAt: new Date().toISOString(),
      }
      await storeCredential(identity, credential)
      audit('openviking.tenant_recovered', accountId, {
        productSpaceId: identity.productSpaceId,
        enterpriseId: identity.enterpriseId,
        userId: existing.userId,
      })
      return credential
    }
  })
}

/**
 * The `ALREADY_EXISTS` recovery path: verify the ownership marker, then read
 * the EXISTING service-user key back from the users list. The read has no
 * side effects — re-signing (`POST .../users/{id}/key`) would invalidate the
 * key every other device holds (brief D2).
 */
async function findExistingTenantKey(
  config: OpenVikingConfig,
  identity: KbTenantIdentity,
  accountId: string,
  adminUserId: string,
  audit: KbTenantAudit,
): Promise<{ userId: string; userKey: string }> {
  let auth: OpenVikingTenantAuth
  try {
    // No usable key exists on THIS device (the cache missed) — the marker
    // read needs a data-plane key, so the users list runs first and the
    // recovered key verifies the marker with it.
    const users = await openVikingListUsers(config, accountId)
    const serviceUser = users.find(user => user.userId === adminUserId)
      ?? users.find(user => user.userKey !== null)
    if (!serviceUser?.userKey) {
      throw unavailable(
        KB_SERVICE_UNAVAILABLE_MESSAGE,
        'existing tenant has no recoverable service-user key; ask the administrator to re-provision',
      )
    }
    auth = { accountId, userKey: serviceUser.userKey }
  } catch (error) {
    if (error instanceof KbStoreError) throw error
    throw unavailable(
      KB_SERVICE_UNAVAILABLE_MESSAGE,
      `credential recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const tags = await readOwnershipTags(config, auth)
  // E2: markers are hex-carried now (the server lower-cases tag values);
  // plaintext markers written before that round still compare directly.
  const spaceTag = kbTagHexDecode(tags?.[KB_TENANT_SPACE_TAG])
    ?? tags?.[KB_TENANT_SPACE_TAG]
    ?? null
  const enterpriseTag = kbTagHexDecode(tags?.[KB_TENANT_ENTERPRISE_TAG])
    ?? tags?.[KB_TENANT_ENTERPRISE_TAG]
    ?? null
  if (spaceTag !== identity.productSpaceId || enterpriseTag !== identity.enterpriseId) {
    // Fail closed WITH the reason in the audit trail; the RPC stays neutral.
    audit('openviking.binding_mismatch', accountId, {
      productSpaceId: identity.productSpaceId,
      enterpriseId: identity.enterpriseId,
      markerSpace: spaceTag,
      markerEnterprise: enterpriseTag,
    })
    throw unavailable(
      KB_SERVICE_UNAVAILABLE_MESSAGE,
      `tenant ownership mismatch: marker space=${spaceTag ?? '(missing)'} enterprise=${enterpriseTag ?? '(missing)'}`,
    )
  }
  return { userId: adminUserId, userKey: auth.userKey }
}
