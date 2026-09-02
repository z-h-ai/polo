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
      className="flex h-full items-center justify-center p-6"
      data-testid="product-space-contract-gate"
      data-gate-stage={stage}
    >
      <section className="flex w-full max-w-[520px] flex-col items-center rounded-[17px] border border-border/50 bg-background px-10 py-9 text-center text-base shadow-minimal">
        <span
          aria-hidden="true"
          className={
            stage === 'failed'
              ? 'mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10 text-lg text-destructive'
              : 'mx-auto flex size-10 items-center justify-center rounded-full bg-foreground/5 text-lg text-foreground'
          }
        >
          {stage === 'required' ? '↑' : stage === 'downloading' ? '↓' : '!'}
        </span>
        <h1
          data-testid="product-space-contract-title"
          className="mt-[18px] text-[28px] font-bold tracking-[-0.04em] text-foreground"
        >
          {stage === 'required'
            ? t('productSpace.contract.requiredTitle')
            : stage === 'downloading'
              ? t('productSpace.contract.downloadingTitle')
              : t('productSpace.contract.failedTitle')}
        </h1>
        <p className="mt-[9px] text-[13px] leading-[1.65] text-foreground/60">
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
          <div className="mt-5 flex items-center justify-center gap-2">
            <Button
              type="button"
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
