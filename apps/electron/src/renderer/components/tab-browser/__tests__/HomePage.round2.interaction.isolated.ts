import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import { createLocalAppScopeKey } from '@polo-ai/shared/protocol'
import {
  BUILTIN_APP_DEFINITIONS,
} from '../../../../shared/tab-browser-types'
import {
  KEYS,
  set as setLocalStorage,
} from '@/lib/local-storage'

GlobalRegistrator.register()
setupI18n()

const openApp = jest.fn()
const removeApp = jest.fn(async () => {})
let appCatalogHook: any
let installedApps = [...BUILTIN_APP_DEFINITIONS]

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
    expect(screen.getByText('Kanban')).toBeTruthy()
    expect(screen.getByText('AirDrop')).toBeTruthy()

    fireEvent.click(screen.getByText('Pro Buddy'))
    expect(openApp).toHaveBeenCalledWith(BUILTIN_APP_DEFINITIONS[0])
  })

  it('keeps non-recent built-ins discoverable on a signed-out returning profile', () => {
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
        id: BUILTIN_APP_DEFINITIONS[0]!.id,
        kind: 'builtin',
        openedAt: 2,
      },
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

    const launcher = screen.getByTestId('builtin-app-launcher')
    expect(within(launcher).queryByText('Pro Buddy')).toBeNull()
    expect(within(launcher).getByText('Kanban')).toBeTruthy()
    expect(within(launcher).getByText('AirDrop')).toBeTruthy()

    fireEvent.click(within(launcher).getByText('Kanban'))
    expect(openApp).toHaveBeenCalledWith(BUILTIN_APP_DEFINITIONS[1])
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
    const deniedApp: CatalogApp = {
      id: 'denied-installed',
      organizationId: 'organization-a',
      name: 'Denied Installed',
      description: '',
      deliveryMode: 'local_bundle',
      currentRelease: {
        version: '2.0.0',
        runtime: 'static',
        downloadUrl: 'https://example.com/app.zip',
        checksum: 'a'.repeat(64),
        sizeBytes: 1024,
      },
      sortOrder: 0,
      availability: 'unavailable',
    }
    const catalog: AppCatalogCacheEntry = {
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
      expect(screen.queryByText('View logs')).toBeNull()
    })
    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => {
      expect(stop).toHaveBeenCalledWith(deniedApp)
    })
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
