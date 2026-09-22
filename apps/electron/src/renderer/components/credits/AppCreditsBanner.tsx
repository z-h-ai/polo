/**
 * AppCreditsBanner — non-modal container-level credits banner (POO-70 M09,
 * D-PC-07). A capability status line above an App's content: it gives every
 * App the same feedback without taking over the App's own interface. The
 * enterprise variant offers 通知管理员 (the Owner decides; the banner does
 * not adjudicate) — the personal variant links to the browser topup.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface AppCreditsBannerProps {
  /** 'enterprise' — member notifying the Owner; 'personal' — self topup. */
  scope?: 'enterprise' | 'personal'
  /** 通知管理员 / 去充值. */
  onAction?: () => void
  onDismiss?: () => void
  className?: string
}

export function AppCreditsBanner({
  scope = 'enterprise',
  onAction,
  onDismiss,
  className,
}: AppCreditsBannerProps) {
  const { t } = useTranslation()

  return (
    <div
      data-testid="app-credits-banner"
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2.5 border-b border-hifi-border bg-hifi-info-soft px-6 py-2.5',
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-hifi-md text-hifi-foreground">
        {scope === 'enterprise'
          ? t('credits.appBanner.enterpriseLow')
          : t('credits.appBanner.personalLow')}
      </span>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex min-h-[28px] cursor-pointer items-center rounded-hifi-sm border border-hifi-border bg-hifi-surface px-3 py-[5px] text-hifi-base font-medium text-hifi-foreground transition-colors hover:bg-hifi-fg-3"
        >
          {scope === 'enterprise'
            ? t('credits.appBanner.notifyAdmin')
            : t('credits.gate.topup')}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onDismiss}
          className="grid size-6 cursor-pointer place-items-center rounded-hifi-xs text-hifi-fg-50 transition-colors hover:bg-hifi-fg-5 hover:text-hifi-foreground"
        >
          <span aria-hidden="true" className="text-hifi-md">
            ×
          </span>
        </button>
      )}
    </div>
  )
}
