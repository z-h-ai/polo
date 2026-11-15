import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  resolveSessionProjectContext,
  buildProjectHeaderLines,
  setProjectContextActiveProductSpaceReaderForTests,
  resetProjectContextActiveProductSpaceReaderForTests,
  setProjectContextAdminForTests,
  resetProjectContextAdminForTests,
  setProjectContextSendResolveTimeoutForTests,
  resetProjectContextSendResolveTimeoutForTests,
} from '../service'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../../handlers/rpc/trusted-product-space-account'
import type { PcSummaryResponse } from '@polo-ai/shared/admin/project-context-contract'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { ProjectContextAdmin } from '../admin-client'
import type { HandlerDeps } from '../../handlers/handler-deps'
import type { ISessionManager } from '../../handlers/session-manager-interface'

/**
 * POO-215 Q7/U7 send-path tests: the bounded project header is a
 * FIRST-USER-MESSAGE injection (asset statistics + confirmed/pinned digest +
 * overview); later sends resolve @ references only. The service seams
 * (admin / active-space reader / send timeout) plus the runtime fence setters
 * stand in for the committed enterprise ProductSpace state, exactly like
 * tool-facade.test.ts.
 */

const ACCOUNT_ID = 'account-1'
const SPACE_ID = 'space-1'
const PROJECT_ID = 'project-1'
const WORKSPACE_ID = 'ws-1'
const SESSION_ID = 'session-1'

const ENTERPRISE_SPACE = {
  id: SPACE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-1',
  name: 'Test Project',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-1' },
} as unknown as TrustedProductSpaceSummary

const SUMMARY: PcSummaryResponse = {
  generatedAt: '2026-11-15T00:00:00.000Z',
  assetCount: 12,
  confirmedCount: 4,
  overview: '项目概况正文。',
  recent: [],
}

/** A minimal PcAssetDto projection — the header builder only reads
 * name/current.version off each row. */
function pinnedAsset(id: string, name: string, version: number) {
  return {
    id,
    name,
    current: { version, confirmedAt: null, confirmedByUserId: null },
  }
}

interface SessionState {
  id: string
  productSpaceId?: string
  projectId?: string
  workspaceId?: string
  messages: Array<{ role: string }>
  preview?: string
}

function makeDeps(session: SessionState): HandlerDeps<ISessionManager> {
  return {
    sessionManager: {
      getSessions: () => [session],
      getSession: async (sessionId: string) =>
        sessionId === session.id
          ? { ...session, messageCount: session.messages.length } as unknown as Awaited<ReturnType<ISessionManager['getSession']>>
          : null,
      getWorkspaces: () => [{ id: WORKSPACE_ID }],
    },
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  } as unknown as HandlerDeps<ISessionManager>
}

/** Commits the runtime fence + trusted mirror for SPACE_ID / ACCOUNT_ID. */
function commitProjectFence(): void {
  setRuntimeActiveProductSpace(SPACE_ID, 'enterprise')
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setProjectContextActiveProductSpaceReaderForTests((accountId, productSpaceId) => {
    if (accountId !== ACCOUNT_ID || productSpaceId !== SPACE_ID) return null
    return ENTERPRISE_SPACE
  })
}

interface AdminCallLog {
  summary: number
  listAssets: number
  getRead: number
}

/** Installs a controllable admin adapter and returns its call log. */
function installAdmin(options?: {
  pinned?: ReturnType<typeof pinnedAsset>[]
  nextCursor?: string
  hangSummary?: boolean
}): AdminCallLog {
  const calls: AdminCallLog = { summary: 0, listAssets: 0, getRead: 0 }
  setProjectContextAdminForTests({
    summary: async () => {
      calls.summary += 1
      if (options?.hangSummary) return new Promise<PcSummaryResponse>(() => {})
      return SUMMARY
    },
    listAssets: async (_spaceId: string, _projectId: string, query: { pinned?: string }) => {
      calls.listAssets += 1
      if (query.pinned !== 'true') throw new Error('unexpected non-pinned listAssets query')
      return {
        assets: options?.pinned ?? [],
        ...(options?.nextCursor ? { nextCursor: options.nextCursor } : {}),
        canManage: false,
      }
    },
    getRead: async () => {
      calls.getRead += 1
      return { content: '引用正文', version: 1 } as Awaited<ReturnType<ProjectContextAdmin['getRead']>>
    },
  } as unknown as ProjectContextAdmin)
  return calls
}

const FIRST_TURN_SESSION: SessionState = {
  id: SESSION_ID,
  productSpaceId: SPACE_ID,
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  messages: [],
}

const LATER_TURN_SESSION: SessionState = {
  ...FIRST_TURN_SESSION,
  messages: [{ role: 'user' }, { role: 'assistant' }],
}

const REFS = [{ assetId: 'asset-1', version: 2, name: 'spec.md' }]

beforeEach(() => {
  commitProjectFence()
})

afterEach(() => {
  resetProjectContextActiveProductSpaceReaderForTests()
  resetProjectContextAdminForTests()
  resetProjectContextSendResolveTimeoutForTests()
  setRuntimeActiveProductSpace(null)
  setSyncTrustedProductSpaceAccountId(null)
  setTrustedProductSpaceAccountProvider(async () => null)
})

describe('resolveSessionProjectContext — first-turn header convergence (POO-215 Q7)', () => {
  it('injects the upgraded header on the session FIRST user message (summary + pinned digest)', async () => {
    const calls = installAdmin({
      pinned: [pinnedAsset('p1', '决策记录.md', 3), pinnedAsset('p2', 'SOP.md', 1)],
    })
    const resolved = await resolveSessionProjectContext(makeDeps(FIRST_TURN_SESSION), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeDefined()
    expect(resolved?.modelContext).toBeDefined()
    expect(resolved?.modelContext?.block).toContain('项目共享文件区：12 个文件，4 个已确认结论，2 个置顶')
    expect(resolved?.modelContext?.block).toContain('置顶文件：决策记录.md (v3)、SOP.md (v1)')
    expect(resolved?.modelContext?.block).toContain('项目概况正文。')
    expect(calls.summary).toBe(1)
    expect(calls.listAssets).toBe(1)
  })

  it('injects NO header on later turns — admin summary/listAssets are never called', async () => {
    const calls = installAdmin({ pinned: [pinnedAsset('p1', '决策记录.md', 3)] })
    const resolved = await resolveSessionProjectContext(makeDeps(LATER_TURN_SESSION), SESSION_ID, REFS, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeDefined()
    expect(calls.summary).toBe(0)
    expect(calls.listAssets).toBe(0)
    // The @ reference resolution is UNCHANGED by the convergence.
    expect(calls.getRead).toBe(1)
    expect(resolved?.references).toHaveLength(1)
    expect(resolved?.references[0].status).toBe('ok')
    expect(resolved?.modelContext?.block).toContain('<project-file')
    expect(resolved?.modelContext?.block).not.toContain('<project-context>')
  })

  it('resolves to undefined on a later turn with no references (zero injection)', async () => {
    installAdmin()
    const resolved = await resolveSessionProjectContext(makeDeps(LATER_TURN_SESSION), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeUndefined()
  })

  it('treats a lazy-header preview signature as "not first" even with an empty message array', async () => {
    installAdmin()
    const lazySession: SessionState = {
      ...FIRST_TURN_SESSION,
      messages: [],
      preview: '之前的用户消息预览',
    }
    const resolved = await resolveSessionProjectContext(makeDeps(lazySession), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeUndefined()
  })

  it('skips the header (fail-closed) when session state is unreadable — never re-floods an old session', async () => {
    installAdmin()
    const deps = makeDeps(FIRST_TURN_SESSION)
    ;(deps.sessionManager as unknown as { getSession: () => Promise<null> }).getSession = async () => null
    const resolved = await resolveSessionProjectContext(deps, SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeUndefined()
  })

  it('on first-turn header timeout the @ references still persist (refs never blocked by the header)', async () => {
    setProjectContextSendResolveTimeoutForTests(0)
    installAdmin({ hangSummary: true, pinned: [pinnedAsset('p1', '决策记录.md', 3)] })
    const resolved = await resolveSessionProjectContext(makeDeps(FIRST_TURN_SESSION), SESSION_ID, REFS, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeDefined()
    expect(resolved?.references).toHaveLength(1)
    expect(resolved?.references[0].status).toBe('ok')
    // The block degrades to references-only; no header section rides it.
    expect(resolved?.modelContext?.block).not.toContain('<project-context>')
    expect(resolved?.modelContext?.block).toContain('<project-file')
  })

  it('still resolves to undefined outside a project session (regression gate)', async () => {
    installAdmin()
    const nonProject: SessionState = { id: SESSION_ID, workspaceId: WORKSPACE_ID, messages: [] }
    const resolved = await resolveSessionProjectContext(makeDeps(nonProject), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    expect(resolved).toBeUndefined()
  })
})

describe('resolveSessionProjectContext — pinned digest bounds (U7)', () => {
  it('caps the pinned listing at 8 entries and marks the overflow instead of listing everything', async () => {
    installAdmin({
      pinned: Array.from({ length: 11 }, (_, i) => pinnedAsset(`p${i}`, `置顶${i}.md`, 1)),
    })
    const resolved = await resolveSessionProjectContext(makeDeps(FIRST_TURN_SESSION), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    const block = resolved?.modelContext?.block ?? ''
    expect(block).toContain('8+ 个置顶')
    expect(block).toContain('置顶文件：')
    expect(block).toContain('（未列全）')
    expect(block).not.toContain('置顶10.md')
  })

  it('omits the pinned row entirely when the project has no pinned assets', async () => {
    installAdmin({ pinned: [] })
    const resolved = await resolveSessionProjectContext(makeDeps(FIRST_TURN_SESSION), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    const block = resolved?.modelContext?.block ?? ''
    expect(block).toContain('项目共享文件区：12 个文件，4 个已确认结论')
    expect(block).not.toContain('置顶文件：')
    expect(block).not.toContain('个置顶')
  })

  it('degrades to statistics-only when the pinned digest call fails', async () => {
    setProjectContextAdminForTests({
      summary: async () => SUMMARY,
      listAssets: async () => {
        throw new Error('admin down')
      },
      getRead: async () => ({ content: '', version: 1 }) as Awaited<ReturnType<ProjectContextAdmin['getRead']>>,
    } as unknown as ProjectContextAdmin)
    const resolved = await resolveSessionProjectContext(makeDeps(FIRST_TURN_SESSION), SESSION_ID, undefined, WORKSPACE_ID, null, PROJECT_ID)
    const block = resolved?.modelContext?.block ?? ''
    expect(block).toContain('项目共享文件区：12 个文件，4 个已确认结论')
    expect(block).not.toContain('置顶文件：')
  })
})

describe('buildProjectHeaderLines — pure assembly', () => {
  it('assembles statistics, pinned listing, overview in order', () => {
    const lines = buildProjectHeaderLines({
      summary: SUMMARY,
      pinned: [{ name: 'A.md', version: 2 }],
      pinnedHasMore: false,
    })
    expect(lines).toEqual([
      '项目共享文件区：12 个文件，4 个已确认结论，1 个置顶',
      '置顶文件：A.md (v2)',
      '项目概况正文。',
    ])
  })

  it('drops empty overview lines and empty pinned rows', () => {
    const lines = buildProjectHeaderLines({
      summary: { ...SUMMARY, overview: '  ' },
      pinned: [],
      pinnedHasMore: false,
    })
    expect(lines).toEqual(['项目共享文件区：12 个文件，4 个已确认结论'])
  })
})
