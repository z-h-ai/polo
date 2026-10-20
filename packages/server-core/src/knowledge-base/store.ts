import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
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
 * Content lives directly under the workspace: `<workspaceRoot>/.polo-kb/`
 * with `collections/{collectionId}/meta.json`,
 * `collections/{collectionId}/documents/{docId}/meta.json + content.md`,
 * `versions/{docId}/v{n}.md` publish snapshots, `recycle/` and `audit.jsonl`.
 * Every mutating call appends an audit entry; the RPC handler layer owns the
 * permission checks, this layer owns the filesystem truth and the state
 * machine.
 */

export interface KbCollectionRecord {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

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

export function kbRootPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), KB_DIR)
}

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

function readDocumentRecord(root: string, docId: string): KbDocumentRecord {
  const path = join(root, 'collections')
  const entries = existsSync(path) ? readdirSync(path, { withFileTypes: true }) : []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const docPath = insideRoot(root, join(path, entry.name, 'documents', docId, 'meta.json'))
    if (existsSync(docPath)) {
      return readJson<KbDocumentRecord>(docPath)
    }
  }
  throw new KbStoreError('kb_document_not_found')
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
  }
}

function readContent(root: string, record: KbDocumentRecord): string {
  const path = insideRoot(
    root,
    join(root, 'collections', record.collectionId, 'documents', record.id, 'content.md'),
  )
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

/** Publish snapshot: `versions/{docId}/v{n}.md` preserves the exact content. */
function writeVersionSnapshot(root: string, record: KbDocumentRecord, content: string): void {
  const versionsDir = insideRoot(root, join(root, 'versions', record.id))
  ensureDir(versionsDir)
  writeFileSync(join(versionsDir, `v${record.version}.md`), content, 'utf-8')
}

export function appendAudit(
  workspaceRoot: string,
  entry: { actor: string; action: string; target: string; detail?: Record<string, unknown> },
): void {
  const root = kbRootPath(workspaceRoot)
  ensureDir(root)
  const record: KbAuditEntry = {
    at: nowIso(),
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: entry.detail ?? {},
  }
  writeFileSync(join(root, 'audit.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' })
}

export function readAudit(workspaceRoot: string): KbAuditEntry[] {
  const path = join(kbRootPath(workspaceRoot), 'audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as KbAuditEntry)
}

function documentCounts(root: string, collectionId: string): KbCollection['documentCounts'] {
  const counts = { draft: 0, in_review: 0, published: 0, rejected: 0 }
  const dir = insideRoot(root, join(root, 'collections', collectionId, 'documents'))
  if (!existsSync(dir)) return counts
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
  canManage: boolean,
): KbCollection[] {
  const root = kbRootPath(workspaceRoot)
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
  input: { name: string; description: string },
  actor: string,
): KbCollection {
  const root = kbRootPath(workspaceRoot)
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
  appendAudit(workspaceRoot, {
    actor,
    action: 'collection.create',
    target: record.id,
    detail: { name: record.name },
  })
  return toCollection(root, record, true)
}

export function listDocuments(workspaceRoot: string, collectionId: string): KbDocumentSummary[] {
  const root = kbRootPath(workspaceRoot)
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
  collectionId: string,
  input: { title: string; content: string },
  actor: string,
): KbDocumentSummary {
  const root = kbRootPath(workspaceRoot)
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
  appendAudit(workspaceRoot, {
    actor,
    action: 'document.upload',
    target: record.id,
    detail: { collectionId, title: record.title, bytes: Buffer.byteLength(input.content, 'utf-8') },
  })
  return toSummary(record)
}

export function getDocument(workspaceRoot: string, docId: string): KbDocument | null {
  const root = kbRootPath(workspaceRoot)
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
  docId: string,
  action: KbTransitionAction,
  opts: { actor: string; reason?: string },
): KbDocumentSummary {
  const root = kbRootPath(workspaceRoot)
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
  appendAudit(workspaceRoot, {
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

export function deleteDocument(
  workspaceRoot: string,
  docId: string,
  actor: string,
): { recycled: true } {
  const root = kbRootPath(workspaceRoot)
  const record = readDocumentRecord(root, assertKbId('docId', docId))
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
  appendAudit(workspaceRoot, {
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

function buildSnippet(content: string, tokens: string[]): string {
  const lower = content.toLowerCase()
  let hitIndex = -1
  let hitLength = 0
  for (const token of tokens) {
    const index = lower.indexOf(token)
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
 * Keyword search over published documents only. Title hits weigh more than
 * body hits; results sort by score (desc) then title, capped at top 20.
 */
export function searchDocuments(
  workspaceRoot: string,
  query: string,
  collectionIds?: string[],
): KbSearchHit[] {
  const root = kbRootPath(workspaceRoot)
  const tokens = tokenizeKbQuery(query)
  const wanted = collectionIds ? new Set(collectionIds) : null
  const collectionNames = new Map<string, string>()
  const hits: KbSearchHit[] = []
  if (tokens.length === 0) return []
  const collectionsDir = join(root, 'collections')
  if (!existsSync(collectionsDir)) return []
  for (const collectionEntry of readdirSync(collectionsDir, { withFileTypes: true })) {
    if (!collectionEntry.isDirectory()) continue
    const collectionMetaPath = insideRoot(root, join(collectionsDir, collectionEntry.name, 'meta.json'))
    if (!existsSync(collectionMetaPath)) continue
    if (wanted && !wanted.has(collectionEntry.name)) continue
    const collection = readJson<KbCollectionRecord>(collectionMetaPath)
    collectionNames.set(collection.id, collection.name)
    const documentsDir = insideRoot(root, join(collectionsDir, collectionEntry.name, 'documents'))
    if (!existsSync(documentsDir)) continue
    for (const docEntry of readdirSync(documentsDir, { withFileTypes: true })) {
      if (!docEntry.isDirectory()) continue
      const metaPath = insideRoot(root, join(documentsDir, docEntry.name, 'meta.json'))
      if (!existsSync(metaPath)) continue
      const record = readJson<KbDocumentRecord>(metaPath)
      if (record.status !== 'published') continue
      const title = record.title.toLowerCase()
      const content = readContent(root, record).toLowerCase()
      let score = 0
      for (const token of tokens) {
        if (title.includes(token)) score += KB_TITLE_WEIGHT
        score += countOccurrences(content, token) * KB_BODY_WEIGHT
      }
      if (score <= 0) continue
      hits.push({
        docId: record.id,
        collectionId: record.collectionId,
        collectionName: collection.name,
        title: record.title,
        snippet: buildSnippet(readContent(root, record), tokens),
        score,
      })
    }
  }
  return hits
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, KB_SEARCH_LIMIT)
}

/**
 * A collection is selectable for a session scope only when it holds at least
 * one published document — the read side searches published content only, so
 * an unpublished collection would be an empty promise.
 */
export function isCollectionPublished(workspaceRoot: string, collectionId: string): boolean {
  const root = kbRootPath(workspaceRoot)
  try {
    readCollectionRecord(root, assertKbId('collectionId', collectionId))
  } catch {
    return false
  }
  return documentCounts(root, collectionId).published > 0
}
