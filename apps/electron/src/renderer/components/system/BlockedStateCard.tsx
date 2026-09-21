import * as React from 'react'
import { StateIconTile, type HifiStateIconKind } from '@/components/hifi'
import { cn } from '@/lib/utils'

export interface BlockedStateCardProps {
  /** Scope line above the title, e.g. “晨星科技 · App 工作区”. */
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** Button row (g4 `.app-actions`): record links and recovery paths. */
  actions?: React.ReactNode
  /** Icon tile tone; blocked reasons default to destructive. */
  icon?: { kind: HifiStateIconKind } | null
  className?: string
}

/**
 * BlockedStateCard — app workspace blocked panel (WS-LOGIN, g4
 * `.app-workspace`): withdrawn / expired-source / version-paused apps and
 * offline-waiting workspaces. Kept as a plain exported card (not fixed, no
 * shell) so ws-home-apps can reuse it inside app views and inspectors.
 */
export function BlockedStateCard({
  eyebrow,
  title,
  description,
  actions,
  icon = { kind: 'destructive' },
  className,
}: BlockedStateCardProps) {
  return (
    <section
      data-testid="blocked-state-card"
      className={cn(
        'grid min-h-[450px] place-items-center content-center rounded-hifi-card border border-hifi-border bg-hifi-bg-elevated p-[30px] text-center',
        className,
      )}
    >
      <div className="grid max-w-full justify-items-center">
        {icon && (
          <StateIconTile
            kind={icon.kind}
            size={58}
            className="mb-[18px] rounded-hifi-edge"
          />
        )}
        {eyebrow != null && <p className="hifi-eyebrow">{eyebrow}</p>}
        <h2 className="m-0 text-hifi-heading font-semibold text-hifi-foreground">
          {title}
        </h2>
        {description != null && (
          <p className="m-0 mt-2 max-w-[620px] text-hifi-md leading-[1.55] text-hifi-fg-60">
            {description}
          </p>
        )}
        {actions != null && (
          <div className="mt-[22px] flex flex-wrap justify-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </section>
  )
}
