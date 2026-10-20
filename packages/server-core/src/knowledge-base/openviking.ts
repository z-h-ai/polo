import { KB_SEARCH_LIMIT } from '@polo-ai/shared/protocol'
import type { KbDocumentSummary, KbSearchHit } from '@polo-ai/shared/protocol'
import {
  openVikingAddResource,
  openVikingDelete,
  openVikingFind,
  openVikingTempUpload,
  type OpenVikingConfig,
} from './openviking-client'
import {
  appendAudit,
  buildKbSnippetForQuery,
  clearDocumentOpenVikingState,
  getDocument,
  kbSpaceSegment,
  lookupPublishedDocument,
  readDocumentOpenVikingState,
  readDocumentSummary,
  readOpenVikingSpaceMeta,
  recordDocumentOpenVikingState,
  tokenizeKbQuery,
  writeOpenVikingSpaceMeta,
  type KbDocumentOpenVikingState,
  type KbSpaceBinding,
} from './store'

/**
 * OpenViking integration for the enterprise knowledge base (POO-108 v2).
 *
 * Division of labor: the LOCAL store (`.polo-kb/`) stays the authoritative
 * record of lifecycle, permissions and audit; OpenViking is the retrieval
 * backend a published copy is synced into. Every function here degrades —
 * callers wrap them so an OpenViking outage can never fail the local
 * management operation it accompanies. The remote space is keyed by the SAME
 * hash as the local store directory (`kbSpaceSegment(productSpaceId)`), so
 * the local and remote roots stay one-to-one.
 */

/** The remote root a ProductSpace publishes under, e.g. `viking://resources/entspace-<hash>`. */
export function openVikingSpaceRootUri(productSpaceId: string): string {
  return `viking://resources/entspace-${kbSpaceSegment(productSpaceId)}`
}

/** The trusted enterprise facts every remote call is bound to. */
export interface OpenVikingTarget {
  config: OpenVikingConfig
  workspaceRoot: string
  binding: KbSpaceBinding
  space: { id: string; enterpriseId: string; name: string }
  actor: string
}

function assertTargetConsistent(target: OpenVikingTarget): void {
  if (target.binding.productSpaceId !== target.space.id) {
    throw new Error('OpenViking target binding does not match the space id')
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `.space.md` manifest: the human-readable inventory OpenViking holds for
 * the space root itself (name / ids / creation time, per the brief).
 */
function spaceManifest(target: OpenVikingTarget, provisionedAt: string): string {
  return [
    `# ${target.space.name}`,
    '',
    'Polo AI 企业知识库空间清单（OpenViking Context 检索后端）。',
    '',
    `- polo_space: ${target.space.id}`,
    `- enterprise: ${target.space.enterpriseId}`,
    `- created_at: ${provisionedAt}`,
    '',
    '内容以各集合下已发布文档为准；本文件仅描述空间本身。',
    '',
  ].join('\n')
}

/**
 * Ensures the remote space root exists, creating it on first use through a
 * `.space.md` manifest upload with `create_parent: true` — that flag is what
 * creates the whole `entspace-<hash>/` tree. Idempotent via the local
 * `openviking.json` marker; a previously failed provisioning is retried on
 * the next call. Throws on failure — the CALLER decides the degradation
 * (collection creation must survive it, a publish sync records it on the
 * document).
 */
export async function ensureOpenVikingSpace(target: OpenVikingTarget): Promise<string> {
  assertTargetConsistent(target)
  const existing = readOpenVikingSpaceMeta(target.workspaceRoot, target.binding)
  if (existing) return existing.rootUri

  const rootUri = openVikingSpaceRootUri(target.space.id)
  const provisionedAt = nowIso()
  const temp = await openVikingTempUpload(target.config, {
    filename: '.space.md',
    content: spaceManifest(target, provisionedAt),
  })
  await openVikingAddResource(target.config, {
    tempFileId: temp.tempFileId,
    to: `${rootUri}/.space.md`,
    createParent: true,
    wait: true,
    processingMode: 'vectors_only',
    tags: [`polo_space=${target.space.id}`, 'kind=polo_space_manifest'],
    reason: `Polo AI: provision enterprise knowledge space ${target.space.id}`,
  })
  writeOpenVikingSpaceMeta(target.workspaceRoot, target.binding, {
    rootUri,
    productSpaceId: target.space.id,
    enterpriseId: target.space.enterpriseId,
    provisionedAt,
  })
  appendAudit(target.workspaceRoot, target.binding, {
    actor: target.actor,
    action: 'openviking.space_provisioned',
    target: rootUri,
    detail: { productSpaceId: target.space.id, enterpriseId: target.space.enterpriseId, provisionedAt },
  })
  return rootUri
}

/**
 * Publishes ONE document's content into the space (`temp_upload` +
 * `add_resource` under `collections/<collectionId>/<docId>.md`), records the
 * outcome on the document meta and audits it. NEVER throws and NEVER touches
 * the local publish state — a failed sync degrades to a `failed` marker plus
 * an `openviking.sync_failed` audit entry. Returns the refreshed summary.
 */
export async function syncPublishedDocumentToOpenViking(
  target: OpenVikingTarget,
  docId: string,
): Promise<KbDocumentSummary> {
  assertTargetConsistent(target)
  const before = readDocumentSummary(target.workspaceRoot, target.binding, docId)
  try {
    if (before.status !== 'published') return before
    const rootUri = await ensureOpenVikingSpace(target)
    // The full local content — the same bytes the publish snapshot preserved.
    const document = getDocument(target.workspaceRoot, target.binding, docId)
    if (!document) throw new Error(`Document ${docId} disappeared before its OpenViking sync`)
    const uri = `${rootUri}/collections/${document.collectionId}/${document.id}.md`
    const temp = await openVikingTempUpload(target.config, {
      filename: `${document.id}.md`,
      content: document.content,
    })
    await openVikingAddResource(target.config, {
      tempFileId: temp.tempFileId,
      to: uri,
      createParent: true,
      wait: true,
      processingMode: 'vectors_only',
      tags: [
        `polo_space=${target.space.id}`,
        `collection=${document.collectionId}`,
        `doc=${document.id}`,
      ],
      reason: `Polo AI: publish knowledge base document ${document.id}`,
    })
    const state: KbDocumentOpenVikingState = { uri, syncedAt: nowIso() }
    const synced = recordDocumentOpenVikingState(target.workspaceRoot, target.binding, docId, state)
    appendAudit(target.workspaceRoot, target.binding, {
      actor: target.actor,
      action: 'openviking.synced',
      target: docId,
      detail: { uri, collectionId: document.collectionId },
    })
    return synced
  } catch (error) {
    const message = errorText(error)
    // The caller sees the failure exactly as the store recorded it — a
    // publish that synced nowhere must still come back with the failed
    // marker, never with a summary that pretends the sync never ran.
    let summary = before
    try {
      summary = recordDocumentOpenVikingState(target.workspaceRoot, target.binding, docId, {
        error: message,
        failedAt: nowIso(),
      })
    } catch (recordError) {
      console.warn(`[KbOpenViking] failed to record the sync failure for ${docId}: ${errorText(recordError)}`)
    }
    appendAudit(target.workspaceRoot, target.binding, {
      actor: target.actor,
      action: 'openviking.sync_failed',
      target: docId,
      detail: { error: message, collectionId: before.collectionId },
    })
    return summary
  }
}

/**
 * Best-effort removal of a document's remote copy (`DELETE /api/v1/fs`,
 * `recursive: false`). Used when a published document is reverted to draft or
 * recycled — a stale remote copy would otherwise keep surfacing in
 * OpenViking-backed search for content the local KB no longer publishes.
 * The caller may pass the URI explicitly (the delete path captures it BEFORE
 * the local delete moves the document into `recycle/`); otherwise it is read
 * from the document meta. Never throws: the outcome (success or failure) is
 * audited instead. Returns `true` when a remote copy was actually removed.
 */
export async function removeDocumentFromOpenViking(
  target: OpenVikingTarget,
  docId: string,
  uri?: string,
): Promise<boolean> {
  assertTargetConsistent(target)
  const resolvedUri = uri ?? readSyncedUri(target, docId)
  if (!resolvedUri) return false
  try {
    await openVikingDelete(target.config, { uri: resolvedUri, recursive: false })
    appendAudit(target.workspaceRoot, target.binding, {
      actor: target.actor,
      action: 'openviking.removed',
      target: docId,
      detail: { uri: resolvedUri },
    })
    return true
  } catch (error) {
    appendAudit(target.workspaceRoot, target.binding, {
      actor: target.actor,
      action: 'openviking.remove_failed',
      target: docId,
      detail: { uri: resolvedUri, error: errorText(error) },
    })
    return false
  }
}

/** The remote URI recorded on a document, when it was successfully synced. */
function readSyncedUri(target: OpenVikingTarget, docId: string): string | undefined {
  const state = readDocumentOpenVikingState(target.workspaceRoot, target.binding, docId)
  return state && 'uri' in state ? state.uri : undefined
}

/**
 * Optional bounds for a search pass (POO-108 review #7 discipline). The find
 * itself is bounded by the client's own search timeout and by whatever the
 * caller races it against; the deadline here additionally bounds the
 * SYNCHRONOUS mapping of hits back onto local documents.
 */
export interface KbOpenVikingSearchOptions {
  /**
   * Wall-clock deadline (Date.now() based): a mapping that runs out of budget
   * keeps the hits already built and drops the rest — partial results stay
   * valid, and the send path never maps past the budget that bounds it.
   */
  deadline?: number
}

/**
 * OpenViking-backed search over the space: `find` scoped to the space root,
 * hits mapped back onto LOCAL published documents through the `doc=` tag.
 * Documents the local store cannot resolve (unpublished, recycled, filtered
 * out, deleted out-of-band) are dropped, so a stale remote copy never leaks.
 * Scores stay the OpenViking ones (they are not confined to [0,1]) and hits
 * carry `source: 'openviking'`; snippets are built from the local content.
 *
 * Throws when OpenViking itself fails — the caller owns the local-fallback
 * decision. A space that was never provisioned has nothing indexed, so it
 * also throws and lets the caller fall back.
 */
export async function searchDocumentsViaOpenViking(
  target: OpenVikingTarget,
  query: string,
  collectionIds?: string[],
  options?: KbOpenVikingSearchOptions,
): Promise<KbSearchHit[]> {
  assertTargetConsistent(target)
  const meta = readOpenVikingSpaceMeta(target.workspaceRoot, target.binding)
  if (!meta) {
    throw new Error('The enterprise space has no OpenViking root yet — nothing was ever synced')
  }
  if (tokenizeKbQuery(query).length === 0) return []
  const resources = await openVikingFind(target.config, {
    query,
    targetUri: meta.rootUri,
    limit: KB_SEARCH_LIMIT,
  })
  const deadline = options?.deadline
  const bestByDoc = new Map<string, KbSearchHit>()
  for (const resource of resources) {
    if (deadline !== undefined && Date.now() >= deadline) break
    const docId = resource.tags.doc
    if (!docId) continue
    const spaceTag = resource.tags.polo_space
    if (spaceTag !== undefined && spaceTag !== target.space.id) continue
    const local = lookupPublishedDocument(
      target.workspaceRoot,
      target.binding,
      docId,
      collectionIds,
    )
    if (!local) continue
    const previous = bestByDoc.get(docId)
    if (previous && previous.score >= resource.score) continue
    bestByDoc.set(docId, {
      docId: local.docId,
      collectionId: local.collectionId,
      collectionName: local.collectionName,
      title: local.title,
      snippet: buildKbSnippetForQuery(local.content, query, deadline),
      score: resource.score,
      source: 'openviking',
    })
  }
  return [...bestByDoc.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, KB_SEARCH_LIMIT)
}
