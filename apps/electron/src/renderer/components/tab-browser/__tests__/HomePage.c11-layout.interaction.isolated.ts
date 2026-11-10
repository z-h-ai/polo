import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  DeniedAppCatalogSnapshot,
} from '@polo-ai/shared/admin'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

/**
 * POO-205 C11 (R15/R16) — the Home IA re-order, the partition-merged vacuum
 * and the manage-skills entry, isolated from the other HomePage suites:
 *
 * - IA order: projects → pinned canvas → Apps (title → toolbar → grid,
 *   adjacent) → My apps — for BOTH space kinds.
 * - Empty-state merge: BOTH partitions verifiably empty → ONE vacuum face;
 *   partial vacua keep their own faces; a failing My apps read never merges.
 * - R16: the manage-skills entry (enterprise committed spaces only) opens
 *   ProductSpaceSkillsDialog — its first production mount. The dialog's data
 *   source is the OPEN-time productSpaceListSkills read (fail-visible), so
 *   there is no pre-open permission probe: the entry shows for every member
 *   of a committed enterprise space.
 */

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}
setupI18n()

const toastErrorSpy = jest.fn()
const openApp = jest.fn()
const storePublish = jest.fn(() => ({ handoffId: 'test-handoff', context: {} }))
const myAppsList = jest.fn()
const pmListProjects = jest.fn()
const productSpaceListSkills = jest.fn()
const getSkills = jest.fn(async () => [])

const ACCOUNT_ID = 'account-c11'
const ORG_ID = 'space-org-c11'
const PERSONAL_ID = 'space-personal-c11'
const WORKSPACE_ID = 'workspace-c11'
const R3_VERSION = 'poo196-client-enterprise-r3'
const MYAPPS_CONTRACT = 'poo205-contract-r1'

let appCatalogHook: any
let installedApps: Array<Record<string, unknown>> = []
/**
 * R16 dialog: the AppShell surface is mocked so the dialog's
 * useActiveWorkspace resolves (a real provider is app-level). It ALSO hands
 * useMyApps its workspaceId scope leg — which under RTL's synchronous act
 * flush makes the hook's scope-identity guard discard its first response and
 * stick the section in `home-my-apps-loading`. So the flag stays FALSE (the
 * hook idles honestly: loading=false, errorCode=null — `myAppsReady`) for
 * every layout test, and flips true only in the one test that needs the
 * workspace-scoped dialog open, plus the deliberate loading-not-merge case.
 */
let appShellAvailable = false

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps,
    openApp,
    removeApp: async () => {},
  }),
}))

mock.module('@/hooks/useAppCatalog', () => ({
  useAppCatalog: () => appCatalogHook,
}))

mock.module('@/lib/product-space-app-launch-handoff', () => ({
  createProductSpaceLaunchHandoffStore: () => ({
    publish: storePublish,
    take: jest.fn(() => null),
    onLaunch: () => () => {},
    commitContext: jest.fn(),
    dispose: jest.fn(),
  }),
}))

mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => (appShellAvailable
    ? { activeWorkspaceId: WORKSPACE_ID, workspaces: [{ id: WORKSPACE_ID }] }
    : null),
  useActiveWorkspace: () => ({ id: WORKSPACE_ID }),
}))

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: jest.fn(),
  },
}))

const {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')
const { HomePage } = await import('../HomePage')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')

function signedOutCatalogHook() {
  return {
    productSpace: null,
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
      creatorCircles: [],
      host: null,
      installStates: {},
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
    resolveLaunch: async () => {
      throw new Error('resolveLaunch behavior not configured')
    },
    resolveRemoteUrl: async () => 'https://trusted.example.com',
    getInstallState: () => undefined,
    installProductSpaceBundle: async () => {},
    uninstallProductSpaceBundle: async () => {},
    scopeKeyForApp: () => 'unused',
    refreshRuntimeStatuses: async () => {},
    refreshProductSpaceInstallStates: async () => {},
    creatorCircles: [],
  }
}

function enterpriseCatalogWith(
  apps: CatalogApp[],
  overrides: Partial<AppCatalogCacheEntry> = {},
): AppCatalogCacheEntry {
  return {
    accountId: ACCOUNT_ID,
    organizationId: ORG_ID,
    appConfigVersion: 'v1',
    authorizationStatus: 'authorized',
    apps,
    syncedAt: 1,
    ...overrides,
  }
}

function hookWithCatalog(
  catalog: AppCatalogCacheEntry | DeniedAppCatalogSnapshot,
  hookOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {},
) {
  return {
    ...signedOutCatalogHook(),
    productSpace: {
      accountId: catalog.accountId,
      activeProductSpaceId: catalog.organizationId,
      productSpaceContextKey: createProductSpaceContextKey(
        catalog.accountId,
        catalog.organizationId,
      ),
      contextVersion: 0,
      activeProductSpace: {
        id: catalog.organizationId,
        kind: 'enterprise',
        name: 'C11 组织',
      },
    },
    state: {
      ...signedOutCatalogHook().state,
      catalog,
      accessMode: 'online',
      ...stateOverrides,
    },
    scopeKeyForApp: () => 'unused',
    uiIdentityKeyForApp: (target: CatalogApp) => JSON.stringify([
      'product-space-ui',
      catalog.accountId,
      catalog.organizationId,
      target.catalogEntryId ?? target.id,
      target.artifactInstanceId ?? null,
    ]),
    ...hookOverrides,
  }
}

function workApp(
  id: string,
  name: string,
  index: number,
  overrides: Partial<CatalogApp> = {},
): CatalogApp {
  return {
    id,
    catalogEntryId: id,
    artifactInstanceId: `artifact-${id}`,
    organizationId: ORG_ID,
    name,
    description: `${name} description`,
    deliveryMode: 'remote_url',
    remoteUrl: `https://${id}.example.com`,
    sortOrder: index,
    availability: 'available',
    catalogSources: [{ kind: 'enterprise_import', name: `${name} Source` }],
    ...overrides,
  }
}

/** A catalog row that lands in the 我的应用 partition: a `self` source whose
 * catalogEntryId sits in the trusted memberCatalogEntryIds index. */
function memberDirectoryApp(): CatalogApp {
  return workApp('my-entry', '我的画布应用', 0, {
    catalogSources: [{ kind: 'self', name: 'self' }],
  })
}

function enterpriseSpace() {
  return {
    id: ORG_ID,
    kind: 'enterprise',
    enterpriseId: `ent-${ORG_ID}`,
    name: 'C11 组织',
    role: 'member',
    accessMode: 'active',
    payer: { kind: 'enterprise', enterpriseId: `ent-${ORG_ID}` },
  }
}

function personalSpace() {
  return {
    id: PERSONAL_ID,
    kind: 'personal',
    name: '我的个人空间',
    accessMode: 'active',
    payer: { kind: 'account' },
  }
}

function homeTree(activeSpace: Record<string, unknown>): ReactElement {
  const value = {
    accountId: ACCOUNT_ID,
    activeProductSpaceId: activeSpace.id as string,
    activeProductSpace: activeSpace,
    productSpaces: [activeSpace],
    allProductSpaces: [activeSpace],
    personalProductSpaceId: PERSONAL_ID,
    productSpaceContextKey: createProductSpaceContextKey(ACCOUNT_ID, activeSpace.id as string),
    contextVersion: 1,
    pendingSwitch: null,
    onSelectProductSpace: () => {},
    onRequestSwitch: async () => {},
    onRefreshProductSpaces: async () => [],
    onOpenCreateProject: () => {},
    onConfirmStopAndSwitch: () => {},
    onRetryFailedStops: () => {},
    onRetryTargetLoad: () => {},
    onCancelSwitch: () => {},
    onDismissTargetAccessLost: () => {},
    onStopSwitchExecution: () => {},
  }
  // HomePage reads the committed space through BOTH the provider and the
  // mocked MemberCatalog hook — mirror the provider value there too.
  appCatalogHook.productSpace = value
  return createElement(ProductSpaceProvider, {
    value: value as never,
    children: createElement(
      I18nextProvider,
      { i18n },
      createElement(MemberCatalogProvider, null, createElement(HomePage)),
    ),
  }) as ReactElement
}

/** Document-order indexes of the FIRST node carrying each testid. */
function testidOrder(testids: string[]): number[] {
  const nodes = Array.from(document.querySelectorAll('[data-testid]'))
  return testids.map(id => {
    const index = nodes.findIndex(node => node.getAttribute('data-testid') === id)
    if (index < 0) throw new Error(`order assertion: element not found: ${id}`)
    return index
  })
}

function expectOrdered(indexes: number[]) {
  for (let i = 1; i < indexes.length; i += 1) {
    expect(indexes[i]).toBeGreaterThan(indexes[i - 1]!)
  }
}

beforeEach(async () => {
  localStorage.clear()
  toastErrorSpy.mockClear()
  openApp.mockClear()
  storePublish.mockClear()
  myAppsList.mockReset()
  pmListProjects.mockReset()
  productSpaceListSkills.mockReset()
  getSkills.mockClear()
  installedApps = []
  appShellAvailable = false
  myAppsList.mockImplementation(async (scope: { productSpaceId: string }) => ({
    contractVersion: MYAPPS_CONTRACT,
    productSpaceId: scope.productSpaceId,
    apps: [],
  }))
  pmListProjects.mockImplementation(async () => ({
    contractVersion: MYAPPS_CONTRACT,
    organizationEnterpriseId: `ent-${ORG_ID}`,
    projects: [],
  }))
  productSpaceListSkills.mockImplementation(async () => ({
    success: true,
    contractVersion: 1,
    productSpaceId: ORG_ID,
    entries: [],
    withdrawnEntries: [],
    accessMode: 'active',
  }))
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openUrl: jest.fn(),
      pmListProjects: (...args: unknown[]) => pmListProjects(...(args as [])),
      pmListProductSpacesR3: async () => ({
        contractVersion: R3_VERSION,
        spaces: { contractVersion: '1', personalProductSpaceId: PERSONAL_ID, productSpaces: [] },
        enterpriseSummaries: [],
      }),
      myAppsList: (...args: unknown[]) => myAppsList(...(args as [])),
      productSpaceListSkills: (...args: unknown[]) => productSpaceListSkills(...(args as [])),
      getSkills: (...args: unknown[]) => getSkills(...(args as [])),
    },
  })
  appCatalogHook = signedOutCatalogHook()
  await i18n.changeLanguage('en')
})

afterEach(cleanup)

describe('C11 IA 顺序 (R15)', () => {
  it('enterprise: 项目区 < 已固定画布 < 应用标题 < 工具栏 < 共享网格 < 我的应用', async () => {
    installedApps = [{ id: 'gen-ui-app-c11', name: 'C11 画布' }]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([workApp('shared-1', 'Shared App', 0)]))
    render(homeTree(enterpriseSpace()))
    await waitFor(() => expect(screen.getByTestId('home-directory-app')).toBeTruthy())
    expectOrdered(testidOrder([
      'home-projects',
      'home-canvas-apps-section',
      'home-apps-title',
      'home-directory-toolbar',
      'home-directory-app',
      'home-my-apps',
    ]))
    // 「我的应用」被挪到共享网格之后：工具栏过滤的网格与工具栏同段相邻，
    // 中间不再被「我的应用」隔开（工具栏 → 网格之间只隔横幅）。
    const [toolbar, gridRow, myApps] = testidOrder([
      'home-directory-toolbar',
      'home-directory-app',
      'home-my-apps',
    ])
    expect(gridRow).toBeLessThan(myApps)
    expect(toolbar).toBeLessThan(gridRow)
  })

  it('personal: 无项目区；hero < 已固定画布 < 应用标题 < 工具栏 < 共享网格 < 我的应用', async () => {
    installedApps = [{ id: 'gen-ui-app-c11', name: 'C11 画布' }]
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([
      // The row must carry the PERSONAL space id — a row addressed to another
      // space is refused wholesale (foreign_space_scope) and renders nothing.
      workApp('shared-1', 'Shared App', 0, {
        organizationId: PERSONAL_ID,
        catalogSources: [{ kind: 'polo', name: 'Polo' }],
      }),
    ], { organizationId: PERSONAL_ID }))
    render(homeTree(personalSpace()))
    await waitFor(() => expect(screen.getByTestId('home-directory-app')).toBeTruthy())
    expect(screen.queryByTestId('home-projects')).toBeNull()
    expectOrdered(testidOrder([
      'home-quick-access-section',
      'home-canvas-apps-section',
      'home-apps-title',
      'home-directory-toolbar',
      'home-directory-app',
      'home-my-apps',
    ]))
  })

  it('我的应用分区行渲染在共享网格之后（工具栏 → 网格行 → myapp 行）', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([
      workApp('shared-1', 'Shared App', 0),
      memberDirectoryApp(),
    ]), {}, { memberCatalogEntryIds: { 'my-entry': { publishedAt: '2026-11-09T00:00:00.000Z' } } })
    render(homeTree(enterpriseSpace()))
    await waitFor(() => expect(screen.getByTestId('home-myapp-card')).toBeTruthy())
    expectOrdered(testidOrder([
      'home-directory-toolbar',
      'home-directory-app',
      'home-my-apps-title',
      'home-myapp-card',
    ]))
  })
})

describe('C11 空态合并 (R15)', () => {
  it('两类应用都空 → 只渲染一个合并空态（企业文案），我的应用空态被抑制', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    render(homeTree(enterpriseSpace()))
    const face = await screen.findByTestId('home-directory-empty-enterprise')
    expect(face.textContent).toContain('and you have not saved any apps of your own')
    // 合并前的共享目录专属文案不得作为该空态出现。
    expect(face.textContent).not.toContain('They will appear here once an admin distributes them.')
    expect(screen.queryByTestId('home-my-apps-empty')).toBeNull()
    expect(screen.queryByTestId('home-directory-shared-empty')).toBeNull()
  })

  it('个人空间合并空态保留个人 face 与合并后的个人文案', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([], { organizationId: PERSONAL_ID }))
    render(homeTree(personalSpace()))
    const face = await screen.findByTestId('home-directory-empty-personal')
    expect(face.textContent).toContain('apps you generate in a chat can also be saved to My apps')
    expect(screen.queryByTestId('home-my-apps-empty')).toBeNull()
    expect(screen.queryByTestId('home-directory-empty-enterprise')).toBeNull()
  })

  it('仅共享目录为空而我的应用有行：共享空态 face + 我的应用行，不合并', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([
      memberDirectoryApp(),
    ]), {}, { memberCatalogEntryIds: { 'my-entry': {} } })
    render(homeTree(enterpriseSpace()))
    await waitFor(() => expect(screen.getByTestId('home-myapp-card')).toBeTruthy())
    expect(screen.getByTestId('home-directory-shared-empty')).toBeTruthy()
    expect(screen.queryByTestId('home-directory-empty-enterprise')).toBeNull()
    expect(screen.queryByTestId('home-my-apps-empty')).toBeNull()
  })

  it('仅我的应用为空而共享网格有行：分区保留自己的空态', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([workApp('shared-1', 'Shared App', 0)]))
    render(homeTree(enterpriseSpace()))
    await waitFor(() => expect(screen.getByTestId('home-directory-app')).toBeTruthy())
    expect(screen.getByTestId('home-my-apps-empty')).toBeTruthy()
    expect(screen.queryByTestId('home-directory-empty-enterprise')).toBeNull()
    expect(screen.queryByTestId('home-directory-shared-empty')).toBeNull()
  })

  it('我的应用读取未完成绝不参与合并：分区自己的 loading face + 共享空态保留合并前文案', async () => {
    // The hook reads myApps only when the workspace scope leg exists
    // (appShellAvailable); under RTL's synchronous act flush its scope-
    // identity guard makes a COMPLETED read unreachable (the first response
    // is discarded), so the reachable "not verifiably empty" state here is
    // the pending read — the same myAppsReady=false branch the error face
    // takes. A never-resolving wire keeps the section in its own face while
    // the shared vacuum must keep the PRE-merge copy.
    appShellAvailable = true
    myAppsList.mockImplementation(() => new Promise(() => {}))
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    render(homeTree(enterpriseSpace()))
    await screen.findByTestId('home-my-apps-loading')
    const face = screen.getByTestId('home-directory-empty-enterprise')
    expect(face.textContent).toContain('They will appear here once an admin distributes them.')
    expect(face.textContent).not.toContain('and you have not saved any apps of your own')
    expect(screen.queryByTestId('home-my-apps-empty')).toBeNull()
  })
})

describe('C11 R16 管理技能入口', () => {
  it('企业首页：应用标题旁显示入口（client-workbench 规格），点击打开 ProductSpaceSkillsDialog 并读取当前空间技能', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    render(homeTree(enterpriseSpace()))
    const button = await screen.findByTestId('home-apps-manage-skills')
    expect(button.textContent).toContain('Manage skills')
    // 设计系统统一：次要按钮 client-workbench 规格。
    expect(button.className).toContain('min-h-[32px]')
    expect(button.className).toContain('text-[14px]')
    expect(button.className).toContain('rounded-[8px]')
    fireEvent.click(button)
    // The dialog mounts and reads the CURRENT space's skill catalog — the
    // production mount's wire contract (fail-visible on its own face).
    await screen.findByText('No skills are available in this space.')
    expect(productSpaceListSkills.mock.calls[0]?.[0]).toBe(ORG_ID)
  })

  it('个人首页不显示管理技能入口（R16 语境是企业首页）', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([], { organizationId: PERSONAL_ID }))
    render(homeTree(personalSpace()))
    await screen.findByTestId('home-apps-title')
    expect(screen.queryByTestId('home-apps-manage-skills')).toBeNull()
  })

  it('无已提交空间时整行应用标题不渲染 → 入口也不存在', async () => {
    // Signed-out MemberCatalog hook (productSpace null): the page still needs
    // the ProductSpaceProvider mount (the launch-handoff hook requires it),
    // but with no committed space on the catalog the Apps header row — and
    // with it the entry — never renders.
    appCatalogHook = signedOutCatalogHook()
    const value = {
      accountId: ACCOUNT_ID,
      activeProductSpaceId: ORG_ID,
      activeProductSpace: enterpriseSpace(),
      productSpaces: [],
      allProductSpaces: [],
      personalProductSpaceId: PERSONAL_ID,
      productSpaceContextKey: createProductSpaceContextKey(ACCOUNT_ID, ORG_ID),
      contextVersion: 1,
      pendingSwitch: null,
      onSelectProductSpace: () => {},
      onRequestSwitch: async () => {},
      onRefreshProductSpaces: async () => [],
      onOpenCreateProject: () => {},
      onConfirmStopAndSwitch: () => {},
      onRetryFailedStops: () => {},
      onRetryTargetLoad: () => {},
      onCancelSwitch: () => {},
      onDismissTargetAccessLost: () => {},
      onStopSwitchExecution: () => {},
    }
    render(createElement(
      ProductSpaceProvider,
      { value: value as never, children: createElement(
        I18nextProvider,
        { i18n },
        createElement(MemberCatalogProvider, null, createElement(HomePage)),
      ) },
    ))
    await waitFor(() => expect(screen.getByTestId('home-app-hub')).toBeTruthy())
    expect(screen.queryByTestId('home-apps-title')).toBeNull()
    expect(screen.queryByTestId('home-apps-manage-skills')).toBeNull()
  })
})

describe('C11 设计系统统一', () => {
  it('创建项目按钮对齐 client-workbench 主按钮规格（min-h-32 / text-14 / rounded-8）', async () => {
    appCatalogHook = hookWithCatalog(enterpriseCatalogWith([]))
    render(homeTree(enterpriseSpace()))
    const create = await screen.findByTestId('home-project-create')
    expect(create.className).toContain('min-h-[32px]')
    expect(create.className).toContain('text-[14px]')
    expect(create.className).toContain('rounded-[8px]')
  })
})
