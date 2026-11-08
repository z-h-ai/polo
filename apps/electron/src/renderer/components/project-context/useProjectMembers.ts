import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PmProjectScopeInput, ProjectMember, ProjectRole } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { projectActionErrorKey } from '../projects/projects-api'

/**
 * POO-205 project-members state hook (Spec Q10: project members ⊆ the
 * organization roster; the targeted invitation flow is RETIRED).
 *
 * Authority stays server-side: the hook renders WHAT the wire answered and
 * re-classifies the viewer from the member list itself (the list carries the
 * acting account's own row — a role change for this viewer shows up on the
 * next read without any client-side authority bookkeeping). A forbidden
 * read is a real lost-access state: the data clears instead of falling back
 * to the previous cache (失权即清数据).
 *
 * Management commands (add / role change / remove) surface their own
 * per-command error keys; the list only ever changes from a server answer
 * (the add response IS the fresh member list, so no optimistic merging).
 * Every scope change (account / space / project) resets everything. Nothing
 * here is persisted.
 */

export type ProjectMembersScope = PmProjectScopeInput & {
  /** Fallback while the member list has not spoken (the caller's last known
   * role — the space summary). The LIST's own row is the live authority. */
  viewerRoleHint?: ProjectRole | null
}

export type MemberListState = {
  items: ProjectMember[]
  loading: boolean
  mutating: boolean
  /** i18n key of the load failure (first read). */
  errorKey: string | null
}

function emptyList(): MemberListState {
  return { items: [], loading: false, mutating: false, errorKey: null }
}

/** Stable i18n key for a member-list load failure. */
export function membersErrorKey(code: string | null): string {
  switch (code) {
    case 'prj_forbidden':
    case 'forbidden':
      return 'projectMembers.error.forbidden'
    case 'prj_not_found':
    case 'not_found':
      return 'projectMembers.error.notFound'
    case 'prj_space_mismatch':
    case 'pm_scope_changed':
      return 'projectMembers.error.scopeChanged'
    case 'pm_unavailable_in_personal':
      return 'projectMembers.error.spaceRequired'
    case 'pm_signin_required':
    case 'unauthorized':
    case 'token_revoked':
    case 'account_disabled':
    case 'prj_signin_required':
      return 'projectMembers.error.signinRequired'
    case 'prj_validation_error':
    case 'validation_error':
    case 'pm_service_unavailable':
    case 'prj_service_unavailable':
    default:
      return 'projectMembers.error.generic'
  }
}

export type MemberMutationOutcome =
  | { ok: true }
  | { ok: false; errorKey: string }

export function useProjectMembers(scope: ProjectMembersScope | null) {
  const scopeKey = scope
    ? `${scope.accountId}:${scope.productSpaceId}:${scope.organizationEnterpriseId}:${scope.projectId}`
    : null

  const [state, setState] = useState<MemberListState>(emptyList)
  const generationRef = useRef(0)
  const mutateGenerationRef = useRef(0)

  // The viewer's live role comes from THIS project's member list — the list
  // is the authority (Q10: membership is the admin wire's answer, never a
  // client-side guess). A forbidden read clears the list, so the role
  // degrades to the hint and every management affordance disappears.
  const viewerRole: ProjectRole | null = useMemo(() => {
    if (!scope) return null
    const mine = state.items.find(member => member.accountId === scope.accountId)
    if (mine) return mine.role
    return state.errorKey ? null : (scope.viewerRoleHint ?? null)
  }, [scope, state.errorKey, state.items])

  const canManage = viewerRole === 'owner' || viewerRole === 'manager'
  const lostAccess = state.errorKey === 'projectMembers.error.forbidden'

  const load = useCallback(async () => {
    if (!scope) return
    const generation = ++generationRef.current
    setState(previous => ({ ...emptyList(), loading: previous.items.length === 0 }))
    try {
      const response = await window.electronAPI.pmListProjectMembers({ ...scope })
      if (generation !== generationRef.current) return
      setState({ items: response.members, loading: false, mutating: false, errorKey: null })
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic. A 403 clears
      // the data (never a stale roster behind the lost-access note).
      setState({ items: [], loading: false, mutating: false, errorKey: membersErrorKey(readRpcErrorCode(error)) })
    }
  }, [scope])

  // Scope change (account / space / project) clears EVERYTHING.
  useEffect(() => {
    generationRef.current += 1
    mutateGenerationRef.current += 1
    setState(emptyList())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  /** pm:addProjectMembers — bulk pick from the organization roster. The
   * response is the fresh member list; on success it REPLACES the state (no
   * optimistic merge, no client-side membership arithmetic). */
  const addMembers = useCallback(async (accountIds: readonly string[], role: ProjectRole): Promise<MemberMutationOutcome> => {
    if (!scope || accountIds.length === 0) return { ok: false, errorKey: 'projectMembers.error.generic' }
    const generation = mutateGenerationRef.current
    setState(previous => ({ ...previous, mutating: true }))
    try {
      const response = await window.electronAPI.pmAddProjectMembers({
        ...scope,
        command: { accountIds: [...accountIds], role },
      })
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState({ items: response.members, loading: false, mutating: false, errorKey: null })
      return { ok: true }
    } catch (error) {
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState(previous => ({ ...previous, mutating: false }))
      return { ok: false, errorKey: projectActionErrorKey(readRpcErrorCode(error)) }
    }
  }, [scope])

  /** pm:updateProjectMember — a role change answers the fresh member row. */
  const updateMemberRole = useCallback(async (targetAccountId: string, role: ProjectRole): Promise<MemberMutationOutcome> => {
    if (!scope) return { ok: false, errorKey: 'projectMembers.error.generic' }
    const generation = mutateGenerationRef.current
    setState(previous => ({ ...previous, mutating: true }))
    try {
      const response = await window.electronAPI.pmUpdateProjectMember({
        ...scope,
        targetAccountId,
        role,
      })
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState(previous => ({
        ...previous,
        items: previous.items.map(member => member.accountId === targetAccountId ? response.member : member),
        mutating: false,
      }))
      return { ok: true }
    } catch (error) {
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState(previous => ({ ...previous, mutating: false }))
      return { ok: false, errorKey: projectActionErrorKey(readRpcErrorCode(error)) }
    }
  }, [scope])

  /** pm:removeProjectMember — leaves the project; the fresh list answers. */
  const removeMember = useCallback(async (targetAccountId: string): Promise<MemberMutationOutcome> => {
    if (!scope) return { ok: false, errorKey: 'projectMembers.error.generic' }
    const generation = mutateGenerationRef.current
    setState(previous => ({ ...previous, mutating: true }))
    try {
      await window.electronAPI.pmRemoveProjectMember({ ...scope, targetAccountId })
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      // pm:removeProjectMember answers a bare {ok} — the fresh list needs an
      // explicit re-read (generation-guarded, same as a manual refresh).
      const response = await window.electronAPI.pmListProjectMembers({ ...scope })
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState({ items: response.members, loading: false, mutating: false, errorKey: null })
      return { ok: true }
    } catch (error) {
      if (generation !== mutateGenerationRef.current) return { ok: false, errorKey: 'projectMembers.error.scopeChanged' }
      setState(previous => ({ ...previous, mutating: false }))
      return { ok: false, errorKey: projectActionErrorKey(readRpcErrorCode(error)) }
    }
  }, [scope])

  return useMemo(() => ({
    scopeKey,
    members: state.items,
    loading: state.loading,
    mutating: state.mutating,
    errorKey: state.errorKey,
    viewerRole,
    canManage,
    lostAccess,
    reload: load,
    addMembers,
    updateMemberRole,
    removeMember,
  }), [addMembers, canManage, load, lostAccess, removeMember, scopeKey, state, updateMemberRole, viewerRole])
}
