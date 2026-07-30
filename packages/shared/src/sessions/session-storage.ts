import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { sanitizeSessionId } from './validation.ts'
import { setSessionFilePathResolver } from '@polo-ai/session-tools-core'

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
  getSessionsRoot(workspaceRootPath: string): string
  getSessionPath(workspaceRootPath: string, sessionId: string): string
  getSessionFilePath(workspaceRootPath: string, sessionId: string): string
  ensureSessionsRoot(workspaceRootPath: string): string
  ensureSession(workspaceRootPath: string, sessionId: string): string
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

export class WorkspaceSessionStorage implements SessionStorage {
  readonly owner = 'electron' as const

  getSessionsRoot(workspaceRootPath: string): string {
    return join(workspaceRootPath, 'sessions')
  }

  getSessionPath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionsRoot(workspaceRootPath), sanitizeSessionId(sessionId))
  }

  getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
    return join(this.getSessionPath(workspaceRootPath, sessionId), 'session.jsonl')
  }

  ensureSessionsRoot(workspaceRootPath: string): string {
    return ensureDirectory(this.getSessionsRoot(workspaceRootPath))
  }

  ensureSession(workspaceRootPath: string, sessionId: string): string {
    this.ensureSessionsRoot(workspaceRootPath)
    return ensureSessionTree(this.getSessionPath(workspaceRootPath, sessionId), this.owner)
  }
}

export class RootedSessionStorage implements SessionStorage {
  readonly owner = 'cli' as const
  readonly sessionsRoot: string

  constructor(sessionsRoot: string) {
    if (!sessionsRoot || !isAbsolute(sessionsRoot)) {
      throw new Error('CLI sessions root must be an absolute, normalized path')
    }
    this.sessionsRoot = resolve(sessionsRoot)
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
}

const desktopSessionStorage = new WorkspaceSessionStorage()
let activeSessionStorage: SessionStorage = desktopSessionStorage

/**
 * Installs the storage service for the current host process. CLI execution
 * runtimes are one-Thread processes; Electron keeps the default service.
 */
export function setSessionStorage(storage: SessionStorage): void {
  activeSessionStorage = storage
  setSessionFilePathResolver((workspaceRootPath, sessionId) =>
    storage.getSessionFilePath(workspaceRootPath, sessionId)
  )
}

export function getSessionStorage(): SessionStorage {
  return activeSessionStorage
}

export function resetSessionStorage(): void {
  activeSessionStorage = desktopSessionStorage
  setSessionFilePathResolver((workspaceRootPath, sessionId) =>
    desktopSessionStorage.getSessionFilePath(workspaceRootPath, sessionId)
  )
}
