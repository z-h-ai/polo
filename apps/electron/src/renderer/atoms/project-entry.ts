/**
 * POO-196 R3 UB2 (adjudication U3/U10/U11) — the SHARED project-entry
 * transaction state.
 *
 * Entering a project is ONE renderer-wide transaction: the homepage card, the
 * create-success auto-enter, the ChatPage composer gate, the empty-state
 * composer gate and the history-error landing face all consume THIS state
 * through the same atom instead of each owning a private copy (U3: the
 * previous per-hook `useState` meant the create dialog and the HomePage could
 * not see each other's transaction, and `finishEntry` wiped
 * `productSpaceId`, so a failed entry lost the very target its retry needed).
 *
 * The state deliberately KEEPS the target on failure (「失败保留目标供重试」):
 * `enter-failed`/`history-failed` stay addressable for「重新进入」/「重新加载」,
 * and `ready` keeps the landed scope so consumers can tell which entry just
 * completed. Only `idle` clears everything.
 *
 * The U11 send-notice markers ride beside the transaction state: ONE marker
 * per blocked draft scope with NO message content — only the scope identity
 * (account / project / session-or-empty draft key) and the entry generation
 * that refused it. They drive the post-landing「请点击发送」/「返回原对话」
 * guidance and are purged wholesale when the account changes, so content can
 * never leak across accounts.
 */

import { atom } from 'jotai'

export type ProjectEntryPhase =
  | 'idle'
  | 'switching'
  | 'resuming'
  | 'ready'
  | 'enter-failed'
  | 'history-failed'

/** Where the entry was started: the homepage card or the create-success
 * auto-enter. U10 renders the「项目已创建，暂时无法进入」extra line ONLY for
 * create-origin failures, and「只重试进入，不再 create」always holds. */
export type ProjectEntryOrigin = 'home' | 'create'

export interface ProjectEntryState {
  /** The account the transaction (or the retained failure/ready state)
   * belongs to. Account change invalidates everything. */
  accountId: string | null
  /** The entry target — kept through failure phases for retry (U3). */
  productSpaceId: string | null
  /** Monotonic transaction generation: an older async continuation can never
   * settle or unlock a newer transaction (「旧 finally/catch 不可解锁新事务」). */
  generation: number
  phase: ProjectEntryPhase
  origin: ProjectEntryOrigin | null
}

export const PROJECT_ENTRY_IDLE: ProjectEntryState = {
  accountId: null,
  productSpaceId: null,
  generation: 0,
  phase: 'idle',
  origin: null,
}

/** The single shared entry state — the ONLY writable copy in the renderer. */
export const projectEntryAtom = atom<ProjectEntryState>(PROJECT_ENTRY_IDLE)

/** Send gate: true while an entry transaction is mid-flight. ChatPage's deep
 * fallback and the composer admission gate both read this shape so a send can
 * never be delivered into the previous project during a switch (D13.1/U11). */
export const projectEntryPendingAtom = atom((get) => {
  const phase = get(projectEntryAtom).phase
  return phase === 'switching' || phase === 'resuming'
})

/** True while the transaction is heading somewhere (spinner faces). */
export function isEntryPendingState(state: ProjectEntryState): boolean {
  return state.phase === 'switching' || state.phase === 'resuming'
}

/** True for failure phases that keep their target for retry (U3/U10). */
export function isEntryFailedState(state: ProjectEntryState): boolean {
  return state.phase === 'enter-failed' || state.phase === 'history-failed'
}

/** U11: one blocked-send notice marker. NO message content — a blocked draft
 * is still the user's original draft in ITS scope; this only records WHERE it
 * lives and which entry generation refused the premature send. */
export interface ProjectEntrySendNotice {
  accountId: string
  /** The project scope the blocked draft belongs to (the session's bound
   * project, or the committed project for the empty-state composer draft). */
  productSpaceId: string
  /** The draft scope: the session id for a conversation composer, or
   * `empty:<accountId>:<productSpaceId>` for the zero-write empty state. */
  draftKey: string
  /** The entry generation that was in flight when the send was refused. */
  generation: number
}

export const EMPTY_DRAFT_KEY_PREFIX = 'empty:'

/** The empty-state composer draft key for a scope. */
export function emptyDraftKey(accountId: string, productSpaceId: string): string {
  return `${EMPTY_DRAFT_KEY_PREFIX}${accountId}:${productSpaceId}`
}

/**
 * POO-196 R3 UB4 (adjudication U5): the ONE-TIME post-create invite
 * onboarding intent. Recorded ONLY by the create-success auto-enter
 * (CreateProjectDialog.enterCreatedProject — fresh create AND the stored-key
 * recovery that lands a pending create), bound to the created result's
 * accountId+productSpaceId and that entry's generation, so a resumed历史
 * read-back or a plain card re-enter can never mint one (「读取历史回执、普通
 * 卡片重进不产生 intent」).
 *
 * Consumption is bound to the ACTUAL conversation host: only U3 ready, the
 * target committed, the live host mounted and the viewer holding the invite
 * right may consume it (and open the members panel's 添加成员 selection
 * page). Close/skip consumes by removal — a resize, re-render or page return
 * cannot re-pop. The shared entry owner destroys the intent on cancel
 * (enter-failed), account change, supersession by another entry target, or
 * leaving the target scope — a failed entry keeps its retryable result
 * without ever re-creating.
 */
export interface ProjectOnboardingIntent {
  accountId: string
  productSpaceId: string
  /** The entry generation the create-success auto-enter started under. */
  generation: number
}

/** The single shared onboarding intent — null = nothing pending. ONE intent
 * at a time: the latest create-success replaces any predecessor. */
export const projectOnboardingIntentAtom = atom<ProjectOnboardingIntent | null>(null)

/** The U11 notice-marker list. Writes come ONLY from (a) a user-triggered
 * blocked send, (b) consuming a marker by actually sending that draft, and
 * (c) the account-change purge. */
export const projectEntrySendNoticesAtom = atom<ProjectEntrySendNotice[]>([])
