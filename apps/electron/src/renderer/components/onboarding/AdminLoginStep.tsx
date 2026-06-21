import { useState } from "react"
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

interface AdminLoginStepProps {
  errorMessage?: string
  isLoading?: boolean
  onSubmit: (username: string, password: string) => void
}

export function AdminLoginStep({
  errorMessage,
  isLoading = false,
  onSubmit,
}: AdminLoginStepProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isLoading) return
    onSubmit(username.trim(), password)
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
        <p className="mt-2 text-sm text-muted-foreground">{t("onboarding.adminLogin.subtitle")}</p>
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

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="admin-username" className="text-xs text-foreground/70">
            {t("onboarding.adminLogin.username")}
          </Label>
          <Input
            id="admin-username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
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
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
          disabled={isLoading || !username.trim() || !password}
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
    </section>
  )
}
