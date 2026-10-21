import { z } from 'zod'

/**
 * Enterprise Knowledge Base (POO-108) wire contracts.
 *
 * The KB is a workspace-scoped service domain (POO-108 v3.1): content lives in
 * the enterprise's remote storage tenant and every RPC is LOCAL_ONLY — the
 * wire never names the storage vendor. These schemas define both the RPC
 * payloads and the persisted `kbReferences` snapshot that travels on user
 * messages.
 */

/**
 * The KB error codes the RPC boundary may put on the wire (POO-108 review fix
 * round B9). The transport rewrites any code outside its whitelist to
 * `HANDLER_ERROR`, which would erase the very distinction the renderer's
 * i18n mapping branches on (e.g. the neutral `kb_service_unavailable` text),
 * so every KB code MUST be listed there — this union is the contract, the
 * transport whitelist imports it.
 */
export const KB_ERROR_CODES = [
  'kb_manage_required',
  'kb_content_too_large',
  'kb_invalid_transition',
  'kb_delete_not_allowed',
  'kb_collection_not_found',
  'kb_document_not_found',
  'kb_unavailable_in_personal',
  'kb_space_read_only',
  'kb_space_mismatch',
  'kb_service_unavailable',
  'kb_collection_not_published',
  'kb_conflict',
] as const
export type KbErrorCode = (typeof KB_ERROR_CODES)[number]

export const KB_MAX_CONTENT_BYTES = 2 * 1024 * 1024
export const KB_SEARCH_LIMIT = 20
/** Per-collection hit cap used by the send-time reference lookup. */
export const KB_SEARCH_PER_COLLECTION_LIMIT = 3
export const KB_SNIPPET_CONTEXT_CHARS = 80
/**
 * Send-time reference resolution must never hold a message hostage (POO-108
 * review #7): the whole resolution is raced against this wall clock — the
 * single remote find, the tenant walk it needs and the snippet building all
 * honour the same deadline. Sized for the v3 native backend (measured
 * 2026-10-21): the tenant credential read + one recursive ls walk + a remote
 * find whose QUERY EMBEDDING is a cloud round-trip legitimately costs 1-3s —
 * the 1.5s v2 budget dropped every reference on a real instance, so the send
 * budget now covers one full remote resolution while staying bounded.
 */
export const KB_SEND_RESOLVE_TIMEOUT_MS = 4_000
/** Same ceiling the SET_SESSION_COLLECTIONS input schema enforces. */
export const KB_SESSION_COLLECTIONS_MAX = 100
/**
 * The longest search query the KB accepts (POO-108 review #7). The send-time
 * lookup tokenizes the raw message, so it truncates the message to this same
 * ceiling instead of silently accepting an unbounded scan input.
 */
export const KB_SEARCH_QUERY_MAX_CHARS = 32_768
/**
 * Wall-clock budget for the publish-state validation that guards a session
 * scope write (POO-108 review #7). The check walks a collection's document
 * metadata synchronously, so with a huge collection it must give up — reading
 * as "not proven published" — instead of stalling the SET RPC (and, on the
 * send path, the message it feeds) past the reference-resolution deadline.
 */
export const KB_PUBLISHED_CHECK_TIMEOUT_MS = 1_500

export const KbDocumentStatusSchema = z.enum(['draft', 'in_review', 'published', 'rejected'])
export type KbDocumentStatus = z.output<typeof KbDocumentStatusSchema>

/** Statuses a document can be moved INTO, used for validation error mapping. */
export const KB_DOCUMENT_TRANSITIONS: Record<KbDocumentStatus, KbDocumentStatus[]> = {
  draft: ['in_review'],
  in_review: ['published', 'rejected'],
  published: [],
  rejected: ['draft'],
}

const nonBlank = (maxLength: number) => z.string()
  .max(maxLength)
  .refine(value => value.trim().length > 0, 'Must be a non-blank string')

export const KbWorkspaceIdSchema = nonBlank(512)
export const KbCollectionIdSchema = nonBlank(128)
export const KbDocumentIdSchema = nonBlank(128)
export const KbSessionIdSchema = nonBlank(256)

export const KbCreateCollectionInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  name: nonBlank(256),
  description: z.string().max(4_096),
}).strict()
export type KbCreateCollectionInput = z.output<typeof KbCreateCollectionInputSchema>

export const KbUploadDocumentInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  collectionId: KbCollectionIdSchema,
  title: nonBlank(512),
  content: z.string().max(KB_MAX_CONTENT_BYTES),
}).strict()
export type KbUploadDocumentInput = z.output<typeof KbUploadDocumentInputSchema>

export const KbWorkspaceRefSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
}).strict()
export type KbWorkspaceRefInput = z.output<typeof KbWorkspaceRefSchema>

/**
 * LIST_COLLECTIONS input. `publishedOnly` is the composer's read side: it
 * returns only collections that can actually back a session scope, so a
 * selected collection can never silently resolve to zero references
 * (POO-108 review #16). The management app omits the flag and sees every
 * collection, including empty ones it uploads into.
 */
export const KbListCollectionsInputSchema = KbWorkspaceRefSchema.extend({
  publishedOnly: z.boolean().optional(),
}).strict()
export type KbListCollectionsInput = z.output<typeof KbListCollectionsInputSchema>

export const KbDocumentRefSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  docId: KbDocumentIdSchema,
}).strict()
export type KbDocumentRefInput = z.output<typeof KbDocumentRefSchema>

export const KbListDocumentsInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  collectionId: KbCollectionIdSchema,
}).strict()
export type KbListDocumentsInput = z.output<typeof KbListDocumentsInputSchema>

export const KbRejectDocumentInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  docId: KbDocumentIdSchema,
  reason: nonBlank(2_048),
}).strict()
export type KbRejectDocumentInput = z.output<typeof KbRejectDocumentInputSchema>

export const KbSearchInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  query: z.string().max(KB_SEARCH_QUERY_MAX_CHARS),
  collectionIds: z.array(KbCollectionIdSchema).max(100).optional(),
}).strict()
export type KbSearchInput = z.output<typeof KbSearchInputSchema>

export const KbSessionCollectionsInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  sessionId: KbSessionIdSchema,
  collectionIds: z.array(KbCollectionIdSchema).max(100),
}).strict()
export type KbSessionCollectionsInput = z.output<typeof KbSessionCollectionsInputSchema>

export const KbGetSessionCollectionsInputSchema = z.object({
  workspaceId: KbWorkspaceIdSchema,
  sessionId: KbSessionIdSchema,
}).strict()
export type KbGetSessionCollectionsInput = z.output<typeof KbGetSessionCollectionsInputSchema>

export const KbCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  documentCounts: z.object({
    draft: z.number().int().min(0),
    in_review: z.number().int().min(0),
    published: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }).strict(),
  canManage: z.boolean(),
}).strict()
export type KbCollection = z.output<typeof KbCollectionSchema>

/**
 * LIST_COLLECTIONS response. `canManage` is the space's authoritative
 * management capability derived from the trusted enterprise role — never
 * from whether any collection exists yet, otherwise the first collection of
 * an empty space could never be created (POO-108 review #6).
 */
export const KbCollectionListSchema = z.object({
  canManage: z.boolean(),
  collections: z.array(KbCollectionSchema),
}).strict()
export type KbCollectionList = z.output<typeof KbCollectionListSchema>

export const KbDocumentSummarySchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  title: z.string(),
  status: KbDocumentStatusSchema,
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
}).strict()
export type KbDocumentSummary = z.output<typeof KbDocumentSummarySchema>

export const KbDocumentSchema = KbDocumentSummarySchema.extend({
  content: z.string(),
}).strict()
export type KbDocument = z.output<typeof KbDocumentSchema>

/**
 * One ranked search hit. The storage backend is invisible on the wire (POO-108
 * v3.1): every hit carries the same shape regardless of where its score came
 * from, so the renderer cannot tell backends apart.
 */
export const KbSearchHitSchema = z.object({
  docId: z.string(),
  collectionId: z.string(),
  collectionName: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
}).strict()
export type KbSearchHit = z.output<typeof KbSearchHitSchema>

/**
 * The immutable per-message snapshot attached to a user message when the
 * session has a KB scope. Persisted with the message record and rendered as
 * reference chips; clearing the session selection never mutates it.
 * The type itself lives in @polo-ai/core (Message is defined there); the
 * schema below mirrors it for runtime validation at the RPC boundary.
 */
export const KbReferenceSchema = z.object({
  docId: z.string(),
  collectionId: z.string(),
  collectionName: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
}).strict()
export type { KbReference } from '@polo-ai/core/types'
