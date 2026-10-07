import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'

/** Only pending facts: authentication succeeded; account/space reads have not finished. */
export function ProductSpacePreparationScreen({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation()
  const style = useClientWorkbenchStyle()
  return (
    <div style={style} className={clientWorkbenchFocusClassName + ' flex h-full items-center justify-center overflow-y-auto bg-background p-[32px]'} data-testid="product-space-preparation-screen">
      <section className="w-full max-w-[520px] rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small" aria-busy="true">
        <span className="mx-auto mb-[18px] grid size-[52px] place-items-center rounded-[14px] bg-[var(--info-soft)] text-info" aria-hidden="true">
          <LoaderCircle className="size-[25px] animate-spin" />
        </span>
        <h1 role="status" className="m-0 text-[24px] font-[720] tracking-[-0.035em] text-foreground">{t('productSpace.exec.status.preparing')}</h1>
        <p className="mt-[9px] text-[13px] leading-[1.58] text-foreground-60">{t('common.loading')}</p>
        <Button className={clientWorkbenchButtonClassName + ' mt-[22px]'} variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </section>
    </div>
  )
}
