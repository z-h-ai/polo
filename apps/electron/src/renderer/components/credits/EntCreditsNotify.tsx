/**
 * EntCreditsNotify — enterprise member credits state (POO-70 M09).
 *
 * Members cannot top up enterprise credits themselves; the notice states
 * that the admins have been notified. The app informs the Owner — it does
 * not decide anything on their behalf (no adjudication copy).
 */

import { Building2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface EntCreditsNotifyProps {
  /** 知道了 — acknowledges the notice. */
  onAcknowledge?: () => void
  className?: string
}

export function EntCreditsNotify({ onAcknowledge, className }: EntCreditsNotifyProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="ent-credits-notify"
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2.5 rounded-hifi-md border border-hifi-border bg-hifi-info-soft px-3.5 py-2.5',
        className,
      )}
    >
      <Building2 className="size-4 shrink-0 text-hifi-info" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-hifi-base text-hifi-foreground">
        <strong className="font-semibold">{t('credits.entNotify.title')}</strong>
        <span> · {t('credits.entNotify.message')}</span>
      </span>
      <button
        type="button"
        onClick={onAcknowledge}
        className="inline-flex min-h-[28px] cursor-pointer items-center rounded-hifi-sm border border-hifi-border bg-hifi-surface px-3 py-[5px] text-hifi-base font-medium text-hifi-foreground transition-colors hover:bg-hifi-fg-3"
      >
        {t('credits.entNotify.ack')}
      </button>
    </div>
  )
}
