import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import {
  PC_CONTROLLED_TAG_ID,
  PC_PRESET_TAG_IDS,
  PC_TAG_MAX_CHARS,
  PC_TAG_MAX_COUNT,
  normalizeTagId,
  type PcAssetDto,
} from '@polo-ai/shared/protocol'
import type { StoredAttachment } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
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
import { cn } from '@/lib/utils'
import {
  AssetUploadPrepError,
  formatAssetBytes,
  mimeFromName,
  prepareAssetUploadFile,
} from './asset-upload-prep'
import { projectContextUploadErrorKey, uploadTagCaption } from './AssetUploadDialog'
import { projectContextErrorKey } from './useProjectAssets'

/**
 * "Share to project" (POO-196 S-01): the entry on a user message of a project
 * session that lands that message's attachments / text artifact into the
 * shared project library.
 *
 * Everything the RPC needs is read locally: attachments already live on disk
 * (their `storedPath`), and the message text is written through the existing
 * sanctioned attachment write (`storeAttachment`, which lands it in the
 * session's private attachments folder) because the upload RPC takes a file
 * PATH — there is no renderer temp-file write and no content-only upload
 * channel. Each selected item becomes its own asset; tags and the
 * auto-filled "from this chat" source note apply to all of them.
 */

/** One shareable candidate derived from the message. */
export interface ShareItem {
  id: string
  kind: 'file' | 'text'
  name: string
  mime: string
  sizeBytes: number
  storedPath?: string
  text?: string
}

export interface ShareToProjectTarget {
  /** The message text (its artifact); blank messages contribute nothing. */
  text: string
  attachments: StoredAttachment[]
  /** Session title for the auto-filled source note, when one exists. */
  sessionTitle?: string | null
}

export interface ShareToProjectDialogProps {
  open: boolean
  scope: { workspaceId: string; productSpaceId: string; projectId: string }
  /** The session the shared copy comes from (attachment writes need it). */
  sessionId: string
  target: ShareToProjectTarget | null
  onClose: () => void
  /** All selected items published; the parent toasts and opens the Files tab. */
  onShared: (assets: PcAssetDto[]) => void
}

const UTF8 = new TextEncoder()

/** A message text needs a file name; the label plus a markdown extension
 * reads as an artifact without pretending to be an uploaded file. */
function textItemName(t: (key: string) => string): string {
  const label = t('projectContext.share.textName').trim() || 'message'
  return `${label.replace(/[/\\:]+/g, '_')}.md`
}

function shareItemsOf(target: ShareToProjectTarget, t: (key: string) => string): ShareItem[] {
  const items: ShareItem[] = []
  for (const attachment of target.attachments) {
    if (!attachment.storedPath) continue
    items.push({
      id: `att:${attachment.id}`,
      kind: 'file',
      name: attachment.name,
      mime: attachment.mimeType || mimeFromName(attachment.name),
      sizeBytes: attachment.size,
      storedPath: attachment.storedPath,
    })
  }
  const text = target.text.trim()
  if (text.length > 0) {
    items.push({
      id: 'text:message',
      kind: 'text',
      name: textItemName(t),
      mime: 'text/markdown',
      sizeBytes: UTF8.encode(text).byteLength,
      text,
    })
  }
  return items
}

/** What the derived candidates depend on: the message text, which
 * attachments ride along, and the title the source note is auto-filled from. */
function targetSignature(target: ShareToProjectTarget): string {
  return JSON.stringify([
    target.text,
    target.attachments.map((attachment) => [attachment.id, attachment.name, attachment.size]),
    target.sessionTitle ?? null,
  ])
}

export function ShareToProjectDialog({
  open,
  scope,
  sessionId,
  target,
  onClose,
  onShared,
}: ShareToProjectDialogProps) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const { requestConfirm, confirmElement } = useConfirmDialog()

  const [items, setItems] = React.useState<ShareItem[]>([])
  const [selected, setSelected] = React.useState<string[]>([])
  const [names, setNames] = React.useState<Record<string, string>>({})
  const [tags, setTags] = React.useState<string[]>([])
  const [customTag, setCustomTag] = React.useState('')
  const [tagErrorKey, setTagErrorKey] = React.useState<string | null>(null)
  const [sourceNote, setSourceNote] = React.useState('')
  const [maxUploadBytes, setMaxUploadBytes] = React.useState(0)
  const [gateErrorKey, setGateErrorKey] = React.useState<string | null>(null)
  const [preparing, setPreparing] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [errorText, setErrorText] = React.useState<string | null>(null)

  // X1-style guard: the synchronous ref answers Esc while React batches state.
  const submittingRef = React.useRef(false)

  // Re-derive the shareable candidates when a message is handed over — but
  // only on a real handover. The init keyed on the `target` reference alone
  // would also fire on a parent re-render that passes an equal-value copy of
  // the same target (streaming tokens and session metadata re-render ChatPage
  // all the time) and silently wipe what the user already typed here. So the
  // signature arms the init and an equal-value re-reference is a no-op; the
  // dialog close disarms it, so reopening the very same message still starts
  // from a fresh form. A `t` change alone therefore no longer re-derives
  // (edits win over relabeling the default text-item name mid-session).
  const initializedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!open || !target) {
      initializedRef.current = null
      return
    }
    const signature = targetSignature(target)
    if (initializedRef.current === signature) return
    initializedRef.current = signature
    const derived = shareItemsOf(target, t)
    setItems(derived)
    setSelected(derived.map((item) => item.id))
    setNames(Object.fromEntries(derived.map((item) => [item.id, item.name])))
    setTags([])
    setCustomTag('')
    setTagErrorKey(null)
    setErrorText(null)
    setSourceNote(target.sessionTitle
      ? t('projectContext.share.sourceNote', { title: target.sessionTitle }).slice(0, 512)
      : '')
  }, [open, target, t])

  // The per-file ceiling is the server's answer, fetched when the dialog opens
  // so an oversized share fails locally with actionable copy.
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setGateErrorKey(null)
    window.electronAPI.pcListCapabilities({
      workspaceId: scope.workspaceId,
      productSpaceId: scope.productSpaceId,
      projectId: scope.projectId,
    }).then((capabilities) => {
      if (cancelled) return
      setMaxUploadBytes(capabilities.limits.maxUploadBytes)
    }).catch((error: unknown) => {
      if (cancelled) return
      setGateErrorKey(projectContextErrorKey(error))
    })
    return () => { cancelled = true }
  }, [open, scope.workspaceId, scope.productSpaceId])

  const attemptClose = React.useCallback(() => {
    if (submittingRef.current) return
    onClose()
  }, [onClose])

  const toggleItem = React.useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]))
  }, [])

  const addCustomTag = React.useCallback(() => {
    const label = customTag.trim()
    if (!label) {
      setTagErrorKey(null)
      return
    }
    const id = normalizeTagId(label)
    if (!id) {
      setTagErrorKey('projectContext.upload.tagInvalid')
      return
    }
    if (id.length > PC_TAG_MAX_CHARS) {
      setTagErrorKey('projectContext.upload.tagTooLong')
      return
    }
    if (id === PC_CONTROLLED_TAG_ID) {
      setTagErrorKey('projectContext.upload.tagReserved')
      return
    }
    if (tags.some((existing) => normalizeTagId(existing) === id)) {
      setTagErrorKey('projectContext.upload.tagDuplicate')
      return
    }
    if (tags.length >= PC_TAG_MAX_COUNT) {
      setTagErrorKey('projectContext.upload.tagLimit')
      return
    }
    setTags((prev) => [...prev, label])
    setCustomTag('')
    setTagErrorKey(null)
  }, [customTag, tags])

  const togglePreset = React.useCallback((id: string) => {
    setTags((prev) => {
      if (prev.includes(id)) return prev.filter((existing) => existing !== id)
      if (prev.length >= PC_TAG_MAX_COUNT) return prev
      return [...prev, id]
    })
    setTagErrorKey(null)
  }, [])

  const selectedItems = items.filter((item) => selected.includes(item.id))
  const canSubmit = selectedItems.length > 0
    && maxUploadBytes > 0
    && selectedItems.every((item) => (names[item.id] ?? '').trim().length > 0)
    && !preparing && !submitting && !gateErrorKey

  const handleSubmit = React.useCallback(async () => {
    if (submittingRef.current || !canSubmit) return
    submittingRef.current = true
    setSubmitting(true)
    setErrorText(null)
    const published: PcAssetDto[] = []
    try {
      // One asset per selected item; a failure stops the loop with the item
      // named so the user can drop it and share the rest instead of losing
      // the whole batch.
      for (const item of selectedItems) {
        try {
          let filePath = item.storedPath
          if (item.kind === 'text') {
            // The upload RPC takes a PATH. The message text has none, so it is
            // written through the existing attachment store (the session's
            // private folder) and shared from there.
            const stored = await window.electronAPI.storeAttachment(sessionId, {
              type: 'text',
              path: '',
              name: (names[item.id] ?? item.name).trim(),
              mimeType: item.mime,
              text: item.text ?? '',
              size: item.sizeBytes,
            })
            filePath = stored.storedPath
          }
          const prepared = await prepareAssetUploadFile(filePath ?? '', maxUploadBytes)
          const result = await window.electronAPI.pcUploadFile({
            workspaceId: scope.workspaceId,
            productSpaceId: scope.productSpaceId,
            projectId: scope.projectId,
            mode: 'create',
            filePath: prepared.filePath,
            name: (names[item.id] ?? item.name).trim(),
            tags,
            source: sourceNote.trim() ? { kind: 'session', note: sourceNote.trim() } : { kind: 'session' },
            sizeBytes: prepared.sizeBytes,
            mime: prepared.mime,
            checksumSha256: prepared.digestSha256,
          })
          published.push(result.asset)
        } catch (error) {
          const reason = t(projectContextUploadErrorKey(error))
          throw new Error(
            error instanceof AssetUploadPrepError
              ? reason
              : t('projectContext.share.itemFailed', { name: (names[item.id] ?? item.name).trim(), reason }),
          )
        }
      }
      onShared(published)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [canSubmit, selectedItems, sessionId, names, maxUploadBytes, scope.workspaceId, scope.productSpaceId, tags, sourceNote, onShared, t])

  // A draft ask: selection, tags or the source note the user touched.
  const requestDiscardConfirm = React.useCallback(() => {
    if (submittingRef.current) return
    const untouched = selected.length === items.length
      && tags.length === 0
      && sourceNote.trim().length === 0
    if (untouched) {
      onClose()
      return
    }
    void requestConfirm({
      testId: 'pc-share-discard-confirm',
      title: t('projectContext.share.discardTitle'),
      description: t('projectContext.share.discardDescription'),
      confirmLabel: t('projectContext.share.discardConfirm'),
      cancelLabel: t('common.cancel'),
      onConfirm: onClose,
    })
  }, [items.length, onClose, requestConfirm, selected.length, sourceNote, tags.length, t])

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestDiscardConfirm() }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={`${clientWorkbenchDialogClassName} max-w-[520px] sm:max-w-[520px]`}
          onEscapeKeyDown={(event) => { if (submitting) event.preventDefault() }}
          onInteractOutside={(event) => { if (submitting) event.preventDefault() }}
          showCloseButton={!submitting}
          data-testid="pc-share-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('projectContext.share.title')}</DialogTitle>
            <DialogDescription>{t('projectContext.share.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-[20px] pb-[18px]" data-testid="pc-share-form">
            {gateErrorKey ? (
              <p className="text-[12px] text-destructive" role="alert" data-testid="pc-share-gate-error">
                {t(gateErrorKey)}
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.share.scope')}</span>
                  {items.length === 0 && (
                    <p className="text-[12px] text-muted-foreground" data-testid="pc-share-empty">
                      {t('projectContext.share.empty')}
                    </p>
                  )}
                  {items.map((item) => {
                    const checked = selected.includes(item.id)
                    return (
                      <label
                        key={item.id}
                        className="flex items-center gap-2 rounded-[10px] border border-border bg-foreground/[0.02] px-2.5 py-1.5"
                        data-testid={`pc-share-item-${item.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleItem(item.id)}
                          className="h-3.5 w-3.5 accent-[var(--accent)]"
                          aria-label={item.name}
                          data-testid={`pc-share-item-check-${item.id}`}
                        />
                        {item.kind === 'text'
                          ? <Icons.FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          : <Icons.Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                        <Input
                          value={names[item.id] ?? ''}
                          onChange={(event) => setNames((prev) => ({ ...prev, [item.id]: event.target.value }))}
                          disabled={!checked}
                          maxLength={512}
                          className="h-7 flex-1 text-[12px]"
                          aria-label={t('projectContext.upload.name')}
                          data-testid={`pc-share-item-name-${item.id}`}
                        />
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatAssetBytes(t, item.sizeBytes)}
                        </span>
                      </label>
                    )
                  })}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.tags')}</span>
                  <div className="flex flex-wrap gap-1.5" data-testid="pc-share-preset-tags">
                    {PC_PRESET_TAG_IDS.map((id) => {
                      const active = tags.includes(id)
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => togglePreset(id)}
                          disabled={tags.length >= PC_TAG_MAX_COUNT && !active}
                          data-testid={`pc-share-preset-tag-${id}`}
                          className={cn(
                            'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            active
                              ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent'
                              : 'border-border text-foreground-70 hover:bg-foreground/5',
                          )}
                        >
                          {t(`projectContext.tags.${id}`)}
                        </button>
                      )
                    })}
                  </div>
                  <Input
                    value={customTag}
                    onChange={(event) => setCustomTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addCustomTag()
                      }
                    }}
                    onBlur={addCustomTag}
                    placeholder={t('projectContext.upload.tagPlaceholder')}
                    maxLength={PC_TAG_MAX_CHARS}
                    aria-invalid={tagErrorKey ? true : undefined}
                    aria-describedby={tagErrorKey ? 'pc-share-tag-error' : undefined}
                    data-testid="pc-share-tag-input"
                  />
                  {tagErrorKey && (
                    <p className="text-[12px] text-destructive" role="alert" id="pc-share-tag-error" data-testid="pc-share-tag-error">
                      {t(tagErrorKey, { count: PC_TAG_MAX_COUNT })}
                    </p>
                  )}
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1" data-testid="pc-share-selected-tags">
                      {tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setTags((prev) => prev.filter((existing) => existing !== tag))}
                          className="inline-flex items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground-70 hover:bg-foreground/5"
                          aria-label={t('projectContext.upload.removeTag', { tag })}
                        >
                          {uploadTagCaption(tag, t)}
                          <Icons.X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.share.source')}</span>
                  <Input
                    value={sourceNote}
                    onChange={(event) => setSourceNote(event.target.value)}
                    maxLength={512}
                    data-testid="pc-share-source"
                  />
                </label>

                {errorText && (
                  <p className="text-[12px] text-destructive" role="alert" data-testid="pc-share-error">
                    {errorText}
                  </p>
                )}
                {submitting && (
                  <p className="text-[12px] text-muted-foreground" role="status" data-testid="pc-share-submitting">
                    {t('projectContext.share.submitting')}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={requestDiscardConfirm}
                    data-testid="pc-share-cancel"
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void handleSubmit()}
                    data-testid="pc-share-submit"
                  >
                    {submitting
                      ? t('projectContext.share.submitting')
                      : t('projectContext.share.submit')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {confirmElement}
    </>
  )
}
