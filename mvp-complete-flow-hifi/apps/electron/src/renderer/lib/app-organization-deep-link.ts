export type OrganizationDeepLinkAppState =
  | 'loading'
  | 'onboarding'
  | 'reauth'
  | 'organization'
  | 'workspace-picker'
  | 'ready'

export type OrganizationDeepLinkNavigation = {
  joinToken?: string
}

type OrganizationDeepLinkNavigationDependencies = {
  receiveJoinToken: (token: string) => Promise<void>
  getCurrentAccountId: () => string | null
  getCurrentAppState: () => OrganizationDeepLinkAppState
  showOrganization: () => void
  showAdminLogin: () => void
}

export type OrganizationDeepLinkNavigationCoordinator = {
  handleNavigation: (navigation: OrganizationDeepLinkNavigation) => void
  invalidate: () => void
  dispose: () => void
}

/**
 * Coordinates the asynchronous preview triggered by organization join links.
 *
 * Authentication and App routing are deliberately read through getters after
 * the preview settles. A monotonically increasing request generation also
 * prevents an older preview from routing after a newer link or authentication
 * transition has superseded it.
 */
export function createOrganizationDeepLinkNavigationCoordinator(
  dependencies: OrganizationDeepLinkNavigationDependencies,
): OrganizationDeepLinkNavigationCoordinator {
  let generation = 0
  let disposed = false

  const invalidate = () => {
    generation += 1
  }

  const handleNavigation = (navigation: OrganizationDeepLinkNavigation) => {
    const token = navigation.joinToken
    if (!token || disposed) return

    const requestGeneration = ++generation
    void dependencies.receiveJoinToken(token)
      .catch(() => {
        // The organization state owns the visible preview error. Routing still
        // proceeds so an authenticated user can see it in the organization flow.
      })
      .then(() => {
        if (disposed || requestGeneration !== generation) return

        const accountId = dependencies.getCurrentAccountId()
        const appState = dependencies.getCurrentAppState()
        if (accountId) {
          dependencies.showOrganization()
        } else if (appState !== 'loading') {
          dependencies.showAdminLogin()
        }
      })
  }

  return {
    handleNavigation,
    invalidate,
    dispose: () => {
      disposed = true
      invalidate()
    },
  }
}
