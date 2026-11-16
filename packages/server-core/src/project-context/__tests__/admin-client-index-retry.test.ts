import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

import { getProjectContextAdmin } from '../admin-client'

/**
 * POO-215 U5/U6 transport tests (same harness as admin-client-refresh.test.ts
 * — a planned globalThis.fetch in place of the admin):
 * - U6: the capabilities read parses through the COMPAT projection, so an
 *   older admin (poo196-contract-r2) that answers without the `parsing` block
 *   still resolves, and a poo215-contract-r1 admin carries it through.
 * - U5: the index-retry write POSTs the single-asset endpoint under the
 *   project scope and answers the rebuild `{ jobId }` envelope; the admin's
 *   `pc_validation_error` for a non-failed asset surfaces as an AdminError.
 */

const VALID_CAPABILITIES = {
  featureEnabled: true,
  // Narrow literals: toEqual's expected-parameter type is the admin contract's
  // union ('owner' | 'manager' | 'member' etc.), and wide `string` inference
  // here failed the overload resolution and turned Validate red.
  role: 'owner' as const,
  canManage: true,
  canShare: true,
  library: { status: 'ready' as const },
  limits: { maxUploadBytes: 1024, downloadUrlTtlSeconds: 60 },
}

const PARSING_BLOCK = {
  searchable: ['pdf', 'docx'],
  storeOnly: ['zip'],
  expectedParsingSeconds: 45,
}

const ORIGINAL_FETCH = globalThis.fetch

interface RecordedTokenWrite {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

let storedTokens: {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
  username: string
  displayName?: string
  role?: string
  groupIds?: string[]
} | null
let tokenWrites: RecordedTokenWrite[]
let fetchPlan: Array<{ status: number; body: unknown }>
let requests: Array<{ method: string; url: string; body: string }>

mock.module('@polo-ai/shared/config', () => ({
  getAdminUrl: () => 'https://admin.test',
}))

mock.module('@polo-ai/shared/credentials', () => ({
  getCredentialManager: () => ({
    getAdminTokens: async () => storedTokens,
    setAdminTokens: async (data: RecordedTokenWrite & { userId: string; username: string }) => {
      if (data.userId !== 'account-1') throw new Error('must never persist a foreign account')
      tokenWrites.push(data)
      storedTokens = { ...storedTokens!, accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt }
    },
  }),
}))

beforeEach(() => {
  // A live (unexpired) token: no refresh detour — the plan answers directly.
  storedTokens = {
    accessToken: 'live-access',
    refreshToken: 'refresh-token-1',
    expiresAt: Date.now() + 600_000,
    userId: 'account-1',
    username: 'member',
  }
  tokenWrites = []
  fetchPlan = []
  requests = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    void init
    if (url.includes('/api/auth/refresh')) {
      return new Response(JSON.stringify({ accessToken: 'fresh-access', refreshToken: 'refresh-token-2', expiresIn: 900 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    requests.push({
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const step = fetchPlan.shift()
      ?? { status: 500, body: { error: 'unexpected fetch during test' } }
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

describe('project-context capabilities COMPAT parse (POO-215 U6)', () => {
  it('an OLD admin answer without the parsing block resolves with parsing absent', async () => {
    fetchPlan = [{ status: 200, body: VALID_CAPABILITIES }]
    const result = await getProjectContextAdmin().capabilities('space-1', 'prj_abc')
    expect(result).toEqual(VALID_CAPABILITIES)
    expect(result.parsing).toBeUndefined()
  })

  it('a poo215-contract-r1 admin answer carries the parsing block through', async () => {
    fetchPlan = [{ status: 200, body: { ...VALID_CAPABILITIES, parsing: PARSING_BLOCK } }]
    const result = await getProjectContextAdmin().capabilities('space-1', 'prj_abc')
    expect(result.parsing).toEqual(PARSING_BLOCK)
  })
})

describe('project-context index-retry (POO-215 U5)', () => {
  it('POSTs the single-asset endpoint under the project scope and answers { jobId }', async () => {
    fetchPlan = [{ status: 200, body: { jobId: 'job-1' } }]
    const result = await getProjectContextAdmin().indexRetry('space-1', 'prj_abc', 'asset-9')
    expect(result).toEqual({ jobId: 'job-1' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.url).toContain('/api/project-context/space-1/assets/asset-9/index-retry')
    expect(requests[0]!.url).toContain('projectId=prj_abc')
    expect(requests[0]!.body).toBe('{}')
  })

  it('surfaces the admin pc_validation_error for a non-failed asset', async () => {
    fetchPlan = [{ status: 400, body: { error: 'Only a failed index can be retried', code: 'pc_validation_error' } }]
    await expect(getProjectContextAdmin().indexRetry('space-1', 'prj_abc', 'asset-indexed'))
      .rejects.toMatchObject({ errorCode: 'pc_validation_error' })
  })
})
