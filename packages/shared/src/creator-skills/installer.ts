import { randomUUID } from 'node:crypto'
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
  readCreatorSkillsLedger,
  removeLedgerInstallation,
  replaceLedgerInstallation,
  writeCreatorSkillsLedger,
} from './ledger'
import {
  HARD_SKILL_ARCHIVE_POLICY,
  type CreatorSkillBackup,
  type CreatorSkillInstallConflict,
  type CreatorSkillInstallInput,
  type CreatorSkillOperationProgress,
  type CreatorSkillOperationResult,
  type InstalledCreatorSkill,
} from './types'

const OP_DIRECTORY = '.creator-skill-ops'
const BACKUP_DIRECTORY = 'skill-backups'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BACKUP_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024
const processQueues = new Map<string, Promise<void>>()
const cancellationControllers = new Map<string, AbortController>()

export type CreatorSkillJournalState =
  | 'prepared'
  | 'old_backed_up'
  | 'new_installed'
  | 'ledger_committed'
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
}

export interface CreatorSkillInstallerDependencies {
  fetch?: typeof fetch
  onProgress?: (progress: CreatorSkillOperationProgress) => void
  assertCommitAllowed?: (input: {
    artifactId: string
    version: string
    archiveChecksum: string
  }) => Promise<void>
  /** Transaction checkpoint hook used by deterministic crash/fault tests. */
  onJournalPersisted?: (state: CreatorSkillJournalState) => Promise<void> | void
  /** Overrides directory fsync for deterministic durability tests. */
  syncJournalDirectory?: (directoryPath: string) => Promise<void>
  /** Transaction cleanup hook used by deterministic crash/fault tests. */
  onCleanupStep?: (
    step: 'transaction_backup_removed' | 'operation_removed'
  ) => Promise<void> | void
}

function errorResult(args: {
  operationId: string
  stage: CreatorSkillOperationProgress['stage']
  errorCode: string
  message: string
  path?: string
  conflicts?: CreatorSkillInstallConflict[]
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
    diagnostic: JSON.stringify({
      operationId: args.operationId,
      stage: args.stage,
      errorCode: args.errorCode,
      ...(args.path ? { path: args.path } : {}),
    }),
    retryable: args.retryable ?? false,
  }
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function invalidOperationPath(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_creator_skill_operation_path' })
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

function validateJournalShape(
  journal: CreatorSkillJournal,
  expectedOperationId: string,
): void {
  if (
    !journal
    || journal.schemaVersion !== 1
    || journal.operationId !== expectedOperationId
    || !UUID_PATTERN.test(journal.operationId)
    || !SKILL_SLUG_PATTERN.test(journal.slug)
    || !['install', 'uninstall'].includes(journal.action)
    || !['prepared', 'old_backed_up', 'new_installed', 'ledger_committed', 'committed']
      .includes(journal.state)
    || (journal.oldLedger !== null && typeof journal.oldLedger !== 'string')
    || (journal.oldLedger?.length ?? 0) > MAX_JOURNAL_BYTES
  ) {
    throw invalidOperationPath('Creator Skill recovery journal is invalid')
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
    if (!BACKUP_NAME_PATTERN.test(backupName)) {
      throw invalidOperationPath('Creator Skill preserved backup name is invalid')
    }
    const backupRoot = resolve(canonicalWorkspace, BACKUP_DIRECTORY)
    const slugBackupRoot = resolve(backupRoot, journal.slug)
    assertChildPath(canonicalWorkspace, backupRoot, 'Creator Skill backup root')
    assertChildPath(backupRoot, slugBackupRoot, 'Creator Skill slug backup root')
    await assertCanonicalPathWhenPresent(backupRoot, 'Creator Skill backup root')
    await assertCanonicalPathWhenPresent(slugBackupRoot, 'Creator Skill slug backup root')
    preserveBackupPath = resolve(slugBackupRoot, backupName)
    assertChildPath(slugBackupRoot, preserveBackupPath, 'Creator Skill preserved backup')
    if (await canonicalizePotentialPath(journal.preserveBackupPath) !== preserveBackupPath) {
      throw invalidOperationPath('Creator Skill recovery journal contains an out-of-bound backup')
    }
    await assertCanonicalPathWhenPresent(
      preserveBackupPath,
      'Creator Skill preserved backup',
    )
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
): Promise<void> {
  const ledgerPath = join(workspaceRoot, 'creator-skills.json')
  if (snapshot === null) {
    await rm(ledgerPath, { force: true })
    return
  }
  const tempPath = `${ledgerPath}.${randomUUID()}.recovery`
  await writeFile(tempPath, snapshot, { mode: 0o600, flag: 'wx' })
  await rename(tempPath, ledgerPath)
}

async function acquireOperationLock(workspaceRoot: string, slug: string): Promise<() => Promise<void>> {
  if (
    slug !== '__creator-skill-backups__'
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

async function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = processQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolvePromise => {
    release = resolvePromise
  })
  const queued = previous.then(() => current)
  processQueues.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (processQueues.get(key) === queued) processQueues.delete(key)
  }
}

async function withBackupManagementLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${resolve(workspaceRoot)}\0__creator-skill-backups__`
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(
      workspaceRoot,
      '__creator-skill-backups__',
    )
    try {
      return await operation()
    } finally {
      await releaseLock()
    }
  })
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
}> {
  const slug = input.grant.slug
  const targetPath = join(workspaceRoot, 'skills', slug)
  const projectPath = input.workingDirectory
    ? join(input.workingDirectory, '.agents', 'skills', slug)
    : undefined
  if (projectPath && await exists(projectPath)) {
    throw Object.assign(new Error('A project-level Skill with this slug has priority'), {
      code: 'project_skill_conflict',
      path: projectPath,
    })
  }
  const ledger = await readCreatorSkillsLedger(workspaceRoot)
  const existing = ledger.installed.find(item => item.slug === slug)
  const targetExists = await exists(targetPath)
  let localModified = false
  if (existing && targetExists) {
    try {
      localModified = (
        await scanCreatorSkillDirectory(targetPath)
      ).contentDigest !== existing.contentDigest
    } catch {
      localModified = true
    }
  }

  const conflicts: CreatorSkillInstallConflict[] = []
  if (targetExists && !existing) conflicts.push('workspace_skill')
  if (existing && existing.artifactId !== input.grant.artifactId) {
    conflicts.push('different_artifact')
  }
  if (localModified) conflicts.push('local_changes')
  if (await exists(join(homedir(), '.agents', 'skills', slug))) {
    conflicts.push('global_skill')
  }
  return { conflicts, ...(existing ? { existing } : {}), localModified }
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

async function rollbackJournal(
  workspaceRoot: string,
  operationPath: string,
  journal: CreatorSkillJournal,
): Promise<void> {
  const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal)
  const recoverableBackupPath = await exists(paths.transactionBackupPath)
    ? paths.transactionBackupPath
    : paths.preserveBackupPath && await exists(paths.preserveBackupPath)
      ? paths.preserveBackupPath
      : undefined
  // A directory rename can be durable before the following journal update.
  // Once old_backed_up is persisted, targetPath may therefore already contain
  // the promoted stage even though new_installed was never recorded. The same
  // applies to the prepared -> old_backed_up window when a backup is present.
  if (recoverableBackupPath || journal.state !== 'prepared') {
    await rm(paths.targetPath, { recursive: true, force: true })
  }
  if (recoverableBackupPath) {
    await mkdir(dirname(paths.targetPath), { recursive: true })
    await rename(recoverableBackupPath, paths.targetPath)
  }
  await restoreLedgerSnapshot(workspaceRoot, journal.oldLedger)
  await rm(operationPath, { recursive: true, force: true })
}

export async function installCreatorSkill(
  workspaceRoot: string,
  input: CreatorSkillInstallInput,
  dependencies: CreatorSkillInstallerDependencies = {},
): Promise<CreatorSkillOperationResult> {
  const key = `${resolve(workspaceRoot)}\0${input.grant.slug}`
  return enqueue(key, async () => {
    let releaseLock: (() => Promise<void>) | undefined
    const controller = new AbortController()
    cancellationControllers.set(input.operationId, controller)
    let operationPath: string | undefined
    let journal: CreatorSkillJournal | undefined
    let commitStarted = false
    let committedResult: Extract<CreatorSkillOperationResult, { success: true }> | undefined
    try {
      releaseLock = await acquireOperationLock(workspaceRoot, input.grant.slug)
      const conflictState = await inspectConflicts(workspaceRoot, input)
      const missing = confirmationsMissing(conflictState.conflicts, input)
      if (missing.length > 0) {
        return errorResult({
          operationId: input.operationId,
          stage: 'prepare',
          errorCode: 'creator_skill_conflict',
          message: 'Installing this Skill requires explicit conflict confirmation',
          conflicts: missing,
        })
      }

      const resolvedOperation = await resolveOperationPath(workspaceRoot, input.operationId)
      const canonicalWorkspace = resolvedOperation.workspaceRoot
      operationPath = resolvedOperation.operationPath
      const stagePath = join(operationPath, 'stage')
      const archivePath = join(operationPath, 'archive.zip')
      const transactionBackupPath = join(operationPath, 'backup')
      await rm(operationPath, { recursive: true, force: true })
      await mkdir(stagePath, { recursive: true, mode: 0o700 })

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

      const ledger = await readCreatorSkillsLedger(canonicalWorkspace)
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
      const targetPath = resolve(canonicalWorkspace, 'skills', input.grant.slug)
      assertChildPath(resolve(canonicalWorkspace, 'skills'), targetPath, 'Creator Skill target')
      await assertCanonicalPathWhenPresent(resolve(canonicalWorkspace, 'skills'), 'Workspace Skills root')
      await assertCanonicalPathWhenPresent(targetPath, 'Creator Skill target')
      const oldLedger = await readLedgerSnapshot(canonicalWorkspace)
      const preserveBackupPath = conflictState.localModified
        ? resolve(
            canonicalWorkspace,
            BACKUP_DIRECTORY,
            input.grant.slug,
            creatorSkillBackupTimestamp(),
          )
        : undefined
      journal = {
        schemaVersion: 1,
        operationId: input.operationId,
        action: 'install',
        slug: input.grant.slug,
        targetPath,
        transactionBackupPath,
        ledgerPath: resolve(canonicalWorkspace, 'creator-skills.json'),
        oldLedger,
        state: 'prepared',
        ...(preserveBackupPath ? { preserveBackupPath } : {}),
      }
      const journalPath = join(operationPath, 'journal.json')
      await persistJournal(journalPath, journal, dependencies)

      commitStarted = true
      report(dependencies, input, 'commit', 72, false)
      await mkdir(dirname(targetPath), { recursive: true })
      if (await exists(targetPath)) {
        await rename(targetPath, transactionBackupPath)
      }
      journal.state = 'old_backed_up'
      await persistJournal(journalPath, journal, dependencies)

      await rename(join(stagePath, input.grant.slug), targetPath)
      journal.state = 'new_installed'
      await persistJournal(journalPath, journal, dependencies)

      await writeCreatorSkillsLedger(
        canonicalWorkspace,
        replaceLedgerInstallation(ledger, installation),
      )
      journal.state = 'ledger_committed'
      await persistJournal(journalPath, journal, dependencies)

      let backupPath: string | undefined
      if (preserveBackupPath && await exists(transactionBackupPath)) {
        await withBackupManagementLock(canonicalWorkspace, async () => {
          await mkdir(dirname(preserveBackupPath), { recursive: true, mode: 0o700 })
          await rename(transactionBackupPath, preserveBackupPath)
        })
        backupPath = preserveBackupPath
      }
      // `committed` is the point of no return. Persist it durably before the
      // old transaction backup is deleted, so every earlier checkpoint can
      // still restore both the previous directory and previous Ledger.
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
        ...(backupPath ? { backupPath } : {}),
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
      if (!preserveBackupPath) {
        await rm(transactionBackupPath, { recursive: true, force: true })
        await dependencies.onCleanupStep?.('transaction_backup_removed')
      }
      await rm(operationPath, { recursive: true, force: true })
      await dependencies.onCleanupStep?.('operation_removed')

      report(dependencies, input, 'refresh', 100, false)
      return committedResult
    } catch (error) {
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
      const code = record.code ?? 'creator_skill_install_failed'
      const cancelled = code === 'creator_skill_cancelled' || controller.signal.aborted
      const failureStage = commitStarted
        ? 'commit'
        : code.includes('download')
          ? 'download'
          : code.includes('conflict') || code === 'creator_skill_operation_in_progress'
            ? 'prepare'
            : 'validate'
      const failurePath = record.path || record.issues?.find(item => item.path)?.path
      return errorResult({
        operationId: input.operationId,
        stage: failureStage,
        errorCode: cancelled ? 'creator_skill_cancelled' : code,
        message: cancelled
          ? 'Installation was cancelled before the commit boundary'
          : record.message ?? 'Creator Skill installation failed',
        ...(failurePath ? { path: failurePath } : {}),
        retryable: !commitStarted
          && !cancelled
          && code !== 'project_skill_conflict',
      })
    } finally {
      cancellationControllers.delete(input.operationId)
      await releaseLock?.()
    }
  })
}

export function cancelCreatorSkillOperation(operationId: string): boolean {
  if (!UUID_PATTERN.test(operationId)) return false
  const controller = cancellationControllers.get(operationId)
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
}): Promise<CreatorSkillOperationResult> {
  const key = `${resolve(args.workspaceRoot)}\0${args.slug}`
  return enqueue(key, async () => {
    let releaseLock: (() => Promise<void>) | undefined
    let journal: CreatorSkillJournal | undefined
    let operationPath: string | undefined
    let committedResult: Extract<CreatorSkillOperationResult, { success: true }> | undefined
    try {
      releaseLock = await acquireOperationLock(args.workspaceRoot, args.slug)
      const resolvedOperation = await resolveOperationPath(
        args.workspaceRoot,
        args.operationId,
      )
      const canonicalWorkspace = resolvedOperation.workspaceRoot
      const ledger = await readCreatorSkillsLedger(canonicalWorkspace)
      const installed = ledger.installed.find(item => item.slug === args.slug)
      if (!installed) {
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
      let modified = false
      if (await exists(targetPath)) {
        try {
          modified = (
            await scanCreatorSkillDirectory(targetPath)
          ).contentDigest !== installed.contentDigest
        } catch {
          modified = true
        }
      }
      const nextLedger = removeLedgerInstallation(ledger, args.slug)
      if (modified && !args.forceDeleteModified) {
        await writeCreatorSkillsLedger(canonicalWorkspace, nextLedger)
        return {
          success: true,
          operationId: args.operationId,
          detached: true,
        }
      }

      operationPath = resolvedOperation.operationPath
      await rm(operationPath, { recursive: true, force: true })
      await mkdir(operationPath, { recursive: true, mode: 0o700 })
      const transactionBackupPath = join(operationPath, 'backup')
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
      }
      const journalPath = join(operationPath, 'journal.json')
      await writeJournal(journalPath, journal)
      if (await exists(targetPath)) await rename(targetPath, transactionBackupPath)
      journal.state = 'old_backed_up'
      await writeJournal(journalPath, journal)
      await writeCreatorSkillsLedger(canonicalWorkspace, nextLedger)
      journal.state = 'ledger_committed'
      await writeJournal(journalPath, journal)
      journal.state = 'committed'
      const committedJournalDurable = await writeJournal(journalPath, journal)
      committedResult = { success: true, operationId: args.operationId }
      if (!committedJournalDurable) return committedResult
      await rm(operationPath, { recursive: true, force: true })
      return committedResult
    } catch (error) {
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
        errorCode: record.code ?? 'creator_skill_uninstall_failed',
        message: record.message ?? 'Creator Skill uninstall failed',
      })
    } finally {
      await releaseLock?.()
    }
  })
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
      const journalStats = await lstat(journalPath)
      if (!journalStats.isFile() || journalStats.size > MAX_JOURNAL_BYTES) {
        throw invalidOperationPath('Creator Skill recovery journal is oversized or invalid')
      }
      const journal = JSON.parse(
        await readFile(journalPath, 'utf8'),
      ) as CreatorSkillJournal
      await deriveJournalPaths(canonicalWorkspace, operationPath, journal)
      if (journal.state === 'committed') {
        await rm(operationPath, { recursive: true, force: true })
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
  const root = join(workspaceRoot, BACKUP_DIRECTORY)
  let slugs
  try {
    slugs = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const backups: CreatorSkillBackup[] = []
  for (const slugEntry of slugs) {
    if (!slugEntry.isDirectory()) continue
    const slugPath = join(root, slugEntry.name)
    const versions = await readdir(slugPath, { withFileTypes: true })
    for (const version of versions) {
      if (!version.isDirectory()) continue
      const path = join(slugPath, version.name)
      backups.push({
        slug: slugEntry.name,
        createdAt: inferBackupCreatedAt(path),
        sizeBytes: await directorySize(path),
        path,
        operation: 'update',
      })
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function deleteCreatorSkillBackups(
  workspaceRoot: string,
  path?: string,
): Promise<number> {
  return withBackupManagementLock(workspaceRoot, async () => {
    const root = resolve(workspaceRoot, BACKUP_DIRECTORY)
    if (!path) {
      const count = (await listCreatorSkillBackups(workspaceRoot)).length
      await rm(root, { recursive: true, force: true })
      return count
    }
    const target = resolve(path)
    if (!target.startsWith(`${root}${sep}`) || target === root) {
      throw Object.assign(new Error('Backup path is outside the workspace backup directory'), {
        code: 'invalid_backup_path',
      })
    }
    if (!await exists(target)) return 0
    await rm(target, { recursive: true, force: true })
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
}): Promise<boolean> {
  const ledger = await readCreatorSkillsLedger(args.workspaceRoot)
  const candidate = ledger.installed.find(item =>
    item.artifactId === args.artifactId
    && item.version === args.version
    && item.archiveChecksum === args.archiveChecksum)
  if (!candidate) return false
  const key = `${resolve(args.workspaceRoot)}\0${candidate.slug}`
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(args.workspaceRoot, candidate.slug)
    try {
      // Re-read after acquiring the same workspace+slug lock as install/update.
      const currentLedger = await readCreatorSkillsLedger(args.workspaceRoot)
      const current = currentLedger.installed.find(item =>
        item.artifactId === args.artifactId
        && item.version === args.version
        && item.archiveChecksum === args.archiveChecksum)
      if (!current) return false
      await writeCreatorSkillsLedger(
        args.workspaceRoot,
        replaceLedgerInstallation(currentLedger, {
          ...current,
          ...args.changes,
        }),
      )
      return true
    } finally {
      await releaseLock()
    }
  })
}

export async function copyCreatorSkillBackupForTesting(
  source: string,
  workspaceRoot: string,
  slug: string,
): Promise<string> {
  const target = join(
    workspaceRoot,
    BACKUP_DIRECTORY,
    basename(slug),
    creatorSkillBackupTimestamp(),
  )
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, errorOnExist: true })
  return target
}
