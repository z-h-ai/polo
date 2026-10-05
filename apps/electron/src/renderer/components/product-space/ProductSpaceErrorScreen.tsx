import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchPrimaryClassName, clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'

/** Both authentic bootstrap/fallback failures share the current system-state
 * composition. Recovery stays with App; no prepared-space facts are inferred. */
export function ProductSpaceErrorScreen({ onLogout, onRetry }: {
  onLogout: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  return (
    <div style={workbenchStyle} className={clientWorkbenchFocusClassName + ' flex h-full items-center justify-center overflow-y-auto bg-background p-[32px]'} data-testid="product-space-error-screen">
      <section className="w-full max-w-[520px] rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small">
        <span className="mx-auto mb-[18px] grid size-[52px] place-items-center rounded-[14px] bg-[var(--destructive-soft)] text-destructive" aria-hidden="true">
          <AlertTriangle className="size-[25px]" />
        </span>
        <h1 className="m-0 text-[24px] font-[720] tracking-[-0.035em] text-foreground">{t('productSpace.error.loadTitle')}</h1>
        <p className="mt-[9px] text-[13px] leading-[1.58] text-foreground-60">{t('productSpace.error.loadDesc')}</p>
        <div className="mt-[22px] flex flex-wrap items-center justify-center gap-[8px]">
          <Button className={clientWorkbenchButtonClassName} variant="ghost" data-testid="product-space-error-logout" onClick={onLogout}>{t('productSpace.error.logout')}</Button>
          <Button className={clientWorkbenchPrimaryClassName} data-testid="product-space-error-retry" onClick={onRetry}>{t('productSpace.error.retry')}</Button>
        </div>
      </section>
    </div>
  )
}
