import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createAdminApiClient as createAuthAdminApiClient } from '../admin-auth.ts'
import {
  getGlobalForceLogoutHandler,
  resetGlobalForceLogoutHandlerForTests,
  setGlobalForceLogoutHandler,
} from '../global-force-logout.ts'
import { createAdminApiClient as createQuotaAdminApiClient } from '../../admin-api/client.ts'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('global force logout wiring', () => {
  afterEach(() => {
    resetGlobalForceLogoutHandlerForTests()
  })

  it('uses the configured global handler for authenticated auth Admin API clients by default', async () => {
    process.env.POLO_ADMIN_API_URL = 'http://admin.example.test'
    const onForceLogout = mock(async () => {})
    setGlobalForceLogoutHandler(onForceLogout)

    const client = createAuthAdminApiClient({
      token: 'jwt',
      fetchFn: mock(async () => jsonResponse(401, { error: 'token_revoked' })),
    })

    await expect(client.getLlmConnections()).rejects.toThrow()

    expect(getGlobalForceLogoutHandler()).toBe(onForceLogout)
    expect(onForceLogout).toHaveBeenCalledTimes(1)
    expect(onForceLogout).toHaveBeenCalledWith({
      reason: 'token_revoked',
      requestUrl: 'http://admin.example.test/api/llm-connections',
    })
  })

  it('uses the configured global handler for quota Admin API singleton-style clients by default', async () => {
    process.env.ADMIN_API_URL = 'http://admin.example.test'
    const onForceLogout = mock(async () => {})
    setGlobalForceLogoutHandler(onForceLogout)

    const client = createQuotaAdminApiClient({
      fetchFn: mock(async () => jsonResponse(401, { error: 'Unauthorized' })),
    })

    await expect(client.checkQuota('jwt')).rejects.toThrow()

    expect(onForceLogout).toHaveBeenCalledTimes(1)
    expect(onForceLogout).toHaveBeenCalledWith({
      reason: 'token_revoked',
      requestUrl: 'http://admin.example.test/api/quota/check',
    })
  })
})
