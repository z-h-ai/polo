import { randomUUID } from 'node:crypto'
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
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
const processQueues = new Map<string, Promise<void>>()
const cancellationControllers = new Map<string, AbortController>()

type JournalState =
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
  state: JournalState
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

async function writeJournal(path: string, journal: CreatorSkillJournal): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await rename(tempPath, path)
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
  const lockDirectory = join(workspaceRoot, OP_DIRECTORY, 'locks')
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
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
  const recoverableBackupPath = await exists(journal.transactionBackupPath)
    ? journal.transactionBackupPath
    : journal.preserveBackupPath && await exists(journal.preserveBackupPath)
      ? journal.preserveBackupPath
      : undefined
  if (
    journal.state === 'new_installed'
    || journal.state === 'ledger_committed'
  ) {
    await rm(journal.targetPath, { recursive: true, force: true })
  }
  if (recoverableBackupPath) {
    await mkdir(dirname(journal.targetPath), { recursive: true })
    await rename(recoverableBackupPath, journal.targetPath)
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

      operationPath = join(workspaceRoot, OP_DIRECTORY, input.operationId)
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

      const ledger = await readCreatorSkillsLedger(workspaceRoot)
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
      const targetPath = join(workspaceRoot, 'skills', input.grant.slug)
      const oldLedger = await readLedgerSnapshot(workspaceRoot)
      const preserveBackupPath = conflictState.localModified
        ? join(
            workspaceRoot,
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
        ledgerPath: join(workspaceRoot, 'creator-skills.json'),
        oldLedger,
        state: 'prepared',
        ...(preserveBackupPath ? { preserveBackupPath } : {}),
      }
      const journalPath = join(operationPath, 'journal.json')
      await writeJournal(journalPath, journal)

      commitStarted = true
      report(dependencies, input, 'commit', 72, false)
      await mkdir(dirname(targetPath), { recursive: true })
      if (await exists(targetPath)) {
        await rename(targetPath, transactionBackupPath)
      }
      journal.state = 'old_backed_up'
      await writeJournal(journalPath, journal)

      await rename(join(stagePath, input.grant.slug), targetPath)
      journal.state = 'new_installed'
      await writeJournal(journalPath, journal)

      await writeCreatorSkillsLedger(
        workspaceRoot,
        replaceLedgerInstallation(ledger, installation),
      )
      journal.state = 'ledger_committed'
      await writeJournal(journalPath, journal)

      let backupPath: string | undefined
      if (preserveBackupPath && await exists(transactionBackupPath)) {
        await withBackupManagementLock(workspaceRoot, async () => {
          await mkdir(dirname(preserveBackupPath), { recursive: true, mode: 0o700 })
          await rename(transactionBackupPath, preserveBackupPath)
        })
        backupPath = preserveBackupPath
      } else {
        await rm(transactionBackupPath, { recursive: true, force: true })
      }
      journal.state = 'committed'
      await writeJournal(journalPath, journal)
      await rm(operationPath, { recursive: true, force: true })

      report(dependencies, input, 'refresh', 100, false)
      return {
        success: true,
        operationId: input.operationId,
        installed: installation,
        ...(backupPath ? { backupPath } : {}),
      }
    } catch (error) {
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
    try {
      releaseLock = await acquireOperationLock(args.workspaceRoot, args.slug)
      const ledger = await readCreatorSkillsLedger(args.workspaceRoot)
      const installed = ledger.installed.find(item => item.slug === args.slug)
      if (!installed) {
        return errorResult({
          operationId: args.operationId,
          stage: 'prepare',
          errorCode: 'creator_skill_not_installed',
          message: 'This workspace Skill is not managed by Creator Space',
        })
      }
      const targetPath = join(args.workspaceRoot, 'skills', args.slug)
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
        await writeCreatorSkillsLedger(args.workspaceRoot, nextLedger)
        return {
          success: true,
          operationId: args.operationId,
          detached: true,
        }
      }

      operationPath = join(args.workspaceRoot, OP_DIRECTORY, args.operationId)
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
        ledgerPath: join(args.workspaceRoot, 'creator-skills.json'),
        oldLedger: await readLedgerSnapshot(args.workspaceRoot),
        state: 'prepared',
      }
      const journalPath = join(operationPath, 'journal.json')
      await writeJournal(journalPath, journal)
      if (await exists(targetPath)) await rename(targetPath, transactionBackupPath)
      journal.state = 'old_backed_up'
      await writeJournal(journalPath, journal)
      await writeCreatorSkillsLedger(args.workspaceRoot, nextLedger)
      journal.state = 'ledger_committed'
      await writeJournal(journalPath, journal)
      journal.state = 'committed'
      await writeJournal(journalPath, journal)
      await rm(operationPath, { recursive: true, force: true })
      return { success: true, operationId: args.operationId }
    } catch (error) {
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
  const root = join(workspaceRoot, OP_DIRECTORY)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'locks') continue
    const operationPath = join(root, entry.name)
    try {
      const journal = JSON.parse(
        await readFile(join(operationPath, 'journal.json'), 'utf8'),
      ) as CreatorSkillJournal
      if (journal.state === 'committed') {
        await rm(operationPath, { recursive: true, force: true })
      } else {
        await rollbackJournal(workspaceRoot, operationPath, journal)
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
  await rm(join(root, 'locks'), { recursive: true, force: true })
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
