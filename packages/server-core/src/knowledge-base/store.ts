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
  OpenVikingError,
  openVikingAttrs,
  openVikingFind,
  openVikingGlob,
  openVikingLs,
  openVikingMkdir,
  openVikingMv,
  openVikingReadContent,
  openVikingSetTags,
  openVikingWaitForProcessing,
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
  /**
   * The handler's LIVE writability view, re-consulted immediately before
   * every remote write (review fix round B2). The handler checks writable
   * once at entry, but a store write is issued only after further awaits
   * (the tenant walk, the state re-read) — a space that turned read-only or
   * offline in that window must fail the write, not slip past the entry
   * check. The callback THROWS the coded refusal (`OFFLINE_READ_ONLY` /
   * `kb_space_read_only`), so the mapping stays at the boundary that owns it.
   */
  isWritable?: () => void
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

/**
 * A timestamp tag read back. The server's lower-casing folds the ISO `T`/`Z`
 * into `t`/`z` (E2, harmless for `Date.parse` but wrong for the B6
 * full-record comparison and for display), so a parseable value is
 * re-emitted in the canonical `toISOString()` form; an unparseable value is
 * kept verbatim for the strict parsers to judge.
 */
function readTagTimestamp(value: string | undefined): string | null {
  const raw = readTagValue(value)
  if (raw === null) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return raw
  return new Date(ms).toISOString()
}

/**
 * Measured server behavior, e2e round 2026-10-21 (brief §1): OpenViking
 * lower-cases EVERY tag value — `"B1"` arrives as `"b1"`, an url-encoded
 * `"Annual%20LEAVE%20Policy"` as `"annual%20leave%20policy"`, and the ISO
 * timestamp's `T`/`Z` ride along (harmless for `Date.parse`). Any
 * case-sensitive exact value is distorted by a tag round-trip, so the
 * precise title / reject reason / collection name / tenant ownership marker
 * travels UTF-8 hex-encoded under a dedicated key — the hex alphabet is
 * itself lower-case and immune. The url-encoded value stays alongside as a
 * READABLE copy (what the storage workbench shows; NOT authoritative), and
 * reads fall back to it when the hex key is missing (data written before
 * this round).
 */
export function kbTagHexEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('hex')
}

/**
 * Decodes a hex-carried tag value. A value that is not hex, not even-length,
 * or does not re-encode to itself (an old plaintext value that merely looks
 * like hex) reads as `null` — the caller falls back to the legacy key.
 */
export function kbTagHexDecode(value: string | undefined): string | null {
  if (value === undefined || value.length < 2 || value.length % 2 !== 0) return null
  if (!/^[0-9a-f]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'hex').toString('utf-8')
  return kbTagHexEncode(decoded) === value ? decoded : null
}

/** Builds one `k=v` tag, url-encoding the value (lossless round-trip). */
function tag(key: string, value: string): string {
  return `${key}=${tagValue(value)}`
}

const KB_DOCUMENT_STATUSES: ReadonlySet<string> = new Set(['draft', 'in_review', 'published', 'rejected'])
/** The live-path parse also accepts the storage-only soft-delete tombstone. */
const KB_TOMBSTONE_STATUSES: ReadonlySet<string> = new Set([...KB_DOCUMENT_STATUSES, 'deleted'])

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
  const parsed = parseDocumentTagSet(raw, KB_DOCUMENT_STATUSES)
  return parsed ? { ...parsed, status: parsed.status as KbDocumentStatus } : null
}

/**
 * Parses the tags at a LIVE uri, additionally accepting the storage-only
 * `deleted` tombstone (review fix round B7): an interrupted soft delete
 * leaves `status=deleted` on the live path, and the delete retry must READ
 * that state to resume the move instead of discarding the node as
 * unparseable. The strict wire parser above still rejects it.
 */
function parseLiveDocumentTags(raw: RawTags): (Omit<KbDocumentTags, 'status'> & { status: KbDocumentStatus | 'deleted' }) | null {
  const parsed = parseDocumentTagSet(raw, KB_TOMBSTONE_STATUSES)
  return parsed ? { ...parsed, status: parsed.status as KbDocumentStatus | 'deleted' } : null
}

function parseDocumentTagSet(
  raw: RawTags,
  allowedStatuses: ReadonlySet<string>,
): Omit<KbDocumentTags, 'status'> & { status: string } | null {
  if (raw.duplicateKeys.length > 0) return null
  const { tags } = raw
  const docId = tags.doc
  const collectionId = tags.collection
  const status = tags.status
  // E2: the EXACT title/reject reason rides the hex key (immune to the
  // server's lower-casing); the url-encoded key is the readable fallback.
  const title = kbTagHexDecode(tags.t) ?? readTagValue(tags.title)
  const createdAt = readTagTimestamp(tags.created)
  const updatedAt = readTagTimestamp(tags.updated)
  if (!docId || !collectionId || !status || !title || !createdAt || !updatedAt) return null
  if (!allowedStatuses.has(status)) return null
  const version = tags.v !== undefined ? Number(tags.v) : 1
  return {
    docId,
    collectionId,
    status,
    title,
    version: Number.isInteger(version) && version >= 1 ? version : 1,
    createdAt,
    updatedAt,
    publishedAt: readTagTimestamp(tags.published),
    rejectReason: kbTagHexDecode(tags.r) ?? readTagValue(tags.reject),
  }
}

function parseDocumentStatus(raw: RawTags): KbDocumentStatus | null {
  if (raw.duplicateKeys.length > 0) return null
  const status = raw.tags.status
  if (!status || !KB_DOCUMENT_STATUSES.has(status)) return null
  return status as KbDocumentStatus
}

/**
 * Whether two parsed tag sets describe the SAME document record (review fix
 * round B6). The read-back after a transition compares EVERY summary field —
 * status alone cannot see a same-status overwrite (a concurrent reject whose
 * reason differs from ours lands on the same `rejected` status), which is
 * exactly the collision the verification exists to catch.
 */
function sameDocumentRecord(left: KbDocumentTags, right: KbDocumentTags): boolean {
  return left.docId === right.docId
    && left.collectionId === right.collectionId
    && left.status === right.status
    && left.title === right.title
    && left.version === right.version
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.publishedAt === right.publishedAt
    && left.rejectReason === right.rejectReason
}

/** The summary fields that differ — diagnostic detail for the conflict (B6). */
function differingFields(expected: KbDocumentTags, actual: KbDocumentTags): string[] {
  const fields: string[] = []
  for (const key of ['docId', 'collectionId', 'status', 'title', 'version', 'createdAt', 'updatedAt', 'publishedAt', 'rejectReason'] as const) {
    if (expected[key] !== actual[key]) fields.push(key)
  }
  return fields
}

/**
 * The tag set uploaded/published with a document — the FULL set, every time.
 * `status` also accepts the storage-only soft-delete state (brief D4), which
 * never appears on the wire but must be writable into tags.
 */
function documentTags(record: {
  docId: string
  collectionId: string
  title: string
  status: KbDocumentStatus | 'deleted'
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
    // E2: `t=` carries the exact title hex-encoded; `title=` stays as the
    // lower-cased readable copy the storage workbench shows.
    `t=${kbTagHexEncode(record.title)}`,
    tag('title', record.title),
    `v=${record.version}`,
    tag('created', record.createdAt),
    tag('updated', record.updatedAt),
    ...(record.publishedAt ? [tag('published', record.publishedAt)] : []),
    ...(record.rejectReason !== null ? [
      `r=${kbTagHexEncode(record.rejectReason)}`,
      tag('reject', record.rejectReason),
    ] : []),
  ]
}

/** Collection directory tags: id, lossless name, optional lossless description. */
function collectionTags(input: { collectionId: string; name: string; description: string; createdAt: string }): string[] {
  return [
    tag('collection', input.collectionId),
    // E2: `n=` carries the exact collection name hex-encoded; `name=` is the
    // readable (lower-cased) copy.
    `n=${kbTagHexEncode(input.name)}`,
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
// Remote primitives — every WRITE revalidates token AND writability first
// (§3.5 + review fix round B2), and every write is audited as an intent
// before the request and a result after it (review fix round B8)
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
 * The FULL pre-write gate (review fix round B2): the captured scope token must
 * still be current AND the handler's live writability view must still hold.
 * The token alone cannot see an offline view or a restriction that landed
 * while earlier awaits (the tenant walk, the state re-read) were pending —
 * those states are only observable through the handler's predicate.
 */
function assertRemoteWriteAllowed(space: KbOpenVikingSpace): void {
  assertScopeTokenCurrent(space)
  space.isWritable?.()
}

/**
 * Wraps a remote call: vendor failures become the neutral availability error
 * with the RAW cause in `detail` (server-side logs only, brief D7).
 */
function toKbError(operation: string, error: unknown): KbStoreError {
  if (error instanceof KbStoreError) return error
  const mapped = new KbStoreError(
    'kb_service_unavailable',
    KB_SERVICE_UNAVAILABLE_MESSAGE,
    `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  // The raw failure rides along for CLASSIFICATION (review fix round B8):
  // the audit outcome must know whether the request may have landed, which
  // only the original OpenVikingError can answer.
  ;(mapped as { cause?: unknown }).cause = error
  return mapped
}

/**
 * How a finished write attempt is recorded (review fix round B8). A timeout
 * or a broken connection means the request MAY have taken effect — the
 * storage service has no read-back-your-own-write oracle for this — so it is
 * recorded as `unknown`, never as a clean `failed`. An intent entry without a
 * result entry (process died mid-flight) reads as the same `unknown`.
 */
type KbRemoteOutcome = 'success' | 'failed' | 'unknown'

function remoteOutcomeOf(error: unknown): KbRemoteOutcome {
  // The primitives classify AFTER their toKbError mapping, so the raw
  // transport failure may ride in `cause` (review fix round B8).
  const raw = error instanceof KbStoreError
    ? (error as { cause?: unknown }).cause
    : error
  // Gateway timeouts/bad-gateway responses are the classic "the origin MAY
  // have applied it" case: the request left, the answer did not come from
  // the storage service itself.
  if (raw instanceof OpenVikingError
    && raw.code === 'openviking_http_error'
    && (raw.status === 502 || raw.status === 503 || raw.status === 504)) {
    return 'unknown'
  }
  if (raw instanceof OpenVikingError
    && (raw.code === 'openviking_timeout' || raw.code === 'openviking_network_error')) {
    return 'unknown'
  }
  return 'failed'
}

interface KbRemoteIntent {
  /** Audit action stem, e.g. `remote.set_tags` → `.intent` / `.result`. */
  action: string
  target: string
  detail?: Record<string, unknown>
  /**
   * Extra detail resolved when the RESULT entry is written — the shape for
   * facts only the run knows (the verified directory-tag loop reports its
   * attempt count and the pipeline-wait spend there, review fix round E1).
   * A throw still resolves it, so a failed run reports how far it got.
   */
  resultDetail?: () => Record<string, unknown>
}

/** The audit sink adapter: one entry into the caller's trail. */
export type KbRemoteAuditRecord = (entry: {
  actor: string
  action: string
  target: string
  detail?: Record<string, unknown>
}) => void

/**
 * Audits ONE remote write as `<action>.intent` BEFORE the request and
 * `<action>.result` after it, correlated by a request id (review fix round
 * B8). A timeout/interruption is recorded `unknown` — the operation may have
 * landed — and a crash between the two entries leaves the intent dangling,
 * which the trail reads as the same `unknown`. The audits are best-effort by
 * construction (the sink never throws). Exported so the TENANT provisioning
 * writes (account creation, ownership tags) carry the same discipline (B8
 * residual): those are remote writes too, and a timeout there may also have
 * landed.
 */
export async function auditedRemoteWrite<T>(
  record: KbRemoteAuditRecord,
  actor: string,
  intent: KbRemoteIntent,
  run: () => Promise<T>,
): Promise<T> {
  const requestId = randomUUID()
  record({
    actor,
    action: `${intent.action}.intent`,
    target: intent.target,
    detail: { requestId, ...(intent.detail ?? {}) },
  })
  try {
    const result = await run()
    record({
      actor,
      action: `${intent.action}.result`,
      target: intent.target,
      detail: {
        // Host detail spreads FIRST: `requestId`/`outcome`/`cause` are this
        // wrapper's audit contract and a host summary must not override them.
        ...(intent.resultDetail?.() ?? {}),
        requestId,
        outcome: 'success' satisfies KbRemoteOutcome,
      },
    })
    return result
  } catch (error) {
    record({
      actor,
      action: `${intent.action}.result`,
      target: intent.target,
      detail: {
        ...(intent.resultDetail?.() ?? {}),
        requestId,
        outcome: remoteOutcomeOf(error),
        reason: error instanceof Error ? error.message : String(error),
        // The mapped error's message is neutral on purpose (D7); the raw
        // cause rides in `detail` — the audit trail is server-side only, so
        // THIS is where diagnosability lives (review fix round B8).
        ...(error instanceof KbStoreError && error.detail !== undefined
          ? { cause: String(error.detail) }
          : {}),
      },
    })
    throw error
  }
}

async function auditedRemote<T>(
  space: KbOpenVikingSpace,
  intent: KbRemoteIntent,
  run: () => Promise<T>,
): Promise<T> {
  return auditedRemoteWrite(
    entry => appendAudit(space.workspaceRoot, space.binding, entry),
    space.actor,
    intent,
    run,
  )
}

async function remoteMkdir(space: KbOpenVikingSpace, uri: string, description?: string): Promise<void> {
  await auditedRemote(space, { action: 'remote.mkdir', target: uri }, async () => {
    assertRemoteWriteAllowed(space)
    try {
      await openVikingMkdir(space.config, space.auth, { uri, description })
    } catch (error) {
      // Idempotent on retry: an existing directory is as good as a new one —
      // the tags write below completes the state either way.
      if (isOpenVikingAlreadyExists(error)) return
      throw toKbError(`mkdir ${uri}`, error)
    }
  })
}

async function remoteWriteContent(
  space: KbOpenVikingSpace,
  uri: string,
  content: string,
  tags?: string[],
): Promise<void> {
  await auditedRemote(space, { action: 'remote.content_write', target: uri }, async () => {
    assertRemoteWriteAllowed(space)
    try {
      await openVikingWriteContent(space.config, space.auth, { uri, content, tags })
    } catch (error) {
      throw toKbError(`write ${uri}`, error)
    }
  })
}

async function remoteSetTags(
  space: KbOpenVikingSpace,
  uri: string,
  tags: string[],
  detail?: Record<string, unknown>,
): Promise<void> {
  await auditedRemote(space, { action: 'remote.set_tags', target: uri, detail }, async () => {
    assertRemoteWriteAllowed(space)
    try {
      await openVikingSetTags(space.config, space.auth, { uri, tags, mode: 'replace' })
    } catch (error) {
      throw toKbError(`set_tags ${uri}`, error)
    }
  })
}

/**
 * Directory tag writes, verified (brief §1.10). The measured instance runs an
 * ingestion pipeline over every freshly created directory — `mkdir` with or
 * without a description, and the account's resource root after an account
 * creation — and REBUILDS the directory's attributes when it finishes, wiping
 * whatever `set_tags` landed inside that window while answering `ok` (the
 * window measured ~4.5s in `semantic_and_vectors`; a plain mkdir drained in
 * ~0.5s). A `set_tags` issued after the pipeline completes sticks reliably.
 *
 * So every directory-bound tag write runs the same bounded loop:
 *
 *   wait for the pipeline (`POST /api/v1/system/wait`, raced against the
 *     client's own wait timeout — a timed-out or failing wait is ABSORBED,
 *     never fatal) → write → read the tags back through `fs/attrs` →
 *     still missing → poll again at a fixed 1s interval (the wait may run
 *     before every retry) until the read-back verifies, for at most the
 *     window below; only then surface the neutral availability error.
 *
 * An unverified write here means a collection whose `collection=` tag never
 * lands — a directory that vanishes from every listing — or an ownership
 * marker that fail-closes the NEXT provisioning forever.
 */
export const KB_DIRECTORY_TAG_WINDOW_MS = 12_000

let directoryTagWindowMs = KB_DIRECTORY_TAG_WINDOW_MS
let directoryTagPollIntervalMs = 1_000

/** Test seam: the poll interval between verification attempts. */
export function setKbDirectoryTagRetryDelayForTests(ms: number): void {
  directoryTagPollIntervalMs = ms
}

export function resetKbDirectoryTagRetryDelayForTests(): void {
  directoryTagPollIntervalMs = 1_000
}

/** Test seam: the total window a verified directory write may take. */
export function setKbDirectoryTagWindowForTests(ms: number): void {
  directoryTagWindowMs = ms
}

export function resetKbDirectoryTagWindowForTests(): void {
  directoryTagWindowMs = KB_DIRECTORY_TAG_WINDOW_MS
}

function sleepForRetry(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Races one loop step against the REMAINING budget: `null` reads as "the
 * window ran out first" (review round N1). The loser is never aborted — the
 * transport has no cancellation — so a write that loses the race may still
 * land later; the budget governs how long the loop WAITS for an answer, not
 * what the storage service ends up holding (the step's own audit pair still
 * records the real outcome when it settles).
 */
function raceRemainingBudget<T>(step: Promise<T>, remainingMs: number): Promise<T | null> {
  if (remainingMs <= 0) return Promise.resolve(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const clock = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), remainingMs)
  })
  return Promise.race([step, clock]).finally(() => clearTimeout(timer))
}

/** Everything the shared verified loop needs from ITS caller (store or tenant). */
export interface KbDirectoryTagWriteHost {
  /** The audit sink for the loop's own `remote.directory_tags` pair. */
  record: KbRemoteAuditRecord
  actor: string
  /** Revalidated before EVERY physical write (the await-spanning scope token). */
  beforeWrite?: () => void
  /**
   * The physical write, audited by the HOST (the store's `remote.set_tags`
   * pair per attempt, the tenant's marker pair). `detail` carries the attempt
   * number and the pipeline-wait spend for the trail.
   */
  write: (detail: { attempt: number; waitedMs: number }) => Promise<void>
  /**
   * The read-back; `null` reads as a miss and keeps the loop going. A
   * transport error must read as a miss too — a set_tags that landed followed
   * by one flaky `fs/attrs` is a poll-away success, not a failure.
   */
  read: () => Promise<Record<string, string> | null>
  /**
   * The bounded pipeline wait; the loop passes the budget it may use (what
   * remains of the window minus one poll interval) and ABSORBS its failure —
   * a timed-out or failing wait never fails the write.
   */
  wait: (budgetMs: number) => Promise<void>
}

/**
 * The ONE verified directory-tag loop, shared by the store's collection
 * writes and the tenant's ownership marker (both are directory writes against
 * the same measured window). The whole loop is one audited remote operation
 * (`remote.directory_tags`) whose result carries the retry detail — attempt
 * count, ms spent waiting for the pipeline, absorbed wait failures — and each
 * physical write stays audited by the host on top of it.
 *
 * The window bounds the WHOLE run, not only the waits (review round N1): the
 * pipeline wait, the write and its read-back each race what remains of the
 * budget, and the verification is re-checked against the deadline at the
 * moment it is accepted — a single slow request can never stretch a 12s
 * promise into 12.1s of reported success.
 */
export async function writeKbDirectoryTagsVerified(
  host: KbDirectoryTagWriteHost,
  uri: string,
  verify: (tags: Record<string, string>) => boolean,
): Promise<void> {
  const summary = { attempts: 0, waitedMs: 0, waitFailures: 0 }
  const windowMs = directoryTagWindowMs
  const deadline = Date.now() + windowMs
  const exhausted = () => new KbStoreError(
    'kb_service_unavailable',
    KB_SERVICE_UNAVAILABLE_MESSAGE,
    `directory tags at ${uri} did not stick within ${windowMs}ms`
      + ` (${summary.attempts} attempts, ${summary.waitedMs}ms waiting,`
      + ` ${summary.waitFailures} failed waits)`,
  )
  await auditedRemoteWrite(host.record, host.actor, {
    action: 'remote.directory_tags',
    target: uri,
    resultDetail: () => ({ ...summary, windowMs }),
  }, async () => {
    for (let attempt = 1; ; attempt += 1) {
      if (Date.now() >= deadline) throw exhausted()
      // The pipeline wait FIRST: a write issued after the drain sticks on the
      // first attempt, so the poll below is the fallback, not the plan. The
      // wait's budget is what remains minus one poll interval — a wait may
      // never convert the whole window into one silent block and leave the
      // write+read-back no turn (review round M1: an unbounded wait ran to
      // its own 12s timeout and pushed the write to ~2× the window).
      const waitBudgetMs = deadline - Date.now() - directoryTagPollIntervalMs
      const waitStartedAt = Date.now()
      if (waitBudgetMs > 0) {
        try {
          await host.wait(waitBudgetMs)
        } catch {
          summary.waitFailures += 1
        }
        summary.waitedMs += Date.now() - waitStartedAt
        // Re-checked AFTER the wait: no write may be issued that the window
        // can no longer verify.
        if (Date.now() >= deadline) throw exhausted()
      }
      host.beforeWrite?.()
      // Counted from the moment the write is DISPATCHED: past the before-write
      // gate the request is handed to the transport — its `remote.set_tags`
      // intent/result pair lands on the trail even when the call throws — so
      // a budget-race loss or a transport failure must not under-report the
      // attempt. Only the refusal above stays uncounted (no request left).
      summary.attempts = attempt
      // The write itself rides the REMAINING budget (review round N1): a
      // request that outlasts the window must not hand the loop a verified
      // success at 2× the promised bound — the window covers every request,
      // not only the waits between them. A write that loses the race is a
      // FAILED attempt, not a missing one, and the window has no turn left.
      const written = await raceRemainingBudget(
        host.write({ attempt, waitedMs: Date.now() - waitStartedAt }),
        deadline - Date.now(),
      )
      if (written === null) throw exhausted()
      const tags = await raceRemainingBudget(host.read(), deadline - Date.now())
      // The verification is accepted only INSIDE the window — re-checked at
      // the moment of acceptance, because a read-back that confirms past the
      // deadline breaks the same promise the write race guards (review round
      // N1). A lost read-back race is a miss, so it falls through to the
      // remaining-budget check below and reads as exhaustion.
      if (tags !== null && verify(tags) && Date.now() < deadline) return
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw exhausted()
      await sleepForRetry(Math.min(directoryTagPollIntervalMs, remainingMs))
    }
  })
}

async function remoteSetDirectoryTagsVerified(
  space: KbOpenVikingSpace,
  uri: string,
  tags: string[],
  verify: (tags: Record<string, string>) => boolean,
): Promise<void> {
  await writeKbDirectoryTagsVerified({
    record: entry => appendAudit(space.workspaceRoot, space.binding, entry),
    actor: space.actor,
    write: detail => remoteSetTags(space, uri, tags, detail),
    read: async () => (await remoteAttrs(space, uri).catch(() => null))?.tags ?? null,
    wait: budgetMs => openVikingWaitForProcessing(space.config, space.auth, budgetMs),
  }, uri, verify)
}

async function remoteMv(space: KbOpenVikingSpace, fromUri: string, toUri: string): Promise<void> {
  await auditedRemote(space, { action: 'remote.mv', target: fromUri, detail: { toUri } }, async () => {
    assertRemoteWriteAllowed(space)
    try {
      await openVikingMv(space.config, space.auth, { fromUri, toUri })
    } catch (error) {
      throw toKbError(`mv ${fromUri}`, error)
    }
  })
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
  /**
   * An index ALREADY built in this operation, reused instead of walking the
   * tenant a second time (review fix round R2 — the send path loads the index
   * once and shares it between the draft-commit publish checks and the
   * retrieval's collection scoping/hit attribution).
   */
  index?: KbIndex
}

const KB_LS_PAGE_NODES = 2_000
/** Ten full pages ≈ 20k nodes: past this the tenant is abnormal, not large. */
const KB_LS_MAX_PAGES = 10

/**
 * One recursive, tag-annotated walk over the whole tenant (brief D3). The
 * server hides dotfile CONTENT but lists dot DIRECTORIES (§1.7), so the
 * recycle/transition subtrees are filtered here by prefix. Pages honor the
 * shared deadline; partial results stay valid — callers fail closed.
 *
 * Pagination correctness (review fix round R2): the offset advances by what
 * the server actually served, and the walk DEDUPES by uri, so a server that
 * returns a short page while reporting `has_more` (or drops malformed rows
 * mid-walk) cannot make pages overlap — an overlap would count one document
 * twice in the collection counts, a skip would silently lose it. A walk that
 * stops at the page CAP reports `truncated` so callers can tell an abnormal
 * tenant from a complete one.
 */
interface KbWalk {
  nodes: OpenVikingNode[]
  /** True when the walk stopped at the page cap with the server still paging. */
  truncated: boolean
}

async function walkKbTree(space: KbOpenVikingSpace, budget?: KbStoreBudget): Promise<KbWalk> {
  const nodes: OpenVikingNode[] = []
  const seen = new Set<string>()
  let offset = 0
  // An exhausted deadline is a NORMAL degradation (the send-time resolver and
  // the search budget both arrive here already out of time), so it must not
  // be reported as a tenant-size anomaly; only walking the page CAP does.
  let ranOutOfBudget = false
  let truncated = false
  for (let page = 0; page < KB_LS_MAX_PAGES; page += 1) {
    if (budget?.deadline !== undefined && Date.now() >= budget.deadline) {
      ranOutOfBudget = true
      break
    }
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
      if (seen.has(entry.uri)) continue
      seen.add(entry.uri)
      if (!isHiddenKbUri(entry.uri)) nodes.push(entry)
    }
    if (!result.hasMore) return { nodes, truncated: false }
    // A page that advances by nothing can never reach `has_more === false` —
    // stop instead of re-reading the same page until the cap.
    if (result.entries.length === 0) break
    offset += result.entries.length
  }
  truncated = !ranOutOfBudget
  if (truncated) {
    console.warn(
      `[KbStore] the knowledge base listing exceeded ${KB_LS_MAX_PAGES * KB_LS_PAGE_NODES} nodes — counting the first pages only`,
    )
  }
  return { nodes, truncated }
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
  /**
   * True when the walk hit the page cap while the server was still paging
   * (review fix round R2): every count below is a consistent prefix of the
   * tenant, never an overlap-inflated number — but a document the prefix did
   * not reach is missing from it, so a collection entirely beyond the prefix
   * reads as unpublished (the natural fail-closed direction: a session scope
   * is refused, never granted on unverifiable data).
   */
  truncated: boolean
}

function emptyCounts(): KbCollection['documentCounts'] {
  return { draft: 0, in_review: 0, published: 0, rejected: 0 }
}

function buildKbIndex(nodes: OpenVikingNode[], truncated: boolean): KbIndex {
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
      // E2: the exact name rides `n=` (hex); `name=` is the readable fallback.
      const name = kbTagHexDecode(raw.tags.n) ?? readTagValue(raw.tags.name)
      if (name) entry.name = name
      const description = readTagValue(raw.tags.description)
      if (description) entry.description = description
      const createdAt = readTagTimestamp(raw.tags.created)
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
  return { collections, documents, truncated }
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
 * collection). An index handed in through the budget is returned as-is: the
 * caller has already paid for the walk (review fix round R2).
 */
export async function loadKbIndex(space: KbOpenVikingSpace, budget?: KbStoreBudget): Promise<KbIndex> {
  if (budget?.index) return budget.index
  const walk = await walkKbTree(space, budget)
  return buildKbIndex(walk.nodes, walk.truncated)
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
  // E1: the tags land right after the mkdir — inside the processing window
  // the real instance wipes on pipeline completion. The verified write waits
  // the pipeline out (`system/wait`), then reads the tags back and polls
  // before the collection is reported created. The verified keys are the two
  // the server's tag lower-casing cannot distort (the collection id and the
  // hex-carried name); the ISO `created` value comes back with its `T`/`Z`
  // folded (E2, harmless for Date.parse) and never takes part.
  const expectedTags = collectionTags(record)
  await remoteSetDirectoryTagsVerified(space, uri, expectedTags, tags =>
    tags.collection === record.collectionId
    && tags.n === kbTagHexEncode(record.name))
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

/**
 * Locates a document's tombstone copy inside `.recycle/` (review fix round
 * B7, second half): when the recycle move already executed but BOTH of its
 * responses were lost (the move and the attrs confirmation), the live lookup
 * finds nothing and the retry must recognize the completed delete instead of
 * answering `kb_document_not_found` forever. Every candidate is confirmed by
 * its tags — the tombstone parse accepts `status=deleted`, and a corrupted
 * or foreign node never masquerades as this document.
 */
async function locateRecycledDocument(space: KbOpenVikingSpace, docId: string): Promise<string | null> {
  let matches: string[]
  try {
    matches = await openVikingGlob(space.config, space.auth, {
      pattern: `**/*-${docId}.md`,
      uri: KB_RECYCLE_DIR_URI,
    })
  } catch {
    // An absent `.recycle/` subtree (nothing ever deleted) or a read failure
    // reads as "no copy" — the caller re-raises the original not-found.
    return null
  }
  for (const uri of matches.sort()) {
    const node = await remoteAttrs(space, uri).catch(() => null)
    const parsed = node ? parseLiveDocumentTags(rawTagsOf(node)) : null
    if (parsed?.docId === docId) return uri
  }
  return null
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
 * trail stays meaningful (v2 review #14, unchanged). `deleted` is the storage
 * ONLY tombstone (brief D4): a previous attempt that already pulled the
 * document off the retrieval face but died before the move completed.
 */
const KB_DELETABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'published', 'rejected'])

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
 * and never fatal: this is a diagnostic trail, not a gate. It goes through
 * the SAME protected write wrapper as every other write (review fix round
 * B3): the scope token AND the live writability are revalidated first, so a
 * revoked/read-only scope can never push even a diagnostic file.
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
    await remoteWriteContent(space, uri, JSON.stringify(entry), [
      `doc=${entry.docId}`,
      `kind=transition`,
    ])
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

    // Read-back verification (review fix round B6): the state machine only
    // commits when the remote tags carry the FULL record we just wrote — not
    // merely the target status. A concurrent writer that lands on the same
    // status with different summary fields (its own reject reason, its own
    // timestamps) is the same unconditional-write collision and must surface
    // as a conflict too (brief D4).
    const after = await remoteAttrs(space, uri)
    const afterParsed = after ? parseDocumentTags(rawTagsOf(after)) : null
    if (!afterParsed || !sameDocumentRecord(afterParsed, next)) {
      throw new KbStoreError(
        'kb_conflict',
        'The document changed while the transition was applied',
        {
          expected: { status: target, updatedAt: next.updatedAt, rejectReason: next.rejectReason },
          actual: afterParsed
            ? { status: afterParsed.status, updatedAt: afterParsed.updatedAt, rejectReason: afterParsed.rejectReason }
            : null,
          ...(afterParsed ? { fields: differingFields(next, afterParsed) } : {}),
        },
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
    let uri: string
    try {
      uri = await locateDocument(space, docId)
    } catch (error) {
      // Review fix round B7, second half: when the recycle move AND its attrs
      // confirmation were both lost, the document already sits in `.recycle/`
      // with its tombstone — the delete is DONE, and the retry must answer
      // idempotent success instead of `kb_document_not_found`.
      if (error instanceof KbStoreError && error.code === 'kb_document_not_found') {
        if (await locateRecycledDocument(space, docId)) {
          appendAudit(space.workspaceRoot, space.binding, {
            actor: space.actor,
            action: 'document.delete',
            target: docId,
            detail: { alreadyRecycled: true },
          })
          return { recycled: true as const }
        }
      }
      throw error
    }
    const node = await remoteAttrs(space, uri)
    if (!node) throw new KbStoreError('kb_document_not_found')
    const current = parseLiveDocumentTags(rawTagsOf(node))
    if (!current || current.docId !== docId) throw new KbStoreError('kb_document_not_found')
    // Review fix round B7: a `deleted` tag at the LIVE uri is the partial
    // state of an interrupted delete — the status write landed, the move into
    // `.recycle/` did not. Retrying must RESUME (complete the move) instead
    // of reading the tombstone as "not deletable" and wedging the document
    // forever.
    const resuming = current.status === 'deleted'
    if (!resuming && !KB_DELETABLE_STATUSES.has(current.status)) {
      throw new KbStoreError(
        'kb_delete_not_allowed',
        `A ${current.status} document cannot be deleted; reject it first`,
      )
    }
    // Soft delete (brief D4): status leaves the retrieval face FIRST (the
    // recycle target is a hidden dot path, so the move then removes it from
    // every listing too). No permanent deletion exists — same as v2.
    const recycledAt = nowIso()
    if (!resuming) {
      await remoteSetTags(space, uri, documentTags({
        ...current,
        status: 'deleted',
        updatedAt: recycledAt,
      }))
    }
    await remoteMkdir(space, KB_RECYCLE_DIR_URI)
    try {
      await remoteMv(space, uri, recycleTargetUri(uri))
    } catch (error) {
      // The move may still have landed past a timeout (B8's `unknown`
      // outcome): the target holding THIS document is success, not an error.
      // The tombstone parse is the LIVE-path one (B7 fix): the moved copy
      // carries `status=deleted`, which the strict wire parser rejects —
      // confirming with it could never confirm a real recycle.
      const target = await remoteAttrs(space, recycleTargetUri(uri)).catch(() => null)
      const moved = target ? parseLiveDocumentTags(rawTagsOf(target)) : null
      if (!moved || moved.docId !== docId) throw error
    }
    appendAudit(space.workspaceRoot, space.binding, {
      actor: space.actor,
      action: 'document.delete',
      target: docId,
      detail: {
        collectionId: current.collectionId,
        recycledAt,
        previousStatus: current.status,
        ...(resuming ? { resumed: true } : {}),
      },
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
 * only after their tags parse STRICTLY and the hit maps BACK into this
 * space's index (review fix round B5): the backend's tags travel with the
 * row and cannot be trusted on their own — a foreign node carrying a copied
 * legal tag set would otherwise be disclosed as this space's document. The
 * mapping is a TRIPLE check: the doc id is known to the index, the hit's
 * collection matches the index's record for that doc, and the hit's uri
 * lives under the LIVE collection uri the index saw. Anything else (foreign
 * body, stale index, out-of-band node, corrupted tags) drops silently.
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
  // mapping — never a second walk of the same tenant (and, review fix round
  // R2, the walk may already have been paid for by the draft-commit phase).
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
    // B5 attribution: the hit must be a document THIS space's index knows,
    // under the collection the tags claim, at the live collection uri — and
    // (review fix round B5 residual) at the index's EXACT document uri. A
    // forged file inside the same collection directory carries the known
    // document's full tag set and passes the prefix check; only the precise
    // uri the index walked pins the hit to the body it disclosed.
    const known = index.documents.get(parsed.docId)
    if (!known || known.parsed.collectionId !== parsed.collectionId) continue
    if (known.parsed.status !== 'published') continue
    if (known.uri !== resource.uri) continue
    const collectionUri = index.collections.get(parsed.collectionId)?.uri
    if (!collectionUri || !resource.uri.startsWith(`${collectionUri}/`)) continue
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
