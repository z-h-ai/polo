import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'

/** How long "Preparing…" may sit silent before the reassurance line shows —
 *  a bare spinner past this point reads as a freeze to a first-time user. */
const STILL_PREPARING_AFTER_MS = 30_000

/** Only pending facts: authentication succeeded; account/space reads have not finished.
 *
 * UX danger guard: the escape hatch signs the user OUT (cancel → relogin →
 * logout), so the leaf spells that consequence out ("Cancel and sign out") and
 * asks before firing — a light "Cancel" label over a logout-sized blast radius
 * was a mis-click trap. */
export function ProductSpacePreparationScreen({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation()
  const style = useClientWorkbenchStyle()
  const [stillPreparing, setStillPreparing] = useState(false)
  const { requestConfirm, confirmElement } = useConfirmDialog()

  useEffect(() => {
    const timer = setTimeout(() => setStillPreparing(true), STILL_PREPARING_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])

  const handleCancelClick = () => {
    void (async () => {
      const confirmed = await requestConfirm({
        testId: 'product-space-cancel-confirm',
        title: t('productSpace.prepare.cancelConfirmTitle'),
        description: t('productSpace.prepare.cancelConfirmDescription'),
        confirmLabel: t('productSpace.prepare.cancelAndSignOut'),
      })
      if (!confirmed) return
      onCancel()
    })()
  }

  return (
    <div style={style} className={clientWorkbenchFocusClassName + ' flex h-full items-center justify-center overflow-y-auto bg-background p-[32px]'} data-testid="product-space-preparation-screen">
      <section className="w-full max-w-[520px] rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small" aria-busy="true">
        <span className="mx-auto mb-[18px] grid size-[52px] place-items-center rounded-[14px] bg-[var(--info-soft)] text-info" aria-hidden="true">
          <LoaderCircle className="size-[25px] animate-spin" />
        </span>
        <h1 role="status" className="m-0 text-[24px] font-[720] tracking-[-0.035em] text-foreground">{t('productSpace.exec.status.preparing')}</h1>
        <p className="mt-[9px] text-[14px] leading-[1.58] text-foreground-60">{t('common.loading')}</p>
        {stillPreparing && (
          <p role="note" data-testid="product-space-preparation-still-preparing" className="mt-[9px] text-[14px] leading-[1.58] text-foreground-60">
            {t('productSpace.prepare.stillPreparing')}
          </p>
        )}
        <Button className={clientWorkbenchButtonClassName + ' mt-[22px]'} variant="ghost" onClick={handleCancelClick}>{t('productSpace.prepare.cancelAndSignOut')}</Button>
        {confirmElement}
      </section>
    </div>
  )
}
