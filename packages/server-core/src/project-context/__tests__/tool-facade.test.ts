import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  createProjectContextToolFacade,
} from '../tool-facade'
import {
  setProjectContextActiveProductSpaceReaderForTests,
  resetProjectContextActiveProductSpaceReaderForTests,
  setProjectContextAdminForTests,
  resetProjectContextAdminForTests,
} from '../service'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../../handlers/rpc/trusted-product-space-account'
import { AdminError } from '@polo-ai/shared/admin'
import type {
  PcReadResponse,
  PcSearchResponse,
} from '@polo-ai/shared/admin/project-context-contract'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { ProjectContextAdmin } from '../admin-client'
import type { HandlerDeps } from '../../handlers/handler-deps'
import type { ISessionManager } from '../../handlers/session-manager-interface'

/**
 * POO-196 facade factory tests.
 *
 * The service seams (setProjectContextActiveProductSpaceReaderForTests /
 * setProjectContextAdminForTests) plus the runtime fence setters stand in for
 * the committed enterprise ProductSpace state, so the full
 * requireProjectContextScope gate runs for real inside every facade call.
 */

const ACCOUNT_ID = 'account-1'
const SPACE_ID = 'space-1'
const WORKSPACE_ID = 'ws-1'
const SESSION_ID = 'session-1'

// Test summary fixture: the opaque-id brands are nominal, so the plain object
// is cast — the service only reads id/kind/role/accessMode off it.
const ENTERPRISE_SPACE = {
  id: SPACE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-1',
  name: 'Test Project',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-1' },
} as unknown as TrustedProductSpaceSummary

interface SessionRecordLike {
  id: string
  productSpaceId?: string
  workspaceId?: string
}

function makeDeps(sessions: SessionRecordLike[]): HandlerDeps<ISessionManager> {
  return {
    sessionManager: {
      getSessions: () => sessions,
      // getBoundWorkspace resolves the caller workspace through this list.
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

beforeEach(() => {
  commitProjectFence()
})

afterEach(() => {
  resetProjectContextActiveProductSpaceReaderForTests()
  resetProjectContextAdminForTests()
  setRuntimeActiveProductSpace(null)
  setSyncTrustedProductSpaceAccountId(null)
  setTrustedProductSpaceAccountProvider(async () => null)
})

describe('createProjectContextToolFacade — fail-closed construction', () => {
  it('returns null when the session is not a project session (no productSpaceId)', () => {
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).toBeNull()
  })

  it('returns null when the session is bound to a DIFFERENT space than the committed one', () => {
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: 'space-other', workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).toBeNull()
  })

  it('returns null when the session does not exist', () => {
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: 'session-unknown',
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).toBeNull()
  })

  it('returns null when no committed fence exists', () => {
    setRuntimeActiveProductSpace(null)
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).toBeNull()
  })

  it('rejects calls for a workspace that does not match the session record (per-call gate)', async () => {
    // Construction-time pre-check only covers the project binding; the
    // workspace binding is enforced per call inside requireProjectContextScope
    // (getBoundWorkspace) — the facade exists but every call fails closed.
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: 'ws-other',
    })
    expect(facade).not.toBeNull()

    const read = await facade!.read({ assetId: 'asset-1' })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      // workspace_context_mismatch collapses to the generic unavailable code.
      expect(read.error).toBe('pc_service_unavailable')
    }
    const search = await facade!.search({ query: 'anything' })
    expect(search).toEqual({ degraded: true, hits: [] })
  })
})

describe('createProjectContextToolFacade — authorized project session', () => {
  it('builds a facade for a session bound to the committed space', () => {
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).not.toBeNull()
  })

  it('search maps the admin response through (hits + degraded flag)', async () => {
    const adminSearchResponse: PcSearchResponse = {
      degraded: false,
      hits: [
        {
          assetId: 'asset-1',
          version: 2,
          name: '产品定稿.md',
          tags: [{ id: 'tag-1', label: '结论', preset: false }],
          snippet: '最终方案',
          score: 0.9,
        },
      ],
    }
    const searches: Array<{ productSpaceId: string; query: { q: string; tag?: string; limit?: number } }> = []
    setProjectContextAdminForTests({
      search: async (productSpaceId: string, query: { q: string; tag?: string; limit?: number }) => {
        searches.push({ productSpaceId, query })
        return adminSearchResponse
      },
    } as unknown as ProjectContextAdmin)

    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).not.toBeNull()

    const result = await facade!.search({ query: '定稿', limit: 5 })
    expect(result.degraded).toBe(false)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.assetId).toBe('asset-1')
    expect(result.hits[0]?.version).toBe(2)
    // The admin call addressed the session's OWN committed space.
    expect(searches).toHaveLength(1)
    expect(searches[0]?.productSpaceId).toBe(SPACE_ID)
    expect(searches[0]?.query.q).toBe('定稿')
    expect(searches[0]?.query.limit).toBe(5)
  })

  it('read maps the admin text response through (content + version + truncated)', async () => {
    const adminReadResponse: PcReadResponse = {
      kind: 'text',
      version: 3,
      content: 'SHARED BODY',
      truncated: true,
    }
    const reads: Array<{ productSpaceId: string; assetId: string; version?: number }> = []
    setProjectContextAdminForTests({
      getRead: async (productSpaceId: string, assetId: string, version?: number) => {
        reads.push({ productSpaceId, assetId, version })
        return adminReadResponse
      },
    } as unknown as ProjectContextAdmin)

    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).not.toBeNull()

    const result = await facade!.read({ assetId: 'asset-1', version: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe('SHARED BODY')
      expect(result.version).toBe(3)
      expect(result.truncated).toBe(true)
    }
    expect(reads).toEqual([{ productSpaceId: SPACE_ID, assetId: 'asset-1', version: 3 }])
  })

  it('read maps an admin 404 onto ok:false error="pc_not_found"', async () => {
    setProjectContextAdminForTests({
      getRead: async () => {
        throw new AdminError('Project file not found', 'pc_not_found', { status: 404 })
      },
    } as unknown as ProjectContextAdmin)

    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).not.toBeNull()

    const result = await facade!.read({ assetId: 'missing' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('pc_not_found')
    }
  })

  it('degrades search to empty hits when the fence is revoked mid-session (scope CAS)', async () => {
    setProjectContextAdminForTests({
      search: async () => {
        throw new AdminError('unreachable', 'SERVER_ERROR', { status: 500 })
      },
    } as unknown as ProjectContextAdmin)
    const facade = createProjectContextToolFacade({
      deps: makeDeps([{ id: SESSION_ID, productSpaceId: SPACE_ID, workspaceId: WORKSPACE_ID }]),
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    })
    expect(facade).not.toBeNull()

    // The session leaves the committed fence after the facade was built —
    // every call re-gates, so the revocation is honored immediately.
    setRuntimeActiveProductSpace(null)

    const search = await facade!.search({ query: 'anything' })
    expect(search).toEqual({ degraded: true, hits: [] })

    const read = await facade!.read({ assetId: 'asset-1' })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.error).toBe('pc_service_unavailable')
    }
  })
})
