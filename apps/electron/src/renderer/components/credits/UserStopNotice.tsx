/**
 * UserStopNotice — the user stopped the generation themselves (POO-70 M09).
 *
 * Deliberately not a credits state: no topup CTA, no destructive tone. The
 * generated part so far and the drafted input stay preserved. Displayed as
 * an inline message-level notice, separate from any credits banner.
 */

import { Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface UserStopNoticeProps {
  className?: string
}

export function UserStopNotice({ className }: UserStopNoticeProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="user-stop-notice"
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-hifi-md bg-hifi-fg-3 px-3.5 py-2 text-hifi-base text-hifi-fg-70',
        className,
      )}
    >
      <Square className="size-3.5 shrink-0 fill-current" aria-hidden="true" />
      {t('credits.userStop.message')}
    </div>
  )
}
