import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcAssetDto, PcTag } from '@polo-ai/shared/protocol'
import { i18n } from '@polo-ai/shared/i18n'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'

/**
 * One project-asset row (POO-196): identity (name + tag chips), provenance
 * (uploader + time), the current version's processing state, the version-bound
 * confirmed state and the row action menu. Shared by the files list, the pin
 * pane and (in trash mode, reduced actions) the trash view.
 */

export function assetTagLabel(tag: PcTag, t: (key: string) => string): string {
  // Preset display names come from the client i18n by contract — never from
  // the wire label; member-defined tags render their own normalized label.
  return tag.preset ? t(`projectContext.tags.${tag.id}`) : tag.label
}

export function assetStatusBadge(asset: PcAssetDto, t: (key: string) => string): { label: string; className: string } | null {
  switch (asset.current.processing) {
    case 'processing':
      return { label: t('projectContext.status.processing'), className: 'bg-info/12 text-info-text' }
    case 'failed':
      return { label: t('projectContext.status.failedRetryable'), className: 'bg-destructive/10 text-destructive' }
    default:
      // `indexed` and `unsupported` are both usable content: stored and
      // downloadable; `unsupported` is just never full-text searchable.
      return { label: t('projectContext.status.ready'), className: 'bg-foreground/8 text-foreground-70' }
  }
}

export function formatAssetDate(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export interface AssetRowActionHandlers {
  onPreview?: (asset: PcAssetDto) => void
  onDownload?: (asset: PcAssetDto) => void
  onReplace?: (asset: PcAssetDto) => void
  onSetConfirmed?: (asset: PcAssetDto, confirmed: boolean) => void
  onSetPinned?: (asset: PcAssetDto, pinned: boolean) => void
  onDelete?: (asset: PcAssetDto) => void
  onRestore?: (asset: PcAssetDto) => void
  /** S-05: ask the admin to re-run the whole space's index build. Only shown
   * for a failed current version — and only when the caller can act on it. */
  onRebuild?: (asset: PcAssetDto) => void
}

export interface AssetRowProps extends AssetRowActionHandlers {
  asset: PcAssetDto
  mode?: 'active' | 'trash'
  canManage?: boolean
  canReplace?: boolean
  canDownload?: boolean
  /** Row-level pending flag while this asset's in-flight mutation resolves. */
  busy?: boolean
}

export function AssetRow({
  asset,
  mode = 'active',
  canManage = false,
  canReplace = false,
  canDownload = true,
  busy = false,
  onPreview,
  onDownload,
  onReplace,
  onSetConfirmed,
  onSetPinned,
  onDelete,
  onRestore,
  onRebuild,
}: AssetRowProps) {
  const { t } = useTranslation()
  const status = assetStatusBadge(asset, t)
  const isHtmlPreview = asset.current.mime === 'text/html'
  const currentConfirmed = asset.current.confirmedAt !== null
  const trashed = mode === 'trash'

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-[10px] border border-border bg-surface px-3 py-2 transition-colors hover:bg-foreground/[0.03]',
        busy && 'opacity-60',
      )}
      data-testid={`pc-asset-row-${asset.id}`}
      data-pinned={asset.pinned ? 'true' : 'false'}
      data-confirmed={currentConfirmed ? 'true' : 'false'}
      data-processing={asset.current.processing}
    >
      <Icons.FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground" title={asset.name}>
            {asset.name}
          </span>
          {asset.pinned && !trashed && (
            <Icons.Pin className="h-3 w-3 shrink-0 text-accent" aria-label={t('projectContext.pin.pinnedAria')} />
          )}
          {currentConfirmed && (
            <span
              className="inline-flex shrink-0 items-center rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-1.5 py-px text-[10px] font-medium text-accent"
              data-testid={`pc-asset-confirmed-${asset.id}`}
            >
              {t('projectContext.confirmed.badge')}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {asset.tags.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {asset.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="rounded-full border border-border px-1.5 py-px"
                  data-testid={`pc-asset-tag-${tag.id}`}
                >
                  {assetTagLabel(tag, t)}
                </span>
              ))}
            </span>
          )}
          <span className="truncate">
            {asset.uploaderDisplayName ?? asset.uploaderUserId}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatAssetDate(asset.updatedAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{t('projectContext.row.version', { version: asset.current.version })}</span>
          {trashed && asset.trashExpiresAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t('projectContext.trash.expires', { date: formatAssetDate(asset.trashExpiresAt) })}</span>
            </>
          )}
        </div>
      </div>

      {status && (
        <span
          className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', status.className)}
          data-testid={`pc-asset-status-${asset.id}`}
        >
          {status.label}
        </span>
      )}

      {trashed ? (
        onRestore && (
          <button
            type="button"
            className="shrink-0 rounded-[8px] border border-border px-2 py-1 text-[12px] text-foreground transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            data-testid={`pc-asset-restore-${asset.id}`}
            onClick={() => onRestore(asset)}
          >
            {t('projectContext.trash.restore')}
          </button>
        )
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('projectContext.row.actionsAria', { name: asset.name })}
              data-testid={`pc-asset-menu-${asset.id}`}
              disabled={busy}
              className="shrink-0 rounded-[8px] p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Icons.MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" sideOffset={6}>
            {onPreview && isHtmlPreview && (
              <StyledDropdownMenuItem onClick={() => onPreview(asset)} data-testid={`pc-asset-action-preview-${asset.id}`}>
                <Icons.Eye className="h-3.5 w-3.5" />
                <span className="flex-1">{t('projectContext.actions.preview')}</span>
              </StyledDropdownMenuItem>
            )}
            {onDownload && canDownload && (
              <StyledDropdownMenuItem onClick={() => onDownload(asset)} data-testid={`pc-asset-action-download-${asset.id}`}>
                <Icons.Download className="h-3.5 w-3.5" />
                <span className="flex-1">{t('projectContext.actions.download')}</span>
              </StyledDropdownMenuItem>
            )}
            {onReplace && canReplace && (
              <StyledDropdownMenuItem onClick={() => onReplace(asset)} data-testid={`pc-asset-action-replace-${asset.id}`}>
                <Icons.RefreshCw className="h-3.5 w-3.5" />
                <span className="flex-1">{t('projectContext.actions.replace')}</span>
              </StyledDropdownMenuItem>
            )}
            {/* S-05: a failed read is a space-level index fault, never a
                per-file retry, so the entry states the scope and stays visible
                (disabled with who must act) for members without the right. */}
            {onRebuild && asset.current.processing === 'failed' && (
              canManage ? (
                <StyledDropdownMenuItem onClick={() => onRebuild(asset)} data-testid={`pc-asset-action-rebuild-${asset.id}`}>
                  <Icons.RotateCw className="h-3.5 w-3.5" />
                  <span className="flex-1">{t('projectContext.actions.rebuild')}</span>
                </StyledDropdownMenuItem>
              ) : (
                <StyledDropdownMenuItem
                  disabled
                  data-testid={`pc-asset-action-rebuild-${asset.id}`}
                  data-rebuild-blocked="true"
                >
                  <Icons.RotateCw className="h-3.5 w-3.5" />
                  <span className="flex-1">{t('projectContext.actions.rebuildNeedsManager')}</span>
                </StyledDropdownMenuItem>
              )
            )}
            {onSetConfirmed && canManage && (
              <StyledDropdownMenuItem
                onClick={() => onSetConfirmed(asset, !currentConfirmed)}
                data-testid={`pc-asset-action-confirm-${asset.id}`}
              >
                <Icons.BadgeCheck className="h-3.5 w-3.5" />
                <span className="flex-1">
                  {currentConfirmed ? t('projectContext.actions.unsetConfirmed') : t('projectContext.actions.setConfirmed')}
                </span>
              </StyledDropdownMenuItem>
            )}
            {onSetPinned && (
              <StyledDropdownMenuItem onClick={() => onSetPinned(asset, !asset.pinned)} data-testid={`pc-asset-action-pin-${asset.id}`}>
                <Icons.Pin className="h-3.5 w-3.5" />
                <span className="flex-1">
                  {asset.pinned ? t('projectContext.actions.unpin') : t('projectContext.actions.pin')}
                </span>
              </StyledDropdownMenuItem>
            )}
            {onDelete && (
              <>
                <StyledDropdownMenuSeparator />
                <StyledDropdownMenuItem onClick={() => onDelete(asset)} variant="destructive" data-testid={`pc-asset-action-delete-${asset.id}`}>
                  <Icons.Trash2 className="h-3.5 w-3.5" />
                  <span className="flex-1">{t('projectContext.actions.delete')}</span>
                </StyledDropdownMenuItem>
              </>
            )}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
