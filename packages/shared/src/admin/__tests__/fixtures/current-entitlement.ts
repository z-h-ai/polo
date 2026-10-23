import type { MemberCircleCurrentEntitlement } from '../../member-circles'

export const CURRENT_MEMBERSHIP_ID = '11111111-1111-4111-8111-111111111111'
export const CURRENT_CIRCLE_ID = '22222222-2222-4222-8222-222222222222'
export const CURRENT_ORDER_ID = '33333333-3333-4333-8333-333333333333'
export const CURRENT_PERIOD_END = '2099-11-19T00:00:00.000Z'

/** Wire fixture follows shared-contract.md v1; lineage IDs are opaque strings. */
export function currentEntitlementFixture(overrides: Partial<MemberCircleCurrentEntitlement> = {}): MemberCircleCurrentEntitlement {
  return {
    version: 1, membershipId: CURRENT_MEMBERSHIP_ID, state: 'entitled',
    computedAt: '2026-10-19T00:00:00.000Z', currentPeriodEnd: CURRENT_PERIOD_END, validUntil: CURRENT_PERIOD_END,
    source: { billingKind: 'paid', membershipGeneration: 2, entitlementEventId: 'event-current', orderId: CURRENT_ORDER_ID, authorityEvidenceId: 'evidence-current' },
    corrections: [], ...overrides,
  }
}

export function memberMembershipWireFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: CURRENT_MEMBERSHIP_ID, status: 'active', billingKind: 'paid', modeTransitionEndsAt: null,
    currentPeriodEnd: CURRENT_PERIOD_END, suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    currentEntitlement: currentEntitlementFixture(),
    paymentOrders: [{ id: CURRENT_ORDER_ID, status: 'paid', amountMinor: 29900, currency: 'CNY', effectivePaymentStatus: 'paid', correction: null }],
    circle: { id: CURRENT_CIRCLE_ID, name: 'R4 Current Circle', purpose: '', status: 'active', joinMode: 'paid', membershipPriceMinor: 29900, membershipCurrency: 'CNY', nextPeriodPriceMinor: null, nextPriceEffectiveAt: null },
    ...overrides,
  }
}
