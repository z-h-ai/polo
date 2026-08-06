import type { ZodTypeAny } from 'zod'

export type CreatorArtifactType = 'web_app' | 'skill'
export type CreatorArtifactStatus = 'draft' | 'published' | 'archived'
export type CreatorArtifactVersionStatus =
  | 'upload_pending'
  | 'uploaded'
  | 'validating'
  | 'validation_failed'
  | 'validated'
  | 'published'
  | 'revoked'
  | 'expired'

export interface SkillArchivePolicy {
  version: string
  maxArchiveBytes: number
  maxFileCount: number
  maxFileBytes: number
  maxExpandedBytes: number
}

export declare const DEFAULT_SKILL_ARCHIVE_POLICY: SkillArchivePolicy
export declare const HARD_SKILL_ARCHIVE_POLICY: SkillArchivePolicy

export interface CreatorArtifact {
  id: string
  organizationId: string
  type: CreatorArtifactType
  slug: string
  name?: string
  summary?: string
  displayIcon?: { kind: 'emoji'; value: string } | { kind: 'image'; url: string }
  status: CreatorArtifactStatus
  latestPublishedVersion?: string
  createdByUserId: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  archivedByUserId?: string
}

export interface CreatorArtifactVersion {
  id: string
  artifactId: string
  version: string
  changelog?: string
  status: CreatorArtifactVersionStatus
  archiveChecksum?: string
  contentDigest?: string
  sizeBytes?: number
  createdAt: string
  publishedAt?: string
  publishedByUserId?: string
  revokedAt?: string
  revokedByUserId?: string
  revocationReason?: string
  validationPolicy?: SkillArchivePolicy
  validatorVersion?: string
  validatedArchiveChecksum?: string
  validatedAt?: string
  metadata?: SkillVersionMetadata
  validationIssues?: SkillValidationIssue[]
}

export interface CreatorArtifactManagerVersion extends CreatorArtifactVersion {
  uploadGeneration: number
}

export interface ValidatedSkillMetadata {
  name: string
  description: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

export type SkillVersionMetadata = ValidatedSkillMetadata

export interface SkillValidationIssue {
  code: string
  severity: 'error' | 'warning'
  path: string
  field?: string
  message: string
  suggestion?: string
}

export interface CreatorArtifactCapability {
  creatorSkillArtifacts: boolean
}

export interface CreatorArtifactCatalogPage {
  artifacts: CreatorArtifact[]
  nextCursor?: string
}

export interface CreatorArtifactDetail {
  artifact: CreatorArtifact
  versions: CreatorArtifactVersion[]
  selectedVersion?: string
  skillContent?: string
  fileTree?: CreatorSkillFileNode[]
  reference?: {
    path: string
    content?: string
    downloadUrl?: string
  }
}

export interface CreatorSkillFileNode {
  path: string
  size: number
  sha256?: string
}

export interface CreateCreatorArtifactInput {
  organizationId: string
  type: 'skill'
  slug: string
  idempotencyKey: string
}

export interface CreateCreatorArtifactVersionInput {
  organizationId: string
  artifactId: string
  version: string
  changelog?: string
  idempotencyKey: string
}

export interface CreatorSkillUploadGrant {
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: string
  uploadGeneration: number
  expectedSizeBytes: number
  expectedArchiveChecksum: string
}

export interface CreatorSkillManifestEntry {
  path: string
  size: number
  sha256: string
}

export interface CreatorSkillDownloadGrant {
  artifactId: string
  organizationId: string
  slug: string
  version: string
  url: string
  expiresAt: string
  archiveChecksum: string
  contentDigest: string
  manifest: CreatorSkillManifestEntry[]
  validationPolicy: SkillArchivePolicy
}

export interface CreatorSkillSafetyStatus {
  artifactId: string
  version: string
  archiveChecksum: string
  status: 'active' | 'revoked' | 'archived'
  safeVersion?: string
}

export interface CreatorSkillsLedger {
  schemaVersion: 1
  installed: InstalledCreatorSkill[]
}

export interface InstalledCreatorSkill {
  artifactId: string
  organizationId: string
  slug: string
  version: string
  archiveChecksum: string
  contentDigest: string
  installedAt: string
  lastKnownStatus?: 'active' | 'revoked' | 'archived'
  lastCheckedAt?: string
  ignoredVersion?: string
}

export type CreatorSkillOperationStage =
  | 'download'
  | 'validate'
  | 'prepare'
  | 'commit'
  | 'refresh'

export interface CreatorSkillOperationProgress {
  operationId: string
  workspaceId: string
  slug: string
  stage: CreatorSkillOperationStage
  percent: number
  cancellable: boolean
}

export type CreatorSkillInstallConflict =
  | 'workspace_skill'
  | 'global_skill'
  | 'different_artifact'
  | 'local_changes'

export interface CreatorSkillInstallIdentity {
  source: 'creator_space' | 'workspace' | 'global'
  slug: string
  artifactId?: string
  organizationId?: string
  version?: string
}

export interface CreatorSkillConflictDetails {
  existing: CreatorSkillInstallIdentity[]
  incoming: CreatorSkillInstallIdentity
}

export interface CreatorSkillInstallInput {
  workspaceId: string
  workingDirectory?: string
  operationId: string
  grant: CreatorSkillDownloadGrant
  replaceExisting?: boolean
  confirmGlobalOverride?: boolean
  backupLocalChanges?: boolean
}

export type CreatorSkillInstallRpcInput = Omit<CreatorSkillInstallInput, 'workingDirectory'>

export type CreatorSkillOperationResult =
  | {
      success: true
      operationId: string
      installed?: InstalledCreatorSkill
      detached?: boolean
      forceDeleteCredential?: string
    }
  | {
      success: false
      operationId: string
      errorCode: string
      stage: CreatorSkillOperationStage
      message?: string
      path?: string
      conflicts?: CreatorSkillInstallConflict[]
      conflictDetails?: CreatorSkillConflictDetails
      diagnostic: string
      retryable: boolean
    }

export type CreatorSkillBackupOperation =
  | 'modified_update'
  | 'update_safety_snapshot'
  | 'clean_uninstall_snapshot'
  | 'concurrent_recreation'

export interface CreatorSkillBackup {
  backupId: string
  slug: string
  createdAt: string
  sizeBytes: number
  operation: CreatorSkillBackupOperation
  version?: string
}

export declare const CreatorSkillOperationIdSchema: ZodTypeAny
export declare const SkillArchivePolicySchema: ZodTypeAny
export declare const SkillValidationIssueSchema: ZodTypeAny
export declare const SkillVersionMetadataSchema: ZodTypeAny
export declare const CreatorArtifactSchema: ZodTypeAny
export declare const CreatorArtifactDetailVersionSchema: ZodTypeAny
export declare const CreatorArtifactVersionSchema: ZodTypeAny
export declare const CreatorArtifactCapabilitySchema: ZodTypeAny
export declare const CreatorArtifactCatalogPageSchema: ZodTypeAny
export declare const CreatorArtifactDetailSchema: ZodTypeAny
export declare const CreatorArtifactMutationResponseSchema: ZodTypeAny
export declare const CreatorArtifactVersionMutationResponseSchema: ZodTypeAny
export declare const CreatorSkillUploadGrantSchema: ZodTypeAny
export declare const CreatorArtifactVersionCreatedResponseSchema: ZodTypeAny
export declare const CreatorSkillManifestEntrySchema: ZodTypeAny
export declare const CreatorSkillDownloadGrantSchema: ZodTypeAny
export declare const CreatorSkillSafetyStatusSchema: ZodTypeAny
export declare const CreatorSkillSafetyStatusBatchSchema: ZodTypeAny
export declare const InstalledCreatorSkillSchema: ZodTypeAny
export declare const CreatorSkillsLedgerSchema: ZodTypeAny
export declare const CreateCreatorArtifactRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactListRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactIdRpcInputSchema: ZodTypeAny
export declare const CreateCreatorArtifactVersionRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactVersionRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactArchiveRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactUploadGrantRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactUploadCompleteRpcInputSchema: ZodTypeAny
export declare const CreatorArtifactRevokeRpcInputSchema: ZodTypeAny
export declare const CreatorSkillDownloadRpcInputSchema: ZodTypeAny
export declare const CreatorSkillTargetRpcInputSchema: ZodTypeAny
export declare const DeleteSkillRpcInputSchema: ZodTypeAny
export declare const CreatorSkillSafetyRpcInputSchema: ZodTypeAny
export declare const CreatorSkillInstallRpcInputSchema: ZodTypeAny
export declare const CreatorSkillUninstallRpcInputSchema: ZodTypeAny
export declare const CreatorSkillBackupRpcInputSchema: ZodTypeAny
export declare const CreatorSkillBackupDeleteRpcInputSchema: ZodTypeAny
export declare const CreatorSkillStatusUpdateRpcInputSchema: ZodTypeAny
export declare const CreatorSkillIgnoreVersionRpcInputSchema: ZodTypeAny
export declare const StableSemverSchema: ZodTypeAny
export declare const SkillSlugSchema: ZodTypeAny

export interface SkillContentValidationIssue {
  file: string
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface SkillContentValidationResult {
  valid: boolean
  errors: SkillContentValidationIssue[]
  warnings: SkillContentValidationIssue[]
}

export declare const PortableSkillMetadataSchema: ZodTypeAny
export declare function isValidSkillSlug(slug: string): boolean
export declare function isValidCreatorSkillSlug(slug: string): boolean
export declare function suggestSkillSlug(slug: string): string
export declare function validatePortableSkillContent(
  markdownContent: string,
  slug: string,
): SkillContentValidationResult
export declare function validateCreatorSkillContent(
  markdownContent: string,
  slug: string,
): SkillContentValidationResult
export declare function readValidatedSkillMetadata(
  markdownContent: string,
  slug: string,
): { metadata: ValidatedSkillMetadata; body: string } | null

export interface CreatorSkillArchiveValidation {
  archiveChecksum: string
  contentDigest: string
  manifest: CreatorSkillManifestEntry[]
  metadata: SkillVersionMetadata
  warnings: SkillValidationIssue[]
  expandedBytes: number
}

export declare class CreatorSkillArchiveError extends Error {
  readonly code:
    | 'invalid_skill_archive'
    | 'skill_validation_failed'
    | 'archive_policy_exceeded'
    | 'checksum_mismatch'
    | 'content_digest_mismatch'
  readonly issues: SkillValidationIssue[]
  constructor(
    code: CreatorSkillArchiveError['code'],
    message: string,
    issues?: SkillValidationIssue[],
  )
}

export declare function canonicalManifestJson(manifest: CreatorSkillManifestEntry[]): string
export declare function calculateContentDigest(manifest: CreatorSkillManifestEntry[]): string
export declare function preflightCreatorSkillArchive(args: any): Promise<CreatorSkillArchiveValidation>
export declare function validateCreatorSkillArchive(args: any): Promise<CreatorSkillArchiveValidation>
export declare function scanCreatorSkillDirectory(path: string): Promise<any>
export declare function directorySize(path: string): Promise<number>
export declare function creatorSkillBackupTimestamp(date?: Date): string
export declare function inferBackupCreatedAt(path: string): string
export declare function hasArchiveLikeExtension(path: string): boolean

export declare const CREATOR_SKILLS_LEDGER_FILE: string
export type CreatorSkillsLedgerWriteStep =
  | 'temporary_file_synced'
  | 'ledger_renamed'
  | 'directory_synced'

export interface CreatorSkillsLedgerWriteDependencies {
  syncDirectory?: (directoryPath: string) => Promise<void>
  onStep?: (step: CreatorSkillsLedgerWriteStep) => Promise<void> | void
}

export declare function emptyCreatorSkillsLedger(): CreatorSkillsLedger
export declare function parseCreatorSkillsLedger(raw: unknown): CreatorSkillsLedger
export declare function readCreatorSkillsLedger(workspaceRoot: string): Promise<CreatorSkillsLedger>
export declare function writeCreatorSkillsLedger(
  workspaceRoot: string,
  ledger: CreatorSkillsLedger,
  dependencies?: CreatorSkillsLedgerWriteDependencies,
): Promise<void>
export declare function replaceLedgerInstallation(
  ledger: CreatorSkillsLedger,
  installation: InstalledCreatorSkill,
): CreatorSkillsLedger
export declare function removeLedgerInstallation(
  ledger: CreatorSkillsLedger,
  slug: string,
): CreatorSkillsLedger

export type CreatorSkillJournalState =
  | 'preparing'
  | 'prepared'
  | 'old_backed_up'
  | 'new_installed'
  | 'ledger_committed'
  | 'detaching'
  | 'committed'

export interface CreatorSkillInstallerDependencies {
  fetch?: typeof fetch
  onProgress?: (progress: CreatorSkillOperationProgress) => void
  assertCommitAllowed?: (input: {
    artifactId: string
    version: string
    archiveChecksum: string
  }) => Promise<void>
  beforeCommitSnapshot?: () => Promise<void> | void
  onJournalPersisted?: (state: CreatorSkillJournalState) => Promise<void> | void
  syncJournalDirectory?: (directoryPath: string) => Promise<void>
  onCleanupStep?: (
    step: 'transaction_backup_removed' | 'operation_removed'
  ) => Promise<void> | void
  onLedgerMutationLocked?: () => Promise<void> | void
  onLedgerMutationLockContended?: () => Promise<void> | void
  operationOwnerId?: string
  ledgerWriteDependencies?: CreatorSkillsLedgerWriteDependencies
  onError?: (error: unknown) => void
}

export type CreatorSkillUninstallerDependencies = Pick<
  CreatorSkillInstallerDependencies,
  | 'beforeCommitSnapshot'
  | 'onJournalPersisted'
  | 'syncJournalDirectory'
  | 'onCleanupStep'
  | 'onLedgerMutationLocked'
  | 'onLedgerMutationLockContended'
  | 'ledgerWriteDependencies'
  | 'onError'
>

export type CreatorSkillMetadataUpdateDependencies = Pick<
  CreatorSkillInstallerDependencies,
  | 'onLedgerMutationLocked'
  | 'onLedgerMutationLockContended'
  | 'ledgerWriteDependencies'
>

export declare function hasPendingCreatorSkillForceDelete(args: {
  workspaceRoot: string
  slug: string
  artifactId: string
  archiveChecksum: string
}): Promise<boolean>
export declare function installCreatorSkill(
  workspaceRoot: string,
  input: CreatorSkillInstallInput,
  dependencies?: CreatorSkillInstallerDependencies,
): Promise<CreatorSkillOperationResult>
export declare function cancelCreatorSkillOperation(args: {
  workspaceRoot: string
  operationId: string
}): Promise<boolean>
export declare function uninstallCreatorSkill(args: {
  workspaceRoot: string
  operationId: string
  slug: string
  forceDeleteModified?: boolean
  forceDeleteCredential?: string
}, dependencies?: CreatorSkillUninstallerDependencies): Promise<CreatorSkillOperationResult>
export declare function recoverCreatorSkillOperations(workspaceRoot: string): Promise<void>
export declare function listCreatorSkillBackups(args: {
  workspaceRoot: string
}): Promise<CreatorSkillBackup[]>
export declare function deleteCreatorSkillBackups(args: {
  workspaceRoot: string
  backup: { slug: string; backupId: string }
}): Promise<boolean>
export declare function updateCreatorSkillInstallationMetadata(args: {
  workspaceRoot: string
  artifactId: string
  version: string
  archiveChecksum: string
  changes: Record<string, unknown>
}): Promise<boolean>
export declare function copyCreatorSkillBackupForTesting(args: {
  workspaceRoot: string
  slug: string
  backupOperation: CreatorSkillBackupOperation
}): Promise<any>

export declare const CREATOR_SKILL_FIXTURE_SLUG: string
export declare const CREATOR_SKILL_FIXTURE_CONTENT: string
export declare const CREATOR_SKILL_FIXTURE_METADATA: SkillVersionMetadata
export declare const CREATOR_SKILL_FIXTURE_POLICY: SkillArchivePolicy
export declare const CREATOR_SKILL_FIXTURE_MANIFEST: CreatorSkillManifestEntry[]
export declare const CREATOR_SKILL_FIXTURE_CONTENT_DIGEST: string
