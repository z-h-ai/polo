import type { ProjectRole } from '@polo-ai/shared/protocol'

/**
 * POO-205 — the renderer-wide "active project" store and the project-page
 * view bus (module-level, one renderer lifecycle).
 *
 * Spec Q1-Q3/Q8: a project is a LIGHTWEIGHT entity inside one organization —
 * entering it is lightweight navigation, never a space-switch transaction.
 * This module carries the two facts every consumer needs without a context
 * prop chain:
 *
 * - `activeProject`: the project the user last ENTERED on this account. It
 *   is what "新建会话 in a project" attaches (App.handleCreateSession reads
 *   it at creation time), and what the org-space conversation empty state
 *   binds its first send to. It is scope-stamped
 *   (accountId + organizationProductSpaceId): the host effect clears it the
 *   moment the committed space or account stops matching, so a session can
 *   never be created into a project of a space the user has left. Memory
 *   only — nothing here persists, and an account switch invalidates it.
 *
 * Spec §10 (project-tab interaction): the active project is DRIVEN BY THE
 * ACTIVE TAB — activating a `project` tab publishes it, activating any other
 * tab clears it. The store stays module-level so AppShell (session list
 * filter), ChatPage (composer binding) and App (creation) read one source.
 */

/** The project-scoped fact one consumer attaches to a created session. */
export interface ActiveProjectRef {
  accountId: string
  /** The organization ProductSpace the project lives in (scope stamp). */
  organizationProductSpaceId: string
  organizationEnterpriseId: string
  projectId: string
  name: string
  purpose?: string
  instructions?: string
  myRole: ProjectRole
}

/** The structural minimum the lightweight entry needs (a full ProjectSummary
 * satisfies it; directory cards pass their projection). */
export type LightweightProjectInput = {
  id: string
  organizationEnterpriseId: string
  organizationProductSpaceId: string
  name: string
  purpose?: string
  instructions?: string
  myRole: ProjectRole
}

export function activeProjectRefOf(accountId: string, project: LightweightProjectInput): ActiveProjectRef {
  return {
    accountId,
    organizationProductSpaceId: project.organizationProductSpaceId,
    organizationEnterpriseId: project.organizationEnterpriseId,
    projectId: project.id,
    name: project.name,
    ...(project.purpose ? { purpose: project.purpose } : {}),
    ...(project.instructions ? { instructions: project.instructions } : {}),
    myRole: project.myRole,
  }
}

let activeProject: ActiveProjectRef | null = null
const activeProjectListeners = new Set<() => void>()

/** Read the active project ONLY for this exact account + committed org space.
 * A mismatch is a stale read (space switched, account switched) and answers
 * null — callers never see a foreign scope's project. */
export function getActiveProjectFor(accountId: string, organizationProductSpaceId: string): ActiveProjectRef | null {
  if (!activeProject) return null
  if (activeProject.accountId !== accountId) return null
  if (activeProject.organizationProductSpaceId !== organizationProductSpaceId) return null
  return activeProject
}

/** Subscribe to active-project changes (useSyncExternalStore host). */
export function subscribeActiveProject(listener: () => void): () => void {
  activeProjectListeners.add(listener)
  return () => { activeProjectListeners.delete(listener) }
}

/** The snapshot getter for useSyncExternalStore — same scope fencing. */
export function getActiveProjectSnapshot(accountId: string, organizationProductSpaceId: string): ActiveProjectRef | null {
  return getActiveProjectFor(accountId, organizationProductSpaceId)
}

/** The UNFENCED snapshot (AppShell session-list filter). The value was
 * scope-stamped at write time and hygiene-cleared on scope drift, so a raw
 * read is safe; per-scope reads keep using getActiveProjectFor. */
export function getActiveProjectRaw(): ActiveProjectRef | null {
  return activeProject
}

export function setActiveProject(ref: ActiveProjectRef | null): void {
  activeProject = ref
  for (const listener of activeProjectListeners) listener()
}

/** Host-effect hygiene: drop the active project the moment its scope stamp
 * stops matching the committed account + organization space. Callers pass
 * their CURRENT live scope; a mismatch (or absence) is normalized to null. */
export function clearActiveProjectIfStale(accountId: string, organizationProductSpaceId: string | null): void {
  if (!activeProject) return
  if (
    activeProject.accountId === accountId
    && organizationProductSpaceId !== null
    && activeProject.organizationProductSpaceId === organizationProductSpaceId
  ) return
  activeProject = null
  for (const listener of activeProjectListeners) listener()
}
