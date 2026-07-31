import { z } from 'zod'
import { HARD_SKILL_ARCHIVE_POLICY } from './types'

const entityId = z.string().trim().min(1).max(512)
const isoDate = z.string().datetime({ offset: true })
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const stableSemver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const skillSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const localSkillBasename = z.string()
  .min(1)
  .max(255)
  .refine(value => (
    value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
  ))
const idempotencyKey = z.string().min(1).max(128).regex(/^[\x21-\x7E]+$/)
export const CreatorSkillOperationIdSchema = z.string().uuid()

export const SkillArchivePolicySchema = z.object({
  version: z.string().min(1).max(128),
  maxArchiveBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes),
  maxFileCount: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  maxFileBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  maxExpandedBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes),
})

export const SkillValidationIssueSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(['error', 'warning']),
  path: z.string().max(4_096),
  field: z.string().max(256).optional(),
  message: z.string().min(1).max(4_096),
  suggestion: z.string().max(4_096).optional(),
})

export const SkillVersionMetadataSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().min(1).max(8_192),
  globs: z.array(z.string().max(2_048)).max(1_000).optional(),
  alwaysAllow: z.array(z.string().max(512)).max(1_000).optional(),
  icon: z.string().max(64).optional(),
  requiredSources: z.array(z.string().max(512)).max(1_000).optional(),
})

const creatorArtifactBaseSchema = z.object({
  id: entityId,
  organizationId: entityId,
  name: z.string().max(512).optional(),
  summary: z.string().max(8_192).optional(),
  displayIcon: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('emoji'), value: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('image'), url: z.string().url().max(8_192) }),
  ]).optional(),
  status: z.enum(['draft', 'published', 'archived']),
  latestPublishedVersion: stableSemver.optional(),
  createdByUserId: entityId,
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: isoDate.optional(),
  archivedByUserId: entityId.optional(),
})

export const CreatorArtifactSchema = z.discriminatedUnion('type', [
  creatorArtifactBaseSchema.extend({
    type: z.literal('web_app'),
    // Legacy Web App slugs are opaque to the desktop client.
    slug: z.string().trim().min(1).max(512),
  }),
  creatorArtifactBaseSchema.extend({
    type: z.literal('skill'),
    slug: skillSlug,
  }),
])

export const CreatorArtifactVersionSchema = z.object({
  id: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: z.string().max(2_000).optional(),
  status: z.enum([
    'upload_pending',
    'uploaded',
    'validating',
    'validation_failed',
    'validated',
    'published',
    'revoked',
    'expired',
  ]),
  archiveChecksum: checksum.optional(),
  contentDigest: checksum.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: isoDate,
  publishedAt: isoDate.optional(),
  publishedByUserId: entityId.optional(),
  revokedAt: isoDate.optional(),
  revokedByUserId: entityId.optional(),
  revocationReason: z.string().max(2_000).optional(),
  validationPolicy: SkillArchivePolicySchema.optional(),
  uploadGeneration: z.number().int().nonnegative(),
  validatorVersion: z.string().max(128).optional(),
  validatedArchiveChecksum: checksum.optional(),
  validatedAt: isoDate.optional(),
  metadata: SkillVersionMetadataSchema.optional(),
  validationIssues: z.array(SkillValidationIssueSchema).max(10_000).optional(),
})

export const CreatorArtifactCapabilitySchema = z.object({
  creatorSkillArtifacts: z.boolean(),
})

export const CreatorArtifactCatalogPageSchema = z.object({
  artifacts: z.array(CreatorArtifactSchema),
  nextCursor: z.string().max(2_048).optional(),
})

export const CreatorArtifactDetailSchema = z.object({
  artifact: CreatorArtifactSchema,
  versions: z.array(CreatorArtifactVersionSchema),
  selectedVersion: stableSemver.optional(),
  skillContent: z.string().max(5 * 1024 * 1024).optional(),
  fileTree: z.array(z.object({
    path: z.string().max(4_096),
    size: z.number().int().nonnegative(),
    sha256: checksum.optional(),
  })).max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount).optional(),
  reference: z.object({
    path: z.string().min(1).max(4_096),
    content: z.string().max(5 * 1024 * 1024).optional(),
    downloadUrl: z.string().url().max(8_192).optional(),
  }).optional(),
})

export const CreatorArtifactMutationResponseSchema = z.object({
  artifact: CreatorArtifactSchema,
  replayed: z.boolean().optional(),
})

export const CreatorArtifactVersionMutationResponseSchema = z.object({
  version: CreatorArtifactVersionSchema,
  replayed: z.boolean().optional(),
})

export const CreatorSkillUploadGrantSchema = z.object({
  method: z.literal('PUT'),
  url: z.string().url().max(8_192),
  headers: z.record(z.string(), z.string().max(8_192)).optional(),
  expiresAt: isoDate,
  uploadGeneration: z.number().int().positive(),
})

export const CreatorSkillManifestEntrySchema = z.object({
  path: z.string().min(1).max(4_096),
  size: z.number().int().nonnegative().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  sha256: checksum,
})

export const CreatorSkillDownloadGrantSchema = z.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  url: z.string().url().max(8_192),
  expiresAt: isoDate,
  archiveChecksum: checksum,
  contentDigest: checksum,
  manifest: z.array(CreatorSkillManifestEntrySchema)
    .max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  validationPolicy: SkillArchivePolicySchema,
})

export const CreatorSkillSafetyStatusSchema = z.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  status: z.enum(['active', 'revoked', 'archived']),
  safeVersion: stableSemver.optional(),
})

export const CreatorSkillSafetyStatusBatchSchema = z.object({
  statuses: z.array(CreatorSkillSafetyStatusSchema).max(1_000),
})

export const InstalledCreatorSkillSchema = z.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  archiveChecksum: checksum,
  contentDigest: checksum,
  installedAt: isoDate,
  lastKnownStatus: z.enum(['active', 'revoked', 'archived']).optional(),
  lastCheckedAt: isoDate.optional(),
  ignoredVersion: stableSemver.optional(),
})

export const CreatorSkillsLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  installed: z.array(InstalledCreatorSkillSchema),
})

export const CreateCreatorArtifactRpcInputSchema = z.object({
  organizationId: entityId,
  type: z.literal('skill'),
  slug: skillSlug,
  idempotencyKey,
}).strict()

export const CreatorArtifactListRpcInputSchema = z.object({
  organizationId: entityId,
  type: z.enum(['web_app', 'skill']).optional(),
  includeDrafts: z.boolean().optional(),
  cursor: z.string().max(2_048).optional(),
}).strict()

export const CreatorArtifactIdRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver.optional(),
  referencePath: z.string()
    .min(1)
    .max(4_096)
    .regex(
      /^references\/(?!\/)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/\/).+$/,
    )
    .optional(),
}).strict().refine(
  input => !input.referencePath || Boolean(input.version),
  { message: 'referencePath requires version', path: ['referencePath'] },
)

export const CreateCreatorArtifactVersionRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: z.string().trim().min(1).max(2_000).optional(),
  idempotencyKey,
}).strict()

export const CreatorArtifactVersionRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  versionId: entityId,
  idempotencyKey,
}).strict()

export const CreatorArtifactArchiveRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  archived: z.boolean(),
  idempotencyKey,
}).strict()

export const CreatorArtifactUploadRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  versionId: entityId,
  archivePath: z.string().min(1).max(32_768),
  operationId: CreatorSkillOperationIdSchema,
  idempotencyKey,
}).strict()

export const CreatorArtifactRevokeRpcInputSchema =
  CreatorArtifactVersionRpcInputSchema.extend({
    reason: z.string().trim().min(1).max(2_000),
  }).strict()

export const CreatorSkillDownloadRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
}).strict()

export const CreatorSkillTargetRpcInputSchema = z.object({
  workspaceId: entityId,
}).strict()

export const DeleteSkillRpcInputSchema = z.object({
  workspaceId: entityId,
  skillSlug: localSkillBasename,
}).strict()

export const CreatorSkillSafetyRpcInputSchema = z.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
}).strict()

export const CreatorSkillInstallRpcInputSchema = z.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  grant: CreatorSkillDownloadGrantSchema,
  replaceExisting: z.boolean().optional(),
  confirmGlobalOverride: z.boolean().optional(),
  backupLocalChanges: z.boolean().optional(),
}).strict()

export const CreatorSkillUninstallRpcInputSchema = z.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  slug: skillSlug,
  forceDeleteModified: z.boolean().optional(),
  forceDeleteCredential: z.string().min(32).max(256).optional(),
}).strict()

export const CreatorSkillBackupRpcInputSchema = z.object({
  workspaceId: entityId,
}).strict()

export const CreatorSkillBackupDeleteRpcInputSchema = z.object({
  workspaceId: entityId,
  backup: z.object({
    slug: skillSlug,
    backupId: z.string().regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    ),
  }).strict().optional(),
}).strict()

export const CreatorSkillStatusUpdateRpcInputSchema = z.object({
  workspaceId: entityId,
  status: CreatorSkillSafetyStatusSchema,
  checkedAt: isoDate,
}).strict()

export const CreatorSkillIgnoreVersionRpcInputSchema = z.object({
  workspaceId: entityId,
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  ignoredVersion: stableSemver,
}).strict()

export const StableSemverSchema = stableSemver
export const SkillSlugSchema = skillSlug
