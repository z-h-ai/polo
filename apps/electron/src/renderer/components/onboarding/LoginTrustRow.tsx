import { useTranslation } from "react-i18next"
import type { ReactNode } from "react"

interface LoginTrustRowProps {
  /**
   * The agreement checkbox (prototype `.trust-row` first line). Interactive
   * so the phone flow can gate code sending on consent; the password flow
   * defaults it to checked.
   */
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** Agreement copy — the phone flow renders linked terms/privacy labels. */
  children: ReactNode
}

/**
 * Prototype `.trust-row`: the muted agreement box below the auth form —
 * consent checkbox on the first line, the first-login note on the second.
 */
export function LoginTrustRow({
  checked,
  onCheckedChange,
  disabled = false,
  children,
}: LoginTrustRowProps) {
  const { t } = useTranslation()

  return (
    <div className="mt-[18px] rounded-[9px] bg-foreground-3 px-[12px] py-[10px] text-[10px] leading-[1.5] text-foreground-50">
      <label className="flex cursor-pointer items-center gap-[6px]">
        <input
          data-testid="login-trust-consent"
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheckedChange(event.target.checked)}
          disabled={disabled}
          className="size-3 accent-[var(--accent)]"
        />
        <span>{children}</span>
      </label>
      <span className="mt-[3px] block">
        ✓ {t("onboarding.adminLogin.firstLoginNote")}
      </span>
    </div>
  )
}
