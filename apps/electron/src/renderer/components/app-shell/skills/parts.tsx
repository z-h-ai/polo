import * as React from 'react'
import { cn } from '@/lib/utils'

export type SkillActionVariant = 'quiet' | 'primary' | 'danger'

export interface SkillActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SkillActionVariant
}

const VARIANT_CLASS: Record<SkillActionVariant, string> = {
  quiet:
    'border border-hifi-border bg-hifi-surface text-hifi-foreground hover:bg-hifi-fg-5',
  primary:
    'border border-transparent bg-hifi-accent text-hifi-on-accent hover:opacity-90',
  danger:
    'border border-hifi-destructive/30 bg-hifi-surface text-hifi-destructive hover:bg-hifi-destructive-soft',
}

/**
 * SkillActionButton — the small action button used across skill manager
 * surfaces (g4 `.button` / `.button quiet` / `.button danger`).
 */
export function SkillActionButton({
  variant = 'quiet',
  className,
  type = 'button',
  ...props
}: SkillActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-7 shrink-0 items-center rounded-hifi-sm px-2.5 text-hifi-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        VARIANT_CLASS[variant],
        className,
      )}
      {...props}
    />
  )
}

export interface SkillFactItem {
  label: React.ReactNode
  value: React.ReactNode
}

export interface SkillFactsTableProps {
  facts: SkillFactItem[]
  className?: string
}

/**
 * SkillFactsTable — the definition list of skill facts (提供者 / 安装位置 /
 * 使用范围 / 版本 …, g4 `.skill-facts`). Shared by the install sheet, the
 * detail sheet and the share dialog.
 */
export function SkillFactsTable({ facts, className }: SkillFactsTableProps) {
  return (
    <dl
      className={cn(
        'grid overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left',
        className,
      )}
    >
      {facts.map((fact, index) => (
        <div
          key={index}
          className={cn(
            'grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-3 py-2.5 text-hifi-base last:border-b-0',
          )}
        >
          <dt className="m-0 text-hifi-fg-50">{fact.label}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}
