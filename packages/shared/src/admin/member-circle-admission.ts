import type { MemberMembership } from './member-circles.ts'
import type { AdminClient } from './client.ts'
import { i18n, translateRegistryMessage } from '../i18n/index.ts'

type CurrentMembership = Pick<MemberMembership,
  'membershipId' | 'status' | 'billingKind' | 'currentPeriodEnd' | 'currentEntitlement'>

/** Bound v1 authority only. Recent payment history never grants execution. */
export function isCurrentMembershipAuthorityEntitled(membership: CurrentMembership, now = Date.now()): boolean {
  const authority = membership.currentEntitlement
  if (membership.status !== 'active' || !authority || authority.version !== 1
    || authority.state !== 'entitled' || authority.membershipId !== membership.membershipId
    || authority.source?.billingKind !== membership.billingKind
    || !Number.isFinite(Date.parse(authority.computedAt))) return false
  const periodMatches = authority.currentPeriodEnd === null
    ? membership.currentPeriodEnd === null
    : membership.currentPeriodEnd !== null
      && Date.parse(authority.currentPeriodEnd) === Date.parse(membership.currentPeriodEnd)
  if (!periodMatches) return false
  if (authority.validUntil !== null) {
    const until = Date.parse(authority.validUntil)
    if (!Number.isFinite(until) || until <= now) return false
  }
  if (membership.billingKind === 'paid') {
    const periodEnd = Date.parse(membership.currentPeriodEnd ?? '')
    if (!Number.isFinite(periodEnd) || periodEnd <= now) return false
  }
  return true
}

export class MemberCircleAdmissionError extends Error {
  readonly code = 'CIRCLE_ENTITLEMENT_REQUIRED'
  readonly errorCode = this.code
  readonly details: { reason: 'unknown' | 'not_entitled' | 'expired'; recovery: 'refresh_membership' }
  constructor(reason: 'unknown' | 'not_entitled' | 'expired') {
    super(translateRegistryMessage(i18n.resolvedLanguage ?? i18n.language, 'homeApps.errors.circleEntitlementRequired'))
    this.name = 'MemberCircleAdmissionError'
    this.details = { reason, recovery: 'refresh_membership' }
  }
}

type AppSourceEntry = {
  kind: string
  sources?: ReadonlyArray<{ kind: string; circleId?: string }>
}

/**
 * Read through Main's authenticated Admin client, independently of member RPC
 * UI scope. Only sources of this exact fresh Catalog entry participate. A paid
 * source needs explicit entitled authority; there is no migration exception.
 * The returned pure guard rechecks local deadlines after subsequent awaits.
 */
export async function requireMemberCircleAppAdmission(
  client: Pick<AdminClient, 'listMemberCircleMemberships'>,
  accessToken: string,
  entry: AppSourceEntry | undefined,
): Promise<() => void> {
  if (entry?.kind !== 'app') return () => {}
  const circleIds = new Set(entry.sources?.filter(source => source.kind === 'creator_circle').map(source => source.circleId))
  if (!circleIds.size) return () => {}
  const { memberships } = await client.listMemberCircleMemberships(accessToken)
  const candidates = memberships.filter(membership => circleIds.has(membership.circle.circleId))
  const assertCurrent = () => {
    const now = Date.now()
    if (candidates.some(membership => membership.status === 'active' && (
      // Free membership remains governed by its active state; when v1 is
      // supplied its denial/deadline still wins. Paid never falls back.
      membership.billingKind === 'free' && membership.currentEntitlement === undefined
        || isCurrentMembershipAuthorityEntitled(membership, now)
    ))) return
    const unknown = candidates.length === 0 || candidates.some(membership =>
      !membership.currentEntitlement || membership.currentEntitlement.state === 'unknown')
    const expired = candidates.some(membership => membership.currentEntitlement?.state === 'entitled'
      && ((membership.currentPeriodEnd !== null && Date.parse(membership.currentPeriodEnd) <= now)
        || (membership.currentEntitlement.validUntil !== null && Date.parse(membership.currentEntitlement.validUntil) <= now)))
    throw new MemberCircleAdmissionError(unknown ? 'unknown' : expired ? 'expired' : 'not_entitled')
  }
  assertCurrent()
  return assertCurrent
}
