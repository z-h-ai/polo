// GENERATED FILE — do not edit by hand.
// Source of truth: polo-admin `src/lib/project-context/contracts.ts`.
// Contract: poo196-contract-r2 · source sha256: 6585ba04d93356a92711e46c810bbda4b0bdead1ee5f716d24ffc2ac1df255dd
// Regenerate: `tsx scripts/export-project-context-contract.ts <this-file>` (polo-admin repo);
// `--check` verifies no drift between the two repos.
import { z } from 'zod'

/**
 * POO-196 project-context HTTP contract — the SINGLE SOURCE OF TRUTH.
 *
 * Every wire shape the admin project-context surface exchanges with the Polo
 * client lives here. `scripts/export-project-context-contract.ts` transforms
 * this file deterministically into the client's
 * `packages/shared/src/admin/project-context-contract.ts`, so neither repo
 * ever hand-maintains a second copy of a field. Rules that keep the transform
 * honest:
 *
 * - self-contained: `zod` is the ONLY import; no Prisma, no admin runtime
 *   types, no `@/` aliases;
 * - wire-neutral: no vendor vocabulary (COS / OpenViking / presign) appears
 *   in any identifier, error code or comment that the transform copies;
 * - every object schema is `.strict()` — an unknown field is a contract
 *   breach, not an extension point.
 *
 * Architecture (POO-196 adjudication r1, binding): polo-admin is the ONLY
 * control plane for enterprise project assets — membership, metadata,
 * object authorization, index projection, async jobs and audit all live
 * server-side. Bytes go directly between the client and object storage via
 * short-lived, admin-signed, object-and-action-bound URLs; no long-lived
 * credential is ever handed to a client. The database (Prisma) is the sole
 * metadata authority; object storage keeps version originals; the project
 * index library is a rebuildable projection.
 */

/** Bumped with every wire-visible change; the client artifact records it. */
export const PC_CONTRACT_VERSION = "poo196-contract-r2";

/**
 * The error codes this surface may put on the wire. The client's i18n and
 * recovery UI branch on these; the transport of the admin HTTP client maps
 * anything outside the list to a neutral generic failure. Codes are stable:
 * never rename, only append.
 */
export const PC_ERROR_CODES = [
  "pc_forbidden",
  "pc_not_found",
  "pc_feature_disabled",
  "pc_read_only",
  "pc_library_not_ready",
  "pc_validation_error",
  "pc_revision_conflict",
  "pc_replace_not_uploader",
  "pc_confirmed_required",
  "pc_upload_not_found",
  "pc_upload_expired",
  "pc_upload_too_large",
  "pc_upload_failed",
  "pc_content_not_indexed",
  "pc_trash_expired",
  // Client-side transport codes (adjudication D7): an unreachable admin and
  // a signed-out member are distinct, actionable states.
  "pc_service_unavailable",
  "pc_signin_required",
] as const;
export type PcErrorCode = (typeof PC_ERROR_CODES)[number];

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export const PC_ROLES = ["owner", "manager", "member"] as const;
export type PcRole = (typeof PC_ROLES)[number];

/** Asset lifecycle. `purging`/`purged` exist server-side only — the wire
 * never advertises them; a purged asset reads as `pc_not_found`. */
export const PC_ASSET_STATUSES = ["active", "trashed"] as const;
export type PcAssetStatus = (typeof PC_ASSET_STATUSES)[number];

/** Content-processing state of one version. `unsupported` = stored and
 * downloadable, never full-text searchable (binary/large); `failed` keeps the
 * original downloadable and a retry path via rebuild. */
export const PC_PROCESSING_STATES = ["processing", "indexed", "failed", "unsupported"] as const;
export type PcProcessingState = (typeof PC_PROCESSING_STATES)[number];

/** List-filter vocabulary for the CURRENT version's processing state.
 * `available` = indexed + unsupported (a stored file that cannot be indexed
 * is still usable — never relabelled as full-text searchable); an asset whose
 * first version is not published yet counts as `processing`. The list
 * endpoint applies this BEFORE pagination so a filter answers over the whole
 * library, not the loaded page. */
export const PC_LIST_PROCESSING_FILTERS = ["processing", "indexed", "failed", "unsupported", "available"] as const;
export type PcListProcessingFilter = (typeof PC_LIST_PROCESSING_FILTERS)[number];

/**
 * Preset tag ids. Tags on the wire are stable ids for presets plus
 * member-defined free names. `confirmed` is deliberately NOT expressible as a
 * tag: it is a controlled, version-bound state with its own endpoints
 * (adjudication D1) — a client cannot sneak it into `tags` and any attempt is
 * a validation error. Display names for preset ids come from the client i18n,
 * never from the wire.
 */
export const PC_PRESET_TAG_IDS = [
  "source",
  "stage",
  "requirement",
  "design",
  "tech",
  "meeting",
  "data",
] as const;
export type PcPresetTagId = (typeof PC_PRESET_TAG_IDS)[number];
/** Reserved id that members cannot use as a custom tag nor send in `tags`. */
export const PC_CONTROLLED_TAG_ID = "confirmed";

/** Bound tag entry the list/summary endpoints return: preset ids ride as-is,
 * custom names are normalized (trimmed, whitespace-collapsed) and lowercased
 * for the id slot while `label` carries the member-facing original. */
export const PcTagSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(64),
    preset: z.boolean(),
  })
  .strict();
export type PcTag = z.output<typeof PcTagSchema>;

/* ------------------------------------------------------------------ */
/* Wire limits (validated here, enforced server-side beyond this)      */
/* ------------------------------------------------------------------ */

export const PC_NAME_MAX_CHARS = 512;
export const PC_TAG_MAX_COUNT = 8;
export const PC_TAG_MAX_CHARS = 64;
export const PC_QUERY_MAX_CHARS = 2_048;
export const PC_SOURCE_NOTE_MAX_CHARS = 512;
export const PC_LIST_LIMIT_MAX = 100;
export const PC_LIST_LIMIT_DEFAULT = 50;
/** Hard ceiling for `read` text bodies on the wire (bytes, UTF-8). */
export const PC_READ_MAX_BYTES = 512 * 1024;
/** Hard ceiling for the bounded project summary (chars). */
export const PC_SUMMARY_MAX_CHARS = 4_000;
export const PC_RECENT_LIMIT = 5;
/** Trash retention: 30 × 24 hours from `trashedAt` (adjudication D6). */
export const PC_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Short-lived download/preview grants: default 60s, ceiling 300s (D3.1.6). */
export const PC_DOWNLOAD_TTL_DEFAULT_SECONDS = 60;
export const PC_DOWNLOAD_TTL_MAX_SECONDS = 300;
/** Upload PUT grants: default 10 minutes (D3.1.6). */
export const PC_UPLOAD_GRANT_TTL_SECONDS = 600;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

const tagIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(PC_TAG_MAX_CHARS)
  .refine(
    (value) => value === normalizeTagId(value),
    "Tag id must already be normalized",
  );
const tagLabelSchema = z.string().trim().min(1).max(PC_TAG_MAX_CHARS);

/** Normalization shared by every tag entry point: presets keep their id,
 * custom names collapse internal whitespace. Exported for the service and
 * mirrored verbatim by the client contract (the transform copies it). */
export function normalizeTagId(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Validates a member-supplied tag list: deduped, bounded, never containing
 * the controlled id, custom ids never colliding with preset ids. Returns the
 * normalized `{ id, label, preset }` entries. */
export function parseTagList(
  raw: readonly string[],
): { ok: true; tags: PcTag[] } | { ok: false; reason: string } {
  if (raw.length > PC_TAG_MAX_COUNT) {
    return { ok: false, reason: `At most ${PC_TAG_MAX_COUNT} tags are allowed` };
  }
  const seen = new Set<string>();
  const tags: PcTag[] = [];
  for (const entry of raw) {
    const label = tagLabelSchema.safeParse(entry);
    if (!label.success) return { ok: false, reason: "Tag labels must be 1-64 characters" };
    const trimmed = label.data;
    const id = normalizeTagId(trimmed);
    if (id === PC_CONTROLLED_TAG_ID) {
      return { ok: false, reason: "This tag is managed by the project and cannot be set manually" };
    }
    if (seen.has(id)) continue;
    const preset = (PC_PRESET_TAG_IDS as readonly string[]).includes(id);
    if (!tagIdSchema.safeParse(id).success) {
      return { ok: false, reason: "Tag id normalization failed" };
    }
    seen.add(id);
    tags.push({ id, label: trimmed, preset });
  }
  return { ok: true, tags };
}

const nonBlank = (max: number) =>
  z.string().trim().min(1).max(max);

/* ------------------------------------------------------------------ */
/* Capability discovery                                                */
/* ------------------------------------------------------------------ */

export const PcCapabilitiesResponseSchema = z
  .object({
    featureEnabled: z.boolean(),
    /** Present only when featureEnabled is false: why the surface is closed. */
    disabledReason: z.enum(["not_configured", "storage_unavailable"]).optional(),
    role: z.enum(PC_ROLES),
    canManage: z.boolean(),
    /** Enterprise aggregate currently accepts project writes (D7). */
    canShare: z.boolean(),
    library: z.object({ status: z.enum(["none", "provisioning", "ready", "failed"]) }).strict(),
    /** User-actionable limits (no engine vocabulary, D1/R8a). */
    limits: z
      .object({
        maxUploadBytes: z.number().int().positive(),
        downloadUrlTtlSeconds: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type PcCapabilitiesResponse = z.output<typeof PcCapabilitiesResponseSchema>;

/* ------------------------------------------------------------------ */
/* Asset & version DTOs                                                */
/* ------------------------------------------------------------------ */

export const PcVersionDtoSchema = z
  .object({
    version: z.number().int().min(1),
    sizeBytes: z.number().int().positive(),
    mime: z.string().min(1).max(128),
    checksumSha256: z.string().length(64).nullable(),
    createdAt: z.string(),
    createdById: z.string(),
    processing: z.enum(PC_PROCESSING_STATES),
    /** Confirmed is version-bound (D1): replacing the file resets it. */
    confirmedAt: z.string().nullable(),
    confirmedByUserId: z.string().nullable(),
  })
  .strict();
export type PcVersionDto = z.output<typeof PcVersionDtoSchema>;

export const PcAssetDtoSchema = z
  .object({
    id: z.string(),
    name: nonBlank(PC_NAME_MAX_CHARS),
    tags: z.array(PcTagSchema).max(PC_TAG_MAX_COUNT),
    uploaderUserId: z.string(),
    uploaderDisplayName: z.string().nullable(),
    source: z
      .object({
        kind: z.enum(["file", "url", "session"]),
        note: z.string().max(PC_SOURCE_NOTE_MAX_CHARS).nullable(),
      })
      .strict(),
    status: z.enum(PC_ASSET_STATUSES),
    currentVersion: z.number().int().min(1),
    /** Optimistic-concurrency token for every metadata mutation (D4.1). */
    revision: z.number().int().min(1),
    pinned: z.boolean(),
    pinnedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    trashedAt: z.string().nullable(),
    trashExpiresAt: z.string().nullable(),
    deletedById: z.string().nullable(),
    current: PcVersionDtoSchema,
  })
  .strict();
export type PcAssetDto = z.output<typeof PcAssetDtoSchema>;

export const PcAssetListRequestQuerySchema = z
  .object({
    view: z.enum(["active", "trash"]).default("active"),
    /** Filter by tag id (normalized). Repeatable keys arrive joined. */
    tag: z.string().max(PC_TAG_MAX_CHARS).optional(),
    /** `confirmed` selects assets whose CURRENT version is confirmed. */
    pinned: z.enum(["true", "false"]).optional(),
    /** Current-version content state filter, applied server-side before
     * pagination (see PC_LIST_PROCESSING_FILTERS). */
    processing: z.enum(PC_LIST_PROCESSING_FILTERS).optional(),
    q: z.string().max(PC_QUERY_MAX_CHARS).optional(),
    limit: z.coerce.number().int().min(1).max(PC_LIST_LIMIT_MAX).default(PC_LIST_LIMIT_DEFAULT),
    cursor: z.string().max(256).optional(),
  })
  .strict();
export type PcAssetListRequestQuery = z.output<typeof PcAssetListRequestQuerySchema>;

export const PcAssetListResponseSchema = z
  .object({
    assets: z.array(PcAssetDtoSchema),
    nextCursor: z.string().optional(),
    canManage: z.boolean(),
  })
  .strict();
export type PcAssetListResponse = z.output<typeof PcAssetListResponseSchema>;

/* ------------------------------------------------------------------ */
/* Metadata mutations                                                  */
/* ------------------------------------------------------------------ */

export const PcUpdateAssetInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    name: nonBlank(PC_NAME_MAX_CHARS).optional(),
    /** Replaces the whole tag set (member-organizable tags only). */
    tags: z.array(z.string().min(1).max(PC_TAG_MAX_CHARS)).max(PC_TAG_MAX_COUNT).optional(),
  })
  .strict();
export type PcUpdateAssetInput = z.output<typeof PcUpdateAssetInputSchema>;

export const PcSetConfirmedInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    confirmed: z.boolean(),
  })
  .strict();
export type PcSetConfirmedInput = z.output<typeof PcSetConfirmedInputSchema>;

export const PcSetPinnedInputSchema = z
  .object({
    pinned: z.boolean(),
  })
  .strict();
export type PcSetPinnedInput = z.output<typeof PcSetPinnedInputSchema>;

export const PcRestoreInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
  })
  .strict();
export type PcRestoreInput = z.output<typeof PcRestoreInputSchema>;

export const PcMutationResponseSchema = z
  .object({
    asset: PcAssetDtoSchema,
  })
  .strict();
export type PcMutationResponse = z.output<typeof PcMutationResponseSchema>;

/* ------------------------------------------------------------------ */
/* Uploads (grant → direct PUT → complete)                             */
/* ------------------------------------------------------------------ */

export const PcCreateAssetInputSchema = z
  .object({
    name: nonBlank(PC_NAME_MAX_CHARS),
    tags: z.array(z.string().min(1).max(PC_TAG_MAX_CHARS)).max(PC_TAG_MAX_COUNT).default([]),
    source: z
      .object({
        kind: z.enum(["file", "url", "session"]),
        note: z.string().max(PC_SOURCE_NOTE_MAX_CHARS).optional(),
      })
      .strict()
      .optional(),
    sizeBytes: z.number().int().positive(),
    mime: z.string().min(1).max(128).default("application/octet-stream"),
    /** Declared by the uploader, verified against the stored object. */
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PcCreateAssetInput = z.output<typeof PcCreateAssetInputSchema>;

export const PcCreateUploadInputSchema = z
  .object({
    /** CAS guard: the caller saw this metadata revision. */
    expectedRevision: z.number().int().min(1),
    sizeBytes: z.number().int().positive(),
    mime: z.string().min(1).max(128).default("application/octet-stream"),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PcCreateUploadInput = z.output<typeof PcCreateUploadInputSchema>;

export const PcUploadGrantResponseSchema = z
  .object({
    assetId: z.string(),
    uploadId: z.string(),
    /** Candidate version this upload will publish on completion. */
    version: z.number().int().min(1),
    uploadUrl: z.string().min(1),
    method: z.literal("PUT"),
    /** Exactly the headers the uploader MUST send; the grant is bound to them. */
    requiredHeaders: z.record(z.string(), z.string()),
    expiresAt: z.string(),
    asset: PcAssetDtoSchema,
  })
  .strict();
export type PcUploadGrantResponse = z.output<typeof PcUploadGrantResponseSchema>;

export const PcCompleteUploadResponseSchema = z
  .object({
    /** False = verification still running; the version is NOT yet active and
     * the client must poll asset detail (never assume success, D3.1.4). */
    published: z.boolean(),
    asset: PcAssetDtoSchema,
  })
  .strict();
export type PcCompleteUploadResponse = z.output<typeof PcCompleteUploadResponseSchema>;

/* ------------------------------------------------------------------ */
/* Content access                                                      */
/* ------------------------------------------------------------------ */

export const PcDownloadResponseSchema = z
  .object({
    url: z.string().min(1),
    expiresAt: z.string(),
    name: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().positive(),
    disposition: z.literal("attachment"),
  })
  .strict();
export type PcDownloadResponse = z.output<typeof PcDownloadResponseSchema>;

export const PcReadResponseSchema = z
  .object({
    kind: z.literal("text"),
    version: z.number().int().min(1),
    content: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type PcReadResponse = z.output<typeof PcReadResponseSchema>;

export const PcPreviewResponseSchema = z
  .object({
    url: z.string().min(1),
    expiresAt: z.string(),
    mime: z.literal("text/html"),
  })
  .strict();
export type PcPreviewResponse = z.output<typeof PcPreviewResponseSchema>;

/* ------------------------------------------------------------------ */
/* Search (semantic with authorized metadata fallback, D7)             */
/* ------------------------------------------------------------------ */

export const PcSearchRequestQuerySchema = z
  .object({
    q: nonBlank(PC_QUERY_MAX_CHARS),
    tag: z.string().max(PC_TAG_MAX_CHARS).optional(),
    limit: z.coerce.number().int().min(1).max(PC_LIST_LIMIT_MAX).default(20),
  })
  .strict();
export type PcSearchRequestQuery = z.output<typeof PcSearchRequestQuerySchema>;

export const PcSearchResponseSchema = z
  .object({
    /** True = the index answered with metadata only; the client must say
     * "searching by name and tags only" and never fake full-text hits. */
    degraded: z.boolean(),
    hits: z
      .array(
        z
          .object({
            assetId: z.string(),
            version: z.number().int().min(1),
            name: z.string(),
            tags: z.array(PcTagSchema).max(PC_TAG_MAX_COUNT),
            snippet: z.string().max(2_000).nullable(),
            score: z.number().nullable(),
          })
          .strict(),
      )
      .max(PC_LIST_LIMIT_MAX),
  })
  .strict();
export type PcSearchResponse = z.output<typeof PcSearchResponseSchema>;

/* ------------------------------------------------------------------ */
/* Summary & jobs                                                      */
/* ------------------------------------------------------------------ */

export const PcSummaryResponseSchema = z
  .object({
    generatedAt: z.string(),
    assetCount: z.number().int().min(0),
    confirmedCount: z.number().int().min(0),
    overview: z.string().max(PC_SUMMARY_MAX_CHARS),
    recent: z
      .array(
        z
          .object({
            assetId: z.string(),
            name: z.string(),
            version: z.number().int().min(1),
            updatedAt: z.string(),
            tags: z.array(PcTagSchema).max(PC_TAG_MAX_COUNT),
          })
          .strict(),
      )
      .max(PC_RECENT_LIMIT),
  })
  .strict();
export type PcSummaryResponse = z.output<typeof PcSummaryResponseSchema>;

export const PcRebuildResponseSchema = z
  .object({
    jobId: z.string(),
  })
  .strict();
export type PcRebuildResponse = z.output<typeof PcRebuildResponseSchema>;

/* ------------------------------------------------------------------ */
/* Error envelope                                                      */
/* ------------------------------------------------------------------ */

export const PcErrorEnvelopeSchema = z
  .object({
    /** Stable pc_* code (see PC_ERROR_CODES). */
    error: z.enum(PC_ERROR_CODES),
    message: z.string().max(512),
    requestId: z.string().optional(),
    details: z
      .object({
        /** Present on pc_revision_conflict: the current authoritative revision. */
        currentRevision: z.number().int().min(1).optional(),
        /** Present on pc_content_not_indexed / processing-bound failures. */
        processing: z.enum(PC_PROCESSING_STATES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PcErrorEnvelope = z.output<typeof PcErrorEnvelopeSchema>;
