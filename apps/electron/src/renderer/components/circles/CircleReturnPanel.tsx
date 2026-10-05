import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { useOptionalClientPage } from '@/context/ClientPageContext'
import {
  deriveCircleReturnRoute,
  type CircleReturnEntitlementState,
} from '@/lib/circle-return-target'
import type { CircleReturnState } from '@/hooks/useCircleReturn'

/**
 * Circle return panel (POO-70 C8 / P70-RETURN-01/02).
 *
 * The proactive verification surface shown when a web join/payment returns
 * the user to the desktop (prototype scenes P-M07-RETURN / -RETURN-FAIL /
 * -ACCOUNT-MISMATCH / -PAY-RETURN / -YEAR-RETURN / -RENEW-RETURN). It is a
 * PURE PROJECTION of the `useCircleReturn` hook state:
 *
 * - Every fact arrives via props; the panel issues no read of its own and
 *   holds no cache — a previous scope's receipt cannot bleed through.
 * - Verification is USER-CLICKED (每次点击仅一轮权威读取 lives in the hook):
 *   nothing runs automatically on mount, and no failure auto-loops.
 * - Read-only surface: NO join, NO payment, NO open-app, NO enable-skill and
 *   NO skill-management affordance exists in any state. The only navigations
 *   are back to the 我的圈子 page and to the located ORIGINAL object (circle
 *   detail / its subscription section, via the N1 ClientPageContext — a
 *   recorded no-op when mounted without the provider, never a fake exit).
 * - The account-mismatch state renders the permission fact INSTEAD of any
 *   order content (C1 fail-closed; F1 same-shape 404) — nothing about an
 *   object this account cannot see is disclosed, and recovery is the
 *   existing A1 auth chain via `onReauthenticate` (C9 wiring).
 * - The original order block shows the located ORIGINAL order only (F1
 *   GET me/circle-payment-orders/{orderId}): its stored status is labelled
 *   display history and never an entitlement (G5); entitlement validity is
 *   the hook's joint verdict.
 *
 * Layout is a derived composition over the confirmed workbench tokens
 * (banner pattern, fact rows, hairline sections) consistent with the C3/C5
 * surfaces. The full-page combination is still pending design re-review —
 * no parity claim is made.
 */

export interface CircleReturnPanelProps {
  /** Live hook state (useCircleReturn). */
  state: CircleReturnState
  /** ONE authoritative verification round (hook.checkOnce). */
  onCheck: () => void
  /**
   * Existing A1 auth-chain entry (hook.reauthenticate; C9 wires the target).
   * OPTIONAL (P2-2, POO-100 review): unset means NO re-login entry is wired
   * in this mount — the mismatch CTA does NOT render (never a dead button)
   * and an honest manual-recovery note renders instead.
   */
  onReauthenticate?: () => void
  /** Decline the candidate: hook.cancel + navigate back to circles. */
  onCancel: () => void
  /** Display-only: the target circle's confirmed name when already known. */
  targetCircleName?: string | null
  /** Display-only: the active personal space display name. */
  spaceName?: string | null
}

function EntitlementValue({ entitlement }: { entitlement: CircleReturnEntitlementState | null }) {
  const { t } = useTranslation()
  const key = entitlement === 'valid'
    ? 'poo70.c8.entitlement.valid'
    : entitlement === 'invalid'
      ? 'poo70.c8.entitlement.invalid'
      : entitlement === 'unknown'
        ? 'poo70.c8.entitlement.unknown'
        : 'poo70.c8.entitlement.pending'
  return (
    <dd
      className="m-0 font-medium text-foreground"
      data-testid="circle-return-fact-entitlement-value"
    >
      {t(key)}
    </dd>
  )
}

function FactRow({
  label,
  testId,
  children,
}: {
  label: string
  testId: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[minmax(84px,auto)_1fr] gap-[12px] py-[8px] text-[13px]" data-testid={testId}>
      <dt className="m-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 break-all font-medium text-foreground">{children}</dd>
    </div>
  )
}

const SECONDARY_BUTTON_CLASS = 'inline-flex min-h-[34px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[14px] text-[13px] font-medium text-foreground hover:bg-foreground-5 disabled:opacity-50'
const PRIMARY_BUTTON_CLASS = 'inline-flex min-h-[34px] items-center justify-center rounded-[8px] bg-foreground px-[14px] text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50'

export function CircleReturnPanel({
  state,
  onCheck,
  onReauthenticate,
  onCancel,
  targetCircleName,
  spaceName,
}: CircleReturnPanelProps) {
  const { t } = useTranslation()
  const clientPage = useOptionalClientPage()

  const isOrder = state.kind === 'order'
  const target: CircleReturnTargetIds | null = state.target

  // 回原对象: the located ORIGINAL object's route (its circle detail, or the
  // subscription section for an order). Without the N1 provider the click is
  // a recorded no-op — never a fake navigation (MyCirclesPage pattern).
  const returnRoute = deriveCircleReturnRoute({
    target,
    order: state.orderFacts?.order ?? null,
    checkout: state.orderFacts?.checkout ?? null,
  })

  const handleBackToCircles = useCallback(() => {
    onCancel()
    clientPage?.navigate({ kind: 'circles' })
  }, [onCancel, clientPage])

  const handleOpenOriginal = useCallback(() => {
    if (!returnRoute) return
    // P2-1 (POO-100 review): release the flow state BEFORE navigating. When
    // the target route equals the CURRENT route the N1 navigate is a no-op —
    // without the release the verified takeover would never end and this CTA
    // would give no feedback. cancel() on an already-acked candidate is an
    // idempotent `not_found` (bridge contract) and resets the local state to
    // idle; a different-circle target remounts fresh and consumes nothing.
    onCancel()
    clientPage?.navigate(returnRoute)
  }, [onCancel, clientPage, returnRoute])

  if (state.phase === 'idle' || !target || !state.kind) {
    // No surfaced candidate — render nothing; C9 mounts the panel
    // unconditionally and this keeps empty app state quiet.
    return null
  }

  const title = isOrder
    ? t('poo70.c8.order.title')
    : t('poo70.c8.circle.title')
  const subtitle = isOrder
    ? t('poo70.c8.order.subtitle')
    : t('poo70.c8.circle.subtitle')
  const checkLabel = isOrder
    ? t('poo70.c8.action.checkOrder')
    : t('poo70.c8.action.checkCircle')
  const targetLabel = targetCircleName?.trim()
    ? targetCircleName
    : (target.circleId ?? '')

  return (
    <section
      className="mx-auto w-full max-w-[720px]"
      data-testid="circle-return-panel"
      data-return-kind={state.kind}
      data-return-phase={state.phase}
    >
      <p className="m-0 text-[12px] font-medium uppercase tracking-[0.04em] text-foreground-50">
        {t('poo70.c8.eyebrow')}
      </p>
      <h1
        className="m-0 mt-[6px] text-[26px] font-bold leading-[1.15] tracking-[-0.04em] text-foreground"
        data-testid="circle-return-title"
      >
        {state.phase === 'failed'
          ? t('poo70.c8.fail.title')
          : state.phase === 'account-mismatch'
            ? t('poo70.c8.mismatch.title')
            : title}
      </h1>
      <p
        className="m-0 mt-[10px] text-[14px] leading-[1.65] text-muted-foreground"
        data-testid="circle-return-subtitle"
      >
        {state.phase === 'failed'
          ? t('poo70.c8.fail.subtitle')
          : state.phase === 'account-mismatch'
            ? t('poo70.c8.mismatch.subtitle')
            : subtitle}
      </p>

      {/* Fact block: the ORIGINAL object ids and the live entitlement fact.
      The mismatch state renders none of them (no disclosure). */}
      {state.phase !== 'account-mismatch' && (
        <dl
          className="m-0 mt-[18px] rounded-[13px] border border-border bg-surface px-[16px] py-[6px]"
          data-testid="circle-return-facts"
        >
          {isOrder && target.orderId && (
            <FactRow label={t('poo70.c8.fact.orderId')} testId="circle-return-fact-order-id">
              {state.orderFacts?.order.orderId ?? target.orderId}
            </FactRow>
          )}
          {!isOrder && (
            <FactRow label={t('poo70.c8.fact.targetCircle')} testId="circle-return-fact-target">
              {state.phase === 'verified' && state.orderFacts
                ? state.orderFacts.order.circle.name
                : targetLabel}
            </FactRow>
          )}
          {isOrder && state.orderFacts && (
            <FactRow label={t('poo70.c8.fact.orderCircle')} testId="circle-return-fact-order-circle">
              {state.orderFacts.order.circle.name}
            </FactRow>
          )}
          {spaceName?.trim() && (
            <FactRow label={t('poo70.c8.fact.currentSpace')} testId="circle-return-fact-space">
              {spaceName}
            </FactRow>
          )}
          {state.phase === 'candidate' && !isOrder && (
            <FactRow label={t('poo70.c8.fact.entitlementState')} testId="circle-return-fact-entitlement">
              {t('poo70.c8.entitlement.pending')}
            </FactRow>
          )}
          {state.phase === 'candidate' && isOrder && (
            <FactRow label={t('poo70.c8.fact.nextStep')} testId="circle-return-fact-next-step">
              {t('poo70.c8.fact.nextStepValue')}
            </FactRow>
          )}
          {(state.phase === 'verified' || state.phase === 'checking') && (
            <FactRow label={t('poo70.c8.fact.entitlementState')} testId="circle-return-fact-entitlement">
              <EntitlementValue entitlement={state.phase === 'checking' ? null : state.entitlement} />
            </FactRow>
          )}
        </dl>
      )}

      {/* Located ORIGINAL order block (only after a round located it).
      storedStatus renders as labelled display history — never an
      entitlement judgment (G5). */}
      {state.phase === 'verified' && state.orderFacts && (
        <dl
          className="m-0 mt-[12px] rounded-[13px] border border-border bg-surface px-[16px] py-[6px]"
          data-testid="circle-return-order"
        >
          <FactRow label={t('poo70.c8.order.storedStatus')} testId="circle-return-order-status">
            {state.orderFacts.order.storedStatus}
            <span className="ml-[6px] font-normal text-muted-foreground">
              {t('poo70.c8.order.storedStatusNote')}
            </span>
          </FactRow>
          <FactRow label={t('poo70.c8.order.amount')} testId="circle-return-order-amount">
            {state.orderFacts.order.amountMinor} {state.orderFacts.order.currency}
          </FactRow>
          {state.orderFacts.checkoutUnknown && (
            <div
              className="py-[8px] text-[12px] leading-[1.6] text-info-text"
              data-testid="circle-return-order-unknown-note"
            >
              {t('poo70.c8.order.checkoutUnknown')}
            </div>
          )}
        </dl>
      )}

      {/* System states (P70-RETURN-02: 失败/未知可重试; 错账号先拒绝). */}
      {state.phase === 'checking' && (
        <div
          className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-return-checking"
          role="status"
        >
          {t('poo70.c8.state.checking')}
        </div>
      )}

      {state.phase === 'failed' && (
        <div
          className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-return-failed"
          role="alert"
        >
          <p className="m-0">
            {state.failure === 'session-unavailable'
              ? t('poo70.c8.fail.sessionBody')
              : state.failure === 'relations-changed'
                ? t('poo70.c8.fail.relationsBody')
                : t('poo70.c8.fail.body')}
          </p>
        </div>
      )}

      {state.phase === 'verified' && state.entitlement === 'unknown' && (
        <div
          className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-return-unknown-note"
          role="status"
        >
          {t('poo70.c8.state.unknownRetry')}
        </div>
      )}

      {/* Actions. The set per phase mirrors the confirmed prototype scenes;
      there is NO join/pay/open-app/enable-skill affordance in any state. */}
      <div className="mt-[18px] flex flex-wrap gap-[10px]" data-testid="circle-return-actions">
        {(state.phase === 'candidate' || state.phase === 'checking') && (
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            data-testid="circle-return-check"
            disabled={state.phase === 'checking'}
            onClick={onCheck}
          >
            {checkLabel}
          </button>
        )}

        {state.phase === 'failed' && (
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            data-testid="circle-return-retry"
            onClick={onCheck}
          >
            {t('poo70.c8.action.recheck')}
          </button>
        )}

        {state.phase === 'account-mismatch' && onReauthenticate && (
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            data-testid="circle-return-reauthenticate"
            onClick={onReauthenticate}
          >
            {t('poo70.c8.action.reauthenticate')}
          </button>
        )}

        {/* P2-2 (POO-100 review): with NO wired re-login entry the mismatch
        CTA must not render as a dead button — the honest manual-recovery
        note replaces it. */}
        {state.phase === 'account-mismatch' && !onReauthenticate && (
          <p
            className="m-0 max-w-[460px] text-[12px] leading-[1.6] text-muted-foreground"
            data-testid="circle-return-mismatch-no-entry"
          >
            {t('poo70.c8.mismatch.noReloginEntry')}
          </p>
        )}

        {state.phase === 'verified' && state.entitlement === 'unknown' && (
          <button
            type="button"
            className={PRIMARY_BUTTON_CLASS}
            data-testid="circle-return-retry"
            onClick={onCheck}
          >
            {t('poo70.c8.action.recheck')}
          </button>
        )}

        {state.phase === 'verified' && returnRoute && (
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            data-testid="circle-return-open"
            onClick={handleOpenOriginal}
          >
            {isOrder ? t('poo70.c8.action.openSubscription') : t('poo70.c8.action.openCircle')}
          </button>
        )}

        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          data-testid="circle-return-back"
          onClick={handleBackToCircles}
        >
          {t('poo70.c8.action.backToCircles')}
        </button>
      </div>
    </section>
  )
}
