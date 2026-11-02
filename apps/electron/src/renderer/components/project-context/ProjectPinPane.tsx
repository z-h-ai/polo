import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcAssetDto, PcCapabilitiesResponse } from '@polo-ai/shared/protocol'
import { PC_LIST_LIMIT_DEFAULT } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { AssetRow } from './AssetRow'
import { ProjectCapabilityNotice } from './ProjectCapabilityNotice'
import {
  capabilityStateOf,
  isPcCapabilityBlocked,
  projectContextErrorKey,
  type PcCapabilityState,
  type PcScope,
} from './useProjectAssets'

/**
 * The Pin tab (POO-196, adjudication D5): ONLY the pinned project files,
 * newest pin first. Confirmed conclusions are deliberately NOT a second card
 * source here — they stay reachable where they belong (the files tab's
 * `confirmed` tag chip and the project summary), so "pin" keeps one meaning.
 * Unpin returns the row to the plain file library — nothing is deleted, the
 * tab is a pure projection of one wire filter.
 *
 * X23 rides along: rows carry their confirmed state inline (AssetRow badge),
 * so the floating corner badge is gone.
 */

export interface ProjectPinPaneProps {
  scope: PcScope
  /**
   * False pauses refreshes while the tab is hidden; becoming active re-syncs
   * (which is also how a Files-tab pin shows up without a manual refresh).
   */
  active?: boolean
  /** Called after any local mutation so the files tab can re-sync on return. */
  onChanged?: () => void
}

export function ProjectPinPane({ scope, active = true, onChanged }: ProjectPinPaneProps) {
  const { t } = useTranslation()
  const [capabilities, setCapabilities] = React.useState<PcCapabilitiesResponse | null>(null)
  const [capabilityState, setCapabilityState] = React.useState<PcCapabilityState>('idle')
  const [entries, setEntries] = React.useState<PcAssetDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [errorKey, setErrorKey] = React.useState<string | null>(null)
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [loadMoreErrorKey, setLoadMoreErrorKey] = React.useState<string | null>(null)
  const [busyAssetId, setBusyAssetId] = React.useState<string | null>(null)

  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const activeRef = React.useRef(active)
  activeRef.current = active
  // Request token: a stale response (scope switch / reactivation race) is
  // dropped instead of overwriting the newer view.
  const seqRef = React.useRef(0)

  const fetchPage = React.useCallback(async (cursor?: string) => {
    const currentScope = scopeRef.current
    if (!currentScope) throw new Error('project context scope is unavailable')
    return window.electronAPI.pcListAssets({
      workspaceId: currentScope.workspaceId,
      productSpaceId: currentScope.productSpaceId,
      view: 'active',
      pinned: 'true',
      limit: PC_LIST_LIMIT_DEFAULT,
      cursor,
    })
  }, [])

  const loadFirstPage = React.useCallback(async () => {
    const token = seqRef.current
    setLoading(true)
    setErrorKey(null)
    setLoadMoreErrorKey(null)
    try {
      const page = await fetchPage()
      if (token !== seqRef.current || !activeRef.current) return
      setEntries(page.assets)
      setNextCursor(page.nextCursor ?? null)
    } catch (error) {
      if (token !== seqRef.current || !activeRef.current) return
      setErrorKey(projectContextErrorKey(error))
    } finally {
      if (token === seqRef.current) setLoading(false)
    }
  }, [fetchPage])

  const loadMore = React.useCallback(async () => {
    if (!nextCursor || loadingMore) return
    const token = seqRef.current
    setLoadingMore(true)
    setLoadMoreErrorKey(null)
    try {
      const page = await fetchPage(nextCursor)
      if (token !== seqRef.current || !activeRef.current) return
      // Dedup by id: a row re-pinned between pages must not appear twice.
      setEntries((prev) => {
        const seen = new Set(prev.map((asset) => asset.id))
        return [...prev, ...page.assets.filter((asset) => !seen.has(asset.id))]
      })
      setNextCursor(page.nextCursor ?? null)
    } catch (error) {
      // X8: the cursor survives a failed page, so the retry re-fires from the
      // rows the user already has.
      if (token !== seqRef.current || !activeRef.current) return
      setLoadMoreErrorKey(projectContextErrorKey(error))
    } finally {
      if (token === seqRef.current) setLoadingMore(false)
    }
  }, [fetchPage, nextCursor, loadingMore])

  const refresh = React.useCallback(async () => {
    // Capability discovery settles FIRST and on its own: a list failure can
    // never erase a feature-disabled state, and a disabled feature never
    // issues a doomed list call (consensus S-08+E-3).
    const token = ++seqRef.current
    let caps: PcCapabilitiesResponse | null = null
    let capsError: unknown = null
    try {
      const currentScope = scopeRef.current
      caps = await window.electronAPI.pcListCapabilities({
        workspaceId: currentScope.workspaceId,
        productSpaceId: currentScope.productSpaceId,
      })
    } catch (error) {
      capsError = error
    }
    if (token !== seqRef.current || !activeRef.current) return
    setCapabilities(caps)
    const state = capabilityStateOf(caps, capsError)
    setCapabilityState(state)
    if (isPcCapabilityBlocked(state)) {
      setEntries([])
      setNextCursor(null)
      setLoading(false)
      return
    }
    await loadFirstPage()
  }, [loadFirstPage])

  React.useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh, scope.workspaceId, scope.productSpaceId])

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

  if (isPcCapabilityBlocked(capabilityState)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2" data-testid="pc-pin-blocked">
        <ProjectCapabilityNotice state={capabilityState} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2" data-testid="pc-pin-pane">
      {errorKey && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          role="alert"
          data-testid="pc-pin-error"
        >
          <span className="flex-1">{t(errorKey)}</span>
          <Button
            variant="ghost"
            className="h-6 px-2 text-[12px] text-destructive"
            onClick={() => void refresh()}
            data-testid="pc-pin-error-retry"
          >
            {t('projectContext.library.retry')}
          </Button>
        </div>
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

      {entries.map((asset) => (
        <AssetRow
          key={asset.id}
          asset={asset}
          busy={busyAssetId === asset.id}
          canManage={capabilities?.canManage ?? false}
          onSetPinned={handleUnpin}
          onSetConfirmed={capabilities?.canManage ? handleSetConfirmed : undefined}
        />
      ))}

      {loadMoreErrorKey && (
        <p className="rounded-[10px] border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert" data-testid="pc-pin-load-error">
          {t(loadMoreErrorKey)}
        </p>
      )}
      {nextCursor && (
        <Button
          variant="ghost"
          className="h-8 text-[12px] text-muted-foreground"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          data-testid="pc-pin-load-more"
        >
          {loadingMore ? t('projectContext.library.loadingMore') : t('projectContext.library.loadMore')}
        </Button>
      )}
    </div>
  )
}
