import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'
import { __resetProjectVisitsForTests, recordProjectVisit } from '@/lib/project-directory'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

/**
 * POO-196 R3 — the home「项目」directory section in isolation (consensus
 * P2/P3/P4/P11): the section is the ONLY create entry; the directory is the
 * r3 NEGOTIATED list (pm:listProductSpacesR3) filtered to
 * enterpriseKind==='project' — organization aggregates are never listed;
 * the current PROJECT keeps a「当前」badge; role / read-only markers ride the
 * v1 space entries; capacity/search/order/P4 pins as adjudicated (D6/D8).
 */

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}
setupI18n()

const toastErrorSpy = jest.fn()
const openApp = jest.fn()

let appCatalogHook: any
let pmListR3: jest.Mock

mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    installedApps: [],
    openApp,
    removeApp: async () => {},
  }),
}))

// The projects section never touches the app catalog, but the page consumes
// the shared MemberCatalog surface; a minimal signed-out catalog keeps the
// rest of the page inert while the section renders from the pm channel.
mock.module('@/hooks/useAppCatalog', () => ({
  useAppCatalog: () => appCatalogHook,
}))

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: jest.fn(),
  },
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { HomePage } = await import('../HomePage')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')

const R3_VERSION = 'poo196-client-enterprise-r3'

/** Install the pm:listProductSpacesR3 fixture. `projectIds` marks which of
 * the enterprise spaces the server classifies as projects (the rest are
 * organization aggregates and must NOT surface as cards). */
function installProjectDirectory(productSpaces: unknown[], projectIds: string[]) {
  const enterprises = productSpaces.filter((space: any) => space.kind === 'enterprise')
  pmListR3.mockImplementation(async () => ({
    contractVersion: R3_VERSION,
    spaces: {
      contractVersion: '1',
      personalProductSpaceId: PERSONAL_ID,
      productSpaces,
    },
    enterpriseSummaries: enterprises.map((space: any) => ({
      productSpaceId: space.id,
      enterpriseId: space.enterpriseId,
      enterpriseKind: projectIds.includes(space.id) ? 'project' : 'organization',
    })),
  }))
}

beforeEach(async () => {
  localStorage.clear()
  toastErrorSpy.mockClear()
  openApp.mockClear()
  __resetProjectVisitsForTests()
  pmListR3 = jest.fn(async () => ({
    contractVersion: R3_VERSION,
    spaces: { contractVersion: '1', personalProductSpaceId: PERSONAL_ID, productSpaces: [] },
    enterpriseSummaries: [],
  }))
  ;(window as any).electronAPI = {
    ...((window as any).electronAPI ?? {}),
    pmListProductSpacesR3: (...args: unknown[]) => pmListR3(...(args as [])),
  }
  appCatalogHook = {
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
    start: async () => ({ appId: 'unused', version: '1.0.0', url: 'http://127.0.0.1:1', port: 1 }),
    stop: async () => {},
    uninstall: async () => {},
    cancelInstall: async () => {},
    getLogs: async () => '',
    resolveLaunch: async () => { throw new Error('not used here') },
    resolveRemoteUrl: async () => 'https://trusted.example.com',
    getInstallState: () => undefined,
    installProductSpaceBundle: async () => {},
    uninstallProductSpaceBundle: async () => {},
    scopeKeyForApp: () => 'unused',
    refreshRuntimeStatuses: async () => {},
    refreshProductSpaceInstallStates: async () => {},
    creatorCircles: [],
  }
  await i18n.changeLanguage('zh-Hans')
})

afterEach(cleanup)

const ACCOUNT_ID = 'account-projects'
const PERSONAL_ID = 'space-personal'
const CURRENT_ORG_ID = 'space-org-current'

function enterpriseSpace(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'enterprise',
    enterpriseId: `ent-${id}`,
    name,
    role: 'member',
    accessMode: 'active',
    payer: { kind: 'enterprise', enterpriseId: `ent-${id}` },
    ...overrides,
  }
}

function homeTree(productSpaces: Array<Record<string, unknown>>, onEnterProject?: (id: string) => void) {
  const value = {
    accountId: ACCOUNT_ID,
    activeProductSpaceId: CURRENT_ORG_ID,
    activeProductSpace: enterpriseSpace(CURRENT_ORG_ID, '当前组织'),
    productSpaces,
    allProductSpaces: productSpaces,
    personalProductSpaceId: PERSONAL_ID,
    productSpaceContextKey: createProductSpaceContextKey(ACCOUNT_ID, CURRENT_ORG_ID),
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
  return createElement(ProductSpaceProvider, {
    value: value as never,
    children: createElement(
      I18nextProvider,
      { i18n },
      createElement(
        MemberCatalogProvider,
        null,
        createElement(HomePage, onEnterProject ? { onEnterProject } : {}),
      ),
    ),
  }) as ReactElement
}

function card(productSpaceId: string): HTMLElement {
  const cardElement = screen.getAllByTestId('home-project-card')
    .find(candidate => candidate.getAttribute('data-product-space-id') === productSpaceId)
  if (!cardElement) throw new Error(`project card not found: ${productSpaceId}`)
  return cardElement
}

describe('HomePage 项目区域 (POO-196 R3 P2/P3/P4/P11)', () => {
  it('P11: the section header carries the ONLY create entry (home-project-create), wired to the hosted dialog callback', async () => {
    const onOpenCreateProject = jest.fn()
    const value = {
      accountId: ACCOUNT_ID,
      activeProductSpaceId: CURRENT_ORG_ID,
      activeProductSpace: enterpriseSpace(CURRENT_ORG_ID, '当前组织'),
      productSpaces: [],
      allProductSpaces: [],
      personalProductSpaceId: PERSONAL_ID,
      productSpaceContextKey: 'k',
      contextVersion: 1,
      pendingSwitch: null,
      onSelectProductSpace: () => {},
      onRequestSwitch: async () => {},
      onRefreshProductSpaces: async () => [],
      onOpenCreateProject,
      onConfirmStopAndSwitch: () => {},
      onRetryFailedStops: () => {},
      onRetryTargetLoad: () => {},
      onCancelSwitch: () => {},
      onDismissTargetAccessLost: () => {},
      onStopSwitchExecution: () => {},
    }
    render(createElement(ProductSpaceProvider, {
      value: value as never,
      children: createElement(I18nextProvider, { i18n }, createElement(
        MemberCatalogProvider, null, createElement(HomePage),
      )),
    }))
    // The verified-empty state keeps a single primary action: exactly ONE
    // create entry on the whole page surface, and no second create button
    // inside the dashed card.
    await waitFor(() => expect(screen.getByTestId('home-project-empty').textContent).toBe('还没有项目'))
    expect(screen.getAllByTestId('home-project-create')).toHaveLength(1)
    expect(screen.getByTestId('home-project-create').textContent).toContain('创建项目')
    expect(screen.queryAllByTestId('home-project-card')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('home-project-create'))
    expect(onOpenCreateProject).toHaveBeenCalledTimes(1)
  })

  it('P2: negotiated project summaries render as cards with role / read-only markers and the「当前」badge on the active one; organizations never surface', async () => {
    installProjectDirectory([
      enterpriseSpace(CURRENT_ORG_ID, '当前项目空间'),
      enterpriseSpace('space-proj-a', '华东区资料库'),
      enterpriseSpace('space-proj-readonly', '受限项目', { accessMode: 'read_only', restrictionCode: 'billing_restricted' }),
      enterpriseSpace('space-org-main', '主企业空间'),
    ], [CURRENT_ORG_ID, 'space-proj-a', 'space-proj-readonly'])
    render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(3))
    // The organization aggregate is NOT a project card.
    expect(screen.queryByText('主企业空间')).toBeNull()
    expect(screen.queryByText('我的空间')).toBeNull()
    expect(card(CURRENT_ORG_ID).getAttribute('data-product-space-id')).toBe(CURRENT_ORG_ID)
    expect(card(CURRENT_ORG_ID).querySelector('[data-testid="home-project-current"]')?.textContent).toBe('当前')
    expect(card('space-proj-a').querySelector('[data-testid="home-project-current"]')).toBeNull()
    expect(card('space-proj-readonly').textContent).toContain('只读')
    // Role badge comes from the real productSpace.role.* keys.
    expect(card('space-proj-a').textContent).toContain('成员')
    // The summary omits the count — P4: the row is omitted, never a
    // fabricated 0.
    expect(card('space-proj-a').textContent).not.toContain('位成员')
  })

  it('P3: cards order by the device-local visit record (recency first) and Enter activates the card through the host prop', async () => {
    const onEnterProject = jest.fn()
    recordProjectVisit(ACCOUNT_ID, 'space-proj-a', 2_000)
    recordProjectVisit(ACCOUNT_ID, CURRENT_ORG_ID, 1_000)
    installProjectDirectory([
      enterpriseSpace(CURRENT_ORG_ID, '当前项目空间'),
      enterpriseSpace('space-proj-a', '华东区资料库'),
      enterpriseSpace('space-proj-b', '安控项目'),
    ], [CURRENT_ORG_ID, 'space-proj-a', 'space-proj-b'])
    render(homeTree([], onEnterProject))
    // Recency first (P3): the 2_000 visit leads the 1_000 visit, which still
    // leads the never-visited project.
    await waitFor(() => {
      const ids = screen.getAllByTestId('home-project-card')
        .map(item => item.getAttribute('data-product-space-id'))
      expect(ids).toEqual(['space-proj-a', CURRENT_ORG_ID, 'space-proj-b'])
    })

    fireEvent.click(card('space-proj-b'))
    expect(onEnterProject).toHaveBeenCalledWith('space-proj-b')
    fireEvent.keyDown(card('space-proj-a'), { key: 'Enter' })
    expect(onEnterProject).toHaveBeenCalledWith('space-proj-a')
    expect(onEnterProject).toHaveBeenCalledTimes(2)
  })

  it('P3: more than two rows collapse behind 查看全部（N） → search → collapse, with the same grid breakpoint classes', async () => {
    // Latin names keep sort order == insertion order, so index-based
    // visibility assertions stay readable.
    const spaces = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(spaces, spaces.map(space => space.id))
    render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))

    // Collapsed: the expand control announces the FULL count; the search box
    // belongs to the expanded state only.
    expect(screen.queryByTestId('home-project-search')).toBeNull()
    expect(screen.getByTestId('home-project-expand').textContent).toBe('查看全部（7）')
    // First two cards always visible; overflow hides via the grid's
    // responsive classes (index 2-4 only below 761px; index 5+ only ≥1081px).
    expect(card('space-0').className).not.toContain('hidden')
    expect(card('space-2').className).toContain('hidden min-[761px]:block')
    expect(card('space-6').className).toContain('hidden min-[761px]:hidden min-[1081px]:block')

    fireEvent.click(screen.getByTestId('home-project-expand'))
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    expect(card('space-6').className).not.toContain('hidden')

    // Expanded: the name search narrows the section (the directory toolbar's
    // search is a different, app-scoped control).
    const search = screen.getByTestId('home-project-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Project G' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()
    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByTestId('home-project-no-matches').textContent).toBe('没有匹配的项目')

    // Collapse resets the query and the capacity state.
    fireEvent.click(screen.getByTestId('home-project-collapse'))
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    expect(screen.queryByTestId('home-project-search')).toBeNull()
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(7)
    expect(card('space-6').className).toContain('hidden')
  })

  it('P3: the expand control tracks the breakpoint capacity (2×columns) instead of a fixed count', async () => {
    // 4 projects: two full rows at ≥761px (2×2) — no overflow there, so the
    // expand control hides at that breakpoint, not via JS.
    const four = ['A', 'B', 'C', 'D']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(four, four.map(space => space.id))
    const { unmount } = render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(4))
    // The responsive visibility lives on the control's wrapper row.
    expect(screen.getByTestId('home-project-expand').parentElement?.className).toContain('min-[761px]:hidden')
    // The 3rd/4th cards carry the mobile-overflow visibility classes.
    expect(card('space-2').className).toContain('hidden min-[761px]:block')
    unmount()

    // 7 projects overflow every breakpoint — the control never hides.
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(seven, seven.map(space => space.id))
    render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect(screen.getByTestId('home-project-expand').parentElement?.className).not.toContain('min-[761px]:hidden')
    expect(screen.getByTestId('home-project-expand').parentElement?.className).not.toContain('min-[1081px]:hidden')
  })

  it('P4: a failed negotiation renders the load-failed face, never 「还没有项目」; a version mismatch loses the retry', async () => {
    pmListR3.mockImplementation(async () => { throw { code: 'contract_version_unsupported' } })
    const first = render(homeTree([]))
    const errorFace = await screen.findByTestId('home-project-error')
    expect(errorFace.textContent).toContain('当前服务尚不支持项目列表')
    expect(screen.queryByTestId('home-project-error-retry')).toBeNull()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()
    first.unmount()

    // A generic failure keeps the retry, and the retry re-runs the request.
    pmListR3.mockImplementation(async () => { throw new Error('transport down') })
    const { unmount } = render(homeTree([]))
    await screen.findByTestId('home-project-error')
    expect(screen.getByTestId('home-project-error').textContent).toContain('无法加载项目')
    expect(screen.getByTestId('home-project-error-retry')).toBeTruthy()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()
    fireEvent.click(screen.getByTestId('home-project-error-retry'))
    await waitFor(() => expect(pmListR3.mock.calls.length).toBeGreaterThanOrEqual(2))
    unmount()
  })
})
