import { getDefaultStore, useSetAtom } from 'jotai'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { openProjectTabAtom } from '@/atoms/tab-browser'
import { navigate, routes } from '@/lib/navigate'
import { recordProjectVisit } from '@/lib/project-directory'
import { activeProjectRefOf, setActiveProject, type ActiveProjectRef, type LightweightProjectInput } from './projects-bus'

export type { LightweightProjectInput }

/**
 * POO-205 — LIGHTWEIGHT project entry (Spec Q8/Q10 adjudication).
 *
 * Entering a project of the ALREADY-COMMITTED organization is a navigation,
 * never a space-switch transaction: publish the active project, land the
 * conversation layout on the project's most recent session (or the editable
 * empty state), activate the assistant tab and record the device-local visit
 * order — then open the project home (detail view). Zero-write except the
 * visit record: entering must not create sessions.
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

/** Enter a project of the committed organization (lightweight). Returns the
 * published ActiveProjectRef (or null when the caller's scope was incomplete
 * — the click is then a no-op, never a fake navigation). */
export async function enterProjectLightweight(accountId: string, project: LightweightProjectInput): Promise<ActiveProjectRef | null> {
  if (!accountOk(accountId) || !project.id || !project.organizationProductSpaceId) return null
  const ref = activeProjectRefOf(accountId, project)
  // Spec §10: entering a project OPENS ITS TAB (title = project name). The
  // App-level effect on the active tab re-publishes the active project from
  // the tab payload; this eager setActiveProject keeps the pre-navigation
  // zero-write first send bound even before that effect settles.
  getDefaultStore().set(openProjectTabAtom, {
    projectId: project.id,
    name: project.name,
    ...(project.purpose !== undefined ? { purpose: project.purpose } : {}),
    ...(project.instructions !== undefined ? { instructions: project.instructions } : {}),
    organizationEnterpriseId: project.organizationEnterpriseId,
    organizationProductSpaceId: project.organizationProductSpaceId,
    myRole: project.myRole,
  })
  setActiveProject(ref)
  // The conversation layout rides the committed org workspace: land on the
  // project's most recent session, or the zero-write empty state (the first
  // send there creates the session WITH the active project attached).
  try {
    const sessions = await window.electronAPI.getSessions()
    const selection = selectProjectSessionByProjectId(sessions, project.id)
    if (selection.kind === 'recent') {
      navigate(routes.view.allSessions(selection.sessionId))
    } else {
      navigate(routes.view.allSessions(), { skipAutoSelect: true })
    }
  } catch {
    // The history read failing must not block the entry: the project home
    // still opens, the session list keeps whatever it already shows.
    navigate(routes.view.allSessions(), { skipAutoSelect: true })
  }
  recordProjectVisit(accountId, project.id)
  return ref
}

function accountOk(accountId: string): boolean {
  return accountId.trim().length > 0
}

/**
 * The React binding: feeds the tab-activation capability + the toast/translate
 * channel the lightweight entry needs, and exposes the enter callback. The
 * HomePage cards share ONE
 * instance through the module store, so the capability stays live wherever
 * this hook is mounted.
 */
export function useProjectLightweightEntry() {
  const { t } = useTranslation()
  // The tab-open now lives inside enterProjectLightweight (default store) so
  // the plain-function callers (HomePage cards) get the same behavior as the
  // dialog. This hook keeps the toast/error channel only.
  const enter = useCallback((accountId: string, project: LightweightProjectInput): Promise<ActiveProjectRef | null> => {
    const result = enterProjectLightweight(accountId, project)
    void result.catch(() => {
      toast.error(t('project.entry.historyFailed'))
    })
    return result
  }, [t])
  return { enterProject: enter }
}
