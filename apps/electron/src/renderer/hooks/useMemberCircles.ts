import { parseMemberCircleSupportState, MemberCircleInvalidResponseError } from '@polo-ai/shared/admin/member-circles'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MemberCircleApiErrorCode,
  MemberCircleCheckoutResult,
  MemberCircleLeaveMembership,
  MemberCircleRenewalPreview,
  MemberCircleSnapshot,
  MemberCircleSupportState,
  MemberCircleUpstreamPendingState,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'
import type { MemberCircleRpcResult } from '../../shared/types'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import {
  selectMemberCircleDetail,
  type MemberCircleDetailView,
} from '@/lib/member-circle-view'

/**
 * Member circle read state (POO-70 C2 / POO-90).
 *
 * ONE trusted read surface per account + personal ProductSpace binding, fed
 * exclusively by the C1 trusted RPC bridge (`electronAPI.memberCircles`). The
 * main process derives the permission subject from the trusted Admin session;
 * this hook never sends a userId and never treats cached rows as
 * authorization (P70-CIRCLE-STATE-01/03).
 *
 * Scope fencing (P70-CIRCLE-STATE-01): every authoritative row lives under
 * `accountId + personalProductSpaceId + epoch`. The epoch is the ProductSpace
 * context's monotonic `contextVersion`, so an A→B→A account round-trip can
 * never reuse a previous binding's rows. When the binding changes the state
 * is dropped synchronously — the previous account's data immediately loses
 * display authority and a late response can never resurrect it.
 *
 * Request generations (P70-CIRCLE-STATE-02): each authoritative fetch bumps a
 * monotonic generation; a response applies only while BOTH its generation and
 * its captured scope fence are still current. Slow replies from a previous
 * account/space are discarded, never merged. Enterprise spaces are denied
 * before any request is issued (the spec has no "我的圈子" in enterprise
 * spaces), so an enterprise session can never even trigger a read of the
 * personal circle data — and never shows the previous account's rows.
 *
 * Command fencing: `leave` / `previewRenewal` / `getOrder` /
 * `getCheckoutResult` / `getUpdates` / `getProfile` / `getSupport` capture
 * the scope fence before the call and re-validate it before the result is
 * returned; a fence miss is reported as `session_changed` and nothing is
 * cached. No payment polling exists on this surface — checkout results are
 * single authoritative reads (G5), re-read only on demand.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Distinct read phases for the authoritative relations list. `empty` is a
 * legitimate success (no membership), never a failure shape; `offline`
 * (network-class failure with no rows yet) is distinct from `error`;
 * `partial` means one of the two authoritative reads succeeded.
 */
export type MemberCirclesReadPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'denied'
  | 'offline'
  | 'partial'

export type MemberCircleReadErrorCode =
  | MemberCircleApiErrorCode
  | 'session_changed'
  | 'session_unavailable'

export interface MemberCircleReadError {
  code: MemberCircleReadErrorCode
  /** Session/scope errors and transport outages are retryable by design. */
  retryable: boolean
}

/**
 * The fence identity of every authoritative row: account + PERSONAL space
 * binding + monotonic epoch. `contextKey` is the collision-free versioned
 * tuple; `epoch` (the ProductSpace contextVersion) is what makes an
 * A→B→A round-trip unable to reuse the first A's rows.
 */
export interface MemberCircleScopeKey {
  accountId: string
  personalProductSpaceId: string
  contextKey: string
  epoch: number
}

/** Kind of the currently published scope binding. */
export type MemberCircleScopeKind = 'none' | 'denied' | 'personal'

export interface MemberCirclesResourceState {
  phase: MemberCirclesReadPhase
  scope: MemberCircleScopeKey | null
  /** Authoritative circles receipt; null = none in THIS scope yet. */
  circles: MemberCircleSnapshot[] | null
  /** Authoritative memberships receipt; null = none in THIS scope yet. */
  memberships: MemberMembership[] | null
  circlesError: MemberCircleReadError | null
  membershipsError: MemberCircleReadError | null
  /** An authoritative relations fetch is in flight. */
  refreshing: boolean
  updatedAt: number | null
}

/**
 * G2/G3 capability reads cache: per circleId. `upstream_pending` is a READY
 * capability fact (the provider has no member-side endpoint yet) — rendered
 * as awaiting-upstream, never as an empty list and never as an error.
 */
export type MemberCircleUpstreamReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; state: MemberCircleUpstreamPendingState }
  | { phase: 'failed'; error: MemberCircleReadError }

/** G4 support-config read state (C1 bridge result; S1 renders it). */
export type MemberCircleSupportReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; state: MemberCircleSupportState }
  | { phase: 'failed'; error: MemberCircleReadError }

export type MemberCirclesRefreshOutcome =
  | { skipped: true; reason: 'no_scope' | 'bridge_unavailable' | 'superseded' }
  | { skipped: false; circles: 'ok' | 'failed'; memberships: 'ok' | 'failed' }

/**
 * Result of the shared invalidation round-trip. `relations: 'partial'` means
 * the relations refetch itself half-failed: old relations are NOT revived
 * (they were dropped at invalidate time) and the caller must surface
 * "relations changed, rows/catalog pending re-verification" rather than
 * treating the pre-invalidate view as current.
 *
 * `catalog` is judged from the injected H1 instance's SETTLED post-sync
 * RENDERED snapshot — never in the same continuation as the awaited `sync()`
 * call, and never from one of sync's own INTERMEDIATE commits (sync flips
 * `loading`/`refreshing` during the IPC window; those identity moves do not
 * settle the outcome). Production `sync()` never rejects; failures settle
 * into the instance state:
 * - 'refreshed': the SETTLED snapshot reports a live catalog with no errorCode;
 * - 'pending': the settled snapshot has no catalog yet — relations changed
 *   while the catalog awaits re-verification;
 * - 'failed': the settled snapshot reports an errorCode (or, defensively,
 *   the sync itself threw);
 * - 'unavailable': no H1 instance was injected.
 * Consumers must NOT treat any outcome as proof the catalog content is
 * current — authoritative catalog state always lives on the H1 instance.
 */
export type MemberCirclesInvalidationOutcome = {
  relations: 'refreshed' | 'partial' | 'failed' | 'skipped'
  catalog: 'refreshed' | 'pending' | 'failed' | 'unavailable'
  circleId: string | null
  orderId: string | null
}

export interface MemberCircleRenewalPreviewResultPayload {
  purchaseUrl: string
  resolvedPurchaseUrl: string | null
  purchaseUrlResolutionError: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' | null
  preview: MemberCircleRenewalPreview
}

/** The full live surface held by MemberCircleResourceProvider (C2→C3..C9/S1). */
export interface MemberCirclesResource {
  state: MemberCirclesResourceState
  circles: MemberCircleSnapshot[] | null
  memberships: MemberMembership[] | null
  updateStates: Record<string, MemberCircleUpstreamReadState>
  profileStates: Record<string, MemberCircleUpstreamReadState>
  supportState: MemberCircleSupportReadState | null
  /**
   * Detail projection for circleId from THIS scope's authoritative rows.
   * `unknown_circle` when the id is absent — never a cross-scope guess.
   */
  getCircle(circleId: string): MemberCircleDetailView
  /** Authoritative re-read of circles + memberships (also the retry path). */
  refresh(): Promise<MemberCirclesRefreshOutcome>
  /**
   * Drop the current relations as no-longer-authoritative, refetch them, and
   * refresh the SAME injected member catalog instance. Used after a
   * successful leave and after return-verification (P70-CIRCLE-STATE-03).
   */
  invalidateAndRefresh(hint?: { circleId?: string; orderId?: string }): Promise<MemberCirclesInvalidationOutcome>
  previewRenewal(membershipId: string): Promise<MemberCircleRpcResult<MemberCircleRenewalPreviewResultPayload>>
  leave(membershipId: string): Promise<MemberCircleRpcResult<{ membership: MemberCircleLeaveMembership }>>
  /** Original order receipt — display history, never an entitlement (G5). */
  getOrder(orderId: string): Promise<MemberCircleRpcResult<{ order: OriginalCircleOrder }>>
  /** Authoritative checkout/cycle read — the entitlement judgment source (G5). */
  getCheckoutResult(orderId: string): Promise<MemberCircleRpcResult<{ checkout: MemberCircleCheckoutResult }>>
  getUpdates(circleId: string): Promise<MemberCircleRpcResult<{ updates: MemberCircleUpstreamPendingState }>>
  refreshUpdates(circleId: string): Promise<MemberCircleRpcResult<{ updates: MemberCircleUpstreamPendingState }>>
  getProfile(circleId: string): Promise<MemberCircleRpcResult<{ profile: MemberCircleUpstreamPendingState }>>
  getSupport(): Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>>
  refreshSupport(): Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>>
}

// ---------------------------------------------------------------------------
// Pure derivation (unit-tested directly)
// ---------------------------------------------------------------------------

/** Network-class codes that distinguish the `offline` phase from `error`. */
const MEMBER_CIRCLE_NETWORK_CLASS_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'timeout',
  'service_unavailable',
])

/**
 * Bounded fallback for the catalog settle await: normally the outcome is
 * released by the commit observer when the injected instance renders a
 * TERMINAL post-sync snapshot (this REQUIRES the holder to re-render the
 * instance after its sync settles — the normal React flow). If that never
 * happens, the awaiting leave/return flow is released from the current fact
 * after this timeout instead of hanging forever.
 */
export const MEMBER_CIRCLES_CATALOG_SETTLE_TIMEOUT_MS = 10_000

export function isMemberCircleNetworkClassError(
  error: MemberCircleReadError | null,
): boolean {
  return error !== null && MEMBER_CIRCLE_NETWORK_CLASS_CODES.has(error.code)
}

export function toMemberCircleReadError(
  failure: { errorCode?: string; message?: string },
): MemberCircleReadError {
  const code = (failure.errorCode ?? 'unknown') as MemberCircleReadErrorCode
  return {
    code,
    retryable: code !== 'invalid_response' && code !== 'validation_error',
  }
}

/**
 * Phase derivation for the authoritative relations state. Order matters:
 * scope kind first (it vetoes any row display), then the two-receipt matrix,
 * then the failure classification. `empty` keys off the circles receipt (the
 * "我的圈子" list) — an empty list is a legitimate success, distinct from
 * every failure shape.
 */
export function deriveMemberCirclesPhase(input: {
  scopeKind: MemberCircleScopeKind
  circles: ReadonlyArray<MemberCircleSnapshot> | null
  memberships: ReadonlyArray<MemberMembership> | null
  circlesError: MemberCircleReadError | null
  membershipsError: MemberCircleReadError | null
}): MemberCirclesReadPhase {
  const { scopeKind, circles, memberships, circlesError, membershipsError } = input
  if (scopeKind === 'none') return 'idle'
  if (scopeKind === 'denied') return 'denied'
  if (circles !== null && memberships !== null) {
    return circles.length === 0 ? 'empty' : 'ready'
  }
  if (circles !== null || memberships !== null) return 'partial'
  if (circlesError || membershipsError) {
    return isMemberCircleNetworkClassError(circlesError)
      || isMemberCircleNetworkClassError(membershipsError)
      ? 'offline'
      : 'error'
  }
  return 'loading'
}

// ---------------------------------------------------------------------------
// Bridge access
// ---------------------------------------------------------------------------

type MemberCirclesBridgeApi = {
  list(): Promise<MemberCircleRpcResult<{ circles: MemberCircleSnapshot[] }>>
  listMemberships(): Promise<MemberCircleRpcResult<{ memberships: MemberMembership[] }>>
  previewRenewal(membershipId: string): Promise<MemberCircleRpcResult<MemberCircleRenewalPreviewResultPayload>>
  leave(membershipId: string): Promise<MemberCircleRpcResult<{ membership: MemberCircleLeaveMembership }>>
  getOrder(orderId: string): Promise<MemberCircleRpcResult<{ order: OriginalCircleOrder }>>
  getCheckoutResult(orderId: string): Promise<MemberCircleRpcResult<{ checkout: MemberCircleCheckoutResult }>>
  getUpdates(circleId: string): Promise<MemberCircleRpcResult<{ updates: MemberCircleUpstreamPendingState }>>
  getProfile(circleId: string): Promise<MemberCircleRpcResult<{ profile: MemberCircleUpstreamPendingState }>>
  getSupport(): Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>>
}

export function getMemberCirclesBridgeApi(): MemberCirclesBridgeApi | null {
  const electronApi = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
    | { memberCircles?: MemberCirclesBridgeApi }
    | undefined
  return electronApi?.memberCircles ?? null
}

function commandFailure(
  code: 'session_changed' | 'session_unavailable',
): { success: false; errorCode: MemberCircleReadErrorCode; message: string } {
  return {
    success: false,
    errorCode: code,
    message: code === 'session_changed'
      ? 'Member circle scope changed while the command was in flight'
      : 'Member circle trusted scope is not available',
  }
}

// ---------------------------------------------------------------------------
// The single relations-reading hook (mounted ONCE by the Provider)
// ---------------------------------------------------------------------------

interface MemberCirclesRelationsState {
  scopeKind: MemberCircleScopeKind
  scope: MemberCircleScopeKey | null
  circles: MemberCircleSnapshot[] | null
  memberships: MemberMembership[] | null
  circlesError: MemberCircleReadError | null
  membershipsError: MemberCircleReadError | null
  refreshing: boolean
  updatedAt: number | null
}

const EMPTY_RELATIONS_STATE: MemberCirclesRelationsState = {
  scopeKind: 'none',
  scope: null,
  circles: null,
  memberships: null,
  circlesError: null,
  membershipsError: null,
  refreshing: false,
  updatedAt: null,
}

export interface MemberCirclesResourceOptions {
  /**
   * THE shared member catalog instance (H1). When provided,
   * `invalidateAndRefresh` refreshes it after the relations refetch so every
   * page/exit/return path shares one catalog binding.
   */
  catalog?: AppCatalogInstance | null
}

export function useMemberCirclesResource(
  options: MemberCirclesResourceOptions = {},
): MemberCirclesResource {
  const productSpace = useOptionalProductSpaceContext()
  const catalog = options.catalog ?? null

  const accountId = productSpace?.accountId ?? null
  const personalProductSpaceId = productSpace?.personalProductSpaceId ?? null
  const contextKey = productSpace?.productSpaceContextKey ?? null
  const epoch = productSpace?.contextVersion ?? 0
  const isEnterpriseSpace = productSpace?.activeProductSpace?.kind === 'enterprise'

  const [relations, setRelations] = useState<MemberCirclesRelationsState>(EMPTY_RELATIONS_STATE)
  const [updateStates, setUpdateStates] = useState<Record<string, MemberCircleUpstreamReadState>>({})
  const [profileStates, setProfileStates] = useState<Record<string, MemberCircleUpstreamReadState>>({})
  const [supportState, setSupportState] = useState<MemberCircleSupportReadState | null>(null)

  const supportGenerationRef = useRef(0)
  const supportFlightRef = useRef<{
    fence: MemberCircleScopeKey
    generation: number
    refresh: boolean
    promise: Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>>
  } | null>(null)

  // The published scope fence. Set synchronously by the scope effect; command
  // closures capture this object and compare by identity after their await.
  const scopeFenceRef = useRef<MemberCircleScopeKey | null>(null)
  // Monotonic request generation: the newest authoritative request wins.
  const generationRef = useRef(0)
  const catalogRef = useRef<AppCatalogInstance | null>(catalog)
  catalogRef.current = catalog

  // Awaiting-settle bookkeeping (catalog outcome timing): React only exposes
  // a post-sync snapshot when the injected instance is RE-RENDERED, so the
  // outcome must never be judged in the same continuation as `await sync()`.
  // `stateAtIssue` is the instance state object identity captured when the
  // sync was issued; the commit observer below completes the judgment when
  // that identity moves.
  const catalogSettleRef = useRef<{
    stateAtIssue: object
    resolve: (outcome: MemberCirclesInvalidationOutcome['catalog']) => void
  } | null>(null)
  const [observedCatalogState, setObservedCatalogState] = useState<object | null>(catalog?.state ?? null)

  const isScopeCurrent = useCallback((fence: MemberCircleScopeKey | null): boolean => (
    fence !== null && scopeFenceRef.current !== null && scopeFenceRef.current === fence
  ), [])

  /**
   * Judge the catalog outcome from an instance's SETTLED rendered snapshot
   * (never from a call's mere completion): an errorCode means failed, a live
   * catalog means refreshed, neither means the catalog is still awaiting
   * re-verification.
   */
  const judgeCatalogOutcome = useCallback((instance: AppCatalogInstance | null): MemberCirclesInvalidationOutcome['catalog'] => {
    if (!instance) return 'unavailable'
    if (instance.state.errorCode) return 'failed'
    if (instance.state.catalog) return 'refreshed'
    return 'pending'
  }, [])

  /**
   * Terminal-snapshot guard: sync's OWN intermediate commits flip
   * `loading`/`refreshing` while the IPC is in flight (useAppCatalog.ts sets
   * `loading: !current.catalog, refreshing: Boolean(current.catalog)` at
   * sync start and lands both back to false in every terminal branch). An
   * identity move alone is therefore NOT settle-worthy — only a snapshot
   * with neither flag set may complete the outcome.
   */
  const isCatalogSnapshotSettled = useCallback((instance: AppCatalogInstance | null): instance is AppCatalogInstance => (
    instance !== null && instance.state.refreshing !== true && instance.state.loading !== true
  ), [])

  // Track the injected instance's latest rendered state identity: H1 returns
  // a NEW instance object per render, so the prop reference moving is the
  // commit signal.
  useEffect(() => {
    setObservedCatalogState(catalogRef.current?.state ?? null)
  }, [catalog])

  // Commit observer: when the observed state identity has moved past the one
  // captured at sync-issue time AND the committed snapshot is TERMINAL (not
  // one of sync's own intermediate refreshing/loading flips), judge from it
  // and release the awaiting outcome. Intermediate commits keep waiting.
  useEffect(() => {
    const pending = catalogSettleRef.current
    if (!pending) return
    if (observedCatalogState === pending.stateAtIssue) return
    const latest = catalogRef.current
    if (!isCatalogSnapshotSettled(latest)) return
    catalogSettleRef.current = null
    pending.resolve(judgeCatalogOutcome(latest))
  }, [observedCatalogState, judgeCatalogOutcome, isCatalogSnapshotSettled])

  // Unmount settlement: never leave an awaiting outcome hanging. Current-fact
  // semantics by design (no terminal guard — the advisory on the outcome type
  // already states the result is never proof of catalog currency).
  useEffect(() => () => {
    supportGenerationRef.current += 1
    supportFlightRef.current = null
    const pending = catalogSettleRef.current
    if (pending) {
      catalogSettleRef.current = null
      pending.resolve(judgeCatalogOutcome(catalogRef.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
  }, [])

  const resetToScopelessState = useCallback((scopeKind: MemberCircleScopeKind) => {
    supportGenerationRef.current += 1
    supportFlightRef.current = null
    scopeFenceRef.current = null
    setRelations({ ...EMPTY_RELATIONS_STATE, scopeKind })
    setUpdateStates({})
    setProfileStates({})
    setSupportState(null)
  }, [])

  // -------------------------------------------------------------------------
  // Authoritative relations fetch
  // -------------------------------------------------------------------------

  const fetchRelations = useCallback(async (
    fence: MemberCircleScopeKey,
    generation: number,
  ): Promise<MemberCirclesRefreshOutcome> => {
    const api = getMemberCirclesBridgeApi()
    if (!api) {
      // Distinct from 'no_scope': the scope fence is fine, the trusted
      // bridge itself is missing (hardened renderer / broken preload).
      return { skipped: true, reason: 'bridge_unavailable' }
    }
    setRelations(current => (
      current.scope === fence ? { ...current, refreshing: true } : current
    ))
    const [circlesResult, membershipsResult] = await Promise.all([
      api.list().catch(() => ({ success: false as const, errorCode: 'unknown' as MemberCircleApiErrorCode, message: 'Member circles list request failed' })),
      api.listMemberships().catch(() => ({ success: false as const, errorCode: 'unknown' as MemberCircleApiErrorCode, message: 'Member memberships list request failed' })),
    ])
    // Latest request wins: a stale generation or a replaced scope fence
    // discards the receipt entirely (A slow → B signed in ⇒ A's rows die).
    if (generation !== generationRef.current || !isScopeCurrent(fence)) {
      return { skipped: true, reason: 'superseded' }
    }
    const circlesOutcome = circlesResult.success
      ? ({ ok: true as const, value: circlesResult.circles })
      : ({ ok: false as const, error: toMemberCircleReadError(circlesResult) })
    const membershipsOutcome = membershipsResult.success
      ? ({ ok: true as const, value: membershipsResult.memberships })
      : ({ ok: false as const, error: toMemberCircleReadError(membershipsResult) })
    setRelations(current => {
      if (current.scope !== fence) return current
      return {
        ...current,
        // Failure keeps the previous receipt as the last known fact — it is
        // never upgraded into an entitlement and never faked into empty.
        circles: circlesOutcome.ok ? circlesOutcome.value : current.circles,
        memberships: membershipsOutcome.ok ? membershipsOutcome.value : current.memberships,
        circlesError: circlesOutcome.ok ? null : circlesOutcome.error,
        membershipsError: membershipsOutcome.ok ? null : membershipsOutcome.error,
        refreshing: false,
        updatedAt: Date.now(),
      }
    })
    return {
      skipped: false,
      circles: circlesOutcome.ok ? 'ok' : 'failed',
      memberships: membershipsOutcome.ok ? 'ok' : 'failed',
    }
  }, [isScopeCurrent])

  // -------------------------------------------------------------------------
  // Scope effect: publish the new fence, drop everything from the old one
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Invalidate EVERYTHING in flight from the previous binding first: an
    // invalidated context immediately loses its display authority, and a
    // pending refresh can never resurrect the previous account's rows.
    const generation = ++generationRef.current
    // A scope rebind also invalidates any AWAITING catalog settle: report
    // from the current fact instead of holding the outcome across the
    // rebind (the settle observer below only fires on identity moves).
    const pendingSettle = catalogSettleRef.current
    if (pendingSettle) {
      catalogSettleRef.current = null
      pendingSettle.resolve(judgeCatalogOutcome(catalogRef.current))
    }
    if (!accountId || !personalProductSpaceId || !contextKey) {
      resetToScopelessState('none')
      return
    }
    if (isEnterpriseSpace) {
      // Enterprise spaces have no "我的圈子": deny BEFORE any request so no
      // read of the personal circle data is even issued, and no previous
      // account's rows stay on screen.
      resetToScopelessState('denied')
      return
    }
    const fence: MemberCircleScopeKey = {
      accountId,
      personalProductSpaceId,
      contextKey,
      epoch,
    }
    supportGenerationRef.current += 1
    supportFlightRef.current = null
    scopeFenceRef.current = fence
    setRelations({
      ...EMPTY_RELATIONS_STATE,
      scopeKind: 'personal',
      scope: fence,
    })
    setUpdateStates({})
    setProfileStates({})
    setSupportState(null)
    void fetchRelations(fence, generation)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fence tuple IS the dependency
  }, [accountId, personalProductSpaceId, contextKey, epoch, isEnterpriseSpace])

  // -------------------------------------------------------------------------
  // Commands (single authoritative reads, scope-fenced, no polling)
  // -------------------------------------------------------------------------

  const runScopedCommand = useCallback(async <T extends object>(
    operation: (api: MemberCirclesBridgeApi) => Promise<MemberCircleRpcResult<T>>,
  ): Promise<MemberCircleRpcResult<T>> => {
    const api = getMemberCirclesBridgeApi()
    const fence = scopeFenceRef.current
    if (!api || !fence) {
      return commandFailure('session_unavailable')
    }
    const result = await operation(api)
    if (!isScopeCurrent(fence)) {
      // The scope died while the command was in flight: the payload may be
      // another identity's — fail closed instead of returning it.
      return commandFailure('session_changed')
    }
    return result
  }, [isScopeCurrent])

  const refresh = useCallback(async (): Promise<MemberCirclesRefreshOutcome> => {
    const fence = scopeFenceRef.current
    if (!fence) {
      return { skipped: true, reason: 'no_scope' }
    }
    const generation = ++generationRef.current
    return fetchRelations(fence, generation)
  }, [fetchRelations])

  const invalidateAndRefresh = useCallback(async (
    hint: { circleId?: string; orderId?: string } = {},
  ): Promise<MemberCirclesInvalidationOutcome> => {
    const fence = scopeFenceRef.current
    const circleId = hint.circleId ?? null
    const orderId = hint.orderId ?? null
    if (!fence) {
      return { relations: 'skipped', catalog: 'unavailable', circleId, orderId }
    }
    const generation = ++generationRef.current
    // 1. Invalidate FIRST: after a leave / return-verification the previous
    // relations are no longer a fact. Dropping them here guarantees a
    // partial failure cannot revive the old launchable rows.
    setRelations(current => (
      current.scope === fence
        ? {
          ...current,
          circles: null,
          memberships: null,
          circlesError: null,
          membershipsError: null,
          refreshing: true,
        }
        : current
    ))
    // 2. Authoritative relations refetch.
    const relationsOutcome = await fetchRelations(fence, generation)
    const relations: MemberCirclesInvalidationOutcome['relations'] = relationsOutcome.skipped
      ? 'skipped'
      : relationsOutcome.circles === 'ok' && relationsOutcome.memberships === 'ok'
        ? 'refreshed'
        : relationsOutcome.circles === 'ok' || relationsOutcome.memberships === 'ok'
          ? 'partial'
          : 'failed'
    // 3. Refresh the SAME injected catalog instance (H1). Production
    // `sync()` NEVER rejects and its failures settle into a LATER RENDERED
    // snapshot — the instance state visible in the same continuation as the
    // awaited sync is still the PRE-sync one, so no judgment happens here.
    // Capture the state identity AT ISSUE, then either judge an already-
    // committed TERMINAL post-sync snapshot, or hand the outcome to the
    // commit observer (which fires when the identity moves to a TERMINAL
    // snapshot — sync's own intermediate refreshing/loading flips keep it
    // waiting; a bounded fallback releases from the current fact if no
    // terminal snapshot ever commits) / the scope-teardown settlement (which
    // reports from the current fact). A throwing sync is reported as failed,
    // defensively. A catalog failure never rolls the relations back.
    let catalogOutcome: MemberCirclesInvalidationOutcome['catalog'] = 'unavailable'
    const requestedCatalog = catalogRef.current
    if (requestedCatalog) {
      const stateAtIssue = requestedCatalog.state
      try {
        await requestedCatalog.sync(true)
      } catch {
        return { relations, catalog: 'failed', circleId, orderId }
      }
      if (!isScopeCurrent(fence)) {
        // The scope died mid-sync: report from the current fact, no waiting.
        catalogOutcome = judgeCatalogOutcome(catalogRef.current)
      } else if (
        catalogRef.current
        && catalogRef.current.state !== stateAtIssue
        && isCatalogSnapshotSettled(catalogRef.current)
      ) {
        // A TERMINAL post-sync snapshot is already committed.
        catalogOutcome = judgeCatalogOutcome(catalogRef.current)
      } else {
        catalogOutcome = await new Promise<MemberCirclesInvalidationOutcome['catalog']>(resolve => {
          const settleTimer = setTimeout(() => {
            // Bounded fallback: if no terminal snapshot ever commits (the
            // holder stopped re-rendering), release from the CURRENT fact
            // instead of hanging the leave/return flow forever.
            if (catalogSettleRef.current?.resolve === guardedResolve) {
              catalogSettleRef.current = null
              resolve(judgeCatalogOutcome(catalogRef.current))
            }
          }, MEMBER_CIRCLES_CATALOG_SETTLE_TIMEOUT_MS)
          const guardedResolve: (outcome: MemberCirclesInvalidationOutcome['catalog']) => void = outcome => {
            clearTimeout(settleTimer)
            resolve(outcome)
          }
          // The settle slot is single: a racing invalidateAndRefresh (C8's
          // leave + return-verification) supersedes THIS registration.
          // Release the superseded pending from the CURRENT fact first —
          // its caller must never be orphaned on an await that no observer
          // will ever complete.
          const superseded = catalogSettleRef.current
          if (superseded) {
            superseded.resolve(judgeCatalogOutcome(catalogRef.current))
          }
          catalogSettleRef.current = { stateAtIssue, resolve: guardedResolve }
        })
      }
    }
    return { relations, catalog: catalogOutcome, circleId, orderId }
  }, [fetchRelations, isScopeCurrent, judgeCatalogOutcome, isCatalogSnapshotSettled])

  const previewRenewal = useCallback(async (membershipId: string) => (
    runScopedCommand(api => api.previewRenewal(membershipId))
  ), [runScopedCommand])

  const leave = useCallback(async (membershipId: string) => {
    const fence = scopeFenceRef.current
    const result = await runScopedCommand(api => api.leave(membershipId))
    if (result.success && isScopeCurrent(fence)) {
      // P70-CIRCLE-STATE-03: one successful leave refreshes the relations
      // AND the shared catalog exactly once, through the same instance.
      await invalidateAndRefresh({ circleId: result.membership.circleId })
    }
    return result
  }, [runScopedCommand, invalidateAndRefresh, isScopeCurrent])

  const getOrder = useCallback(async (orderId: string) => (
    runScopedCommand(api => api.getOrder(orderId))
  ), [runScopedCommand])

  const getCheckoutResult = useCallback(async (orderId: string) => (
    runScopedCommand(api => api.getCheckoutResult(orderId))
  ), [runScopedCommand])

  const getUpdates = useCallback(async (circleId: string): Promise<MemberCircleRpcResult<{ updates: MemberCircleUpstreamPendingState }>> => {
    const fence = scopeFenceRef.current
    // No personal scope (idle/enterprise): fail closed BEFORE writing any
    // loading state, so no capability cache can be stranded in loading.
    if (!fence) return commandFailure('session_unavailable')
    setUpdateStates(previous => ({ ...previous, [circleId]: { phase: 'loading' } }))
    const result = await runScopedCommand(api => api.getUpdates(circleId))
    if (!isScopeCurrent(fence)) return result
    if (result.success) {
      // `upstream_pending` (G2) is a READY capability fact — cached as such,
      // never as an empty list and never as an error.
      setUpdateStates(previous => ({
        ...previous,
        [circleId]: { phase: 'ready', state: result.updates },
      }))
    } else {
      setUpdateStates(previous => ({
        ...previous,
        [circleId]: { phase: 'failed', error: toMemberCircleReadError(result) },
      }))
    }
    return result
  }, [runScopedCommand, isScopeCurrent])

  /** Force a fresh G2 capability read for one circle (same channel). */
  const refreshUpdates = getUpdates

  const getProfile = useCallback(async (circleId: string): Promise<MemberCircleRpcResult<{ profile: MemberCircleUpstreamPendingState }>> => {
    const fence = scopeFenceRef.current
    if (!fence) return commandFailure('session_unavailable')
    setProfileStates(previous => ({ ...previous, [circleId]: { phase: 'loading' } }))
    const result = await runScopedCommand(api => api.getProfile(circleId))
    if (!isScopeCurrent(fence)) return result
    if (result.success) {
      // `upstream_pending` (G3): awaiting-upstream, not empty, not an error.
      setProfileStates(previous => ({
        ...previous,
        [circleId]: { phase: 'ready', state: result.profile },
      }))
    } else {
      setProfileStates(previous => ({
        ...previous,
        [circleId]: { phase: 'failed', error: toMemberCircleReadError(result) },
      }))
    }
    return result
  }, [runScopedCommand, isScopeCurrent])

  const fetchSupport = useCallback((refresh: boolean): Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>> => {
    const fence = scopeFenceRef.current
    if (!fence) return Promise.resolve(commandFailure('session_unavailable'))
    const active = supportFlightRef.current
    if (active?.fence === fence && (!refresh || active.refresh)) return active.promise
    const generation = ++supportGenerationRef.current
    setSupportState({ phase: 'loading' })
    const isCurrent = () => isScopeCurrent(fence) && supportGenerationRef.current === generation
    const promise = (async (): Promise<MemberCircleRpcResult<{ support: MemberCircleSupportState }>> => {
      let result: MemberCircleRpcResult<{ support: MemberCircleSupportState }>
      try {
        result = await runScopedCommand(api => api.getSupport())
        if (!isCurrent()) return commandFailure('session_changed')
        if (result.success) result = { success: true, support: parseMemberCircleSupportState(result.support) }
      } catch (error) {
        result = { success: false, errorCode: error instanceof MemberCircleInvalidResponseError ? 'invalid_response' : 'network_error',
          message: 'Member support read failed' }
      }
      if (!isCurrent()) return commandFailure('session_changed')
      if (result.success) setSupportState({ phase: 'ready', state: result.support })
      else setSupportState({ phase: 'failed', error: toMemberCircleReadError(result) })
      return result
    })()
    supportFlightRef.current = { fence, generation, refresh, promise }
    void promise.finally(() => {
      if (supportFlightRef.current?.generation === generation) supportFlightRef.current = null
    })
    return promise
  }, [runScopedCommand, isScopeCurrent])

  const getSupport = useCallback(() => fetchSupport(false), [fetchSupport])
  const refreshSupport = useCallback(() => fetchSupport(true), [fetchSupport])

  const getCircle = useCallback((circleId: string): MemberCircleDetailView => (
    selectMemberCircleDetail(relations.circles ?? [], relations.memberships ?? [], circleId)
  ), [relations.circles, relations.memberships])

  const phase = useMemo(() => deriveMemberCirclesPhase({
    scopeKind: relations.scopeKind,
    circles: relations.circles,
    memberships: relations.memberships,
    circlesError: relations.circlesError,
    membershipsError: relations.membershipsError,
  }), [relations])

  const state = useMemo<MemberCirclesResourceState>(() => ({
    phase,
    scope: relations.scope,
    circles: relations.circles,
    memberships: relations.memberships,
    circlesError: relations.circlesError,
    membershipsError: relations.membershipsError,
    refreshing: relations.refreshing,
    updatedAt: relations.updatedAt,
  }), [phase, relations])

  const resource = useMemo<MemberCirclesResource>(() => ({
    state,
    circles: state.circles,
    memberships: state.memberships,
    updateStates,
    profileStates,
    supportState,
    getCircle,
    refresh,
    invalidateAndRefresh,
    previewRenewal,
    leave,
    getOrder,
    getCheckoutResult,
    getUpdates,
    refreshUpdates,
    getProfile,
    getSupport,
    refreshSupport,
  }), [
    state,
    updateStates,
    profileStates,
    supportState,
    getCircle,
    refresh,
    invalidateAndRefresh,
    previewRenewal,
    leave,
    getOrder,
    getCheckoutResult,
    getUpdates,
    refreshUpdates,
    getProfile,
    getSupport,
    refreshSupport,
  ])

  return resource
}
