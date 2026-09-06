import {
  AdminClient,
  AdminError,
  type AdminErrorDetails,
  denyAppCatalogAccessForAccount,
  denyCachedAppCatalogAuthorization,
  denyCachedAppCatalogAuthorizationForAccount,
  getAppCatalogAccessMode,
  getCachedAppCatalog,
  getSafeAdminErrorMessage,
  listCachedAppCatalogs,
  resumeAppCatalogAccessForAccount,
  saveAppCatalog,
  setAppCatalogAccessMode,
  type AppCatalogCacheEntry,
  type AppCatalogSyncResult,
  type AdminErrorCode,
  type AdminLlmConnection,
  type AdminLoginResponse,
  type AdminRefreshResponse,
  type AdminUser,
  type DeniedAppCatalogSnapshot,
  analyzeCreatorAppPayload,
  createCanonicalCreatorAppBundle,
  decodeCreatorAppPayloadZip,
  resolveCreatorAppPublishingOrganization,
} from '@polo-ai/shared/admin'
import { z } from 'zod'
import {
  classifyAdminAuthorizationFailure,
  markAppCatalogAccessDenied,
} from '@polo-ai/shared/admin/authorization'
import { createOrganizationContextKey } from '@polo-ai/shared/admin/context-key'
import {
  AdminLoginRpcInputSchema,
  CatalogOrganizationIdRpcInputSchema,
  CreateOrganizationInvitationRpcInputSchema,
  CreateOrganizationJoinLinkRpcInputSchema,
  CreateOrganizationRpcInputSchema,
  OrganizationIdRpcInputSchema,
  OrganizationJoinTokenRpcInputSchema,
  RemoveOrganizationMemberRpcInputSchema,
  SendPhoneAuthCodeRpcInputSchema,
  SetAdminPasswordRpcInputSchema,
  UpdateOrganizationMemberRpcInputSchema,
  VerifyPhoneAuthCodeRpcInputSchema,
} from '@polo-ai/shared/admin/schemas'
import {
  CreateCreatorArtifactRpcInputSchema,
  CreatorArtifactArchiveRpcInputSchema,
  CreatorArtifactIdRpcInputSchema,
  CreatorArtifactDetailSchema,
  CreatorArtifactListRpcInputSchema,
  CreatorArtifactRevokeRpcInputSchema,
  CreatorArtifactUploadCompleteRpcInputSchema,
  CreatorArtifactUploadGrantRpcInputSchema,
  CreatorArtifactVersionRpcInputSchema,
  CreatorSkillArchiveError,
  CreatorSkillDownloadRpcInputSchema,
  CreatorSkillSafetyRpcInputSchema,
  CreateCreatorArtifactVersionRpcInputSchema,
} from '@polo-ai/shared/creator-skills'
import {
  addLlmConnection,
  deleteLlmConnection,
  getAdminConfigVersion,
  getAdminUrl,
  getLlmConnections,
  setAdminConfigVersion,
  setDefaultLlmConnection,
  updateLlmConnection,
  type LlmConnection,
} from '@polo-ai/shared/config'
import { getCredentialManager, type CredentialManager } from '@polo-ai/shared/credentials'
import {
  CatalogEntryIdSchema,
  ProductSpaceIdSchema,
  createProductSpaceContextKey,
} from '@polo-ai/shared/product-spaces'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import {
  beginAccountTransition,
  settleAccountTransition,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
  setTrustedProductSpaceListFetcher,
  type TrustedProductSpaceListResult,
} from './trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  getRuntimeFenceGeneration,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
  isSwitchInProgress,
  revokeRuntimeProductSpaceFence,
  revokeRuntimeProductSpaceFenceIfBoundLocked,
  withSwitchLock,
} from '../../runtime/product-space-executions'
import { revokeProductSpaceCatalogAuthority } from '../../runtime/product-space-catalog-authority'
// INTERNAL commit entry: the ONLY grant-capable mutator, reachable solely
// from this schema-validated Admin Catalog commit path (not exported by the
// package `exports` map — asserted by the authority boundary tests).
import { recordProductSpaceCatalogAuthoritativeEntries } from '../../runtime/product-space-catalog-authority-commit'
import type { HandlerDeps } from '../handler-deps'
import { decryptTransitApiKey, deriveTransitKey } from '../../lib/admin-transit-decrypt'

// Latest-request fence per (account, ProductSpace) for the unified Catalog —
// a BOUNDED in-flight structure: each scope tracks its latest (global
// monotonic) invocation and the number of in-flight requests; the scope
// entry is deleted once every request for that scope has finished, so
// renderer-supplied identifiers cannot grow the map without bound. Global
// invocation IDs prevent ABA revival across scope re-creation.
interface ProductSpaceCatalogSyncScope {
  latestInvocation: number
  inFlight: number
  /**
   * Invocations that passed the pre-check and are about to commit. The set
   * is per-INVOCATION: an older request settling (even last) can never
   * release a newer request's reservation.
   */
  pendingCommitInvocations: Set<number>
}
const productSpaceCatalogSyncScopes = new Map<string, ProductSpaceCatalogSyncScope>()
let nextProductSpaceCatalogSyncInvocation = 0

function beginProductSpaceCatalogSync(scopeKey: string): number {
  const invocation = ++nextProductSpaceCatalogSyncInvocation
  let scope = productSpaceCatalogSyncScopes.get(scopeKey)
  if (!scope) {
    scope = {
      latestInvocation: 0,
      inFlight: 0,
      pendingCommitInvocations: new Set<number>(),
    }
    productSpaceCatalogSyncScopes.set(scopeKey, scope)
  }
  scope.latestInvocation = invocation
  scope.inFlight += 1
  return invocation
}

/**
 * Marks a request as having passed its pre-check and heading for the
 * session-current commit zone: its final CAS must stay decidable even when
 * another (older) request settles last and drains the in-flight count.
 */
function markProductSpaceCatalogCommitPending(
  scopeKey: string,
  invocation: number,
): void {
  const scope = productSpaceCatalogSyncScopes.get(scopeKey)
  if (!scope) return
  scope.pendingCommitInvocations.add(invocation)
}

function isLatestProductSpaceCatalogSync(scopeKey: string, invocation: number): boolean {
  return productSpaceCatalogSyncScopes.get(scopeKey)?.latestInvocation === invocation
}

/**
 * Settles one finished request. The scope entry survives while a commit is
 * still pending in the session-current zone or another request is in
 * flight; a fully idle scope (no in-flight requests, no pending commits) is
 * deleted immediately so the map stays bounded.
 */
function settleProductSpaceCatalogSync(scopeKey: string): void {
  const scope = productSpaceCatalogSyncScopes.get(scopeKey)
  if (!scope) return
  scope.inFlight = Math.max(0, scope.inFlight - 1)
  if (scope.inFlight === 0 && scope.pendingCommitInvocations.size === 0) {
    productSpaceCatalogSyncScopes.delete(scopeKey)
  }
}

/**
 * Releases a consumed commit from the session-current zone: once the scope
 * is fully idle its entry is deleted.
 */
/**
 * Releases THIS invocation's own reservation. A request that never marked
 * (list/Catalog failure, notModified, superseded) has nothing to release and
 * can never consume a newer request's pending reservation.
 */
function releaseProductSpaceCatalogCommit(
  scopeKey: string,
  invocation: number,
): void {
  const scope = productSpaceCatalogSyncScopes.get(scopeKey)
  if (!scope) return
  scope.pendingCommitInvocations.delete(invocation)
  if (scope.inFlight === 0 && scope.pendingCommitInvocations.size === 0) {
    productSpaceCatalogSyncScopes.delete(scopeKey)
  }
}

/**
 * Test-only: force-bump the ProductSpace Catalog latest-request fence,
 * simulating a newer request's registration-and-exit without a second full
 * session (the registered invocation permanently supersedes older ones).
 */
export function __bumpProductSpaceCatalogSyncFenceForTests(scopeKey: string): void {
  beginProductSpaceCatalogSync(scopeKey)
  settleProductSpaceCatalogSync(scopeKey)
}

/** Test-only: scope count for fence-bounds regressions. */
export function __productSpaceCatalogSyncScopeCountForTests(): number {
  return productSpaceCatalogSyncScopes.size
}

/** Test-only: whether an invocation is still the fence's latest. */
export function __isLatestProductSpaceCatalogSyncForTests(scopeKey: string, invocation: number): boolean {
  return isLatestProductSpaceCatalogSync(scopeKey, invocation)
}

/** Test-only: the latest registered invocation for a scope (or null). */
export function __latestProductSpaceCatalogSyncInvocationForTests(scopeKey: string): number | null {
  return productSpaceCatalogSyncScopes.get(scopeKey)?.latestInvocation ?? null
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.admin.LOGIN,
  RPC_CHANNELS.admin.GET_AUTH_CONFIG,
  RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG,
  RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
  RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE,
  RPC_CHANNELS.admin.SET_PASSWORD,
  RPC_CHANNELS.admin.VALIDATE,
  RPC_CHANNELS.admin.LOGOUT,
  RPC_CHANNELS.admin.GET_STATUS,
  RPC_CHANNELS.admin.SYNC_CONNECTIONS,
  RPC_CHANNELS.admin.SYNC_APP_CATALOG,
  RPC_CHANNELS.admin.LIST_ORGANIZATIONS,
  RPC_CHANNELS.admin.LIST_PRODUCT_SPACES,
  RPC_CHANNELS.productSpace.CATALOG,
  RPC_CHANNELS.productSpace.RESOLVE_LAUNCH,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION,
  RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN,
  RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN,
  RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS,
  RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION,
  RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION,
  RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK,
  RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK,
  RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER,
  RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER,
  RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT_CAPABILITIES,
  RPC_CHANNELS.admin.LIST_CREATOR_ARTIFACTS,
  RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT,
  RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT,
  RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_DRAFT,
  RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.CREATE_CREATOR_SKILL_UPLOAD_GRANT,
  RPC_CHANNELS.admin.COMPLETE_CREATOR_SKILL_UPLOAD,
  RPC_CHANNELS.admin.PUBLISH_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_VERSION_DRAFT,
  RPC_CHANNELS.admin.SET_CREATOR_ARTIFACT_ARCHIVED,
  RPC_CHANNELS.admin.REVOKE_CREATOR_ARTIFACT_VERSION,
  RPC_CHANNELS.admin.GET_CREATOR_SKILL_DOWNLOAD_GRANT,
  RPC_CHANNELS.admin.GET_CREATOR_SKILL_SAFETY_STATUS,
  RPC_CHANNELS.admin.PUBLISH_CREATOR_APP,
] as const

const CreatorAppPublishRpcInputSchema = z.object({
  organizationId: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(128),
  visibility: z.literal('all_members'),
  mode: z.enum(['website', 'upload']),
  websiteUrl: z.string().url().max(16_384).optional(),
  /** ZIP bytes cross the authenticated local RPC only as base64. */
  payloadBase64: z.string().min(1).max(70 * 1024 * 1024).optional(),
  selectedEntry: z.object({ runtime: z.enum(['static', 'python', 'js']), path: z.string().min(1).max(4_096) }).strict().optional(),
  appId: z.string().min(1).max(512).optional(),
}).strict().superRefine((input, context) => {
  if (input.mode === 'website') {
    if (!input.websiteUrl || new URL(input.websiteUrl).protocol !== 'https:') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['websiteUrl'], message: 'HTTPS URL required' })
    }
  } else if (!input.payloadBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.payloadBase64)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payloadBase64'], message: 'ZIP payload required' })
  }
})

const CREATOR_APP_RELEASE_CONFLICT_RETRIES = 3

function nextCreatorAppPatchVersion(releases: readonly { version: string }[]): string {
  const patches = releases
    .map(release => /^1\.0\.(\d+)$/.exec(release.version)?.[1])
    .filter((patch): patch is string => patch !== undefined)
    .map(Number)
  return `1.0.${patches.length ? Math.max(...patches) + 1 : 0}`
}

type StoredAdminTokens = NonNullable<Awaited<ReturnType<CredentialManager['getAdminTokens']>>>
interface AdminSessionSnapshot {
  generation: number
  tokens: StoredAdminTokens
}

interface AdminSessionEndingTransition {
  session: AdminSessionSnapshot
  cleanup: Promise<void>
  /** R39-1: the immutable transition epoch THIS flow began and owns. */
  transitionEpoch: number
}

interface AdminRequestContext {
  session: AdminSessionSnapshot
}

type TokenValidationResult =
  | {
      tokens: StoredAdminTokens
      session: AdminSessionSnapshot
      accessMode: 'online' | 'offline'
      warning?: string
    }
  | {
      tokens: null
      stale?: boolean
      authError?: { errorCode: string; message: string; status?: number }
    }

interface AdminSessionMutationResult<T> {
  applied: boolean
  value?: T
}

export type AdminSessionEndResult = 'ended' | 'no_session' | 'session_changed'

export interface AdminSessionControl {
  endCurrentSession(
    beforeDelete?: (manager: CredentialManager) => void | Promise<void>,
  ): Promise<AdminSessionEndResult>
}

class AdminSessionChangedError extends Error {
  constructor() {
    super('Admin session changed while the request was in flight')
    this.name = 'AdminSessionChangedError'
  }
}

/**
 * Serializes trusted Admin session transitions. The session generation, login
 * attempt, and ending snapshot are advanced only by code running under
 * `runExclusive`; an ending generation therefore closes every older commit
 * before the lock is released. Host cleanup is started while that transition
 * is locked, but its slow promise stays outside the mutation tail so a new
 * login is not blocked. Cleanup is single-flight per account until settlement,
 * and the recorded generation keeps an older finalizer from deleting a newer
 * cleanup entry.
 */
class AdminSessionCoordinator {
  private generation = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private loginAttempt = 0
  private endingSession: AdminSessionSnapshot | null = null
  private readonly accountCleanups = new Map<string, {
    generation: number
    promise: Promise<void>
  }>()

  constructor(
    private readonly closeCatalogAuthorization: (accountId: string) => void,
  ) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async beginLoginAttempt(): Promise<number> {
    return this.runExclusive(async () => {
      this.loginAttempt += 1
      return this.loginAttempt
    })
  }

  isLatestLoginAttempt(attempt: number): boolean {
    return attempt === this.loginAttempt
  }

  advanceGeneration(): number {
    this.generation += 1
    return this.generation
  }

  closeAuthorizationForEnding(accountId: string): void {
    this.closeCatalogAuthorization(accountId)
  }

  getOrStartAccountCleanup(
    accountId: string,
    cleanupGeneration: number,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    const existing = this.accountCleanups.get(accountId)
    if (existing) return existing.promise

    let operationResult: Promise<void>
    try {
      operationResult = Promise.resolve(operation())
    } catch (error) {
      operationResult = Promise.reject(error)
    }
    let trackedPromise!: Promise<void>
    trackedPromise = operationResult.finally(() => {
      const current = this.accountCleanups.get(accountId)
      if (
        current?.generation === cleanupGeneration
        && current.promise === trackedPromise
      ) {
        this.accountCleanups.delete(accountId)
      }
    })
    this.accountCleanups.set(accountId, {
      generation: cleanupGeneration,
      promise: trackedPromise,
    })
    return trackedPromise
  }

  createSnapshot(tokens: StoredAdminTokens): AdminSessionSnapshot {
    // Every authenticated-session snapshot (login commit, startup restore,
    // validate/refresh capture) refreshes the synchronous authenticated-
    // account mirror consumed by sync gates such as the webview attach
    // check; session endings clear it explicitly.
    setSyncTrustedProductSpaceAccountId(tokens.userId)
    return {
      generation: this.generation,
      tokens: { ...tokens },
    }
  }

  async capture(
    manager: CredentialManager,
  ): Promise<AdminSessionSnapshot | null> {
    return this.runExclusive(async () => {
      const tokens = await manager.getAdminTokens()
      return tokens && !this.isCurrentSessionEnding(tokens)
        ? this.createSnapshot(tokens)
        : null
    })
  }

  async isCurrent(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      return this.matches(current, expected)
    })
  }

  async mutateIfCurrent<T>(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
    operation: (current: StoredAdminTokens) => Promise<T>,
  ): Promise<AdminSessionMutationResult<T>> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matches(current, expected)) return { applied: false }
      return { applied: true, value: await operation(current!) }
    })
  }

  async beginEnding(
    manager: CredentialManager,
    expected: AdminSessionSnapshot,
    beginAccountCleanup: (accountId: string) => void | Promise<void>,
  ): Promise<AdminSessionEndingTransition | null> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matches(current, expected)) return null
      this.advanceGeneration()
      const ending = this.createSnapshot(current!)
      this.endingSession = ending
      this.closeAuthorizationForEnding(current!.userId)
      // R31: the lock-free account-transition epoch is published inside the
      // successful transition-ownership section — after the current-session
      // CAS matched, before getOrStartAccountCleanup can snapshot
      // executions. Rejected/non-owner transitions never advance it, and it
      // is monotonic (never reset) for failed/aborted owned transitions.
      // R39-1: the epoch returned here is the IMMUTABLE owner token for
      // this flow — settlement must use it, never the mutable global.
      const transitionEpoch = beginAccountTransition()
      const cleanup = this.getOrStartAccountCleanup(
        current!.userId,
        ending.generation,
        () => beginAccountCleanup(current!.userId),
      )
      // The caller awaits and reports this promise after any remote side
      // effect. Observe it now so a fast rejection cannot become unhandled.
      void cleanup.catch(() => {})
      return { session: ending, cleanup, transitionEpoch }
    })
  }

  async finishEndingIfCurrent<T>(
    manager: CredentialManager,
    ending: AdminSessionSnapshot,
    operation: (current: StoredAdminTokens) => Promise<T>,
  ): Promise<AdminSessionMutationResult<T>> {
    return this.runExclusive(async () => {
      const current = await manager.getAdminTokens()
      if (!this.matchesEnding(current, ending)) {
        if (this.sameSnapshot(this.endingSession, ending)) {
          this.endingSession = null
        }
        return { applied: false }
      }
      const value = await operation(current!)
      this.advanceGeneration()
      this.endingSession = null
      return { applied: true, value }
    })
  }

  private isCurrentSessionEnding(current: StoredAdminTokens): boolean {
    return Boolean(
      this.endingSession
      && this.endingSession.generation === this.generation
      && this.tokensMatch(current, this.endingSession.tokens),
    )
  }

  private matchesEnding(
    current: StoredAdminTokens | null,
    ending: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      current
      && this.sameSnapshot(this.endingSession, ending)
      && ending.generation === this.generation
      && this.tokensMatch(current, ending.tokens),
    )
  }

  private sameSnapshot(
    left: AdminSessionSnapshot | null,
    right: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      left
      && left.generation === right.generation
      && this.tokensMatch(left.tokens, right.tokens),
    )
  }

  private tokensMatch(
    current: StoredAdminTokens,
    expected: StoredAdminTokens,
  ): boolean {
    return (
      current.userId === expected.userId
      && current.accessToken === expected.accessToken
      && current.refreshToken === expected.refreshToken
    )
  }

  private matches(
    current: StoredAdminTokens | null,
    expected: AdminSessionSnapshot,
  ): boolean {
    return Boolean(
      current
      && expected.generation === this.generation
      && !this.isCurrentSessionEnding(current)
      && this.tokensMatch(current, expected.tokens),
    )
  }
}

function staleAdminSessionResult(): {
  success: false
  errorCode: 'SESSION_CHANGED'
  message: string
} {
  return {
    success: false,
    errorCode: 'SESSION_CHANGED',
    message: 'Admin session changed',
  }
}

function staleAdminValidationResult(): {
  loggedIn: false
  errorCode: 'SESSION_CHANGED'
  message: string
} {
  return {
    loggedIn: false,
    errorCode: 'SESSION_CHANGED',
    message: 'Admin session changed',
  }
}

let initialSyncAccountRestorePromise: Promise<void> | null = null

/**
 * Resolves once the synchronous authenticated-account mirror has been
 * committed from the persisted Admin credentials (authenticated or the
 * explicitly confirmed signed_out). Electron main awaits this BEFORE
 * creating the first window so the webview attach gate never has to decide
 * on the fail-closed `unknown` state in practice.
 */
export function whenInitialSyncTrustedProductSpaceAccountRestored(): Promise<void> {
  return initialSyncAccountRestorePromise ?? Promise.resolve()
}

export function registerAdminHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): AdminSessionControl {
  const log = deps.platform.logger
  let appCatalogSyncInvocation = 0
  const latestAppCatalogSyncByScope = new Map<string, number>()
  const appCatalogAuthorizationEpochByScope = new Map<string, number>()
  // Keep tuple members structured for account-wide authorization changes.
  // Entity IDs may contain every delimiter used by older prefix encodings.
  const appCatalogScopeByKey = new Map<string, {
    accountId: string
    organizationId: string
  }>()
  const appCatalogScopeKey = (accountId: string, organizationId: string) => {
    const scopeKey = createOrganizationContextKey(accountId, organizationId)
    if (!appCatalogScopeByKey.has(scopeKey)) {
      appCatalogScopeByKey.set(scopeKey, { accountId, organizationId })
    }
    return scopeKey
  }
  const currentAppCatalogAuthorizationEpoch = (scopeKey: string) =>
    appCatalogAuthorizationEpochByScope.get(scopeKey) ?? 0
  const advanceAppCatalogAuthorizationEpoch = (scopeKey: string) => {
    appCatalogAuthorizationEpochByScope.set(
      scopeKey,
      currentAppCatalogAuthorizationEpoch(scopeKey) + 1,
    )
  }
  const closeCatalogAuthorizationForAccount = (accountId: string) => {
    for (const [scopeKey, scope] of appCatalogScopeByKey) {
      if (
        scope.accountId === accountId
        && appCatalogAuthorizationEpochByScope.has(scopeKey)
      ) {
        advanceAppCatalogAuthorizationEpoch(scopeKey)
      }
    }
    denyAppCatalogAccessForAccount(accountId)
    try {
      denyCachedAppCatalogAuthorizationForAccount(accountId)
    } catch (error) {
      log?.warn(
        '[Admin] failed to persist denied Catalog cache while ending the session:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  const catalogOrganizationIdsForAccount = (accountId: string) => {
    const organizationIds = new Set(
      listCachedAppCatalogs(accountId).map(cached => cached.organizationId),
    )
    for (const [scopeKey, scope] of appCatalogScopeByKey) {
      if (
        scope.accountId === accountId
        && appCatalogAuthorizationEpochByScope.has(scopeKey)
      ) {
        organizationIds.add(scope.organizationId)
      }
    }
    return organizationIds
  }
  const markCatalogAccessOfflineForAccount = (accountId: string) => {
    for (const organizationId of catalogOrganizationIdsForAccount(accountId)) {
      if (getAppCatalogAccessMode(accountId, organizationId) === 'online') {
        setAppCatalogAccessMode(accountId, organizationId, 'offline')
      }
    }
  }
  const denyCatalogScope = (
    accountId: string,
    organizationId: string,
  ): DeniedAppCatalogSnapshot | null => {
    const scopeKey = appCatalogScopeKey(accountId, organizationId)
    // The in-memory epoch and gate are the security boundary. Persistence is
    // recovery metadata and must never keep a previously-online process open
    // when a denied-cache write fails.
    advanceAppCatalogAuthorizationEpoch(scopeKey)
    setAppCatalogAccessMode(accountId, organizationId, 'denied')
    try {
      const cleanup = deps.onAdminCatalogScopeDenied?.(
        accountId,
        organizationId,
      )
      void cleanup?.catch(error => {
        log?.warn(
          '[Admin] organization local app cleanup failed after Catalog denial:',
          error instanceof Error ? error.message : String(error),
        )
      })
    } catch (error) {
      log?.warn(
        '[Admin] failed to establish organization local app lifecycle fence:',
        error instanceof Error ? error.message : String(error),
      )
    }
    const cached = getCachedAppCatalog(accountId, organizationId)
    try {
      const deniedCache = denyCachedAppCatalogAuthorization(
        accountId,
        organizationId,
      )
      return deniedCache
        ? markAppCatalogAccessDenied(deniedCache)
        : cached
          ? markAppCatalogAccessDenied(cached)
          : null
    } catch (error) {
      log?.warn(
        '[Admin] failed to persist denied Catalog cache:',
        error instanceof Error ? error.message : String(error),
      )
      return cached ? markAppCatalogAccessDenied(cached) : null
    }
  }
  const sessions = new AdminSessionCoordinator(
    closeCatalogAuthorizationForAccount,
  )

  // One-shot trusted credential restore for the synchronous authenticated-
  // account mirror: reads the persisted Admin credentials once and commits
  // either `authenticated(accountId)` or the explicitly confirmed
  // `signed_out`. Main awaits this before creating the first window so the
  // webview attach gate never decides on the fail-closed `unknown` state in
  // practice; until it resolves the gate refuses every partition.
  let initialSyncAccountRestore: Promise<void> | null = null
  const captureInitialSyncTrustedProductSpaceAccount = (): Promise<void> => {
    initialSyncAccountRestore ??= (async () => {
      try {
        const manager = getCredentialManager()
        // Discriminative read: `signed_out` is committed ONLY when the
        // credential store confirms the admin token does not exist. A
        // store that exists but cannot be read, decrypted or validated
        // stays `unknown` (the sync gate refuses everything) so a corrupt
        // credentials.enc is never mistaken for a signed-out device.
        const presence = await manager.inspectAdminCredentialPresence()
        if (presence.status === 'unreadable_or_invalid') {
          deps.platform.logger.warn(
            '[Admin] persisted Admin credentials are unreadable or invalid; the sync gate stays fail-closed:',
            presence.reason,
          )
          return
        }
        if (presence.status === 'absent') {
          setSyncTrustedProductSpaceAccountId(null)
          return
        }
        // Credential found: resolve the live session snapshot for its user.
        const snapshot = await sessions.capture(manager)
        if (!snapshot) {
          deps.platform.logger.warn(
            '[Admin] persisted Admin credentials exist but no session snapshot could be captured; the sync gate stays fail-closed',
          )
          return
        }
        setSyncTrustedProductSpaceAccountId(snapshot.tokens.userId)
      } catch (error) {
        deps.platform.logger.warn(
          '[Admin] initial ProductSpace account restore failed; the sync gate stays fail-closed:',
          error instanceof Error ? error.message : String(error),
        )
        // Deliberately NOT committed to signed_out: an unreadable credential
        // store is `unknown`, and the sync gate refuses everything.
      }
    })()
    initialSyncAccountRestorePromise = initialSyncAccountRestore
    return initialSyncAccountRestore
  }
  void captureInitialSyncTrustedProductSpaceAccount()

  // The ProductSpace runtime derives the account from this trusted session
  // snapshot instead of trusting RPC arguments. Registered by the admin
  // handler module because only it owns the session coordinator.
  setTrustedProductSpaceAccountProvider(async (): Promise<string | null> => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const snapshot = await sessions.capture(manager)
      if (!snapshot) {
        void adminUrl
        return null
      }
      return snapshot.tokens.userId
    } catch {
      return null
    }
  })

  // The Main-side switch transaction verifies the target space against the
  // account's contract-validated visible list (server-authoritative). The
  // failure mode is typed: an Admin server speaking an incompatible
  // ProductSpace contract is preserved as `product_space_contract_unsupported`
  // so PREPARE/target-revalidation/COMMIT all fail closed into
  // contract-blocked — it must never masquerade as a transient outage.
  setTrustedProductSpaceListFetcher(async (): Promise<TrustedProductSpaceListResult> => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(adminUrl, manager, sessions, deps)
      if (!tokenResult.tokens) return { ok: false, errorCode: 'service_unavailable' }
      const client = createAuthenticatedAdminClient(adminUrl, manager, sessions, {
        session: tokenResult.session,
      })
      const list = await client.listProductSpaces(tokenResult.tokens.accessToken)
      return {
        ok: true,
        list: {
          personalProductSpaceId: list.personalProductSpaceId,
          productSpaces: list.productSpaces.map(space => ({
            id: space.id,
            kind: space.kind,
            name: space.name,
            accessMode: space.accessMode,
          })),
        },
      }
    } catch (error) {
      if (
        error instanceof AdminError
        && error.errorCode === 'product_space_contract_unsupported'
      ) {
        return { ok: false, errorCode: 'product_space_contract_unsupported' }
      }
      return { ok: false, errorCode: 'service_unavailable' }
    }
  })

  type ProductSpaceDenialOrigin = 'remote_authority' | 'local_scope_guard'

  /**
   * Typed denial representation: the origin is a DECLARED readonly field on
   * an AdminError subclass — no dynamic property attachment, no forced
   * casts. `instanceof` + the field give the revocation policy an auditable
   * discriminator.
   */
  class ProductSpaceDenialError extends AdminError {
    readonly denialOrigin: ProductSpaceDenialOrigin

    constructor(
      message: string,
      errorCode: AdminErrorCode,
      origin: ProductSpaceDenialOrigin,
      options?: { status?: number; details?: AdminErrorDetails },
    ) {
      super(message, errorCode, options)
      this.name = 'ProductSpaceDenialError'
      this.denialOrigin = origin
    }
  }

  function denialOriginOf(error: unknown): ProductSpaceDenialOrigin | null {
    return error instanceof ProductSpaceDenialError ? error.denialOrigin : null
  }

  /**
   * THE exact-scope revocation primitive shared by every ProductSpace
   * catalog-scope denial (Catalog sync and direct-open resolution alike).
   * ONE switch-lock critical section decides EVERYTHING: the optional
   * latest-wins CAS, the durable authority deletion, and the fence
   * compare-and-revoke — a newer commit can never interleave between the
   * check and the state writes. Failures propagate after both halves ran.
   */
  async function revokeProductSpaceTrustedScope(options: {
    accountId: string
    productSpaceId: string
    /** Fence generation observed when the denial's request entered scope. */
    fenceGeneration: number | null
    /** Latest-wins CAS evaluated inside the critical section. */
    requireLatestInvocation?: () => boolean
  }): Promise<'revoked' | 'superseded'> {
    return withSwitchLock(async (): Promise<'revoked' | 'superseded'> => {
      if (options.requireLatestInvocation && !options.requireLatestInvocation()) {
        return 'superseded'
      }
      let firstError: unknown = null
      // SYNCHRONOUS: the authority mutation is a same-tick file operation.
      // There must be NO yield between the final latest CAS, the authority
      // mutation and the fence mutation — a yield here would let a queued R2
      // register a newer invocation inside the critical section and split
      // the linearization.
      try {
        revokeProductSpaceCatalogAuthority(options.accountId, options.productSpaceId)
      } catch (error) {
        firstError = error
      }
      revokeRuntimeProductSpaceFenceIfBoundLocked({
        accountId: options.accountId,
        productSpaceId: options.productSpaceId,
        fenceGeneration: options.fenceGeneration ?? getRuntimeFenceGeneration(),
      })
      if (firstError) throw firstError
      return 'revoked'
    })
  }

  interface CatalogScopeRevocationPolicy {
    productSpaceId: string
    /**
     * Awaitable fail-closed revocation for EXACTLY this scope. Receives the
     * denial error and the verified scope (account id + the policy's own
     * productSpaceId). Must throw on failure — callOrganization answers
     * CATALOG_SCOPE_REVOKE_FAILED instead of pretending the state closed.
     * Returns 'superseded' when the denial's latest-wins CAS (evaluated
     * INSIDE the revocation critical section) finds a newer committed
     * invocation: the caller then answers REQUEST_SUPERSEDED with zero
     * state writes.
     */
    onDenied: (
      error: AdminError,
      scope: { accountId: string; productSpaceId: string },
    ) => 'superseded' | void | Promise<'superseded' | void>
  }

  interface CallOrganizationOptions<T> {
    onCurrentSuccess?: (
      result: T,
      session: AdminSessionSnapshot,
    ) => void | Promise<void>
    // ALWAYS-SETTLE cleanup contract: runs exactly once after the callback
    // has settled — whether the session-current CAS applied, was skipped, or
    // the commit-zone work threw. Receives the callback result (or null when
    // the callback never completed).
    onSettled?: (result: T | null) => void
    /**
     * Catalog-scope semantics: org/space-level 403/FORBIDDEN and membership
     * denials stay IN-PAGE (login session preserved, only the failing
     * request fails); 401/TOKEN_REVOKED still end the session. The bundled
     * policy makes the deny hook structurally mandatory.
     */
    catalogScope?: CatalogScopeRevocationPolicy
  }

  const callOrganization = async <T extends object>(
    operation: string,
    callback: (
      client: AdminClient,
      accessToken: string,
      userId: string,
    ) => Promise<T>,
    optionsOrOnCurrentSuccess?:
      | CallOrganizationOptions<T>
      | ((
        result: T,
        session: AdminSessionSnapshot,
      ) => void | Promise<void>),
    // Legacy positional ALWAYS-SETTLE cleanup contract (non-catalog callers).
    legacyOnSettled?: (result: T | null) => void,
  ) => {
    const objectOptions = typeof optionsOrOnCurrentSuccess === 'object' && optionsOrOnCurrentSuccess !== null
      ? optionsOrOnCurrentSuccess as CallOrganizationOptions<T>
      : null
    const onCurrentSuccess = objectOptions
      ? objectOptions.onCurrentSuccess
      : optionsOrOnCurrentSuccess as ((result: T, session: AdminSessionSnapshot) => void | Promise<void>) | undefined
    const onSettled = objectOptions ? objectOptions.onSettled : legacyOnSettled
    // Presence of a catalogScope policy enables catalog-scope error
    // semantics AND carries the mandatory deny hook: a ProductSpace handler
    // cannot opt into scoped 403s while forgetting the fail-closed
    // revocation.
    const catalogScope = objectOptions?.catalogScope ?? null
    let requestContext: AdminRequestContext | null = null
    let manager: CredentialManager | null = null
    let settledResult: T | null = null
    let verifiedUserId: string | null = null
    try {
      const adminUrl = requireAdminUrl()
      manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
        return {
          success: false as const,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }
      if (tokenResult.accessMode === 'offline') {
        return {
          success: false as const,
          errorCode: 'NETWORK_ERROR',
          message: tokenResult.warning ?? 'Failed to reach admin server',
        }
      }
      requestContext = { session: tokenResult.session }
      verifiedUserId = tokenResult.tokens.userId
      const result = await callback(
        createAuthenticatedAdminClient(
          adminUrl,
          manager,
          sessions,
          requestContext,
        ),
        tokenResult.tokens.accessToken,
        tokenResult.tokens.userId,
      )
      settledResult = result
      const current = onCurrentSuccess
        ? await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async () => onCurrentSuccess!(result, requestContext!.session),
          ).then(applied => applied.applied)
        : await sessions.isCurrent(manager, requestContext.session)
      if (!current) return staleAdminSessionResult()
      return { success: true as const, ...result }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
      }
      const sessionEnding = catalogScope
        ? isSessionEndingCatalogScopedError(error)
        : isSessionEndingAuthFailure(error)
      if (sessionEnding) {
        if (!manager || !requestContext) return staleAdminSessionResult()
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminSessionResult()
      } else if (
        catalogScope
        && error instanceof AdminError
        && classifyAdminAuthorizationFailure(
          error,
          { catalogScoped: true },
        ) === 'catalog_scope'
      ) {
        // The space itself denied this member: revoke that space's trusted
        // state BEFORE answering so installs/opens/uninstalls and launch
        // resolution fail closed while the login session survives. The
        // revocation is AWAITED — the response is only produced after the
        // durable fail-closed outcome (or its failure) is known. The
        // latest-wins CAS is evaluated INSIDE the revocation's critical
        // section and may still return 'superseded'.
        try {
          const verdict = await catalogScope.onDenied(
            error,
            {
              accountId: verifiedUserId ?? '',
              productSpaceId: catalogScope.productSpaceId,
            },
          )
          if (verdict === 'superseded') {
            log?.warn(
              `[Admin] ${operation} catalog-scope denial is stale (a newer request already committed); zero state writes`,
            )
            return {
              success: false as const,
              errorCode: 'REQUEST_SUPERSEDED',
              message: 'A newer ProductSpace catalog request replaced this one',
            }
          }
        } catch (revokeError) {
          log?.warn(
            `[Admin] ${operation} catalog-scope revocation failed:`,
            revokeError instanceof Error ? revokeError.message : String(revokeError),
          )
          return {
            success: false as const,
            errorCode: 'CATALOG_SCOPE_REVOKE_FAILED',
            message: 'The denied ProductSpace state could not be durably revoked',
          }
        }
      }
      const adminError = toAdminRpcError(error)
      log?.warn(`[Admin] ${operation} failed:`, adminError.message)
      return { success: false as const, ...adminError }
    } finally {
      onSettled?.(settledResult)
    }
  }

  server.handle(RPC_CHANNELS.admin.LOGIN, async (_ctx, identifier: unknown, password: unknown) => {
    const input = AdminLoginRpcInputSchema.safeParse({ identifier, password })
    if (!input.success) {
      return adminInputError('INVALID_CREDENTIALS')
    }

    const loginAttempt = await sessions.beginLoginAttempt()
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const client = createPublicAdminClient(adminUrl)
      const login = await client.login(input.data.identifier, input.data.password)
      const session = await completeAdminLogin({
        adminUrl,
        manager,
        login,
        loginAttempt,
        sessions,
        deps,
        onSyncFailure: error => logPostLoginSyncFailure(log, error),
      })
      if (!session || !await sessions.isCurrent(manager, session)) {
        return staleAdminSessionResult()
      }
      invalidateAllCreatorArtifactCaches()

      return { success: true, user: login.user }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] login failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_AUTH_CONFIG, async () => {
    try {
      return await createPublicAdminClient(requireAdminUrl()).getAuthConfig()
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] getAuthConfig failed:', adminError.message)
      return { phoneAuthEnabled: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.GET_PHONE_AUTH_CHALLENGE_CONFIG, async () => {
    try {
      const result = await createPublicAdminClient(
        requireAdminUrl(),
      ).getPhoneAuthChallengeConfig()
      return { success: true, ...result }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] getPhoneAuthChallengeConfig failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(
    RPC_CHANNELS.admin.SEND_PHONE_AUTH_CODE,
    async (_ctx, phone: unknown, challengeToken: unknown) => {
      const input = SendPhoneAuthCodeRpcInputSchema.safeParse({ phone, challengeToken })
      if (!input.success) {
        return adminInputError(hasValidationIssue(input.error.issues, 'phone')
          ? 'invalid_phone'
          : 'phone_auth_configuration_error')
      }

      try {
        const result = await createPublicAdminClient(requireAdminUrl())
          .sendPhoneAuthCode(input.data)
        return { success: true, ...result }
      } catch (error) {
        const adminError = toAdminRpcError(error)
        log?.warn('[Admin] sendPhoneAuthCode failed:', adminError.message)
        return { success: false, ...adminError }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.admin.VERIFY_PHONE_AUTH_CODE,
    async (_ctx, phone: unknown, code: unknown) => {
      const input = VerifyPhoneAuthCodeRpcInputSchema.safeParse({ phone, code })
      if (!input.success) {
        return adminInputError(hasValidationIssue(input.error.issues, 'phone')
          ? 'invalid_phone'
          : 'verification_code_invalid')
      }

      const loginAttempt = await sessions.beginLoginAttempt()
      try {
        const adminUrl = requireAdminUrl()
        const manager = getCredentialManager()
        const login = await createPublicAdminClient(adminUrl)
          .verifyPhoneAuthCode(input.data)
        const session = await completeAdminLogin({
          adminUrl,
          manager,
          login,
          loginAttempt,
          sessions,
          deps,
          onSyncFailure: error => logPostLoginSyncFailure(log, error),
        })
        if (!session || !await sessions.isCurrent(manager, session)) {
          return staleAdminSessionResult()
        }
        invalidateAllCreatorArtifactCaches()
        return {
          success: true,
          user: login.user,
          isNewUser: login.isNewUser,
        }
      } catch (error) {
        const adminError = toAdminRpcError(error)
        log?.warn('[Admin] verifyPhoneAuthCode failed:', adminError.message)
        return { success: false, ...adminError }
      }
    },
  )

  server.handle(RPC_CHANNELS.admin.SET_PASSWORD, async (_ctx, password: unknown) => {
    const input = SetAdminPasswordRpcInputSchema.safeParse({ password })
    if (!input.success) {
      return adminInputError('VALIDATION_ERROR')
    }

    let requestContext: AdminRequestContext | null = null
    let manager: CredentialManager | null = null
    try {
      const adminUrl = requireAdminUrl()
      manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }
      if (tokenResult.accessMode === 'offline') {
        return {
          success: false,
          errorCode: 'NETWORK_ERROR',
          message: tokenResult.warning ?? 'Failed to reach admin server',
        }
      }

      requestContext = { session: tokenResult.session }
      const result = await createAuthenticatedAdminClient(
        adminUrl,
        manager,
        sessions,
        requestContext,
      )
        .setPassword(tokenResult.tokens.accessToken, input.data)
      if (!await sessions.isCurrent(manager, requestContext.session)) {
        return staleAdminSessionResult()
      }
      return { success: result.success }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
      }
      if (isSessionEndingAuthFailure(error)) {
        if (!manager || !requestContext) return staleAdminSessionResult()
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminSessionResult()
      }
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] setPassword failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.VALIDATE, async () => {
    const adminUrl = getAdminUrl()
    if (!adminUrl) {
      return { loggedIn: false }
    }

    const manager = getCredentialManager()
    const tokenResult = await ensureValidTokens(
      adminUrl,
      manager,
      sessions,
      deps,
    )
    if (!tokenResult.tokens) {
      if (tokenResult.stale) {
        return staleAdminValidationResult()
      }
      if (tokenResult.authError) {
        return { loggedIn: false, ...tokenResult.authError }
      }
      return { loggedIn: false }
    }
    if (tokenResult.accessMode === 'offline') {
      const committed = await sessions.mutateIfCurrent(
        manager,
        tokenResult.session,
        async () => {
          markCatalogAccessOfflineForAccount(tokenResult.tokens.userId)
          return {
            loggedIn: true as const,
            user: adminUserFromStoredTokens(tokenResult.tokens),
            configVersion: getAdminConfigVersion() ?? 'offline',
            offline: true as const,
          }
        },
      )
      return committed.applied
        ? committed.value!
        : staleAdminValidationResult()
    }

    const requestContext: AdminRequestContext = {
      session: tokenResult.session,
    }
    try {
      const client = createAuthenticatedAdminClient(
        adminUrl,
        manager,
        sessions,
        requestContext,
      )
      const validation = await client.validate(tokenResult.tokens.accessToken)
      if (!validation.valid) {
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminValidationResult()
        return { loggedIn: false }
      }
      const verifiedSession = await persistVerifiedAdminUser(
        manager,
        sessions,
        requestContext.session,
        validation.user,
      )
      if (!verifiedSession) {
        return staleAdminValidationResult()
      }
      requestContext.session = verifiedSession

      if (getAdminConfigVersion() !== validation.configVersion) {
        const synced = await syncAdminConnections({
          adminUrl,
          manager,
          sessions,
          session: requestContext.session,
        })
        requestContext.session = synced.session
      }
      if (!await sessions.isCurrent(manager, requestContext.session)) {
        return staleAdminValidationResult()
      }

      return {
        loggedIn: true,
        user: validation.user,
        configVersion: validation.configVersion,
      }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminValidationResult()
      }
      if (isSessionEndingAuthFailure(error)) {
        const ended = await endAdminSession(
          manager,
          deps,
          sessions,
          requestContext.session,
        )
        if (!ended) return staleAdminValidationResult()
        return { loggedIn: false, ...toAdminRpcError(error) }
      }
      if (isTemporaryAdminFailure(error)) {
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async () => {
            markCatalogAccessOfflineForAccount(
              requestContext.session.tokens.userId,
            )
            return {
              loggedIn: true as const,
              user: adminUserFromStoredTokens(requestContext.session.tokens),
              configVersion: getAdminConfigVersion() ?? 'offline',
              offline: true as const,
            }
          },
        )
        return committed.applied
          ? committed.value!
          : staleAdminValidationResult()
      }
      throw error
    }
  })

  server.handle(RPC_CHANNELS.admin.LOGOUT, async () => {
    const adminUrl = getAdminUrl()
    const manager = getCredentialManager()
    const session = await sessions.capture(manager)
    if (!session) return { success: true }

    const ended = await endAdminSession(
      manager,
      deps,
      sessions,
      session,
      async () => {
        await deleteAdminManagedConnections(manager)
        setAdminConfigVersion(undefined)
      },
      async () => {
        if (!adminUrl) return
        try {
          await createPublicAdminClient(adminUrl)
            .logout(session.tokens.accessToken)
        } catch (error) {
          log?.warn(
            '[Admin] remote logout failed; clearing local state:',
            error instanceof Error ? error.message : String(error),
          )
        }
      },
    )
    if (!ended) return staleAdminSessionResult()

    return { success: true }
  })

  server.handle(RPC_CHANNELS.admin.GET_STATUS, async () => {
    const manager = getCredentialManager()
    const tokens = await manager.getAdminTokens()

    return {
      adminUrl: getAdminUrl(),
      loggedIn: !!tokens,
      userId: tokens?.userId ?? null,
      username: tokens?.username ?? null,
      displayName: tokens?.displayName ?? tokens?.username ?? null,
    }
  })

  server.handle(RPC_CHANNELS.admin.SYNC_CONNECTIONS, async () => {
    try {
      const adminUrl = requireAdminUrl()
      const manager = getCredentialManager()
      const { session: _session, ...result } = await syncAdminConnections({
        adminUrl,
        manager,
        sessions,
        deps,
      })
      return { success: true, ...result }
    } catch (error) {
      if (error instanceof AdminSessionChangedError) {
        return staleAdminSessionResult()
      }
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] syncConnections failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(
    RPC_CHANNELS.admin.SYNC_APP_CATALOG,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawOptions?: unknown,
    ): Promise<AppCatalogSyncResult> => {
      const organizationId =
        CatalogOrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      if (!organizationId.success) {
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Organization id is invalid',
        }
      }
      const force = Boolean(
        rawOptions
        && typeof rawOptions === 'object'
        && (rawOptions as Record<string, unknown>).force === true,
      )
      const syncInvocation = ++appCatalogSyncInvocation

      const adminUrl = getAdminUrl()
      if (!adminUrl) {
        return {
          success: false,
          errorCode: 'VALIDATION_ERROR',
          message: 'Admin URL is not configured',
        }
      }
      const manager = getCredentialManager()
      const tokenResult = await ensureValidTokens(
        adminUrl,
        manager,
        sessions,
        deps,
      )
      if (!tokenResult.tokens) {
        if (tokenResult.stale) return staleAdminSessionResult()
        return {
          success: false,
          ...(tokenResult.authError ?? {
            errorCode: 'UNAUTHORIZED',
            message: 'Admin session is not logged in',
          }),
        }
      }

      const accountId = tokenResult.tokens.userId
      const requestContext: AdminRequestContext = {
        session: tokenResult.session,
      }
      const catalogSyncKey = appCatalogScopeKey(accountId, organizationId.data)
      const registeredRequest = await sessions.mutateIfCurrent(
        manager,
        requestContext.session,
        async () => {
          if (!appCatalogAuthorizationEpochByScope.has(catalogSyncKey)) {
            appCatalogAuthorizationEpochByScope.set(catalogSyncKey, 0)
          }
          latestAppCatalogSyncByScope.set(
            catalogSyncKey,
            Math.max(
              latestAppCatalogSyncByScope.get(catalogSyncKey) ?? 0,
              syncInvocation,
            ),
          )
          return currentAppCatalogAuthorizationEpoch(catalogSyncKey)
        },
      )
      if (!registeredRequest.applied) return staleAdminSessionResult()
      const registeredAuthorizationEpoch = registeredRequest.value!
      const isCurrentCatalogSync = () => (
        latestAppCatalogSyncByScope.get(catalogSyncKey) === syncInvocation
        && currentAppCatalogAuthorizationEpoch(catalogSyncKey)
          === registeredAuthorizationEpoch
      )
      const supersededCatalogResult = (): AppCatalogSyncResult => ({
        success: false,
        errorCode: 'REQUEST_SUPERSEDED',
        message: 'A newer app catalog sync replaced this request',
      })
      const cached = getCachedAppCatalog(accountId, organizationId.data)
      if (tokenResult.accessMode === 'offline') {
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => {
            if (!isCurrentCatalogSync()) return supersededCatalogResult()
            const current = getCachedAppCatalog(accountId, organizationId.data)
            if (
              getAppCatalogAccessMode(accountId, organizationId.data) === 'denied'
              || current?.authorizationStatus === 'denied'
            ) {
              // A refresh transport failure is not new authorization evidence.
              // The process-local deny gate is authoritative even when writing
              // its denied snapshot failed and disk still contains an older
              // authorized cache.
              setAppCatalogAccessMode(accountId, organizationId.data, 'denied')
              return {
                success: false,
                errorCode: 'NETWORK_ERROR',
                message: tokenResult.warning ?? 'Failed to reach admin server',
                accessMode: 'denied',
                ...(current
                  ? {
                      catalog: markAppCatalogAccessDenied(current),
                    }
                  : {}),
              }
            }
            if (current?.authorizationStatus === 'authorized') {
              setAppCatalogAccessMode(accountId, organizationId.data, 'offline')
              return {
                success: true,
                catalog: current,
                source: 'cache',
                refreshed: false,
                accessMode: 'offline',
                warningCode: 'NETWORK_ERROR',
                warning: tokenResult.warning ?? 'Failed to reach admin server',
              }
            }
            setAppCatalogAccessMode(accountId, organizationId.data, 'offline')
            return {
              success: false,
              errorCode: 'NETWORK_ERROR',
              message: tokenResult.warning ?? 'Failed to reach admin server',
            }
          }
        )
        return committed.applied
          ? committed.value!
          : staleAdminSessionResult()
      }
      try {
        const client = createAuthenticatedAdminClient(
          adminUrl,
          manager,
          sessions,
          requestContext,
        )
        const requestedAppConfigVersion = (
          !force
          && cached?.authorizationStatus === 'authorized'
          && getAppCatalogAccessMode(
            accountId,
            organizationId.data,
          ) !== 'denied'
        )
          ? cached.appConfigVersion
          : undefined
        const result = await client.getAppCatalog(
          tokenResult.tokens.accessToken,
          organizationId.data,
          requestedAppConfigVersion,
        )
        if (
          !result.notModified
          && result.apps.some(app => app.organizationId !== organizationId.data)
        ) {
          throw new AdminError(
            'Admin app catalog contains an app from another organization',
            'SERVER_ERROR',
          )
        }
        if (result.notModified) {
          const committed = await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async (): Promise<AppCatalogSyncResult> => {
              if (!isCurrentCatalogSync()) return supersededCatalogResult()
              const currentCatalog = getCachedAppCatalog(
                accountId,
                organizationId.data,
              )
              if (
                force
                || requestedAppConfigVersion === undefined
                || currentCatalog?.authorizationStatus !== 'authorized'
                || currentCatalog.appConfigVersion
                  !== requestedAppConfigVersion
                || getAppCatalogAccessMode(
                  accountId,
                  organizationId.data,
                ) === 'denied'
              ) {
                const deniedCatalog = denyCatalogScope(
                  accountId,
                  organizationId.data,
                )
                return {
                  success: false,
                  errorCode: 'SERVER_ERROR',
                  message: 'Admin returned not modified for an ineligible Catalog request',
                  ...(deniedCatalog
                    ? {
                        catalog: deniedCatalog,
                        accessMode: 'denied' as const,
                      }
                    : {}),
                }
              }
              setAppCatalogAccessMode(accountId, organizationId.data, 'online')
              return {
                success: true as const,
                catalog: currentCatalog,
                source: 'cache' as const,
                refreshed: false,
                accessMode: 'online' as const,
                ...(currentCatalog.warnings?.length
                  ? { warningCode: 'INVALID_SEMVER' }
                  : {}),
              }
            },
          )
          return committed.applied
            ? committed.value!
            : staleAdminSessionResult()
        }

        const updatedCatalog = result
        const preliminaryRetainedAppIds =
          await deps.getRetainedCatalogAppIds?.(
            accountId,
            organizationId.data,
          ) ?? new Set<string>()
        const findDeliveryModeConflict = (
          currentCatalog: AppCatalogCacheEntry | null,
        ) => {
          const currentAppsById = new Map(
            [
              ...(currentCatalog?.withdrawnApps ?? []),
              ...(currentCatalog?.apps ?? []),
            ].map(app => [app.id, app]),
          )
          return updatedCatalog.apps.find(app => {
            const currentApp = currentAppsById.get(app.id)
            return currentApp
              && currentApp.deliveryMode !== app.deliveryMode
          })
        }
        const getWithdrawnAppIds = (
          currentCatalog: AppCatalogCacheEntry | null,
        ) => {
          const nextAvailableAppIds = new Set(
            updatedCatalog.apps.map(app => app.id),
          )
          return (currentCatalog?.apps ?? [])
            .filter(app => (
              (
                app.availability === undefined
                || app.availability === 'available'
              )
              && !nextAvailableAppIds.has(app.id)
            ))
            .map(app => app.id)
        }
        const preparation = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async () => {
            if (!isCurrentCatalogSync()) return null
            const currentCatalog = getCachedAppCatalog(
              accountId,
              organizationId.data,
            )
            const deliveryModeConflict = findDeliveryModeConflict(
              currentCatalog,
            )
            if (deliveryModeConflict) {
              // deliveryMode determines whether this identity is resolved as a
              // remote URL or bound to a scoped local runtime. Reusing the same
              // Catalog ID for the other mode would make lifecycle and data
              // management authorization ambiguous, so preserve the last
              // trusted cache and reject the replacement response.
              throw new AdminError(
                `Catalog app ${deliveryModeConflict.id} changed delivery mode`,
                'SERVER_ERROR',
              )
            }
            const withdrawnAppIds = getWithdrawnAppIds(currentCatalog)
            let cleanup: Promise<void> | undefined
            if (withdrawnAppIds.length > 0) {
              // This host callback must advance every exact app lifecycle
              // generation synchronously for local and remote Apps. The slow
              // cleanup is awaited outside the session lock; a final retained
              // state scan and a second sync/session CAS precede cache commit.
              cleanup = deps.onAdminCatalogAppsWithdrawn?.(
                accountId,
                organizationId.data,
                withdrawnAppIds,
              )
              void cleanup?.catch(() => {})
            }
            return { withdrawnAppIds, cleanup }
          },
        )
        if (!preparation.applied) return staleAdminSessionResult()
        if (!preparation.value) return supersededCatalogResult()
        const preparedCommit = preparation.value
        if (preparedCommit.cleanup) {
          try {
            await preparedCommit.cleanup
          } catch (error) {
            log?.warn(
              '[Admin] withdrawn Catalog app cleanup failed:',
              error instanceof Error ? error.message : String(error),
            )
            throw new AdminError(
              'Failed to quiesce withdrawn Catalog app lifecycle operations',
              'SERVER_ERROR',
            )
          }
        }
        const finalRetainedAppIds = await deps.getRetainedCatalogAppIds?.(
          accountId,
          organizationId.data,
        ) ?? new Set<string>()
        const retainedWithdrawnAppIds = new Set([
          ...preliminaryRetainedAppIds,
          ...finalRetainedAppIds,
        ])
        const committed = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => {
            if (!isCurrentCatalogSync()) return supersededCatalogResult()
            const currentCatalog = getCachedAppCatalog(
              accountId,
              organizationId.data,
            )
            const deliveryModeConflict = findDeliveryModeConflict(
              currentCatalog,
            )
            if (deliveryModeConflict) {
              throw new AdminError(
                `Catalog app ${deliveryModeConflict.id} changed delivery mode`,
                'SERVER_ERROR',
              )
            }
            const finalWithdrawnAppIds = getWithdrawnAppIds(currentCatalog)
            const fencedAppIds = new Set(preparedCommit.withdrawnAppIds)
            if (finalWithdrawnAppIds.some(appId => !fencedAppIds.has(appId))) {
              throw new AdminError(
                'Catalog changed after withdrawn app lifecycle preparation',
                'SERVER_ERROR',
              )
            }
            const savedCatalog = saveAppCatalog(
              accountId,
              organizationId.data,
              updatedCatalog,
              Date.now(),
              retainedWithdrawnAppIds,
            )
            deps.onAdminCatalogAppsAuthorized?.(
              accountId,
              organizationId.data,
              updatedCatalog.apps.map(app => app.id),
            )
            setAppCatalogAccessMode(accountId, organizationId.data, 'online')
            return {
              success: true as const,
              catalog: savedCatalog,
              source: 'network' as const,
              refreshed: true,
              accessMode: 'online' as const,
              ...(savedCatalog.warnings?.length
                ? { warningCode: 'INVALID_SEMVER' }
                : {}),
            }
          },
        )
        return committed.applied ? committed.value! : staleAdminSessionResult()
      } catch (error) {
        if (error instanceof AdminSessionChangedError) {
          return staleAdminSessionResult()
        }
        const adminError = toAdminRpcError(error)
        if (isCatalogSessionEndingAuthFailure(error)) {
          const ended = await endAdminSession(
            manager,
            deps,
            sessions,
            requestContext.session,
          )
          if (!ended) {
            // Catalog request ordering is not an authentication truth source.
            // Only a real session generation/account change may suppress an
            // explicit session-ending failure from an older request.
            return staleAdminSessionResult()
          }
          log?.warn('[Admin] app catalog authorization denied:', adminError.message)
          return { success: false, ...adminError }
        } else if (isCatalogAuthorizationFailure(error)) {
          const denied = await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async (): Promise<AppCatalogSyncResult> => {
              if (!isCurrentCatalogSync()) return supersededCatalogResult()
              const deniedCatalog = denyCatalogScope(
                accountId,
                organizationId.data,
              )
              return {
                success: false,
                ...adminError,
                ...(deniedCatalog
                  ? {
                      catalog: deniedCatalog,
                      accessMode: 'denied' as const,
                    }
                  : {}),
              }
            },
          )
          if (!denied.applied) return staleAdminSessionResult()
          log?.warn('[Admin] app catalog authorization denied:', adminError.message)
          return denied.value!
        } else if (cached && isTemporaryAdminFailure(error)) {
          const markedOffline = await sessions.mutateIfCurrent(
            manager,
            requestContext.session,
            async (): Promise<AppCatalogSyncResult> => {
              if (!isCurrentCatalogSync()) return supersededCatalogResult()
              const current = getCachedAppCatalog(accountId, organizationId.data)
              if (
                getAppCatalogAccessMode(
                  accountId,
                  organizationId.data,
                ) === 'denied'
                || !current
                || current.authorizationStatus !== 'authorized'
              ) {
                setAppCatalogAccessMode(
                  accountId,
                  organizationId.data,
                  'denied',
                )
                return {
                  success: false,
                  ...adminError,
                  accessMode: 'denied',
                  ...(current
                    ? {
                        catalog: markAppCatalogAccessDenied(current),
                      }
                    : {}),
                }
              }
              setAppCatalogAccessMode(
                accountId,
                organizationId.data,
                'offline',
              )
              return {
                success: true,
                catalog: current,
                source: 'cache',
                refreshed: false,
                accessMode: 'offline',
                warningCode: adminError.errorCode,
                warning: adminError.message,
              }
            },
          )
          if (!markedOffline.applied) return staleAdminSessionResult()
          log?.warn('[Admin] app catalog refresh failed; using cache:', adminError.message)
          return markedOffline.value!
        }
        const current = await sessions.mutateIfCurrent(
          manager,
          requestContext.session,
          async (): Promise<AppCatalogSyncResult> => {
            if (!isCurrentCatalogSync()) return supersededCatalogResult()
            const deniedCatalog = getCachedAppCatalog(
              accountId,
              organizationId.data,
            )
            return {
              success: false,
              ...adminError,
              ...(deniedCatalog?.authorizationStatus === 'denied'
                ? {
                    catalog: markAppCatalogAccessDenied(deniedCatalog),
                    accessMode: 'denied' as const,
                  }
                : {}),
            }
          },
        )
        if (!current.applied) return staleAdminSessionResult()
        log?.warn('[Admin] app catalog sync failed:', adminError.message)
        return current.value!
      }
    },
  )

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATIONS, async () => {
    return callOrganization(
      'listOrganizations',
      async (client, accessToken, userId) => {
        invalidateCreatorArtifactCache(userId)
        return await client.listOrganizations(accessToken)
      },
      async (result, session) => {
        const activeOrganizationIds = new Set(result.organizations
          .filter(organization => (
            organization.status !== 'suspended'
            && organization.membership.status === 'active'
          ))
          .map(organization => organization.id))
        const accountId = session.tokens.userId
        invalidateCreatorArtifactCache(accountId)
        const scopedOrganizationIds = catalogOrganizationIdsForAccount(accountId)
        for (const organizationId of scopedOrganizationIds) {
          if (activeOrganizationIds.has(organizationId)) continue
          denyCatalogScope(accountId, organizationId)
        }
      },
    )
  })

  server.handle(RPC_CHANNELS.admin.LIST_PRODUCT_SPACES, async () => {
    return callOrganization(
      'listProductSpaces',
      (client, accessToken) => client.listProductSpaces(accessToken),
    )
  })

  // Unified ProductSpace Catalog (S01). The requested space is validated
  // against a freshly fetched trusted list before the catalog is read, and
  // the response passes the shared ProductSpace boundary parser — a catalog
  // for another space can never be hydrated.
  server.handle(
    RPC_CHANNELS.productSpace.CATALOG,
    async (_ctx, productSpaceId: unknown, knownRevision: unknown) => {
      if (typeof productSpaceId !== 'string' || !productSpaceId) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Catalog request is invalid' }
      }
      // The requested identifier is validated BEFORE it can touch the
      // fence: a renderer-supplied arbitrary string never becomes a
      // long-lived scope key.
      const requestedSpaceId = ProductSpaceIdSchema.safeParse(productSpaceId)
      if (!requestedSpaceId.success) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Catalog request is invalid' }
      }
      // The fence scope key is only knowable after authentication (it binds
      // the verified account), so the settle hook releases via this captured
      // key once the callback has entered the authenticated scope. The
      // reservation is owned by the marking invocation: only a request that
      // actually marked may release.
      let syncScopeKey: string | null = null
      let markedCommitInvocation: number | null = null
      // This request's fence registration; null until the callback entered
      // the authenticated scope. The catalog-scope denial decision re-checks
      // latest-wins AGAINST THIS invocation inside its revocation critical
      // section: a stale denial must never revoke a newer request's
      // committed state.
      let denialInvocation: number | null = null
      // Fence generation observed at scope entry — the revocation only
      // applies while the live fence is still EXACTLY this one.
      let fenceGenerationAtEntry: number | null = null
      return callOrganization(
        'getProductSpaceCatalog',
        async (client, accessToken, userId) => {
          // The fence registration happens the moment the request enters the
          // authenticated ProductSpace Catalog scope — BEFORE any ProductSpace
          // list or Catalog await — so an older in-flight response can never
          // commit past a newer request, even when the newer request exits
          // early (e.g. its list validation finds the space withdrawn).
          const catalogSyncKey = createProductSpaceContextKey(
            userId as never,
            requestedSpaceId.data,
          )
          syncScopeKey = catalogSyncKey
          const syncInvocation = beginProductSpaceCatalogSync(catalogSyncKey)
          denialInvocation = syncInvocation
          fenceGenerationAtEntry = getRuntimeFenceGeneration()
          const supersededCatalogResult = () => ({
            success: false as const,
            errorCode: 'REQUEST_SUPERSEDED',
            message: 'A newer ProductSpace catalog request replaced this one',
          })
          try {
            const list = await client.listProductSpaces(accessToken)
            const context = list.productSpaces.find(
              space => space.id === requestedSpaceId.data,
            )
            if (!context || context.accessMode !== 'active') {
              throw new AdminError(
                'The requested ProductSpace is not available for this account',
                'FORBIDDEN',
              )
            }
            if (context.id !== requestedSpaceId.data) {
              throw new AdminError(
                'The requested ProductSpace is not available for this account',
                'FORBIDDEN',
              )
            }

            const result = await client.getProductSpaceCatalog(
              accessToken,
              context,
              typeof knownRevision === 'string' && knownRevision
                ? knownRevision
                : undefined,
            )
            if ('notModified' in result) {
              if (!isLatestProductSpaceCatalogSync(catalogSyncKey, syncInvocation)) {
                return supersededCatalogResult()
              }
              // The notModified short-circuit commits nothing; settle the
              // scope without a pending authority commit.
              return { notModified: true as const, catalogRevision: knownRevision as string }
            }
            if (!isLatestProductSpaceCatalogSync(catalogSyncKey, syncInvocation)) {
              return supersededCatalogResult()
            }
            // The authority write happens in the session-current commit zone
            // (onCurrentSuccess), where a FINAL CAS re-checks this fence
            // under the session lock — a failing CAS downgrades the response
            // to REQUEST_SUPERSEDED with zero authority writes. The pending
            // reservation is ALWAYS released by callOrganization's settle
            // contract afterwards — even when the session changed (commit
            // skipped) or the authority write threw. The reservation is
            // owned by THIS invocation: an older unmarked request settling
            // last can never release it.
            markProductSpaceCatalogCommitPending(catalogSyncKey, syncInvocation)
            markedCommitInvocation = syncInvocation
            return {
              __authorityCommit: {
                scopeKey: catalogSyncKey,
                invocation: syncInvocation,
                accountId: userId,
                productSpaceId: requestedSpaceId.data,
                catalogRevision: result.catalogRevision,
                entries: result.entries,
              },
              notModified: false as const,
              contractVersion: result.contractVersion,
              productSpaceId: result.productSpaceId,
              catalogRevision: result.catalogRevision,
              entries: result.entries,
            } as never
          } finally {
            // NOTE: the scope entry is deliberately NOT settled here. It must
            // survive until callOrganization's ALWAYS-SETTLE hook runs — i.e.
            // AFTER a catalog-scope denial's revocation decision — so the
            // decision-time latest CAS reads a live registration. The settle
            // (and full state deletion) happens in onSettled below.
          }
        },
        {
          onCurrentSuccess: result => {
            const commit = (result as {
              __authorityCommit?: {
              scopeKey: string
              invocation: number
              accountId: string
              productSpaceId: string
              catalogRevision: string
              entries: ReadonlyArray<Record<string, unknown>>
            }
            willCommitAuthority?: boolean
          }).__authorityCommit
          if (!commit) return
          delete (result as { __authorityCommit?: unknown }).__authorityCommit
          // FINAL CAS + authority write inside the SAME switch-lock critical
          // section the catalog-scope denial revocation uses: a denial
          // decision can never interleave between this CAS check and the
          // authority write (and vice versa) — the freshest verified state
          // and a stale denial are strictly serialized. A CAS failure
          // downgrades the response to REQUEST_SUPERSEDED with ZERO
          // authority writes.
          return withSwitchLock(async () => {
            if (!isLatestProductSpaceCatalogSync(commit.scopeKey, commit.invocation)) {
              Object.assign(result, {
                success: false,
                errorCode: 'REQUEST_SUPERSEDED',
                message: 'A newer ProductSpace catalog request replaced this one',
              })
              return
            }
            const withdrawnEntries = recordProductSpaceCatalogAuthoritativeEntries(
              commit.accountId,
              commit.productSpaceId,
              commit.catalogRevision,
              commit.entries,
            )
            ;(result as {
              withdrawnEntries?: ReadonlyArray<Record<string, unknown>>
            }).withdrawnEntries = withdrawnEntries.map(entry => ({
              kind: 'app' as const,
              catalogEntryId: entry.catalogEntryId,
              artifactInstanceId: entry.artifactInstanceId,
              version: {
                versionId: entry.versionId,
                version: entry.version,
              },
              name: entry.name,
              description: entry.description,
              ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
              availability: 'withdrawn' as const,
              sources: entry.sources,
              permissions: entry.permissions,
            }))
          })
          },
          // ALWAYS-SETTLE: release the pending commit reservation no matter
        // how the request concluded (committed, CAS-skipped by a session
        // change, or authority write failure) — the scope entry is recycled
          // as soon as it is fully idle. Only THIS request's own marked
          // reservation is released; an unmarked failure (list/Catalog error,
          // notModified, superseded) must never steal a newer request's
          // pending reservation on the same scope.
          onSettled: () => {
            if (syncScopeKey !== null && markedCommitInvocation !== null) {
              releaseProductSpaceCatalogCommit(syncScopeKey, markedCommitInvocation)
            }
            // ALWAYS-SETTLE the scope itself — after the denial decision —
            // so the bounded in-flight structure is fully deleted once idle.
            if (syncScopeKey !== null) {
              settleProductSpaceCatalogSync(syncScopeKey)
            }
          },
          // Catalog-scope error semantics: a 403/FORBIDDEN (governance
          // restriction, membership loss for this space) must NOT end the
          // login session — the member stays on the home with the frozen
          // restricted view and can return to their personal space. Only
          // genuine session failures (401/TOKEN_REVOKED/…) end it. The
          // revocation is ONE switch-lock critical section: the latest-wins
          // CAS is evaluated at DECISION time inside the lock, so a newer
          // invocation that registered while this denial waited still wins
          // ('superseded' → REQUEST_SUPERSEDED with zero state writes).
          catalogScope: {
            productSpaceId: requestedSpaceId.data,
            onDenied: async (_error, scope) => {
              const verdict = await revokeProductSpaceTrustedScope({
                accountId: scope.accountId,
                productSpaceId: scope.productSpaceId,
                fenceGeneration: fenceGenerationAtEntry,
                requireLatestInvocation: () =>
                  syncScopeKey !== null
                  && denialInvocation !== null
                  && isLatestProductSpaceCatalogSync(syncScopeKey, denialInvocation),
              })
              return verdict === 'superseded' ? 'superseded' : undefined
            },
          },
        },
      )
    })

  // Direct-open preparation for POO-47. Main derives the host tuple and
  // resolves against a fresh server-authoritative Catalog. The renderer can
  // name only an entry in the currently committed ProductSpace; old ids,
  // cross-space ids, offline state and a concurrent switch all fail closed.
  server.handle(
    RPC_CHANNELS.productSpace.RESOLVE_LAUNCH,
    async (_ctx, rawProductSpaceId: unknown, rawCatalogEntryId: unknown) => {
      const productSpaceId = ProductSpaceIdSchema.safeParse(rawProductSpaceId)
      const catalogEntryId = CatalogEntryIdSchema.safeParse(rawCatalogEntryId)
      if (!productSpaceId.success || !catalogEntryId.success) {
        return {
          success: false as const,
          errorCode: 'VALIDATION_ERROR',
          message: 'Launch request is invalid',
        }
      }
      // Typed denial origins: only REMOTE authority denials (the server's
      // own membership/catalog verdicts — including a list that lacks the
      // requested space or marks it inactive) prove the member lost access
      // and may revoke the trusted authority/fence for this scope. The LOCAL
      // stale-scope guard is a request-scoped rejection, never a revocation.
      let fenceGenerationAtEntry: number | null = null
      return callOrganization(
        'resolveProductSpaceLaunch',
        async (client, accessToken, userId) => {
          const requireCurrentLaunchScope = () => {
            if (
              getRuntimeActiveProductSpace() !== productSpaceId.data
              || !isRuntimeFenceBoundToAccount(userId)
              || isRuntimeOfflineReadOnly()
              || isRuntimeProductSpaceRestricted(productSpaceId.data)
              || isSwitchInProgress()
            ) {
              throw new ProductSpaceDenialError(
                'Launch is not allowed outside the current active ProductSpace',
                'FORBIDDEN',
                'local_scope_guard',
              )
            }
          }
          requireCurrentLaunchScope()
          fenceGenerationAtEntry = getRuntimeFenceGeneration()

          // Wraps REAL server calls: a thrown AdminError from them is a
          // remote authority verdict.
          const tagRemoteAuthority = async <S>(call: Promise<S>): Promise<S> => {
            try {
              return await call
            } catch (error) {
              if (error instanceof AdminError && denialOriginOf(error) === null) {
                throw new ProductSpaceDenialError(
                  error.message,
                  error.errorCode,
                  'remote_authority',
                  { status: error.status, details: error.details },
                )
              }
              throw error
            }
          }

          const platform = process.platform
          const arch = process.arch
          if (
            (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux')
            || (arch !== 'arm64' && arch !== 'x64')
          ) {
            throw new AdminError('This host cannot resolve App launches', 'VALIDATION_ERROR')
          }

          const list = await tagRemoteAuthority(client.listProductSpaces(accessToken))
          const context = list.productSpaces.find(
            space => space.id === productSpaceId.data,
          )
          if (!context || context.accessMode !== 'active') {
            // The server ANSWERED, but this space does not exist for the
            // member or is not active: an authoritative remote denial.
            throw new ProductSpaceDenialError(
              'The requested ProductSpace is not available for launch',
              'FORBIDDEN',
              'remote_authority',
            )
          }
          const catalog = await tagRemoteAuthority(client.getProductSpaceCatalog(accessToken, context))
          if ('notModified' in catalog) {
            throw new AdminError('Fresh ProductSpace Catalog is required for launch', 'SERVER_ERROR')
          }
          requireCurrentLaunchScope()
          const launch = await tagRemoteAuthority(client.resolveProductSpaceLaunch(
            accessToken,
            context,
            catalog,
            catalogEntryId.data,
            { platform, arch },
          ))
          requireCurrentLaunchScope()
          return { launch }
        },
        {
          // Catalog-scope error semantics for direct-open resolution too: a
          // 403/FORBIDDEN stays IN-PAGE — the login session survives and the
          // member can return to their personal space. Only genuine session
          // failures end it.
          catalogScope: {
            productSpaceId: productSpaceId.data,
            onDenied: async (error, scope) => {
              if (denialOriginOf(error) !== 'remote_authority') return
              await revokeProductSpaceTrustedScope({
                accountId: scope.accountId,
                productSpaceId: scope.productSpaceId,
                fenceGeneration: fenceGenerationAtEntry,
              })
            },
          },
        },
      )
    },
  )

  server.handle(RPC_CHANNELS.admin.CREATE_ORGANIZATION, async (_ctx, rawInput: unknown) => {
    const input = CreateOrganizationRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createOrganization', (client, accessToken) =>
      client.createOrganization(accessToken, input.data))
  })

  server.handle(RPC_CHANNELS.admin.PREVIEW_ORGANIZATION_JOIN, async (_ctx, rawToken: unknown) => {
    const token = OrganizationJoinTokenRpcInputSchema.safeParse(rawToken)
    if (!token.success) return adminInputError('VALIDATION_ERROR')
    try {
      const result = await createPublicAdminClient(requireAdminUrl())
        .previewOrganizationJoin(token.data)
      return { success: true, ...result }
    } catch (error) {
      const adminError = toAdminRpcError(error)
      log?.warn('[Admin] previewOrganizationJoin failed:', adminError.message)
      return { success: false, ...adminError }
    }
  })

  server.handle(RPC_CHANNELS.admin.ACCEPT_ORGANIZATION_JOIN, async (_ctx, rawToken: unknown) => {
    const token = OrganizationJoinTokenRpcInputSchema.safeParse(rawToken)
    if (!token.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('acceptOrganizationJoin', (client, accessToken) =>
      client.acceptOrganizationJoin(accessToken, token.data))
  })

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATION_MEMBERS, async (_ctx, rawOrganizationId: unknown) => {
    const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
    if (!organizationId.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('listOrganizationMembers', (client, accessToken) =>
      client.listOrganizationMembers(accessToken, organizationId.data))
  })

  server.handle(RPC_CHANNELS.admin.LIST_ORGANIZATION_INVITATIONS, async (_ctx, rawOrganizationId: unknown) => {
    const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
    if (!organizationId.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('listOrganizationInvitations', (client, accessToken) =>
      client.listOrganizationInvitations(accessToken, organizationId.data))
  })

  server.handle(
    RPC_CHANNELS.admin.CREATE_ORGANIZATION_INVITATION,
    async (_ctx, rawOrganizationId: unknown, rawInput: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const input = CreateOrganizationInvitationRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !input.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('createOrganizationInvitation', (client, accessToken) =>
        client.createOrganizationInvitation(accessToken, organizationId.data, input.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.CANCEL_ORGANIZATION_INVITATION,
    async (_ctx, rawOrganizationId: unknown, rawInvitationId: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const invitationId = OrganizationIdRpcInputSchema.safeParse(rawInvitationId)
      if (!organizationId.success || !invitationId.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('cancelOrganizationInvitation', (client, accessToken) =>
        client.cancelOrganizationInvitation(accessToken, organizationId.data, invitationId.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.CREATE_ORGANIZATION_JOIN_LINK,
    async (_ctx, rawOrganizationId: unknown, rawInput: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const input = CreateOrganizationJoinLinkRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !input.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('createOrganizationJoinLink', (client, accessToken) =>
        client.createOrganizationJoinLink(accessToken, organizationId.data, input.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.REVOKE_ORGANIZATION_JOIN_LINK,
    async (_ctx, rawOrganizationId: unknown, rawJoinLinkId: unknown) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const joinLinkId = OrganizationIdRpcInputSchema.safeParse(rawJoinLinkId)
      if (!organizationId.success || !joinLinkId.success) return adminInputError('VALIDATION_ERROR')
      return callOrganization('revokeOrganizationJoinLink', (client, accessToken) =>
        client.revokeOrganizationJoinLink(accessToken, organizationId.data, joinLinkId.data))
    },
  )

  server.handle(
    RPC_CHANNELS.admin.UPDATE_ORGANIZATION_MEMBER,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawMemberId: unknown,
      rawInput: unknown,
    ) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const memberId = OrganizationIdRpcInputSchema.safeParse(rawMemberId)
      const input = UpdateOrganizationMemberRpcInputSchema.safeParse(rawInput)
      if (!organizationId.success || !memberId.success || !input.success) {
        return adminInputError('VALIDATION_ERROR')
      }
      return callOrganization('updateOrganizationMember', async (client, accessToken, userId) => {
        const result = await client.updateOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data,
        )
        invalidateCreatorArtifactCache(userId, organizationId.data)
        return result
      })
    },
  )

  server.handle(
    RPC_CHANNELS.admin.REMOVE_ORGANIZATION_MEMBER,
    async (
      _ctx,
      rawOrganizationId: unknown,
      rawMemberId: unknown,
      rawReason: unknown,
    ) => {
      const organizationId = OrganizationIdRpcInputSchema.safeParse(rawOrganizationId)
      const memberId = OrganizationIdRpcInputSchema.safeParse(rawMemberId)
      const input = RemoveOrganizationMemberRpcInputSchema.safeParse(
        rawReason === undefined ? {} : { reason: rawReason },
      )
      if (!organizationId.success || !memberId.success || !input.success) {
        return adminInputError('VALIDATION_ERROR')
      }
      return callOrganization('removeOrganizationMember', async (client, accessToken, userId) => {
        const result = await client.removeOrganizationMember(
          accessToken,
          organizationId.data,
          memberId.data,
          input.data.reason,
        )
        invalidateCreatorArtifactCache(userId, organizationId.data)
        return result
      })
    },
  )

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT_CAPABILITIES, async () =>
    callOrganization('getCreatorArtifactCapabilities', (client, accessToken) =>
      client.getCreatorArtifactCapabilities(accessToken)))

  server.handle(RPC_CHANNELS.admin.LIST_CREATOR_ARTIFACTS, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactListRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization(
      'listCreatorArtifacts',
      async (client, accessToken, userId) => {
        const key = [
          userId,
          input.data.organizationId,
          input.data.type ?? '',
          input.data.includeDrafts ? 'drafts' : 'published',
          input.data.cursor ?? '',
        ].join('\0')
        const cached = creatorArtifactCatalogCache.get(key)
        if (cached && cached.expiresAt > Date.now()) return cached.value
        const generation = creatorArtifactCacheGeneration(
          userId,
          input.data.organizationId,
        )
        const value = await client.listCreatorArtifacts(accessToken, input.data)
        if (creatorArtifactCacheGenerationMatches(
          userId,
          input.data.organizationId,
          generation,
        )) {
          creatorArtifactCatalogCache.set(key, {
            expiresAt: Date.now() + CREATOR_ARTIFACT_CACHE_TTL_MS,
            value,
          })
        }
        return value
      },
    )
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_ARTIFACT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactIdRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorArtifact', async (client, accessToken) => {
      const detail = await client.getCreatorArtifact(
        accessToken,
        input.data.organizationId,
        input.data.artifactId,
        input.data.version,
        input.data.referencePath,
      )
      return CreatorArtifactDetailSchema.parse(detail)
    })
  })

  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT, async (_ctx, rawInput: unknown) => {
    const input = CreateCreatorArtifactRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorArtifact', async (client, accessToken, userId) => {
      const result = await client.createCreatorArtifact(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_DRAFT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.omit({ version: true })
      .safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('deleteCreatorArtifactDraft', async (client, accessToken, userId) => {
      const result = await client.deleteCreatorArtifactDraft(
        accessToken,
        input.data.organizationId,
        input.data.artifactId,
        input.data.idempotencyKey,
      )
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreateCreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.createCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  // The renderer owns the selected File and PUTs it directly. This RPC only
  // renews a short-lived grant and never receives archive bytes.
  server.handle(RPC_CHANNELS.admin.CREATE_CREATOR_SKILL_UPLOAD_GRANT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactUploadGrantRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('createCreatorSkillUploadGrant', async (client, accessToken) => ({
      grant: await client.createCreatorSkillUploadGrant(accessToken, input.data),
    }))
  })

  server.handle(RPC_CHANNELS.admin.COMPLETE_CREATOR_SKILL_UPLOAD, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactUploadCompleteRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('completeCreatorSkillUpload', async (client, accessToken, userId) => {
      const completed = await client.completeCreatorSkillUpload(accessToken, input.data)
      if (completed.uploadGeneration !== input.data.uploadGeneration) {
        throw new AdminError(
          'Admin service did not bind the upload generation',
          'version_conflict',
        )
      }
      const archiveChecksum = completed.archiveChecksum
      if (!archiveChecksum || archiveChecksum !== input.data.archiveChecksum) {
        throw new AdminError(
          'Admin service did not bind the uploaded archive checksum',
          'checksum_mismatch',
        )
      }
      if (completed.sizeBytes !== input.data.sizeBytes) {
        throw new AdminError(
          'Admin service did not bind the uploaded archive size',
          'checksum_mismatch',
        )
      }
      const result = await client.triggerCreatorSkillValidation(accessToken, {
        artifactId: input.data.artifactId,
        version: input.data.version,
      })
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return { version: result }
    })
  })

  server.handle(RPC_CHANNELS.admin.PUBLISH_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('publishCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.publishCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.DELETE_CREATOR_ARTIFACT_VERSION_DRAFT, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactVersionRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('deleteCreatorArtifactVersionDraft', async (client, accessToken, userId) => {
      const result = await client.deleteCreatorArtifactVersionDraft(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.SET_CREATOR_ARTIFACT_ARCHIVED, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactArchiveRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('setCreatorArtifactArchived', async (client, accessToken, userId) => {
      const result = await client.setCreatorArtifactArchived(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.REVOKE_CREATOR_ARTIFACT_VERSION, async (_ctx, rawInput: unknown) => {
    const input = CreatorArtifactRevokeRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('revokeCreatorArtifactVersion', async (client, accessToken, userId) => {
      const result = await client.revokeCreatorArtifactVersion(accessToken, input.data)
      invalidateCreatorArtifactCache(userId, input.data.organizationId)
      return result
    })
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_SKILL_DOWNLOAD_GRANT, async (_ctx, rawInput: unknown) => {
    const input = CreatorSkillDownloadRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorSkillDownloadGrant', (client, accessToken) =>
      client.getCreatorSkillDownloadGrant(accessToken, input.data))
  })

  server.handle(RPC_CHANNELS.admin.GET_CREATOR_SKILL_SAFETY_STATUS, async (_ctx, rawInput: unknown) => {
    const input = CreatorSkillSafetyRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('getCreatorSkillSafetyStatus', (client, accessToken) =>
      client.getCreatorSkillSafetyStatus(accessToken, input.data))
  })

  // This is the authenticated receiving boundary for Creator Space's publish
  // intent.  It resolves the requested source organization from the current
  // Admin session before creating the draft, so query parameters can never
  // select an organization the session cannot access.
  server.handle(RPC_CHANNELS.admin.PUBLISH_CREATOR_APP, async (_ctx, rawInput: unknown) => {
    const input = CreatorAppPublishRpcInputSchema.safeParse(rawInput)
    if (!input.success) return adminInputError('VALIDATION_ERROR')
    return callOrganization('publishCreatorApp', async (client, accessToken, userId) => {
      const organizations = await client.listOrganizations(accessToken)
      const activeOrganizations = organizations.organizations.filter(item => (
        item.status !== 'suspended' && item.membership?.status === 'active'
      ))
      const resolved = resolveCreatorAppPublishingOrganization({
        requestedOrganizationId: input.data.organizationId,
        availableOrganizationIds: activeOrganizations.map(item => item.id),
        fallbackOrganizationId: null,
      })
      if (!resolved.organizationId) {
        throw new AdminError('The source organization is unavailable', 'ORGANIZATION_UNAVAILABLE')
      }
      if (input.data.mode === 'website') {
        const app = await client.createPlatformApp(accessToken, resolved.organizationId, { name: input.data.name, visibility: input.data.visibility, deliveryMode: 'remote_url', remoteUrl: input.data.websiteUrl! })
        const publication = { appId: app.id, releaseId: '', version: '1.0.0', status: 'published' as const }
        invalidateCreatorArtifactCache(userId, resolved.organizationId)
        return { publication }
      }
      const archive = Uint8Array.from(Buffer.from(input.data.payloadBase64!, 'base64'))
      const entries = decodeCreatorAppPayloadZip(archive)
      const analysis = analyzeCreatorAppPayload(entries)
      if (analysis.status === 'invalid') throw new AdminError(analysis.message, 'VALIDATION_ERROR')
      if (analysis.status === 'needs_entry_selection' && !input.data.selectedEntry) return { status: 'needs_entry_selection' as const, candidates: analysis.candidates }
      const entry = input.data.selectedEntry ?? (analysis.status === 'ready' ? analysis.candidate : undefined)
      if (!entry) throw new AdminError('Choose which detected file starts the application.', 'VALIDATION_ERROR')
      const app = input.data.appId
        ? { id: input.data.appId }
        : await client.createPlatformApp(accessToken, resolved.organizationId, { name: input.data.name, visibility: input.data.visibility, deliveryMode: 'local_bundle' })
      let created: {
        release: { id: string; appId: string; version: string }
        upload: { url: string; method: 'PUT'; headers?: Record<string, string> }
        bundle: ReturnType<typeof createCanonicalCreatorAppBundle>
      } | undefined
      for (let attempt = 0; attempt < CREATOR_APP_RELEASE_CONFLICT_RETRIES; attempt += 1) {
        const releases = await client.listPlatformAppReleases(accessToken, resolved.organizationId, app.id)
        const version = nextCreatorAppPatchVersion(releases)
        const bundle = createCanonicalCreatorAppBundle({
          entries, appId: app.id, version, name: input.data.name, entry,
        })
        try {
          const result = await client.createPlatformRelease(
            accessToken,
            resolved.organizationId,
            app.id,
            {
              version,
              runtime: bundle.manifest.runtime,
              checksum: `sha256:${bundle.checksum}`,
              sizeBytes: bundle.sizeBytes,
              platform: 'any',
              arch: 'any',
            },
          )
          created = { ...result, bundle }
          break
        } catch (error) {
          if (!(error instanceof AdminError) || error.status !== 409) throw error
        }
      }
      if (!created) {
        throw new AdminError(
          'Release version allocation conflicted repeatedly',
          'version_conflict',
          { status: 409 },
        )
      }
      const { release, upload, bundle } = created
      await client.uploadPlatformReleaseBundle(accessToken, upload, bundle.archive)
      await client.completeAndPublishPlatformRelease(accessToken, resolved.organizationId, app.id, release.id)
      const version = release.version
      const publication = { appId: app.id, releaseId: release.id, version, status: 'published' as const, checksum: bundle.checksum, sizeBytes: bundle.sizeBytes }
      invalidateCreatorArtifactCache(userId, resolved.organizationId)
      return { publication }
    })
  })
  return {
    async endCurrentSession(beforeDelete): Promise<AdminSessionEndResult> {
      const manager = getCredentialManager()
      const session = await sessions.capture(manager)
      if (session) {
        return await endAdminSession(
          manager,
          deps,
          sessions,
          session,
          () => beforeDelete?.(manager),
        )
          ? 'ended'
          : 'session_changed'
      }

      const cleared = await sessions.runExclusive(async () => {
        if (await manager.getAdminTokens()) return false
        await beforeDelete?.(manager)
        return true
      })
      return cleared ? 'no_session' : 'session_changed'
    },
  }
}

const CREATOR_ARTIFACT_CACHE_TTL_MS = 30_000
const creatorArtifactCatalogCache = new Map<string, {
  expiresAt: number
  value: Awaited<ReturnType<AdminClient['listCreatorArtifacts']>>
}>()
let creatorArtifactGlobalGeneration = 0
const creatorArtifactUserGenerations = new Map<string, number>()
const creatorArtifactOrganizationGenerations = new Map<string, number>()

interface CreatorArtifactCacheGeneration {
  global: number
  user: number
  organization: number
}

function creatorArtifactCacheGeneration(
  userId: string,
  organizationId: string,
): CreatorArtifactCacheGeneration {
  return {
    global: creatorArtifactGlobalGeneration,
    user: creatorArtifactUserGenerations.get(userId) ?? 0,
    organization: creatorArtifactOrganizationGenerations
      .get(`${userId}\0${organizationId}`) ?? 0,
  }
}

function creatorArtifactCacheGenerationMatches(
  userId: string,
  organizationId: string,
  generation: CreatorArtifactCacheGeneration,
): boolean {
  const current = creatorArtifactCacheGeneration(userId, organizationId)
  return current.global === generation.global
    && current.user === generation.user
    && current.organization === generation.organization
}

function invalidateAllCreatorArtifactCaches(): void {
  creatorArtifactGlobalGeneration += 1
  creatorArtifactCatalogCache.clear()
  creatorArtifactUserGenerations.clear()
  creatorArtifactOrganizationGenerations.clear()
}

/**
 * One-shot direct-switch cleanup step: invalidates every cached creator
 * artifact / skill view. There is no client-side skill-enablement cache —
 * enablement state is server-authoritative — so this covers the local skill
 * caches that do exist.
 */
export function clearLegacySkillCaches(): boolean {
  try {
    invalidateAllCreatorArtifactCaches()
    return true
  } catch {
    return false
  }
}

function invalidateCreatorArtifactCache(userId: string, organizationId?: string): void {
  if (organizationId) {
    // Publication and membership changes alter what every member may see.
    // A per-actor eviction leaves a recently cached member catalog showing a
    // stale role view after an owner changes that member's role.
    creatorArtifactGlobalGeneration += 1
    creatorArtifactCatalogCache.clear()
    creatorArtifactOrganizationGenerations.clear()
    return
  } else {
    creatorArtifactUserGenerations.set(
      userId,
      (creatorArtifactUserGenerations.get(userId) ?? 0) + 1,
    )
  }
  const prefix = organizationId ? `${userId}\0${organizationId}\0` : `${userId}\0`
  for (const key of creatorArtifactCatalogCache.keys()) {
    if (key.startsWith(prefix)) creatorArtifactCatalogCache.delete(key)
  }
}

function requireAdminUrl(): string {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new AdminError('Admin URL is not configured', 'VALIDATION_ERROR')
  }
  return adminUrl
}

function createPublicAdminClient(adminUrl: string): AdminClient {
  return new AdminClient(adminUrl)
}

function createAuthenticatedAdminClient(
  adminUrl: string,
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  requestContext: AdminRequestContext,
): AdminClient {
  return new AdminClient(adminUrl, {
    tokenStore: {
      async getRefreshToken() {
        return await sessions.isCurrent(manager, requestContext.session)
          ? requestContext.session.tokens.refreshToken
          : null
      },
      async onTokensRefreshed(tokens) {
        const refreshedSession = await persistRefreshedTokens(
          manager,
          sessions,
          requestContext.session,
          tokens,
        )
        if (!refreshedSession) throw new AdminSessionChangedError()
        requestContext.session = refreshedSession
      },
    },
  })
}

function adminUserFromStoredTokens(tokens: StoredAdminTokens): AdminUser {
  return {
    id: tokens.userId,
    username: tokens.username,
    displayName: tokens.displayName ?? null,
    role: tokens.role ?? 'member',
    groupIds: tokens.groupIds ?? [],
  }
}

async function persistVerifiedAdminUser(
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  user: AdminUser,
): Promise<AdminSessionSnapshot | null> {
  if (user.id !== expected.tokens.userId) {
    throw new AdminError(
      'Admin validation identity does not match the current session',
      'INVALID_TOKEN',
    )
  }
  const persisted = await sessions.mutateIfCurrent(
    manager,
    expected,
    async current => {
      const updated: StoredAdminTokens = {
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        expiresAt: current.expiresAt,
        userId: user.id,
        username: user.username,
        displayName: user.displayName ?? undefined,
        role: user.role,
        groupIds: user.groupIds,
      }
      sessions.advanceGeneration()
      await manager.setAdminTokens(updated)
      return sessions.createSnapshot(updated)
    },
  )
  return persisted.applied ? persisted.value! : null
}

async function endAdminSession(
  manager: CredentialManager,
  deps: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'> | undefined,
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  beforeDelete?: () => void | Promise<void>,
  whileEnding?: () => void | Promise<void>,
): Promise<boolean> {
  const transition = await sessions.beginEnding(
    manager,
    expected,
    accountId => deps?.onAdminSessionEnding?.(accountId),
  )
  if (!transition) return false
  const { session: ending, cleanup, transitionEpoch: ownedTransitionEpoch } = transition
  // R38-1/R39-1: this flow OWNS the immutable transition epoch returned by
  // beginEnding. It never reads the mutable global active epoch, so a newer
  // transition queued concurrently can never be aborted by this older flow.
  // R31: the transition epoch was already published inside beginEnding's
  // ownership section — synchronously before its cleanup could snapshot
  // executions. Publication at the caller would be too late.

  // R39-1: settlement happens in this outer finally using ONLY the owned
  // epoch: commit after the credential/session transition committed, abort
  // on every earlier exit or thrown dependency. The settle CAS protects a
  // newer transition from being cleared by this older flow.
  let didEnd = false
  try {
  // Catalog authorization and the host lifecycle fence are already active.
  // Slow remote/process cleanup stays outside the lock so a replacement login
  // can proceed; final token deletion is guarded by the ending snapshot CAS.
  try {
    await whileEnding?.()
  } catch (error) {
    deps?.platform.logger.warn(
      '[Admin] session-ending side effect failed; continuing fail-closed cleanup:',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    await cleanup
  } catch (error) {
    deps?.platform.logger.warn(
      '[Admin] local app cleanup failed while ending the session; continuing fail-closed cleanup:',
      error instanceof Error ? error.message : String(error),
    )
  }

  // The ProductSpace fence is Main state that outlives the renderer's own
  // revoke attempt: end the session's runtime scope too, so a logout can
  // never return while a committed fence (or offline view) survives.
  try {
    await revokeRuntimeProductSpaceFence()
  } catch (error) {
    deps?.platform.logger.warn(
      '[Admin] ProductSpace fence revoke failed while ending the session:',
      error instanceof Error ? error.message : String(error),
    )
  }

  const ended = await sessions.finishEndingIfCurrent(
    manager,
    ending,
    async () => {
      try {
        await beforeDelete?.()
      } catch (error) {
        deps?.platform.logger.warn(
          '[Admin] secondary session cleanup failed; deleting Admin credentials:',
          error instanceof Error ? error.message : String(error),
        )
      }
      await manager.deleteAdminTokens()
      return true
    },
  )
  didEnd = ended.applied && ended.value === true
  if (didEnd) {
    // The Admin credentials are gone: the synchronous authenticated-account
    // mirror drops to signed-out (a replacement login re-commits it).
    setSyncTrustedProductSpaceAccountId(null)
    invalidateAllCreatorArtifactCaches()
  }
  } finally {
    // R39-1: owner-matched settlement from the outer finally — commit only
    // after the credential/session transition committed; abort on every
    // earlier exit or thrown dependency. The epoch CAS makes this a no-op
    // if a newer transition has superseded this owner.
    settleAccountTransition(ownedTransitionEpoch, didEnd ? 'commit' : 'abort')
  }
  return didEnd
}

async function completeAdminLogin(args: {
  adminUrl: string
  manager: CredentialManager
  login: AdminLoginResponse
  loginAttempt: number
  sessions: AdminSessionCoordinator
  deps: Pick<
    HandlerDeps,
    'onAdminSessionEnding' | 'onAdminSessionStarted' | 'platform'
  >
  onSyncFailure: (error: unknown) => void
}): Promise<AdminSessionSnapshot | null> {
  // R38-1/R39-1: handle for the transition this replacement login may
  // begin. Settlement is owner-matched and happens on EVERY path below:
  // commit only after the credential/session snapshot committed, abort on
  // stale-attempt exit, cleanup rejection, or any thrown dependency.
  let replacementTransitionEpoch: number | null = null
  let replacementCommitted = false
  const replacement = await args.sessions.runExclusive(async () => {
    if (!args.sessions.isLatestLoginAttempt(args.loginAttempt)) return null

    const previousTokens = await args.manager.getAdminTokens()
    const previousAdminConnectionSlugs = getAdminManagedConnectionSlugs()
    const switchingAccounts = Boolean(
      previousTokens && previousTokens.userId !== args.login.user.id,
    )

    // Advancing before the first cleanup await makes every older request
    // stale for the full account-transition window.
    const transitionGeneration = args.sessions.advanceGeneration()
    if (previousTokens && switchingAccounts) {
      args.sessions.closeAuthorizationForEnding(previousTokens.userId)
      // Account replacement must be total before account B becomes usable:
      // every registered execution of account A (assistant sessions and
      // Local Apps alike) must reach a terminal state, and account A's
      // ProductSpace fence must be revoked — BEFORE account B's tokens land
      // or its session starts. A failed stop or revoke propagates: the
      // replacement is refused with a retryable local error and the login
      // can be retried once the runtime is clean. The coordinator
      // deduplicates this against an already-running logout cleanup.
      //
      // The lock-free account-transition epoch is advanced SYNCHRONOUSLY
      // before the first cleanup await: in-flight execution starts that
      // captured the previous epoch fail closed even while the mirror still
      // shows account A and the fence revoke is queued behind the switch
      // lock. The epoch is monotonic — an aborted replacement keeps stale
      // starts refused while fresh starts simply capture the new epoch.
      replacementTransitionEpoch = beginAccountTransition()
      try {
        await args.sessions.getOrStartAccountCleanup(
          previousTokens.userId,
          transitionGeneration,
          async () => {
            await args.deps.onAdminSessionEnding?.(previousTokens.userId)
            await revokeRuntimeProductSpaceFence()
          },
        )
      } catch (error) {
        // R38-1: the owner explicitly aborts — the prior account boundary
        // is restored as valid instead of leaving the runtime stuck on
        // account_transition_pending forever.
        settleAccountTransition(replacementTransitionEpoch, 'abort')
        args.deps.platform.logger.warn(
          '[Admin] previous account cleanup failed during login replacement; refusing the replacement:',
          error instanceof Error ? error.message : String(error),
        )
        throw new AdminError(
          'The previous account is still shutting down. Retry the sign-in.',
          'account_transition_pending',
        )
      }
      await deleteAdminManagedConnections(
        args.manager,
        previousAdminConnectionSlugs,
      )
      setAdminConfigVersion(undefined)
    }

    const nextTokens: StoredAdminTokens = {
      accessToken: args.login.accessToken,
      refreshToken: args.login.refreshToken,
      expiresAt: expiresAtFromNow(args.login.expiresIn),
      userId: args.login.user.id,
      username: args.login.user.username,
      displayName: args.login.user.displayName ?? undefined,
      role: args.login.user.role,
      groupIds: args.login.user.groupIds,
    }
    await args.deps.onAdminSessionStarted?.(args.login.user.id)
    await args.manager.setAdminTokens(nextTokens)
    // Only a newly authenticated session may reopen the account-level Catalog
    // gate. Individual organizations remain offline until their own sync.
    resumeAppCatalogAccessForAccount(args.login.user.id)
    setAdminConfigVersion(undefined)

    if (!switchingAccounts) {
      await deleteAdminManagedConnections(
        args.manager,
        previousAdminConnectionSlugs,
      )
    }
    return args.sessions.createSnapshot(nextTokens)
  })
  // R39-1: owner-matched settlement — commit only when the credential/
  // session snapshot committed; abort on stale attempt or any thrown
  // dependency. The outer catch guarantees the abort on every throw.
  try {
    if (replacement) replacementCommitted = true
    if (replacementTransitionEpoch !== null) {
      settleAccountTransition(replacementTransitionEpoch, replacementCommitted ? 'commit' : 'abort')
    }
    if (!replacement) return null

    try {
      const synced = await syncAdminConnections({
        adminUrl: args.adminUrl,
        manager: args.manager,
        sessions: args.sessions,
        session: replacement,
      })
      return synced.session
    } catch (error) {
      if (error instanceof AdminSessionChangedError) return null
      // Authentication has already succeeded and the one-time code may already
      // be consumed. Keep the persisted session, but fail closed for model
      // authorization so a previous account's managed connections cannot be used.
      args.onSyncFailure(error)
      return await args.sessions.isCurrent(args.manager, replacement)
        ? replacement
        : null
    }
  } catch (error) {
    // R39-1: a dependency thrown after begin must abort the owned
    // transition (the settle CAS makes a repeated settlement a no-op).
    if (replacementTransitionEpoch !== null && !replacementCommitted) {
      settleAccountTransition(replacementTransitionEpoch, 'abort')
    }
    throw error
  }
}

function logPostLoginSyncFailure(
  log: HandlerDeps['platform']['logger'],
  error: unknown,
): void {
  log?.warn(
    '[Admin] post-login connection sync failed; session remains authenticated:',
    error instanceof Error ? error.message : String(error),
  )
}

async function ensureValidTokens(
  adminUrl: string,
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>,
): Promise<TokenValidationResult> {
  const initialSession = await sessions.capture(manager)
  if (!initialSession) return { tokens: null }
  const { tokens } = initialSession

  if (!manager.isExpired({
    value: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  })) {
    return {
      tokens,
      session: initialSession,
      accessMode: 'online',
    }
  }

  try {
    const refreshed = await createPublicAdminClient(adminUrl)
      .refresh(tokens.refreshToken)
    const refreshedSession = await persistRefreshedTokens(
      manager,
      sessions,
      initialSession,
      refreshed,
    )
    if (!refreshedSession) return { tokens: null, stale: true }
    return {
      tokens: refreshedSession.tokens,
      session: refreshedSession,
      accessMode: 'online',
    }
  } catch (error) {
    if (error instanceof AdminSessionChangedError) {
      return { tokens: null, stale: true }
    }
    if (isSessionEndingAuthFailure(error)) {
      const ended = await endAdminSession(
        manager,
        deps,
        sessions,
        initialSession,
      )
      if (!ended) return { tokens: null, stale: true }
      return {
        tokens: null,
        authError: toAdminRpcError(error),
      }
    }
    if (isTemporaryAdminFailure(error)) {
      if (!await sessions.isCurrent(manager, initialSession)) {
        return { tokens: null, stale: true }
      }
      return {
        tokens,
        session: initialSession,
        accessMode: 'offline',
        warning: toAdminRpcError(error).message,
      }
    }
    if (!await sessions.isCurrent(manager, initialSession)) {
      return { tokens: null, stale: true }
    }
    const ended = await endAdminSession(
      manager,
      deps,
      sessions,
      initialSession,
    )
    if (!ended) return { tokens: null, stale: true }
    return {
      tokens: null,
      authError: toAdminRpcError(error),
    }
  }
}

async function persistRefreshedTokens(
  manager: CredentialManager,
  sessions: AdminSessionCoordinator,
  expected: AdminSessionSnapshot,
  refreshed: AdminRefreshResponse,
): Promise<AdminSessionSnapshot | null> {
  const persisted = await sessions.mutateIfCurrent(
    manager,
    expected,
    async existing => {
      const updated: StoredAdminTokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: expiresAtFromNow(refreshed.expiresIn),
        userId: existing.userId,
        username: existing.username,
        displayName: existing.displayName,
        role: existing.role,
        groupIds: existing.groupIds,
      }
      sessions.advanceGeneration()
      await manager.setAdminTokens(updated)
      return sessions.createSnapshot(updated)
    },
  )
  return persisted.applied ? persisted.value! : null
}

async function syncAdminConnections(args: {
  adminUrl: string
  manager: CredentialManager
  sessions: AdminSessionCoordinator
  session?: AdminSessionSnapshot
  deps?: Pick<HandlerDeps, 'onAdminSessionEnding' | 'platform'>
}): Promise<{
  configVersion: string
  connectionCount: number
  defaultConnection: string | null
  session: AdminSessionSnapshot
}> {
  let session = args.session
  if (!session) {
    const tokens = await ensureValidTokens(
      args.adminUrl,
      args.manager,
      args.sessions,
      args.deps,
    )
    if (!tokens.tokens) {
      if (tokens.stale) throw new AdminSessionChangedError()
      throw new AdminError('Admin session is not logged in', 'UNAUTHORIZED')
    }
    if (tokens.accessMode === 'offline') {
      throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR')
    }
    session = tokens.session
  }
  const requestContext: AdminRequestContext = { session }
  try {
    const client = createAuthenticatedAdminClient(
      args.adminUrl,
      args.manager,
      args.sessions,
      requestContext,
    )
    const response = await client.getLlmConnections(
      requestContext.session.tokens.accessToken,
    )
    const applied = await args.sessions.mutateIfCurrent(
      args.manager,
      requestContext.session,
      async () => {
        const incomingSlugs = new Set(
          response.connections.map(connection => connection.slug),
        )
        for (const existing of getLlmConnections()) {
          if (
            existing.managedBy === 'admin'
            && !incomingSlugs.has(existing.slug)
          ) {
            await deleteConnectionAndCredentials(args.manager, existing.slug)
          }
        }

        for (const connection of response.connections) {
          await upsertAdminConnection(
            args.manager,
            connection,
            response.configVersion,
            requestContext.session.tokens.accessToken,
          )
        }

        if (
          response.defaultConnection
          && getLlmConnections().some(
            connection => connection.slug === response.defaultConnection,
          )
        ) {
          setDefaultLlmConnection(response.defaultConnection)
        }
        setAdminConfigVersion(response.configVersion)
      },
    )
    if (!applied.applied) throw new AdminSessionChangedError()
    return {
      configVersion: response.configVersion,
      connectionCount: response.connections.length,
      defaultConnection: response.defaultConnection,
      session: requestContext.session,
    }
  } catch (error) {
    if (error instanceof AdminSessionChangedError) throw error
    if (isSessionEndingAuthFailure(error)) {
      const ended = await endAdminSession(
        args.manager,
        args.deps,
        args.sessions,
        requestContext.session,
      )
      if (!ended) throw new AdminSessionChangedError()
      throw error
    }
    const cleaned = await args.sessions.mutateIfCurrent(
      args.manager,
      requestContext.session,
      async () => {
        setAdminConfigVersion(undefined)
        await deleteAdminManagedConnections(args.manager)
      },
    )
    if (!cleaned.applied) throw new AdminSessionChangedError()
    throw error
  }
}

async function upsertAdminConnection(
  manager: CredentialManager,
  connection: AdminLlmConnection,
  configVersion: string,
  accessToken: string,
): Promise<void> {
  const apiKey = readApiKey(connection, accessToken)
  const { apiKey: _apiKey, key: _key, credentials: _credentials, endpoint, ...configConnection } = connection
  const adminConnection: LlmConnection = {
    ...configConnection,
    baseUrl: endpoint ?? configConnection.baseUrl,
    createdAt: configConnection.createdAt ?? Date.now(),
    managedBy: 'admin',
    adminConfigVersion: configVersion,
  }
  const piAuthProvider = deriveAdminPiAuthProvider(adminConnection)
  if (piAuthProvider && !adminConnection.piAuthProvider) {
    adminConnection.piAuthProvider = piAuthProvider
  }

  const existing = getLlmConnections().find(item => item.slug === adminConnection.slug)
  if (existing) {
    scrubCredentialFields(existing)
    const { slug: _slug, ...updates } = adminConnection
    updateLlmConnection(adminConnection.slug, updates)
  } else {
    addLlmConnection(adminConnection)
  }

  if (apiKey) {
    await manager.setLlmApiKey(adminConnection.slug, apiKey)
  }
}

function deriveAdminPiAuthProvider(connection: LlmConnection): string | undefined {
  if (
    connection.providerType !== 'pi_compat' ||
    !connection.baseUrl?.trim() ||
    !connection.customEndpoint?.api
  ) {
    return undefined
  }

  return connection.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai'
}

export function readApiKey(connection: AdminLlmConnection, accessToken: string): string | null {
  const value =
    connection.apiKey ??
    connection.key ??
    connection.credentials?.apiKey ??
    connection.credentials?.key
  if (isTransitEncryptedApiKey(value)) {
    return decryptTransitApiKey(value, deriveTransitKey(accessToken))
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isTransitEncryptedApiKey(value: unknown): value is { alg: string; iv: string; ciphertext: string; tag: string } {
  if (!value || typeof value !== 'object') return false
  const encrypted = value as { alg?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown }
  return encrypted.alg === 'A256GCM' &&
    typeof encrypted.iv === 'string' &&
    typeof encrypted.ciphertext === 'string' &&
    typeof encrypted.tag === 'string'
}

function scrubCredentialFields(connection: LlmConnection): void {
  const mutable = connection as LlmConnection & {
    apiKey?: unknown
    key?: unknown
    credentials?: unknown
  }
  delete mutable.apiKey
  delete mutable.key
  delete mutable.credentials
}

function getAdminManagedConnectionSlugs(): string[] {
  return getLlmConnections()
    .filter(connection => connection.managedBy === 'admin')
    .map(connection => connection.slug)
}

async function deleteAdminManagedConnections(
  manager: CredentialManager,
  additionalSlugs: Iterable<string> = [],
): Promise<void> {
  const slugs = new Set([
    ...additionalSlugs,
    ...getAdminManagedConnectionSlugs(),
  ])

  // Remove every connection from active configuration before awaiting keychain
  // cleanup. Even if credential deletion fails, model dispatch can no longer
  // resolve a previous account's Admin-managed connection.
  for (const slug of slugs) {
    deleteLlmConnection(slug)
  }

  await Promise.all(
    [...slugs].map(slug => manager.deleteLlmCredentials(slug)),
  )
}

async function deleteConnectionAndCredentials(manager: CredentialManager, slug: string): Promise<void> {
  deleteLlmConnection(slug)
  await manager.deleteLlmCredentials(slug)
}

function expiresAtFromNow(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000
}

function isSessionEndingAuthFailure(error: unknown): boolean {
  return error instanceof AdminError
    && classifyAdminAuthorizationFailure(
      error,
      { catalogScoped: false },
    ) === 'session'
}

/**
 * Catalog-scoped error semantics for ProductSpace Catalog/launch calls: only
 * genuine account-session failures (401, UNAUTHORIZED, TOKEN_REVOKED,
 * ACCOUNT_DISABLED) end the login session. Org/space-level denials
 * (FORBIDDEN, MEMBERSHIP_*, NOT_FOUND, 403) stay in-page so the member can
 * return to their personal space.
 */
function isSessionEndingCatalogScopedError(error: unknown): boolean {
  return error instanceof AdminError
    && classifyAdminAuthorizationFailure(
      error,
      { catalogScoped: true },
    ) === 'session'
}

function isTemporaryAdminFailure(error: unknown): boolean {
  return error instanceof AdminError && (
    error.errorCode === 'TIMEOUT'
    || error.errorCode === 'NETWORK_ERROR'
    || error.errorCode === 'SERVER_ERROR'
    || (typeof error.status === 'number' && error.status >= 500)
  )
}

function isCatalogSessionEndingAuthFailure(error: unknown): boolean {
  return error instanceof AdminError
    && classifyAdminAuthorizationFailure(
      error,
      { catalogScoped: true },
    ) === 'session'
}

function isCatalogAuthorizationFailure(error: unknown): boolean {
  return error instanceof AdminError
    && classifyAdminAuthorizationFailure(
      error,
      { catalogScoped: true },
    ) === 'catalog_scope'
}

function toAdminRpcError(error: unknown): {
  errorCode: string
  message: string
  status?: number
  retryAfter?: number
} {
  if (error instanceof AdminError) {
    return {
      errorCode: error.errorCode,
      message: getSafeAdminErrorMessage(error.errorCode, error.status),
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.details?.retryAfter === 'number'
        && Number.isFinite(error.details.retryAfter)
        && error.details.retryAfter > 0
        && error.details.retryAfter <= 86_400
        ? { retryAfter: error.details.retryAfter }
        : {}),
    }
  }
  if (error instanceof Error) {
    return { errorCode: 'UNKNOWN_ERROR', message: 'Admin request failed' }
  }
  return { errorCode: 'UNKNOWN_ERROR', message: 'Admin request failed' }
}

function adminInputError(errorCode: AdminErrorCode): {
  success: false
  errorCode: AdminErrorCode
  message: string
} {
  return {
    success: false,
    errorCode,
    message: getSafeAdminErrorMessage(errorCode),
  }
}

function hasValidationIssue(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
  field: string,
): boolean {
  return issues.some(issue => issue.path[0] === field)
}
