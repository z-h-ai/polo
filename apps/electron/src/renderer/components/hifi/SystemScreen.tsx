import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SystemScreenProps {
  /**
   * `plain` — solid hifi background (g4 `.system-screen`).
   * `ambient` — adds the auth-style radial tint layer (g4 `.auth-ambient`).
   */
  variant?: 'plain' | 'ambient'
  /** Max width of the centered content column. Defaults to no constraint. */
  maxWidth?: number | string
  className?: string
  children: React.ReactNode
}

/**
 * SystemScreen — full-screen system state surface (g4 `.system-screen`).
 * Login, space switching, browser handoff and other full-window states sit
 * inside this container: centered content over the hifi background.
 *
 * Note: like the prototype it is `position: fixed; inset: 0` — in playground
 * demos wrap it in `playground/mocks/DemoFixedContainer` so the fixed layer
 * is clipped to the preview box.
 */
export function SystemScreen({
  variant = 'plain',
  maxWidth,
  className,
  children,
}: SystemScreenProps) {
  return (
    <div
      data-testid="hifi-system-screen"
      className={cn(
        'fixed inset-0 z-fullscreen grid place-items-center overflow-y-auto bg-hifi-background p-8',
        className,
      )}
    >
      {variant === 'ambient' && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0"
          style={{
            background:
              'radial-gradient(circle at 20% 16%, color-mix(in srgb, var(--hifi-accent) 12%, transparent), transparent 33%),' +
              'radial-gradient(circle at 86% 84%, color-mix(in srgb, var(--hifi-success) 8%, transparent), transparent 36%)',
          }}
        />
      )}
      <div
        className="relative grid w-full place-items-center justify-items-center"
        style={maxWidth != null ? { maxWidth } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
