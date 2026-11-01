import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcAssetDto, PcCapabilitiesResponse } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { AssetRow } from './AssetRow'
import { projectContextErrorKey, type PcScope } from './useProjectAssets'

/**
 * The Pin tab (POO-196, Spec v2): pinned project files plus the
 * confirmed-conclusion cards, newest pin first. Unpin (and, for managers,
 * un-confirm) returns the row to the plain file library — nothing here is
 * deleted, the tab is a pure projection of two wire filters.
 */

interface PinEntry {
  asset: PcAssetDto
  pinned: boolean
  confirmed: boolean
}

export interface ProjectPinPaneProps {
  scope: PcScope
  /** Called after any local mutation so the files tab can re-sync on return. */
  onChanged?: () => void
}

export function ProjectPinPane({ scope, onChanged }: ProjectPinPaneProps) {
  const { t } = useTranslation()
  const [capabilities, setCapabilities] = React.useState<PcCapabilitiesResponse | null>(null)
  const [entries, setEntries] = React.useState<PinEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [errorKey, setErrorKey] = React.useState<string | null>(null)
  const [busyAssetId, setBusyAssetId] = React.useState<string | null>(null)

  const scopeRef = React.useRef(scope)
  scopeRef.current = scope

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setErrorKey(null)
    try {
      const activeScope = scopeRef.current
      const [caps, pinned, confirmed] = await Promise.all([
        window.electronAPI.pcListCapabilities({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
        }),
        window.electronAPI.pcListAssets({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          pinned: 'true',
        }),
        window.electronAPI.pcListAssets({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          tag: 'confirmed',
        }),
      ])
      // Merge by id: an asset that is both pinned and confirmed shows once,
      // carrying both states.
      const merged = new Map<string, PinEntry>()
      for (const asset of pinned.assets) {
        merged.set(asset.id, { asset, pinned: true, confirmed: asset.current.confirmedAt !== null })
      }
      for (const asset of confirmed.assets) {
        const existing = merged.get(asset.id)
        if (existing) {
          existing.confirmed = true
        } else {
          merged.set(asset.id, { asset, pinned: false, confirmed: true })
        }
      }
      const list = [...merged.values()]
      // Pin time descending first; confirmed-only cards follow by confirm time.
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        const aTime = Date.parse(a.pinned ? (a.asset.pinnedAt ?? '') : (a.asset.current.confirmedAt ?? ''))
        const bTime = Date.parse(b.pinned ? (b.asset.pinnedAt ?? '') : (b.asset.current.confirmedAt ?? ''))
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
      })
      setCapabilities(caps)
      setEntries(list)
    } catch (error) {
      setErrorKey(projectContextErrorKey(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh, scope.workspaceId, scope.productSpaceId])

  const withBusy = async (asset: PcAssetDto, write: () => Promise<unknown>) => {
    setBusyAssetId(asset.id)
    try {
      await write()
      onChanged?.()
      await refresh()
    } catch (error) {
      // Revision conflicts surface verbatim — the next refresh shows the
      // authoritative state either way.
      const code = readRpcErrorCode(error)
      setErrorKey(code === 'pc_revision_conflict'
        ? 'projectContext.errors.revisionConflict'
        : projectContextErrorKey(error))
    } finally {
      setBusyAssetId(null)
    }
  }

  const handleUnpin = (asset: PcAssetDto) => {
    const activeScope = scopeRef.current
    void withBusy(asset, () => window.electronAPI.pcSetPinned({
      workspaceId: activeScope.workspaceId,
      productSpaceId: activeScope.productSpaceId,
      assetId: asset.id,
      input: { pinned: false },
    }))
  }

  const handleSetConfirmed = (target: PcAssetDto, confirmed: boolean) => {
    const activeScope = scopeRef.current
    void withBusy(target, () => window.electronAPI.pcSetConfirmed({
      workspaceId: activeScope.workspaceId,
      productSpaceId: activeScope.productSpaceId,
      assetId: target.id,
      input: { expectedVersion: target.current.version, confirmed },
    }))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="pc-pin-pane">
      {errorKey && (
        <p className="rounded-[10px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert" data-testid="pc-pin-error">
          {t(errorKey)}
        </p>
      )}

      {loading && entries.length === 0 && (
        <p className="py-6 text-center text-[13px] text-muted-foreground" role="status">
          {t('projectContext.pin.loading')}
        </p>
      )}

      {!loading && entries.length === 0 && !errorKey && (
        <div className="flex flex-col items-center justify-center gap-1 rounded-[16px] border border-dashed border-border px-5 py-10 text-center">
          <Icons.Pin className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-[13px] text-foreground">{t('projectContext.pin.emptyTitle')}</p>
          <p className="text-[12px] text-muted-foreground">{t('projectContext.pin.emptyHint')}</p>
        </div>
      )}

      {entries.map(({ asset, pinned, confirmed }) => (
        <div key={asset.id} className="relative">
          {!pinned && confirmed && (
            <span className="absolute -top-1 right-2 z-10 rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2 py-px text-[10px] font-medium text-accent">
              {t('projectContext.confirmed.badge')}
            </span>
          )}
          <AssetRow
            asset={asset}
            busy={busyAssetId === asset.id}
            canManage={capabilities?.canManage ?? false}
            onSetPinned={pinned ? handleUnpin : undefined}
            onSetConfirmed={confirmed && capabilities?.canManage ? handleSetConfirmed : undefined}
          />
        </div>
      ))}
    </div>
  )
}
