import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import type { StoredSession } from '@polo-ai/shared/sessions'
import { getSessionFilePath, projectSessionStoreRoot } from '@polo-ai/shared/sessions'
import {
  createManagedSession,
  isEnterpriseSessionRecord,
  SessionManager,
  setEnterpriseSessionSpaceKindReaderForTests,
} from './SessionManager.ts'
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

// POO-205 C7b (P1-5): an ENTERPRISE session never reads personal scope.
//
//   CREATE — the workspace-default working directory, any caller-supplied
//   working directory and the workspace-default data sources are all
//   ignored: the session record stores neither.
//
//   LOAD — a pre-C7b header that still carries a personal working directory
//   or enabled sources is treated as EMPTY in memory (the file itself is
//   never rewritten by the load; the next natural persist writes it clean).
//
//   RPC — updateWorkingDirectory and setSessionSources refuse with the coded
//   ENTERPRISE_PERSONAL_CONTEXT_BLOCKED.
//
// Personal sessions keep every behavior: options win, workspace defaults
// apply, both RPCs work.

const accountA = 'acc-c7b-sm'
const enterpriseSpaceId = 'space-ent-c7b-sm'
const personalSpaceId = 'space-personal-c7b-sm'
const enterpriseId = 'ent-c7b-sm'
const workspaceId = 'ws_c7b'
const personalDir = '/home/someone/personal-project'

function project(id: string): ProjectSummary {
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
  } as ProjectSummary
}

function rosterAdmin(roster: ProjectSummary[]): ProjectMembersAdmin {
  return {
    listProjects: async () => ({
      contractVersion: 'poo205-contract-r1' as never,
      organizationEnterpriseId: enterpriseId,
      projects: roster,
    }),
  } as unknown as ProjectMembersAdmin
}

function seedEnterpriseRoster(): void {
  setProjectContextResolverSpaceReaderForTests(
    (id, spaceId) => id === accountA && spaceId === enterpriseSpaceId ? { kind: 'enterprise', enterpriseId } : null,
  )
  setProjectContextResolverAdminForTests(rosterAdmin([project('proj-c7b')]))
}

type ManagedRecord = ReturnType<typeof createManagedSession>
const sessionsOf = (sm: SessionManager) =>
  (sm as unknown as { sessions: Map<string, ManagedRecord> }).sessions

describe('enterprise sessions never read personal scope (POO-205 C7b)', () => {
  let tmpRoot: string
  let sm: SessionManager
  let workspace: { id: string; name: string; rootPath: string; createdAt: number }

  const storeRootFor = (projectId?: string | null) =>
    projectId ? projectSessionStoreRoot(tmpRoot, projectId) : tmpRoot

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-c7b-'))
    resetProductSpaceExecutionRegistryForTests()
    resetProjectContextResolverForTests()
    setTrustedProductSpaceAccountProvider(async () => accountA)
    setSyncTrustedProductSpaceAccountId(accountA)
    setRuntimeActiveProductSpaceAccount(accountA)
    setEnterpriseSessionSpaceKindReaderForTests((id, spaceId) => {
      if (id !== accountA) return null
      if (spaceId === enterpriseSpaceId) return 'enterprise'
      if (spaceId === personalSpaceId) return 'personal'
      return null
    })
    workspace = { id: workspaceId, name: 'C7b Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    sm = new SessionManager({ workspace: workspace as never })
    ;(sm as unknown as { initGate: { markReady(): void } }).initGate.markReady()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
    resetProjectContextResolverForTests()
    setEnterpriseSessionSpaceKindReaderForTests(null)
    setRuntimeActiveProductSpace(null)
    setSyncTrustedProductSpaceAccountId(null)
    resetProductSpaceExecutionRegistryForTests()
  })

  // -------------------------------------------------------------------------
  // The predicate itself
  // -------------------------------------------------------------------------

  describe('isEnterpriseSessionRecord', () => {
    it('a project binding alone decides', () => {
      expect(isEnterpriseSessionRecord({ projectId: 'proj-x' })).toBe(true)
    })

    it('an enterprise committed space decides', () => {
      expect(isEnterpriseSessionRecord({ productSpaceId: enterpriseSpaceId, accountId: accountA })).toBe(true)
    })

    it('a personal committed space does NOT', () => {
      expect(isEnterpriseSessionRecord({ productSpaceId: personalSpaceId, accountId: accountA })).toBe(false)
    })

    it('no bindings do NOT (plain personal session)', () => {
      expect(isEnterpriseSessionRecord({})).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  describe('createSession strips personal scope from enterprise sessions', () => {
    beforeEach(() => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      seedEnterpriseRoster()
      writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
        defaults: {
          workingDirectory: personalDir,
          enabledSourceSlugs: ['ws-default-source'],
        },
      }))
    })

    it('caller workingDirectory AND workspace defaults are both ignored', async () => {
      const session = await sm.createSession(workspaceId, {
        name: 'ent-strip',
        projectId: 'proj-c7b',
        projectContext: { name: 'Project proj-c7b' } as never,
        workingDirectory: personalDir,
        enabledSourceSlugs: ['caller-source'],
      } as never)
      const managed = sessionsOf(sm).get(session.id)!
      expect(managed.workingDirectory).toBeUndefined()
      expect(managed.enabledSourceSlugs).toBeUndefined()
    })

    it('a personal session keeps BOTH (negative control)', async () => {
      setRuntimeActiveProductSpace(personalSpaceId, 'personal')
      const session = await sm.createSession(workspaceId, {
        name: 'personal-keep',
        workingDirectory: personalDir,
        enabledSourceSlugs: ['caller-source'],
      } as never)
      const managed = sessionsOf(sm).get(session.id)!
      expect(managed.workingDirectory).toBe(personalDir)
      expect(managed.enabledSourceSlugs).toEqual(['caller-source'])
    })
  })

  // -------------------------------------------------------------------------
  // LOAD (startup restore)
  // -------------------------------------------------------------------------

  describe('loadSessionsFromDisk treats pre-C7b personal scope as absent', () => {
    function writeHeader(input: { id: string; projectId?: string; workingDirectory?: string }): void {
      const root = storeRootFor(input.projectId)
      const path = getSessionFilePath(root, input.id)
      mkdirSync(dirname(path), { recursive: true })
      const header = {
        id: input.id,
        workspaceRootPath: root,
        name: input.id,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        messageCount: 0,
        productSpaceId: enterpriseSpaceId,
        accountId: accountA,
        projectId: input.projectId,
        workingDirectory: input.workingDirectory,
        enabledSourceSlugs: ['stale-personal-source'],
      }
      writeFileSync(path, `${JSON.stringify({ type: 'header', ...header })}\n`)
    }

    it('an enterprise session restores with NO working directory (file untouched)', () => {
      setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
      writeHeader({ id: 'ent-stale', projectId: 'proj-c7b', workingDirectory: personalDir })
      const before = readFileSync(getSessionFilePath(storeRootFor('proj-c7b'), 'ent-stale'), 'utf-8')
      ;(sm as unknown as { loadSessionsFromDisk(): void }).loadSessionsFromDisk()
      const managed = sessionsOf(sm).get('ent-stale')!
      expect(managed).toBeDefined()
      expect(managed.workingDirectory).toBeUndefined()
      // The load itself never rewrites history — the on-disk header keeps its
      // bytes until the session's next natural persist.
      const after = readFileSync(getSessionFilePath(storeRootFor('proj-c7b'), 'ent-stale'), 'utf-8')
      expect(after).toBe(before)
      expect(after).toContain(personalDir)
    })

    it('a personal session still restores the workspace-default working directory', () => {
      writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
        defaults: { workingDirectory: personalDir },
      }))
      const header = {
        id: 'personal-restore',
        workspaceRootPath: tmpRoot,
        name: 'personal-restore',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        messageCount: 0,
      }
      const personalPath = getSessionFilePath(tmpRoot, 'personal-restore')
      mkdirSync(dirname(personalPath), { recursive: true })
      writeFileSync(personalPath, `${JSON.stringify({ type: 'header', ...header })}\n`)
      ;(sm as unknown as { loadSessionsFromDisk(): void }).loadSessionsFromDisk()
      const managed = sessionsOf(sm).get('personal-restore')!
      expect(managed).toBeDefined()
      expect(managed.workingDirectory).toBe(personalDir)
    })
  })

  // -------------------------------------------------------------------------
  // RPC refusal
  // -------------------------------------------------------------------------

  describe('personal-context RPCs refuse on enterprise sessions', () => {
    function seedManaged(input: { id: string; projectId?: string }): ManagedRecord {
      const stored = {
        id: input.id,
        workspaceRootPath: storeRootFor(input.projectId),
        name: input.id,
        sessionStatus: 'todo',
        labels: [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        productSpaceId: enterpriseSpaceId,
        accountId: accountA,
        projectId: input.projectId,
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
      } as unknown as StoredSession
      const managed = createManagedSession(stored as never, workspace as never, { messagesLoaded: true })
      sessionsOf(sm).set(input.id, managed)
      return managed
    }

    it('updateWorkingDirectory → coded ENTERPRISE_PERSONAL_CONTEXT_BLOCKED', () => {
      seedManaged({ id: 'rpc-wd', projectId: 'proj-c7b' })
      let caught: unknown = null
      try {
        sm.updateWorkingDirectory('rpc-wd', personalDir)
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string }).code).toBe('ENTERPRISE_PERSONAL_CONTEXT_BLOCKED')
      expect((caught as Error).message).toContain('企业空间的会话不能使用个人工作目录或数据源')
      expect(sessionsOf(sm).get('rpc-wd')!.workingDirectory).toBeUndefined()
    })

    it('setSessionSources → coded ENTERPRISE_PERSONAL_CONTEXT_BLOCKED', async () => {
      seedManaged({ id: 'rpc-src', projectId: 'proj-c7b' })
      let caught: unknown = null
      await sm.setSessionSources('rpc-src', ['some-source']).catch(error => { caught = error })
      expect((caught as { code?: string }).code).toBe('ENTERPRISE_PERSONAL_CONTEXT_BLOCKED')
      expect(sessionsOf(sm).get('rpc-src')!.enabledSourceSlugs).toBeUndefined()
    })

    it('updateWorkingDirectory still works on a personal session (negative control)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sm-c7b-personal-wd-'))
      try {
        const stored = {
          id: 'rpc-wd-personal',
          workspaceRootPath: tmpRoot,
          name: 'rpc-wd-personal',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          messages: [],
        } as unknown as StoredSession
        const managed = createManagedSession(stored as never, workspace as never, { messagesLoaded: true })
        sessionsOf(sm).set('rpc-wd-personal', managed)
        sm.updateWorkingDirectory('rpc-wd-personal', dir)
        expect(sessionsOf(sm).get('rpc-wd-personal')!.workingDirectory).toBe(dir)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  // -------------------------------------------------------------------------
  // Source reload — an enterprise session never reads the personal list
  // -------------------------------------------------------------------------

  describe('reloadSessionSources skips enterprise sessions', () => {
    it('the live agent is never touched (setAllSources stays un-called)', async () => {
      const stored = {
        id: 'reload-ent',
        workspaceRootPath: tmpRoot,
        name: 'reload-ent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        productSpaceId: enterpriseSpaceId,
        accountId: accountA,
        projectId: 'proj-c7b',
        messages: [],
      } as unknown as StoredSession
      const managed = createManagedSession(stored as never, workspace as never, { messagesLoaded: true })
      const setAllSourcesCalls: unknown[][] = []
      ;(managed as unknown as { agent: unknown }).agent = {
        setAllSources: (...args: unknown[]) => { setAllSourcesCalls.push(args) },
      }
      sessionsOf(sm).set('reload-ent', managed)
      await (sm as unknown as {
        reloadSessionSources(managed: ManagedRecord): Promise<void>
      }).reloadSessionSources(managed)
      expect(setAllSourcesCalls.length).toBe(0)
    })
  })
})
