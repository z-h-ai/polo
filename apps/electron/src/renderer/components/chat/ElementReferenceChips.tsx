import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { WebElementReference } from '@polo-ai/core/types'
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

/** One-line chip label: `<tag> · <text/aria summary>`, truncated. */
export function elementReferenceChipLabel(reference: WebElementReference): string {
  const summary = reference.text || reference.aria || ''
  return summary ? `${reference.tag} · ${summary}` : reference.tag
}

/**
 * POO-135: chips for picked web element references.
 *
 * - draft mode (composer): removable chips; deleting keeps the user's typed
 *   text intact and only drops the reference
 * - message mode (under a sent user message): read-only chips opening a
 *   point-in-time snapshot dialog (page / element / locator / summary)
 *
 * The snapshot is exactly what capture whitelisted — no field values, no
 * scripts, no page-wide content.
 */
export function ElementReferenceChips({ references, mode, onRemove }: {
  references: WebElementReference[]
  mode: 'draft' | 'message'
  onRemove?: (id: string) => void
}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const [preview, setPreview] = useState<WebElementReference | null>(null)

  if (references.length === 0) return null

  return (
    <>
      <div
        className="mt-1 flex flex-wrap items-center gap-1.5"
        data-testid={mode === 'draft' ? 'element-draft-chips' : 'element-reference-chips'}
      >
        {references.map((reference) => (
          <span
            key={reference.id}
            className="inline-flex max-w-[280px] items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground-70 shadow-minimal"
          >
            <button
              type="button"
              title={`${reference.pageTitle}\n${reference.url}`}
              onClick={() => setPreview(reference)}
              className="inline-flex min-w-0 items-center gap-1 text-left transition-colors hover:text-foreground"
            >
              <Icons.MousePointerClick className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate">{elementReferenceChipLabel(reference)}</span>
            </button>
            {mode === 'draft' && onRemove && (
              <button
                type="button"
                aria-label={t('browserPane.elementReference.remove')}
                data-testid={`element-draft-chip-remove-${reference.id}`}
                onClick={() => onRemove(reference.id)}
                className="shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icons.X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={`${clientWorkbenchDialogClassName} max-w-[560px] sm:max-w-[560px]`}
        >
          <DialogHeader>
            <DialogTitle>{t('browserPane.elementReference.previewTitle')}</DialogTitle>
            <DialogDescription>{t('browserPane.elementReference.previewCaption')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-[20px] pb-[18px] text-[13px] leading-[1.6]">
            <ElementReferenceField label={t('browserPane.elementReference.fieldPage')}>
              <div className="text-foreground-80">{preview?.pageTitle}</div>
              <div className="break-all text-[12px] text-muted-foreground">{preview?.url}</div>
            </ElementReferenceField>
            <ElementReferenceField label={t('browserPane.elementReference.fieldElement')}>
              <div className="flex flex-wrap items-center gap-2 text-foreground-80">
                <code className="rounded bg-surface px-1.5 py-0.5 text-[12px]">&lt;{preview?.tag}&gt;</code>
                {preview?.aria && <span className="text-muted-foreground">{preview.aria}</span>}
              </div>
            </ElementReferenceField>
            <ElementReferenceField label={t('browserPane.elementReference.fieldLocator')}>
              <code className="block break-all rounded bg-surface px-1.5 py-0.5 text-[12px] text-foreground-80">{preview?.locator}</code>
            </ElementReferenceField>
            {preview?.text && (
              <ElementReferenceField label={t('browserPane.elementReference.fieldSummary')}>
                <div className="whitespace-pre-wrap break-words text-foreground-80">{preview.text}</div>
              </ElementReferenceField>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ElementReferenceField({ label, children }: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
