import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import type { PmOrganizationScopeInput } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { projectActionErrorKey } from './projects-api'

/**
 * POO-205 — the committed organization's project directory (pm:listProjects).
 *
 * A project is a lightweight entity INSIDE the organization (Spec Q1/Q3):
 * the directory is the caller's projects in the committed org space, scoped
 * {accountId, productSpaceId, organizationEnterpriseId}. The hook is render
 * side only — loading / failure / verified-empty stay distinct states, and a
 * scope change (account / space) clears everything and discards the late
 * response of the previous scope. Nothing here is persisted; `purpose` and
 * `instructions` travel with each ProjectSummary so the session-creation
 * path can attach the authoritative snapshot without a second read.
 */

export type ProjectsDirectoryState = {
  projects: ProjectSummary[]
  loading: boolean
  /** i18n key of the load failure (first load or an explicit reload). */
  errorKey: string | null
}

function emptyDirectory(): ProjectsDirectoryState {
  return { projects: [], loading: false, errorKey: null }
}

export function useProjects(scope: PmOrganizationScopeInput | null) {
  const scopeKey = scope ? `${scope.accountId}:${scope.productSpaceId}:${scope.organizationEnterpriseId}` : null

  const [state, setState] = useState<ProjectsDirectoryState>(emptyDirectory)
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    if (!scope) return
    const generation = ++generationRef.current
    setState(previous => ({ ...previous, loading: previous.projects.length === 0, errorKey: null }))
    try {
      const response = await window.electronAPI.pmListProjects({ ...scope })
      if (generation !== generationRef.current) return
      setState({ projects: response.projects, loading: false, errorKey: null })
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare `.code`
      // read would classify every failure as generic.
      setState({ projects: [], loading: false, errorKey: projectActionErrorKey(readRpcErrorCode(error)) })
    }
  }, [scope])

  // Scope change clears EVERYTHING and rejects the late responses of the
  // previous scope. 失权即清数据.
  useEffect(() => {
    generationRef.current += 1
    setState(emptyDirectory())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  return useMemo(() => ({
    scopeKey,
    ...state,
    reload: load,
  }), [load, scopeKey, state])
}

/** Case-insensitive name/purpose search over the project directory. */
export function projectMatchesQuery(project: { name: string; purpose?: string }, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return [project.name, project.purpose ?? '']
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}
