import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  AppCatalogCacheEntry,
  CatalogApp,
  MemberCircleEntitlement,
  MemberCircleSnapshot,
  MemberMembership,
} from '@polo-ai/shared/admin'
import type { CircleReturnCandidate, CircleReturnPendingState } from '@polo-ai/shared/protocol'
import type { ClientPageRoute } from '@/context/ClientPageContext'

// -------------------------------------------------------------------------
// Isolated-process host (same model as MyCirclesPage.interaction.isolated.ts
// and the C7 flow tests): the ProductSpace binding is a mutable module
// double, the trusted C1 bridge is a mutable window stub, and the injected
// H1 catalog instance is a React-state-committed double so C2's
// invalidateAndRefresh settle observer observes a NEW state identity.
//
// The assembly under test is the REAL C9 mount: TabContent home branch →
// ClientHomeSurface (MemberCircleResourceProvider on the injected catalog) →
// ClientHomeRouter → CircleDetailPage (C4/C5/C6/C7/S1 panels).
// -------------------------------------------------------------------------

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

// The frozen TabShell surface double: the home branch is active, no web app
// tabs, the Polo assistant never opens.
const openAppSpy = jest.fn()
mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => ({
    activeTab: { id: 'home', appId: 'home', type: 'home', title: '首页' },
    activeTabId: 'home',
    openTabs: [],
    isReady: true,
    openApp: openAppSpy,
    activateHome: jest.fn(),
    activateTab: jest.fn(),
    closeTab: jest.fn(),
  }),
  useOptionalTabShell: () => null,
}))

// -------------------------------------------------------------------------
// Mutable ProductSpace binding (the harness's only binding authority)
// -------------------------------------------------------------------------

interface BindingDouble {
  accountId: string
  activeProductSpaceId: string
  personalProductSpaceId: string
  productSpaceContextKey: string
  contextVersion: number
  activeProductSpace: { id: string; kind: 'personal' | 'enterprise'; name: string; accessMode: string }
}

function personalBinding(accountId: string, contextVersion: number): BindingDouble {
  return {
    accountId,
    activeProductSpaceId: 'personal-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: `["product-space",1,"${accountId}","personal-space"]`,
    contextVersion,
    activeProductSpace: { id: 'personal-space', kind: 'personal', name: '我的空间', accessMode: 'active' },
  }
}

function enterpriseBinding(accountId: string, contextVersion: number): BindingDouble {
  return {
    accountId,
    activeProductSpaceId: 'org-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: `["product-space",1,"${accountId}","org-space"]`,
    contextVersion,
    activeProductSpace: { id: 'org-space', kind: 'enterprise', name: '企业空间', accessMode: 'active' },
  }
}

let productSpaceContextState: BindingDouble = personalBinding('account-a', 1)

const launchHandoffDouble = {
  publish: jest.fn(),
  take: () => null,
  onLaunch: () => () => {},
}

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
  useProductSpaceAppLaunchHandoff: () => launchHandoffDouble,
}))

// -------------------------------------------------------------------------
// Mutable trusted bridge (authoritative receipts of the CURRENT account)
// -------------------------------------------------------------------------

let currentAccount = 'account-a'
const circlesByAccount: Record<string, Array<MemberCircleSnapshot>> = {}
const membershipsByAccount: Record<string, Array<MemberMembership>> = {}
let listErrorCode: string | null = null
let membershipsErrorCode: string | null = null
let updatesErrorCode: string | null = null
let leaveImpl: (membershipId: string) => Promise<{ success: true; membership: Record<string, unknown> } | { success: false; errorCode: string; message: string }> = () =>
  Promise.resolve({ success: false, errorCode: 'conflict', message: 'stub default' })
let listCalls = 0
let membershipsCalls = 0
let getUpdatesCalls = 0
let leaveCalls: string[] = []

// C8 bridge double (the useCircleReturn test model): a pending queue feeds
// getPending once, ack/cancel are recorded, and the typed event subscriber is
// captured for direct deliveries.
let returnPendingQueue: Array<CircleReturnPendingState> = []
const returnAckedIds: string[] = []
const returnCancelledIds: string[] = []
let returnEventSubscriber: ((candidate: CircleReturnCandidate) => void) | null = null

function installBridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      circleReturn: {
        getPending: () => {
          return Promise.resolve(returnPendingQueue.shift() ?? { status: 'none' })
        },
        ack: (candidateId: string) => {
          returnAckedIds.push(candidateId)
          return Promise.resolve({ status: 'acked' })
        },
        cancel: (candidateId: string) => {
          returnCancelledIds.push(candidateId)
          return Promise.resolve({ status: 'cancelled' })
        },
      },
      onCircleReturnCandidate: (callback: (candidate: CircleReturnCandidate) => void) => {
        returnEventSubscriber = callback
        return () => {
          returnEventSubscriber = null
        }
      },
      memberCircles: {
        list: () => {
          listCalls += 1
          if (listErrorCode) {
            return Promise.resolve({ success: false, errorCode: listErrorCode, message: 'stub failure' })
          }
          return Promise.resolve({ success: true, circles: circlesByAccount[currentAccount] ?? [] })
        },
        listMemberships: () => {
          membershipsCalls += 1
          if (membershipsErrorCode) {
            return Promise.resolve({ success: false, errorCode: membershipsErrorCode, message: 'stub failure' })
          }
          return Promise.resolve({ success: true, memberships: membershipsByAccount[currentAccount] ?? [] })
        },
        previewRenewal: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        leave: (membershipId: string) => {
          leaveCalls.push(membershipId)
          return leaveImpl(membershipId)
        },
        getOrder: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getCheckoutResult: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getUpdates: () => {
          getUpdatesCalls += 1
          if (updatesErrorCode) {
            return Promise.resolve({ success: false, errorCode: updatesErrorCode, message: 'stub failure' })
          }
          return Promise.resolve({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } })
        },
        getProfile: () => Promise.resolve({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
        getSupport: () => Promise.resolve({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
      },
    },
  })
}

// -------------------------------------------------------------------------
// Fixtures (F1 contract shapes)
// -------------------------------------------------------------------------

function entitlementFixture(
  circleId: string,
  id: string,
  type: 'web_app' | 'skill',
  name: string,
): MemberCircleEntitlement {
  return {
    id,
    circleId,
    artifactId: `artifact-${id}`,
    sourceKind: 'active_distribution',
    sourceValidUntil: null,
    artifact: {
      id: `artifact-${id}`,
      type,
      slug: name,
      name,
      summary: '',
      status: 'published',
      currentStableVersionId: null,
    },
    artifactVersion: { id: `version-${id}`, version: '1.0.0', status: 'published', publishedAt: null },
  }
}

function circleFixture(input: {
  circleId: string
  membershipId: string
  name: string
  billingKind: 'free' | 'paid'
  status?: 'active' | 'suspended' | 'expired'
}): MemberCircleSnapshot {
  return {
    membershipId: input.membershipId,
    status: input.status ?? 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: null,
    joinSource: 'share_link',
    joinedAt: '2026-09-01T00:00:00.000Z',
    circle: {
      circleId: input.circleId,
      name: input.name,
      purpose: '增长打法分享',
      status: 'active',
      ownerUserId: '00000000-0000-4000-8000-000000000001',
    },
    entitlements: [
      entitlementFixture(input.circleId, `${input.circleId}-a1`, 'web_app', '增长打法手册'),
      entitlementFixture(input.circleId, `${input.circleId}-s1`, 'skill', '资料研究'),
    ],
  }
}

function membershipFixture(input: {
  circleId: string
  membershipId: string
  billingKind: 'free' | 'paid'
  status?: 'active' | 'suspended' | 'expired'
}): MemberMembership {
  return {
    membershipId: input.membershipId,
    status: input.status ?? 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: null,
    suspendedReason: input.status === 'suspended' ? 'provider_suspended' : null,
    joinedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    paymentOrders: [],
    circle: {
      circleId: input.circleId,
      name: '晨星增长圈',
      purpose: '',
      status: 'active',
      joinMode: input.billingKind === 'free' ? 'free' : 'paid',
      membershipPriceMinor: input.billingKind === 'free' ? null : 2500,
      membershipCurrency: input.billingKind === 'free' ? null : 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
  }
}

function seedAccountA() {
  circlesByAccount['account-a'] = [
    circleFixture({ circleId: 'circle-1', membershipId: 'ms-1', name: '晨星增长圈', billingKind: 'free' }),
  ]
  membershipsByAccount['account-a'] = [
    membershipFixture({ circleId: 'circle-1', membershipId: 'ms-1', billingKind: 'free' }),
  ]
}

function seedAccountB() {
  circlesByAccount['account-b'] = [
    circleFixture({ circleId: 'circle-b', membershipId: 'ms-b', name: 'B 圈子', billingKind: 'free' }),
  ]
  membershipsByAccount['account-b'] = [
    membershipFixture({ circleId: 'circle-b', membershipId: 'ms-b', billingKind: 'free' }),
  ]
}

// H1 catalog fixture: entries whose creator_circle sources let the
// last-source projection distinguish 独源 (loses its ONLY source) from
// 双源 (keeps another valid circle source).
const accountId = 'account-a'
const spaceId = 'personal-space'

function catalogApp(overrides: Partial<CatalogApp> & Pick<CatalogApp, 'id' | 'name'>): CatalogApp {
  return {
    organizationId: spaceId,
    description: '',
    deliveryMode: 'resolve_launch',
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

function personalCatalog(apps: CatalogApp[]): AppCatalogCacheEntry {
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
  }
}

function catalogAppsFixture(): CatalogApp[] {
  return [
    catalogApp({
      id: 'entry-solo',
      catalogEntryId: 'entry-solo',
      artifactInstanceId: 'artifact-solo',
      name: '独源手册',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' }],
    }),
    catalogApp({
      id: 'entry-multi',
      catalogEntryId: 'entry-multi',
      artifactInstanceId: 'artifact-multi',
      name: '双源手册',
      catalogSources: [
        { kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长圈' },
        { kind: 'creator_circle', circleId: 'circle-2', name: '另一个圈' },
      ],
    }),
    catalogApp({
      id: 'entry-other',
      catalogEntryId: 'entry-other',
      artifactInstanceId: 'artifact-other',
      name: '别圈应用',
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-2', name: '另一个圈' }],
    }),
  ]
}

// -------------------------------------------------------------------------
// Reactive H1 catalog double (state identity moves on commit, so C2's
// invalidateAndRefresh settle observer resolves — the C7 test model)
// -------------------------------------------------------------------------

interface CatalogDoubleState {
  errorCode: string | null
  catalog: AppCatalogCacheEntry | null
  refreshing?: boolean
  loading?: boolean
}

type CatalogDouble = import('@/hooks/useAppCatalog').AppCatalogInstance

let catalogLogicalState: CatalogDoubleState = { errorCode: null, catalog: personalCatalog(catalogAppsFixture()) }

function createCatalogInstance(): CatalogDouble {
  const snapshot: CatalogDoubleState = { ...catalogLogicalState }
  return {
    productSpace: {
      accountId,
      activeProductSpaceId: productSpaceContextState.activeProductSpaceId,
      activeProductSpace: productSpaceContextState.activeProductSpace,
    },
    state: {
      loading: false,
      refreshing: false,
      warningCode: null,
      accessMode: 'online',
      statuses: {},
      installStates: {},
      ...snapshot,
    },
    sync: async () => {
      // The double settles into a NEW committed identity via commitCatalog.
      commitCatalog(createCatalogInstance())
    },
    getInstallState: () => undefined,
    resolveLaunch: async () => {
      throw new Error('resolveLaunch not exercised in this assembly test')
    },
  } as unknown as CatalogDouble
}

let commitCatalog: (instance: CatalogDouble) => void = () => {}

function CatalogHost({ children }: { children: (catalog: CatalogDouble) => any }) {
  const [catalog, setCatalog] = useState<CatalogDouble>(() => createCatalogInstance())
  commitCatalog = setCatalog
  return children(catalog)
}

// -------------------------------------------------------------------------
// Render harness: the REAL TabContent home branch inside the real provider
// stack (MemberCatalogProvider → ClientPageProvider → TabContent), plus a
// route probe for navigation and hairline observation.
// -------------------------------------------------------------------------

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ClientPageProvider, clientPageScopeKey, useOptionalClientPage } = await import('@/context/ClientPageContext')
const { MemberCatalogProvider } = await import('@/context/MemberCatalogContext')
const { TabContent } = await import('@/components/tab-browser/TabContent')

afterEach(() => {
  cleanup()
})

let observedRoute: ClientPageRoute | null = null
let probeClientPage: ReturnType<typeof useOptionalClientPage> = null
let observedHairline: boolean | null = null

function RouteProbe() {
  probeClientPage = useOptionalClientPage()
  observedRoute = probeClientPage?.route ?? null
  observedHairline = probeClientPage?.isHeaderLineVisible ?? null
  return null
}

interface TreeOptions {
  accountId: string
  contextVersion?: number
  enterprise?: boolean
  onReauthenticateRequest?: (target: unknown) => void
}

function tree(options: TreeOptions) {
  const accountIdOption = options.accountId
  const contextVersion = options.contextVersion ?? 1
  const binding = options.enterprise
    ? enterpriseBinding(accountIdOption, contextVersion)
    : personalBinding(accountIdOption, contextVersion)
  productSpaceContextState = binding
  currentAccount = accountIdOption
  const scope = {
    accountId: binding.accountId,
    productSpaceId: binding.activeProductSpaceId,
    epoch: binding.contextVersion,
  }
  return createElement(CatalogHost, {
    children: (catalog: CatalogDouble) => createElement(
      I18nextProvider,
      { i18n },
      createElement(MemberCatalogProvider, {
        catalog,
        children: createElement(ClientPageProvider, {
          key: clientPageScopeKey(scope),
          scope,
          children: [
            createElement(TabContent, {
              key: 'content',
              renderPolo: () => null,
              onReauthenticateRequest: options.onReauthenticateRequest as never,
            }),
            createElement(RouteProbe, { key: 'probe' }),
          ],
        }),
      }),
    ),
  })
}

async function renderAssembly(options: TreeOptions = { accountId: 'account-a' }) {
  const view = render(tree(options))
  await waitFor(() => {
    expect(screen.getByTestId('client-home-router')).toBeTruthy()
    expect(screen.getByTestId('client-home-router').getAttribute('data-route-kind')).toBe('home')
  })
  return view
}

async function navigateToDetail(circleId = 'circle-1', section: 'content' | 'updates' | 'subscription' = 'content') {
  await act(async () => {
    probeClientPage!.navigate({ kind: 'circles' })
  })
  await waitFor(() => {
    expect(screen.getByTestId('my-circles-page')).toBeTruthy()
  })
  await act(async () => {
    probeClientPage!.navigate({ kind: 'circle-detail', circleId, section })
  })
  await waitFor(() => {
    expect(screen.getByTestId('circle-detail-page')).toBeTruthy()
  })
}

beforeEach(() => {
  productSpaceContextState = personalBinding('account-a', 1)
  currentAccount = 'account-a'
  seedAccountA()
  seedAccountB()
  listErrorCode = null
  membershipsErrorCode = null
  updatesErrorCode = null
  listCalls = 0
  membershipsCalls = 0
  getUpdatesCalls = 0
  leaveCalls = []
  leaveImpl = () => Promise.resolve({ success: false, errorCode: 'conflict', message: 'stub default' })
  returnPendingQueue = []
  returnAckedIds.length = 0
  returnCancelledIds.length = 0
  returnEventSubscriber = null
  catalogLogicalState = { errorCode: null, catalog: personalCatalog(catalogAppsFixture()) }
  observedRoute = null
  probeClientPage = null
  observedHairline = null
  toastErrorSpy.mockClear()
  toastSuccessSpy.mockClear()
  openAppSpy.mockClear()
  installBridge()
})

// -------------------------------------------------------------------------
// P70-CIRCLE-DETAIL-01 — the real route loop home → circles → detail
// -------------------------------------------------------------------------

describe('outer route assembly (P70-CIRCLE-DETAIL-01)', () => {
  it('mounts the router in the TabContent home branch and walks home → circles → detail with the STABLE circleId', async () => {
    await renderAssembly()
    // The home surface renders through the router (no second home copy).
    expect(screen.getByTestId('home-app-hub')).toBeTruthy()

    await act(async () => {
      probeClientPage!.navigate({ kind: 'circles' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-page')).toBeTruthy()
    })
    expect(screen.queryByTestId('home-app-hub')).toBeNull()

    // The C3 row click hands the SAME navigation contract to N1.
    const row = screen.getAllByTestId('circle-row').find(r => r.getAttribute('data-circle-id') === 'circle-1')!
    fireEvent.click(row.querySelector('[data-testid="circle-row-open"]')!)
    expect(observedRoute).toEqual({ kind: 'circle-detail', circleId: 'circle-1', section: 'content' })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-page')).toBeTruthy()
    })
    const page = screen.getByTestId('circle-detail-page')
    expect(page.getAttribute('data-circle-id')).toBe('circle-1')
    expect(page.getAttribute('data-section')).toBe('content')
    // ONE identity heading from the SAME C2 row; no second page title.
    expect(screen.getByTestId('circle-detail-title').textContent).toBe('晨星增长圈')
    expect(screen.getByTestId('circle-content-panel')).toBeTruthy()
    expect(screen.queryByTestId('my-circles-page')).toBeNull()
  })

  it('switches all three sections through the route field, rendering each panel exactly once', async () => {
    await renderAssembly()
    await navigateToDetail()

    // 内容 → C4.
    expect(screen.getByTestId('circle-content-panel')).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-panel')).toBeNull()
    expect(screen.queryByTestId('circle-subscription-panel')).toBeNull()

    // 更新 → C5 (the C9-issued getUpdates read resolves into the G2 state).
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-updates'))
    })
    expect(observedRoute).toEqual({ kind: 'circle-detail', circleId: 'circle-1', section: 'updates' })
    await waitFor(() => {
      expect(screen.getByTestId('circle-updates-panel')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-content-panel')).toBeNull()

    // 订阅 → C6 with the reserved exit region and NO duplicated titles.
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-subscription'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-subscription-panel')).toBeTruthy()
    })
    expect(screen.getByTestId('circle-subscription-exit-region')).toBeTruthy()
    expect(screen.queryByTestId('circle-updates-panel')).toBeNull()

    // The tabs are ROUTE navigation: aria-current tracks the section.
    expect(screen.getByTestId('circle-detail-tab-subscription').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('circle-detail-tab-content').getAttribute('aria-current')).toBeNull()

    // Back to 内容.
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-content'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-content-panel')).toBeTruthy()
    })
  })

  it('backs out of the detail into circles, then home, never popping the home root', async () => {
    await renderAssembly()
    await navigateToDetail()

    fireEvent.click(screen.getByTestId('circle-detail-back'))
    expect(observedRoute).toEqual({ kind: 'circles' })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-page')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('my-circles-back'))
    expect(observedRoute).toEqual({ kind: 'home' })
    await waitFor(() => {
      expect(screen.getByTestId('home-app-hub')).toBeTruthy()
    })
  })
})

// -------------------------------------------------------------------------
// P70-CIRCLE-DETAIL-02 — updates read, leave flow with re-verification
// -------------------------------------------------------------------------

describe('updates section read (P70-CIRCLE-DETAIL-02)', () => {
  it('issues getUpdates from the page; a failed read shows the panel error and the explicit retry recovers', async () => {
    updatesErrorCode = 'timeout'
    await renderAssembly()
    await navigateToDetail('circle-1', 'updates')

    await waitFor(() => {
      expect(getUpdatesCalls).toBe(1)
      expect(screen.getByTestId('circle-updates-error')).toBeTruthy()
    })
    // The retry is the ONLY recovery path — and it re-reads.
    updatesErrorCode = null
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-updates-retry'))
    })
    await waitFor(() => {
      expect(getUpdatesCalls).toBe(2)
      expect(screen.getByTestId('circle-updates-pending-upstream')).toBeTruthy()
    })
    // G2 pending-upstream is a READY capability state, not empty, not error.
    expect(screen.queryByTestId('circle-updates-empty')).toBeNull()
    expect(screen.queryByTestId('circle-updates-error')).toBeNull()
  })
})

describe('leave flow in the subscription section (P70-CIRCLE-DETAIL-02)', () => {
  it('computes lastSourceWorkNames from the H1 projection, confirms ONCE, and keeps the correct object on screen', async () => {
    leaveImpl = () => {
      // The F1 receipt: the relation flips to expired and STAYS listed.
      membershipsByAccount['account-a'] = [
        membershipFixture({ circleId: 'circle-1', membershipId: 'ms-1', billingKind: 'free', status: 'expired' }),
      ]
      return Promise.resolve({
        success: true,
        membership: {
          membershipId: 'ms-1',
          circleId: 'circle-1',
          userId: 'aaaaaaaa-0000-4000-8000-000000000001',
          status: 'expired',
          billingKind: 'free',
          currentPeriodEnd: null,
          modeTransitionEndsAt: null,
          suspendedReason: null,
          joinedAt: '2026-09-01T00:00:00.000Z',
          endedAt: '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
        },
      })
    }
    await renderAssembly()
    await navigateToDetail('circle-1', 'subscription')

    // The ONLY exit entry lives in the subscription section.
    expect(screen.getByTestId('circle-subscription-exit-region')).toBeTruthy()
    fireEvent.click(screen.getByTestId('circle-detail-exit'))

    const dialog = await waitFor(() => screen.getByTestId('leave-circle-dialog'))
    expect(dialog.getAttribute('data-phase')).toBe('confirm')
    // lastSourceWorkNames: the H1 projection lists ONLY the work losing its
    // LAST valid source — the dual-source work stays absent.
    const lastSource = screen.getByTestId('leave-circle-dialog-last-source')
    expect(lastSource.textContent).toContain('独源手册')
    expect(lastSource.textContent).not.toContain('双源手册')
    expect(lastSource.textContent).not.toContain('别圈应用')

    const leavesBefore = leaveCalls.length
    const listBefore = listCalls
    await act(async () => {
      fireEvent.click(screen.getByTestId('leave-circle-dialog-confirm'))
    })

    // Exactly ONE write; C2's single refresh round trip re-read relations.
    expect(leaveCalls.length).toBe(leavesBefore + 1)
    expect(leaveCalls[leaveCalls.length - 1]).toBe('ms-1')
    expect(listCalls).toBeGreaterThan(listBefore)
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-leave-outcome')).toBeTruthy()
    })
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
    // The page keeps the CORRECT object: the expired relation renders the
    // restricted heading state from the refreshed C2 receipt.
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-heading-status').getAttribute('data-status')).toBe('restore')
    })
  })

  it('runs the read-only recheck on a result-unknown write and reports still-member honestly', async () => {
    leaveImpl = () => Promise.resolve({ success: false, errorCode: 'network_error', message: 'transport down' })
    await renderAssembly()
    await navigateToDetail('circle-1', 'subscription')

    fireEvent.click(screen.getByTestId('circle-detail-exit'))
    await waitFor(() => {
      expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    })
    const listBefore = listCalls
    await act(async () => {
      fireEvent.click(screen.getByTestId('leave-circle-dialog-confirm'))
    })

    // One write, then exactly ONE automatic read-only re-verification.
    expect(leaveCalls.length).toBe(1)
    await waitFor(() => {
      expect(listCalls).toBeGreaterThan(listBefore)
      expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy()
    })
    expect(screen.getByTestId('leave-circle-dialog-error').textContent).toContain('still a member')
    // No left outcome may exist anywhere on the page (失败不显示已退出).
    expect(screen.queryByTestId('circle-detail-leave-outcome')).toBeNull()
    expect(screen.getByTestId('circle-detail-heading-status').getAttribute('data-status')).toBe('valid')
  })

  it('cancel closes the dialog without any write', async () => {
    await renderAssembly()
    await navigateToDetail('circle-1', 'subscription')
    fireEvent.click(screen.getByTestId('circle-detail-exit'))
    await waitFor(() => {
      expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('leave-circle-dialog-cancel'))
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
    expect(leaveCalls.length).toBe(0)
  })
})

// -------------------------------------------------------------------------
// Unknown circle / denied scope / old-scope isolation
// -------------------------------------------------------------------------

describe('unknown circle and scope isolation (P70-CIRCLE-DETAIL-01/03)', () => {
  it('renders the exited fact for an id absent from THIS scope once relations settled — in every section, with no fabricated identity', async () => {
    await renderAssembly()
    await navigateToDetail('circle-ghost', 'content')

    // No identity heading: the page never invents a name for a foreign id.
    expect(screen.queryByTestId('circle-detail-title')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('circle-content-exited')).toBeTruthy()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-updates'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-unavailable-exited')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-subscription'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-unavailable-exited')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-subscription-panel')).toBeNull()
    expect(screen.queryByTestId('circle-detail-exit')).toBeNull()
  })

  it('denies an enterprise scope BEFORE any row exists — the detail renders the denied state in every section', async () => {
    const view = render(tree({ accountId: 'account-a', enterprise: true, contextVersion: 1 }))
    await waitFor(() => {
      expect(screen.getByTestId('client-home-router')).toBeTruthy()
    })

    // 我的圈子 is denied in the enterprise space (C2 refuses pre-read).
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circles' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-restricted-banner')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-row')).toBeNull()
    expect(listCalls).toBe(0)

    // A circle-detail route in a denied scope can show no personal data.
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circle-detail', circleId: 'circle-1', section: 'content' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-content-relations-denied')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-updates'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-unavailable-denied')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-detail-tab-subscription'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-unavailable-denied')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-detail-title')).toBeNull()
    view.unmount()
  })

  it('reseals the route on an account switch: no stale circle detail survives into the new scope', async () => {
    const view = render(tree({ accountId: 'account-a', contextVersion: 1 }))
    await renderAssemblyReady()
    await navigateToDetail('circle-1')
    expect(screen.getByTestId('circle-detail-title').textContent).toBe('晨星增长圈')

    // Account A → B (fresh epoch): the keyed provider remounts and N1
    // re-seals to the home root — the previous detail is gone.
    await act(async () => {
      view.rerender(tree({ accountId: 'account-b', contextVersion: 2 }))
    })
    await waitFor(() => {
      expect(observedRoute).toEqual({ kind: 'home' })
      expect(screen.getByTestId('home-app-hub')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-detail-page')).toBeNull()

    // B's own rows only; A's circleId resolves to the exited fact under B.
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circles' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-page')).toBeTruthy()
    })
    const rows = screen.getAllByTestId('circle-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute('data-circle-id')).toBe('circle-b')

    await act(async () => {
      probeClientPage!.navigate({ kind: 'circle-detail', circleId: 'circle-1', section: 'content' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-content-exited')).toBeTruthy()
    })
    expect(screen.queryByText('晨星增长圈')).toBeNull()
  })

  async function renderAssemblyReady() {
    await waitFor(() => {
      expect(screen.getByTestId('client-home-router')).toBeTruthy()
    })
  }
})

// -------------------------------------------------------------------------
// Circle-read exception recovery (S1 as the LOCAL help view)
// -------------------------------------------------------------------------

describe('circle exception help view (P70-CIRCLE-DETAIL-02)', () => {
  it('offers S1 over the original circle-read exception, returns to it unchanged, and re-checks read-only', async () => {
    listErrorCode = 'network_error'
    membershipsErrorCode = 'network_error'
    await renderAssembly()
    await navigateToDetail('circle-1', 'content')

    // The original exception state stays on screen; the help entry appears.
    await waitFor(() => {
      expect(screen.getByTestId('circle-content-relations-offline')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('circle-detail-support-entry'))
    const support = await waitFor(() => screen.getByTestId('circle-support-panel'))
    expect(support.getAttribute('data-target-kind')).toBe('circle')
    expect(support.getAttribute('data-circle-id')).toBe('circle-1')
    // The copied facts are the user's own circle facts (allowlist shape).
    expect(screen.getByTestId('circle-support-info-text').textContent ?? '').toContain('circle-1')

    // Closing returns to the ORIGINAL exception — unchanged.
    fireEvent.click(screen.getByTestId('circle-support-back'))
    expect(screen.queryByTestId('circle-support-panel')).toBeNull()
    expect(screen.getByTestId('circle-content-relations-offline')).toBeTruthy()

    // The manual re-check is a read-only C2 re-verification: restoring the
    // stub and re-checking recovers the content panel.
    const listBefore = listCalls
    listErrorCode = null
    membershipsErrorCode = null
    fireEvent.click(screen.getByTestId('circle-detail-support-entry'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-panel')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-support-recheck'))
    })
    await waitFor(() => {
      expect(listCalls).toBeGreaterThan(listBefore)
      expect(screen.getByTestId('circle-content-panel')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-support-panel')).toBeNull()
  })
})

// -------------------------------------------------------------------------
// P70-CIRCLE-DETAIL-03 — the main scroller drives the header hairline
// -------------------------------------------------------------------------

describe('main-scroller registration (P70-CIRCLE-DETAIL-03)', () => {
  it('registers the routed page root so ITS scroll drives the hairline, re-registers per route, and the routed element IS the registered scroller', async () => {
    const view = await renderAssembly()

    // Home first: scrolling the home root shows the hairline.
    const routerEl = () => document.querySelector('[data-testid="client-home-router"]')!
    const homeRoot = routerEl().firstElementChild as HTMLElement
    homeRoot.scrollTop = 64
    homeRoot.dispatchEvent(new Event('scroll'))
    await waitFor(() => {
      expect(observedHairline).toBe(true)
    })
    homeRoot.scrollTop = 0
    homeRoot.dispatchEvent(new Event('scroll'))
    await waitFor(() => {
      expect(observedHairline).toBe(false)
    })

    // Circles: the routed page root changes, and scrolling THE CIRCLES root
    // (a different element) is what moves the hairline now.
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circles' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-page')).toBeTruthy()
    })
    const circlesRoot = routerEl().firstElementChild as HTMLElement
    expect(circlesRoot).not.toBe(homeRoot)
    circlesRoot.scrollTop = 40
    circlesRoot.dispatchEvent(new Event('scroll'))
    await waitFor(() => {
      expect(observedHairline).toBe(true)
    })

    // Detail: same contract for the detail page root.
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circle-detail', circleId: 'circle-1', section: 'content' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-detail-page')).toBeTruthy()
    })
    const detailRoot = routerEl().firstElementChild as HTMLElement
    expect(detailRoot.getAttribute('data-testid')).toBe('circle-detail-page')
    detailRoot.scrollTop = 24
    detailRoot.dispatchEvent(new Event('scroll'))
    await waitFor(() => {
      expect(observedHairline).toBe(true)
    })

    // Unmount disposes: the probe stops observing (provider gone).
    view.unmount()
    expect(document.querySelector('[data-testid="client-home-router"]')).toBeNull()
  })
})

// -------------------------------------------------------------------------
// C8 return verification assembly (P70-CIRCLE-DETAIL-02, afb222aa contract):
// candidate 呈现 → 面板接管 → ONE checkOnce round → 事实渲染 → ack/release
// -------------------------------------------------------------------------

describe('circle return verification assembly (C8 wiring)', () => {
  it('consumes the B1 candidate on mount, takes the page over with the flow panel, runs ONE authoritative round to the verified fact, acks, and releases on back', async () => {
    // The bridge target must address a REAL row by strict UUID; the fixture
    // circle ids are symbolic, so the return test seeds its own UUID row.
    const returnCircleId = 'c8c8c8c8-0000-4000-8000-00000000c801'
    circlesByAccount['account-a'] = [
      ...(circlesByAccount['account-a'] ?? []),
      circleFixture({ circleId: returnCircleId, membershipId: 'ms-return', name: '回归圈', billingKind: 'free' }),
    ]
    membershipsByAccount['account-a'] = [
      ...(membershipsByAccount['account-a'] ?? []),
      membershipFixture({ circleId: returnCircleId, membershipId: 'ms-return', billingKind: 'free' }),
    ]
    returnPendingQueue.push({
      status: 'pending',
      candidate: {
        candidateId: 'cand-c8-assembly',
        protocolVersion: 1,
        target: { circleId: returnCircleId },
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    })

    await renderAssembly()
    // Consumption happens on the detail page mount (the C8 hook lives there).
    await navigateToDetail('circle-1')

    // The candidate is surfaced: the flow panel takes the page over.
    await waitFor(() => {
      const panel = screen.getByTestId('circle-return-panel')
      expect(panel.getAttribute('data-return-kind')).toBe('circle')
      expect(panel.getAttribute('data-return-phase')).toBe('candidate')
    })
    expect(screen.getByTestId('circle-detail-page').getAttribute('data-return-active')).toBe('true')
    // Single flow-state surface: the detail heading/tabs are NOT rendered
    // beside it (不造第二套标题).
    expect(screen.queryByTestId('circle-detail-title')).toBeNull()
    expect(screen.queryByTestId('circle-detail-tabs')).toBeNull()
    // The target circle's confirmed name comes from the C2 rows.
    expect(screen.getByTestId('circle-return-fact-target').textContent).toContain('回归圈')

    // ONE authoritative round per click: the C2 invalidation refresh runs
    // (list re-read) and the verdict renders from the refreshed receipt.
    const listBefore = listCalls
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-check'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('verified')
    })
    expect(listCalls).toBeGreaterThan(listBefore)
    expect(returnAckedIds).toEqual(['cand-c8-assembly'])
    // The entitlement fact renders from the refreshed authoritative row.
    expect(screen.getByTestId('circle-return-fact-entitlement-value').textContent).toBe('Valid')
    // The takeover persists until the user leaves the flow surface.
    expect(screen.queryByTestId('circle-detail-title')).toBeNull()

    // 返回我的圈子 releases the candidate (bridge cancel) and routes to circles.
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-back'))
    })
    expect(observedRoute).toEqual({ kind: 'circles' })
    expect(returnCancelledIds).toEqual(['cand-c8-assembly'])
  })
})

// -------------------------------------------------------------------------
// P2-1 (POO-100 review): open-original never dead-ends the verified takeover
// -------------------------------------------------------------------------

describe('return panel open-original (P2-1)', () => {
  const returnCircleId = 'c8c8c8c8-0000-4000-8000-00000000c802'

  function seedReturnCircleAndCandidate() {
    circlesByAccount['account-a'] = [
      ...(circlesByAccount['account-a'] ?? []),
      circleFixture({ circleId: returnCircleId, membershipId: 'ms-return', name: '回归圈', billingKind: 'free' }),
    ]
    membershipsByAccount['account-a'] = [
      ...(membershipsByAccount['account-a'] ?? []),
      membershipFixture({ circleId: returnCircleId, membershipId: 'ms-return', billingKind: 'free' }),
    ]
    returnPendingQueue.push({
      status: 'pending',
      candidate: {
        candidateId: 'cand-p2-1',
        protocolVersion: 1,
        target: { circleId: returnCircleId },
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    })
  }

  async function verifyCandidateOnPage(circleId: string) {
    await renderAssembly()
    await navigateToDetail(circleId)
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('candidate')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-check'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('verified')
    })
    expect(returnAckedIds).toContain('cand-p2-1')
  }

  it('SAME route: opening the original releases the verified takeover so the click lands on the object (no dead CTA)', async () => {
    seedReturnCircleAndCandidate()
    // The candidate's derived route IS the current route (circle detail,
    // content section) — the pre-fix dead-button case.
    await verifyCandidateOnPage(returnCircleId)

    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-open'))
    })
    // The route navigation is a no-op (same route) — the RELEASE is the
    // feedback: the flow surface is gone, the object's detail body renders.
    expect(observedRoute).toEqual({ kind: 'circle-detail', circleId: returnCircleId, section: 'content' })
    await waitFor(() => {
      expect(screen.queryByTestId('circle-return-panel')).toBeNull()
      expect(screen.getByTestId('circle-detail-title').textContent).toBe('回归圈')
    })
    expect(screen.getByTestId('circle-detail-page').getAttribute('data-return-active')).toBe('false')
    // The release ran the bridge cancel (harmless not_found for an acked id).
    expect(returnCancelledIds).toEqual(['cand-p2-1'])
  })

  it('DIFFERENT circle: opening the original navigates, the remount consumes nothing, and the target object renders', async () => {
    seedReturnCircleAndCandidate()
    // The user is on ANOTHER circle's detail; the candidate targets 回归圈.
    await verifyCandidateOnPage('circle-1')

    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-open'))
    })
    // The route CHANGES to the target's detail; the keyed page remounts,
    // the new hook consumes nothing (acked candidate), and the target's
    // own detail renders normally.
    expect(observedRoute).toEqual({ kind: 'circle-detail', circleId: returnCircleId, section: 'content' })
    await waitFor(() => {
      expect(screen.queryByTestId('circle-return-panel')).toBeNull()
      expect(screen.getByTestId('circle-detail-title').textContent).toBe('回归圈')
    })
    expect(screen.getByTestId('circle-detail-page').getAttribute('data-return-active')).toBe('false')
  })
})

// -------------------------------------------------------------------------
// P2-2 (POO-100 review): the mismatch CTA is gated on a wired A1 entry
// -------------------------------------------------------------------------

describe('account mismatch reauthenticate CTA (P2-2)', () => {
  const orderUuid = 'c8c8c8c8-0000-4000-8000-00000000c803'

  function seedOrderCandidate() {
    // getOrder/getCheckoutResult stubs fail with not_found (the F1 same-shape
    // negative) → the round lands on the definitive account-mismatch verdict.
    returnPendingQueue.push({
      status: 'pending',
      candidate: {
        candidateId: 'cand-p2-2',
        protocolVersion: 1,
        target: { orderId: orderUuid },
        createdAt: '2026-10-04T00:00:00.000Z',
      },
    })
  }

  async function verifyToMismatch() {
    await renderAssembly()
    await navigateToDetail('circle-1')
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-kind')).toBe('order')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-check'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('account-mismatch')
    })
    // No object disclosure on the mismatch state.
    expect(screen.queryByTestId('circle-return-facts')).toBeNull()
  }

  it('WITH a wired A1 entry: the CTA renders, one click hands over the minimal target and keeps the candidate for re-verification', async () => {
    seedOrderCandidate()
    const reauthenticateSpy = jest.fn()
    await renderAssembly({ accountId: 'account-a', onReauthenticateRequest: reauthenticateSpy })
    await navigateToDetail('circle-1')
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-kind')).toBe('order')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-check'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('account-mismatch')
    })

    const button = screen.getByTestId('circle-return-reauthenticate')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(reauthenticateSpy).toHaveBeenCalledTimes(1)
    expect(reauthenticateSpy.mock.calls[0]![0]).toEqual({ orderId: orderUuid })
    // The hook drops the previous account's facts and KEEPS the minimal
    // target so the same object re-verifies after re-login.
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('candidate')
    })
    expect(screen.queryByTestId('circle-return-mismatch-no-entry')).toBeNull()
    expect(returnCancelledIds).toEqual([])
  })

  it('WITHOUT a wired entry: no dead CTA — the honest manual-recovery note replaces it', async () => {
    seedOrderCandidate()
    await renderAssembly()
    await navigateToDetail('circle-1')
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-kind')).toBe('order')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('circle-return-check'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-phase')).toBe('account-mismatch')
    })

    expect(screen.queryByTestId('circle-return-reauthenticate')).toBeNull()
    const note = screen.getByTestId('circle-return-mismatch-no-entry')
    expect(note.textContent).toContain('account menu')
  })
})
