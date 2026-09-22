/**
 * CreditsGate — pre-send credits block (POO-70 M09, PC-N03).
 *
 * Sits right above the composer: the drafted input stays fully preserved,
 * the send action stays unavailable, and the reason plus 去充值 are visible
 * on the same screen. Once a top-up arrives the gate switches to the resumed
 * banner (info tone) which only re-enables sending — continuing stays the
 * user's own action in the composer, so the banner carries no CTA.
 */

import { CircleCheck, Coins } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface CreditsGateProps {
  /** Credits the pending send needs. */
  needed: number
  /** Current balance snapshot. */
  balance: number
  /**
   * 'blocked' — PRE-BLOCK; 'resumed' — top-up arrived, send re-enabled by
   * the user only.
   */
  variant?: 'blocked' | 'resumed'
  /** 去充值 — opens the browser topup handoff. */
  onTopup?: () => void
  /**
   * 继续发送 — explicit user action after arrival. Kept for hosts that
   * wire the composer send button; the resumed banner itself renders no
   * CTA (arrival only lifts the block).
   */
  onContinueSend?: () => void
  className?: string
}

export function CreditsGate({
  needed,
  balance,
  variant = 'blocked',
  onTopup,
  className,
}: CreditsGateProps) {
  const { t } = useTranslation()
  const resumed = variant === 'resumed'

  return (
    <div
      data-testid={`credits-gate-${variant}`}
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2.5 rounded-hifi-md border px-3.5 py-2.5',
        resumed
          ? 'border-[color-mix(in_srgb,var(--hifi-info)_35%,var(--hifi-border))] bg-hifi-info-soft'
          : 'border-hifi-border bg-hifi-destructive-soft',
        className,
      )}
    >
      {resumed ? (
        <CircleCheck className="size-4 shrink-0 text-hifi-info" aria-hidden="true" />
      ) : (
        <Coins className="size-4 shrink-0 text-hifi-destructive" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 text-hifi-base text-hifi-foreground">
        {resumed ? (
          <>
            <strong className="font-semibold">
              {t('credits.gate.resumedTitle', { balance })}
            </strong>
            <span> · {t('credits.gate.resumedMessage')}</span>
          </>
        ) : (
          <>
            <strong className="font-semibold">{t('credits.gate.title')}</strong>
            <span>
              {' '}
              ·{' '}
              {t('credits.gate.needMessage', {
                needed,
                balance,
              })}
            </span>
          </>
        )}
      </span>
      {!resumed && (
        <button
          type="button"
          onClick={onTopup}
          className="inline-flex min-h-[28px] cursor-pointer items-center rounded-hifi-sm border border-hifi-border bg-hifi-surface px-3 py-[5px] text-hifi-base font-medium text-hifi-foreground transition-colors hover:bg-hifi-fg-3"
        >
          {t('credits.gate.topup')}
        </button>
      )}
    </div>
  )
}
