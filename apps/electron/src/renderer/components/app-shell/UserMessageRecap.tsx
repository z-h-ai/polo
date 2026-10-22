/**
 * UserMessageRecap — floating single-line shortcut to the latest sent user
 * message (POO-111).
 *
 * Presentational only: the selection/geometry logic lives in
 * `user-message-recap.ts` and scheduling in `useUserMessageRecap.ts`.
 * Rendered as a sibling *outside* the messages fade mask so the mask never
 * dims it. The column is constrained to `CHAT_LAYOUT.maxWidth` — the same
 * 840px message column beneath it — so a long preview cannot stretch across
 * the whole panel. Native <button> gives Enter/Space activation for free; the
 * instant scroll in the hook keeps it reduced-motion safe.
 */

import { ArrowUp } from 'lucide-react'

import { CHAT_LAYOUT } from '@/config/layout'
import { cn } from '@/lib/utils'

import { truncateRecapTitle } from './user-message-recap'

export interface UserMessageRecapProps {
  /** One-line visible-text preview of the target message. */
  preview: string
  /** Accessible name (e.g. "Jump to your latest message"). */
  ariaLabel: string
  onClick: () => void
  compactMode?: boolean
}

export function UserMessageRecap({ preview, ariaLabel, onClick, compactMode = false }: UserMessageRecapProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
      <div
        className={cn(
          'mx-auto flex w-full justify-center',
          CHAT_LAYOUT.maxWidth,
          compactMode ? 'px-3 pt-1.5' : 'px-5 pt-2',
        )}
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          title={truncateRecapTitle(preview)}
          className={cn(
            'pointer-events-auto flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background text-muted-foreground shadow-tinted',
            'transition-colors hover:border-border hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60',
            compactMode ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
          )}
        >
          <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate whitespace-nowrap">{preview}</span>
        </button>
      </div>
    </div>
  )
}
