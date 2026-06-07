import { describe, expect, it, mock } from 'bun:test'
import {
  getGlobalForceLogoutHandler,
  resetGlobalForceLogoutHandlerForTests,
  resetInFlightLlmAbortControllersForTests,
  trackInFlightLlmAbortController,
  type SessionExpiredEvent,
} from '@polo-ai/shared/auth'
import { configureServerForceLogout } from '../force-logout-wiring'

describe('configureServerForceLogout', () => {
  it('installs one global handler backed by LLM abort tracking, cache cleanup, and UI event emission', async () => {
    resetGlobalForceLogoutHandlerForTests()
    resetInFlightLlmAbortControllersForTests()

    const abort = mock(() => {})
    const untrack = trackInFlightLlmAbortController({ abort })
    const clearCachedAuthData = mock(async () => {})
    const emitSessionExpired = mock(async (_event: SessionExpiredEvent) => {})
    const routeToLogin = mock(async () => {})
    const credentialManager = {
      list: mock(async () => []),
      delete: mock(async (_id: unknown) => {}),
    }

    const handler = configureServerForceLogout({
      clearCachedAuthData,
      emitSessionExpired,
      routeToLogin,
      credentialManager,
    })

    expect(getGlobalForceLogoutHandler()).toBe(handler)

    const event: SessionExpiredEvent = {
      reason: 'token_revoked',
      requestUrl: 'http://admin.example.test/api/quota/check',
    }
    await handler(event)

    expect(abort).toHaveBeenCalledTimes(1)
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1)
    expect(emitSessionExpired).toHaveBeenCalledWith(event)
    expect(routeToLogin).toHaveBeenCalledTimes(1)

    untrack()
  })
})
