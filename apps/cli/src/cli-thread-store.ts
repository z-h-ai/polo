import {
  chmod,
  cp,
  mkdir,
  open,
  readFile,
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

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE })
  if (process.platform !== 'win32') await chmod(path, DIRECTORY_MODE)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path))
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', FILE_MODE)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
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
}

export async function updateCliThread(
  record: CliThreadRecord,
  updates: Partial<Pick<CliThreadMetadata, 'mainSessionId' | 'status' | 'lastUsedAt' | 'workingDirectory' | 'configurationWorkspaceId' | 'configurationWorkspacePath' | 'connection'>>,
): Promise<void> {
  const metadata = await readJson<CliThreadMetadata>(join(record.directory, 'thread.json'))
  const next = { ...metadata, ...updates }
  await atomicWriteJson(join(record.directory, 'thread.json'), next)
  record.metadata = next
}

export function isOwnerActive(owner: CliThreadOwner, _now = Date.now()): boolean {
  const cliMatches = processIdentityMatches(owner.cliPid, owner.cliProcessIdentity)
  const serverMatches = processIdentityMatches(owner.serverPid, owner.serverProcessIdentity)
  return cliMatches || serverMatches
}

export async function acquireCliThreadLease(record: CliThreadRecord): Promise<CliThreadLease> {
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
    const previous = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
    if (previous && isOwnerActive(previous)) {
      throw new Error(`Thread ${record.metadata.threadId} is already active`)
    }
    if (record.metadata.origin === 'cli-exec' && record.metadata.status !== 'interrupted') {
      await updateCliThread(record, { status: 'interrupted', lastUsedAt: Date.now() })
    }
    const staleOwner = join(record.directory, `.owner.stale.${crypto.randomUUID()}.json`)
    await rename(ownerFile, staleOwner).catch(() => {})
    await writeFile(ownerFile, JSON.stringify(owner, null, 2), { flag: 'wx', mode: FILE_MODE })
    await unlink(staleOwner).catch(() => {})
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
      const current = await readJson<CliThreadOwner>(ownerFile).catch(() => null)
      if (current?.leaseId === owner.leaseId) {
        await unlink(ownerFile).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }
    },
  }
}

export async function locateCliThread(threadId: string): Promise<CliThreadRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null
  const root = getCliSessionsRoot()
  if (!existsSync(root)) return null
  for (const scope of await readdir(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name === 'trash') continue
    const directory = join(root, scope.name, 'executions', threadId)
    const metadataPath = join(directory, 'thread.json')
    if (!existsSync(metadataPath)) continue
    assertControlledPath(root, directory)
    const metadata = await readJson<CliThreadMetadata>(metadataPath)
    if (metadata.threadId !== threadId) throw new Error(`Corrupt Thread metadata: ${threadId}`)
    return recordFor(directory, metadata)
  }
  return null
}

export async function listCliThreads(): Promise<CliThreadRecord[]> {
  const root = getCliSessionsRoot()
  if (!existsSync(root)) return []
  const records: CliThreadRecord[] = []
  for (const scope of await readdir(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name === 'trash') continue
    const executionsRoot = join(root, scope.name, 'executions')
    if (!existsSync(executionsRoot)) continue
    for (const entry of await readdir(executionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(executionsRoot, entry.name)
      try {
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
    await rm(clone.sessionsRoot, { recursive: true, force: true })
    await cp(source.sessionsRoot, clone.sessionsRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    if (process.platform !== 'win32') await chmod(clone.sessionsRoot, DIRECTORY_MODE)
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
  const trashRoot = join(root, 'trash')
  await ensurePrivateDir(trashRoot)
  const target = join(trashRoot, `${record.metadata.threadId}.${crypto.randomUUID()}`)
  assertControlledPath(root, target)
  await rename(record.directory, target)
  return target
}

export async function deleteCliThread(record: CliThreadRecord): Promise<void> {
  const owner = await readJson<CliThreadOwner>(record.ownerFile).catch(() => null)
  if (owner && isOwnerActive(owner)) {
    throw new Error(`Thread ${record.metadata.threadId} is active and cannot be deleted`)
  }
  const trash = await moveThreadToTrash(record)
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
    const info = await stat(cleanerLock).catch(() => null)
    if (!info || now - info.mtimeMs <= 60_000) return 0
    await unlink(cleanerLock).catch(() => {})
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
      await rm(trash, { recursive: true, force: true })
      cleaned++
    }
  } finally {
    await unlink(cleanerLock).catch(() => {})
  }
  return cleaned
}

export async function threadDiskUsage(record: CliThreadRecord): Promise<number> {
  let total = 0
  const walk = async (path: string): Promise<void> => {
    const info = await stat(path)
    if (info.isFile()) {
      total += info.size
      return
    }
    for (const entry of await readdir(path)) await walk(join(path, entry))
  }
  await walk(record.directory)
  return total
}
