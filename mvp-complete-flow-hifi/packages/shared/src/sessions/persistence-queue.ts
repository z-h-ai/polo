import { chmod, writeFile, rename, unlink } from 'fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'path'
import { sanitizeSessionId } from './validation.ts'
import type { StoredSession, SessionHeader } from './types.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

export interface SessionPersistencePaths {
  readonly owner: 'electron' | 'cli'
  ensureSessionsRoot(workspaceRootPath: string): string
  ensureSession(workspaceRootPath: string, sessionId: string): string
  getSessionFilePath(workspaceRootPath: string, sessionId: string): string
  redactPersistedValue?(value: string): string
  assertSafeFilePath?(path: string, allowMissing?: boolean): void
}

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number
  private writeErrors = new Map<string, unknown>()

  constructor(
    private readonly paths: SessionPersistencePaths,
    debounceMs = 500,
  ) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      // Preserve the error for flush()/flushAll(), where lifecycle callers can
      // fail cleanup deterministically, without creating an unhandled rejection
      // from the debounce callback itself.
      void this.startWrite(session.id).catch(() => {})
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)

    let temporaryFile: string | undefined
    try {
      const { data } = entry
      this.paths.ensureSessionsRoot(data.workspaceRootPath)
      this.paths.ensureSession(data.workspaceRootPath, sessionId)

      const filePath = this.paths.getSessionFilePath(data.workspaceRootPath, sessionId)
      this.paths.assertSafeFilePath?.(filePath, true)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ].map(line => this.paths.redactPersistedValue?.(line) ?? line)

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      temporaryFile = tmpFile
      const privateFile = this.paths.owner === 'cli'
      this.paths.assertSafeFilePath?.(tmpFile, true)
      await writeFile(tmpFile, lines.join('\n') + '\n', {
        encoding: 'utf-8',
        ...(privateFile ? { mode: 0o600 } : {}),
      })
      if (privateFile && process.platform !== 'win32') await chmod(tmpFile, 0o600)
      this.paths.assertSafeFilePath?.(tmpFile, false)
      this.paths.assertSafeFilePath?.(filePath, true)
      // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
      try { await unlink(filePath) } catch { /* ignore if doesn't exist */ }
      this.paths.assertSafeFilePath?.(filePath, true)
      await rename(tmpFile, filePath)
      this.paths.assertSafeFilePath?.(filePath, false)
      if (privateFile && process.platform !== 'win32') await chmod(filePath, 0o600)
      this.writeErrors.delete(sessionId)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      if (temporaryFile) {
        try { await unlink(temporaryFile) } catch { /* ignore absent temporary file */ }
      }
      this.writeErrors.set(sessionId, error)
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
      throw error
    }
  }

  /**
   * Put every write, including debounce-timer writes, on the same per-session
   * chain. A timer callback must never bypass the chain observed by flush().
   */
  private startWrite(sessionId: string): Promise<void> {
    const previous = this.writeInProgress.get(sessionId) ?? Promise.resolve()
    const writePromise = previous
      .catch(() => {
        // The prior failure is retained in writeErrors and rethrown by flush.
        // Continue the chain so a newer snapshot can still be persisted.
      })
      .then(() => this.write(sessionId))

    this.writeInProgress.set(sessionId, writePromise)
    void writePromise.finally(() => {
      if (this.writeInProgress.get(sessionId) === writePromise) {
        this.writeInProgress.delete(sessionId)
      }
    }).catch(() => {})
    return writePromise
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    // Enqueue can race a timer-triggered write. Loop until both the pending
    // snapshot and the in-flight chain are empty at the same observation point.
    while (true) {
      const entry = this.pending.get(sessionId)
      if (entry) {
        clearTimeout(entry.timer)
        await this.startWrite(sessionId)
        continue
      }
      const inProgress = this.writeInProgress.get(sessionId)
      if (!inProgress) break
      await inProgress
    }
    const error = this.writeErrors.get(sessionId)
    if (error) throw error
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    while (this.pending.size > 0 || this.writeInProgress.size > 0) {
      const sessionIds = new Set([
        ...this.pending.keys(),
        ...this.writeInProgress.keys(),
      ])
      await Promise.all([...sessionIds].map(id => this.flush(id)))
    }
    if (this.writeErrors.size > 0) {
      const first = this.writeErrors.values().next().value
      throw first instanceof Error ? first : new Error(String(first))
    }
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Backward-compatible desktop queue for legacy functional callers. Runtime
// hosts should inject a SessionStorage instance and use its private queue.
export const sessionPersistenceQueue = new SessionPersistenceQueue({
  owner: 'electron',
  ensureSessionsRoot(workspaceRootPath) {
    const path = join(workspaceRootPath, 'sessions')
    mkdirSync(path, { recursive: true })
    return path
  },
  ensureSession(workspaceRootPath, sessionId) {
    const path = join(workspaceRootPath, 'sessions', sanitizeSessionId(sessionId))
    mkdirSync(path, { recursive: true })
    return path
  },
  getSessionFilePath(workspaceRootPath, sessionId) {
    return join(workspaceRootPath, 'sessions', sanitizeSessionId(sessionId), 'session.jsonl')
  },
})

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
