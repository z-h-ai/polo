import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StoredSession } from '@polo-ai/shared/sessions'
import { createManagedSession, SessionManager } from './SessionManager.ts'

// POO-205 C9 (R12): markAllSessionsRead's `options.projectId` narrows the
// sweep to ONE project's sessions (the "mark all read" inside a project
// tab); omitted keeps the workspace-wide behavior byte-for-byte. The
// SessionManager is always built against a TEMP workspace — never the real
// user store (lead-plan §5 X4).

const spaceId = 'space-mar-scope'
const accountA = 'acc-mar'
const workspaceId = 'ws_mar'

type ManagedRecord = ReturnType<typeof createManagedSession>
const sessionsOf = (sm: SessionManager) =>
  (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions

describe('markAllSessionsRead project scope (POO-205 C9 R12)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let workspace: { id: string; name: string; rootPath: string; createdAt: number }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-mar-scope-'))
    workspace = { id: workspaceId, name: 'MAR Scope', rootPath: tmpRoot, createdAt: Date.now() }
    sm = new SessionManager({ workspace: workspace as never })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedUnread(input: {
    id: string
    projectId?: string
    hidden?: boolean
    isArchived?: boolean
    hasUnread?: boolean
  }): ManagedRecord {
    const stored = {
      id: input.id,
      workspaceRootPath: tmpRoot,
      name: input.id,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      productSpaceId: spaceId,
      accountId: accountA,
      projectId: input.projectId,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as unknown as StoredSession
    const managed = createManagedSession(stored as never, workspace as never, { messagesLoaded: true })
    if (input.hidden) (managed as unknown as { hidden: boolean }).hidden = true
    if (input.isArchived) (managed as unknown as { isArchived: boolean }).isArchived = true
    if (input.hasUnread !== false) managed.hasUnread = true
    sessionsOf(sm).set(input.id, managed)
    return managed
  }

  it('WITHOUT options: the workspace-wide sweep clears every scope-matching unread session', async () => {
    const inProject = seedUnread({ id: 'mar-proj', projectId: 'proj-1' })
    const otherProject = seedUnread({ id: 'mar-other', projectId: 'proj-2' })
    const personal = seedUnread({ id: 'mar-personal' })

    await sm.markAllSessionsRead(workspaceId, { productSpaceId: spaceId, accountId: accountA })

    expect(inProject.hasUnread).toBe(false)
    expect(otherProject.hasUnread).toBe(false)
    expect(personal.hasUnread).toBe(false)
  })

  it('WITH options.projectId: ONLY that project is swept — others and personal stay unread', async () => {
    const inProject = seedUnread({ id: 'mar-proj', projectId: 'proj-1' })
    const otherProject = seedUnread({ id: 'mar-other', projectId: 'proj-2' })
    const personal = seedUnread({ id: 'mar-personal' })

    await sm.markAllSessionsRead(
      workspaceId,
      { productSpaceId: spaceId, accountId: accountA },
      { projectId: 'proj-1' },
    )

    expect(inProject.hasUnread).toBe(false)
    expect(otherProject.hasUnread).toBe(true)
    expect(personal.hasUnread).toBe(true)
  })

  it('the narrowed sweep still skips hidden and archived sessions (existing guards intact)', async () => {
    const visible = seedUnread({ id: 'mar-visible', projectId: 'proj-1' })
    const hidden = seedUnread({ id: 'mar-hidden', projectId: 'proj-1', hidden: true })
    const archived = seedUnread({ id: 'mar-archived', projectId: 'proj-1', isArchived: true })

    await sm.markAllSessionsRead(
      workspaceId,
      { productSpaceId: spaceId, accountId: accountA },
      { projectId: 'proj-1' },
    )

    expect(visible.hasUnread).toBe(false)
    expect(hidden.hasUnread).toBe(true)
    expect(archived.hasUnread).toBe(true)
  })

  it('an incomplete scope fails closed and mutates nothing (either options shape)', async () => {
    const inProject = seedUnread({ id: 'mar-proj', projectId: 'proj-1' })

    await sm.markAllSessionsRead(workspaceId, null, { projectId: 'proj-1' })
    expect(inProject.hasUnread).toBe(true)

    await sm.markAllSessionsRead(workspaceId)
    expect(inProject.hasUnread).toBe(true)
  })
})
