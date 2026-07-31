// packages/shared/src/creator-skills/schemas.ts
import { z } from "zod";

// packages/shared/src/creator-skills/types.ts
var DEFAULT_SKILL_ARCHIVE_POLICY = {
  version: "1",
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024
};
var HARD_SKILL_ARCHIVE_POLICY = {
  version: "hard-1",
  maxArchiveBytes: 100 * 1024 * 1024,
  maxFileCount: 1e3,
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024
};

// packages/shared/src/creator-skills/schemas.ts
var entityId = z.string().trim().min(1).max(512);
var isoDate = z.string().datetime({ offset: true });
var checksum = z.string().trim().transform((value) => value.toLowerCase().replace(/^sha256:/, "")).pipe(z.string().regex(/^[a-f0-9]{64}$/));
var stableSemver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
var skillSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var localSkillBasename = z.string().min(1).max(255).refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0"));
var idempotencyKey = z.string().min(1).max(128).regex(/^[\x21-\x7E]+$/);
var CreatorSkillOperationIdSchema = z.string().uuid();
var nonnegativeSafeInteger = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform((value) => Number(value))
]).refine((value) => Number.isSafeInteger(value) && value >= 0);
function nullableOptional(schema) {
  return schema.nullish().transform((value) => value ?? void 0).optional();
}
var SkillArchivePolicySchema = z.object({
  version: z.string().min(1).max(128),
  maxArchiveBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes),
  maxFileCount: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  maxFileBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  maxExpandedBytes: z.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes)
});
var SkillValidationIssueSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(["error", "warning"]),
  path: z.string().max(4096),
  field: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  suggestion: z.string().max(4096).optional()
});
var SkillVersionMetadataSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().min(1).max(8192),
  globs: z.array(z.string().max(2048)).max(1e3).optional(),
  alwaysAllow: z.array(z.string().max(512)).max(1e3).optional(),
  icon: z.string().max(64).optional(),
  requiredSources: z.array(z.string().max(512)).max(1e3).optional()
});
var creatorArtifactBaseSchema = z.object({
  id: entityId,
  organizationId: entityId,
  name: nullableOptional(z.string().max(512)),
  summary: nullableOptional(z.string().max(8192)),
  displayIcon: nullableOptional(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("emoji"), value: z.string().min(1).max(64) }),
    z.object({ kind: z.literal("image"), url: z.string().url().max(8192) })
  ])),
  status: z.enum(["draft", "published", "archived"]),
  latestPublishedVersion: nullableOptional(stableSemver),
  createdByUserId: entityId,
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: nullableOptional(isoDate),
  archivedByUserId: nullableOptional(entityId)
});
var CreatorArtifactSchema = z.discriminatedUnion("type", [
  creatorArtifactBaseSchema.extend({
    type: z.literal("web_app"),
    // Legacy Web App slugs are opaque to the desktop client.
    slug: z.string().trim().min(1).max(512)
  }),
  creatorArtifactBaseSchema.extend({
    type: z.literal("skill"),
    slug: skillSlug
  })
]);
var CreatorArtifactVersionSchema = z.object({
  id: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: nullableOptional(z.string().max(2e3)),
  status: z.enum([
    "upload_pending",
    "uploaded",
    "validating",
    "validation_failed",
    "validated",
    "published",
    "revoked",
    "expired"
  ]),
  archiveChecksum: nullableOptional(checksum),
  contentDigest: nullableOptional(checksum),
  sizeBytes: nullableOptional(nonnegativeSafeInteger),
  createdAt: isoDate,
  publishedAt: nullableOptional(isoDate),
  publishedByUserId: nullableOptional(entityId),
  revokedAt: nullableOptional(isoDate),
  revokedByUserId: nullableOptional(entityId),
  revocationReason: nullableOptional(z.string().max(2e3)),
  validationPolicy: nullableOptional(SkillArchivePolicySchema),
  uploadGeneration: z.number().int().nonnegative(),
  validatorVersion: nullableOptional(z.string().max(128)),
  validatedArchiveChecksum: nullableOptional(checksum),
  validatedAt: nullableOptional(isoDate),
  metadata: nullableOptional(SkillVersionMetadataSchema),
  validationIssues: nullableOptional(z.array(SkillValidationIssueSchema).max(1e4))
});
var CreatorArtifactCapabilitySchema = z.object({
  creatorSkillArtifacts: z.boolean()
});
var CreatorArtifactCatalogPageSchema = z.object({
  artifacts: z.array(CreatorArtifactSchema),
  nextCursor: z.string().max(2048).optional()
});
var CreatorArtifactDetailSchema = z.object({
  artifact: CreatorArtifactSchema,
  versions: z.array(CreatorArtifactVersionSchema),
  selectedVersion: nullableOptional(stableSemver),
  // Zod's string max is measured in UTF-16 code units, while the archive
  // policy is expressed in bytes.  Keep the transport boundary aligned with
  // the absolute archive limit and validate the actual UTF-8 representation.
  skillContent: z.string().superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > HARD_SKILL_ARCHIVE_POLICY.maxFileBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        origin: "string",
        maximum: HARD_SKILL_ARCHIVE_POLICY.maxFileBytes,
        inclusive: true,
        type: "string",
        message: "SKILL.md exceeds the maximum UTF-8 byte length"
      });
    }
  }).optional(),
  fileTree: z.array(z.object({
    path: z.string().max(4096),
    size: z.number().int().nonnegative(),
    sha256: checksum.optional()
  })).max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount).optional(),
  reference: z.object({
    path: z.string().min(1).max(4096),
    content: z.string().max(5 * 1024 * 1024).optional(),
    downloadUrl: z.string().url().max(8192).optional()
  }).optional()
});
var CreatorArtifactMutationResponseSchema = z.object({
  artifact: CreatorArtifactSchema,
  replayed: z.boolean().optional()
});
var CreatorArtifactVersionMutationResponseSchema = z.object({
  version: CreatorArtifactVersionSchema,
  replayed: z.boolean().optional()
});
var CreatorSkillUploadGrantSchema = z.object({
  method: z.literal("PUT"),
  url: z.string().url().max(8192),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
  expiresAt: isoDate,
  uploadGeneration: z.number().int().positive()
});
var CreatorArtifactVersionCreatedResponseSchema = z.object({
  version: CreatorArtifactVersionSchema,
  upload: CreatorSkillUploadGrantSchema,
  replayed: z.boolean().optional()
});
var CreatorSkillManifestEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  sha256: checksum
});
var CreatorSkillDownloadGrantSchema = z.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  url: z.string().url().max(8192),
  expiresAt: isoDate,
  archiveChecksum: checksum,
  contentDigest: checksum,
  manifest: z.array(CreatorSkillManifestEntrySchema).max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  validationPolicy: SkillArchivePolicySchema
});
var CreatorSkillSafetyStatusSchema = z.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  status: z.enum(["active", "revoked", "archived"]),
  safeVersion: stableSemver.optional()
});
var CreatorSkillSafetyStatusBatchSchema = z.object({
  statuses: z.array(CreatorSkillSafetyStatusSchema).max(1e3)
});
var InstalledCreatorSkillSchema = z.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  archiveChecksum: checksum,
  contentDigest: checksum,
  installedAt: isoDate,
  lastKnownStatus: z.enum(["active", "revoked", "archived"]).optional(),
  lastCheckedAt: isoDate.optional(),
  ignoredVersion: stableSemver.optional()
});
var CreatorSkillsLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  installed: z.array(InstalledCreatorSkillSchema)
});
var CreateCreatorArtifactRpcInputSchema = z.object({
  organizationId: entityId,
  type: z.literal("skill"),
  slug: skillSlug,
  idempotencyKey
}).strict();
var CreatorArtifactListRpcInputSchema = z.object({
  organizationId: entityId,
  type: z.enum(["web_app", "skill"]).optional(),
  includeDrafts: z.boolean().optional(),
  cursor: z.string().max(2048).optional()
}).strict();
var CreatorArtifactIdRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver.optional(),
  referencePath: z.string().min(1).max(4096).regex(
    /^references\/(?!\/)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/\/).+$/
  ).optional()
}).strict().refine(
  (input) => !input.referencePath || Boolean(input.version),
  { message: "referencePath requires version", path: ["referencePath"] }
);
var CreateCreatorArtifactVersionRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: z.string().trim().min(1).max(2e3).optional(),
  idempotencyKey
}).strict();
var CreatorArtifactVersionRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  idempotencyKey
}).strict();
var CreatorArtifactArchiveRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  archived: z.boolean(),
  idempotencyKey
}).strict();
var CreatorArtifactUploadGrantRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  idempotencyKey
}).strict();
var CreatorArtifactUploadCompleteRpcInputSchema = CreatorArtifactUploadGrantRpcInputSchema.extend({
  uploadGeneration: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative().max(HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes)
}).strict();
var CreatorArtifactRevokeRpcInputSchema = CreatorArtifactVersionRpcInputSchema.extend({
  reason: z.string().trim().min(1).max(2e3)
}).strict();
var CreatorSkillDownloadRpcInputSchema = z.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver
}).strict();
var CreatorSkillTargetRpcInputSchema = z.object({
  workspaceId: entityId
}).strict();
var DeleteSkillRpcInputSchema = z.object({
  workspaceId: entityId,
  skillSlug: localSkillBasename
}).strict();
var CreatorSkillSafetyRpcInputSchema = z.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum
}).strict();
var CreatorSkillInstallRpcInputSchema = z.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  grant: CreatorSkillDownloadGrantSchema,
  replaceExisting: z.boolean().optional(),
  confirmGlobalOverride: z.boolean().optional(),
  backupLocalChanges: z.boolean().optional()
}).strict();
var CreatorSkillUninstallRpcInputSchema = z.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  slug: skillSlug,
  forceDeleteModified: z.boolean().optional(),
  forceDeleteCredential: z.string().min(32).max(256).optional()
}).strict();
var CreatorSkillBackupRpcInputSchema = z.object({
  workspaceId: entityId
}).strict();
var CreatorSkillBackupDeleteRpcInputSchema = z.object({
  workspaceId: entityId,
  backup: z.object({
    slug: skillSlug,
    backupId: z.string().regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
    )
  }).strict().optional()
}).strict();
var CreatorSkillStatusUpdateRpcInputSchema = z.object({
  workspaceId: entityId,
  status: CreatorSkillSafetyStatusSchema,
  checkedAt: isoDate
}).strict();
var CreatorSkillIgnoreVersionRpcInputSchema = z.object({
  workspaceId: entityId,
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  ignoredVersion: stableSemver
}).strict();
var StableSemverSchema = stableSemver;
var SkillSlugSchema = skillSlug;
export {
  CreateCreatorArtifactRpcInputSchema,
  CreateCreatorArtifactVersionRpcInputSchema,
  CreatorArtifactArchiveRpcInputSchema,
  CreatorArtifactCapabilitySchema,
  CreatorArtifactCatalogPageSchema,
  CreatorArtifactDetailSchema,
  CreatorArtifactIdRpcInputSchema,
  CreatorArtifactListRpcInputSchema,
  CreatorArtifactMutationResponseSchema,
  CreatorArtifactRevokeRpcInputSchema,
  CreatorArtifactSchema,
  CreatorArtifactUploadCompleteRpcInputSchema,
  CreatorArtifactUploadGrantRpcInputSchema,
  CreatorArtifactVersionCreatedResponseSchema,
  CreatorArtifactVersionMutationResponseSchema,
  CreatorArtifactVersionRpcInputSchema,
  CreatorArtifactVersionSchema,
  CreatorSkillBackupDeleteRpcInputSchema,
  CreatorSkillBackupRpcInputSchema,
  CreatorSkillDownloadGrantSchema,
  CreatorSkillDownloadRpcInputSchema,
  CreatorSkillIgnoreVersionRpcInputSchema,
  CreatorSkillInstallRpcInputSchema,
  CreatorSkillManifestEntrySchema,
  CreatorSkillOperationIdSchema,
  CreatorSkillSafetyRpcInputSchema,
  CreatorSkillSafetyStatusBatchSchema,
  CreatorSkillSafetyStatusSchema,
  CreatorSkillStatusUpdateRpcInputSchema,
  CreatorSkillTargetRpcInputSchema,
  CreatorSkillUninstallRpcInputSchema,
  CreatorSkillUploadGrantSchema,
  CreatorSkillsLedgerSchema,
  DeleteSkillRpcInputSchema,
  InstalledCreatorSkillSchema,
  SkillArchivePolicySchema,
  SkillSlugSchema,
  SkillValidationIssueSchema,
  SkillVersionMetadataSchema,
  StableSemverSchema
};
