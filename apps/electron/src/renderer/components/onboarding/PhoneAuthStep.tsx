import { useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AdminLoginMethodSwitch } from "./AdminLoginMethodSwitch"
import { LoginTrustRow } from "./LoginTrustRow"
import type { AdminSendPhoneAuthCodeResult } from "../../../shared/types"
import {
  canSendPhoneAuthCode,
  canVerifyPhoneAuthCode,
  createExclusiveRunner,
  getRemainingPhoneAuthResendSeconds,
  INITIAL_PHONE_AUTH_FORM_STATE,
  maskMainlandPhone,
  reducePhoneAuthForm,
} from "./phone-auth-utils"

interface PhoneAuthStepProps {
  isLoading: boolean
  onClearError: () => void
  resendDeadlines: ReadonlyMap<string, number>
  onSendCode: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  onCodeSent: (phone: string, resendAfter: number) => void
  onVerify: (phone: string, code: string) => Promise<boolean>
  onUsePassword: () => void
  /** Shared inline error surface, rendered below the panel heading. */
  errorNode?: ReactNode
}

export function PhoneAuthStep({
  isLoading,
  onClearError,
  resendDeadlines,
  onSendCode,
  onCodeSent,
  onVerify,
  onUsePassword,
  errorNode = null,
}: PhoneAuthStepProps) {
  const { t } = useTranslation()
  const [form, dispatch] = useReducer(reducePhoneAuthForm, INITIAL_PHONE_AUTH_FORM_STATE)
  const [isSending, setIsSending] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [countdownTick, setCountdownTick] = useState(0)
  const sendRunner = useRef(createExclusiveRunner())
  const verifyRunner = useRef(createExclusiveRunner())
  const resendDeadline = resendDeadlines.get(form.phone)
  const resendSeconds = getRemainingPhoneAuthResendSeconds(resendDeadline)

  useEffect(() => {
    if (resendSeconds <= 0 || resendDeadline === undefined) return
    const timer = window.setTimeout(() => {
      setCountdownTick(value => value + 1)
    }, Math.min(1_000, Math.max(1, resendDeadline - Date.now())))
    return () => window.clearTimeout(timer)
  }, [countdownTick, resendDeadline, resendSeconds])

  const canSend = canSendPhoneAuthCode(form) && resendSeconds === 0
  const canVerify = canVerifyPhoneAuthCode(form)
  const isBusy = isLoading || isSending || isVerifying
  const maskedPhone = useMemo(() => maskMainlandPhone(form.phone), [form.phone])

  const sendCode = async () => {
    if (isBusy || !canSend) return
    const result = await sendRunner.current.run(async () => {
      setIsSending(true)
      try {
        return await onSendCode(form.phone)
      } finally {
        setIsSending(false)
      }
    })
    if (result?.success) {
      onCodeSent(form.phone, result.resendAfter)
      dispatch({ type: 'codeSent' })
    }
  }

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSend) return
    await sendCode()
  }

  const handleVerify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isBusy || !canVerify) return
    void verifyRunner.current.run(async () => {
      setIsVerifying(true)
      try {
        return await onVerify(form.phone, form.code)
      } finally {
        setIsVerifying(false)
      }
    })
  }

  const handleEditPhone = () => {
    dispatch({ type: 'phoneEditRequested' })
    onClearError()
  }

  const primaryButtonClassName
    = "h-10 w-full rounded-[8px] bg-accent text-[12px] font-medium text-primary-foreground hover:bg-accent/90"

  if (form.mode === "entry") {
    return (
      <>
        {/* Prototype `.login-panel` heading for the code-request scene. */}
        <h2 className="m-0 text-[22px] font-semibold text-foreground">
          {t("onboarding.adminLogin.phoneAuth")}
        </h2>
        <p className="mt-2 text-[12px] leading-[1.55] text-foreground-50">
          {t("onboarding.adminLogin.phoneAuthSubtitle")}
        </p>
        {errorNode}
        <form data-testid="phone-auth-entry" onSubmit={handleSend} className="mt-5 grid gap-[15px]">
          <div className="grid gap-[7px] text-[11px] font-semibold text-foreground-60">
            <label htmlFor="phone-auth-phone">{t("onboarding.adminLogin.phone")}</label>
            <span className="flex h-11 overflow-hidden rounded-[10px] border border-border bg-foreground-3 focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]">
              <span className="flex items-center border-r border-border px-[12px] text-[12px] font-medium text-foreground-50">+86</span>
              <Input
                id="phone-auth-phone"
                aria-label={t("onboarding.adminLogin.phone")}
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder={t("onboarding.adminLogin.phonePlaceholder")}
                value={form.phone}
                onChange={(event) => {
                  dispatch({ type: 'phoneChanged', value: event.target.value })
                  onClearError()
                }}
                disabled={isBusy}
                className="h-11 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </span>
          </div>

          <Button
            data-testid="phone-auth-send-code"
            type="submit"
            disabled={isBusy || !canSend}
            className={primaryButtonClassName}
          >
            {isSending ? (
              <>
                <Spinner className="mr-1.5" />
                {t("onboarding.adminLogin.sendingCode")}
              </>
            ) : resendSeconds > 0 ? (
              t("onboarding.adminLogin.resendIn", { count: resendSeconds })
            ) : (
              t("onboarding.adminLogin.sendCode")
            )}
          </Button>

          <AdminLoginMethodSwitch
            target="password"
            disabled={isBusy}
            onSwitch={onUsePassword}
          />
        </form>

        <LoginTrustRow
          checked={form.consented}
          onCheckedChange={value => dispatch({ type: 'consentChanged', value })}
          disabled={isBusy}
        >
          {t("onboarding.adminLogin.legalPrefix")}{" "}
          <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.terms")}</span>
          {" "}{t("onboarding.adminLogin.legalJoin")}{" "}
          <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.privacy")}</span>
        </LoginTrustRow>
      </>
    )
  }

  return (
    <>
      {/* Prototype `.login-panel` heading for the code-entry scene. */}
      <h2 className="m-0 text-[22px] font-semibold text-foreground">
        {t("onboarding.adminLogin.code")}
      </h2>
      <p className="mt-2 text-[12px] leading-[1.55] text-foreground-50">
        {t("onboarding.adminLogin.codeSubtitle", { phone: maskedPhone })}
      </p>
      {errorNode}
      <form data-testid="phone-auth-verify" onSubmit={handleVerify} className="mt-5 grid gap-[15px]">
        <div className="flex items-center justify-between rounded-[10px] bg-foreground-3 px-3 py-2.5 text-sm">
          <strong className="font-medium text-foreground">{maskedPhone}</strong>
          <button
            type="button"
            onClick={handleEditPhone}
            disabled={isBusy}
            className="text-accent hover:underline disabled:opacity-50"
          >
            {t("onboarding.adminLogin.editPhone")}
          </button>
        </div>

        <label className="grid gap-[7px] text-[11px] font-semibold text-foreground-60">
          {t("onboarding.adminLogin.code")}
          <Input
            id="phone-auth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={t("onboarding.adminLogin.codePlaceholder")}
            value={form.code}
            onChange={(event) => {
              dispatch({ type: 'codeChanged', value: event.target.value })
              onClearError()
            }}
            disabled={isBusy}
            autoFocus
            className="h-11 min-w-0 rounded-[10px] border-border bg-foreground-3 tracking-[0.25em]"
          />
        </label>

        <Button
          data-testid="phone-auth-continue"
          type="submit"
          disabled={isBusy || !canVerify}
          className={primaryButtonClassName}
        >
          {isVerifying ? (
            <>
              <Spinner className="mr-1.5" />
              {t("onboarding.adminLogin.verifying")}
            </>
          ) : (
            t("onboarding.adminLogin.continue")
          )}
        </Button>

        <AdminLoginMethodSwitch
          target="password"
          disabled={isBusy}
          onSwitch={onUsePassword}
        />

        <Button
          type="button"
          variant="ghost"
          disabled={isBusy || resendSeconds > 0}
          onClick={sendCode}
          className="min-h-[28px] w-full rounded-[8px] text-[12px] font-medium text-foreground-60 hover:bg-foreground-5 hover:text-foreground"
        >
          {resendSeconds > 0
            ? t("onboarding.adminLogin.resendIn", { count: resendSeconds })
            : t("onboarding.adminLogin.resend")}
        </Button>
      </form>

      <p className="mt-[8px] text-[10px] leading-[1.4] text-foreground-50">
        {t("onboarding.adminLogin.codeExpires")}
      </p>

      <LoginTrustRow
        checked={form.consented}
        onCheckedChange={value => dispatch({ type: 'consentChanged', value })}
        disabled={isBusy}
      >
        {t("onboarding.adminLogin.legalPrefix")}{" "}
        <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.terms")}</span>
        {" "}{t("onboarding.adminLogin.legalJoin")}{" "}
        <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.privacy")}</span>
      </LoginTrustRow>
    </>
  )
}
