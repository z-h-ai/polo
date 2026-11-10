import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { StoredMessage, StoredSession } from '@polo-ai/shared/sessions'
import {
  getSessionFilePath,
  projectSessionStoreRoot,
} from '@polo-ai/shared/sessions'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import {
  resetProjectContextResolverForTests,
  setProjectContextResolverAdminForTests,
  setProjectContextResolverSpaceReaderForTests,
  type ProjectMembersAdmin,
} from '../project-members/project-context-resolver'
import {
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account'

// POO-205 C7a: the session layer re-proves project membership against
// polo-admin at the two boundaries that matter —
//
//   CREATE (and branch/import): the renderer-supplied `projectContext` is
//   presentation state. member → the ADMIN-proven snapshot is what gets
//   persisted (forged fields are ignored); not_member → coded prj_not_found
//   and NO session file; unavailable → coded PROJECT_CONTEXT_UNAVAILABLE and
//   NO session file (creation stays fail-closed).
//
//   SEND: member → a changed snapshot is written back to the managed session,
//   persisted in the header and pushed to the LIVE agent
//   (updateProjectContext) so instruction edits take effect on THIS turn;
//   not_member → prj_not_found and nothing is appended or written;
//   unavailable → the persisted snapshot keeps the turn alive (fail-open).

const accountA = 'acc-ctx-a'
const enterpriseSpaceId = 'space-ent-ctx'
const enterpriseId = 'ent-ctx-1'
const personalSpaceId = 'space-personal-ctx'
const workspaceId = 'ws_c7a'

function project(id: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    organizationEnterpriseId: enterpriseId,
    organizationProductSpaceId: enterpriseSpaceId,
    name: `Project ${id}`,
    createdByAccountId: 'owner-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    myRole: 'member',
    memberCount: 2,
    ...overrides,
  } as ProjectSummary
}

function rosterAdmin(roster: ProjectSummary[], calls?: { count: number }): ProjectMembersAdmin {
  return {
    listProjects: async () => {
      if (calls) calls.count++
      return { contractVersion: 'poo205-contract-r1' as never, organizationEnterpriseId: enterpriseId, projects: roster }
    },
  } as unknown as ProjectMembersAdmin
}

type ManagedRecord = ReturnType<typeof createManagedSession>

describe('session project-context membership re-proof (POO-205 C7a)', () => {
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
    messages?: unknown[]
    agent?: unknown
  }): ManagedRecord {
    const stored = {
      id: input.id,
      workspaceRootPath: storeRootFor(input.projectId),
      name: input.id,
      sessionStatus: 'todo',
      labels: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      productSpaceId: input.spaceId ?? enterpriseSpaceId,
      accountId: accountA,
      projectId: input.projectId,
      projectContext: input.projectContext,
      sdkSessionId: undefined,
      messages: input.messages ?? [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
    } as unknown as StoredSession
    const managed = createManagedSession(stored as never, workspace as never, {
      messagesLoaded: true,
      messages: (input.messages ?? []) as never,
    })
    if (input.agent) {
      ;(managed as unknown as { agent: unknown }).agent = input.agent
    }
    ;(sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.set(input.id, managed)
    return managed
  }

  /** Reads the PERSISTED header (first JSONL line) for projectContext. */
  function persistedHeader(input: { projectId?: string | null; id: string }): StoredSession | null {
    const path = getSessionFilePath(storeRootFor(input.projectId), input.id)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8').split('\n')[0]!) as StoredSession
  }

  function jsonlBodyLineCount(input: { projectId?: string | null; id: string }): number {
    const path = getSessionFilePath(storeRootFor(input.projectId), input.id)
    if (!existsSync(path)) return 0
    return readFileSync(path, 'utf-8').trim().split('\n').length - 1
  }

  function flush(smInstance: SessionManager, sessionId: string): Promise<void> {
    return (smInstance as unknown as { flushSession(id: string): Promise<void> }).flushSession(sessionId)
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-c7a-'))
    resetProductSpaceExecutionRegistryForTests()
    resetProjectContextResolverForTests()
    setTrustedProductSpaceAccountProvider(async () => accountA)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    workspace = { id: workspaceId, name: 'C7a Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    sm = new SessionManager({ workspace: workspace as never })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    resetProjectContextResolverForTests()
    setRuntimeActiveProductSpace(null)
    setSyncTrustedProductSpaceAccountId(null)
    resetProductSpaceExecutionRegistryForTests()
  })

  // -------------------------------------------------------------------------
  // CREATE (P3-1a)
  // -------------------------------------------------------------------------

  describe('createSession in an enterprise space', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
    })

    it('member → the ADMIN-proven snapshot is persisted; renderer-forged fields are ignored', async () => {
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
      setProjectContextResolverAdminForTests(rosterAdmin([
        project('proj-real', { name: 'Real Project', purpose: 'Real purpose', instructions: 'Real instructions.' }),
      ]))
      const session = await sm.createSession(workspaceId, {
        name: 'forged',
        projectId: 'proj-real',
        // The renderer ships a plausible-looking snapshot — none of it may
        // survive: the server's own read is the authority.
        projectContext: { name: 'Forged Project', instructions: 'Forged instructions.' } as never,
      })
      const managed = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get(session.id)!
      expect(managed.projectContext).toEqual({
        name: 'Real Project',
        purpose: 'Real purpose',
        instructions: 'Real instructions.',
      })
      await flush(sm, session.id)
      expect(persistedHeader({ projectId: 'proj-real', id: session.id })?.projectContext).toEqual({
        name: 'Real Project',
        purpose: 'Real purpose',
        instructions: 'Real instructions.',
      })
    })

    it('not_member → coded prj_not_found and NO session file anywhere', async () => {
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
      setProjectContextResolverAdminForTests(rosterAdmin([project('proj-other')]))
      let caught: unknown = null
      await sm.createSession(workspaceId, {
        name: 'removed',
        projectId: 'proj-kicked',
        projectContext: { name: 'Kicked Project' } as never,
      }).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('prj_not_found')
      expect((caught as Error).message).toContain('你已不在这个项目中')
      expect((sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.has('removed')).toBe(false)
      // No reservation → no file in either store.
      expect(existsSync(getSessionFilePath(storeRootFor('proj-kicked'), 'removed'))).toBe(false)
    })

    it('unavailable → coded PROJECT_CONTEXT_UNAVAILABLE and NO session file', async () => {
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
      setProjectContextResolverAdminForTests({
        listProjects: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443') },
      } as unknown as ProjectMembersAdmin)
      let caught: unknown = null
      await sm.createSession(workspaceId, {
        name: 'offline',
        projectId: 'proj-offline',
        projectContext: { name: 'Offline Project' } as never,
      }).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('PROJECT_CONTEXT_UNAVAILABLE')
      expect(existsSync(getSessionFilePath(storeRootFor('proj-offline'), 'offline'))).toBe(false)
    })

    it('personal space → the resolver is NEVER consulted (negative control)', async () => {
      const calls = { count: 0 }
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => {
          calls.count++
          return id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null
        },
      )
      setProjectContextResolverAdminForTests(rosterAdmin([], calls))
      const session = await sm.createSession(workspaceId, { name: 'personal-ok' })
      const managed = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get(session.id)!
      expect(managed.projectId).toBeUndefined()
      expect(calls.count).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // importSession (same gate, P2-5 extension)
  // -------------------------------------------------------------------------

  describe('importSession in an enterprise space', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
    })

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

    it('member → the imported record carries the admin-proven snapshot', async () => {
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
      setProjectContextResolverAdminForTests(rosterAdmin([
        project('proj-imp', { name: 'Imported Real', instructions: 'Imported instructions.' }),
      ]))
      const { sessionId } = await sm.importSession(workspaceId, makeBundle('imp-ctx') as never, 'fork', { projectId: 'proj-imp' })
      const managed = (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get(sessionId)!
      expect(managed.projectContext).toEqual({ name: 'Imported Real', instructions: 'Imported instructions.' })
    })

    it('not_member → the import is refused with prj_not_found', async () => {
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
      setProjectContextResolverAdminForTests(rosterAdmin([]))
      let caught: unknown = null
      await sm.importSession(workspaceId, makeBundle('imp-kicked') as never, 'fork', { projectId: 'proj-gone' }).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('prj_not_found')
    })
  })

  // -------------------------------------------------------------------------
  // SEND (P3-3): instructions ride the NEXT turn, removals refuse, outages
  // degrade to the snapshot
  // -------------------------------------------------------------------------

  describe('sendMessage on a project-bound session', () => {
    let capturedContexts: Array<{ name: string; purpose?: string; instructions?: string } | undefined>
    let acked: string | null

    function captureAgent() {
      capturedContexts = []
      acked = null
      return {
        updateProjectContext: (ctx: { name: string } | undefined) => { capturedContexts.push(ctx) },
        redirect: () => false,
        isProcessing: () => false,
      }
    }

    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      setProjectContextResolverSpaceReaderForTests(
        (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
      )
    })

    it('v1 → admin edits instructions → the LIVE agent gets v2 and the header persists v2', async () => {
      const agent = captureAgent()
      seedManaged({
        id: 'send-v1v2',
        projectId: 'proj-live',
        projectContext: { name: 'Live Project', instructions: 'v1 instructions.' },
        agent,
      })
      setProjectContextResolverAdminForTests(rosterAdmin([
        project('proj-live', { name: 'Live Project Renamed', instructions: 'v2 instructions.' }),
      ]))

      await sm.sendMessage('send-v1v2', 'hello', undefined, undefined, undefined, undefined, undefined, (messageId) => {
        acked = messageId
      }).catch(() => { /* post-ack agent-init may fail in this minimal harness */ })

      expect(acked).not.toBeNull()
      expect(capturedContexts).toEqual([{ name: 'Live Project Renamed', instructions: 'v2 instructions.' }])
      expect((sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get('send-v1v2')!.projectContext).toEqual({
        name: 'Live Project Renamed',
        instructions: 'v2 instructions.',
      })
      await flush(sm, 'send-v1v2')
      expect(persistedHeader({ projectId: 'proj-live', id: 'send-v1v2' })?.projectContext).toEqual({
        name: 'Live Project Renamed',
        instructions: 'v2 instructions.',
      })
    })

    it('member with an UNCHANGED snapshot does not push the agent or re-persist', async () => {
      const agent = captureAgent()
      seedManaged({
        id: 'send-same',
        projectId: 'proj-same',
        projectContext: { name: 'Same Project', instructions: 'stable.' },
        agent,
      })
      setProjectContextResolverAdminForTests(rosterAdmin([
        project('proj-same', { name: 'Same Project', instructions: 'stable.' }),
      ]))
      await sm.sendMessage('send-same', 'hello', undefined, undefined, undefined, undefined, undefined, (messageId) => {
        acked = messageId
      }).catch(() => { /* post-ack harness failure expected */ })
      expect(acked).not.toBeNull()
      expect(capturedContexts).toEqual([])
    })

    it('not_member → prj_not_found, NOTHING appended, NOTHING written', async () => {
      const agent = captureAgent()
      seedManaged({
        id: 'send-kicked',
        projectId: 'proj-kicked-send',
        projectContext: { name: 'Kicked Send', instructions: 'old.' },
        messages: [{ id: 'm0', type: 'user', content: 'earlier', timestamp: Date.now() }],
        agent,
      })
      setProjectContextResolverAdminForTests(rosterAdmin([project('proj-other-send')]))
      const before = jsonlBodyLineCount({ projectId: 'proj-kicked-send', id: 'send-kicked' })
      await expect(sm.sendMessage(
        'send-kicked', 'hello', undefined, undefined, undefined, undefined, undefined, () => { acked = 'SHOULD-NOT-ACK' },
      )).rejects.toThrow('你已不在这个项目中')
      let code: unknown = null
      await sm.sendMessage('send-kicked', 'hello').catch(error => { code = (error as { code?: unknown }).code })
      expect(code).toBe('prj_not_found')
      expect(acked).toBeNull()
      expect(jsonlBodyLineCount({ projectId: 'proj-kicked-send', id: 'send-kicked' })).toBe(before)
      expect(capturedContexts).toEqual([])
    })

    it('unavailable → the persisted snapshot keeps the turn alive (fail-open SEND)', async () => {
      const agent = captureAgent()
      seedManaged({
        id: 'send-offline',
        projectId: 'proj-offline-send',
        projectContext: { name: 'Offline Send', instructions: 'snapshot stands in.' },
        agent,
      })
      setProjectContextResolverAdminForTests({
        listProjects: async () => { throw new Error('connect ETIMEDOUT') },
      } as unknown as ProjectMembersAdmin)
      await sm.sendMessage('send-offline', 'still works', undefined, undefined, undefined, undefined, undefined, (messageId) => {
        acked = messageId
      }).catch(() => { /* post-ack harness failure expected */ })
      expect(acked).not.toBeNull()
      // Snapshot semantics: no push, no rewrite.
      expect(capturedContexts).toEqual([])
      expect((sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions.get('send-offline')!.projectContext).toEqual({
        name: 'Offline Send',
        instructions: 'snapshot stands in.',
      })
    })
  })
})
