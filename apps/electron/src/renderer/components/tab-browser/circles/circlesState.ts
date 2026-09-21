/**
 * Circle subscription & source state machine (pure functions, POO-70 M07).
 *
 * Rules encoded here (review.md §3 M07):
 * - Renewal starts from the current expiry date while active; after expiry a
 *   repurchase takes effect immediately (PC-F03).
 * - Prepaid time is capped at 12 months ahead of the renewal base date.
 * - Leaving a circle only revokes that circle's sources: a work stays usable
 *   while any other source is still valid (D-PC-09).
 */

import type {
  CircleMembershipState,
  CircleSourcedApp,
  CircleSummary,
  CircleWorkAvailability,
  CircleWorkRow,
  CircleWorksInput,
} from './types'

/** Max prepaid months ahead of the renewal base date (manual renewal only). */
export const MAX_PREPAID_MONTHS = 12

/** Parses an ISO date (yyyy-MM-dd) into a UTC-noon-safe timestamp. */
function toTimestamp(isoDate: string): number {
  const time = Date.parse(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(time)) throw new Error(`invalid ISO date: ${isoDate}`)
  return time
}

function toIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

/** Adds whole months, clamping the day to the target month's length. */
export function addMonths(isoDate: string, months: number): string {
  const date = new Date(toTimestamp(isoDate))
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const daysInMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate()
  date.setUTCDate(Math.min(day, daysInMonth))
  return toIsoDate(date.getTime())
}

/** Membership state of a paid circle at `now` (free circles stay 'active'). */
export function membershipState(
  circle: Pick<CircleSummary, 'membership' | 'subscription'>,
  now: string,
): CircleMembershipState {
  if (circle.membership !== 'active') return circle.membership
  if (!circle.subscription) return 'active'
  return toTimestamp(circle.subscription.expiresAt) >= toTimestamp(now)
    ? 'active'
    : 'expired'
}

/**
 * The date a renewal starts counting from: the current expiry while still
 * active, otherwise today (repurchase takes effect immediately, PC-F03).
 */
export function renewalBaseDate(
  subscription: { expiresAt: string },
  now: string,
): string {
  return toTimestamp(subscription.expiresAt) >= toTimestamp(now)
    ? subscription.expiresAt
    : now
}

/** The furthest expiry prepaid time may reach (base + 12 months). */
export function maxPrepaidExpiry(baseDate: string): string {
  return addMonths(baseDate, MAX_PREPAID_MONTHS)
}

export interface RenewalOutcome {
  /** Renewed expiry (from the base date, capped at 12 months prepaid). */
  expiresAt: string
  /** True when the requested duration was clipped by the 12-month cap. */
  capped: boolean
}

/** Applies a manual renewal of `months` months starting at the base date. */
export function applyRenewal(
  baseDate: string,
  months: number,
): RenewalOutcome {
  const requested = addMonths(baseDate, months)
  const cap = maxPrepaidExpiry(baseDate)
  return requested > cap
    ? { expiresAt: cap, capped: true }
    : { expiresAt: requested, capped: false }
}

/** Marks every source of `circleId` as invalid (leave / expiry). */
export function revokeCircleSources(
  apps: CircleSourcedApp[],
  circleId: string,
): CircleSourcedApp[] {
  return apps.map(app => ({
    ...app,
    sources: app.sources.map(source =>
      source.circleId === circleId ? { ...source, valid: false } : source,
    ),
  }))
}

/** A work stays usable while at least one source is still valid (D-PC-09). */
export function isAppUsable(app: CircleSourcedApp): boolean {
  return app.sources.some(source => source.valid)
}

function rowAvailability(
  sourceValid: boolean,
  anyValidSource: boolean,
  kind: 'app' | 'skill',
  installed: boolean,
): CircleWorkAvailability {
  if (sourceValid) return kind === 'app' || installed ? 'usable' : 'installable'
  return anyValidSource ? 'stillAuthorized' : kind === 'skill' ? 'installable' : 'unavailable'
}

/** Presentation details the sourced-apps contract does not carry. */
export interface CircleWorkDetails {
  description?: string
  /** Version label of this circle's copy, e.g. "v1.4.0". */
  version?: string
}

/**
 * Builds the detail-page work rows for one circle from the deduped
 * sourced-apps data: one row per app/skill with this circle's source line,
 * including the source-fallback presentation for shared works.
 */
export function buildCircleWorkRows(
  input: CircleWorksInput,
  details: Record<string, CircleWorkDetails> = {},
): CircleWorkRow[] {
  const { circle, apps, skills, installedSkillIds = [] } = input
  const build = (works: CircleSourcedApp[], kind: 'app' | 'skill'): CircleWorkRow[] => {
    const rows: CircleWorkRow[] = []
    for (const work of works) {
      const source = work.sources.find(item => item.circleId === circle.id)
      if (!source) continue
      const anyValidSource = isAppUsable(work)
      const installed = installedSkillIds.includes(work.appId)
      const otherValid = work.sources.find(
        item => item.circleId !== circle.id && item.valid,
      )
      rows.push({
        id: work.appId,
        kind,
        name: work.name,
        description: details[work.appId]?.description,
        version: details[work.appId]?.version,
        source,
        sourceNames:
          work.sources.length > 1
            ? work.sources.map(item => item.circleName)
            : undefined,
        fallbackNote: !source.valid
          ? otherValid
            ? { kind: 'other-source', circleName: otherValid.circleName }
            : kind === 'skill'
              ? { kind: 'install-note' }
              : undefined
          : kind === 'skill' && !installed
            ? { kind: 'install-note' }
            : undefined,
        availability: rowAvailability(source.valid, anyValidSource, kind, installed),
      })
    }
    return rows
  }
  return [...build(apps, 'app'), ...build(skills, 'skill')]
}
