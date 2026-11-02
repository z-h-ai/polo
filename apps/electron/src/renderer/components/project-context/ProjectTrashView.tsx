import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcAssetDto } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { AssetRow, formatAssetDate } from './AssetRow'
import { cn } from '@/lib/utils'

/**
 * The trash view of the project file surface (POO-196, adjudication D6):
 * trashed assets with their retention deadline and the restore entry. v1
 * ships restore only — permanent deletion is a server-side expiry (the wire
 * has no purge RPC), so the surface never promises a manual purge.
 */

export interface ProjectTrashViewProps {
  assets: PcAssetDto[]
  loading: boolean
  errorKey: string | null
  busyAssetId: string | null
  /** X7: the server returned a cursor — a page of rows is still unpaged. */
  hasMore?: boolean
  loadingMore?: boolean
  /** X8: a failed next page re-fires from the retained rows. */
  onLoadMore?: () => void
  onRestore: (asset: PcAssetDto) => void
  onRefresh: () => void
  onBack: () => void
}

export function ProjectTrashView({ assets, loading, errorKey, busyAssetId, hasMore = false, loadingMore = false, onLoadMore, onRestore, onRefresh, onBack }: ProjectTrashViewProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="pc-trash-view">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
          onClick={onBack}
          data-testid="pc-trash-back"
        >
          <Icons.ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('projectContext.trash.back')}
        </Button>
        <span className="text-[12px] text-muted-foreground">{t('projectContext.trash.hint')}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
          onClick={onRefresh}
          disabled={loading}
          data-testid="pc-trash-refresh"
        >
          <Icons.RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
          {t('projectContext.trash.refresh')}
        </Button>
      </div>

      {errorKey && (
        <p className="rounded-[10px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert" data-testid="pc-trash-error">
          {t(errorKey)}
        </p>
      )}

      {loading && assets.length === 0 && (
        <p className="py-6 text-center text-[13px] text-muted-foreground" role="status">
          {t('projectContext.trash.loading')}
        </p>
      )}

      {!loading && !errorKey && assets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-1 rounded-[16px] border border-dashed border-border px-5 py-10 text-center">
          <Icons.Trash2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-[13px] text-foreground">{t('projectContext.trash.emptyTitle')}</p>
          <p className="text-[12px] text-muted-foreground">{t('projectContext.trash.emptyHint')}</p>
        </div>
      )}

      {assets.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-2" data-testid="pc-trash-list">
          {assets.map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              mode="trash"
              busy={busyAssetId === asset.id}
              onRestore={onRestore}
            />
          ))}
          {assets.some((asset) => asset.trashExpiresAt) && (
            <p className="px-1 pt-1 text-[11px] text-muted-foreground">
              {t('projectContext.trash.retentionNote', {
                date: formatAssetDate(
                  assets
                    .map((asset) => asset.trashExpiresAt)
                    .filter((value): value is string => !!value)
                    .sort()[0] ?? null,
                ),
              })}
            </p>
          )}
          {hasMore && onLoadMore && (
            <Button
              variant="ghost"
              className="h-8 text-[12px] text-muted-foreground"
              onClick={onLoadMore}
              disabled={loadingMore}
              data-testid="pc-trash-load-more"
            >
              {loadingMore ? t('projectContext.library.loadingMore') : t('projectContext.library.loadMore')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
