/**
 * Circle-return target helpers (POO-70 C8 / P70-RETURN-01/02).
 *
 * Pure, unit-testable projections over the B1 candidate target ids
 * (`CircleReturnTargetIds`) and the C2 authoritative receipts. Ground rules
 * encoded here:
 *
 * - Ids only ADDRESS an object (B1 contract): every value this module
 *   accepts must pass the shared strict UUID validator; anything else is
 *   dropped fail-closed instead of being passed downstream as a target.
 * - A candidate is never an authorization and never a verification result:
 *   the verdict derivations below judge ONLY from C2/F1 authoritative reads
 *   (original-order GET + authoritative checkout read + the refreshed
 *   correction-aware membership projection). A raw stored `paid` status alone
 *   never grants anything (G5) and an absent projection stays `unknown`.
 * - The recent-orders list on a membership row (provider take:5) is display
 *   history; the ORIGINAL order object is only ever the one fetched by
 *   `getOrder(orderId)` — this module never substitutes the former for the
 *   latter (P70-RETURN-02).
 */
import type {
  MemberCircleCheckoutResult,
  MemberCircleCheckoutState,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'
import { isValidPoloUuid } from '@polo-ai/shared/protocol'
import type { CircleReturnCandidate, CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import type { ClientPageRoute } from '@/context/ClientPageContext'
import {
  selectLatestEntitlementJudgment,
} from '@/lib/member-circle-view'

// ---------------------------------------------------------------------------
// Target normalization (fail-closed id validation)
// ---------------------------------------------------------------------------

/**
 * Keeps only the strictly-UUID-valid ids of a raw candidate target. A target
 * with NO valid id at all returns null — an unaddressable candidate can never
 * become a navigation target (malicious/foreign payload fail closed).
 */
export function normalizeCircleReturnTarget(raw: unknown): CircleReturnTargetIds | null {
  const candidate = raw as Partial<CircleReturnTargetIds> | null
  if (!candidate || typeof candidate !== 'object') return null
  const target: CircleReturnTargetIds = {}
  if (isValidPoloUuid(candidate.circleId)) target.circleId = candidate.circleId
  if (isValidPoloUuid(candidate.membershipId)) target.membershipId = candidate.membershipId
  if (isValidPoloUuid(candidate.orderId)) target.orderId = candidate.orderId
  return target.circleId || target.membershipId || target.orderId ? target : null
}

/** Which object the return verification is ABOUT. */
export type CircleReturnTargetKind = 'order' | 'circle'

/**
 * `order` when an original orderId addresses the verification (the
 * order-return scenes); anything else addressable is a circle-return. An
 * unaddressable target is `invalid` and never rendered as a candidate.
 */
export function circleReturnTargetKind(
  target: CircleReturnTargetIds | null,
): CircleReturnTargetKind | 'invalid' {
  if (!target) return 'invalid'
  if (target.orderId) return 'order'
  if (target.circleId || target.membershipId) return 'circle'
  return 'invalid'
}

/** Structural target identity (used to detect an explicit-candidate change). */
export function sameCircleReturnTarget(
  left: CircleReturnTargetIds | null,
  right: CircleReturnTargetIds | null,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.circleId === right.circleId
    && left.membershipId === right.membershipId
    && left.orderId === right.orderId
}

// ---------------------------------------------------------------------------
// Scope-fenced consumption key (event/read dedup, P70-RETURN-BRIDGE-03)
// ---------------------------------------------------------------------------

/**
 * Consumption dedup key. Within ONE identity scope the B1 typed event and the
 * getPending read may deliver the same candidate in any interleaving — both
 * carry the same candidateId and must be consumed exactly once. Across an
 * account/space rebind (A4 mirror re-anchor) the SAME candidateId MUST be
 * re-consumed under the new identity (P70-RETURN-01: 换账号后重新核对), so
 * the scope identity is part of the key, not a replacement for candidateId.
 */
export function circleReturnConsumptionKey(scopeKey: string | null, candidateId: string): string {
  return `${scopeKey ?? 'no-scope'}::${candidateId}`
}

/** The collision-free identity scope a delivery belongs to. */
export interface CircleReturnScopeIdentity {
  accountId: string | null
  personalProductSpaceId: string | null
  contextKey: string | null
  epoch: number
}

export function circleReturnScopeKey(scope: CircleReturnScopeIdentity | null): string | null {
  if (!scope?.accountId || !scope.personalProductSpaceId || !scope.contextKey) return null
  return JSON.stringify([
    'poo70-c8-return',
    scope.accountId,
    scope.personalProductSpaceId,
    scope.contextKey,
    scope.epoch,
  ])
}

// ---------------------------------------------------------------------------
// Navigation back to the original object (N1 ClientPageContext contract)
// ---------------------------------------------------------------------------

/**
 * The client-page route that opens the ORIGINAL object. Derivable only from
 * a confirmed circleId (target's own, the original order's circle, or the
 * authoritative checkout's circle); a membershipId-only target cannot name a
 * page and returns null — the caller then stays put instead of guessing.
 * Order verification lands on the subscription section (原订单/订阅事实的家),
 * circle verification on the content section.
 */
export function deriveCircleReturnRoute(input: {
  target: CircleReturnTargetIds | null
  order: OriginalCircleOrder | null
  checkout: MemberCircleCheckoutResult | null
}): ClientPageRoute | null {
  const { target, order, checkout } = input
  const kind = circleReturnTargetKind(target)
  if (kind === 'invalid') return null
  const section = kind === 'order' ? 'subscription' : 'content'
  const circleId = target?.circleId
    ?? checkout?.circleId
    ?? order?.circle.circleId
  if (!circleId || !isValidPoloUuid(circleId)) return null
  return { kind: 'circle-detail', circleId, section }
}

// ---------------------------------------------------------------------------
// Verdict derivation (authoritative reads only; paid-alone never grants)
// ---------------------------------------------------------------------------

/** The entitlement fact the panel renders for 资格状态. */
export type CircleReturnEntitlementState = 'valid' | 'invalid' | 'unknown'

export interface CircleReturnVerdictInput {
  kind: CircleReturnTargetKind
  /** Original-order GET result; null when the read failed or is absent. */
  order: OriginalCircleOrder | null
  /** True when the original-order read FAILED (payload withheld). */
  orderReadFailed: boolean
  /** The order-read failure code class that decides account mismatch. */
  orderErrorCode: string | null
  /** Authoritative checkout read result; null when it failed or is absent. */
  checkout: MemberCircleCheckoutResult | null
  checkoutReadFailed: boolean
  checkoutErrorCode: string | null
  /**
   * The C2 invalidation outcome's relations arm: only `refreshed` means the
   * membership rows below are the CURRENT account's authoritative relations.
   */
  relations: 'refreshed' | 'partial' | 'failed' | 'skipped'
  /** The refreshed relations' membership row for this circle (or null). */
  membership: MemberMembership | null
}

export interface CircleReturnVerdict {
  /** Definitive negative for the CURRENT account (same-shape 404/403, or
   * refreshed relations without the membership) — no object disclosure. */
  accountMismatch: boolean
  entitlementState: CircleReturnEntitlementState
  /** The authoritative checkout state, when one was obtained. */
  checkoutState: MemberCircleCheckoutState | null
  /** True when another click may obtain a better answer (failure/unknown). */
  retryable: boolean
}

const ACCOUNT_MISMATCH_READ_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'forbidden',
  'not_found',
])

const NETWORK_CLASS_READ_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'timeout',
  'service_unavailable',
  'session_unavailable',
  'session_changed',
])

/**
 * Correction-aware membership entitlement display (mirrors the C3 row rule):
 * lifecycle `active` keeps the row valid UNLESS the correction-aware payment
 * projection says the latest order is no longer paid (refund/chargeback).
 * A projection that is MISSING (no orders / provider omitted it) is a fact,
 * not a failure — the lifecycle stays the authority, and a raw stored `paid`
 * alone never grants anything (G5).
 */
export function deriveMembershipEntitlementState(
  membership: MemberMembership | null,
): CircleReturnEntitlementState {
  if (!membership) return 'unknown'
  if (membership.status !== 'active') return 'invalid'
  const judgment = selectLatestEntitlementJudgment(membership)
  if (judgment && judgment.basis === 'projected' && judgment.effectivePaymentStatus !== 'paid') {
    return 'invalid'
  }
  return 'valid'
}

/**
 * Joint verdict over the F1 authoritative reads and the refreshed
 * correction-aware membership projection:
 *
 * - The ORIGINAL order receipt (GET me/circle-payment-orders/{orderId}) is
 *   display evidence; its stored status is history, never a grant (G5).
 *   Same-shape 404/401/403 (F1: other people's orders look identical) is the
 *   definitive "this account has no such record" — the order payload is
 *   withheld and nothing about it is disclosed.
 * - The authoritative CHECKOUT read is the entitlement judgment source: only
 *   `state: 'success'` supports 有效, and only when the refreshed relations
 *   also carry the membership (a successful checkout over a relations receipt
 *   that lacks the membership row stays `unknown` — one receipt alone does
 *   not grant). `failed` is a definitive invalid; every other state (or a
 *   failed read) stays `unknown` and retryable.
 * - Circle-only returns are judged from the refreshed relations alone: the
 *   membership row present (any lifecycle) is member evidence; refreshed
 *   relations WITHOUT the row is the same-shape definitive negative.
 */
export function deriveCircleReturnVerdict(input: CircleReturnVerdictInput): CircleReturnVerdict {
  const {
    kind,
    order,
    orderReadFailed,
    orderErrorCode,
    checkout,
    checkoutReadFailed,
    checkoutErrorCode,
    relations,
    membership,
  } = input

  const mismatchCode = (code: string | null) =>
    code !== null && ACCOUNT_MISMATCH_READ_CODES.has(code)
  const networkCode = (code: string | null) =>
    code !== null && NETWORK_CLASS_READ_CODES.has(code)

  if (kind === 'order') {
    // Wrong account / absent object: F1 answers with the SAME shape — there
    // is no observable difference between "no such order" and "not yours",
    // and both mean this account cannot verify the object (fail closed, no
    // disclosure, recovery is re-login under the right account).
    if (orderReadFailed && mismatchCode(orderErrorCode)) {
      return { accountMismatch: true, entitlementState: 'unknown', checkoutState: null, retryable: false }
    }
    if (orderReadFailed) {
      // The ORIGINAL order lookup itself failed (network class): the round
      // could not complete its promised original-object check — retryable,
      // nothing granted and nothing disclosed (P-M07-PAY-RETURN-FAIL).
      return { accountMismatch: false, entitlementState: 'unknown', checkoutState: null, retryable: true }
    }
    if (checkoutReadFailed && mismatchCode(checkoutErrorCode) && !order) {
      return { accountMismatch: true, entitlementState: 'unknown', checkoutState: null, retryable: false }
    }

    // Relations half-failed: the membership cross-check is not current, so no
    // verdict can complete regardless of the order facts (重试而非猜测).
    if (relations !== 'refreshed') {
      return { accountMismatch: false, entitlementState: 'unknown', checkoutState: checkout?.state ?? null, retryable: true }
    }

    // Authoritative checkout succeeded: entitlement 有效 ONLY when the
    // refreshed relations ALSO carry the membership (joint judgment), and
    // even then the correction-aware projection may still invalidate it
    // (refund/chargeback after the checkout). The original order's stored
    // `paid` never qualifies by itself (G5).
    if (checkout?.state === 'success') {
      const membershipState = deriveMembershipEntitlementState(membership)
      if (!membership) {
        return { accountMismatch: false, entitlementState: 'unknown', checkoutState: 'success', retryable: true }
      }
      return {
        accountMismatch: false,
        entitlementState: membershipState === 'invalid' ? 'invalid' : 'valid',
        checkoutState: 'success',
        retryable: false,
      }
    }
    if (checkout?.state === 'failed') {
      // Definitive authoritative negative: the payment did not establish an
      // entitlement (the order object itself IS this account's and may be
      // shown as display history — not an account mismatch).
      return { accountMismatch: false, entitlementState: 'invalid', checkoutState: 'failed', retryable: false }
    }
    // confirm/processing/changed/unknown states and failed reads: no
    // authoritative answer yet — unknown, one more click may settle it.
    return { accountMismatch: false, entitlementState: 'unknown', checkoutState: checkout?.state ?? null, retryable: true }
  }

  // Circle-only return: the refreshed relations receipt is the only evidence.
  if (relations === 'refreshed') {
    if (membership) {
      return {
        accountMismatch: false,
        entitlementState: deriveMembershipEntitlementState(membership),
        checkoutState: null,
        retryable: false,
      }
    }
    // Refreshed authoritative relations without the membership: the same
    // definitive negative as the order 404 (share links forward to anyone —
    // the account simply has no such record).
    return { accountMismatch: true, entitlementState: 'unknown', checkoutState: null, retryable: false }
  }
  return { accountMismatch: false, entitlementState: 'unknown', checkoutState: null, retryable: true }
}

// ---------------------------------------------------------------------------
// Candidate helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory candidate holder (ids + consumer handle — never secrets). */
export interface HeldCircleReturnCandidate {
  /** Main-generated handle when the candidate came from the B1 bridge. */
  candidateId: string | null
  target: CircleReturnTargetIds
  /** Where this candidate was surfaced from. */
  source: 'bridge' | 'explicit'
}

/** Wraps a delivered B1 candidate into the minimal holder (ids validated). */
export function heldCandidateFromBridge(
  candidate: CircleReturnCandidate,
): HeldCircleReturnCandidate | null {
  const target = normalizeCircleReturnTarget(candidate.target)
  if (!target) return null
  return { candidateId: candidate.candidateId, target, source: 'bridge' }
}

/** Wraps an explicit (local original-object record) candidate. */
export function heldCandidateFromExplicit(
  target: CircleReturnTargetIds | null,
): HeldCircleReturnCandidate | null {
  const normalized = normalizeCircleReturnTarget(target)
  if (!normalized) return null
  return { candidateId: null, target: normalized, source: 'explicit' }
}
