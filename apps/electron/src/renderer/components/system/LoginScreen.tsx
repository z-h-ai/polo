import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { SystemScreen } from '@/components/hifi'
import {
  maskMainlandPhone,
} from '@/components/onboarding/phone-auth-utils'
import { useAuthFlow, type UseAuthFlowReturn } from '@/hooks/useAuthFlow'
import { cn } from '@/lib/utils'
import { PhoneCodeForm } from './PhoneCodeForm'
import { HifiActionButton, InlineAlert } from './primitives'

export interface LoginScreenProps {
  /**
   * Externally driven flow (real wiring). Omitted: the component runs its
   * own `useAuthFlow` with the demo adapter, so it renders standalone in
   * playground demos.
   */
  flow?: UseAuthFlowReturn
  /** Demo prefill for the masked password (prototype screenshots show it filled). */
  initialPassword?: string
  className?: string
}

function LoginBrandStory() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col justify-between bg-hifi-fg-3 p-[54px] max-md:hidden">
      <div>
        <div className="flex items-center gap-[9px] px-2 pb-4 pt-1 text-hifi-lg font-bold text-hifi-foreground">
          <span
            aria-hidden="true"
            className="grid size-[26px] place-items-center rounded-hifi-md bg-hifi-foreground text-hifi-base font-extrabold text-hifi-background"
          >
            P
          </span>
          <span>{t('login.brandName')}</span>
        </div>
        <h1 className="m-0 mt-6 max-w-[460px] text-hifi-display font-bold leading-[1.12] tracking-[-0.04em] text-hifi-foreground">
          {t('login.story.headline')}
        </h1>
        <p className="m-0 max-w-[430px] text-hifi-lg leading-[1.65] text-hifi-fg-50">
          {t('login.story.sub')}
        </p>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0">
        {[1, 2, 3].map((index) => (
          <li
            key={index}
            className="flex items-center gap-2.5 text-hifi-base text-hifi-foreground"
          >
            <span className="grid size-[21px] shrink-0 place-items-center rounded-full bg-hifi-success-soft text-hifi-success">
              <Check className="size-3" aria-hidden="true" strokeWidth={2.4} />
            </span>
            {t(`login.story.point${index}`)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function LoginPhoneField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <span className="grid h-11 grid-cols-[54px_minmax(0,1fr)] overflow-hidden rounded-hifi-inner border border-hifi-border bg-hifi-fg-3 outline-none focus-within:border-hifi-accent focus-within:ring-3 focus-within:ring-hifi-accent-soft">
      <b className="m-0 grid place-items-center border-r border-hifi-border text-hifi-base font-medium text-hifi-fg-50">
        +86
      </b>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 border-0 bg-transparent px-3 text-hifi-base font-normal text-hifi-foreground outline-none"
        type="tel"
        maxLength={11}
        inputMode="numeric"
        autoComplete="tel-national"
        aria-label={label}
      />
    </span>
  )
}

function LoginTrustRow({
  consented,
  onConsentChange,
}: {
  consented: boolean
  onConsentChange: (value: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-[18px] rounded-[9px] bg-hifi-fg-3 px-3 py-2.5 text-hifi-xs leading-[1.5] text-hifi-fg-50">
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => onConsentChange(event.target.checked)}
          aria-label={t('login.consent')}
          className="size-3 accent-hifi-accent"
        />
        <span>{t('login.consent')}</span>
      </label>
      <p className="m-0 mt-1 flex items-center gap-1.5">
        <Check className="size-3 text-hifi-success" aria-hidden="true" strokeWidth={2.4} />
        {t('login.firstRunNote')}
      </p>
    </div>
  )
}

function LoginNotice({ notice }: { notice: 'cancelled' | 'expired' | null }) {
  const { t } = useTranslation()
  if (notice === 'cancelled') {
    return <InlineAlert>{t('login.notice.cancelled')}</InlineAlert>
  }
  if (notice === 'expired') {
    return <InlineAlert tone="bad">{t('login.notice.expired')}</InlineAlert>
  }
  return null
}

/**
 * LoginScreen — the g4 login-split surface (WS-LOGIN, P-M01-LOGIN-*):
 * brand story column + password / phone-code entry column over the ambient
 * system screen. Cancelled and expired sessions render as inline alerts
 * (never dialogs); the code step delegates to `PhoneCodeForm`.
 *
 * Seam: this component owns only the login steps. Once the flow advances
 * (prepping / prepFailed / ready) it renders nothing — the parent surface
 * (App.tsx wiring, or the playground demo) swaps in `SystemStatePage` /
 * the product shell and is responsible for unmounting this screen.
 */
export function LoginScreen({ flow, initialPassword, className }: LoginScreenProps) {
  const { t } = useTranslation()
  const internal = useAuthFlow()
  const current = flow ?? internal
  const { state } = current
  const [password, setPassword] = React.useState(initialPassword ?? '')

  React.useEffect(() => {
    if (state.step === 'idle') current.start()
  }, [state.step, current])

  if (!current.isLoginStep && state.step !== 'idle') return null

  const step = state.step === 'idle' ? 'password' : state.step
  const canSubmitEntry = state.consented && state.phone.length === 11
  const canSubmitPassword = canSubmitEntry && password.length > 0

  const heading =
    step === 'phone'
      ? { title: t('login.phone.title'), subtitle: t('login.phone.subtitle') }
      : step === 'code'
        ? { title: t('login.code.title'), subtitle: '' }
        : { title: t('login.password.title'), subtitle: t('login.password.subtitle') }

  return (
    <SystemScreen variant="ambient" className={cn('px-6 pb-8 pt-12', className)}>
      <section
        data-testid="login-split"
        className={cn(
          'relative grid w-[min(960px,100%)] min-h-[570px] grid-cols-[1.08fr_.92fr] overflow-hidden rounded-[24px] border border-hifi-border bg-hifi-surface shadow-modal-small',
          'max-md:min-h-0 max-md:grid-cols-1 max-md:rounded-[18px]',
        )}
      >
        <LoginBrandStory />
        <div className="flex flex-col justify-center p-[46px] max-md:px-[22px] max-md:py-7">
          <p className="hifi-eyebrow">{t('login.eyebrow')}</p>
          <h2 className="m-0 text-hifi-page text-hifi-foreground">{heading.title}</h2>
          {heading.subtitle && (
            <p className="m-0 mt-2 text-hifi-base leading-[1.55] text-hifi-fg-50">
              {heading.subtitle}
            </p>
          )}
          <LoginNotice notice={state.notice} />
          {state.error && (
            <InlineAlert tone="bad" className="mt-3">
              {t('login.error.submitFailed')}
            </InlineAlert>
          )}
          {step === 'code' && (
            <>
              <p className="m-0 mt-2 text-hifi-base leading-[1.55] text-hifi-fg-50">
                {t('login.code.subtitle', { phone: maskMainlandPhone(state.phone) })}
              </p>
              <PhoneCodeForm
                code={state.code}
                onCodeChange={current.setCode}
                onVerify={() => current.submitCode(state.phone, state.code)}
                onResend={() => current.sendCode(state.phone)}
                onUsePassword={() => current.switchMode('password')}
                resendAt={state.codeResendAt}
                expiresAt={state.codeExpiresAt}
              />
            </>
          )}
          {step === 'password' && (
            <form
              className="mt-5 grid gap-[15px]"
              onSubmit={(event) => {
                event.preventDefault()
                if (canSubmitPassword) current.submitPassword(state.phone, password)
              }}
            >
              <label className="grid gap-[7px] text-hifi-sm font-semibold text-hifi-fg-60">
                <span>{t('login.field.phone')}</span>
                <LoginPhoneField
                  value={state.phone}
                  onChange={current.setPhone}
                  label={t('login.field.phone')}
                />
              </label>
              <label className="grid gap-[7px] text-hifi-sm font-semibold text-hifi-fg-60">
                <span>{t('login.field.password')}</span>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-11 rounded-hifi-inner border border-hifi-border bg-hifi-fg-3 px-3 text-hifi-base font-normal text-hifi-foreground outline-none focus-visible:border-hifi-accent focus-visible:ring-3 focus-visible:ring-hifi-accent-soft"
                  type="password"
                  placeholder={t('login.field.passwordPlaceholder')}
                  autoComplete="current-password"
                  aria-label={t('login.field.password')}
                />
              </label>
              <HifiActionButton
                variant="primary"
                type="submit"
                className="min-h-10"
                disabled={!canSubmitPassword}
              >
                {t('common.continue')}
              </HifiActionButton>
              <HifiActionButton
                variant="quiet"
                type="button"
                onClick={() => current.switchMode('phone')}
              >
                {t('login.action.useCode')}
              </HifiActionButton>
            </form>
          )}
          {step === 'phone' && (
            <form
              className="mt-5 grid gap-[15px]"
              onSubmit={(event) => {
                event.preventDefault()
                if (canSubmitEntry) current.sendCode(state.phone)
              }}
            >
              <label className="grid gap-[7px] text-hifi-sm font-semibold text-hifi-fg-60">
                <span>{t('login.field.phone')}</span>
                <LoginPhoneField
                  value={state.phone}
                  onChange={current.setPhone}
                  label={t('login.field.phone')}
                />
              </label>
              <HifiActionButton
                variant="primary"
                type="submit"
                className="min-h-10"
                disabled={!canSubmitEntry}
              >
                {t('login.action.sendCode')}
              </HifiActionButton>
              <HifiActionButton
                variant="quiet"
                type="button"
                onClick={() => current.switchMode('password')}
              >
                {t('login.action.usePassword')}
              </HifiActionButton>
            </form>
          )}
          <LoginTrustRow
            consented={state.consented}
            onConsentChange={current.setConsented}
          />
        </div>
      </section>
    </SystemScreen>
  )
}
