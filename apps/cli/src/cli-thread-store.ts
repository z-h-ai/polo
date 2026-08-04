import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  getProcessBirthIdentity,
  processIdentityMatches,
} from '@polo-ai/shared/utils'
import type { LlmConnection } from '@polo-ai/shared/config'

export { getProcessBirthIdentity, processIdentityMatches } from '@polo-ai/shared/utils'

export type CliThreadOrigin = 'cli-run' | 'cli-exec'
export type CliThreadStatus = 'completed' | 'failed' | 'interrupted'
export type CliThreadPersistence = 'persistent' | 'ephemeral'

export interface CliThreadMetadata {
  version: 1
  threadId: string
  origin: CliThreadOrigin
  configurationScopeId: string
  configurationWorkspaceId?: string
  configurationWorkspacePath: string
  workingDirectory: string
  mainSessionId?: string
  createdAt: number
  lastUsedAt: number
  persistence: CliThreadPersistence
  status?: CliThreadStatus
  connection?: {
    slug?: string
    provider?: string
    model?: string
    baseUrl?: string
    connectionType?: LlmConnection['providerType']
    authType?: LlmConnection['authType']
    customEndpoint?: LlmConnection['customEndpoint']
  }
}

export interface CliThreadOwner {
  leaseId: string
  cliPid: number
  cliStartedAt: number
  cliProcessIdentity: string
  serverPid: number
  serverStartedAt: number
  serverProcessIdentity?: string
  heartbeatAt: number
}

export interface CliThreadRecord {
  metadata: CliThreadMetadata
  directory: string
  sessionsRoot: string
  ownerFile: string
}

export interface CliThreadLease {
  record: CliThreadRecord
  owner: CliThreadOwner
  heartbeat(server?: { pid: number; startedAt: number; processIdentity: string }): Promise<void>
  release(): Promise<void>
}

interface CliThreadStateLockRecord {
  lockId: string
  /** Backward-compatible alias used by the round-2 takeover lock. */
  takeoverId?: string
  operation: 'acquire' | 'heartbeat' | 'release' | 'delete' | 'repair' | 'stale-cleanup'
  pid: number
  processIdentity: string
  createdAt: number
}

interface CliThreadDeletingMarker {
  version: 1
  deletionId: string
  markedAt: number
  initiatorPid: number
  initiatorProcessIdentity: string
  owner?: CliThreadOwner
  lastHeartbeatAt: number
}

interface CliThreadCreatingMarker {
  version: 1
  origin: CliThreadOrigin
  persistence: CliThreadPersistence
  pid: number
  processIdentity: string
  createdAt: number
}

interface CliThreadStateLock {
  lockId: string
  path: string
  release(): Promise<void>
}

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ACTIVE_LEASE_WINDOW_MS = 15_000
const STALE_EPHEMERAL_MS = 10 * 60_000
const THREAD_STATE_LOCK_STALE_MS = 60_000
const THREAD_STATE_LOCK_FILE = '.owner.takeover.lock'
const THREAD_DELETING_FILE = 'deleting.json'
const THREAD_CREATING_FILE = 'creating.json'

function configRoot(): string {
  return resolve(process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai'))
}

export function getCliSessionsRoot(): string {
  return join(configRoot(), 'cli-sessions')
}

function sanitizeScopeId(scopeId: string): string {
  const value = scopeId.trim()
  if (!value || value === '.' || value === '..' || basename(value) !== value) {
    throw new Error(`Invalid configuration scope id: ${scopeId}`)
  }
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}

function assertControlledPath(root: string, target: string): void {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep)) {
    throw new Error(`Refusing path outside controlled CLI root: ${target}`)
  }
}

async function assertCanonicalControlledPath(root: string, target: string): Promise<void> {
  await assertControlledAncestors(root, target, false)
}

async function assertControlledAncestors(
  root: string,
  target: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  assertControlledPath(normalizedRoot, normalizedTarget)
  const rootInfo = await lstat(normalizedRoot)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Refusing unsafe controlled CLI root: ${normalizedRoot}`)
  }
  const canonicalRoot = await realpath(normalizedRoot)
  let current = normalizedRoot
  const relative = normalizedTarget === normalizedRoot
    ? []
    : normalizedTarget.slice(normalizedRoot.length + 1).split(sep)
  for (let index = 0; index < relative.length; index++) {
    current = join(current, relative[index]!)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (
        allowMissingLeaf
        && (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlink inside controlled CLI root: ${current}`)
    }
    if (index < relative.length - 1 && !info.isDirectory()) {
      throw new Error(`Refusing non-directory CLI ancestor: ${current}`)
    }
    const canonicalCurrent = await realpath(current)
    assertControlledPath(canonicalRoot, canonicalCurrent)
  }
}

async function ensurePrivateDirectoryTree(path: string): Promise<void> {
  const target = resolve(path)
  const missing: string[] = []
  let current = target
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Refusing unsafe directory ancestor: ${current}`)
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(basename(current))
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
  const canonicalAncestor = await realpath(current)
  for (const segment of missing.reverse()) {
    current = join(current, segment)
    try {
      await mkdir(current, { mode: DIRECTORY_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe directory ancestor: ${current}`)
    }
    assertControlledPath(canonicalAncestor, await realpath(current))
    if (process.platform !== 'win32') await chmod(current, DIRECTORY_MODE)
  }
  if (process.platform !== 'win32') await chmod(target, DIRECTORY_MODE)
}

async function ensureControlledPrivateDir(root: string, target: string): Promise<void> {
  await assertControlledAncestors(root, target, true)
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  let current = normalizedRoot
  const relative = normalizedTarget === normalizedRoot
    ? []
    : normalizedTarget.slice(normalizedRoot.length + 1).split(sep)
  for (const segment of relative) {
    current = join(current, segment)
    try {
      await mkdir(current, { mode: DIRECTORY_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await assertCanonicalControlledPath(root, current)
    const info = await lstat(current)
    if (!info.isDirectory()) throw new Error(`Refusing non-directory CLI path: ${current}`)
    if (process.platform !== 'win32') await chmod(current, DIRECTORY_MODE)
  }
}

async function unlinkControlledFile(root: string, target: string): Promise<void> {
  try {
    await assertCanonicalControlledPath(root, target)
    const info = await lstat(target)
    if (!info.isFile()) throw new Error(`Refusing to unlink non-file inside controlled CLI root: ${target}`)
    await unlink(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function ensurePrivateDir(path: string): Promise<void> {
  const root = getCliSessionsRoot()
  if (resolve(path) === resolve(root)) {
    await ensurePrivateDirectoryTree(path)
  } else {
    await ensureControlledPrivateDir(root, path)
  }
}

async function makePrivateTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symlink inside CLI Thread: ${path}`)
  }
  if (process.platform !== 'win32') {
    await chmod(path, info.isDirectory() ? DIRECTORY_MODE : FILE_MODE)
  }
  if (!info.isDirectory()) return
  for (const entry of await readdir(path)) {
    await makePrivateTree(join(path, entry))
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path))
  await assertControlledAncestors(getCliSessionsRoot(), path, true)
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', FILE_MODE)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await assertControlledAncestors(getCliSessionsRoot(), path, true)
  if (process.platform !== 'win32') await chmod(temp, FILE_MODE)
  await rename(temp, path)
  if (process.platform !== 'win32') await chmod(path, FILE_MODE)
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T
}

function recordFor(directory: string, metadata: CliThreadMetadata): CliThreadRecord {
  return {
    metadata,
    directory,
    sessionsRoot: join(directory, 'sessions'),
    ownerFile: join(directory, 'owner.json'),
  }
}

function stateLockPath(record: CliThreadRecord): string {
  return join(record.directory, THREAD_STATE_LOCK_FILE)
}

function deletingMarkerPath(record: CliThreadRecord): string {
  return join(record.directory, THREAD_DELETING_FILE)
}

function creatingMarkerPath(record: CliThreadRecord): string {
  return join(record.directory, THREAD_CREATING_FILE)
}

async function acquireThreadStateLock(
  record: CliThreadRecord,
  operation: CliThreadStateLockRecord['operation'],
): Promise<CliThreadStateLock> {
  const root = getCliSessionsRoot()
  await assertCanonicalControlledPath(root, record.directory)
  const path = stateLockPath(record)
  const processIdentity = getProcessBirthIdentity(process.pid)
  if (!processIdentity) {
    throw new Error(`Could not verify CLI process birth identity for pid ${process.pid}`)
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const lockId = crypto.randomUUID()
    const value: CliThreadStateLockRecord = {
      lockId,
      takeoverId: lockId,
      operation,
      pid: process.pid,
      processIdentity,
      createdAt: Date.now(),
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, 'wx', FILE_MODE)
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (process.platform !== 'win32') await chmod(path, FILE_MODE)

      let released = false
      return {
        lockId,
        path,
        async release() {
          if (released) return
          released = true
          const current = await readJson<CliThreadStateLockRecord>(path).catch(() => null)
          const currentId = current?.lockId ?? current?.takeoverId
          if (currentId === lockId) {
            await unlinkControlledFile(root, path).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
          }
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      await assertCanonicalControlledPath(root, path)
      const [observed, info] = await Promise.all([
        readJson<CliThreadStateLockRecord>(path).catch(() => null),
        stat(path).catch(() => null),
      ])
      const observedId = observed?.lockId ?? observed?.takeoverId
      const createdAt = Number.isFinite(observed?.createdAt)
        ? observed!.createdAt
        : info?.mtimeMs ?? Date.now()
      const hasProcessIdentity = !!observed
        && Number.isInteger(observed.pid)
        && observed.pid > 0
        && typeof observed.processIdentity === 'string'
        && observed.processIdentity.length > 0
      const holderExists = hasProcessIdentity
        && processIdentityMatches(observed.pid, observed.processIdentity)
      if (
        !hasProcessIdentity
        || holderExists
        || Date.now() - createdAt <= THREAD_STATE_LOCK_STALE_MS
      ) {
        throw new Error(
          `Thread ${record.metadata.threadId} state transition is already in progress`,
        )
      }

      // Recover only a safely expired lock whose exact observed identity was
      // moved. The atomic rename is the filesystem CAS boundary; if another
      // contender already replaced it, the moved identity check fails closed.
      const stalePath = join(
        record.directory,
        `.${THREAD_STATE_LOCK_FILE}.stale.${observedId ?? 'unknown'}.${crypto.randomUUID()}`,
      )
      try {
        await rename(path, stalePath)
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      const moved = await readJson<CliThreadStateLockRecord>(stalePath).catch(() => null)
      const movedId = moved?.lockId ?? moved?.takeoverId
      if (movedId !== observedId) {
        if (!existsSync(path)) await rename(stalePath, path).catch(() => {})
        throw new Error(
          `Thread ${record.metadata.threadId} state lock changed during recovery`,
        )
      }
      await unlinkControlledFile(root, stalePath)
    }
  }

  throw new Error(`Thread ${record.metadata.threadId} state transition could not be acquired`)
}

async function assertThreadStateLock(
  record: CliThreadRecord,
  stateLock: CliThreadStateLock,
): Promise<void> {
  const current = await readJson<CliThreadStateLockRecord>(stateLock.path)
  const currentId = current.lockId ?? current.takeoverId
  if (currentId !== stateLock.lockId) {
    throw new Error(`Thread ${record.metadata.threadId} state lock was lost`)
  }
}

export async function createCliThread(input: {
  origin: CliThreadOrigin
  configurationScopeId: string
  configurationWorkspaceId?: string
  configurationWorkspacePath: string
  workingDirectory: string
  persistence: CliThreadPersistence
  connection?: CliThreadMetadata['connection']
}): Promise<CliThreadRecord> {
  const root = getCliSessionsRoot()
  const scopeId = sanitizeScopeId(input.configurationScopeId)
  const executionsRoot = join(root, scopeId, 'executions')
  await ensurePrivateDir(root)
  await ensurePrivateDir(executionsRoot)

  let directory = ''
  let threadId = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    threadId = crypto.randomUUID()
    directory = join(executionsRoot, threadId)
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 4) throw error
    }
  }

  assertControlledPath(root, directory)
  try {
    const processIdentity = getProcessBirthIdentity(process.pid)
    if (!processIdentity) {
      throw new Error(`Could not verify CLI process birth identity for pid ${process.pid}`)
    }
    await atomicWriteJson(join(directory, THREAD_CREATING_FILE), {
      version: 1,
      origin: input.origin,
      persistence: input.persistence,
      pid: process.pid,
      processIdentity,
      createdAt: Date.now(),
    } satisfies CliThreadCreatingMarker)
    await ensurePrivateDir(join(directory, 'sessions'))

    const now = Date.now()
    const metadata: CliThreadMetadata = {
      version: 1,
      threadId,
      origin: input.origin,
      configurationScopeId: scopeId,
      configurationWorkspaceId: input.configurationWorkspaceId,
      configurationWorkspacePath: resolve(input.configurationWorkspacePath),
      workingDirectory: resolve(input.workingDirectory),
      createdAt: now,
      lastUsedAt: now,
      persistence: input.persistence,
      connection: input.connection,
    }
    await atomicWriteJson(join(directory, 'thread.json'), metadata)
    await unlinkControlledFile(root, join(directory, THREAD_CREATING_FILE))
    return recordFor(directory, metadata)
  } catch (error) {
    await assertCanonicalControlledPath(root, directory)
      .then(() => rm(directory, { recursive: true, force: true }))
      .catch(() => {})
    throw error
  }
}

export async function updateCliThread(
  record: CliThreadRecord,
  updates: Partial<Pick<CliThreadMetadata, 'mainSessionId' | 'status' | 'lastUsedAt' | 'workingDirectory' | 'configurationWorkspaceId' | 'configurationWorkspacePath' | 'connection'>>,
): Promise<void> {
  await assertCanonicalControlledPath(getCliSessionsRoot(), record.directory)
  const metadata = await readJson<CliThreadMetadata>(join(record.directory, 'thread.json'))
  const next = { ...metadata, ...updates }
  await atomicWriteJson(join(record.directory, 'thread.json'), next)
  record.metadata = next
}

export function isOwnerActive(owner: CliThreadOwner, now = Date.now()): boolean {
  const cliMatches = processIdentityMatches(owner.cliPid, owner.cliProcessIdentity)
  const serverMatches = processIdentityMatches(owner.serverPid, owner.serverProcessIdentity)
  const leaseIsFresh = Number.isFinite(owner.heartbeatAt)
    && now - owner.heartbeatAt <= ACTIVE_LEASE_WINDOW_MS
  return cliMatches || serverMatches || leaseIsFresh
}

export async function acquireCliThreadLease(
  record: CliThreadRecord,
  options: { purpose?: 'execute' | 'clone-source' } = {},
): Promise<CliThreadLease> {
  const root = getCliSessionsRoot()
  await assertCanonicalControlledPath(root, record.directory)
  // An acquire operates on an existing Thread. Recreating this directory here
  // opens a delete/acquire race: delete can atomically move the Thread after
  // the containment check, then this call can recreate an empty directory and
  // publish a lease for a Thread that no longer exists. The state-lock acquire
  // below revalidates the existing directory and fails closed if delete won.
  const ownerFile = record.ownerFile
  const now = Date.now()
  const cliProcessIdentity = getProcessBirthIdentity(process.pid)
  if (!cliProcessIdentity) {
    throw new Error(`Could not verify CLI process birth identity for pid ${process.pid}`)
  }
  const owner: CliThreadOwner = {
    leaseId: crypto.randomUUID(),
    cliPid: process.pid,
    cliStartedAt: now,
    cliProcessIdentity,
    serverPid: 0,
    serverStartedAt: 0,
    heartbeatAt: now,
  }

  const stateLock = await acquireThreadStateLock(record, 'acquire')
  try {
    if (existsSync(deletingMarkerPath(record))) {
      await assertCanonicalControlledPath(root, deletingMarkerPath(record))
      throw new Error(`Thread ${record.metadata.threadId} is being deleted`)
    }
    const currentOwner = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
    if (currentOwner && isOwnerActive(currentOwner)) {
      throw new Error(`Thread ${record.metadata.threadId} is already active`)
    }
    if (
      currentOwner
      && options.purpose !== 'clone-source'
      && record.metadata.origin === 'cli-exec'
      && record.metadata.status !== 'interrupted'
    ) {
      await updateCliThread(record, { status: 'interrupted', lastUsedAt: Date.now() })
    }
    await atomicWriteJson(ownerFile, owner)
  } finally {
    await stateLock.release()
  }
  if (process.platform !== 'win32') await chmod(ownerFile, FILE_MODE)

  let released = false
  return {
    record,
    owner,
    async heartbeat(server) {
      if (released) return
      if (server) {
        owner.serverPid = server.pid
        owner.serverStartedAt = server.startedAt
        owner.serverProcessIdentity = server.processIdentity
      }
      owner.heartbeatAt = Date.now()
      const heartbeatLock = await acquireThreadStateLock(record, 'heartbeat')
      try {
        if (existsSync(deletingMarkerPath(record))) {
          throw new Error(`Thread ${record.metadata.threadId} is being deleted`)
        }
        const current = await readJson<CliThreadOwner>(ownerFile)
        if (current.leaseId !== owner.leaseId) {
          throw new Error(`Thread ${record.metadata.threadId} lease was lost`)
        }
        await atomicWriteJson(ownerFile, owner)
      } finally {
        await heartbeatLock.release()
      }
    },
    async release() {
      if (released) return
      released = true
      if (!existsSync(record.directory)) return
      let releaseLock: CliThreadStateLock
      try {
        releaseLock = await acquireThreadStateLock(record, 'release')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      try {
        if (existsSync(ownerFile)) await assertCanonicalControlledPath(root, ownerFile)
        const current = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
        if (current?.leaseId === owner.leaseId) {
          await unlinkControlledFile(root, ownerFile)
        }
      } finally {
        await releaseLock.release()
      }
    },
  }
}

export async function locateCliThread(threadId: string): Promise<CliThreadRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null
  const root = getCliSessionsRoot()
  if (!existsSync(root)) return null
  await assertCanonicalControlledPath(root, root)
  for (const scope of await readdir(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name === 'trash') continue
    const directory = join(root, scope.name, 'executions', threadId)
    const metadataPath = join(directory, 'thread.json')
    if (!existsSync(metadataPath)) continue
    await assertCanonicalControlledPath(root, directory)
    const metadata = await readJson<CliThreadMetadata>(metadataPath)
    if (metadata.threadId !== threadId) throw new Error(`Corrupt Thread metadata: ${threadId}`)
    return recordFor(directory, metadata)
  }
  return null
}

interface CliThreadDirectoryScan {
  records: CliThreadRecord[]
  incomplete: Array<{ directory: string; observedMtime: number }>
}

async function scanCliThreadDirectories(): Promise<CliThreadDirectoryScan> {
  const root = getCliSessionsRoot()
  if (!existsSync(root)) return { records: [], incomplete: [] }
  await assertCanonicalControlledPath(root, root)
  const records: CliThreadRecord[] = []
  const incomplete: Array<{ directory: string; observedMtime: number }> = []
  for (const scope of await readdir(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name === 'trash') continue
    const scopeRoot = join(root, scope.name)
    const executionsRoot = join(root, scope.name, 'executions')
    if (!existsSync(executionsRoot)) continue
    try {
      await assertCanonicalControlledPath(root, scopeRoot)
      await assertCanonicalControlledPath(root, executionsRoot)
    } catch {
      continue
    }
    for (const entry of await readdir(executionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue
      const directory = join(executionsRoot, entry.name)
      try {
        await assertCanonicalControlledPath(root, directory)
        const metadataPath = join(directory, 'thread.json')
        if (!existsSync(metadataPath)) {
          incomplete.push({
            directory,
            observedMtime: (await stat(directory)).mtimeMs,
          })
          continue
        }
        const metadata = await readJson<CliThreadMetadata>(metadataPath)
        if (metadata.threadId !== entry.name) continue
        records.push(recordFor(directory, metadata))
      } catch {
        // Corrupt or half-created Threads are not advertised as resumable.
      }
    }
  }
  return { records, incomplete }
}

export async function listCliThreads(): Promise<CliThreadRecord[]> {
  const { records } = await scanCliThreadDirectories()
  return records.sort((a, b) => b.metadata.lastUsedAt - a.metadata.lastUsedAt)
}

export async function isCliThreadActive(record: CliThreadRecord): Promise<boolean> {
  await assertCanonicalControlledPath(getCliSessionsRoot(), record.directory)
  if (existsSync(deletingMarkerPath(record))) return true
  if (existsSync(record.ownerFile)) {
    await assertCanonicalControlledPath(getCliSessionsRoot(), record.ownerFile)
  }
  const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
  return owner ? isOwnerActive(owner) : false
}

export async function repairAbandonedCliThread(
  record: CliThreadRecord,
  now = Date.now(),
): Promise<boolean> {
  const root = getCliSessionsRoot()
  await assertCanonicalControlledPath(root, record.directory)
  const stateLock = await acquireThreadStateLock(record, 'repair')
  try {
    if (existsSync(deletingMarkerPath(record))) return false
    const metadata = await readJson<CliThreadMetadata>(join(record.directory, 'thread.json'))
    record.metadata = metadata
    if (
      metadata.origin !== 'cli-exec'
      || metadata.persistence !== 'persistent'
      || metadata.status
    ) {
      return false
    }

    if (existsSync(record.ownerFile)) {
      await assertCanonicalControlledPath(root, record.ownerFile)
    }
    const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
    if (owner ? isOwnerActive(owner, now) : now - metadata.lastUsedAt <= ACTIVE_LEASE_WINDOW_MS) {
      return false
    }

    await updateCliThread(record, { status: 'interrupted' })
    return true
  } finally {
    await stateLock.release()
  }
}

export async function cloneCliThreadEphemeral(source: CliThreadRecord): Promise<CliThreadRecord> {
  const clone = await createCliThread({
    origin: 'cli-exec',
    configurationScopeId: source.metadata.configurationScopeId,
    configurationWorkspaceId: source.metadata.configurationWorkspaceId,
    configurationWorkspacePath: source.metadata.configurationWorkspacePath,
    workingDirectory: source.metadata.workingDirectory,
    persistence: 'ephemeral',
    connection: source.metadata.connection,
  })
  try {
    const root = getCliSessionsRoot()
    await assertCanonicalControlledPath(root, source.sessionsRoot)
    await assertCanonicalControlledPath(root, clone.sessionsRoot)
    await rm(clone.sessionsRoot, { recursive: true, force: true })
    await cp(source.sessionsRoot, clone.sessionsRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    await makePrivateTree(clone.sessionsRoot)
    await updateCliThread(clone, { mainSessionId: source.metadata.mainSessionId })
    return clone
  } catch (error) {
    // The outer execution lifecycle does not own this clone until it is
    // returned, so rollback every failure after createCliThread here.
    await deleteCliThread(clone).catch(() => {})
    throw error
  }
}

async function moveThreadToTrash(
  record: CliThreadRecord,
  stateLock: CliThreadStateLock,
): Promise<string> {
  const root = getCliSessionsRoot()
  assertControlledPath(root, record.directory)
  await assertCanonicalControlledPath(root, record.directory)
  await assertThreadStateLock(record, stateLock)
  const trashRoot = join(root, 'trash')
  await ensurePrivateDir(trashRoot)
  await assertCanonicalControlledPath(root, trashRoot)
  const target = join(trashRoot, `${record.metadata.threadId}.${crypto.randomUUID()}`)
  assertControlledPath(root, target)
  // Re-check ownership and the durable deleting state immediately before the
  // atomic move while the shared state lock is still held.
  await assertThreadStateLock(record, stateLock)
  if (!existsSync(deletingMarkerPath(record))) {
    throw new Error(`Thread ${record.metadata.threadId} is not marked deleting`)
  }
  await rename(record.directory, target)
  await assertCanonicalControlledPath(root, target)
  return target
}

async function writeDeletingMarker(
  record: CliThreadRecord,
  owner: CliThreadOwner | null,
  now = Date.now(),
): Promise<CliThreadDeletingMarker> {
  const processIdentity = getProcessBirthIdentity(process.pid)
  if (!processIdentity) {
    throw new Error(`Could not verify CLI process birth identity for pid ${process.pid}`)
  }
  const marker: CliThreadDeletingMarker = {
    version: 1,
    deletionId: crypto.randomUUID(),
    markedAt: now,
    initiatorPid: process.pid,
    initiatorProcessIdentity: processIdentity,
    owner: owner ?? undefined,
    lastHeartbeatAt: owner?.heartbeatAt ?? record.metadata.lastUsedAt,
  }
  await atomicWriteJson(deletingMarkerPath(record), marker)
  return marker
}

export async function deleteCliThread(
  record: CliThreadRecord,
  options: { expectedLeaseId?: string } = {},
): Promise<void> {
  const root = getCliSessionsRoot()
  await assertCanonicalControlledPath(root, record.directory)
  const stateLock = await acquireThreadStateLock(record, 'delete')
  let trash: string | undefined
  try {
    if (existsSync(record.ownerFile)) await assertCanonicalControlledPath(root, record.ownerFile)
    const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
    if (options.expectedLeaseId && owner?.leaseId !== options.expectedLeaseId) {
      throw new Error(`Thread ${record.metadata.threadId} lease changed before deletion`)
    }
    if (
      owner
      && isOwnerActive(owner)
      && owner.leaseId !== options.expectedLeaseId
    ) {
      throw new Error(`Thread ${record.metadata.threadId} is active and cannot be deleted`)
    }

    const existingMarker = await readJson<CliThreadDeletingMarker>(
      deletingMarkerPath(record),
    ).catch(() => null)
    if (
      existingMarker
      && processIdentityMatches(
        existingMarker.initiatorPid,
        existingMarker.initiatorProcessIdentity,
      )
      && existingMarker.initiatorPid !== process.pid
    ) {
      throw new Error(`Thread ${record.metadata.threadId} deletion is already in progress`)
    }
    if (!existingMarker) await writeDeletingMarker(record, owner)
    trash = await moveThreadToTrash(record, stateLock)
  } finally {
    if (!trash) await stateLock.release()
  }
  if (!trash) throw new Error(`Thread ${record.metadata.threadId} deletion did not complete`)
  await assertCanonicalControlledPath(root, trash)
  await rm(trash, { recursive: true, force: true })
}

export async function cleanupStaleEphemeralThreads(now = Date.now()): Promise<number> {
  const root = getCliSessionsRoot()
  await ensurePrivateDir(root)
  const cleanerLock = join(root, '.cleaner.lock')
  try {
    await writeFile(cleanerLock, JSON.stringify({ pid: process.pid, createdAt: now }), {
      flag: 'wx',
      mode: FILE_MODE,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await assertCanonicalControlledPath(root, cleanerLock)
    const info = await stat(cleanerLock).catch(() => null)
    if (!info || now - info.mtimeMs <= 60_000) return 0
    await unlinkControlledFile(root, cleanerLock)
    return cleanupStaleEphemeralThreads(now)
  }

  let cleaned = 0
  try {
    const scan = await scanCliThreadDirectories()
    for (const record of scan.records) {
      if (record.metadata.persistence !== 'ephemeral') continue
      let stateLock: CliThreadStateLock
      try {
        stateLock = await acquireThreadStateLock(record, 'stale-cleanup')
      } catch {
        continue
      }
      let trash: string | undefined
      try {
        const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
        const marker = await readJson<CliThreadDeletingMarker>(
          deletingMarkerPath(record),
        ).catch(() => null)
        const evidence = owner ?? marker?.owner
        const cliExists = evidence
          ? processIdentityMatches(evidence.cliPid, evidence.cliProcessIdentity)
          : false
        const runtimeExists = evidence
          ? processIdentityMatches(evidence.serverPid, evidence.serverProcessIdentity)
          : false
        const markerInitiatorExists = !!marker && processIdentityMatches(
          marker.initiatorPid,
          marker.initiatorProcessIdentity,
        )
        const lastHeartbeatAt = evidence?.heartbeatAt
          ?? marker?.lastHeartbeatAt
          ?? record.metadata.lastUsedAt
        const leaseExpired = !evidence
          || now - evidence.heartbeatAt > ACTIVE_LEASE_WINDOW_MS
        if (
          cliExists
          || runtimeExists
          || markerInitiatorExists
          || !leaseExpired
          || now - lastHeartbeatAt <= STALE_EPHEMERAL_MS
        ) {
          continue
        }
        if (!marker) await writeDeletingMarker(record, owner, now)
        trash = await moveThreadToTrash(record, stateLock)
      } catch {
        // Another state transition won, or the Thread failed containment checks.
      } finally {
        if (!trash) await stateLock.release()
      }
      if (!trash) continue
      await assertCanonicalControlledPath(root, trash)
      await rm(trash, { recursive: true, force: true })
      cleaned++
    }
    for (const incomplete of scan.incomplete) {
      if (now - incomplete.observedMtime <= STALE_EPHEMERAL_MS) continue
      const creating = await readJson<CliThreadCreatingMarker>(
        join(incomplete.directory, THREAD_CREATING_FILE),
      ).catch(() => null)
      // An incomplete directory is recoverable only when its durable creation
      // marker proves that it belongs to an ephemeral invocation. Historical
      // markers without retention metadata, persistent exec Threads, and
      // run --no-cleanup Threads must fail closed and remain untouched.
      if (
        creating?.persistence !== 'ephemeral'
        || (creating.origin !== 'cli-run' && creating.origin !== 'cli-exec')
      ) {
        continue
      }
      const threadId = basename(incomplete.directory)
      const scopeId = basename(dirname(dirname(incomplete.directory)))
      const record = recordFor(incomplete.directory, {
        version: 1,
        threadId,
        origin: creating.origin,
        configurationScopeId: scopeId,
        configurationWorkspacePath: configRoot(),
        workingDirectory: configRoot(),
        createdAt: incomplete.observedMtime,
        lastUsedAt: incomplete.observedMtime,
        persistence: creating.persistence,
      })
      let stateLock: CliThreadStateLock
      try {
        stateLock = await acquireThreadStateLock(record, 'stale-cleanup')
      } catch {
        continue
      }
      let trash: string | undefined
      try {
        // Creation can finish after the directory scan but before the state
        // lock is acquired. Never classify a now-complete Thread as debris.
        if (existsSync(join(record.directory, 'thread.json'))) continue
        const [owner, marker, currentCreating] = await Promise.all([
          readJson<CliThreadOwner>(record.ownerFile).catch(() => null),
          readJson<CliThreadDeletingMarker>(deletingMarkerPath(record)).catch(() => null),
          readJson<CliThreadCreatingMarker>(creatingMarkerPath(record)).catch(() => null),
        ])
        if (
          currentCreating?.persistence !== 'ephemeral'
          || currentCreating.origin !== creating.origin
        ) {
          continue
        }
        const evidence = owner ?? marker?.owner
        const cliExists = evidence
          ? processIdentityMatches(evidence.cliPid, evidence.cliProcessIdentity)
          : false
        const runtimeExists = evidence
          ? processIdentityMatches(evidence.serverPid, evidence.serverProcessIdentity)
          : false
        const markerInitiatorExists = !!marker && processIdentityMatches(
          marker.initiatorPid,
          marker.initiatorProcessIdentity,
        )
        const creatorExists = processIdentityMatches(
          currentCreating.pid,
          currentCreating.processIdentity,
        )
        const lastHeartbeatAt = Math.max(
          incomplete.observedMtime,
          evidence?.heartbeatAt ?? 0,
          marker?.lastHeartbeatAt ?? 0,
          currentCreating.createdAt,
        )
        const leaseExpired = !evidence
          || now - evidence.heartbeatAt > ACTIVE_LEASE_WINDOW_MS
        if (
          cliExists
          || runtimeExists
          || markerInitiatorExists
          || creatorExists
          || !leaseExpired
          || now - lastHeartbeatAt <= STALE_EPHEMERAL_MS
        ) {
          continue
        }
        if (!marker) await writeDeletingMarker(record, owner, now)
        trash = await moveThreadToTrash(record, stateLock)
      } catch {
        // A concurrent creator/state transition won, or containment failed.
      } finally {
        if (!trash) await stateLock.release()
      }
      if (!trash) continue
      await assertCanonicalControlledPath(root, trash)
      await rm(trash, { recursive: true, force: true })
      cleaned++
    }
  } finally {
    await unlinkControlledFile(root, cleanerLock)
  }
  return cleaned
}

export async function threadDiskUsage(record: CliThreadRecord): Promise<number> {
  let total = 0
  const walk = async (path: string): Promise<void> => {
    await assertCanonicalControlledPath(getCliSessionsRoot(), path)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlink inside controlled CLI root: ${path}`)
    }
    if (info.isFile()) {
      total += info.size
      return
    }
    for (const entry of await readdir(path)) await walk(join(path, entry))
  }
  await walk(record.directory)
  return total
}
