import { z } from 'zod'
import {
  PC_LIST_LIMIT_MAX,
  PC_LIST_PROCESSING_FILTERS,
  PC_QUERY_MAX_CHARS,
  PC_TAG_MAX_CHARS,
  PcRestoreInputSchema,
  PcSetConfirmedInputSchema,
  PcSetPinnedInputSchema,
  PcUpdateAssetInputSchema,
} from '../admin/project-context-contract'

/**
 * Enterprise Project Context (POO-196) wire contracts — the client side.
 *
 * Project assets are an ADMIN control-plane domain (adjudication r1): polo-admin
 * owns membership, metadata, object authorization and the index projection, so
 * every wire shape the AdminClient exchanges is GENERATED in
 * `../admin/project-context-contract.ts` and re-exported here untouched. This
 * file adds only what the RPC boundary needs on top:
 *
 * - the LOCAL_ONLY channel payload schemas (workspace-scoped inputs wrapping
 *   the generated contract schemas);
 * - the `pc_*` transport error codes, re-exported for the transport whitelist
 *   in `./types.ts` (same mechanism as KB_ERROR_CODES);
 * - the persisted `projectAssetRefs` snapshot and the internal-only
 *   `projectModelContext` that travel with a user message (mirrors
 *   the project asset references).
 *
 * Bytes never transit the RPC: the renderer hands over a local file path and
 * the trusted main/server side streams it through the short-lived, object-bound
 * URLs the admin grants — no transfer URL is ever exposed to the renderer.
 */

// The generated contract is the single source of truth for DTO shapes, limits
// and error codes. Re-exporting keeps protocol consumers (transport whitelist,
// electron preload types, server-core) on `@polo-ai/shared/protocol` without a
// second import path — and without ever hand-copying a field.
export * from '../admin/project-context-contract'

/**
 * pc_* codes this client raises at its OWN boundary (never returned by the
 * admin wire, so they must not live in the generated PC_ERROR_CODES): the
 * workspace scope check that refuses to run project files outside an
 * enterprise project, and the local download-to-disk failure (review R-6) —
 * a missing name, a containment refusal or a broken stream is NOT the admin
 * service being down, and the two must not share one "service unavailable"
 * copy. Registered in the transport whitelist through `./types.ts` so the
 * coded-error bridge can carry them to the renderer.
 */
export const PC_LOCAL_ERROR_CODES = [
  'pc_unavailable_in_personal',
  'pc_download_failed',
  // POO-210 batch upload staging: raised by the LOCAL stage/scan channels at
  // the trusted side's own boundary (the admin wire never sees them). The
  // renderer maps each to its own recovery copy — a 200MB+ archive, a bomb
  // guard trip, a corrupt zip, an unreadable source and a staging write
  // failure are five different user-facing sentences.
  'pc_stage_zip_too_large',
  'pc_stage_zip_bomb',
  'pc_stage_zip_invalid',
  'pc_stage_read_failed',
  'pc_stage_write_failed',
] as const
export type PcLocalErrorCode = (typeof PC_LOCAL_ERROR_CODES)[number]

/**
 * The workspace gate message shape. Every project-context RPC names the local
 * workspace it runs against (same non-blank bound as the KB scope).
 */
const nonBlank = (maxLength: number) => z.string()
  .max(maxLength)
  .refine(value => value.trim().length > 0, 'Must be a non-blank string')

export const PcWorkspaceIdSchema = nonBlank(512)
export const PcProductSpaceIdSchema = nonBlank(512)
// POO-205: the project (not the space) owns its shared-file area — every
// asset RPC now addresses BOTH the organization space and the project inside
// it, so a project's files are unreachable from any other project or space.
export const PcProjectIdSchema = nonBlank(512)
export const PcAssetIdSchema = nonBlank(128)
export const PcUploadIdSchema = nonBlank(128)

/** Workspace-only scope shared by every channel. */
export const PcIpcWorkspaceScopeSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
}).strict()
export type PcIpcWorkspaceScopeInput = z.output<typeof PcIpcWorkspaceScopeSchema>

const PcIpcAssetScopeSchema = PcIpcWorkspaceScopeSchema.extend({
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
}).strict()

const PcOptionalVersionSchema = z.number().int().min(1).optional()

/* ------------------------------------------------------------------ */
/* Channel input schemas (LOCAL_ONLY RPC payloads)                     */
/* ------------------------------------------------------------------ */

export const PcListCapabilitiesInputSchema = PcIpcAssetScopeSchema.extend({}).strict()
export type PcListCapabilitiesInput = z.output<typeof PcListCapabilitiesInputSchema>

export const PcGetSummaryInputSchema = PcIpcAssetScopeSchema.extend({}).strict()
export type PcGetSummaryInput = z.output<typeof PcGetSummaryInputSchema>

export const PcListAssetsInputSchema = PcIpcAssetScopeSchema.extend({
  view: z.enum(['active', 'trash']).optional(),
  tag: z.string().max(PC_TAG_MAX_CHARS).optional(),
  pinned: z.enum(['true', 'false']).optional(),
  /** Current-version content state filter, pushed through to the admin list
   * endpoint so filtering happens BEFORE pagination (consensus X10). */
  processing: z.enum(PC_LIST_PROCESSING_FILTERS).optional(),
  q: z.string().max(PC_QUERY_MAX_CHARS).optional(),
  limit: z.number().int().min(1).max(PC_LIST_LIMIT_MAX).optional(),
  cursor: z.string().max(256).optional(),
}).strict()
export type PcListAssetsInput = z.output<typeof PcListAssetsInputSchema>

export const PcGetAssetInputSchema = PcIpcAssetScopeSchema.extend({
  assetId: PcAssetIdSchema,
}).strict()
export type PcGetAssetInput = z.output<typeof PcGetAssetInputSchema>

/**
 * The single upload RPC (the renderer never holds a transfer URL): the
 * trusted side creates the asset/upload grants, streams `filePath` straight
 * to the granted URL and completes the upload, answering with the same
 * `{ published, asset }` the admin complete endpoint returns. `mode:
 * 'replace'` requires `assetId` + `expectedRevision` (CAS against the
 * revision the caller saw); those fields must be absent for 'create'.
 */
export const PcUploadFileInputSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  mode: z.enum(['create', 'replace']),
  filePath: z.string().min(1),
  name: nonBlank(512),
  tags: z.array(z.string().min(1).max(64)).max(8).default([]),
  source: z.object({
    kind: z.enum(['file', 'url', 'session']),
    note: z.string().max(512).optional(),
  }).strict().optional(),
  sizeBytes: z.number().int().min(1),
  mime: z.string().max(128).optional(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  assetId: z.string().min(1).optional(),
  expectedRevision: z.number().int().min(1).optional(),
}).strict()
export type PcUploadFileInput = z.output<typeof PcUploadFileInputSchema>

export const PcUpdateAssetIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  input: PcUpdateAssetInputSchema,
}).strict()
export type PcUpdateAssetIpcInput = z.output<typeof PcUpdateAssetIpcSchema>

export const PcSetConfirmedIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  input: PcSetConfirmedInputSchema,
}).strict()
export type PcSetConfirmedIpcInput = z.output<typeof PcSetConfirmedIpcSchema>

export const PcSetPinnedIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  input: PcSetPinnedInputSchema,
}).strict()
export type PcSetPinnedIpcInput = z.output<typeof PcSetPinnedIpcSchema>

export const PcTrashAssetIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  expectedRevision: z.number().int().min(1),
}).strict()
export type PcTrashAssetIpcInput = z.output<typeof PcTrashAssetIpcSchema>

export const PcRestoreIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  input: PcRestoreInputSchema,
}).strict()
export type PcRestoreIpcInput = z.output<typeof PcRestoreIpcSchema>

/**
 * Download-to-disk RPC: the trusted side fetches the short-lived attachment
 * grant and streams the object to `targetPath`, answering with the absolute
 * `savedPath` the renderer may reveal/open.
 */
export const PcDownloadAssetInputSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  version: PcOptionalVersionSchema,
  targetPath: z.string().min(1),
}).strict()
export type PcDownloadAssetInput = z.output<typeof PcDownloadAssetInputSchema>

export const PcDownloadFileOutputSchema = z.object({
  savedPath: z.string(),
}).strict()
export type PcDownloadFileOutput = z.output<typeof PcDownloadFileOutputSchema>

export const PcReadAssetIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  version: PcOptionalVersionSchema,
}).strict()
export type PcReadAssetIpcInput = z.output<typeof PcReadAssetIpcSchema>

export const PcGetPreviewUrlIpcSchema = z.object({
  workspaceId: PcWorkspaceIdSchema,
  productSpaceId: PcProductSpaceIdSchema,
  projectId: PcProjectIdSchema,
  assetId: PcAssetIdSchema,
  version: PcOptionalVersionSchema,
}).strict()
export type PcGetPreviewUrlIpcInput = z.output<typeof PcGetPreviewUrlIpcSchema>

export const PcSearchAssetsInputSchema = PcIpcAssetScopeSchema.extend({
  q: nonBlank(PC_QUERY_MAX_CHARS),
  tag: z.string().max(PC_TAG_MAX_CHARS).optional(),
  limit: z.number().int().min(1).max(PC_LIST_LIMIT_MAX).optional(),
}).strict()
export type PcSearchAssetsInput = z.output<typeof PcSearchAssetsInputSchema>

export const PcRebuildInputSchema = PcIpcAssetScopeSchema.extend({}).strict()
export type PcRebuildInput = z.output<typeof PcRebuildInputSchema>

/* ------------------------------------------------------------------ */
/* POO-210 batch upload staging (LOCAL_ONLY, transport-layer only)     */
/* ------------------------------------------------------------------ */

/**
 * D5's submit budget: the batch checklist's DEFAULT selection never exceeds
 * this many entries. The overflow stays listed and unchecked — the caller
 * explains (`defaultedDown`), never silently drops.
 */
export const PC_BATCH_SUBMIT_MAX = 500

/**
 * The batch upload entry list (zip unpack / folder scan). Deliberately NOT
 * part of the admin project-context contract: staging happens entirely on
 * the trusted local side — the admin never sees a batch, only the resulting
 * `pcUploadFile` calls, one per entry, in the unchanged single-file shape.
 * `reason` is the stable exclusion vocabulary the renderer maps to copy;
 * `stagedPath` is a real local file the upload RPC streams ("" for entries
 * that cannot be uploaded at all) — a zip entry name never becomes a
 * filesystem path here. A zip batch's LAST entry is the archive itself
 * (D3c): `included: false`, uploading the original file if the user checks it.
 */
export const PC_BATCH_EXCLUSION_REASONS = [
  'hidden',
  'dependency_dir',
  'binary_format',
  'empty',
  'too_large',
  'symlink',
] as const
export type PcBatchExclusionReason = (typeof PC_BATCH_EXCLUSION_REASONS)[number]

export const PcBatchSourceEntrySchema = z.object({
  entryId: z.string().min(1),
  sourcePath: z.string(),
  displayName: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  included: z.boolean(),
  reason: z.enum(PC_BATCH_EXCLUSION_REASONS).nullable(),
  stagedPath: z.string(),
}).strict()
export type PcBatchSourceEntry = z.output<typeof PcBatchSourceEntrySchema>

export const PcStageZipBatchInputSchema = PcIpcAssetScopeSchema.extend({
  zipPath: z.string().min(1),
  maxEntryBytes: z.number().int().min(1),
}).strict()
export type PcStageZipBatchInput = z.output<typeof PcStageZipBatchInputSchema>

export const PcStagedZipBatchResponseSchema = z.object({
  batchId: z.string().regex(/^[0-9a-f]{32}$/),
  entries: z.array(PcBatchSourceEntrySchema),
  /** True when the entry count hit the scan ceiling — the caller must say so. */
  truncated: z.boolean(),
}).strict()
export type PcStagedZipBatchResponse = z.output<typeof PcStagedZipBatchResponseSchema>

export const PcScanFolderInputSchema = PcIpcAssetScopeSchema.extend({
  folderPath: z.string().min(1),
  maxEntryBytes: z.number().int().min(1),
}).strict()
export type PcScanFolderInput = z.output<typeof PcScanFolderInputSchema>

export const PcScanFolderResponseSchema = z.object({
  entries: z.array(PcBatchSourceEntrySchema),
  truncated: z.boolean(),
}).strict()
export type PcScanFolderResponse = z.output<typeof PcScanFolderResponseSchema>

export const PcStageCleanupInputSchema = z.object({
  batchId: z.string().regex(/^[0-9a-f]{32}$/),
}).strict()
export type PcStageCleanupInput = z.output<typeof PcStageCleanupInputSchema>

export const PcStageCleanupResponseSchema = z.object({
  cleaned: z.boolean(),
}).strict()
export type PcStageCleanupResponse = z.output<typeof PcStageCleanupResponseSchema>

/* ------------------------------------------------------------------ */
/* Message-borne payloads (project asset references)                  */
/* ------------------------------------------------------------------ */

/**
 * The persisted per-reference snapshot attached to a user message when the
 * composer carried an @ project-asset mention. The SERVER resolves each
 * mention at send time and stamps the outcome here — `status` tells the
 * renderer which references did not resolve (adjudication D7), and `snippet`
 * is a bounded excerpt of the resolved content. Persisted with the message
 * record; a point-in-time snapshot that later asset changes never rewrite.
 * The type lives here (not in @polo-ai/core) because only the client wire
 * needs it today.
 */
export const PcProjectAssetReferenceSchema = z.object({
  assetId: z.string().min(1),
  version: z.number().int().min(1),
  name: z.string().max(512),
  status: z.enum(['ok', 'missing', 'stale', 'failed']),
  snippet: z.string().max(2_000).nullable(),
}).strict()
export type ProjectAssetReference = z.output<typeof PcProjectAssetReferenceSchema>

/**
 * Server-assembled project-context injection for this turn — staged by the
 * SessionManager for a ONE-SHOT prompt injection, exactly like
 * the resolved project model context. Internal only: never persisted, never part of the message
 * record, and a client-supplied value is always dropped.
 */
export const PcProjectModelContextSchema = z.object({
  block: z.string(),
  docs: z.number().int().min(0),
  bytes: z.number().int().min(0),
}).strict()
export type PcProjectModelContext = z.output<typeof PcProjectModelContextSchema>
