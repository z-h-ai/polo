/**
 * POO-177 QUOTA-01/02 — pure decisions for the manual billing refresh.
 *
 * The canonical Admin self-availability snapshot (POL-288 wire DTO) is the
 * ONLY receipt allowed to rewrite a managed billing latch, and only within
 * the latch revision it was captured against. The mapping here is
 * deliberately narrow:
 *
 * - a blocked snapshot re-latches the ORIGINAL banner classification for its
 *   exact reason (insufficient credit keeps the role copy + legit recharge
 *   action; budget/payment/payer get their own honest classes);
 * - an available snapshot may clear ONLY a managed temporary billing latch —
 *   never a true HTTP-429 period quota, an account-disabled, a config state
 *   or anything the canonical provider-metered read cannot speak for;
 * - anything unconfirmed (unknown states, unknown reasons) keeps the old
 *   latch and surfaces as a light failure feedback — never a fake success.
 *
 * Auth policy (401 vs 403), busy state and toast surfacing do NOT live here:
 * the RPC envelope already carries the scoped-read semantics, and App owns
 * the wiring.
 */
import type { SelfBillingAvailabilityResponse } from '@polo-ai/shared/admin/schemas'
import type { ChatAccessIssue } from '../context/AppShellContext'

/** The managed temporary billing latches a canonical Admin read owns. */
export type ManagedBillingIssue =
  | 'insufficient-credit'
  | 'billing-budget-exhausted'
  | 'billing-payment-pending'
  | 'billing-payer-restricted'

const MANAGED_BILLING_ISSUES: readonly ManagedBillingIssue[] = [
  'insufficient-credit',
  'billing-budget-exhausted',
  'billing-payment-pending',
  'billing-payer-restricted',
]

export function isManagedBillingIssue(issue: ChatAccessIssue): issue is ManagedBillingIssue {
  return (MANAGED_BILLING_ISSUES as readonly string[]).includes(issue)
}

/** Admin blocked reason → the original banner classification. An unknown
 * reason maps to null — the UI never invents a billing class. */
export function chatAccessIssueForBlockedReason(reason: string): ManagedBillingIssue | null {
  switch (reason) {
    case 'insufficient_credit':
      return 'insufficient-credit'
    case 'budget_exhausted':
      return 'billing-budget-exhausted'
    case 'payment_result_pending':
      return 'billing-payment-pending'
    case 'payer_restricted':
      return 'billing-payer-restricted'
    default:
      return null
  }
}

export type BillingRefreshOutcome =
  /** Canonical available — the captured managed latch may clear. */
  | { kind: 'clears-latch' }
  /** Canonical blocked — the latch is re-written with the mapped issue. */
  | { kind: 'reblocks'; issue: ManagedBillingIssue }
  /** Unknown state — keep the old latch, one light "not confirmed" feedback. */
  | { kind: 'unconfirmed' }

export function resolveBillingRefreshOutcome(
  snapshot: SelfBillingAvailabilityResponse,
): BillingRefreshOutcome {
  if (snapshot.availability.state === 'available') {
    return { kind: 'clears-latch' }
  }
  if (snapshot.availability.state === 'blocked') {
    const issue = chatAccessIssueForBlockedReason(snapshot.availability.reason)
    // The wire contract pins the blocked-reason enum, so this is unreachable
    // for a schema-validated snapshot — but an unknown reason must degrade
    // to "unconfirmed", never to a guessed class or a cleared latch.
    return issue ? { kind: 'reblocks', issue } : { kind: 'unconfirmed' }
  }
  return { kind: 'unconfirmed' }
}

/** A refresh receipt applies only when the latch was not rewritten between
 * capture and settle: a NEW admission rejection during the in-flight GET
 * owns the latch, even if it carries the same issue class. */
export function refreshResultApplies(capturedRevision: number, currentRevision: number): boolean {
  return capturedRevision === currentRevision
}

/**
 * Where a billing latch came from. Only a send that provably rode the
 * admin-managed connection of the trusted product space may later be cleared
 * by the Admin refresh — a BYOK/custom 402, or a send whose source cannot be
 * proven, is 'unknown' and stays out of the refresh's reach.
 */
export interface BillingLatchSourceLease {
  source: 'admin-managed' | 'unknown'
  sessionId?: string
  connectionSlug?: string
  productSpaceId?: string | null
  accountId?: string | null
}
