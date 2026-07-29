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
  createOrganizationContextKey,
  getPendingOrganizationJoinToken,
  getStoredActiveOrganizationId,
  setPendingOrganizationJoinToken,
  setStoredActiveOrganizationId,
} from '@/lib/organization-storage'

export type OrganizationFlowState =
  | 'idle'
  | 'loading'
  | 'create'
  | 'join'
  | 'select'
  | 'ready'

export interface OrganizationFlowError {
  code: string
}

function resultError(result: {
  errorCode?: string
}): OrganizationFlowError {
  return {
    code: result.errorCode || 'request_failed',
  }
}

function caughtError(caught: unknown): OrganizationFlowError {
  if (caught && typeof caught === 'object') {
    const code = 'code' in caught && typeof caught.code === 'string'
      ? caught.code
      : 'errorCode' in caught && typeof caught.errorCode === 'string'
        ? caught.errorCode
        : 'request_failed'
    return { code }
  }
  return { code: 'request_failed' }
}

export function useOrganizationContextState() {
  const [flowState, setFlowState] = useState<OrganizationFlowState>('idle')
  const [organizationSummaries, setOrganizationSummaries] = useState<OrganizationSummary[]>([])
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null)
  const [organizationMembershipRole, setOrganizationMembershipRole] = useState<OrganizationRole | null>(null)
  const [pendingJoinToken, setPendingJoinToken] = useState<string | null>(
    () => getPendingOrganizationJoinToken(),
  )
  const pendingJoinTokenRef = useRef(pendingJoinToken)
  const [joinPreview, setJoinPreview] = useState<OrganizationJoinPreview | null>(null)
  const [error, setError] = useState<OrganizationFlowError | null>(null)
  const [contextVersion, setContextVersion] = useState(0)
  const accountIdRef = useRef<string | null>(null)

  const activateOrganization = useCallback((
    accountId: string,
    summaries: OrganizationSummary[],
    organizationId: string,
  ) => {
    const organization = summaries.find(item => item.id === organizationId)
    if (!organization || organization.membership.status !== 'active') {
      throw { code: 'membership_not_active' } satisfies OrganizationFlowError
    }

    setStoredActiveOrganizationId(accountId, organizationId)
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

  const loadOrganizations = useCallback(async (): Promise<OrganizationSummary[]> => {
    const result = await window.electronAPI.organizationList()
    if (!result.success) throw resultError(result)
    setOrganizationSummaries(result.organizations)
    return result.organizations
  }, [])

  const previewJoin = useCallback(async (token: string) => {
    setJoinPreview(null)
    setError(null)
    try {
      const result = await window.electronAPI.organizationPreviewJoin(token)
      if (!result.success) {
        setError(resultError(result))
        return null
      }
      setJoinPreview({
        organization: result.organization,
        join: result.join,
      })
      return result
    } catch (caught) {
      setError(caughtError(caught))
      return null
    }
  }, [])

  const bootstrap = useCallback(async (accountId: string): Promise<OrganizationFlowState> => {
    accountIdRef.current = accountId
    setFlowState('loading')
    setError(null)

    try {
      const summaries = await loadOrganizations()
      const token = getPendingOrganizationJoinToken() ?? pendingJoinTokenRef.current
      if (token) {
        pendingJoinTokenRef.current = token
        setPendingJoinToken(token)
        await previewJoin(token)
        setFlowState('join')
        return 'join'
      }

      if (summaries.length === 0) {
        setActiveOrganizationId(null)
        setOrganizationMembershipRole(null)
        setFlowState('create')
        return 'create'
      }

      const storedId = getStoredActiveOrganizationId(accountId)
      const preferred = (
        storedId ? summaries.find(item => item.id === storedId) : undefined
      ) ?? (summaries.length === 1 ? summaries[0] : undefined)

      if (preferred) {
        activateOrganization(accountId, summaries, preferred.id)
        return 'ready'
      }

      setActiveOrganizationId(null)
      setOrganizationMembershipRole(null)
      setFlowState('select')
      return 'select'
    } catch (caught) {
      setError(caughtError(caught))
      setFlowState('loading')
      throw caught
    }
  }, [activateOrganization, loadOrganizations, previewJoin])

  const receiveJoinToken = useCallback(async (token: string) => {
    setPendingOrganizationJoinToken(token)
    pendingJoinTokenRef.current = token
    setPendingJoinToken(token)
    setFlowState('join')
    await previewJoin(token)
  }, [previewJoin])

  const dismissJoin = useCallback((): OrganizationFlowState => {
    clearPendingOrganizationJoinToken()
    pendingJoinTokenRef.current = null
    setPendingJoinToken(null)
    setJoinPreview(null)
    setError(null)

    if (organizationSummaries.length === 0) {
      setFlowState('create')
      return 'create'
    }

    const accountId = accountIdRef.current
    const storedId = accountId ? getStoredActiveOrganizationId(accountId) : null
    const preferred = (
      storedId
        ? organizationSummaries.find(item => item.id === storedId)
        : undefined
    ) ?? (organizationSummaries.length === 1 ? organizationSummaries[0] : undefined)

    if (accountId && preferred) {
      activateOrganization(accountId, organizationSummaries, preferred.id)
      return 'ready'
    }

    setFlowState('select')
    return 'select'
  }, [activateOrganization, organizationSummaries])

  const createOrganization = useCallback(async (input: CreateOrganizationInput) => {
    setError(null)
    try {
      const result = await window.electronAPI.organizationCreate(input)
      if (!result.success) throw resultError(result)
      if (
        result.membership.role !== 'owner'
        || result.membership.status !== 'active'
      ) {
        throw {
          code: 'owner_membership_unconfirmed',
        } satisfies OrganizationFlowError
      }

      const summaries = await loadOrganizations()
      const created = summaries.find(item => item.id === result.organization.id)
      if (created?.membership.role !== 'owner') {
        throw {
          code: 'owner_membership_unconfirmed',
        } satisfies OrganizationFlowError
      }
      const accountId = accountIdRef.current
      if (!accountId) {
        throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
      }
      activateOrganization(accountId, summaries, result.organization.id)
      return result
    } catch (caught) {
      const nextError = caughtError(caught)
      setError(nextError)
      throw nextError
    }
  }, [activateOrganization, loadOrganizations])

  const acceptJoin = useCallback(async () => {
    const token = pendingJoinTokenRef.current
    if (!token) {
      throw { code: 'join_token_unavailable' } satisfies OrganizationFlowError
    }
    setError(null)
    try {
      const result = await window.electronAPI.organizationAcceptJoin(token)
      if (!result.success) throw resultError(result)

      const summaries = await loadOrganizations()
      const accountId = accountIdRef.current
      if (!accountId) {
        throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
      }
      clearPendingOrganizationJoinToken()
      pendingJoinTokenRef.current = null
      setPendingJoinToken(null)
      setJoinPreview(null)
      activateOrganization(accountId, summaries, result.membership.organizationId)
      return result
    } catch (caught) {
      const nextError = caughtError(caught)
      setError(nextError)
      throw nextError
    }
  }, [activateOrganization, loadOrganizations])

  const selectOrganization = useCallback((organizationId: string) => {
    const accountId = accountIdRef.current
    if (!accountId) {
      throw { code: 'account_context_unavailable' } satisfies OrganizationFlowError
    }
    activateOrganization(accountId, organizationSummaries, organizationId)
  }, [activateOrganization, organizationSummaries])

  const refreshOrganizations = useCallback(async () => {
    const summaries = await loadOrganizations()
    const accountId = accountIdRef.current
    if (!accountId || !activeOrganizationId) return summaries
    const active = summaries.find(item => item.id === activeOrganizationId)
    if (!active) {
      clearStoredActiveOrganizationId(accountId)
      setActiveOrganizationId(null)
      setOrganizationMembershipRole(null)
      setFlowState(summaries.length === 0 ? 'create' : 'select')
      return summaries
    }
    setOrganizationMembershipRole(active.membership.role)
    return summaries
  }, [activeOrganizationId, loadOrganizations])

  const clearAccount = useCallback((accountId?: string | null) => {
    const targetAccountId = accountId ?? accountIdRef.current
    if (targetAccountId) clearStoredActiveOrganizationId(targetAccountId)
    clearPendingOrganizationJoinToken()
    pendingJoinTokenRef.current = null
    accountIdRef.current = null
    setOrganizationSummaries([])
    setActiveOrganizationId(null)
    setOrganizationMembershipRole(null)
    setPendingJoinToken(null)
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
