/**
 * CircleSubscriptionPanel interaction tests (POO-70 C6 / POO-95).
 *
 * Isolated-process host (own bun process via `bun test --isolate <file>`,
 * same pattern as MyCirclesPage.interaction.isolated.ts): the ProductSpace
 * binding is a mutable module double, the trusted C1 bridge and
 * `electronAPI.openUrl` are mutable window stubs, and the panel mounts under
 * the REAL C2 resource provider so the scope fence is exercised for real.
 *
 * Scenarios (P70-SUBSCRIPTION-01/02/03):
 * - 01 display: identity + status header; price/period/validity each ONCE;
 *   月/年 wording ONLY from the preview periodKind (calendar_month /
 *   calendar_year); free circles show no renewal surface; null price states
 *   web confirmation instead of a fabricated amount; the next-period price
 *   fact renders from the circle DTO.
 * - 02 handoff: renewal opens ONLY after the preview GET through the
 *   renderer gate; cap opens nothing (no order, no QR, no payment SDK);
 *   blocked/untrusted URLs never reach openUrl; launch failure retries
 *   WITHOUT a second GET.
 * - 03 recovery: expired renders the restore entry and never the cap; the
 *   cap state keeps 查看原订单 (getOrder receipt is display history, G5);
 *   preview/order failures are distinct retryable states; the exit region
 *   is a reserved mount point and onLeave/onReturn are NEVER invoked here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  MemberCircleRenewalPreview,
  MemberCircleSnapshot,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'

// -------------------------------------------------------------------------
// Isolated-process host
// -------------------------------------------------------------------------

GlobalRegistrator.register()
setupI18n()
await i18n.changeLanguage('zh-Hans')

let productSpaceContextState: unknown = {
  accountId: 'account-a-fixture',
  activeProductSpaceId: 'personal-space',
  personalProductSpaceId: 'personal-space',
  productSpaceContextKey: '["product-space",1,"account-a-fixture","personal-space"]',
  contextVersion: 1,
  activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
}

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { MemberCircleResourceProvider } = await import('@/context/MemberCircleResourceContext')
const {
  CircleSubscriptionPanel,
  formatSubscriptionDate,
  formatSubscriptionPrice,
  resolveSubscriptionStatus,
  subscriptionPeriodLabel,
} = await import('../CircleSubscriptionPanel')

// -------------------------------------------------------------------------
// Fixtures (authoritative DTO shapes; no prototype demo amounts in prod code)
// -------------------------------------------------------------------------

const CONTROLLED_ORIGIN = 'https://creator.polo.z-h-ai.com'

function circleFixture(overrides: Partial<MemberCircleSnapshot> = {}): MemberCircleSnapshot {
  return {
    membershipId: 'membership-monthly-fixture',
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-02T00:00:00.000Z',
    joinSource: 'share_link',
    joinedAt: '2026-09-01T00:00:00.000Z',
    circle: {
      circleId: 'circle-monthly-fixture',
      name: '晨星设计圈',
      purpose: '品牌语气分析等作品',
      status: 'active',
      ownerUserId: 'owner-uuid-fixture',
    },
    entitlements: [],
    ...overrides,
  }
}

function membershipFixture(overrides: Partial<MemberMembership> = {}): MemberMembership {
  return {
    membershipId: 'membership-monthly-fixture',
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-02T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    paymentOrders: [
      {
        orderId: 'order-original-fixture',
        storedStatus: 'paid',
        amountMinor: 3900,
        currency: 'CNY',
        effectivePaymentStatus: 'paid',
        correction: null,
      },
    ],
    circle: {
      circleId: 'circle-monthly-fixture',
      name: '晨星设计圈',
      purpose: '品牌语气分析等作品',
      status: 'active',
      joinMode: 'paid',
      membershipPriceMinor: 3900,
      membershipCurrency: 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
    ...overrides,
  }
}

function previewFixture(overrides: Partial<MemberCircleRenewalPreview> = {}): MemberCircleRenewalPreview {
  return {
    membershipId: 'membership-monthly-fixture',
    circleId: 'circle-monthly-fixture',
    billingCycle: 'month',
    periodKind: 'calendar_month',
    priceMinor: 3900,
    currency: 'CNY',
    anchorAt: '2026-11-02T00:00:00.000Z',
    projectedPeriodStartAt: '2026-11-02T00:00:00.000Z',
    projectedPeriodEndAt: '2026-12-02T00:00:00.000Z',
    periodCapEndAt: '2027-11-02T00:00:00.000Z',
    canRenew: true,
    capReason: null,
    ...overrides,
  }
}

function successPreviewPayload(overrides: Partial<MemberCircleRenewalPreview> = {}) {
  return {
    success: true as const,
    purchaseUrl: '/c/morning-star?renew=1',
    resolvedPurchaseUrl: `${CONTROLLED_ORIGIN}/c/morning-star?renew=1`,
    purchaseUrlResolutionError: null,
    preview: previewFixture(overrides),
  }
}

function orderFixture(overrides: Partial<OriginalCircleOrder> = {}): OriginalCircleOrder {
  return {
    orderId: 'order-original-fixture',
    storedStatus: 'paid',
    amountMinor: 3900,
    currency: 'CNY',
    checkoutUrl: '/c/morning-star',
    periodEndAt: '2026-11-02T00:00:00.000Z',
    circle: { circleId: 'circle-monthly-fixture', name: '晨星设计圈' },
    paymentOwner: 'B01',
    ...overrides,
  }
}

// -------------------------------------------------------------------------
// Mutable bridge stub (the only trusted-read authority in this harness)
// -------------------------------------------------------------------------

let previewResponse: unknown = successPreviewPayload()
let previewCalls = 0
let openUrlCalls: string[] = []
let orderResponse: unknown = { success: true as const, order: orderFixture() }
let orderCalls: string[] = []

function installBridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: () => Promise.resolve({ success: true, circles: [circleFixture()] }),
        listMemberships: () => Promise.resolve({ success: true, memberships: [membershipFixture()] }),
        previewRenewal: () => {
          previewCalls += 1
          return Promise.resolve(previewResponse)
        },
        getOrder: (orderId: string) => {
          orderCalls.push(orderId)
          return Promise.resolve(orderResponse)
        },
        getCheckoutResult: () => Promise.resolve({ success: false as const, errorCode: 'not_found' as const, message: 'unused' }),
        getUpdates: () => Promise.resolve({ success: false as const, errorCode: 'not_found' as const, message: 'unused' }),
        getProfile: () => Promise.resolve({ success: false as const, errorCode: 'not_found' as const, message: 'unused' }),
        getSupport: () => Promise.resolve({ success: false as const, errorCode: 'not_found' as const, message: 'unused' }),
        leave: () => Promise.resolve({ success: false as const, errorCode: 'not_found' as const, message: 'unused' }),
      },
      openUrl: (url: string) => {
        openUrlCalls.push(url)
        return Promise.resolve()
      },
    },
  })
}

beforeEach(() => {
  productSpaceContextState = {
    accountId: 'account-a-fixture',
    activeProductSpaceId: 'personal-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: '["product-space",1,"account-a-fixture","personal-space"]',
    contextVersion: 1,
    activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
  }
  previewResponse = successPreviewPayload()
  previewCalls = 0
  openUrlCalls = []
  orderResponse = { success: true as const, order: orderFixture() }
  orderCalls = []
  installBridge()
})

afterEach(() => {
  cleanup()
})

function renderPanel(props: Partial<Parameters<typeof CircleSubscriptionPanel>[0]> = {}) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(MemberCircleResourceProvider, null,
      createElement(CircleSubscriptionPanel, {
        circle: circleFixture(),
        membership: membershipFixture(),
        ...props,
      }),
    )),
  )
}

const price = (minor: number) => formatSubscriptionPrice(minor, 'CNY', 'zh-Hans')

// -------------------------------------------------------------------------
// Pure display helpers
// -------------------------------------------------------------------------

describe('subscription display helpers', () => {
  it('uses the preview periodKind discriminated union for 月/年 wording', () => {
    expect(subscriptionPeriodLabel({ periodKind: 'calendar_month' }, k => i18n.t(k)))
      .toBe('月度订阅')
    expect(subscriptionPeriodLabel({ periodKind: 'calendar_year' }, k => i18n.t(k)))
      .toBe('年度订阅')
    expect(subscriptionPeriodLabel(null, k => i18n.t(k))).toBeNull()
  })

  it('falls back to the circle row when no membership projection exists', () => {
    expect(resolveSubscriptionStatus(null, { status: 'expired' })).toBe('expired')
    expect(resolveSubscriptionStatus(membershipFixture({ status: 'suspended' }), { status: 'active' }))
      .toBe('suspended')
  })

  it('renders provider instants as deterministic UTC calendar dates', () => {
    expect(formatSubscriptionDate('2026-11-02T00:00:00.000Z')).toBe('2026-11-02')
    expect(formatSubscriptionDate('not-a-date')).toBe('')
  })

  it('renders minor-unit prices and never fabricates unavailable amounts', () => {
    expect(formatSubscriptionPrice(3900, 'CNY', 'zh-Hans')).toContain('39')
    expect(formatSubscriptionPrice(null, 'CNY', 'zh-Hans')).toBe('')
    expect(formatSubscriptionPrice(3900, null, 'zh-Hans')).toBe('')
    expect(formatSubscriptionPrice(-1, 'CNY', 'zh-Hans')).toBe('')
  })
})

// -------------------------------------------------------------------------
// P70-SUBSCRIPTION-01 — display
// -------------------------------------------------------------------------

describe('P70-SUBSCRIPTION-01: identity, single occurrence, authoritative period', () => {
  it('shows circle identity and effective status in the header; monthly wording from preview', async () => {
    renderPanel()
    expect(screen.getByTestId('circle-subscription-circle-name').textContent).toBe('晨星设计圈')
    const status = await screen.findByTestId('circle-subscription-status')
    expect(status.getAttribute('data-status')).toBe('active')
    const period = await screen.findByTestId('circle-subscription-period-value')
    expect(period.textContent).toContain('月度订阅')
    expect(period.textContent).toContain(price(3900))
    expect(period.textContent).toContain('/ 月')
    // Validity is the membership currentPeriodEnd, rendered ONCE.
    const validity = screen.getByTestId('circle-subscription-validity-value')
    expect(validity.textContent).toContain('有效至 2026-11-02')
  })

  it('renders price and period exactly once (no duplication anywhere in the section)', async () => {
    const { container } = renderPanel()
    await screen.findByTestId('circle-subscription-renew')
    const occurrences = container.textContent!.split(price(3900)).length - 1
    expect(occurrences).toBe(1)
    expect(container.textContent!.split('月度订阅').length - 1).toBe(1)
    expect(container.textContent!.split('有效至 2026-11-02').length - 1).toBe(1)
  })

  it('takes yearly wording from the preview period union, never from the list layer', async () => {
    previewResponse = successPreviewPayload({
      billingCycle: 'year',
      periodKind: 'calendar_year',
      priceMinor: 39000,
      projectedPeriodEndAt: '2027-11-02T00:00:00.000Z',
      periodCapEndAt: '2028-11-02T00:00:00.000Z',
    })
    renderPanel({ membership: membershipFixture({ circle: { ...membershipFixture().circle, membershipPriceMinor: 39000 } }) })
    const period = await screen.findByTestId('circle-subscription-period-value')
    expect(period.textContent).toContain('年度订阅')
    expect(period.textContent).toContain('/ 年')
  })

  it('states web-confirmation for a null preview price instead of fabricating an amount', async () => {
    previewResponse = successPreviewPayload({ priceMinor: null })
    const { container } = renderPanel()
    await screen.findByTestId('circle-subscription-renew')
    expect(screen.getByTestId('circle-subscription-period-value').textContent).toContain('价格以公开页确认价格为准')
    expect(container.textContent).not.toContain(price(3900))
  })

  it('free circles show no renewal surface and issue no preview GET', async () => {
    const freeMembership = membershipFixture({
      status: 'active',
      billingKind: 'free',
      currentPeriodEnd: null,
      paymentOrders: [],
      circle: { ...membershipFixture().circle, joinMode: 'free', membershipPriceMinor: null, membershipCurrency: null },
    })
    const freeCircle = circleFixture({ billingKind: 'free', currentPeriodEnd: null })
    renderPanel({ circle: freeCircle, membership: freeMembership })
    await screen.findByTestId('circle-subscription-validity-value')
    expect(screen.queryByTestId('circle-subscription-renew')).toBeNull()
    expect(screen.queryByTestId('circle-subscription-preview-loading')).toBeNull()
    expect(previewCalls).toBe(0)
    const period = screen.getByTestId('circle-subscription-period-value')
    expect(period.textContent).toContain('免费 · 长期有效')
    expect(screen.getByTestId('circle-subscription-validity-value').textContent).toContain('长期有效')
  })

  it('shows the authoritative next-period price fact once when provided', async () => {
    renderPanel({
      membership: membershipFixture({
        circle: {
          ...membershipFixture().circle,
          nextPeriodPriceMinor: 4900,
          nextPriceEffectiveAt: '2026-12-01T00:00:00.000Z',
        },
      }),
    })
    const note = await screen.findByTestId('circle-subscription-next-price')
    expect(note.textContent).toContain('2026-12-01')
    expect(note.textContent).toContain(price(4900))
  })
})

// -------------------------------------------------------------------------
// P70-SUBSCRIPTION-02 — preview GET then browser handoff
// -------------------------------------------------------------------------

describe('P70-SUBSCRIPTION-02: preview-then-open, fail closed, no payment surface', () => {
  it('renewal opens the resolved creator path after the single preview GET', async () => {
    renderPanel()
    const renew = await screen.findByTestId('circle-subscription-renew')
    // The auto preview GET happened exactly once; renew must NOT re-GET.
    expect(previewCalls).toBe(1)
    renew.click()
    await waitFor(() => expect(openUrlCalls).toHaveLength(1))
    expect(openUrlCalls[0]).toBe(`${CONTROLLED_ORIGIN}/c/morning-star?renew=1`)
    expect(previewCalls).toBe(1)
    // No order creation surface exists on this panel.
    expect(screen.queryByTestId('circle-subscription-cap')).toBeNull()
  })

  it('renews after re-fetching the preview when the held one failed', async () => {
    previewResponse = { success: false as const, errorCode: 'network_error' as const, message: 'down' }
    renderPanel()
    const error = await screen.findByTestId('circle-subscription-preview-error')
    expect(error.textContent).toContain('续费预览获取失败')
    expect(screen.queryByTestId('circle-subscription-renew')).toBeNull()
    // Recovery: retry the preview GET, then the CTA appears and opens.
    previewResponse = successPreviewPayload()
    screen.getByTestId('circle-subscription-preview-retry').click()
    const renew = await screen.findByTestId('circle-subscription-renew')
    expect(previewCalls).toBe(2)
    renew.click()
    await waitFor(() => expect(openUrlCalls).toHaveLength(1))
  })

  it('never opens a blocked/untrusted handoff and shows the fail-closed reason', async () => {
    previewResponse = {
      ...successPreviewPayload(),
      purchaseUrl: 'https://evil.example.com/c/morning-star?renew=1',
      resolvedPurchaseUrl: null,
      purchaseUrlResolutionError: 'untrusted_purchase_url_origin' as const,
    }
    renderPanel()
    await screen.findByTestId('circle-subscription-handoff-blocked')
    expect(screen.getByTestId('circle-subscription-handoff-blocked').textContent)
      .toContain('来源不受信任')
    expect(openUrlCalls).toHaveLength(0)
    // The CTA stays hidden while the handoff is blocked: nothing may open.
    expect(screen.queryByTestId('circle-subscription-renew')).toBeNull()
  })

  it('a browser launch failure is a distinct retryable state that re-opens without a second GET', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        memberCircles: (window as unknown as { electronAPI: { memberCircles: object } }).electronAPI.memberCircles,
        openUrl: () => Promise.reject(new Error('launch failed')),
      },
    })
    renderPanel()
    const renew = await screen.findByTestId('circle-subscription-renew')
    renew.click()
    const failed = await screen.findByTestId('circle-subscription-open-failed')
    expect(failed.textContent).toContain('续费网页启动失败')
    const getsAfterFailure = previewCalls
    // Recovery retries the LAUNCH, not the preview GET.
    screen.getByTestId('circle-subscription-open-retry').click()
    await waitFor(() => expect(screen.queryByTestId('circle-subscription-open-failed')).toBeNull())
    expect(previewCalls).toBe(getsAfterFailure)
  })

  it('the cap state creates no order and opens nothing, keeping 查看原订单 available', async () => {
    previewResponse = successPreviewPayload({ canRenew: false, capReason: 'next_period_already_purchased' })
    renderPanel()
    await screen.findByTestId('circle-subscription-cap')
    expect(screen.queryByTestId('circle-subscription-renew')).toBeNull()
    expect(openUrlCalls).toHaveLength(0)
    expect(screen.getByTestId('circle-subscription-cap').textContent)
      .toContain('本次没有创建新订单或支付码')
    expect(screen.getByTestId('circle-subscription-cap-reason').textContent)
      .toContain('next_period_already_purchased')
    // 限额不建单仍可查原单.
    screen.getByTestId('circle-subscription-view-order').click()
    const order = await screen.findByTestId('circle-subscription-order')
    expect(orderCalls).toEqual(['order-original-fixture'])
    expect(screen.getByTestId('circle-subscription-order-id').textContent).toContain('order-original-fixture')
    expect(screen.getByTestId('circle-subscription-order-status').textContent).toContain('paid')
  })
})

// -------------------------------------------------------------------------
// P70-SUBSCRIPTION-03 — recovery, exit region reservation
// -------------------------------------------------------------------------

describe('P70-SUBSCRIPTION-03: expired recovery, order display, exit region', () => {
  it('an expired membership renders the restore entry and never the cap block', async () => {
    renderPanel({
      circle: circleFixture({ status: 'expired' }),
      membership: membershipFixture({ status: 'expired', currentPeriodEnd: '2026-09-01T00:00:00.000Z' }),
    })
    const status = await screen.findByTestId('circle-subscription-status')
    expect(status.getAttribute('data-status')).toBe('expired')
    const restore = await screen.findByTestId('circle-subscription-renew-restore')
    expect(restore.textContent).toContain('续费恢复')
    expect(screen.queryByTestId('circle-subscription-cap')).toBeNull()
    const validity = screen.getByTestId('circle-subscription-validity-value')
    expect(validity.textContent).toContain('2026-09-01 到期')
  })

  it('an expired membership never shows the purchase-cap state, even when capped (fail closed)', async () => {
    previewResponse = successPreviewPayload({ canRenew: false, capReason: 'any_cap' })
    renderPanel({
      circle: circleFixture({ status: 'expired' }),
      membership: membershipFixture({ status: 'expired', currentPeriodEnd: '2026-09-01T00:00:00.000Z' }),
    })
    await screen.findByTestId('circle-subscription-status')
    expect(screen.queryByTestId('circle-subscription-cap')).toBeNull()
    // No dead button either: the server said cannot renew, so nothing opens.
    expect(screen.queryByTestId('circle-subscription-renew-restore')).toBeNull()
    expect(openUrlCalls).toHaveLength(0)
  })

  it('a suspended membership fails closed: reason shown, no renewal CTA', async () => {
    renderPanel({
      membership: membershipFixture({
        status: 'suspended',
        suspendedReason: 'payment_review',
      }),
    })
    const reason = await screen.findByTestId('circle-subscription-suspended-reason')
    expect(reason.textContent).toBe('payment_review')
    expect(screen.queryByTestId('circle-subscription-renew')).toBeNull()
    expect(screen.queryByTestId('circle-subscription-renew-restore')).toBeNull()
    expect(openUrlCalls).toHaveLength(0)
  })

  it('an order read failure is distinct and retryable; the receipt stays display-only (G5)', async () => {
    orderResponse = { success: false as const, errorCode: 'network_error' as const, message: 'down' }
    renderPanel()
    await screen.findByTestId('circle-subscription-renew')
    screen.getByTestId('circle-subscription-view-order-cta').click()
    const failed = await screen.findByTestId('circle-subscription-order-failed')
    expect(failed.textContent).toContain('原订单查询失败')
    orderResponse = { success: true as const, order: orderFixture() }
    screen.getByTestId('circle-subscription-order-retry').click()
    await screen.findByTestId('circle-subscription-order')
    expect(screen.getByTestId('circle-subscription-order').textContent)
      .toContain('订单记录仅作展示')
    expect(screen.getByTestId('circle-subscription-order-period-end').textContent).toContain('2026-11-02')
  })

  it('reserves the exit region and never invokes onLeave/onReturn by itself', async () => {
    const onLeave = mock(() => {})
    const onReturn = mock(() => {})
    renderPanel({ onLeave, onReturn })
    await screen.findByTestId('circle-subscription-renew')
    // Exercise every interactive control above before judging the contract.
    screen.getByTestId('circle-subscription-view-order-cta').click()
    await screen.findByTestId('circle-subscription-order')
    expect(screen.getByTestId('circle-subscription-exit-region')).toBeTruthy()
    expect(onLeave).not.toHaveBeenCalled()
    expect(onReturn).not.toHaveBeenCalled()
  })
})
