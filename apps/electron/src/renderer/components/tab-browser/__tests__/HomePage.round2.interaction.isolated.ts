import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  DeniedAppCatalogSnapshot,
} from '@polo-ai/shared/admin'
import { createLocalAppScopeKey } from '@polo-ai/shared/protocol'
import {
  BUILTIN_APP_DEFINITIONS,
} from '../../../../shared/tab-browser-types'
import {
  KEYS,
  set as setLocalStorage,
} from '@/lib/local-storage'
import { createOrganizationContextKey } from '@/lib/organization-storage'

GlobalRegistrator.register()
setupI18n()

const openApp = jest.fn()
const removeApp = jest.fn(async () => {})
let appCatalogHook: any
let installedApps = [...BUILTIN_APP_DEFINITIONS]
const homeRecentAppsByContext = new Map<string, any[]>()
const getHomeRecentApps = jest.fn(async (contextKey: string) =>
  homeRecentAppsByContext.get(contextKey) ?? [])
const setHomeRecentApps = jest.fn(async (contextKey: string, apps: any[]) => {
  homeRecentAppsByContext.set(contextKey, apps)
  return apps
})

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function signedOutCatalogHook() {
  return {
    organization: null,
    state: {
      catalog: null,
      loading: false,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      statusErrorCode: null,
      statusErrorScopeKeys: {},
      statusLoadingScopeKeys: {},
      accessMode: null,
      statuses: {},
      host: null,
    },
    sync: async () => {},
    install: async () => {},
    start: async () => ({
      appId: 'unused',
      version: '1.0.0',
      url: 'http://127.0.0.1:1',
      port: 1,
    }),
    stop: async () => {},
    uninstall: async () => {},
    cancelInstall: async () => {},
    getLogs: async () => '',
    resolveRemoteUrl: async () => 'https://trusted.example.com',
    getStatus: () => undefined,
    scopeKeyForApp: () => 'unused',
    refreshRuntimeStatuses: async () => {},
  }
}

appCatalogHook = signedOutCatalogHook()

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps,
    openApp,
    removeApp,
  }),
}))

mock.module('@/hooks/useAppCatalog', () => ({
  useAppCatalog: () => appCatalogHook,
}))

const {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} = await import('@testing-library/react')
const { formatBytes, HomePage } = await import('../HomePage')
const {
  catalogStateMessage,
  homeAppOperationErrorText,
} = await import('@/lib/home-app-errors')

beforeEach(async () => {
  localStorage.clear()
  openApp.mockClear()
  removeApp.mockClear()
  appCatalogHook = signedOutCatalogHook()
  installedApps = [...BUILTIN_APP_DEFINITIONS]
  homeRecentAppsByContext.clear()
  getHomeRecentApps.mockClear()
  setHomeRecentApps.mockClear()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeRecentApps,
      setHomeRecentApps,
    },
  })
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('HomePage round-two regressions', () => {
  it('shows a labeled built-in launcher for a signed-out fresh or cleared profile', () => {
    localStorage.setItem('polo-home-recent-apps', JSON.stringify([{
      id: 'old-app',
      kind: 'external',
      openedAt: 1,
    }]))
    localStorage.clear()

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(screen.getByTestId('builtin-app-launcher')).toBeTruthy()
    expect(screen.getByText('Built-in apps')).toBeTruthy()
    expect(screen.getByText('Pro Buddy')).toBeTruthy()
    expect(screen.queryByText('Kanban')).toBeNull()
    expect(screen.queryByText('AirDrop')).toBeNull()

    fireEvent.click(screen.getByText('Pro Buddy'))
    expect(openApp).toHaveBeenCalledWith(BUILTIN_APP_DEFINITIONS[0])
  })

  it('migrates recents to preferences while keeping Pro Buddy discoverable', async () => {
    installedApps = [
      ...BUILTIN_APP_DEFINITIONS,
      {
        id: 'external-recent',
        name: 'External Recent',
        url: 'https://external.example.com',
        type: 'webapp',
        createdAt: 1,
        order: 3,
      },
    ]
    setLocalStorage(KEYS.homeRecentApps, [
      {
        id: 'external-recent',
        kind: 'external',
        openedAt: 1,
      },
    ])

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    await waitFor(() => {
      expect(setHomeRecentApps).toHaveBeenCalledTimes(1)
    })
    expect(localStorage.getItem('craft-home-recent-apps')).toBeNull()
    const launcher = screen.getByTestId('builtin-app-launcher')
    expect(within(launcher).getByText('Pro Buddy')).toBeTruthy()
    expect(screen.queryByText('Kanban')).toBeNull()
    expect(screen.queryByText('AirDrop')).toBeNull()

    fireEvent.click(within(launcher).getByText('Pro Buddy'))
    expect(openApp).toHaveBeenCalledWith(BUILTIN_APP_DEFINITIONS[0])
  })

  it('does not let delayed hydration overwrite newer same-context recents', async () => {
    const externalA = {
      id: 'external-a',
      name: 'External A',
      url: 'https://external-a.example.com',
      type: 'webapp' as const,
      createdAt: 1,
      order: 1,
    }
    const externalB = {
      id: 'external-b',
      name: 'External B',
      url: 'https://external-b.example.com',
      type: 'webapp' as const,
      createdAt: 2,
      order: 2,
    }
    installedApps = [...BUILTIN_APP_DEFINITIONS, externalA, externalB]
    const hydration = createDeferred<any[]>()
    getHomeRecentApps.mockImplementationOnce(() => hydration.promise)

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))
    await waitFor(() => {
      expect(getHomeRecentApps).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByText('Pro Buddy'))
    fireEvent.click(screen.getByText('External A'))
    await waitFor(() => {
      expect(setHomeRecentApps).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      hydration.resolve([{
        id: externalB.id,
        kind: 'external',
        openedAt: 1,
      }])
      await hydration.promise
    })

    expect(screen.queryByTestId('builtin-app-launcher')).toBeNull()
    expect(screen.getByText('Pro Buddy')).toBeTruthy()
    expect(screen.queryByText('Kanban')).toBeNull()
    expect(screen.queryByText('AirDrop')).toBeNull()
    fireEvent.click(screen.getByText('External B'))

    await waitFor(() => {
      expect(setHomeRecentApps).toHaveBeenCalledTimes(3)
    })
    const persisted = [...homeRecentAppsByContext.values()][0]!
    expect(persisted.map(app => app.id)).toEqual([
      externalB.id,
      externalA.id,
      BUILTIN_APP_DEFINITIONS[0]!.id,
    ])
  })

  it('maps operation and catalog codes through the active non-English locale', async () => {
    await i18n.changeLanguage('zh-Hans')
    const secret = 'backend stack detail must stay hidden'

    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'START_FAILED', message: secret },
      'open',
    )).toBe('无法打开应用。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'UNINSTALL_FAILED', message: secret },
      'uninstall',
    )).toBe('无法卸载应用。')
    expect(homeAppOperationErrorText(
      i18n.t.bind(i18n),
      { code: 'RELEASE_CHANGED', message: secret },
      'install',
    )).toBe('应用发布版本已变更，请确认更新后的版本再安装。')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'NETWORK_ERROR',
      'warning',
    )).toContain('离线')
    expect(catalogStateMessage(
      i18n.t.bind(i18n),
      'INVALID_SEMVER',
      'warning',
    )).not.toContain(secret)
  })

  it('formats install sizes through locale unit keys', async () => {
    await i18n.changeLanguage('en')
    expect(formatBytes(i18n.t.bind(i18n), 512)).toBe('512 B')
    expect(formatBytes(i18n.t.bind(i18n), 1024 ** 3)).toBe('1.0 GB')

    await i18n.changeLanguage('zh-Hans')
    expect(formatBytes(i18n.t.bind(i18n), 512)).toBe('512 字节')
    expect(formatBytes(i18n.t.bind(i18n), 1024 ** 2)).toBe('1.0 MB')

    await i18n.changeLanguage('de')
    expect(formatBytes(i18n.t.bind(i18n), 1)).toBe('1 Byte')
  })

  it('revalidates a stale remote URL through main before opening a WebView', async () => {
    const remoteApp: CatalogApp = {
      id: 'remote-app',
      organizationId: 'organization-a',
      name: 'Remote App',
      description: '',
      deliveryMode: 'remote_url',
      remoteUrl: 'https://stale.example.com',
      sortOrder: 0,
      availability: 'available',
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'v1',
      authorizationStatus: 'authorized',
      apps: [remoteApp],
      syncedAt: 1,
    }
    const resolveRemoteUrl = jest.fn(async () => {
      throw new Error('NOT_AUTHORIZED')
    })
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: 'account-a',
        activeOrganizationId: 'organization-a',
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: 'organization-a',
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
      },
      resolveRemoteUrl,
      scopeKeyForApp: () => createLocalAppScopeKey({
        kind: 'catalog',
        accountId: 'account-a',
        organizationId: 'organization-a',
        catalogAppId: remoteApp.id,
      }),
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))
    fireEvent.click(screen.getByTestId('organization-app-action-remote-app'))

    await waitFor(() => {
      expect(resolveRemoteUrl).toHaveBeenCalledWith(remoteApp)
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('shows a retry action when a runtime-status batch cannot be read', () => {
    const localApp: CatalogApp = {
      id: 'unknown-status-app',
      organizationId: 'organization-a',
      name: 'Unknown Status App',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'v1',
      authorizationStatus: 'authorized',
      apps: [localApp],
      syncedAt: 1,
    }
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: localApp.id,
    })
    const refreshRuntimeStatuses = jest.fn(async () => {})
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: 'account-a',
        activeOrganizationId: 'organization-a',
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: 'organization-a',
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
        statusErrorCode: 'status_read_failed',
        statusErrorScopeKeys: { [scopeKey]: true },
      },
      refreshRuntimeStatuses,
      scopeKeyForApp: () => scopeKey,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(screen.getByText('Some app statuses could not be refreshed.')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.getByTestId('organization-app-action-unknown-status-app')
      .hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText('Try again'))
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1)
  })

  it('disables install while the initial runtime status is loading', () => {
    const localApp: CatalogApp = {
      id: 'loading-status-app',
      organizationId: 'organization-a',
      name: 'Loading Status App',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'v1',
      authorizationStatus: 'authorized',
      apps: [localApp],
      syncedAt: 1,
    }
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: localApp.id,
    })
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: catalog.accountId,
        activeOrganizationId: catalog.organizationId,
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: catalog.organizationId,
          type: 'enterprise_workspace',
          name: 'Organization A',
          purpose: '',
          status: 'suspended',
          membership: {
            id: 'membership-denied',
            role: 'member',
            status: 'removed',
          },
          memberCount: 1,
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
        statusLoadingScopeKeys: { [scopeKey]: true },
      },
      scopeKeyForApp: () => scopeKey,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(screen.getAllByText('Loading status…')).toHaveLength(2)
    expect(screen.getByTestId('organization-app-action-loading-status-app')
      .hasAttribute('disabled')).toBe(true)
  })

  it('keeps a retained withdrawn app manageable when its first status batch fails', async () => {
    const withdrawnApp: CatalogApp = {
      id: 'retained-withdrawn',
      organizationId: 'organization-a',
      name: 'Retained Withdrawn',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'withdrawn',
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'v1',
      authorizationStatus: 'authorized',
      apps: [],
      withdrawnApps: [withdrawnApp],
      syncedAt: 1,
    }
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: withdrawnApp.id,
    })
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: 'account-a',
        activeOrganizationId: 'organization-a',
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: 'organization-a',
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
        statusErrorCode: 'status_read_failed',
        statusErrorScopeKeys: { [scopeKey]: true },
      },
      scopeKeyForApp: () => scopeKey,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(screen.getByTestId('organization-app-retained-withdrawn')).toBeTruthy()
    expect(screen.getByText('Status unavailable')).toBeTruthy()
    expect(screen.getByTestId('organization-app-action-retained-withdrawn')
      .hasAttribute('disabled')).toBe(true)
    const management = screen.getByLabelText(
      'More actions for Retained Withdrawn',
    )
    expect(management).toBeTruthy()
    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => {
      expect(screen.getByText('Uninstall')).toBeTruthy()
      expect(screen.getByText('Stop')).toBeTruthy()
      expect(screen.queryByText('View logs')).toBeNull()
    })
  })

  it('keeps an installed app manageable from a denied NETWORK_ERROR cold snapshot', async () => {
    const deniedApp = {
      id: 'denied-installed',
      organizationId: 'organization-a',
      name: 'Denied Installed',
      description: '',
      deliveryMode: 'local_bundle' as const,
      sortOrder: 0,
      availability: 'unavailable' as const,
    }
    const catalog: DeniedAppCatalogSnapshot = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'denied',
      authorizationStatus: 'denied',
      apps: [deniedApp],
      syncedAt: 1,
    }
    const scopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: deniedApp.id,
    })
    const status = {
      appId: deniedApp.id,
      scope: {
        kind: 'catalog' as const,
        accountId: catalog.accountId,
        organizationId: catalog.organizationId,
        catalogAppId: deniedApp.id,
      },
      status: 'running' as const,
      currentVersion: '1.0.0',
      runningVersion: '1.0.0',
    }
    const stop = jest.fn(async () => {})
    const uninstall = jest.fn(async () => {})
    const getLogs = jest.fn(async () => 'retained log output')
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: catalog.accountId,
        activeOrganizationId: catalog.organizationId,
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: catalog.organizationId,
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'denied',
        errorCode: 'NETWORK_ERROR',
        statuses: { [scopeKey]: status },
      },
      getStatus: () => status,
      scopeKeyForApp: () => scopeKey,
      stop,
      uninstall,
      getLogs,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(screen.getByText('Denied Installed')).toBeTruthy()
    expect(screen.getByText('Access removed by your organization')).toBeTruthy()
    expect(screen.getByTestId('organization-app-action-denied-installed')
      .hasAttribute('disabled')).toBe(true)

    const management = screen.getByLabelText('More actions for Denied Installed')
    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => {
      expect(screen.getByText('Stop')).toBeTruthy()
      expect(screen.getByText('Uninstall')).toBeTruthy()
      expect(screen.getByText('View logs')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('View logs'))
    await waitFor(() => {
      expect(screen.getByText('retained log output')).toBeTruthy()
    })
    expect(getLogs).toHaveBeenCalledWith(deniedApp)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy())
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith(deniedApp)
    })
  })

  it('shows retained log management for denied and withdrawn installed-like states', async () => {
    for (const availability of ['unavailable', 'withdrawn'] as const) {
      for (
        const runtimeStatus of [
          'installed',
          'running',
          'stopped',
          'broken',
          'update_available',
        ] as const
      ) {
        const retainedApp: CatalogApp = {
          id: `${availability}-${runtimeStatus}`,
          organizationId: 'organization-a',
          name: `${availability} ${runtimeStatus}`,
          description: '',
          deliveryMode: 'local_bundle',
          sortOrder: 0,
          availability,
        }
        const catalog: AppCatalogCacheEntry = {
          accountId: 'account-a',
          organizationId: 'organization-a',
          appConfigVersion: 'retained-logs',
          authorizationStatus: availability === 'unavailable'
            ? 'denied'
            : 'authorized',
          apps: availability === 'unavailable' ? [retainedApp] : [],
          withdrawnApps: availability === 'withdrawn' ? [retainedApp] : [],
          syncedAt: 1,
        }
        const status = {
          appId: retainedApp.id,
          scope: {
            kind: 'catalog' as const,
            accountId: catalog.accountId,
            organizationId: catalog.organizationId,
            catalogAppId: retainedApp.id,
          },
          status: runtimeStatus,
          currentVersion: '1.0.0',
        }
        const scopeKey = createLocalAppScopeKey(status.scope)
        appCatalogHook = {
          ...signedOutCatalogHook(),
          organization: {
            accountId: catalog.accountId,
            activeOrganizationId: catalog.organizationId,
            organizationContextKey: createOrganizationContextKey(
              catalog.accountId,
              catalog.organizationId,
            ),
            organizationSummaries: [{
              id: catalog.organizationId,
              type: 'enterprise',
              name: 'Organization A',
            }],
          },
          state: {
            ...signedOutCatalogHook().state,
            catalog,
            accessMode: availability === 'unavailable' ? 'denied' : 'online',
            statuses: { [scopeKey]: status },
          },
          getStatus: () => status,
          scopeKeyForApp: () => scopeKey,
          getLogs: jest.fn(async () => 'retained logs'),
        }

        render(createElement(
          I18nextProvider,
          { i18n },
          createElement(HomePage, { onAddApp: () => {} }),
        ))
        const management = screen.getByLabelText(
          `More actions for ${retainedApp.name}`,
        )
        fireEvent.pointerDown(management, { button: 0, ctrlKey: false })
        await waitFor(() => {
          expect(screen.getByText('View logs')).toBeTruthy()
        })
        cleanup()
      }
    }
  })

  it('keeps deferred log results isolated by full App scope and request generation', async () => {
    const appA: CatalogApp = {
      id: 'broken-app-a',
      organizationId: 'organization-a',
      name: 'Broken App A',
      description: '',
      deliveryMode: 'local_bundle',
      sortOrder: 0,
      availability: 'available',
    }
    const appB: CatalogApp = {
      ...appA,
      id: 'broken-app-b',
      name: 'Broken App B',
      sortOrder: 1,
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'logs-race',
      authorizationStatus: 'authorized',
      apps: [appA, appB],
      syncedAt: 1,
    }
    const scopeKeyForApp = (app: CatalogApp) => createLocalAppScopeKey({
      kind: 'catalog',
      accountId: catalog.accountId,
      organizationId: catalog.organizationId,
      catalogAppId: app.id,
    })
    const statuses = Object.fromEntries([appA, appB].map(app => [
      scopeKeyForApp(app),
      {
        appId: app.id,
        scope: {
          kind: 'catalog' as const,
          accountId: catalog.accountId,
          organizationId: catalog.organizationId,
          catalogAppId: app.id,
        },
        status: 'broken' as const,
        currentVersion: '1.0.0',
        error: {
          code: 'START_FAILED',
          message: 'health check failed',
        },
      },
    ]))
    const appALogs = createDeferred<string>()
    const appBLogs = createDeferred<string>()
    const getLogs = jest.fn((app: CatalogApp) => (
      app.id === appA.id ? appALogs.promise : appBLogs.promise
    ))
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: catalog.accountId,
        activeOrganizationId: catalog.organizationId,
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: catalog.organizationId,
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
        statuses,
      },
      getStatus: (app: CatalogApp) => statuses[scopeKeyForApp(app)],
      scopeKeyForApp,
      getLogs,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    fireEvent.pointerDown(
      screen.getByLabelText('More actions for Broken App A'),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText('Broken App A logs')).toBeTruthy()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(screen.queryByText('Broken App A logs')).toBeNull()
    })
    fireEvent.pointerDown(
      screen.getByLabelText('More actions for Broken App B'),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText('Broken App B logs')).toBeTruthy()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    await act(async () => {
      appALogs.resolve('stale App A logs')
      await appALogs.promise
    })
    expect(screen.queryByText('stale App A logs')).toBeNull()
    expect(screen.getByText('Loading logs…')).toBeTruthy()

    await act(async () => {
      appBLogs.resolve('current App B logs')
      await appBLogs.promise
    })
    await waitFor(() => {
      expect(screen.getByText('current App B logs')).toBeTruthy()
    })
    expect(screen.queryByText('stale App A logs')).toBeNull()
    expect(getLogs).toHaveBeenNthCalledWith(1, appA)
    expect(getLogs).toHaveBeenNthCalledWith(2, appB)
  })

  it('closes deferred logs when switching between legacy-colliding contexts', async () => {
    const accountA = 'account:west'
    const organizationAId = '组织'
    const accountB = 'account'
    const organizationBId = 'west:组织'
    expect(`${accountA}:${organizationAId}`)
      .toBe(`${accountB}:${organizationBId}`)

    const pendingLogs = createDeferred<string>()
    const brokenApp = (
      accountId: string,
      organizationId: string,
    ): {
      app: CatalogApp
      hook: any
    } => {
      const app: CatalogApp = {
        id: 'shared-broken-app',
        organizationId,
        name: `Broken ${accountId}`,
        description: '',
        deliveryMode: 'local_bundle',
        sortOrder: 0,
        availability: 'available',
      }
      const catalog: AppCatalogCacheEntry = {
        accountId,
        organizationId,
        appConfigVersion: `catalog-${accountId}`,
        authorizationStatus: 'authorized',
        apps: [app],
        syncedAt: 1,
      }
      const scopeKey = createLocalAppScopeKey({
        kind: 'catalog',
        accountId,
        organizationId,
        catalogAppId: app.id,
      })
      const status = {
        appId: app.id,
        scope: {
          kind: 'catalog' as const,
          accountId,
          organizationId,
          catalogAppId: app.id,
        },
        status: 'broken' as const,
        currentVersion: '1.0.0',
        error: {
          code: 'START_FAILED',
          message: 'health check failed',
        },
      }
      return {
        app,
        hook: {
          ...signedOutCatalogHook(),
          organization: {
            accountId,
            activeOrganizationId: organizationId,
            organizationContextKey: createOrganizationContextKey(
              accountId,
              organizationId,
            ),
            organizationSummaries: [{
              id: organizationId,
              type: 'enterprise',
              name: organizationId,
            }],
          },
          state: {
            ...signedOutCatalogHook().state,
            catalog,
            accessMode: 'online',
            statuses: { [scopeKey]: status },
          },
          getStatus: () => status,
          scopeKeyForApp: () => scopeKey,
          getLogs: () => pendingLogs.promise,
        },
      }
    }
    const contextA = brokenApp(accountA, organizationAId)
    const contextB = brokenApp(accountB, organizationBId)
    expect(contextA.hook.organization.organizationContextKey)
      .not.toBe(contextB.hook.organization.organizationContextKey)

    appCatalogHook = contextA.hook
    const view = render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))
    fireEvent.pointerDown(
      screen.getByLabelText(`More actions for ${contextA.app.name}`),
      { button: 0, ctrlKey: false },
    )
    await waitFor(() => expect(screen.getByText('View logs')).toBeTruthy())
    fireEvent.click(screen.getByText('View logs'))
    expect(screen.getByText(`${contextA.app.name} logs`)).toBeTruthy()

    appCatalogHook = contextB.hook
    view.rerender(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))
    await waitFor(() => {
      expect(screen.queryByText(`${contextA.app.name} logs`)).toBeNull()
    })

    await act(async () => {
      pendingLogs.resolve('stale account A logs')
      await pendingLogs.promise
    })
    expect(screen.queryByText('stale account A logs')).toBeNull()
    expect(screen.getByText(contextB.app.name)).toBeTruthy()
  })

  it('segments a maximum catalog and excludes withdrawn apps without local data', () => {
    const visibleApps: CatalogApp[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `visible-${index}`,
        organizationId: 'organization-a',
        name: `Visible ${index}`,
        description: '',
        deliveryMode: 'remote_url' as const,
        remoteUrl: `https://example.com/${index}`,
        sortOrder: index,
        availability: 'available' as const,
      }),
    )
    const withdrawnApps: CatalogApp[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `withdrawn-${index}`,
        organizationId: 'organization-a',
        name: `Withdrawn ${index}`,
        description: '',
        deliveryMode: 'local_bundle' as const,
        sortOrder: index + 20_000,
        availability: 'withdrawn' as const,
      }),
    )
    withdrawnApps[9_999] = {
      ...withdrawnApps[9_999]!,
      name: 'Installed Withdrawn',
      sortOrder: -1,
    }
    const catalog: AppCatalogCacheEntry = {
      accountId: 'account-a',
      organizationId: 'organization-a',
      appConfigVersion: 'maximum',
      authorizationStatus: 'authorized',
      apps: visibleApps,
      withdrawnApps,
      syncedAt: 1,
    }
    const installedWithdrawn = withdrawnApps[9_999]!
    const installedScopeKey = createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: installedWithdrawn.id,
    })
    const statuses = {
      [installedScopeKey]: {
        appId: installedWithdrawn.id,
        scope: {
          kind: 'catalog' as const,
          accountId: 'account-a',
          organizationId: 'organization-a',
          catalogAppId: installedWithdrawn.id,
        },
        status: 'installed' as const,
        currentVersion: '1.0.0',
      },
    }
    const scopeKeyForApp = (target: CatalogApp) => createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-a',
      organizationId: 'organization-a',
      catalogAppId: target.id,
    })
    appCatalogHook = {
      ...signedOutCatalogHook(),
      organization: {
        accountId: 'account-a',
        activeOrganizationId: 'organization-a',
        organizationContextKey: 'account-a:organization-a',
        organizationSummaries: [{
          id: 'organization-a',
          type: 'enterprise',
          name: 'Organization A',
        }],
      },
      state: {
        ...signedOutCatalogHook().state,
        catalog,
        accessMode: 'online',
        statuses,
      },
      getStatus: (target: CatalogApp) => statuses[scopeKeyForApp(target)],
      scopeKeyForApp,
    }

    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(HomePage, { onAddApp: () => {} }),
    ))

    expect(document.querySelectorAll(
      'article[data-testid^="organization-app-"]',
    )).toHaveLength(60)
    expect(screen.getByText('Installed Withdrawn')).toBeTruthy()
    expect(screen.queryByText('Withdrawn 0')).toBeNull()

    fireEvent.click(screen.getByText('Load more'))
    expect(document.querySelectorAll(
      'article[data-testid^="organization-app-"]',
    )).toHaveLength(120)
  })
})
