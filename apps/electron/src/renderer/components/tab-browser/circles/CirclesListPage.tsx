/**
 * CirclesListPage — 「我的圈子」 list and empty state (POO-70 M07).
 *
 * Sits beside 「全部 Apps」 in the personal space navigation (D-PC-07);
 * host surfaces mount it inside the product shell. The empty state explains
 * the private-distribution entries: shared links, QR codes, directed
 * invitations, paid and approval-gated circles.
 */

import { ArrowLeft, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusPill, type StatusPillTone } from '@/components/hifi'
import { cn } from '@/lib/utils'
import { membershipState } from './circlesState'
import { FlowButton } from './flowButtons'
import type { CircleSummary } from './types'

export interface CirclesListPageProps {
  circles: CircleSummary[]
  /** ISO date used to evaluate paid expiry (defaults to "today" at render). */
  now?: string
  onBack: () => void
  onOpenCircle: (circleId: string) => void
  /** 「使用邀请链接加入」 / empty-state CTA. */
  onUseInviteLink: () => void
  className?: string
}

function statusPill(
  circle: CircleSummary,
  state: CircleSummary['membership'],
  t: (key: string, options?: Record<string, unknown>) => string,
): { tone: StatusPillTone; label: string } {
  const subscription = circle.subscription
  switch (state) {
    case 'pendingApproval':
      return { tone: 'info', label: t('circles.status.pendingApproval') }
    case 'expired':
      return { tone: 'destructive', label: t('circles.status.expired') }
    case 'left':
      return { tone: 'destructive', label: t('circles.status.left') }
    default:
      return subscription
        ? {
            tone: 'info',
            label: t('circles.status.paidActive'),
          }
        : { tone: 'success', label: t('circles.status.active') }
  }
}

export function CirclesListPage({
  circles,
  now,
  onBack,
  onOpenCircle,
  onUseInviteLink,
  className,
}: CirclesListPageProps) {
  const { t } = useTranslation()
  const today = now ?? new Date().toISOString().slice(0, 10)

  return (
    <div
      data-testid="circles-list-page"
      className={cn('min-h-full bg-hifi-background px-6 py-6', className)}
    >
      <div className="mx-auto w-full max-w-[780px]">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex cursor-pointer items-center gap-1.5 rounded-hifi-sm text-hifi-md text-hifi-fg-60 transition-colors hover:text-hifi-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t('circles.list.back')}
        </button>

        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="hifi-eyebrow">{t('circles.list.eyebrow')}</p>
            <h1 className="m-0 text-hifi-page font-[720] tracking-[-0.02em] text-hifi-foreground">
              {t('circles.list.title')}
            </h1>
            <p className="mt-1.5 text-hifi-md text-hifi-fg-60">
              {t('circles.list.subtitle')}
            </p>
          </div>
          <FlowButton variant="quiet" onClick={onUseInviteLink}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t('circles.list.inviteCta')}
          </FlowButton>
        </header>

        {circles.length === 0 ? (
          <div
            data-testid="circles-empty-state"
            className="mt-10 grid place-items-center rounded-hifi-card border border-hifi-border bg-hifi-surface px-8 py-14 text-center shadow-minimal"
          >
            <p className="hifi-eyebrow">{t('circles.empty.eyebrow')}</p>
            <h2 className="m-0 text-hifi-state font-[720] tracking-[-0.03em] text-hifi-foreground">
              {t('circles.empty.title')}
            </h2>
            <p className="mt-2 max-w-[440px] text-hifi-md text-hifi-fg-60">
              {t('circles.empty.description')}
            </p>
            <div className="mt-6">
              <FlowButton variant="primary" onClick={onUseInviteLink}>
                {t('circles.empty.cta')}
              </FlowButton>
            </div>
          </div>
        ) : (
          <section className="mt-8">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="m-0 text-hifi-lg font-semibold text-hifi-foreground">
                  {t('circles.list.sectionTitle')}
                </h2>
                <p className="mt-0.5 text-hifi-base text-hifi-fg-60">
                  {t('circles.list.sectionSubtitle')}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3">
              {circles.map(circle => {
                const state = membershipState(circle, today)
                const pill = statusPill(circle, state, t)
                return (
                  <article
                    key={circle.id}
                    data-testid="circle-card"
                    className="flex flex-wrap items-start gap-4 rounded-hifi-inner border border-hifi-border bg-hifi-surface p-4 shadow-minimal"
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-hifi-md bg-hifi-accent-soft text-hifi-lg font-semibold text-hifi-accent">
                      {circle.name.charAt(0)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-hifi-lg font-semibold text-hifi-foreground">
                          {circle.name}
                        </span>
                        <span className="text-hifi-base text-hifi-fg-60">
                          {circle.creator}
                        </span>
                        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
                      </div>
                      {circle.updateNote && (
                        <p className="m-0 mt-1 text-hifi-base text-hifi-fg-60">
                          {circle.updateNote}
                        </p>
                      )}
                      <p className="m-0 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-hifi-base text-hifi-fg-60">
                        <span>{t('circles.stats.apps', { count: circle.appCount })}</span>
                        {circle.skillCount > 0 && (
                          <span>
                            {t('circles.stats.skills', { count: circle.skillCount })}
                          </span>
                        )}
                        <span>
                          {circle.subscription
                            ? state === 'expired'
                              ? t('circles.stats.expiredOn', {
                                  date: circle.subscription.expiresAt,
                                })
                              : t('circles.stats.pricePeriod', {
                                  price: circle.subscription.price,
                                })
                            : t('circles.stats.free')}
                        </span>
                        {circle.subscription && state === 'active' && (
                          <span>
                            {t('circles.stats.expiresOn', {
                              date: circle.subscription.expiresAt,
                            })}
                          </span>
                        )}
                        {!circle.subscription && (
                          <span>{t('circles.stats.longTerm')}</span>
                        )}
                      </p>
                    </div>
                    <FlowButton onClick={() => onOpenCircle(circle.id)}>
                      {circle.appCount > 0 && !circle.skillCount
                        ? t('circles.card.viewApp')
                        : t('circles.card.viewCircle')}
                    </FlowButton>
                  </article>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
