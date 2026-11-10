import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  invalidateProjectContextCache,
  __projectContextResolverStateForTests,
  resetProjectContextResolverForTests,
  resolveProjectContext,
  setProjectContextResolverAdminForTests,
  setProjectContextResolverClockForTests,
  setProjectContextResolverSpaceReaderForTests,
  type ProjectMembersAdmin,
  type ProjectContextResolution,
} from './project-context-resolver'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import {
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account'

// POO-205 C7a (P3-1): the server-side project-context resolver. member /
// not_member / unavailable fail-closed tri-state, a per-(account, org)
// TTL cache shared across concurrent callers, admin reachability failures
// (network error, 5xx, timeout) collapsed into `unavailable`, cache
// invalidation after every successful pm write, and a per-account cache
// key so a switched account never reads another account's roster.

const accountA = 'acc-resolver-a'
const accountB = 'acc-resolver-b'
const enterpriseSpaceId = 'space-ent-resolver'
const enterpriseId = 'ent-resolver-1'

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

function adminMock(
  projects: ProjectSummary[] | Error,
  calls?: { count: number },
): ProjectMembersAdmin {
  return {
    listProjects: async () => {
      if (calls) calls.count++
      if (projects instanceof Error) throw projects
      return {
        contractVersion: 'poo205-contract-r1' as never,
        organizationEnterpriseId: enterpriseId,
        projects,
      }
    },
  } as unknown as ProjectMembersAdmin
}

const isMember = (r: ProjectContextResolution): r is { status: 'member'; context: { name: string; purpose?: string; instructions?: string } } =>
  r.status === 'member'

describe('project-context-resolver (POO-205 C7a)', () => {
  let now: number

  const seedEnterpriseScope = (accountId = accountA) => {
    resetProductSpaceExecutionRegistryForTests()
    setRuntimeActiveProductSpaceAccount(accountId)
    setRuntimeActiveProductSpace(enterpriseSpaceId, 'enterprise')
    setSyncTrustedProductSpaceAccountId(accountId)
    setTrustedProductSpaceAccountProvider(async () => accountId)
    setProjectContextResolverSpaceReaderForTests(
      (id, spaceId) => id === accountId && spaceId === enterpriseSpaceId
        ? { kind: 'enterprise', enterpriseId }
        : null,
    )
  }

  beforeEach(() => {
    now = 1_000_000
    resetProjectContextResolverForTests()
    setProjectContextResolverClockForTests(() => now)
    seedEnterpriseScope()
  })

  afterEach(() => {
    resetProjectContextResolverForTests()
    setSyncTrustedProductSpaceAccountId(null)
    setRuntimeActiveProductSpace(null)
    resetProductSpaceExecutionRegistryForTests()
  })

  it('member → the admin-proven snapshot (name/purpose/instructions), not the renderer-supplied one', async () => {
    setProjectContextResolverAdminForTests(adminMock([
      project('proj-1', { name: 'Acme Reorg', purpose: 'Plan the reorg', instructions: 'Always answer in Chinese.' }),
    ]))
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(isMember(r)).toBe(true)
    if (isMember(r)) {
      expect(r.context).toEqual({
        name: 'Acme Reorg',
        purpose: 'Plan the reorg',
        instructions: 'Always answer in Chinese.',
      })
    }
  })

  it('not_member → admin answered but the project is not in the roster', async () => {
    setProjectContextResolverAdminForTests(adminMock([project('proj-1')]))
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-removed' })
    expect(r.status).toBe('not_member')
  })

  it('unavailable — no committed runtime scope (personal space fence)', async () => {
    setRuntimeActiveProductSpace(null)
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(r.status).toBe('unavailable')
  })

  it('unavailable — the caller is not the trusted account (switched account)', async () => {
    setProjectContextResolverAdminForTests(adminMock([project('proj-1')]))
    const r = await resolveProjectContext({ accountId: accountB, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(r.status).toBe('unavailable')
    // And nothing was cached under the foreign account.
    expect(__projectContextResolverStateForTests().cachedKeys()).toEqual([])
  })

  it('unavailable — the committed space is not an enterprise space', async () => {
    setProjectContextResolverSpaceReaderForTests(() => ({ kind: 'personal' }))
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(r.status).toBe('unavailable')
  })

  it('unavailable — admin unreachable (network error / 5xx mapped by the admin client)', async () => {
    setProjectContextResolverAdminForTests(adminMock(new Error('connect ECONNREFUSED')))
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(r.status).toBe('unavailable')
    expect(__projectContextResolverStateForTests().cachedKeys()).toEqual([])
  })

  it('unavailable — the single fetch exceeds the 3s deadline', async () => {
    setProjectContextResolverClockForTests(() => Date.now())
    setProjectContextResolverAdminForTests({
      listProjects: () => new Promise(() => { /* never settles */ }),
    } as unknown as ProjectMembersAdmin)
    const r = await resolveProjectContext({ accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    expect(r.status).toBe('unavailable')
    expect(__projectContextResolverStateForTests().inflightCount()).toBe(0)
  })

  it('TTL: a burst inside the window hits the cache once; past the window it refetches', async () => {
    const calls = { count: 0 }
    setProjectContextResolverAdminForTests(adminMock([project('proj-1')], calls))
    const input = { accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' }
    await resolveProjectContext(input)
    await resolveProjectContext(input)
    await resolveProjectContext(input)
    expect(calls.count).toBe(1)
    now += 30_000 // exactly at TTL → stale
    const r = await resolveProjectContext(input)
    expect(calls.count).toBe(2)
    expect(isMember(r)).toBe(true)
  })

  it('concurrent callers for one key share a single in-flight fetch', async () => {
    const calls = { count: 0 }
    setProjectContextResolverAdminForTests({
      listProjects: async () => {
        calls.count++
        await new Promise(resolve => setTimeout(resolve, 20))
        return { contractVersion: 'poo205-contract-r1' as never, organizationEnterpriseId: enterpriseId, projects: [project('proj-1')] }
      },
    } as unknown as ProjectMembersAdmin)
    const input = { accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' }
    const [a, b] = await Promise.all([resolveProjectContext(input), resolveProjectContext(input)])
    expect(calls.count).toBe(1)
    expect(isMember(a)).toBe(true)
    expect(isMember(b)).toBe(true)
    expect(__projectContextResolverStateForTests().inflightCount()).toBe(0)
  })

  it('invalidateProjectContextCache drops the organization so the next resolve refetches', async () => {
    const calls = { count: 0 }
    setProjectContextResolverAdminForTests(adminMock([project('proj-1', { instructions: 'v1' })], calls))
    const input = { accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' }
    await resolveProjectContext(input)
    expect(calls.count).toBe(1)
    invalidateProjectContextCache(enterpriseId)
    const r = await resolveProjectContext(input)
    expect(calls.count).toBe(2)
    if (isMember(r)) expect(r.context.instructions).toBe('v1')
    // An unknown organization id invalidates nothing of this one.
    invalidateProjectContextCache('ent-other')
    await resolveProjectContext(input)
    expect(calls.count).toBe(2)
  })

  it('switching accounts never reads the other account’s cached roster', async () => {
    setProjectContextResolverAdminForTests(adminMock([project('proj-1')]))
    const inputA = { accountId: accountA, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' }
    await resolveProjectContext(inputA)
    const keyOf = (accountId: string) => `${accountId}\u0000${enterpriseId}`
    expect(__projectContextResolverStateForTests().cachedKeys()).toEqual([keyOf(accountA)])
    // The trusted account flips to B — B's own scope resolves its own key.
    seedEnterpriseScope(accountB)
    setProjectContextResolverAdminForTests(adminMock([]))
    const r = await resolveProjectContext({ accountId: accountB, productSpaceId: enterpriseSpaceId, projectId: 'proj-1' })
    // B is NOT a member (admin says so for B's roster), even though A's cache holds proj-1.
    expect(r.status).toBe('not_member')
    expect(__projectContextResolverStateForTests().cachedKeys().sort()).toEqual(
      [keyOf(accountA), keyOf(accountB)].sort(),
    )
  })
})
