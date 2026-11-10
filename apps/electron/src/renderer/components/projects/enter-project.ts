import { useStore } from 'jotai'

type JotaiStore = ReturnType<typeof useStore>
import { useCallback } from 'react'
import { openProjectTabAtom } from '@/atoms/tab-browser'
import { recordProjectVisit } from '@/lib/project-directory'
import { activeProjectRefOf, setActiveProject, type ActiveProjectRef, type LightweightProjectInput } from './projects-bus'

export type { LightweightProjectInput }

/**
 * POO-205 — LIGHTWEIGHT project entry (Spec Q8/Q10 adjudication).
 *
 * Entering a project of the ALREADY-COMMITTED organization is a navigation,
 * never a space-switch transaction: open/activate the project tab, publish
 * the active project (NavigationProvider's project-landing invariant then
 * lands the conversation on the project's stored selection → most recent
 * real conversation → the editable empty state) and record the device-local
 * visit order. Zero-write except the visit record: entering must not create
 * sessions.
 *
 * The space-switch path (committed space ≠ the project's organization) keeps
 * using the existing useProjectEntry transaction — this module never calls
 * onRequestSwitch. In practice the renderer only lists the CURRENT committed
 * organization's projects, so the lightweight path is the only project-entry
 * path; the transaction path remains for the general space switcher.
 */

/** Most recent REAL conversation bound to THIS project (sessions carry the
 * POO-205 immutable `projectId` binding). Mirrors selectProjectSession's
 * history discipline: an empty session (never messaged) is not history. */
export function selectProjectSessionByProjectId(
  sessions: ReadonlyArray<{
    id: string
    projectId?: string | null
    productSpaceId?: string | null
    hidden?: boolean | null
    isArchived?: boolean | null
    preview?: string | null
    name?: string | null
    lastFinalMessageId?: string | null
    lastMessageAt?: number | null
    createdAt?: number | null
  }>,
  projectId: string,
): { kind: 'recent'; sessionId: string } | { kind: 'empty' } {
  const candidates = sessions.filter(session => {
    if (session.projectId !== projectId) return false
    if (session.hidden) return false
    if (session.isArchived) return false
    return (typeof session.preview === 'string' && session.preview.length > 0)
      || (typeof session.name === 'string' && session.name.length > 0)
      || (session.lastFinalMessageId ?? null) !== null
  })
  if (candidates.length === 0) return { kind: 'empty' }
  const decorated = candidates.map(session => ({
    session,
    last: session.lastMessageAt ?? 0,
    created: session.createdAt ?? 0,
  }))
  decorated.sort((left, right) => {
    if (left.last !== right.last) return right.last - left.last
    if (left.created !== right.created) return right.created - left.created
    return left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0
  })
  return { kind: 'recent', sessionId: decorated[0]!.session.id }
}

export type ProjectLanding =
  | { kind: 'session'; sessionId: string; source: 'stored' | 'recent' }
  | { kind: 'empty' }

/** POO-205 §10 (C3): the three-level PROJECT LANDING for sessions navigation
 * while a project tab is active — the pure resolver behind
 * NavigationProvider's invariant (the ONLY enforcement point). Order:
 * the project's stored last selection (still present, not hidden/archived,
 * THIS project) → the project's most recent real conversation (an empty
 * session is not history) → the project empty state. Sessions of OTHER
 * projects never land. */
export function resolveProjectLanding(
  metas: Parameters<typeof selectProjectSessionByProjectId>[0],
  projectId: string,
  storedId: string | null,
): ProjectLanding {
  if (storedId) {
    const stored = metas.find(meta =>
      meta.id === storedId
      && meta.projectId === projectId
      && !meta.hidden
      && meta.isArchived !== true
    )
    if (stored) return { kind: 'session', sessionId: storedId, source: 'stored' }
  }
  const recent = selectProjectSessionByProjectId(metas, projectId)
  if (recent.kind === 'recent') return { kind: 'session', sessionId: recent.sessionId, source: 'recent' }
  return { kind: 'empty' }
}

/** The focused session projected against the active project (NavigationProvider
 * feeds this from the meta map). `unknown` = details exist but the session's
 * meta has not landed in the map yet — a fresh creation or a project switch
 * the meta cannot vouch for. */
export type ProjectFocusedSession =
  | 'none'      // no details selected
  | 'unknown'   // details set, meta not (yet) in the map
  | 'foreign'   // meta known, belongs to ANOTHER project
  | 'mine'      // meta known, belongs to the active project

/** POO-205 C3-fix: whether the project-landing invariant must act. Pure.
 *
 * - A PROJECT TRANSITION (entering, tab A⇄B, restart restore) lands the
 *   project conversation NO MATTER which navigator the panel is showing —
 *   the only pass is a focused session that is already provably the new
 *   project's. `unknown` is NOT a pass: a just-switched project cannot be
 *   vouched for by a meta that is not in the map.
 * - WITHIN the same project the invariant stays surgical (C3 behavior): it
 *   only corrects a foreign session in the sessions navigator; sources/
 *   skills/settings pages the user opened inside the project are never
 *   yanked back, an unknown meta is left alone, and details=null over an
 *   empty project IS the correct landing.
 * - C4 (R3): an EXPLICIT empty-state request (「新建会话」 in a project tab)
 *   must NOT be yanked back to the most recent conversation. While the
 *   empty-intent flag for THIS project is set, details=null is accepted as
 *   the landing even when the project has landable sessions. The intent is
 *   project-bound: a tab switch invalidates it (and the transition branch
 *   never consults it).
 */
export function shouldLandProject(input: {
  /** activeProjectId differs from the last project this effect landed. */
  transition: boolean
  /** The focused panel currently shows the sessions navigator. */
  isSessions: boolean
  details: ProjectFocusedSession
  /** resolveProjectLanding answers a session (not the empty state). */
  hasLandingSession: boolean
  /** The user explicitly requested THIS project's empty state (C4 R3). */
  emptyIntent?: boolean
}): boolean {
  if (input.transition) {
    return input.details !== 'mine'
  }
  if (!input.isSessions) return false
  switch (input.details) {
    case 'foreign':
      return true
    case 'unknown':
    case 'mine':
      return false
    case 'none':
      return input.emptyIntent ? false : input.hasLandingSession
  }
}

/** POO-205 C4 (R4): where a "new chat" request lands in an ENTERPRISE
 * committed space. Pure — the caller performs the tab/navigation side
 * effects.
 *
 * - Inside a project tab: the project's OWN empty state (zero-write; R3).
 * - On any other tab: the most recently VISITED project that is still in the
 *   visible directory (visit order first, a project that has become
 *   invisible is skipped, not fatal) — opened as a tab and landed on its
 *   empty state.
 * - No accessible project at all: home + the「先创建或进入一个项目」hint.
 *
 * The PERSONAL space never routes through this function (its assistant tab
 * remains the default chat surface — `personal-default` exists so tests and
 * callers can branch on the full shape).
 */
export type ChatEntryTarget =
  | { kind: 'personal-default' }
  | { kind: 'project'; projectId: string }
  | { kind: 'home-hint' }

export function resolveChatEntryTarget(input: {
  spaceKind: 'personal' | 'enterprise' | null
  /** The currently active tab instance, if any. */
  activeTab: { type: string; project?: { projectId: string } } | null
  /** Project ids, most recently visited first (readProjectVisitOrder). */
  recentProjectIds: ReadonlyArray<string>
  /** The projects the directory currently lists (visible + accessible). */
  visibleProjects: ReadonlyArray<{ id: string }>
}): ChatEntryTarget {
  if (input.spaceKind !== 'enterprise') return { kind: 'personal-default' }
  if (input.activeTab?.type === 'project' && input.activeTab.project?.projectId) {
    return { kind: 'project', projectId: input.activeTab.project.projectId }
  }
  const visibleIds = new Set(input.visibleProjects.map(project => project.id))
  for (const projectId of input.recentProjectIds) {
    if (visibleIds.has(projectId)) return { kind: 'project', projectId }
  }
  return { kind: 'home-hint' }
}

/** Enter a project of the committed organization (lightweight). Returns the
 * published ActiveProjectRef (or null when the caller's scope was incomplete
 * — the click is then a no-op, never a fake navigation).
 *
 * POO-205 C3: this function NO LONGER navigates. The conversation landing
 * (stored selection → recent real conversation → empty state) belongs to
 * NavigationProvider's project-landing invariant, keyed off the active
 * project THIS function publishes — one enforcement point instead of two
 * racing navigators (tab A ⇄ tab B switching never keeps the previous
 * project's conversation). */
export async function enterProjectLightweight(accountId: string, project: LightweightProjectInput, store?: JotaiStore): Promise<ActiveProjectRef | null> {
  if (!accountOk(accountId) || !project.id || !project.organizationProductSpaceId) return null
  const ref = activeProjectRefOf(accountId, project)
  // Spec §10: entering a project OPENS ITS TAB (title = project name). The
  // App-level effect on the active tab re-publishes the active project from
  // the tab payload; this eager setActiveProject flips the NavigationProvider
  // project-landing invariant immediately (tab A → tab B lands B's session,
  // not A's) and keeps the pre-navigation zero-write first send bound.
  // The caller's jotai store (useStore) — the app runs inside a Jotai
  // Provider, so getDefaultStore would be a DIFFERENT store the UI never reads.
  const jotai = store ?? (() => { throw new Error('project entry requires the jotai store') })()
  jotai.set(openProjectTabAtom, {
    projectId: project.id,
    name: project.name,
    ...(project.purpose !== undefined ? { purpose: project.purpose } : {}),
    ...(project.instructions !== undefined ? { instructions: project.instructions } : {}),
    organizationEnterpriseId: project.organizationEnterpriseId,
    organizationProductSpaceId: project.organizationProductSpaceId,
    myRole: project.myRole,
  })
  setActiveProject(ref)
  recordProjectVisit(accountId, project.id)
  return ref
}

function accountOk(accountId: string): boolean {
  return accountId.trim().length > 0
}

/**
 * The React binding: the enter callback bound to the CALLER'S jotai store.
 * The HomePage cards share ONE instance through the module store, so the
 * capability stays live wherever this hook is mounted. (The historyFailed
 * toast retired with the entry's own history read — POO-205 C3 moved the
 * conversation landing into NavigationProvider's invariant, which owns its
 * own failure faces.)
 */
export function useProjectLightweightEntry() {
  // The caller's jotai store: the app runs inside a JotaiProvider, so the
  // project-tab write MUST ride the context store (getDefaultStore would be
  // a store the UI never reads).
  const store = useStore()
  const enter = useCallback((accountId: string, project: LightweightProjectInput): Promise<ActiveProjectRef | null> => {
    return enterProjectLightweight(accountId, project, store)
  }, [store])
  return { enterProject: enter }
}
