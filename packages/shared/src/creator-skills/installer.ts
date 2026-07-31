import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  creatorSkillBackupTimestamp,
  directorySize,
  inferBackupCreatedAt,
  scanCreatorSkillDirectory,
  validateCreatorSkillArchive,
} from './archive'
import {
  parseCreatorSkillsLedger,
  readCreatorSkillsLedger,
  removeLedgerInstallation,
  replaceLedgerInstallation,
  type CreatorSkillsLedgerWriteDependencies,
  writeCreatorSkillsLedger,
} from './ledger'
import {
  HARD_SKILL_ARCHIVE_POLICY,
  type CreatorSkillBackup,
  type CreatorSkillBackupOperation,
  type CreatorSkillConflictDetails,
  type CreatorSkillInstallConflict,
  type CreatorSkillInstallInput,
  type CreatorSkillOperationProgress,
  type CreatorSkillOperationResult,
  type InstalledCreatorSkill,
} from './types'

const OP_DIRECTORY = '.creator-skill-ops'
const BACKUP_DIRECTORY = 'skill-backups'
const FORCE_DELETE_CREDENTIAL_FILE = '.creator-skill-force-delete.json'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BACKUP_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024
const MAX_BACKUP_METADATA_BYTES = 16 * 1024
const MAX_FORCE_DELETE_CREDENTIAL_BYTES = 1024 * 1024
const FORCE_DELETE_CREDENTIAL_TTL_MS = 10 * 60 * 1000
const BACKUP_MANAGEMENT_LOCK = '__creator-skill-backups__'
const LEDGER_MUTATION_LOCK = '__creator-skills-ledger__'
const processQueues = new Map<string, Promise<void>>()
const cancellationControllers = new Map<string, AbortController>()

export type CreatorSkillJournalState =
  | 'preparing'
  | 'prepared'
  | 'old_backed_up'
  | 'new_installed'
  | 'ledger_committed'
  | 'detaching'
  | 'committed'

interface CreatorSkillJournal {
  schemaVersion: 1
  operationId: string
  action: 'install' | 'uninstall'
  slug: string
  targetPath: string
  transactionBackupPath: string
  ledgerPath: string
  oldLedger: string | null
  state: CreatorSkillJournalState
  preserveBackupPath?: string
  backupOperation?: CreatorSkillBackupOperation
  backupVersion?: string
  backupCreatedAt?: string
  promotedDirectoryIdentity?: string
}

interface CreatorSkillBackupMetadata {
  schemaVersion: 1
  slug: string
  backupId: string
  operation: CreatorSkillBackupOperation
  createdAt: string
  version?: string
}

interface StoredForceDeleteCredential {
  tokenHash: string
  slug: string
  artifactId: string
  archiveChecksum: string
  directoryIdentity: string
  contentFingerprint: string
  expiresAt: string
}

interface ForceDeleteCredentialStore {
  schemaVersion: 1
  credentials: StoredForceDeleteCredential[]
}

export interface CreatorSkillInstallerDependencies {
  fetch?: typeof fetch
  onProgress?: (progress: CreatorSkillOperationProgress) => void
  assertCommitAllowed?: (input: {
    artifactId: string
    version: string
    archiveChecksum: string
  }) => Promise<void>
  /** Runs immediately before the final target identity snapshot in deterministic race tests. */
  beforeCommitSnapshot?: () => Promise<void> | void
  /** Transaction checkpoint hook used by deterministic crash/fault tests. */
  onJournalPersisted?: (state: CreatorSkillJournalState) => Promise<void> | void
  /** Overrides directory fsync for deterministic durability tests. */
  syncJournalDirectory?: (directoryPath: string) => Promise<void>
  /** Transaction cleanup hook used by deterministic crash/fault tests. */
  onCleanupStep?: (
    step: 'transaction_backup_removed' | 'operation_removed'
  ) => Promise<void> | void
  /** Runs while the workspace-wide Ledger mutation lock is held in deterministic tests. */
  onLedgerMutationLocked?: () => Promise<void> | void
  /** Reports deterministic in-process Ledger lock contention in fault-injection tests. */
  onLedgerMutationLockContended?: () => Promise<void> | void
  /** RPC-client ownership scope for cancellation. Defaults to the workspace id in direct calls. */
  operationOwnerId?: string
  /** Ledger durability fault injection used by deterministic transaction tests. */
  ledgerWriteDependencies?: CreatorSkillsLedgerWriteDependencies
  /** Receives raw filesystem/download errors for server-only diagnostics. */
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

function errorResult(args: {
  operationId: string
  stage: CreatorSkillOperationProgress['stage']
  errorCode: string
  message: string
  path?: string
  conflicts?: CreatorSkillInstallConflict[]
  conflictDetails?: CreatorSkillConflictDetails
  retryable?: boolean
}): CreatorSkillOperationResult {
  return {
    success: false,
    operationId: args.operationId,
    errorCode: args.errorCode,
    stage: args.stage,
    message: args.message,
    ...(args.path ? { path: args.path } : {}),
    ...(args.conflicts ? { conflicts: args.conflicts } : {}),
    ...(args.conflictDetails ? { conflictDetails: args.conflictDetails } : {}),
    diagnostic: JSON.stringify({
      operationId: args.operationId,
      stage: args.stage,
      errorCode: args.errorCode,
      ...(args.path ? { path: args.path } : {}),
    }),
    retryable: args.retryable ?? false,
  }
}

const SAFE_OPERATION_ERROR_CODES = new Set([
  'archive_policy_exceeded',
  'artifact_not_published',
  'artifact_version_revoked',
  'checksum_mismatch',
  'content_digest_mismatch',
  'creator_skill_cancelled',
  'creator_skill_conflict',
  'creator_skill_download_failed',
  'creator_skill_feature_disabled',
  'creator_skill_force_delete_credential_required',
  'creator_skill_force_delete_stale',
  'creator_skill_not_installed',
  'creator_skill_operation_id_conflict',
  'creator_skill_operation_in_progress',
  'invalid_operation_id',
  'invalid_backup_path',
  'invalid_creator_skill_operation_path',
  'invalid_skill_archive',
  'project_skill_conflict',
  'skill_validation_failed',
])

function safeOperationErrorCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_OPERATION_ERROR_CODES.has(value)
    ? value
    : fallback
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function cancellationKey(
  workspaceRoot: string,
  ownerId: string,
  operationId: string,
): string {
  return `${workspaceRoot}\0${ownerId}\0${operationId}`
}

function invalidOperationPath(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_creator_skill_operation_path' })
}

function invalidBackupPath(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_backup_path' })
}

function assertChildPath(parent: string, candidate: string, label: string): void {
  if (candidate === parent || !candidate.startsWith(`${parent}${sep}`)) {
    throw invalidOperationPath(`${label} is outside its allowed directory`)
  }
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const candidate = resolve(workspaceRoot)
  const canonical = await realpath(candidate)
  if (canonical !== candidate) {
    // The configured workspace root itself may legitimately be reached through
    // a symlink. All descendants are derived from its canonical path.
    return canonical
  }
  return candidate
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && (error as { code?: string }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

async function directoryIdentity(path: string): Promise<string> {
  const stats = await lstat(path, { bigint: true })
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw Object.assign(new Error('Creator Skill target must be a regular directory'), {
      code: 'content_digest_mismatch',
    })
  }
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`
}

function forceDeleteCredentialPath(workspaceRoot: string): string {
  const path = resolve(workspaceRoot, FORCE_DELETE_CREDENTIAL_FILE)
  assertChildPath(workspaceRoot, path, 'Creator Skill force-delete credential store')
  return path
}

function validStoredForceDeleteCredential(
  value: unknown,
): value is StoredForceDeleteCredential {
  if (!value || typeof value !== 'object') return false
  const credential = value as Partial<StoredForceDeleteCredential>
  return typeof credential.tokenHash === 'string'
    && /^[a-f0-9]{64}$/.test(credential.tokenHash)
    && typeof credential.slug === 'string'
    && SKILL_SLUG_PATTERN.test(credential.slug)
    && typeof credential.artifactId === 'string'
    && credential.artifactId.length > 0
    && credential.artifactId.length <= 512
    && typeof credential.archiveChecksum === 'string'
    && /^[a-f0-9]{64}$/.test(credential.archiveChecksum)
    && typeof credential.directoryIdentity === 'string'
    && /^[0-9]+:[0-9]+:[0-9]+$/.test(credential.directoryIdentity)
    && typeof credential.contentFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(credential.contentFingerprint)
    && typeof credential.expiresAt === 'string'
    && !Number.isNaN(Date.parse(credential.expiresAt))
}

async function readForceDeleteCredentialStore(
  workspaceRoot: string,
): Promise<ForceDeleteCredentialStore> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const path = forceDeleteCredentialPath(canonicalWorkspace)
  const stats = await lstatIfPresent(path)
  if (!stats) return { schemaVersion: 1, credentials: [] }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || stats.size > MAX_FORCE_DELETE_CREDENTIAL_BYTES
    || await realpath(path) !== path
  ) {
    throw invalidOperationPath('Creator Skill force-delete credential store is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    throw invalidOperationPath('Creator Skill force-delete credential store is invalid JSON')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as Partial<ForceDeleteCredentialStore>).schemaVersion !== 1
    || !Array.isArray((parsed as Partial<ForceDeleteCredentialStore>).credentials)
    || !(parsed as ForceDeleteCredentialStore).credentials.every(
      validStoredForceDeleteCredential,
    )
  ) {
    throw invalidOperationPath('Creator Skill force-delete credential store is invalid')
  }
  const now = Date.now()
  return {
    schemaVersion: 1,
    credentials: (parsed as ForceDeleteCredentialStore).credentials
      .filter(credential => Date.parse(credential.expiresAt) > now)
      .slice(-64),
  }
}

async function writeForceDeleteCredentialStore(
  workspaceRoot: string,
  store: ForceDeleteCredentialStore,
): Promise<void> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const path = forceDeleteCredentialPath(canonicalWorkspace)
  const existing = await lstatIfPresent(path)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw invalidOperationPath('Creator Skill force-delete credential store is invalid')
  }
  if (store.credentials.length === 0) {
    await rm(path, { force: true })
    await syncJournalDirectory(canonicalWorkspace)
    return
  }
  const tempPath = `${path}.${randomUUID()}.tmp`
  const handle = await open(tempPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, path)
    await syncJournalDirectory(canonicalWorkspace)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

function hashForceDeleteCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function credentialHashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

async function assertSafeBackupDirectory(
  path: string,
  parent: string,
  label: string,
): Promise<void> {
  assertChildPath(parent, path, label)
  const pathStats = await lstatIfPresent(path)
  if (!pathStats) return
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw invalidBackupPath(`${label} must be a regular directory`)
  }
  const canonical = await realpath(path)
  if (canonical !== path) {
    throw invalidBackupPath(`${label} cannot resolve through a symbolic link`)
  }
}

async function resolveCreatorSkillBackupTarget(args: {
  workspaceRoot: string
  slug: string
  backupId: string
  createAncestors?: boolean
}): Promise<{
  workspaceRoot: string
  backupRoot: string
  slugBackupRoot: string
  targetPath: string
  targetExists: boolean
}> {
  if (!SKILL_SLUG_PATTERN.test(args.slug) || !BACKUP_NAME_PATTERN.test(args.backupId)) {
    throw invalidBackupPath('Creator Skill backup identity is invalid')
  }
  const canonicalWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot)
  const backupRoot = resolve(canonicalWorkspace, BACKUP_DIRECTORY)
  assertChildPath(canonicalWorkspace, backupRoot, 'Creator Skill backup root')
  await assertSafeBackupDirectory(
    backupRoot,
    canonicalWorkspace,
    'Creator Skill backup root',
  )
  if (!await lstatIfPresent(backupRoot) && args.createAncestors) {
    await mkdir(backupRoot, { mode: 0o700 })
    await assertSafeBackupDirectory(
      backupRoot,
      canonicalWorkspace,
      'Creator Skill backup root',
    )
  }

  const slugBackupRoot = resolve(backupRoot, args.slug)
  await assertSafeBackupDirectory(
    slugBackupRoot,
    backupRoot,
    'Creator Skill slug backup root',
  )
  if (!await lstatIfPresent(slugBackupRoot) && args.createAncestors) {
    if (!await lstatIfPresent(backupRoot)) {
      throw invalidBackupPath('Creator Skill backup root is unavailable')
    }
    await mkdir(slugBackupRoot, { mode: 0o700 })
    await assertSafeBackupDirectory(
      slugBackupRoot,
      backupRoot,
      'Creator Skill slug backup root',
    )
  }

  const targetPath = resolve(slugBackupRoot, args.backupId)
  assertChildPath(slugBackupRoot, targetPath, 'Creator Skill backup target')
  const targetStats = await lstatIfPresent(targetPath)
  if (targetStats) {
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
      throw invalidBackupPath('Creator Skill backup target must be a regular directory')
    }
    const canonicalTarget = await realpath(targetPath)
    if (canonicalTarget !== targetPath) {
      throw invalidBackupPath('Creator Skill backup target cannot resolve through a symbolic link')
    }
  }
  return {
    workspaceRoot: canonicalWorkspace,
    backupRoot,
    slugBackupRoot,
    targetPath,
    targetExists: targetStats !== null,
  }
}

function backupMetadataPath(targetPath: string): string {
  return `${targetPath}.metadata.json`
}

function isBackupOperation(value: unknown): value is CreatorSkillBackupOperation {
  return value === 'modified_update'
    || value === 'update_safety_snapshot'
    || value === 'clean_uninstall_snapshot'
    || value === 'concurrent_recreation'
}

function parseBackupMetadata(
  raw: unknown,
  expected: { slug: string; backupId: string },
): CreatorSkillBackupMetadata {
  if (!raw || typeof raw !== 'object') {
    throw invalidBackupPath('Creator Skill backup metadata is invalid')
  }
  const metadata = raw as Partial<CreatorSkillBackupMetadata>
  if (
    metadata.schemaVersion !== 1
    || metadata.slug !== expected.slug
    || metadata.backupId !== expected.backupId
    || !isBackupOperation(metadata.operation)
    || typeof metadata.createdAt !== 'string'
    || Number.isNaN(Date.parse(metadata.createdAt))
    || (metadata.version !== undefined
      && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version))
  ) {
    throw invalidBackupPath('Creator Skill backup metadata is invalid')
  }
  return metadata as CreatorSkillBackupMetadata
}

async function readBackupMetadata(args: {
  targetPath: string
  slug: string
  backupId: string
}): Promise<CreatorSkillBackupMetadata | null> {
  const metadataPath = backupMetadataPath(args.targetPath)
  assertChildPath(dirname(args.targetPath), metadataPath, 'Creator Skill backup metadata')
  const metadataStats = await lstatIfPresent(metadataPath)
  if (!metadataStats) return null
  if (
    metadataStats.isSymbolicLink()
    || !metadataStats.isFile()
    || metadataStats.size > MAX_BACKUP_METADATA_BYTES
  ) {
    throw invalidBackupPath('Creator Skill backup metadata must be a small regular file')
  }
  try {
    return parseBackupMetadata(
      JSON.parse(await readFile(metadataPath, 'utf8')) as unknown,
      { slug: args.slug, backupId: args.backupId },
    )
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && (error as { code?: string }).code === 'invalid_backup_path'
    ) {
      throw error
    }
    throw invalidBackupPath('Creator Skill backup metadata is invalid JSON')
  }
}

async function writeBackupMetadata(
  targetPath: string,
  metadata: CreatorSkillBackupMetadata,
): Promise<void> {
  const metadataPath = backupMetadataPath(targetPath)
  assertChildPath(dirname(targetPath), metadataPath, 'Creator Skill backup metadata')
  const existing = await readBackupMetadata({
    targetPath,
    slug: metadata.slug,
    backupId: metadata.backupId,
  })
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(metadata)) {
      throw invalidBackupPath('Creator Skill backup metadata conflicts with the operation journal')
    }
    return
  }
  const tempPath = `${metadataPath}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await rename(tempPath, metadataPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

async function allocateCreatorSkillBackupTarget(
  workspaceRoot: string,
  slug: string,
): Promise<Awaited<ReturnType<typeof resolveCreatorSkillBackupTarget>>> {
  const now = Date.now()
  for (let offset = 0; offset < 1_000; offset += 1) {
    const target = await resolveCreatorSkillBackupTarget({
      workspaceRoot,
      slug,
      backupId: creatorSkillBackupTimestamp(new Date(now + offset)),
      createAncestors: true,
    })
    if (
      !target.targetExists
      && !await lstatIfPresent(backupMetadataPath(target.targetPath))
    ) {
      return target
    }
  }
  throw invalidBackupPath('Unable to allocate a unique Creator Skill backup identity')
}

async function ensureOperationRoot(workspaceRoot: string): Promise<{
  workspaceRoot: string
  operationRoot: string
}> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const candidate = resolve(canonicalWorkspace, OP_DIRECTORY)
  assertChildPath(canonicalWorkspace, candidate, 'Creator Skill operation root')
  await mkdir(candidate, { recursive: true, mode: 0o700 })
  const canonicalOperationRoot = await realpath(candidate)
  if (canonicalOperationRoot !== candidate) {
    throw invalidOperationPath('Creator Skill operation root cannot be a symbolic link')
  }
  assertChildPath(canonicalWorkspace, canonicalOperationRoot, 'Creator Skill operation root')
  return {
    workspaceRoot: canonicalWorkspace,
    operationRoot: canonicalOperationRoot,
  }
}

async function resolveOperationPath(
  workspaceRoot: string,
  operationId: string,
): Promise<{
  workspaceRoot: string
  operationRoot: string
  operationPath: string
}> {
  if (!UUID_PATTERN.test(operationId)) {
    throw Object.assign(new Error('Creator Skill operationId must be a UUID'), {
      code: 'invalid_operation_id',
    })
  }
  const roots = await ensureOperationRoot(workspaceRoot)
  const operationPath = resolve(roots.operationRoot, operationId)
  assertChildPath(roots.operationRoot, operationPath, 'Creator Skill operation')
  if (await exists(operationPath)) {
    const canonicalOperationPath = await realpath(operationPath)
    if (canonicalOperationPath !== operationPath) {
      throw invalidOperationPath('Creator Skill operation directory cannot be a symbolic link')
    }
    assertChildPath(roots.operationRoot, canonicalOperationPath, 'Creator Skill operation')
  }
  return { ...roots, operationPath }
}

async function reserveOperationPath(
  workspaceRoot: string,
  operationId: string,
): Promise<Awaited<ReturnType<typeof resolveOperationPath>>> {
  const resolved = await resolveOperationPath(workspaceRoot, operationId)
  try {
    await mkdir(resolved.operationPath, {
      recursive: false,
      mode: 0o700,
    })
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && (error as { code?: string }).code === 'EEXIST'
    ) {
      throw Object.assign(
        new Error('Creator Skill operationId is already reserved in this workspace'),
        { code: 'creator_skill_operation_id_conflict' },
      )
    }
    throw error
  }
  const canonicalOperationPath = await realpath(resolved.operationPath)
  if (canonicalOperationPath !== resolved.operationPath) {
    throw invalidOperationPath('Creator Skill operation directory cannot be a symbolic link')
  }
  return resolved
}

function validateJournalShape(
  journal: CreatorSkillJournal,
  expectedOperationId: string,
): void {
  const hasAnyBackupMetadata = (
    journal.backupOperation !== undefined
    || journal.backupVersion !== undefined
    || journal.backupCreatedAt !== undefined
  )
  if (
    !journal
    || journal.schemaVersion !== 1
    || journal.operationId !== expectedOperationId
    || !UUID_PATTERN.test(journal.operationId)
    || !SKILL_SLUG_PATTERN.test(journal.slug)
    || !['install', 'uninstall'].includes(journal.action)
    || ![
      'preparing',
      'prepared',
      'old_backed_up',
      'new_installed',
      'ledger_committed',
      'detaching',
      'committed',
    ]
      .includes(journal.state)
    || (journal.oldLedger !== null && typeof journal.oldLedger !== 'string')
    || (journal.oldLedger?.length ?? 0) > MAX_JOURNAL_BYTES
    || (journal.promotedDirectoryIdentity !== undefined
      && !/^[0-9]+:[0-9]+:[0-9]+$/.test(journal.promotedDirectoryIdentity))
    || (hasAnyBackupMetadata && (
      !isBackupOperation(journal.backupOperation)
      || typeof journal.backupCreatedAt !== 'string'
      || Number.isNaN(Date.parse(journal.backupCreatedAt))
      || (journal.backupVersion !== undefined
        && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(journal.backupVersion))
    ))
  ) {
    throw invalidOperationPath('Creator Skill recovery journal is invalid')
  }
}

function backupMetadataFromJournal(
  journal: CreatorSkillJournal,
  preserveBackupPath: string,
): CreatorSkillBackupMetadata | null {
  if (!journal.backupOperation || !journal.backupCreatedAt) return null
  return {
    schemaVersion: 1,
    slug: journal.slug,
    backupId: basename(preserveBackupPath),
    operation: journal.backupOperation,
    createdAt: journal.backupCreatedAt,
    ...(journal.backupVersion ? { version: journal.backupVersion } : {}),
  }
}

async function assertCanonicalPathWhenPresent(path: string, label: string): Promise<void> {
  if (!await exists(path)) return
  const canonical = await realpath(path)
  if (canonical !== path) {
    throw invalidOperationPath(`${label} cannot be a symbolic link`)
  }
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let existingAncestor = resolve(path)
  const missingSegments: string[] = []
  while (!await exists(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) {
      throw invalidOperationPath('Creator Skill recovery path has no valid ancestor')
    }
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
  return resolve(await realpath(existingAncestor), ...missingSegments)
}

async function deriveJournalPaths(
  workspaceRoot: string,
  operationPath: string,
  journal: CreatorSkillJournal,
): Promise<{
  targetPath: string
  transactionBackupPath: string
  ledgerPath: string
  preserveBackupPath?: string
}> {
  validateJournalShape(journal, basename(operationPath))
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const skillsRoot = resolve(canonicalWorkspace, 'skills')
  assertChildPath(canonicalWorkspace, skillsRoot, 'Workspace Skills root')
  await assertCanonicalPathWhenPresent(skillsRoot, 'Workspace Skills root')
  const targetPath = resolve(skillsRoot, journal.slug)
  assertChildPath(skillsRoot, targetPath, 'Creator Skill target')
  await assertCanonicalPathWhenPresent(targetPath, 'Creator Skill target')

  const transactionBackupPath = resolve(operationPath, 'backup')
  assertChildPath(operationPath, transactionBackupPath, 'Creator Skill transaction backup')
  await assertCanonicalPathWhenPresent(
    transactionBackupPath,
    'Creator Skill transaction backup',
  )
  const ledgerPath = resolve(canonicalWorkspace, 'creator-skills.json')
  assertChildPath(canonicalWorkspace, ledgerPath, 'Creator Skill ledger')

  if (
    await canonicalizePotentialPath(journal.targetPath) !== targetPath
    || await canonicalizePotentialPath(journal.transactionBackupPath) !== transactionBackupPath
    || await canonicalizePotentialPath(journal.ledgerPath) !== ledgerPath
  ) {
    throw invalidOperationPath('Creator Skill recovery journal contains an out-of-bound path')
  }

  let preserveBackupPath: string | undefined
  if (journal.preserveBackupPath !== undefined) {
    const backupName = basename(journal.preserveBackupPath)
    const backupTarget = await resolveCreatorSkillBackupTarget({
      workspaceRoot: canonicalWorkspace,
      slug: journal.slug,
      backupId: backupName,
    })
    preserveBackupPath = backupTarget.targetPath
    if (await canonicalizePotentialPath(journal.preserveBackupPath) !== preserveBackupPath) {
      throw invalidOperationPath('Creator Skill recovery journal contains an out-of-bound backup')
    }
  }

  return {
    targetPath,
    transactionBackupPath,
    ledgerPath,
    ...(preserveBackupPath ? { preserveBackupPath } : {}),
  }
}

function compareStableSemver(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function report(
  dependencies: CreatorSkillInstallerDependencies,
  input: CreatorSkillInstallInput,
  stage: CreatorSkillOperationProgress['stage'],
  percent: number,
  cancellable: boolean,
): void {
  dependencies.onProgress?.({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    slug: input.grant.slug,
    stage,
    percent,
    cancellable,
  })
}

async function syncJournalDirectory(directoryPath: string): Promise<void> {
  let directoryHandle
  try {
    directoryHandle = await open(directoryPath, 'r')
    await directoryHandle.sync()
  } finally {
    await directoryHandle?.close()
  }
}

async function writeJournal(
  path: string,
  journal: CreatorSkillJournal,
  syncDirectory: (directoryPath: string) => Promise<void> = syncJournalDirectory,
): Promise<boolean> {
  const tempPath = `${path}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, path)
    // A successful file fsync does not make the directory-entry rename durable.
    // Callers must retain transaction recovery material when directory fsync is
    // unsupported instead of treating that weaker guarantee as committed.
    try {
      await syncDirectory(dirname(path))
      return true
    } catch (error) {
      const code = error && typeof error === 'object'
        ? (error as { code?: string }).code
        : undefined
      if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR') {
        return false
      }
      throw error
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function persistJournal(
  path: string,
  journal: CreatorSkillJournal,
  dependencies?: CreatorSkillInstallerDependencies,
): Promise<boolean> {
  const durable = await writeJournal(
    path,
    journal,
    dependencies?.syncJournalDirectory,
  )
  await dependencies?.onJournalPersisted?.(journal.state)
  return durable
}

async function readLedgerSnapshot(workspaceRoot: string): Promise<string | null> {
  try {
    return await readFile(join(workspaceRoot, 'creator-skills.json'), 'utf8')
  } catch {
    return null
  }
}

async function restoreLedgerSnapshot(
  workspaceRoot: string,
  snapshot: string | null,
  slug: string,
): Promise<void> {
  let oldInstallation: InstalledCreatorSkill | undefined
  if (snapshot !== null) {
    try {
      oldInstallation = parseCreatorSkillsLedger(
        JSON.parse(snapshot) as unknown,
      ).installed.find(item => item.slug === slug)
    } catch {
      oldInstallation = undefined
    }
  }
  const current = await readCreatorSkillsLedger(workspaceRoot)
  const restored = oldInstallation
    ? replaceLedgerInstallation(current, oldInstallation)
    : removeLedgerInstallation(current, slug)
  if (snapshot === null && restored.installed.length === 0) {
    await rm(join(workspaceRoot, 'creator-skills.json'), { force: true })
  } else {
    await writeCreatorSkillsLedger(workspaceRoot, restored)
  }
}

async function acquireOperationLock(workspaceRoot: string, slug: string): Promise<() => Promise<void>> {
  if (
    slug !== BACKUP_MANAGEMENT_LOCK
    && slug !== LEDGER_MUTATION_LOCK
    && !SKILL_SLUG_PATTERN.test(slug)
  ) {
    throw invalidOperationPath('Creator Skill lock slug is invalid')
  }
  const { operationRoot } = await ensureOperationRoot(workspaceRoot)
  const lockDirectory = resolve(operationRoot, 'locks')
  assertChildPath(operationRoot, lockDirectory, 'Creator Skill lock directory')
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
  const canonicalLockDirectory = await realpath(lockDirectory)
  if (canonicalLockDirectory !== lockDirectory) {
    throw invalidOperationPath('Creator Skill lock directory cannot be a symbolic link')
  }
  const lockPath = join(lockDirectory, `${slug}.lock`)
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }))
  } catch (error) {
    await handle?.close()
    throw Object.assign(new Error('Another Creator Skill operation is already running'), {
      code: 'creator_skill_operation_in_progress',
    })
  }
  return async () => {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

async function acquireProcessQueueSlot(key: string): Promise<() => void> {
  const previous = processQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => {
    release = resolvePromise
  })
  const queued = previous.then(() => current)
  processQueues.set(key, queued)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    if (processQueues.get(key) === queued) processQueues.delete(key)
  }
}

async function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireProcessQueueSlot(key)
  try {
    return await operation()
  } finally {
    release()
  }
}

async function withBackupManagementLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const key = `${canonicalWorkspace}\0${BACKUP_MANAGEMENT_LOCK}`
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(
      canonicalWorkspace,
      BACKUP_MANAGEMENT_LOCK,
    )
    try {
      return await operation()
    } finally {
      await releaseLock()
    }
  })
}

async function acquireLedgerMutationLock(
  workspaceRoot: string,
  onContended?: () => Promise<void> | void,
): Promise<() => Promise<void>> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const key = `${canonicalWorkspace}\0${LEDGER_MUTATION_LOCK}`
  if (processQueues.has(key)) await onContended?.()
  const releaseQueue = await acquireProcessQueueSlot(key)
  try {
    const releaseFile = await acquireOperationLock(
      canonicalWorkspace,
      LEDGER_MUTATION_LOCK,
    )
    return async () => {
      try {
        await releaseFile()
      } finally {
        releaseQueue()
      }
    }
  } catch (error) {
    releaseQueue()
    throw error
  }
}

async function downloadArchive(args: {
  url: string
  outputPath: string
  maxBytes: number
  signal: AbortSignal
  fetchImpl: typeof fetch
  onChunk: (downloaded: number, total?: number) => void
}): Promise<void> {
  const response = await args.fetchImpl(args.url, {
    method: 'GET',
    redirect: 'error',
    signal: args.signal,
  })
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Download failed with HTTP ${response.status}`), {
      code: 'creator_skill_download_failed',
    })
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    throw Object.assign(new Error('Download exceeds the archive policy'), {
      code: 'archive_policy_exceeded',
    })
  }
  const handle = await open(args.outputPath, 'wx', 0o600)
  const reader = response.body.getReader()
  let downloaded = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      downloaded += chunk.value.byteLength
      if (downloaded > args.maxBytes) {
        throw Object.assign(new Error('Download exceeds the archive policy'), {
          code: 'archive_policy_exceeded',
        })
      }
      await handle.write(chunk.value)
      args.onChunk(downloaded, Number.isFinite(declared) ? declared : undefined)
    }
  } finally {
    await handle.close()
  }
}

async function inspectConflicts(
  workspaceRoot: string,
  input: CreatorSkillInstallInput,
): Promise<{
  conflicts: CreatorSkillInstallConflict[]
  existing?: InstalledCreatorSkill
  localModified: boolean
  targetIdentity: CreatorSkillTargetIdentity
  conflictDetails: CreatorSkillConflictDetails
}> {
  const slug = input.grant.slug
  const targetPath = join(workspaceRoot, 'skills', slug)
  const projectPath = input.workingDirectory
    ? join(input.workingDirectory, '.agents', 'skills', slug)
    : undefined
  if (projectPath && await exists(projectPath)) {
    throw Object.assign(new Error('A project-level Skill with this slug has priority'), {
      code: 'project_skill_conflict',
    })
  }
  const ledger = await readCreatorSkillsLedger(workspaceRoot)
  const existing = ledger.installed.find(item => item.slug === slug)
  const targetIdentity = await inspectCreatorSkillTarget(targetPath)
  const targetExists = targetIdentity.kind !== 'missing'
  const localModified = isTargetLocallyModified(targetIdentity, existing)

  const conflicts: CreatorSkillInstallConflict[] = []
  const existingIdentities: CreatorSkillConflictDetails['existing'] = []
  if (targetExists && !existing) conflicts.push('workspace_skill')
  if (targetExists && !existing) {
    existingIdentities.push({
      source: 'workspace',
      slug,
    })
  }
  if (existing && existing.artifactId !== input.grant.artifactId) {
    conflicts.push('different_artifact')
  }
  if (existing) {
    existingIdentities.push({
      source: 'creator_space',
      artifactId: existing.artifactId,
      organizationId: existing.organizationId,
      slug: existing.slug,
      version: existing.version,
    })
  }
  if (localModified) conflicts.push('local_changes')
  if (await exists(join(homedir(), '.agents', 'skills', slug))) {
    conflicts.push('global_skill')
    existingIdentities.push({
      source: 'global',
      slug,
    })
  }
  return {
    conflicts,
    ...(existing ? { existing } : {}),
    localModified,
    targetIdentity,
    conflictDetails: {
      existing: existingIdentities,
      incoming: {
        source: 'creator_space',
        artifactId: input.grant.artifactId,
        organizationId: input.grant.organizationId,
        slug: input.grant.slug,
        version: input.grant.version,
      },
    },
  }
}

interface CreatorSkillTargetIdentity {
  kind: 'missing' | 'scanned' | 'unreadable'
  contentDigest?: string
  directoryIdentity?: string
}

async function inspectCreatorSkillTarget(
  targetPath: string,
): Promise<CreatorSkillTargetIdentity> {
  if (!await exists(targetPath)) return { kind: 'missing' }
  try {
    const beforeIdentity = await directoryIdentity(targetPath)
    const scanned = await scanCreatorSkillDirectory(targetPath)
    const afterIdentity = await directoryIdentity(targetPath)
    if (beforeIdentity !== afterIdentity) return { kind: 'unreadable' }
    return {
      kind: 'scanned',
      contentDigest: scanned.contentDigest,
      directoryIdentity: afterIdentity,
    }
  } catch {
    return { kind: 'unreadable' }
  }
}

function targetIdentitiesEqual(
  left: CreatorSkillTargetIdentity,
  right: CreatorSkillTargetIdentity,
): boolean {
  return left.kind === right.kind
    && left.contentDigest === right.contentDigest
    && left.directoryIdentity === right.directoryIdentity
}

async function issueForceDeleteCredential(args: {
  workspaceRoot: string
  slug: string
  artifactId: string
  archiveChecksum: string
  targetPath: string
}): Promise<string> {
  const identity = await inspectCreatorSkillTarget(args.targetPath)
  if (
    identity.kind !== 'scanned'
    || !identity.contentDigest
    || !identity.directoryIdentity
  ) {
    throw Object.assign(
      new Error('Creator Skill changed while preparing permanent deletion'),
      { code: 'creator_skill_force_delete_stale' },
    )
  }
  const token = randomBytes(32).toString('base64url')
  const store = await readForceDeleteCredentialStore(args.workspaceRoot)
  const credential: StoredForceDeleteCredential = {
    tokenHash: hashForceDeleteCredential(token),
    slug: args.slug,
    artifactId: args.artifactId,
    archiveChecksum: args.archiveChecksum,
    directoryIdentity: identity.directoryIdentity,
    contentFingerprint: identity.contentDigest,
    expiresAt: new Date(Date.now() + FORCE_DELETE_CREDENTIAL_TTL_MS).toISOString(),
  }
  await writeForceDeleteCredentialStore(args.workspaceRoot, {
    schemaVersion: 1,
    credentials: [
      ...store.credentials.filter(item => item.slug !== args.slug),
      credential,
    ],
  })
  return token
}

async function pendingForceDeleteCredential(
  workspaceRoot: string,
  slug: string,
): Promise<StoredForceDeleteCredential | undefined> {
  const store = await readForceDeleteCredentialStore(workspaceRoot)
  return store.credentials.find(credential => credential.slug === slug)
}

async function removeForceDeleteCredential(
  workspaceRoot: string,
  slug: string,
): Promise<void> {
  const store = await readForceDeleteCredentialStore(workspaceRoot)
  await writeForceDeleteCredentialStore(workspaceRoot, {
    schemaVersion: 1,
    credentials: store.credentials.filter(credential => credential.slug !== slug),
  })
}

async function validateForceDeleteCredential(args: {
  workspaceRoot: string
  slug: string
  token?: string
  targetPath: string
}): Promise<StoredForceDeleteCredential> {
  if (!args.token) {
    throw Object.assign(new Error('Permanent deletion requires a confirmation credential'), {
      code: 'creator_skill_force_delete_credential_required',
    })
  }
  const credential = await pendingForceDeleteCredential(args.workspaceRoot, args.slug)
  const tokenHash = hashForceDeleteCredential(args.token)
  if (
    !credential
    || !credentialHashesEqual(credential.tokenHash, tokenHash)
    || Date.parse(credential.expiresAt) <= Date.now()
  ) {
    throw Object.assign(new Error('Permanent deletion credential is invalid or expired'), {
      code: 'creator_skill_force_delete_credential_required',
    })
  }
  const identity = await inspectCreatorSkillTarget(args.targetPath)
  if (
    identity.kind !== 'scanned'
    || identity.directoryIdentity !== credential.directoryIdentity
    || identity.contentDigest !== credential.contentFingerprint
  ) {
    throw Object.assign(new Error('Creator Skill changed after deletion confirmation'), {
      code: 'creator_skill_force_delete_stale',
    })
  }
  return credential
}

export async function hasPendingCreatorSkillForceDelete(
  workspaceRoot: string,
  slug: string,
): Promise<boolean> {
  if (!SKILL_SLUG_PATTERN.test(slug)) return false
  return Boolean(await pendingForceDeleteCredential(workspaceRoot, slug))
}

function isTargetLocallyModified(
  identity: CreatorSkillTargetIdentity,
  existing?: InstalledCreatorSkill,
): boolean {
  if (!existing || identity.kind === 'missing') return Boolean(existing)
  return identity.kind !== 'scanned'
    || identity.contentDigest !== existing.contentDigest
}

function lateLocalChangesResult(
  input: CreatorSkillInstallInput,
  conflictDetails: CreatorSkillConflictDetails,
): CreatorSkillOperationResult {
  return errorResult({
    operationId: input.operationId,
    stage: 'prepare',
    errorCode: 'creator_skill_conflict',
    message: 'The existing Skill changed while the update was being prepared',
    conflicts: ['local_changes'],
    conflictDetails,
  })
}

function confirmationsMissing(
  conflicts: CreatorSkillInstallConflict[],
  input: CreatorSkillInstallInput,
): CreatorSkillInstallConflict[] {
  return conflicts.filter(conflict => {
    if (conflict === 'global_skill') return !input.confirmGlobalOverride
    if (conflict === 'local_changes') return !input.backupLocalChanges
    return !input.replaceExisting
  })
}

async function preserveConcurrentRecreation(args: {
  workspaceRoot: string
  slug: string
  targetPath: string
  version?: string
}): Promise<string | undefined> {
  if (!await exists(args.targetPath)) return undefined
  return withBackupManagementLock(args.workspaceRoot, async () => {
    if (!await exists(args.targetPath)) return undefined
    await assertCanonicalPathWhenPresent(
      args.targetPath,
      'Concurrent Creator Skill recreation',
    )
    const backup = await allocateCreatorSkillBackupTarget(
      args.workspaceRoot,
      args.slug,
    )
    await rename(args.targetPath, backup.targetPath)
    await writeBackupMetadata(backup.targetPath, {
      schemaVersion: 1,
      slug: args.slug,
      backupId: basename(backup.targetPath),
      operation: 'concurrent_recreation',
      createdAt: inferBackupCreatedAt(backup.targetPath),
      ...(args.version ? { version: args.version } : {}),
    })
    return backup.targetPath
  })
}

async function removeTransactionTargetOrPreserveRecreation(args: {
  workspaceRoot: string
  targetPath: string
  journal: CreatorSkillJournal
}): Promise<void> {
  if (!await exists(args.targetPath)) return
  const currentIdentity = await directoryIdentity(args.targetPath).catch(() => undefined)
  if (
    args.journal.promotedDirectoryIdentity
    && currentIdentity === args.journal.promotedDirectoryIdentity
  ) {
    await rm(args.targetPath, { recursive: true, force: true })
    return
  }
  await preserveConcurrentRecreation({
    workspaceRoot: args.workspaceRoot,
    slug: args.journal.slug,
    targetPath: args.targetPath,
    version: args.journal.backupVersion,
  })
}

async function assertPromotedTargetIdentity(
  targetPath: string,
  expectedIdentity: string,
): Promise<void> {
  const actualIdentity = await directoryIdentity(targetPath).catch(() => undefined)
  if (actualIdentity !== expectedIdentity) {
    throw Object.assign(new Error('Creator Skill target was recreated during commit'), {
      code: 'creator_skill_conflict',
    })
  }
}

async function rollbackJournal(
  workspaceRoot: string,
  operationPath: string,
  journal: CreatorSkillJournal,
): Promise<void> {
  const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal)
  if (journal.state === 'preparing') {
    await rm(operationPath, { recursive: true, force: true })
    return
  }
  const recoverableBackupPath = await exists(paths.transactionBackupPath)
    ? paths.transactionBackupPath
    : paths.preserveBackupPath && await exists(paths.preserveBackupPath)
      ? paths.preserveBackupPath
      : undefined
  const detachedTargetAlreadyRestored = (
    journal.action === 'uninstall'
    && journal.state === 'detaching'
    && !recoverableBackupPath
    && await exists(paths.targetPath)
  )
  // A directory rename can be durable before the following journal update.
  // Once old_backed_up is persisted, targetPath may therefore already contain
  // the promoted stage even though new_installed was never recorded. The same
  // applies to the prepared -> old_backed_up window when a backup is present.
  if (
    !detachedTargetAlreadyRestored
    && (recoverableBackupPath || journal.state !== 'prepared')
  ) {
    await removeTransactionTargetOrPreserveRecreation({
      workspaceRoot,
      targetPath: paths.targetPath,
      journal,
    })
  }
  if (recoverableBackupPath) {
    await mkdir(dirname(paths.targetPath), { recursive: true })
    await rename(recoverableBackupPath, paths.targetPath)
  }
  if (paths.preserveBackupPath) {
    await rm(backupMetadataPath(paths.preserveBackupPath), { force: true })
  }
  await restoreLedgerSnapshot(workspaceRoot, journal.oldLedger, journal.slug)
  await rm(operationPath, { recursive: true, force: true })
}

async function publishCommittedBackup(
  workspaceRoot: string,
  operationPath: string,
  journal: CreatorSkillJournal,
): Promise<string | undefined> {
  const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal)
  const preserveBackupPath = paths.preserveBackupPath
  if (!preserveBackupPath) return undefined
  return withBackupManagementLock(workspaceRoot, async () => {
    const metadata = backupMetadataFromJournal(journal, preserveBackupPath)
    const transactionExists = await exists(paths.transactionBackupPath)
    const preserveExists = await exists(preserveBackupPath)
    if (transactionExists && preserveExists) {
      throw invalidBackupPath(
        'Creator Skill committed backup exists in both transaction and permanent storage',
      )
    }
    if (transactionExists) {
      const backupTarget = await resolveCreatorSkillBackupTarget({
        workspaceRoot,
        slug: journal.slug,
        backupId: basename(preserveBackupPath),
        createAncestors: true,
      })
      if (
        backupTarget.targetPath !== preserveBackupPath
        || backupTarget.targetExists
      ) {
        throw invalidBackupPath('Creator Skill backup target is unsafe or already exists')
      }
      if (metadata) await writeBackupMetadata(preserveBackupPath, metadata)
      await rename(paths.transactionBackupPath, preserveBackupPath)
    }
    if (!await exists(preserveBackupPath)) return undefined
    if (metadata) await writeBackupMetadata(preserveBackupPath, metadata)
    return preserveBackupPath
  })
}

async function finalizeCommittedJournal(
  workspaceRoot: string,
  operationPath: string,
  journal: CreatorSkillJournal,
): Promise<void> {
  await publishCommittedBackup(workspaceRoot, operationPath, journal)
  if (journal.action === 'uninstall' && !journal.preserveBackupPath) {
    await removeForceDeleteCredential(workspaceRoot, journal.slug)
  }
  await rm(operationPath, { recursive: true, force: true })
}

export async function installCreatorSkill(
  workspaceRoot: string,
  input: CreatorSkillInstallInput,
  dependencies: CreatorSkillInstallerDependencies = {},
): Promise<CreatorSkillOperationResult> {
  const queueWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const key = `${queueWorkspace}\0${input.grant.slug}`
  return enqueue(key, async () => {
    let releaseLock: (() => Promise<void>) | undefined
    let releaseLedgerLock: (() => Promise<void>) | undefined
    const controller = new AbortController()
    const ownerId = dependencies.operationOwnerId ?? input.workspaceId
    const controllerKey = cancellationKey(
      queueWorkspace,
      ownerId,
      input.operationId,
    )
    let controllerRegistered = false
    let operationPath: string | undefined
    let journal: CreatorSkillJournal | undefined
    let commitStarted = false
    let committedResult: Extract<CreatorSkillOperationResult, { success: true }> | undefined
    try {
      releaseLock = await acquireOperationLock(queueWorkspace, input.grant.slug)
      const conflictState = await inspectConflicts(queueWorkspace, input)
      const missing = confirmationsMissing(conflictState.conflicts, input)
      if (missing.length > 0) {
        return errorResult({
          operationId: input.operationId,
          stage: 'prepare',
          errorCode: 'creator_skill_conflict',
          message: 'Installing this Skill requires explicit conflict confirmation',
          conflicts: missing,
          conflictDetails: conflictState.conflictDetails,
        })
      }

      const resolvedOperation = await reserveOperationPath(
        queueWorkspace,
        input.operationId,
      )
      const canonicalWorkspace = resolvedOperation.workspaceRoot
      operationPath = resolvedOperation.operationPath
      const stagePath = join(operationPath, 'stage')
      const archivePath = join(operationPath, 'archive.zip')
      const transactionBackupPath = join(operationPath, 'backup')
      const targetPath = resolve(canonicalWorkspace, 'skills', input.grant.slug)
      assertChildPath(resolve(canonicalWorkspace, 'skills'), targetPath, 'Creator Skill target')
      journal = {
        schemaVersion: 1,
        operationId: input.operationId,
        action: 'install',
        slug: input.grant.slug,
        targetPath,
        transactionBackupPath,
        ledgerPath: resolve(canonicalWorkspace, 'creator-skills.json'),
        oldLedger: null,
        state: 'preparing',
      }
      await persistJournal(join(operationPath, 'journal.json'), journal, dependencies)
      await mkdir(stagePath, { recursive: true, mode: 0o700 })
      cancellationControllers.set(controllerKey, controller)
      controllerRegistered = true

      report(dependencies, input, 'download', 2, true)
      const policyMax = Math.min(
        input.grant.validationPolicy.maxArchiveBytes,
        HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes,
      )
      await downloadArchive({
        url: input.grant.url,
        outputPath: archivePath,
        maxBytes: policyMax,
        signal: controller.signal,
        fetchImpl: dependencies.fetch ?? fetch,
        onChunk: (downloaded, total) => report(
          dependencies,
          input,
          'download',
          total ? Math.min(35, Math.round((downloaded / total) * 35)) : 20,
          true,
        ),
      })

      report(dependencies, input, 'validate', 40, true)
      await validateCreatorSkillArchive({
        archivePath,
        slug: input.grant.slug,
        destinationRoot: stagePath,
        policy: input.grant.validationPolicy,
        expectedArchiveChecksum: input.grant.archiveChecksum,
        expectedContentDigest: input.grant.contentDigest,
        expectedManifest: input.grant.manifest,
      })
      if (controller.signal.aborted) {
        throw Object.assign(new Error('Installation cancelled'), {
          code: 'creator_skill_cancelled',
        })
      }

      report(dependencies, input, 'prepare', 65, true)
      await dependencies.assertCommitAllowed?.({
        artifactId: input.grant.artifactId,
        version: input.grant.version,
        archiveChecksum: input.grant.archiveChecksum,
      })
      if (controller.signal.aborted) {
        throw Object.assign(new Error('Installation cancelled'), {
          code: 'creator_skill_cancelled',
        })
      }

      releaseLedgerLock = await acquireLedgerMutationLock(
        canonicalWorkspace,
        dependencies.onLedgerMutationLockContended,
      )
      const ledger = await readCreatorSkillsLedger(canonicalWorkspace)
      await dependencies.onLedgerMutationLocked?.()
      const previous = conflictState.existing
      const ignoredVersion = (
        previous
        && previous.artifactId === input.grant.artifactId
        && compareStableSemver(input.grant.version, previous.version) < 0
      ) ? previous.version : undefined
      const installation: InstalledCreatorSkill = {
        artifactId: input.grant.artifactId,
        organizationId: input.grant.organizationId,
        slug: input.grant.slug,
        version: input.grant.version,
        archiveChecksum: input.grant.archiveChecksum,
        contentDigest: input.grant.contentDigest,
        installedAt: new Date().toISOString(),
        lastKnownStatus: 'active',
        lastCheckedAt: new Date().toISOString(),
        ...(ignoredVersion ? { ignoredVersion } : {}),
      }
      await assertCanonicalPathWhenPresent(resolve(canonicalWorkspace, 'skills'), 'Workspace Skills root')
      await assertCanonicalPathWhenPresent(targetPath, 'Creator Skill target')
      const oldLedger = await readLedgerSnapshot(canonicalWorkspace)
      await dependencies.beforeCommitSnapshot?.()
      const preCommitTargetIdentity = await inspectCreatorSkillTarget(targetPath)
      const changedDuringPreparation = !targetIdentitiesEqual(
        conflictState.targetIdentity,
        preCommitTargetIdentity,
      )
      if (changedDuringPreparation && !input.backupLocalChanges) {
        await rm(operationPath, { recursive: true, force: true })
        return lateLocalChangesResult(input, conflictState.conflictDetails)
      }
      // A process can keep writing through an open file descriptor after the
      // directory is renamed. Every replaced directory is therefore moved to
      // a permanent, user-managed backup before transaction cleanup. Limiting
      // this to directories that were already known to be modified would leave
      // post-rename writes vulnerable to silent deletion.
      let preserveBackupPath = preCommitTargetIdentity.kind !== 'missing'
        ? (await allocateCreatorSkillBackupTarget(
            canonicalWorkspace,
            input.grant.slug,
          )).targetPath
        : undefined
      let backupOperation: CreatorSkillBackupOperation | undefined = preserveBackupPath
        ? (
            conflictState.localModified
            || changedDuringPreparation
            || isTargetLocallyModified(preCommitTargetIdentity, conflictState.existing)
          )
          ? 'modified_update'
          : 'update_safety_snapshot'
        : undefined
      const backupCreatedAt = preserveBackupPath
        ? inferBackupCreatedAt(preserveBackupPath)
        : undefined
      journal.oldLedger = oldLedger
      journal.state = 'prepared'
      if (preserveBackupPath) journal.preserveBackupPath = preserveBackupPath
      if (backupOperation) journal.backupOperation = backupOperation
      if (conflictState.existing?.version) {
        journal.backupVersion = conflictState.existing.version
      }
      if (backupCreatedAt) journal.backupCreatedAt = backupCreatedAt
      const journalPath = join(operationPath, 'journal.json')
      await persistJournal(journalPath, journal, dependencies)

      commitStarted = true
      report(dependencies, input, 'commit', 72, false)
      await mkdir(dirname(targetPath), { recursive: true })
      if (await exists(targetPath)) {
        await rename(targetPath, transactionBackupPath)
      }
      const capturedTargetIdentity = await inspectCreatorSkillTarget(transactionBackupPath)
      const changedAtRename = !targetIdentitiesEqual(
        preCommitTargetIdentity,
        capturedTargetIdentity,
      )
      if (changedAtRename && !input.backupLocalChanges) {
        await rollbackJournal(canonicalWorkspace, operationPath, journal)
        return lateLocalChangesResult(input, conflictState.conflictDetails)
      }
      const capturedLocalModified = isTargetLocallyModified(
        capturedTargetIdentity,
        conflictState.existing,
      )
      if (
        preserveBackupPath
        && backupOperation !== 'modified_update'
        && (capturedLocalModified || changedDuringPreparation || changedAtRename)
      ) {
        backupOperation = 'modified_update'
        journal.backupOperation = backupOperation
        await persistJournal(journalPath, journal, dependencies)
      }
      const promotedDirectoryIdentity = await directoryIdentity(
        join(stagePath, input.grant.slug),
      )
      journal.promotedDirectoryIdentity = promotedDirectoryIdentity
      journal.state = 'old_backed_up'
      await persistJournal(journalPath, journal, dependencies)

      await preserveConcurrentRecreation({
        workspaceRoot: canonicalWorkspace,
        slug: input.grant.slug,
        targetPath,
        version: conflictState.existing?.version,
      })
      await rename(join(stagePath, input.grant.slug), targetPath)
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity)
      journal.state = 'new_installed'
      await persistJournal(journalPath, journal, dependencies)
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity)

      await writeCreatorSkillsLedger(
        canonicalWorkspace,
        replaceLedgerInstallation(ledger, installation),
        dependencies.ledgerWriteDependencies,
      )
      journal.state = 'ledger_committed'
      await persistJournal(journalPath, journal, dependencies)
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity)

      // `committed` is the point of no return. Persist it durably before the
      // hidden transaction backup is published to the user-managed backup
      // directory, so every earlier checkpoint can still restore both the
      // previous directory and previous Ledger.
      journal.state = 'committed'
      const committedJournalDurable = await writeJournal(
        journalPath,
        journal,
        dependencies.syncJournalDirectory,
      )
      committedResult = {
        success: true,
        operationId: input.operationId,
        installed: installation,
      }
      await dependencies.onJournalPersisted?.(journal.state)
      if (!committedJournalDurable) {
        // This filesystem cannot prove that the committed rename reached stable
        // storage. Keep the journal and rollback backup for startup recovery;
        // it can safely finalize a visible committed journal or roll back an
        // older checkpoint after a crash.
        report(dependencies, input, 'refresh', 100, false)
        return committedResult
      }
      const backupPath = await publishCommittedBackup(
        canonicalWorkspace,
        operationPath,
        journal,
      )
      if (!backupPath) {
        await rm(transactionBackupPath, { recursive: true, force: true })
      }
      await dependencies.onCleanupStep?.('transaction_backup_removed')
      await rm(operationPath, { recursive: true, force: true })
      await dependencies.onCleanupStep?.('operation_removed')

      report(dependencies, input, 'refresh', 100, false)
      return committedResult
    } catch (error) {
      dependencies.onError?.(error)
      if (journal?.state === 'committed' && committedResult) {
        // The directory and Ledger are already atomically committed. Leave
        // cleanup to startup recovery rather than attempting an unsafe rollback
        // after the point of no return.
        report(dependencies, input, 'refresh', 100, false)
        return committedResult
      }
      if (commitStarted && operationPath && journal) {
        try {
          await rollbackJournal(workspaceRoot, operationPath, journal)
        } catch {
          // Recovery will retry the journal on next server start.
        }
      } else if (operationPath) {
        await rm(operationPath, { recursive: true, force: true }).catch(() => {})
      }
      const record = error && typeof error === 'object'
        ? error as {
            code?: string
            message?: string
            path?: string
            issues?: Array<{ path?: string }>
          }
        : {}
      const code = safeOperationErrorCode(
        record.code,
        'creator_skill_install_failed',
      )
      const cancelled = code === 'creator_skill_cancelled' || controller.signal.aborted
      const failureStage = commitStarted
        ? 'commit'
        : code.includes('download')
          ? 'download'
          : code.includes('conflict') || code === 'creator_skill_operation_in_progress'
            ? 'prepare'
            : 'validate'
      const issuePath = record.issues?.find(item => item.path)?.path
      const failurePath = issuePath
        && !issuePath.startsWith('/')
        && !/^[a-zA-Z]:/.test(issuePath)
        && !issuePath.includes('\\')
        && !issuePath.split('/').some(segment => segment === '..')
        ? issuePath.replace(new RegExp(`^${input.grant.slug}/`), '')
        : undefined
      return errorResult({
        operationId: input.operationId,
        stage: failureStage,
        errorCode: cancelled ? 'creator_skill_cancelled' : code,
        message: cancelled
          ? 'Installation was cancelled before the commit boundary'
          : 'Creator Skill installation failed',
        ...(failurePath ? { path: failurePath } : {}),
        retryable: !commitStarted
          && !cancelled
          && code !== 'project_skill_conflict',
      })
    } finally {
      if (
        controllerRegistered
        && cancellationControllers.get(controllerKey) === controller
      ) {
        cancellationControllers.delete(controllerKey)
      }
      await releaseLedgerLock?.()
      await releaseLock?.()
    }
  })
}

export async function cancelCreatorSkillOperation(
  workspaceRoot: string,
  ownerId: string,
  operationId: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(operationId)) return false
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const controller = cancellationControllers.get(cancellationKey(
    canonicalWorkspace,
    ownerId,
    operationId,
  ))
  if (!controller) return false
  controller.abort()
  return true
}

export async function uninstallCreatorSkill(args: {
  workspaceRoot: string
  workspaceId: string
  operationId: string
  slug: string
  forceDeleteModified?: boolean
  forceDeleteCredential?: string
}, dependencies: CreatorSkillUninstallerDependencies = {}): Promise<CreatorSkillOperationResult> {
  const queueWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot)
  const key = `${queueWorkspace}\0${args.slug}`
  return enqueue(key, async () => {
    let releaseLock: (() => Promise<void>) | undefined
    let releaseLedgerLock: (() => Promise<void>) | undefined
    let journal: CreatorSkillJournal | undefined
    let operationPath: string | undefined
    let committedResult: Extract<CreatorSkillOperationResult, { success: true }> | undefined
    try {
      releaseLock = await acquireOperationLock(queueWorkspace, args.slug)
      const resolvedOperation = await resolveOperationPath(
        queueWorkspace,
        args.operationId,
      )
      const canonicalWorkspace = resolvedOperation.workspaceRoot
      releaseLedgerLock = await acquireLedgerMutationLock(
        canonicalWorkspace,
        dependencies.onLedgerMutationLockContended,
      )
      const ledger = await readCreatorSkillsLedger(canonicalWorkspace)
      await dependencies.onLedgerMutationLocked?.()
      const installed = ledger.installed.find(item => item.slug === args.slug)
      const pendingCredential = installed
        ? undefined
        : await pendingForceDeleteCredential(canonicalWorkspace, args.slug)
      if (!installed && !pendingCredential) {
        return errorResult({
          operationId: args.operationId,
          stage: 'prepare',
          errorCode: 'creator_skill_not_installed',
          message: 'This workspace Skill is not managed by Creator Space',
        })
      }
      const targetPath = resolve(canonicalWorkspace, 'skills', args.slug)
      assertChildPath(resolve(canonicalWorkspace, 'skills'), targetPath, 'Creator Skill target')
      await assertCanonicalPathWhenPresent(resolve(canonicalWorkspace, 'skills'), 'Workspace Skills root')
      await assertCanonicalPathWhenPresent(targetPath, 'Creator Skill target')
      const targetIdentity = await inspectCreatorSkillTarget(targetPath)
      await dependencies.beforeCommitSnapshot?.()
      let validatedForceCredential: StoredForceDeleteCredential | undefined
      if (args.forceDeleteModified) {
        if (installed) {
          throw Object.assign(new Error('Detach the modified Creator Skill before deleting it'), {
            code: 'creator_skill_force_delete_credential_required',
          })
        }
        validatedForceCredential = await validateForceDeleteCredential({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          token: args.forceDeleteCredential,
          targetPath,
        })
      }
      const nextLedger = installed
        ? removeLedgerInstallation(ledger, args.slug)
        : ledger
      if (targetIdentity.kind === 'missing') {
        await writeCreatorSkillsLedger(
          canonicalWorkspace,
          nextLedger,
          dependencies.ledgerWriteDependencies,
        )
        if (pendingCredential) {
          await removeForceDeleteCredential(canonicalWorkspace, args.slug)
        }
        return {
          success: true,
          operationId: args.operationId,
        }
      }

      // A normal uninstall only detaches content that was already modified at
      // the manifest scan boundary. A clean directory is renamed away from the
      // Skill loading path into a permanent safety snapshot. Writes arriving
      // after the scan keep targeting that same inode and are therefore
      // retained by the snapshot instead of silently disappearing.
      if (
        !args.forceDeleteModified
        && (
          (installed && isTargetLocallyModified(targetIdentity, installed))
          || (!installed && pendingCredential)
        )
      ) {
        await writeCreatorSkillsLedger(
          canonicalWorkspace,
          nextLedger,
          dependencies.ledgerWriteDependencies,
        )
        let forceDeleteCredential: string
        try {
          forceDeleteCredential = await issueForceDeleteCredential({
            workspaceRoot: canonicalWorkspace,
            slug: args.slug,
            artifactId: installed?.artifactId ?? pendingCredential!.artifactId,
            archiveChecksum: installed?.archiveChecksum
              ?? pendingCredential!.archiveChecksum,
            targetPath,
          })
        } catch (error) {
          if (installed) {
            await writeCreatorSkillsLedger(
              canonicalWorkspace,
              ledger,
              dependencies.ledgerWriteDependencies,
            )
          }
          throw error
        }
        return {
          success: true,
          operationId: args.operationId,
          detached: true,
          forceDeleteCredential,
        }
      }

      const reservedOperation = await reserveOperationPath(
        canonicalWorkspace,
        args.operationId,
      )
      operationPath = reservedOperation.operationPath
      const transactionBackupPath = join(operationPath, 'backup')
      const preserveBackupPath = !args.forceDeleteModified
        ? (await allocateCreatorSkillBackupTarget(
            canonicalWorkspace,
            args.slug,
          )).targetPath
        : undefined
      journal = {
        schemaVersion: 1,
        operationId: args.operationId,
        action: 'uninstall',
        slug: args.slug,
        targetPath,
        transactionBackupPath,
        ledgerPath: resolve(canonicalWorkspace, 'creator-skills.json'),
        oldLedger: await readLedgerSnapshot(canonicalWorkspace),
        state: 'prepared',
        ...(preserveBackupPath ? {
          preserveBackupPath,
          backupOperation: 'clean_uninstall_snapshot',
          backupVersion: installed?.version,
          backupCreatedAt: inferBackupCreatedAt(preserveBackupPath),
        } : {}),
      }
      const journalPath = join(operationPath, 'journal.json')
      await persistJournal(journalPath, journal, dependencies)
      if (await exists(targetPath)) await rename(targetPath, transactionBackupPath)
      await assertCanonicalPathWhenPresent(
        transactionBackupPath,
        'Creator Skill uninstall snapshot',
      )
      if (validatedForceCredential) {
        const captured = await inspectCreatorSkillTarget(transactionBackupPath)
        if (
          captured.kind !== 'scanned'
          || captured.directoryIdentity !== validatedForceCredential.directoryIdentity
          || captured.contentDigest !== validatedForceCredential.contentFingerprint
        ) {
          throw Object.assign(new Error('Creator Skill changed after deletion confirmation'), {
            code: 'creator_skill_force_delete_stale',
          })
        }
      }
      journal.state = 'old_backed_up'
      await persistJournal(journalPath, journal, dependencies)
      if (args.forceDeleteModified && await exists(targetPath)) {
        throw Object.assign(new Error('Creator Skill target was recreated during deletion'), {
          code: 'creator_skill_force_delete_stale',
        })
      }
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version,
        })
      }
      await writeCreatorSkillsLedger(
        canonicalWorkspace,
        nextLedger,
        dependencies.ledgerWriteDependencies,
      )
      journal.state = 'ledger_committed'
      await persistJournal(journalPath, journal, dependencies)
      if (args.forceDeleteModified && await exists(targetPath)) {
        throw Object.assign(new Error('Creator Skill target was recreated during deletion'), {
          code: 'creator_skill_force_delete_stale',
        })
      }
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version,
        })
      }

      journal.state = 'committed'
      const committedJournalDurable = await writeJournal(
        journalPath,
        journal,
        dependencies.syncJournalDirectory,
      )
      committedResult = {
        success: true,
        operationId: args.operationId,
      }
      await dependencies.onJournalPersisted?.(journal.state)
      if (!committedJournalDurable) return committedResult
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version,
        })
      }
      const backupPath = await publishCommittedBackup(
        canonicalWorkspace,
        operationPath,
        journal,
      )
      if (!backupPath) {
        await rm(transactionBackupPath, { recursive: true, force: true })
      }
      if (args.forceDeleteModified) {
        await removeForceDeleteCredential(canonicalWorkspace, args.slug)
      }
      await dependencies.onCleanupStep?.('transaction_backup_removed')
      await rm(operationPath, { recursive: true, force: true })
      await dependencies.onCleanupStep?.('operation_removed')
      return committedResult
    } catch (error) {
      dependencies.onError?.(error)
      if (journal?.state === 'committed' && committedResult) {
        return committedResult
      }
      if (journal && operationPath) {
        await rollbackJournal(args.workspaceRoot, operationPath, journal).catch(() => {})
      }
      const record = error && typeof error === 'object'
        ? error as { code?: string; message?: string }
        : {}
      return errorResult({
        operationId: args.operationId,
        stage: 'commit',
        errorCode: safeOperationErrorCode(
          record.code,
          'creator_skill_uninstall_failed',
        ),
        message: 'Creator Skill uninstall failed',
      })
    } finally {
      await releaseLedgerLock?.()
      await releaseLock?.()
    }
  })
}

async function cleanupAbandonedPreJournalOperation(
  operationPath: string,
): Promise<boolean> {
  const entries = await readdir(operationPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'stage') {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false
      continue
    }
    if (entry.name === 'archive.zip') {
      if (!entry.isFile() || entry.isSymbolicLink()) return false
      continue
    }
    if (
      /^journal\.json\.[0-9a-f-]+\.tmp$/i.test(entry.name)
      && entry.isFile()
      && !entry.isSymbolicLink()
    ) {
      continue
    }
    // A backup or any unknown entry could be the only recovery material.
    return false
  }
  await rm(operationPath, { recursive: true, force: true })
  return true
}

export async function recoverCreatorSkillOperations(workspaceRoot: string): Promise<void> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const root = resolve(canonicalWorkspace, OP_DIRECTORY)
  assertChildPath(canonicalWorkspace, root, 'Creator Skill operation root')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) {
    throw invalidOperationPath('Creator Skill operation root cannot be a symbolic link')
  }
  for (const entry of entries) {
    if (entry.name === 'locks') continue
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
      throw Object.assign(
        new Error(`Creator Skill recovery requires attention for operation '${entry.name}'`),
        { code: 'creator_skill_recovery_failed' },
      )
    }
    const { operationPath } = await resolveOperationPath(canonicalWorkspace, entry.name)
    try {
      const journalPath = resolve(operationPath, 'journal.json')
      assertChildPath(operationPath, journalPath, 'Creator Skill recovery journal')
      const journalStats = await lstatIfPresent(journalPath)
      if (!journalStats) {
        if (await cleanupAbandonedPreJournalOperation(operationPath)) continue
        throw invalidOperationPath(
          'Creator Skill operation without a journal contains recovery material',
        )
      }
      if (!journalStats.isFile() || journalStats.size > MAX_JOURNAL_BYTES) {
        throw invalidOperationPath('Creator Skill recovery journal is oversized or invalid')
      }
      const journal = JSON.parse(
        await readFile(journalPath, 'utf8'),
      ) as CreatorSkillJournal
      await deriveJournalPaths(canonicalWorkspace, operationPath, journal)
      if (journal.state === 'committed') {
        await finalizeCommittedJournal(canonicalWorkspace, operationPath, journal)
      } else {
        await rollbackJournal(canonicalWorkspace, operationPath, journal)
      }
    } catch {
      // Preserve an unreadable operation directory for diagnostics. Deleting it
      // could discard the only transaction backup if a journal was corrupted
      // after the old Skill had already been renamed.
      throw Object.assign(
        new Error(`Creator Skill recovery requires attention for operation '${entry.name}'`),
        { code: 'creator_skill_recovery_failed' },
      )
    }
  }
  const lockRoot = resolve(root, 'locks')
  assertChildPath(root, lockRoot, 'Creator Skill lock directory')
  if (await exists(lockRoot)) {
    const lockStats = await stat(lockRoot)
    if (lockStats.isDirectory()) {
      const canonicalLockRoot = await realpath(lockRoot)
      if (canonicalLockRoot !== lockRoot) {
        throw invalidOperationPath('Creator Skill lock directory cannot be a symbolic link')
      }
    }
    await rm(lockRoot, { recursive: true, force: true })
  }
}

export async function listCreatorSkillBackups(
  workspaceRoot: string,
): Promise<CreatorSkillBackup[]> {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot)
  const root = resolve(canonicalWorkspace, BACKUP_DIRECTORY)
  assertChildPath(canonicalWorkspace, root, 'Creator Skill backup root')
  const rootStats = await lstatIfPresent(root)
  if (!rootStats) return []
  await assertSafeBackupDirectory(root, canonicalWorkspace, 'Creator Skill backup root')
  let slugs
  try {
    slugs = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const backups: CreatorSkillBackup[] = []
  for (const slugEntry of slugs) {
    if (slugEntry.isSymbolicLink()) {
      throw invalidBackupPath('Creator Skill backup slug cannot be a symbolic link')
    }
    if (!slugEntry.isDirectory()) continue
    if (!SKILL_SLUG_PATTERN.test(slugEntry.name)) continue
    const slugPath = resolve(root, slugEntry.name)
    await assertSafeBackupDirectory(
      slugPath,
      root,
      'Creator Skill slug backup root',
    )
    const versions = await readdir(slugPath, { withFileTypes: true })
    for (const version of versions) {
      if (version.isSymbolicLink()) {
        throw invalidBackupPath('Creator Skill backup target cannot be a symbolic link')
      }
      if (!version.isDirectory()) continue
      if (!BACKUP_NAME_PATTERN.test(version.name)) continue
      const resolved = await resolveCreatorSkillBackupTarget({
        workspaceRoot: canonicalWorkspace,
        slug: slugEntry.name,
        backupId: version.name,
      })
      const metadata = await readBackupMetadata({
        targetPath: resolved.targetPath,
        slug: slugEntry.name,
        backupId: version.name,
      })
      backups.push({
        backupId: version.name,
        slug: slugEntry.name,
        createdAt: metadata?.createdAt ?? inferBackupCreatedAt(resolved.targetPath),
        sizeBytes: await directorySize(resolved.targetPath),
        operation: metadata?.operation ?? 'update_safety_snapshot',
        ...(metadata?.version ? { version: metadata.version } : {}),
      })
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function deleteCreatorSkillBackups(
  workspaceRoot: string,
  backup?: { slug: string; backupId: string },
): Promise<number> {
  return withBackupManagementLock(workspaceRoot, async () => {
    if (!backup) {
      const backups = await listCreatorSkillBackups(workspaceRoot)
      for (const item of backups) {
        const target = await resolveCreatorSkillBackupTarget({
          workspaceRoot,
          slug: item.slug,
          backupId: item.backupId,
        })
        if (!target.targetExists) continue
        await rm(target.targetPath, { recursive: true, force: true })
        await rm(backupMetadataPath(target.targetPath), { force: true })
      }
      return backups.length
    }
    const target = await resolveCreatorSkillBackupTarget({
      workspaceRoot,
      slug: backup.slug,
      backupId: backup.backupId,
    })
    if (!target.targetExists) return 0
    await rm(target.targetPath, { recursive: true, force: true })
    await rm(backupMetadataPath(target.targetPath), { force: true })
    return 1
  })
}

export async function updateCreatorSkillInstallationMetadata(args: {
  workspaceRoot: string
  artifactId: string
  version: string
  archiveChecksum: string
  changes: Pick<
    InstalledCreatorSkill,
    'lastKnownStatus' | 'lastCheckedAt' | 'ignoredVersion'
  >
}, dependencies: CreatorSkillMetadataUpdateDependencies = {}): Promise<boolean> {
  const queueWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot)
  const ledger = await readCreatorSkillsLedger(queueWorkspace)
  const candidate = ledger.installed.find(item =>
    item.artifactId === args.artifactId
    && item.version === args.version
    && item.archiveChecksum === args.archiveChecksum)
  if (!candidate) return false
  const key = `${queueWorkspace}\0${candidate.slug}`
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(queueWorkspace, candidate.slug)
    let releaseLedgerLock: (() => Promise<void>) | undefined
    try {
      releaseLedgerLock = await acquireLedgerMutationLock(
        queueWorkspace,
        dependencies.onLedgerMutationLockContended,
      )
      // Re-read after acquiring both the workspace+slug and workspace Ledger locks.
      const currentLedger = await readCreatorSkillsLedger(queueWorkspace)
      await dependencies.onLedgerMutationLocked?.()
      const current = currentLedger.installed.find(item =>
        item.artifactId === args.artifactId
        && item.version === args.version
        && item.archiveChecksum === args.archiveChecksum)
      if (!current) return false
      const changes = (
        current.lastKnownStatus === 'revoked'
        && args.changes.lastKnownStatus
        && args.changes.lastKnownStatus !== 'revoked'
      ) ? {
          ...args.changes,
          // A precise revoked version is terminal. A delayed active/archived
          // response may refresh its timestamp, but can never clear the warning.
          lastKnownStatus: 'revoked' as const,
        } : args.changes
      await writeCreatorSkillsLedger(
        queueWorkspace,
        replaceLedgerInstallation(currentLedger, {
          ...current,
          ...changes,
        }),
        dependencies.ledgerWriteDependencies,
      )
      return true
    } finally {
      await releaseLedgerLock?.()
      await releaseLock()
    }
  })
}

export async function copyCreatorSkillBackupForTesting(
  source: string,
  workspaceRoot: string,
  slug: string,
): Promise<string> {
  const target = await allocateCreatorSkillBackupTarget(workspaceRoot, slug)
  await cp(source, target.targetPath, { recursive: true, errorOnExist: true })
  return target.targetPath
}
