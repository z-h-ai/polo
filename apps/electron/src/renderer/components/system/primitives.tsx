import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * POO-70 WS-LOGIN local primitives — g4 `.button`, `.inline-alert` and
 * `.system-progress` rebuilt on the shared `--hifi-*` tokens.
 *
 * The hifi shared kit (components/hifi) has no button/alert primitives yet;
 * a request to promote these into the kit is filed in
 * `.ws-requests/ws-login.md`.
 */

export type HifiButtonVariant = 'default' | 'primary' | 'quiet'

export interface HifiButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: HifiButtonVariant
  className?: string
  children?: React.ReactNode
}

/** HifiActionButton — g4 `.button` / `.button.primary` / `.button.quiet`. */
export function HifiActionButton({
  variant = 'default',
  className,
  type = 'button',
  children,
  ...buttonProps
}: HifiButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-hifi-md border border-hifi-border bg-transparent px-3 text-hifi-base font-medium text-hifi-foreground transition-colors',
        'hover:bg-hifi-fg-5',
        'disabled:cursor-not-allowed disabled:opacity-48 disabled:hover:bg-transparent',
        variant === 'primary' &&
          'border-hifi-accent bg-hifi-accent text-hifi-on-accent hover:bg-hifi-accent',
        variant === 'quiet' && 'min-h-7',
        className,
      )}
      {...buttonProps}
    >
      {children}
    </button>
  )
}

export type InlineAlertTone = 'info' | 'bad'

export interface InlineAlertProps {
  tone?: InlineAlertTone
  className?: string
  children: React.ReactNode
}

/**
 * InlineAlert — g4 `.inline-alert`. Status notices rendered in place
 * (cancelled login, expired session, submit errors) instead of dialogs.
 */
export function InlineAlert({ tone = 'info', className, children }: InlineAlertProps) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={cn(
        'mt-[18px] grid grid-cols-[8px_minmax(0,1fr)] gap-[9px] rounded-hifi-md px-3 py-[11px] text-left text-hifi-base leading-[1.45] text-hifi-fg-70',
        tone === 'info' ? 'bg-hifi-info-soft' : 'bg-hifi-destructive-soft',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-[5px] size-1.5 rounded-full',
          tone === 'info' ? 'bg-hifi-info' : 'bg-hifi-destructive',
        )}
      />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export interface SystemProgressBarProps {
  /** 0–100. */
  value: number
  /** Caption below the bar (g4 `.system-progress-label`). */
  label?: React.ReactNode
  className?: string
}

/** SystemProgressBar — g4 `.system-progress` + `.system-progress-label`. */
export function SystemProgressBar({ value, label, className }: SystemProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)))
  return (
    <div className={cn('mt-6', className)}>
      <div className="h-[7px] overflow-hidden rounded-hifi-pill bg-hifi-fg-10">
        <div
          className="h-full rounded-hifi-pill bg-hifi-accent transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {label != null && (
        <p className="m-0 mt-2 text-hifi-xs text-hifi-fg-50">{label}</p>
      )}
    </div>
  )
}
