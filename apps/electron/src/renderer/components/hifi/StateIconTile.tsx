import * as React from 'react'
import { AlertCircle, CheckCircle2, Globe, Info, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Icon tile kinds, mapped to g4 `.state-icon` tone variants. */
export type HifiStateIconKind = 'info' | 'success' | 'destructive' | 'accent' | 'spinning'

const KIND_STYLES: Record<
  HifiStateIconKind,
  {
    Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
    tile: string
    spin: boolean
  }
> = {
  info: { Icon: Info, tile: 'bg-hifi-info-soft text-hifi-info', spin: false },
  success: { Icon: CheckCircle2, tile: 'bg-hifi-success-soft text-hifi-success', spin: false },
  destructive: { Icon: AlertCircle, tile: 'bg-hifi-destructive-soft text-hifi-destructive', spin: false },
  accent: { Icon: Globe, tile: 'bg-hifi-accent-soft text-hifi-accent', spin: false },
  spinning: { Icon: Loader2, tile: 'bg-hifi-info-soft text-hifi-info', spin: true },
}

export interface StateIconTileProps {
  kind: HifiStateIconKind
  /** Tile edge length in px. Defaults to the g4 52px state icon. */
  size?: number
  className?: string
}

/**
 * StateIconTile — rounded icon tile used by system state cards and handoff
 * cards (g4 `.state-icon`). Tone pairs come from the hifi soft tokens.
 */
export function StateIconTile({ kind, size = 52, className }: StateIconTileProps) {
  const { Icon, tile, spin } = KIND_STYLES[kind]
  // g4 keeps the inner glyph at ~48% of the tile edge (25/52, 27/58).
  const glyphSize = Math.round(size * 0.48)
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-hifi-edge', tile, className)}
      style={{ width: size, height: size }}
    >
      <Icon className={cn(spin && 'animate-spin')} style={{ width: glyphSize, height: glyphSize }} />
    </span>
  )
}
