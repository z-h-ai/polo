import { describe, expect, it } from 'bun:test'
import type { MemberCircleSnapshot } from '@polo-ai/shared/admin'
import { parseMemberMembershipsResponse } from '@polo-ai/shared/admin/member-circles'
import { currentEntitlementFixture, memberMembershipWireFixture, CURRENT_CIRCLE_ID, CURRENT_PERIOD_END } from '../../../../../../packages/shared/src/admin/__tests__/fixtures/current-entitlement'
import { isMembershipCurrentlyPaidEntitled, selectLostCircleAuthorizationIds } from '../member-circle-view'
import { deriveMembershipEntitlementState } from '../circle-return-target'

const now = Date.parse('2026-10-19T00:00:00.000Z')
const parsed = (overrides: Record<string, unknown> = {}) => parseMemberMembershipsResponse({ memberships: [memberMembershipWireFixture(overrides)] }).memberships[0]!
const paid = memberMembershipWireFixture().paymentOrders[0]!
const attempts = (count: number) => [...Array.from({ length: count }, (_, i) => ({ ...paid, id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`, status: 'cancelled', effectivePaymentStatus: 'cancelled' })), paid].slice(0, 5)

describe('R4FIX-02 current entitlement v1 through shared parser', () => {
  it('preserves the complete authority and opaque lineage, without requiring UUID ledger IDs', () => {
    const authority = currentEntitlementFixture({ corrections: [{ id: 'ledger-refund-1', orderId: 'bound-order', kind: 'refund', amountMinor: 1000, authorityEvidenceId: null }] })
    expect(parsed({ currentEntitlement: authority }).currentEntitlement).toEqual(authority)
  })
  for (const count of [0, 1, 4, 6]) {
    it(`current paid survives ${count} future cancelled attempts in a take:5 DTO`, () => {
      expect(isMembershipCurrentlyPaidEntitled(parsed({ paymentOrders: attempts(count) }), now)).toBe(true)
    })
  }
  it('pending ahead of paid retains the current term', () => {
    expect(isMembershipCurrentlyPaidEntitled(parsed({ paymentOrders: [{ ...paid, effectivePaymentStatus: 'pending' }, paid] }), now)).toBe(true)
  })
  it('expiry still denies even when the provider returned entitled and retained paid history', () => {
    expect(isMembershipCurrentlyPaidEntitled(parsed(), Date.parse(CURRENT_PERIOD_END))).toBe(false)
  })
  for (const state of ['not_entitled', 'unknown'] as const) {
    it(`${state} denies despite a future period and a recent paid order`, () => {
      const member = parsed({ currentEntitlement: currentEntitlementFixture({ state }) })
      expect(isMembershipCurrentlyPaidEntitled(member, now)).toBe(false)
      expect(deriveMembershipEntitlementState(member)).toBe('invalid')
      expect(selectLostCircleAuthorizationIds([{ membershipId: member.membershipId, status: member.status, billingKind: member.billingKind, currentPeriodEnd: member.currentPeriodEnd, modeTransitionEndsAt: null, joinedAt: member.joinedAt, joinSource: 'share_link', circle: { circleId: CURRENT_CIRCLE_ID, name: 'Current Circle', purpose: '', status: 'active', ownerUserId: 'owner' }, entitlements: [] } satisfies MemberCircleSnapshot], [member], now).has(CURRENT_CIRCLE_ID)).toBe(true)
    })
  }
  for (const kind of ['refund', 'chargeback'] as const) {
    for (const state of ['entitled', 'not_entitled'] as const) {
      it(`${kind} uses ${state} from retained current rights instead of guessing from corrections`, () => {
        const member = parsed({
          currentEntitlement: currentEntitlementFixture({ state, corrections: [{ id: `ledger-${kind}`, orderId: paid.id, kind, amountMinor: 1000, authorityEvidenceId: null }] }),
          paymentOrders: [{ ...paid, effectivePaymentStatus: kind === 'refund' ? 'refunded' : 'disputed' }],
        })
        expect(isMembershipCurrentlyPaidEntitled(member, now)).toBe(state === 'entitled')
      })
    }
  }
  it('an earlier validUntil is a local upper bound', () => {
    expect(isMembershipCurrentlyPaidEntitled(parsed({ currentEntitlement: currentEntitlementFixture({ validUntil: '2026-10-19T00:00:00.000Z' }) }), now)).toBe(false)
  })
  for (const state of ['entitled', 'not_entitled', 'unknown'] as const) {
    it(`free membership respects ${state} and its transition upper bound`, () => {
      const authority = currentEntitlementFixture({ state, currentPeriodEnd: null, validUntil: null, source: { ...currentEntitlementFixture().source, billingKind: 'free', orderId: null } })
      const member = parsed({ billingKind: 'free', currentPeriodEnd: null, currentEntitlement: authority, paymentOrders: [] })
      expect(isMembershipCurrentlyPaidEntitled(member, now)).toBe(state === 'entitled')
      expect(isMembershipCurrentlyPaidEntitled({ ...member, currentEntitlement: { ...authority, validUntil: new Date(now).toISOString() } }, now)).toBe(false)
    })
  }
  it('omitted currentEntitlement retains legacy conservative behavior and absence', () => {
    const wire = memberMembershipWireFixture()
    delete (wire as Record<string, unknown>).currentEntitlement
    const legacy = parseMemberMembershipsResponse({ memberships: [wire] }).memberships[0]!
    expect('currentEntitlement' in legacy).toBe(false)
    expect(isMembershipCurrentlyPaidEntitled(legacy, now)).toBe(true)
    expect(isMembershipCurrentlyPaidEntitled({ ...legacy, paymentOrders: legacy.paymentOrders.map(o => ({ ...o, effectivePaymentStatus: 'cancelled' })) }, now)).toBe(false)
  })
  for (const bad of [null, { version: 2 }, { state: 'future_state' }, { source: null }, { membershipId: 'other-member' }, { currentPeriodEnd: '2098-01-01T00:00:00.000Z' }, { computedAt: 'bad-time' }]) {
    it(`rejects unsupported, malformed or mismatched authority: ${JSON.stringify(bad)}`, () => {
      expect(() => parsed({ currentEntitlement: bad === null ? null : { ...currentEntitlementFixture(), ...bad } })).toThrow()
    })
  }
})
