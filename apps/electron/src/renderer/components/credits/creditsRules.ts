/**
 * Credits flow rules (pure, POO-70 M09).
 *
 * Encodes the acceptance invariants of review.md §2 故事3:
 * - Returning from the browser performs a single query per user-initiated
 *   check; nothing polls or re-checks on its own.
 * - An arrived top-up only lifts the block — sending (or continuing a cut
 *   generation) stays a separate user action.
 * - A user-initiated stop is not a credits shortage; the two states are
 *   flagged separately and never derive one from the other.
 */

export type TopupCheckPhase =
  | 'blocked'      // pre-send block, before/without a query
  | 'checking'     // one query in flight
  | 'not-arrived'  // query finished, balance unchanged (or query failed)
  | 'arrived'      // balance topped up; block lifted

export interface TopupCheckState {
  phase: TopupCheckPhase
  /** Number of queries actually performed (one per user-initiated check). */
  checksPerformed: number
  /** Balance snapshot when the block was raised. */
  blockedBalance: number
  /** Latest known balance. */
  currentBalance: number
}

export interface TopupBlockedInput {
  balance: number
}

export interface QuerySettledInput {
  /** Balance reported by the single query. */
  balance: number
}

export function blockedTopup({ balance }: TopupBlockedInput): TopupCheckState {
  return {
    phase: 'blocked',
    checksPerformed: 0,
    blockedBalance: balance,
    currentBalance: balance,
  }
}

/**
 * Starts one query. Only valid while blocked or after a settled not-arrived
 * result — a check already in flight never starts another (single query).
 */
export function beginCheck(state: TopupCheckState): TopupCheckState {
  if (state.phase === 'checking') return state
  return { ...state, phase: 'checking' }
}

/**
 * Settles the in-flight query. A higher balance moves to 'arrived' (block
 * lifted, nothing else); otherwise the block stays with 'not-arrived'.
 */
export function settleCheck(
  state: TopupCheckState,
  { balance }: QuerySettledInput,
): TopupCheckState {
  if (state.phase !== 'checking') return state
  return {
    ...state,
    phase: balance > state.blockedBalance ? 'arrived' : 'not-arrived',
    checksPerformed: state.checksPerformed + 1,
    currentBalance: balance,
  }
}

/** True while the composer send button must stay unavailable. */
export function isSendBlocked(state: TopupCheckState): boolean {
  return state.phase !== 'arrived'
}

/**
 * Arrival never triggers a send: the resumed state exposes only
 * "continue send" as an explicit user action. Modeled as data — the reducer
 * has no action that both lifts the block and sends.
 */
export function requiresUserSendAfterArrival(state: TopupCheckState): boolean {
  return state.phase === 'arrived'
}

/** Reasons a generation stopped — kept distinct on purpose (USER-STOP). */
export type GenerationStopReason = 'user-stop' | 'credits-cut'

export function stopReasonIsCreditsShortage(reason: GenerationStopReason): boolean {
  return reason === 'credits-cut'
}
