import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { KbCollection } from '@polo-ai/shared/protocol'
import { KB_MAX_CONTENT_BYTES } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { renderKbMarkdown } from './kb-markdown'
import type { KbQueueItem, KbUploadRejection } from './kb-upload'

/**
 * The POO-143 upload dialog (Spec S3.1/S3.2): a multi-file queue fed by the
 * file picker OR a drag-and-drop dropzone through the same ingest path, an
 * aggregated rejection summary ("added X, Y not added" with a per-file
 * breakdown) and a split preview — editable title + raw text on the left with
 * live byte accounting, safe Markdown rendering on the right.
 *
 * Queue lifecycle (Spec S3.1): the dialog closing WITHOUT confirming keeps
 * the queue, rejections and selection — reopening resumes exactly where the
 * user left off. Confirming hands every row to the document-list pending
 * pipeline and clears the dialog state.
 */

export interface KbUploadDialogProps {
  target: KbCollection
  queue: KbQueueItem[]
  rejected: KbUploadRejection[]
  selectedQid: string | null
  rejectionsExpanded: boolean
  onIngest: (files: File[]) => void
  onSelect: (qid: string) => void
  onRemoveQueued: (qid: string) => void
  onClearQueue: () => void
  onUpdateItem: (qid: string, patch: Partial<Pick<KbQueueItem, 'title' | 'text' | 'sizeBytes'>>) => void
  onDismissRejections: () => void
  onToggleRejections: () => void
  onRepick: () => void
  onConfirm: () => void
  onCancel: () => void
}

export function KbUploadDialog(props: KbUploadDialogProps) {
  const {
    target,
    queue,
    rejected,
    selectedQid,
    rejectionsExpanded,
    onIngest,
    onSelect,
    onRemoveQueued,
    onClearQueue,
    onUpdateItem,
    onDismissRejections,
    onToggleRejections,
    onRepick,
    onConfirm,
    onCancel,
  } = props
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const selectedItem = queue.find(item => item.qid === selectedQid) ?? null
  // One oversized queue row (including one oversized by EDITING, Spec S3.2)
  // blocks the whole batch — the cap is per document, and the dialog states
  // which row is over instead of silently disabling the button.
  const overLimitQid = queue.find(item => item.sizeBytes > KB_MAX_CONTENT_BYTES)?.qid ?? null
  const uploadDisabled = queue.length === 0 || overLimitQid !== null

  const ingest = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    onIngest(Array.from(fileList))
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={`${clientWorkbenchDialogClassName} max-w-[860px] sm:max-w-[860px]`}
        data-testid="kb-upload-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('knowledgeBase.uploadTitle', { name: target.name })}</DialogTitle>
          <DialogDescription>{t('knowledgeBase.uploadDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-[12px] px-[20px] pb-[18px]">
          {/* Dropzone: click-pick and drag-drop share one ingest path (S3.1). */}
          <div
            className={`flex flex-wrap items-center gap-[8px] rounded-[12px] border-[1.5px] border-dashed p-[12px] transition-colors ${
              dragOver ? 'border-accent bg-accent/5' : 'border-border'
            }`}
            data-testid="kb-dropzone"
            onDragOver={event => { event.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={event => {
              event.preventDefault()
              setDragOver(false)
              ingest(event.dataTransfer.files)
            }}
          >
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icons.FileUp className="size-[14px]" aria-hidden="true" />
              {t('knowledgeBase.actions.pickFile')}
            </Button>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {t('knowledgeBase.upload.queue.dragHint')}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              multiple
              className="hidden"
              data-testid="kb-file-input"
              onChange={event => {
                ingest(event.target.files)
                event.target.value = ''
              }}
            />
          </div>

          {/* Aggregated selection errors (S3.1): count first, expandable
              per-file reasons, never overwritten by a later empty batch. */}
          {rejected.length > 0 && (
            <div
              className="grid gap-[7px] rounded-[10px] border border-destructive/30 bg-destructive/10 px-[12px] py-[10px] text-[12px]"
              data-testid="kb-pick-summary"
            >
              <div className="flex flex-wrap items-center gap-[8px]">
                <b className="font-bold" data-testid="kb-pick-summary-text">
                  {t('knowledgeBase.pickSummary.summary', { added: queue.length, rejected: rejected.length })}
                </b>
                <button
                  type="button"
                  className="min-h-[22px] rounded-[6px] px-[8px] text-[11px] font-bold text-destructive underline underline-offset-2 hover:bg-destructive/10"
                  data-testid="kb-pick-summary-toggle"
                  onClick={onToggleRejections}
                >
                  {rejectionsExpanded ? t('knowledgeBase.pickSummary.collapse') : t('knowledgeBase.pickSummary.expand')}
                </button>
                <Button
                  type="button"
                  variant="secondary"
                  className={clientWorkbenchButtonClassName}
                  data-testid="kb-pick-repick"
                  onClick={onRepick}
                >
                  {t('knowledgeBase.pickSummary.repick')}
                </Button>
                <button
                  type="button"
                  aria-label={t('knowledgeBase.pickSummary.dismiss')}
                  data-testid="kb-pick-summary-dismiss"
                  className="grid size-[22px] place-items-center rounded-[6px] text-foreground-40 hover:bg-foreground/5 hover:text-foreground"
                  onClick={onDismissRejections}
                >
                  <Icons.X className="size-[13px]" aria-hidden="true" />
                </button>
              </div>
              {rejectionsExpanded && (
                <div data-testid="kb-pick-summary-list">
                  {rejected.map((row, index) => (
                    <div key={`${row.fileName}-${index}`} className="flex flex-wrap items-baseline gap-[6px] text-[11.5px] leading-[1.5]">
                      <span className="font-semibold">{row.fileName}</span>
                      <span className="text-destructive">
                        {t(`knowledgeBase.upload.queue.rejection.${row.reason}`)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* The queue: per-row removal + clear-all; closing the dialog
              without confirming preserves all of it (S3.1 lifecycle). */}
          {queue.length > 0 && (
            <>
              <div className="grid gap-[6px]" data-testid="kb-upload-queue">
                {queue.map(item => (
                  <div
                    key={item.qid}
                    role="button"
                    tabIndex={0}
                    className={`flex cursor-pointer items-center gap-[8px] rounded-[10px] border bg-surface px-[9px] py-[7px] hover:bg-foreground/4 ${
                      item.qid === selectedQid ? 'border-accent/45 bg-accent/5' : 'border-border'
                    }`}
                    data-testid={`kb-queue-row-${item.qid}`}
                    onClick={() => onSelect(item.qid)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(item.qid) }}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{item.title}</span>
                    <span
                      className={`shrink-0 text-[10.5px] ${item.qid === overLimitQid ? 'font-bold text-destructive' : 'text-foreground-40'}`}
                    >
                      {t('knowledgeBase.upload.queue.bytes', { bytes: item.sizeBytes })}
                      {item.qid === overLimitQid && (
                        // The over-limit verdict stays on ITS row, so the
                        // error survives switching the preview to another row.
                        <span className="ml-[6px]" data-testid={`kb-up-byte-error-${item.qid}`}>
                          {t('knowledgeBase.pending.byteOver')}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-foreground/8 px-[8px] py-[1px] text-[10px] font-semibold text-foreground-70">
                      {t('knowledgeBase.pending.stageQueued')}
                    </span>
                    <button
                      type="button"
                      aria-label={t('knowledgeBase.upload.queue.removeQueued')}
                      className="grid size-[22px] shrink-0 place-items-center rounded-[6px] text-foreground-40 hover:bg-foreground/6 hover:text-destructive"
                      data-testid={`kb-queue-remove-${item.qid}`}
                      onClick={event => {
                        event.stopPropagation()
                        onRemoveQueued(item.qid)
                      }}
                    >
                      <Icons.X className="size-[13px]" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-foreground-50"
                  data-testid="kb-queue-clear"
                  onClick={onClearQueue}
                >
                  {t('knowledgeBase.upload.queue.clearQueue')}
                </Button>
              </div>
            </>
          )}

          {/* Split preview (S3.2): title + raw text with live byte accounting
              on the left, safe Markdown rendering on the right. */}
          {selectedItem ? (
            <div className="grid gap-[12px] min-[721px]:grid-cols-2">
              <div className="grid min-w-0 content-start gap-[6px]">
                <h4 className="m-0 text-[11px] font-semibold tracking-[0.4px] text-foreground-50">
                  {t('knowledgeBase.previewRawLabel')}
                </h4>
                <Input
                  value={selectedItem.title}
                  maxLength={512}
                  placeholder={t('knowledgeBase.documentTitle')}
                  data-testid="kb-document-title-input"
                  onChange={event => onUpdateItem(selectedItem.qid, { title: event.target.value })}
                />
                <Textarea
                  value={selectedItem.text}
                  rows={10}
                  className="resize-y font-mono text-[12px] leading-[1.6]"
                  data-testid="kb-document-content-input"
                  onChange={event => onUpdateItem(selectedItem.qid, {
                    text: event.target.value,
                    sizeBytes: new TextEncoder().encode(event.target.value).length,
                  })}
                />
                <span className={`text-[11px] ${selectedItem.sizeBytes > KB_MAX_CONTENT_BYTES ? 'font-bold text-destructive' : 'text-foreground-40'}`}>
                  {t('knowledgeBase.contentBytes', { bytes: selectedItem.sizeBytes })}
                </span>
                {overLimitQid === selectedItem.qid && (
                  <span className="text-[11px] font-bold text-destructive" data-testid="kb-up-byte-error">
                    {t('knowledgeBase.pending.byteOver')}
                  </span>
                )}
              </div>
              <div className="grid min-w-0 content-start gap-[6px]">
                <h4 className="m-0 text-[11px] font-semibold tracking-[0.4px] text-foreground-50">
                  {t('knowledgeBase.previewRenderedLabel')}
                </h4>
                <div
                  className="max-h-[320px] min-h-[230px] overflow-auto rounded-[10px] border border-border bg-surface px-[14px] py-[12px]"
                  data-testid="kb-upload-preview-rendered"
                >
                  {renderKbMarkdown(selectedItem.text)}
                </div>
              </div>
            </div>
          ) : (
            <p className="m-0 text-[11px] text-muted-foreground" data-testid="kb-upload-preview-empty">
              {t('knowledgeBase.upload.queue.previewEmpty')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" className={clientWorkbenchButtonClassName} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className={clientWorkbenchPrimaryClassName}
            disabled={uploadDisabled}
            data-testid="kb-document-upload-confirm"
            onClick={onConfirm}
          >
            <Icons.Upload className="size-[14px]" aria-hidden="true" />
            {t('knowledgeBase.pending.uploadAll')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
