/**
 * StreamCutNotice — generation stopped mid-stream by insufficient credits
 * (POO-70 M09). The already generated part stays in the conversation and is
 * labeled as-is; the notice states that continuing is the user's decision
 * once the top-up arrives. Kept visually aligned with CreditsGate.
 */

import { Coins } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface StreamCutNoticeProps {
  /** 去充值 — opens the browser topup handoff (stream variant). */
  onTopup?: () => void
  className?: string
}

export function StreamCutNotice({ onTopup, className }: StreamCutNoticeProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="stream-cut-notice"
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2.5 rounded-hifi-md border border-hifi-border bg-hifi-destructive-soft px-3.5 py-2.5',
        className,
      )}
    >
      <Coins className="size-4 shrink-0 text-hifi-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-hifi-base text-hifi-foreground">
        <strong className="font-semibold">{t('credits.streamCut.title')}</strong>
        <span> · {t('credits.streamCut.message')}</span>
      </span>
      <button
        type="button"
        onClick={onTopup}
        className="inline-flex min-h-[28px] cursor-pointer items-center rounded-hifi-sm border border-hifi-border bg-hifi-surface px-3 py-[5px] text-hifi-base font-medium text-hifi-foreground transition-colors hover:bg-hifi-fg-3"
      >
        {t('credits.streamCut.topup')}
      </button>
    </div>
  )
}
