import { useTranslation } from 'react-i18next'
import type { PcAssetDto, PcUploadFileInput } from '@polo-ai/shared/protocol'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { AssetUploadForm, type AssetUploadInput } from './AssetUploadDialog'
import { replaceUploadInput } from './AssetUploadDialog'
import type { PcScope } from './useProjectAssets'

/**
 * The replace dialog (POO-196): the same pick → digest → fields form as the
 * create upload, submitting `pcUploadFile` with `mode: 'replace'` and a CAS
 * guard against the revision the caller saw. On `pc_revision_conflict` the
 * mapped copy tells the user the file changed under them; the dialog stays
 * open with the form intact for a deliberate retry — a stale revision never
 * re-fires silently.
 */

export interface AssetReplaceDialogProps {
  open: boolean
  asset: PcAssetDto | null
  scope: PcScope
  maxUploadBytes: number
  onClose: () => void
  /** Receives the replace-mode RPC input ready for `pcUploadFile`. */
  onSubmit: (input: PcUploadFileInput) => Promise<void>
}

export function AssetReplaceDialog({ open, asset, scope, maxUploadBytes, onClose, onSubmit }: AssetReplaceDialogProps) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()

  if (!asset) return null

  const handleSubmit = async (input: AssetUploadInput) => {
    await onSubmit(replaceUploadInput(input, asset, scope))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={`${clientWorkbenchDialogClassName} max-w-[520px] sm:max-w-[520px]`}
        data-testid="pc-replace-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('projectContext.replace.title', { name: asset.name })}</DialogTitle>
          <DialogDescription>{t('projectContext.replace.description')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-[20px] pb-[18px]">
          <AssetUploadForm
            maxUploadBytes={maxUploadBytes}
            initialName={asset.name}
            initialTags={asset.tags.map((tag) => (tag.preset ? tag.id : tag.label))}
            submitLabel={t('projectContext.replace.submit')}
            busyLabel={t('projectContext.upload.submitting')}
            pickLabel={t('projectContext.replace.pick')}
            repickLabel={t('projectContext.replace.repick')}
            testIdPrefix="pc-replace"
            onSubmit={handleSubmit}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
