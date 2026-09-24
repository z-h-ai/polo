import { useTranslation } from "react-i18next"

export type AdminLoginMethod = "phone" | "password"

interface AdminLoginMethodSwitchProps {
  /** The login mode this button switches TO (the other one). */
  target: AdminLoginMethod
  disabled?: boolean
  onSwitch: () => void
}

/**
 * Prototype `.button.quiet` mode switch: the bordered quiet button below the
 * primary action that flips between password and verification-code login.
 */
export function AdminLoginMethodSwitch({
  target,
  disabled = false,
  onSwitch,
}: AdminLoginMethodSwitchProps) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      data-testid={`admin-login-method-${target}`}
      onClick={onSwitch}
      disabled={disabled}
      className="inline-flex min-h-[28px] w-full items-center justify-center rounded-[8px] border border-border px-[12px] text-[12px] font-medium text-foreground-60 transition-colors hover:bg-foreground-5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {t(target === "phone"
        ? "onboarding.adminLogin.phoneAuth"
        : "onboarding.adminLogin.passwordLogin")}
    </button>
  )
}
