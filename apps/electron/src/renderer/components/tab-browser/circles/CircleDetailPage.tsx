/**
 * CircleDetailPage — joined / subscribed / expired / left detail view
 * (POO-70 M07). Detail = granted works + subscription terms; renewal and
 * leaving both live here. Work rows come from the deduped CircleSourcedApp
 * data, so the source-fallback presentation (D-PC-09) is data-driven: a work
 * whose only invalid source was this circle stays listed with the other
 * source's line.
 */

import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusPill, type StatusPillTone } from '@/components/hifi'
import { cn } from '@/lib/utils'
import {
  buildCircleWorkRows,
  membershipState,
  type CircleWorkDetails,
} from './circlesState'
import { FlowButton } from './flowButtons'
import type {
  CircleMembershipState,
  CircleSourcedApp,
  CircleSummary,
  CircleWorkRow,
} from './types'

export interface CircleDetailPageProps {
  circle: CircleSummary
  apps: CircleSourcedApp[]
  skills: CircleSourcedApp[]
  /** Skill ids already installed on this machine. */
  installedSkillIds?: string[]
  /** Presentation details the sourced-apps contract does not carry. */
  workDetails?: Record<string, CircleWorkDetails>
  /** ISO date used to evaluate paid expiry (defaults to "today" at render). */
  now?: string
  onBack: () => void
  onViewAllApps: () => void
  onManageSkills: () => void
  onOpenWork: (work: CircleWorkRow) => void
  onInstallWork: (work: CircleWorkRow) => void
  /** 续费 / 续费恢复 / 重新加入圈子, depending on state. */
  onRenew?: () => void
  onRejoin?: () => void
  onLeave?: () => void
  className?: string
}

const WORK_STATUS_TONE: Record<
  CircleWorkRow['availability'],
  { tone: StatusPillTone; key: string }
> = {
  usable: { tone: 'success', key: 'circles.work.status.usable' },
  installable: { tone: 'neutral', key: 'circles.work.status.installable' },
  unavailable: { tone: 'destructive', key: 'circles.work.status.unavailable' },
  expired: { tone: 'destructive', key: 'circles.work.status.expired' },
  stillAuthorized: { tone: 'neutral', key: 'circles.work.status.stillAuthorized' },
}

function workRowActions(
  row: CircleWorkRow,
  handlers: {
    onOpenWork: CircleDetailPageProps['onOpenWork']
    onInstallWork: CircleDetailPageProps['onInstallWork']
    onRejoin?: () => void
    onRenew?: () => void
  },
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  switch (row.availability) {
    case 'installable':
      return [
        <FlowButton key="install" onClick={() => handlers.onInstallWork(row)}>
          {t('circles.work.install')}
        </FlowButton>,
      ]
    case 'unavailable':
      return handlers.onRejoin
        ? [
            <FlowButton key="rejoin" onClick={handlers.onRejoin}>
              {t('circles.work.rejoin')}
            </FlowButton>,
          ]
        : []
    case 'expired':
      return [
        <FlowButton key="open" onClick={() => handlers.onOpenWork(row)}>
          {t('circles.work.open')}
        </FlowButton>,
        ...(handlers.onRenew
          ? [
              <FlowButton key="renew" variant="primary" onClick={handlers.onRenew}>
                {t('circles.work.renewRestore')}
              </FlowButton>,
            ]
          : []),
      ]
    case 'stillAuthorized':
      return [
        <FlowButton
          key="open"
          variant="primary"
          onClick={() => handlers.onOpenWork(row)}
        >
          {t('circles.work.stillOpen')}
        </FlowButton>,
      ]
    default:
      return [
        <FlowButton key="open" onClick={() => handlers.onOpenWork(row)}>
          {t('circles.work.open')}
        </FlowButton>,
      ]
  }
}

function sourceLine(
  row: CircleWorkRow,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const fromCircle = row.version
    ? t('circles.work.sourceFromVersion', {
        circle: row.source.circleName,
        version: row.version,
      })
    : t('circles.work.sourceFrom', { circle: row.source.circleName })
  if (!row.sourceNames) return fromCircle
  return row.kind === 'skill'
    ? t('circles.work.sourceSameSkill', {
        circles: row.sourceNames.join(t('circles.work.sourceSeparator')),
      })
    : fromCircle
}

function fallbackLine(
  row: CircleWorkRow,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const note = row.fallbackNote
  if (!note) return undefined
  switch (note.kind) {
    case 'other-source':
      return t('circles.work.sourceOtherCircle', { circle: note.circleName ?? '' })
    case 'install-note':
      return t('circles.work.sourceInstallNote')
    case 'expired-source':
      return t('circles.work.sourceFallback')
  }
}

function headingMeta(
  circle: CircleSummary,
  state: CircleMembershipState,
  t: (key: string, options?: Record<string, unknown>) => string,
): { pill: { tone: StatusPillTone; label: string }; meta: string } {
  switch (state) {
    case 'expired':
      return {
        pill: { tone: 'destructive', label: t('circles.status.expired') },
        meta: t('circles.detail.expiredMeta', {
          price: circle.subscription?.price ?? '',
          date: circle.subscription?.expiresAt ?? '',
        }),
      }
    case 'left':
      return {
        pill: { tone: 'destructive', label: t('circles.status.left') },
        meta: t('circles.detail.leftMeta'),
      }
    case 'pendingApproval':
      return {
        pill: { tone: 'info', label: t('circles.status.pendingApproval') },
        meta: t('circles.stats.free'),
      }
    default:
      return circle.subscription
        ? {
            pill: { tone: 'info', label: t('circles.status.paid') },
            meta: t('circles.detail.paidMeta', {
              price: circle.subscription.price,
              date: circle.subscription.expiresAt,
            }),
          }
        : {
            pill: { tone: 'success', label: t('circles.status.active') },
            meta: t('circles.detail.freeMeta'),
          }
  }
}

export function CircleDetailPage({
  circle,
  apps,
  skills,
  installedSkillIds = [],
  workDetails = {},
  now,
  onBack,
  onViewAllApps,
  onManageSkills,
  onOpenWork,
  onInstallWork,
  onRenew,
  onRejoin,
  onLeave,
  className,
}: CircleDetailPageProps) {
  const { t } = useTranslation()
  const today = now ?? new Date().toISOString().slice(0, 10)
  const state = membershipState(circle, today)
  const rows = buildCircleWorkRows(
    { circle, apps, skills, installedSkillIds },
    workDetails,
  )
  const appRows = rows.filter(row => row.kind === 'app')
  const skillRows = rows.filter(row => row.kind === 'skill')
  const heading = headingMeta(circle, state, t)
  const handlers = { onOpenWork, onInstallWork, onRejoin, onRenew }

  return (
    <div
      data-testid="circle-detail-page"
      className={cn('min-h-full bg-hifi-background px-6 py-6', className)}
    >
      <div className="mx-auto w-full max-w-[780px]">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex cursor-pointer items-center gap-1.5 rounded-hifi-sm text-hifi-md text-hifi-fg-60 transition-colors hover:text-hifi-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t('circles.detail.back')}
        </button>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="hifi-eyebrow">{t('circles.detail.eyebrow')}</p>
            <h1 className="m-0 text-hifi-page font-[720] tracking-[-0.02em] text-hifi-foreground">
              {circle.name}
            </h1>
            <p className="mt-1.5 text-hifi-md text-hifi-fg-60">
              {t('circles.detail.meta', {
                creator: circle.creator,
                apps: circle.appCount,
                skills: circle.skillCount,
              })}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
              <StatusPill tone={heading.pill.tone}>{heading.pill.label}</StatusPill>
              <span className="text-hifi-base text-hifi-fg-60">{heading.meta}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {state === 'expired' && onRenew && (
              <FlowButton variant="quiet" onClick={onRenew}>
                {t('circles.detail.renewRestore')}
              </FlowButton>
            )}
            {state === 'active' && circle.subscription && onRenew && (
              <FlowButton variant="quiet" onClick={onRenew}>
                {t('circles.detail.renew')}
              </FlowButton>
            )}
            {state === 'active' && onLeave && (
              <FlowButton variant="quiet" onClick={onLeave}>
                {t('circles.detail.leave')}
              </FlowButton>
            )}
            {state === 'left' && onRejoin && (
              <FlowButton variant="quiet" onClick={onRejoin}>
                {t('circles.detail.rejoin')}
              </FlowButton>
            )}
          </div>
        </header>

        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="m-0 text-hifi-lg font-semibold text-hifi-foreground">
                {t('circles.detail.appsTitle')}
              </h2>
              <p className="mt-0.5 text-hifi-base text-hifi-fg-60">
                {state === 'expired'
                  ? t('circles.detail.expiredAppsSubtitle')
                  : t('circles.detail.appsSubtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={onViewAllApps}
              className="inline-flex cursor-pointer items-center gap-1 rounded-hifi-sm text-hifi-md text-hifi-accent transition-colors hover:text-hifi-accent/80"
            >
              {t('circles.detail.viewAllApps')}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-4 grid gap-2.5">
            {appRows.map(row => (
              <CircleWorkRowView key={row.id} row={row} handlers={handlers} />
            ))}
          </div>
        </section>

        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="m-0 text-hifi-lg font-semibold text-hifi-foreground">
                {t('circles.detail.skillsTitle')}
              </h2>
              <p className="mt-0.5 text-hifi-base text-hifi-fg-60">
                {t('circles.detail.skillsSubtitle')}
              </p>
            </div>
            <button
              type="button"
              onClick={onManageSkills}
              className="inline-flex cursor-pointer items-center gap-1 rounded-hifi-sm text-hifi-md text-hifi-accent transition-colors hover:text-hifi-accent/80"
            >
              {t('circles.detail.manageSkills')}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-4 grid gap-2.5">
            {skillRows.map(row => (
              <CircleWorkRowView key={row.id} row={row} handlers={handlers} />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function CircleWorkRowView({
  row,
  handlers,
}: {
  row: CircleWorkRow
  handlers: {
    onOpenWork: CircleDetailPageProps['onOpenWork']
    onInstallWork: CircleDetailPageProps['onInstallWork']
    onRejoin?: () => void
    onRenew?: () => void
  }
}) {
  const { t } = useTranslation()
  const status = WORK_STATUS_TONE[row.availability]
  const statusLabel =
    row.availability === 'stillAuthorized' && row.fallbackNote?.circleName
      ? t('circles.work.status.stillAuthorized', {
          circle: row.fallbackNote.circleName,
        })
      : t(status.key)
  const fallback = fallbackLine(row, t)

  return (
    <article
      data-testid="circle-work-row"
      className="flex flex-wrap items-center gap-4 rounded-hifi-inner border border-hifi-border bg-hifi-surface p-4 shadow-minimal"
    >
      <div className="min-w-0 flex-1">
        <h3 className="m-0 text-hifi-md font-semibold text-hifi-foreground">
          {row.name}
        </h3>
        {row.description && (
          <p className="m-0 mt-0.5 text-hifi-base text-hifi-fg-60">{row.description}</p>
        )}
        <p className="m-0 mt-1 text-hifi-base text-hifi-fg-50">{sourceLine(row, t)}</p>
        {fallback && (
          <p className="m-0 mt-0.5 text-hifi-base text-hifi-fg-50">{fallback}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={status.tone}>{statusLabel}</StatusPill>
        {workRowActions(row, handlers, t)}
      </div>
    </article>
  )
}
