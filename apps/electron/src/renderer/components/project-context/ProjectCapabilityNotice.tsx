import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { pcCapabilityCopyKeys, type PcCapabilityState } from './useProjectAssets'

/**
 * The neutral capability notice (POO-196 consensus S-08+E-3): replaces the
 * whole pane when the project file surface is persistently unusable — feature
 * not enabled, storage unavailable, signed out or forbidden. Each state
 * carries its own title/hint pair; the copy stays neutral and names no engine
 * (R8a). The transient unreachable case is a banner inside the pane instead.
 */
export function ProjectCapabilityNotice({ state, onRetry }: {
  state: PcCapabilityState
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const copy = pcCapabilityCopyKeys(state)
  if (!copy) return null

  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-[16px] border border-dashed border-border px-5 py-10 text-center"
      data-testid="pc-capability-notice"
      data-state={state}
    >
      <Icons.Lock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-[13px] text-foreground" data-testid="pc-capability-title">{t(copy.titleKey)}</p>
      <p className="text-[12px] text-muted-foreground" data-testid="pc-capability-hint">{t(copy.hintKey)}</p>
      {onRetry && (
        <Button
          variant="ghost"
          className="mt-1 h-7 px-2 text-[12px] text-muted-foreground"
          onClick={onRetry}
          data-testid="pc-capability-retry"
        >
          {t('projectContext.library.retry')}
        </Button>
      )}
    </div>
  )
}
