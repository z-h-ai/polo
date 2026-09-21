import * as React from 'react'
import { Globe, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StateIconTile, type HifiStateIconKind } from './StateIconTile'

export type HandoffCardIconKind = HifiStateIconKind

export interface HandoffCardProps {
  title: React.ReactNode
  /** Small uppercase label above the title (g4 `.eyebrow`). */
  eyebrow?: React.ReactNode
  description?: React.ReactNode
  /** What the browser side takes care of (first column). */
  browserResponsibilities: React.ReactNode[]
  /** What the desktop app keeps responsibility for (second column). */
  desktopResponsibilities: React.ReactNode[]
  /** Optional column headers; when omitted the column icon stands alone. */
  browserLabel?: React.ReactNode
  desktopLabel?: React.ReactNode
  /** Button row (g4 `.state-actions`): primary action opens the browser. */
  actions?: React.ReactNode
  /** Icon tile above the title; defaults to info (as all handoff scenes). */
  icon?: { kind: HandoffCardIconKind } | null
  className?: string
}

function ResponsibilityList({
  icon: ColumnIcon,
  label,
  labelFallback,
  items,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  label?: React.ReactNode
  labelFallback: string
  items: React.ReactNode[]
  className?: string
}) {
  return (
    <div className={cn('grid content-start gap-[7px] p-4', className)}>
      <div className="flex items-center gap-2 text-hifi-sm font-medium uppercase tracking-[0.75px] text-hifi-fg-50">
        <ColumnIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {label != null ? <span>{label}</span> : <span className="sr-only">{labelFallback}</span>}
      </div>
      {items.map((item, index) => (
        <p key={index} className="m-0 flex items-start gap-2 text-hifi-base text-hifi-fg-60">
          <span aria-hidden="true" className="mt-[7px] size-[5px] shrink-0 rounded-full bg-hifi-fg-40" />
          <span className="min-w-0">{item}</span>
        </p>
      ))}
    </div>
  )
}

/**
 * HandoffCard — browser handoff card skeleton (g4 `.flow-state-page` variant).
 * Shared by the cross-device handoff scenes: title + two-column
 * responsibilities (browser vs desktop) + primary action. Callers provide
 * translated copy and the action buttons.
 */
export function HandoffCard({
  title,
  eyebrow,
  description,
  browserResponsibilities,
  desktopResponsibilities,
  browserLabel,
  desktopLabel,
  actions,
  icon = { kind: 'info' },
  className,
}: HandoffCardProps) {
  return (
    <section
      data-testid="hifi-handoff-card"
      className={cn(
        'w-full max-w-[640px] rounded-hifi-card border border-hifi-border bg-hifi-surface p-8 text-center shadow-middle',
        className,
      )}
    >
      {icon && <StateIconTile kind={icon.kind} className="mx-auto mb-[18px]" />}
      {eyebrow != null && <p className="hifi-eyebrow">{eyebrow}</p>}
      <h1 className="m-0 text-hifi-flow font-[720] tracking-[-0.035em] text-hifi-foreground">
        {title}
      </h1>
      {description != null && (
        <p className="mt-[9px] text-hifi-md text-hifi-fg-60">{description}</p>
      )}
      <div className="mt-[22px] grid w-full overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left sm:grid-cols-2">
        <ResponsibilityList
          icon={Globe}
          label={browserLabel}
          labelFallback="browser"
          items={browserResponsibilities}
        />
        <ResponsibilityList
          icon={Monitor}
          label={desktopLabel}
          labelFallback="desktop"
          items={desktopResponsibilities}
          className="border-t border-hifi-border sm:border-t-0 sm:border-l"
        />
      </div>
      {actions != null && (
        <div className="mt-[22px] flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </section>
  )
}
