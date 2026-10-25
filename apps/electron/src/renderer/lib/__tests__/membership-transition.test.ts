import { describe, expect, it } from 'bun:test'
import { deriveMembershipTransition } from '../membership-transition'

const personal = { kind: 'personal' }
const enterprise = { kind: 'enterprise' }
const readOnlyEnterprise = { kind: 'enterprise' }

function facts(overrides: Partial<Parameters<typeof deriveMembershipTransition>[0]> = {}) {
  return {
    membershipListVerified: true,
    allProductSpaces: [personal],
    circles: [] as never[],
    memberships: [] as never[],
    circleReadDenied: false,
    audience: 'enterprise' as const,
    ...overrides,
  }
}

describe('deriveMembershipTransition', () => {
  it('never claims "no membership" from an unverified (cached/offline) space list', () => {
    for (const membershipListVerified of [false]) {
      const state = deriveMembershipTransition(facts({
        membershipListVerified,
        circles: [{ id: 'c1' } as never],
      }))
      expect(state).toEqual({ status: 'unknown', reason: 'spaces_unverified' })
    }
  })

  it('is unknown outside an account context', () => {
    expect(deriveMembershipTransition(facts({ allProductSpaces: null })))
      .toEqual({ status: 'unknown', reason: 'spaces_unverified' })
  })

  it('hides for any enterprise membership regardless of role or access mode', () => {
    expect(deriveMembershipTransition(facts({ allProductSpaces: [personal, enterprise] })))
      .toEqual({ status: 'affiliated' })
    expect(deriveMembershipTransition(facts({
      allProductSpaces: [personal, readOnlyEnterprise],
      circleReadDenied: true,
      circles: null,
      memberships: null,
    }))).toEqual({ status: 'affiliated' })
  })

  it('treats the ever-present personal space alone as NO membership', () => {
    expect(deriveMembershipTransition(facts()))
      .toEqual({ status: 'unaffiliated', audience: 'enterprise' })
  })

  it('hides for circles-only accounts (CL-TR-05 / plan D1 option A: any positive receipt wins over an empty twin)', () => {
    expect(deriveMembershipTransition(facts({ memberships: [{ id: 'm1' } as never] })))
      .toEqual({ status: 'affiliated' })
    expect(deriveMembershipTransition(facts({ circles: [{ id: 'c1' } as never] })))
      .toEqual({ status: 'affiliated' })
  })

  it('stays unknown until BOTH relations receipts exist, and after a denied circle read', () => {
    expect(deriveMembershipTransition(facts({ circles: null, memberships: null })))
      .toEqual({ status: 'unknown', reason: 'circles_unread' })
    expect(deriveMembershipTransition(facts({ memberships: null })))
      .toEqual({ status: 'unknown', reason: 'circles_unread' })
    expect(deriveMembershipTransition(facts({ circles: null })))
      .toEqual({ status: 'unknown', reason: 'circles_unread' })
    // Denied without an enterprise list is an unresolvable scope, not "empty".
    expect(deriveMembershipTransition(facts({ circleReadDenied: true, circles: null, memberships: null })))
      .toEqual({ status: 'unknown', reason: 'circles_denied' })
  })

  it('keeps an already proven "no membership" when a later refresh fails in scope', () => {
    // The shared resource keeps the previous receipts on a failed refresh, so
    // the banner survives instead of flickering away on a network error.
    expect(deriveMembershipTransition(facts())).toEqual({ status: 'unaffiliated', audience: 'enterprise' })
  })

  it('selects the parameterized copy audience', () => {
    expect(deriveMembershipTransition(facts({ audience: 'circle' })))
      .toEqual({ status: 'unaffiliated', audience: 'circle' })
    expect(deriveMembershipTransition(facts({ audience: 'enterprise' })))
      .toEqual({ status: 'unaffiliated', audience: 'enterprise' })
  })
})
