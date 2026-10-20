import { RPC_CHANNELS, type KbCollectionList, type KbDocument, type KbDocumentSummary, type KbSearchHit } from '@polo-ai/shared/protocol'
import {
  KB_PUBLISHED_CHECK_TIMEOUT_MS,
  KB_SEND_MAX_SCAN_BYTES,
  KB_SEND_RESOLVE_TIMEOUT_MS,
  KB_SESSION_COLLECTIONS_MAX,
  KB_SEARCH_PER_COLLECTION_LIMIT,
  KB_SEARCH_QUERY_MAX_CHARS,
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
  createCollection,
  deleteDocument,
  getDocument,
  isCollectionPublished,
  KbStoreError,
  listCollections,
  listDocuments,
  searchDocuments,
  transitionDocument,
  uploadDocument,
  type KbSpaceBinding,
} from '../../knowledge-base/store'

/**
 * Enterprise Knowledge Base RPC handlers (POO-108).
 *
 * Every entry derives its scope from the trusted Admin session + committed
 * ProductSpace fence (same discipline as the Skills surface) and refuses any
 * non-enterprise space with an explicit `kb_unavailable_in_personal` error —
 * a personal-space caller must never see an empty list that looks like
 * "no collections yet". Mutations additionally require the enterprise
 * owner/manager role, a writable space (online, `accessMode: 'active'`, no
 * runtime restriction) and append to the workspace's KB audit trail.
 *
 * Store isolation: every store call is bound to the trusted
 * `{productSpaceId, enterpriseId}` pair, so a workspace reused across
 * enterprises keeps one KB per space and no entry can read or write another
 * space's content (review #1). Session-scoped reads/writes additionally run
 * the complete session-scope comparator (account AND committed space AND
 * caller Workspace) and revalidate an await-spanning token after every await
 * and immediately before disclosure or mutation (reviews #2/#3).
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
 * `await requireKbScope(...)` always costs at least one microtask between the
 * helper's internal CAS and the handler body, so a fence revoked in exactly
 * that window still authorized. Every handler therefore calls this as its
 * FIRST statement after the entry await — the check lands in the same
 * synchronous block as the disclosure or mutation that follows, and no await
 * may slip between them.
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
function getDocumentOrNull(workspaceRoot: string, binding: KbSpaceBinding, docId: string): KbDocument | null {
  try {
    return getDocument(workspaceRoot, binding, docId)
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
    const rows = listCollections(scope.workspace.rootPath, kbSpaceBinding(scope), scope.canManage)
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
    const collection = createCollection(
      scope.workspace.rootPath,
      kbSpaceBinding(scope),
      { name: input.name, description: input.description },
      scope.accountId,
    )
    deps.platform.logger?.info(`KB_CREATE_COLLECTION: ${collection.id} in ${scope.workspace.id}`)
    return collection
  })

  server.handle(RPC_CHANNELS.kb.LIST_DOCUMENTS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbListDocumentsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    const rows: KbDocumentSummary[] = listDocuments(
      scope.workspace.rootPath,
      kbSpaceBinding(scope),
      input.collectionId,
    )
    // Members see published rows only; managers run the review flow and see all.
    return scope.canManage ? rows : rows.filter(row => row.status === 'published')
  })

  server.handle(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbUploadDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return uploadDocument(
      scope.workspace.rootPath,
      kbSpaceBinding(scope),
      input.collectionId,
      { title: input.title, content: input.content },
      scope.accountId,
    )
  })

  server.handle(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return transitionDocument(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId, 'submit', {
      actor: scope.accountId,
    })
  })

  server.handle(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return transitionDocument(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId, 'publish', {
      actor: scope.accountId,
    })
  })

  server.handle(RPC_CHANNELS.kb.REJECT_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbRejectDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return transitionDocument(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId, 'reject', {
      actor: scope.accountId,
      reason: input.reason,
    })
  })

  server.handle(RPC_CHANNELS.kb.REVERT_TO_DRAFT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return transitionDocument(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId, 'revert', {
      actor: scope.accountId,
    })
  })

  server.handle(RPC_CHANNELS.kb.DELETE_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    assertCanManage(scope)
    assertKbWritable(scope)
    return deleteDocument(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId, scope.accountId)
  })

  server.handle(RPC_CHANNELS.kb.GET_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    const doc: KbDocument | null = getDocumentOrNull(scope.workspace.rootPath, kbSpaceBinding(scope), input.docId)
    if (!doc) return null
    // Members may only open published documents; managers preview anything.
    if (!scope.canManage && doc.status !== 'published') return null
    return doc
  })

  server.handle(RPC_CHANNELS.kb.SEARCH, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbSearchInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbScopeCurrent(scope)
    const hits: KbSearchHit[] = searchDocuments(
      scope.workspace.rootPath,
      kbSpaceBinding(scope),
      input.query,
      input.collectionIds,
    )
    // Defense in depth: the store only indexes published rows of its OWN
    // space, the scope filter here keeps a forged collectionIds list from
    // changing that.
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
    // hold at least one published document. The checks share ONE wall clock
    // (review #7): the metadata walk is synchronous, so a collection with a
    // huge document listing fails closed at the budget instead of stalling
    // the caller.
    const publishedCheckDeadline = Date.now() + KB_PUBLISHED_CHECK_TIMEOUT_MS
    for (const collectionId of input.collectionIds) {
      if (!isCollectionPublished(scope.workspace.rootPath, kbSpaceBinding(scope), collectionId, {
        deadline: publishedCheckDeadline,
      })) {
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
    // or during any step above — fails here, before anything is recorded.
    assertKbScopeCurrent(scope)
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
 * the draft was not honored (abandoned, read-only, foreign session or
 * nothing to change) and the STORED scope must be used instead.
 *
 * The publish-state validation shares the resolution's ONE wall clock
 * (review #7): a collection with a huge document listing fails the check at
 * the deadline — the entry degrades, it never stalls the send.
 */
async function commitSendDraftScope(
  deps: HandlerDeps<ISessionManager>,
  capture: SendScopeCapture,
  sessionId: string,
  draft: string[],
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
  const scopeIds = draft.filter(id =>
    isCollectionPublished(capture.workspaceRoot, capture.binding, id, { deadline })
  )
  const previousScope = [...(session.kbCollectionIds ?? [])]
  if (JSON.stringify(previousScope) === JSON.stringify(scopeIds)) return scopeIds
  // The LAST synchronous gate before the write is initiated: after the send
  // deadline this attempt is abandoned (review N1 — a timeout may not leave
  // background work behind that mutates state), and a scope that moved during
  // any awaited step above fails closed here (review #3).
  //
  // The DEADLINE is re-checked absolutely (review N1 residual): the publish
  // filter above runs SYNCHRONOUSLY, so the abandonment flag cannot flip
  // inside it — a scan that consumed the whole budget would otherwise reach
  // this gate with `abandoned` still false and commit the truncated scope
  // after the deadline. Time is monotonic, so an exhausted budget can never
  // pass this check: budget gone → no write, no audit, the stored scope wins.
  if (
    attempt.abandoned
    || Date.now() >= deadline
    || !isTrustedSessionScopeTokenCurrent(capture.token)
  ) return null
  await writeSessionScopeAudited(deps, {
    workspaceRoot: capture.workspaceRoot,
    binding: capture.binding,
    actor: capture.token.accountId,
    workspaceId: capture.token.workspaceId,
    sessionId,
    from: previousScope,
    to: scopeIds,
    detail: { source: 'send_draft_commit' },
  })
  return scopeIds
}

/**
 * Phase 2 of the send resolution — strictly READ-ONLY against the captured
 * space binding. It never touches session or audit state, so finishing after
 * the send deadline is harmless: the caller has already moved on with the
 * fallback, and the late hits are simply discarded (review N1).
 */
function retrieveReferences(
  capture: SendScopeCapture,
  message: string,
  scopeIds: string[],
  deadline: number,
): KbSearchHit[] {
  if (scopeIds.length === 0) return []
  // The send text is tokenized raw, so it is truncated to the same ceiling
  // the SEARCH RPC schema enforces (review #7).
  const query = message.slice(0, KB_SEARCH_QUERY_MAX_CHARS)
  const byCollection = new Map<string, KbSearchHit[]>()
  for (const collectionId of scopeIds) {
    if (Date.now() >= deadline) break
    const hits = searchDocuments(
      capture.workspaceRoot,
      capture.binding,
      query,
      [collectionId],
      { deadline, maxScannedBytes: KB_SEND_MAX_SCAN_BYTES },
    ).slice(0, KB_SEARCH_PER_COLLECTION_LIMIT)
    byCollection.set(collectionId, hits)
  }
  // Interleave so no single collection dominates the reference list.
  const merged: KbSearchHit[] = []
  for (let index = 0; ; index += 1) {
    let added = false
    for (const hits of byCollection.values()) {
      const hit = hits[index]
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
 * checks, store scan, scoring and snippet building all honour the same
 * deadline, and a timed-out attempt is abandoned — it may return nothing,
 * but never mutate session scope or audit afterwards. Any KB failure
 * degrades to "no references" — a KB outage must never block a send.
 */
export async function resolveSessionKbReferences(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  message: string,
  draftCollectionIds?: string[],
  callerWorkspaceId?: string | null,
  entryScopeToken?: TrustedSessionScopeToken | null,
): Promise<KbSearchHit[] | undefined> {
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
    // Phase 1 — the only state-changing step. It runs whenever the composer
    // PROVIDED a draft, including an explicit empty one: clearing the
    // selection must commit the clear, or the send would fall back to the
    // stored scope the user just emptied (review #12 regression). The commit
    // promise never rejects (a failed write is audited and logged, the send
    // degrades), so a post-timeout settlement cannot become an unhandled
    // rejection.
    let scopeIds = storedScope
    if (draft !== undefined) {
      const committed = await raceSendDeadline(
        commitSendDraftScope(deps, capture, sessionId, draft, attempt, deadline),
        deadline,
        () => {
          attempt.abandoned = true
          return null
        },
      )
      if (committed !== null) scopeIds = committed
    }
    // Phase 2 — read-only retrieval.
    const references = retrieveReferences(capture, message, scopeIds, deadline)
    return references.length > 0 ? references : undefined
  } catch (error) {
    deps.platform.logger?.warn(`KB_SEND_REFERENCES: reference resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
