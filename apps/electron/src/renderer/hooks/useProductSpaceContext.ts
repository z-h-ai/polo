import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  ExecutionSummary,
  ProductSpaceSummary,
} from '@polo-ai/shared/product-spaces'
import { invalidateLegacyOrganizationState } from '@polo-ai/shared/product-spaces'
import {
  clearStoredActiveProductSpaceId,
  clearVerifiedProductSpaceContext,
  createProductSpaceContextKey,
  getProductSpaceContextStorage,
  getStoredActiveProductSpaceId,
  readLegacyCleanupLedger,
  setStoredActiveProductSpaceId,
  setVerifiedProductSpaceContext,
  writeLegacyCleanupLedger,
} from '@/lib/product-space-storage'

export type ProductSpaceFlowState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'contract-blocked'
  | 'error'

export type SpaceSwitchPhase =
  | 'confirm'
  | 'stopping'
  | 'stop-failed'
  | 'target-loading'
  | 'target-failed'
  | 'target-access-lost'

export interface PendingSpaceSwitch {
  targetId: string
  phase: SpaceSwitchPhase
  /** Executions captured when the switch was requested. */
  executions: ExecutionSummary[]
  /** Live per-execution statuses while terminating. */
  statuses: Record<string, ExecutionSummary['status']>
  /** Failure from the most recent stop-all or target verification attempt. */
  errorCode: string | null
}

interface AccountScope {
  accountId: string
  generation: number
}

/**
 * Main's authoritative linearization verdict for a switch cancellation
 * (CANCEL_SWITCH response). `cancelled` means the transaction was still
 * cancellable — the switch stays on the origin. `already_committed` means
 * the COMMIT already won its final gate and moved the Main fence: the
 * response carries the committed target plus the CURRENT authoritative fence
 * read-back; the renderer converges to the committed target only while it is
 * still the latest authority. `no_transaction` matches nothing known.
 */
type SwitchCancelOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'no_transaction' }
  | {
    outcome: 'already_committed'
    committedTargetProductSpaceId: string | null
    activeProductSpaceId: string | null
  }

function isActiveSpace(space: ProductSpaceSummary): boolean {
  return space.accessMode === 'active'
}

function isTerminalExecution(status: ExecutionSummary['status']): boolean {
  return status === 'stopped' || status === 'failed'
}

/**
 * One-shot pre-release cleanup mandated by the shared contract. Only legacy
 * authorization/catalog caches are reachable from the renderer; workspace
 * metadata and user exports are structurally absent from this invalidator.
 */
const legacyStateInvalidator = {
  removeLegacyOrganizationAuthorizationCache: () => {
    try {
      const staleKeys: string[] = []
      // eslint-disable-next-line polo-ai/no-localstorage -- one-time legacy invalidation only
      for (let index = 0; index < localStorage.length; index += 1) {
        // eslint-disable-next-line polo-ai/no-localstorage -- one-time legacy invalidation only
        const key = localStorage.key(index)
        if (
          key
          && (key.startsWith('polo-active-organization:')
            || key.startsWith('polo-verified-organization-context:')
            || key.startsWith('polo-unavailable-organization:'))
        ) {
          staleKeys.push(key)
        }
      }
      for (const key of staleKeys) {
        // eslint-disable-next-line polo-ai/no-localstorage -- one-time legacy invalidation only
        localStorage.removeItem(key)
      }
    } catch {
      // Hardened renderers without localStorage simply keep nothing.
    }
  },
  removeLegacyOrganizationCatalogCache: () => {},
  removeLegacyOrganizationInstallationStateCache: () => {},
  removeLegacyOrganizationRuntimeCache: () => {},
  removeLegacyOrganizationSkillEnablementCache: () => {},
  removeLegacyOrganizationSessionIndex: () => {},
}

export function useProductSpaceContextState() {
  const [flowState, setFlowState] = useState<ProductSpaceFlowState>('idle')
  const [productSpaces, setProductSpaces] = useState<ProductSpaceSummary[]>([])
  const [personalProductSpaceId, setPersonalProductSpaceId] = useState<string | null>(null)
  const [activeProductSpaceId, setActiveProductSpaceId] = useState<string | null>(null)
  const [contextVersion, setContextVersion] = useState(0)
  const [error, setError] = useState<{ code: string; message?: string } | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSpaceSwitch | null>(null)
  const [unavailableSpaceIds, setUnavailableSpaceIds] = useState<ReadonlySet<string>>(new Set())

  const accountIdRef = useRef<string | null>(null)
  const accountScopeGenerationRef = useRef(0)
  const activeProductSpaceIdRef = useRef<string | null>(null)
  const switchGenerationRef = useRef(0)
  const pendingTargetRef = useRef<string | null>(null)
  const preparedSwitchTokenRef = useRef<string | null>(null)
  const legacyInvalidatedAccountsRef = useRef(new Set<string>())
  const productSpacesRef = useRef<ProductSpaceSummary[]>([])
  productSpacesRef.current = productSpaces
  const personalProductSpaceIdRef = useRef<string | null>(null)
  personalProductSpaceIdRef.current = personalProductSpaceId
  // Linearization record of the latest user cancellation: the click only
  // closes the dialog and advances the generation — the authoritative Main
  // cancellation verdict decides whether the switch stays on the origin
  // (cancel won the final gate) or converges to the committed target (the
  // COMMIT already wrote the fence before the cancel was scheduled).
  const lateCancelRef = useRef<{
    generation: number
    outcome: Promise<SwitchCancelOutcome | null>
  } | null>(null)

  const isCurrentAccountScope = useCallback((scope: AccountScope) => (
    accountIdRef.current === scope.accountId
    && accountScopeGenerationRef.current === scope.generation
  ), [])

  const persistVerifiedContext = useCallback((
    accountId: string,
    list: ProductSpaceSummary[],
    personalId: string,
    activeId: string | null,
  ) => {
    void setVerifiedProductSpaceContext(accountId, {
      contractVersion: 1,
      personalProductSpaceId: personalId,
      productSpaces: list,
    }, activeId).catch(() => {
      // The live selection stays authoritative; the next verified response
      // retries the device-local write.
    })
  }, [])

  const publishCommittedSelection = useCallback((
    accountId: string,
    list: ProductSpaceSummary[],
    personalId: string,
    productSpaceId: string,
  ) => {
    // The Main fence already moved (trusted transaction committed); now the
    // renderer projection is published as one step.
    setStoredActiveProductSpaceId(accountId, productSpaceId)
    persistVerifiedContext(accountId, list, personalId, productSpaceId)
    activeProductSpaceIdRef.current = productSpaceId
    setActiveProductSpaceId(productSpaceId)
    setContextVersion(version => version + 1)
    setFlowState('ready')
    setError(null)

    window.dispatchEvent(new CustomEvent('polo:product-space-changed', {
      detail: {
        accountId,
        productSpaceId,
        contextKey: createProductSpaceContextKey(accountId, productSpaceId),
      },
    }))
  }, [persistVerifiedContext])

  /**
   * The runtime contract-blocked state (PC-F11): revokes the Main fence and
   * tears down every renderer projection. Defined before the switch
   * primitives because PREPARE must fail closed into it when Main reports an
   * incompatible ProductSpace contract.
   */
  const enterContractBlocked = useCallback((accountId: string | null): void => {
    // PC-F11 at runtime: revoke the Main fence synchronously (renderer can
    // only ever clear it) and tear down every renderer projection so the
    // business shell cannot be entered behind a stale context key.
    void window.electronAPI.productSpaceRevokeActiveContext().catch(() => {})
    if (accountId) {
      clearStoredActiveProductSpaceId(accountId)
      void clearVerifiedProductSpaceContext(accountId)
      legacyInvalidatedAccountsRef.current.delete(accountId)
    }
    switchGenerationRef.current += 1
    pendingTargetRef.current = null
    activeProductSpaceIdRef.current = null
    setProductSpaces([])
    setPersonalProductSpaceId(null)
    setActiveProductSpaceId(null)
    setPendingSwitch(null)
    setUnavailableSpaceIds(new Set())
    setError({ code: 'product_space_contract_unsupported' })
    setContextVersion(version => version + 1)
    setFlowState('contract-blocked')
  }, [])

  /**
   * Phase 1 of the cancellable trusted switch. PREPARE (Main): verify the
   * target against the account's contract-validated list and create the
   * one-time transaction token BEFORE stopping anything — the token is held
   * by the renderer from here on, so cancelling during the stopping phase
   * is real. Nothing has been stopped when this resolves; the planned
   * executions are returned for the stop dialog.
   */
  const prepareTrustedSwitch = useCallback(async (
    targetId: string,
  ): Promise<{
    ok: boolean
    token?: string
    errorCode?: string
    statuses: Record<string, ExecutionSummary['status']>
  }> => {
    const result = await window.electronAPI.productSpacePrepareSwitch(targetId)
    const statuses: Record<string, ExecutionSummary['status']> = {}
    if (result.success) {
      preparedSwitchTokenRef.current = result.token
      for (const execution of result.executions) {
        statuses[execution.executionId] = execution.status
      }
      return { ok: true, token: result.token, statuses }
    }
    for (const execution of result.executions ?? []) {
      statuses[execution.executionId] = execution.status
    }
    // A PREPARE that revalidated the target against an incompatible server
    // contract must fail closed into contract-blocked — never into the
    // retryable target-failed dialog that keeps the business UI usable.
    if (result.errorCode === 'product_space_contract_unsupported') {
      enterContractBlocked(accountIdRef.current)
    }
    return { ok: false, errorCode: result.errorCode, statuses }
  }, [enterContractBlocked])

  /**
   * Phase 1b: dispatch the terminations covered by the prepared token. Main
   * checks cancellation before every dispatch; SWITCH_CANCELLED means the
   * renderer cancelled while stopping (already-dispatched stops finished,
   * untouched executions keep running).
   */
  const stopPreparedSwitchExecutions = useCallback(async (token: string): Promise<{
    ok: boolean
    errorCode?: string
    statuses: Record<string, ExecutionSummary['status']>
  }> => {
    const result = await window.electronAPI.productSpaceStopSwitchExecutions(token)
    const statuses: Record<string, ExecutionSummary['status']> = {}
    for (const execution of result.executions ?? []) {
      statuses[execution.executionId] = execution.status
    }
    if (result.success) {
      return { ok: true, statuses }
    }
    return { ok: false, errorCode: result.errorCode, statuses }
  }, [])

  const commitPreparedSwitch = useCallback(async (targetId: string): Promise<void> => {
    const token = preparedSwitchTokenRef.current
    if (!token) throw { code: 'SWITCH_TRANSACTION_INVALID' }
    const result = await window.electronAPI.productSpaceCommitSwitch(token, targetId)
    preparedSwitchTokenRef.current = null
    if (!result.success) {
      throw { code: result.errorCode ?? 'runtime_commit_failed' }
    }
  }, [])

  const cancelPreparedSwitch = useCallback(async (): Promise<SwitchCancelOutcome | null> => {
    const token = preparedSwitchTokenRef.current
    if (!token) return null
    preparedSwitchTokenRef.current = null
    try {
      const result = await window.electronAPI.productSpaceCancelSwitch(token)
      if (!result.success) return null
      if (result.outcome === 'already_committed') {
        return {
          outcome: 'already_committed',
          committedTargetProductSpaceId: result.committedTargetProductSpaceId ?? null,
          activeProductSpaceId: result.activeProductSpaceId ?? null,
        }
      }
      return { outcome: result.outcome === 'cancelled' ? 'cancelled' : 'no_transaction' }
    } catch {
      return null
    }
  }, [])

  /**
   * A switch that lost its generation while Main was preparing (the user
   * cancelled during stopping/target-loading) must still deterministically
   * consume whatever one-time token the prepare produced — otherwise the
   * pending Main transaction lingers until its TTL and a later prepare has
   * to supersede it. Stopping cannot be undone, so cancelling here never
   * revives stopped executions; it only releases the prepared transaction.
   */
  const abandonSwitchIfStale = useCallback(async (generation: number): Promise<boolean> => {
    if (generation === switchGenerationRef.current) return false
    pendingTargetRef.current = null
    await cancelPreparedSwitch()
    return true
  }, [cancelPreparedSwitch])

  /**
   * Trusted reverse transaction used when anything fails after a commit:
   * Main re-runs the same verification/termination for the origin space and
   * atomically restores its fence, after which the renderer republishes the
   * full origin projection.
   */
  const rollbackToOrigin = useCallback(async (
    explicitOriginId?: string,
  ): Promise<boolean> => {
    const accountId = accountIdRef.current
    // The rollback target is the recorded origin of the failing transaction;
    // personal space is only the fallback when no transaction was recorded.
    const originId = explicitOriginId
      ?? personalProductSpaceIdRef.current
      ?? activeProductSpaceIdRef.current
    if (!accountId || !originId) return false
    const prepared = await prepareTrustedSwitch(originId)
    if (!prepared.ok) return false
    const stopped = await stopPreparedSwitchExecutions(prepared.token!)
    if (!stopped.ok) {
      await cancelPreparedSwitch()
      return false
    }
    try {
      await commitPreparedSwitch(originId)
    } catch {
      await cancelPreparedSwitch()
      return false
    }
    publishCommittedSelection(
      accountId,
      productSpacesRef.current,
      personalProductSpaceIdRef.current ?? originId,
      originId,
    )
    return true
  }, [cancelPreparedSwitch, commitPreparedSwitch, prepareTrustedSwitch, publishCommittedSelection, stopPreparedSwitchExecutions])

  /**
   * Bootstrap initial declaration and membership-loss fallbacks run through
   * the same cancellable trusted transaction: Main verifies the target and
   * creates the token, the stop phase terminates origin executions (cancel
   * still possible until each dispatch), and the one-time token commit
   * moves the fence.
   */
  const executeAtomicSwitch = useCallback(async (
    targetId: string,
  ): Promise<{
    ok: boolean
    errorCode?: string
    statuses: Record<string, ExecutionSummary['status']>
  }> => {
    const prepared = await prepareTrustedSwitch(targetId)
    if (!prepared.ok) {
      return { ok: false, errorCode: prepared.errorCode, statuses: prepared.statuses }
    }
    const stopped = await stopPreparedSwitchExecutions(prepared.token!)
    if (!stopped.ok) {
      if (stopped.errorCode === 'SWITCH_CANCELLED') {
        return { ok: false, errorCode: 'SWITCH_CANCELLED', statuses: stopped.statuses }
      }
      return { ok: false, errorCode: stopped.errorCode ?? 'runtime_stop_failed', statuses: stopped.statuses }
    }
    try {
      await commitPreparedSwitch(targetId)
      return { ok: true, statuses: stopped.statuses }
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      return {
        ok: false,
        errorCode: typeof record.code === 'string' ? record.code : 'runtime_commit_failed',
        statuses: stopped.statuses,
      }
    }
  }, [commitPreparedSwitch, prepareTrustedSwitch, stopPreparedSwitchExecutions])

  const applySpaceSelection = useCallback(async (
    accountId: string,
    list: ProductSpaceSummary[],
    personalId: string,
    productSpaceId: string,
  ): Promise<void> => {
    const committed = await executeAtomicSwitch(productSpaceId)
    if (!committed.ok) {
      throw { code: committed.errorCode ?? 'runtime_commit_failed' }
    }
    publishCommittedSelection(accountId, list, personalId, productSpaceId)
  }, [executeAtomicSwitch, publishCommittedSelection])

  const applyListResponse = useCallback((parsed: {
    productSpaces: ProductSpaceSummary[]
    personalProductSpaceId: string
  }) => {
    setProductSpaces(parsed.productSpaces)
    setPersonalProductSpaceId(parsed.personalProductSpaceId)
  }, [])

  const fetchProductSpaces = useCallback(async (scope: AccountScope, options?: {
    /** Publish the fetched list into renderer state (default true). */
    publishList?: boolean
  }): Promise<{
    list: ProductSpaceSummary[]
    personalId: string
  } | null> => {
    const result = await window.electronAPI.productSpaceList()
    if (!isCurrentAccountScope(scope)) return null
    if (!result.success) {
      if (result.contractUnsupported) {
        throw { code: 'product_space_contract_unsupported' }
      }
      throw { code: result.errorCode, message: result.message }
    }
    const parsed = result as unknown as {
      productSpaces: ProductSpaceSummary[]
      personalProductSpaceId: string
    }
    if (!parsed.personalProductSpaceId || parsed.productSpaces.length === 0) {
      throw { code: 'product_space_list_invalid' }
    }
    // A membership-loss refresh must not publish the new list before the
    // fallback transaction committed — callers stage it instead.
    if (options?.publishList !== false) {
      applyListResponse(parsed)
    }
    return {
      list: parsed.productSpaces,
      personalId: parsed.personalProductSpaceId,
    }
  }, [applyListResponse, isCurrentAccountScope])

  const bootstrap = useCallback(async (accountId: string): Promise<
    'ready' | 'contract-blocked' | 'error' | null
  > => {
    const scope = {
      accountId,
      generation: ++accountScopeGenerationRef.current,
    }
    accountIdRef.current = accountId
    switchGenerationRef.current += 1
    pendingTargetRef.current = null
    activeProductSpaceIdRef.current = null
    setProductSpaces([])
    setPersonalProductSpaceId(null)
    setActiveProductSpaceId(null)
    setPendingSwitch(null)
    setUnavailableSpaceIds(new Set())
    setFlowState('loading')
    setError(null)

    let hadPersistedContext = false
    // Whether THIS bootstrap already fetched the authoritative membership
    // list from the server. When it did, a later failure must never fall
    // back to the device-local verified snapshot: that snapshot can be
    // stale (e.g. membership changed to personal-only) and would shadow the
    // authoritative result that is already published.
    let membershipFetchSucceeded = false
    try {
      const persisted = await getProductSpaceContextStorage(accountId)
      if (!isCurrentAccountScope(scope)) return null
      hadPersistedContext = Boolean(persisted.verifiedContext)

      // Direct switch: clear legacy Organization state once, executed by the
      // runtime with verifiable per-step results. Only an all-green run is
      // recorded in the device ledger; any failure (or a failed ledger
      // persistence) keeps the account fail-closed and retried on the next
      // bootstrap — the business surface never opens.
      const ledger = await readLegacyCleanupLedger(accountId)
      if (!ledger && !legacyInvalidatedAccountsRef.current.has(accountId)) {
        const cleanup = await window.electronAPI.productSpaceCleanupLegacyState()
        const ledgerWritten = cleanup.success
          ? await writeLegacyCleanupLedger(accountId, cleanup.results)
          : false
        if (!ledgerWritten) {
          throw { code: 'legacy_cleanup_failed' }
        }
      }
      legacyInvalidatedAccountsRef.current.add(accountId)
      legacyStateInvalidator.removeLegacyOrganizationAuthorizationCache()

      const fetched = await fetchProductSpaces(scope)
      if (!fetched || !isCurrentAccountScope(scope)) return null
      membershipFetchSucceeded = true


      const availableById = new Map<string, ProductSpaceSummary>(fetched.list.map(space => [space.id as string, space]))
      const storedId = getStoredActiveProductSpaceId(accountId)
      const restored = storedId ? availableById.get(storedId) : undefined
      const target = restored && isActiveSpace(restored) ? restored.id : fetched.personalId
      await applySpaceSelection(accountId, fetched.list, fetched.personalId, target)
      return 'ready'
    } catch (caught) {
      if (!isCurrentAccountScope(scope)) return null
      const record = (caught ?? {}) as Record<string, unknown>
      const code = typeof record.code === 'string' ? record.code : 'request_failed'
      setError({ code, message: typeof record.message === 'string' ? record.message : undefined })
      if (code === 'product_space_contract_unsupported') {
        enterContractBlocked(accountId)
        return 'contract-blocked'
      }
      // Offline or server failure of the MEMBERSHIP FETCH itself: restore
      // the read-only offline view from the Main-owned verified snapshot +
      // completed cleanup ledger. Main validates both before moving the
      // fence; resolves, new App/Skill and assistant executions stay blocked
      // until an online switch succeeds.
      //
      // When the fetch SUCCEEDED but a later stage failed, the offline
      // snapshot must not shadow the already-published authoritative list:
      // fail closed into the safe error state instead.
      if (membershipFetchSucceeded) {
        setFlowState('error')
        return 'error'
      }
      const restored = await window.electronAPI.productSpaceRestoreOfflineView()
      if (restored.success && isCurrentAccountScope(scope)) {
        applyListResponse(restored.snapshot)
        publishCommittedSelection(
          accountId,
          restored.snapshot.productSpaces,
          restored.snapshot.personalProductSpaceId,
          restored.snapshot.activeProductSpaceId,
        )
        return 'ready'
      }
      setFlowState('error')
      return 'error'
    }
  }, [applyListResponse, applySpaceSelection, fetchProductSpaces, isCurrentAccountScope])

  const refreshProductSpaces = useCallback(async (): Promise<ProductSpaceSummary[] | null> => {
    const accountId = accountIdRef.current
    if (!accountId) return null
    const scope = {
      accountId,
      generation: accountScopeGenerationRef.current,
    }
    try {
      // The fetched list is staged locally: it is only published together
      // with a consistent active selection, never before the membership
      // evaluation completes.
      const fetched = await fetchProductSpaces(scope, { publishList: false })
      if (!fetched) return null

      const listedIds = new Set<string>(fetched.list.map(space => space.id as string))
      setUnavailableSpaceIds(previous => new Set(
        [...previous].filter(id => listedIds.has(id)),
      ))

      const activeId = activeProductSpaceIdRef.current
      if (!activeId) {
        applyListResponse({ productSpaces: fetched.list, personalProductSpaceId: fetched.personalId })
        persistVerifiedContext(accountId, fetched.list, fetched.personalId, null)
        return fetched.list
      }
      const active = fetched.list.find(space => space.id === activeId)
      if (active && isActiveSpace(active)) {
        applyListResponse({ productSpaces: fetched.list, personalProductSpaceId: fetched.personalId })
        persistVerifiedContext(accountId, fetched.list, fetched.personalId, activeId)
        return fetched.list
      }

      // A removed membership makes the space disappear from the server list;
      // membership loss returns the account to personal space without
      // confirmation, per the shared operation contract. The stop-all fence
      // guards this path: the personal fallback transaction must fully
      // commit BEFORE the new list and selection are published together —
      // a half-published refresh can never render. A read-only space stays
      // entered so its restriction reason remains visible.
      if (!active && activeId !== fetched.personalId) {
        try {
          await applySpaceSelection(accountId, fetched.list, fetched.personalId, fetched.personalId)
        } catch {
          // Fail-closed: keep the last complete verified projection (the old
          // list is still published state) and surface the safe error page —
          // Apps, assistant, files and writes stay blocked there. Publishing
          // a list that lacks the active space would render a providerless
          // shell.
          setFlowState('error')
          return null
        }
        applyListResponse({ productSpaces: fetched.list, personalProductSpaceId: fetched.personalId })
        persistVerifiedContext(accountId, fetched.list, fetched.personalId, fetched.personalId)
        return fetched.list
      }

      applyListResponse({ productSpaces: fetched.list, personalProductSpaceId: fetched.personalId })
      persistVerifiedContext(accountId, fetched.list, fetched.personalId, activeId)
      return fetched.list
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      const code = typeof record.code === 'string' ? record.code : null
      if (code === 'product_space_contract_unsupported') {
        enterContractBlocked(accountId)
      }
      // Refresh failures keep the current space and its member relationships.
      return null
    }
  }, [applyListResponse, applySpaceSelection, enterContractBlocked, fetchProductSpaces, persistVerifiedContext])

  const listActiveExecutions = useCallback(async (): Promise<ExecutionSummary[] | null> => {
    const accountId = accountIdRef.current
    const activeId = activeProductSpaceIdRef.current
    if (!accountId || !activeId) return null
    const result = await window.electronAPI.productSpaceListActiveExecutions(
      accountId,
      activeId,
    )
    if (!result.success) {
      throw { code: result.errorCode, message: result.message }
    }
    return result.executions
  }, [])

  const verifyTargetStillAccessible = useCallback(async (
    scope: AccountScope,
    targetId: string,
  ): Promise<'ok' | 'access-lost' | 'unavailable' | 'contract-blocked' | null> => {
    try {
      const result = await window.electronAPI.productSpaceList()
      if (!isCurrentAccountScope(scope)) return null
      if (!result.success) {
        if (result.contractUnsupported) {
          throw { code: 'product_space_contract_unsupported' }
        }
        throw { code: result.errorCode }
      }
      const parsed = result as unknown as {
        productSpaces: ProductSpaceSummary[]
        personalProductSpaceId: string
      }
      applyListResponse(parsed)
      const target = parsed.productSpaces.find(space => space.id === targetId)
      // A read-only (restricted) target stays enterable so its restriction
      // reason and history entry remain visible; only a missing entry means
      // the access was lost.
      if (!target) return 'access-lost'
      persistVerifiedContext(
        scope.accountId,
        parsed.productSpaces,
        parsed.personalProductSpaceId,
        activeProductSpaceIdRef.current,
      )
      return 'ok'
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      // An incompatible contract discovered while re-validating the target
      // must enter the existing contract-blocked path (revoke the Main
      // fence, clear every business projection) — folding it into
      // "unavailable" would keep the old business UI usable, which violates
      // the fail-closed contract requirement.
      if (record.code === 'product_space_contract_unsupported') {
        enterContractBlocked(scope.accountId)
        return 'contract-blocked'
      }
      return 'unavailable'
    }
  }, [applyListResponse, enterContractBlocked, isCurrentAccountScope, persistVerifiedContext])

  const finishSwitchAfterStop = useCallback(async (
    scope: AccountScope,
    generation: number,
    targetId: string,
  ): Promise<void> => {
    const verification = await verifyTargetStillAccessible(scope, targetId)
    if (await abandonSwitchIfStale(generation)) return
    if (verification === 'contract-blocked') {
      // enterContractBlocked already revoked the fence, cleared every
      // business projection and bumped the generation (so the abandon check
      // above cancelled the prepared token). Nothing further may run: the
      // catalog staging and commit below would issue business requests in a
      // contract-blocked session.
      return
    }
    if (verification === 'access-lost') {
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-access-lost', errorCode: 'product_space_not_found' }
          : previous
      ))
      setUnavailableSpaceIds(previous => new Set([...previous, targetId]))
      return
    }
    if (verification !== 'ok') {
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-failed', errorCode: 'service_unavailable' }
          : previous
      ))
      return
    }
    // Staging gate: the target unified Catalog must load and pass the space
    // boundary BEFORE the prepared transaction commits the fence. Nothing
    // from the target space enters the UI until this succeeds, and the fence
    // is still on the origin space if it fails.
    try {
      const catalog = await window.electronAPI.productSpaceGetCatalog(targetId)
      if (!catalog.success) {
        throw { code: catalog.errorCode }
      }
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      const errorCode = typeof record.code === 'string' ? record.code : 'catalog_load_failed'
      if (errorCode === 'product_space_contract_unsupported') {
        enterContractBlocked(accountId)
        return
      }
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-failed', errorCode }
          : previous
      ))
      return
    }
    // All prepared conditions are green: atomically move the fence with the
    // one-time transaction token, then publish the renderer projection.
    try {
      await commitPreparedSwitch(targetId)
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      const errorCode = typeof record.code === 'string' ? record.code : 'runtime_commit_failed'
      if (errorCode === 'product_space_contract_unsupported') {
        enterContractBlocked(accountId)
        return
      }
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-failed', errorCode }
          : previous
      ))
      return
    }
    // Post-COMMIT generation re-check: a cancel that raced the final commit
    // await (or any newer switch/bootstrap) must never publish a stale
    // target — unless Main's authoritative cancellation verdict reports that
    // the commit already won its final gate and the committed target is
    // still the current fence. In that case the switch linearizes to the
    // committed target so the Main fence, the renderer projection, the
    // persisted selection and visible consumers converge on one space.
    if (generation !== switchGenerationRef.current) {
      pendingTargetRef.current = null
      const lateCancel = lateCancelRef.current
      lateCancelRef.current = null
      if (lateCancel && isCurrentAccountScope(scope)) {
        const resolved = await lateCancel.outcome.catch(() => null)
        if (
          resolved?.outcome === 'already_committed'
          && resolved.committedTargetProductSpaceId === targetId
          // The committed target must still be the CURRENT authoritative
          // fence: a newer commit elsewhere keeps the renderer put.
          && resolved.activeProductSpaceId === resolved.committedTargetProductSpaceId
          // No newer switch/bootstrap may have started after the cancel.
          && switchGenerationRef.current === lateCancel.generation
        ) {
          switchGenerationRef.current += 1
          setPendingSwitch(null)
          publishCommittedSelection(
            scope.accountId,
            productSpacesRef.current,
            personalProductSpaceIdRef.current ?? targetId,
            targetId,
          )
        }
      }
      return
    }
    switchGenerationRef.current += 1
    pendingTargetRef.current = null
    setPendingSwitch(null)
    publishCommittedSelection(
      scope.accountId,
      productSpacesRef.current,
      personalProductSpaceIdRef.current ?? targetId,
      targetId,
    )
  }, [abandonSwitchIfStale, commitPreparedSwitch, enterContractBlocked, publishCommittedSelection, verifyTargetStillAccessible])

  const requestSwitch = useCallback(async (targetId: string): Promise<void> => {
    const accountId = accountIdRef.current
    const activeId = activeProductSpaceIdRef.current
    if (!accountId || !activeId) {
      throw { code: 'product_space_context_unavailable' }
    }
    if (targetId === activeId) return
    if (pendingTargetRef.current) return
    if (!productSpacesRef.current.some(space => space.id === targetId)) return

    setError(null)
    let executions: ExecutionSummary[] = []
    try {
      executions = (await listActiveExecutions()) ?? []
    } catch (caught) {
      const record = (caught ?? {}) as Record<string, unknown>
      setError({
        code: typeof record.code === 'string' ? record.code : 'runtime_list_failed',
      })
      return
    }

    const statuses: Record<string, ExecutionSummary['status']> = {}
    for (const execution of executions) {
      statuses[execution.executionId] = execution.status
    }
    pendingTargetRef.current = targetId
    setPendingSwitch({
      targetId,
      phase: executions.length === 0 ? 'target-loading' : 'confirm',
      executions,
      statuses,
      errorCode: null,
    })

    // No running items: verify the target, finalize the (empty) stop phase,
    // and commit without a stop dialog.
    if (executions.length === 0) {
      const generation = switchGenerationRef.current
      const prepared = await prepareTrustedSwitch(targetId)
      if (await abandonSwitchIfStale(generation)) return
      if (!prepared.ok) {
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? { ...previous, phase: 'target-failed', errorCode: prepared.errorCode ?? 'runtime_stop_failed' }
            : previous
        ))
        return
      }
      const stopped = await stopPreparedSwitchExecutions(prepared.token!)
      if (await abandonSwitchIfStale(generation)) return
      if (!stopped.ok) {
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? { ...previous, phase: 'target-failed', errorCode: stopped.errorCode ?? 'runtime_stop_failed' }
            : previous
        ))
        return
      }
      const scope = {
        accountId,
        generation: accountScopeGenerationRef.current,
      }
      await finishSwitchAfterStop(scope, generation, targetId)
    }
  }, [abandonSwitchIfStale, finishSwitchAfterStop, listActiveExecutions, prepareTrustedSwitch, stopPreparedSwitchExecutions])

  const confirmStopAndSwitch = useCallback(async (): Promise<void> => {
    const accountId = accountIdRef.current
    const current = pendingSwitch
    if (!accountId || !current) return
    if (current.phase !== 'confirm' && current.phase !== 'stop-failed') return
    const scope = {
      accountId,
      generation: accountScopeGenerationRef.current,
    }
    const targetId = current.targetId
    const generation = ++switchGenerationRef.current
    pendingTargetRef.current = targetId
    setPendingSwitch(previous => (
      previous && previous.targetId === targetId
        ? {
            ...previous,
            phase: 'stopping',
            statuses: Object.fromEntries(
              previous.executions.map(execution => [execution.executionId, 'stopping' as const]),
            ),
          }
        : previous
    ))
    try {
      const committed = await prepareTrustedSwitch(targetId)
      if (await abandonSwitchIfStale(generation)) return
      if (!committed.ok) {
        if (committed.errorCode === 'runtime_stop_failed') {
          setPendingSwitch(previous => (
            previous && previous.targetId === targetId
              ? {
                  ...previous,
                  phase: 'stop-failed',
                  statuses: committed.statuses,
                  errorCode: 'runtime_stop_failed',
                }
              : previous
          ))
          return
        }
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? { ...previous, phase: 'target-failed', errorCode: committed.errorCode ?? 'runtime_commit_failed' }
            : previous
        ))
        return
      }
      // The token is already held: Main dispatches the terminations now and
      // checks cancellation before every dispatch, so the frozen cancel
      // button is real during this phase.
      const stopped = await stopPreparedSwitchExecutions(committed.token!)
      if (stopped.errorCode === 'SWITCH_CANCELLED') {
        // The user cancelled during stopping: Main left every not-yet-
        // dispatched execution running and released the transaction.
        return
      }
      if (await abandonSwitchIfStale(generation)) return
      if (!stopped.ok) {
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? {
                ...previous,
                phase: 'stop-failed',
                statuses: stopped.statuses,
                errorCode: stopped.errorCode ?? 'runtime_stop_failed',
              }
            : previous
        ))
        return
      }
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-loading', statuses: stopped.statuses, errorCode: null }
          : previous
      ))
      await finishSwitchAfterStop(scope, generation, targetId)
    } catch (caught) {
      if (generation !== switchGenerationRef.current) return
      const record = (caught ?? {}) as Record<string, unknown>
      const errorCode = typeof record.code === 'string' ? record.code : 'runtime_stop_failed'
      setPendingSwitch(previous => {
        if (!previous || previous.targetId !== targetId) return previous
        const statuses: Record<string, ExecutionSummary['status']> = { ...previous.statuses }
        for (const execution of previous.executions) {
          if (statuses[execution.executionId] === 'stopping') {
            statuses[execution.executionId] = 'failed'
          }
        }
        return { ...previous, phase: 'stop-failed', statuses, errorCode }
      })
    }
  }, [abandonSwitchIfStale, finishSwitchAfterStop, pendingSwitch, prepareTrustedSwitch, stopPreparedSwitchExecutions])

  const retryFailedStops = useCallback(async (): Promise<void> => {
    await confirmStopAndSwitch()
  }, [confirmStopAndSwitch])

  const retryTargetLoad = useCallback(async (): Promise<void> => {
    const accountId = accountIdRef.current
    const targetId = pendingTargetRef.current
    if (!accountId || !targetId) return
    const scope = {
      accountId,
      generation: accountScopeGenerationRef.current,
    }
    const generation = switchGenerationRef.current
    setPendingSwitch(previous => (
      previous ? { ...previous, phase: 'target-loading', errorCode: null } : previous
    ))
    // A commit-level failure consumes the one-time token at Main. Retry must
    // re-prepare the trusted transaction (and re-run the stop phase, since
    // commit requires the finalized 'ready' state) before re-staging and
    // committing; a still-held token (pre-commit staging failure) is reused
    // as-is with its already-finalized stop phase.
    if (!preparedSwitchTokenRef.current) {
      const prepared = await prepareTrustedSwitch(targetId)
      if (await abandonSwitchIfStale(generation)) return
      if (!prepared.ok) {
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? { ...previous, phase: 'target-failed', errorCode: prepared.errorCode ?? 'runtime_stop_failed' }
            : previous
        ))
        return
      }
      const stopped = await stopPreparedSwitchExecutions(prepared.token!)
      if (await abandonSwitchIfStale(generation)) return
      if (!stopped.ok) {
        setPendingSwitch(previous => (
          previous && previous.targetId === targetId
            ? { ...previous, phase: 'target-failed', errorCode: stopped.errorCode ?? 'runtime_stop_failed' }
            : previous
        ))
        return
      }
    }
    await finishSwitchAfterStop(scope, generation, targetId)
  }, [abandonSwitchIfStale, finishSwitchAfterStop, prepareTrustedSwitch, stopPreparedSwitchExecutions])

  const cancelSwitch = useCallback((): void => {
    switchGenerationRef.current += 1
    const generation = switchGenerationRef.current
    pendingTargetRef.current = null
    setPendingSwitch(null)
    // The click closes the dialog immediately but does NOT irreversibly
    // decide the switch: the authoritative Main cancellation result (stored
    // for the in-flight COMMIT to consume) decides between staying on the
    // origin and converging to the already-committed target.
    lateCancelRef.current = {
      generation,
      outcome: cancelPreparedSwitch(),
    }
  }, [cancelPreparedSwitch])

  const dismissTargetAccessLost = useCallback((): void => {
    cancelSwitch()
  }, [cancelSwitch])

  const clearAccount = useCallback((accountId?: string | null) => {
    const targetAccountId = accountId ?? accountIdRef.current
    void window.electronAPI.productSpaceRevokeActiveContext().catch(() => {})
    if (targetAccountId) {
      clearStoredActiveProductSpaceId(targetAccountId)
      void clearVerifiedProductSpaceContext(targetAccountId)
      legacyInvalidatedAccountsRef.current.delete(targetAccountId)
    }
    accountScopeGenerationRef.current += 1
    switchGenerationRef.current += 1
    accountIdRef.current = null
    activeProductSpaceIdRef.current = null
    pendingTargetRef.current = null
    setProductSpaces([])
    setPersonalProductSpaceId(null)
    setActiveProductSpaceId(null)
    setPendingSwitch(null)
    setUnavailableSpaceIds(new Set())
    setError(null)
    setContextVersion(version => version + 1)
    setFlowState('idle')
  }, [])

  const retryBootstrap = useCallback(async (): Promise<
    'ready' | 'contract-blocked' | 'error' | null
  > => {
    const accountId = accountIdRef.current
    if (!accountId) return null
    return bootstrap(accountId)
  }, [bootstrap])

  const activeProductSpace = useMemo(
    () => productSpaces.find(space => space.id === activeProductSpaceId) ?? null,
    [activeProductSpaceId, productSpaces],
  )

  const accountId = accountIdRef.current
  const productSpaceContextKey = accountId && activeProductSpaceId
    ? createProductSpaceContextKey(accountId, activeProductSpaceId)
    : null

  const selectableSpaces = useMemo(
    () => productSpaces.filter(space => !unavailableSpaceIds.has(space.id)),
    [productSpaces, unavailableSpaceIds],
  )

  return {
    accountId,
    flowState,
    productSpaces: selectableSpaces,
    allProductSpaces: productSpaces,
    personalProductSpaceId,
    activeProductSpace,
    activeProductSpaceId,
    productSpaceContextKey,
    contextVersion,
    pendingSwitch,
    unavailableSpaceIds,
    error,
    bootstrap,
    refreshProductSpaces,
    retryBootstrap,
    requestSwitch,
    confirmStopAndSwitch,
    retryFailedStops,
    retryTargetLoad,
    cancelSwitch,
    dismissTargetAccessLost,
    clearAccount,
    rollbackToOrigin,
    enterContractBlocked,
  }
}

export type ProductSpaceContextState = ReturnType<typeof useProductSpaceContextState>
