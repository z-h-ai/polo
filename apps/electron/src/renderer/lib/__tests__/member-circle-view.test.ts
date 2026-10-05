import { describe, expect, it } from 'bun:test'
import type {
  MemberCirclePaymentOrderSummary,
  MemberCircleSnapshot,
  MemberMembership,
} from '@polo-ai/shared/admin'
import {
  isEntitlementJudgmentPaid,
  isMembershipEndedBeforePeriodEnd,
  isRenewalPriceAvailable,
  judgeMembershipPaymentStatus,
  memberCircleCreatorNameField,
  selectLatestEntitlementJudgment,
  selectLostCircleAuthorizationIds,
  selectMemberCircleDetail,
  selectRenewalHandoff,
} from '../member-circle-view'

let orderSequence = 0

function paymentOrder(
  overrides: Partial<MemberCirclePaymentOrderSummary> = {},
): MemberCirclePaymentOrderSummary {
  orderSequence += 1
  return {
    orderId: `00000000-0000-4000-8000-${String(orderSequence).padStart(12, '0')}`,
    storedStatus: 'paid',
    amountMinor: 9900,
    currency: 'CNY',
    effectivePaymentStatus: null,
    correction: null,
    ...overrides,
  }
}

let circleSequence = 0

function circleSnapshot(
  circleId: string,
  overrides: Partial<MemberCircleSnapshot> = {},
): MemberCircleSnapshot {
  circleSequence += 1
  return {
    membershipId: `00000000-0000-4000-9000-${String(circleSequence).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    joinSource: 'share_link',
    joinedAt: '2026-01-01T00:00:00.000Z',
    circle: {
      circleId,
      name: '设计进阶圈',
      purpose: '一起练设计',
      status: 'active',
      ownerUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
    },
    entitlements: [],
    ...overrides,
  }
}

let membershipSequence = 0

function membership(
  circleId: string,
  overrides: Partial<MemberMembership> = {},
): MemberMembership {
  membershipSequence += 1
  return {
    membershipId: `00000000-0000-4000-9100-${String(membershipSequence).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    paymentOrders: [paymentOrder()],
    circle: {
      circleId,
      name: '设计进阶圈',
      purpose: '一起练设计',
      status: 'active',
      joinMode: 'paid',
      membershipPriceMinor: 9900,
      membershipCurrency: 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
    ...overrides,
  }
}

describe('memberCircleCreatorNameField (G1)', () => {
  it('never fabricates a creator name from ownerUserId', () => {
    const field = memberCircleCreatorNameField(circleSnapshot('c-1').circle)
    expect(field).toEqual({ readiness: 'upstream_pending', contractGap: 'G1' })
  })

  it('stays pending for membership circle rows too', () => {
    const membershipRow = membership('c-1')
    const field = memberCircleCreatorNameField(membershipRow.circle)
    expect(field).toEqual({ readiness: 'upstream_pending', contractGap: 'G1' })
  })
})

describe('judgeMembershipPaymentStatus (G5)', () => {
  it('judges from the correction-aware projection, not the stored status', () => {
    const judgment = judgeMembershipPaymentStatus(paymentOrder({
      storedStatus: 'paid',
      effectivePaymentStatus: 'refunded',
      correction: {
        kind: 'refund',
        amountMinor: 9900,
        partial: false,
        refundAmountMinor: 9900,
        chargebackAmountMinor: 0,
      },
    }))
    expect(judgment).toMatchObject({
      basis: 'projected',
      effectivePaymentStatus: 'refunded',
      storedStatus: 'paid',
    })
    expect(isEntitlementJudgmentPaid(judgment)).toBe(false)
  })

  it('keeps an explicit unknown projection as an unknown fact', () => {
    const judgment = judgeMembershipPaymentStatus(paymentOrder({
      storedStatus: 'paid',
      effectivePaymentStatus: 'unknown',
    }))
    expect(judgment).toMatchObject({
      basis: 'projected',
      effectivePaymentStatus: 'unknown',
    })
    expect(isEntitlementJudgmentPaid(judgment)).toBe(false)
  })

  it('stays unknown with a reason when the provider omitted the projection', () => {
    const judgment = judgeMembershipPaymentStatus(paymentOrder({
      storedStatus: 'paid',
      effectivePaymentStatus: null,
    }))
    expect(judgment).toEqual({
      basis: 'unknown',
      effectivePaymentStatus: null,
      correction: null,
      storedStatus: 'paid',
      reason: 'projection_missing',
    })
    expect(isEntitlementJudgmentPaid(judgment)).toBe(false)
  })

  it('only a projected `paid` counts as paid', () => {
    const projected = judgeMembershipPaymentStatus(paymentOrder({
      effectivePaymentStatus: 'paid',
    }))
    expect(isEntitlementJudgmentPaid(projected)).toBe(true)
  })
})

describe('selectLatestEntitlementJudgment', () => {
  it('judges from the newest order only', () => {
    const row = membership('c-1', {
      paymentOrders: [
        paymentOrder({ effectivePaymentStatus: 'refunded' }),
        paymentOrder({ storedStatus: 'paid', effectivePaymentStatus: 'paid' }),
      ],
    })
    expect(selectLatestEntitlementJudgment(row)).toMatchObject({
      basis: 'projected',
      effectivePaymentStatus: 'refunded',
    })
  })

  it('returns null when the membership has no orders at all', () => {
    const row = membership('c-1', { paymentOrders: [] })
    expect(selectLatestEntitlementJudgment(row)).toBeNull()
  })
})

describe('selectMemberCircleDetail', () => {
  it('projects circle + membership + judgment + pending creator name', () => {
    const circles = [circleSnapshot('c-1'), circleSnapshot('c-2')]
    const memberships = [membership('c-2', {
      paymentOrders: [paymentOrder({ effectivePaymentStatus: 'paid' })],
    })]
    const detail = selectMemberCircleDetail(circles, memberships, 'c-2')
    expect(detail.availability).toBe('ready')
    if (detail.availability !== 'ready') return
    expect(detail.circle.circle.circleId).toBe('c-2')
    expect(detail.membership?.circle.circleId).toBe('c-2')
    expect(detail.creatorName).toEqual({ readiness: 'upstream_pending', contractGap: 'G1' })
    expect(detail.entitlementJudgment).toMatchObject({
      basis: 'projected',
      effectivePaymentStatus: 'paid',
    })
  })

  it('keeps empty entitlements as a legitimate ready state (G8)', () => {
    const detail = selectMemberCircleDetail(
      [circleSnapshot('closed-circle', {
        status: 'expired',
        circle: {
          circleId: 'closed-circle',
          name: '已关闭圈',
          purpose: '',
          status: 'closed',
          ownerUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
        entitlements: [],
      })],
      [],
      'closed-circle',
    )
    expect(detail).toMatchObject({
      availability: 'ready',
      entitlements: [],
      membership: null,
      entitlementJudgment: null,
    })
  })

  it('reports an unknown circle instead of guessing across scopes', () => {
    expect(selectMemberCircleDetail([], [], 'missing')).toEqual({
      availability: 'unknown_circle',
    })
  })
})

describe('selectRenewalHandoff', () => {
  const basePreview = {
    membershipId: '00000000-0000-4000-9200-000000000001',
    circleId: 'c-1',
    billingCycle: 'year' as const,
    periodKind: 'calendar_year' as const,
    priceMinor: 12800,
    currency: 'CNY',
    anchorAt: '2026-06-01T00:00:00.000Z',
    projectedPeriodStartAt: '2026-11-01T00:00:00.000Z',
    projectedPeriodEndAt: '2027-11-01T00:00:00.000Z',
    periodCapEndAt: '2027-11-01T00:00:00.000Z',
    canRenew: true,
    capReason: null,
  }

  it('hands off only the resolved (Admin-origin-vouched) URL', () => {
    const handoff = selectRenewalHandoff({
      purchaseUrl: '/c/share-1?renew=1',
      resolvedPurchaseUrl: 'https://admin.example.com/c/share-1?renew=1',
      purchaseUrlResolutionError: null,
      preview: basePreview,
    })
    expect(handoff).toMatchObject({
      state: 'ready',
      url: 'https://admin.example.com/c/share-1?renew=1',
    })
  })

  it('fails closed with an explicit reason when resolution failed', () => {
    const handoff = selectRenewalHandoff({
      purchaseUrl: 'https://evil.example.com/c/share-1?renew=1',
      resolvedPurchaseUrl: null,
      purchaseUrlResolutionError: 'untrusted_purchase_url_origin',
      preview: basePreview,
    })
    expect(handoff).toEqual({
      state: 'purchase_url_unresolved',
      reason: 'untrusted_purchase_url_origin',
      rawPurchaseUrl: 'https://evil.example.com/c/share-1?renew=1',
      preview: basePreview,
    })
  })

  it('keeps price availability orthogonal to the handoff', () => {
    expect(isRenewalPriceAvailable(basePreview)).toBe(true)
    expect(isRenewalPriceAvailable({ ...basePreview, priceMinor: null })).toBe(false)
    const nullPriceHandoff = selectRenewalHandoff({
      purchaseUrl: '/c/share-1?renew=1',
      resolvedPurchaseUrl: 'https://admin.example.com/c/share-1?renew=1',
      purchaseUrlResolutionError: null,
      preview: { ...basePreview, priceMinor: null },
    })
    // The recovery entry stays open even when the price is unavailable.
    expect(nullPriceHandoff).toMatchObject({ state: 'ready' })
  })
})

describe('selectLostCircleAuthorizationIds (POO-70 visual review R1 F2)', () => {
  it('marks lifecycle-restricted and projection-unpaid circles as lost', () => {
    const circles = [
      circleSnapshot('c-active'),
      circleSnapshot('c-left', { status: 'expired' }),
      circleSnapshot('c-suspended', { status: 'suspended' }),
    ]
    const memberships = [
      membership('c-active'),
      membership('c-left', { status: 'expired' }),
      // G5: a stored `paid` order with a refunded projection stays NOT paid.
      membership('c-refunded', {
        paymentOrders: [paymentOrder({
          storedStatus: 'paid',
          effectivePaymentStatus: 'refunded',
        })],
      }),
    ]
    // The refund-only circle appears in the circles receipt too.
    circles.push(circleSnapshot('c-refunded'))
    const lost = selectLostCircleAuthorizationIds(circles, memberships)
    expect(lost.has('c-active')).toBe(false)
    expect(lost.has('c-left')).toBe(true)
    expect(lost.has('c-suspended')).toBe(true)
    expect(lost.has('c-refunded')).toBe(true)
  })

  it('keeps an unjudged membership (no orders) OUT of the set — unknown is a fact', () => {
    const circles = [circleSnapshot('c-unjudged')]
    const memberships = [membership('c-unjudged', { paymentOrders: [] })]
    const lost = selectLostCircleAuthorizationIds(circles, memberships)
    expect(lost.size).toBe(0)
  })

  it('never judges a circle absent from the receipts', () => {
    expect(selectLostCircleAuthorizationIds([], []).size).toBe(0)
  })
})

describe('isMembershipEndedBeforePeriodEnd (POO-70 visual review R1 F3)', () => {
  const NOW = Date.parse('2026-10-05T00:00:00.000Z')

  it('reads an expired relation with a still-running period as ended early (leave)', () => {
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'expired',
      currentPeriodEnd: '2026-10-25T00:00:00.000Z',
    }, NOW)).toBe(true)
  })

  it('reads an expired relation with a passed period end as natural expiry', () => {
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'expired',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    }, NOW)).toBe(false)
  })

  it('is false for active/suspended relations and for absent/unparsable period ends', () => {
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'active',
      currentPeriodEnd: '2026-10-25T00:00:00.000Z',
    }, NOW)).toBe(false)
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'suspended',
      currentPeriodEnd: '2026-10-25T00:00:00.000Z',
    }, NOW)).toBe(false)
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'expired',
      currentPeriodEnd: null,
    }, NOW)).toBe(false)
    expect(isMembershipEndedBeforePeriodEnd({
      status: 'expired',
      currentPeriodEnd: 'not-a-date',
    }, NOW)).toBe(false)
  })
})
