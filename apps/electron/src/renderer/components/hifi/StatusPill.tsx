import * as React from 'react'
import { cn } from '@/lib/utils'

/** Tone of a status pill, mapped to g4 `.status` variants. */
export type StatusPillTone = 'success' | 'info' | 'destructive' | 'accent' | 'neutral'

export interface StatusPillProps {
  /** Semantic tone; picks the g4 soft background + text color pair. */
  tone: StatusPillTone
  children: React.ReactNode
  className?: string
}

/**
 * StatusPill — compact status badge with a leading dot (g4 `.status`).
 * Used for running/stopped/pending states in cards and rows. Rendering and
 * tone classes come from the shared `.hifi-state-pill` tokens.css classes.
 */
export function StatusPill({ tone, children, className }: StatusPillProps) {
  return (
    <span className={cn('hifi-state-pill', `hifi-state-pill--${tone}`, className)}>
      {children}
    </span>
  )
}
