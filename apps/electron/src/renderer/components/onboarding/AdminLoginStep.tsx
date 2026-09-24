import { useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { AlertTriangle, Check, Eye, EyeOff } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { PhoneAuthStep } from "./PhoneAuthStep"
import { AdminLoginMethodSwitch } from "./AdminLoginMethodSwitch"
import { LoginTrustRow } from "./LoginTrustRow"
import {
  createPhoneAuthResendDeadline,
  resolvePreferredAdminLoginMode,
} from "./phone-auth-utils"
import type { AdminSendPhoneAuthCodeResult } from "../../../shared/types"

interface AdminLoginStepProps {
  errorMessage?: string
  isLoading?: boolean
  phoneAuthEnabled?: boolean
  onClearError: () => void
  onSendPhoneCode: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  onVerifyPhoneCode: (phone: string, code: string) => Promise<boolean>
  onSubmit: (identifier: string, password: string) => void
}

const STORY_POINTS = [
  { key: "onboarding.adminLogin.storyPoint1" },
  { key: "onboarding.adminLogin.storyPoint2" },
  { key: "onboarding.adminLogin.storyPoint3" },
] as const

export function AdminLoginStep({
  errorMessage,
  isLoading = false,
  phoneAuthEnabled,
  onClearError,
  onSendPhoneCode,
  onVerifyPhoneCode,
  onSubmit,
}: AdminLoginStepProps) {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [consented, setConsented] = useState(true)
  const [loginMode, setLoginMode] = useState<"phone" | "password">(
    resolvePreferredAdminLoginMode(phoneAuthEnabled),
  )
  const [phoneAuthResendDeadlines, setPhoneAuthResendDeadlines] = useState<
    ReadonlyMap<string, number>
  >(() => new Map())

  useEffect(() => {
    if (phoneAuthEnabled !== undefined) {
      setLoginMode(resolvePreferredAdminLoginMode(phoneAuthEnabled))
    }
  }, [phoneAuthEnabled])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isLoading || !consented) return
    onSubmit(identifier.trim(), password)
  }

  const switchMode = (target: "phone" | "password") => {
    setLoginMode(target)
    onClearError()
  }

  const errorBlock: ReactNode = (
    <AnimatePresence initial={false}>
      {errorMessage ? (
        <motion.div
          key="admin-login-error"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="mt-[15px] flex items-start gap-2 rounded-[10px] border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{errorMessage}</span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )

  return (
    <div className="relative w-full max-w-[960px]" aria-label={t("onboarding.adminLogin.ariaLabel")}>
      {/* Ambient glow behind the split card (prototype `.auth-ambient`) */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(circle at 20% 16%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 33%), radial-gradient(circle at 86% 84%, color-mix(in srgb, var(--success) 8%, transparent), transparent 36%)",
        }}
      />

      <section className="relative grid min-h-[570px] grid-cols-[1.08fr_0.92fr] overflow-hidden rounded-[24px] border border-border bg-background shadow-modal-small max-lg:grid-cols-1 max-lg:min-h-0">
        {/* === LEFT: brand story (prototype `.login-story`) === */}
        <div className="flex flex-col justify-between gap-10 bg-foreground-3 p-[54px] max-lg:p-8">
          <div>
            <div className="flex items-center gap-[9px] pb-[16px] pl-[8px] pt-[4px]">
              <span className="grid size-[26px] flex-none place-items-center rounded-[8px] bg-foreground text-[13px] font-extrabold text-background">
                P
              </span>
              <span className="text-[14px] font-bold text-foreground">
                Polo AI
              </span>
            </div>
            <h1 className="mt-[24px] max-w-[460px] text-[36px] font-bold leading-[1.12] tracking-[-0.04em] text-foreground max-lg:mt-5 max-lg:text-[28px]">
              {t("onboarding.adminLogin.storyHeadline")}
            </h1>
            <p className="mt-[14px] max-w-[430px] text-[14px] leading-[1.65] text-foreground-50">
              {t("onboarding.adminLogin.storySub")}
            </p>
          </div>
          <div className="flex flex-col gap-[12px] max-lg:hidden">
            {STORY_POINTS.map(({ key }) => (
              <div key={key} className="flex items-center gap-[10px] text-[12px] text-foreground">
                <span className="grid size-[21px] flex-none place-items-center rounded-full bg-success/10 text-success">
                  <Check className="size-3" strokeWidth={2.4} />
                </span>
                {t(key)}
              </div>
            ))}
          </div>
        </div>

        {/* === RIGHT: login panel (existing auth logic, prototype `.login-panel`) === */}
        <div className="flex flex-col justify-center p-[46px] max-lg:p-7">
          <p className="m-0 text-[11px] font-medium tracking-[0.75px] text-foreground-50 uppercase">
            {t("onboarding.adminLogin.eyebrow")}
          </p>

          {phoneAuthEnabled === undefined ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground" aria-label={t("common.loading")}>
              <Spinner />
            </div>
          ) : loginMode === "phone" && phoneAuthEnabled ? (
            <PhoneAuthStep
              isLoading={isLoading}
              errorNode={errorBlock}
              onClearError={onClearError}
              resendDeadlines={phoneAuthResendDeadlines}
              onSendCode={onSendPhoneCode}
              onCodeSent={(phone, resendAfter) => {
                setPhoneAuthResendDeadlines(current => {
                  const next = new Map(current)
                  next.set(phone, createPhoneAuthResendDeadline(resendAfter))
                  return next
                })
              }}
              onVerify={onVerifyPhoneCode}
              onUsePassword={() => switchMode("password")}
            />
          ) : (
            <>
              {/* Prototype password scene: mode title + short lead, fields,
              the 继续 primary, the quiet mode switch, then the trust row. */}
              <h2 className="m-0 text-[22px] font-semibold text-foreground">
                {t("onboarding.adminLogin.passwordLogin")}
              </h2>
              <p className="mt-2 text-[12px] leading-[1.55] text-foreground-50">
                {t("onboarding.adminLogin.subtitle")}
              </p>
              {errorBlock}
              <form
                data-testid="admin-password-login-form"
                onSubmit={handleSubmit}
                className="mt-5 grid gap-[15px]"
              >
                <label className="grid gap-[7px] text-[11px] font-semibold text-foreground-60">
                  {t("onboarding.adminLogin.identifier")}
                  <Input
                    id="admin-identifier"
                    autoComplete="username"
                    placeholder={t("onboarding.adminLogin.identifierPlaceholder")}
                    value={identifier}
                    onChange={(event) => {
                      setIdentifier(event.target.value)
                      onClearError()
                    }}
                    disabled={isLoading}
                    className="h-11 rounded-[10px] border-border bg-foreground-3"
                  />
                </label>

                <div className="grid gap-[7px] text-[11px] font-semibold text-foreground-60">
                  <Label htmlFor="admin-password" className="text-[11px] font-semibold text-foreground-60">
                    {t("onboarding.adminLogin.password")}
                  </Label>
                  <div className="relative">
                    <Input
                      id="admin-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder={t("onboarding.adminLogin.passwordPlaceholder")}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        onClearError()
                      }}
                      disabled={isLoading}
                      className="h-11 rounded-[10px] border-border bg-foreground-3 pr-11"
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? t("onboarding.adminLogin.passwordHide") : t("onboarding.adminLogin.passwordShow")}
                      onClick={() => setShowPassword(value => !value)}
                      disabled={isLoading}
                      className={cn(
                        "absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-[8px] text-muted-foreground transition-colors",
                        "hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                      )}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={isLoading || !identifier.trim() || !password || !consented}
                  className="h-10 w-full rounded-[8px] bg-accent text-[12px] font-medium text-primary-foreground hover:bg-accent/90"
                >
                  {isLoading ? (
                    <>
                      <Spinner className="mr-1.5" />
                      {t("onboarding.adminLogin.signingIn")}
                    </>
                  ) : (
                    t("onboarding.adminLogin.continue")
                  )}
                </Button>

                {phoneAuthEnabled ? (
                  <AdminLoginMethodSwitch
                    target="phone"
                    disabled={isLoading}
                    onSwitch={() => switchMode("phone")}
                  />
                ) : null}
              </form>

              <LoginTrustRow
                checked={consented}
                onCheckedChange={setConsented}
                disabled={isLoading}
              >
                {t("onboarding.adminLogin.agreement")}
              </LoginTrustRow>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
