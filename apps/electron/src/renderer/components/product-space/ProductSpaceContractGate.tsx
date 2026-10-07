import { useClientWorkbenchStyle, clientWorkbenchFocusClassName, clientWorkbenchPrimaryClassName, clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

type UpgradeStage = 'required' | 'downloading' | 'failed'

/**
 * PC-F11 contract gate. When the client cannot safely understand the server
 * ProductSpace contract, every business surface stays blocked behind this
 * screen; only upgrading and help remain available.
 */
export function ProductSpaceContractGate() {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const [stage, setStage] = useState<UpgradeStage>('required')

  const startUpgrade = async () => {
    setStage('downloading')
    try {
      const update = await window.electronAPI.checkForUpdates()
      if (update?.available) {
        await window.electronAPI.installUpdate()
        return
      }
      setStage('failed')
    } catch {
      setStage('failed')
    }
  }

  return (
    <div
      style={workbenchStyle}
      className={clientWorkbenchFocusClassName + " flex h-full items-center justify-center overflow-y-auto bg-background p-[32px]"}
      data-testid="product-space-contract-gate"
      data-gate-stage={stage}
    >
      <section className="block w-full max-w-[520px] rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small">
        <span
          aria-hidden="true"
          className={
            stage === 'failed'
              ? 'mx-auto mb-[18px] flex size-[52px] items-center justify-center rounded-[14px] bg-[var(--destructive-soft)] text-[25px] text-destructive'
              : 'mx-auto mb-[18px] flex size-[52px] items-center justify-center rounded-[14px] bg-[var(--info-soft)] text-[25px] text-info'
          }
        >
          {stage === 'required' ? '↑' : stage === 'downloading' ? '↓' : '!'}
        </span>
        <h1
          data-testid="product-space-contract-title"
          className="m-0 text-[24px] font-[720] tracking-[-0.035em] text-foreground"
        >
          {stage === 'required'
            ? t('productSpace.contract.requiredTitle')
            : stage === 'downloading'
              ? t('productSpace.contract.downloadingTitle')
              : t('productSpace.contract.failedTitle')}
        </h1>
        <p className="mt-[9px] text-[13px] leading-[1.58] text-foreground-60">
          {stage === 'required'
            ? t('productSpace.contract.requiredDesc')
            : stage === 'downloading'
              ? t('productSpace.contract.downloadingDesc')
              : t('productSpace.contract.failedDesc')}
        </p>
        {stage === 'downloading' ? (
          <button
            type="button"
            data-testid="product-space-contract-help"
            className="mt-5 text-sm text-foreground/60 underline-offset-2 hover:underline"
            onClick={() => window.electronAPI.openUrl('https://app.polo.z-h-ai.com/docs')}
          >
            {t('productSpace.contract.help')}
          </button>
        ) : (
          <div className="mt-[22px] flex flex-wrap items-center justify-center gap-[8px]">
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              data-testid="product-space-contract-upgrade"
              onClick={() => {
                void startUpgrade()
              }}
            >
              {stage === 'failed'
                ? t('productSpace.contract.retryUpgrade')
                : t('productSpace.contract.upgrade')}
            </Button>
            <Button
              type="button"
              className={clientWorkbenchButtonClassName}
              variant="ghost"
              data-testid="product-space-contract-help"
              onClick={() => window.electronAPI.openUrl('https://app.polo.z-h-ai.com/docs')}
            >
              {t('productSpace.contract.help')}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
