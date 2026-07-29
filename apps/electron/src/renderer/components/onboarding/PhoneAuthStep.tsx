import { useEffect, useMemo, useState } from "react"
import type { FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AdminSendPhoneAuthCodeResult } from "../../../shared/types"
import {
  createPhoneAuthChallengeToken,
  maskMainlandPhone,
  normalizeMainlandPhoneInput,
  normalizeVerificationCode,
} from "./phone-auth-utils"

interface PhoneAuthStepProps {
  isLoading: boolean
  onClearError: () => void
  onSendCode: (phone: string, challengeToken: string) => Promise<AdminSendPhoneAuthCodeResult>
  onVerify: (phone: string, code: string) => void
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
  const [mode, setMode] = useState<"entry" | "verify">("entry")
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [consented, setConsented] = useState(false)
  const [resendSeconds, setResendSeconds] = useState(0)

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setInterval(() => {
      setResendSeconds(value => Math.max(0, value - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendSeconds])

  const phoneIsValid = /^1\d{10}$/.test(phone)
  const maskedPhone = useMemo(() => maskMainlandPhone(phone), [phone])

  const sendCode = async () => {
    if (isLoading || !phoneIsValid) return
    const result = await onSendCode(phone, createPhoneAuthChallengeToken())
    if (!result.success) return
    setCode("")
    setResendSeconds(Math.max(0, Math.ceil(result.resendAfter)))
    setMode("verify")
  }

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!consented) return
    await sendCode()
  }

  const handleVerify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isLoading || code.length !== 6) return
    onVerify(phone, code)
  }

  const handleEditPhone = () => {
    setMode("entry")
    setCode("")
    setResendSeconds(0)
    onClearError()
  }

  return (
    <>
      <div className="mt-5 grid grid-cols-2 rounded-[10px] bg-foreground/5 p-1" role="tablist" aria-label={t("onboarding.adminLogin.methodAriaLabel")}>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="rounded-[8px] bg-background px-3 py-2 text-sm font-medium text-foreground shadow-xs"
        >
          {t("onboarding.adminLogin.phoneAuth")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          onClick={onUsePassword}
          disabled={isLoading}
          className="rounded-[8px] px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {t("onboarding.adminLogin.passwordLogin")}
        </button>
      </div>

      {mode === "entry" ? (
        <form onSubmit={handleSend} className="mt-5 space-y-4">
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
                value={phone}
                onChange={(event) => {
                  setPhone(normalizeMainlandPhoneInput(event.target.value))
                  onClearError()
                }}
                disabled={isLoading}
                className="h-11 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted-foreground">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
              disabled={isLoading}
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
            type="submit"
            disabled={isLoading || !phoneIsValid || !consented}
            className="h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
          >
            {isLoading ? (
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
        <form onSubmit={handleVerify} className="mt-5 space-y-4">
          <div className="flex items-center justify-between rounded-[10px] bg-foreground/5 px-3 py-2.5 text-sm">
            <strong className="font-medium text-foreground">{maskedPhone}</strong>
            <button
              type="button"
              onClick={handleEditPhone}
              disabled={isLoading}
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
                value={code}
                onChange={(event) => {
                  setCode(normalizeVerificationCode(event.target.value))
                  onClearError()
                }}
                disabled={isLoading}
                autoFocus
                className="h-11 min-w-0 flex-1 rounded-[10px] bg-foreground-2 tracking-[0.25em]"
              />
              <Button
                type="button"
                variant="outline"
                disabled={isLoading || resendSeconds > 0}
                onClick={sendCode}
                className="h-11 shrink-0 rounded-[10px]"
              >
                {resendSeconds > 0
                  ? t("onboarding.adminLogin.resendIn", { seconds: resendSeconds })
                  : t("onboarding.adminLogin.resend")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("onboarding.adminLogin.codeExpires")}</p>
          </div>

          <Button
            type="submit"
            disabled={isLoading || code.length !== 6}
            className="h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
          >
            {isLoading ? (
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
