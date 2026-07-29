import { useEffect, useState } from "react"
import type { CSSProperties, FormEvent } from "react"
import { AlertTriangle, Eye, EyeOff } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useTranslation } from "react-i18next"
import { Spinner } from "@polo-ai/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { PoloAiSymbol } from "@/components/icons/PoloAiSymbol"
import { PhoneAuthStep } from "./PhoneAuthStep"
import { AdminLoginMethodTabs } from "./AdminLoginMethodTabs"
import { resolvePreferredAdminLoginMode } from "./phone-auth-utils"
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
    <section
      className="w-full max-w-96 rounded-[20px] border border-white/20 bg-background/72 p-7 shadow-modal-small backdrop-blur-xl"
      style={{ WebkitBackdropFilter: "blur(24px)" }}
      aria-label={t("onboarding.adminLogin.ariaLabel")}
    >
      <div className="flex flex-col items-center text-center">
        <div
          className="flex size-12 items-center justify-center rounded-2xl text-background shadow-tinted"
          style={{
            background:
              "linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 58%, var(--foreground)))",
            "--shadow-color": "var(--accent-rgb)",
          } as CSSProperties}
        >
          <PoloAiSymbol className="size-7" />
        </div>
        <h1 className="mt-5 text-xl font-semibold text-foreground">{t("onboarding.adminLogin.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {loginMode === "phone" && phoneAuthEnabled
            ? t("onboarding.adminLogin.phoneAuthSubtitle")
            : t("onboarding.adminLogin.subtitle")}
        </p>
      </div>

      <AnimatePresence initial={false}>
        {errorMessage ? (
          <motion.div
            key="admin-login-error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="mt-6 flex items-start gap-2 rounded-[10px] border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
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
          onSendCode={onSendPhoneCode}
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
          <form onSubmit={handleSubmit} className={phoneAuthEnabled ? "mt-5 space-y-4" : "mt-6 space-y-4"}>
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
    </section>
  )
}
