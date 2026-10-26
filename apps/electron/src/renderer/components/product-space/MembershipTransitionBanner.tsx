import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchFocusClassName,
} from '@/components/ui/client-workbench'
import {
  deriveMembershipTransition,
  type MembershipTransitionAudience,
} from '@/lib/membership-transition'

/**
 * POO-142 membership transition (POL-272 split card): the ONE workbench-level
 * "not joined yet" banner. A normal, non-error info strip — one line of copy
 * plus a manual 刷新状态 button, no modal, no navigation, no auto-polling.
 *
 * Mounted ONCE inside TabContent, above every tab surface and inside the
 * SAME shared MemberCircleResourceProvider the home pages read, so the
 * derivation below never creates a second relations read surface.
 *
 * Self-healing contract: the account's silent pulls (login/startup bootstrap
 * for ProductSpaces, the shared relations read for circles) are the existing
 * channels — the button only re-runs them. Once the authoritative facts show
 * a membership (any enterprise role/access mode, or any circle relations
 * receipt), the banner disappears without a reinstall or re-login.
 *
 * "Unknown is not empty": an unverified (cached/offline) ProductSpace list or
 * a missing relations receipt renders NOTHING — a failed first read never
 * becomes a "not joined" claim, and an already proven "empty" survives a
 * failed refresh (the shared resource keeps its receipts; the button stays
 * retryable).
 */
export function MembershipTransitionBanner({
  audience = 'enterprise',
}: {
  /**
   * Which membership the copy names. The default enterprise copy is the only
   * reachable variant today: the client has no cross-install circle-invite
   * source channel, and per the adjudicated scope ANY existing affiliation
   * (circle membership included) hides the banner.
   */
  audience?: MembershipTransitionAudience
}) {
  const { t } = useTranslation()
  // Optional read: isolated TabShell mounts (tests, minimal hosts) have no
  // ProductSpace context — nothing verifiable to say, render nothing.
  const productSpace = useOptionalProductSpaceContext()
  const circles = useMemberCircles()
  const allProductSpaces = productSpace?.allProductSpaces ?? null
  const membershipListVerified = productSpace?.membershipListVerified ?? false
  const onRefreshProductSpaces = productSpace?.onRefreshProductSpaces
  const pendingSwitch = productSpace?.pendingSwitch ?? null

  // Single-flight for THIS mounted banner instance only: the keyed shell
  // remount on an account/ProductSpace scope change drops the lock with the
  // instance, so a released lock can never belong to a newer scope's request.
  const inFlightRef = useRef(false)
  const [refreshingSpaces, setRefreshingSpaces] = useState(false)

  const state = useMemo(() => deriveMembershipTransition({
    membershipListVerified,
    allProductSpaces,
    circles: circles.state.circles,
    memberships: circles.state.memberships,
    circleReadDenied: circles.state.phase === 'denied',
    audience,
  }), [membershipListVerified, allProductSpaces, circles.state, audience])

  const handleRefresh = useCallback(() => {
    if (inFlightRef.current || !onRefreshProductSpaces) return
    inFlightRef.current = true
    setRefreshingSpaces(true)
    // One manual refresh re-reads BOTH membership channels in parallel
    // through their existing transactions. Failures resolve to null / a
    // failed outcome and keep the previous facts — never an empty list.
    void Promise.all([
      Promise.resolve(onRefreshProductSpaces()).catch(() => null),
      circles.refresh().catch(() => null),
    ]).finally(() => {
      inFlightRef.current = false
      setRefreshingSpaces(false)
    })
  }, [onRefreshProductSpaces, circles])

  // A pending switch owns the screen through its own dialog; the banner never
  // offers a competing action there.
  if (!onRefreshProductSpaces || state.status !== 'unaffiliated' || pendingSwitch !== null) {
    return null
  }

  const busy = refreshingSpaces || circles.state.refreshing

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="membership-transition-banner"
      className={
        clientWorkbenchFocusClassName
        + ' flex shrink-0 items-center justify-between gap-[12px] border-b border-border bg-foreground-5 px-[16px] py-[6px]'
      }
    >
      <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-foreground-80">
        {/* Static branches keep both message keys visible to the i18n
        coverage scan (no dynamic key concatenation). */}
        {state.audience === 'circle'
          ? t('membershipTransition.circle.message')
          : t('membershipTransition.enterprise.message')}
      </p>
      <button
        type="button"
        data-testid="membership-transition-refresh"
        onClick={handleRefresh}
        disabled={busy}
        aria-busy={busy}
        className={clientWorkbenchButtonClassName + ' h-[24px] min-h-[24px] shrink-0 px-[10px] text-[12px]'}
      >
        {busy ? t('membershipTransition.refreshing') : t('membershipTransition.refresh')}
      </button>
    </div>
  )
}
