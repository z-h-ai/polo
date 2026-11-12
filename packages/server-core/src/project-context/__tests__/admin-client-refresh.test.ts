import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

import { getProjectContextAdmin } from '../admin-client'

/**
 * POO-205 production incident guard: the PC surface used to construct a
 * tokenStore-less AdminClient, so the routine 15-minute admin access-token
 * lapse surfaced as a raw 401 that the caller could only report as
 * "project file service unavailable — check your network". withAdmin now
 * rides the same 401 → refresh → retry contract as every other admin client,
 * anchored to the account id that was observed when the call started.
 */

const capabilities = {
  featureEnabled: true,
  role: 'owner',
  canManage: true,
  canShare: true,
  library: { status: 'ready' },
  limits: { maxUploadBytes: 1024, downloadUrlTtlSeconds: 60 },
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
let refreshStatus: number

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
  storedTokens = {
    accessToken: 'expired-access',
    refreshToken: 'refresh-token-1',
    expiresAt: Date.now() - 1000,
    userId: 'account-1',
    username: 'member',
  }
  tokenWrites = []
  fetchPlan = []
  refreshStatus = 200
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    void init
    if (url.includes('/api/auth/refresh')) {
      // the refresh endpoint is not part of the per-call plan; the suite pins
      // its status through refreshStatus
      if (refreshStatus !== 200) {
        return new Response(JSON.stringify({ error: 'refresh rejected' }), { status: refreshStatus, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ accessToken: 'fresh-access', refreshToken: 'refresh-token-2', expiresIn: 900 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const step = fetchPlan.shift()
      ?? { status: 500, body: { error: 'unexpected fetch during test' } }
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

describe('project-context withAdmin token refresh', () => {
  it('refreshes an expired access token and retries the call transparently', async () => {
    fetchPlan = [
      { status: 401, body: { error: ' Unauthorized' } },
      { status: 200, body: capabilities },
    ]
    const result = await getProjectContextAdmin().capabilities('space-1', 'prj_abc')
    expect(result).toEqual(capabilities)
    expect(tokenWrites).toHaveLength(1)
    expect(tokenWrites[0]!.accessToken).toBe('fresh-access')
    expect(tokenWrites[0]!.refreshToken).toBe('refresh-token-2')
    expect(tokenWrites[0]!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('falls through with the original 401 when the refresh itself is rejected', async () => {
    refreshStatus = 401
    fetchPlan = [
      { status: 401, body: { error: 'Unauthorized' } },
    ]
    await expect(getProjectContextAdmin().capabilities('space-1', 'prj_abc')).rejects.toThrow()
    expect(tokenWrites).toHaveLength(0)
  })
})
