import { RPC_CHANNELS, type KbCollectionList, type KbDocument, type KbDocumentSummary, type KbSearchHit } from '@polo-ai/shared/protocol'
import {
  KB_PUBLISHED_CHECK_TIMEOUT_MS,
  KB_SEARCH_PER_COLLECTION_LIMIT,
  KB_SEARCH_QUERY_MAX_CHARS,
  KB_SEND_RESOLVE_TIMEOUT_MS,
  KB_SESSION_COLLECTIONS_MAX,
  KbCreateCollectionInputSchema,
  KbDocumentRefSchema,
  KbGetSessionCollectionsInputSchema,
  KbListCollectionsInputSchema,
  KbListDocumentsInputSchema,
  KbRejectDocumentInputSchema,
  KbSearchInputSchema,
  KbSessionCollectionsInputSchema,
  KbUploadDocumentInputSchema,
} from '@polo-ai/shared/protocol'
import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { RequestContext } from '@polo-ai/server-core/transport'
import type { OpenVikingTenantAuth } from '../../knowledge-base/openviking-client'
import { getBoundWorkspace, currentWorkspaceId } from './skills'
import {
  captureCompleteTrustedSessionScope,
  captureCompleteTrustedSessionScopeToken,
  isTrustedSessionScopeTokenCurrent,
  resolveTrustedProductSpaceAccountId,
  trustedScopeMatchesSessionRecord,
  type TrustedSessionScopeToken,
} from './trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
} from '../../runtime/product-space-executions'
import {
  appendAudit,
  buildKbModelContextBlock,
  createCollection,
  deleteDocument,
  ensureKbSpaceRoot,
  getDocument,
  indexCollectionPublished,
  kbAuditFor,
  loadKbIndex,
  KbStoreError,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
  listCollections,
  listDocuments,
  searchDocuments,
  transitionDocument,
  uploadDocument,
  type KbIndex,
  type KbOpenVikingSpace,
  type KbSpaceBinding,
  type KbStoreBudget,
} from '../../knowledge-base/store'
import { ensureKbTenant, kbTenantAuth, readKbTenantCredential, type KbTenantCredential } from '../../knowledge-base/tenant'
import {
  adminKbAuth,
  adminKbSpaceConfig,
  readAdminKbCredential,
  type AdminKbLibraryCredential,
} from '../../knowledge-base/admin-credential'
import {
  isManagedOpenViking,
  managedOpenVikingAuth,
  readOpenVikingConfig,
  type OpenVikingConfig,
} from '../../knowledge-base/openviking-client'

/**
 * Enterprise Knowledge Base RPC handlers (POO-108 v3.1).
 *
 * The remote storage tenant IS the knowledge base (brief R1): every handler
 * below resolves the space's tenant binding and turns the RPC into store
 * calls — there is no local copy and no sync step anymore. The storage
 * service stays invisible: failures surface as the neutral
 * `kb_service_unavailable` code and its message never names a vendor, a URI
 * or a raw response (brief D7 — the details live in server logs and the
 * audit trail only).
 *
 * Scope discipline (unchanged from v2): every entry derives its scope from
 * the trusted Admin session + committed ProductSpace fence (same discipline
 * as the Skills surface) and refuses any non-enterprise space with an
 * explicit `kb_unavailable_in_personal` error — a personal-space caller must
 * never see an empty list that looks like "no collections yet". Mutations
 * additionally require the enterprise owner/manager role and a writable
 * space (online, `accessMode: 'active'`, no runtime restriction).
 *
 * Provisioning boundary (brief D2): ONLY management RPCs bring the tenant up
 * (`ensureKbSpace`, idempotent). Reads and the send path use the CACHED
 * credential exclusively (`requireKbSpace`/`readSendKbSpace`) — a space that
 * was never provisioned on this device reads as unavailable/no references,
 * and a read can never trigger a remote write.
 *
 * Credential priority (brief v5 §B): every entry resolves the admin-managed
 * per-space library credential FIRST (`admin-credential.ts`, TTL-cached,
 * never throwing), then the env modes — `POLO_OPENVIKING_API_KEY` (one shared
 * cloud library) and `POLO_OPENVIKING_ROOT_API_KEY` (OSS multi-tenant) —
 * exactly as before. An admin answer replaces the env baseUrl and needs no
 * env config at all; an admin miss changes nothing.
 *
 * Async-store CAS discipline (brief §3 item 5): every store call is awaited,
 * so the authorization check and the change it authorizes are no longer in
 * the same synchronous block. The gap is closed at both ends — the store
 * revalidates the captured scope token right before each REMOTE WRITE it
 * issues, and each handler re-runs `assertKbScopeCurrent(scope)` after its
 * last await and before it discloses or returns.
 */

/** Stable business-RPC error for an uncommitted (null) runtime fence. */
export const KB_PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

export type KbActiveProductSpaceReader = (
  accountId: string,
  productSpaceId: string,
) => TrustedProductSpaceSummary | null

const defaultActiveProductSpaceReader: KbActiveProductSpaceReader = (accountId, productSpaceId) => {
  const verified = getProductSpaceContextStorage(accountId)?.verifiedContext
  if (!verified || verified.activeProductSpaceId !== productSpaceId) return null
  return verified.list.productSpaces.find(space => space.id === productSpaceId) ?? null
}

// Production code never installs a custom reader; tests use this seam the
// same way they install setManagedSkillsRoot / the trusted account provider.
let activeProductSpaceReader: KbActiveProductSpaceReader = defaultActiveProductSpaceReader

export function setKbActiveProductSpaceReaderForTests(reader: KbActiveProductSpaceReader | null): void {
  activeProductSpaceReader = reader ?? defaultActiveProductSpaceReader
}

export function resetKbActiveProductSpaceReaderForTests(): void {
  activeProductSpaceReader = defaultActiveProductSpaceReader
}

/** Test seam for the send-time resolution wall clock (review #7). */
let sendResolveTimeoutMs = KB_SEND_RESOLVE_TIMEOUT_MS

export function setKbSendResolveTimeoutForTests(ms: number): void {
  sendResolveTimeoutMs = ms
}

export function resetKbSendResolveTimeoutForTests(): void {
  sendResolveTimeoutMs = KB_SEND_RESOLVE_TIMEOUT_MS
}

function kbError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? code), { code })
}

interface KbScope {
  workspace: { id: string; rootPath: string; name: string; remoteServer?: unknown }
  space: TrustedProductSpaceSummary & { kind: 'enterprise'; role: 'owner' | 'manager' | 'member' }
  canManage: boolean
  /** The trusted account resolved ONCE at entry and reused for audit. */
  accountId: string
  /** Await-spanning scope token captured at entry; revalidated after awaits. */
  token: TrustedSessionScopeToken
}

function kbSpaceBinding(scope: KbScope): KbSpaceBinding {
  return { productSpaceId: scope.space.id, enterpriseId: scope.space.enterpriseId }
}

function kbSpaceFromAuth(scope: KbScope, config: OpenVikingConfig, auth: OpenVikingTenantAuth): KbOpenVikingSpace {
  return {
    config,
    auth,
    binding: kbSpaceBinding(scope),
    workspaceRoot: scope.workspace.rootPath,
    spaceName: scope.space.name,
    actor: scope.accountId,
    scopeToken: scope.token,
    // Review fix round B2: the store re-consults the LIVE writability view
    // right before every remote write it issues. The entry check alone can
    // see only the space as it was BEFORE the handler's awaits (the tenant
    // walk, the state re-read); a restriction or offline view that lands in
    // that window must still stop the write.
    isWritable: () => assertKbWritable(scope),
  }
}

function kbSpaceFrom(scope: KbScope, config: OpenVikingConfig, credential: KbTenantCredential): KbOpenVikingSpace {
  return kbSpaceFromAuth(scope, config, kbTenantAuth(credential))
}

/**
 * The admin-managed per-space library binding (brief v5 §B) — the HIGHEST
 * credential priority, consulted by every entry below before any env mode:
 * the admin service provisions each enterprise space's dedicated library and
 * hands out its data-plane credential on demand. `null` = the admin answered
 * nothing usable (unconfigured, signed out, no such library, still
 * provisioning, unreachable) and the caller falls through to the env modes
 * unchanged — the read paths only ever see a `null`, never a throw.
 *
 * The resolved config carries the ADMIN baseUrl and neither env key, and
 * keeps `managedApiKey` unset: a dedicated library's space root is the
 * library root itself (`viking://resources/`, the OSS shape), not the derived
 * per-space directory the shared-library managed mode nests under.
 */
async function adminKbSpace(scope: KbScope): Promise<KbOpenVikingSpace | null> {
  const credential = await readAdminKbCredential(scope.space.id, scope.space.enterpriseId)
  if (!credential) return null
  return kbSpaceFromAuth(scope, adminKbSpaceConfig(credential), adminKbAuth(credential))
}

/**
 * The store binding for a READ: the deployment must be configured and the
 * space's tenant credential must already be cached on this device. A miss is
 * the neutral availability failure — reads NEVER provision (brief D2), so a
 * space provisioned on another device stays unavailable here until a
 * management RPC recovers the binding.
 *
 * Admin-managed mode (brief v5 §B): the per-space library credential is the
 * highest priority and needs NO env config — a space the admin answers for
 * resolves even with `POLO_OPENVIKING_URL` unset, and only a clean admin miss
 * falls through to the env modes below.
 *
 * Managed-library mode (brief v4 D-A): there IS no per-device binding — the
 * config's managed key IS the data-plane credential, so the space resolves
 * directly and `tenant.ts` is never consulted.
 *
 * Review fix round B1: LIST_COLLECTIONS by an owner/manager IS that
 * management RPC. The renderer gates the "new collection" button on the
 * `canManage` flag that only a successful list delivers, so a manager whose
 * binding is missing (fresh device, cleared credential store) would otherwise
 * never reach any provisioning entry at all — the management role has already
 * been proven by the trusted-scope authorization, so the list may bring the
 * tenant up. Members keep the read-only rule: their list uses the cached
 * binding exclusively and refuses with the neutral error.
 */
async function requireKbSpace(scope: KbScope): Promise<KbOpenVikingSpace> {
  const admin = await adminKbSpace(scope)
  if (admin) return admin
  const config = readOpenVikingConfig()
  if (!config) {
    throw new KbStoreError('kb_service_unavailable', KB_SERVICE_UNAVAILABLE_MESSAGE)
  }
  if (isManagedOpenViking(config)) {
    return kbSpaceFromAuth(scope, config, managedOpenVikingAuth(config))
  }
  const credential = await readKbTenantCredential(scope.space.id, scope.space.enterpriseId)
  if (!credential) {
    throw new KbStoreError('kb_service_unavailable', KB_SERVICE_UNAVAILABLE_MESSAGE)
  }
  return kbSpaceFrom(scope, config, credential)
}

/**
 * The store binding for a MEMBER read: the cached credential ONLY — reads
 * never provision (brief D2) — resolved to `null` when this device holds no
 * binding for the space. A clean credential MISS is the ONLY degraded answer:
 * an unconfigured deployment, a failed credential-store read (the tenant read
 * throws) or an enterprise mismatch all stay real errors, and so does every
 * remote listing failure AFTER a binding was found (F1 acceptance round,
 * 2026-10-21 — "no binding" and "bound but the call failed" must stay
 * distinguishable).
 *
 * Managed-library mode (brief v4 D-A): the binding always resolves — the
 * config's managed key IS the credential — and a space whose directory was
 * never created yet reads as empty through the store's not-found walk rule.
 * Admin-managed mode (brief v5 §B) resolves the same way, from the admin's
 * per-space credential, before any env mode is consulted.
 */
async function readCachedKbSpaceOrNull(scope: KbScope): Promise<KbOpenVikingSpace | null> {
  const admin = await adminKbSpace(scope)
  if (admin) return admin
  const config = readOpenVikingConfig()
  if (!config) {
    throw new KbStoreError('kb_service_unavailable', KB_SERVICE_UNAVAILABLE_MESSAGE)
  }
  if (isManagedOpenViking(config)) {
    return kbSpaceFromAuth(scope, config, managedOpenVikingAuth(config))
  }
  const credential = await readKbTenantCredential(scope.space.id, scope.space.enterpriseId)
  if (!credential) return null
  return kbSpaceFrom(scope, config, credential)
}

/**
 * The store binding for a WRITE: provision/recover the tenant binding first
 * (idempotent, lease-serialized — brief D2). This is the ONLY path that may
 * provision, and every content mutation goes through it, so a binding that
 * vanished (fresh device, cleared credential store) is recovered by the first
 * management RPC instead of failing the surface forever.
 *
 * Managed-library mode (brief v4 D-A): no provisioning exists — the space
 * resolves directly from the config, and the space-root directory is created
 * by the store on first content write (`ensureKbSpaceRoot`). Admin-managed
 * mode (brief v5 §B) resolves the same way from the admin's per-space
 * credential — the library itself was provisioned by the admin service, so
 * the client-side provisioning plane never runs.
 */
async function ensureKbSpace(scope: KbScope): Promise<KbOpenVikingSpace> {
  const admin = await adminKbSpace(scope)
  if (admin) return admin
  const config = readOpenVikingConfig()
  if (!config) {
    throw new KbStoreError('kb_service_unavailable', KB_SERVICE_UNAVAILABLE_MESSAGE)
  }
  if (isManagedOpenViking(config)) {
    return kbSpaceFromAuth(scope, config, managedOpenVikingAuth(config))
  }
  const credential = await ensureKbTenant({
    config,
    identity: {
      productSpaceId: scope.space.id,
      enterpriseId: scope.space.enterpriseId,
      spaceName: scope.space.name,
    },
    actor: scope.accountId,
    audit: kbAuditFor({
      workspaceRoot: scope.workspace.rootPath,
      binding: kbSpaceBinding(scope),
      actor: scope.accountId,
    }),
    scopeToken: scope.token,
  })
  return kbSpaceFrom(scope, config, credential)
}

/**
 * The store binding for ONE send phase: cached credential ONLY (the send path
 * never provisions, brief D2), and every failure degrades to `null` — a KB
 * outage or a missing binding yields "no references", never a failed send
 * (brief D7). Managed-library mode (brief v4 D-A) resolves straight from the
 * config — nothing device-local to miss. Admin-managed mode (brief v5 §B)
 * resolves first, from the admin's per-space credential (itself TTL-cached,
 * so a send pays no admin request); its `null` degrades identically.
 */
async function readSendKbSpace(capture: SendScopeCapture): Promise<KbOpenVikingSpace | null> {
  const config = readOpenVikingConfig()
  const adminCredential: AdminKbLibraryCredential | null = await readAdminKbCredential(
    capture.binding.productSpaceId,
    capture.binding.enterpriseId,
  )
  if (adminCredential) {
    return {
      config: adminKbSpaceConfig(adminCredential),
      auth: adminKbAuth(adminCredential),
      binding: capture.binding,
      workspaceRoot: capture.workspaceRoot,
      spaceName: capture.space.name,
      actor: capture.token.accountId,
      scopeToken: capture.token,
    }
  }
  if (!config) return null
  if (isManagedOpenViking(config)) {
    return {
      config,
      auth: managedOpenVikingAuth(config),
      binding: capture.binding,
      workspaceRoot: capture.workspaceRoot,
      spaceName: capture.space.name,
      actor: capture.token.accountId,
      scopeToken: capture.token,
    }
  }
  let credential: KbTenantCredential | null
  try {
    credential = await readKbTenantCredential(
      capture.binding.productSpaceId,
      capture.binding.enterpriseId,
    )
  } catch {
    return null
  }
  if (!credential) return null
  return {
    config,
    auth: kbTenantAuth(credential),
    binding: capture.binding,
    workspaceRoot: capture.workspaceRoot,
    spaceName: capture.space.name,
    actor: capture.token.accountId,
    scopeToken: capture.token,
  }
}

/**
 * The ONE tenant read both send phases share (review fix round R2): the
 * cached binding and the index built from a SINGLE walk. The draft-commit
 * phase needs the index for its publish checks, the retrieval phase for its
 * collection scoping and hit attribution — loading it twice would walk the
 * same tenant twice inside one send budget. Every step is raced against the
 * shared deadline (review fix round B4 — the binding read used to sit outside
 * any race), and a timed-out load abandons the attempt like every other
 * timed-out phase. `null` degrades both phases (no honored draft, no
 * references); `index: null` with a non-null space means the walk failed but
 * the binding is fine.
 */
interface SendKbContext {
  space: KbOpenVikingSpace
  index: KbIndex | null
}

async function loadSendKbContext(
  deps: HandlerDeps<ISessionManager>,
  capture: SendScopeCapture,
  deadline: number,
  attempt: { abandoned: boolean },
): Promise<SendKbContext | null> {
  const space = await raceSendDeadline<KbOpenVikingSpace | null>(
    readSendKbSpace(capture),
    deadline,
    () => {
      attempt.abandoned = true
      return null
    },
  )
  if (!space) return null
  try {
    const index = await raceSendDeadline<KbIndex | null>(
      loadKbIndex(space, { deadline }),
      deadline,
      () => {
        attempt.abandoned = true
        return null
      },
    )
    return { space, index }
  } catch (error) {
    logKbStoreDetail(deps, 'SEND_INDEX', error)
    return { space, index: null }
  }
}

/** Logs a store failure's RAW cause — server log only, never the wire (D7). */
function logKbStoreDetail(
  deps: HandlerDeps<ISessionManager>,
  operation: string,
  error: unknown,
): void {
  if (error instanceof KbStoreError && error.detail !== undefined) {
    deps.platform.logger?.warn(`KB_${operation}: ${error.code}: ${String(error.detail)}`)
  }
}

/**
 * Fails closed unless the committed ProductSpace fence belongs to the
 * trusted account, resolves to a known ENTERPRISE space, and the requested
 * workspace is exactly the caller's bound workspace. The await-spanning
 * token is captured BEFORE the trusted-account lookup and revalidated right
 * after it, so an account/space transition mid-authorization can never
 * authorize the call (review #3).
 */
async function requireKbScope(
  ctx: RequestContext,
  workspaceId: string,
  deps: HandlerDeps,
): Promise<KbScope> {
  const callerWorkspaceId = currentWorkspaceId(ctx, deps)
  const token = captureCompleteTrustedSessionScopeToken(callerWorkspaceId)
  if (!token) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted caller scope is available')
  }
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  // Post-await CAS: the account/space/fence state may have moved while the
  // trusted account was being resolved.
  assertKbScopeTokenCurrent(token)
  if (!trustedAccountId) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted Admin session is available')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No committed ProductSpace is active for this account')
  }
  const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
  if (!space || space.id !== activeProductSpaceId) {
    // A reader answer that does not match the committed fence id is treated
    // as unresolvable — the fence, not the reader, names the space.
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The active ProductSpace is not resolvable for this account')
  }
  if (space.kind !== 'enterprise') {
    throw kbError('kb_unavailable_in_personal', 'The knowledge base is only available in an enterprise space')
  }
  const workspace = getBoundWorkspace(ctx, workspaceId, deps)
  if (!workspace) {
    throw kbError('workspace_context_mismatch', 'Workspace context mismatch')
  }
  return {
    workspace: workspace as KbScope['workspace'],
    space: space as KbScope['space'],
    canManage: space.role === 'owner' || space.role === 'manager',
    accountId: trustedAccountId,
    token,
  }
}

function assertKbScopeTokenCurrent(token: TrustedSessionScopeToken): void {
  if (!isTrustedSessionScopeTokenCurrent(token)) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The trusted scope changed during the operation')
  }
}

/**
 * Post-await CAS for a captured scope: an account logout, space switch or
 * fence revoke during any awaited step must fail the boundary before it
 * discloses data or commits a mutation (review #3).
 *
 * With the async store every handler awaits remote calls AFTER
 * `requireKbScope`, so this runs a SECOND time — after the last store await,
 * in the same synchronous block as the disclosure/return it guards. The store
 * additionally revalidates the token before each remote WRITE it initiates
 * (brief §3 item 5), covering the window between this check and the write.
 */
function assertKbScopeCurrent(scope: KbScope): void {
  assertKbScopeTokenCurrent(scope.token)
}

function assertCanManage(scope: KbScope): void {
  if (!scope.canManage) {
    throw kbError('kb_manage_required', 'Only enterprise owners and managers may modify the knowledge base')
  }
}

/**
 * Write protection covers every read-only state, not just the offline view:
 * an online `read_only` enterprise space (verified-refresh restriction or
 * `accessMode: 'read_only'`) keeps its read capabilities but must never
 * mutate the KB (review #4).
 */
function assertKbWritable(scope: KbScope): void {
  if (isRuntimeOfflineReadOnly()) {
    throw kbError('OFFLINE_READ_ONLY', 'The offline read-only view cannot modify the knowledge base')
  }
  if (scope.space.accessMode !== 'active' || isRuntimeProductSpaceRestricted(scope.space.id)) {
    throw kbError('kb_space_read_only', 'This enterprise space is read-only; the knowledge base cannot be modified')
  }
}

/**
 * The ONE session-scope predicate for KB session boundaries: the target
 * session must belong to the caller's complete trusted scope (immutable
 * account AND committed ProductSpace AND caller Workspace) — the same
 * comparator the sessions RPC surface uses (review #2).
 */
function assertSessionInCallerScope(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  callerWorkspaceId: string | null,
): void {
  const scope = captureCompleteTrustedSessionScope(callerWorkspaceId)
  if (!scope) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted caller scope is available')
  }
  const session = deps.sessionManager
    .getSessions()
    .find(candidate => candidate.id === sessionId)
  if (!session || !trustedScopeMatchesSessionRecord(session, scope)) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The target session is outside the caller scope')
  }
}

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  const input = schema.safeParse(raw)
  if (!input.success || input.data === undefined) {
    throw kbError('VALIDATION_ERROR')
  }
  return input.data
}

/** A missing document reads as "no document", not as an RPC failure. */
async function getDocumentOrNull(space: KbOpenVikingSpace, docId: string): Promise<KbDocument | null> {
  try {
    return await getDocument(space, docId)
  } catch (error) {
    if (error instanceof KbStoreError && error.code === 'kb_document_not_found') return null
    throw error
  }
}

export function registerKnowledgeBaseHandlers(
  server: RpcServer,
  deps: HandlerDeps<ISessionManager>,
): void {
  server.handle(RPC_CHANNELS.kb.LIST_COLLECTIONS, async (ctx, rawInput: unknown) => {
    // The bridge passes ONE input object; parsing it directly keeps the
    // shared schema, the handler and the renderer contract identical
    // (review #5 — the previous wrapper produced {workspaceId:{workspaceId}}).
    const input = parseOrThrow(KbListCollectionsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    // B1: a manager's list recovers/provisions the binding (the UI's create
    // button is gated on this list's `canManage`); a member's list is a pure
    // read of the cached binding. An unconfigured deployment still refuses
    // both with the neutral availability error (brief D2/D7).
    let space: KbOpenVikingSpace
    if (scope.canManage) {
      space = await ensureKbSpace(scope)
      // B1 carries into the managed-library mode (brief v4 D-A): the
      // management role is already proven, so the list may create the space's
      // root directory on first use — a member's first list then reads the
      // empty space instead of a missing-directory failure. OSS mode: no-op.
      await ensureKbSpaceRoot(space)
    } else {
      // F1 (acceptance round, 2026-10-21): a member opening the surface on a
      // space that was never provisioned ON THIS DEVICE reads the EMPTY list
      // — informationally exactly what the member saw before any manager
      // provisioned — instead of the neutral failure the UI renders as "the
      // knowledge base operation failed". Still cache-only (brief D2): the
      // miss never provisions and never discloses another space's data, and
      // only the clean binding MISS degrades — a real unavailability (failed
      // credential-store read, enterprise mismatch, remote listing failure)
      // keeps its error.
      const cached = await readCachedKbSpaceOrNull(scope)
      if (!cached) {
        assertKbScopeCurrent(scope)
        return { canManage: false, collections: [] }
      }
      space = cached
    }
    const rows = await listCollections(space, scope.canManage)
    // Post-await CAS: the disclosure is refused for a scope that moved while
    // the remote listing was in flight (review #3, async-store discipline).
    assertKbScopeCurrent(scope)
    const collections = input.publishedOnly
      ? rows.filter(row => row.documentCounts.published > 0)
      : rows
    const result: KbCollectionList = { canManage: scope.canManage, collections }
    return result
  })

  server.handle(RPC_CHANNELS.kb.CREATE_COLLECTION, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbCreateCollectionInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    // The collection is created INSIDE the tenant, so the tenant binding is
    // provisioned/recovered first — the only lazy-provisioning trigger of the
    // whole surface (brief D2). Its failure is the neutral availability
    // error; the raw cause is already in the tenant audit trail.
    const space = await ensureKbSpace(scope)
    const collection = await createCollection(space, { name: input.name, description: input.description })
    assertKbScopeCurrent(scope)
    deps.platform.logger?.info(`KB_CREATE_COLLECTION: ${collection.id} in ${scope.workspace.id}`)
    return collection
  })

  server.handle(RPC_CHANNELS.kb.LIST_DOCUMENTS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbListDocumentsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    const space = await requireKbSpace(scope)
    const rows: KbDocumentSummary[] = await listDocuments(space, input.collectionId)
    assertKbScopeCurrent(scope)
    // Members see published rows only; managers run the review flow and see all.
    return scope.canManage ? rows : rows.filter(row => row.status === 'published')
  })

  server.handle(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbUploadDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    const space = await ensureKbSpace(scope)
    const document = await uploadDocument(space, input.collectionId, {
      title: input.title,
      content: input.content,
    })
    assertKbScopeCurrent(scope)
    return document
  })

  server.handle(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    const space = await ensureKbSpace(scope)
    const summary = await transitionDocument(space, input.docId, 'submit')
    assertKbScopeCurrent(scope)
    return summary
  })

  server.handle(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    // v3.1: the status tag IS the publication — the document already lives in
    // the tenant, so publishing is one transition with no sync step after it.
    const space = await ensureKbSpace(scope)
    const summary = await transitionDocument(space, input.docId, 'publish')
    assertKbScopeCurrent(scope)
    return summary
  })

  server.handle(RPC_CHANNELS.kb.REJECT_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbRejectDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    const space = await ensureKbSpace(scope)
    const summary = await transitionDocument(space, input.docId, 'reject', { reason: input.reason })
    assertKbScopeCurrent(scope)
    return summary
  })

  server.handle(RPC_CHANNELS.kb.REVERT_TO_DRAFT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    const space = await ensureKbSpace(scope)
    const summary = await transitionDocument(space, input.docId, 'revert')
    assertKbScopeCurrent(scope)
    return summary
  })

  server.handle(RPC_CHANNELS.kb.DELETE_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    const space = await ensureKbSpace(scope)
    // Soft delete (brief D4): status=deleted, then a move into the hidden
    // recycle directory — the recycle-bin contract is unchanged.
    const result = await deleteDocument(space, input.docId)
    assertKbScopeCurrent(scope)
    return result
  })

  server.handle(RPC_CHANNELS.kb.GET_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    const space = await requireKbSpace(scope)
    const doc: KbDocument | null = await getDocumentOrNull(space, input.docId)
    assertKbScopeCurrent(scope)
    if (!doc) return null
    // Members may only open published documents; managers preview anything.
    if (!scope.canManage && doc.status !== 'published') return null
    return doc
  })

  server.handle(RPC_CHANNELS.kb.SEARCH, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbSearchInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    // ONE find, server-scoped (brief D5): the storage service filters by the
    // requested collections and the published status in the same call, and
    // the hits arrive with their content inlined — there is no local keyword
    // fallback anymore (brief R3).
    const space = await requireKbSpace(scope)
    const hits: KbSearchHit[] = await searchDocuments(space, input.query, input.collectionIds)
    assertKbScopeCurrent(scope)
    return hits
  })

  server.handle(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbSessionCollectionsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertKbWritable(scope)
    const callerWorkspaceId = currentWorkspaceId(ctx, deps)
    // The TARGET session must live inside the caller's complete trusted
    // scope — supplying a foreign session id from this Workspace can never
    // read or overwrite another account/space/Workspace's KB scope
    // (review #2).
    assertSessionInCallerScope(deps, input.sessionId, callerWorkspaceId)
    // Every selected collection must belong to this enterprise space and
    // hold at least one published document. The check is a READ: the cached
    // binding only, never provisioning (brief D2).
    const space = await requireKbSpace(scope)
    // ONE shared wall clock (review #7) and ONE tenant walk serve every
    // collection: the index is loaded once, then each entry is checked
    // against it in an EXPLICIT loop (brief §3 item 2 — a `filter(async…)`
    // would see every Promise as truthy and pass unpublished collections).
    // Nothing inside the loop is awaited, so the trap cannot arise, and the
    // walk honors the same deadline a per-collection walk would have.
    const publishedCheckDeadline = Date.now() + KB_PUBLISHED_CHECK_TIMEOUT_MS
    const index = await loadKbIndex(space, { deadline: publishedCheckDeadline })
    for (const collectionId of input.collectionIds) {
      if (Date.now() >= publishedCheckDeadline || !indexCollectionPublished(index, collectionId)) {
        throw kbError('kb_collection_not_published', `Collection ${collectionId} is not available for sessions`)
      }
    }
    const unique = [...new Set(input.collectionIds)].slice(0, KB_SESSION_COLLECTIONS_MAX)
    // Snapshot: the audit entry must record the PRE-write scope even if the
    // session manager mutates its record array in place.
    const previous = [...(deps.sessionManager
      .getSessions()
      .find(candidate => candidate.id === input.sessionId)?.kbCollectionIds ?? [])]
    if (JSON.stringify(previous) === JSON.stringify(unique)) {
      return { ok: true as const, collectionIds: unique }
    }
    // Final CAS in the same synchronous block as the audit and the write it
    // authorizes (reviews #3/#15): a fence revoked after the entry await —
    // or during the remote steps above — fails here, before anything is
    // recorded. Writability is re-asserted too (review fix round B2): the
    // space may have turned read-only during the awaited published checks,
    // and the earlier `assertKbWritable(scope)` at the entry no longer
    // covers this point.
    assertKbScopeCurrent(scope)
    assertKbWritable(scope)
    // Audit BEFORE the awaited mutation (review #15): the previous order
    // (mutate → CAS → audit) left a mutated scope with an empty trail when
    // the post-write CAS failed. The write is initiated only while the scope
    // is proven current, and the trail always precedes it.
    await writeSessionScopeAudited(deps, {
      workspaceRoot: scope.workspace.rootPath,
      binding: kbSpaceBinding(scope),
      actor: scope.accountId,
      workspaceId: scope.workspace.id,
      sessionId: input.sessionId,
      from: previous,
      to: unique,
    })
    return { ok: true as const, collectionIds: unique }
  })

  server.handle(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbGetSessionCollectionsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    const callerWorkspaceId = currentWorkspaceId(ctx, deps)
    assertSessionInCallerScope(deps, input.sessionId, callerWorkspaceId)
    const session = await deps.sessionManager.getSession(input.sessionId)
    // Post-await CAS before disclosure: the scope and the session ownership
    // are re-validated after the awaited read (reviews #2/#3).
    assertKbScopeCurrent(scope)
    assertSessionInCallerScope(deps, input.sessionId, callerWorkspaceId)
    return { collectionIds: session?.kbCollectionIds ?? [] }
  })
}

/**
 * Races a promise against a wall-clock deadline (review #7). A KB dependency
 * that never settles (hung auth, stuck session read) degrades to the
 * on-timeout fallback instead of holding the send hostage. The deadline is
 * absolute, so the phases of one resolution share a single budget.
 */
async function raceSendDeadline<T>(
  value: Promise<T>,
  deadline: number,
  onTimeout: () => T,
): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return onTimeout()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(onTimeout()), remaining)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Audit-FIRST session-scope write (review #15). The entry that records the
 * change is appended BEFORE the awaited mutation, so a scope that moved
 * during the write — or a caller whose fence was revoked mid-write — can
 * never leave a mutated scope with an empty trail (the previous order,
 * mutate → CAS → audit, skipped the audit whenever the post-write CAS
 * failed). The write is initiated only from the synchronous block that
 * proved the scope current, and a failed mutation appends a compensating
 * `session_scope.set_failed` entry so the trail never records a change that
 * did not happen.
 */
async function writeSessionScopeAudited(
  deps: HandlerDeps<ISessionManager>,
  params: {
    workspaceRoot: string
    binding: KbSpaceBinding
    actor: string
    workspaceId: string
    sessionId: string
    from: string[]
    to: string[]
    detail?: Record<string, unknown>
  },
): Promise<void> {
  appendAudit(params.workspaceRoot, params.binding, {
    actor: params.actor,
    action: 'session_scope.set',
    target: params.sessionId,
    detail: { from: params.from, to: params.to, workspaceId: params.workspaceId, ...params.detail },
  })
  try {
    await deps.sessionManager.setSessionKbCollections(params.sessionId, params.to)
  } catch (error) {
    appendAudit(params.workspaceRoot, params.binding, {
      actor: params.actor,
      action: 'session_scope.set_failed',
      target: params.sessionId,
      detail: { intended: params.to, error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

/**
 * The scope ONE send-time resolution is bound to, captured once. The complete
 * trusted token names the account, ProductSpace and Workspace the send was
 * authorized against; the audit binding is derived from the CAPTURED space,
 * never from the state at resume time (review N1).
 */
interface SendScopeCapture {
  token: TrustedSessionScopeToken
  space: TrustedProductSpaceSummary & { kind: 'enterprise' }
  binding: KbSpaceBinding
  workspaceRoot: string
}

/**
 * The send path commits a scope change, so it runs the SAME read-only gate as
 * the SET RPC (review #4): an offline view or a read-only space keeps its
 * read capabilities — references still resolve from the STORED scope — but a
 * composer draft can never mutate the session scope.
 */
function isSendScopeWritable(space: SendScopeCapture['space']): boolean {
  return !isRuntimeOfflineReadOnly()
    && space.accessMode === 'active'
    && !isRuntimeProductSpaceRestricted(space.id)
}

async function captureSendScope(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  token: TrustedSessionScopeToken,
  attempt: { abandoned: boolean },
): Promise<SendScopeCapture | null> {
  // The token arrives ALREADY BOUND by the caller — captured before this
  // function's first await (reviews #3/N1). It is only re-checked here, in
  // the same synchronous block the first awaited read starts from.
  if (attempt.abandoned || !isTrustedSessionScopeTokenCurrent(token)) return null
  const session = await deps.sessionManager.getSession(sessionId)
  if (!session || attempt.abandoned) return null
  // The target session must belong to the BOUND capture (account AND space
  // AND workspace), or nothing may be committed or read for it.
  if (!trustedScopeMatchesSessionRecord(session, token)) return null
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  // Post-await CAS: the account/space/fence may all have moved while the
  // lookup was pending — a capture that is no longer current authorizes
  // nothing (reviews #3/N1).
  if (attempt.abandoned || trustedAccountId !== token.accountId) return null
  if (!isTrustedSessionScopeTokenCurrent(token) || !isRuntimeFenceBoundToAccount(trustedAccountId)) return null
  const space = activeProductSpaceReader(trustedAccountId, token.productSpaceId)
  if (!space || space.id !== token.productSpaceId || space.kind !== 'enterprise') return null
  const workspace = deps.sessionManager
    .getWorkspaces()
    .find((item: { id: string }) => item.id === token.workspaceId)
  if (!workspace) return null
  return {
    token,
    space: space as SendScopeCapture['space'],
    binding: { productSpaceId: space.id, enterpriseId: space.enterpriseId },
    workspaceRoot: workspace.rootPath,
  }
}

/**
 * Phase 1 of the send resolution — its ONLY state-changing step. Honors the
 * composer draft for THIS message when the captured scope proves current,
 * writable and owning; returns the effective draft scope ids, or `null` when
 * the draft was not honored (abandoned, read-only, foreign session, nothing
 * to change, or a knowledge base that cannot prove publication) and the
 * STORED scope must be used instead.
 *
 * The publish-state validation shares the resolution's ONE wall clock
 * (review #7) and ONE index load with the retrieval phase (review fix round
 * R2 — the context arrives pre-loaded, no second walk): each draft entry is
 * checked against it in an EXPLICIT loop (brief §3 item 3 — a
 * `filter(async…)` would pass everything, Promise being truthy). The
 * deadline is re-checked inside the loop, so an exhausted budget commits
 * nothing: the stored scope wins.
 */
async function commitSendDraftScope(
  deps: HandlerDeps<ISessionManager>,
  capture: SendScopeCapture,
  sessionId: string,
  draft: string[],
  context: SendKbContext | null,
  attempt: { abandoned: boolean },
  deadline: number,
): Promise<string[] | null> {
  // Fresh read: the record may have moved while the scope was captured.
  const session = await deps.sessionManager.getSession(sessionId)
  if (!session || attempt.abandoned) return null
  if (!trustedScopeMatchesSessionRecord(session, capture.token)) return null
  if (!isSendScopeWritable(capture.space)) return null
  // The draft scope is authoritative for THIS message. Invalid entries are
  // dropped, never fatal. The previous scope is SNAPSHOT before the save —
  // the session record may be mutated in place, and the audit entry must
  // capture the change, not the post-write value.
  const scopeIds: string[] = []
  if (draft.length > 0) {
    // Cached binding only — the send path NEVER provisions (brief D2). A
    // missing binding, an unavailable service or an index that could not be
    // loaded means the draft cannot be PROVEN published, so it is not
    // honored: `null` keeps the stored scope and the retrieval phase
    // degrades to no references.
    if (!context?.index) return null
    for (const collectionId of draft) {
      if (Date.now() >= deadline) break
      if (indexCollectionPublished(context.index, collectionId)) scopeIds.push(collectionId)
    }
  }
  if (JSON.stringify(session.kbCollectionIds ?? []) === JSON.stringify(scopeIds)) return scopeIds
  // The LAST synchronous gate before the write is initiated: after the send
  // deadline this attempt is abandoned (review N1 — a timeout may not leave
  // background work behind that mutates state), and a scope that moved during
  // any awaited step above fails closed here (review #3).
  //
  // The DEADLINE is re-checked absolutely (review N1 residual): the publish
  // loop above can only STOP at the deadline — an exhausted budget lands
  // here with a truncated `scopeIds` and must not commit it. Time is
  // monotonic, so budget gone → no write, no audit, the stored scope wins.
  // The WRITABILITY is re-checked in the same block (review fix round B2):
  // the space may have turned read-only or offline during the awaited index
  // load above, and a draft commit is a scope WRITE.
  if (
    attempt.abandoned
    || Date.now() >= deadline
    || !isSendScopeWritable(capture.space)
    || !isTrustedSessionScopeTokenCurrent(capture.token)
  ) return null
  await writeSessionScopeAudited(deps, {
    workspaceRoot: capture.workspaceRoot,
    binding: capture.binding,
    actor: capture.token.accountId,
    workspaceId: capture.token.workspaceId,
    sessionId,
    from: [...(session.kbCollectionIds ?? [])],
    to: scopeIds,
    detail: { source: 'send_draft_commit' },
  })
  return scopeIds
}

/**
 * Interleaves one find's ranked hits per collection (brief D5): the per-
 * collection cap stops a single dominant collection from filling the list,
 * and the round-robin merge walks the session's selection order so each
 * collection's own ranking is preserved. Rows may carry the internal
 * inlined-content field (brief v4 D-B) — the merge only reorders, never
 * strips.
 */
function interleaveSendReferences(
  hits: Array<KbSearchHit & { content?: string }>,
  scopeIds: string[],
): Array<KbSearchHit & { content?: string }> {
  const byCollection = new Map<string, Array<KbSearchHit & { content?: string }>>()
  for (const hit of hits) {
    const list = byCollection.get(hit.collectionId)
    if (list) {
      if (list.length < KB_SEARCH_PER_COLLECTION_LIMIT) list.push(hit)
    } else {
      byCollection.set(hit.collectionId, [hit])
    }
  }
  const merged: Array<KbSearchHit & { content?: string }> = []
  for (let index = 0; ; index += 1) {
    let added = false
    for (const collectionId of scopeIds) {
      const hit = byCollection.get(collectionId)?.[index]
      if (hit) {
        merged.push(hit)
        added = true
      }
    }
    if (!added) break
  }
  return merged
}

/**
 * Phase 2 of the send resolution — strictly READ-ONLY against the captured
 * space binding. It never touches session or audit state, so finishing after
 * the send deadline is harmless: the caller has already moved on with the
 * fallback, and the late hits are simply discarded (review N1).
 *
 * Retrieval is ONE bounded find (brief §3 item 4): the cached tenant binding
 * must exist, the storage service scopes by the session's collections and the
 * published status in the same call, and hits arrive with content inlined —
 * there is no local keyword scan to fall back to (brief R3). The binding read
 * and the index walk arrive pre-raced through the shared context (review fix
 * round B4 — the binding read used to sit OUTSIDE the deadline race, and the
 * whole phase is raced again by the caller), so every awaited step of the
 * phase honours the send budget. No binding, a failure or a timeout all
 * degrade to ZERO references: a send is never blocked, and no provisioning is
 * ever triggered from here (brief D2/D7).
 */
async function retrieveReferences(
  deps: HandlerDeps<ISessionManager>,
  capture: SendScopeCapture,
  message: string,
  scopeIds: string[],
  context: SendKbContext | null,
  deadline: number,
  attempt: { abandoned: boolean },
): Promise<Array<KbSearchHit & { content?: string }>> {
  if (scopeIds.length === 0) return []
  // The send text is tokenized raw, so it is truncated to the same ceiling
  // the SEARCH RPC schema enforces (review #7).
  const query = message.slice(0, KB_SEARCH_QUERY_MAX_CHARS)
  const space = context?.space ?? null
  if (!space) {
    deps.platform.logger?.info('KB_SEND_REFERENCES: no knowledge base binding, no references')
    return []
  }
  if (Date.now() >= deadline) {
    attempt.abandoned = true
    return []
  }
  // Review fix round R2 residual (b): the shared context already TRIED to
  // build the index and failed (`index: null` — the walk threw or the
  // deadline ended it). Sending the retrieval off WITHOUT it would make
  // `searchDocuments` walk the same tenant a second time inside one budget;
  // two failed walks only double the spend. Attribution (B5) is impossible
  // without this space's index anyway — degrade to no references.
  if (context && context.index === null) {
    deps.platform.logger?.info('KB_SEND_REFERENCES: knowledge base index unavailable, no references')
    return []
  }
  let hits: Array<KbSearchHit & { content?: string }>
  try {
    let timedOut = false
    hits = await raceSendDeadline<Array<KbSearchHit & { content?: string }>>(
      // `includeContent` (brief v4 D-B): the SAME find response also carries
      // the hit bodies the model-context block is assembled from — the send
      // budget pays for one retrieval, not one retrieval plus N reads.
      searchDocuments(space, query, scopeIds, {
        deadline,
        // The walk the draft-commit phase already paid for serves the
        // retrieval's attribution too (review fix round R2).
        ...(context?.index ? { index: context.index } : {}),
      } satisfies KbStoreBudget, { includeContent: true }),
      deadline,
      () => {
        timedOut = true
        return []
      },
    )
    if (timedOut) {
      // The deadline, not the backend, ended the race — mark the attempt
      // abandoned like every other timed-out phase (review N1).
      attempt.abandoned = true
      deps.platform.logger?.warn('KB_SEND_REFERENCES: knowledge base lookup raced past the send deadline, no references')
      return []
    }
  } catch (error) {
    logKbStoreDetail(deps, 'SEND_REFERENCES', error)
    deps.platform.logger?.warn('KB_SEND_REFERENCES: knowledge base lookup failed, no references')
    return []
  }
  return interleaveSendReferences(hits, scopeIds)
}

/**
 * The bounded knowledge context assembled alongside the send references
 * (brief v4 D-B): the <system-reminder> payload the SessionManager injects
 * one-shot into the SAME turn, plus the counts the server log reports.
 * `block` travels as an internal options field — it is never persisted and
 * never enters the message's `kbReferences` snapshot.
 */
export interface KbSendModelContext {
  block: string
  docs: number
  bytes: number
}

/** What one send-time resolution returns — `undefined` means "no references". */
export interface ResolvedSessionKbReferences {
  /**
   * The clean reference rows (title/snippet/score) that persist as the user
   * message's immutable snapshot — the internal inlined-content field is
   * stripped before these leave the resolver.
   */
  references: KbSearchHit[]
  /** Present only when at least one hit arrived WITH its inlined body. */
  modelContext?: KbSendModelContext
}

/**
 * Send-time reference resolution used by the SEND_MESSAGE handler. Split by
 * authority (review N1): phase 1 is the only step that may change state — it
 * commits the composer draft through the full ownership/read-only/pre-write
 * token gates — and phase 2 only reads.
 *
 * ONE token binds the whole resolution (reviews #3/N1): the SEND entry
 * captures its scope token and hands it in here, so the resolution is
 * authorized against exactly the authorization the send was admitted with.
 * The binding happens before the FIRST await and every later gate
 * revalidates THAT token — the resolution never re-captures, so a
 * revoke-and-recommit while a phase is pending can never re-authorize this
 * send after its entry authorization was rejected.
 *
 * Both phases share ONE wall clock (review #7): an empty scope exits before
 * any await, the awaited reads are raced against the deadline, the publish
 * checks, the tenant walk and the find all honour the same deadline, and a
 * timed-out attempt is abandoned — it may return nothing, but never mutates
 * session scope or audit afterwards. Any KB failure degrades to "no
 * references" — a KB outage must never block a send (brief D7).
 *
 * Brief v4 D-B: the SAME find (its inlined `read_content` bodies, zero extra
 * requests) also yields the bounded model-context block, assembled inside
 * this resolution so the injected context is EXACTLY the snapshot the user's
 * reference chips show — one send, one retrieval, two views of it.
 */
export async function resolveSessionKbReferences(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  message: string,
  draftCollectionIds?: string[],
  callerWorkspaceId?: string | null,
  entryScopeToken?: TrustedSessionScopeToken | null,
): Promise<ResolvedSessionKbReferences | undefined> {
  try {
    // Fast path: the session index is synchronous. A session without a KB
    // scope (and without a composer draft to commit) resolves to nothing
    // without touching auth or the store. A provided draft — INCLUDING an
    // explicitly empty one — must stay distinguishable from no draft at all:
    // the empty array is the "user cleared the selection" signal (review #12).
    const draft = Array.isArray(draftCollectionIds)
      ? [...new Set(draftCollectionIds)].slice(0, KB_SESSION_COLLECTIONS_MAX)
      : undefined
    const indexed = deps.sessionManager
      .getSessions()
      .find(candidate => candidate.id === sessionId)
    // Bind the token BEFORE the first await (reviews #3/N1). The SEND entry's
    // token wins; a legacy caller without one gets a token captured right
    // here — still ahead of any await, so no phase can authorize against a
    // scope newer than the request itself.
    const token = entryScopeToken
      ?? captureCompleteTrustedSessionScopeToken(callerWorkspaceId ?? indexed?.workspaceId ?? null)
    if (!token || !isTrustedSessionScopeTokenCurrent(token)) return undefined
    const storedScope = indexed?.kbCollectionIds ?? []
    if ((storedScope.length === 0) && (draft === undefined || draft.length === 0)) return undefined

    const deadline = Date.now() + sendResolveTimeoutMs
    const attempt = { abandoned: false }
    // Phase 0 — capture, read-only: the scope this send is bound to.
    const capture = await raceSendDeadline(
      captureSendScope(deps, sessionId, token, attempt),
      deadline,
      () => {
        attempt.abandoned = true
        return null
      },
    )
    if (!capture) return undefined
    // The ONE shared binding + index load (review fix rounds B4/R2): both
    // phases consume the same context, the binding read sits inside the
    // deadline race, and the tenant is never walked twice per send. Loaded
    // only when a phase actually needs it — a scope-less session with no
    // draft still exits without touching auth or the store.
    let scopeIds = storedScope
    // Review fix round R2 residual (a): an explicit EMPTY draft is the
    // "clear the selection" commit, and it needs NO remote fact — there is
    // no collection left to prove published. It commits BEFORE the shared
    // context load, so a hung credential read or a slow walk can no longer
    // abandon the clear and pin the session to the scope the user just
    // emptied. (An empty draft over an empty stored scope already exited on
    // the fast path above.)
    if (draft !== undefined && draft.length === 0 && scopeIds.length > 0) {
      const committed = await raceSendDeadline(
        commitSendDraftScope(deps, capture, sessionId, [], null, attempt, deadline),
        deadline,
        () => {
          attempt.abandoned = true
          return null
        },
      )
      if (committed !== null) scopeIds = committed
    }
    const needsContext = (draft?.length ?? 0) > 0 || scopeIds.length > 0
    const context = needsContext
      ? await raceSendDeadline<SendKbContext | null>(
        loadSendKbContext(deps, capture, deadline, attempt),
        deadline,
        () => {
          attempt.abandoned = true
          return null
        },
      )
      : null
    // Phase 1 — the only state-changing step. It runs whenever the composer
    // PROVIDED a non-empty draft; an explicit empty one was committed above,
    // ahead of the remote load (review fix round R2 residual a). The commit
    // promise never rejects (a failed write is audited and logged, the send
    // degrades), so a post-timeout settlement cannot become an unhandled
    // rejection.
    if (draft !== undefined && draft.length > 0) {
      const committed = await raceSendDeadline(
        commitSendDraftScope(deps, capture, sessionId, draft, context, attempt, deadline),
        deadline,
        () => {
          attempt.abandoned = true
          return null
        },
      )
      if (committed !== null) scopeIds = committed
    }
    // Phase 2 — read-only retrieval. The binding read and index walk arrived
    // pre-raced in the shared context; the single find is raced here against
    // the same deadline (review fix round B4 — the whole phase used to await
    // the binding read outside any race), so a slow binding can no longer
    // push the send past its budget: the deadline ends the phase instead.
    const hits = await raceSendDeadline<Array<KbSearchHit & { content?: string }>>(
      retrieveReferences(deps, capture, message, scopeIds, context, deadline, attempt),
      deadline,
      () => {
        attempt.abandoned = true
        return []
      },
    )
    if (hits.length === 0) return undefined
    // Brief v4 D-B: the bounded model-context block is assembled from the
    // SAME rows inside this resolution — pure string work over the already
    // inlined bodies (no await), so it stays inside the deadline that bounded
    // the find it feeds on.
    const modelContext = buildKbModelContextBlock(hits) ?? undefined
    // The persisted snapshot stays CLEAN: the inlined bodies ride only the
    // model context, never the `kbReferences` rows (brief v4 D-B).
    const references: KbSearchHit[] = hits.map(({ content: _inlinedBody, ...hit }) => hit)
    return {
      references,
      ...(modelContext ? { modelContext } : {}),
    }
  } catch (error) {
    deps.platform.logger?.warn(`KB_SEND_REFERENCES: reference resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
