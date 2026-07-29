import { useTranslation } from "react-i18next"

export type AdminLoginMethod = "phone" | "password"

interface AdminLoginMethodTabsProps {
  disabled?: boolean
  value: AdminLoginMethod
  onChange: (value: AdminLoginMethod) => void
}

export function AdminLoginMethodTabs({
  disabled = false,
  value,
  onChange,
}: AdminLoginMethodTabsProps) {
  const { t } = useTranslation()

  return (
    <div
      className="mt-5 grid grid-cols-2 rounded-[10px] bg-foreground/5 p-1"
      role="tablist"
      aria-label={t("onboarding.adminLogin.methodAriaLabel")}
    >
      {(["phone", "password"] as const).map(method => {
        const selected = value === method
        return (
          <button
            key={method}
            data-testid={`admin-login-method-${method}`}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={selected ? undefined : () => onChange(method)}
            disabled={disabled}
            className={selected
              ? "rounded-[8px] bg-background px-3 py-2 text-sm font-medium text-foreground shadow-xs"
              : "rounded-[8px] px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"}
          >
            {t(method === "phone"
              ? "onboarding.adminLogin.phoneAuth"
              : "onboarding.adminLogin.passwordLogin")}
          </button>
        )
      })}
    </div>
  )
}
