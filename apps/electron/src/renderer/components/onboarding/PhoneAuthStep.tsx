import { useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AdminLoginMethodTabs } from "./AdminLoginMethodTabs"
import type { AdminSendPhoneAuthCodeResult } from "../../../shared/types"
import {
  canSendPhoneAuthCode,
  canVerifyPhoneAuthCode,
  createExclusiveRunner,
  INITIAL_PHONE_AUTH_FORM_STATE,
  maskMainlandPhone,
  reducePhoneAuthForm,
} from "./phone-auth-utils"

interface PhoneAuthStepProps {
  isLoading: boolean
  onClearError: () => void
  onSendCode: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  onVerify: (phone: string, code: string) => Promise<boolean>
  onUsePassword: () => void
}

export function PhoneAuthStep({
  isLoading,
  onClearError,
  onSendCode,
  onVerify,
  onUsePassword,
}: PhoneAuthStepProps) {
  const { t } = useTranslation()
  const [form, dispatch] = useReducer(reducePhoneAuthForm, INITIAL_PHONE_AUTH_FORM_STATE)
  const [isSending, setIsSending] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const sendRunner = useRef(createExclusiveRunner())
  const verifyRunner = useRef(createExclusiveRunner())

  useEffect(() => {
    if (form.resendSeconds <= 0) return
    const timer = window.setInterval(() => {
      dispatch({ type: 'countdownTicked' })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [form.resendSeconds])

  const canSend = canSendPhoneAuthCode(form)
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
      dispatch({ type: 'codeSent', resendAfter: result.resendAfter })
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

  return (
    <>
      <AdminLoginMethodTabs
        value="phone"
        disabled={isBusy}
        onChange={onUsePassword}
      />

      {form.mode === "entry" ? (
        <form data-testid="phone-auth-entry" onSubmit={handleSend} className="mt-5 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phone-auth-phone" className="text-xs text-foreground/70">
              {t("onboarding.adminLogin.phone")}
            </Label>
            <div className="flex h-11 overflow-hidden rounded-[10px] bg-foreground-2 ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
              <span className="flex items-center border-r border-border/60 px-3 text-sm text-muted-foreground">+86</span>
              <Input
                id="phone-auth-phone"
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
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted-foreground">
            <input
              data-testid="phone-auth-consent"
              type="checkbox"
              checked={form.consented}
              onChange={(event) => dispatch({ type: 'consentChanged', value: event.target.checked })}
              disabled={isBusy}
              className="mt-1 size-3.5 accent-[var(--accent)]"
            />
            <span>
              {t("onboarding.adminLogin.legalPrefix")}{" "}
              <span className="text-foreground/80 underline underline-offset-2">{t("onboarding.adminLogin.terms")}</span>
              {" "}{t("onboarding.adminLogin.legalJoin")}{" "}
              <span className="text-foreground/80 underline underline-offset-2">{t("onboarding.adminLogin.privacy")}</span>
            </span>
          </label>

          <Button
            data-testid="phone-auth-send-code"
            type="submit"
            disabled={isBusy || !canSend}
            className="h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
          >
            {isSending ? (
              <>
                <Spinner className="mr-1.5" />
                {t("onboarding.adminLogin.sendingCode")}
              </>
            ) : (
              t("onboarding.adminLogin.sendCode")
            )}
          </Button>
        </form>
      ) : (
        <form data-testid="phone-auth-verify" onSubmit={handleVerify} className="mt-5 space-y-4">
          <div className="flex items-center justify-between rounded-[10px] bg-foreground/5 px-3 py-2.5 text-sm">
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

          <div className="space-y-2">
            <Label htmlFor="phone-auth-code" className="text-xs text-foreground/70">
              {t("onboarding.adminLogin.code")}
            </Label>
            <div className="flex gap-2">
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
                className="h-11 min-w-0 flex-1 rounded-[10px] bg-foreground-2 tracking-[0.25em]"
              />
              <Button
                type="button"
                variant="outline"
                disabled={isBusy || form.resendSeconds > 0}
                onClick={sendCode}
                className="h-11 shrink-0 rounded-[10px]"
              >
                {form.resendSeconds > 0
                  ? t("onboarding.adminLogin.resendIn", { count: form.resendSeconds })
                  : t("onboarding.adminLogin.resend")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("onboarding.adminLogin.codeExpires")}</p>
          </div>

          <Button
            data-testid="phone-auth-continue"
            type="submit"
            disabled={isBusy || !canVerify}
            className="h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
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
        </form>
      )}
    </>
  )
}
