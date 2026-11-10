import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'
import { __resetProjectVisitsForTests, recordProjectVisit } from '@/lib/project-directory'
import { setActiveProject } from '@/components/projects/projects-bus'
import { ProductSpaceProvider } from '@/context/ProductSpaceContext'

/**
 * POO-205 — the home「项目」directory section in isolation (rewritten from
 * the POO-196 R3 P2/P3/P4/P11 surface; Spec Q1/Q3/Q8): a project is a
 * LIGHTWEIGHT entity inside ONE organization, so the directory is the
 * CURRENT committed organization's projects (pm:listProjects) — enterprise
 * spaces are organizations now and the enterpriseKind==='project' projection
 * is gone. The section stays the ONLY create entry (P11); capacity/search/
 * order/P4 pins carry over; the「当前」badge now marks the ENTERED project
 * (the active-project bus) instead of a space id; and entering a project of
 * the committed organization is the LIGHTWEIGHT navigation (no space-switch
 * transaction) — the host-provided onEnterProject override keeps the click
 * observable for the transaction path.
 */

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}
setupI18n()

const toastErrorSpy = jest.fn()
const openApp = jest.fn()

let appCatalogHook: any
let pmListProjects: jest.Mock

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

/** Installs the pm:listProjects fixture — the committed organization's
 * project directory. */
function installProjectDirectory(projects: Array<Record<string, unknown>>) {
  pmListProjects.mockImplementation(async () => ({
    contractVersion: 'poo205-contract-r1',
    organizationEnterpriseId: ORG_ENTERPRISE_ID,
    projects,
  }))
}

beforeEach(async () => {
  localStorage.clear()
  toastErrorSpy.mockClear()
  openApp.mockClear()
  __resetProjectVisitsForTests()
  setActiveProject(null)
  pmListProjects = jest.fn(async () => ({
    contractVersion: 'poo205-contract-r1',
    organizationEnterpriseId: ORG_ENTERPRISE_ID,
    projects: [],
  }))
  ;(window as any).electronAPI = {
    ...((window as any).electronAPI ?? {}),
    pmListProjects: (...args: unknown[]) => pmListProjects(...(args as [])),
    pmListProductSpacesR3: async () => ({
      contractVersion: R3_VERSION,
      spaces: { contractVersion: '1', personalProductSpaceId: PERSONAL_ID, productSpaces: [] },
      enterpriseSummaries: [],
    }),
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

afterEach(() => {
  setActiveProject(null)
  cleanup()
})

const ACCOUNT_ID = 'account-projects'
const PERSONAL_ID = 'space-personal'
const CURRENT_ORG_ID = 'space-org-current'
const ORG_ENTERPRISE_ID = 'ent-org-current'

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

function projectSummary(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationEnterpriseId: ORG_ENTERPRISE_ID,
    organizationProductSpaceId: CURRENT_ORG_ID,
    name,
    myRole: 'member',
    memberCount: 2,
    createdByAccountId: ACCOUNT_ID,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  }
}

function homeTree(
  productSpaces: Array<Record<string, unknown>>,
  onEnterProject?: (id: string) => void,
  overrides: { accountId?: string; activeSpace?: Record<string, unknown> } = {},
) {
  const accountId = overrides.accountId ?? ACCOUNT_ID
  const activeSpace = overrides.activeSpace ?? enterpriseSpace(CURRENT_ORG_ID, '当前组织')
  const value = {
    accountId,
    activeProductSpaceId: activeSpace.id as string,
    activeProductSpace: activeSpace,
    productSpaces,
    allProductSpaces: productSpaces,
    personalProductSpaceId: PERSONAL_ID,
    productSpaceContextKey: createProductSpaceContextKey(accountId, activeSpace.id as string),
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
  // U14 identity-bar mounts read the committed space through the shared
  // MemberCatalog surface too — mirror the provider value there.
  appCatalogHook.productSpace = value
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

function card(projectId: string): HTMLElement {
  const cardElement = screen.getAllByTestId('home-project-card')
    .find(candidate => candidate.getAttribute('data-product-space-id') === projectId)
  if (!cardElement) throw new Error(`project card not found: ${projectId}`)
  return cardElement
}

describe('HomePage 项目区域 (POO-205, Spec Q1/Q3/Q8)', () => {
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

  it('P2: pm:listProjects summaries render as cards with the caller role and member count, carrying the PROJECT id and owning org space', async () => {
    installProjectDirectory([
      projectSummary('pj-a', '华东区资料库', { myRole: 'owner', purpose: '区域销售资料', memberCount: 5 }),
      projectSummary('pj-b', '安控项目'),
    ])
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(2))

    const cardA = card('pj-a')
    expect(cardA.getAttribute('data-product-space-id')).toBe('pj-a')
    expect(cardA.textContent).toContain('华东区资料库')
    // Role badge from the real productSpace.role.* keys, member count only
    // when the source knows it (P4).
    expect(cardA.textContent).toContain('所有者')
    expect(cardA.textContent).toContain('5 位成员')
    expect(card('pj-b').textContent).toContain('成员')
    // The badge marks the ENTERED project (active-project bus) — none yet.
    expect(screen.queryByTestId('home-project-current')).toBeNull()
  })

  it('P3: cards order by the device-local visit record (recency first) and Enter activates the card through the host prop', async () => {
    const onEnterProject = jest.fn()
    recordProjectVisit(ACCOUNT_ID, 'pj-a', 2_000)
    recordProjectVisit(ACCOUNT_ID, 'pj-b', 1_000)
    installProjectDirectory([
      projectSummary('pj-a', '华东区资料库'),
      projectSummary('pj-b', '安控项目'),
      projectSummary('pj-c', '巡检项目'),
    ])
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')], onEnterProject))
    // Recency first (P3): the 2_000 visit leads the 1_000 visit, which still
    // leads the never-visited project.
    await waitFor(() => {
      const ids = screen.getAllByTestId('home-project-card')
        .map(item => item.getAttribute('data-product-space-id'))
      expect(ids).toEqual(['pj-a', 'pj-b', 'pj-c'])
    })

    fireEvent.click(card('pj-c'))
    expect(onEnterProject).toHaveBeenCalledWith('pj-c')
    fireEvent.keyDown(card('pj-a'), { key: 'Enter' })
    expect(onEnterProject).toHaveBeenCalledWith('pj-a')
    expect(onEnterProject).toHaveBeenCalledTimes(2)
  })

  it('P3/U9: the search is RESIDENT — an active query shows every match and suspends the expand/collapse controls; expand/collapse never erase the query', async () => {
    // Latin names keep sort order == insertion order, so index-based
    // visibility assertions stay readable.
    const projects = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => projectSummary(`pj-${index}`, `Project ${letter}`))
    installProjectDirectory(projects)
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))

    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.getByTestId('home-project-expand').textContent).toBe('查看全部（7）')
    // First two cards always visible; overflow hides via the grid's
    // responsive classes (index 2-4 only below 761px; index 5+ only ≥1081px).
    expect(card('pj-0').className).not.toContain('hidden')
    expect(card('pj-2').className).toContain('hidden min-[761px]:block')
    expect(card('pj-6').className).toContain('hidden min-[761px]:hidden min-[1081px]:block')

    // An active query shows EVERY match over the full authorized set — G
    // sits beyond the second row and still renders — while the expand/
    // collapse controls suspend.
    const search = screen.getByTestId('home-project-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Project G' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)
    expect(card('pj-6').className).not.toContain('hidden')
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    expect(screen.queryByTestId('home-project-collapse')).toBeNull()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()

    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByTestId('home-project-no-matches').textContent).toBe('没有匹配的项目')
    expect(screen.queryAllByTestId('home-project-card')).toHaveLength(0)
    expect(search.nextElementSibling?.getAttribute('data-testid')).toBe('home-project-no-matches')

    // Clearing the query restores the ORIGINAL expansion preference.
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(7)
    expect(card('pj-6').className).toContain('hidden')
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()

    fireEvent.click(screen.getByTestId('home-project-expand'))
    expect(card('pj-6').className).not.toContain('hidden')
    expect(screen.getByTestId('home-project-collapse')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'Project B' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)
    expect(screen.queryByTestId('home-project-collapse')).toBeNull()
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    expect((search as HTMLInputElement).value).toBe('Project B')
    fireEvent.change(search, { target: { value: '' } })
    expect(card('pj-6').className).not.toContain('hidden')
    fireEvent.click(screen.getByTestId('home-project-collapse'))
    expect(card('pj-6').className).toContain('hidden')
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    expect((search as HTMLInputElement).value).toBe('')
  })

  it('P3: the expand control tracks the breakpoint capacity (2×columns) instead of a fixed count', async () => {
    const four = ['A', 'B', 'C', 'D']
      .map((letter, index) => projectSummary(`pj-${index}`, `Project ${letter}`))
    installProjectDirectory(four)
    const { unmount } = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(4))
    expect(screen.getByTestId('home-project-expand').parentElement?.className).toContain('min-[761px]:hidden')
    expect(card('pj-2').className).toContain('hidden min-[761px]:block')
    unmount()

    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => projectSummary(`pj-${index}`, `Project ${letter}`))
    installProjectDirectory(seven)
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect(screen.getByTestId('home-project-expand').parentElement?.className).not.toContain('min-[761px]:hidden')
    expect(screen.getByTestId('home-project-expand').parentElement?.className).not.toContain('min-[1081px]:hidden')
  })

  it('P4: a failed pm:listProjects renders the load-failed face, never 「还没有项目」; a version mismatch loses the retry (U4 local guide only on an unhosted mount)', async () => {
    pmListProjects.mockImplementation(async () => { throw { code: 'contract_version_unsupported' } })
    const first = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    const errorFace = await screen.findByTestId('home-project-error')
    expect(errorFace.textContent).toContain('当前连接的服务暂不支持此功能，需要管理员检查服务版本。')
    expect(screen.queryByTestId('home-project-error-retry')).toBeNull()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()

    const guide = screen.getByTestId('home-project-update-guide')
    expect(guide.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(guide)
    const guideBody = screen.getByTestId('home-project-update-guide-body')
    expect(guideBody.textContent).toContain('请联系单位的 Polo 管理员，告知当前无法使用项目功能，请其检查服务与客户端版本是否兼容。')
    expect(screen.queryByTestId('home-project-client-update')).toBeNull()
    expect(guide.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(guide)
    expect(screen.queryByTestId('home-project-update-guide-body')).toBeNull()
    first.unmount()

    // A generic failure keeps the retry, and the retry re-runs the request.
    pmListProjects.mockImplementation(async () => { throw new Error('transport down') })
    const { unmount } = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await screen.findByTestId('home-project-error')
    expect(screen.getByTestId('home-project-error').textContent).toContain('无法加载项目')
    expect(screen.getByTestId('home-project-error-retry')).toBeTruthy()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()
    fireEvent.click(screen.getByTestId('home-project-error-retry'))
    await waitFor(() => expect(pmListProjects.mock.calls.length).toBeGreaterThanOrEqual(2))
    unmount()
  })

  it('a PERSONAL committed space has no project scope: the honest org-required face instead of a directory that could only fail', async () => {
    const personalSpace = { id: PERSONAL_ID, kind: 'personal', name: '我的个人空间', accessMode: 'active', payer: { kind: 'account' } }
    render(homeTree([], undefined, { activeSpace: personalSpace }))
    await waitFor(() => expect(screen.getByTestId('home-project-empty')).toBeTruthy())
    // The verified-empty face + the resident search; NO cards and NO wire
    // call (the pm channel is committed-organization scoped).
    expect(screen.queryAllByTestId('home-project-card')).toHaveLength(0)
    expect(pmListProjects.mock.calls).toHaveLength(0)
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
  })
})

describe('HomePage U14 — 卡片层级（POO-205 保留）', () => {
  // POO-205 C8 (R8): the ONE settings entry is the project tab sidebar's
  // gear — the home card keeps a SINGLE action (enter), even for an owner.
  it('R8: an owner project card has NO settings button — the card actions are role badge, count and the「进入项目」label only', async () => {
    installProjectDirectory([
      projectSummary('pj-owner', '华东区资料库', { myRole: 'owner' }),
    ])
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(1))
    expect(screen.queryByTestId('home-project-settings')).toBeNull()
    expect(screen.queryByTestId('home-project-settings-dialog')).toBeNull()
    expect(card('pj-owner').textContent).toContain('所有者')
    expect(card('pj-owner').textContent).toContain('进入项目')
  })

  it('U14: project cards gain the conversation bubble at the name level and keep the「进入项目」label, role badge, 「当前」marker and the FROZEN card chrome', async () => {
    installProjectDirectory([
      projectSummary('pj-entered', '已进入的项目', { myRole: 'owner' }),
      projectSummary('pj-other', '华东区资料库'),
    ])
    // POO-205: 「当前」marks the ENTERED project via the active-project bus.
    setActiveProject({
      accountId: ACCOUNT_ID,
      organizationProductSpaceId: CURRENT_ORG_ID,
      organizationEnterpriseId: ORG_ENTERPRISE_ID,
      projectId: 'pj-entered',
      name: '已进入的项目',
      myRole: 'owner',
    })
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(2))

    // New section copy (项目 → 我们的项目 + U14 说明).
    expect(screen.getByTestId('home-projects').textContent).toContain('我们的项目')
    expect(screen.getByTestId('home-projects').textContent).toContain('和同事一起看资料、聊工作。')

    for (const id of ['pj-entered', 'pj-other']) {
      const cardElement = card(id)
      const nameHeading = cardElement.querySelector('h3')
      expect(nameHeading?.querySelector('svg')).toBeTruthy()
      expect(cardElement.querySelector('[data-testid="home-project-enter-label"]')?.textContent).toContain('进入项目')
      // Frozen POO-41 card language untouched: radius / material / hover
      // lift / outline.
      expect(cardElement.className).toContain('rounded-[20px]')
      expect(cardElement.className).toContain('client-material-card')
      expect(cardElement.className).toContain('hover:-translate-y-[1px]')
      expect(cardElement.className).toContain('hover:shadow-middle')
      const nameText = cardElement.querySelector('h3 span')?.textContent ?? ''
      expect(nameText.length).toBeGreaterThan(0)
      expect(cardElement.getAttribute('aria-label')).toBe(nameText)
    }
    // The「当前」badge rides the ENTERED project only.
    expect(card('pj-entered').querySelector('[data-testid="home-project-current"]')).toBeTruthy()
    expect(card('pj-other').querySelector('[data-testid="home-project-current"]')).toBeNull()

    const grid = screen.getAllByTestId('home-project-card')[0]!.parentElement!
    expect(grid.className).toContain('grid-cols-1')
    expect(grid.className).toContain('min-[761px]:grid-cols-2')
    expect(grid.className).toContain('min-[1081px]:grid-cols-3')
  })

  it('U9: the search stays discoverable with 0 / 1 / 7 projects (loading and failure never fake a search result)', async () => {
    installProjectDirectory([])
    const emptyView = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getByTestId('home-project-empty')).toBeTruthy())
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()
    emptyView.unmount()

    installProjectDirectory([projectSummary('pj-one', '唯一项目')])
    const oneView = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(1))
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    oneView.unmount()

    const projects = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => projectSummary(`pj-${index}`, `Project ${letter}`))
    installProjectDirectory(projects)
    const sevenView = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    sevenView.unmount()

    pmListProjects.mockImplementation(async () => { throw new Error('transport down') })
    render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await screen.findByTestId('home-project-error')
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()
  })

  it('U9: an account change clears the project query (the query never crosses accounts)', async () => {
    const projects = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => projectSummary(`pj-${index}`, `Project ${letter}`))
    installProjectDirectory(projects)
    const view = render(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    const search = screen.getByTestId('home-project-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Project B' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)

    // A different signed-in account remounts the same section with a FRESH
    // query — the filter no longer applies.
    const accountBProjects = projects.map(project => ({ ...project, id: `b-${project.id}` }))
    installProjectDirectory(accountBProjects)
    view.rerender(homeTree([enterpriseSpace(CURRENT_ORG_ID, '当前组织')], undefined, { accountId: 'account-projects-b' }))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect((screen.getByTestId('home-project-search') as HTMLInputElement).value).toBe('')
  })
})
