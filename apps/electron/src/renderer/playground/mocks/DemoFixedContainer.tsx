import * as React from 'react'
import { cn } from '@/lib/utils'

export interface DemoFixedContainerProps {
  /** Outer box width; defaults to 880 (tab-bar demo default). */
  width?: number | string
  /** Outer box height; defaults to 220. */
  height?: number | string
  /**
   * Optional zoom factor (e.g. 2.2 to inspect glyph alignment). The inner
   * layer is scaled from the top-left corner.
   */
  scale?: number
  className?: string
  /** Class for the inner (transformed) layer. */
  contentClassName?: string
  children: React.ReactNode
}

/**
 * DemoFixedContainer — clips `position: fixed` children (top bars, system
 * screens, overlays) to a playground preview box. The inner layer always
 * carries a transform, which makes it the containing block for fixed
 * descendants. Migrated from the tab-browser-shell demo's inline trick.
 */
export function DemoFixedContainer({
  width = 880,
  height = 220,
  scale,
  className,
  contentClassName,
  children,
}: DemoFixedContainerProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-background',
        className,
      )}
      style={{ width, height }}
    >
      <div
        className={cn('relative h-full w-full', contentClassName)}
        style={
          scale != null
            ? { transform: `scale(${scale})`, transformOrigin: 'top left' }
            : { transform: 'translateZ(0)' }
        }
      >
        {children}
      </div>
    </div>
  )
}
