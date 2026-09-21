/**
 * Flow buttons on the hifi token scale (g4 `.button` variants).
 *
 * ws-shared's `components/hifi` kit does not ship a button primitive yet, so
 * these are the sanctioned "inline equivalent style" stand-ins (COMMON.md);
 * see `.ws-requests/ws-circles-account.md` for the hoisting request.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export type FlowButtonVariant = 'primary' | 'quiet' | 'danger'

const BASE_CLASS =
  'inline-flex min-h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-hifi-sm px-3 py-[6px] text-hifi-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hifi-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

const VARIANT_CLASS: Record<FlowButtonVariant, string> = {
  primary: 'bg-hifi-accent text-hifi-on-accent hover:bg-hifi-accent/90',
  quiet:
    'border border-hifi-border bg-hifi-surface text-hifi-foreground hover:bg-hifi-fg-3',
  danger:
    'bg-hifi-destructive text-hifi-on-accent hover:bg-hifi-destructive/90',
}

export interface FlowButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: FlowButtonVariant
}

/** Token-styled action button for circle/credits flow surfaces. */
export function FlowButton({
  variant = 'quiet',
  className,
  type = 'button',
  ...props
}: FlowButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE_CLASS, VARIANT_CLASS[variant], className)}
      {...props}
    />
  )
}
