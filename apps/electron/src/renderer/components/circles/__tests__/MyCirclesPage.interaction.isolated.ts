import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  MemberCircleEntitlement,
  MemberCircleSnapshot,
  MemberMembership,
} from '@polo-ai/shared/admin'
import type { MemberCirclesResource } from '@/context/MemberCircleResourceContext'
import type { ClientPageRoute } from '@/context/ClientPageContext'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))


// -------------------------------------------------------------------------
// Isolated-process host (own bun process; same pattern as
// MemberCircleResourceContext.isolated.ts): the ProductSpace binding is a
// mutable module double, the trusted C1 bridge is a mutable window stub.
// -------------------------------------------------------------------------

GlobalRegistrator.register()
setupI18n()

let productSpaceContextState: unknown = {
  accountId: 'account-a-fixture',
  activeProductSpaceId: 'personal-space',
  personalProductSpaceId: 'personal-space',
  productSpaceContextKey: '["product-space",1,"account-a-fixture","personal-space"]',
  contextVersion: 1,
  activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
}

function accountBinding(accountId: string, contextVersion: number) {
  return {
    accountId,
    activeProductSpaceId: 'personal-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: `["product-space",1,"${accountId}","personal-space"]`,
    contextVersion,
    activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
  }
}

// Mutable bridge payloads (authoritative receipts of the CURRENT account).
let currentAccount = 'account-a-fixture'
const circlesByAccount: Record<string, Array<MemberCircleSnapshot>> = {}
const membershipsByAccount: Record<string, Array<MemberMembership>> = {}
let listErrorCode: string | null = null
let membershipsErrorCode: string | null = null
let holdListRequests = false
const pendingListResolvers: Array<() => void> = []
const pendingMembershipsResolvers: Array<() => void> = []
let listCalls = 0

// The C2 relations hook reads the ProductSpace binding through this context;
// the mutable double above is the harness's only binding authority.
mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

beforeEach(() => {
  productSpaceContextState = accountBinding('account-a-fixture', 1)
  currentAccount = 'account-a-fixture'
  circlesByAccount['account-a-fixture'] = accountACircles()
  membershipsByAccount['account-a-fixture'] = accountAMemberships()
  circlesByAccount['account-b-fixture'] = [circleB()]
  membershipsByAccount['account-b-fixture'] = [membershipB()]
  listErrorCode = null
  membershipsErrorCode = null
  holdListRequests = false
  pendingListResolvers.length = 0
  pendingMembershipsResolvers.length = 0
  listCalls = 0
  __resetMyCirclesViewPreferencesForTests()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: () => {
          listCalls += 1
          if (holdListRequests) {
            return new Promise(resolve => {
              pendingListResolvers.push(() => resolve({ success: true, circles: circlesByAccount[currentAccount] ?? [] }))
            })
          }
          if (listErrorCode) {
            return Promise.resolve({ success: false, errorCode: listErrorCode, message: 'stub failure' })
          }
          return Promise.resolve({ success: true, circles: circlesByAccount[currentAccount] ?? [] })
        },
        listMemberships: () => {
          if (holdListRequests) {
            return new Promise(resolve => {
              pendingMembershipsResolvers.push(() => resolve({ success: true, memberships: membershipsByAccount[currentAccount] ?? [] }))
            })
          }
          if (membershipsErrorCode) {
            return Promise.resolve({ success: false, errorCode: membershipsErrorCode, message: 'stub failure' })
          }
          return Promise.resolve({ success: true, memberships: membershipsByAccount[currentAccount] ?? [] })
        },
        previewRenewal: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        leave: () => Promise.resolve({ success: false, errorCode: 'conflict', message: 'x' }),
        getOrder: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getCheckoutResult: () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'x' }),
        getUpdates: () => Promise.resolve({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
        getProfile: () => Promise.resolve({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
        getSupport: () => Promise.resolve({ success: true, support: { availability: 'upstream_pending', contractGap: 'G4' } }),
      },
    },
  })
})

// -------------------------------------------------------------------------
// Fixtures (F1 contract shapes; ownerUserId is NEVER a display name — G1)
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
  purpose: string
  billingKind: 'free' | 'paid'
  status?: 'active' | 'suspended' | 'expired'
  currentPeriodEnd?: string | null
  ownerUserId?: string
  entitlements: Array<MemberCircleEntitlement>
}): MemberCircleSnapshot {
  return {
    membershipId: input.membershipId,
    status: input.status ?? 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    joinSource: 'share_link',
    joinedAt: '2026-09-01T00:00:00.000Z',
    circle: {
      circleId: input.circleId,
      name: input.name,
      purpose: input.purpose,
      status: 'active',
      ownerUserId: input.ownerUserId ?? '00000000-0000-4000-8000-00000000dead',
    },
    entitlements: input.entitlements,
  }
}

function membershipFixture(input: {
  circleId: string
  membershipId: string
  name: string
  billingKind: 'free' | 'paid'
  status?: 'active' | 'suspended' | 'expired'
  currentPeriodEnd?: string | null
  orders?: Array<{
    orderId: string
    storedStatus: string
    effectivePaymentStatus: string | null
    correction?: import('@polo-ai/shared/admin').MemberCircleCorrection | null
  }>
}): MemberMembership {
  return {
    membershipId: input.membershipId,
    status: input.status ?? 'active',
    billingKind: input.billingKind,
    modeTransitionEndsAt: null,
    currentPeriodEnd: input.currentPeriodEnd ?? null,
    suspendedReason: input.status === 'suspended' ? 'provider_suspended' : null,
    joinedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    paymentOrders: (input.orders ?? []).map(order => ({
      orderId: order.orderId,
      storedStatus: order.storedStatus,
      amountMinor: 2500,
      currency: 'CNY',
      effectivePaymentStatus: order.effectivePaymentStatus,
      correction: order.correction ?? null,
    })),
    circle: {
      circleId: input.circleId,
      name: input.name,
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

const REFUND_CORRECTION: import('@polo-ai/shared/admin').MemberCircleCorrection = {
  kind: 'refund',
  amountMinor: 2500,
  partial: false,
  refundAmountMinor: 2500,
  chargebackAmountMinor: 0,
}

function accountACircles(): Array<MemberCircleSnapshot> {
  return [
    circleFixture({
      circleId: 'circle-growth',
      membershipId: 'ms-growth',
      name: 'Growth Circle',
      purpose: 'Playbooks, notes and research skills',
      billingKind: 'free',
      entitlements: [
        entitlementFixture('circle-growth', 'ent-g1', 'web_app', 'Playbook App'),
        entitlementFixture('circle-growth', 'ent-g2', 'web_app', 'Notes App'),
        entitlementFixture('circle-growth', 'ent-g3', 'skill', 'Research Skill'),
      ],
    }),
    circleFixture({
      circleId: 'circle-design',
      membershipId: 'ms-design',
      name: 'Design Circle',
      purpose: 'Brand voice analysis',
      billingKind: 'paid',
      currentPeriodEnd: '2026-11-02T00:00:00.000Z',
      entitlements: [
        entitlementFixture('circle-design', 'ent-d1', 'web_app', 'Brand App'),
        entitlementFixture('circle-design', 'ent-d2', 'skill', 'Voice Skill'),
      ],
    }),
    circleFixture({
      circleId: 'circle-annual',
      membershipId: 'ms-annual',
      name: 'Annual Circle',
      purpose: '',
      billingKind: 'paid',
      currentPeriodEnd: '2028-10-01T00:00:00.000Z',
      entitlements: [entitlementFixture('circle-annual', 'ent-a1', 'web_app', 'Annual App')],
    }),
    // Restricted rows (P70-CIRCLE-LIST-02): lifecycle-suspended AND
    // projection-refunded (G5) memberships land in 待恢复.
    circleFixture({
      circleId: 'circle-data',
      membershipId: 'ms-data',
      name: 'Data Circle',
      purpose: 'Periodic reports',
      billingKind: 'paid',
      status: 'suspended',
      entitlements: [entitlementFixture('circle-data', 'ent-x1', 'web_app', 'Reports App')],
    }),
    circleFixture({
      circleId: 'circle-refund',
      membershipId: 'ms-refund',
      name: 'Refunded Circle',
      purpose: '',
      billingKind: 'paid',
      entitlements: [entitlementFixture('circle-refund', 'ent-r1', 'web_app', 'Refund App')],
    }),
  ]
}

function accountAMemberships(): Array<MemberMembership> {
  return [
    membershipFixture({
      circleId: 'circle-growth',
      membershipId: 'ms-growth',
      name: 'Growth Circle',
      billingKind: 'free',
    }),
    membershipFixture({
      circleId: 'circle-design',
      membershipId: 'ms-design',
      name: 'Design Circle',
      billingKind: 'paid',
      currentPeriodEnd: '2026-11-02T00:00:00.000Z',
      orders: [{ orderId: 'order-design-1', storedStatus: 'paid', effectivePaymentStatus: 'paid' }],
    }),
    membershipFixture({
      circleId: 'circle-annual',
      membershipId: 'ms-annual',
      name: 'Annual Circle',
      billingKind: 'paid',
      currentPeriodEnd: '2028-10-01T00:00:00.000Z',
      orders: [{ orderId: 'order-annual-1', storedStatus: 'paid', effectivePaymentStatus: 'paid' }],
    }),
    membershipFixture({
      circleId: 'circle-data',
      membershipId: 'ms-data',
      name: 'Data Circle',
      billingKind: 'paid',
      status: 'suspended',
      orders: [{ orderId: 'order-data-1', storedStatus: 'paid', effectivePaymentStatus: 'paid' }],
    }),
    membershipFixture({
      circleId: 'circle-refund',
      membershipId: 'ms-refund',
      name: 'Refunded Circle',
      billingKind: 'paid',
      orders: [{
        orderId: 'order-refund-1',
        storedStatus: 'paid',
        effectivePaymentStatus: 'refunded',
        correction: REFUND_CORRECTION,
      }],
    }),
  ]
}

function circleB(): MemberCircleSnapshot {
  return circleFixture({
    circleId: 'circle-b',
    membershipId: 'ms-b',
    name: 'B Circle',
    purpose: 'Only for account B',
    billingKind: 'free',
    entitlements: [entitlementFixture('circle-b', 'ent-b1', 'skill', 'B Skill')],
  })
}

function membershipB(): MemberMembership {
  return membershipFixture({
    circleId: 'circle-b',
    membershipId: 'ms-b',
    name: 'B Circle',
    billingKind: 'free',
  })
}

// -------------------------------------------------------------------------
// Render harness: MemberCircleResourceProvider (real C2) + ClientPageProvider
// (real N1) + the page, plus a route probe for the navigation handoff.
// -------------------------------------------------------------------------

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { MemberCircleResourceProvider } = await import('@/context/MemberCircleResourceContext')
const { ClientPageProvider, clientPageScopeKey, useOptionalClientPage } = await import('@/context/ClientPageContext')
const { MyCirclesPage, __resetMyCirclesViewPreferencesForTests } = await import('../MyCirclesPage')

afterEach(() => {
  cleanup()
})

let observedRoute: ClientPageRoute | null = null
let probeClientPage: ReturnType<typeof useOptionalClientPage> = null

function RouteProbe() {
  const clientPage = useOptionalClientPage()
  probeClientPage = clientPage
  observedRoute = clientPage?.route ?? null
  return null
}

interface TreeOptions {
  accountId: string
  contextVersion?: number
  withPage?: boolean
}

function pageTree(options: TreeOptions) {
  const accountId = options.accountId
  const contextVersion = options.contextVersion ?? 1
  productSpaceContextState = accountBinding(accountId, contextVersion)
  currentAccount = accountId
  const scope = { accountId, productSpaceId: 'personal-space', epoch: contextVersion }
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      MemberCircleResourceProvider,
      null,
      createElement(
        ClientPageProvider,
        {
          key: clientPageScopeKey(scope),
          scope,
          children: [
            ...(options.withPage === false ? [] : [createElement(MyCirclesPage, { key: 'page' })]),
            createElement(RouteProbe, { key: 'probe' }),
          ],
        },
      ),
    ),
  )
}

async function renderReadyPage() {
  const view = render(pageTree({ accountId: 'account-a-fixture' }))
  await waitFor(() => {
    expect(screen.getByTestId('my-circles-list')).toBeTruthy()
  })
  return view
}

// Injected-resource mode (C2 review contract): the page's SYSTEM-state
// renderings that need a retained receipt beside a failure are driven through
// a pre-built resource instead of manipulating the live bridge.
function makeInjectedResource(stateOverrides: Partial<MemberCirclesResource['state']>): MemberCirclesResource {
  const base = {
    state: {
      phase: 'ready' as const,
      scope: {
        accountId: 'account-a-fixture',
        personalProductSpaceId: 'personal-space',
        contextKey: '["product-space",1,"account-a-fixture","personal-space"]',
        epoch: 1,
      },
      circles: circlesByAccount['account-a-fixture'] ?? null,
      memberships: membershipsByAccount['account-a-fixture'] ?? null,
      circlesError: null,
      membershipsError: null,
      refreshing: false,
      updatedAt: 1,
    },
    circles: circlesByAccount['account-a-fixture'] ?? null,
    memberships: membershipsByAccount['account-a-fixture'] ?? null,
    updateStates: {},
    profileStates: {},
    supportState: null,
    getCircle: () => ({ availability: 'unknown_circle' as const }),
    refresh: async () => ({ skipped: true as const, reason: 'no_scope' as const }),
    invalidateAndRefresh: async () => ({ relations: 'skipped' as const, catalog: 'unavailable' as const, circleId: null, orderId: null }),
    previewRenewal: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    leave: async () => ({ success: false as const, errorCode: 'conflict' as const, message: 'injected' }),
    getOrder: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    getCheckoutResult: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    getUpdates: async () => ({ success: true as const, updates: { availability: 'upstream_pending' as const, contractGap: 'G2' as const } }),
    refreshUpdates: async () => ({ success: true as const, updates: { availability: 'upstream_pending' as const, contractGap: 'G2' as const } }),
    getProfile: async () => ({ success: true as const, profile: { availability: 'upstream_pending' as const, contractGap: 'G3' as const } }),
    getSupport: async () => ({ success: true as const, support: { availability: 'upstream_pending' as const, contractGap: 'G4' as const } }),
    refreshSupport: async () => ({ success: true as const, support: { availability: 'upstream_pending' as const, contractGap: 'G4' as const } }),
  }
  return {
    ...base,
    state: { ...base.state, ...stateOverrides },
    circles: stateOverrides.circles !== undefined ? stateOverrides.circles : base.circles,
    memberships: stateOverrides.memberships !== undefined ? stateOverrides.memberships : base.memberships,
  }
}

function renderInjected(resource: MemberCirclesResource) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(MemberCircleResourceProvider, {
        resource,
        children: createElement(ClientPageProvider, {
          key: clientPageScopeKey({ accountId: 'account-a-fixture', productSpaceId: 'personal-space', epoch: 1 }),
          scope: { accountId: 'account-a-fixture', productSpaceId: 'personal-space', epoch: 1 },
          children: [createElement(MyCirclesPage, { key: 'page' }), createElement(RouteProbe, { key: 'probe' })],
        }),
      }),
    ),
  )
}

// -------------------------------------------------------------------------
// P70-CIRCLE-LIST-01 — the unified list
// -------------------------------------------------------------------------

describe('MyCirclesPage unified list (P70-CIRCLE-LIST-01)', () => {
  it('renders free / paid rows through ONE row component with the entitlement term at the fixed slot and 查看详情 at the right', async () => {
    await renderReadyPage()
    const rows = screen.getAllByTestId('circle-row')
    // Authoritative receipt order; free and BOTH paid kinds share the exact
    // same row structure (same testid contract, same fixed slots).
    expect(rows.map(row => row.getAttribute('data-circle-id'))).toEqual([
      'circle-growth',
      'circle-design',
      'circle-annual',
      'circle-data',
      'circle-refund',
    ])
    for (const row of rows) {
      expect(row.querySelector('[data-testid="circle-row-term"]')).toBeTruthy()
      expect(row.querySelector('[data-testid="circle-row-count"]')).toBeTruthy()
      expect(row.querySelector('[data-testid="circle-row-open"]')).toBeTruthy()
    }
    // Entitlement term wording comes from CONFIRMED fields only: free has no
    // expiry; paid rows show the confirmed period end. The C1 list receipt
    // carries no month/year cycle, so no 月度/年度 wording is fabricated.
    const terms = rows.map(row => row.querySelector('[data-testid="circle-row-term"]')!.textContent)
    expect(terms[0]).toBe('Free · No expiry')
    expect(terms[1]).toBe('Subscription · ends 2026-11-02')
    expect(terms[2]).toBe('Subscription · ends 2028-10-01')
    // Restricted rows (suspended / refunded) render the restore term in the
    // SAME slot — restricted feedback, not a different card layout.
    expect(terms[3]).toBe('Needs restoration')
    expect(terms[4]).toBe('Needs restoration')
    expect(rows[3]!.getAttribute('data-entitlement-state')).toBe('restore')
    expect(rows[4]!.getAttribute('data-entitlement-state')).toBe('restore')
  })

  it('shows the G1 upstream-pending creator line and never derives a name from ownerUserId', async () => {
    await renderReadyPage()
    const creators = screen.getAllByTestId('circle-row-creator')
    expect(creators.length).toBe(5)
    for (const creator of creators) {
      expect(creator.textContent).toBe('Creator name pending upstream')
      expect(creator.textContent).not.toContain('00000000-0000-4000-8000-00000000dead')
    }
  })

  it('renders NO summary line: the internal purpose never surfaces (POO-70 visual review R1 F1); counts come from typed entitlements', async () => {
    await renderReadyPage()
    const rows = screen.getAllByTestId('circle-row')
    const summaries = rows.map(row => row.querySelector('[data-testid="circle-row-summary"]')?.textContent ?? null)
    // The provider's only descriptive field is the INTERNAL purpose — a
    // user-visible row must not surface it (§13.12), and the provider has no
    // human-readable content-summary field yet, so the line stays absent on
    // EVERY row (never the English fixture purpose, never an invented update).
    for (const summary of summaries) {
      expect(summary).toBeNull()
    }
    // Entitlement counts: typed 'web_app' / 'skill' entries only.
    const counts = rows.map(row => row.querySelector('[data-testid="circle-row-count"]')!.textContent)
    expect(counts[0]).toBe('2 apps · 1 skill')
    expect(counts[2]).toBe('1 app')
  })
})

// -------------------------------------------------------------------------
// P70-CIRCLE-LIST-02 — search / filter / distinct system states
// -------------------------------------------------------------------------

describe('MyCirclesPage search and entitlement filter (P70-CIRCLE-LIST-02)', () => {
  it('narrows rows by confirmed name and shows the DISTINCT no-match state with a clear action', async () => {
    await renderReadyPage()
    fireEvent.change(screen.getByTestId('my-circles-search'), { target: { value: 'design' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('circle-row').length).toBe(1)
    })
    expect(screen.getAllByTestId('circle-row')[0]!.getAttribute('data-circle-id')).toBe('circle-design')

    fireEvent.change(screen.getByTestId('my-circles-search'), { target: { value: 'zzz-nothing' } })
    expect(screen.getByTestId('my-circles-no-match')).toBeTruthy()
    expect(screen.queryByTestId('my-circles-list')).toBeNull()
    // Search-no-match is NOT the empty-relations state.
    expect(screen.queryByTestId('my-circles-empty')).toBeNull()

    fireEvent.click(screen.getByTestId('my-circles-clear-filters'))
    await waitFor(() => {
      expect(screen.getAllByTestId('circle-row').length).toBe(5)
    })
  })

  it('filters by entitlement state; 待恢复 rows drop out of 有效 and vice versa', async () => {
    await renderReadyPage()
    const filter = screen.getByTestId('my-circles-filter')
    fireEvent.change(filter, { target: { value: 'valid' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('circle-row').length).toBe(3)
    })
    expect(
      screen.getAllByTestId('circle-row').every(row => row.getAttribute('data-entitlement-state') === 'valid'),
    ).toBe(true)

    fireEvent.change(filter, { target: { value: 'restore' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('circle-row').length).toBe(2)
    })
    expect(
      screen.getAllByTestId('circle-row').every(row => row.getAttribute('data-entitlement-state') === 'restore'),
    ).toBe(true)
  })
})

describe('MyCirclesPage distinct system states (P70-CIRCLE-LIST-02)', () => {
  it('renders a DISTINCT loading state while the authoritative read is in flight', async () => {
    holdListRequests = true
    render(pageTree({ accountId: 'account-a-fixture' }))
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-loading')).toBeTruthy()
    })
    expect(screen.queryByTestId('my-circles-list')).toBeNull()
    expect(screen.queryByTestId('my-circles-error')).toBeNull()
    // Release BOTH held reads: loading resolves into the ready list.
    await act(async () => {
      for (const resolve of pendingListResolvers.splice(0)) resolve()
      for (const resolve of pendingMembershipsResolvers.splice(0)) resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
  })

  it('renders the empty-relations state with browser-join guidance and NO share-link input, join button or marketplace', async () => {
    circlesByAccount['account-a-fixture'] = []
    membershipsByAccount['account-a-fixture'] = []
    render(pageTree({ accountId: 'account-a-fixture' }))
    const empty = await waitFor(() => screen.getByTestId('my-circles-empty'))
    expect(empty.textContent).toContain('No circles joined yet')
    expect(empty.querySelectorAll('input, button, a').length).toBe(0)
    expect(screen.queryByTestId('my-circles-loading')).toBeNull()
    expect(screen.queryByTestId('my-circles-error')).toBeNull()
    // The empty phase has no list and no toolbar.
    expect(screen.queryByTestId('my-circles-toolbar')).toBeNull()
  })

  it('renders the error state with an explicit retry that recovers into the list', async () => {
    // BOTH receipts fail (non-network class) → the error phase, distinct from
    // partial and offline.
    listErrorCode = 'forbidden'
    membershipsErrorCode = 'forbidden'
    render(pageTree({ accountId: 'account-a-fixture' }))
    expect(await waitFor(() => screen.getByTestId('my-circles-error'))).toBeTruthy()
    expect(screen.queryByTestId('my-circles-offline')).toBeNull()
    const callsBeforeRetry = listCalls
    // Flip the stub to success and retry — recovery keeps the same fact base.
    listErrorCode = null
    membershipsErrorCode = null
    fireEvent.click(screen.getByTestId('my-circles-retry'))
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
    expect(listCalls).toBe(callsBeforeRetry + 1)
  })

  it('renders the OFFLINE state (network-class failure) distinct from the error state', async () => {
    listErrorCode = 'network_error'
    membershipsErrorCode = 'network_error'
    render(pageTree({ accountId: 'account-a-fixture' }))
    expect(await waitFor(() => screen.getByTestId('my-circles-offline'))).toBeTruthy()
    expect(screen.queryByTestId('my-circles-error')).toBeNull()
  })

  it('renders the restricted (denied) state for enterprise/denied scopes', async () => {
    renderInjected(makeInjectedResource({ phase: 'denied', scope: null, circles: null, memberships: null }))
    expect(screen.getByTestId('my-circles-restricted-banner')).toBeTruthy()
    expect(screen.queryByTestId('my-circles-list')).toBeNull()
    expect(screen.queryByTestId('my-circles-toolbar')).toBeNull()
  })

  it('keeps retained rows under a STALE banner when a refresh failed over the cache', async () => {
    renderInjected(makeInjectedResource({
      phase: 'ready',
      circlesError: { code: 'timeout', retryable: true },
    }))
    expect(screen.getByTestId('my-circles-stale-banner')).toBeTruthy()
    // Rows stay visible; the banner carries its own explicit retry.
    expect(screen.getAllByTestId('circle-row').length).toBe(5)
    expect(screen.getByTestId('my-circles-stale-retry')).toBeTruthy()
  })

  it('renders the partial banner when one authoritative receipt half-failed', async () => {
    renderInjected(makeInjectedResource({
      phase: 'partial',
      membershipsError: { code: 'timeout', retryable: true },
    }))
    expect(screen.getByTestId('my-circles-partial-banner')).toBeTruthy()
    // The circles receipt is intact → its rows still render.
    expect(screen.getAllByTestId('circle-row').length).toBe(5)
  })
})

// -------------------------------------------------------------------------
// P70-CIRCLE-LIST-03 — stable circleId navigation + per-account restore
// -------------------------------------------------------------------------

describe('MyCirclesPage navigation and toolbar restore (P70-CIRCLE-LIST-03)', () => {
  it('navigates to circle-detail content with the STABLE circleId and returns home via back', async () => {
    await renderReadyPage()
    // Set the stack to [home, circles] through the REAL ClientPageContext,
    // exactly like the home circles entry (P70-NAV-01).
    await act(async () => {
      probeClientPage!.navigate({ kind: 'circles' })
    })
    expect(observedRoute).toEqual({ kind: 'circles' })
    const rows = screen.getAllByTestId('circle-row')
    const designRow = rows.find(row => row.getAttribute('data-circle-id') === 'circle-design')!
    fireEvent.click(designRow.querySelector('[data-testid="circle-row-open"]')!)
    expect(observedRoute).toEqual({ kind: 'circle-detail', circleId: 'circle-design', section: 'content' })

    // 返回首页 pops ONE stack entry (detail → circles), and the home ROOT is
    // never popped below.
    fireEvent.click(screen.getByTestId('my-circles-back'))
    expect(observedRoute).toEqual({ kind: 'circles' })
    fireEvent.click(screen.getByTestId('my-circles-back'))
    expect(observedRoute).toEqual({ kind: 'home' })
  })

  it("restores THIS account's search and filter after leaving and re-entering the same scope", async () => {
    const first = render(pageTree({ accountId: 'account-a-fixture' }))
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('my-circles-search'), { target: { value: 'design' } })
    fireEvent.change(screen.getByTestId('my-circles-filter'), { target: { value: 'valid' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('circle-row').length).toBe(1)
    })

    // Leave (unmount) and re-enter the SAME live scope: the exact search and
    // filter combination comes back.
    first.unmount()
    render(pageTree({ accountId: 'account-a-fixture' }))
    await waitFor(() => {
      expect((screen.getByTestId('my-circles-search') as HTMLInputElement).value).toBe('design')
    })
    expect((screen.getByTestId('my-circles-filter') as HTMLSelectElement).value).toBe('valid')
    expect(screen.getAllByTestId('circle-row').length).toBe(1)
  })

  it("never shows another account's toolbar state or rows after an account change", async () => {
    const first = render(pageTree({ accountId: 'account-a-fixture' }))
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
    fireEvent.change(screen.getByTestId('my-circles-search'), { target: { value: 'design' } })

    // Account A → B: the C2 scope rebind refetches for B; the page reseeds
    // the toolbar to B's (fresh) preferences and renders ONLY B's rows.
    await act(async () => {
      first.rerender(pageTree({ accountId: 'account-b-fixture', contextVersion: 2 }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
    expect((screen.getByTestId('my-circles-search') as HTMLInputElement).value).toBe('')
    const rows = screen.getAllByTestId('circle-row')
    expect(rows.length).toBe(1)
    expect(rows[0]!.getAttribute('data-circle-id')).toBe('circle-b')
    expect(screen.queryByText('Growth Circle')).toBeNull()

    // Back to A (fresh context version — a re-bound scope): A's toolbar state
    // is NOT resurrected across the rebind, and A's rows return from a fresh
    // authoritative read only.
    await act(async () => {
      first.rerender(pageTree({ accountId: 'account-a-fixture', contextVersion: 3 }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('my-circles-list')).toBeTruthy()
    })
    expect((screen.getByTestId('my-circles-search') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByTestId('circle-row').length).toBe(5)
  })
})
