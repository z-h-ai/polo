import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RootedSessionStorage, type StoredSession } from './index.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('RootedSessionStorage', () => {
  it('routes every Polo-owned session path under the injected CLI root', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-rooted-storage-'))
    tempDirs.push(temp)
    const sessionsRoot = join(temp, 'thread', 'sessions')
    const storage = new RootedSessionStorage(sessionsRoot)

    const fakeWorkspace = join(temp, 'electron-workspace')
    const sessionDir = storage.ensureSession(fakeWorkspace, 'session-1')
    expect(sessionDir).toBe(join(sessionsRoot, 'session-1'))
    expect(storage.getSessionPath(fakeWorkspace, 'session-1')).toBe(sessionDir)
    expect(storage.getAttachmentsPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'attachments'))
    expect(storage.getPlansPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'plans'))
    expect(storage.getDataPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'data'))
    expect(storage.getDownloadsPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'downloads'))
    expect(storage.getLongResponsesPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'long_responses'))
    expect(storage.getMetaPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'meta'))

    if (process.platform !== 'win32') {
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps path resolution and persistence queues instance-local', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-rooted-storage-isolation-'))
    tempDirs.push(temp)
    const first = new RootedSessionStorage(join(temp, 'first', 'sessions'))
    const second = new RootedSessionStorage(join(temp, 'second', 'sessions'))

    expect(first.persistenceQueue).not.toBe(second.persistenceQueue)
    expect(first.getSessionPath('/ignored', 'same-id')).toBe(join(temp, 'first', 'sessions', 'same-id'))
    expect(second.getSessionPath('/ignored', 'same-id')).toBe(join(temp, 'second', 'sessions', 'same-id'))
  })

  it('redacts invocation credentials at the persistence boundary', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-rooted-storage-redaction-'))
    tempDirs.push(temp)
    const secret = 'sk-secret-value-123456789'
    const storage = new RootedSessionStorage(join(temp, 'sessions'), { secrets: [secret] })

    const persisted = storage.redactPersistedValue(
      `token=${secret} Authorization: Bearer ${secret} fallback=sk-another-secret-123456`,
    )

    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain('sk-another-secret-123456')
    expect(persisted).toContain('[REDACTED]')
  })

  it('keeps CRUD, JSONL, and every artifact outside Electron sessions', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-rooted-storage-crud-'))
    tempDirs.push(temp)
    const secret = 'sk-thread-secret-123456789'
    const sessionsRoot = join(temp, 'cli-thread', 'sessions')
    const electronWorkspace = join(temp, 'electron-workspace')
    const storage = new RootedSessionStorage(sessionsRoot, { secrets: [secret] })
    const session: StoredSession = {
      id: 'session-1',
      workspaceRootPath: electronWorkspace,
      createdAt: 1,
      lastUsedAt: 1,
      messages: [{
        id: 'message-1',
        type: 'assistant',
        content: `response must hide ${secret}`,
      }],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    }

    await storage.save(session)
    await storage.flushAll()

    expect(storage.list(electronWorkspace).map(item => item.id)).toEqual(['session-1'])
    expect(storage.load(electronWorkspace, session.id)?.messages[0]?.content).toContain('[REDACTED]')
    expect(existsSync(join(electronWorkspace, 'sessions'))).toBe(false)
    expect(readFileSync(storage.getSessionFilePath(electronWorkspace, session.id), 'utf8')).not.toContain(secret)
    expect(storage.delete(electronWorkspace, session.id)).toBe(true)
    expect(storage.load(electronWorkspace, session.id)).toBeNull()
  })
})
