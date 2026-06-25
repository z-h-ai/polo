import * as Icons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AppDefinition } from '../../../shared/tab-browser-types'

interface AppIconProps {
  app: AppDefinition
  onOpen: (app: AppDefinition) => void
  onRemove?: (app: AppDefinition) => void
  className?: string
}

const FALLBACK_COLORS = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-600',
  'bg-lime-600',
  'bg-fuchsia-600',
]

function colorForName(name: string) {
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
}

export function AppIcon({ app, onOpen, onRemove, className }: AppIconProps) {
  const isBuiltin = app.type === 'builtin'

  return (
    <button
      type="button"
      className={cn(
        'group titlebar-no-drag flex min-w-0 flex-col items-center gap-2 rounded-lg p-2 text-center outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={() => onOpen(app)}
      onContextMenu={(event) => {
        if (isBuiltin || !onRemove) return
        event.preventDefault()
        if (window.confirm(`Remove ${app.name}?`)) {
          onRemove(app)
        }
      }}
    >
      <span className="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground/5 shadow-xs">
        {app.iconUrl ? (
          <img src={app.iconUrl} alt="" className="h-full w-full object-cover" />
        ) : isBuiltin ? (
          <Icons.Sparkles className="h-9 w-9 text-foreground/75" strokeWidth={1.5} />
        ) : (
          <span className={cn('flex h-full w-full items-center justify-center text-2xl font-semibold text-white', colorForName(app.name))}>
            {app.name.trim().slice(0, 1).toUpperCase() || '?'}
          </span>
        )}
      </span>
      <span className="line-clamp-2 min-h-9 max-w-[96px] text-sm leading-[18px] text-foreground/85">
        {app.name}
      </span>
    </button>
  )
}
