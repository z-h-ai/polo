import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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
  private readonly secrets: string[]

  constructor(sessionsRoot: string, options?: { secrets?: Array<string | undefined> }) {
    super()
    if (!sessionsRoot || !isAbsolute(sessionsRoot)) {
      throw new Error('CLI sessions root must be an absolute, normalized path')
    }
    this.sessionsRoot = resolve(sessionsRoot)
    this.secrets = (options?.secrets ?? []).filter((value): value is string => !!value)
  }

  getSessionsRoot(_workspaceRootPath: string): string {
    return this.sessionsRoot
  }

  getSessionPath(_workspaceRootPath: string, sessionId: string): string {
    return join(this.sessionsRoot, sanitizeSessionId(sessionId))
  }

  getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'session.jsonl')
  }

  ensureSessionsRoot(_workspaceRootPath: string): string {
    return ensurePrivateDirectory(this.sessionsRoot)
  }

  ensureSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    return ensureSessionTree(this.getSessionPath(workspaceRootPath, sessionId), this.owner)
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
