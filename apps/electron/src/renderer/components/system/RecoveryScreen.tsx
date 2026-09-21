import * as React from 'react'
import { StateIconTile, type HifiStateIconKind, type StateCardFact } from '@/components/hifi'
import { cn } from '@/lib/utils'

export interface RecoveryScreenProps {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Recovery checklist rows: session / tabs / tasks with their real status. */
  facts?: StateCardFact[]
  actions?: React.ReactNode
  icon?: { kind: HifiStateIconKind } | null
  className?: string
}

/**
 * RecoveryScreen — reopen recovery card (WS-LOGIN, g4 `.recovery-card`):
 * surfaces what a reopen actually restored — sessions, tabs and per-task
 * status — so nothing is presented as finished that is not (PC-F10).
 * Rendered inside the workspace area; not a fixed overlay.
 */
export function RecoveryScreen({
  eyebrow,
  title,
  description,
  facts,
  actions,
  icon = { kind: 'info' },
  className,
}: RecoveryScreenProps) {
  return (
    <section
      data-testid="recovery-card"
      className={cn(
        'mx-auto grid w-full max-w-[620px] justify-items-center rounded-hifi-card border border-hifi-border bg-hifi-surface p-[30px] text-center shadow-middle',
        className,
      )}
    >
      {icon && <StateIconTile kind={icon.kind} className="mb-[18px]" />}
      {eyebrow != null && <p className="hifi-eyebrow">{eyebrow}</p>}
      <h2 className="m-0 text-hifi-heading text-hifi-foreground">{title}</h2>
      {description != null && (
        <p className="m-0 mt-[9px] text-hifi-md leading-[1.58] text-hifi-fg-60">
          {description}
        </p>
      )}
      {facts && facts.length > 0 && (
        <dl className="mt-[22px] grid w-full overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left">
          {facts.map((fact, index) => (
            <div
              key={index}
              className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-[13px] py-[11px] text-hifi-base last:border-b-0"
            >
              <dt className="text-hifi-fg-50">{fact.label}</dt>
              <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {actions != null && (
        <div className="mt-[22px] flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </section>
  )
}
