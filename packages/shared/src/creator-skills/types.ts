import type { ValidatedSkillMetadata } from './skill-content'

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

export const DEFAULT_SKILL_ARCHIVE_POLICY: SkillArchivePolicy = {
  version: '1',
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024,
}

export const HARD_SKILL_ARCHIVE_POLICY: SkillArchivePolicy = {
  version: 'hard-1',
  maxArchiveBytes: 100 * 1024 * 1024,
  maxFileCount: 1_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024,
}

export interface CreatorArtifact {
  id: string
  organizationId: string
  type: CreatorArtifactType
  slug: string
  name?: string
  summary?: string
  displayIcon?:
    | { kind: 'emoji'; value: string }
    | { kind: 'image'; url: string }
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
  uploadGeneration: number
  validatorVersion?: string
  validatedArchiveChecksum?: string
  validatedAt?: string
  metadata?: SkillVersionMetadata
  validationIssues?: SkillValidationIssue[]
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
  headers?: Record<string, string>
  expiresAt: string
  uploadGeneration: number
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
  /** Server-derived project directory; never accepted from renderer RPC input. */
  workingDirectory?: string
  operationId: string
  grant: CreatorSkillDownloadGrant
  replaceExisting?: boolean
  confirmGlobalOverride?: boolean
  backupLocalChanges?: boolean
}

export type CreatorSkillInstallRpcInput =
  Omit<CreatorSkillInstallInput, 'workingDirectory'>

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
