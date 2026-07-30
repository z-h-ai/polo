import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { sanitizeSessionId } from './validation.ts'
import { SessionPersistenceQueue } from './persistence-queue.ts'
import type { SessionConfig, SessionMetadata, StoredSession } from './types.ts'
import {
  createSessionWithStorage,
  deleteSessionWithStorage,
  listSessionsWithStorage,
  loadSessionWithStorage,
  saveSessionWithStorage,
} from './storage.ts'

export type SessionStorageOwner = 'electron' | 'cli'

/**
 * Complete path service for Polo-owned session artifacts.
 *
 * The desktop implementation derives the root from the configuration workspace.
 * A CLI execution injects a RootedSessionStorage whose root is the current
 * Thread's private sessions directory. All existing session helpers delegate to
 * this service, so attachments, plans, downloads, bundles and sidecars share the
 * same physical boundary.
 */
export interface SessionStorage {
  readonly owner: SessionStorageOwner
  readonly persistenceQueue: SessionPersistenceQueue
  getSessionsRoot(workspaceRootPath: string): string
  getSessionPath(workspaceRootPath: string, sessionId: string): string
  getSessionFilePath(workspaceRootPath: string, sessionId: string): string
  getAttachmentsPath(workspaceRootPath: string, sessionId: string): string
  getPlansPath(workspaceRootPath: string, sessionId: string): string
  getDataPath(workspaceRootPath: string, sessionId: string): string
  getDownloadsPath(workspaceRootPath: string, sessionId: string): string
  getLongResponsesPath(workspaceRootPath: string, sessionId: string): string
  getMetaPath(workspaceRootPath: string, sessionId: string): string
  ensureSessionsRoot(workspaceRootPath: string): string
  ensureSession(workspaceRootPath: string, sessionId: string): string
  reserveSession(workspaceRootPath: string, sessionId: string): string
  create(
    workspaceRootPath: string,
    options?: Parameters<typeof createSessionWithStorage>[2],
  ): Promise<SessionConfig>
  load(workspaceRootPath: string, sessionId: string): StoredSession | null
  list(workspaceRootPath: string): SessionMetadata[]
  save(session: StoredSession): Promise<void>
  flush(sessionId: string): Promise<void>
  flushAll(): Promise<void>
  delete(workspaceRootPath: string, sessionId: string): boolean
  redactPersistedValue?(value: string): string
  assertSafeFilePath?(path: string, allowMissing?: boolean): void
}

function ensurePrivateDirectory(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  if (process.platform !== 'win32') {
    chmodSync(path, 0o700)
  }
  return path
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function ensurePrivateDirectoryWithoutSymlinks(path: string): string {
  const target = resolve(path)
  const missing: string[] = []
  let current = target
  while (true) {
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Refusing unsafe CLI session directory: ${current}`)
      }
      break
    } catch (error) {
      if (!isMissing(error)) throw error
      missing.push(basename(current))
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
  const canonicalAncestor = realpathSync(current)
  for (const segment of missing.reverse()) {
    current = join(current, segment)
    try {
      mkdirSync(current, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = lstatSync(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe CLI session directory: ${current}`)
    }
    const canonical = realpathSync(current)
    const fromAncestor = relative(canonicalAncestor, canonical)
    if (fromAncestor === '..' || fromAncestor.startsWith(`..${sep}`)) {
      throw new Error(`Refusing CLI session directory outside controlled root: ${current}`)
    }
    if (process.platform !== 'win32') chmodSync(current, 0o700)
  }
  if (process.platform !== 'win32') chmodSync(target, 0o700)
  return target
}

function ensureDirectory(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

function ensureSessionTree(path: string, owner: SessionStorageOwner): string {
  const ensure = owner === 'cli' ? ensurePrivateDirectory : ensureDirectory
  ensure(path)
  const children = owner === 'cli'
    ? ['plans', 'attachments', 'long_responses', 'data', 'downloads', 'meta']
    : ['plans', 'attachments', 'long_responses', 'data', 'downloads']
  for (const child of children) {
    ensure(join(path, child))
  }
  return path
}

abstract class FilesystemSessionStorage implements SessionStorage {
  abstract readonly owner: SessionStorageOwner
  readonly persistenceQueue: SessionPersistenceQueue

  protected constructor() {
    this.persistenceQueue = new SessionPersistenceQueue(this)
  }

  abstract getSessionsRoot(workspaceRootPath: string): string
  abstract ensureSessionsRoot(workspaceRootPath: string): string

  getSessionPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionsRoot(workspaceRootPath), sanitizeSessionId(sessionId))
  }

  getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'session.jsonl')
  }

  ensureSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    return ensureSessionTree(this.getSessionPath(workspaceRootPath, sessionId), this.owner)
  }

  reserveSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    const path = this.getSessionPath(workspaceRootPath, sessionId)
    mkdirSync(path, {
      recursive: false,
      mode: this.owner === 'cli' ? 0o700 : undefined,
    })
    if (this.owner === 'cli' && process.platform !== 'win32') {
      chmodSync(path, 0o700)
    }
    return ensureSessionTree(path, this.owner)
  }

  getAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'attachments')
  }

  getPlansPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'plans')
  }

  getDataPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'data')
  }

  getDownloadsPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'downloads')
  }

  getLongResponsesPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'long_responses')
  }

  getMetaPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'meta')
  }

  create(
    workspaceRootPath: string,
    options?: Parameters<typeof createSessionWithStorage>[2],
  ): Promise<SessionConfig> {
    return createSessionWithStorage(workspaceRootPath, this, options)
  }

  load(workspaceRootPath: string, sessionId: string): StoredSession | null {
    return loadSessionWithStorage(workspaceRootPath, sessionId, this)
  }

  list(workspaceRootPath: string): SessionMetadata[] {
    return listSessionsWithStorage(workspaceRootPath, this)
  }

  save(session: StoredSession): Promise<void> {
    return saveSessionWithStorage(session, this)
  }

  flush(sessionId: string): Promise<void> {
    return this.persistenceQueue.flush(sessionId)
  }

  flushAll(): Promise<void> {
    return this.persistenceQueue.flushAll()
  }

  delete(workspaceRootPath: string, sessionId: string): boolean {
    return deleteSessionWithStorage(workspaceRootPath, sessionId, this)
  }
}

export class WorkspaceSessionStorage extends FilesystemSessionStorage {
  readonly owner = 'electron' as const

  constructor() {
    super()
  }

  getSessionsRoot(workspaceRootPath: string): string {
    return join(workspaceRootPath, 'sessions')
  }

  ensureSessionsRoot(workspaceRootPath: string): string {
    return ensureDirectory(this.getSessionsRoot(workspaceRootPath))
  }
}

export class RootedSessionStorage extends FilesystemSessionStorage {
  readonly owner = 'cli' as const
  readonly sessionsRoot: string
  readonly controlledRoot: string
  private readonly secrets: string[]

  constructor(
    sessionsRoot: string,
    options?: {
      secrets?: Array<string | undefined>
      controlledRoot?: string
    },
  ) {
    super()
    if (!sessionsRoot || !isAbsolute(sessionsRoot)) {
      throw new Error('CLI sessions root must be an absolute, normalized path')
    }
    this.sessionsRoot = resolve(sessionsRoot)
    this.controlledRoot = resolve(options?.controlledRoot ?? this.sessionsRoot)
    const sessionsRelative = relative(this.controlledRoot, this.sessionsRoot)
    if (
      sessionsRelative === '..'
      || sessionsRelative.startsWith(`..${sep}`)
      || isAbsolute(sessionsRelative)
    ) {
      throw new Error('CLI sessions root must be inside its controlled root')
    }
    this.secrets = (options?.secrets ?? []).filter((value): value is string => !!value)
  }

  private assertControlledPath(path: string, allowMissing = true): void {
    const target = resolve(path)
    const fromControlledRoot = relative(this.controlledRoot, target)
    if (
      fromControlledRoot === '..'
      || fromControlledRoot.startsWith(`..${sep}`)
      || isAbsolute(fromControlledRoot)
    ) {
      throw new Error(`Refusing path outside controlled CLI sessions root: ${path}`)
    }

    let controlledRootInfo
    try {
      controlledRootInfo = lstatSync(this.controlledRoot)
    } catch (error) {
      if (allowMissing && isMissing(error)) {
        // Validate the deepest existing ancestor so a dangling or intermediate
        // symlink cannot later redirect creation outside the Thread.
        let ancestor = this.controlledRoot
        while (true) {
          try {
            const info = lstatSync(ancestor)
            if (info.isSymbolicLink() || !info.isDirectory()) {
              throw new Error(`Refusing unsafe CLI sessions ancestor: ${ancestor}`)
            }
            return
          } catch (ancestorError) {
            if (!isMissing(ancestorError)) throw ancestorError
            const parent = dirname(ancestor)
            if (parent === ancestor) throw ancestorError
            ancestor = parent
          }
        }
      }
      throw error
    }
    if (controlledRootInfo.isSymbolicLink() || !controlledRootInfo.isDirectory()) {
      throw new Error(`Refusing unsafe CLI controlled root: ${this.controlledRoot}`)
    }

    const canonicalRoot = realpathSync(this.controlledRoot)
    let current = this.controlledRoot
    const segments = fromControlledRoot ? fromControlledRoot.split(sep) : []
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!)
      let info
      try {
        info = lstatSync(current)
      } catch (error) {
        if (allowMissing && isMissing(error)) return
        throw error
      }
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing symlink inside controlled CLI sessions root: ${current}`)
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new Error(`Refusing non-directory CLI session ancestor: ${current}`)
      }
      const canonical = realpathSync(current)
      const canonicalRelative = relative(canonicalRoot, canonical)
      if (
        canonicalRelative === '..'
        || canonicalRelative.startsWith(`..${sep}`)
        || isAbsolute(canonicalRelative)
      ) {
        throw new Error(`Refusing path outside canonical CLI sessions root: ${current}`)
      }
    }
  }

  private ensureControlledDirectory(path: string): string {
    this.assertControlledPath(path, true)
    const fromRoot = relative(this.sessionsRoot, resolve(path))
    let current = this.sessionsRoot
    for (const segment of fromRoot ? fromRoot.split(sep) : []) {
      current = join(current, segment)
      try {
        mkdirSync(current, { recursive: false, mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      this.assertControlledPath(current, false)
      const info = lstatSync(current)
      if (!info.isDirectory()) {
        throw new Error(`Refusing non-directory CLI session path: ${current}`)
      }
      if (process.platform !== 'win32') chmodSync(current, 0o700)
    }
    return path
  }

  assertSafeFilePath(path: string, allowMissing = true): void {
    this.assertControlledPath(path, allowMissing)
  }

  getSessionsRoot(_workspaceRootPath: string): string {
    this.assertControlledPath(this.sessionsRoot, true)
    return this.sessionsRoot
  }

  getSessionPath(_workspaceRootPath: string, sessionId: string): string {
    const path = join(this.sessionsRoot, sanitizeSessionId(sessionId))
    this.assertControlledPath(path, true)
    return path
  }

  getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
    const path = join(this.getSessionPath(workspaceRootPath, sessionId), 'session.jsonl')
    this.assertControlledPath(path, true)
    return path
  }

  private getArtifactPath(
    workspaceRootPath: string,
    sessionId: string,
    name: string,
  ): string {
    const path = join(this.getSessionPath(workspaceRootPath, sessionId), name)
    this.assertControlledPath(path, true)
    return path
  }

  getAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'attachments')
  }

  getPlansPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'plans')
  }

  getDataPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'data')
  }

  getDownloadsPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'downloads')
  }

  getLongResponsesPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'long_responses')
  }

  getMetaPath(workspaceRootPath: string, sessionId: string): string {
    return this.getArtifactPath(workspaceRootPath, sessionId, 'meta')
  }

  ensureSessionsRoot(_workspaceRootPath: string): string {
    this.assertControlledPath(this.sessionsRoot, true)
    const path = ensurePrivateDirectoryWithoutSymlinks(this.sessionsRoot)
    this.assertControlledPath(this.sessionsRoot, false)
    return path
  }

  ensureSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    const path = this.ensureControlledDirectory(
      this.getSessionPath(workspaceRootPath, sessionId),
    )
    for (const child of [
      'plans',
      'attachments',
      'long_responses',
      'data',
      'downloads',
      'meta',
    ]) {
      this.ensureControlledDirectory(join(path, child))
    }
    return path
  }

  reserveSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    const path = this.getSessionPath(workspaceRootPath, sessionId)
    this.assertControlledPath(path, true)
    let reserved = false
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 })
      reserved = true
      if (process.platform !== 'win32') chmodSync(path, 0o700)
      for (const child of [
        'plans',
        'attachments',
        'long_responses',
        'data',
        'downloads',
        'meta',
      ]) {
        this.ensureControlledDirectory(join(path, child))
      }
      return path
    } catch (error) {
      if (reserved) {
        try {
          this.assertControlledPath(path, false)
          rmSync(path, { recursive: true, force: true })
        } catch {
          // Preserve the original reservation error; unsafe replacement paths
          // are intentionally not traversed during rollback.
        }
      }
      throw error
    }
  }

  redactPersistedValue(value: string): string {
    let redacted = value
    for (const secret of this.secrets) {
      redacted = redacted.split(secret).join('[REDACTED]')
    }
    return redacted
      .replace(/Authorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi, 'Authorization: [REDACTED]')
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
  }
}

/** Immutable compatibility storage for functional desktop callers. */
export const defaultWorkspaceSessionStorage = new WorkspaceSessionStorage()
