import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { toast } from 'sonner'
import type { PcAssetDto } from '@polo-ai/shared/protocol'
import { PC_CONTROLLED_TAG_ID, PC_PRESET_TAG_IDS } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { useTheme } from '@/hooks/useTheme'
import type { FilePreviewState } from '@/hooks/useLinkInterceptor'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { AssetRow } from './AssetRow'
import { AssetUploadDialog, type AssetUploadInput } from './AssetUploadDialog'
import { AssetReplaceDialog } from './AssetReplaceDialog'
import { ProjectAssetPreviewOverlay } from './ProjectAssetPreviewOverlay'
import { ProjectCapabilityNotice } from './ProjectCapabilityNotice'
import { ProjectTrashView } from './ProjectTrashView'
import {
  isPcCapabilityBlocked,
  projectContextErrorKey,
  useProjectAssets,
  type PcFilters,
  type PcScope,
  type PcStatusFilter,
} from './useProjectAssets'

/**
 * The files tab of the project surface (POO-196, Spec v2): the team library
 * and the knowledge projection in ONE list — search, tag chips (the preset
 * vocabulary, the controlled confirmed state and the loaded custom tags),
 * processing-status filter, upload (when the enterprise aggregate allows
 * sharing), the trash view and per-row actions. Every server mutation is
 * permission-checked server-side; this surface renders outcomes and maps
 * `pc_*` failures to user copy via useProjectAssets' shared table.
 *
 * A disabled/unusable capability (consensus S-08+E-3) replaces the whole pane
 * with neutral guidance instead of an error face.
 */

/** The filter chips: the preset vocabulary plus the controlled confirmed state. */
export const PC_FILTER_TAG_IDS: readonly string[] = [...PC_PRESET_TAG_IDS, PC_CONTROLLED_TAG_ID]

/** 状态 chips (Spec R8): 全部 / 可用 / 处理中 / 失败. `available` means
 * indexed + unsupported — a stored file that cannot be indexed is still
 * usable, never relabelled as full-text searchable (consensus S-09). */
const STATUS_FILTERS: readonly PcStatusFilter[] = ['all', 'available', 'processing', 'failed']

export interface ProjectFileLibraryProps {
  scope: PcScope
  /**
   * The signed-in account id — the replace entry only renders for the
   * uploader's own rows. The server re-checks authoritatively
   * (`pc_replace_not_uploader`); this gate is presentation only.
   */
  currentUserId?: string | null
  /** False pauses refresh + the processing poll while the pane is hidden. */
  active?: boolean
  /**
   * Incremented by the Pin tab's mutations (X6 wiring) so a pin/unpin made
   * there is re-synced here without a manual refresh.
   */
  pinMutations?: number
}

interface PreviewState {
  asset: PcAssetDto
  state: FilePreviewState
}

export function ProjectFileLibrary({ scope, currentUserId, active = true, pinMutations = 0 }: ProjectFileLibraryProps) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const { requestConfirm, confirmElement } = useConfirmDialog()

  const library = useProjectAssets({ scope, enabled: true, active })
  const {
    capabilities,
    capabilityState,
    assets,
    loadedAssets,
    loading,
    errorKey,
    hasMore,
    loadingMore,
    filters,
    debouncedQ,
    setFilters,
    view,
    setView,
    trashAssets,
    trashLoading,
    trashErrorKey,
    trashHasMore,
    trashLoadingMore,
    refresh,
    loadMore,
    loadMoreTrash,
    upsertAsset,
    removeAsset,
    refreshTrash,
    upsertTrashAsset,
    removeTrashAsset,
  } = library

  const [busyAssetId, setBusyAssetId] = React.useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [replaceAsset, setReplaceAsset] = React.useState<PcAssetDto | null>(null)
  const [preview, setPreview] = React.useState<PreviewState | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)

  const maxUploadBytes = capabilities?.limits.maxUploadBytes ?? 0
  // S-09: the tag chips grow with what the list actually returned (consensus
  // #10) — custom member tags join the preset vocabulary, deduped, so a chip
  // never filters into a guaranteed-empty result. Custom ids keep the member's
  // own label for display.
  const customTagLabels = React.useMemo(() => {
    const preset = new Set<string>(PC_PRESET_TAG_IDS)
    preset.add(PC_CONTROLLED_TAG_ID)
    const labels = new Map<string, string>()
    for (const asset of loadedAssets) {
      for (const tag of asset.tags) {
        if (preset.has(tag.id) || labels.has(tag.id)) continue
        labels.set(tag.id, tag.label || tag.id)
      }
    }
    return labels
  }, [loadedAssets])
  const canShare = capabilities?.canShare ?? false
  const canManage = capabilities?.canManage ?? false
  const libraryReady = capabilities?.library.status === 'ready'

  const scopeRef = React.useRef(scope)
  scopeRef.current = scope

  // X6 wiring: a pin/unpin made on the Pin tab re-syncs the rows shown here.
  React.useEffect(() => {
    if (pinMutations > 0) void refresh()
  }, [pinMutations, refresh])

  const withBusy = async (assetId: string, write: () => Promise<PcAssetDto | null>): Promise<boolean> => {
    setBusyAssetId(assetId)
    try {
      const updated = await write()
      if (updated) upsertAsset(updated)
      return true
    } catch (error) {
      toast.error(t(projectContextErrorKey(error)))
      return false
    } finally {
      setBusyAssetId(null)
    }
  }

  const handleSetConfirmed = (asset: PcAssetDto, confirmed: boolean) => {
    const activeScope = scopeRef.current
    void withBusy(asset.id, async () => {
      const result = await window.electronAPI.pcSetConfirmed({
        workspaceId: activeScope.workspaceId,
        productSpaceId: activeScope.productSpaceId,
        assetId: asset.id,
        input: { expectedVersion: asset.current.version, confirmed },
      })
      toast.success(t(confirmed ? 'projectContext.toast.confirmedSet' : 'projectContext.toast.confirmedUnset'))
      return result.asset
    })
  }

  const handleSetPinned = (asset: PcAssetDto, pinned: boolean) => {
    const activeScope = scopeRef.current
    void withBusy(asset.id, async () => {
      const result = await window.electronAPI.pcSetPinned({
        workspaceId: activeScope.workspaceId,
        productSpaceId: activeScope.productSpaceId,
        assetId: asset.id,
        input: { pinned },
      })
      toast.success(t(pinned ? 'projectContext.toast.pinned' : 'projectContext.toast.unpinned'))
      return result.asset
    })
  }

  // Destructive move to trash: the explicit second ask (Apple HIG) names the
  // file and the retention semantics before anything is sent.
  const handleDelete = (asset: PcAssetDto) => {
    const activeScope = scopeRef.current
    void requestConfirm({
      testId: 'pc-delete-confirm',
      title: t('projectContext.delete.title', { name: asset.name }),
      description: t('projectContext.delete.description'),
      confirmLabel: t('projectContext.delete.confirm'),
      cancelLabel: t('projectContext.delete.cancel'),
      onConfirm: async () => {
        // X5: a raw RPC failure used to escape the confirm shell as an
        // unlabelled error; map it through the shared pc_* table so the
        // dialog surfaces real copy (revision conflict, forbidden, …).
        try {
          const result = await window.electronAPI.pcTrashAsset({
            workspaceId: activeScope.workspaceId,
            productSpaceId: activeScope.productSpaceId,
            assetId: asset.id,
            expectedRevision: asset.revision,
          })
          removeAsset(asset.id)
          upsertTrashAsset(result.asset)
          toast.success(t('projectContext.toast.trashed'))
        } catch (error) {
          throw new Error(t(projectContextErrorKey(error)))
        }
      },
    })
  }

  const handleReplace = (asset: PcAssetDto) => {
    setReplaceAsset(asset)
  }

  const handleDownload = async (asset: PcAssetDto) => {
    const activeScope = scopeRef.current
    setBusyAssetId(asset.id)
    try {
      // v1 destination: the user's Downloads folder (no save-as RPC exists in
      // the renderer bridge yet); the toast reveals the saved file.
      const homeDir = await window.electronAPI.getHomeDir()
      const safeName = asset.name.replace(/[/\\:]+/g, '_')
      const targetPath = `${homeDir.replace(/\/+$/, '')}/Downloads/${safeName}`
      const result = await window.electronAPI.pcDownloadAsset({
        workspaceId: activeScope.workspaceId,
        productSpaceId: activeScope.productSpaceId,
        assetId: asset.id,
        targetPath,
      })
      toast.success(t('projectContext.toast.downloaded', { name: asset.name }), {
        action: {
          label: t('projectContext.toast.reveal'),
          onClick: () => void window.electronAPI.showInFolder(result.savedPath),
        },
      })
    } catch (error) {
      toast.error(t(projectContextErrorKey(error)))
    } finally {
      setBusyAssetId(null)
    }
  }

  const handlePreview = async (asset: PcAssetDto) => {
    const activeScope = scopeRef.current
    setPreviewLoading(true)
    try {
      // HTML previews ride the short-lived preview grant; the renderer fetches
      // the sandboxed text and hands it to the shared FilePreviewPane. If the
      // grant cannot be fetched from the renderer, the bounded text read is
      // the fallback.
      let content: string | null = null
      try {
        const grant = await window.electronAPI.pcGetPreviewUrl({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          assetId: asset.id,
        })
        const response = await fetch(grant.url)
        if (response.ok) content = await response.text()
      } catch {
        content = null
      }
      if (content === null) {
        const read = await window.electronAPI.pcReadAsset({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          assetId: asset.id,
        })
        content = read.content
      }
      setPreview({
        asset,
        state: { type: 'html', filePath: asset.name, content },
      })
    } catch (error) {
      toast.error(t(projectContextErrorKey(error)))
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleRestore = (asset: PcAssetDto) => {
    const activeScope = scopeRef.current
    void (async () => {
      setBusyAssetId(asset.id)
      try {
        await window.electronAPI.pcRestoreAsset({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          assetId: asset.id,
          input: { expectedRevision: asset.revision },
        })
        removeTrashAsset(asset.id)
        toast.success(t('projectContext.toast.restored', { name: asset.name }))
        // The restored file rejoins the active library — re-sync it now.
        void refresh()
      } catch (error) {
        if (readRpcErrorCode(error) === 'pc_revision_conflict') {
          toast.error(t('projectContext.errors.revisionConflict'))
          void refreshTrash()
        } else {
          toast.error(t(projectContextErrorKey(error)))
        }
      } finally {
        setBusyAssetId(null)
      }
    })()
  }

  const handleUploadSubmit = async (input: AssetUploadInput) => {
    const activeScope = scopeRef.current
    const result = await window.electronAPI.pcUploadFile({
      workspaceId: activeScope.workspaceId,
      productSpaceId: activeScope.productSpaceId,
      mode: 'create',
      filePath: input.filePath,
      name: input.name,
      tags: input.tags,
      source: input.source,
      sizeBytes: input.sizeBytes,
      mime: input.mime,
      checksumSha256: input.checksumSha256,
    })
    upsertAsset(result.asset)
    setUploadOpen(false)
    // published=false ⇒ the version is still processing; the status badge
    // shows 处理中 and the next refresh picks up the indexed state.
    toast.success(t(result.published ? 'projectContext.toast.uploaded' : 'projectContext.toast.uploadProcessing'))
    void refresh()
  }

  const handleReplaceSubmit = async (input: import('@polo-ai/shared/protocol').PcUploadFileInput) => {
    const activeScope = scopeRef.current
    const result = await window.electronAPI.pcUploadFile({ ...input, workspaceId: activeScope.workspaceId, productSpaceId: activeScope.productSpaceId })
    upsertAsset(result.asset)
    setReplaceAsset(null)
    toast.success(t(result.published ? 'projectContext.toast.replaced' : 'projectContext.toast.replaceProcessing'))
    void refresh()
  }

  const handleFiltersChange = (patch: Partial<PcFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }))
  }

  const filtersActive = filters.tag !== null || filters.status !== 'all' || debouncedQ.length > 0

  // S-08+E-3: an unusable capability replaces the whole pane with neutral
  // guidance — no error face, no engine words. None of these states offers a
  // retry: each needs an outside action (sign in, admin setup, storage
  // provisioning). The transient unreachable case stays in the pane below as
  // the retryable pc-error banner.
  if (isPcCapabilityBlocked(capabilityState)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2" data-testid="pc-library-blocked">
        <ProjectCapabilityNotice state={capabilityState} />
        {confirmElement}
      </div>
    )
  }

  if (view === 'trash') {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2" data-testid="pc-library-trash">
        <ProjectTrashView
          assets={trashAssets}
          loading={trashLoading}
          errorKey={trashErrorKey}
          busyAssetId={busyAssetId}
          hasMore={trashHasMore}
          loadingMore={trashLoadingMore}
          onLoadMore={() => void loadMoreTrash()}
          onRestore={handleRestore}
          onRefresh={() => void refreshTrash()}
          onBack={() => setView('active')}
        />
        {confirmElement}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2" data-testid="pc-library">
      {/* Toolbar: search / tag chips / status / upload / trash */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Icons.Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={filters.q}
            onChange={(event) => handleFiltersChange({ q: event.target.value })}
            placeholder={t('projectContext.library.searchPlaceholder')}
            className="h-8 pl-8"
            data-testid="pc-search"
          />
        </div>
        {canShare && (
          <Button
            className="h-8 gap-1.5 px-3 text-[12px]"
            onClick={() => setUploadOpen(true)}
            disabled={!libraryReady}
            data-testid="pc-upload-button"
          >
            <Icons.Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {t('projectContext.library.upload')}
          </Button>
        )}
        <Button
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-[12px] text-muted-foreground"
          onClick={() => setView('trash')}
          data-testid="pc-trash-button"
        >
          <Icons.Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('projectContext.library.trash')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="pc-filter-row">
        {[...PC_FILTER_TAG_IDS, ...customTagLabels.keys()].map((id) => {
          const selected = filters.tag === id
          // Preset ids carry an i18n name; custom member tags render their own
          // label (already display text from the uploader).
          const caption = (PC_FILTER_TAG_IDS as readonly string[]).includes(id)
            ? t(`projectContext.tags.${id}`)
            : customTagLabels.get(id) ?? id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => handleFiltersChange({ tag: selected ? null : id })}
              data-testid={`pc-tag-filter-${id}`}
              className={
                selected
                  ? 'rounded-full border border-accent bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2.5 py-0.5 text-[12px] text-accent'
                  : 'rounded-full border border-border px-2.5 py-0.5 text-[12px] text-foreground-70 hover:bg-foreground/5'
              }
            >
              {caption}
            </button>
          )
        })}
        <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        {STATUS_FILTERS.map((status) => {
          const selected = filters.status === status
          return (
            <button
              key={status}
              type="button"
              aria-pressed={selected}
              onClick={() => handleFiltersChange({ status })}
              data-testid={`pc-status-filter-${status}`}
              className={
                selected
                  ? 'rounded-full bg-foreground/10 px-2.5 py-0.5 text-[12px] font-medium text-foreground'
                  : 'rounded-full px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-foreground/5'
              }
            >
              {t(`projectContext.statusFilter.${status}`)}
            </button>
          )
        })}
      </div>

      {errorKey && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          role="alert"
          data-testid="pc-error"
        >
          <span className="flex-1">{t(errorKey)}</span>
          <Button variant="ghost" className="h-6 px-2 text-[12px] text-destructive" onClick={() => void refresh()} data-testid="pc-error-retry">
            {t('projectContext.library.retry')}
          </Button>
        </div>
      )}

      {/* Loading / empty / list — the three required faces */}
      {loading && assets.length === 0 && (
        <p className="py-6 text-center text-[13px] text-muted-foreground" role="status" data-testid="pc-loading">
          {t('projectContext.library.loading')}
        </p>
      )}

      {!loading && !errorKey && assets.length === 0 && (
        filtersActive ? (
          <div className="flex flex-col items-center justify-center gap-1 rounded-[16px] border border-dashed border-border px-5 py-10 text-center" data-testid="pc-empty-filtered">
            <Icons.SearchX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-[13px] text-foreground">{t('projectContext.library.noMatchesTitle')}</p>
            <p className="text-[12px] text-muted-foreground">{t('projectContext.library.noMatchesHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border px-5 py-10 text-center" data-testid="pc-empty">
            <Icons.FolderOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-[13px] text-foreground">{t('projectContext.library.emptyTitle')}</p>
            <p className="text-[12px] text-muted-foreground">{t('projectContext.library.emptyHint')}</p>
            {canShare && libraryReady && (
              <Button className="mt-1 h-8 gap-1.5 px-3 text-[12px]" onClick={() => setUploadOpen(true)} data-testid="pc-empty-upload">
                <Icons.Upload className="h-3.5 w-3.5" aria-hidden="true" />
                {t('projectContext.library.upload')}
              </Button>
            )}
          </div>
        )
      )}

      {assets.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2" data-testid="pc-list">
          {assets.map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              busy={busyAssetId === asset.id || (previewLoading && preview?.asset.id === asset.id)}
              canManage={canManage}
              canReplace={canShare && !!currentUserId && asset.uploaderUserId === currentUserId}
              onPreview={handlePreview}
              onDownload={(target) => void handleDownload(target)}
              onReplace={handleReplace}
              onSetConfirmed={handleSetConfirmed}
              onSetPinned={handleSetPinned}
              onDelete={handleDelete}
            />
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              className="h-8 text-[12px] text-muted-foreground"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="pc-load-more"
            >
              {loadingMore ? t('projectContext.library.loadingMore') : t('projectContext.library.loadMore')}
            </Button>
          )}
        </div>
      )}

      <AssetUploadDialog
        open={uploadOpen}
        maxUploadBytes={maxUploadBytes}
        onClose={() => setUploadOpen(false)}
        onSubmit={handleUploadSubmit}
      />

      <AssetReplaceDialog
        open={replaceAsset !== null}
        asset={replaceAsset}
        scope={scope}
        maxUploadBytes={maxUploadBytes}
        onClose={() => setReplaceAsset(null)}
        onSubmit={handleReplaceSubmit}
      />

      {preview && (
        // S-10 + X20: untrusted shared HTML renders through the hardened
        // overlay (non-relaxable CSP + scripts-only sandbox) on the z-modal
        // token, not a raw absolute layer under real modals.
        <ProjectAssetPreviewOverlay
          state={preview.state}
          isDark={isDark}
          onClose={() => setPreview(null)}
          onRetry={() => { setPreview(null); void handlePreview(preview.asset) }}
        />
      )}

      {confirmElement}
    </div>
  )
}
