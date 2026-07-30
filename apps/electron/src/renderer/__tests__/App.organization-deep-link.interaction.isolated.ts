import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type {
  OrganizationContextStorage,
  OrganizationContextStoragePatch,
} from '@polo-ai/shared/config/organization-context'

GlobalRegistrator.register()
setupI18n()

function passthrough({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}

let loginRouteRenderCount = 0
let lastOnboardingFinish: (() => void) | null = null

mock.module('@polo-ai/ui', () => ({
  TooltipProvider: passthrough,
  ShikiThemeProvider: passthrough,
  PlatformProvider: passthrough,
  ImagePreviewOverlay: () => null,
  PDFPreviewOverlay: () => null,
  CodePreviewOverlay: () => null,
  DocumentFormattedMarkdownOverlay: () => null,
  JSONPreviewOverlay: () => null,
}))

mock.module('sonner', () => ({
  toast: {
    error: mock(() => {}),
    warning: mock(() => {}),
  },
}))

mock.module('@/components/onboarding', () => ({
  OnboardingWizard: ({ onFinish }: { onFinish: () => void }) => {
    loginRouteRenderCount += 1
    lastOnboardingFinish = onFinish
    return createElement(
      'div',
      { 'data-testid': 'login-route' },
      createElement(
        'button',
        { type: 'button', onClick: onFinish },
        'Complete login',
      ),
    )
  },
  ReauthScreen: () => null,
}))

mock.module('@/components/organization/OrganizationOnboarding', () => ({
  OrganizationOnboarding: ({
    flowState,
    joinPreview,
  }: {
    flowState: string
    joinPreview: { organization: { name: string } } | null
  }) => createElement(
    'div',
    {
      'data-testid': 'organization-route',
      'data-flow-state': flowState,
    },
    joinPreview?.organization.name ?? '',
  ),
}))

mock.module('@/components/organization/OrganizationManagementDialog', () => ({
  OrganizationManagementDialog: () => null,
}))

mock.module('@/components/app-shell/AppShell', () => ({
  AppShell: ({
    contextValue,
  }: {
    contextValue: {
      currentAdminUser?: { userId: string } | null
      onAdminLogout?: () => Promise<void>
      onReset?: () => void
    }
  }) => createElement(
    'div',
    {
      'data-testid': 'ready-route',
      'data-account-id': contextValue.currentAdminUser?.userId ?? '',
    },
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => {
          void contextValue.onAdminLogout?.()
        },
      },
      'Log out',
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: contextValue.onReset,
      },
      'Reset app',
    ),
  ),
}))

mock.module('@/components/workspace', () => ({
  WorkspacePicker: () => createElement('div', { 'data-testid': 'workspace-route' }),
}))

mock.module('@/components/ResetConfirmationDialog', () => ({
  ResetConfirmationDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: () => void
  }) => open
    ? createElement(
        'button',
        { type: 'button', onClick: onConfirm },
        'Confirm reset',
      )
    : null,
}))

mock.module('@/components/SplashScreen', () => ({
  SplashScreen: () => null,
}))

mock.module('@/components/app-shell/TransportConnectionBanner', () => ({
  TransportConnectionBanner: () => null,
  shouldShowTransportConnectionBanner: () => false,
}))

mock.module('@/context/FocusContext', () => ({
  FocusProvider: passthrough,
}))

mock.module('@/context/ModalContext', () => ({
  ModalProvider: passthrough,
}))

mock.module('@/context/DismissibleLayerContext', () => ({
  DismissibleLayerProvider: passthrough,
}))

mock.module('@/context/TabShellContext', () => ({
  TabShellProvider: passthrough,
}))

mock.module('@/context/OrganizationContext', () => ({
  OrganizationProvider: passthrough,
}))

mock.module('@/actions', () => ({
  ActionRegistryProvider: passthrough,
}))

mock.module('@/components/tab-browser/TabShell', () => ({
  TabShellProvider: passthrough,
  TabShell: ({ renderPolo }: { renderPolo: () => ReactNode }) => renderPolo(),
}))

mock.module('@/contexts/NavigationContext', () => ({
  NavigationProvider: passthrough,
}))

mock.module('@/hooks/useTheme', () => ({
  useTheme: () => ({ shikiTheme: 'github-light', isDark: false }),
}))

mock.module('@/hooks/useUpdateChecker', () => ({
  useUpdateChecker: () => ({}),
}))

mock.module('@/event-processor', () => ({
  useEventProcessor: () => ({
    processAgentEvent: mock(() => ({ effects: [] })),
    clearStreamingState: mock(() => {}),
  }),
}))

mock.module('@/hooks/useStaleSessionRecovery', () => ({
  useStaleSessionRecovery: () => ({
    trackSessionActivity: mock(() => {}),
  }),
}))

mock.module('@/hooks/useSession', () => ({
  useSession: () => [{ selected: null }, mock(() => {})],
}))

mock.module('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    isWindowFocused: true,
    showSessionNotification: mock(() => {}),
  }),
}))

mock.module('@/hooks/useLinkInterceptor', () => ({
  useLinkInterceptor: () => ({
    previewState: null,
    handleOpenFile: mock(async () => {}),
    handleOpenUrl: mock(async () => {}),
    openFileExternal: mock(async () => {}),
    closePreview: mock(() => {}),
    readFileDataUrl: mock(async () => ''),
    readFileBinary: mock(async () => new Uint8Array()),
  }),
}))

mock.module('@/hooks/useTransportConnectionState', () => ({
  useTransportConnectionState: () => null,
}))

mock.module('@/hooks/useWindowCloseHandler', () => ({
  useWindowCloseHandler: () => {},
}))

type PreviewResult = {
  success: true
  organization: {
    id: string
    type: 'creator_space'
    name: string
    purpose: string
  }
  join: {
    kind: 'join_link'
    effectiveStatus: 'active'
    expiresAt: null
    usesRemaining: null
    requiresPhoneMatch: false
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

type SessionChangedLogoutResult = {
  success: false
  errorCode: 'SESSION_CHANGED'
  message: string
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const account = {
  userId: 'account-app-wiring',
  username: 'phone_user',
  displayName: 'Phone User',
}

const replacementAccount = {
  userId: 'account-app-wiring-b',
  username: 'replacement_user',
  displayName: 'Replacement User',
}

const organization = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'creator_space' as const,
  name: 'Deferred Preview Studio',
  purpose: 'Verify App wiring',
}

const organizationSummary = {
  ...organization,
  membership: {
    id: '21111111-1111-4111-8111-111111111111',
    role: 'owner' as const,
    status: 'active' as const,
  },
  memberCount: 1,
}

const replacementOrganizationSummary = {
  ...organizationSummary,
  id: '31111111-1111-4111-8111-111111111111',
  name: 'Replacement Studio',
  membership: {
    ...organizationSummary.membership,
    id: '41111111-1111-4111-8111-111111111111',
  },
}

const previewResult: PreviewResult = {
  success: true,
  organization,
  join: {
    kind: 'join_link',
    effectiveStatus: 'active',
    expiresAt: null,
    usesRemaining: null,
    requiresPhoneMatch: false,
  },
}

let authenticated = false
let currentAccount = account
let activeWorkspaceId: string | null = null
let listedOrganizations: typeof organizationSummary[] = []
let previewRequests: Deferred<PreviewResult>[] = []
let previewJoinCallCount = 0
let adminLogoutCallCount = 0
let commonLogoutCallCount = 0
let catalogSyncCallCount = 0
let catalogSyncResult:
  | { success: true }
  | {
      success: false
      errorCode: string
      message: string
      status?: number
    } = { success: true }
let pendingAdminLogout: Deferred<SessionChangedLogoutResult> | null = null
let pendingCommonLogout: Deferred<SessionChangedLogoutResult> | null = null
let organizationContextStorageByAccount = new Map<
  string,
  OrganizationContextStorage
>()
let deepLinkNavigateListener:
  | ((navigation: { joinToken?: string }) => void)
  | null = null

const unsubscribe = () => {}
const subscribe = () => unsubscribe

const electronAPI = new Proxy<Record<string, unknown>>({
  isDebugMode: async () => false,
  getWindowWorkspace: async () => activeWorkspaceId,
  getSetupNeeds: async () => authenticated
    ? {
        needsBillingConfig: false,
        needsCredentials: false,
        needsAdminLogin: false,
        isFullyConfigured: true,
      }
    : {
        needsBillingConfig: false,
        needsCredentials: false,
        needsAdminLogin: true,
        isFullyConfigured: false,
      },
  adminGetStatus: async () => authenticated
    ? {
        loggedIn: true,
        adminUrl: 'https://admin.example.test',
        ...currentAccount,
      }
    : {
        loggedIn: false,
      },
  adminValidate: async () => authenticated
    ? {
        loggedIn: true,
        user: {
          id: currentAccount.userId,
          username: currentAccount.username,
          displayName: currentAccount.displayName,
        },
      }
    : {
        loggedIn: false,
        errorCode: 'UNAUTHORIZED',
      },
  adminSyncConnections: async () => ({ success: true }),
  adminSyncAppCatalog: async () => {
    catalogSyncCallCount += 1
    return catalogSyncResult
  },
  adminLogout: async () => {
    adminLogoutCallCount += 1
    if (pendingAdminLogout) return pendingAdminLogout.promise
    authenticated = false
    return { success: true as const }
  },
  logout: async () => {
    commonLogoutCallCount += 1
    if (pendingCommonLogout) return pendingCommonLogout.promise
    authenticated = false
    return { success: true as const }
  },
  adminAcquirePhoneAuthChallenge: async () => ({ success: false }),
  adminGetAuthConfig: async () => ({ phoneAuthEnabled: false }),
  checkGitBash: async () => ({ platform: 'darwin', found: true }),
  getWorkspaces: async () => activeWorkspaceId
    ? [{ id: activeWorkspaceId, name: 'Local workspace', path: '/tmp/workspace' }]
    : [],
  switchWorkspace: async () => {},
  organizationList: async () => ({
    success: true,
    organizations: listedOrganizations,
  }),
  getOrganizationContextStorage: async (accountId: string) =>
    organizationContextStorageByAccount.get(accountId) ?? null,
  updateOrganizationContextStorage: async (
    accountId: string,
    patch: OrganizationContextStoragePatch,
  ) => {
    const next = {
      ...(organizationContextStorageByAccount.get(accountId) ?? {}),
    }
    if (patch.verifiedContext === null) delete next.verifiedContext
    else if (patch.verifiedContext) {
      next.verifiedContext = patch.verifiedContext
    }
    if (patch.unavailableTombstone === null) {
      delete next.unavailableTombstone
    } else if (patch.unavailableTombstone) {
      next.unavailableTombstone = patch.unavailableTombstone
    }
    if (next.verifiedContext || next.unavailableTombstone) {
      organizationContextStorageByAccount.set(accountId, next)
      return next
    }
    organizationContextStorageByAccount.delete(accountId)
    return null
  },
  organizationPreviewJoin: async () => {
    previewJoinCallCount += 1
    const request = deferred<PreviewResult>()
    previewRequests.push(request)
    return request.promise
  },
  onDeepLinkNavigate: (
    listener: (navigation: { joinToken?: string }) => void,
  ) => {
    deepLinkNavigateListener = listener
    return () => {
      if (deepLinkNavigateListener === listener) deepLinkNavigateListener = null
    }
  },
  onAdminReauthRequired: subscribe,
  onAppThemeChange: subscribe,
  onLlmConnectionsChanged: subscribe,
  onSessionEvent: subscribe,
  onReconnected: subscribe,
  onMenuNewChat: subscribe,
  onMenuOpenSettings: subscribe,
  onMenuKeyboardShortcuts: subscribe,
  getNotificationsEnabled: async () => true,
  getSystemWarnings: async () => ({}),
  listLlmConnectionsWithStatus: async () => [],
  getAllDrafts: async () => ({}),
  getAppTheme: async () => null,
  getSessions: async () => [],
  getTransportConnectionState: async () => null,
  getWorkspaceSettings: async () => null,
  debugLog: () => {},
}, {
  get(target, property) {
    if (property in target) return target[property as string]
    if (String(property).startsWith('on')) return subscribe
    return async () => undefined
  },
})

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: electronAPI as unknown as Window['electronAPI'],
})

const { act, cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { default: App } = await import('../App')
const { emitAdminAuthFailure } = await import('@/lib/admin-auth-failure')
const {
  getStoredActiveOrganizationId,
  resetOrganizationStorageMemoryForTests,
} = await import('@/lib/organization-storage')

beforeEach(async () => {
  await i18n.changeLanguage('en')
  // eslint-disable-next-line polo-ai/no-localstorage -- isolate the real organization persistence between App integration cases
  localStorage.clear()
  sessionStorage.clear()
  resetOrganizationStorageMemoryForTests()
  organizationContextStorageByAccount = new Map()
  authenticated = false
  currentAccount = account
  activeWorkspaceId = null
  listedOrganizations = []
  previewRequests = []
  previewJoinCallCount = 0
  adminLogoutCallCount = 0
  commonLogoutCallCount = 0
  catalogSyncCallCount = 0
  catalogSyncResult = { success: true }
  pendingAdminLogout = null
  pendingCommonLogout = null
  loginRouteRenderCount = 0
  lastOnboardingFinish = null
  deepLinkNavigateListener = null
})

afterEach(() => {
  cleanup()
})

describe('App deferred organization deep-link wiring', () => {
  it('restores the current invitation through the real login completion entry', async () => {
    const user = userEvent.setup({ document: window.document })
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('login-route')
    expect(deepLinkNavigateListener).not.toBeNull()

    act(() => {
      deepLinkNavigateListener?.({ joinToken: 'login-deferred-token' })
    })
    await waitFor(() => expect(previewJoinCallCount).toBe(1))

    authenticated = true
    await user.click(screen.getByRole('button', { name: 'Complete login' }))
    await waitFor(() => expect(previewJoinCallCount).toBe(2))

    await act(async () => {
      previewRequests[0].resolve(previewResult)
      await previewRequests[0].promise
    })
    expect(screen.getByTestId('login-route')).toBeTruthy()
    expect(screen.queryByTestId('organization-route')).toBeNull()

    act(() => {
      previewRequests[1].resolve(previewResult)
    })

    const organizationRoute = await screen.findByTestId('organization-route')
    expect(organizationRoute.getAttribute('data-flow-state')).toBe('join')
    expect(organizationRoute.textContent).toContain('Deferred Preview Studio')
    expect(screen.queryByTestId('login-route')).toBeNull()
  })

  it('stays in the real login flow when adminLogout wins a deferred preview', async () => {
    authenticated = true
    activeWorkspaceId = 'workspace-1'
    listedOrganizations = [organizationSummary]
    const user = userEvent.setup({ document: window.document })
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('ready-route')
    expect(deepLinkNavigateListener).not.toBeNull()

    act(() => {
      deepLinkNavigateListener?.({ joinToken: 'logout-deferred-token' })
    })
    await waitFor(() => expect(previewJoinCallCount).toBe(1))

    await user.click(screen.getByRole('button', { name: 'Log out' }))
    await screen.findByTestId('login-route')
    expect(adminLogoutCallCount).toBe(1)
    const loginRenderCountAfterLogout = loginRouteRenderCount

    await act(async () => {
      previewRequests[0].resolve(previewResult)
      await previewRequests[0].promise
    })
    expect(screen.getByTestId('login-route')).toBeTruthy()
    expect(screen.queryByTestId('organization-route')).toBeNull()
    expect(loginRouteRenderCount).toBe(loginRenderCountAfterLogout)
  })

  it('keeps the App account context when startup Catalog sync returns organization 403', async () => {
    authenticated = true
    activeWorkspaceId = 'workspace-1'
    listedOrganizations = [organizationSummary]
    catalogSyncResult = {
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Admin request is not permitted',
      status: 403,
    }
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('ready-route')
    await waitFor(() => expect(catalogSyncCallCount).toBe(1))
    expect(screen.queryByTestId('login-route')).toBeNull()
    await waitFor(() => {
      expect(organizationContextStorageByAccount.get(account.userId))
        .toMatchObject({
          verifiedContext: { activeOrganizationId: organization.id },
        })
    })
    expect(getStoredActiveOrganizationId(account.userId)).toBe(organization.id)
  })

  it('clears the App account context for an actual account-disabled failure', async () => {
    authenticated = true
    activeWorkspaceId = 'workspace-1'
    listedOrganizations = [organizationSummary]
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('ready-route')
    await waitFor(() => {
      expect(organizationContextStorageByAccount.get(account.userId))
        .toMatchObject({
          verifiedContext: { activeOrganizationId: organization.id },
        })
    })

    act(() => {
      expect(emitAdminAuthFailure({
        code: 'ACCOUNT_DISABLED',
        status: 403,
      })).toBe(true)
    })

    await screen.findByTestId('login-route')
    expect(screen.queryByTestId('ready-route')).toBeNull()
    await waitFor(() => {
      expect(organizationContextStorageByAccount.get(account.userId))
        .toBeUndefined()
    })
    expect(getStoredActiveOrganizationId(account.userId)).toBeNull()
  })

  it('discards a stale logout continuation after another account logs in', async () => {
    activeWorkspaceId = 'workspace-1'
    listedOrganizations = [organizationSummary]
    const user = userEvent.setup({ document: window.document })
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('login-route')
    authenticated = true
    await user.click(screen.getByRole('button', { name: 'Complete login' }))
    await waitFor(() => {
      expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
        .toBe(account.userId)
    })

    pendingAdminLogout = deferred()
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    await waitFor(() => expect(adminLogoutCallCount).toBe(1))

    currentAccount = replacementAccount
    listedOrganizations = [replacementOrganizationSummary]
    act(() => {
      lastOnboardingFinish?.()
    })
    await waitFor(() => {
      expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
        .toBe(replacementAccount.userId)
    })

    await act(async () => {
      pendingAdminLogout?.resolve({
        success: false,
        errorCode: 'SESSION_CHANGED',
        message: 'Admin session changed',
      })
      await pendingAdminLogout?.promise
    })

    expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
      .toBe(replacementAccount.userId)
    expect(screen.queryByTestId('login-route')).toBeNull()
    expect(organizationContextStorageByAccount.get(replacementAccount.userId))
      .toMatchObject({
        verifiedContext: {
          activeOrganizationId: replacementOrganizationSummary.id,
        },
      })
  })

  it('discards a stale common-reset continuation after another account logs in', async () => {
    activeWorkspaceId = 'workspace-1'
    listedOrganizations = [organizationSummary]
    const user = userEvent.setup({ document: window.document })
    render(createElement(I18nextProvider, { i18n }, createElement(App)))

    await screen.findByTestId('login-route')
    authenticated = true
    await user.click(screen.getByRole('button', { name: 'Complete login' }))
    await waitFor(() => {
      expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
        .toBe(account.userId)
    })

    pendingCommonLogout = deferred()
    await user.click(screen.getByRole('button', { name: 'Reset app' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))
    await waitFor(() => expect(commonLogoutCallCount).toBe(1))

    currentAccount = replacementAccount
    listedOrganizations = [replacementOrganizationSummary]
    act(() => {
      lastOnboardingFinish?.()
    })
    await waitFor(() => {
      expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
        .toBe(replacementAccount.userId)
    })

    await act(async () => {
      pendingCommonLogout?.resolve({
        success: false,
        errorCode: 'SESSION_CHANGED',
        message: 'Admin session changed',
      })
      await pendingCommonLogout?.promise
    })

    expect(screen.getByTestId('ready-route').getAttribute('data-account-id'))
      .toBe(replacementAccount.userId)
    expect(screen.queryByTestId('login-route')).toBeNull()
    expect(organizationContextStorageByAccount.get(replacementAccount.userId))
      .toMatchObject({
        verifiedContext: {
          activeOrganizationId: replacementOrganizationSummary.id,
        },
      })
  })
})
