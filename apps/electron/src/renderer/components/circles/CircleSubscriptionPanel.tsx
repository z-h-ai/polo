import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  MemberCircleRenewalPreview,
  MemberCircleSnapshot,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import {
  toMemberCircleReadError,
  type MemberCircleRenewalPreviewResultPayload,
} from '@/hooks/useMemberCircles'
import { isMembershipEndedBeforePeriodEnd } from '@/lib/member-circle-view'
import {
  selectCirclePurchaseHandoff,
} from '@/lib/circle-purchase-url'

/**
 * Circle subscription panel (POO-70 C6 / POO-95; P70-SUBSCRIPTION-01/02/03).
 *
 * The 订阅 section of the circle detail (prototype scenes
 * P-M07-DETAIL-*-SUBSCRIPTION / P-M07-RENEW* / P-M07-YEAR-RESULT). Display
 * contract (Spec §13.13): the circle identity and its effective status live
 * in the header region; price, period and validity each appear EXACTLY ONCE
 * in the detail rows; free / monthly / yearly and the current vs next-period
 * purchased facts follow the authoritative DTOs only.
 *
 * Authoritative sources and non-negotiables:
 * - The 月/年 wording comes from the renewal preview's period discriminated
 *   union (`periodKind: 'calendar_month' | 'calendar_year'`) — the C3 list
 *   layer has no such field, THIS panel is the authoritative place. No
 *   client-side 30/365-day math anywhere: validity, projected renewal window
 *   and the year cap are rendered from server-returned instants
 *   (`currentPeriodEnd` / `projectedPeriodStartAt` / `projectedPeriodEndAt` /
 *   `periodCapEndAt`), never computed from elapsed days.
 * - `priceMinor` may be null (contract): the panel then states the price is
 *   confirmed on the web page — it never fabricates an amount.
 * - Entitlement facts follow the G5 projection discipline: stored order
 *   status is display history only; the panel never upgrades a receipt into
 *   an entitlement and never infers a purchased next-year order from
 *   `currentPeriodEnd` (F1: 下一年度已购 only via the preview's own facts).
 * - Renewal handoff (P70-SUBSCRIPTION-02): the ONLY action is GET preview
 *   (`resource.previewRenewal`) followed by opening the creator-domain
 *   approved path through the existing `electronAPI.openUrl`, after the
 *   renderer-side fail-closed gate (`selectCirclePurchaseHandoff`). No order
 *   creation, no QR code, no payment SDK, no auto-charge, no grace period —
 *   price changes are re-confirmed on the web page.
 * - Recovery (P70-SUBSCRIPTION-03): expired memberships keep the renewal
 *   entry (到期不显示为购买上限 — the restore CTA, preview stays readable);
 *   the cap state creates no order but keeps 查看原订单; preview, order-read
 *   and browser-launch failures are distinct, retryable states that keep the
 *   last known facts on screen.
 *
 * Exit region (P70-SUBSCRIPTION-03): 退出 lives ONLY here and its logic is
 * owned by C7/POO-96 — this card renders the reserved mount point
 * (`circle-subscription-exit-region`) and accepts `onLeave` / `onReturn` in
 * its contract WITHOUT ever invoking them. Price never conflates with
 * compute credits (内容订阅与计算积分独立) — stated once as a display fact.
 *
 * Read authority: preview/order reads go through the shared C2 resource
 * (`useMemberCircles`), whose scope fence derives the permission subject
 * main-side; this panel never sends a userId and keeps no cross-scope cache.
 * The full-page composition is still pending design re-review — no parity
 * claim is made.
 */

// ---------------------------------------------------------------------------
// Props contract (交接接口)
// ---------------------------------------------------------------------------

export interface CircleSubscriptionPanelProps {
  /** The circle whose subscription is shown (display/traceability only). */
  circle: MemberCircleSnapshot
  /**
   * The same-circle membership projection (C2 relations). `null` when this
   * scope has no membership row — the panel falls back to the circle row's
   * own lifecycle fields and never invents a membership fact.
   */
  membership: MemberMembership | null
  /**
   * C7/POO-96 exit wiring point. Deliberately NOT called by this panel: the
   * exit logic (confirmation, per-source invalidation, return verification)
   * belongs to the C7 component that mounts into the reserved exit region.
   */
  onLeave?: () => void
  /** C7/POO-96 return-bridge wiring point; same ownership as `onLeave`. */
  onReturn?: () => void
}

// ---------------------------------------------------------------------------
// Pure display helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Effective membership lifecycle: the membership row wins, circle falls back. */
export function resolveSubscriptionStatus(
  membership: MemberMembership | null,
  circle: Pick<MemberCircleSnapshot, 'status'>,
): MemberMembership['status'] | MemberCircleSnapshot['status'] {
  return membership?.status ?? circle.status
}

/** Suspended/expired reason: the membership row is the only authoritative source. */
export function resolveSubscriptionSuspensionReason(
  membership: MemberMembership | null,
): string | null {
  const reason = membership?.suspendedReason?.trim()
  return reason ? reason : null
}

/**
 * Renders a provider ISO instant as its calendar date (YYYY-MM-DD) — the
 * deterministic UTC date, the same display convention as the C3 list. An
 * unparsable value returns empty and the caller renders the no-date state.
 */
export function formatSubscriptionDate(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return ''
  return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Minor-unit price rendering. The DTO amount is in minor units (the contract
 * stores 2-exponent currency minors); the value is shown in the provider's
 * currency. `null` / negative amounts return empty — the caller then shows
 * the web-confirmation state instead of fabricating a number.
 */
export function formatSubscriptionPrice(
  amountMinor: number | null,
  currency: string | null,
  locale?: string,
): string {
  if (amountMinor === null || amountMinor < 0 || !currency) return ''
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(amountMinor / 100)
  } catch {
    return `${amountMinor / 100} ${currency}`
  }
}

/** Authoritative period wording — the preview period discriminated union ONLY. */
export function subscriptionPeriodLabel(
  preview: Pick<MemberCircleRenewalPreview, 'periodKind'> | null,
  translate: (key: string) => string,
): string | null {
  if (!preview) return null
  if (preview.periodKind === 'calendar_month') return translate('poo70.c6.detail.period.month')
  if (preview.periodKind === 'calendar_year') return translate('poo70.c6.detail.period.year')
  return null
}

// ---------------------------------------------------------------------------
// Component-local preview/launch state
// ---------------------------------------------------------------------------

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; payload: MemberCircleRenewalPreviewResultPayload }
  | { phase: 'failed'; retryable: boolean; errorCode: string }

type OrderState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; order: OriginalCircleOrder }
  | { phase: 'failed' }

type LaunchState =
  | { phase: 'idle' }
  | { phase: 'opening' }
  | { phase: 'opened' }
  | { phase: 'open-failed' }

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function CircleSubscriptionPanel({
  circle,
  membership,
  onLeave: _onLeave,
  onReturn: _onReturn,
}: CircleSubscriptionPanelProps) {
  const { t, i18n } = useTranslation()
  const resource = useMemberCircles()

  const status = resolveSubscriptionStatus(membership, circle)
  const billingKind = membership?.billingKind ?? circle.billingKind
  const isPaid = billingKind === 'paid'
  const membershipId = membership?.membershipId ?? null

  const [preview, setPreview] = useState<PreviewState>({ phase: 'idle' })
  const [order, setOrder] = useState<OrderState>({ phase: 'idle' })
  const [launch, setLaunch] = useState<LaunchState>({ phase: 'idle' })

  // Latest preview request wins; a superseded response never lands. The
  // order/launch round-trips carry the SAME seq guard: a receipt resolved
  // after a circle switch belongs to the previous identity and must never
  // land on the new circle's panel.
  const previewSeqRef = useRef(0)
  const orderSeqRef = useRef(0)
  const launchSeqRef = useRef(0)

  /**
   * ONE authoritative preview GET: resolves the trusted payload on success,
   * `null` on any failure OR when this request was superseded before it
   * landed (the caller must not open from a stale round-trip).
   */
  const requestPreview = useCallback(async (membershipId: string): Promise<MemberCircleRenewalPreviewResultPayload | null> => {
    const seq = ++previewSeqRef.current
    setPreview(current => (current.phase === 'ready' ? current : { phase: 'loading' }))
    const result = await resource.previewRenewal(membershipId)
    if (seq !== previewSeqRef.current) return null
    if (result.success) {
      const payload: MemberCircleRenewalPreviewResultPayload = {
        purchaseUrl: result.purchaseUrl,
        resolvedPurchaseUrl: result.resolvedPurchaseUrl,
        purchaseUrlResolutionError: result.purchaseUrlResolutionError,
        preview: result.preview,
      }
      setPreview({ phase: 'ready', payload })
      return payload
    }
    const error = toMemberCircleReadError(result)
    // A ready receipt stays on screen over a failed refresh (P70-SUBSCRIPTION-03):
    // keep the last known facts, the error banner carries the retry.
    setPreview(current => (current.phase === 'ready'
      ? current
      : { phase: 'failed', retryable: error.retryable, errorCode: error.code }))
    return null
  }, [resource])

  // Circle switch hygiene (P70 旧回执不串圈): a different membership must
  // never display the previous circle's preview/order/launch state. The
  // internal state is dropped synchronously AND every in-flight round-trip
  // of the previous identity is invalidated, so a late getOrder/openUrl
  // settlement can never write a stale receipt or banner onto THIS panel.
  useEffect(() => {
    previewSeqRef.current += 1
    orderSeqRef.current += 1
    launchSeqRef.current += 1
    setPreview({ phase: 'idle' })
    setOrder({ phase: 'idle' })
    setLaunch({ phase: 'idle' })
  }, [membershipId])

  // ONE authoritative preview GET per paid membership mount: it feeds the
  // authoritative period wording, the renewal/cap facts and the handoff.
  // The read waits for the C2 scope fence to exist (the provider publishes
  // it in its own mount effect, which runs AFTER this child's effects) and
  // re-runs when the binding changes; a superseded scope can never answer.
  const scopeReady = resource.state.scope !== null
  useEffect(() => {
    if (!isPaid || !membershipId || !scopeReady) return
    void requestPreview(membershipId)
    // Re-run only for a DIFFERENT paid membership or a re-bound scope; the
    // C2 fence already discards cross-account replies.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the identity IS the dependency
  }, [membershipId, isPaid, scopeReady])

  const readyPreview = preview.phase === 'ready' ? preview.payload : null
  const canRenew = readyPreview?.preview.canRenew === true
  // 到期不显示为购买上限, and a suspended membership fails closed (reason
  // display only, no renewal claims): neither renders the cap block — the
  // cap copy is only meaningful for an ACTIVE membership's early renewal.
  const showCap = isPaid && readyPreview !== null && !canRenew
    && status !== 'expired' && status !== 'suspended'

  const handleRetryPreview = useCallback(() => {
    if (!membershipId) return
    void requestPreview(membershipId)
  }, [membershipId, requestPreview])

  const openInBrowser = useCallback(async (url: string) => {
    // Superseded round-trips never land: a circle switch (or a newer launch)
    // invalidates THIS attempt's feedback, so a rejection resolved after the
    // switch cannot render a dead banner on the new circle's panel.
    const seq = ++launchSeqRef.current
    setLaunch({ phase: 'opening' })
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
      | { openUrl?: (url: string) => Promise<void> }
      | undefined
    if (!api?.openUrl) {
      // Fail closed: no bridge, no fake success.
      if (seq === launchSeqRef.current) setLaunch({ phase: 'open-failed' })
      return
    }
    try {
      await api.openUrl(url)
      if (seq === launchSeqRef.current) setLaunch({ phase: 'opened' })
    } catch {
      if (seq === launchSeqRef.current) setLaunch({ phase: 'open-failed' })
    }
  }, [])

  // P70-SUBSCRIPTION-02: renewal opens ONLY through a preview GET — either
  // the already-held authoritative preview (read BEFORE any await, so the
  // closure is fresh), or the payload a fresh fetch resolves with. A cap
  // (canRenew=false) and a blocked handoff open nothing.
  const handleRenew = useCallback(() => {
    if (!membershipId) return
    void (async () => {
      const payload = preview.phase === 'ready'
        ? preview.payload
        : await requestPreview(membershipId)
      if (!payload || !payload.preview.canRenew) return
      const handoff = selectCirclePurchaseHandoff(payload)
      if (handoff.state !== 'ready') return // blocked: fail closed, banner below
      await openInBrowser(handoff.url)
    })()
  }, [membershipId, preview, requestPreview, openInBrowser])

  const handleRetryLaunch = useCallback(() => {
    const payload = preview.phase === 'ready' ? preview.payload : null
    if (!payload || !payload.preview.canRenew) return
    const handoff = selectCirclePurchaseHandoff(payload)
    if (handoff.state !== 'ready') return
    void openInBrowser(handoff.url)
  }, [preview, openInBrowser])

  const latestOrderSummary = membership?.paymentOrders[0] ?? null

  // The renewal CTA exists only when the handoff can actually open: a cap
  // (canRenew=false) or a blocked URL renders NO dead button — the cap block
  // / blocked banner is the state, and re-checking the preview is recovery.
  const handoff = readyPreview ? selectCirclePurchaseHandoff(readyPreview) : null
  const handoffReady = canRenew && handoff?.state === 'ready'

  const handleViewOriginalOrder = useCallback(() => {
    if (!latestOrderSummary) return
    void (async () => {
      // Same supersede guard as the preview: an order receipt resolved after
      // a circle switch belongs to the previous identity and never renders.
      const seq = ++orderSeqRef.current
      setOrder({ phase: 'loading' })
      const result = await resource.getOrder(latestOrderSummary.orderId)
      if (seq !== orderSeqRef.current) return
      if (result.success) {
        setOrder({ phase: 'ready', order: result.order })
      } else {
        setOrder({ phase: 'failed' })
      }
    })()
  }, [latestOrderSummary, resource])

  const suspensionReason = resolveSubscriptionSuspensionReason(membership)

  const currentPeriodEnd = membership?.currentPeriodEnd ?? circle.currentPeriodEnd
  const validityDate = currentPeriodEnd ? formatSubscriptionDate(currentPeriodEnd) : ''
  // POO-70 visual review R1 F3: an expired relation whose paid period is
  // still running is the leave/early-termination shape (F1: a confirmed
  // leave writes active→expired mid-period). Its display facts unify with
  // the page heading's restore vocabulary and drop the contradictory
  // validity date / projected renewal below.
  const endedBeforePeriodEnd = isMembershipEndedBeforePeriodEnd({
    status,
    currentPeriodEnd: currentPeriodEnd ?? null,
  })

  const statusLabel = status === 'active'
    ? t('poo70.c6.status.active')
    : status === 'expired' && !endedBeforePeriodEnd
      ? t('poo70.c6.status.expired')
      : t('poo70.c3.entitlement.restore')

  // Price rendering follows the resolved i18n language for a stable locale.
  const locale = i18n.resolvedLanguage ?? undefined
  const circlePrice = formatSubscriptionPrice(
    membership?.circle.membershipPriceMinor ?? null,
    membership?.circle.membershipCurrency ?? null,
    locale,
  )
  const nextPrice = formatSubscriptionPrice(
    membership?.circle.nextPeriodPriceMinor ?? null,
    membership?.circle.membershipCurrency ?? null,
    locale,
  )
  const nextPriceDate = membership?.circle.nextPriceEffectiveAt
    ? formatSubscriptionDate(membership.circle.nextPriceEffectiveAt)
    : ''

  const periodLabel = readyPreview ? subscriptionPeriodLabel(readyPreview.preview, t) : null
  const previewPrice = readyPreview
    ? formatSubscriptionPrice(readyPreview.preview.priceMinor, readyPreview.preview.currency, locale)
    : ''
  const previewPriceChanged = readyPreview !== null
    && previewPrice !== ''
    && circlePrice !== ''
    && previewPrice !== circlePrice

  return (
    <section
      className="mt-[34px]"
      data-testid="circle-subscription-panel"
      data-circle-id={circle.circle.circleId}
    >
      {/* 页头 region (P70-SUBSCRIPTION-01): circle identity + effective status.
      The detail page shell (C9) may render its own page heading; this region
      keeps the subscription-section header facts authoritative and single. */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {t('poo70.c6.title')}
        </h2>
        <span
          className="m-0 text-[13px] font-medium text-foreground"
          data-testid="circle-subscription-circle-name"
        >
          {circle.circle.name}
        </span>
        <span
          className={`inline-flex min-h-[20px] items-center rounded-full px-[8px] text-[11px] font-medium ${
            status === 'active'
              ? 'bg-success/10 text-success-text'
              : 'bg-foreground/6 text-muted-foreground'
          }`}
          data-testid="circle-subscription-status"
          data-status={status}
        >
          {statusLabel}
        </span>
      </div>

      {suspensionReason && status === 'suspended' && (
        <p
          className="m-0 mt-[8px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
          data-testid="circle-subscription-suspended-reason"
          role="alert"
        >
          {suspensionReason}
        </p>
      )}

      {/* Detail rows: price / period / validity each appear EXACTLY ONCE
      (Spec §13.13 订阅页文案去重). */}
      <dl className="m-0 mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-[8px]">
          <dt className="m-0 text-muted-foreground">{t('poo70.c6.detail.periodLabel')}</dt>
          <dd
            className="m-0 text-right text-[13px] font-medium text-foreground"
            data-testid="circle-subscription-period-value"
          >
            {!isPaid && t('poo70.c6.detail.period.free')}
            {isPaid && preview.phase === 'loading' && (
              <span data-testid="circle-subscription-period-loading">{t('poo70.c6.detail.period.loading')}</span>
            )}
            {isPaid && preview.phase === 'failed' && (
              <span data-testid="circle-subscription-period-unavailable">{t('poo70.c6.detail.period.unavailable')}</span>
            )}
            {isPaid && readyPreview && (
              <span>
                {periodLabel ?? t('poo70.c6.detail.period.unavailable')}
                {previewPrice !== '' && (
                  <span className="ml-[6px] font-normal text-muted-foreground">
                    {readyPreview.preview.priceMinor !== null
                      ? t(readyPreview.preview.periodKind === 'calendar_year'
                        ? 'poo70.c6.detail.pricePerYear'
                        : 'poo70.c6.detail.pricePerMonth', { price: previewPrice })
                      : null}
                    {readyPreview.preview.priceMinor === null && t('poo70.c6.detail.priceAtWeb')}
                  </span>
                )}
                {previewPrice === '' && t('poo70.c6.detail.priceAtWeb')}
              </span>
            )}
            {isPaid && !readyPreview && preview.phase === 'idle' && (
              <span data-testid="circle-subscription-period-loading">{t('poo70.c6.detail.period.loading')}</span>
            )}
          </dd>
        </div>
        <div className="mt-[8px] flex flex-wrap items-baseline justify-between gap-[8px] border-t border-border pt-[8px]">
          <dt className="m-0 text-muted-foreground">{t('poo70.c6.detail.validityLabel')}</dt>
          <dd
            className="m-0 text-right text-[13px] font-medium text-foreground"
            data-testid="circle-subscription-validity-value"
          >
            {!isPaid && t('poo70.c6.detail.freeTerm')}
            {isPaid && validityDate && endedBeforePeriodEnd && (
              <span data-testid="circle-subscription-validity-revoked">
                {t('poo70.c6.detail.validityRevoked')}
              </span>
            )}
            {isPaid && validityDate && !endedBeforePeriodEnd && (status === 'expired'
              ? t('poo70.c6.detail.expiredAt', { date: validityDate })
              : t('poo70.c6.detail.validUntil', { date: validityDate }))}
            {isPaid && !validityDate && t('poo70.c6.detail.termUnknown')}
          </dd>
        </div>
      </dl>

      {/* Authoritative price-change fact (价格变化重新确认), shown once. */}
      {isPaid && nextPrice !== '' && nextPriceDate && (
        <p
          className="m-0 mt-[8px] text-[12px] text-muted-foreground"
          data-testid="circle-subscription-next-price"
        >
          {t('poo70.c6.detail.nextPrice', { date: nextPriceDate, price: nextPrice })}
        </p>
      )}

      {/* Paid-only renewal facts — all from the ONE authoritative preview.
      Suppressed for the leave/early-termination state (POO-70 visual review
      R1 F3): a projected 续期 would contradict the revoked authorization. */}
      {isPaid && readyPreview && !endedBeforePeriodEnd && (
        <div className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs">
          <p className="m-0 text-muted-foreground">{t('poo70.c6.preview.projectedTermLabel')}</p>
          <p
            className="m-0 mt-[4px] text-[13px] font-medium text-foreground"
            data-testid="circle-subscription-projected-term"
          >
            {t('poo70.c6.preview.projectedTerm', {
              start: formatSubscriptionDate(readyPreview.preview.projectedPeriodStartAt),
              end: formatSubscriptionDate(readyPreview.preview.projectedPeriodEndAt),
            })}
          </p>
          {previewPriceChanged && (
            <p
              className="m-0 mt-[8px] text-[12px] text-info-text"
              data-testid="circle-subscription-preview-price-changed"
            >
              {t('poo70.c6.preview.priceChanged', { price: previewPrice })}
            </p>
          )}
          <p className="m-0 mt-[8px] text-[12px] text-muted-foreground">
            {t('poo70.c6.preview.noAutoRenew')}
          </p>
        </div>
      )}

      {isPaid && preview.phase === 'loading' && (
        <div
          className="mt-[14px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-subscription-preview-loading"
          role="status"
        >
          {t('poo70.c6.preview.loading')}
        </div>
      )}

      {isPaid && preview.phase === 'failed' && (
        <div
          className="mt-[14px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-subscription-preview-error"
          role="alert"
        >
          <span>{t('poo70.c6.preview.failed')}</span>
          {preview.retryable && (
            <button
              type="button"
              data-testid="circle-subscription-preview-retry"
              className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
              onClick={handleRetryPreview}
            >
              {t('poo70.c3.action.retry')}
            </button>
          )}
        </div>
      )}

      {/* Cap state (限额): NO order is created and NO browser opens; the
      original order stays queryable (P70-SUBSCRIPTION-03). Suppressed for an
      expired membership — 到期不显示为购买上限. */}
      {showCap && (
        <div
          className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs"
          data-testid="circle-subscription-cap"
          role="status"
        >
          <p className="m-0 font-medium text-foreground">{t('poo70.c6.cap.title')}</p>
          <p className="m-0 mt-[4px] text-muted-foreground">{t('poo70.c6.cap.body')}</p>
          <ul className="m-0 mt-[8px] list-none p-0 text-muted-foreground">
            <li>{t('poo70.c6.cap.ruleMonth')}</li>
            <li className="mt-[2px]">{t('poo70.c6.cap.ruleYear')}</li>
          </ul>
          {readyPreview?.preview.capReason && (
            <p className="m-0 mt-[8px] text-muted-foreground" data-testid="circle-subscription-cap-reason">
              {t('poo70.c6.cap.serverReason', { reason: readyPreview.preview.capReason })}
            </p>
          )}
          {latestOrderSummary && (
            <button
              type="button"
              data-testid="circle-subscription-view-order"
              className="mt-[10px] inline-flex min-h-[28px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
              onClick={handleViewOriginalOrder}
            >
              {t('poo70.c6.action.viewOriginalOrder')}
            </button>
          )}
        </div>
      )}

      {/* Renewal CTA (P70-SUBSCRIPTION-02): active → 续费, expired → 续费恢复
      (the recovery entry — the preview stays readable when expired). A
      suspended membership fails closed: no renewal CTA, reason above. */}
      {isPaid && status !== 'suspended' && handoffReady && (
        <div className="mt-[14px] flex flex-wrap items-center gap-[10px]">
          <button
            type="button"
            data-testid={status === 'expired' ? 'circle-subscription-renew-restore' : 'circle-subscription-renew'}
            className="inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-accent/35 bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-[16px] text-[13px] font-medium text-accent hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] disabled:opacity-60"
            disabled={launch.phase === 'opening'}
            onClick={handleRenew}
          >
            {launch.phase === 'opening'
              ? t('poo70.c6.action.opening')
              : status === 'expired'
                ? t('poo70.c6.action.renewRestore')
                : t('poo70.c6.action.renew')}
          </button>
          {latestOrderSummary && (
            <button
              type="button"
              data-testid="circle-subscription-view-order-cta"
              className="inline-flex min-h-[32px] items-center justify-center rounded-[8px] border border-border bg-transparent px-[12px] text-[13px] font-medium text-foreground hover:bg-foreground-5"
              onClick={handleViewOriginalOrder}
            >
              {t('poo70.c6.action.viewOriginalOrder')}
            </button>
          )}
        </div>
      )}

      {/* Fail-closed handoff banner: the raw URL is NEVER opened. */}
      {isPaid && readyPreview && canRenew && handoff?.state === 'blocked' && (
        <div
          className="mt-[14px] rounded-[13px] border border-danger/25 bg-danger/8 px-4 py-3 text-xs text-danger"
          data-testid="circle-subscription-handoff-blocked"
          role="alert"
        >
          <p className="m-0 font-medium">{t('poo70.c6.handoff.blockedTitle')}</p>
          <p className="m-0 mt-[4px]">
            {handoff.reason === 'untrusted_purchase_url_origin'
              ? t('poo70.c6.handoff.blockedUntrusted')
              : t('poo70.c6.handoff.blockedInvalid')}
          </p>
        </div>
      )}

      {/* Browser launch failure is a distinct, retryable recovery state
      (P70-SUBSCRIPTION-03 网页启动失败可恢复). The resolved URL is still
      held, so the retry re-opens WITHOUT a second preview GET. */}
      {launch.phase === 'open-failed' && (
        <div
          className="mt-[14px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-subscription-open-failed"
          role="alert"
        >
          <span>{t('poo70.c6.handoff.openFailed')}</span>
          <button
            type="button"
            data-testid="circle-subscription-open-retry"
            className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            onClick={handleRetryLaunch}
          >
            {t('poo70.c3.action.retry')}
          </button>
        </div>
      )}

      {/* Original order receipt (查询原单): display history only — NEVER an
      entitlement judgment (G5). */}
      {order.phase === 'loading' && (
        <div
          className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs text-muted-foreground"
          data-testid="circle-subscription-order-loading"
          role="status"
        >
          {t('poo70.c6.order.loading')}
        </div>
      )}

      {order.phase === 'failed' && (
        <div
          className="mt-[14px] flex flex-wrap items-center justify-between gap-[10px] rounded-[13px] border border-info/20 bg-info/8 px-4 py-3 text-xs text-info-text"
          data-testid="circle-subscription-order-failed"
          role="alert"
        >
          <span>{t('poo70.c6.order.failed')}</span>
          <button
            type="button"
            data-testid="circle-subscription-order-retry"
            className="inline-flex min-h-[28px] shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
            onClick={handleViewOriginalOrder}
          >
            {t('poo70.c3.action.retry')}
          </button>
        </div>
      )}

      {order.phase === 'ready' && (
        <div
          className="mt-[14px] rounded-[13px] border border-border bg-surface px-4 py-3 text-xs"
          data-testid="circle-subscription-order"
        >
          <p className="m-0 font-medium text-foreground">{t('poo70.c6.order.title')}</p>
          <p className="m-0 mt-[4px] text-muted-foreground" data-testid="circle-subscription-order-id">
            {t('poo70.c6.order.id', { orderId: order.order.orderId })}
          </p>
          <p className="m-0 mt-[2px] text-muted-foreground" data-testid="circle-subscription-order-amount">
            {t('poo70.c6.order.amount', {
              price: formatSubscriptionPrice(order.order.amountMinor, order.order.currency, locale),
            })}
          </p>
          <p className="m-0 mt-[2px] text-muted-foreground" data-testid="circle-subscription-order-status">
            {t('poo70.c6.order.status', { status: order.order.storedStatus })}
          </p>
          {order.order.periodEndAt && formatSubscriptionDate(order.order.periodEndAt) !== '' && (
            <p className="m-0 mt-[2px] text-muted-foreground" data-testid="circle-subscription-order-period-end">
              {t('poo70.c6.order.periodEnd', { date: formatSubscriptionDate(order.order.periodEndAt) })}
            </p>
          )}
          <p className="m-0 mt-[8px] text-muted-foreground">{t('poo70.c6.order.displayOnly')}</p>
        </div>
      )}

      {/* Section notes (each once): exit-impact rule + the
      subscription≠compute-credits independence fact. */}
      <div className="mt-[14px] text-[12px] leading-[1.6] text-muted-foreground">
        <p className="m-0" data-testid="circle-subscription-note-exit">
          {t('poo70.c6.note.exitImpact')}
        </p>
        <p className="m-0 mt-[4px]" data-testid="circle-subscription-note-not-credits">
          {t('poo70.c6.note.notCredits')}
        </p>
      </div>

      {/* P70-SUBSCRIPTION-03: the ONLY exit entry region. Reserved mount
      point for the C7/POO-96 exit component — this card renders nothing
      inside it and never invokes onLeave/onReturn itself. */}
      <div
        className="mt-[14px] border-t border-border pt-[14px]"
        data-testid="circle-subscription-exit-region"
        data-circle-id={circle.circle.circleId}
      />
    </section>
  )
}
