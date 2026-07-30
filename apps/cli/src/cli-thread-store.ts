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

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const ACTIVE_LEASE_WINDOW_MS = 15_000
const STALE_EPHEMERAL_MS = 10 * 60_000

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
  await ensurePrivateDir(record.directory)
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

  try {
    await writeFile(ownerFile, JSON.stringify(owner, null, 2), { flag: 'wx', mode: FILE_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    await assertCanonicalControlledPath(root, ownerFile)
    const observedOwner = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
    if (observedOwner && isOwnerActive(observedOwner)) {
      throw new Error(`Thread ${record.metadata.threadId} is already active`)
    }

    // Only one contender may inspect and replace a stale owner. The lock is
    // acquired with O_EXCL and the observed lease is checked again while held,
    // so a delayed contender can never rename a newly installed live owner.
    const takeoverFile = join(record.directory, '.owner.takeover.lock')
    const takeoverId = crypto.randomUUID()
    let takeoverHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      takeoverHandle = await open(takeoverFile, 'wx', FILE_MODE)
      await takeoverHandle.writeFile(JSON.stringify({
        takeoverId,
        pid: process.pid,
        processIdentity: cliProcessIdentity,
        createdAt: Date.now(),
      }), 'utf-8')
      await takeoverHandle.sync()
    } catch (takeoverError) {
      await takeoverHandle?.close().catch(() => {})
      if ((takeoverError as NodeJS.ErrnoException).code !== 'EEXIST') {
        await unlinkControlledFile(root, takeoverFile).catch(() => {})
      }
      if ((takeoverError as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Thread ${record.metadata.threadId} lease takeover is already in progress`)
      }
      throw takeoverError
    }
    await takeoverHandle.close()
    if (process.platform !== 'win32') await chmod(takeoverFile, FILE_MODE)

    try {
      const currentOwner = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
      if (currentOwner && isOwnerActive(currentOwner)) {
        throw new Error(`Thread ${record.metadata.threadId} is already active`)
      }
      if (
        observedOwner
        && currentOwner
        && currentOwner.leaseId !== observedOwner.leaseId
      ) {
        throw new Error(`Thread ${record.metadata.threadId} lease changed during takeover`)
      }
      if (
        options.purpose !== 'clone-source'
        && record.metadata.origin === 'cli-exec'
        && record.metadata.status !== 'interrupted'
      ) {
        await updateCliThread(record, { status: 'interrupted', lastUsedAt: Date.now() })
      }
      if (currentOwner) {
        // Keep owner.json present throughout the replacement. Removing it even
        // briefly would let another process win the initial O_EXCL create path
        // without observing the takeover lock.
        await atomicWriteJson(ownerFile, owner)
      } else {
        await writeFile(ownerFile, JSON.stringify(owner, null, 2), {
          flag: 'wx',
          mode: FILE_MODE,
        })
      }
    } finally {
      const takeover = await readJson<{ takeoverId?: string }>(takeoverFile)
        .catch(() => null)
      if (takeover?.takeoverId === takeoverId) {
        await unlinkControlledFile(root, takeoverFile)
      }
    }
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
      const current = await readJson<CliThreadOwner>(ownerFile)
      if (current.leaseId !== owner.leaseId) {
        throw new Error(`Thread ${record.metadata.threadId} lease was lost`)
      }
      await atomicWriteJson(ownerFile, owner)
    },
    async release() {
      if (released) return
      released = true
      if (existsSync(ownerFile)) await assertCanonicalControlledPath(root, ownerFile)
      const current = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
      if (current?.leaseId === owner.leaseId) {
        await unlinkControlledFile(root, ownerFile)
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

export async function listCliThreads(): Promise<CliThreadRecord[]> {
  const root = getCliSessionsRoot()
  if (!existsSync(root)) return []
  await assertCanonicalControlledPath(root, root)
  const records: CliThreadRecord[] = []
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
      if (!entry.isDirectory()) continue
      const directory = join(executionsRoot, entry.name)
      try {
        await assertCanonicalControlledPath(root, directory)
        const metadata = await readJson<CliThreadMetadata>(join(directory, 'thread.json'))
        records.push(recordFor(directory, metadata))
      } catch {
        // Corrupt or half-created Threads are not advertised as resumable.
      }
    }
  }
  return records.sort((a, b) => b.metadata.lastUsedAt - a.metadata.lastUsedAt)
}

export async function isCliThreadActive(record: CliThreadRecord): Promise<boolean> {
  await assertCanonicalControlledPath(getCliSessionsRoot(), record.directory)
  if (existsSync(record.ownerFile)) {
    await assertCanonicalControlledPath(getCliSessionsRoot(), record.ownerFile)
  }
  const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
  return owner ? isOwnerActive(owner) : false
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

async function moveThreadToTrash(record: CliThreadRecord): Promise<string> {
  const root = getCliSessionsRoot()
  assertControlledPath(root, record.directory)
  await assertCanonicalControlledPath(root, record.directory)
  const trashRoot = join(root, 'trash')
  await ensurePrivateDir(trashRoot)
  await assertCanonicalControlledPath(root, trashRoot)
  const target = join(trashRoot, `${record.metadata.threadId}.${crypto.randomUUID()}`)
  assertControlledPath(root, target)
  await rename(record.directory, target)
  await assertCanonicalControlledPath(root, target)
  return target
}

export async function deleteCliThread(record: CliThreadRecord): Promise<void> {
  const root = getCliSessionsRoot()
  await assertCanonicalControlledPath(root, record.directory)
  if (existsSync(record.ownerFile)) await assertCanonicalControlledPath(root, record.ownerFile)
  const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
  if (owner && isOwnerActive(owner)) {
    throw new Error(`Thread ${record.metadata.threadId} is active and cannot be deleted`)
  }
  const trash = await moveThreadToTrash(record)
  await assertCanonicalControlledPath(getCliSessionsRoot(), trash)
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
    for (const record of await listCliThreads()) {
      if (record.metadata.persistence !== 'ephemeral') continue
      const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
      if (!owner) continue
      const cliExists = processIdentityMatches(owner.cliPid, owner.cliProcessIdentity)
      const runtimeExists = processIdentityMatches(owner.serverPid, owner.serverProcessIdentity)
      const leaseExpired = now - owner.heartbeatAt > ACTIVE_LEASE_WINDOW_MS
      if (cliExists || runtimeExists || !leaseExpired) continue
      if (now - owner.heartbeatAt <= STALE_EPHEMERAL_MS) continue
      const trash = await moveThreadToTrash(record).catch(() => null)
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
