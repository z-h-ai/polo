import * as React from 'react'
import { SystemScreen, StateCard, type StateCardProps } from '@/components/hifi'
import { cn } from '@/lib/utils'
import { InlineAlert, SystemProgressBar } from './primitives'

export interface SystemStatePageProps
  extends Omit<StateCardProps, 'className' | 'children'> {
  /** `ambient` adds the auth-style radial tint (g4 `.auth-ambient`). */
  variant?: 'plain' | 'ambient'
  /** Progress bar rendered below the facts (g4 `.system-progress`). */
  progress?: { value: number; label?: React.ReactNode }
  /** Inline alert rendered below the facts/progress (g4 `.inline-alert`). */
  alert?: { tone?: 'info' | 'bad'; children: React.ReactNode }
  /** Card-level notice rendered under the actions (g4 `.dialog-note` style). */
  note?: React.ReactNode
  className?: string
}

/**
 * SystemStatePage — full-window system state surface (WS-LOGIN): the shared
 * `SystemScreen` container composed with a `StateCard`. Used for personal
 * space preparation, cold-start revalidation, contract/update gates and the
 * account-restriction pages; purely presentational, copy comes via props.
 */
export function SystemStatePage({
  variant = 'plain',
  progress,
  alert,
  note,
  className,
  ...cardProps
}: SystemStatePageProps) {
  return (
    <SystemScreen variant={variant}>
      <StateCard
        {...cardProps}
        className={cn('w-[min(520px,100%)]', className)}
      >
        {progress && (
          <SystemProgressBar value={progress.value} label={progress.label} />
        )}
        {alert && <InlineAlert tone={alert.tone}>{alert.children}</InlineAlert>}
        {note != null && (
          <p className="m-0 mt-[18px] text-hifi-base leading-[1.5] text-hifi-fg-50">
            {note}
          </p>
        )}
      </StateCard>
    </SystemScreen>
  )
}
