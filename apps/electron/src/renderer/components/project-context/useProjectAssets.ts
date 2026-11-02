import * as React from 'react'
import type {
  PcAssetDto,
  PcAssetListResponse,
  PcCapabilitiesResponse,
  PcListProcessingFilter,
} from '@polo-ai/shared/protocol'
import { PC_LIST_LIMIT_DEFAULT } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

/**
 * POO-196 renderer data hook for the project file surface (files / pin /
 * trash views). Owns: capability discovery, the active + trash lists with
 * their filters (debounced query, tag, processing status), cursor pagination,
 * a bounded poll for still-processing rows, and local upsert/remove so a
 * mutation never needs a full refetch to look right. Error codes surface as
 * i18n keys — the mapping below is the ONE place that knows the `pc_*` → copy
 * mapping.
 */

/** Search debounce (Apple HIG: instant feel without request storms). */
export const PC_SEARCH_DEBOUNCE_MS = 300

/** Bounded poll for processing rows (consensus E-2): 1s doubling to 8s, at
 * most 60s per asset, then it gives up silently — the row keeps its 处理中
 * badge and the next manual refresh picks the final state up. */
export const PC_POLL_BASE_MS = 1_000
export const PC_POLL_MAX_MS = 8_000
export const PC_POLL_BUDGET_MS = 60_000
/** Poll terminal states. `published` is deliberately NOT one: a version can
 * publish while its index work is still running (adjudication D3.1.4). */
const PC_POLL_TERMINAL_STATES = new Set(['indexed', 'failed', 'unsupported'])

export type PcStatusFilter =
  | 'all'
  | 'available'
  | 'processing'
  | 'failed'
  | 'indexed'
  | 'unsupported'
export type PcViewMode = 'active' | 'trash'

/**
 * Capability gate (consensus S-08+E-3): resolved independently of the lists so
 * a list failure can never erase a feature-disabled state, and a disabled
 * feature never issues a doomed list call. A blocked state replaces the whole
 * pane with neutral guidance copy (no engine vocabulary, R8a) — each state has
 * its own i18n key pair under `projectContext.capability.*`.
 */
export type PcCapabilityState =
  | 'idle'
  | 'loading'
  | 'ok'
  | 'not_configured'
  | 'storage_unavailable'
  | 'signed_out'
  | 'forbidden'
  | 'service_unavailable'

/**
 * The states that hide the library and show the neutral guidance instead.
 * `service_unavailable` is deliberately NOT blocking (consensus S-08 two-tier
 * degradation): a transient capabilities read failure keeps the pane and
 * surfaces as the retryable `pc-error` banner via the `capabilitiesErrorKey`
 * fallback, so a flaky read never erases an already-loaded list.
 */
export function isPcCapabilityBlocked(state: PcCapabilityState): boolean {
  return state === 'not_configured'
    || state === 'storage_unavailable'
    || state === 'signed_out'
    || state === 'forbidden'
}

/** True when the wire accepts this filter as the `processing` query param. */
function wireProcessingFilter(status: PcStatusFilter): PcListProcessingFilter | undefined {
  return status === 'all' ? undefined : status
}

/** Every `pc_*` error code the surface can produce, mapped to its i18n key. */
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
  pc_unavailable_in_personal: 'projectContext.errors.unavailableInPersonal',
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
  /** False pauses refresh + polling (pane hidden); re-activation re-syncs. */
  active?: boolean
}

export interface UseProjectAssetsResult {
  capabilities: PcCapabilitiesResponse | null
  /** The capability gate state machine — see PcCapabilityState. */
  capabilityState: PcCapabilityState
  /** i18n key describing why capabilities could not load, when they could not. */
  capabilitiesErrorKey: string | null
  assets: PcAssetDto[]
  /** Every loaded page's rows (pre-filter) — the source for chip collections. */
  loadedAssets: PcAssetDto[]
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
  trashHasMore: boolean
  trashLoadingMore: boolean
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  /** Replace/add one asset in the local list (mutation responses carry the DTO). */
  upsertAsset: (asset: PcAssetDto) => void
  /** Drop one asset from the local active list. */
  removeAsset: (assetId: string) => void
  refreshTrash: () => Promise<void>
  loadMoreTrash: () => Promise<void>
  upsertTrashAsset: (asset: PcAssetDto) => void
  removeTrashAsset: (assetId: string) => void
}

function applyStatusFilter(assets: PcAssetDto[], status: PcStatusFilter): PcAssetDto[] {
  if (status === 'all') return assets
  // `available` = indexed + unsupported: a stored file that cannot be indexed
  // is still usable — never relabelled as full-text searchable (consensus S-09).
  if (status === 'available') {
    return assets.filter((asset) => asset.current.processing === 'indexed'
      || asset.current.processing === 'unsupported')
  }
  return assets.filter((asset) => asset.current.processing === status)
}

/** Maps a gate state to its neutral title/hint i18n key pair. */
export function pcCapabilityCopyKeys(state: PcCapabilityState): { titleKey: string; hintKey: string } | null {
  switch (state) {
    case 'not_configured':
      return { titleKey: 'projectContext.capability.notConfiguredTitle', hintKey: 'projectContext.capability.notConfiguredHint' }
    case 'storage_unavailable':
      return { titleKey: 'projectContext.capability.storageUnavailableTitle', hintKey: 'projectContext.capability.storageUnavailableHint' }
    case 'signed_out':
      return { titleKey: 'projectContext.capability.signedOutTitle', hintKey: 'projectContext.capability.signedOutHint' }
    case 'forbidden':
      return { titleKey: 'projectContext.capability.forbiddenTitle', hintKey: 'projectContext.capability.forbiddenHint' }
    case 'service_unavailable':
      return { titleKey: 'projectContext.capability.serviceUnavailableTitle', hintKey: 'projectContext.capability.serviceUnavailableHint' }
    default:
      return null
  }
}

/** Derives the gate state from the capabilities answer (or its failure).
 * Shared with the Pin pane so every tab reads the same capability face. */
export function capabilityStateOf(caps: PcCapabilitiesResponse | null, error: unknown): PcCapabilityState {
  if (caps) {
    if (!caps.featureEnabled) {
      return caps.disabledReason === 'storage_unavailable' ? 'storage_unavailable' : 'not_configured'
    }
    return 'ok'
  }
  const code = readRpcErrorCode(error)
  if (code === 'pc_signin_required') return 'signed_out'
  if (code === 'pc_forbidden') return 'forbidden'
  // The feature being switched off at the source is a persistent, neutral
  // state — same face as `featureEnabled=false`, not a transient outage.
  if (code === 'pc_feature_disabled') return 'not_configured'
  return 'service_unavailable'
}

export function useProjectAssets({ scope, enabled, active = true }: UseProjectAssetsOptions): UseProjectAssetsResult {
  const [capabilities, setCapabilities] = React.useState<PcCapabilitiesResponse | null>(null)
  const [capabilityState, setCapabilityState] = React.useState<PcCapabilityState>('idle')
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
  const [trashLoadingMore, setTrashLoadingMore] = React.useState(false)

  const scopeKey = scope ? `${scope.workspaceId}::${scope.productSpaceId}` : null
  const isActive = Boolean(scope) && enabled && active
  const requestSeq = React.useRef(0)
  const capsSeq = React.useRef(0)
  const pollSeq = React.useRef(0)

  // Latest-value holders: the poll chain and list calls stay stable per scope
  // and read the live values through refs instead of re-binding on every state
  // change (which would re-fire the mount effect on every keystroke).
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const activeRef = React.useRef(isActive)
  activeRef.current = isActive
  const filtersRef = React.useRef(filters)
  filtersRef.current = filters
  const debouncedQRef = React.useRef(debouncedQ)
  debouncedQRef.current = debouncedQ

  // Debounce the query (300ms) before it reaches the wire.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(filters.q.trim()), PC_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters.q])

  const listPage = React.useCallback(async (options: {
    q?: string
    tag: string | null
    status: PcStatusFilter
    cursor?: string
  }): Promise<PcAssetListResponse> => {
    const currentScope = scopeRef.current
    if (!currentScope) throw new Error('project context scope is unavailable')
    return window.electronAPI.pcListAssets({
      workspaceId: currentScope.workspaceId,
      productSpaceId: currentScope.productSpaceId,
      view: 'active',
      q: options.q || undefined,
      tag: options.tag ?? undefined,
      // Pushed to the admin list so filtering happens BEFORE pagination
      // (consensus X10); the local filter below stays as the safety net for
      // rows inserted locally after the fetch.
      processing: wireProcessingFilter(options.status),
      limit: PC_LIST_LIMIT_DEFAULT,
      cursor: options.cursor,
    })
  }, [])

  /* ---------------- processing poll (consensus E-2) ---------------- */

  const pollersRef = React.useRef<Map<string, { timer: number; attempts: number; startedAt: number }>>(new Map())

  const stopPolling = React.useCallback((assetId: string) => {
    const entry = pollersRef.current.get(assetId)
    if (!entry) return
    window.clearTimeout(entry.timer)
    pollersRef.current.delete(assetId)
  }, [])

  const stopAllPolling = React.useCallback(() => {
    for (const entry of pollersRef.current.values()) window.clearTimeout(entry.timer)
    pollersRef.current.clear()
  }, [])

  // Property holder so the poll chain can recurse without a circular
  // useCallback dependency (and so the closure always sees the latest scope).
  const pollRunRef = React.useRef<{ run: (assetId: string, attempts: number, startedAt: number) => Promise<void> }>({
    run: async () => {},
  })

  /** Arms (or re-arms) the bounded poll for one asset. */
  const schedulePoll = React.useCallback((assetId: string, delay: number, attempts: number, startedAt: number) => {
    stopPolling(assetId)
    if (!activeRef.current || !scopeRef.current) return
    const timer = window.setTimeout(() => {
      void pollRunRef.current.run(assetId, attempts, startedAt)
    }, delay)
    pollersRef.current.set(assetId, { timer, attempts, startedAt })
  }, [stopPolling])

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
    if (asset.current.processing === 'processing' && !pollersRef.current.has(asset.id)) {
      schedulePoll(asset.id, PC_POLL_BASE_MS, 0, Date.now())
    }
  }, [schedulePoll])

  pollRunRef.current.run = async (assetId, attempts, startedAt) => {
    const currentScope = scopeRef.current
    if (!currentScope || !activeRef.current) return
    const seq = ++pollSeq.current
    let next: PcAssetDto | null = null
    let gone = false
    try {
      const result = await window.electronAPI.pcGetAsset({
        workspaceId: currentScope.workspaceId,
        productSpaceId: currentScope.productSpaceId,
        assetId,
      })
      next = result.asset
    } catch (error) {
      // The asset vanished mid-poll: terminal, nothing to keep waiting for.
      gone = isPcError(error, 'pc_not_found')
      if (!gone) next = null
    }
    if (seq !== pollSeq.current || scopeRef.current !== currentScope || !activeRef.current) return
    if (gone) {
      stopPolling(assetId)
      return
    }
    if (next) upsertAsset(next)
    if (!next || PC_POLL_TERMINAL_STATES.has(next.current.processing)) {
      stopPolling(assetId)
      return
    }
    if (Date.now() - startedAt >= PC_POLL_BUDGET_MS) {
      stopPolling(assetId)
      return
    }
    const delay = Math.min(PC_POLL_BASE_MS * 2 ** Math.min(attempts, 4), PC_POLL_MAX_MS)
    schedulePoll(assetId, delay, attempts + 1, startedAt)
  }

  /** Starts polls for every still-processing row that has none yet. */
  const ensurePolling = React.useCallback((assets: readonly PcAssetDto[]) => {
    if (!activeRef.current || !scopeRef.current) return
    for (const asset of assets) {
      if (asset.current.processing !== 'processing') continue
      if (pollersRef.current.has(asset.id)) continue
      schedulePoll(asset.id, PC_POLL_BASE_MS, 0, Date.now())
    }
  }, [schedulePoll])

  /* ---------------- fetch chains ---------------- */

  const refreshCapabilities = React.useCallback(async (): Promise<boolean> => {
    const currentScope = scopeRef.current
    if (!currentScope) return false
    const seq = ++capsSeq.current
    setCapabilityState('loading')
    try {
      const caps = await window.electronAPI.pcListCapabilities({
        workspaceId: currentScope.workspaceId,
        productSpaceId: currentScope.productSpaceId,
      })
      if (seq !== capsSeq.current || scopeRef.current !== currentScope) return false
      const next = capabilityStateOf(caps, null)
      setCapabilities(caps)
      setCapabilityState(next)
      setCapabilitiesErrorKey(null)
      return next === 'ok'
    } catch (error) {
      if (seq !== capsSeq.current || scopeRef.current !== currentScope) return false
      setCapabilities(null)
      setCapabilityState(capabilityStateOf(null, error))
      setCapabilitiesErrorKey(projectContextErrorKey(error))
      return false
    }
  }, [])

  const refreshList = React.useCallback(async () => {
    const currentScope = scopeRef.current
    if (!currentScope || !activeRef.current) return
    const currentFilters = filtersRef.current
    const seq = ++requestSeq.current
    setLoading(true)
    setErrorKey(null)
    try {
      const list = await listPage({
        q: debouncedQRef.current,
        tag: currentFilters.tag,
        status: currentFilters.status,
      })
      if (seq !== requestSeq.current || scopeRef.current !== currentScope) return
      setPage(list)
      ensurePolling(list.assets)
      // The authoritative page landed: later filter changes may re-fetch the
      // list alone (capabilities stay put).
      listReadyRef.current = true
    } catch (error) {
      if (seq !== requestSeq.current || scopeRef.current !== currentScope) return
      setPage(null)
      setErrorKey(projectContextErrorKey(error))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [listPage, ensurePolling])

  /** Full re-sync: capabilities first (a blocked gate must not fire a doomed
   * list call), then the list. Capabilities survive list failures (#7). */
  const refresh = React.useCallback(async () => {
    if (!activeRef.current) return
    const ok = await refreshCapabilities()
    if (!ok) return
    await refreshList()
  }, [refreshCapabilities, refreshList])

  const listReadyRef = React.useRef(false)
  // Scope / activation changes re-read authoritative state; a pane becoming
  // visible again pauses its polls while hidden and re-syncs on return (X6).
  React.useEffect(() => {
    if (!isActive) {
      stopAllPolling()
      return
    }
    listReadyRef.current = false
    void refresh()
  }, [scopeKey, isActive, refresh, stopAllPolling])

  // Scope switches and unmounts must not leave timers behind.
  React.useEffect(() => {
    pollSeq.current += 1
    stopAllPolling()
  }, [scopeKey, stopAllPolling])

  React.useEffect(() => () => {
    stopAllPolling()
    pollSeq.current += 1
  }, [stopAllPolling])

  // Committed filter changes re-fetch the list only — capabilities are stable
  // per scope and a list failure must not reset them (#7).
  React.useEffect(() => {
    if (!isActive || !listReadyRef.current) return
    void refreshList()
  }, [debouncedQ, filters.tag, filters.status, isActive, refreshList])

  const loadMore = React.useCallback(async () => {
    const currentScope = scopeRef.current
    if (!currentScope || !activeRef.current || loadingMore || !page?.nextCursor) return
    setLoadingMore(true)
    try {
      const next = await listPage({
        q: debouncedQRef.current,
        tag: filtersRef.current.tag,
        status: filtersRef.current.status,
        cursor: page.nextCursor,
      })
      setPage((prev) => (prev
        ? { ...next, assets: [...prev.assets, ...next.assets] }
        : next))
      ensurePolling(next.assets)
    } catch (error) {
      setErrorKey(projectContextErrorKey(error))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, page?.nextCursor, listPage, ensurePolling])

  const refreshTrash = React.useCallback(async () => {
    const currentScope = scopeRef.current
    if (!currentScope || !activeRef.current) return
    setTrashLoading(true)
    setTrashErrorKey(null)
    try {
      const list = await window.electronAPI.pcListAssets({
        workspaceId: currentScope.workspaceId,
        productSpaceId: currentScope.productSpaceId,
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
  }, [activeRef])

  const loadMoreTrash = React.useCallback(async () => {
    const currentScope = scopeRef.current
    if (!currentScope || !activeRef.current || trashLoadingMore || !trash?.nextCursor) return
    setTrashLoadingMore(true)
    try {
      const next = await window.electronAPI.pcListAssets({
        workspaceId: currentScope.workspaceId,
        productSpaceId: currentScope.productSpaceId,
        view: 'trash',
        limit: PC_LIST_LIMIT_DEFAULT,
        cursor: trash.nextCursor,
      })
      setTrash((prev) => (prev
        ? { ...next, assets: [...prev.assets, ...next.assets] }
        : next))
    } catch (error) {
      // Page-level failure: keep the loaded rows, surface the retry banner.
      setTrashErrorKey(projectContextErrorKey(error))
    } finally {
      setTrashLoadingMore(false)
    }
  }, [trashLoadingMore, trash?.nextCursor, activeRef])

  // Trash data loads lazily on first entry and on re-entry after a change.
  React.useEffect(() => {
    if (view === 'trash' && isActive) void refreshTrash()
  }, [view, isActive, refreshTrash])

  const setView = React.useCallback((next: PcViewMode) => {
    setViewState(next)
  }, [])

  const removeAsset = React.useCallback((assetId: string) => {
    stopPolling(assetId)
    setPage((prev) => prev
      ? { ...prev, assets: prev.assets.filter((candidate) => candidate.id !== assetId) }
      : prev)
  }, [stopPolling])

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
    capabilityState,
    capabilitiesErrorKey,
    assets,
    loadedAssets: page?.assets ?? [],
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
    trashHasMore: Boolean(trash?.nextCursor),
    trashLoadingMore,
    refresh,
    loadMore,
    upsertAsset,
    removeAsset,
    refreshTrash,
    loadMoreTrash,
    upsertTrashAsset,
    removeTrashAsset,
  }
}
