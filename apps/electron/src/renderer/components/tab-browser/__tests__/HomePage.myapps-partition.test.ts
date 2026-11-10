import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  CatalogLocalAppScope,
  LocalAppBatchStatusRequest,
  LocalAppRuntimeStatus,
} from '@polo-ai/shared/protocol'
import type {
  ElectronAPI,
  ProductSpaceAppInstallState,
  ProductSpaceAppIdentity,
} from '../../../../shared/types'
import { BUILTIN_APP_DEFINITIONS } from '../../../../shared/tab-browser-types'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

/**
 * POO-205 C12 — the 我的应用 partition renders the myapps:list rows DIRECTLY
 * (each row IS a MyAppSummary, the count IS the list length, published reads
 * the row's publishedEntryId), open keys on the member-app id DIRECTLY, and
 * publish/delete route through explicit confirmations that stage nothing on
 * cancel. Real hooks, mocked transport — the same runtime-boundary posture as
 * HomePage.real-hook-runtime-boundary.test.ts.
 */

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

const SCOPE = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  productSpaceId: 'organization-a',
}

type MyAppSummary = import('@polo-ai/shared/protocol').MyAppSummary

let myAppsListResponse: { contractVersion: 1; productSpaceId: string; apps: MyAppSummary[] }
const publishSpy = jest.fn(async (_input: Record<string, unknown>) => ({
  contractVersion: 1,
  catalogEntryId: 'new-entry',
  appId: 'app-1',
  visibility: 'space',
}))
const withdrawSpy = jest.fn(async (_input: Record<string, unknown>) => ({
  contractVersion: 1,
  appId: 'app-1',
  visibility: 'member',
}))
const deleteSpy = jest.fn(async (_input: Record<string, unknown>) => ({ contractVersion: 1, appId: 'app-1', deleted: true }))
const resolveLaunchSpy = jest.fn(async (_organizationId: string, appId: string) => ({
  success: true as const,
  launch: {
    contractVersion: 1,
    productSpaceId: SCOPE.productSpaceId,
    catalogEntryId: appId,
    resolvedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    subject: {
      kind: 'artifact_instance' as const,
      artifactType: 'app' as const,
      artifactInstanceId: `artifact-${appId}`,
      versionId: 'version-1',
      version: '1.2.3',
    },
    payer: { kind: 'organization' as const, organizationId: SCOPE.productSpaceId },
    delivery: {
      kind: 'bundle' as const,
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 10,
      runtime: 'static' as const,
    },
  },
}))
const adminGetStatus = jest.fn(async () => ({
  expiresAt: Date.now() + 3_600_000,
  userId: SCOPE.accountId,
  username: SCOPE.accountId,
}))

function myAppRow(input: { appId: string; name: string; publishedEntryId?: string }): MyAppSummary {
  return {
    appId: input.appId,
    name: input.name,
    description: '',
    ownerAccountId: SCOPE.accountId,
    runtime: 'static',
    publishedEntryId: input.publishedEntryId ?? null,
    publishedAt: input.publishedEntryId ? '2026-01-01T00:00:00.000Z' : null,
    version: '1.2.3',
    sizeBytes: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

// One shared directory entry (an admin-imported work App), so the page has a
// shared grid AND a my-apps partition — the C11 merged-vacuum path stays out
// of the way.
function rawCatalogResponse() {
  return {
    success: true as const,
    notModified: false as const,
    catalogRevision: 'rev-myapps-partition',
    productSpaceId: SCOPE.productSpaceId,
    accessMode: 'online' as const,
    entries: [{
      kind: 'app' as const,
      catalogEntryId: 'catalog-entry-shared',
      artifactInstanceId: 'artifact-shared',
      version: { versionId: 'version-shared', version: '1.2.3' },
      name: 'Shared Work App',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Organization A' }],
      permissions: [],
    }],
    withdrawnEntries: [],
  }
}

beforeEach(() => {
  publishSpy.mockClear()
  withdrawSpy.mockClear()
  deleteSpy.mockClear()
  resolveLaunchSpy.mockClear()
  adminGetStatus.mockClear()
  // THREE rows: one published (publishedEntryId set on the ROW), two not —
  // the badge/withdraw flip must read the row, not a catalog pairing.
  myAppsListResponse = {
    contractVersion: 1,
    productSpaceId: SCOPE.productSpaceId,
    apps: [
      myAppRow({ appId: 'app-1', name: 'Canvas One', publishedEntryId: 'catalog-entry-pub' }),
      myAppRow({ appId: 'app-2', name: 'Canvas Two' }),
      myAppRow({ appId: 'app-3', name: 'Canvas Three' }),
    ],
  }

  const localAppsApi: Partial<ElectronAPI['localApps']> = {
    getHostInfo: async () => ({ platform: 'darwin' as const, arch: 'arm64' as const }),
    getProductSpaceInstallStates: async (apps: ProductSpaceAppIdentity[]) => apps.map(app => ({
      app,
      state: 'installed' as const,
      currentVersion: '1.2.3',
    })),
    getProductSpaceWithdrawnInstallStates: async (apps: ProductSpaceAppIdentity[]) => apps.map(app => ({
      app,
      state: 'not_installed' as const,
    })),
    getRuntimeStatuses: (_request: LocalAppBatchStatusRequest) => {
      void _request
      return Promise.resolve<LocalAppRuntimeStatus[]>([])
    },
    getRuntimeStatus: (scope: CatalogLocalAppScope) => Promise.resolve<LocalAppRuntimeStatus>({
      appId: scope.catalogAppId,
      scope,
      status: 'not_installed',
    }),
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeQuickAccess: async () => [],
      setHomeQuickAccess: async (_contextKey: string, apps: unknown[]) => apps,
      adminGetStatus,
      productSpaceGetCatalog: async () => rawCatalogResponse(),
      productSpaceResolveLaunch: (...args: Parameters<typeof resolveLaunchSpy>) => resolveLaunchSpy(...args),
      localApps: localAppsApi,
      myAppsList: async () => myAppsListResponse,
      myAppsPublish: (...args: Parameters<typeof publishSpy>) => publishSpy(...args),
      myAppsWithdraw: (...args: Parameters<typeof withdrawSpy>) => withdrawSpy(...args),
      myAppsDelete: (...args: Parameters<typeof deleteSpy>) => deleteSpy(...args),
    },
  })
  return i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

// useMyApps reads the committed scope's workspaceId through the optional
// app-shell context — a null context deades the whole partition (scope gap).
// The factory must carry the module's FULL export face (other consumers in
// the page tree import the remaining hooks).
mock.module('@/context/AppShellContext', () => ({
  AppShellProvider: ({ children }: { children?: unknown }) => children ?? null,
  useOptionalAppShellContext: () => ({ activeWorkspaceId: SCOPE.workspaceId }),
  useAppShellContext: () => ({ activeWorkspaceId: SCOPE.workspaceId }),
  useSession: () => null,
  useActiveWorkspace: () => null,
  usePendingPermission: () => undefined,
  usePendingCredential: () => undefined,
}))

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps: [...BUILTIN_APP_DEFINITIONS],
    openApp: jest.fn(),
    removeApp: async () => {},
  }),
}))

mock.module('@/lib/product-space-app-launch-handoff', () => ({
  createProductSpaceLaunchHandoffStore: () => ({
    publish: () => ({ handoffId: 'test-handoff' }),
    take: () => null,
    onLaunch: () => () => {},
    commitContext: () => {},
    dispose: () => {},
  }),
}))

mock.module('sonner', () => ({
  toast: {
    error: () => {},
    success: () => {},
  },
}))

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')
const { HomePage } = await import('../HomePage')

function spaceContextValue(kind: 'enterprise' | 'personal') {
  return {
    accountId: SCOPE.accountId,
    activeProductSpaceId: SCOPE.productSpaceId,
    activeProductSpace: {
      id: SCOPE.productSpaceId,
      kind,
      name: kind === 'enterprise' ? 'Organization A' : 'Personal',
    },
    productSpaces: [],
    allProductSpaces: [],
    personalProductSpaceId: SCOPE.productSpaceId,
    productSpaceContextKey: `${SCOPE.accountId}|${SCOPE.productSpaceId}`,
    contextVersion: 7,
    pendingSwitch: null,
    onSelectProductSpace: () => {},
    onRefreshProductSpaces: () => {},
    onConfirmStopAndSwitch: () => {},
    onRetryFailedStops: () => {},
    onRetryTargetLoad: () => {},
    onCancelSwitch: () => {},
    onDismissTargetAccessLost: () => {},
    onStopSwitchExecution: () => {},
  }
}

async function renderHome(kind: 'enterprise' | 'personal' = 'enterprise') {
  const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')
  const tree = createElement(
    ProductSpaceProvider,
    {
      value: spaceContextValue(kind) as never,
      children: createElement(
        I18nextProvider,
        { i18n },
        createElement(MemberCatalogProvider, null, createElement(HomePage)),
      ),
    },
  )
  render(tree)
  await waitFor(() => {
    if (!screen.getByTestId('home-my-apps')) throw new Error('my-apps partition not mounted')
  })
  // The partition renders as soon as the LIST loaded (scope gate), even while
  // the shared catalog is still hydrating.
  await waitFor(() => {
    if (screen.getAllByTestId('home-myapp-card').length !== 3) throw new Error('rows not rendered')
  })
}

describe('HomePage 我的应用 partition × C12 (list is the single source)', () => {
  it('renders N list rows with the count N, keyed by appId, badges read the row', async () => {
    await renderHome()
    // The count badge IS the list length — never a catalog-correlated count.
    expect(screen.getByTestId('home-my-apps').textContent).toContain('3')
    expect(screen.getAllByTestId('home-myapp-card')).toHaveLength(3)

    // Row testids key on the member-app id.
    expect(screen.getByTestId('home-myapp-open-app-1')).toBeTruthy()
    expect(screen.getByTestId('home-myapp-open-app-2')).toBeTruthy()
    expect(screen.getByTestId('home-myapp-open-app-3')).toBeTruthy()

    // app-1 carries publishedEntryId ON THE ROW → published badge + withdraw,
    // no publish entry; the unpublished rows flip the other way.
    expect(screen.getByTestId('home-myapp-badge-app-1').textContent).toBe('Published')
    expect(screen.getByTestId('home-myapp-withdraw-app-1')).toBeTruthy()
    expect(screen.queryByTestId('home-myapp-publish-app-1')).toBeNull()
    expect(screen.getByTestId('home-myapp-badge-app-2').textContent).toBe('Not published')
    expect(screen.getByTestId('home-myapp-publish-app-2')).toBeTruthy()
    expect(screen.queryByTestId('home-myapp-withdraw-app-2')).toBeNull()
  })

  it('opens by the member-app id DIRECTLY (resolve-launch receives the appId)', async () => {
    await renderHome()
    await act(async () => {
      fireEvent.click(screen.getByTestId('home-myapp-open-app-2'))
    })
    await waitFor(() => {
      if (resolveLaunchSpy.mock.calls.length === 0) throw new Error('resolve-launch not called')
    })
    expect(resolveLaunchSpy.mock.calls[0]).toEqual([SCOPE.productSpaceId, 'app-2'])
    // No install confirmation staged: the fixture installs the granted version.
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(publishSpy).not.toHaveBeenCalled()
  })

  it('publish routes through the confirmation; cancel stages nothing', async () => {
    await renderHome()
    fireEvent.click(screen.getByTestId('home-myapp-publish-app-2'))
    // The dialog appears with the app name; the wire is still untouched.
    expect(screen.getByTestId('home-myapp-publish-confirm-title').textContent).toContain('Canvas Two')
    expect(publishSpy).not.toHaveBeenCalled()
    // Cancel: dialog closes, NO RPC.
    fireEvent.click(screen.getByTestId('home-myapp-publish-confirm-cancel'))
    await waitFor(() => {
      if (screen.queryByTestId('home-myapp-publish-confirm-title')) throw new Error('dialog not closed')
    })
    expect(publishSpy).not.toHaveBeenCalled()
    // Re-open and CONFIRM: exactly one publish for the staged appId.
    fireEvent.click(screen.getByTestId('home-myapp-publish-app-2'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('home-myapp-publish-confirm-action'))
    })
    await waitFor(() => {
      if (publishSpy.mock.calls.length === 0) throw new Error('publish not called')
    })
    expect(publishSpy.mock.calls[0][0]).toMatchObject({
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      productSpaceId: SCOPE.productSpaceId,
      appId: 'app-2',
    })
  })

  it('delete routes through the confirmation; a published row names the shared-directory consequence', async () => {
    await renderHome()
    // CANCEL path on the unpublished row: dialog appears, cancel, no RPC.
    fireEvent.click(screen.getByTestId('home-myapp-delete-app-2'))
    expect(screen.getByTestId('home-myapp-delete-confirm-title').textContent).toContain('Canvas Two')
    expect(deleteSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('home-myapp-delete-confirm-cancel'))
    await waitFor(() => {
      if (screen.queryByTestId('home-myapp-delete-confirm-title')) throw new Error('dialog not closed')
    })
    expect(deleteSpy).not.toHaveBeenCalled()

    // CONFIRM path on the PUBLISHED row: the body must speak the withdrawal
    // consequence (the admin transaction removes the shared entry too).
    fireEvent.click(screen.getByTestId('home-myapp-delete-app-1'))
    const body = screen.getByTestId('home-myapp-delete-confirm-body')
    expect(body.textContent).not.toBe(screen.queryByTestId('home-myapp-delete-confirm-title')!.textContent)
    expect(body.textContent.length).toBeGreaterThan(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('home-myapp-delete-confirm-action'))
    })
    await waitFor(() => {
      if (deleteSpy.mock.calls.length === 0) throw new Error('delete not called')
    })
    expect(deleteSpy.mock.calls[0][0]).toMatchObject({
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      productSpaceId: SCOPE.productSpaceId,
      appId: 'app-1',
    })
  })

  it('renders the partition in a PERSONAL space (rows visible, no publish entries)', async () => {
    await renderHome('personal')
    expect(screen.getAllByTestId('home-myapp-card')).toHaveLength(3)
    // Publish is enterprise-only — and it stays hidden even for the row the
    // admin wire would refuse anyway.
    expect(screen.queryByTestId('home-myapp-publish-app-2')).toBeNull()
    expect(screen.queryByTestId('home-myapp-publish-app-3')).toBeNull()
    // Open and delete stay available in personal spaces.
    expect(screen.getByTestId('home-myapp-open-app-2')).toBeTruthy()
    expect(screen.getByTestId('home-myapp-delete-app-2')).toBeTruthy()
  })
})
