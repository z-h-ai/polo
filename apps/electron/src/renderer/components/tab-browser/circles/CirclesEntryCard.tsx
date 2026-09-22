/**
 * CirclesEntryCard — home surface 「我的圈子」 entry (POO-70 M07, D-PC-07).
 *
 * Mounted through `HomeSurfaceSlots.circlesEntry` (provider wiring belongs to
 * ws-home-apps / integration): next to 「全部 Apps」, not inside account
 * settings. Presentational — the host decides where tapping leads.
 */

import { ChevronRight, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface CirclesEntryCardProps {
  /** Number of joined circles (label under the title). */
  count: number
  onClick: () => void
  className?: string
}

export function CirclesEntryCard({ count, onClick, className }: CirclesEntryCardProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      data-testid="circles-entry-card"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-hifi-inner border border-hifi-border bg-hifi-surface p-3.5 text-left shadow-minimal transition-colors hover:bg-hifi-fg-3',
        className,
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-hifi-md bg-hifi-accent-soft text-hifi-accent">
        <UsersRound className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-hifi-lg font-semibold text-hifi-foreground">
          {t('circles.entry.title')}
        </span>
        <span className="block text-hifi-base text-hifi-fg-60">
          {t('circles.entry.count', { count })}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-hifi-fg-50" aria-hidden="true" />
    </button>
  )
}
