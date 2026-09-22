import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { getRemainingPhoneAuthResendSeconds } from '@/components/onboarding/phone-auth-utils'
import { HifiActionButton } from './primitives'

export interface PhoneCodeFormProps {
  code: string
  onCodeChange: (value: string) => void
  onVerify: () => void
  onResend: () => void
  onUsePassword: () => void
  /** Epoch ms before which the resend button stays disabled. */
  resendAt: number | undefined
  /** Epoch ms when the code expires (drives the “valid for” note). */
  expiresAt: number | undefined
  /** Blocks every action while a submit is in flight. */
  submitting?: boolean
  /** Test seam: fixed clock for the countdown. */
  now?: () => number
}

function useTicker(enabled: boolean, now: () => number) {
  const [instant, setInstant] = React.useState(now)
  React.useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setInstant(now()), 1_000)
    return () => window.clearInterval(timer)
  }, [enabled, now])
  return instant
}

/**
 * PhoneCodeForm — the verification-code entry (g4 auth form for the code
 * step): 6-digit field + verify / resend actions with the resend countdown.
 * Errors render inline in LoginScreen; this form never opens dialogs.
 */
export function PhoneCodeForm({
  code,
  onCodeChange,
  onVerify,
  onResend,
  onUsePassword,
  resendAt,
  expiresAt,
  submitting = false,
  now = Date.now,
}: PhoneCodeFormProps) {
  const { t } = useTranslation()
  const readNow = React.useCallback(now, [now])
  const current = useTicker(resendAt != null, readNow)
  const resendInSeconds = getRemainingPhoneAuthResendSeconds(resendAt, current)
  const expiresInSeconds =
    expiresAt == null ? 0 : Math.max(0, Math.ceil((expiresAt - current) / 1_000))
  const canVerify = code.length === 6 && !submitting

  return (
    <>
      <form
        className="mt-5 grid gap-[15px]"
        onSubmit={(event) => {
          event.preventDefault()
          if (canVerify) onVerify()
        }}
      >
        <label className="grid gap-[7px] text-hifi-sm font-semibold text-hifi-fg-60">
          <span>{t('login.field.code')}</span>
          <input
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            className="h-11 rounded-hifi-inner border border-hifi-border bg-hifi-fg-3 px-3 text-hifi-base font-normal text-hifi-foreground outline-none focus-visible:border-hifi-accent focus-visible:ring-3 focus-visible:ring-hifi-accent-soft"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={t('login.field.codePlaceholder')}
            aria-label={t('login.field.code')}
          />
        </label>
        <HifiActionButton
          variant="primary"
          type="submit"
          className="min-h-10"
          disabled={!canVerify}
        >
          {t('common.continue')}
        </HifiActionButton>
        <HifiActionButton
          variant="quiet"
          type="button"
          onClick={onUsePassword}
          disabled={submitting}
        >
          {t('login.action.switchToPassword')}
        </HifiActionButton>
        <HifiActionButton
          variant="quiet"
          type="button"
          onClick={() => {
            if (resendInSeconds === 0 && !submitting) onResend()
          }}
          disabled={resendInSeconds > 0 || submitting}
        >
          {t('login.action.resend')}
        </HifiActionButton>
      </form>
      <p className="m-0 mt-[5px] text-hifi-sm text-hifi-fg-50">
        {t('login.code.meta', {
          minutes: Math.max(1, Math.ceil(expiresInSeconds / 60)),
          seconds: resendInSeconds,
        })}
      </p>
    </>
  )
}
