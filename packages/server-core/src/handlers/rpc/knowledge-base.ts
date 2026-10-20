import { RPC_CHANNELS, type KbDocument, type KbDocumentSummary, type KbSearchHit } from '@polo-ai/shared/protocol'
import {
  KbCreateCollectionInputSchema,
  KbDocumentRefSchema,
  KbGetSessionCollectionsInputSchema,
  KbListDocumentsInputSchema,
  KbRejectDocumentInputSchema,
  KbSearchInputSchema,
  KbSessionCollectionsInputSchema,
  KbUploadDocumentInputSchema,
  KbWorkspaceRefSchema,
  KB_SEARCH_PER_COLLECTION_LIMIT,
} from '@polo-ai/shared/protocol'
import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { RequestContext } from '@polo-ai/server-core/transport'
import { getBoundWorkspace, currentWorkspaceId } from './skills'
import { resolveTrustedProductSpaceAccountId } from './trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
} from '../../runtime/product-space-executions'
import {
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
} from '../../knowledge-base/store'

/**
 * Enterprise Knowledge Base RPC handlers (POO-108).
 *
 * Every entry derives its scope from the trusted Admin session + committed
 * ProductSpace fence (same discipline as the Skills surface) and refuses any
 * non-enterprise space with an explicit `kb_unavailable_in_personal` error —
 * a personal-space caller must never see an empty list that looks like
 * "no collections yet". Mutations additionally require the enterprise
 * owner/manager role and append to the workspace's KB audit trail.
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

function kbError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? code), { code })
}

interface KbScope {
  workspace: { id: string; rootPath: string; name: string; remoteServer?: unknown }
  space: TrustedProductSpaceSummary & { kind: 'enterprise'; role: 'owner' | 'manager' | 'member' }
  canManage: boolean
}

/**
 * Fails closed unless the committed ProductSpace fence belongs to the
 * trusted account, resolves to a known ENTERPRISE space, and the requested
 * workspace is exactly the caller's bound workspace.
 */
async function requireKbScope(
  ctx: RequestContext,
  workspaceId: string,
  deps: HandlerDeps,
): Promise<KbScope> {
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!trustedAccountId) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted Admin session is available')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw kbError(KB_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No committed ProductSpace is active for this account')
  }
  const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
  if (!space) {
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
  }
}

function assertCanManage(scope: KbScope): void {
  if (!scope.canManage) {
    throw kbError('kb_manage_required', 'Only enterprise owners and managers may modify the knowledge base')
  }
}

function assertKbWritable(): void {
  if (isRuntimeOfflineReadOnly()) {
    throw kbError('OFFLINE_READ_ONLY', 'The offline read-only view cannot modify the knowledge base')
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
function getDocumentOrNull(workspaceRoot: string, docId: string): KbDocument | null {
  try {
    return getDocument(workspaceRoot, docId)
  } catch (error) {
    if (error instanceof KbStoreError && error.code === 'kb_document_not_found') return null
    throw error
  }
}

export function registerKnowledgeBaseHandlers(
  server: RpcServer,
  deps: HandlerDeps<ISessionManager>,
): void {
  server.handle(RPC_CHANNELS.kb.LIST_COLLECTIONS, async (ctx, workspaceId: unknown) => {
    const input = parseOrThrow(KbWorkspaceRefSchema, { workspaceId })
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    return listCollections(scope.workspace.rootPath, scope.canManage)
  })

  server.handle(RPC_CHANNELS.kb.CREATE_COLLECTION, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbCreateCollectionInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    const collection = createCollection(
      scope.workspace.rootPath,
      { name: input.name, description: input.description },
      accountId,
    )
    deps.platform.logger?.info(`KB_CREATE_COLLECTION: ${collection.id} in ${scope.workspace.id}`)
    return collection
  })

  server.handle(RPC_CHANNELS.kb.LIST_DOCUMENTS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbListDocumentsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    const rows: KbDocumentSummary[] = listDocuments(scope.workspace.rootPath, input.collectionId)
    // Members see published rows only; managers run the review flow and see all.
    return scope.canManage ? rows : rows.filter(row => row.status === 'published')
  })

  server.handle(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbUploadDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return uploadDocument(
      scope.workspace.rootPath,
      input.collectionId,
      { title: input.title, content: input.content },
      accountId,
    )
  })

  server.handle(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return transitionDocument(scope.workspace.rootPath, input.docId, 'submit', { actor: accountId })
  })

  server.handle(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return transitionDocument(scope.workspace.rootPath, input.docId, 'publish', { actor: accountId })
  })

  server.handle(RPC_CHANNELS.kb.REJECT_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbRejectDocumentInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return transitionDocument(scope.workspace.rootPath, input.docId, 'reject', {
      actor: accountId,
      reason: input.reason,
    })
  })

  server.handle(RPC_CHANNELS.kb.REVERT_TO_DRAFT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return transitionDocument(scope.workspace.rootPath, input.docId, 'revert', { actor: accountId })
  })

  server.handle(RPC_CHANNELS.kb.DELETE_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertCanManage(scope)
    assertKbWritable()
    const accountId = (await resolveTrustedProductSpaceAccountId()) ?? ''
    return deleteDocument(scope.workspace.rootPath, input.docId, accountId)
  })

  server.handle(RPC_CHANNELS.kb.GET_DOCUMENT, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbDocumentRefSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    const doc: KbDocument | null = getDocumentOrNull(scope.workspace.rootPath, input.docId)
    if (!doc) return null
    // Members may only open published documents; managers preview anything.
    if (!scope.canManage && doc.status !== 'published') return null
    return doc
  })

  server.handle(RPC_CHANNELS.kb.SEARCH, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbSearchInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    const hits: KbSearchHit[] = searchDocuments(
      scope.workspace.rootPath,
      input.query,
      input.collectionIds,
    )
    // Defense in depth: the store only indexes published rows, the scope
    // filter here keeps a forged collectionIds list from changing that.
    return hits
  })

  server.handle(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbSessionCollectionsInputSchema, rawInput)
    const scope = await requireKbScope(ctx, input.workspaceId, deps)
    assertKbWritable()
    // Every selected collection must belong to this enterprise space and
    // hold at least one published document.
    for (const collectionId of input.collectionIds) {
      if (!isCollectionPublished(scope.workspace.rootPath, collectionId)) {
        throw kbError('kb_collection_not_published', `Collection ${collectionId} is not available for sessions`)
      }
    }
    const unique = [...new Set(input.collectionIds)]
    await deps.sessionManager.setSessionKbCollections(input.sessionId, unique)
    return { ok: true as const, collectionIds: unique }
  })

  server.handle(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, async (ctx, rawInput: unknown) => {
    const input = parseOrThrow(KbGetSessionCollectionsInputSchema, rawInput)
    await requireKbScope(ctx, input.workspaceId, deps)
    const session = await deps.sessionManager.getSession(input.sessionId)
    return { collectionIds: session?.kbCollectionIds ?? [] }
  })
}

/**
 * Send-time reference resolution used by the SEND_MESSAGE handler: commits a
 * first-send draft scope, then resolves each selected collection's top hits.
 * Any KB failure degrades to "no references" — a KB outage must never block
 * sending a message.
 */
export async function resolveSessionKbReferences(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  message: string,
  draftCollectionIds?: string[],
): Promise<KbSearchHit[] | undefined> {
  try {
    const session = await deps.sessionManager.getSession(sessionId)
    if (!session) return undefined
    const workspace = deps.sessionManager.getWorkspaces().find((item: { id: string }) => item.id === session.workspaceId)
    if (!workspace) return undefined
    // A personal (or unresolvable) space has no KB scope by construction —
    // requireKbScope is the authority and its refusal means no references.
    const trustedAccountId = await resolveTrustedProductSpaceAccountId()
    if (!trustedAccountId) return undefined
    const activeProductSpaceId = getRuntimeActiveProductSpace()
    if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) return undefined
    const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
    if (!space || space.kind !== 'enterprise') return undefined

    let scopeIds = session.kbCollectionIds ?? []
    if (draftCollectionIds) {
      // First send of a new session: commit the composer draft. Invalid
      // entries are dropped, never fatal.
      scopeIds = draftCollectionIds.filter(id => isCollectionPublished(workspace.rootPath, id))
      if (session.kbCollectionIds?.join(' ') !== scopeIds.join(' ')) {
        await deps.sessionManager.setSessionKbCollections(sessionId, scopeIds)
      }
    }
    if (scopeIds.length === 0) return undefined

    const byCollection = new Map<string, KbSearchHit[]>()
    for (const collectionId of scopeIds) {
      const hits = searchDocuments(workspace.rootPath, message, [collectionId])
        .slice(0, KB_SEARCH_PER_COLLECTION_LIMIT)
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
  } catch (error) {
    deps.platform.logger?.warn(`KB_SEND_REFERENCES: reference resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
