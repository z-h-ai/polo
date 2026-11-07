import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { openAppTabAtom } from '@/atoms/tab-browser'
import { projectEntryAtom, projectEntryPendingAtom, PROJECT_ENTRY_IDLE, projectEntrySendNoticesAtom, projectOnboardingIntentAtom, isEntryPendingState, type ProjectEntryOrigin, type ProjectEntryPhase, type ProjectEntryState, type ProjectOnboardingIntent } from '@/atoms/project-entry'
import { navigate, routes } from '@/lib/navigate'
import { entryScopeMatches, selectProjectSession } from '@/lib/project-entry'
import { recordProjectVisit } from '@/lib/project-directory'
import { POLO_APP_DEFINITION } from '../../shared/tab-browser-types'

/**
 * POO-196 R3 (adjudication D13/D14; UB2 U3/U10/U11) — the project direct-entry
 * flow, driven by the MODULE-LEVEL shared transaction owner.
 *
 * Entering a project (homepage card click, or the create-success auto-enter)
 * must land on the conversation layout with the account's most recent session
 * in that project, or on an editable empty state when there is no history.
 * The transaction hand-off is two-phased exactly like the App-level
 * space-select flow: the click records the intent, and ONLY the committed-
 * scope effect routes on completion — requestSwitch resolves either after
 * the no-execution transaction committed or right after parking the switch
 * dialog on a user phase, so "pendingSwitch cleared + committed target" is
 * the only reliable completion signal.
 *
 * U3: the transaction state is ONE module-level owner (`atoms/project-entry`),
 * subscribed by the HomePage cards, the create dialog, MainContentPanel's
 * history-error face and both composer gates — no consumer replays its own
 * getSessions. The owner survives any single hook instance unmounting: every
 * mounted instance feeds the LIVE space snapshot in and the module settles
 * the transaction from it (the mounted dialog/App-level instances are the
 * stable host). A failure phase keeps its target for「重新进入」/「重新加载」
 * (the old `finishEntry` cleared `productSpaceId`, which erased the retry
 * target), an account change invalidates everything, and a stale async
 * continuation can never settle or unlock a newer generation's transaction.
 * The original two-phased switch order and pendingSwitch semantics are
 * unchanged; an explicit cancel surfaces as `enter-failed` (the switch dialog
 * already presented why), never disguised as a network fault.
 */

export type { ProjectEntryPhase, ProjectEntryOrigin, ProjectEntryState, ProjectOnboardingIntent }
export { projectEntryAtom, projectEntryPendingAtom, projectOnboardingIntentAtom }

interface ActiveTarget {
  accountId: string
  productSpaceId: string
  generation: number
  origin: ProjectEntryOrigin
  requestSettled: boolean
  /** Set when resumeIntoScope has been entered for this generation — a later
   * settle (another snapshot tick while the IPC read is in flight) must not
   * start a second fresh read. */
  resuming?: boolean
}

/** The LIVE space snapshot every mounted instance feeds in (the App-level
 * productSpaceRef pattern — async state is not a reentry lock). */
interface SpaceSnapshot {
  accountId: string | null
  activeProductSpaceId: string | null
  pendingSwitchId: string | null
  productSpaces: ReadonlyArray<{ id: string }>
  onRequestSwitch: (
    productSpaceId: string,
    options?: { knownSpaces?: ReadonlyArray<{ id: string }> },
  ) => Promise<unknown>
}

/* ── The module-level transaction owner (single renderer lifecycle) ──────── */

let activeTarget: ActiveTarget | null = null
let publishedState: ProjectEntryState = PROJECT_ENTRY_IDLE
let generationSeq = 0
let spaceSnapshot: SpaceSnapshot | null = null
/** R-AT: the ready-landing generation whose assistant-tab activation has
 * already been replayed into the (post-remount) shell — see the self-heal
 * effect in useProjectEntry. */
let readyTabReplayGeneration: number | null = null

/** Publication channel + live capabilities, captured from whichever instance
 * is mounted (the create dialog hosts one permanently at App level). */
const channel = {
  publish: null as null | ((state: ProjectEntryState) => void),
  activateTab: null as null | ((app: typeof POLO_APP_DEFINITION) => void),
  translate: null as null | ((key: string) => string),
  purgeNotices: null as null | ((accountId: string) => void),
  /** UB4 (U5): the onboarding-intent write channel — record/replace/clear
   * all ride this one setter so the owner module never needs its own store. */
  setOnboardingIntent: null as null | ((update: (previous: ProjectOnboardingIntent | null) => ProjectOnboardingIntent | null) => void),
  /** UB4 (U5): read the live intent (the superseded-target destroy rule). */
  readOnboardingIntent: null as null | (() => ProjectOnboardingIntent | null),
}

/** UB4 (U5): the one-time post-create invite intent. Record on a create-origin
 * entry start (fresh create AND the stored-key recovery — both run through
 * CreateProjectDialog.enterCreatedProject), bound to the result's scope and
 * that entry's generation; destroy on cancel (enter-failed), account change,
 * supersession by another entry target, or leaving the target scope. A plain
 * card re-enter NEVER records one; a failed entry keeps its retryable result
 * while the intent waits (or dies, per the rules above) — never a re-create. */
function recordOnboardingIntent(target: { accountId: string; productSpaceId: string; generation: number }) {
  channel.setOnboardingIntent?.(() => ({
    accountId: target.accountId,
    productSpaceId: target.productSpaceId,
    generation: target.generation,
  }))
}

/** UB4 (U5): drop the intent if it exists and belongs to `target` (exact
 * scope match — a different target's intent is left for its own destroy
 * rule, never silently borrowed). */
function destroyOnboardingIntent(target?: { accountId: string; productSpaceId: string }) {
  channel.setOnboardingIntent?.(previous => {
    if (!previous) return null
    if (target && (previous.accountId !== target.accountId || previous.productSpaceId !== target.productSpaceId)) return previous
    return null
  })
}

function publish(next: ProjectEntryState) {
  publishedState = next
  channel.publish?.(next)
}

/** Terminal settle of the CURRENT transaction — generation-guarded, so a
 * stale catch/finally from an older generation can never clear a newer one. */
function finishEntry(phase: ProjectEntryPhase, target: ActiveTarget) {
  if (!activeTarget || activeTarget.generation !== target.generation) return
  activeTarget = null
  // U3: the target stays in the published state on failure AND on ready —
  // the retry faces and the U10 landing face read it from here.
  publish({
    accountId: target.accountId,
    productSpaceId: target.productSpaceId,
    generation: target.generation,
    phase,
    origin: target.origin,
  })
  // UB4 (U5): an explicit cancel / entry failure destroys the one-time
  // invite intent (「取消…销毁 intent」). The created project itself stays
  // intact and retryable — only the auto-invite offer dies with the entry.
  if (phase === 'enter-failed') {
    destroyOnboardingIntent({ accountId: target.accountId, productSpaceId: target.productSpaceId })
  }
}

function invalidateEntry(generation: number) {
  if (!activeTarget || activeTarget.generation !== generation) return
  const superseded = activeTarget
  activeTarget = null
  // UB4 (U5): the transaction was superseded mid-flight (logout/another
  // entry) — the intent bound to THIS generation dies with it.
  destroyOnboardingIntent({ accountId: superseded.accountId, productSpaceId: superseded.productSpaceId })
  publish(PROJECT_ENTRY_IDLE)
}

/** D13.3-7: the committed scope is live — read the fresh session list and
 * land on the most recent conversation or the zero-write empty state. */
async function resumeIntoScope(target: ActiveTarget) {
  publish({
    accountId: target.accountId,
    productSpaceId: target.productSpaceId,
    generation: target.generation,
    phase: 'resuming',
    origin: target.origin,
  })
  let sessions: Parameters<typeof selectProjectSession>[0]['sessions'] = []
  try {
    // Authoritative fresh read of the committed scope's workspace — the
    // atom snapshot may still hold the previous space's rows (D13.3).
    sessions = await window.electronAPI.getSessions()
  } catch {
    // U10: the failure KEEPS the target — the persistent history-error face
    // and「重新加载」read it. The toast stays as immediate feedback, never as
    // the only surface.
    finishEntry('history-failed', target)
    const message = channel.translate?.('project.entry.historyFailed')
    if (message) toast.error(message)
    return
  }
  // Scope fence: the account/space transaction may have been superseded
  // (another entry, a logout) while the IPC read was in flight.
  const live = spaceSnapshot
  if (!live || !entryScopeMatches({
    accountId: live.accountId,
    activeProductSpaceId: live.activeProductSpaceId,
    pendingSwitchId: live.pendingSwitchId,
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
  channel.activateTab?.(POLO_APP_DEFINITION)
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
    finishEntry('ready', target)
}

/** Settle the in-flight transaction against the LIVE space snapshot. Runs on
 * every snapshot change from every mounted instance — idempotent under the
 * generation guard. */
function settleFromSpace() {
  const target = activeTarget
  if (!target || !target.requestSettled || target.resuming) return
  const live = spaceSnapshot
  if (!live) return
  if (live.accountId !== target.accountId) {
    invalidateEntry(target.generation)
    return
  }
  if (live.pendingSwitchId) {
    if (live.pendingSwitchId === target.productSpaceId) {
      // The switch dialog holds the transaction on a user phase.
      publish({ ...publishedState, phase: 'switching' })
    }
    return
  }
  if (live.activeProductSpaceId === target.productSpaceId) {
    activeTarget = { ...target, resuming: true }
    void resumeIntoScope(target)
    return
  }
  finishEntry('enter-failed', target)
}

/** Feed the live space snapshot in; drop retained states that lost their
 * scope. Called on every relevant space change from mounted instances. */
function syncFromSpace(snapshot: SpaceSnapshot) {
  const previous = spaceSnapshot
  spaceSnapshot = snapshot
  // Account change: the in-flight transaction and every retained state die —
  // a new account's renderer must never see the previous account's entry
  // state, and the U11 notice markers purge wholesale (they would otherwise
  // leak the previous account's draft scopes).
  if (previous && snapshot.accountId && previous.accountId && snapshot.accountId !== previous.accountId) {
    if (activeTarget && activeTarget.accountId !== snapshot.accountId) activeTarget = null
    publish(PROJECT_ENTRY_IDLE)
    // UB4 (U5): 切账号销毁 intent — the invite offer never crosses accounts.
    channel.setOnboardingIntent?.(() => null)
    channel.purgeNotices?.(snapshot.accountId)
    return
  }
  // U10: a retained history-failure (and the ready landing) is owned by the
  // committed-scope match — the moment the scope moves off the target (a
  // later switch, a revocation) the retained state is discarded, so the old
  // error can never resurface for a scope the user left.
  const state = publishedState
  if ((state.phase === 'history-failed' || state.phase === 'ready') && state.accountId && state.productSpaceId) {
    if (snapshot.accountId !== state.accountId || snapshot.activeProductSpaceId !== state.productSpaceId) {
      publish(PROJECT_ENTRY_IDLE)
      // UB4 (U5): 离开目标销毁 intent — walking off the target scope ends
      // the one-time offer (「关闭再进」不再弹出), even though the retained
      // failure/ready face itself is what announced the drop.
      destroyOnboardingIntent({ accountId: state.accountId, productSpaceId: state.productSpaceId })
    }
  }
  // UB4 (U5): an intent whose target no longer exists in the LIVE space
  // snapshot (revocation between landing and consumption) dies too.
  const pendingIntent = channel.readOnboardingIntent?.() ?? null
  if (pendingIntent) {
    const targetKnown = snapshot.accountId === pendingIntent.accountId
      && (snapshot.activeProductSpaceId === pendingIntent.productSpaceId
        || snapshot.productSpaces.some(space => space.id === pendingIntent.productSpaceId))
    if (!targetKnown) channel.setOnboardingIntent?.(() => null)
  }
  settleFromSpace()
}

function enterProjectImpl(
  productSpaceId: string,
  options?: {
    /** Spaces known to the CALLER as of right now (e.g. the just-resolved
     * refresh after a create). The context value may still hold the
     * pre-refresh list — React commits the new state after the current
     * continuation — so the create-success path passes its fresh list. */
    knownSpaces?: ReadonlyArray<{ id: string }>
    /** U3/U10: where the entry was started (create-origin failures render
     * the「项目已创建，暂时无法进入」extra line). */
    origin?: ProjectEntryOrigin
  },
) {
  const live = spaceSnapshot
  if (!live?.accountId) return
  // 重复激活不重入: any in-flight transaction owns the entry — mouse, keyboard
  // or dialog retries while switching/resuming are absorbed here.
  if (activeTarget) return
  const knownSpaces = options?.knownSpaces ?? live.productSpaces
  if (!knownSpaces.some(item => item.id === productSpaceId)) return
  const generation = ++generationSeq
  const target: ActiveTarget = {
    accountId: live.accountId,
    productSpaceId,
    generation,
    origin: options?.origin ?? 'home',
    requestSettled: false,
  }
  // UB4 (U5) intent lifecycle at transaction start:
  // - origin 'create' (CreateProjectDialog.enterCreatedProject — fresh create
  //   AND the stored-key recovery) RECORDS the one-time invite intent, bound
  //   to the created result + this entry's generation (a retry that finally
  //   lands refreshes it);
  // - ANY other entry start (历史回执读取、普通卡片重进) never records, and an
  //   intent pointing at a DIFFERENT target is superseded (destroyed) so a
  //   stale offer can never pop on a project the user moved on from.
  const pendingIntent = channel.readOnboardingIntent?.() ?? null
  if (target.origin === 'create') {
    recordOnboardingIntent({ accountId: target.accountId, productSpaceId: target.productSpaceId, generation })
  } else if (pendingIntent && (pendingIntent.accountId !== target.accountId || pendingIntent.productSpaceId !== target.productSpaceId)) {
    destroyOnboardingIntent({ accountId: pendingIntent.accountId, productSpaceId: pendingIntent.productSpaceId })
  }
  activeTarget = target
  publish({
    accountId: target.accountId,
    productSpaceId,
    generation,
    phase: 'switching',
    origin: target.origin,
  })
  if (productSpaceId === live.activeProductSpaceId && !live.pendingSwitchId) {
    // Already committed to this project — re-verify scope and land.
    void resumeIntoScope(target)
    return
  }
  // R-AT: forward the caller's fresh knownSpaces into requestSwitch — the
  // create-success auto-enter calls this one React commit BEFORE the context
  // publishes the refreshed catalog, and the context's own stale-list guard
  // used to silently swallow the switch (entry parked in 'switching' with
  // zero feedback while the project existed server-side).
  void live.onRequestSwitch(productSpaceId, { knownSpaces }).then(() => {
    if (activeTarget?.generation !== generation) return
    activeTarget = { ...target, requestSettled: true }
    // The committed-scope sync settles on completion; the promise may also
    // have parked on the switch dialog (user phase).
  }).catch(() => {
    finishEntry('enter-failed', target)
  })
}

/* ── The hook (thin coordinator over the shared owner) ───────────────────── */

export function useProjectEntry() {
  const { t } = useTranslation()
  const space = useProductSpaceContext()
  // The tab activation rides the module-level jotai atom directly (the same
  // atom TabShellContext's openApp writes) so the hook works BOTH inside the
  // ready shell (homepage cards) and at the App-level create-dialog hosts,
  // which sit outside TabShellProvider.
  const activateAssistantTab = useSetAtom(openAppTabAtom)
  const setEntryState = useSetAtom(projectEntryAtom)
  const setSendNotices = useSetAtom(projectEntrySendNoticesAtom)
  const setOnboardingIntent = useSetAtom(projectOnboardingIntentAtom)
  const getOnboardingIntent = useAtomValue(projectOnboardingIntentAtom)
  const store = useStore()
  const entryState = useAtomValue(projectEntryAtom)

  // U3: every mounted instance is part of the stable host — it publishes the
  // shared atom, feeds the live snapshot in, and lends the module the tab
  // activation / translation / notice-purge capabilities. Assignments during
  // render keep the channel fresh (the same pattern as the host's bridge).
  channel.publish = setEntryState
  channel.activateTab = activateAssistantTab
  channel.translate = t
  channel.purgeNotices = (accountId: string) => {
    store.set(projectEntrySendNoticesAtom, notices =>
      notices.filter(notice => notice.accountId === accountId))
  }
  // UB4 (U5): the intent read/write channel — same lifecycle-owner pattern.
  channel.setOnboardingIntent = update => {
    setOnboardingIntent(previous => update(previous))
  }
  channel.readOnboardingIntent = () => getOnboardingIntent

  // R-AT: a committed space switch (the create-success auto-enter) changes
  // `productSpaceContextKey`, which REMOUNTS TabShellProvider; its hydrate()
  // resets the visible tab to Home AFTER the landing's activateTab, so the
  // user is left on Home although the entry landed (route + scope + intent
  // all committed). A freshly mounted instance self-heals: if the shared
  // entry state is a ready landing for THIS committed scope and this
  // generation's tab replay has not been handed to the new tree yet, re
  // activate the assistant tab exactly once. The module-level guard keeps
  // later remounts from yanking the user back after they moved on.
  useEffect(() => {
    const state = entryState
    if (state.phase !== 'ready' || !state.accountId || !state.productSpaceId) return
    if (readyTabReplayGeneration === state.generation) return
    if (state.accountId !== space.accountId || state.productSpaceId !== space.activeProductSpaceId) return
    readyTabReplayGeneration = state.generation
    activateAssistantTab(POLO_APP_DEFINITION)
  }, [entryState, space.accountId, space.activeProductSpaceId, activateAssistantTab])

  const snapshot = useMemo<SpaceSnapshot>(() => ({
    accountId: space.accountId,
    activeProductSpaceId: space.activeProductSpaceId,
    pendingSwitchId: space.pendingSwitch?.targetId ?? null,
    productSpaces: space.productSpaces,
    onRequestSwitch: space.onRequestSwitch,
  }), [space.accountId, space.activeProductSpaceId, space.pendingSwitch, space.productSpaces, space.onRequestSwitch])

  useEffect(() => {
    syncFromSpace(snapshot)
  }, [snapshot])

  const enterProject = useCallback((
    productSpaceId: string,
    options?: Parameters<typeof enterProjectImpl>[1],
  ) => {
    enterProjectImpl(productSpaceId, options)
  }, [])

  // Explicit retry after enter-failed / history-failed — never re-creates
  // anything; the created project (create-success path) stays intact.
  const retryEntry = useCallback((productSpaceId: string | null) => {
    const targetId = productSpaceId ?? publishedState.productSpaceId
    if (!targetId) return
    enterProjectImpl(targetId)
  }, [])

  return {
    entryState,
    entryPending: isEntryPendingState(entryState),
    enterProject,
    retryEntry,
  }
}

/** Read-side helper for send gates (ChatPage deep fallback). */
export function useProjectEntryPending(): boolean {
  return useAtomValue(projectEntryPendingAtom)
}
