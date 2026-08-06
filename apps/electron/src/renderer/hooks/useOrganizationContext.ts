import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  CreateOrganizationInput,
  OrganizationJoinPreview,
  OrganizationRole,
  OrganizationSummary,
} from '../../shared/types'
import {
  clearPendingOrganizationJoinToken,
  clearStoredActiveOrganizationId,
  clearVerifiedOrganizationContext,
  createUnavailableOrganizationTombstone,
  createOrganizationContextKey,
  getOrganizationContextStorage,
  getPendingOrganizationJoinToken,
  getStoredActiveOrganizationId,
  setPendingOrganizationJoinToken,
  setStoredActiveOrganizationId,
  setUnavailableOrganizationContext,
  setVerifiedOrganizationContext,
} from '@/lib/organization-storage'
import type {
  UnavailableOrganizationTombstone,
  VerifiedOrganizationContext,
} from '@/lib/organization-storage'
import {
  emitAdminAuthFailure,
  normalizeAdminError,
} from '@/lib/admin-auth-failure'

export type OrganizationFlowState =
  | 'idle'
  | 'loading'
  | 'create'
  | 'join'
  | 'select'
  | 'ready'

export interface OrganizationFlowError {
  code: string
  status?: number
  authFailureHandled?: true
}

export interface AcceptJoinOutcome {
  completed: boolean
}

interface OrganizationAccountScope {
  accountId: string
  generation: number
}

const TEMPORARY_ORGANIZATION_ERROR_CODES = new Set([
  'FETCH_FAILED',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  'request_failed',
])

function isTemporaryOrganizationError(error: OrganizationFlowError): boolean {
  return (
    TEMPORARY_ORGANIZATION_ERROR_CODES.has(error.code)
    || (typeof error.status === 'number' && error.status >= 500)
  )
}

function isActiveOrganization(organization: OrganizationSummary): boolean {
  return organization.status !== 'suspended'
    && organization.membership.status === 'active'
}

function resultError(result: {
  errorCode?: string
  status?: number
}): OrganizationFlowError {
  const normalized = normalizeAdminError(result)
  const authFailureHandled = emitAdminAuthFailure(normalized)
  return authFailureHandled
    ? { ...normalized, authFailureHandled: true }
    : normalized
}

function caughtError(caught: unknown): OrganizationFlowError {
  if (caught && typeof caught === 'object') {
    const record = caught as Record<string, unknown>
    const normalized = normalizeAdminError({
      code: typeof record.code === 'string' ? record.code : undefined,
      errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
      status: typeof record.status === 'number' ? record.status : undefined,
    })
    if (record.authFailureHandled === true) {
      return { ...normalized, authFailureHandled: true }
    }
    const authFailureHandled = emitAdminAuthFailure(normalized)
    return authFailureHandled
      ? { ...normalized, authFailureHandled: true }
      : normalized
  }
  return { code: 'request_failed' }
}

function persistOrganizationContext(persistence: Promise<void>): void {
  void persistence.catch(() => {
    // The live authorization state remains authoritative. A later verified
    // response or bootstrap will retry the device-local preference write.
  })
}

export function useOrganizationContextState() {
  const [flowState, setFlowState] = useState<OrganizationFlowState>('idle')
  const [organizationSummaries, setOrganizationSummaries] = useState<OrganizationSummary[]>([])
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null)
  const [organizationMembershipRole, setOrganizationMembershipRole] = useState<OrganizationRole | null>(null)
  const [pendingJoinToken, setPendingJoinToken] = useState<string | null>(
    () => getPendingOrganizationJoinToken(),
  )
  // Join concurrency invariant: pendingJoinTokenRef is the newest deep-link intent,
  // joinPreviewTokenRef identifies the token actually shown, and the generation
  // invalidates every earlier preview/accept chain when a token is replaced or cleared.
  const pendingJoinTokenRef = useRef(pendingJoinToken)
  const joinPreviewTokenRef = useRef<string | null>(null)
  const joinPreviewGenerationRef = useRef(0)
  const [joinPreview, setJoinPreview] = useState<OrganizationJoinPreview | null>(null)
  const [error, setError] = useState<OrganizationFlowError | null>(null)
  const [contextVersion, setContextVersion] = useState(0)
  // Account-scope generation invalidates every bootstrap/list/create/accept chain
  // started for an earlier login, even when its IPC response arrives after account swap.
  const accountIdRef = useRef<string | null>(null)
  const accountScopeGenerationRef = useRef(0)
  const organizationSummariesRef = useRef(organizationSummaries)
  organizationSummariesRef.current = organizationSummaries
  const activeOrganizationIdRef = useRef<string | null>(null)
  const unavailableOrganizationRef = useRef<
    UnavailableOrganizationTombstone | null
  >(null)
  const organizationScopeGenerationRef = useRef(0)
  const refreshGenerationRef = useRef(0)

  const isCurrentAccountScope = useCallback((scope: OrganizationAccountScope) => (
    accountIdRef.current === scope.accountId
    && accountScopeGenerationRef.current === scope.generation
  ), [])

  const activateOrganization = useCallback((
    accountId: string,
    summaries: OrganizationSummary[],
    organizationId: string,
  ) => {
    const organization = summaries.find(item => item.id === organizationId)
    if (!organization || !isActiveOrganization(organization)) {
      throw { code: 'membership_not_active' } satisfies OrganizationFlowError
    }

    setStoredActiveOrganizationId(accountId, organizationId)
    persistOrganizationContext(
      setVerifiedOrganizationContext(accountId, summaries, organizationId),
    )
    unavailableOrganizationRef.current = null
    accountIdRef.current = accountId
    organizationSummariesRef.current = summaries
    activeOrganizationIdRef.current = organizationId
    organizationScopeGenerationRef.current += 1
    setActiveOrganizationId(organizationId)
    setOrganizationMembershipRole(organization.membership.role)
    setContextVersion(version => version + 1)
    setFlowState('ready')
    setError(null)

    window.dispatchEvent(new CustomEvent('polo:organization-changed', {
      detail: {
        accountId,
        organizationId,
        role: organization.membership.role,
        contextKey: createOrganizationContextKey(accountId, organizationId),
      },
    }))
  }, [])

  const retainUnavailableOrganization = useCallback((
    accountId: string,
    summaries: OrganizationSummary[],
    unavailableOrganization: OrganizationSummary,
  ) => {
    const tombstone = createUnavailableOrganizationTombstone(
      unavailableOrganization,
    )
    const nextSummaries = [
      ...summaries.filter(item => item.id !== tombstone.id),
      tombstone,
    ]
    clearStoredActiveOrganizationId(accountId)
    persistOrganizationContext(
      setUnavailableOrganizationContext(
        accountId,
        summaries,
        tombstone,
      ),
    )
    unavailableOrganizationRef.current = {
      organization: tombstone,
      recordedAt: Date.now(),
    }
    accountIdRef.current = accountId
    organizationSummariesRef.current = nextSummaries
    activeOrganizationIdRef.current = tombstone.id
    organizationScopeGenerationRef.current += 1
    setOrganizationSummaries(nextSummaries)
    setActiveOrganizationId(tombstone.id)
    setOrganizationMembershipRole(tombstone.membership.role)
    setContextVersion(version => version + 1)
    setFlowState('ready')
    setError(null)

    window.dispatchEvent(new CustomEvent('polo:organization-changed', {
      detail: {
        accountId,
        organizationId: tombstone.id,
        role: tombstone.membership.role,
        contextKey: createOrganizationContextKey(accountId, tombstone.id),
        available: false,
      },
    }))
  }, [])

  const loadOrganizations = useCallback(async (
    scope: OrganizationAccountScope,
  ): Promise<OrganizationSummary[] | null> => {
    const result = await window.electronAPI.organizationList()
    if (!isCurrentAccountScope(scope)) return null
    if (!result.success) throw resultError(result)
    organizationSummariesRef.current = result.organizations
    setOrganizationSummaries(result.organizations)
    persistOrganizationContext(
      setVerifiedOrganizationContext(
        scope.accountId,
        result.organizations,
        activeOrganizationIdRef.current
          ?? getStoredActiveOrganizationId(scope.accountId),
      ),
    )
    return result.organizations
  }, [isCurrentAccountScope])

  const previewJoin = useCallback(async (token: string) => {
    // Starting a preview increments the generation and removes the previously
    // displayed-token binding. Its response may commit only while token + generation
    // still describe the latest pending deep link.
    const generation = ++joinPreviewGenerationRef.current
    joinPreviewTokenRef.current = null
    setJoinPreview(null)
    setError(null)
    try {
      const result = await window.electronAPI.organizationPreviewJoin(token)
      if (
        generation !== joinPreviewGenerationRef.current
        || pendingJoinTokenRef.current !== token
      ) {
        return null
      }
      if (!result.success) {
        setError(resultError(result))
        return null
      }
      joinPreviewTokenRef.current = token
      setJoinPreview({
        organization: result.organization,
        join: result.join,
      })
      return result
    } catch (caught) {
      if (
        generation === joinPreviewGenerationRef.current
        && pendingJoinTokenRef.current === token
      ) {
        setError(caughtError(caught))
      }
      return null
    }
  }, [])

  const bootstrap = useCallback(async (
    accountId: string,
  ): Promise<OrganizationFlowState | null> => {
    const scope = {
      accountId,
      generation: ++accountScopeGenerationRef.current,
    }
    accountIdRef.current = accountId
    joinPreviewGenerationRef.current += 1
    joinPreviewTokenRef.current = null
    activeOrganizationIdRef.current = null
    organizationScopeGenerationRef.current += 1
    organizationSummariesRef.current = []
    setOrganizationSummaries([])
    setJoinPreview(null)
    setActiveOrganizationId(null)
    setOrganizationMembershipRole(null)
    setFlowState('loading')
    setError(null)

    let previouslyVerified: VerifiedOrganizationContext | null = null
    let persistedTombstone: UnavailableOrganizationTombstone | null = null
    try {
      const persisted = await getOrganizationContextStorage(accountId)
      if (!isCurrentAccountScope(scope)) return null
      previouslyVerified = persisted.verifiedContext ?? null
      persistedTombstone = persisted.unavailableTombstone ?? null
      unavailableOrganizationRef.current = persistedTombstone

      const summaries = await loadOrganizations(scope)
      if (!summaries || !isCurrentAccountScope(scope)) return null
      const token = getPendingOrganizationJoinToken() ?? pendingJoinTokenRef.current
      if (token) {
        pendingJoinTokenRef.current = token
        setPendingJoinToken(token)
        await previewJoin(token)
        if (!isCurrentAccountScope(scope)) return null
        setFlowState('join')
        return 'join'
      }

      if (!isCurrentAccountScope(scope)) return null
      const activeSummaries = summaries.filter(
        isActiveOrganization,
      )
      const priorOrganizationId = persistedTombstone?.organization.id
        ?? previouslyVerified?.activeOrganizationId
      if (priorOrganizationId) {
        const reauthorized = activeSummaries.find(
          organization => organization.id === priorOrganizationId,
        )
        if (reauthorized) {
          activateOrganization(accountId, summaries, reauthorized.id)
          return 'ready'
        }
        const unavailable = summaries.find(
          organization => organization.id === priorOrganizationId,
        )
          ?? persistedTombstone?.organization
          ?? previouslyVerified?.organizationSummaries.find(
            organization => organization.id === priorOrganizationId,
          )
        if (unavailable) {
          retainUnavailableOrganization(accountId, summaries, unavailable)
          return 'ready'
        }
      }
      if (activeSummaries.length === 0) {
        activeOrganizationIdRef.current = null
        setActiveOrganizationId(null)
        setOrganizationMembershipRole(null)
        setFlowState('create')
        return 'create'
      }

      const storedId = getStoredActiveOrganizationId(accountId)
      const preferred = (
        storedId ? activeSummaries.find(item => item.id === storedId) : undefined
      ) ?? (activeSummaries.length === 1 ? activeSummaries[0] : undefined)

      if (preferred) {
        activateOrganization(accountId, summaries, preferred.id)
        return 'ready'
      }

      activeOrganizationIdRef.current = null
      setActiveOrganizationId(null)
      setOrganizationMembershipRole(null)
      setFlowState('select')
      return 'select'
    } catch (caught) {
      if (!isCurrentAccountScope(scope)) return null
      const nextError = caughtError(caught)
      if (nextError.authFailureHandled) {
        clearStoredActiveOrganizationId(accountId)
        persistOrganizationContext(clearVerifiedOrganizationContext(accountId))
        unavailableOrganizationRef.current = null
      } else if (isTemporaryOrganizationError(nextError)) {
        const cached = previouslyVerified
        const active = cached?.activeOrganizationId
          ? cached.organizationSummaries.find(organization => (
              organization.id === cached.activeOrganizationId
              && isActiveOrganization(organization)
            ))
          : undefined
        if (cached && active && isCurrentAccountScope(scope)) {
          setOrganizationSummaries(cached.organizationSummaries)
          activateOrganization(accountId, cached.organizationSummaries, active.id)
          return 'ready'
        }
        const unavailable = persistedTombstone?.organization
        if (unavailable && isCurrentAccountScope(scope)) {
          retainUnavailableOrganization(accountId, [], unavailable)
          return 'ready'
        }
      }
      setError(nextError)
      setFlowState('loading')
      throw caught
    }
  }, [
    activateOrganization,
    isCurrentAccountScope,
    loadOrganizations,
    previewJoin,
    retainUnavailableOrganization,
  ])

  const receiveJoinToken = useCallback(async (token: string) => {
    setPendingOrganizationJoinToken(token)
    pendingJoinTokenRef.current = token
    setPendingJoinToken(token)
    setFlowState('join')
    await previewJoin(token)
  }, [previewJoin])

  const dismissJoin = useCallback((): OrganizationFlowState => {
    clearPendingOrganizationJoinToken()
    joinPreviewGenerationRef.current += 1
    joinPreviewTokenRef.current = null
    pendingJoinTokenRef.current = null
    setPendingJoinToken(null)
    setJoinPreview(null)
    setError(null)

    const activeSummaries = organizationSummaries.filter(isActiveOrganization)
    if (activeSummaries.length === 0) {
      setFlowState('create')
      return 'create'
    }

    const accountId = accountIdRef.current
    const unavailable = accountId
      ? unavailableOrganizationRef.current?.organization
      : null
    if (accountId && unavailable) {
      retainUnavailableOrganization(
        accountId,
        organizationSummaries.filter(isActiveOrganization),
        unavailable,
      )
      return 'ready'
    }
    const storedId = accountId ? getStoredActiveOrganizationId(accountId) : null
    const preferred = (
      storedId
        ? activeSummaries.find(item => item.id === storedId)
        : undefined
    ) ?? (activeSummaries.length === 1 ? activeSummaries[0] : undefined)

    if (accountId && preferred) {
      activateOrganization(accountId, organizationSummaries, preferred.id)
      return 'ready'
    }

    setFlowState('select')
    return 'select'
  }, [
    activateOrganization,
    organizationSummaries,
    retainUnavailableOrganization,
  ])

  const createOrganization = useCallback(async (input: CreateOrganizationInput) => {
    const accountId = accountIdRef.current
    if (!accountId) {
      throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
    }
    const scope = {
      accountId,
      generation: accountScopeGenerationRef.current,
    }
    setError(null)
    try {
      const result = await window.electronAPI.organizationCreate(input)
      if (!isCurrentAccountScope(scope)) return null
      if (!result.success) throw resultError(result)
      if (
        result.membership.role !== 'owner'
        || result.membership.status !== 'active'
      ) {
        throw {
          code: 'owner_membership_unconfirmed',
        } satisfies OrganizationFlowError
      }

      const summaries = await loadOrganizations(scope)
      if (!summaries || !isCurrentAccountScope(scope)) return null
      const created = summaries.find(item => item.id === result.organization.id)
      if (created?.membership.role !== 'owner') {
        throw {
          code: 'owner_membership_unconfirmed',
        } satisfies OrganizationFlowError
      }
      activateOrganization(accountId, summaries, result.organization.id)
      return result
    } catch (caught) {
      if (!isCurrentAccountScope(scope)) return null
      const nextError = caughtError(caught)
      setError(nextError)
      throw nextError
    }
  }, [activateOrganization, isCurrentAccountScope, loadOrganizations])

  const acceptJoin = useCallback(async () => {
    // Acceptance snapshots the visible preview token and generation. Every async
    // boundary must preserve the pending token, displayed token, and generation
    // before the result may activate an organization or clear the join context.
    const token = joinPreviewTokenRef.current
    if (!token || pendingJoinTokenRef.current !== token) {
      throw { code: 'join_token_unavailable' } satisfies OrganizationFlowError
    }
    const generation = joinPreviewGenerationRef.current
    const accountId = accountIdRef.current
    if (!accountId) {
      throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
    }
    const accountScope = {
      accountId,
      generation: accountScopeGenerationRef.current,
    }
    setError(null)
    try {
      const result = await window.electronAPI.organizationAcceptJoin(token)
      if (!isCurrentAccountScope(accountScope)) {
        return { completed: false } satisfies AcceptJoinOutcome
      }
      if (!result.success) throw resultError(result)

      const isCurrentJoin = () => (
        isCurrentAccountScope(accountScope)
        && generation === joinPreviewGenerationRef.current
        && joinPreviewTokenRef.current === token
        && pendingJoinTokenRef.current === token
      )
      if (!isCurrentJoin()) {
        return { completed: false } satisfies AcceptJoinOutcome
      }

      const summaries = await loadOrganizations(accountScope)
      if (!summaries) {
        return { completed: false } satisfies AcceptJoinOutcome
      }
      if (!isCurrentJoin()) {
        return { completed: false } satisfies AcceptJoinOutcome
      }

      clearPendingOrganizationJoinToken()
      joinPreviewGenerationRef.current += 1
      joinPreviewTokenRef.current = null
      pendingJoinTokenRef.current = null
      setPendingJoinToken(null)
      setJoinPreview(null)
      activateOrganization(accountId, summaries, result.membership.organizationId)
      return { completed: true } satisfies AcceptJoinOutcome
    } catch (caught) {
      if (!isCurrentAccountScope(accountScope)) {
        return { completed: false } satisfies AcceptJoinOutcome
      }
      const nextError = caughtError(caught)
      if (
        generation === joinPreviewGenerationRef.current
        && joinPreviewTokenRef.current === token
        && pendingJoinTokenRef.current === token
      ) {
        setError(nextError)
      }
      throw nextError
    }
  }, [activateOrganization, isCurrentAccountScope, loadOrganizations])

  const selectOrganization = useCallback((organizationId: string) => {
    const accountId = accountIdRef.current
    if (!accountId) {
      throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
    }
    activateOrganization(accountId, organizationSummaries, organizationId)
  }, [activateOrganization, organizationSummaries])

  const refreshOrganizations = useCallback(async () => {
    const requestAccountId = accountIdRef.current
    if (!requestAccountId) return []
    const requestOrganizationId = activeOrganizationIdRef.current
    const scopeGeneration = organizationScopeGenerationRef.current
    const refreshGeneration = ++refreshGenerationRef.current
    const isCurrentScope = () => (
      refreshGeneration === refreshGenerationRef.current
      && scopeGeneration === organizationScopeGenerationRef.current
      && accountIdRef.current === requestAccountId
      && activeOrganizationIdRef.current === requestOrganizationId
    )

    const result = await window.electronAPI.organizationList()
    if (!isCurrentScope()) return result.success ? result.organizations : []
    if (!result.success) {
      const nextError = resultError(result)
      if (nextError.authFailureHandled) {
        clearStoredActiveOrganizationId(requestAccountId)
        persistOrganizationContext(
          clearVerifiedOrganizationContext(requestAccountId),
        )
        unavailableOrganizationRef.current = null
      }
      throw nextError
    }
    const summaries = result.organizations

    if (!requestOrganizationId) {
      organizationSummariesRef.current = summaries
      setOrganizationSummaries(summaries)
      persistOrganizationContext(
        setVerifiedOrganizationContext(requestAccountId, summaries, null),
      )
      return summaries
    }
    const active = summaries.find(item => (
      item.id === requestOrganizationId
      && isActiveOrganization(item)
    ))
    if (!active) {
      const unavailable = summaries.find(
        item => item.id === requestOrganizationId,
      ) ?? organizationSummariesRef.current.find(
        item => item.id === requestOrganizationId,
      ) ?? unavailableOrganizationRef.current?.organization
      if (unavailable) {
        retainUnavailableOrganization(
          requestAccountId,
          summaries,
          unavailable,
        )
        return summaries
      }
      organizationSummariesRef.current = summaries
      setOrganizationSummaries(summaries)
      clearStoredActiveOrganizationId(requestAccountId)
      persistOrganizationContext(
        setVerifiedOrganizationContext(requestAccountId, summaries, null),
      )
      unavailableOrganizationRef.current = null
      activeOrganizationIdRef.current = null
      organizationScopeGenerationRef.current += 1
      setActiveOrganizationId(null)
      setOrganizationMembershipRole(null)
      setFlowState(summaries.length === 0 ? 'create' : 'select')
      return summaries
    }
    organizationSummariesRef.current = summaries
    setOrganizationSummaries(summaries)
    unavailableOrganizationRef.current = null
    persistOrganizationContext(
      setVerifiedOrganizationContext(requestAccountId, summaries, active.id),
    )
    setOrganizationMembershipRole(active.membership.role)
    return summaries
  }, [retainUnavailableOrganization])

  const clearAccount = useCallback((
    accountId?: string | null,
    options?: { preservePendingJoinToken?: boolean },
  ) => {
    const targetAccountId = accountId ?? accountIdRef.current
    if (targetAccountId) {
      clearStoredActiveOrganizationId(targetAccountId)
      persistOrganizationContext(
        clearVerifiedOrganizationContext(targetAccountId),
      )
    }
    const preservedJoinToken = options?.preservePendingJoinToken
      ? pendingJoinTokenRef.current ?? getPendingOrganizationJoinToken()
      : null
    if (!options?.preservePendingJoinToken) clearPendingOrganizationJoinToken()
    joinPreviewGenerationRef.current += 1
    joinPreviewTokenRef.current = null
    pendingJoinTokenRef.current = preservedJoinToken
    accountIdRef.current = null
    accountScopeGenerationRef.current += 1
    activeOrganizationIdRef.current = null
    unavailableOrganizationRef.current = null
    organizationScopeGenerationRef.current += 1
    refreshGenerationRef.current += 1
    organizationSummariesRef.current = []
    setOrganizationSummaries([])
    setActiveOrganizationId(null)
    setOrganizationMembershipRole(null)
    setPendingJoinToken(preservedJoinToken)
    setJoinPreview(null)
    setError(null)
    setContextVersion(version => version + 1)
    setFlowState('idle')
  }, [])

  const showCreate = useCallback(() => {
    setError(null)
    setFlowState('create')
  }, [])

  const showSelect = useCallback(() => {
    setError(null)
    setFlowState(organizationSummaries.length === 0 ? 'create' : 'select')
  }, [organizationSummaries.length])

  const activeOrganization = useMemo(
    () => organizationSummaries.find(item => item.id === activeOrganizationId) ?? null,
    [activeOrganizationId, organizationSummaries],
  )
  const accountId = accountIdRef.current
  const organizationContextKey = accountId && activeOrganizationId
    ? createOrganizationContextKey(accountId, activeOrganizationId)
    : null

  return {
    accountId,
    flowState,
    organizationSummaries,
    activeOrganization,
    activeOrganizationId,
    organizationMembershipRole,
    organizationContextKey,
    contextVersion,
    pendingJoinToken,
    joinPreview,
    error,
    bootstrap,
    receiveJoinToken,
    dismissJoin,
    createOrganization,
    acceptJoin,
    selectOrganization,
    refreshOrganizations,
    clearAccount,
    showCreate,
    showSelect,
  }
}
