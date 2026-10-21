import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type {
  KbCollection,
  KbDocument,
  KbDocumentStatus,
  KbDocumentSummary,
  KbSearchHit,
} from '@polo-ai/shared/protocol'
import {
  KB_DOCUMENT_TRANSITIONS,
  KB_MAX_CONTENT_BYTES,
  KB_SEARCH_LIMIT,
  KB_SNIPPET_CONTEXT_CHARS,
} from '@polo-ai/shared/protocol'
import {
  isOpenVikingAlreadyExists,
  openVikingAttrs,
  openVikingFind,
  openVikingGlob,
  openVikingLs,
  openVikingMkdir,
  openVikingMv,
  openVikingReadContent,
  openVikingSetTags,
  openVikingWriteContent,
  type OpenVikingConfig,
  type OpenVikingFindResource,
  type OpenVikingNode,
  type OpenVikingTenantAuth,
} from './openviking-client'
import { isTrustedSessionScopeTokenCurrent, type TrustedSessionScopeToken } from '../handlers/rpc/trusted-product-space-account'
import { KB_SERVICE_UNAVAILABLE_MESSAGE, KbStoreError } from './errors'

/**
 * Enterprise Knowledge Base store (POO-108 v3.1) — the OpenViking backend.
 *
 * The remote tenant IS the authoritative storage (brief R1): one OpenViking
 * account per enterprise ProductSpace, created by `tenant.ts`. Polo keeps no
 * local content or metadata copy — collections are top-level directories in
 * the account's resource root, documents are `.md` files under them, and the
 * ENTIRE lifecycle state (status, titles, timestamps) travels in retrieval
 * tags. Everything this module does is an API call; the only local artifact
 * is the audit trail (`.polo-kb/audit/`, a device-local operation log — the
 * enterprise-authoritative audit is follow-up card #3, brief D8).
 *
 * URI scheme (brief D3/D4): deterministic URIs make every write retry-safe —
 *
 *   collection   viking://resources/<pathSegment(name)>-<collectionId>
 *   document     <collectionUri>/<pathSegment(title)>-<docId>.md
 *   recycle      viking://resources/.recycle/<original file name>
 *   transition   viking://resources/.audit/transitions/<uuid>.md
 *
 * The FULL id suffix keeps URIs collision-free even for identical names; the
 * readable prefix survives in the Studio tree. Lossless names/titles travel
 * in url-encoded tags (`name=`, `title=`) because pathSegment folds
 * characters for URI safety.
 *
 * CAS discipline (brief §3 item 5): every REMOTE WRITE revalidates the
 * await-spanning scope token right before it is issued, so a fence revoked
 * while earlier awaits were pending can never authorize a write it never
 * saw. Cross-device concurrent transitions are bounded by design (brief D4):
 * re-read immediately before the write, verify after — conflicts that land
 * inside that window surface as `kb_conflict`, and everything wider is an
 * accepted, audited last-writer-wins boundary (no conditional-write primitive
 * exists on the storage service; the admin-side serializer is follow-up #6).
 */

/** The trusted enterprise ProductSpace a KB store belongs to. */
export interface KbSpaceBinding {
  productSpaceId: string
  enterpriseId: string
}

/**
 * Everything a store call needs: the remote binding (config + tenant key),
 * the space facts audit entries are written against, and the await-spanning
 * scope token every remote write revalidates. `auth`/`config` are supplied by
 * the handler layer — reads receive the CACHED tenant credential only, so a
 * space that was never provisioned has no store at all (no background
 * provisioning on read/send paths, brief D2).
 */
export interface KbOpenVikingSpace {
  config: OpenVikingConfig
  auth: OpenVikingTenantAuth
  binding: KbSpaceBinding
  /** The workspace root the LOCAL audit trail is written under. */
  workspaceRoot: string
  spaceName: string
  actor: string
  /** Captured at the RPC entry; revalidated before every remote write. */
  scopeToken?: TrustedSessionScopeToken
}

export {
  KbStoreError,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
} from './errors'

/**
 * ProductSpace ids are opaque, so the audit file is a deterministic hash —
 * collision-free, traversal-safe and stable across processes. The remote
 * account id carries the readable slug instead (`tenant.ts`).
 */
export function kbSpaceSegment(productSpaceId: string): string {
  // Collision-free sha256 — the audit file for one space must never be
  // created for a different one, even for adversarially similar ids. A
  // device-local layout detail ONLY: the remote tenant's hash suffix is
  // derived independently in `tenant.ts` and the two must never be
  // cross-interpreted.
  return createHash('sha256').update(productSpaceId).digest('hex').slice(0, 32)
}

const KB_DIR = '.polo-kb'
const KB_AUDIT_DIR = 'audit'
const KB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/** The account-relative root every collection lives under. */
export const KB_SPACE_ROOT_URI = 'viking://resources/'
/** Soft-delete target: a hidden dot directory, out of every listing (§1.7). */
const KB_RECYCLE_DIR_URI = `${KB_SPACE_ROOT_URI}.recycle`
/** Best-effort transition log: hidden, one UUID file per transition (D4). */
const KB_TRANSITIONS_DIR_URI = `${KB_SPACE_ROOT_URI}.audit/transitions`

function assertKbId(kind: string, id: string): string {
  if (!KB_ID_PATTERN.test(id)) {
    throw new KbStoreError('kb_not_found', `${kind} is invalid`)
  }
  return id
}

function createKbId(): string {
  return `kb-${randomUUID()}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// URI construction
// ---------------------------------------------------------------------------

/**
 * Single-segment safety for readable URI parts: the service rejects `.`, `..`,
 * `:` and `+` inside a segment, so human names fold down to a stable subset.
 * Uniqueness NEVER relies on this text — the full id is appended by the
 * caller — so folding is free to be lossy (brief D3).
 */
export function kbPathSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f/\\:*?#%<>|"+:^]/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return cleaned || 'untitled'
}

export function kbCollectionUri(collectionName: string, collectionId: string): string {
  return `${KB_SPACE_ROOT_URI}${kbPathSegment(collectionName)}-${collectionId}`
}

export function kbDocumentUri(collectionUri: string, title: string, docId: string): string {
  return `${collectionUri}/${kbPathSegment(title)}-${docId}.md`
}

/** True for URIs inside the hidden recycle/transition subtrees. */
function isHiddenKbUri(uri: string): boolean {
  return uri.startsWith(`${KB_RECYCLE_DIR_URI}/`) || uri.startsWith(`${KB_TRANSITIONS_DIR_URI}/`)
}

/** The `.recycle/` file name a document moves under (keeps its unique suffix). */
function recycleTargetUri(documentUri: string): string {
  const fileName = documentUri.slice(documentUri.lastIndexOf('/') + 1)
  return `${KB_RECYCLE_DIR_URI}/${fileName}`
}

// ---------------------------------------------------------------------------
// Tag encoding — the summary fields' ONLY source of truth (brief D4)
// ---------------------------------------------------------------------------

function tagValue(value: string): string {
  return encodeURIComponent(value)
}

function readTagValue(value: string | undefined): string | null {
  if (value === undefined) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Builds one `k=v` tag, url-encoding the value (lossless round-trip). */
function tag(key: string, value: string): string {
  return `${key}=${tagValue(value)}`
}

const KB_DOCUMENT_STATUSES: ReadonlySet<string> = new Set(['draft', 'in_review', 'published', 'rejected'])

/**
 * The full tag set of ONE document, parsed STRICTLY (brief D5): repeated keys
 * or a missing required field reject the node outright — a corrupted or
 * out-of-band node must never be disclosed as a document.
 */
interface KbDocumentTags {
  docId: string
  collectionId: string
  status: KbDocumentStatus
  title: string
  version: number
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  rejectReason: string | null
}

interface RawTags {
  tags: Record<string, string>
  duplicateKeys: string[]
}

function rawTagsOf(node: OpenVikingNode | OpenVikingFindResource): RawTags {
  return {
    tags: node.tags,
    duplicateKeys: node.duplicateTagKeys ?? [],
  }
}

function parseDocumentTags(raw: RawTags): KbDocumentTags | null {
  if (raw.duplicateKeys.length > 0) return null
  const { tags } = raw
  const docId = tags.doc
  const collectionId = tags.collection
  const status = tags.status
  const title = readTagValue(tags.title)
  const createdAt = readTagValue(tags.created)
  const updatedAt = readTagValue(tags.updated)
  if (!docId || !collectionId || !status || !title || !createdAt || !updatedAt) return null
  if (!KB_DOCUMENT_STATUSES.has(status)) return null
  const version = tags.v !== undefined ? Number(tags.v) : 1
  return {
    docId,
    collectionId,
    status: status as KbDocumentStatus,
    title,
    version: Number.isInteger(version) && version >= 1 ? version : 1,
    createdAt,
    updatedAt,
    publishedAt: readTagValue(tags.published),
    rejectReason: readTagValue(tags.reject),
  }
}

function parseDocumentStatus(raw: RawTags): KbDocumentStatus | null {
  if (raw.duplicateKeys.length > 0) return null
  const status = raw.tags.status
  if (!status || !KB_DOCUMENT_STATUSES.has(status)) return null
  return status as KbDocumentStatus
}

/** The tag set uploaded/published with a document — the FULL set, every time. */
function documentTags(record: {
  docId: string
  collectionId: string
  title: string
  status: KbDocumentStatus
  version: number
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  rejectReason: string | null
}): string[] {
  return [
    tag('doc', record.docId),
    tag('collection', record.collectionId),
    tag('status', record.status),
    tag('title', record.title),
    `v=${record.version}`,
    tag('created', record.createdAt),
    tag('updated', record.updatedAt),
    ...(record.publishedAt ? [tag('published', record.publishedAt)] : []),
    ...(record.rejectReason !== null ? [tag('reject', record.rejectReason)] : []),
  ]
}

/** Collection directory tags: id, lossless name, optional lossless description. */
function collectionTags(input: { collectionId: string; name: string; description: string; createdAt: string }): string[] {
  return [
    tag('collection', input.collectionId),
    tag('name', input.name),
    // Descriptions beyond the verified tag budget (2048 CJK chars, §1.4)
    // truncate rather than fail the creation.
    ...(input.description ? [tag('description', input.description.slice(0, 2_048))] : []),
    tag('created', input.createdAt),
  ]
}

// ---------------------------------------------------------------------------
// Audit trail (local, device-operation log — brief D8)
// ---------------------------------------------------------------------------

export interface KbAuditEntry {
  at: string
  actor: string
  action: string
  target: string
  detail: Record<string, unknown>
}

function auditPath(workspaceRoot: string, binding: KbSpaceBinding): string {
  return join(resolve(workspaceRoot), KB_DIR, KB_AUDIT_DIR, `${kbSpaceSegment(binding.productSpaceId)}.jsonl`)
}

/** Appends ONE audit entry; failures are logged, never fatal to the caller. */
export function appendAudit(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  entry: { actor: string; action: string; target: string; detail?: Record<string, unknown> },
): void {
  const record: KbAuditEntry = {
    at: nowIso(),
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: entry.detail ?? {},
  }
  try {
    const path = auditPath(workspaceRoot, binding)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'a' })
  } catch (error) {
    console.warn(`[KbStore] audit append failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readAudit(workspaceRoot: string, binding: KbSpaceBinding): KbAuditEntry[] {
  const path = auditPath(workspaceRoot, binding)
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as KbAuditEntry)
  } catch {
    return []
  }
}

/** The audit callback tenant provisioning writes through. */
export function kbAuditFor(space: Pick<KbOpenVikingSpace, 'workspaceRoot' | 'binding' | 'actor'>) {
  return (action: string, target: string, detail?: Record<string, unknown>): void => {
    appendAudit(space.workspaceRoot, space.binding, { actor: space.actor, action, target, detail })
  }
}

// ---------------------------------------------------------------------------
// Remote primitives — every WRITE revalidates the scope token first (§3.5)
// ---------------------------------------------------------------------------

function assertScopeTokenCurrent(space: KbOpenVikingSpace): void {
  if (space.scopeToken && !isTrustedSessionScopeTokenCurrent(space.scopeToken)) {
    throw new KbStoreError(
      'PRODUCT_SPACE_CONTEXT_REQUIRED',
      'The trusted scope changed during the operation',
    )
  }
}

/**
 * Wraps a remote call: vendor failures become the neutral availability error
 * with the RAW cause in `detail` (server-side logs only, brief D7).
 */
function toKbError(operation: string, error: unknown): KbStoreError {
  if (error instanceof KbStoreError) return error
  return new KbStoreError(
    'kb_service_unavailable',
    KB_SERVICE_UNAVAILABLE_MESSAGE,
    `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
  )
}

async function remoteMkdir(space: KbOpenVikingSpace, uri: string, description?: string): Promise<void> {
  assertScopeTokenCurrent(space)
  try {
    await openVikingMkdir(space.config, space.auth, { uri, description })
  } catch (error) {
    // Idempotent on retry: an existing directory is as good as a new one —
    // the tags write below completes the state either way.
    if (isOpenVikingAlreadyExists(error)) return
    throw toKbError(`mkdir ${uri}`, error)
  }
}

async function remoteWriteContent(
  space: KbOpenVikingSpace,
  uri: string,
  content: string,
  tags?: string[],
): Promise<void> {
  assertScopeTokenCurrent(space)
  try {
    await openVikingWriteContent(space.config, space.auth, { uri, content, tags })
  } catch (error) {
    throw toKbError(`write ${uri}`, error)
  }
}

async function remoteSetTags(space: KbOpenVikingSpace, uri: string, tags: string[]): Promise<void> {
  assertScopeTokenCurrent(space)
  try {
    await openVikingSetTags(space.config, space.auth, { uri, tags, mode: 'replace' })
  } catch (error) {
    throw toKbError(`set_tags ${uri}`, error)
  }
}

async function remoteMv(space: KbOpenVikingSpace, fromUri: string, toUri: string): Promise<void> {
  assertScopeTokenCurrent(space)
  try {
    await openVikingMv(space.config, space.auth, { fromUri, toUri })
  } catch (error) {
    throw toKbError(`mv ${fromUri}`, error)
  }
}

/** Reads ONE node's attrs; a missing node reads as `null`. */
async function remoteAttrs(space: KbOpenVikingSpace, uri: string): Promise<OpenVikingNode | null> {
  try {
    return await openVikingAttrs(space.config, space.auth, uri)
  } catch (error) {
    throw toKbError(`attrs ${uri}`, error)
  }
}

/** Reads ONE document body; `null` when the body is absent. */
async function remoteReadContent(space: KbOpenVikingSpace, uri: string): Promise<string | null> {
  try {
    return await openVikingReadContent(space.config, space.auth, uri)
  } catch (error) {
    throw toKbError(`read ${uri}`, error)
  }
}

// ---------------------------------------------------------------------------
// Tree walk — the ONE listing the collection views are built from (brief D3)
// ---------------------------------------------------------------------------

/** Wall-clock budget shared by the walk and everything built from it. */
export interface KbStoreBudget {
  /** Wall-clock deadline (Date.now() based); an exhausted budget fails closed. */
  deadline?: number
}

const KB_LS_PAGE_NODES = 2_000
/** Ten full pages ≈ 20k nodes: past this the tenant is abnormal, not large. */
const KB_LS_MAX_PAGES = 10

/**
 * One recursive, tag-annotated walk over the whole tenant (brief D3). The
 * server hides dotfile CONTENT but lists dot DIRECTORIES (§1.7), so the
 * recycle/transition subtrees are filtered here by prefix. Pages honor the
 * shared deadline; partial results stay valid — callers fail closed.
 */
async function walkKbTree(space: KbOpenVikingSpace, budget?: KbStoreBudget): Promise<OpenVikingNode[]> {
  const nodes: OpenVikingNode[] = []
  let offset = 0
  for (let page = 0; page < KB_LS_MAX_PAGES; page += 1) {
    if (budget?.deadline !== undefined && Date.now() >= budget.deadline) break
    let result
    try {
      result = await openVikingLs(space.config, space.auth, {
        uri: KB_SPACE_ROOT_URI,
        recursive: true,
        nodeLimit: KB_LS_PAGE_NODES,
        offset,
      })
    } catch (error) {
      throw toKbError('ls', error)
    }
    for (const entry of result.entries) {
      if (!isHiddenKbUri(entry.uri)) nodes.push(entry)
    }
    if (!result.hasMore) return nodes
    offset += result.entries.length
  }
  console.warn(
    `[KbStore] the knowledge base listing exceeded ${KB_LS_MAX_PAGES * KB_LS_PAGE_NODES} nodes — counting the first pages only`,
  )
  return nodes
}

interface KbCollectionIndexEntry {
  uri: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  documentCounts: KbCollection['documentCounts']
}

interface KbDocumentIndexEntry {
  uri: string
  parsed: KbDocumentTags
}

/** The tenant index one walk produces: collections with counts, documents by id. */
export interface KbIndex {
  collections: Map<string, KbCollectionIndexEntry>
  documents: Map<string, KbDocumentIndexEntry>
}

function emptyCounts(): KbCollection['documentCounts'] {
  return { draft: 0, in_review: 0, published: 0, rejected: 0 }
}

function buildKbIndex(nodes: OpenVikingNode[]): KbIndex {
  const collections = new Map<string, KbCollectionIndexEntry>()
  const documents = new Map<string, KbDocumentIndexEntry>()
  for (const node of nodes) {
    const raw = rawTagsOf(node)
    const collectionId = raw.tags.collection
    if (!collectionId || raw.duplicateKeys.includes('collection')) continue
    const entry = collections.get(collectionId) ?? {
      uri: '',
      name: collectionId,
      description: '',
      createdAt: '',
      updatedAt: '',
      documentCounts: emptyCounts(),
    }
    collections.set(collectionId, entry)
    if (raw.tags.doc === undefined) {
      // The collection directory itself: name/description/timestamps live here.
      const name = readTagValue(raw.tags.name)
      if (name) entry.name = name
      const description = readTagValue(raw.tags.description)
      if (description) entry.description = description
      const createdAt = readTagValue(raw.tags.created)
      if (createdAt) entry.createdAt = createdAt
      if (node.mtime) entry.updatedAt = node.mtime
      if (!entry.uri && node.uri.startsWith(KB_SPACE_ROOT_URI)) entry.uri = node.uri
      continue
    }
    // A document: strict parsing — unknown shapes never reach the views.
    // Soft-deleted copies (status=deleted, brief D4) fail the strict parse
    // (an unknown status), so they drop out of counts AND listings here.
    const parsed = parseDocumentTags(raw)
    if (!parsed) continue
    entry.documentCounts[parsed.status] = (entry.documentCounts[parsed.status] ?? 0) + 1
    const existing = documents.get(parsed.docId)
    if (!existing) documents.set(parsed.docId, { uri: node.uri, parsed })
  }
  return { collections, documents }
}

function toCollection(entry: KbCollectionIndexEntry, collectionId: string, canManage: boolean): KbCollection {
  return {
    id: collectionId,
    name: entry.name,
    description: entry.description,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    documentCounts: entry.documentCounts,
    canManage,
  }
}

export async function listCollections(
  space: KbOpenVikingSpace,
  canManage: boolean,
): Promise<KbCollection[]> {
  const index = await loadKbIndex(space)
  return [...index.collections.entries()]
    .map(([collectionId, entry]) => toCollection(entry, collectionId, canManage))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

/**
 * ONE walk, ONE index — the shared input for every listing/published check
 * (the send path's for-await loop reuses a single load instead of walking per
 * collection).
 */
export async function loadKbIndex(space: KbOpenVikingSpace, budget?: KbStoreBudget): Promise<KbIndex> {
  return buildKbIndex(await walkKbTree(space, budget))
}

export async function listDocuments(
  space: KbOpenVikingSpace,
  collectionId: string,
): Promise<KbDocumentSummary[]> {
  assertKbId('collectionId', collectionId)
  const index = await loadKbIndex(space)
  if (!index.collections.has(collectionId)) {
    throw new KbStoreError('kb_collection_not_found')
  }
  const rows: KbDocumentSummary[] = []
  for (const entry of index.documents.values()) {
    if (entry.parsed.collectionId !== collectionId) continue
    rows.push(toSummary(entry))
  }
  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

function toSummary(entry: KbDocumentIndexEntry): KbDocumentSummary {
  const parsed = entry.parsed
  return {
    id: parsed.docId,
    collectionId: parsed.collectionId,
    title: parsed.title,
    status: parsed.status,
    version: parsed.version,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    publishedAt: parsed.publishedAt,
    rejectReason: parsed.rejectReason,
  }
}

/**
 * A collection is selectable for a session scope only when it holds at least
 * one published document (D6). The walk honors the shared budget: an
 * exhausted budget reads as "not proven published" — degraded availability,
 * never an unbounded stall.
 */
export async function isCollectionPublished(
  space: KbOpenVikingSpace,
  collectionId: string,
  budget?: KbStoreBudget,
): Promise<boolean> {
  if (budget?.deadline !== undefined && Date.now() >= budget.deadline) return false
  const index = await loadKbIndex(space, budget)
  return indexCollectionPublished(index, collectionId)
}

/** The synchronous check against an ALREADY-loaded index (send path, N collections). */
export function indexCollectionPublished(index: KbIndex, collectionId: string): boolean {
  return (index.collections.get(collectionId)?.documentCounts.published ?? 0) > 0
}

export async function createCollection(
  space: KbOpenVikingSpace,
  input: { name: string; description: string },
): Promise<KbCollection> {
  const record = {
    collectionId: createKbId(),
    name: input.name.trim(),
    description: input.description,
    createdAt: nowIso(),
  }
  const uri = kbCollectionUri(record.name, record.collectionId)
  await remoteMkdir(space, uri, record.description)
  await remoteSetTags(space, uri, collectionTags(record))
  appendAudit(space.workspaceRoot, space.binding, {
    actor: space.actor,
    action: 'collection.create',
    target: record.collectionId,
    detail: { name: record.name },
  })
  return {
    id: record.collectionId,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    documentCounts: emptyCounts(),
    canManage: true,
  }
}

export async function uploadDocument(
  space: KbOpenVikingSpace,
  collectionId: string,
  input: { title: string; content: string },
): Promise<KbDocumentSummary> {
  assertKbId('collectionId', collectionId)
  if (Buffer.byteLength(input.content, 'utf-8') > KB_MAX_CONTENT_BYTES) {
    throw new KbStoreError('kb_content_too_large')
  }
  // The collection's URI comes from the listing — a collection id that does
  // not resolve in THIS tenant is a not-found, never a write into nowhere.
  const index = await loadKbIndex(space)
  const collection = index.collections.get(collectionId)
  if (!collection?.uri) {
    throw new KbStoreError('kb_collection_not_found')
  }
  const timestamp = nowIso()
  const record = {
    docId: createKbId(),
    collectionId,
    title: input.title.trim(),
    status: 'draft' as const,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: null,
    rejectReason: null,
  }
  // The deterministic URI makes the write replace-idempotent: a timed-out
  // upload retried under the same id rewrites the same node (brief D4).
  const uri = kbDocumentUri(collection.uri, record.title, record.docId)
  await remoteWriteContent(space, uri, input.content, documentTags(record))
  appendAudit(space.workspaceRoot, space.binding, {
    actor: space.actor,
    action: 'document.upload',
    target: record.docId,
    detail: { collectionId, title: record.title, bytes: Buffer.byteLength(input.content, 'utf-8') },
  })
  return {
    id: record.docId,
    collectionId,
    title: record.title,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
    rejectReason: record.rejectReason,
  }
}

/** Resolves ONE document's live URI by its unique id suffix (brief D4). */
async function locateDocument(space: KbOpenVikingSpace, docId: string): Promise<string> {
  assertKbId('docId', docId)
  let matches: string[]
  try {
    matches = await openVikingGlob(space.config, space.auth, {
      pattern: `**/*-${docId}.md`,
      uri: KB_SPACE_ROOT_URI,
    })
  } catch (error) {
    throw toKbError(`glob ${docId}`, error)
  }
  // Recycled/transition copies never resolve: the live document is the one
  // outside the hidden subtrees.
  const live = matches.filter(uri => !isHiddenKbUri(uri))
  if (live.length === 0) {
    throw new KbStoreError('kb_document_not_found')
  }
  return live.sort()[0]
}

export async function getDocument(space: KbOpenVikingSpace, docId: string): Promise<KbDocument | null> {
  const uri = await locateDocument(space, docId)
  // Two O(1) reads (brief D4): the body and the tags.
  const [content, node] = await Promise.all([
    remoteReadContent(space, uri),
    remoteAttrs(space, uri),
  ])
  if (!node) {
    // Glob saw it, attrs does not: a concurrently recycled document.
    throw new KbStoreError('kb_document_not_found')
  }
  const parsed = parseDocumentTags(rawTagsOf(node))
  if (!parsed || parsed.docId !== docId) {
    throw new KbStoreError('kb_document_not_found')
  }
  return {
    ...toSummary({ uri, parsed }),
    content: content ?? '',
  }
}

export type KbTransitionAction = 'submit' | 'publish' | 'reject' | 'revert'

const TRANSITION_TARGET: Record<KbTransitionAction, KbDocumentStatus> = {
  submit: 'in_review',
  publish: 'published',
  reject: 'rejected',
  revert: 'draft',
}

/**
 * The deletion contract covers `draft` / `published` / `rejected` only — a
 * document under review must be rejected (or reverted) first, so the review
 * trail stays meaningful (v2 review #14, unchanged).
 */
const KB_DELETABLE_STATUSES: ReadonlySet<KbDocumentStatus> = new Set(['draft', 'published', 'rejected'])

/**
 * Per-document in-process mutex (brief D4): transitions read-modify-write the
 * tag set, so two concurrent transitions on ONE document serialize here.
 * Cross-device races stay bounded by the re-read/verify window below.
 */
const documentLocks = new Map<string, Promise<unknown>>()

function withDocumentLock<T>(docId: string, operation: () => Promise<T>): Promise<T> {
  const previous = documentLocks.get(docId) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(() => undefined, () => undefined)
  documentLocks.set(docId, tail)
  void tail.then(() => {
    if (documentLocks.get(docId) === tail) documentLocks.delete(docId)
  })
  return result
}

/**
 * The best-effort shared transition log (brief D4 ii): ONE uuid file per
 * transition in the hidden `.audit/transitions/` tree. Independent files —
 * never an append to a shared one, which would lose concurrent entries —
 * and never fatal: this is a diagnostic trail, not a gate.
 */
async function writeTransitionLog(
  space: KbOpenVikingSpace,
  entry: {
    docId: string
    uri: string
    from: KbDocumentStatus
    to: KbDocumentStatus
    actor: string
    at: string
  },
): Promise<void> {
  try {
    const uri = `${KB_TRANSITIONS_DIR_URI}/${randomUUID()}.md`
    await openVikingWriteContent(space.config, space.auth, {
      uri,
      content: JSON.stringify(entry),
      tags: [`doc=${entry.docId}`, `kind=transition`],
    })
  } catch (error) {
    console.warn(
      `[KbStore] transition log for ${entry.docId} failed (best-effort): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function transitionDocument(
  space: KbOpenVikingSpace,
  docId: string,
  action: KbTransitionAction,
  opts: { reason?: string } = {},
): Promise<KbDocumentSummary> {
  return withDocumentLock(docId, async () => {
    const uri = await locateDocument(space, docId)
    const target = TRANSITION_TARGET[action]

    // Gate 1: the current state must allow the transition at all.
    const node = await remoteAttrs(space, uri)
    if (!node) throw new KbStoreError('kb_document_not_found')
    const current = parseDocumentTags(rawTagsOf(node))
    if (!current || current.docId !== docId) throw new KbStoreError('kb_document_not_found')
    if (!KB_DOCUMENT_TRANSITIONS[current.status]?.includes(target)) {
      throw new KbStoreError(
        'kb_invalid_transition',
        `Cannot move a ${current.status} document to ${target}`,
      )
    }

    // Gate 2 — the tight re-read (brief D4): state checked again IMMEDIATELY
    // before the write, shrinking the local-race window to one round trip.
    // A concurrent transition detected here is a conflict, not a surprise.
    const fresh = await remoteAttrs(space, uri)
    if (!fresh) throw new KbStoreError('kb_document_not_found')
    const freshParsed = parseDocumentTags(rawTagsOf(fresh))
    if (!freshParsed || freshParsed.docId !== docId) throw new KbStoreError('kb_document_not_found')
    if (freshParsed.status !== current.status) {
      throw new KbStoreError(
        'kb_conflict',
        'The document was changed concurrently',
        { from: current.status, actual: freshParsed.status },
      )
    }

    const updatedAt = nowIso()
    const next: KbDocumentTags = {
      ...current,
      status: target,
      updatedAt,
      ...(target === 'published' ? { publishedAt: updatedAt, rejectReason: null } : {}),
      ...(target === 'rejected' ? { rejectReason: opts.reason ?? '' } : {}),
      ...(target === 'draft' ? { publishedAt: null, rejectReason: null } : {}),
    }
    await remoteSetTags(space, uri, documentTags(next))

    // Read-back verification: the state machine only commits when the remote
    // tags say what we just wrote. A mismatch is a hard conflict (the write
    // itself was unconditional — some other writer has overlapped, brief D4).
    const after = await remoteAttrs(space, uri)
    const afterParsed = after ? parseDocumentTags(rawTagsOf(after)) : null
    if (!afterParsed || afterParsed.status !== target) {
      throw new KbStoreError(
        'kb_conflict',
        'The document changed while the transition was applied',
        { expected: target, actual: afterParsed?.status ?? null },
      )
    }
    void writeTransitionLog(space, {
      docId,
      uri,
      from: current.status,
      to: target,
      actor: space.actor,
      at: updatedAt,
    })
    appendAudit(space.workspaceRoot, space.binding, {
      actor: space.actor,
      action: `document.${action}`,
      target: docId,
      detail: {
        from: current.status,
        status: target,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    })
    return toSummary({ uri, parsed: next })
  })
}

export async function deleteDocument(
  space: KbOpenVikingSpace,
  docId: string,
): Promise<{ recycled: true }> {
  return withDocumentLock(docId, async () => {
    const uri = await locateDocument(space, docId)
    const node = await remoteAttrs(space, uri)
    if (!node) throw new KbStoreError('kb_document_not_found')
    const current = parseDocumentTags(rawTagsOf(node))
    if (!current || current.docId !== docId) throw new KbStoreError('kb_document_not_found')
    if (!KB_DELETABLE_STATUSES.has(current.status)) {
      throw new KbStoreError(
        'kb_delete_not_allowed',
        `A ${current.status} document cannot be deleted; reject it first`,
      )
    }
    // Soft delete (brief D4): status leaves the retrieval face FIRST (the
    // recycle target is a hidden dot path, so the move then removes it from
    // every listing too). No permanent deletion exists — same as v2.
    const recycledAt = nowIso()
    await remoteSetTags(space, uri, documentTags({
      ...current,
      status: 'deleted',
      updatedAt: recycledAt,
    }))
    await remoteMkdir(space, KB_RECYCLE_DIR_URI)
    await remoteMv(space, uri, recycleTargetUri(uri))
    appendAudit(space.workspaceRoot, space.binding, {
      actor: space.actor,
      action: 'document.delete',
      target: docId,
      detail: { collectionId: current.collectionId, recycledAt, previousStatus: current.status },
    })
    return { recycled: true as const }
  })
}

// ---------------------------------------------------------------------------
// Retrieval (brief D5) — ONE find, server-scoped, snippets inline
// ---------------------------------------------------------------------------

/**
 * Naive tokenization for the query guard: whitespace-separated runs stay
 * whole, CJK runs split into single characters. A query with no tokens
 * (whitespace only) is answered with no results, never with a remote call.
 */
export function tokenizeKbQuery(query: string): string[] {
  const tokens = new Set<string>()
  for (const chunk of query.toLowerCase().split(/\s+/)) {
    if (!chunk) continue
    const segments = chunk.match(/[㐀-鿿぀-ヿ가-힯]|[^㐀-鿿぀-ヿ가-힯]+/g) ?? []
    for (const segment of segments) {
      if (segment) tokens.add(segment)
    }
  }
  return [...tokens]
}

const KB_TITLE_WEIGHT = 3
const KB_BODY_WEIGHT = 1
const KB_BODY_TOKEN_HIT_CAP = 5

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1 && count < KB_BODY_TOKEN_HIT_CAP) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Builds the hit snippet from the ALREADY lowered content (the scoring pass
 * computed it; re-lowering a max-size document would double the cost). The
 * optional deadline is the search's own: a token sweep that runs out of
 * budget stops early and falls back to the nearest hit found so far, or to
 * the head of the content — a snippet is never worth running past the budget
 * that bounds the send it feeds.
 */
function buildSnippet(content: string, lowered: string, tokens: string[], deadline?: number): string {
  let hitIndex = -1
  let hitLength = 0
  for (const token of tokens) {
    if (deadline !== undefined && Date.now() >= deadline) break
    const index = lowered.indexOf(token)
    if (index !== -1 && (hitIndex === -1 || index < hitIndex)) {
      hitIndex = index
      hitLength = token.length
    }
  }
  if (hitIndex === -1) {
    return content.slice(0, KB_SNIPPET_CONTEXT_CHARS * 2).trim()
  }
  const start = Math.max(0, hitIndex - KB_SNIPPET_CONTEXT_CHARS)
  const end = Math.min(content.length, hitIndex + hitLength + KB_SNIPPET_CONTEXT_CHARS)
  const body = content.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${body}${end < content.length ? '…' : ''}`
}

/** Snippet built from the content ONE find inlined (brief D5). */
export function buildKbSnippetForQuery(content: string, query: string, deadline?: number): string {
  return buildSnippet(content, content.toLowerCase(), tokenizeKbQuery(query), deadline)
}

/** Resolves the requested collection ids to their LIVE remote URIs. */
function resolveCollectionUris(index: KbIndex, collectionIds: string[] | undefined): string[] {
  if (!collectionIds || collectionIds.length === 0) return [KB_SPACE_ROOT_URI]
  const uris: string[] = []
  for (const collectionId of collectionIds) {
    const entry = index.collections.get(collectionId)
    if (entry?.uri) uris.push(entry.uri)
  }
  return uris
}

/**
 * Retrieval over published documents only (brief D5): ONE `find` with the
 * server-side collection scoping (`target_uri` array), the server-side
 * status filter (`status=published`) and inlined hit content — snippets come
 * from the SAME response, never one extra read per hit. Hits are disclosed
 * only after their tags parse STRICTLY and re-confirm collection membership
 * and the published status; anything else (stale index, out-of-band node,
 * corrupted tags) drops silently.
 *
 * Scores stay the backend's (not confined to [0,1]); results sort by score
 * (desc) then title, capped at the KB search limit. An exhausted budget
 * keeps the hits already mapped — partial results stay valid.
 */
export async function searchDocuments(
  space: KbOpenVikingSpace,
  query: string,
  collectionIds?: string[],
  budget?: KbStoreBudget,
): Promise<KbSearchHit[]> {
  const tokens = tokenizeKbQuery(query)
  if (tokens.length === 0) return []
  if (budget?.deadline !== undefined && Date.now() >= budget.deadline) return []
  // ONE index load serves BOTH the collection-URI resolution and the hit
  // mapping — never a second walk of the same tenant.
  const index = await loadKbIndex(space, budget)
  const targetUris = resolveCollectionUris(index, collectionIds)
  if (targetUris.length === 0) return []
  const wanted = collectionIds ? new Set(collectionIds) : null
  let resources: OpenVikingFindResource[]
  try {
    resources = await openVikingFind(space.config, space.auth, {
      query,
      targetUri: targetUris,
      tags: ['status=published'],
      limit: KB_SEARCH_LIMIT,
      readContent: true,
    })
  } catch (error) {
    throw toKbError('find', error)
  }
  const collectionNames = new Map<string, string>()
  for (const [collectionId, entry] of index.collections) {
    collectionNames.set(collectionId, entry.name)
  }
  const bestByDoc = new Map<string, KbSearchHit>()
  for (const resource of resources) {
    if (budget?.deadline !== undefined && Date.now() >= budget.deadline) break
    // Strict disclosure gate (brief D5): duplicated keys, missing fields or
    // an unknown status reject the hit outright.
    const parsed = parseDocumentTags(rawTagsOf(resource))
    if (!parsed) continue
    if (parsed.status !== 'published') continue
    if (wanted && !wanted.has(parsed.collectionId)) continue
    const collectionName = collectionNames.get(parsed.collectionId) ?? parsed.collectionId
    const previous = bestByDoc.get(parsed.docId)
    if (previous && previous.score >= resource.score) continue
    const content = resource.content ?? ''
    bestByDoc.set(parsed.docId, {
      docId: parsed.docId,
      collectionId: parsed.collectionId,
      collectionName,
      title: parsed.title,
      snippet: buildKbSnippetForQuery(content, query, budget?.deadline),
      score: resource.score,
    })
  }
  return [...bestByDoc.values()]
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, KB_SEARCH_LIMIT)
}
