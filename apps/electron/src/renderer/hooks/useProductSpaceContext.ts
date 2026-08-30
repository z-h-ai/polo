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
  const legacyInvalidatedAccountsRef = useRef(new Set<string>())
  const productSpacesRef = useRef<ProductSpaceSummary[]>([])
  productSpacesRef.current = productSpaces
  const personalProductSpaceIdRef = useRef<string | null>(null)
  personalProductSpaceIdRef.current = personalProductSpaceId

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
   * Moves the runtime fence through the Main-side trusted switch transaction.
   * The renderer can never write the fence directly: Main verifies the target
   * against the account's contract-validated list, terminates running items,
   * re-enumerates under the switch lock and only then commits atomically. A
   * rejected transaction keeps every piece of renderer state — selection,
   * context key, runtime scope — inside the origin space.
   */
  const commitTrustedSwitch = useCallback(async (
    targetId: string,
  ): Promise<{
    ok: boolean
    errorCode?: string
    statuses: Record<string, ExecutionSummary['status']>
  }> => {
    const result = await window.electronAPI.productSpaceExecuteSwitch(targetId)
    if (result.success) {
      const statuses: Record<string, ExecutionSummary['status']> = {}
      for (const execution of result.executions) {
        statuses[execution.executionId] = execution.status
      }
      return { ok: true, statuses }
    }
    const statuses: Record<string, ExecutionSummary['status']> = {}
    for (const execution of result.executions ?? []) {
      statuses[execution.executionId] = execution.status
    }
    return { ok: false, errorCode: result.errorCode, statuses }
  }, [])

  const applySpaceSelection = useCallback(async (
    accountId: string,
    list: ProductSpaceSummary[],
    personalId: string,
    productSpaceId: string,
  ): Promise<void> => {
    const committed = await commitTrustedSwitch(productSpaceId)
    if (!committed.ok) {
      throw { code: committed.errorCode ?? 'runtime_commit_failed' }
    }
    publishCommittedSelection(accountId, list, personalId, productSpaceId)
  }, [commitTrustedSwitch])

  const applyListResponse = useCallback((parsed: {
    productSpaces: ProductSpaceSummary[]
    personalProductSpaceId: string
  }) => {
    setProductSpaces(parsed.productSpaces)
    setPersonalProductSpaceId(parsed.personalProductSpaceId)
  }, [])

  const fetchProductSpaces = useCallback(async (scope: AccountScope): Promise<{
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
    applyListResponse(parsed)
    return {
      list: parsed.productSpaces,
      personalId: parsed.personalProductSpaceId,
    }
  }, [applyListResponse, isCurrentAccountScope])

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
      // Offline or server failure: fall back to the device's last verified
      // context so saved data stays viewable. This is cached view state only;
      // new launches still require the network. The verified context never
      // substitutes for the persisted cleanup ledger — an unverified direct
      // switch keeps the account fail-closed.
      const verified = hadPersistedContext
        ? (await getProductSpaceContextStorage(accountId)).verifiedContext
        : null
      const cleanupLedger = await readLegacyCleanupLedger(accountId)
      if (verified && cleanupLedger && isCurrentAccountScope(scope)) {
        const storedId = getStoredActiveProductSpaceId(accountId)
          ?? verified.activeProductSpaceId
          ?? verified.list.personalProductSpaceId
        const listed = verified.list.productSpaces.find(
          space => space.id === storedId && isActiveSpace(space),
        )
        const target = listed?.id ?? verified.list.personalProductSpaceId
        applyListResponse(verified.list)
        await applySpaceSelection(
          accountId,
          verified.list.productSpaces,
          verified.list.personalProductSpaceId,
          target,
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
      const fetched = await fetchProductSpaces(scope)
      if (!fetched) return null
      persistVerifiedContext(
        accountId,
        fetched.list,
        fetched.personalId,
        activeProductSpaceIdRef.current,
      )

      const listedIds = new Set<string>(fetched.list.map(space => space.id as string))
      setUnavailableSpaceIds(previous => new Set(
        [...previous].filter(id => listedIds.has(id)),
      ))

      const activeId = activeProductSpaceIdRef.current
      if (!activeId) return fetched.list
      const active = fetched.list.find(space => space.id === activeId)
      if (active && isActiveSpace(active)) return fetched.list

      // A removed membership makes the space disappear from the server list;
      // membership loss returns the account to personal space without
      // confirmation, per the shared operation contract. The same atomic
      // stop-all fence guards this path: if any execution cannot be
      // terminated, the account stays on the old space (safe degraded state)
      // instead of half-switching. A read-only space stays entered so its
      // restriction reason remains visible.
      if (!active && activeId !== fetched.personalId) {
        // Same trusted transaction, no confirmation needed for membership
        // loss. Any rejection keeps the old space and degrades safely.
        try {
          await applySpaceSelection(accountId, fetched.list, fetched.personalId, fetched.personalId)
        } catch {
          setFlowState('error')
          return fetched.list
        }
      }
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
  }, [applySpaceSelection, enterContractBlocked, fetchProductSpaces, persistVerifiedContext])

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
  ): Promise<'ok' | 'access-lost' | 'unavailable' | null> => {
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
    } catch {
      return 'unavailable'
    }
  }, [applyListResponse, isCurrentAccountScope, persistVerifiedContext])

  const commitSwitch = useCallback(async (
    scope: AccountScope,
    targetId: string,
  ): Promise<boolean> => {
    const accountId = accountIdRef.current
    if (!accountId || !isCurrentAccountScope(scope)) return false
    const personalId = personalProductSpaceIdRef.current
    if (!personalId) return false
    try {
      await applySpaceSelection(accountId, productSpacesRef.current, personalId, targetId)
      return true
    } catch {
      // The runtime commit failed: nothing was published, so the client is
      // still fully inside the origin space.
      return false
    }
  }, [applySpaceSelection, isCurrentAccountScope])

  const finishSwitchAfterStop = useCallback(async (
    scope: AccountScope,
    generation: number,
    targetId: string,
  ): Promise<void> => {
    const verification = await verifyTargetStillAccessible(scope, targetId)
    if (generation !== switchGenerationRef.current) return
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
    // boundary before the selection is committed. Nothing from the target
    // space enters the UI until this succeeds.
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
    if (await commitSwitch(scope, targetId)) {
      switchGenerationRef.current += 1
      pendingTargetRef.current = null
      setPendingSwitch(null)
    } else {
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-failed', errorCode: 'runtime_commit_failed' }
          : previous
      ))
    }
  }, [commitSwitch, verifyTargetStillAccessible])

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

    // No running items: verify the target and commit without a stop dialog.
    if (executions.length === 0) {
      const scope = {
        accountId,
        generation: accountScopeGenerationRef.current,
      }
      const generation = ++switchGenerationRef.current
      await finishSwitchAfterStop(scope, generation, targetId)
    }
  }, [finishSwitchAfterStop, listActiveExecutions])

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
      const committed = await commitTrustedSwitch(targetId)
      if (generation !== switchGenerationRef.current) return
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
      setPendingSwitch(previous => (
        previous && previous.targetId === targetId
          ? { ...previous, phase: 'target-loading', statuses: committed.statuses, errorCode: null }
          : previous
      ))
      await finishSwitchAfterStop(scope, generation, targetId)
    } catch (caught) {
      console.error('CONFIRM_SWITCH_CAUGHT', caught)
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
  }, [commitTrustedSwitch, finishSwitchAfterStop, pendingSwitch])

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
    await finishSwitchAfterStop(scope, generation, targetId)
  }, [finishSwitchAfterStop])

  const cancelSwitch = useCallback((): void => {
    switchGenerationRef.current += 1
    pendingTargetRef.current = null
    setPendingSwitch(null)
  }, [])

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
  }
}

export type ProductSpaceContextState = ReturnType<typeof useProductSpaceContextState>
