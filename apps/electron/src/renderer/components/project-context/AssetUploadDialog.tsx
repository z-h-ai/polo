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
  type PcUploadFileInput,
} from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  prepareAssetUploadFile,
  type PreparedAssetUpload,
} from './asset-upload-prep'
import { projectContextErrorKey } from './useProjectAssets'

/**
 * The project file upload dialog, create mode (POO-196). One local file per
 * submission: pick → measure + integrity digest → name/tags/source → the
 * single pcUploadFile RPC (the renderer never sees a transfer URL). The same
 * form drives AssetReplaceDialog in replace mode.
 */

export interface AssetUploadInput {
  filePath: string
  name: string
  tags: string[]
  source?: { kind: 'file'; note?: string }
  sizeBytes: number
  mime: string
  checksumSha256: string
}

export interface AssetUploadDialogProps {
  open: boolean
  /** Server-advertised per-file ceiling (`capabilities.limits.maxUploadBytes`). */
  maxUploadBytes: number
  onClose: () => void
  /**
   * The mode-specific write. Throws to surface a mapped error inline; a
   * resolved promise closes the dialog (the parent refreshes its list).
   */
  onSubmit: (input: AssetUploadInput) => Promise<void>
}

/** Upload-write failures map through the shared pc_* table; prep failures get their own copy. */
export function projectContextUploadErrorKey(error: unknown): string {
  if (error instanceof AssetUploadPrepError) {
    return error.failure === 'too_large'
      ? 'projectContext.errors.uploadTooLarge'
      : 'projectContext.upload.readFailed'
  }
  return projectContextErrorKey(error)
}

/** The tag chip caption: preset ids render their i18n name, customs their label. */
export function uploadTagCaption(tag: string, t: (key: string) => string): string {
  return (PC_PRESET_TAG_IDS as readonly string[]).includes(tag)
    ? t(`projectContext.tags.${tag}`)
    : tag
}

/**
 * The shared pick → digest → fields form. Both create and replace dialogs
 * render this; only the submit write and copy differ.
 */
export function AssetUploadForm({
  maxUploadBytes,
  initialName,
  initialTags,
  submitLabel,
  busyLabel,
  pickLabel,
  repickLabel,
  onSubmit,
  testIdPrefix = 'pc-upload',
}: {
  maxUploadBytes: number
  initialName?: string
  initialTags?: string[]
  submitLabel: string
  busyLabel: string
  pickLabel: string
  repickLabel: string
  onSubmit: (input: AssetUploadInput) => Promise<void>
  testIdPrefix?: string
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = React.useState<PreparedAssetUpload | null>(null)
  const [preparing, setPreparing] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [errorKey, setErrorKey] = React.useState<string | null>(null)
  const [name, setName] = React.useState(initialName ?? '')
  const [tags, setTags] = React.useState<string[]>(initialTags ?? [])
  const [customTag, setCustomTag] = React.useState('')
  const [sourceNote, setSourceNote] = React.useState('')

  const ingestPath = React.useCallback(async (filePath: string) => {
    setPreparing(true)
    setErrorKey(null)
    try {
      const prepared = await prepareAssetUploadFile(filePath, maxUploadBytes)
      setPicked(prepared)
      setName(initialName ?? prepared.name)
    } catch (error) {
      setPicked(null)
      setErrorKey(projectContextUploadErrorKey(error))
    } finally {
      setPreparing(false)
    }
  }, [maxUploadBytes, initialName])

  const handlePickButton = React.useCallback(async () => {
    setErrorKey(null)
    // The shared electron file dialog answers absolute local paths.
    const paths = await window.electronAPI.openFileDialog()
    const filePath = paths?.[0]
    if (!filePath) return
    await ingestPath(filePath)
  }, [ingestPath])

  const addCustomTag = React.useCallback(() => {
    const label = customTag.trim()
    setCustomTag('')
    if (!label) return
    const id = normalizeTagId(label)
    if (!id || id.length > PC_TAG_MAX_CHARS) return
    // The controlled tag is version-state, not a member tag — refuse it here
    // exactly like the contract's parseTagList does server-side.
    if (id === PC_CONTROLLED_TAG_ID) return
    setTags((prev) => {
      if (prev.some((existing) => normalizeTagId(existing) === id)) return prev
      if (prev.length >= PC_TAG_MAX_COUNT) return prev
      return [...prev, label]
    })
  }, [customTag])

  const togglePreset = React.useCallback((id: string) => {
    setTags((prev) => {
      if (prev.includes(id)) return prev.filter((existing) => existing !== id)
      if (prev.length >= PC_TAG_MAX_COUNT) return prev
      return [...prev, id]
    })
  }, [])

  const canSubmit = !!picked && name.trim().length > 0 && !preparing && !submitting

  const handleSubmit = React.useCallback(async () => {
    if (!picked || !canSubmit) return
    setSubmitting(true)
    setErrorKey(null)
    try {
      await onSubmit({
        filePath: picked.filePath,
        name: name.trim(),
        tags,
        source: sourceNote.trim()
          ? { kind: 'file', note: sourceNote.trim() }
          : undefined,
        sizeBytes: picked.sizeBytes,
        mime: picked.mime,
        checksumSha256: picked.digestSha256,
      })
    } catch (error) {
      setErrorKey(projectContextUploadErrorKey(error))
    } finally {
      setSubmitting(false)
    }
  }, [picked, canSubmit, onSubmit, name, tags, sourceNote])

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`${testIdPrefix}-form`}>
      <button
        type="button"
        onClick={() => void handlePickButton()}
        disabled={preparing || submitting}
        className={cn(
          'flex flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-border px-4 py-6 text-center transition-colors hover:bg-foreground/[0.03]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        data-testid={`${testIdPrefix}-pick`}
      >
        <Icons.FileUp className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <span className="text-[13px] text-foreground">
          {picked ? repickLabel : pickLabel}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatAssetBytes(t, maxUploadBytes)}
        </span>
      </button>

      {picked && (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[10px] border border-border bg-foreground/[0.02] px-3 py-2 text-[12px]"
          data-testid={`${testIdPrefix}-file-summary`}
        >
          <dt className="text-muted-foreground">{t('projectContext.upload.size')}</dt>
          <dd className="text-foreground-80" data-testid={`${testIdPrefix}-size`}>
            {formatAssetBytes(t, picked.sizeBytes)}
          </dd>
          <dt className="text-muted-foreground">{t('projectContext.upload.digest')}</dt>
          <dd className="truncate font-mono text-foreground-80" title={picked.digestSha256} data-testid={`${testIdPrefix}-digest`}>
            {picked.digestSha256}
          </dd>
        </dl>
      )}
      {preparing && (
        <p className="text-[12px] text-muted-foreground" role="status" data-testid={`${testIdPrefix}-preparing`}>
          {t('projectContext.upload.preparing')}
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.name')}</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('projectContext.upload.namePlaceholder')}
          maxLength={512}
          data-testid={`${testIdPrefix}-name`}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.tags')}</span>
        <div className="flex flex-wrap gap-1.5" data-testid={`${testIdPrefix}-preset-tags`}>
          {PC_PRESET_TAG_IDS.map((id) => {
            const active = tags.includes(id)
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => togglePreset(id)}
                disabled={tags.length >= PC_TAG_MAX_COUNT && !active}
                data-testid={`${testIdPrefix}-preset-tag-${id}`}
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
          data-testid={`${testIdPrefix}-tag-input`}
        />
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid={`${testIdPrefix}-selected-tags`}>
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
        <span className="text-[12px] font-medium text-foreground-80">{t('projectContext.upload.source')}</span>
        <Input
          value={sourceNote}
          onChange={(event) => setSourceNote(event.target.value)}
          placeholder={t('projectContext.upload.sourcePlaceholder')}
          maxLength={512}
          data-testid={`${testIdPrefix}-source`}
        />
      </label>

      {errorKey && (
        <p className="text-[12px] text-destructive" role="alert" data-testid={`${testIdPrefix}-error`}>
          {t(errorKey)}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
          data-testid={`${testIdPrefix}-submit`}
        >
          {submitting ? busyLabel : submitLabel}
        </Button>
      </div>
    </div>
  )
}

export function AssetUploadDialog({ open, maxUploadBytes, onClose, onSubmit }: AssetUploadDialogProps) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={`${clientWorkbenchDialogClassName} max-w-[520px] sm:max-w-[520px]`}
        data-testid="pc-upload-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('projectContext.upload.title')}</DialogTitle>
          <DialogDescription>{t('projectContext.upload.description')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-[20px] pb-[18px]">
          <AssetUploadForm
            maxUploadBytes={maxUploadBytes}
            submitLabel={t('projectContext.upload.submit')}
            busyLabel={t('projectContext.upload.submitting')}
            pickLabel={t('projectContext.upload.pick')}
            repickLabel={t('projectContext.upload.repick')}
            onSubmit={onSubmit}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Shape a replace-mode RPC input (CAS against the revision the caller saw). */
export function replaceUploadInput(
  input: AssetUploadInput,
  asset: PcAssetDto,
  scope: { workspaceId: string; productSpaceId: string },
): PcUploadFileInput {
  return {
    workspaceId: scope.workspaceId,
    productSpaceId: scope.productSpaceId,
    mode: 'replace',
    filePath: input.filePath,
    name: input.name,
    tags: input.tags,
    source: input.source,
    sizeBytes: input.sizeBytes,
    mime: input.mime,
    checksumSha256: input.checksumSha256,
    assetId: asset.id,
    expectedRevision: asset.revision,
  }
}
