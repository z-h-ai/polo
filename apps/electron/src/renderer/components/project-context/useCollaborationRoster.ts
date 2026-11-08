import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PmProjectScopeInput, ProjectMember } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { membersErrorKey } from './useProjectMembers'

/**
 * POO-205 collaboration-roster state hook (rewritten from the POO-196 R3
 * roster: the safe all-roles projection of ONE project's members, read from
 * the same `pm:listProjectMembers` wire as the management surface).
 *
 * The projection carries NO contact and NO governance fields. The member
 * count is the SERVER's full array length — `pm:listProjectMembers` answers
 * the complete list (no pagination), so the client counts exactly what the
 * server sent and never a fabricated 0; the viewer's role is derived from
 * the list's own row for the acting account. A forbidden read is a real
 * authority loss: data clears, count and role fall back to unknown — never
 * a stale roster behind the error (失权即清数据).
 *
 * Name search is CLIENT-side over the loaded snapshot (the wire takes no `q`
 * on this channel). Every scope change (account / space / project) clears
 * everything and bumps the generation, so a late response of the previous
 * scope is discarded instead of being published into the wrong panel.
 * Nothing here is persisted; the count a header shows dies with the scope.
 */

export type CollaborationRosterScope = PmProjectScopeInput

export interface CollaborationRosterMember {
  accountId: string
  displayName: string | null
  role: 'owner' | 'manager' | 'member'
  isSelf: boolean
}

export type CollaborationRosterState = {
  members: CollaborationRosterMember[]
  /** The server snapshot's member count; `null` means unknown — the UI
   * keeps a "members" affordance instead of showing a fabricated 0. */
  totalActiveMembers: number | null
  viewerRole: CollaborationRosterMember['role'] | null
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  /** i18n key of the load failure. */
  errorKey: string | null
}

function toRosterMembers(items: readonly ProjectMember[], accountId: string): CollaborationRosterMember[] {
  return items.map(member => ({
    accountId: member.accountId,
    displayName: member.displayName,
    role: member.role,
    isSelf: member.accountId === accountId,
  }))
}

function emptyRoster(): CollaborationRosterState {
  return {
    members: [],
    totalActiveMembers: null,
    viewerRole: null,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    errorKey: null,
  }
}

export function useCollaborationRoster(scope: CollaborationRosterScope | null) {
  const scopeKey = scope
    ? `${scope.accountId}:${scope.productSpaceId}:${scope.organizationEnterpriseId}:${scope.projectId}`
    : null

  const [state, setState] = useState<CollaborationRosterState>(emptyRoster)
  const [query, setQuery] = useState('')
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    if (!scope) return
    const generation = ++generationRef.current
    setState(previous => ({ ...emptyRoster(), loading: previous.members.length === 0 }))
    try {
      const response = await window.electronAPI.pmListProjectMembers({ ...scope })
      if (generation !== generationRef.current) return
      const members = toRosterMembers(response.members, scope.accountId)
      const mine = members.find(member => member.isSelf)
      setState({
        members,
        totalActiveMembers: members.length,
        viewerRole: mine?.role ?? null,
        nextCursor: null,
        loading: false,
        loadingMore: false,
        errorKey: null,
      })
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic. A 403 clears
      // the pages so the header count falls back to unknown — never a stale
      // roster behind the error.
      const code = readRpcErrorCode(error)
      setState({
        ...emptyRoster(),
        errorKey: membersErrorKey(code),
      })
    }
  }, [scope])

  // Scope change (account / space / project) clears EVERYTHING and rejects
  // the late responses of the previous scope.
  useEffect(() => {
    generationRef.current += 1
    setQuery('')
    setState(emptyRoster())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  /** Client-side name search over the loaded snapshot: a new query filters
   * in place (no re-read — the wire channel has no `q`). */
  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim().slice(0, 128))
  }, [])

  /** The full snapshot's filtered view (query applied). Kept separate from
   * `members` so count surfaces can keep reading the UNFILTERED total. */
  const visibleMembers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return state.members
    return state.members.filter(member =>
      (member.displayName ?? '').toLocaleLowerCase().includes(normalized))
  }, [query, state.members])

  const retry = useCallback(() => {
    if (!scope) return
    if (!state.errorKey) return
    void load()
  }, [load, scope, state.errorKey])

  return useMemo(() => ({
    scopeKey,
    query,
    members: visibleMembers,
    allMembers: state.members,
    totalActiveMembers: state.totalActiveMembers,
    viewerRole: state.viewerRole,
    enterpriseName: null,
    nextCursor: null,
    loading: state.loading,
    loadingMore: false,
    errorKey: state.errorKey,
    search,
    loadMore: () => {},
    retry,
  }), [retry, scopeKey, search, state.errorKey, state.loading, state.members, state.totalActiveMembers, state.viewerRole, visibleMembers])
}
