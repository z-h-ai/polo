import { describe, expect, it, mock } from 'bun:test'
import { createOrganizationDeepLinkNavigationCoordinator } from '../app-organization-deep-link'
import type { OrganizationDeepLinkAppState } from '../app-organization-deep-link'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function settlePromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('App organization deep-link routing', () => {
  it('keeps the current invitation route when login completes during a deferred preview', async () => {
    const preview = deferred()
    let accountId: string | null = null
    let appState: OrganizationDeepLinkAppState = 'onboarding'
    let pendingJoinToken: string | null = null
    let visibleJoinToken: string | null = null
    const showOrganization = mock(() => {
      appState = 'organization'
      visibleJoinToken = pendingJoinToken
    })
    const showAdminLogin = mock(() => {
      appState = 'onboarding'
    })
    const coordinator = createOrganizationDeepLinkNavigationCoordinator({
      receiveJoinToken: token => {
        // Mirrors receiveJoinToken: persist the invitation context before previewing.
        pendingJoinToken = token
        return preview.promise
      },
      getCurrentAccountId: () => accountId,
      getCurrentAppState: () => appState,
      showOrganization,
      showAdminLogin,
    })

    coordinator.handleNavigation({ joinToken: 'login-preview-token' })
    expect(String(pendingJoinToken)).toBe('login-preview-token')

    // Login invalidates the old preview callback. The login bootstrap then restores
    // the persisted invitation and becomes the only owner of the current route.
    coordinator.invalidate()
    accountId = 'account-after-login'
    showOrganization()
    preview.resolve()
    await settlePromises()

    expect(String(appState)).toBe('organization')
    expect(String(visibleJoinToken)).toBe('login-preview-token')
    expect(showOrganization).toHaveBeenCalledTimes(1)
    expect(showAdminLogin).not.toHaveBeenCalled()
  })

  it('stays in the login flow when logout occurs during a deferred preview', async () => {
    const preview = deferred()
    let accountId: string | null = 'signed-in-account'
    let appState: OrganizationDeepLinkAppState = 'ready'
    let pendingJoinToken: string | null = null
    const showOrganization = mock(() => {
      appState = 'organization'
    })
    const showAdminLogin = mock(() => {
      appState = 'onboarding'
    })
    const coordinator = createOrganizationDeepLinkNavigationCoordinator({
      receiveJoinToken: token => {
        pendingJoinToken = token
        return preview.promise
      },
      getCurrentAccountId: () => accountId,
      getCurrentAppState: () => appState,
      showOrganization,
      showAdminLogin,
    })

    coordinator.handleNavigation({ joinToken: 'logout-preview-token' })
    expect(String(pendingJoinToken)).toBe('logout-preview-token')

    // Logout clears the sensitive invitation state and invalidates the request before
    // its preview can route with the former account's result.
    coordinator.invalidate()
    accountId = null
    pendingJoinToken = null
    appState = 'onboarding'
    preview.resolve()
    await settlePromises()

    expect(appState).toBe('onboarding')
    expect(pendingJoinToken).toBeNull()
    expect(showOrganization).not.toHaveBeenCalled()
    expect(showAdminLogin).not.toHaveBeenCalled()
  })

  it('uses live App state and drops an older link after a newer navigation', async () => {
    const previews = new Map<string, ReturnType<typeof deferred>>()
    let accountId: string | null = null
    let appState: OrganizationDeepLinkAppState = 'loading'
    const showOrganization = mock(() => {
      appState = 'organization'
    })
    const showAdminLogin = mock(() => {
      appState = 'onboarding'
    })
    const coordinator = createOrganizationDeepLinkNavigationCoordinator({
      receiveJoinToken: token => {
        const preview = deferred()
        previews.set(token, preview)
        return preview.promise
      },
      getCurrentAccountId: () => accountId,
      getCurrentAppState: () => appState,
      showOrganization,
      showAdminLogin,
    })

    coordinator.handleNavigation({ joinToken: 'older-token' })
    coordinator.handleNavigation({ joinToken: 'newer-token' })
    appState = 'onboarding'

    previews.get('newer-token')?.resolve()
    await settlePromises()
    expect(showAdminLogin).toHaveBeenCalledTimes(1)

    previews.get('older-token')?.resolve()
    await settlePromises()
    expect(showAdminLogin).toHaveBeenCalledTimes(1)
    expect(showOrganization).not.toHaveBeenCalled()

    coordinator.handleNavigation({ joinToken: 'authenticated-token' })
    accountId = 'live-account'
    previews.get('authenticated-token')?.resolve()
    await settlePromises()
    expect(showOrganization).toHaveBeenCalledTimes(1)
  })
})
