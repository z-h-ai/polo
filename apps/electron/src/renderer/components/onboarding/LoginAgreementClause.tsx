import { useTranslation } from "react-i18next"

/**
 * THE agreement clause of the login card (POO-70 visual review R1 F6).
 *
 * Every login view renders the SAME linked form — 我已阅读并同意 用户协议 和
 * 隐私政策 — inside its `LoginTrustRow`: the password view used to render a
 * second, link-less wording (同意协议与隐私政策), so one card carried two
 * forms of the same consent row. The linked version is the single form (the
 * terms stay visible/legal-readable in both views).
 */
export function LoginAgreementClause() {
  const { t } = useTranslation()
  return (
    <>
      {t("onboarding.adminLogin.legalPrefix")}{" "}
      <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.terms")}</span>
      {" "}{t("onboarding.adminLogin.legalJoin")}{" "}
      <span className="text-foreground-80 underline underline-offset-2">{t("onboarding.adminLogin.privacy")}</span>
    </>
  )
}
