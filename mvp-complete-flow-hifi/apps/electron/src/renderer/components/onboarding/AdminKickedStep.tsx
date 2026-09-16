import { LogIn, Monitor } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"

interface AdminKickedStepProps {
  onRelogin: () => void
}

export function AdminKickedStep({ onRelogin }: AdminKickedStepProps) {
  const { t } = useTranslation()

  return (
    <section
      className="w-full max-w-96 rounded-[20px] border border-white/20 bg-background/72 p-7 text-center shadow-modal-small backdrop-blur-xl"
      style={{ WebkitBackdropFilter: "blur(24px)" }}
      aria-label={t("onboarding.adminKicked.ariaLabel")}
    >
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-foreground-2 text-foreground">
        <Monitor className="size-7" />
      </div>
      <h1 className="mt-5 text-xl font-semibold text-foreground">{t("onboarding.adminKicked.title")}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {t("onboarding.adminKicked.description")}
      </p>
      <Button
        type="button"
        onClick={onRelogin}
        className="mt-6 h-11 w-full rounded-[10px] bg-accent text-background hover:bg-accent/90"
      >
        <LogIn className="size-4" />
        {t("onboarding.adminKicked.relogin")}
      </Button>
    </section>
  )
}
