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

  it('P3/U9 (旧→新映射): the search is RESIDENT — an active query shows every match and suspends the expand/collapse controls; expand/collapse never erase the query', async () => {
    // Latin names keep sort order == insertion order, so index-based
    // visibility assertions stay readable.
    const spaces = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(spaces, spaces.map(space => space.id))
    render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))

    // U9 旧→新: the search used to belong to the expanded state only; it is
    // now RESIDENT — discoverable in the collapsed default, decoupled from
    // the expand/collapse preference (which still announces the full count).
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.getByTestId('home-project-expand').textContent).toBe('查看全部（7）')
    // First two cards always visible; overflow hides via the grid's
    // responsive classes (index 2-4 only below 761px; index 5+ only ≥1081px).
    expect(card('space-0').className).not.toContain('hidden')
    expect(card('space-2').className).toContain('hidden min-[761px]:block')
    expect(card('space-6').className).toContain('hidden min-[761px]:hidden min-[1081px]:block')

    // An active query shows EVERY match over the full authorized set — G
    // sits beyond the second row and still renders — while the expand/
    // collapse controls suspend (no meaningless toggles, no implicit path
    // that could erase the query).
    const search = screen.getByTestId('home-project-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Project G' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)
    expect(card('space-6').className).not.toContain('hidden')
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    expect(screen.queryByTestId('home-project-collapse')).toBeNull()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()

    fireEvent.change(search, { target: { value: '不存在' } })
    expect(screen.getByTestId('home-project-no-matches').textContent).toBe('没有匹配的项目')
    expect(screen.queryAllByTestId('home-project-card')).toHaveLength(0)
    // U9: the no-match hint sits DIRECTLY below the input (same wrapper,
    // immediately following element — never above the input, never in the
    // app region).
    expect(search.nextElementSibling?.getAttribute('data-testid')).toBe('home-project-no-matches')

    // Clearing the query restores the ORIGINAL expansion preference (still
    // collapsed → two rows + 查看全部（7）), not a forced expand.
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(7)
    expect(card('space-6').className).toContain('hidden')
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()

    // Expand → an active query suspends BOTH controls, so a collapse click
    // cannot even exist while filtering — implicit erasure is impossible by
    // construction; clearing is the input's own gesture alone.
    fireEvent.click(screen.getByTestId('home-project-expand'))
    expect(card('space-6').className).not.toContain('hidden')
    expect(screen.getByTestId('home-project-collapse')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'Project B' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)
    expect(screen.queryByTestId('home-project-collapse')).toBeNull()
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    expect((search as HTMLInputElement).value).toBe('Project B')
    fireEvent.change(search, { target: { value: '' } })
    // The preference stayed expanded (the suspended round trip never
    // flipped it), and flipping it now leaves the input untouched.
    expect(card('space-6').className).not.toContain('hidden')
    fireEvent.click(screen.getByTestId('home-project-collapse'))
    expect(card('space-6').className).toContain('hidden')
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    expect((search as HTMLInputElement).value).toBe('')
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

  it('P4: a failed negotiation renders the load-failed face, never 「还没有项目」; a version mismatch loses the retry (U4: expandable local guide, no dead settings shortcut on an unhosted mount)', async () => {
    pmListR3.mockImplementation(async () => { throw { code: 'contract_version_unsupported' } })
    const first = render(homeTree([]))
    const errorFace = await screen.findByTestId('home-project-error')
    // U1/U4 copy ruling: the version face names the SERVICE as the thing to
    // check (旧→新映射: 「当前服务尚不支持项目列表…」→「当前连接的服务暂不
    // 支持此功能…」).
    expect(errorFace.textContent).toContain('当前连接的服务暂不支持此功能，需要管理员检查服务版本。')
    expect(screen.queryByTestId('home-project-error-retry')).toBeNull()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()

    // U4: the face opens with a collapsed「查看更新指引」guide; expanding
    // reveals the admin escalation copy. THIS mount has no AppShell host, so
    // the client-update shortcut must NOT render (degraded local guide only).
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

describe('HomePage UB5 — U9 常驻搜索 / U14 空间身份层级与卡片层级', () => {
  /** The negotiated summary map the current space's identity classification
   * reads — `kinds` maps productSpaceId → enterpriseKind; ids WITHOUT an
   * entry stay unclassified (neutral 当前空间 face). */
  function installDirectoryWithKinds(
    productSpaces: unknown[],
    kinds: Record<string, 'organization' | 'project'>,
  ) {
    pmListR3.mockImplementation(async () => ({
      contractVersion: R3_VERSION,
      spaces: {
        contractVersion: '1',
        personalProductSpaceId: PERSONAL_ID,
        productSpaces,
      },
      enterpriseSummaries: Object.entries(kinds).map(([productSpaceId, enterpriseKind]) => ({
        productSpaceId,
        enterpriseId: `ent-${productSpaceId}`,
        enterpriseKind,
      })),
    }))
  }

  it('U14: the identity bar classifies the committed space from the negotiated summary type — organization / project / unclassified, the real name verbatim (never name-guessed, never stripped)', async () => {
    // The committed name deliberately CONTAINS「项目空间」— the identity bar
    // must render it verbatim inside the category template.
    const committed = enterpriseSpace(CURRENT_ORG_ID, 'Apollo 项目空间')
    const spaces = [committed, enterpriseSpace('space-proj-a', '华东区资料库')]

    // organization aggregate → 「当前单位：Apollo 项目空间」.
    installDirectoryWithKinds(spaces, { [CURRENT_ORG_ID]: 'organization', 'space-proj-a': 'project' })
    const orgView = render(homeTree(spaces, undefined, { activeSpace: committed }))
    await waitFor(() => expect(screen.getByTestId('home-space-context-title').textContent).toBe('当前单位：Apollo 项目空间'))
    orgView.unmount()

    // The committed space IS a project → 「当前项目：…」(never misnamed as
    // the organization).
    installDirectoryWithKinds(spaces, { [CURRENT_ORG_ID]: 'project', 'space-proj-a': 'project' })
    const projectView = render(homeTree(spaces, undefined, { activeSpace: committed }))
    await waitFor(() => expect(screen.getByTestId('home-space-context-title').textContent).toBe('当前项目：Apollo 项目空间'))
    projectView.unmount()

    // No verifiable summary for the committed space → the NEUTRAL face
    // (「当前空间：…」) — the name is still the full committed name.
    installDirectoryWithKinds(spaces, { 'space-proj-a': 'project' })
    const unknownView = render(homeTree(spaces, undefined, { activeSpace: committed }))
    await waitFor(() => expect(screen.getByTestId('home-space-context-title').textContent).toBe('当前空间：Apollo 项目空间'))
    // The description keys stay the U12 values, keyed by space kind.
    expect(screen.getByTestId('home-space-context').textContent).toContain('发布到当前空间的应用。')
    unknownView.unmount()
  })

  it('U14: a personal home classifies as 「个人空间：{{name}}」 through the circles fallback mount; the circles entry stays personal-only', async () => {
    installDirectoryWithKinds([], {})
    const personalSpace = { id: PERSONAL_ID, kind: 'personal', name: '我的个人空间', accessMode: 'active', payer: { kind: 'account' } }
    const view = render(homeTree([], undefined, { activeSpace: personalSpace }))
    // The personal hero carries the circles entry (catalog provides it).
    await waitFor(() => expect(screen.getByTestId('home-circles-link')).toBeTruthy())
    // Without the App's ClientPage provider the link falls back to the local
    // identity card — the U14 personal face.
    fireEvent.click(screen.getByTestId('home-circles-link'))
    await waitFor(() => expect(screen.getByTestId('home-space-context-title').textContent).toBe('个人空间：我的个人空间'))
    expect(screen.getByTestId('home-space-context').textContent).toContain('你的个人空间与圈子应用。')
    view.unmount()
  })

  it('U14: project cards gain the conversation bubble at the name level and keep the U3「进入项目」label, role/read-only/current markers and the FROZEN card chrome', async () => {
    installProjectDirectory([
      enterpriseSpace(CURRENT_ORG_ID, '当前项目空间'),
      enterpriseSpace('space-proj-a', '华东区资料库'),
      enterpriseSpace('space-proj-readonly', '受限项目', { accessMode: 'read_only' }),
    ], [CURRENT_ORG_ID, 'space-proj-a', 'space-proj-readonly'])
    render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(3))

    // New section copy (旧→新: 项目 → 我们的项目 + U14 说明).
    expect(screen.getByTestId('home-projects').textContent).toContain('我们的项目')
    expect(screen.getByTestId('home-projects').textContent).toContain('和同事一起看资料、聊工作。')

    for (const id of [CURRENT_ORG_ID, 'space-proj-a', 'space-proj-readonly']) {
      const cardElement = card(id)
      // The name row leads with the decorative bubble icon.
      const nameHeading = cardElement.querySelector('h3')
      expect(nameHeading?.querySelector('svg')).toBeTruthy()
      // The U3 label rides bottom-right (shared, non-nested marker).
      expect(cardElement.querySelector('[data-testid="home-project-enter-label"]')?.textContent).toContain('进入项目')
      // Frozen POO-41 card language untouched: radius / material / hover
      // lift / outline.
      expect(cardElement.className).toContain('rounded-[20px]')
      expect(cardElement.className).toContain('client-material-card')
      expect(cardElement.className).toContain('hover:-translate-y-[1px]')
      expect(cardElement.className).toContain('hover:shadow-middle')
      // The accessible name stays the PURE project name (icon excluded).
      const nameText = cardElement.querySelector('h3 span')?.textContent ?? ''
      expect(nameText.length).toBeGreaterThan(0)
      expect(cardElement.getAttribute('aria-label')).toBe(nameText)
    }
    // Markers preserved: 当前 badge unique, 只读 on the read-only card.
    expect(card(CURRENT_ORG_ID).querySelector('[data-testid="home-project-current"]')).toBeTruthy()
    expect(card('space-proj-readonly').querySelector('[data-testid="home-project-readonly"]')).toBeTruthy()

    // Frozen grid breakpoints on the section's card grid.
    const grid = screen.getAllByTestId('home-project-card')[0]!.parentElement!
    expect(grid.className).toContain('grid-cols-1')
    expect(grid.className).toContain('min-[761px]:grid-cols-2')
    expect(grid.className).toContain('min-[1081px]:grid-cols-3')
  })

  it('U14: the identity bar renders compact — 8px vertical padding, 13px semibold name, 12px secondary description', async () => {
    installDirectoryWithKinds([], {})
    render(homeTree([]))
    await waitFor(() => expect(screen.getByTestId('home-space-context')).toBeTruthy())
    const section = screen.getByTestId('home-space-context')
    expect(section.className).toContain('py-[8px]')
    const title = screen.getByTestId('home-space-context-title')
    expect(title.className).toContain('text-[13px]')
    expect(title.className).toContain('font-semibold')
  })

  it('U9: the search stays discoverable with 0 / 1 / 7 projects (loading and failure never fake a search result)', async () => {
    // 0 projects: the verified-empty face AND the resident search.
    installProjectDirectory([], [])
    const emptyView = render(homeTree([]))
    await waitFor(() => expect(screen.getByTestId('home-project-empty')).toBeTruthy())
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()
    emptyView.unmount()

    // 1 project: single card + resident search + no expand control.
    installProjectDirectory([enterpriseSpace('space-one', '唯一项目')], ['space-one'])
    const oneView = render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(1))
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-expand')).toBeNull()
    oneView.unmount()

    // 7 projects: resident search + the full-count expand control.
    const spaces = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(spaces, spaces.map(space => space.id))
    const sevenView = render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.getByTestId('home-project-expand')).toBeTruthy()
    sevenView.unmount()

    // Loading / failure faces are never replaced by search-empty results.
    pmListR3.mockImplementation(async () => { throw new Error('transport down') })
    render(homeTree([]))
    await screen.findByTestId('home-project-error')
    expect(screen.getByTestId('home-project-search')).toBeTruthy()
    expect(screen.queryByTestId('home-project-no-matches')).toBeNull()
    expect(screen.queryByTestId('home-project-empty')).toBeNull()
  })

  it('U9: an account change clears the project query (the query never crosses accounts)', async () => {
    const spaces = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
      .map((letter, index) => enterpriseSpace(`space-${index}`, `Project ${letter}`))
    installProjectDirectory(spaces, spaces.map(space => space.id))
    const view = render(homeTree([]))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    const search = screen.getByTestId('home-project-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'Project B' } })
    expect(screen.getAllByTestId('home-project-card')).toHaveLength(1)

    // A different signed-in account remounts the same section with a FRESH
    // query — the filter no longer applies.
    const accountBSpaces = spaces.map(space => ({ ...space, id: `b-${space.id}` }))
    installProjectDirectory(accountBSpaces, accountBSpaces.map(space => space.id))
    view.rerender(homeTree(accountBSpaces, undefined, { accountId: 'account-projects-b' }))
    await waitFor(() => expect(screen.getAllByTestId('home-project-card')).toHaveLength(7))
    expect((screen.getByTestId('home-project-search') as HTMLInputElement).value).toBe('')
  })
})
