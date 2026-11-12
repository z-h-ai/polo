import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import {
  PC_BATCH_SUBMIT_MAX,
  PC_CONTROLLED_TAG_ID,
  PC_PRESET_TAG_IDS,
  PC_TAG_MAX_CHARS,
  PC_TAG_MAX_COUNT,
  normalizeTagId,
} from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { formatAssetBytes } from '../asset-upload-prep'
import { uploadTagCaption } from '../AssetUploadDialog'
import type { BatchUploadController, BatchUploadEntry } from './useBatchUpload'

/**
 * The batch checklist view (POO-210, decision D4): every scanned entry with
 * its selection box, exclusion reason, editable upload name and per-entry
 * outcome. The whole list moves through three phases — review → uploading →
 * settled — driven entirely by the `BatchUploadController` the dialog owns.
 *
 * Rendering cap: the scan ceiling (5000) is an ingestion budget, not a DOM
 * budget, so the list shows at most the first PC_BATCH_VIEW_RENDER_MAX rows
 * and states the overflow instead of freezing the dialog.
 */

const PC_BATCH_VIEW_RENDER_MAX = 1000

/** The stable exclusion vocabulary → copy key (never renamed wire values). */
function exclusionReasonKey(reason: BatchUploadEntry['reason']): string {
  return `projectContext.upload.batch.reason.${reason}`
}

function EntryStatusBadge({ entry }: { entry: BatchUploadEntry }) {
  const { t } = useTranslation()
  if (entry.status === 'uploading') {
    return <Icons.Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" data-testid="pc-batch-entry-status" data-status="uploading" />
  }
  if (entry.status === 'success') {
    return <Icons.Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" data-testid="pc-batch-entry-status" data-status="success" />
  }
  if (entry.status === 'failed') {
    return <Icons.X className="h-3.5 w-3.5 text-destructive" aria-hidden="true" data-testid="pc-batch-entry-status" data-status="failed" />
  }
  return (
    <span
      className="inline-block h-2 w-2 rounded-full border border-border"
      aria-hidden="true"
      data-testid="pc-batch-entry-status"
      data-status="pending"
      title={t('projectContext.upload.batch.pending')}
    />
  )
}

interface BatchUploadViewProps {
  controller: BatchUploadController
  onBack: () => void
  onClose: () => void
}

export function BatchUploadView({ controller, onBack, onClose }: BatchUploadViewProps) {
  const { t } = useTranslation()
  const {
    phase, sourceKind, sourceLabel, entries, truncated, defaultedDown, scanning,
    batchTags, sourceNote, uploading, settled,
    selectedCount, selectedBytes, doneCount, failedCount,
    toggleEntry, toggleAllCheckable, renameEntry, setBatchTags, setSourceNote,
    startUpload, cancelUpload, retryFailed,
  } = controller

  const [customTag, setCustomTag] = React.useState('')
  const [tagErrorKey, setTagErrorKey] = React.useState<string | null>(null)

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
    if (batchTags.some((existing) => normalizeTagId(existing) === id)) {
      setTagErrorKey('projectContext.upload.tagDuplicate')
      return
    }
    if (batchTags.length >= PC_TAG_MAX_COUNT) {
      setTagErrorKey('projectContext.upload.tagLimit')
      return
    }
    setBatchTags((prev) => (prev.some((existing) => normalizeTagId(existing) === id) ? prev : [...prev, label]))
    setCustomTag('')
    setTagErrorKey(null)
  }, [customTag, batchTags, setBatchTags])

  const togglePreset = React.useCallback((id: string) => {
    setBatchTags((prev) => {
      if (prev.includes(id)) return prev.filter((existing) => existing !== id)
      if (prev.length >= PC_TAG_MAX_COUNT) return prev
      return [...prev, id]
    })
    setTagErrorKey(null)
  }, [setBatchTags])

  const visibleEntries = entries.slice(0, PC_BATCH_VIEW_RENDER_MAX)
  const hiddenCount = entries.length - visibleEntries.length
  const canStart = selectedCount > 0 && !uploading

  if (scanning) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-2" data-testid="pc-batch-scanning">
        <Icons.Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-[13px] text-muted-foreground" role="status">
          {t(sourceKind === 'zip' ? 'projectContext.upload.batch.unpacking' : 'projectContext.upload.batch.scanning')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="pc-batch-view" data-phase={phase}>
      {/* Source summary */}
      <div className="flex items-center justify-between gap-2 rounded-[10px] border border-border bg-foreground/[0.02] px-3 py-2 text-[12px]">
        <div className="flex min-w-0 flex-col" data-testid="pc-batch-summary">
          <span className="truncate font-medium text-foreground" title={sourceLabel || undefined}>
            {sourceLabel || t('projectContext.upload.batch.filesSource')}
          </span>
          <span className="text-muted-foreground">
            {t('projectContext.upload.batch.summary', {
              total: entries.length,
              selected: selectedCount,
            })}
            {selectedBytes > 0 && ` · ${formatAssetBytes(t, selectedBytes)}`}
          </span>
        </div>
        {!uploading && (
          <Button
            type="button"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-[12px]"
            onClick={onBack}
            data-testid="pc-batch-back"
          >
            <Icons.ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('projectContext.upload.batch.back')}
          </Button>
        )}
      </div>

      {(truncated || defaultedDown || hiddenCount > 0) && !uploading && (
        <p className="text-[12px] text-amber-600" role="status" data-testid="pc-batch-budget-note">
          {truncated && t('projectContext.upload.batch.truncated')}
          {truncated && (defaultedDown || hiddenCount > 0) && ' '}
          {defaultedDown && t('projectContext.upload.batch.submitCapped', { max: PC_BATCH_SUBMIT_MAX })}
          {defaultedDown && hiddenCount > 0 && ' '}
          {hiddenCount > 0 && t('projectContext.upload.batch.renderCapped', { count: hiddenCount })}
        </p>
      )}

      {/* The checklist */}
      <div
        className="flex max-h-[320px] min-h-[120px] flex-col overflow-y-auto rounded-[10px] border border-border"
        data-testid="pc-batch-list"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-[11px] text-muted-foreground">
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => toggleAllCheckable(true)}
            disabled={uploading}
            data-testid="pc-batch-select-all"
          >
            {t('projectContext.upload.batch.selectAll')}
          </button>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => toggleAllCheckable(false)}
            disabled={uploading}
            data-testid="pc-batch-select-none"
          >
            {t('projectContext.upload.batch.selectNone')}
          </button>
        </div>
        {visibleEntries.map((entry) => {
          const blocked = !entry.checkable
          return (
            <div
              key={entry.entryId}
              className={cn(
                'flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0',
                blocked && 'bg-foreground/[0.02] opacity-60',
              )}
              data-testid="pc-batch-entry"
              data-status={entry.status}
              data-included={entry.checkable}
            >
              <input
                type="checkbox"
                checked={entry.selected}
                disabled={blocked || uploading || entry.status === 'success'}
                onChange={() => toggleEntry(entry.entryId)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                aria-label={entry.displayName}
                data-testid="pc-batch-entry-check"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                {blocked ? (
                  <span className="truncate text-[12px] text-muted-foreground" title={entry.sourcePath}>
                    {entry.displayName}
                  </span>
                ) : (
                  <input
                    value={entry.displayName}
                    onChange={(event) => renameEntry(entry.entryId, event.target.value)}
                    disabled={uploading || entry.status === 'success'}
                    maxLength={512}
                    className="w-full truncate rounded-sm bg-transparent text-[12px] text-foreground outline-none hover:bg-foreground/5 focus:bg-foreground/5"
                    title={entry.sourcePath}
                    aria-label={t('projectContext.upload.batch.entryName')}
                    data-testid="pc-batch-entry-name"
                  />
                )}
                {blocked && entry.reason && (
                  <span className="text-[11px] text-muted-foreground" data-testid="pc-batch-entry-reason">
                    {t(exclusionReasonKey(entry.reason))}
                  </span>
                )}
                {entry.status === 'failed' && entry.errorKey && (
                  <span className="text-[11px] text-destructive" data-testid="pc-batch-entry-error">
                    {t(entry.errorKey)}
                  </span>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="pc-batch-entry-size">
                {entry.sizeBytes === null ? '—' : formatAssetBytes(t, entry.sizeBytes)}
              </span>
              <EntryStatusBadge entry={entry} />
            </div>
          )
        })}
      </div>

      {/* Batch-wide tags + source note (D3b) */}
      {(phase === 'review' || phase === 'uploading') && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.tags')}</span>
          <div className="flex flex-wrap gap-1.5" data-testid="pc-batch-preset-tags">
            {PC_PRESET_TAG_IDS.map((id) => {
              const active = batchTags.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => togglePreset(id)}
                  disabled={uploading || (batchTags.length >= PC_TAG_MAX_COUNT && !active)}
                  data-testid={`pc-batch-preset-tag-${id}`}
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
            disabled={uploading}
            placeholder={t('projectContext.upload.tagPlaceholder')}
            maxLength={PC_TAG_MAX_CHARS}
            aria-invalid={tagErrorKey ? true : undefined}
            data-testid="pc-batch-tag-input"
          />
          {tagErrorKey && (
            <p className="text-[12px] text-destructive" role="alert" data-testid="pc-batch-tag-error">
              {t(tagErrorKey, { count: PC_TAG_MAX_COUNT })}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.source')}</span>
            <Input
              value={sourceNote}
              onChange={(event) => setSourceNote(event.target.value)}
              disabled={uploading}
              placeholder={t('projectContext.upload.batch.sourcePlaceholder', { source: sourceLabel || t('projectContext.upload.batch.filesSource') })}
              maxLength={512}
              data-testid="pc-batch-source"
            />
          </label>
        </div>
      )}

      {/* Footer: phase-specific actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-[12px] text-muted-foreground" role="status" data-testid="pc-batch-progress">
          {uploading && t('projectContext.upload.batch.progress', { done: doneCount, total: doneCount + selectedCount })}
          {settled && t('projectContext.upload.batch.settled', { succeeded: doneCount - failedCount, failed: failedCount })}
        </div>
        <div className="flex shrink-0 gap-2">
          {uploading && (
            <Button type="button" variant="outline" onClick={cancelUpload} data-testid="pc-batch-cancel">
              {t('projectContext.upload.batch.cancelUpload')}
            </Button>
          )}
          {settled && failedCount > 0 && (
            <Button type="button" variant="outline" onClick={retryFailed} data-testid="pc-batch-retry">
              {t('projectContext.upload.batch.retryFailed', { count: failedCount })}
            </Button>
          )}
          {settled ? (
            <Button type="button" onClick={onClose} data-testid="pc-batch-done">
              {t('projectContext.upload.batch.done')}
            </Button>
          ) : (
            !uploading && (
              <Button type="button" disabled={!canStart} onClick={startUpload} data-testid="pc-batch-start">
                {t('projectContext.upload.batch.start', { count: selectedCount })}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
