import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { StoredMessage, StoredSession } from '@polo-ai/shared/sessions'
import {
  getSessionFilePath,
  projectSessionStoreRoot,
  writeSessionJsonl,
} from '@polo-ai/shared/sessions'
import { isErrorCode, SESSION_PROJECT_ERROR_MESSAGES } from '@polo-ai/shared/protocol'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { assertSessionProjectBinding } from './session-project-binding'
import {
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account'
import {
  resetProjectContextResolverForTests,
  setProjectContextResolverAdminForTests,
  setProjectContextResolverSpaceReaderForTests,
} from '../project-members/project-context-resolver'

// POO-205 C6: sessions, branches, agent tools and imports never cross the
// project boundary. The AGENT TOOL surface answers "does not exist" for any
// other project's sessions (no existence disclosure), a BRANCH inherits its
// source's project binding (an explicit different project is the coded
// BRANCH_PROJECT_MISMATCH), a SPAWNED child lands in its parent's project
// store, an IMPORT in an enterprise space must name its project and lands in
// that project's store, and the background entry points (automation, remote
// transfer) refuse with the coded readable reason.

const accountA = 'account-a'
const enterpriseSpaceId = 'space-ent'
const personalSpaceId = 'space-personal'
const workspaceId = 'ws_test'

type ManagedRecord = ReturnType<typeof createManagedSession>

describe('session project-boundary guards (POO-205 C6)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let workspace: { id: string; name: string; rootPath: string; createdAt: number }

  const storeRootFor = (projectId?: string | null) =>
    projectId ? projectSessionStoreRoot(tmpRoot, projectId) : tmpRoot

  function seedManaged(input: {
    id: string
    projectId?: string
    projectContext?: { name: string; purpose?: string; instructions?: string }
    spaceId?: string
    sdkSessionId?: string
    messages?: unknown[]
  }): ManagedRecord {
    const spaceId = input.spaceId ?? enterpriseSpaceId
    const stored = {
      id: input.id,
      workspaceRootPath: storeRootFor(input.projectId),
      name: input.id,
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      productSpaceId: spaceId,
      accountId: accountA,
      projectId: input.projectId,
      projectContext: input.projectContext,
      sdkSessionId: input.sdkSessionId,
      messages: input.messages ?? [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as unknown as StoredSession
    // Production passes the PLAIN workspace object; the project store root
    // only lands in the persisted workspaceRootPath source field. Messages go
    // through OVERRIDES — the factory's runtime defaults reset sourceFields'
    // messages to [] (real sessions hydrate them later via ensureMessagesLoaded).
    const managed = createManagedSession(stored as never, workspace as never, {
      messagesLoaded: true,
      messages: (input.messages ?? []) as never,
    })
    ;(sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.set(input.id, managed)
    return managed
  }

  function writeSourceJsonl(input: {
    id: string
    projectId?: string
    messages: StoredMessage[]
    sdkSessionId?: string
    projectContext?: { name: string }
  }): void {
    const root = storeRootFor(input.projectId)
    const path = getSessionFilePath(root, input.id)
    mkdirSync(dirname(path), { recursive: true })
    writeSessionJsonl(path, {
      id: input.id,
      workspaceRootPath: root,
      name: input.id,
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      productSpaceId: enterpriseSpaceId,
      accountId: accountA,
      projectId: input.projectId,
      projectContext: input.projectContext,
      sdkSessionId: input.sdkSessionId,
      messages: input.messages,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as unknown as StoredSession)
  }

  function managedById(id: string): ManagedRecord {
    const managed = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get(id)
    if (!managed) throw new Error(`seed missing: ${id}`)
    return managed
  }

  type ToolCallbacks = Record<string, (...args: unknown[]) => unknown>

  function toolCallbacks(sourceId: string): ToolCallbacks {
    return (sm as unknown as {
      buildManagedSessionToolCallbacks(m: ManagedRecord): ToolCallbacks
    }).buildManagedSessionToolCallbacks(managedById(sourceId))
  }

  const outOfScope = (error: unknown): boolean =>
    error instanceof Error && error.message.includes('SESSION_OUT_OF_TRUSTED_SCOPE')

  // In-memory managed.messages hold RUNTIME-shaped messages (role); the JSONL
  // on disk holds STORED-shaped messages (type). Mixing them up makes
  // persistSession serialize empty history — branch validation then fails.
  function userMessage(id: string, content: string): StoredMessage {
    return { id, role: 'user', content, timestamp: Date.now() } as unknown as StoredMessage
  }

  function storedUserMessage(id: string, content: string): StoredMessage {
    return { id, type: 'user', content, timestamp: Date.now() } as StoredMessage
  }

  function makeBundle(id: string): unknown {
    return {
      version: 1,
      session: {
        header: { id, createdAt: Date.now(), name: `imported-${id}` },
        messages: [],
      },
      files: [],
    }
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-c6-'))
    resetProductSpaceExecutionRegistryForTests()
    resetProjectContextResolverForTests()
    setTrustedProductSpaceAccountProvider(async () => accountA)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    // POO-205 C7a: the createSession/branch/spawn/import success paths now
    // re-prove membership against polo-admin through the project-context
    // resolver. Seed its seams so those paths see a member roster instead of
    // an unreachable admin (which would fail creation closed).
    setProjectContextResolverSpaceReaderForTests(
      (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId
        ? { kind: 'enterprise', enterpriseId: 'ent-c6' }
        : null,
    )
    setProjectContextResolverAdminForTests({
      listProjects: async (organizationEnterpriseId: string) => ({
        contractVersion: 'poo205-contract-r1' as never,
        organizationEnterpriseId,
        projects: [
          {
            id: 'proj-a',
            organizationEnterpriseId: 'ent-c6',
            organizationProductSpaceId: enterpriseSpaceId,
            name: 'Project A',
            purpose: 'ops',
            createdByAccountId: 'owner-1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            myRole: 'member',
            memberCount: 2,
          },
          {
            id: 'proj-b',
            organizationEnterpriseId: 'ent-c6',
            organizationProductSpaceId: enterpriseSpaceId,
            name: 'Project B',
            createdByAccountId: 'owner-1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            myRole: 'member',
            memberCount: 2,
          },
          {
            id: 'proj-imp',
            organizationEnterpriseId: 'ent-c6',
            organizationProductSpaceId: enterpriseSpaceId,
            name: 'Project Imp',
            createdByAccountId: 'owner-1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            myRole: 'member',
            memberCount: 2,
          },
        ],
      }),
    } as never)
    workspace = { id: workspaceId, name: 'C6 Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    sm = new SessionManager({ workspace: workspace as never })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    resetProjectContextResolverForTests()
    setRuntimeActiveProductSpace(null)
    setSyncTrustedProductSpaceAccountId(null)
  })

  // -------------------------------------------------------------------------
  // Agent session tools (P2-3)
  // -------------------------------------------------------------------------

  describe('agent tools inside one enterprise project', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      seedManaged({ id: 'a1', projectId: 'proj-a' })
      seedManaged({ id: 'a2', projectId: 'proj-a' })
      seedManaged({ id: 'b1', projectId: 'proj-b' })
      seedManaged({ id: 'u1' })
    })

    it('lists ONLY the source project sessions — other projects and unbound sessions do not exist', () => {
      const listing = toolCallbacks('a1').listSessionsFn({}) as { total: number; sessions: Array<{ id: string }> }
      const ids = listing.sessions.map(s => s.id)
      expect(ids).toContain('a1')
      expect(ids).toContain('a2')
      expect(ids).not.toContain('b1')
      expect(ids).not.toContain('u1')
      expect(listing.total).toBe(2)
    })

    it('read (get_session_info) answers not-found for another project and for a real unbound session alike', () => {
      const info = toolCallbacks('a1').getSessionInfoFn
      expect(info('b1')).toBeNull()
      // Same not-found shape as a truly absent id — no existence disclosure.
      expect(info('no-such-session')).toBeNull()
      // Same project reads fine.
      expect((info('a2') as { id: string }).id).toBe('a2')
    })

    it('send / status / labels refuse another project exactly like a missing session', async () => {
      const callbacks = toolCallbacks('a1')
      const crossProject = callbacks.sendAgentMessageFn('b1', 'hi') as Promise<unknown>
      const missing = callbacks.sendAgentMessageFn('no-such-session', 'hi') as Promise<unknown>
      expect(outOfScope(await crossProject.catch((e: unknown) => e))).toBe(true)
      expect(outOfScope(await missing.catch((e: unknown) => e))).toBe(true)
      expect(outOfScope(await (callbacks.setSessionStatusFn('b1', 'done') as Promise<unknown>).catch((e: unknown) => e))).toBe(true)
      await expect(callbacks.setSessionLabelsFn('b1', [])).rejects.toThrow('SESSION_OUT_OF_TRUSTED_SCOPE')
      // Same project targets pass the gate (labels resolve without an agent).
      await expect(callbacks.setSessionLabelsFn('a2', ['ops'])).resolves.toBeUndefined()
      expect(managedById('a2').labels).toEqual(['ops'])
    })

    it('task subscription answers the not-found shape for another project', async () => {
      const result = await toolCallbacks('a1').subscribeTaskFn({ targetSessionId: 'b1', events: ['completed'] }) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('an unbound (personal-style) source session cannot see project-bound targets', () => {
      const info = toolCallbacks('u1').getSessionInfoFn
      expect(info('a1')).toBeNull()
      expect(info('b1')).toBeNull()
      // But its own projectless peers stay visible.
      expect((info('u1') as { id: string }).id).toBe('u1')
      const listing = toolCallbacks('u1').listSessionsFn({}) as { sessions: Array<{ id: string }> }
      expect(listing.sessions.map(s => s.id)).toEqual(['u1'])
    })
  })

  describe('agent tools in the personal space (negative control)', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      seedManaged({ id: 'p1', spaceId: personalSpaceId })
      seedManaged({ id: 'p2', spaceId: personalSpaceId })
    })

    it('projectless personal sessions keep working — list, read, labels', async () => {
      const callbacks = toolCallbacks('p1')
      const listing = callbacks.listSessionsFn({}) as { total: number; sessions: Array<{ id: string }> }
      expect(listing.total).toBe(2)
      expect((callbacks.getSessionInfoFn('p2') as { id: string }).id).toBe('p2')
      await expect(callbacks.setSessionLabelsFn('p2', ['x'])).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Branch (P2-4) + spawn_session
  // -------------------------------------------------------------------------

  describe('branch project binding', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      // A mock agent: the real backend preflight needs provider credentials
      // this harness must not depend on.
      ;(sm as unknown as { getOrCreateAgent: (m: ManagedRecord) => Promise<unknown> }).getOrCreateAgent = async (m) => {
        ;(m as unknown as { agent: unknown }).agent = { ensureBranchReady: async () => {}, supportsBranching: true }
        return (m as unknown as { agent: unknown }).agent
      }
      writeSourceJsonl({
        id: 'src-a',
        projectId: 'proj-a',
        projectContext: { name: 'Project A' },
        sdkSessionId: 'sdk-src-a',
        messages: [storedUserMessage('m1', 'root turn'), storedUserMessage('m2', 'second turn')],
      })
      seedManaged({
        id: 'src-a',
        projectId: 'proj-a',
        projectContext: { name: 'Project A' },
        sdkSessionId: 'sdk-src-a',
        messages: [userMessage('m1', 'root turn'), userMessage('m2', 'second turn')],
      })
    })

    it('an explicitly different projectId is refused with the coded BRANCH_PROJECT_MISMATCH', async () => {
      let caught: unknown = null
      await sm.createSession(workspaceId, {
        name: 'cross',
        branchFromSessionId: 'src-a',
        branchFromMessageId: 'm2',
        projectId: 'proj-b',
      }).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('BRANCH_PROJECT_MISMATCH')
      expect(isErrorCode((caught as { code?: string }).code)).toBe(true)
      expect((caught as Error).message).toBe(SESSION_PROJECT_ERROR_MESSAGES.BRANCH_PROJECT_MISMATCH)
    })

    it('no projectId inherits the source session project and lands in its project store', async () => {
      const session = await sm.createSession(workspaceId, {
        name: 'inherit',
        branchFromSessionId: 'src-a',
        branchFromMessageId: 'm2',
      })
      const managed = managedById(session.id)
      expect(managed.projectId).toBe('proj-a')
      expect(managed.projectContext?.name).toBe('Project A')
      // workspaceRootPath rides the record via sourceFields spread (undeclared
      // on the ManagedSession type).
      expect((managed as unknown as { workspaceRootPath?: string }).workspaceRootPath).toBe(storeRootFor('proj-a'))
      expect(existsSync(getSessionFilePath(storeRootFor('proj-a'), session.id))).toBe(true)
      expect(existsSync(getSessionFilePath(tmpRoot, session.id))).toBe(false)
    })

    it('the source session own projectId passes', async () => {
      const session = await sm.createSession(workspaceId, {
        name: 'same-project',
        branchFromSessionId: 'src-a',
        branchFromMessageId: 'm2',
        projectId: 'proj-a',
      })
      expect(managedById(session.id).projectId).toBe('proj-a')
    })
  })

  describe('spawn_session project inheritance', () => {
    it('a spawned child inherits the parent project binding/context and lands in the project store', async () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      seedManaged({
        id: 'parent',
        projectId: 'proj-a',
        projectContext: { name: 'Project A', purpose: 'ops' },
      })
      ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<unknown> }).sendMessage = async () => {}
      const spawn = (sm as unknown as {
        spawnSessionFromManagedAgent(m: ManagedRecord, request: { name?: string; prompt?: string }): Promise<{ sessionId: string }>
      }).spawnSessionFromManagedAgent
      const result = await spawn.call(sm, managedById('parent'), { name: 'child', prompt: 'go' })
      const child = managedById(result.sessionId)
      expect(child.projectId).toBe('proj-a')
      expect(child.projectContext?.name).toBe('Project A')
      expect(child.projectContext?.purpose).toBe('ops')
      expect(existsSync(getSessionFilePath(storeRootFor('proj-a'), result.sessionId))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // importSession (P2-5)
  // -------------------------------------------------------------------------

  describe('importSession project binding', () => {
    it('an enterprise import without a project is refused with the coded reason', async () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      let caught: unknown = null
      await sm.importSession(workspaceId, makeBundle('imp-1') as never, 'fork').catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('PROJECT_CONTEXT_REQUIRED')
      expect((caught as Error).message).toBe(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED)
    })

    it('an enterprise import with a project lands in the project store with the binding persisted', async () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      const { sessionId } = await sm.importSession(workspaceId, makeBundle('imp-2') as never, 'fork', { projectId: 'proj-imp' })
      const managed = managedById(sessionId)
      expect(managed.projectId).toBe('proj-imp')
      expect((managed as unknown as { workspaceRootPath?: string }).workspaceRootPath).toBe(storeRootFor('proj-imp'))
      expect(existsSync(getSessionFilePath(storeRootFor('proj-imp'), sessionId))).toBe(true)
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
    })

    it('a personal import without a project keeps the legacy workspace-root behavior', async () => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      const { sessionId } = await sm.importSession(workspaceId, makeBundle('imp-3') as never, 'fork')
      const managed = managedById(sessionId)
      expect(managed.projectId).toBeUndefined()
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(true)
    })

    it('a personal import carrying a project binding is refused', async () => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      let caught: unknown = null
      await sm.importSession(workspaceId, makeBundle('imp-4') as never, 'fork', { projectId: 'proj-x' }).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE')
    })
  })

  // -------------------------------------------------------------------------
  // Background entry points (P2-6): automation + remote transfer
  // -------------------------------------------------------------------------

  describe('automation entry point', () => {
    it('an enterprise automation creates NO session and records the coded reason', async () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      const before = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.size
      let caught: unknown = null
      await sm.executePromptAutomation({
        workspaceId,
        workspaceRootPath: tmpRoot,
        prompt: 'run the nightly digest',
        automationName: 'nightly',
      } as never).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('PROJECT_CONTEXT_REQUIRED')
      expect((caught as Error).message).toBe(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED)
      expect((sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.size).toBe(before)

      // The scheduler's allSettled wrapper turns the rejection into a run
      // record whose error field carries the reason.
      const { createPromptHistoryEntry, appendAutomationHistoryEntry } = await import('@polo-ai/shared/automations')
      const entry = createPromptHistoryEntry({
        matcherId: 'matcher-1',
        ok: false,
        prompt: 'run the nightly digest',
        error: String(caught),
      })
      await appendAutomationHistoryEntry(tmpRoot, entry)
      const historyPath = join(tmpRoot, 'automations-history.jsonl')
      const written = existsSync(historyPath) ? readFileSync(historyPath, 'utf-8') : ''
      expect(written).toContain('企业空间里的会话需要在项目中创建')
    })

    it('a personal automation still creates a projectless session', async () => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      ;(sm as unknown as { sendMessage: (...args: unknown[]) => Promise<unknown> }).sendMessage = async () => {}
      const { sessionId } = await sm.executePromptAutomation({
        workspaceId,
        workspaceRootPath: tmpRoot,
        prompt: 'run the nightly digest',
        automationName: 'nightly',
      } as never)
      expect(managedById(sessionId).projectId).toBeUndefined()
    })
  })

  describe('remote session transfer import', () => {
    it('an enterprise transfer-in is refused with the coded reason and creates no session', async () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      const before = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.size
      let caught: unknown = null
      await sm.importRemoteSessionTransfer(workspaceId, { name: 'transferred', summary: 'a summary' } as never).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('PROJECT_CONTEXT_REQUIRED')
      expect((sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.size).toBe(before)
    })

    it('a personal transfer-in keeps working without a project binding', async () => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      const { sessionId } = await sm.importRemoteSessionTransfer(workspaceId, { name: 'transferred', summary: 'a summary' } as never)
      expect(managedById(sessionId).projectId).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // The shared gate itself
  // -------------------------------------------------------------------------

  describe('assertSessionProjectBinding (the shared creation/import gate)', () => {
    it('enterprise requires a project; personal rejects one; no committed space is inert', () => {
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: true, activeSpaceKind: 'enterprise', projectId: null }))
        .toThrow(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED)
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: true, activeSpaceKind: 'enterprise', projectId: 'p' })).not.toThrow()
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: true, activeSpaceKind: 'personal', projectId: 'p' }))
        .toThrow(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE)
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: true, activeSpaceKind: 'personal', projectId: null })).not.toThrow()
      // Headless/legacy workspaces without a committed space never throw.
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: false, activeSpaceKind: null, projectId: null })).not.toThrow()
      expect(() => assertSessionProjectBinding({ hasCommittedProductSpace: false, activeSpaceKind: null, projectId: 'p' })).not.toThrow()
    })
  })
})
