import type { Store } from 'jotai/vanilla/store'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import type { TabInstance } from '../../../shared/tab-browser-types'
import { projectTabId } from '../../../shared/tab-browser-types'
import { closeTabAtom, openTabsAtom } from '@/atoms/tab-browser'
import { i18n } from '@polo-ai/shared/i18n'
import { toast } from 'sonner'
import * as storage from '@/lib/local-storage'

/**
 * POO-205 C9 (R12): project-tab RECONCILIATION — the renderer-side closing
 * move when a project leaves the user's visible directory.
 *
 * The project list read (home directory load, enterprise new-session routing)
 * is the authority: a project tab whose project is no longer in the list is
 * closed with one toast, regardless of WHY (the project was deleted, or the
 * user is no longer a member — the two are not distinguished). Being removed
 * while the tab is ACTIVE lands Home through closeTabAtom's existing
 * active-project-tab rule; background tabs close silently in place.
 *
 * The pure resolver answers WHAT to close and how to say it; the reactor
 * performs the writes (tab close, the project-scoped last-selected cleanup,
 * the toast) so the reads stay testable without a store.
 */

/** The toast payload for one reconciliation hit. */
export interface ProjectTabRemovalToast {
  key: string
  values: { name: string }
}

/** One project the reconciliation decides to close. A projectId appears at
 * most once even if several tabs could carry it (projectTabId is
 * deterministic, but the dedup keeps the invariant local). */
export interface ProjectTabRemoval {
  projectId: string
  /** The title the CLOSING tab carried — the name the toast quotes. */
  tabTitle: string
  toast: ProjectTabRemovalToast
}

/** The toast copy for a reconciliation close. One key, project name
 * interpolated. */
export const PROJECT_TAB_REMOVAL_TOAST_KEY = 'home.projects.noLongerMember'

/** Pure: which open PROJECT tabs carry a project the visible directory no
 * longer lists. Everything else — personal Polo tab, webapp tabs, project
 * tabs still in the list — passes through untouched. An EMPTY visible list is
 * NOT an all-clear signal for reconciliation callers (a failed load never
 * reaches this function; callers gate on a successful read). */
export function reconcileProjectTabRemovals(input: {
  /** The projects the successful directory read lists. */
  visibleProjects: ReadonlyArray<{ id: string }>
  /** The full open-tab list (the atom, not the space-visible projection). */
  openTabs: ReadonlyArray<TabInstance>
}): ProjectTabRemoval[] {
  const visible = new Set(input.visibleProjects.map(project => project.id))
  const seen = new Set<string>()
  const removals: ProjectTabRemoval[] = []
  for (const tab of input.openTabs) {
    if (tab.type !== 'project' || !tab.project?.projectId) continue
    if (visible.has(tab.project.projectId)) continue
    if (seen.has(tab.project.projectId)) continue
    seen.add(tab.project.projectId)
    const tabTitle = tab.title
    removals.push({
      projectId: tab.project.projectId,
      tabTitle,
      toast: { key: PROJECT_TAB_REMOVAL_TOAST_KEY, values: { name: tabTitle } },
    })
  }
  return removals
}

/** Perform the closes for one successful directory read. Returns the
 * removals applied (callers log / test against it). Idempotent: a second run
 * over the same state finds nothing. A FAILED list load must not reach here
 * — only successful reads reconcile. */
export function reconcileOpenProjectTabs(
  store: Store,
  input: {
    visibleProjects: ReadonlyArray<{ id: string }>
    /** The workspace scope for the per-project last-selected cleanup. */
    workspaceId?: string | null
  },
): ProjectTabRemoval[] {
  const removals = reconcileProjectTabRemovals({
    visibleProjects: input.visibleProjects,
    openTabs: store.get<ReadonlyArray<TabInstance>>(openTabsAtom),
  })
  for (const removal of removals) {
    // The ACTIVE project tab closes too — closeTabAtom returns Home for it
    // (its sessions keep running; only the tab closes).
    store.set(closeTabAtom, projectTabId(removal.projectId))
    // The project's stored last selection is dead with the tab — the next
    // entry must not resume a conversation of a project the user left.
    if (input.workspaceId) {
      storage.remove(storage.KEYS.lastSelectedSessionId, `${input.workspaceId}:project:${removal.projectId}`)
    }
    toast.error(i18n.t(removal.toast.key, { name: removal.toast.values.name }))
  }
  return removals
}

/** The prj_not_found closing move (C9 adjudication 3): the server refused a
 * create/send because the caller is no longer a member of the bound project.
 * Closes THAT project's tab (when open) with the same copy and cleanup as the
 * list reconciliation. Answers whether the code was handled so callers keep
 * their own error faces for everything else. */
export function closeProjectTabForLostProject(
  store: Store,
  input: {
    projectId: string | null | undefined
    workspaceId?: string | null
  },
): boolean {
  if (!input.projectId) return false
  const tabId = projectTabId(input.projectId)
  const tabs = store.get<ReadonlyArray<TabInstance>>(openTabsAtom)
  const tab = tabs.find(candidate => candidate.id === tabId)
  if (!tab) return false
  store.set(closeTabAtom, tabId)
  if (input.workspaceId) {
    storage.remove(storage.KEYS.lastSelectedSessionId, `${input.workspaceId}:project:${input.projectId}`)
  }
  toast.error(i18n.t(PROJECT_TAB_REMOVAL_TOAST_KEY, { name: tab.title }))
  return true
}

/** The coded refusal entry (C9 adjudication 3): CREATE/SEND can fail with
 * the C7a `prj_not_found` when the caller is no longer a member of the
 * project the request was bound to. ONLY that code closes anything — every
 * other failure keeps the caller's own error face. Personal spaces never
 * receive the code. Answers whether the project loss was handled. */
export function handleCodedProjectLoss(
  store: Store,
  input: {
    error: unknown
    projectId: string | null | undefined
    workspaceId?: string | null
  },
): boolean {
  if (readRpcErrorCode(input.error) !== 'prj_not_found') return false
  return closeProjectTabForLostProject(store, {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
  })
}
