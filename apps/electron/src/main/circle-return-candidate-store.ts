/**
 * Circle-return candidate store (POO-70 B1, P70-RETURN-BRIDGE-02/03).
 *
 * Holds at most ONE pending navigation candidate parsed from a versioned
 * `poloai://circle-return?...` deep link, from BEFORE any UI is subscribed
 * until it is acked/cancelled/consumed or cleared by account lifecycle. The
 * candidate carries ids only — never an authorization, never a verification
 * result — so nothing from a previous epoch can be "replayed": every object /
 * permission re-verification happens through the C1 memberCircles trusted
 * bridge after delivery (P70-RETURN-BRIDGE-03).
 *
 * Account epoch semantics (A4 fencing anchors, card implementation order 4):
 * - Pre-login capture (trusted mirror `signed_out`/`unknown`): the candidate
 *   is UNBOUND and survives the login-pending phase — after the login is
 *   verified it is handed to the outer page (late read still returns the
 *   original target; C8 dedups by candidateId, Main keeps it pending until
 *   ack/cancel).
 * - Authenticated capture: the candidate is anchored to the trusted
 *   accountId + account-binding generation.
 * - Deliberate account SWITCH (session of A ends, a new session starts):
 *   the navigation candidate is RETAINED for re-verification under the new
 *   account — its anchor is detached and re-anchored to the delivering
 *   account at read time. The ids are re-checked against the new account by
 *   C1 (actor-filtered reads), so a wrong-account delivery can only ever
 *   surface "no access", never another account's objects.
 * - FULL logout (session ends, no new session starts): the candidate is
 *   cleared. The clear is observed fail-closed at the next pending read (a
 *   bound candidate is never delivered while signed out) and at every
 *   authenticated delivery the anchor must match the trusted account.
 *
 * The class itself is pure: callers pass the trusted account view in, which
 * keeps the lifecycle unit-testable without Electron.
 */

import { randomUUID } from 'crypto'
import type {
  CircleReturnAckResult,
  CircleReturnCancelResult,
  CircleReturnCandidate,
  CircleReturnPendingState,
  CircleReturnTargetIds,
} from '@polo-ai/shared/protocol'
import { CIRCLE_RETURN_PROTOCOL_VERSION } from '@polo-ai/shared/protocol'
import {
  getSyncTrustedProductSpaceAccountState,
  getTrustedAccountGeneration,
  isAccountTransitionInProgress,
} from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'

/**
 * The trusted account view at capture/delivery time. Mirrors the A4 sync
 * trusted account mirror: `unknown` (startup not settled), `signed_out`, or
 * the authenticated accountId + trusted account-binding generation.
 */
export type CircleReturnAccountView =
  | { status: 'unknown' }
  | { status: 'signed_out' }
  | { status: 'authenticated'; accountId: string; accountGeneration: number }

interface StoredCandidate {
  candidateId: string
  target: CircleReturnTargetIds
  /** ISO timestamp of when Main recorded the candidate. */
  createdAt: string
  /** null anchor = captured before any verified login (login-pending). */
  anchor: { accountId: string | null; accountGeneration: number | null }
}

function sameTarget(a: CircleReturnTargetIds, b: CircleReturnTargetIds): boolean {
  return a.circleId === b.circleId
    && a.membershipId === b.membershipId
    && a.orderId === b.orderId
}

/** Capture-time anchor: authenticated views bind the account, everything else stays unbound (login-pending). */
function anchorFromView(accountView: CircleReturnAccountView): StoredCandidate['anchor'] {
  return accountView.status === 'authenticated'
    ? { accountId: accountView.accountId, accountGeneration: accountView.accountGeneration }
    : { accountId: null, accountGeneration: null }
}

function toPublicCandidate(stored: StoredCandidate): CircleReturnCandidate {
  return {
    candidateId: stored.candidateId,
    protocolVersion: CIRCLE_RETURN_PROTOCOL_VERSION,
    target: { ...stored.target },
    createdAt: stored.createdAt,
  }
}

export class CircleReturnCandidateStore {
  private candidate: StoredCandidate | null = null
  /**
   * Set by noteAccountSessionEnding while an account session end is running.
   * A session START that follows converts the ending into a deliberate
   * account switch (retain candidate); an ending with no start is a full
   * logout (clear candidate on the next pending read).
   */
  private sessionEndingAccountId: string | null = null

  /**
   * Records a parsed circle-return target as the single pending candidate.
   * Recording an IDENTICAL target while one is pending keeps the existing
   * candidateId (store-side dedup — the renderer dedups by candidateId too,
   * so OS-level link redelivery never produces a second consumption) and
   * re-takes the account anchor from the CURRENT record-time view, so a
   * redelivery can never leave a dying account's anchor in place. A
   * different target REPLACES the pending one under a fresh candidateId.
   */
  recordCandidate(
    target: CircleReturnTargetIds,
    accountView: CircleReturnAccountView,
  ): { candidate: CircleReturnCandidate; duplicated: boolean } {
    if (this.candidate && sameTarget(this.candidate.target, target)) {
      this.candidate.anchor = anchorFromView(accountView)
      return { candidate: toPublicCandidate(this.candidate), duplicated: true }
    }

    const stored: StoredCandidate = {
      candidateId: randomUUID(),
      target: {
        ...(target.circleId !== undefined && { circleId: target.circleId }),
        ...(target.membershipId !== undefined && { membershipId: target.membershipId }),
        ...(target.orderId !== undefined && { orderId: target.orderId }),
      },
      createdAt: new Date().toISOString(),
      anchor: anchorFromView(accountView),
    }
    this.candidate = stored
    return { candidate: toPublicCandidate(stored), duplicated: false }
  }

  /**
   * Reads the pending candidate for delivery. Delivery is gated on the
   * trusted account view and NEVER consumes: the candidate stays pending
   * until ack/cancel/logout so a late subscriber (event lost, read-first vs
   * event-first race) still reads the original target.
   */
  getPending(accountView: CircleReturnAccountView): CircleReturnPendingState {
    if (accountView.status === 'unknown') {
      // Startup not settled — fail closed: deliver nothing, mutate nothing.
      return { status: 'unavailable', reason: 'session_unavailable' }
    }

    if (accountView.status === 'signed_out') {
      if (!this.candidate) return { status: 'none' }
      if (this.candidate.anchor.accountId === null) {
        // Pre-login capture: login-pending retention — keep the navigation
        // target so the pending login can deliver it to the outer page.
        return { status: 'none' }
      }
      // An account-bound candidate while signed out means the account session
      // ended without a replacement (full logout) — clear it (注销清理).
      this.candidate = null
      this.sessionEndingAccountId = null
      return { status: 'none' }
    }

    // Authenticated delivery: re-anchor (covers the retained account-switch
    // candidate and the pre-login candidate alike) and clear any stale
    // ending marker. Ids are re-verified under THIS account by C1 afterwards.
    if (this.candidate) {
      this.candidate.anchor = {
        accountId: accountView.accountId,
        accountGeneration: accountView.accountGeneration,
      }
      this.sessionEndingAccountId = null
      return { status: 'pending', candidate: toPublicCandidate(this.candidate) }
    }
    return { status: 'none' }
  }
  /** Consumption confirmation: clears the pending candidate. Idempotent. */
  ack(candidateId: string): CircleReturnAckResult {
    if (this.candidate && this.candidate.candidateId === candidateId) {
      this.candidate = null
      return { status: 'acked' }
    }
    return { status: 'not_found' }
  }

  /** Renderer-declined navigation: clears the pending candidate. Idempotent. */
  cancel(candidateId: string): CircleReturnCancelResult {
    if (this.candidate && this.candidate.candidateId === candidateId) {
      this.candidate = null
      return { status: 'cancelled' }
    }
    return { status: 'not_found' }
  }

  /**
   * Account session END (logout or account replacement — Main cannot
   * distinguish them at this hook, so it only marks the ending). The
   * candidate itself is NOT mutated here: while the transition is in flight
   * every pending read fails closed (`session_unavailable`), and after it
   * settles the trusted mirror decides — a signed-out mirror clears an
   * account-bound candidate (full logout) while a new authenticated session
   * retains it for re-verification under the new account.
   */
  noteAccountSessionEnding(accountId: string): void {
    this.sessionEndingAccountId = accountId
  }

  /**
   * A new account session started after the ending — a deliberate account
   * switch / re-login: RETAIN the navigation candidate for re-verification
   * under the new account (anchor is re-established at delivery time).
   */
  noteAccountSessionStarted(_accountId: string): void {
    this.sessionEndingAccountId = null
  }

  /** Full reset (app-level teardown, tests). */
  clear(): void {
    this.candidate = null
    this.sessionEndingAccountId = null
  }

  /** Test/diagnostic peek — never a delivery path. */
  peekForTests(): CircleReturnCandidate | null {
    return this.candidate ? toPublicCandidate(this.candidate) : null
  }
}

let singleton: CircleReturnCandidateStore | null = null

/** Main-process singleton (deep-link parser + GUI system handlers share it). */
export function getCircleReturnCandidateStore(): CircleReturnCandidateStore {
  if (!singleton) {
    singleton = new CircleReturnCandidateStore()
  }
  return singleton
}

/** Test seam — resets the process singleton. */
export function resetCircleReturnCandidateStoreForTests(): void {
  singleton = null
}

/**
 * Captures the trusted account view for candidate record/delivery decisions.
 * An in-flight account transition (logout / account replacement — R37-1)
 * fails closed as `transition`: recording yields an unbound (login-pending)
 * candidate and delivery reports `session_unavailable` — an anchor is never
 * taken from an account whose session end has already begun.
 */
export function captureCircleReturnAccountView(): CircleReturnAccountView | { status: 'transition' } {
  if (isAccountTransitionInProgress()) return { status: 'transition' }
  const state = getSyncTrustedProductSpaceAccountState()
  if (state.status === 'unknown') return { status: 'unknown' }
  if (state.status === 'signed_out') return { status: 'signed_out' }
  return {
    status: 'authenticated',
    accountId: state.accountId,
    accountGeneration: getTrustedAccountGeneration(),
  }
}
