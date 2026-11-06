import { useCallback, useEffect, useRef, useState } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { openAppTabAtom } from '@/atoms/tab-browser'
import { navigate, routes } from '@/lib/navigate'
import { entryScopeMatches, selectProjectSession } from '@/lib/project-entry'
import { recordProjectVisit } from '@/lib/project-directory'
import { POLO_APP_DEFINITION } from '../../shared/tab-browser-types'

/**
 * POO-196 R3 (adjudication D13/D14) — the project direct-entry flow.
 *
 * Entering a project (homepage card click, or the create-success auto-enter)
 * must land on the conversation layout with the account's most recent
 * session in that project, or on an editable empty state when there is no
 * history. The transaction hand-off is two-phased exactly like the App-level
 * space-select flow: the click records the intent, and ONLY the committed-
 * scope effect routes on completion — requestSwitch resolves either after
 * the no-execution transaction committed or right after parking the switch
 * dialog on a user phase, so "pendingSwitch cleared + committed target" is
 * the only reliable completion signal. While an entry is in flight the
 * composer send gate (projectEntryPendingAtom) refuses sends so a draft can
 * never be delivered into the previous scope.
 */

export type ProjectEntryPhase =
  | 'idle'
  | 'switching'
  | 'resuming'
  | 'ready'
  | 'enter-failed'
  | 'history-failed'

export interface ProjectEntryState {
  phase: ProjectEntryPhase
  productSpaceId: string | null
  generation: number
}

/** Send gate: true while an entry transaction is mid-flight. ChatPage reads
 * this OUTSIDE the committed-scope check so a send can never be delivered
 * into the previous project during a switch (D13.1). */
export const projectEntryPendingAtom = atom(false)

interface EntryTarget {
  accountId: string
  productSpaceId: string
  generation: number
  requestSettled: boolean
}

export function useProjectEntry() {
  const { t } = useTranslation()
  const space = useProductSpaceContext()
  // The tab activation rides the module-level jotai atom directly (the same
  // atom TabShellContext's openApp writes) so the hook works BOTH inside the
  // ready shell (homepage cards) and at the App-level create-dialog hosts,
  // which sit outside TabShellProvider.
  const activateAssistantTab = useSetAtom(openAppTabAtom)
  const setSendPending = useSetAtom(projectEntryPendingAtom)
  const [state, setState] = useState<ProjectEntryState>({ phase: 'idle', productSpaceId: null, generation: 0 })

  // Refs mirror the live context for callbacks defined before render settles
  // (the App-level productSpaceRef pattern — async state is not a reentry lock).
  const spaceRef = useRef(space)
  spaceRef.current = space
  const targetRef = useRef<EntryTarget | null>(null)

  const finishEntry = useCallback((phase: ProjectEntryPhase, generation: number) => {
    if (!targetRef.current || targetRef.current.generation !== generation) return
    targetRef.current = null
    setSendPending(false)
    setState({ phase, productSpaceId: null, generation })
  }, [setSendPending])

  const invalidateEntry = useCallback((generation: number) => {
    if (!targetRef.current || targetRef.current.generation !== generation) return
    targetRef.current = null
    setSendPending(false)
    setState({ phase: 'idle', productSpaceId: null, generation })
  }, [setSendPending])

  // D13.3-7: the committed scope is live — read the fresh session list and
  // land on the most recent conversation or the zero-write empty state.
  const resumeIntoScope = useCallback(async (target: EntryTarget) => {
    setState({ phase: 'resuming', productSpaceId: target.productSpaceId, generation: target.generation })
    let sessions: Parameters<typeof selectProjectSession>[0]['sessions'] = []
    try {
      // Authoritative fresh read of the committed scope's workspace — the
      // atom snapshot may still hold the previous space's rows (D13.3).
      sessions = await window.electronAPI.getSessions()
    } catch {
      finishEntry('history-failed', target.generation)
      toast.error(t('project.entry.historyFailed'))
      return
    }
    // Scope fence: the account/space transaction may have been superseded
    // (another entry, a logout) while the IPC read was in flight.
    const live = spaceRef.current
    if (!entryScopeMatches({
      accountId: live.accountId,
      activeProductSpaceId: live.activeProductSpaceId,
      pendingSwitchId: live.pendingSwitch?.targetId ?? null,
      target: { accountId: target.accountId, productSpaceId: target.productSpaceId },
    })) {
      invalidateEntry(target.generation)
      return
    }
    const selection = selectProjectSession({
      accountId: target.accountId,
      productSpaceId: target.productSpaceId,
      sessions,
    })
    activateAssistantTab(POLO_APP_DEFINITION)
    if (selection.kind === 'recent') {
      navigate(routes.view.allSessions(selection.sessionId))
    } else {
      // D14: the editable empty state — clearing details with skipAutoSelect
      // keeps the lastSelected effect from pulling an old session back in.
      // Never routes.action.newSession() here: entering must not create
      // sessions (zero-write entry).
      navigate(routes.view.allSessions(), { skipAutoSelect: true })
    }
    // Landing succeeded (tab active + route committed) — only now is the
    // recently-visited ordering record written.
    recordProjectVisit(target.accountId, target.productSpaceId)
    finishEntry('ready', target.generation)
  }, [activateAssistantTab, finishEntry, invalidateEntry, t])

  const enterProject = useCallback((productSpaceId: string, options?: {
    /** Spaces known to the CALLER as of right now (e.g. the just-resolved
     * refresh after a create). The context value may still hold the
     * pre-refresh list — React commits the new state after the current
     * continuation — so the create-success path passes its fresh list. */
    knownSpaces?: ReadonlyArray<{ id: string }>
  }) => {
    const live = spaceRef.current
    const accountId = live.accountId
    if (!accountId) return
    if (targetRef.current) return
    const knownSpaces = options?.knownSpaces ?? live.productSpaces
    if (!knownSpaces.some(item => item.id === productSpaceId)) return
    const generation = state.generation + 1
    const target: EntryTarget = { accountId, productSpaceId, generation, requestSettled: false }
    targetRef.current = target
    setSendPending(true)
    setState({ phase: 'switching', productSpaceId, generation })
    if (productSpaceId === live.activeProductSpaceId && !live.pendingSwitch) {
      // Already committed to this project — re-verify scope and land.
      void resumeIntoScope(target)
      return
    }
    void live.onRequestSwitch(productSpaceId).then(() => {
      if (targetRef.current?.generation !== generation) return
      targetRef.current = { ...target, requestSettled: true }
      // The committed-scope effect below routes on completion; the promise
      // may also have parked on the switch dialog (user phase).
    }).catch(() => {
      finishEntry('enter-failed', generation)
    })
  }, [finishEntry, resumeIntoScope, setSendPending, state.generation])

  // Transaction completion: pendingSwitch cleared AND the target committed
  // → resume into the scope. Settled but neither committed nor pending →
  // the switch failed or was cancelled (the dialog already presented why).
  useEffect(() => {
    const target = targetRef.current
    if (!target || !target.requestSettled) return
    if (space.accountId !== target.accountId) {
      invalidateEntry(target.generation)
      return
    }
    if (space.pendingSwitch) {
      if (space.pendingSwitch.targetId === target.productSpaceId) {
        setState(previous => ({ ...previous, phase: 'switching' }))
      }
      return
    }
    if (space.activeProductSpaceId === target.productSpaceId) {
      void resumeIntoScope(target)
      return
    }
    finishEntry('enter-failed', target.generation)
  }, [finishEntry, invalidateEntry, resumeIntoScope, space.accountId, space.activeProductSpaceId, space.pendingSwitch])

  // Explicit retry after enter-failed / history-failed — never re-creates
  // anything; the created project (create-success path) stays intact.
  const retryEntry = useCallback((productSpaceId: string | null) => {
    const targetId = productSpaceId ?? state.productSpaceId
    if (!targetId) return
    enterProject(targetId)
  }, [enterProject, state.productSpaceId])

  return {
    entryState: state,
    entryPending: state.phase === 'switching' || state.phase === 'resuming',
    enterProject,
    retryEntry,
  }
}

/** Read-side helper for send gates (ChatPage). */
export function useProjectEntryPending(): boolean {
  return useAtomValue(projectEntryPendingAtom)
}
