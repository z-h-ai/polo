import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  MemberCircleEntitlement,
} from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { AppCatalogInstance } from '../../../hooks/useAppCatalog'
import type { ProductSpaceAppLaunchHandoff } from '../../../context/ProductSpaceContext'
import type {
  MemberCircleDetailView,
} from '../../../lib/member-circle-view'
import type { CircleContentPanelContextValue } from '../CircleContentPanel'
import { selectHomeAppDirectory } from '../../../lib/home-app-directory'

GlobalRegistrator.register()
setupI18n()

const toastErrorSpy = jest.fn()
const toastSuccessSpy = jest.fn()

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: (...args: unknown[]) => toastSuccessSpy(...args),
  },
}))

const { cleanup, fireEvent, render, screen, within } = await import(
  '@testing-library/react'
)
const { CircleContentPanel, selectCircleContentApps } = await import(
  '../CircleContentPanel'
)
const { selectCircleSkillSummaries } = await import('../CircleSkillSummary')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const accountId = 'account-1'
const spaceId = 'space-personal'

function catalogApp(
  overrides: Partial<CatalogApp> & Pick<CatalogApp, 'id' | 'name'>,
): CatalogApp {
  return {
    organizationId: spaceId,
    description: '',
    deliveryMode: 'resolve_launch',
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

function personalCatalog(
  apps: CatalogApp[],
  overrides: Partial<AppCatalogCacheEntry> = {},
): AppCatalogCacheEntry {
  return {
    accountId,
    organizationId: spaceId,
    appConfigVersion: 'catalog-rev-1',
    authorizationStatus: 'authorized',
    syncedAt: 1,
    apps,
    trustedReleases: {},
    warnings: [],
    withdrawnApps: [],
    ...overrides,
  }
}

function directoryContext(
  overrides: Record<string, unknown> = {},
): Parameters<typeof selectHomeAppDirectory>[1] {
  return {
    accountId,
    productSpaceId: spaceId,
    spaceKind: 'personal' as const,
    ...overrides,
  }
}

let entitlementSeq = 0
function skillEntitlement(
  overrides: Partial<Omit<MemberCircleEntitlement, 'artifact' | 'artifactVersion'>> & {
    artifact?: Partial<MemberCircleEntitlement['artifact']>
    artifactVersion?: Partial<MemberCircleEntitlement['artifactVersion']>
  } = {},
): MemberCircleEntitlement {
  entitlementSeq += 1
  const id = overrides.id ?? `ent-skill-${entitlementSeq}`
  // artifact / artifactVersion are merged per-field; the remaining top-level
  // overrides apply verbatim (a trailing full spread would clobber the
  // merged artifact object and drop its `type`).
  const { artifact, artifactVersion, ...restOverrides } = overrides
  return {
    id,
    circleId: 'circle-1',
    artifactId: `artifact-skill-${entitlementSeq}`,
    sourceKind: 'active_distribution',
    sourceValidUntil: null,
    artifact: {
      id: `artifact-skill-${entitlementSeq}`,
      type: 'skill',
      slug: `skill-${entitlementSeq}`,
      name: '资料研究',
      summary: '检索打法与案例',
      status: 'published',
      currentStableVersionId: `stable-version-${entitlementSeq}`,
      ...artifact,
    },
    artifactVersion: {
      id: `stable-version-${entitlementSeq}`,
      version: '1.0.0',
      status: 'published',
      publishedAt: '2026-09-01T00:00:00.000Z',
      ...artifactVersion,
    },
    ...restOverrides,
  } as MemberCircleEntitlement
}

function appClassEntitlement(
  overrides: Partial<MemberCircleEntitlement> = {},
): MemberCircleEntitlement {
  const entitlement = skillEntitlement(overrides)
  return {
    ...entitlement,
    artifact: { ...entitlement.artifact, type: 'web_app', name: '增长打法手册' },
  } as MemberCircleEntitlement
}

let circleSeq = 0
function readyCircle(
  overrides: {
    circleId?: string
    entitlements?: MemberCircleEntitlement[]
    circleStatus?: 'active' | 'suspended' | 'closing' | 'closed'
  } = {},
): MemberCircleDetailView {
  circleSeq += 1
  const circleId = overrides.circleId ?? `circle-${circleSeq}`
  return {
    availability: 'ready',
    circle: {
      membershipId: `membership-${circleId}`,
      status: 'active',
      billingKind: 'free',
      modeTransitionEndsAt: null,
      currentPeriodEnd: null,
      joinSource: 'share_link',
      joinedAt: '2026-09-01T00:00:00.000Z',
      circle: {
        circleId,
        name: '晨星增长圈',
        purpose: '增长打法分享',
        status: overrides.circleStatus ?? 'active',
        ownerUserId: '00000000-0000-0000-0000-000000000001',
      },
      entitlements: overrides.entitlements ?? [],
    },
    membership: null,
    creatorName: { readiness: 'upstream_pending', contractGap: 'G1' },
    entitlementJudgment: null,
    entitlements: overrides.entitlements ?? [],
  }
}

function fakeCatalog(overrides: Record<string, unknown> = {}): AppCatalogInstance {
  return {
    state: {
      catalog: { accountId, organizationId: spaceId, apps: [], withdrawnApps: [] },
      loading: false,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      accessMode: 'online',
      statuses: {},
      installStates: {},
    },
    uiIdentityKeyForApp: (app: CatalogApp) => `ui:${app.id}`,
    resolveLaunch: jest.fn(async (app: CatalogApp): Promise<ResolveLaunchResponse> => ({
      contractVersion: 1,
      productSpaceId: app.organizationId,
      catalogEntryId: app.catalogEntryId ?? app.id,
      resolvedAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:10:00.000Z',
      subject: {
        kind: 'artifact_instance',
        artifactType: 'app',
        artifactInstanceId: app.artifactInstanceId ?? `artifact-${app.id}`,
        versionId: app.catalogVersion?.versionId ?? 'version-1',
        version: app.catalogVersion?.version ?? '1.0.0',
      },
      payer: { kind: 'personal', accountId },
      delivery: {
        kind: 'web_url',
        url: 'https://fresh.example.com',
        launchToken: 'launch-token-value',
      },
    } as unknown as ResolveLaunchResponse)),
    getInstallState: () => undefined,
    installProductSpaceBundle: jest.fn(async () => {}),
    sync: jest.fn(async () => {}),
    ...overrides,
  } as unknown as AppCatalogInstance
}

function fakeHandoff() {
  return {
    publish: jest.fn(),
    take: () => null,
    onLaunch: () => () => {},
  }
}

function panelContext(
  catalog: AppCatalogInstance,
): CircleContentPanelContextValue {
  return {
    directory: selectHomeAppDirectory(catalog.state.catalog, directoryContext({
      loading: catalog.state.loading,
      errorCode: catalog.state.errorCode,
      accessMode: catalog.state.accessMode,
    })),
    catalog,
    spaceKind: 'personal',
    launchHandoff: fakeHandoff() as unknown as ProductSpaceAppLaunchHandoff,
  }
}

function renderPanel(
  circle: MemberCircleDetailView,
  context: CircleContentPanelContextValue,
) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(CircleContentPanel, {
      circle,
      context,
    })),
  )
}

/** Re-directory with explicit H1 context overrides (e.g. lostCircleIds). */
function contextWithDirectory(
  catalog: AppCatalogInstance,
  h1Overrides: Record<string, unknown>,
  extra: Partial<CircleContentPanelContextValue> = {},
): CircleContentPanelContextValue {
  return {
    directory: selectHomeAppDirectory(
      catalog.state.catalog,
      directoryContext({
        loading: catalog.state.loading,
        errorCode: catalog.state.errorCode,
        accessMode: catalog.state.accessMode,
        ...h1Overrides,
      }),
    ),
    catalog,
    spaceKind: 'personal',
    launchHandoff: fakeHandoff() as unknown as ProductSpaceAppLaunchHandoff,
    ...extra,
  }
}

beforeEach(async () => {
  toastErrorSpy.mockClear()
  toastSuccessSpy.mockClear()
  entitlementSeq = 0
  circleSeq = 0
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// P70-CIRCLE-CONTENT-01 — two sections, H1/H2 reuse, complete identity
// ---------------------------------------------------------------------------

describe('CircleContentPanel (P70-CIRCLE-CONTENT-01 apps/skills sections)', () => {
  it('projects only THIS circle\'s apps from the H1 directory and opens through the shared action with the complete app', async () => {
    const app = catalogApp({
      id: 'entry-growth',
      catalogEntryId: 'entry-growth',
      artifactInstanceId: 'artifact-growth',
      name: '增长打法手册',
      catalogVersion: { versionId: 'version-growth', version: '1.2.0' },
      catalogSources: [
        { kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' },
        { kind: 'polo', name: 'Polo' },
      ],
    })
    const otherApp = catalogApp({
      id: 'entry-other',
      catalogEntryId: 'entry-other',
      artifactInstanceId: 'artifact-other',
      name: '别的圈子的应用',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-2', name: '设计圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app, otherApp]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const context = panelContext(catalog)
    const circle = readyCircle({ circleId: 'circle-1' })
    renderPanel(circle, context)

    const panel = screen.getByTestId('circle-content-panel')
    expect(screen.getByTestId('circle-content-apps-section')).toBeTruthy()
    // Only THIS circle's row is projected; the other circle's row is not.
    expect(screen.getByText('增长打法手册')).toBeTruthy()
    expect(screen.queryByText('别的圈子的应用')).toBeNull()
    // H2 detail variant card, with source identification kept.
    const cards = within(panel).getAllByTestId('circle-content-app-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.getAttribute('data-variant')).toBe('detail')
    // Detail keeps circle source, stable version and complete identity.
    const row = screen.getByTestId(
      `circle-content-app-${cards[0]!.getAttribute('data-identity-key')}`,
    )
    expect(row.getAttribute('data-catalog-entry-id')).toBe('entry-growth')
    expect(row.getAttribute('data-artifact-instance-id')).toBe('artifact-growth')
    expect(row.getAttribute('data-stable-version')).toBe('1.2.0')
    expect(row.getAttribute('data-launch-blocked')).toBe('false')
    expect(screen.getByTestId(
      `circle-content-app-reason-${cards[0]!.getAttribute('data-identity-key')}`,
    ).textContent).toContain('v1.2.0')

    // Open goes through the SHARED action: resolveLaunch receives the FULL
    // CatalogApp (complete identity preserved for the launch grant).
    fireEvent.click(cards[0]!)
    await new Promise(resolve => setTimeout(resolve, 0))
    const typedCatalog = catalog.resolveLaunch as unknown as ReturnType<typeof jest.fn>
    expect(typedCatalog).toHaveBeenCalledWith(app)
  })

  it('shows the same work in BOTH circles when two circles authorize it, each with its own matched source', () => {
    // D-PC-09: the same work distributed to two circles keeps ONE stable
    // identity with TWO creator_circle sources.
    const app = catalogApp({
      id: 'entry-shared',
      catalogEntryId: 'entry-shared',
      artifactInstanceId: 'artifact-shared',
      name: '会议纪要整理',
      catalogSources: [
        { kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' },
        { kind: 'creator_circle', circleId: 'circle-2', name: '晨星设计圈' },
      ],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const context = panelContext(catalog)
    const first = renderPanel(readyCircle({ circleId: 'circle-1' }), context)
    expect(screen.getByText('会议纪要整理')).toBeTruthy()
    first.unmount()
    const second = renderPanel(readyCircle({ circleId: 'circle-2' }), context)
    expect(screen.getByText('会议纪要整理')).toBeTruthy()
    second.unmount()
    // Pure projection sanity: both circles match the same single row.
    const directory = selectHomeAppDirectory(
      personalCatalog([app]),
      directoryContext(),
    )
    expect(selectCircleContentApps(directory, 'circle-1')).toHaveLength(1)
    expect(selectCircleContentApps(directory, 'circle-2')).toHaveLength(1)
    expect(selectCircleContentApps(directory, 'circle-3')).toHaveLength(0)
  })

  it('keeps same-name works from one circle as separate rows with correct identities', async () => {
    // 同名不同作品: same display name, distinct stable identities — never
    // merged by name, never opened as the wrong work.
    const reportA = catalogApp({
      id: 'entry-report-a',
      catalogEntryId: 'entry-report-a',
      artifactInstanceId: 'artifact-report-a',
      name: '周报助手',
      sortOrder: 0,
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    })
    const reportB = catalogApp({
      id: 'entry-report-b',
      catalogEntryId: 'entry-report-b',
      artifactInstanceId: 'artifact-report-b',
      name: '周报助手',
      sortOrder: 1,
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([reportA, reportB]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    const cards = screen.getAllByTestId('circle-content-app-card')
    expect(cards).toHaveLength(2)
    const keys = cards.map(card => card.getAttribute('data-identity-key')!)
    expect(keys[0]).not.toEqual(keys[1])
    // Opening the SECOND row resolves THAT work's artifact instance, not the
    // first same-name row's.
    fireEvent.click(cards[1]!)
    await new Promise(resolve => setTimeout(resolve, 0))
    const resolveLaunch = catalog.resolveLaunch as unknown as ReturnType<typeof jest.fn>
    expect(resolveLaunch).toHaveBeenCalledTimes(1)
    const launchedApp = resolveLaunch.mock.calls[0][0] as CatalogApp
    expect(launchedApp.artifactInstanceId).toBe('artifact-report-b')
    expect(launchedApp.catalogEntryId).toBe('entry-report-b')
  })
})

// ---------------------------------------------------------------------------
// P70-CIRCLE-CONTENT-02 — read-only skill boundary, no big buttons
// ---------------------------------------------------------------------------

describe('CircleContentPanel (P70-CIRCLE-CONTENT-02 read-only skill boundary)', () => {
  it('renders skills read-only with name, summary, stable version and the purpose note, and NO actions', async () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const skill = skillEntitlement()
    renderPanel(
      readyCircle({ circleId: 'circle-1', entitlements: [skill] }),
      panelContext(catalog),
    )
    expect(screen.getByTestId('circle-content-skills-section')).toBeTruthy()
    const row = screen.getByTestId(`circle-content-skill-${skill.id}`)
    expect(row.getAttribute('data-stable-version-id')).toBe('stable-version-1')
    expect(screen.getByText('资料研究')).toBeTruthy()
    expect(screen.getByText('检索打法与案例')).toBeTruthy()
    // §13.13: the install-purpose note stays once per skill entry (rendered
    // on the same meta line as the version — substring match). The note is
    // CONDITIONAL: it must never assert an install that has not happened
    // (P70-CIRCLE-CONTENT-03 — no fabricated success facts).
    expect(screen.getByText(
      'After it is installed on this device, it can be used by the Polo assistant',
      { exact: false },
    )).toBeTruthy()
    // No actions at all: no install/manage buttons anywhere in the skills
    // section, and no 查看全部应用 / 管理本机技能 entries on the panel.
    const skillsSection = screen.getByTestId('circle-content-skills-section')
    expect(within(skillsSection).queryAllByRole('button')).toHaveLength(0)
    expect(within(screen.getByTestId('circle-content-panel')).queryAllByRole('button'))
      .toHaveLength(0)
    // Pure projection: skill-type entitlements only.
    const skills = selectCircleSkillSummaries([skill, appClassEntitlement()])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('资料研究')
    expect(skills[0]!.version).toBe('1.0.0')
  })

  it('renders a null-safe skill row when the receipt artifact name/summary are null (C1 nullable provider shape)', () => {
    // C1 ab9df8d8: Artifact.name / Artifact.summary are nullable DB columns
    // passed through verbatim. Null stays null — no fabricated fallback.
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const skill = skillEntitlement({
      artifact: { name: null, summary: null },
    })
    renderPanel(
      readyCircle({ circleId: 'circle-1', entitlements: [skill] }),
      panelContext(catalog),
    )
    const row = screen.getByTestId(`circle-content-skill-${skill.id}`)
    // Null name/summary render as empty — the row still exists with its
    // version + purpose meta line, and nothing crashes.
    expect(row.textContent).not.toContain('资料研究')
    expect(row.textContent).toContain('After it is installed on this device')
    expect(screen.queryByText('检索打法与案例')).toBeNull()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
    // Projection passes the nulls through verbatim.
    const skills = selectCircleSkillSummaries([skill])
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBeNull()
    expect(skills[0]!.summary).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P70-CIRCLE-CONTENT-03 — accurate no-works / lost / partial / exited feedback
// ---------------------------------------------------------------------------

describe('CircleContentPanel (P70-CIRCLE-CONTENT-03 accurate feedback)', () => {
  it('shows the honest vacuum when the circle has no verifiable apps and no skills', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    expect(screen.getByTestId('circle-content-empty')).toBeTruthy()
    expect(screen.queryByTestId('circle-content-skills-section')).toBeNull()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('keeps a lost circle source visible with its explanation and blocks the launch (single-source lost)', async () => {
    const app = catalogApp({
      id: 'entry-lost',
      catalogEntryId: 'entry-lost',
      artifactInstanceId: 'artifact-lost',
      name: '已失效来源的应用',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    // The member-circle authority reports circle-1's authorization lost.
    renderPanel(
      readyCircle({ circleId: 'circle-1' }),
      contextWithDirectory(catalog, { lostCircleIds: new Set(['circle-1']) }),
    )
    const cards = screen.getAllByTestId('circle-content-app-card')
    expect(cards).toHaveLength(1)
    const key = cards[0]!.getAttribute('data-identity-key')!
    const row = screen.getByTestId(`circle-content-app-${key}`)
    expect(row.getAttribute('data-launch-blocked')).toBe('true')
    expect(screen.getByTestId(`circle-content-app-reason-${key}`).textContent)
      .toContain("This circle's authorization has ended")
    // Fail closed: the open gate toasts and never touches resolve-launch.
    fireEvent.click(cards[0]!)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    expect(catalog.resolveLaunch).not.toHaveBeenCalled()
  })

  it('a lost source with ANOTHER valid source stays launchable and explains the lost circle source', () => {
    // D-PC-09: one lost circle source keeps the work usable (the home still
    // opens it); THIS circle's panel explains the lost source.
    const app = catalogApp({
      id: 'entry-multi',
      catalogEntryId: 'entry-multi',
      artifactInstanceId: 'artifact-multi',
      name: '多来源应用',
      catalogSources: [
        { kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' },
        { kind: 'creator_circle', circleId: 'circle-2', name: '晨星设计圈' },
      ],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(
      readyCircle({ circleId: 'circle-1' }),
      contextWithDirectory(catalog, { lostCircleIds: new Set(['circle-1']) }),
    )
    const key = screen.getByTestId('circle-content-app-card').getAttribute('data-identity-key')!
    expect(screen.getByTestId(`circle-content-app-${key}`).getAttribute('data-launch-blocked'))
      .toBe('false')
    expect(screen.getByTestId(`circle-content-app-reason-${key}`).textContent)
      .toContain("This circle's authorization has ended")
  })

  it('renders NO rows for an exited circle (unknown_circle) — nothing can launch through a cache', () => {
    const app = catalogApp({
      id: 'entry-exited',
      catalogEntryId: 'entry-exited',
      artifactInstanceId: 'artifact-exited',
      name: '已退出圈子的应用',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-gone', name: '已退出圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(
      { availability: 'unknown_circle' } as MemberCircleDetailView,
      contextWithDirectory(catalog, { lostCircleIds: new Set(['circle-gone']) }),
    )
    expect(screen.getByTestId('circle-content-exited')).toBeTruthy()
    // No rows, no cards, no open affordance, no skill material.
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
    expect(within(screen.getByTestId('circle-content-exited')).queryAllByRole('button'))
      .toHaveLength(0)
    expect(catalog.resolveLaunch).not.toHaveBeenCalled()
  })

  it('does NOT render the exit verdict while the C2 relations read is unsettled (loading/error/offline/partial/denied)', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    // `unknown_circle` also happens while the relations read has not
    // settled — absence must not become a premature "exited" verdict.
    const onRefreshRelations = jest.fn()
    const unsettledCases: Array<{ phase: 'loading' | 'error' | 'offline' | 'partial' | 'denied', testid: string, hasRetry: boolean }> = [
      { phase: 'loading', testid: 'circle-content-relations-loading', hasRetry: false },
      { phase: 'error', testid: 'circle-content-relations-error', hasRetry: true },
      { phase: 'offline', testid: 'circle-content-relations-offline', hasRetry: true },
      { phase: 'partial', testid: 'circle-content-relations-partial', hasRetry: true },
      { phase: 'denied', testid: 'circle-content-relations-denied', hasRetry: false },
    ]
    for (const testCase of unsettledCases) {
      const caseView = renderPanel(
        { availability: 'unknown_circle' } as MemberCircleDetailView,
        contextWithDirectory(catalog, {}, { relationsPhase: testCase.phase, onRefreshRelations }),
      )
      expect(screen.getByTestId(testCase.testid)).toBeTruthy()
      expect(screen.queryByTestId('circle-content-exited')).toBeNull()
      expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
      if (testCase.hasRetry) {
        expect(screen.getByTestId('circle-content-relations-retry')).toBeTruthy()
      } else {
        expect(screen.queryByTestId('circle-content-relations-retry')).toBeNull()
      }
      caseView.unmount()
    }
    // The retry on error/offline/partial drives the holder-wired C2 refresh.
    renderPanel(
      { availability: 'unknown_circle' } as MemberCircleDetailView,
      contextWithDirectory(catalog, {}, { relationsPhase: 'error', onRefreshRelations }),
    )
    fireEvent.click(screen.getByTestId('circle-content-relations-retry'))
    expect(onRefreshRelations).toHaveBeenCalledTimes(1)
  })

  it('renders the exit verdict only when the relations read has settled (ready)', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(
      { availability: 'unknown_circle' } as MemberCircleDetailView,
      contextWithDirectory(catalog, {}, { relationsPhase: 'ready' }),
    )
    expect(screen.getByTestId('circle-content-exited')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('unknown_circle with a dual-source entry: the exited panel renders nothing while the same work stays launchable for 我的应用 via its other valid source', () => {
    // D-PC-09 combination: the work keeps ANOTHER valid circle source, so the
    // H1 directory (the 我的应用 projection) still marks it launchable, while
    // the exited circle's own panel shows no rows at all.
    const app = catalogApp({
      id: 'entry-dual',
      catalogEntryId: 'entry-dual',
      artifactInstanceId: 'artifact-dual',
      name: '双来源应用',
      catalogSources: [
        { kind: 'creator_circle', circleId: 'circle-gone', name: '已退出圈' },
        { kind: 'creator_circle', circleId: 'circle-2', name: '晨星设计圈' },
      ],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const context = contextWithDirectory(
      catalog,
      { lostCircleIds: new Set(['circle-gone']) },
      { relationsPhase: 'ready' },
    )
    renderPanel(
      { availability: 'unknown_circle' } as MemberCircleDetailView,
      context,
    )
    // The exited circle's panel: verdict only — zero rows, zero actions.
    expect(screen.getByTestId('circle-content-exited')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
    expect(within(screen.getByTestId('circle-content-exited')).queryAllByRole('button'))
      .toHaveLength(0)
    // The SAME H1 directory row keeps the work usable through the surviving
    // valid source — 我的应用 can still open it (launch stays with
    // resolveLaunch there; this panel renders nothing to click).
    expect(context.directory.entries).toHaveLength(1)
    expect(context.directory.entries[0]!.launchBlocked).toBe(false)
    expect(context.directory.entries[0]!.sources.some(
      source => source.circleId === 'circle-2' && source.valid,
    )).toBe(true)
    expect(catalog.resolveLaunch).not.toHaveBeenCalled()
  })

  it('renders the denied directory phase banner and no rows', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'denied',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    expect(screen.getByTestId('circle-content-denied')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('renders the error directory phase with the catalog retry and no rows', async () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: 'catalog_failed',
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    expect(screen.getByTestId('circle-content-error')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
    // The retry drives the SAME injected catalog instance's explicit sync.
    fireEvent.click(screen.getByTestId('circle-content-catalog-retry'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(catalog.sync).toHaveBeenCalledWith(true)
  })

  it('renders the no-space directory phase and no rows', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    // No active space context: the receipt is refused wholesale (fail closed).
    renderPanel(
      readyCircle({ circleId: 'circle-1' }),
      contextWithDirectory(catalog, { accountId: null, productSpaceId: null }),
    )
    expect(screen.getByTestId('circle-content-no-space')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('renders the rejected directory explanation (empty phase consumed WITH rejections) and no rows', () => {
    // A row whose organizationId does not match the space is refused
    // consumer-side: entries stay empty, rejections recorded — that is NOT a
    // vacuum, it keeps its own explanation.
    const foreign = catalogApp({
      id: 'entry-foreign',
      catalogEntryId: 'entry-foreign',
      artifactInstanceId: 'artifact-foreign',
      name: '外来空间的应用',
      organizationId: 'space-other',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([foreign]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    expect(screen.getByTestId('circle-content-rejected')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
    expect(screen.queryByTestId('circle-content-empty')).toBeNull()
  })

  it('flags the explicit count-based partial when receipt app entitlements exceed verified catalog rows', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(
      readyCircle({ circleId: 'circle-1', entitlements: [appClassEntitlement()] }),
      panelContext(catalog),
    )
    // The receipt lists one app-class work the trusted Catalog cannot verify:
    // explicit partial — not silence, not fabricated rows.
    expect(screen.getByTestId('circle-content-apps-partial')).toBeTruthy()
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('surfaces the C2 partial relations phase with the holder-wired retry', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    const onRefreshRelations = jest.fn()
    renderPanel(
      readyCircle({ circleId: 'circle-1' }),
      contextWithDirectory(catalog, {}, { relationsPhase: 'partial', onRefreshRelations }),
    )
    fireEvent.click(screen.getByTestId('circle-content-relations-retry'))
    expect(onRefreshRelations).toHaveBeenCalledTimes(1)
  })

  it('separates the offline directory phase and renders no rows while offline', () => {
    const app = catalogApp({
      id: 'entry-offline',
      catalogEntryId: 'entry-offline',
      artifactInstanceId: 'artifact-offline',
      name: '离线时的应用',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    })
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([app]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'offline',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(readyCircle({ circleId: 'circle-1' }), panelContext(catalog))
    expect(screen.getByTestId('circle-content-offline')).toBeTruthy()
    // No launchable rows while the directory cannot be verified.
    expect(screen.queryAllByTestId('circle-content-app-card')).toHaveLength(0)
  })

  it('shows a non-active circle status without fabricating content', () => {
    const catalog = fakeCatalog({
      state: {
        catalog: personalCatalog([]),
        loading: false,
        refreshing: false,
        warningCode: null,
        errorCode: null,
        accessMode: 'online',
        statuses: {},
        installStates: {},
      },
    })
    renderPanel(
      readyCircle({ circleId: 'circle-1', circleStatus: 'closed' }),
      panelContext(catalog),
    )
    const status = screen.getByTestId('circle-content-circle-status')
    expect(status.getAttribute('data-circle-status')).toBe('closed')
    expect(status.textContent).toContain('Circle closed')
  })
})
