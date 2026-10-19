import { useEffect, useState } from 'react'
import type { MemberCircleCurrentEntitlement } from '@polo-ai/shared/admin'

interface MembershipPeriod {
  status: string
  billingKind: string
  currentPeriodEnd: string | null
  currentEntitlement?: Pick<MemberCircleCurrentEntitlement, 'version' | 'state' | 'validUntil'>
}

/** Local display clock only: expiry never grants execution or sends a request. */
export function useMemberCircleClock(periods: ReadonlyArray<MembershipPeriod>): number {
  const key = JSON.stringify(periods.map(period => [period.status, period.billingKind, period.currentPeriodEnd, period.currentEntitlement?.version, period.currentEntitlement?.state, period.currentEntitlement?.validUntil]))
  const [snapshot, setSnapshot] = useState(() => ({ key, now: Date.now() }))
  let clock = snapshot
  if (clock.key !== key) {
    clock = { key, now: Date.now() }
    setSnapshot(clock)
  }
  const nextExpiry = periods.reduce((next, period) => {
    if (period.status !== 'active') return next
    const bounds = [period.billingKind === 'paid' ? period.currentPeriodEnd : null, period.currentEntitlement?.validUntil]
    return bounds.reduce((nearest, bound) => {
      const end = Date.parse(bound ?? '')
      return Number.isFinite(end) && end > clock.now ? Math.min(nearest, end) : nearest
    }, next)
  }, Infinity)

  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return
    // Long memberships exceed the platform timeout limit; wake and reschedule.
    const delay = Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_483_647)
    const timer = setTimeout(() => {
      setSnapshot(current => current.key === key ? { key, now: Date.now() } : current)
    }, delay)
    return () => clearTimeout(timer)
  }, [key, nextExpiry, clock.now])

  return clock.now
}
