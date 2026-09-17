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
import {
  BUILTIN_APP_DEFINITIONS,
} from '../../../../shared/tab-browser-types'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

// Register only when no window exists yet (shared bun test process): another
// test file may have registered Happy DOM first — see
// TopBar.registry-poller.test.ts for the same shared-process pattern.
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

// The runtime-status spies are typed from the REAL Electron API members —
// the production contracts `ElectronAPI['localApps']['getRuntimeStatuses']`
// and `ElectronAPI['localApps']['getRuntimeStatus']` — so a signature drift
// or an `any`-erased stub can never mask a boundary breach. BOTH the plural
// and the singular member are counted: neither may be an uncounted stub.
type GetRuntimeStatuses = ElectronAPI['localApps']['getRuntimeStatuses']
type GetRuntimeStatus = ElectronAPI['localApps']['getRuntimeStatus']
let runtimeStatusesCalls = 0
let runtimeStatusCalls = 0
const getRuntimeStatusesSpy: GetRuntimeStatuses = (request: LocalAppBatchStatusRequest) => {
  runtimeStatusesCalls += 1
  void request
  return Promise.resolve<LocalAppRuntimeStatus[]>([])
}
const getRuntimeStatusSpy: GetRuntimeStatus = (scope: CatalogLocalAppScope) => {
  runtimeStatusCalls += 1
  void scope
  return Promise.resolve<LocalAppRuntimeStatus>({
    appId: scope.catalogAppId,
    scope,
    status: 'not_installed',
  })
}

const openApp = jest.fn()
const adminGetStatus = jest.fn(async () => ({
  expiresAt: Date.now() + 3_600_000,
  userId: 'account-a',
  username: 'account-a',
}))
const openUrl = jest.fn()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

// Explicit barriers: the gated catalog response and the gated install-state
// IPC make hydration deterministic (event-driven, never elapsed-time waits).
let releaseCatalog!: (response: unknown) => void
let releaseInstallStates!: (states: ProductSpaceAppInstallState[]) => void
let lastInstallStatesRequest: ProductSpaceAppIdentity[] | null = null

function rawCatalogResponse() {
  return {
    success: true as const,
    notModified: false as const,
    catalogRevision: 'rev-real-hook-boundary',
    productSpaceId: 'organization-a',
    accessMode: 'online' as const,
    entries: [{
      kind: 'app' as const,
      catalogEntryId: 'catalog-entry-real',
      artifactInstanceId: 'artifact-instance-real',
      version: { versionId: 'version-real', version: '1.2.3' },
      name: 'Real Hook Boundary App',
      description: '',
      availability: 'available' as const,
      sources: [{ kind: 'enterprise_import' as const, name: 'Organization A' }],
      permissions: ['camera'],
    }],
    withdrawnEntries: [],
  }
}

beforeEach(() => {
  runtimeStatusesCalls = 0
  runtimeStatusCalls = 0
  openApp.mockClear()
  adminGetStatus.mockClear()
  openUrl.mockClear()
  lastInstallStatesRequest = null
  const catalogGate = deferred<unknown>()
  releaseCatalog = catalogGate.resolve
  const installStatesGate = deferred<ProductSpaceAppInstallState[]>()
  releaseInstallStates = installStatesGate.resolve

  const localAppsApi: Partial<ElectronAPI['localApps']> = {
    getHostInfo: async () => ({ platform: 'darwin' as const, arch: 'arm64' as const }),
    // The production hook compares the echoed identity against its own
    // sealed identity verbatim — echoing `app` unchanged is REQUIRED.
    getProductSpaceInstallStates: (apps: ProductSpaceAppIdentity[]) => {
      lastInstallStatesRequest = apps
      return installStatesGate.promise.then(() => apps.map(app => ({
        app,
        state: 'installed' as const,
        currentVersion: '1.2.3',
      })))
    },
    getProductSpaceWithdrawnInstallStates: async (
      apps: ProductSpaceAppIdentity[],
    ): Promise<ProductSpaceAppInstallState[]> => apps.map(app => ({
      app,
      state: 'not_installed' as const,
    })),
    getRuntimeStatuses: getRuntimeStatusesSpy,
    getRuntimeStatus: getRuntimeStatusSpy,
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeQuickAccess: async () => [],
      setHomeQuickAccess: async (_contextKey: string, apps: unknown[]) => apps,
      adminGetStatus,
      openUrl,
      productSpaceGetCatalog: () => catalogGate.promise,
      localApps: localAppsApi,
    },
  })
  return i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps: [...BUILTIN_APP_DEFINITIONS],
    openApp,
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

describe('HomePage × production useAppCatalog runtime boundary (POO-43 / POO-47)', () => {
  it('mounts Home on the REAL useAppCatalog hook and never issues localApps.getRuntimeStatuses', async () => {
    const contextValue = {
      accountId: 'account-a',
      activeProductSpaceId: 'organization-a',
      activeProductSpace: { id: 'organization-a', kind: 'enterprise', name: 'Organization A' },
      productSpaces: [],
      allProductSpaces: [],
      personalProductSpaceId: 'organization-a',
      productSpaceContextKey: 'account-a|organization-a',
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
    const tree = createElement(
      ProductSpaceProvider,
      {
        value: contextValue as never,
        children: createElement(I18nextProvider, { i18n }, createElement(HomePage)),
      },
    )

    render(tree)
    // Home rendered on the production hook (Polo assistant entry always).
    await waitFor(() => {
      if (!screen.getByTestId('home-quick-entry-polo')) throw new Error('Home not mounted')
    })
    // Zero runtime-status IPC so far (mount + activation).
    expectRuntimeBoundaryIntact()

    // Explicit CATALOG barrier: release the gated real productSpaceGetCatalog
    // response and wait until the production hook hydrated the page.
    releaseCatalog!(rawCatalogResponse())
    await waitFor(() => {
      if (!screen.getByTestId('home-all-apps-open')) throw new Error('catalog not hydrated')
    })
    expectRuntimeBoundaryIntact()

    // Interaction: open the all-apps view driven by the SAME production hook.
    fireEvent.click(screen.getByTestId('home-all-apps-open'))
    await waitFor(() => {
      if (!screen.getByTestId('all-apps-row')) throw new Error('all-apps rows pending')
    })

    // Explicit INSTALL-STATE barrier: the production hook issued the
    // install-state IPC with a sealed identity, the gated IPC resolves, and
    // the reconciled 'Installed' status becomes visible.
    await waitFor(() => {
      if (lastInstallStatesRequest !== null) return undefined
      throw new Error('install-state IPC not requested')
    })
    expect((lastInstallStatesRequest as ProductSpaceAppIdentity[]).length).toBe(1)
    expect((lastInstallStatesRequest as ProductSpaceAppIdentity[])[0]!.sources).toEqual([
      { kind: 'enterprise_import', name: 'Organization A', circleId: null },
    ])
    expect((lastInstallStatesRequest as ProductSpaceAppIdentity[])[0]!.availability).toBe('available')
    releaseInstallStates!([])
    await act(async () => {})
    await waitFor(() => {
      if (!screen.getByText('Installed')) throw new Error('install states not reconciled')
    })
    expectRuntimeBoundaryIntact()

    // Interaction: search filter and navigation back to Home.
    fireEvent.change(screen.getByTestId('all-apps-search'), { target: { value: 'Real Hook' } })
    fireEvent.click(screen.getByTestId('all-apps-back'))
    await waitFor(() => {
      if (!screen.getByTestId('home-all-apps-open')) throw new Error('back navigation pending')
    })

    // THE BOUNDARY, asserted at EVERY stage: NEITHER production
    // runtime-status IPC member (plural batch NOR singular per-scope) was
    // ever called through any render, barrier or interaction, and no
    // running badge exists.
    expectRuntimeBoundaryIntact()
    expect(screen.queryByText('Running')).toBeNull()
  })
})

function expectRuntimeBoundaryIntact(): void {
  expect(runtimeStatusesCalls).toBe(0)
  expect(runtimeStatusCalls).toBe(0)
}
