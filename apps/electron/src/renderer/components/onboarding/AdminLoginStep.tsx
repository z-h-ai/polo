import { useEffect, useState } from "react"
import type { FormEvent } from "react"
import { AlertTriangle, Check, Eye, EyeOff } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { PhoneAuthStep } from "./PhoneAuthStep"
import { AdminLoginMethodTabs } from "./AdminLoginMethodTabs"
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
    if (isLoading) return
    onSubmit(identifier.trim(), password)
  }

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
        <div className="flex flex-col justify-between gap-10 bg-foreground/3 p-[54px] max-lg:p-8">
          <div>
            <div className="flex items-center gap-[9px]">
              <span className="grid size-[30px] place-items-center rounded-[9px] bg-foreground text-[15px] font-extrabold text-background">
                P
              </span>
              <span className="text-[15px] font-bold tracking-[-0.03em] text-foreground">
                Polo AI
              </span>
            </div>
            <h1 className="mt-8 text-[28px] font-bold leading-[1.25] tracking-[-0.02em] text-foreground max-lg:mt-5 max-lg:text-[22px]">
              {t("onboarding.adminLogin.storyHeadline")}
            </h1>
            <p className="mt-3 max-w-[38ch] text-[13px] leading-[1.7] text-muted-foreground">
              {t("onboarding.adminLogin.storySub")}
            </p>
          </div>
          <div className="flex flex-col gap-[10px] max-lg:hidden">
            {STORY_POINTS.map(({ key }) => (
              <div key={key} className="flex items-center gap-[10px] text-[12px] text-foreground/75">
                <span className="grid size-[18px] flex-none place-items-center rounded-full bg-success/15 text-success">
                  <Check className="size-3" strokeWidth={2.2} />
                </span>
                {t(key)}
              </div>
            ))}
          </div>
        </div>

        {/* === RIGHT: login panel (existing auth logic, prototype `.login-panel`) === */}
        <div className="flex flex-col justify-center p-[46px] max-lg:p-7">
          <p className="m-0 text-[11px] font-medium uppercase tracking-[0.75px] text-foreground/50">
            {t("onboarding.adminLogin.eyebrow")}
          </p>
          <h2 className="mt-[7px] text-xl font-semibold text-foreground">
            {t("onboarding.adminLogin.title")}
          </h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {loginMode === "phone" && phoneAuthEnabled
              ? t("onboarding.adminLogin.phoneAuthSubtitle")
              : t("onboarding.adminLogin.subtitle")}
          </p>

          <AnimatePresence initial={false}>
            {errorMessage ? (
              <motion.div
                key="admin-login-error"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="mt-5 flex items-start gap-2 rounded-[10px] border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{errorMessage}</span>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {phoneAuthEnabled === undefined ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground" aria-label={t("common.loading")}>
              <Spinner />
            </div>
          ) : loginMode === "phone" && phoneAuthEnabled ? (
            <PhoneAuthStep
              isLoading={isLoading}
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
              onUsePassword={() => {
                setLoginMode("password")
                onClearError()
              }}
            />
          ) : (
            <>
              {phoneAuthEnabled ? (
                <AdminLoginMethodTabs
                  value="password"
                  disabled={isLoading}
                  onChange={() => {
                    setLoginMode("phone")
                    onClearError()
                  }}
                />
              ) : null}
              <form
                data-testid="admin-password-login-form"
                onSubmit={handleSubmit}
                className={cn("space-y-4", phoneAuthEnabled ? "mt-5" : "mt-6")}
              >
                <div className="space-y-2">
                  <Label htmlFor="admin-identifier" className="text-xs text-foreground/70">
                    {t("onboarding.adminLogin.identifier")}
                  </Label>
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
                    className="h-11 rounded-[10px] bg-foreground-2"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="admin-password" className="text-xs text-foreground/70">
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
                      className="h-11 rounded-[10px] bg-foreground-2 pr-11"
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
                  disabled={isLoading || !identifier.trim() || !password}
                  className="h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
                >
                  {isLoading ? (
                    <>
                      <Spinner className="mr-1.5" />
                      {t("onboarding.adminLogin.signingIn")}
                    </>
                  ) : (
                    t("onboarding.adminLogin.signIn")
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
