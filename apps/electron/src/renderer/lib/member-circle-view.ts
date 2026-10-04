/**
 * Member circle read-only view projections (POO-70 C2 / POO-90).
 *
 * Pure adapters from the C1 verified DTOs (F1 contract snapshot) to the view
 * shapes consumed by the member circle pages (C3+). Ground rules encoded here
 * (P70-CIRCLE-STATE-01/02/03):
 * - Missing display fields stay EXPLICITLY not-ready: the creator display
 *   name is an `upstream_pending` capability fact (contract gap G1), never a
 *   name fabricated from `ownerUserId`.
 * - Entitlement judgments come ONLY from the correction-aware payment
 *   projection (`effectivePaymentStatus` / `correction`); the raw stored
 *   order status is display history and never an entitlement (G5). An absent
 *   projection stays `unknown` — unknown is a fact, not an error and not a
 *   success.
 * - Empty `entitlements` are a legitimate state (closed circle / unrunnable
 *   artifact source, G8) — never upgraded into an error or a fake entry.
 * - A renewal handoff whose `resolvedPurchaseUrl` failed closed is surfaced
 *   with its explicit reason; the raw purchase URL is never opened directly.
 */
import type {
  MemberCircleCorrection,
  MemberCirclePaymentOrderSummary,
  MemberCircleRenewalPreview,
  MemberCircleSnapshot,
  MemberMembership,
} from '@polo-ai/shared/admin'

/**
 * Explicit readiness for a view field whose provider source is not landed
 * upstream yet (F1 contract gaps). Renderers show "awaiting upstream" —
 * never a guessed fallback value.
 */
export type MemberCircleDisplayField<T> =
  | { readiness: 'ready'; value: T }
  | { readiness: 'upstream_pending'; contractGap: 'G1' | 'G2' | 'G3' | 'G4' }

/** The contract gaps the member-circle consumer knows about, verbatim. */
export type MemberCircleContractGap = 'G1' | 'G2' | 'G3' | 'G4'

/**
 * Creator display name field (gap G1): `ownerUserId` is a raw uuid, not a
 * displayable name and never a fallback for one. Until the provider lands a
 * member-side display-name field, the name stays pending upstream.
 */
export function memberCircleCreatorNameField(
  _circle: MemberCircleSnapshot['circle'] | MemberMembership['circle'],
): MemberCircleDisplayField<string> {
  return { readiness: 'upstream_pending', contractGap: 'G1' }
}

/**
 * Entitlement judgment for one payment order (G5). The projection carried by
 * C1 (`effectivePaymentStatus` + `correction`) is the judgment basis; when
 * the provider omitted it, the judgment is explicitly `unknown` and the raw
 * stored status stays display-only history.
 */
export type MemberCircleEntitlementJudgment =
  | {
    basis: 'projected';
    /** Correction-projected status (may itself be `unknown` — kept as-is). */
    effectivePaymentStatus: string;
    correction: MemberCircleCorrection | null;
    /** Stored status — display history only. */
    storedStatus: string;
  }
  | {
    basis: 'unknown';
    /** No authoritative projection was provided; nothing is judged. */
    effectivePaymentStatus: null;
    correction: null;
    storedStatus: string;
    reason: 'projection_missing';
  }

export function judgeMembershipPaymentStatus(
  order: MemberCirclePaymentOrderSummary,
): MemberCircleEntitlementJudgment {
  if (typeof order.effectivePaymentStatus === 'string' && order.effectivePaymentStatus.length > 0) {
    return {
      basis: 'projected',
      effectivePaymentStatus: order.effectivePaymentStatus,
      correction: order.correction,
      storedStatus: order.storedStatus,
    }
  }
  return {
    basis: 'unknown',
    effectivePaymentStatus: null,
    correction: null,
    storedStatus: order.storedStatus,
    reason: 'projection_missing',
  }
}

/**
 * Judgement over a membership's LATEST payment order (provider take:5,
 * newest first). With no orders at all the membership is simply unjudged —
 * never treated as paid, never treated as failed.
 */
export function selectLatestEntitlementJudgment(
  membership: Pick<MemberMembership, 'paymentOrders'>,
): MemberCircleEntitlementJudgment | null {
  const latest = membership.paymentOrders[0]
  if (!latest) return null
  return judgeMembershipPaymentStatus(latest)
}

/**
 * True only when the correction-aware projection says paid. Raw stored
 * `paid` never qualifies by itself (G5): a fully refunded order stays
 * `paid` in storage while the projection reports the refund.
 */
export function isEntitlementJudgmentPaid(
  judgment: MemberCircleEntitlementJudgment,
): boolean {
  return judgment.basis === 'projected' && judgment.effectivePaymentStatus === 'paid'
}

// ---------------------------------------------------------------------------
// Detail projection (the member side has NO per-circle detail endpoint — the
// F1-verified detail surface is the list rows + memberships projection).
// ---------------------------------------------------------------------------

export type MemberCircleDetailView =
  | {
    availability: 'ready';
    circle: MemberCircleSnapshot;
    /** Membership projection for this circle, when one exists. */
    membership: MemberMembership | null;
    creatorName: MemberCircleDisplayField<string>;
    /** Latest-order entitlement judgment; null when no orders exist. */
    entitlementJudgment: MemberCircleEntitlementJudgment | null;
    /**
     * Verbatim provider entitlements (G8): empty is a legitimate state —
     * the source is closed/unrunnable, not an error.
     */
    entitlements: MemberCircleSnapshot['entitlements'];
  }
  | {
    /** circleId not present in the CURRENT scope's authoritative rows. */
    availability: 'unknown_circle';
  }

export function selectMemberCircleDetail(
  circles: ReadonlyArray<MemberCircleSnapshot>,
  memberships: ReadonlyArray<MemberMembership>,
  circleId: string,
): MemberCircleDetailView {
  const circle = circles.find(candidate => candidate.circle.circleId === circleId)
  if (!circle) return { availability: 'unknown_circle' }
  const membership = memberships.find(
    candidate => candidate.circle.circleId === circleId,
  ) ?? null
  return {
    availability: 'ready',
    circle,
    membership,
    creatorName: memberCircleCreatorNameField(circle.circle),
    entitlementJudgment: membership
      ? selectLatestEntitlementJudgment(membership)
      : null,
    entitlements: circle.entitlements,
  }
}

// ---------------------------------------------------------------------------
// Renewal browser handoff (previewRenewal result → explicit handoff state).
// ---------------------------------------------------------------------------

export interface MemberCircleRenewalPreviewPayload {
  purchaseUrl: string
  resolvedPurchaseUrl: string | null
  purchaseUrlResolutionError: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' | null
  preview: MemberCircleRenewalPreview
}

export type MemberCircleRenewalHandoff =
  | {
    /** C1 resolved the purchase URL against the confirmed Admin origin. */
    state: 'ready';
    url: string;
    preview: MemberCircleRenewalPreview;
  }
  | {
    /** Resolution failed closed — the raw URL is carried, never opened. */
    state: 'purchase_url_unresolved';
    reason: 'invalid_purchase_url' | 'untrusted_purchase_url_origin';
    rawPurchaseUrl: string;
    preview: MemberCircleRenewalPreview;
  }

/**
 * Price availability is ORTHOGONAL to the handoff state: the preview
 * `priceMinor` may be null while the purchase URL still resolves (the
 * browser page remains the recovery entry). Consumers must handle a null
 * price explicitly and must never substitute a fabricated amount.
 */
export function isRenewalPriceAvailable(
  preview: Pick<MemberCircleRenewalPreview, 'priceMinor'>,
): boolean {
  return preview.priceMinor !== null
}

export function selectRenewalHandoff(
  payload: MemberCircleRenewalPreviewPayload,
): MemberCircleRenewalHandoff {
  if (payload.resolvedPurchaseUrl) {
    return {
      state: 'ready',
      url: payload.resolvedPurchaseUrl,
      preview: payload.preview,
    }
  }
  return {
    state: 'purchase_url_unresolved',
    reason: payload.purchaseUrlResolutionError ?? 'invalid_purchase_url',
    rawPurchaseUrl: payload.purchaseUrl,
    preview: payload.preview,
  }
}
