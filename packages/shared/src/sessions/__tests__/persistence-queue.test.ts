import { afterEach, describe, it, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, StoredSession } from '../types'
import {
  getHeaderMetadataSignature,
  mergeHeaderWithExternalMetadata,
  SessionPersistenceQueue,
} from '../persistence-queue'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 's1',
    workspaceRootPath: '~/.polo-ai/workspaces/ws',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
    ...overrides,
  }
}

describe('session persistence header conflict helpers', () => {
  it('metadata signature ignores non-metadata fields', () => {
    const a = makeHeader({ name: 'A', lastUsedAt: 100 })
    const b = makeHeader({ name: 'A', lastUsedAt: 999, messageCount: 42 })

    expect(getHeaderMetadataSignature(a)).toBe(getHeaderMetadataSignature(b))
  })

  it('metadata signature changes when metadata changes', () => {
    const a = makeHeader({ name: 'A', labels: ['x'] })
    const b = makeHeader({ name: 'B', labels: ['x'] })

    expect(getHeaderMetadataSignature(a)).not.toBe(getHeaderMetadataSignature(b))
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      sessionStatus: 'todo',
      permissionMode: 'allow-all',
      hasUnread: true,
      lastReadMessageId: 'm-local',
      messageCount: 99,
      lastUsedAt: 500,
    })

    const disk = makeHeader({
      name: 'Disk Name',
      labels: ['disk'],
      isFlagged: true,
      sessionStatus: 'needs-review',
      permissionMode: 'safe',
      hasUnread: false,
      lastReadMessageId: 'm-disk',
      messageCount: 1,
      lastUsedAt: 50,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.name).toBe('Disk Name')
    expect(merged.labels).toEqual(['disk'])
    expect(merged.isFlagged).toBe(true)
    expect(merged.sessionStatus).toBe('needs-review')
    expect(merged.permissionMode).toBe('safe')
    expect(merged.hasUnread).toBe(false)
    expect(merged.lastReadMessageId).toBe('m-disk')

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
  })

  it('startup scenario: external metadata differs from local signature', () => {
    const local = makeHeader({ name: 'Local Name', labels: ['local'] })
    const disk = makeHeader({ name: 'External Name', labels: ['external'] })

    const localSig = getHeaderMetadataSignature(local)
    const diskSig = getHeaderMetadataSignature(disk)

    // This is the condition used by persistence queue at startup:
    // no previousSig yet, disk differs from local → preserve external metadata.
    const hasExternalMetadataChange = diskSig !== localSig
      && (undefined === undefined || diskSig !== undefined)

    expect(hasExternalMetadataChange).toBe(true)

    const merged = mergeHeaderWithExternalMetadata(local, disk)
    expect(merged.name).toBe('External Name')
    expect(merged.labels).toEqual(['external'])
  })

  it('flushAll waits for a timer-started write and preserves the latest JSONL', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'polo-persistence-race-'))
    tempDirs.push(workspaceRoot)
    const sessionDir = join(workspaceRoot, 'sessions', 's1')
    const queue = new SessionPersistenceQueue({
      owner: 'cli',
      ensureSessionsRoot() {
        mkdirSync(join(workspaceRoot, 'sessions'), { recursive: true })
        return join(workspaceRoot, 'sessions')
      },
      ensureSession() {
        mkdirSync(sessionDir, { recursive: true })
        return sessionDir
      },
      getSessionFilePath() {
        return join(sessionDir, 'session.jsonl')
      },
    }, 1)
    const session: StoredSession = {
      ...makeHeader(),
      workspaceRootPath: workspaceRoot,
      messages: [{
        id: 'm1',
        type: 'assistant',
        content: 'latest durable response',
        timestamp: Date.now(),
      }],
    }

    queue.enqueue(session)
    await Bun.sleep(5)
    await queue.flushAll()

    const jsonl = readFileSync(join(sessionDir, 'session.jsonl'), 'utf8')
    expect(jsonl).toContain('latest durable response')
    expect(queue.pendingCount).toBe(0)
  })
})
