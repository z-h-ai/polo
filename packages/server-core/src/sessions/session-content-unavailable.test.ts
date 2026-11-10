import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionFilePath, writeSessionJsonl, type StoredSession } from '@polo-ai/shared/sessions'
import type { StoredMessage } from '@polo-ai/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// POO-205 C5 (X2): a session whose session.jsonl EXISTS on disk but fails to
// load must never be treated as a fresh empty session. Before the fix, both
// loadMessagesFromDisk and the cold-persist hydration silently set
// messagesLoaded=true when the load returned null — the next persist wrote
// "header + only the new message" over the real, unreadable history.
//
// Now: sends are refused with the coded SESSION_CONTENT_UNAVAILABLE error
// and persistence refuses outright until a reload actually succeeds.

describe('session content unavailable guard (X2)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-x2-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  /** Register a cold (messagesLoaded=false) session in memory only. */
  function seedColdSession(sessionId: string, name = 'x2 session'): void {
    const managed = createManagedSession(
      { id: sessionId, name, sessionStatus: 'todo', labels: [], createdAt: Date.now() },
      buildWorkspace(),
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  }

  /** A crashed/truncated JSONL: the file exists but parses as nothing. */
  function seedUnreadableRecord(sessionId: string): void {
    const path = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '', 'utf-8')
  }

  function seedReadableRecord(sessionId: string, messages: StoredMessage[]): void {
    const path = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'with history',
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages,
    } as unknown as StoredSession
    writeSessionJsonl(path, stored)
  }

  function diskBytes(sessionId: string): string | null {
    const path = getSessionFilePath(tmpRoot, sessionId)
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  }

  function makeUserMessage(id: string, content: string): StoredMessage {
    return { id, type: 'user', content, timestamp: Date.now() } as StoredMessage
  }

  it('sendMessage refuses with SESSION_CONTENT_UNAVAILABLE when the record exists but cannot load', async () => {
    const sessionId = 'x2-refuse-send'
    seedColdSession(sessionId)
    seedUnreadableRecord(sessionId)
    const before = diskBytes(sessionId)

    let caught: unknown = null
    await sm.sendMessage(sessionId, 'should be refused', undefined, undefined, undefined, undefined, undefined, () => {
      throw new Error('onAck must never fire for a refused send')
    }).catch(error => { caught = error })

    expect(caught).not.toBeNull()
    expect((caught as Error).message).toContain('SESSION_CONTENT_UNAVAILABLE')
    expect((caught as { code?: string }).code).toBe('SESSION_CONTENT_UNAVAILABLE')
    // The unreadable record is untouched — no header+stub overwrite.
    expect(diskBytes(sessionId)).toBe(before)
  })

  it('persistSession refuses to write when the record exists but cannot load', async () => {
    const sessionId = 'x2-refuse-persist'
    seedColdSession(sessionId)
    seedUnreadableRecord(sessionId)
    const before = diskBytes(sessionId)

    await sm.setSessionStatus(sessionId, 'done')
    await sm.flushSession(sessionId)

    expect(diskBytes(sessionId)).toBe(before)
  })

  it('sending after a successful lazy load keeps the old history and appends the new message', async () => {
    const sessionId = 'x2-keeps-history'
    seedColdSession(sessionId)
    const oldMessage = makeUserMessage('old-1', 'previous conversation turn')
    seedReadableRecord(sessionId, [oldMessage])

    let ackedMessageId: string | null = null
    await sm
      .sendMessage(sessionId, 'new turn', undefined, undefined, undefined, undefined, undefined, messageId => {
        ackedMessageId = messageId
      })
      .catch(() => { /* post-ack agent-init failure is expected in this harness */ })

    expect(ackedMessageId).not.toBeNull()
    const ids = diskBytes(sessionId)!.trim().split('\n').slice(1).map(l => JSON.parse(l).id as string)
    // OLD history survived AND the new message is appended after it.
    expect(ids).toContain('old-1')
    expect(ids).toContain(ackedMessageId!)
    expect(ids.indexOf('old-1')).toBeLessThan(ids.indexOf(ackedMessageId!))
  })

  it('a genuinely fresh session (no file at all) still persists normally — the guard is load-failure-only', async () => {
    const sessionId = 'x2-fresh-unaffected'
    seedColdSession(sessionId)
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)

    await sm.setSessionStatus(sessionId, 'done')
    await sm.flushSession(sessionId)

    // The cold persist created the record from scratch, as before the fix.
    const header = JSON.parse(diskBytes(sessionId)!.trim().split('\n')[0])
    expect(header.sessionStatus).toBe('done')
  })
})
