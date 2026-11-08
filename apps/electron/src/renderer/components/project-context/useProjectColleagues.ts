import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrganizationColleague, PmOrganizationScopeInput } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { membersErrorKey } from './useProjectMembers'

/**
 * POO-205 organization colleague directory (Spec Q10: the ONLY source a
 * project can pick members from — project membership ⊆ organization
 * membership, enforced server-side via `prj_member_not_in_organization`).
 *
 * The desktop reads `pm:listOrganizationColleagues` for the committed
 * organization scope. The old colleague-option projection (source state,
 * per-member projectState) is retired along with the invitation flow: the
 * panel derives "already a member" client-side from the loaded project
 * member list, and "not in the organization" can no longer be picked by
 * construction. The response carries the COMPLETE colleague list for the
 * organization (the wire caps it well above any real roster), so the
 * directory is one shot — no pagination, no cursors.
 *
 * Name search is CLIENT-side over the loaded snapshot (this surface's
 * selection model is a bounded multi-pick; filtering in place keeps the
 * selection stable while the user narrows the view). Every scope change
 * clears everything and bumps the generation, so a late response of the
 * previous scope is discarded instead of being published into the wrong
 * panel. Nothing here is persisted.
 */

export type ProjectColleaguesScope = PmOrganizationScopeInput

export type ProjectColleaguesState = {
  colleagues: OrganizationColleague[]
  loading: boolean
  /** i18n key of the load failure. */
  errorKey: string | null
}

function emptyColleagues(): ProjectColleaguesState {
  return { colleagues: [], loading: false, errorKey: null }
}

export function useProjectColleagues(scope: ProjectColleaguesScope | null) {
  const scopeKey = scope
    ? `${scope.accountId}:${scope.productSpaceId}:${scope.organizationEnterpriseId}`
    : null

  const [state, setState] = useState<ProjectColleaguesState>(emptyColleagues)
  const [query, setQuery] = useState('')
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    if (!scope) return
    const generation = ++generationRef.current
    setState(previous => ({ ...emptyColleagues(), loading: previous.colleagues.length === 0 }))
    try {
      const response = await window.electronAPI.pmListOrganizationColleagues({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        organizationEnterpriseId: scope.organizationEnterpriseId,
      })
      if (generation !== generationRef.current) return
      setState({ colleagues: response.colleagues, loading: false, errorKey: null })
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic.
      setState({ colleagues: [], loading: false, errorKey: membersErrorKey(readRpcErrorCode(error)) })
    }
  }, [scope])

  // Scope change clears EVERYTHING and rejects the late responses of the
  // previous scope. 失权即清数据.
  useEffect(() => {
    generationRef.current += 1
    setQuery('')
    setState(emptyColleagues())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  /** Client-side name search over the loaded directory. */
  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim().slice(0, 128))
  }, [])

  /** The directory filtered by the active query (selection keys stay stable
   * — filtering hides rows, it never rewrites the picked set). */
  const visibleColleagues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return state.colleagues
    return state.colleagues.filter(colleague =>
      (colleague.displayName ?? '').toLocaleLowerCase().includes(normalized))
  }, [query, state.colleagues])

  /** X2-7-style retry: only meaningful while the load failed. */
  const retry = useCallback(() => {
    if (!scope) return
    if (!state.errorKey) return
    void load()
  }, [load, scope, state.errorKey])

  return useMemo(() => ({
    scopeKey,
    query,
    colleagues: visibleColleagues,
    allColleagues: state.colleagues,
    loading: state.loading,
    errorKey: state.errorKey,
    search,
    retry,
  }), [retry, scopeKey, search, state.colleagues, state.errorKey, state.loading, visibleColleagues])
}
