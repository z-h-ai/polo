import * as React from 'react'
import {
  HandoffCard,
  StateCard,
  SystemScreen,
  type StateCardFact,
  type StateCardIconKind,
} from '@/components/hifi'
import { cn } from '@/lib/utils'

export interface HandoffPageProps {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  icon?: { kind: StateCardIconKind } | null
  /**
   * `split` — the two-column browser/desktop responsibility card
   * (shared `HandoffCard`), used when the other side owns the action.
   * `facts` — fact-sheet layout (shared `StateCard`) for mismatch/pending
   * states whose payload is account/space data.
   */
  layout?: 'split' | 'facts'
  browserResponsibilities?: React.ReactNode[]
  desktopResponsibilities?: React.ReactNode[]
  browserLabel?: React.ReactNode
  desktopLabel?: React.ReactNode
  facts?: StateCardFact[]
  actions?: React.ReactNode
  className?: string
}

/**
 * HandoffPage — full-window browser handoff surface (WS-LOGIN): cross-device
 * scenes where the system browser carries part of the flow (circle invites,
 * enterprise creation, support requests, download guidance) while the
 * desktop keeps its own responsibilities.
 */
export function HandoffPage({
  eyebrow,
  title,
  description,
  icon = { kind: 'info' },
  layout = 'split',
  browserResponsibilities,
  desktopResponsibilities,
  browserLabel,
  desktopLabel,
  facts,
  actions,
  className,
}: HandoffPageProps) {
  return (
    <SystemScreen>
      {layout === 'facts' ? (
        <StateCard
          eyebrow={eyebrow}
          title={title}
          description={description}
          facts={facts}
          actions={actions}
          icon={icon ?? undefined}
          // g4 `.flow-state-page` proportions: 640px wide card, 26px title.
          className={cn('w-full max-w-[640px] [&_h1]:text-hifi-flow', className)}
        />
      ) : (
        <HandoffCard
          eyebrow={eyebrow}
          title={title}
          description={description}
          icon={icon}
          browserResponsibilities={browserResponsibilities ?? []}
          desktopResponsibilities={desktopResponsibilities ?? []}
          browserLabel={browserLabel}
          desktopLabel={desktopLabel}
          actions={actions}
          className={className}
        />
      )}
    </SystemScreen>
  )
}
