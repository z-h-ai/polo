import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { join, resolve, sep } from 'path'
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

/**
 * Enterprise Knowledge Base local store (POO-108).
 *
 * Content lives under the workspace, scoped to the TRUSTED enterprise
 * ProductSpace that owns it: `<workspaceRoot>/.polo-kb/spaces/<spaceHash>/`
 * with `space.json` (the immutable ProductSpace↔enterprise binding),
 * `collections/{collectionId}/meta.json`,
 * `collections/{collectionId}/documents/{docId}/meta.json + content.md`,
 * `versions/{docId}/v{n}.md` publish snapshots, `recycle/` and `audit.jsonl`.
 * Every mutating call appends an audit entry; the RPC handler layer owns the
 * permission checks, this layer owns the filesystem truth and the state
 * machine. A store bound to one enterprise ProductSpace is never readable or
 * writable through another space's binding — switching the same workspace
 * between enterprises keeps each space's KB isolated (review #1).
 */

/** The trusted enterprise ProductSpace a KB store belongs to. */
export interface KbSpaceBinding {
  productSpaceId: string
  enterpriseId: string
}

/**
 * ProductSpace ids are opaque (any non-blank string up to 512 chars), so the
 * directory segment is a deterministic hash — collision-free, traversal-safe
 * and stable across processes. The raw ids stay readable in `space.json`.
 */
export function kbSpaceSegment(productSpaceId: string): string {
  return createHash('sha256').update(productSpaceId).digest('hex').slice(0, 32)
}

export function kbRootPath(workspaceRoot: string, binding: KbSpaceBinding): string {
  return join(resolve(workspaceRoot), KB_DIR, 'spaces', kbSpaceSegment(binding.productSpaceId))
}

interface KbSpaceMarker {
  productSpaceId: string
  enterpriseId: string
  boundAt: string
}

function markerMatches(marker: KbSpaceMarker, binding: KbSpaceBinding): boolean {
  return marker.productSpaceId === binding.productSpaceId && marker.enterpriseId === binding.enterpriseId
}

function readSpaceMarker(root: string, binding: KbSpaceBinding): void {
  const marker = readJson<KbSpaceMarker>(join(root, 'space.json'))
  if (!markerMatches(marker, binding)) {
    throw new KbStoreError(
      'kb_space_mismatch',
      'The knowledge base store is bound to a different enterprise ProductSpace',
    )
  }
}

/**
 * Read-side root: `null` when this space has no store yet (reads as an empty
 * KB), explicit refusal when the store exists but was bound by a different
 * enterprise claim on the same ProductSpace.
 */
function readSpaceRoot(workspaceRoot: string, binding: KbSpaceBinding): string | null {
  const root = kbRootPath(workspaceRoot, binding)
  if (!existsSync(join(root, 'space.json'))) return null
  readSpaceMarker(root, binding)
  return root
}

/** Write-side root: binds the store on first write, refuses a foreign binding. */
function writeSpaceRoot(workspaceRoot: string, binding: KbSpaceBinding): string {
  const root = kbRootPath(workspaceRoot, binding)
  if (existsSync(join(root, 'space.json'))) {
    readSpaceMarker(root, binding)
    return root
  }
  ensureDir(root)
  const marker: KbSpaceMarker = {
    productSpaceId: binding.productSpaceId,
    enterpriseId: binding.enterpriseId,
    boundAt: nowIso(),
  }
  writeJson(join(root, 'space.json'), marker)
  return root
}

export interface KbCollectionRecord {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

/**
 * Outcome of the OpenViking publish sync recorded on ONE document (POO-108
 * v2): either the remote URI it was published under, or why the sync failed.
 * The local publish itself is never rolled back by the failure branch.
 */
export type KbDocumentOpenVikingState =
  | { uri: string; syncedAt: string }
  | { error: string; failedAt: string }

export interface KbDocumentRecord {
  id: string
  collectionId: string
  title: string
  status: KbDocumentStatus
  version: number
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  rejectReason: string | null
  openViking?: KbDocumentOpenVikingState
}

/**
 * Space-level OpenViking provisioning marker (POO-108 v2): the remote root the
 * whole ProductSpace publishes under. Written once by the first provisioning
 * call and reused (idempotently) by every later sync.
 */
export interface KbOpenVikingSpaceMeta {
  rootUri: string
  productSpaceId: string
  enterpriseId: string
  provisionedAt: string
}

export interface KbAuditEntry {
  at: string
  actor: string
  action: string
  target: string
  detail: Record<string, unknown>
}

/** Thrown for KB business failures; `code` is the stable RPC error contract. */
export class KbStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'KbStoreError'
  }
}

const KB_DIR = '.polo-kb'
const KB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

function assertKbId(kind: string, id: string): string {
  if (!KB_ID_PATTERN.test(id)) {
    throw new KbStoreError('kb_not_found', `${kind} is invalid`)
  }
  return id
}

function insideRoot(root: string, path: string): string {
  const canonical = resolve(path)
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
    throw new KbStoreError('kb_not_found', 'Resolved path escaped the knowledge base root')
  }
  return canonical
}

function createKbId(): string {
  return `kb-${randomUUID()}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function readCollectionRecord(root: string, collectionId: string): KbCollectionRecord {
  const path = insideRoot(root, join(root, 'collections', collectionId, 'meta.json'))
  if (!existsSync(path)) {
    throw new KbStoreError('kb_collection_not_found')
  }
  return readJson<KbCollectionRecord>(path)
}

/** Locates a document's directory across the space's collections; throws `kb_document_not_found`. */
function findDocumentDir(root: string, docId: string): string {
  const collectionsDir = join(root, 'collections')
  const entries = existsSync(collectionsDir) ? readdirSync(collectionsDir, { withFileTypes: true }) : []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const docDir = insideRoot(root, join(collectionsDir, entry.name, 'documents', docId))
    if (existsSync(join(docDir, 'meta.json'))) {
      return docDir
    }
  }
  throw new KbStoreError('kb_document_not_found')
}

function readDocumentRecord(root: string, docId: string): KbDocumentRecord {
  return readJson<KbDocumentRecord>(join(findDocumentDir(root, assertKbId('docId', docId)), 'meta.json'))
}

function writeDocumentRecord(root: string, record: KbDocumentRecord, content?: string): void {
  const docDir = insideRoot(
    root,
    join(root, 'collections', record.collectionId, 'documents', record.id),
  )
  ensureDir(docDir)
  writeJson(join(docDir, 'meta.json'), record)
  if (content !== undefined) {
    writeFileSync(join(docDir, 'content.md'), content, 'utf-8')
  }
}

function toSummary(record: KbDocumentRecord): KbDocumentSummary {
  return {
    id: record.id,
    collectionId: record.collectionId,
    title: record.title,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
    rejectReason: record.rejectReason,
    // Omitted entirely when OpenViking is not in play — the wire shape of a
    // non-synced store stays byte-identical to the pre-v2 one.
    ...(record.openViking ? { openViking: record.openViking } : {}),
  }
}

function readContent(root: string, record: KbDocumentRecord): string {
  const path = insideRoot(
    root,
    join(root, 'collections', record.collectionId, 'documents', record.id, 'content.md'),
  )
  if (!existsSync(path)) return ''
  // Bounded at the SYSCALL, not after the fact (review #7): uploads are
  // capped at KB_MAX_CONTENT_BYTES, so an oversize file can only be an
  // out-of-band write — only the capped head (+1 byte that merely decides
  // the file is oversize and is then dropped) is ever pulled off the disk.
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(KB_CONTENT_READ_MAX_BYTES + 1)
    const read = readSync(handle, buffer, 0, buffer.length, 0)
    if (read > KB_CONTENT_READ_MAX_BYTES) {
      console.warn(
        `[KbStore] document ${record.id} content exceeds ${KB_CONTENT_READ_MAX_BYTES} bytes — reading a truncated head (out-of-band write?)`,
      )
      return buffer.toString('utf-8', 0, KB_CONTENT_READ_MAX_BYTES)
    }
    return buffer.toString('utf-8', 0, read)
  } finally {
    closeSync(handle)
  }
}

/** Publish snapshot: `versions/{docId}/v{n}.md` preserves the exact content. */
function writeVersionSnapshot(root: string, record: KbDocumentRecord, content: string): void {
  const versionsDir = insideRoot(root, join(root, 'versions', record.id))
  ensureDir(versionsDir)
  writeFileSync(join(versionsDir, `v${record.version}.md`), content, 'utf-8')
}

export function appendAudit(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  entry: { actor: string; action: string; target: string; detail?: Record<string, unknown> },
): void {
  const root = writeSpaceRoot(workspaceRoot, binding)
  const record: KbAuditEntry = {
    at: nowIso(),
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: entry.detail ?? {},
  }
  writeFileSync(join(root, 'audit.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' })
}

export function readAudit(workspaceRoot: string, binding: KbSpaceBinding): KbAuditEntry[] {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return []
  const path = join(root, 'audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as KbAuditEntry)
}

/**
 * OpenViking provisioning marker for the space (`openviking.json`), POO-108
 * v2. `null` means the space was never provisioned. The store only owns the
 * marker's persistence — the remote calls around it live in
 * `openviking.ts`. A marker naming a different binding is refused like any
 * other cross-binding read (fail closed).
 */
export function readOpenVikingSpaceMeta(
  workspaceRoot: string,
  binding: KbSpaceBinding,
): KbOpenVikingSpaceMeta | null {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return null
  const path = join(root, 'openviking.json')
  if (!existsSync(path)) return null
  const meta = readJson<KbOpenVikingSpaceMeta>(path)
  if (meta.productSpaceId !== binding.productSpaceId || meta.enterpriseId !== binding.enterpriseId) {
    throw new KbStoreError(
      'kb_space_mismatch',
      'The OpenViking space marker is bound to a different enterprise ProductSpace',
    )
  }
  return meta
}

export function writeOpenVikingSpaceMeta(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  meta: KbOpenVikingSpaceMeta,
): void {
  const root = writeSpaceRoot(workspaceRoot, binding)
  writeJson(join(root, 'openviking.json'), meta)
}

/** The OpenViking sync state recorded on ONE document, if any. */
export function readDocumentOpenVikingState(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
): KbDocumentOpenVikingState | null {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return null
  return readDocumentRecord(root, docId).openViking ?? null
}

/** Records a sync outcome on the document meta and returns the refreshed summary. */
export function recordDocumentOpenVikingState(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
  state: KbDocumentOpenVikingState,
): KbDocumentSummary {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_document_not_found')
  const docDir = findDocumentDir(root, assertKbId('docId', docId))
  const record = readJson<KbDocumentRecord>(join(docDir, 'meta.json'))
  record.openViking = state
  writeJson(join(docDir, 'meta.json'), record)
  return toSummary(record)
}

/** Drops the sync state (after a successful remote removal on revert). */
export function clearDocumentOpenVikingState(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
): void {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return
  const docDir = findDocumentDir(root, assertKbId('docId', docId))
  const record = readJson<KbDocumentRecord>(join(docDir, 'meta.json'))
  if (!record.openViking) return
  delete record.openViking
  writeJson(join(docDir, 'meta.json'), record)
}

/** Re-reads ONE document's summary (used to report the post-sync state). */
export function readDocumentSummary(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
): KbDocumentSummary {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_document_not_found')
  return toSummary(readDocumentRecord(root, assertKbId('docId', docId)))
}

/** The local document facts an OpenViking search hit is mapped back onto. */
export interface KbLookupDocument {
  docId: string
  collectionId: string
  collectionName: string
  title: string
  content: string
}

/**
 * Resolves a remote hit's `doc=` tag to the LOCAL published document it
 * belongs to, enforcing the same visibility rules the local search does:
 * published only, and inside the requested collection filter. Unpublished,
 * foreign-collection or missing documents read as `null` — a stale remote
 * copy never leaks into results (POO-108 v2).
 */
export function lookupPublishedDocument(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
  collectionIds?: string[],
): KbLookupDocument | null {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return null
  let record: KbDocumentRecord
  try {
    record = readDocumentRecord(root, docId)
  } catch (error) {
    if (error instanceof KbStoreError && error.code === 'kb_document_not_found') return null
    throw error
  }
  if (record.status !== 'published') return null
  if (collectionIds && !collectionIds.includes(record.collectionId)) return null
  let collectionName = record.collectionId
  try {
    collectionName = readCollectionRecord(root, record.collectionId).name
  } catch {
    // A collection deleted out-of-band still leaves the document readable.
  }
  return {
    docId: record.id,
    collectionId: record.collectionId,
    collectionName,
    title: record.title,
    content: readContent(root, record),
  }
}

/**
 * Wall-clock budget for the synchronous metadata walks that guard a scope
 * write (POO-108 review #7): a collection holding tens of thousands of
 * documents must not stall the caller — the walk gives up at the deadline and
 * the caller fails closed ("not proven published").
 */
export interface KbPublishedCheckBudget {
  /** Wall-clock deadline (Date.now() based); an exhausted budget fails closed. */
  deadline?: number
}

/**
 * Defensive ceilings for the two walks the deadline budget cannot interrupt
 * (POO-108 review #7 — KNOWN ITEM, deferred): the metadata walk and the
 * full-text read below run as a single synchronous stretch, so neither the
 * send deadline nor the publish-check budget can cancel them mid-flight, and
 * a runaway or out-of-band-written store directory would otherwise be
 * scanned unbounded. These are NOT product limits — uploads are already
 * capped by `KB_MAX_CONTENT_BYTES`; hitting a ceiling means the store on
 * disk is abnormal. The caller sees the degradation in the log and the
 * truncated result, never a stall. The real fix — offloading the walks to a
 * cancellable worker the deadline can terminate — is tracked as follow-up
 * work (see `.pipeline/sdlc/POO-108/dev-delivery-v1.md`, 已知项与收尾).
 */
/** Max document directory entries enumerated for ONE collection. */
const KB_DOCUMENT_DIR_MAX_ENTRIES = 10_000
/** Max bytes ever read back from ONE document's `content.md`. */
const KB_CONTENT_READ_MAX_BYTES = KB_MAX_CONTENT_BYTES

function documentCounts(
  root: string,
  collectionId: string,
  budget?: KbPublishedCheckBudget,
): KbCollection['documentCounts'] {
  const counts = { draft: 0, in_review: 0, published: 0, rejected: 0 }
  const dir = insideRoot(root, join(root, 'collections', collectionId, 'documents'))
  if (!existsSync(dir)) return counts
  // Enumeration is bounded (review #7): a collection directory past the
  // ceiling is counted only up to it and logged, never walked unbounded.
  const entries = readdirSync(dir, { withFileTypes: true })
  if (entries.length > KB_DOCUMENT_DIR_MAX_ENTRIES) {
    console.warn(
      `[KbStore] collection ${collectionId} holds ${entries.length} document entries — counting only the first ${KB_DOCUMENT_DIR_MAX_ENTRIES}`,
    )
  }
  for (const entry of entries.slice(0, KB_DOCUMENT_DIR_MAX_ENTRIES)) {
    if (budget?.deadline !== undefined && Date.now() >= budget.deadline) break
    if (!entry.isDirectory()) continue
    const metaPath = insideRoot(root, join(dir, entry.name, 'meta.json'))
    if (!existsSync(metaPath)) continue
    const record = readJson<KbDocumentRecord>(metaPath)
    if (record.status in counts) counts[record.status] += 1
  }
  return counts
}

function toCollection(
  root: string,
  record: KbCollectionRecord,
  canManage: boolean,
): KbCollection {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    documentCounts: documentCounts(root, record.id),
    canManage,
  }
}

export function listCollections(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  canManage: boolean,
): KbCollection[] {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return []
  const dir = join(root, 'collections')
  if (!existsSync(dir)) return []
  const rows: KbCollection[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metaPath = insideRoot(root, join(dir, entry.name, 'meta.json'))
    if (!existsSync(metaPath)) continue
    rows.push(toCollection(root, readJson<KbCollectionRecord>(metaPath), canManage))
  }
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

export function createCollection(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  input: { name: string; description: string },
  actor: string,
): KbCollection {
  const root = writeSpaceRoot(workspaceRoot, binding)
  const record: KbCollectionRecord = {
    id: createKbId(),
    name: input.name.trim(),
    description: input.description,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  const dir = insideRoot(root, join(root, 'collections', record.id))
  ensureDir(dir)
  writeJson(join(dir, 'meta.json'), record)
  appendAudit(workspaceRoot, binding, {
    actor,
    action: 'collection.create',
    target: record.id,
    detail: { name: record.name },
  })
  return toCollection(root, record, true)
}

export function listDocuments(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  collectionId: string,
): KbDocumentSummary[] {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_collection_not_found')
  readCollectionRecord(root, assertKbId('collectionId', collectionId))
  const dir = insideRoot(root, join(root, 'collections', collectionId, 'documents'))
  if (!existsSync(dir)) return []
  const rows: KbDocumentSummary[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metaPath = insideRoot(root, join(dir, entry.name, 'meta.json'))
    if (!existsSync(metaPath)) continue
    rows.push(toSummary(readJson<KbDocumentRecord>(metaPath)))
  }
  return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

export function uploadDocument(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  collectionId: string,
  input: { title: string; content: string },
  actor: string,
): KbDocumentSummary {
  const root = writeSpaceRoot(workspaceRoot, binding)
  readCollectionRecord(root, assertKbId('collectionId', collectionId))
  if (Buffer.byteLength(input.content, 'utf-8') > KB_MAX_CONTENT_BYTES) {
    throw new KbStoreError('kb_content_too_large')
  }
  const timestamp = nowIso()
  const record: KbDocumentRecord = {
    id: createKbId(),
    collectionId,
    title: input.title.trim(),
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: null,
    rejectReason: null,
  }
  writeDocumentRecord(root, record, input.content)
  appendAudit(workspaceRoot, binding, {
    actor,
    action: 'document.upload',
    target: record.id,
    detail: { collectionId, title: record.title, bytes: Buffer.byteLength(input.content, 'utf-8') },
  })
  return toSummary(record)
}

export function getDocument(workspaceRoot: string, binding: KbSpaceBinding, docId: string): KbDocument | null {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_document_not_found')
  const record = readDocumentRecord(root, assertKbId('docId', docId))
  return { ...toSummary(record), content: readContent(root, record) }
}

export type KbTransitionAction = 'submit' | 'publish' | 'reject' | 'revert'

const TRANSITION_TARGET: Record<KbTransitionAction, KbDocumentStatus> = {
  submit: 'in_review',
  publish: 'published',
  reject: 'rejected',
  revert: 'draft',
}

export function transitionDocument(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
  action: KbTransitionAction,
  opts: { actor: string; reason?: string },
): KbDocumentSummary {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_document_not_found')
  const record = readDocumentRecord(root, assertKbId('docId', docId))
  const target = TRANSITION_TARGET[action]
  if (!KB_DOCUMENT_TRANSITIONS[record.status]?.includes(target)) {
    throw new KbStoreError(
      'kb_invalid_transition',
      `Cannot move a ${record.status} document to ${target}`,
    )
  }
  const content = readContent(root, record)
  const previousStatus = record.status
  record.status = target
  record.updatedAt = nowIso()
  if (target === 'published') {
    record.publishedAt = record.updatedAt
    record.rejectReason = null
    writeVersionSnapshot(root, record, content)
  } else if (target === 'rejected') {
    record.rejectReason = opts.reason ?? ''
  } else if (target === 'draft') {
    record.rejectReason = null
  }
  writeDocumentRecord(root, record)
  appendAudit(workspaceRoot, binding, {
    actor: opts.actor,
    action: `document.${action}`,
    target: record.id,
    detail: {
      from: previousStatus,
      status: record.status,
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  })
  return toSummary(record)
}

/**
 * The agreed deletion contract covers `draft` / `published` / `rejected` only
 * — a document under review must be rejected (or reverted) first, so the
 * review trail stays meaningful (review #14).
 */
const KB_DELETABLE_STATUSES: ReadonlySet<KbDocumentStatus> = new Set(['draft', 'published', 'rejected'])

export function deleteDocument(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  docId: string,
  actor: string,
): { recycled: true } {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) throw new KbStoreError('kb_document_not_found')
  const record = readDocumentRecord(root, assertKbId('docId', docId))
  if (!KB_DELETABLE_STATUSES.has(record.status)) {
    throw new KbStoreError(
      'kb_delete_not_allowed',
      `A ${record.status} document cannot be deleted; reject it first`,
    )
  }
  const source = insideRoot(
    root,
    join(root, 'collections', record.collectionId, 'documents', record.id),
  )
  const recycleDir = insideRoot(root, join(root, 'recycle'))
  ensureDir(recycleDir)
  const destination = insideRoot(root, join(recycleDir, record.id))
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true })
  }
  renameSync(source, destination)
  const recycledAt = nowIso()
  writeJson(join(destination, 'meta.json'), {
    ...record,
    status: record.status,
    recycledAt,
  })
  appendAudit(workspaceRoot, binding, {
    actor,
    action: 'document.delete',
    target: record.id,
    detail: { collectionId: record.collectionId, recycledAt, previousStatus: record.status },
  })
  return { recycled: true }
}

/**
 * Naive tokenization for the local keyword search: whitespace-separated runs
 * stay whole, CJK runs split into single characters.
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
 * that bounds the send it feeds (review #7).
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

/**
 * Snippet for a search hit built from the LOCAL content, whatever ranked it
 * (POO-108 v2: OpenViking hits keep the local snippet contract so the
 * renderer cannot tell the backends apart beyond the `source` field).
 */
export function buildKbSnippetForQuery(content: string, query: string, deadline?: number): string {
  return buildSnippet(content, content.toLowerCase(), tokenizeKbQuery(query), deadline)
}

/**
 * Bounds for a search pass (POO-108 review #7): the scan is synchronous, so
 * the send-time lookup caps how much content it may read and by when it must
 * stop — a huge KB can never stall the send loop.
 */
export interface KbSearchBudget {
  /** Stop READING further documents once this many content bytes have been read. */
  maxScannedBytes?: number
  /** Wall-clock deadline (Date.now() based), checked between documents, inside the token loop and while building snippets. */
  deadline?: number
}

/**
 * Keyword search over published documents only. Title hits weigh more than
 * body hits; results sort by score (desc) then title, capped at top 20.
 * Honors the optional budget by stopping early — partial results stay valid.
 */
export function searchDocuments(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  query: string,
  collectionIds?: string[],
  budget?: KbSearchBudget,
): KbSearchHit[] {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return []
  const tokens = tokenizeKbQuery(query)
  const wanted = collectionIds ? new Set(collectionIds) : null
  const collectionNames = new Map<string, string>()
  const hits: KbSearchHit[] = []
  if (tokens.length === 0) return []
  const collectionsDir = join(root, 'collections')
  if (!existsSync(collectionsDir)) return []
  let scannedBytes = 0
  // The two budget dimensions cancel at different granularities (review #7):
  // the DEADLINE may stop anywhere — between documents and inside a token
  // loop — while the BYTE budget only decides whether the NEXT document may
  // be read at all. Byte-checking inside the scoring loop instead would drop
  // a document that was already read: two 2MiB documents against a 4MiB cap
  // would leave the second one unscored even though its content was in hand.
  const pastDeadline = (): boolean => budget?.deadline !== undefined && Date.now() >= budget.deadline
  const pastByteBudget = (): boolean =>
    budget?.maxScannedBytes !== undefined && scannedBytes >= budget.maxScannedBytes
  /** Partial results stay valid: rank and cap whatever was scored in budget. */
  const finalize = (): KbSearchHit[] =>
    hits
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, KB_SEARCH_LIMIT)
  const scan = (): KbSearchHit[] => {
    for (const collectionEntry of readdirSync(collectionsDir, { withFileTypes: true })) {
      if (pastDeadline()) break
      if (!collectionEntry.isDirectory()) continue
      const collectionMetaPath = insideRoot(root, join(collectionsDir, collectionEntry.name, 'meta.json'))
      if (!existsSync(collectionMetaPath)) continue
      if (wanted && !wanted.has(collectionEntry.name)) continue
      const collection = readJson<KbCollectionRecord>(collectionMetaPath)
      collectionNames.set(collection.id, collection.name)
      const documentsDir = insideRoot(root, join(collectionsDir, collectionEntry.name, 'documents'))
      if (!existsSync(documentsDir)) continue
      for (const docEntry of readdirSync(documentsDir, { withFileTypes: true })) {
        if (pastDeadline() || pastByteBudget()) return finalize()
        if (!docEntry.isDirectory()) continue
        const metaPath = insideRoot(root, join(documentsDir, docEntry.name, 'meta.json'))
        if (!existsSync(metaPath)) continue
        const record = readJson<KbDocumentRecord>(metaPath)
        if (record.status !== 'published') continue
        const content = readContent(root, record)
        scannedBytes += Buffer.byteLength(content, 'utf-8')
        const title = record.title.toLowerCase()
        const lowered = content.toLowerCase()
        let score = 0
        for (const token of tokens) {
          // The deadline must cancel INSIDE the token loop, not only between
          // documents: a message that tokenizes into thousands of tokens over
          // a large document would otherwise run past its budget (review #7).
          if (pastDeadline()) return finalize()
          if (title.includes(token)) score += KB_TITLE_WEIGHT
          score += countOccurrences(lowered, token) * KB_BODY_WEIGHT
        }
        if (score <= 0) continue
        hits.push({
          docId: record.id,
          collectionId: record.collectionId,
          collectionName: collection.name,
          title: record.title,
          snippet: buildSnippet(content, lowered, tokens, budget?.deadline),
          score,
        })
      }
    }
    return finalize()
  }
  return scan()
}

/**
 * A collection is selectable for a session scope only when it holds at least
 * one published document — the read side searches published content only, so
 * an unpublished collection would be an empty promise.
 *
 * The optional budget shares ONE wall clock with the rest of the surrounding
 * operation (the send resolution's deadline, or the SET RPC's validation
 * budget): an exhausted budget stops the metadata walk and reads as "not
 * published" — degraded availability, never an unbounded stall (review #7).
 */
export function isCollectionPublished(
  workspaceRoot: string,
  binding: KbSpaceBinding,
  collectionId: string,
  budget?: KbPublishedCheckBudget,
): boolean {
  const root = readSpaceRoot(workspaceRoot, binding)
  if (!root) return false
  if (budget?.deadline !== undefined && Date.now() >= budget.deadline) return false
  try {
    readCollectionRecord(root, assertKbId('collectionId', collectionId))
  } catch {
    return false
  }
  return documentCounts(root, collectionId, budget).published > 0
}
