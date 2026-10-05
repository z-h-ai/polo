/**
 * Member circle client contract (POO-70 C1 / POO-88).
 *
 * Single consumption surface for the member-side circle endpoints verified by
 * the F1 contract snapshot
 * `docs/client-journey-review/development-plan/member-circle-contract.json`
 * (polo-admin `integration/pol114-creator-r26@17477dbf`).
 *
 * Ground rules encoded here (P70-CIRCLE-API-01/02/03):
 * - DTOs keep `circleId` / `membershipId` / `artifactId` / `versionId` /
 *   `orderId` as separate, non-interchangeable identifiers.
 * - Unknown response fields are stripped, never guessed; a response that does
 *   not match the verified contract fails closed (`invalid_response`), and is
 *   never downgraded to an empty-list success.
 * - Empty `circles` / `memberships` / `entitlements` arrays are legitimate
 *   successes (no membership / source closed) — distinct from the explicit
 *   `upstream_pending` capability states returned where the F1 contract
 *   records a missing member-side endpoint (gaps G2/G3/G4).
 * - No purchase / create-order / grant API exists on this surface; the only
 *   member write is `leave_now`.
 */
import { z } from 'zod';
import { AdminError } from './types.ts';

// ---------------------------------------------------------------------------
// Contract enums (member-circle-contract.json → conventions.enums)
// ---------------------------------------------------------------------------

export type MemberCircleStatus = 'active' | 'suspended' | 'closing' | 'closed';
export type MemberCircleMembershipStatus = 'active' | 'suspended' | 'expired';
export type MemberCircleJoinMode = 'free' | 'invite_only' | 'paid';
export type MemberCircleBillingCycle = 'month' | 'year';
export type MemberCircleBillingKind = 'free' | 'paid';
export type MemberCirclePeriodKind = 'legacy_days' | 'calendar_month' | 'calendar_year';
export type MemberCircleEntitlementSourceKind = 'active_distribution' | 'paid_retention';
export type MemberCircleCheckoutState =
  | 'confirm'
  | 'processing'
  | 'success'
  | 'failed'
  | 'changed'
  | 'unknown';
export type MemberCircleProviderPaymentState = 'unpaid' | 'paid' | 'closed' | 'unknown';

// ---------------------------------------------------------------------------
// Typed error surface (contract error_model: {code, message} + HTTP status)
// ---------------------------------------------------------------------------

/**
 * Status-level error vocabulary. Provider fine-grained 409 codes
 * (`invalid_membership_transition` / `calendar_contract_invalid` /
 * `replacement_chain_invalid`) all collapse into `conflict`; consumers
 * distinguish them by operation, never by guessing a finer code.
 */
export type MemberCircleApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'service_unavailable'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'unknown';

export interface MemberCircleApiError {
  code: MemberCircleApiErrorCode;
  /** Original HTTP status when the failure came from a response. */
  status: number | null;
  message: string;
}

const MEMBER_CIRCLE_API_ERROR_MESSAGES: Record<MemberCircleApiErrorCode, string> = {
  validation_error: 'Member circle request was rejected',
  unauthorized: 'Member circle session is no longer valid',
  forbidden: 'Member circle request is not permitted',
  not_found: 'Member circle resource was not found',
  conflict: 'Member circle request conflicts with the current membership state',
  rate_limited: 'Member circle request was rate limited',
  service_unavailable: 'Member circle service is temporarily unavailable',
  timeout: 'Member circle request timed out',
  network_error: 'Failed to reach the member circle service',
  invalid_response: 'Member circle response did not match the verified contract',
  unknown: 'Member circle request failed',
};

export function getSafeMemberCircleApiErrorMessage(code: MemberCircleApiErrorCode): string {
  return MEMBER_CIRCLE_API_ERROR_MESSAGES[code];
}

/**
 * Thrown by the contract parsers when a 2xx payload does not match the
 * verified F1 shapes. Carries its own identity so the error mapping can
 * surface `invalid_response` verbatim across the RPC bridge — a contract
 * violation must stay distinguishable from a transport/service outage and
 * must never collapse into `service_unavailable`.
 */
export class MemberCircleInvalidResponseError extends AdminError {
  constructor(detail?: string) {
    const message = getSafeMemberCircleApiErrorMessage('invalid_response');
    super(detail ? `${message} (${detail})` : message, 'SERVER_ERROR');
    this.name = 'MemberCircleInvalidResponseError';
  }
}

/**
 * Maps transport-level failures into the typed member-circle error surface.
 * Status is authoritative when present (the AdminClient preserves it), so
 * 401/403/404/409/429/503 keep their distinct identity instead of collapsing
 * into the generic Admin code set.
 */
export function mapMemberCircleApiError(error: unknown): MemberCircleApiError {
  if (error instanceof MemberCircleInvalidResponseError) {
    return {
      code: 'invalid_response',
      status: null,
      message: getSafeMemberCircleApiErrorMessage('invalid_response'),
    };
  }
  if (!(error instanceof AdminError)) {
    return {
      code: 'unknown',
      status: null,
      message: getSafeMemberCircleApiErrorMessage('unknown'),
    };
  }
  const status = typeof error.status === 'number' ? error.status : null;
  let code: MemberCircleApiErrorCode;
  if (status === 400) code = 'validation_error';
  else if (status === 401) code = 'unauthorized';
  else if (status === 403) code = 'forbidden';
  else if (status === 404) code = 'not_found';
  else if (status === 409) code = 'conflict';
  else if (status === 429) code = 'rate_limited';
  else if (status !== null && status >= 500) code = 'service_unavailable';
  else if (error.errorCode === 'UNAUTHORIZED' || error.errorCode === 'TOKEN_REVOKED' || error.errorCode === 'TOKEN_EXPIRED' || error.errorCode === 'INVALID_TOKEN') code = 'unauthorized';
  else if (error.errorCode === 'FORBIDDEN') code = 'forbidden';
  else if (error.errorCode === 'NOT_FOUND') code = 'not_found';
  else if (error.errorCode === 'VALIDATION_ERROR') code = 'validation_error';
  else if (error.errorCode === 'TIMEOUT') code = 'timeout';
  else if (error.errorCode === 'NETWORK_ERROR') code = 'network_error';
  else if (status !== null && status >= 400 && status < 500) code = 'validation_error';
  else code = 'service_unavailable';
  return { code, status, message: getSafeMemberCircleApiErrorMessage(code) };
}

// ---------------------------------------------------------------------------
// Zod primitives (fail-closed parsing of provider payloads)
// ---------------------------------------------------------------------------

const uuidString = z.string().uuid();
const isoTimestamp = z.string().refine(
  value => Number.isFinite(Date.parse(value)),
  'Expected an ISO-8601 timestamp',
);
const isoTimestampNullable = isoTimestamp.nullable();
const minorAmount = z.number().int();

/** Shared UUID validator for wire ids (membership/circle/artifact/order). */
export const MemberCircleUuidSchema = uuidString;

// ---------------------------------------------------------------------------
// Entitlements (me/circles → resolveCircleEntitlements projection)
// ---------------------------------------------------------------------------

const MemberCircleEntitlementArtifactSchema = z.object({
  id: uuidString,
  type: z.string().min(1),
  slug: z.string().min(1),
  // Artifact.name / Artifact.summary are nullable DB columns
  // (pol114@17477dbf prisma/schema.prisma model Artifact) and the
  // entitlements projection passes them through verbatim
  // (distributions.ts L38 `summary: string | null`, L51 raw SELECT,
  // L171 passthrough). A NULL is a fact to preserve, not a contract
  // violation — POO-79 API-CIRCLE-02-SUMMARY-NULL.
  name: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.string().min(1),
  currentStableVersionId: uuidString.nullable(),
});

const MemberCircleEntitlementArtifactVersionSchema = z.object({
  id: uuidString,
  version: z.string().min(1),
  status: z.string().min(1),
  publishedAt: isoTimestamp.nullable(),
});

export interface MemberCircleEntitlement {
  /** Entitlement row id. */
  id: string;
  circleId: string;
  artifactId: string;
  sourceKind: MemberCircleEntitlementSourceKind;
  /** Only meaningful for `paid_retention`. */
  sourceValidUntil: string | null;
  artifact: {
    id: string;
    type: string;
    slug: string;
    /** Nullable upstream (Artifact.name String?); consumers render as not-provided. */
    name: string | null;
    /** Nullable upstream (Artifact.summary String?); consumers render as not-provided. */
    summary: string | null;
    status: string;
    currentStableVersionId: string | null;
  };
  artifactVersion: {
    id: string;
    version: string;
    status: string;
    publishedAt: string | null;
  };
}

const MemberCircleEntitlementSchema = z.object({
  id: uuidString,
  circleId: uuidString,
  artifactId: uuidString,
  sourceKind: z.enum(['active_distribution', 'paid_retention']),
  sourceValidUntil: isoTimestampNullable,
  artifact: MemberCircleEntitlementArtifactSchema,
  artifactVersion: MemberCircleEntitlementArtifactVersionSchema,
});

// ---------------------------------------------------------------------------
// MemberCircleSnapshot (GET /api/me/circles)
// ---------------------------------------------------------------------------

export interface MemberCircleSnapshot {
  membershipId: string;
  status: MemberCircleMembershipStatus;
  billingKind: MemberCircleBillingKind;
  modeTransitionEndsAt: string | null;
  currentPeriodEnd: string | null;
  joinSource: string;
  joinedAt: string;
  circle: {
    circleId: string;
    name: string;
    purpose: string;
    status: MemberCircleStatus;
    /**
     * Raw owner uuid (contract gap G1): NOT a displayable creator name and
     * never a fallback for one.
     */
    ownerUserId: string;
  };
  /** Empty is a legitimate state (closed circle / unresolvable source) — G8. */
  entitlements: MemberCircleEntitlement[];
}

const MemberCircleSnapshotSchema = z.object({
  id: uuidString,
  status: z.enum(['active', 'suspended', 'expired']),
  billingKind: z.enum(['free', 'paid']),
  modeTransitionEndsAt: isoTimestampNullable,
  currentPeriodEnd: isoTimestampNullable,
  joinSource: z.string(),
  joinedAt: isoTimestamp,
  circle: z.object({
    id: uuidString,
    name: z.string(),
    purpose: z.string(),
    status: z.enum(['active', 'suspended', 'closing', 'closed']),
    ownerUserId: uuidString,
  }),
  entitlements: z.array(MemberCircleEntitlementSchema),
});

export interface MemberCircleListResponse {
  circles: MemberCircleSnapshot[];
}

export function parseMemberCirclesResponse(data: unknown): MemberCircleListResponse {
  const parsed = z.object({ circles: z.array(MemberCircleSnapshotSchema) })
    .safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  return {
    circles: parsed.data.circles.map(circle => ({
      membershipId: circle.id,
      status: circle.status,
      billingKind: circle.billingKind,
      modeTransitionEndsAt: circle.modeTransitionEndsAt,
      currentPeriodEnd: circle.currentPeriodEnd,
      joinSource: circle.joinSource,
      joinedAt: circle.joinedAt,
      circle: {
        circleId: circle.circle.id,
        name: circle.circle.name,
        purpose: circle.circle.purpose,
        status: circle.circle.status,
        ownerUserId: circle.circle.ownerUserId,
      },
      entitlements: circle.entitlements.map(entitlement => ({
        id: entitlement.id,
        circleId: entitlement.circleId,
        artifactId: entitlement.artifactId,
        sourceKind: entitlement.sourceKind,
        sourceValidUntil: entitlement.sourceValidUntil,
        artifact: entitlement.artifact,
        artifactVersion: entitlement.artifactVersion,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// MemberMembership (GET /api/me/circle-memberships)
// ---------------------------------------------------------------------------

export interface MemberCircleCorrection {
  kind: 'refund' | 'chargeback';
  amountMinor: number;
  partial: boolean;
  refundAmountMinor: number;
  chargebackAmountMinor: number;
}

/**
 * Projected payment order row (contract: effectivePaymentStatus / correction
 * include refund/chargeback corrections — never judge entitlements from the
 * raw stored `status` alone, G5).
 */
export interface MemberCirclePaymentOrderSummary {
  orderId: string;
  /** Stored status, display-only history. */
  storedStatus: string;
  amountMinor: number;
  currency: string;
  /** Correction-projected status; absent when the provider omits it. */
  effectivePaymentStatus: string | null;
  correction: MemberCircleCorrection | null;
}

export interface MemberMembership {
  membershipId: string;
  status: MemberCircleMembershipStatus;
  billingKind: MemberCircleBillingKind;
  modeTransitionEndsAt: string | null;
  currentPeriodEnd: string | null;
  suspendedReason: string | null;
  joinedAt: string;
  updatedAt: string;
  /** Most recent orders (provider take:5, newest first). */
  paymentOrders: MemberCirclePaymentOrderSummary[];
  circle: {
    circleId: string;
    name: string;
    purpose: string;
    status: MemberCircleStatus;
    joinMode: MemberCircleJoinMode;
    membershipPriceMinor: number | null;
    membershipCurrency: string | null;
    nextPeriodPriceMinor: number | null;
    nextPriceEffectiveAt: string | null;
  };
}

const MemberCircleCorrectionSchema = z.object({
  kind: z.enum(['refund', 'chargeback']),
  amountMinor: minorAmount,
  partial: z.boolean(),
  refundAmountMinor: minorAmount,
  chargebackAmountMinor: minorAmount,
});

const MemberCirclePaymentOrderSchema = z.object({
  id: uuidString,
  status: z.string().min(1),
  amountMinor: minorAmount,
  currency: z.string().min(3).max(3),
  effectivePaymentStatus: z.string().min(1).nullable().optional(),
  correction: MemberCircleCorrectionSchema.nullable().optional(),
});

const MemberMembershipSchema = z.object({
  id: uuidString,
  status: z.enum(['active', 'suspended', 'expired']),
  billingKind: z.enum(['free', 'paid']),
  modeTransitionEndsAt: isoTimestampNullable,
  currentPeriodEnd: isoTimestampNullable,
  suspendedReason: z.string().nullable(),
  joinedAt: isoTimestamp,
  updatedAt: isoTimestamp,
  paymentOrders: z.array(MemberCirclePaymentOrderSchema),
  circle: z.object({
    id: uuidString,
    name: z.string(),
    purpose: z.string(),
    status: z.enum(['active', 'suspended', 'closing', 'closed']),
    joinMode: z.enum(['free', 'invite_only', 'paid']),
    membershipPriceMinor: minorAmount.nullable(),
    membershipCurrency: z.string().min(3).max(3).nullable(),
    nextPeriodPriceMinor: minorAmount.nullable(),
    nextPriceEffectiveAt: isoTimestampNullable,
  }),
});

export interface MemberMembershipListResponse {
  memberships: MemberMembership[];
}

export function parseMemberMembershipsResponse(data: unknown): MemberMembershipListResponse {
  const parsed = z.object({ memberships: z.array(MemberMembershipSchema) })
    .safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  return {
    memberships: parsed.data.memberships.map(membership => ({
      membershipId: membership.id,
      status: membership.status,
      billingKind: membership.billingKind,
      modeTransitionEndsAt: membership.modeTransitionEndsAt,
      currentPeriodEnd: membership.currentPeriodEnd,
      suspendedReason: membership.suspendedReason,
      joinedAt: membership.joinedAt,
      updatedAt: membership.updatedAt,
      paymentOrders: membership.paymentOrders.map(order => ({
        orderId: order.id,
        storedStatus: order.status,
        amountMinor: order.amountMinor,
        currency: order.currency,
        effectivePaymentStatus: order.effectivePaymentStatus ?? null,
        correction: order.correction ?? null,
      })),
      circle: {
        circleId: membership.circle.id,
        name: membership.circle.name,
        purpose: membership.circle.purpose,
        status: membership.circle.status,
        joinMode: membership.circle.joinMode,
        membershipPriceMinor: membership.circle.membershipPriceMinor,
        membershipCurrency: membership.circle.membershipCurrency,
        nextPeriodPriceMinor: membership.circle.nextPeriodPriceMinor,
        nextPriceEffectiveAt: membership.circle.nextPriceEffectiveAt,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Renewal preview (GET /api/me/circle-memberships/{membershipId})
// ---------------------------------------------------------------------------

export interface MemberCircleRenewalPreview {
  membershipId: string;
  circleId: string;
  billingCycle: MemberCircleBillingCycle;
  periodKind: Exclude<MemberCirclePeriodKind, 'legacy_days'>;
  /**
   * Current effective price in minor units. The contract explicitly allows
   * `null` (price unavailable upstream) — consumers must handle it and must
   * never substitute a fabricated amount.
   */
  priceMinor: number | null;
  currency: string;
  anchorAt: string;
  projectedPeriodStartAt: string;
  projectedPeriodEndAt: string;
  periodCapEndAt: string;
  canRenew: boolean;
  capReason: string | null;
}

export interface MemberCircleRenewalPreviewPayload {
  /** Raw provider value, e.g. `/c/{shareId}?renew=1`. Untrusted for direct opening. */
  purchaseUrl: string;
  preview: MemberCircleRenewalPreview;
}

const MemberCircleRenewalPreviewSchema = z.object({
  purchaseUrl: z.string().min(1),
  preview: z.object({
    membershipId: uuidString,
    circleId: uuidString,
    billingCycle: z.enum(['month', 'year']),
    periodKind: z.enum(['calendar_month', 'calendar_year']),
    priceMinor: minorAmount.nullable(),
    currency: z.string().min(3).max(3),
    anchorAt: isoTimestamp,
    projectedPeriodStartAt: isoTimestamp,
    projectedPeriodEndAt: isoTimestamp,
    periodCapEndAt: isoTimestamp,
    canRenew: z.boolean(),
    capReason: z.string().nullable(),
  }),
});

export function parseMemberRenewalPreviewResponse(data: unknown): MemberCircleRenewalPreviewPayload {
  const parsed = MemberCircleRenewalPreviewSchema.safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  return parsed.data;
}

export type MemberCirclePurchaseUrlResolution =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' };

/**
 * Resolves the preview `purchaseUrl` for browser handoff. Relative paths are
 * resolved ONLY against the confirmed Admin (creator) origin; an absolute URL
 * is accepted only when its origin IS that same confirmed origin. Anything
 * else fails closed — the desktop never opens a URL the Admin contract did
 * not vouch for.
 */
export function resolveMemberCirclePurchaseUrl(
  purchaseUrl: string,
  adminUrl: string,
): MemberCirclePurchaseUrlResolution {
  let adminOrigin: string;
  try {
    adminOrigin = new URL(adminUrl).origin;
  } catch {
    return { ok: false, reason: 'untrusted_purchase_url_origin' };
  }
  try {
    const resolved = new URL(purchaseUrl, adminUrl);
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
      return { ok: false, reason: 'invalid_purchase_url' };
    }
    if (resolved.origin !== adminOrigin) {
      return { ok: false, reason: 'untrusted_purchase_url_origin' };
    }
    return { ok: true, url: resolved.toString() };
  } catch {
    return { ok: false, reason: 'invalid_purchase_url' };
  }
}

// ---------------------------------------------------------------------------
// Leave (PATCH /api/me/circle-memberships/{membershipId} — leave_now)
// ---------------------------------------------------------------------------

export interface MemberCircleLeaveMembership {
  membershipId: string;
  circleId: string;
  /** Provider-echoed actor id; informational only — never a permission input. */
  userId: string;
  status: MemberCircleMembershipStatus;
  billingKind: MemberCircleBillingKind;
  currentPeriodEnd: string | null;
  modeTransitionEndsAt: string | null;
  suspendedReason: string | null;
  joinedAt: string;
  endedAt: string | null;
  updatedAt: string | null;
}

const MemberCircleLeaveMembershipSchema = z.object({
  id: uuidString,
  circleId: uuidString,
  userId: uuidString,
  status: z.enum(['active', 'suspended', 'expired']),
  billingKind: z.enum(['free', 'paid']),
  currentPeriodEnd: isoTimestampNullable,
  modeTransitionEndsAt: isoTimestampNullable,
  suspendedReason: z.string().nullable(),
  joinedAt: isoTimestamp,
  endedAt: isoTimestampNullable,
  updatedAt: isoTimestamp.nullable(),
});

export function parseMemberLeaveResponse(data: unknown): MemberCircleLeaveMembership {
  const parsed = z.object({ membership: MemberCircleLeaveMembershipSchema })
    .safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  const membership = parsed.data.membership;
  return {
    membershipId: membership.id,
    circleId: membership.circleId,
    userId: membership.userId,
    status: membership.status,
    billingKind: membership.billingKind,
    currentPeriodEnd: membership.currentPeriodEnd,
    modeTransitionEndsAt: membership.modeTransitionEndsAt,
    suspendedReason: membership.suspendedReason,
    joinedAt: membership.joinedAt,
    endedAt: membership.endedAt,
    updatedAt: membership.updatedAt,
  };
}

/** The only member write on this surface (contract: strict single-value body). */
export const MEMBER_CIRCLE_LEAVE_COMMAND = { action: 'leave_now' } as const;

// ---------------------------------------------------------------------------
// Original order (GET /api/me/circle-payment-orders/{orderId})
// ---------------------------------------------------------------------------

export interface OriginalCircleOrder {
  orderId: string;
  /** Stored status — display history only; NEVER an entitlement judgment (G5). */
  storedStatus: string;
  amountMinor: number;
  currency: string;
  /** Nullable upstream (CirclePaymentOrder.checkoutUrl String?) — null before a code was issued. */
  checkoutUrl: string | null;
  periodEndAt: string | null;
  circle: {
    circleId: string;
    name: string;
  };
  /** Literal payment authority marker from the contract ("B01"). */
  paymentOwner: string;
}

const OriginalCircleOrderResponseSchema = z.object({
  order: z.object({
    id: uuidString,
    status: z.string().min(1),
    amountMinor: minorAmount,
    currency: z.string().min(3).max(3),
    // Nullable upstream DB column (CirclePaymentOrder.checkoutUrl String?).
    checkoutUrl: z.string().min(1).nullable(),
    periodEndAt: isoTimestamp.nullable(),
    circle: z.object({
      id: uuidString,
      name: z.string(),
    }),
  }),
  // The contract pins the payment authority marker to the literal "B01";
  // any other value is a contract violation, not a tolerant passthrough.
  paymentOwner: z.literal('B01'),
});

export function parseMemberOriginalOrderResponse(data: unknown): OriginalCircleOrder {
  const parsed = OriginalCircleOrderResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  return {
    orderId: parsed.data.order.id,
    storedStatus: parsed.data.order.status,
    amountMinor: parsed.data.order.amountMinor,
    currency: parsed.data.order.currency,
    checkoutUrl: parsed.data.order.checkoutUrl,
    periodEndAt: parsed.data.order.periodEndAt,
    circle: {
      circleId: parsed.data.order.circle.id,
      name: parsed.data.order.circle.name,
    },
    paymentOwner: parsed.data.paymentOwner,
  };
}

// ---------------------------------------------------------------------------
// Authoritative checkout read (GET /api/circle-checkout/{orderId})
// ---------------------------------------------------------------------------

export type MemberCircleEntitlementPeriod =
  | {
    kind: 'legacy_days';
    periodDays: number;
    periodEndAt: string | null;
  }
  | {
    kind: 'calendar_month' | 'calendar_year';
    billingCycle: MemberCircleBillingCycle;
    anchorAt: string;
    periodStartAt: string;
    periodEndAt: string | null;
    projectedPeriodEndAt: string;
    periodCapEndAt: string;
    canRenew: boolean;
    capReason: string | null;
  };

export interface MemberCircleCheckoutResult {
  state: MemberCircleCheckoutState;
  /** Effective (replacement-chain terminal) order id. */
  orderId: string;
  circleId: string;
  circleName: string;
  amountMinor: number;
  currency: string;
  periodDays: number | null;
  /** Null means the provider has not attached a period yet — surfaced as-is. */
  period: MemberCircleEntitlementPeriod | null;
  periodEndAt: string | null;
  membershipPeriodEndAt: string | null;
  projectedPeriodEndAt: string | null;
  periodCapEndAt: string | null;
  expiresAt: string | null;
  qrIssuedAt: string | null;
  qrExpiresAt: string | null;
  codeUrl: string | null;
  merchantExpiresAt: string | null;
  providerState: MemberCircleProviderPaymentState | null;
  canRecoverQr: boolean | null;
  canReconsent: boolean | null;
  recoveryOrderId: string | null;
  consentVersion: string | null;
  channel: string | null;
  currentPriceMinor: number | null;
  replacedByOrderId: string | null;
  canRetry: boolean | null;
}

const MemberCircleEntitlementPeriodSchema: z.ZodType<MemberCircleEntitlementPeriod> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('legacy_days'),
    periodDays: z.literal(30),
    periodEndAt: isoTimestamp.nullable(),
  }),
  z.object({
    kind: z.enum(['calendar_month', 'calendar_year']),
    billingCycle: z.enum(['month', 'year']),
    anchorAt: isoTimestamp,
    periodStartAt: isoTimestamp,
    periodEndAt: isoTimestamp.nullable(),
    projectedPeriodEndAt: isoTimestamp,
    periodCapEndAt: isoTimestamp,
    canRenew: z.boolean(),
    capReason: z.string().nullable(),
  }),
]);

const MemberCircleCheckoutResultSchema = z.object({
  state: z.enum(['confirm', 'processing', 'success', 'failed', 'changed', 'unknown']),
  orderId: z.string().min(1),
  circleId: uuidString,
  circleName: z.string(),
  amountMinor: minorAmount,
  currency: z.string().min(3).max(3),
  periodDays: minorAmount.nullable(),
  period: MemberCircleEntitlementPeriodSchema.nullable(),
  periodEndAt: isoTimestampNullable,
  membershipPeriodEndAt: isoTimestampNullable,
  projectedPeriodEndAt: isoTimestampNullable,
  periodCapEndAt: isoTimestampNullable,
  expiresAt: isoTimestampNullable,
  qrIssuedAt: isoTimestampNullable,
  qrExpiresAt: isoTimestampNullable,
  codeUrl: z.string().min(1).nullable(),
  merchantExpiresAt: isoTimestampNullable,
  providerState: z.enum(['unpaid', 'paid', 'closed', 'unknown']).nullable(),
  canRecoverQr: z.boolean().nullable(),
  canReconsent: z.boolean().nullable(),
  recoveryOrderId: z.string().min(1).nullable(),
  consentVersion: z.string().nullable(),
  channel: z.string().nullable(),
  currentPriceMinor: minorAmount.nullable(),
  replacedByOrderId: z.string().min(1).nullable(),
  canRetry: z.boolean().nullable(),
});

export function parseMemberCheckoutResultResponse(data: unknown): MemberCircleCheckoutResult {
  const parsed = MemberCircleCheckoutResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new MemberCircleInvalidResponseError();
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Upstream-pending capability states (contract gaps G2 / G3 / G4)
// ---------------------------------------------------------------------------

/**
 * Explicit "no member-side endpoint upstream yet" state. Distinct from both
 * an empty-list success (real data, legitimately empty) and a transport
 * failure — consumers must render it as pending/awaiting-upstream, never
 * fabricate content (contract gaps G2 updates, G3 public profile, G4 support).
 */
export interface MemberCircleUpstreamPendingState {
  availability: 'upstream_pending';
  contractGap: 'G2' | 'G3' | 'G4';
}

/**
 * Support bridge state (G4). `unconfigured` and `load_failed` are distinct
 * real states for the re-pin once the member-side endpoint exists; neither
 * may be faked today.
 */
export type MemberCircleSupportState =
  | { availability: 'available'; configured: boolean; guidance: string | null }
  | { availability: 'load_failed' }
  | { availability: 'upstream_pending'; contractGap: 'G4' };
