import * as React from 'react'
import { cn } from '@/lib/utils'
import { StateIconTile, type HifiStateIconKind } from './StateIconTile'

export type StateCardIconKind = HifiStateIconKind

export interface StateCardFact {
  label: React.ReactNode
  value: React.ReactNode
}

export interface StateCardProps {
  /** Small uppercase label above the title (g4 `.eyebrow`). */
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Definition list rendered as g4 `.state-facts`. */
  facts?: StateCardFact[]
  /** Button row rendered as g4 `.state-actions` (centered, wrapping). */
  actions?: React.ReactNode
  /** Optional icon tile above the title (g4 `.state-icon`). */
  icon?: { kind: StateCardIconKind }
  className?: string
  /** Extra content below the facts (e.g. inline alert), still centered. */
  children?: React.ReactNode
}

/**
 * StateCard — centered system state card (g4 `.system-state-card`).
 * eyebrow + title + description + facts list + action row. Purely
 * presentational: callers pass translated strings and action buttons.
 */
export function StateCard({
  eyebrow,
  title,
  description,
  facts,
  actions,
  icon,
  className,
  children,
}: StateCardProps) {
  return (
    <section
      data-testid="hifi-state-card"
      className={cn(
        'w-[min(520px,100%)] rounded-hifi-card border border-hifi-border bg-hifi-surface p-[30px] text-center shadow-modal-small',
        className,
      )}
    >
      {icon && <StateIconTile kind={icon.kind} className="mx-auto mb-[18px]" />}
      {eyebrow != null && <p className="hifi-eyebrow">{eyebrow}</p>}
      <h1 className="m-0 text-hifi-state font-[720] tracking-[-0.035em] text-hifi-foreground">
        {title}
      </h1>
      {description != null && (
        <p className="mt-[9px] text-hifi-md text-hifi-fg-60">{description}</p>
      )}
      {facts && facts.length > 0 && (
        <dl className="mt-[22px] grid overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left">
          {facts.map((fact, index) => (
            <div
              key={index}
              className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-[13px] py-[11px] text-hifi-base last:border-b-0"
            >
              <dt className="text-hifi-fg-50">{fact.label}</dt>
              <dd className="m-0 min-w-0 font-medium [overflow-wrap:anywhere]">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
      {actions != null && (
        <div className="mt-[22px] flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </section>
  )
}
