import { z } from 'zod'

/**
 * Enterprise Knowledge Base (POO-108) wire contracts.
 *
 * The KB is a local, workspace-scoped service domain: content lives under the
 * workspace's `.polo-kb/` directory and every RPC is LOCAL_ONLY. These schemas
 * define both the RPC payloads and the persisted `kbReferences` snapshot that
 * travels on user messages.
 */

export const KB_MAX_CONTENT_BYTES = 2 * 1024 * 1024
export const KB_SEARCH_LIMIT = 20
/** Per-collection hit cap used by the send-time reference lookup. */
export const KB_SEARCH_PER_COLLECTION_LIMIT = 3
export const KB_SNIPPET_CONTEXT_CHARS = 80

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
  query: z.string().max(32_768),
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
