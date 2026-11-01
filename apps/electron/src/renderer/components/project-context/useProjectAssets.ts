import * as React from 'react'
import type {
  PcAssetDto,
  PcAssetListResponse,
  PcCapabilitiesResponse,
} from '@polo-ai/shared/protocol'
import { PC_LIST_LIMIT_DEFAULT } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

/**
 * POO-196 renderer data hook for the project file surface (files / pin /
 * trash views). Owns: capability discovery, the active + trash lists with
 * their filters (debounced query, tag, processing status), cursor pagination
 * and local upsert/remove so a mutation never needs a full refetch to look
 * right. Error codes surface as i18n keys — the mapping below is the ONE
 * place that knows the `pc_*` → copy mapping.
 */

/** Search debounce (Apple HIG: instant feel without request storms). */
export const PC_SEARCH_DEBOUNCE_MS = 300

export type PcStatusFilter = 'all' | 'processing' | 'failed'
export type PcViewMode = 'active' | 'trash'

/** Every `pc_*` error code the contract can put on the wire, mapped to its i18n key. */
const PC_ERROR_KEYS: Record<string, string> = {
  pc_forbidden: 'projectContext.errors.forbidden',
  pc_not_found: 'projectContext.errors.notFound',
  pc_feature_disabled: 'projectContext.errors.featureDisabled',
  pc_read_only: 'projectContext.errors.readOnly',
  pc_library_not_ready: 'projectContext.errors.libraryNotReady',
  pc_validation_error: 'projectContext.errors.validation',
  pc_revision_conflict: 'projectContext.errors.revisionConflict',
  pc_replace_not_uploader: 'projectContext.errors.replaceNotUploader',
  pc_confirmed_required: 'projectContext.errors.confirmedRequired',
  pc_upload_not_found: 'projectContext.errors.uploadNotFound',
  pc_upload_expired: 'projectContext.errors.uploadExpired',
  pc_upload_too_large: 'projectContext.errors.uploadTooLarge',
  pc_upload_failed: 'projectContext.errors.uploadFailed',
  pc_content_not_indexed: 'projectContext.errors.contentNotIndexed',
  pc_trash_expired: 'projectContext.errors.trashExpired',
  pc_service_unavailable: 'projectContext.errors.serviceUnavailable',
  pc_signin_required: 'projectContext.errors.signinRequired',
}

/**
 * The ONE error-code → i18n-key mapping for the whole project-context surface.
 * A coded `pc_*` failure maps to its user-facing copy; anything else (transport
 * loss, non-coded Error) degrades to the generic retryable text.
 */
export function projectContextErrorKey(error: unknown): string {
  const code = readRpcErrorCode(error)
  if (code && PC_ERROR_KEYS[code]) return PC_ERROR_KEYS[code]
  return 'projectContext.errors.generic'
}

/** True when the error carries the given `pc_*` code (bridge-carriable aware). */
export function isPcError(error: unknown, code: string): boolean {
  return readRpcErrorCode(error) === code
}

export interface PcScope {
  workspaceId: string
  productSpaceId: string
}

export interface PcFilters {
  /** Raw search text; the debounced value is what reaches the wire. */
  q: string
  /** Selected tag id (preset id or `confirmed`), or null for no tag filter. */
  tag: string | null
  status: PcStatusFilter
}

interface UseProjectAssetsOptions {
  scope: PcScope | null
  /** False keeps the hook idle (personal sessions never issue pc calls). */
  enabled: boolean
}

export interface UseProjectAssetsResult {
  capabilities: PcCapabilitiesResponse | null
  /** i18n key describing why capabilities could not load, when they could not. */
  capabilitiesErrorKey: string | null
  assets: PcAssetDto[]
  loading: boolean
  errorKey: string | null
  hasMore: boolean
  loadingMore: boolean
  filters: PcFilters
  /** Debounced query — the value the current list was fetched with. */
  debouncedQ: string
  setFilters: React.Dispatch<React.SetStateAction<PcFilters>>
  view: PcViewMode
  setView: (view: PcViewMode) => void
  trashAssets: PcAssetDto[]
  trashLoading: boolean
  trashErrorKey: string | null
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  /** Replace/add one asset in the local list (mutation responses carry the DTO). */
  upsertAsset: (asset: PcAssetDto) => void
  /** Drop one asset from the local active list. */
  removeAsset: (assetId: string) => void
  refreshTrash: () => Promise<void>
  upsertTrashAsset: (asset: PcAssetDto) => void
  removeTrashAsset: (assetId: string) => void
}

function applyStatusFilter(assets: PcAssetDto[], status: PcStatusFilter): PcAssetDto[] {
  if (status === 'all') return assets
  return assets.filter((asset) => asset.current.processing === status)
}

export function useProjectAssets({ scope, enabled }: UseProjectAssetsOptions): UseProjectAssetsResult {
  const [capabilities, setCapabilities] = React.useState<PcCapabilitiesResponse | null>(null)
  const [capabilitiesErrorKey, setCapabilitiesErrorKey] = React.useState<string | null>(null)
  const [page, setPage] = React.useState<PcAssetListResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [errorKey, setErrorKey] = React.useState<string | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [filters, setFilters] = React.useState<PcFilters>({ q: '', tag: null, status: 'all' })
  const [debouncedQ, setDebouncedQ] = React.useState('')
  const [view, setViewState] = React.useState<PcViewMode>('active')
  const [trash, setTrash] = React.useState<PcAssetListResponse | null>(null)
  const [trashLoading, setTrashLoading] = React.useState(false)
  const [trashErrorKey, setTrashErrorKey] = React.useState<string | null>(null)

  const scopeKey = scope ? `${scope.workspaceId}::${scope.productSpaceId}` : null
  const requestSeq = React.useRef(0)

  // Debounce the query (300ms) before it reaches the wire.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(filters.q.trim()), PC_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters.q])

  const listPage = React.useCallback(async (options: {
    q?: string
    tag: string | null
    cursor?: string
  }): Promise<PcAssetListResponse> => {
    if (!scope) throw new Error('project context scope is unavailable')
    return window.electronAPI.pcListAssets({
      workspaceId: scope.workspaceId,
      productSpaceId: scope.productSpaceId,
      view: 'active',
      q: options.q || undefined,
      tag: options.tag ?? undefined,
      limit: PC_LIST_LIMIT_DEFAULT,
      cursor: options.cursor,
    })
  }, [scope])

  const refresh = React.useCallback(async () => {
    if (!scope || !enabled) return
    const seq = ++requestSeq.current
    setLoading(true)
    setErrorKey(null)
    try {
      const [caps, list] = await Promise.all([
        window.electronAPI.pcListCapabilities({
          workspaceId: scope.workspaceId,
          productSpaceId: scope.productSpaceId,
        }),
        listPage({ q: debouncedQ, tag: filters.tag }),
      ])
      if (seq !== requestSeq.current) return
      setCapabilities(caps)
      setPage(list)
    } catch (error) {
      if (seq !== requestSeq.current) return
      setCapabilities(null)
      setPage(null)
      setErrorKey(projectContextErrorKey(error))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [scope, enabled, listPage, debouncedQ, filters.tag])

  // Refetch whenever the scope, activation or a committed filter changes.
  React.useEffect(() => {
    void refresh()
  }, [refresh, scopeKey])

  const loadMore = React.useCallback(async () => {
    if (!scope || !enabled || loadingMore || !page?.nextCursor) return
    setLoadingMore(true)
    try {
      const next = await listPage({ q: debouncedQ, tag: filters.tag, cursor: page.nextCursor })
      setPage((prev) => prev
        ? { ...next, assets: [...prev.assets, ...next.assets] }
        : next)
    } catch (error) {
      setErrorKey(projectContextErrorKey(error))
    } finally {
      setLoadingMore(false)
    }
  }, [scope, enabled, loadingMore, page?.nextCursor, listPage, debouncedQ, filters.tag])

  const refreshTrash = React.useCallback(async () => {
    if (!scope || !enabled) return
    setTrashLoading(true)
    setTrashErrorKey(null)
    try {
      const list = await window.electronAPI.pcListAssets({
        workspaceId: scope.workspaceId,
        productSpaceId: scope.productSpaceId,
        view: 'trash',
        limit: PC_LIST_LIMIT_DEFAULT,
      })
      setTrash(list)
    } catch (error) {
      setTrash(null)
      setTrashErrorKey(projectContextErrorKey(error))
    } finally {
      setTrashLoading(false)
    }
  }, [scope, enabled])

  // Trash data loads lazily on first entry and on re-entry after a change.
  React.useEffect(() => {
    if (view === 'trash') void refreshTrash()
  }, [view, refreshTrash])

  const setView = React.useCallback((next: PcViewMode) => {
    setViewState(next)
  }, [])

  const upsertAsset = React.useCallback((asset: PcAssetDto) => {
    setPage((prev) => {
      if (!prev) return prev
      const exists = prev.assets.some((candidate) => candidate.id === asset.id)
      return {
        ...prev,
        assets: exists
          ? prev.assets.map((candidate) => (candidate.id === asset.id ? asset : candidate))
          : [asset, ...prev.assets],
      }
    })
  }, [])

  const removeAsset = React.useCallback((assetId: string) => {
    setPage((prev) => prev
      ? { ...prev, assets: prev.assets.filter((candidate) => candidate.id !== assetId) }
      : prev)
  }, [])

  const upsertTrashAsset = React.useCallback((asset: PcAssetDto) => {
    setTrash((prev) => {
      if (!prev) return prev
      const exists = prev.assets.some((candidate) => candidate.id === asset.id)
      return {
        ...prev,
        assets: exists
          ? prev.assets.map((candidate) => (candidate.id === asset.id ? asset : candidate))
          : [asset, ...prev.assets],
      }
    })
  }, [])

  const removeTrashAsset = React.useCallback((assetId: string) => {
    setTrash((prev) => prev
      ? { ...prev, assets: prev.assets.filter((candidate) => candidate.id !== assetId) }
      : prev)
  }, [])

  const assets = React.useMemo(
    () => applyStatusFilter(page?.assets ?? [], filters.status),
    [page?.assets, filters.status],
  )
  const trashAssets = React.useMemo(() => trash?.assets ?? [], [trash?.assets])

  return {
    capabilities,
    capabilitiesErrorKey,
    assets,
    loading,
    errorKey: errorKey ?? capabilitiesErrorKey,
    hasMore: Boolean(page?.nextCursor),
    loadingMore,
    filters,
    debouncedQ,
    setFilters,
    view,
    setView,
    trashAssets,
    trashLoading,
    trashErrorKey,
    refresh,
    loadMore,
    upsertAsset,
    removeAsset,
    refreshTrash,
    upsertTrashAsset,
    removeTrashAsset,
  }
}
