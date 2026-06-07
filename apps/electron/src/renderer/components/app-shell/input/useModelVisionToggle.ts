import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

export type ToggleModelVision = (
  connectionSlug: string,
  modelId: string,
  enabled: boolean,
) => Promise<void>

/** Per-model image support is now Admin-managed and cannot be edited in the renderer. */
export function useModelVisionToggle(): ToggleModelVision {
  const { t } = useTranslation()

  return React.useCallback(async () => {
    toast.error(t('chat.modelPicker.toggleVisionFailed'))
  }, [t])
}
