import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { toast } from 'sonner'
import type { KbReference } from '@polo-ai/core/types'
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

/**
 * The immutable kbReferences snapshot under a user message (POO-108). Chips
 * render exactly what was attached at send time; clicking one opens the
 * CURRENT document read-only — the snapshot text stays on the message, the
 * preview may reflect later edits and is labelled accordingly.
 */
export function KbReferenceChips({ references, workspaceId }: {
  references: KbReference[]
  workspaceId?: string
}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null)
  const [loading, setLoading] = useState(false)

  if (references.length === 0) return null

  const openReference = async (reference: KbReference) => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const doc = await window.electronAPI.kbGetDocument({ workspaceId, docId: reference.docId })
      if (!doc) {
        toast.error(t('knowledgeBase.errors.notFound'))
        return
      }
      setPreview({ title: doc.title, content: doc.content })
    } catch {
      toast.error(t('knowledgeBase.errors.notFound'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5" data-testid="kb-reference-chips">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Icons.Library className="h-3 w-3" aria-hidden="true" />
          {t('chat.knowledgeBase.referenceTitle')}
        </span>
        {references.map(reference => (
          <button
            key={`${reference.collectionId}:${reference.docId}`}
            type="button"
            disabled={loading || !workspaceId}
            title={`${reference.collectionName} · ${reference.title}\n${reference.snippet}`}
            onClick={() => void openReference(reference)}
            className="inline-flex max-w-[260px] items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-foreground-70 shadow-minimal transition-colors hover:border-foreground/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icons.FileText className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
            <span className="truncate">{reference.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{reference.collectionName}</span>
          </button>
        ))}
      </div>

      <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={`${clientWorkbenchDialogClassName} max-w-[720px] sm:max-w-[720px]`}
        >
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.previewLabel')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto px-[20px] pb-[18px]">
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[13px] leading-[1.7] text-foreground-80">
              {preview?.content}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
