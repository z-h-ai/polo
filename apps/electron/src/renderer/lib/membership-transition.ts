import type { MemberCircleSnapshot, MemberMembership } from '@polo-ai/shared/admin'

/**
 * POO-142 membership transition (POL-272 split card): the pure truth table
 * behind the workbench "not joined yet" banner. Relation judgment and copy
 * selection are separated here so no component can turn an unknown or a
 * cached read into a "no membership" claim — the banner is display-only and
 * never grants or revokes anything.
 */

/** Which membership the unaffiliated copy names. */
export type MembershipTransitionAudience = 'enterprise' | 'circle'

export type MembershipTransitionStatus = 'unknown' | 'affiliated' | 'unaffiliated'

export type MembershipTransitionState =
  | { status: 'unknown'; reason: 'spaces_unverified' | 'circles_unread' | 'circles_denied' }
  | { status: 'affiliated' }
  | { status: 'unaffiliated'; audience: MembershipTransitionAudience }

export interface MembershipTransitionFacts {
  /**
   * True only when THIS account scope's ProductSpace list was published from
   * an authoritative ONLINE read. An offline/cached restore never sets it, so
   * a snapshot can never stand for "no enterprise".
   */
  membershipListVerified: boolean
  /**
   * The COMPLETE authoritative ProductSpace list (allProductSpaces — owner,
   * manager, member, read_only and temporarily unavailable spaces included),
   * or null outside an account context.
   */
  allProductSpaces: ReadonlyArray<{ kind: string }> | null
  /** Authoritative circles receipt; null = this scope has no circles fact yet. */
  circles: ReadonlyArray<MemberCircleSnapshot> | null
  /** Authoritative memberships receipt; null = this scope has no membership fact yet. */
  memberships: ReadonlyArray<MemberMembership> | null
  /** The active space is an enterprise space: the contract denies circle reads there. */
  circleReadDenied: boolean
  /** Which membership the unaffiliated copy names. */
  audience: MembershipTransitionAudience
}

/**
 * Derive the banner state from one account scope's authoritative facts.
 *
 * - The personal space is always present and never proves a membership.
 * - Any enterprise space (any role, `read_only` included) hides the banner —
 *   the copy must not mask a real restriction reason.
 * - Any positive relations receipt hides it too: a circles-only account has a
 *   membership, and a suspended/expired row is still "joined", not "never".
 * - Both receipts PRESENT and both empty is the only proof of "no membership".
 *   A null receipt (never read, failed before its first success) is unknown —
 *   a later failed refresh keeps the previous receipts in place, so an already
 *   proven "empty" survives refresh failures while a never-proven scope does
 *   not invent one.
 */
export function deriveMembershipTransition(
  facts: MembershipTransitionFacts,
): MembershipTransitionState {
  if (!facts.membershipListVerified || facts.allProductSpaces === null) {
    return { status: 'unknown', reason: 'spaces_unverified' }
  }
  if (facts.allProductSpaces.some(space => space.kind === 'enterprise')) {
    return { status: 'affiliated' }
  }
  if (facts.circleReadDenied) {
    return { status: 'unknown', reason: 'circles_denied' }
  }
  if (
    (facts.circles !== null && facts.circles.length > 0)
    || (facts.memberships !== null && facts.memberships.length > 0)
  ) {
    return { status: 'affiliated' }
  }
  if (facts.circles !== null && facts.memberships !== null) {
    return { status: 'unaffiliated', audience: facts.audience }
  }
  return { status: 'unknown', reason: 'circles_unread' }
}
