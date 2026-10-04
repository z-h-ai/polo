import { describe, expect, it } from 'bun:test'
import { AdminError } from '../types.ts'
import {
  MEMBER_CIRCLE_LEAVE_COMMAND,
  MemberCircleInvalidResponseError,
  getSafeMemberCircleApiErrorMessage,
  mapMemberCircleApiError,
  parseMemberCirclesResponse,
  parseMemberCheckoutResultResponse,
  parseMemberLeaveResponse,
  parseMemberMembershipsResponse,
  parseMemberOriginalOrderResponse,
  parseMemberRenewalPreviewResponse,
  resolveMemberCirclePurchaseUrl,
  type MemberCircleSnapshot,
} from '../member-circles.ts'
import { AdminClient } from '../client.ts'

const MEMBERSHIP_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_MEMBERSHIP_ID = '11111111-1111-4111-8111-111111111112'
const CIRCLE_ID = '22222222-2222-4222-8222-222222222221'
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333331'
const ENTITLEMENT_ID = '44444444-4444-4444-8444-444444444441'
const STABLE_VERSION_ID = '55555555-5555-4555-8555-555555555551'
const ENTITLEMENT_VERSION_ID = '66666666-6666-4666-8666-666666666661'
const ORDER_ID = '77777777-7777-4777-8777-777777777771'
const OWNER_USER_ID = '88888888-8888-4888-8888-888888888881'
const ACTOR_USER_ID = '99999999-9999-4999-8999-999999999991'

// ---------------------------------------------------------------------------
// P70-CIRCLE-API-02 — DTO id separation
// ---------------------------------------------------------------------------

describe('member circle snapshot DTO', () => {
  const validCirclesPayload = {
    circles: [
      {
        id: MEMBERSHIP_ID,
        status: 'active',
        billingKind: 'paid',
        modeTransitionEndsAt: null,
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        joinSource: 'paid_join',
        joinedAt: '2026-01-01T00:00:00.000Z',
        circle: {
          id: CIRCLE_ID,
          name: 'Design Circle',
          purpose: 'Design reviews',
          status: 'active',
          ownerUserId: OWNER_USER_ID,
        },
        entitlements: [
          {
            id: ENTITLEMENT_ID,
            circleId: CIRCLE_ID,
            artifactId: ARTIFACT_ID,
            sourceKind: 'active_distribution',
            sourceValidUntil: null,
            artifact: {
              id: ARTIFACT_ID,
              type: 'skill',
              slug: 'design-kit',
              name: 'Design Kit',
              summary: 'A kit',
              status: 'published',
              currentStableVersionId: STABLE_VERSION_ID,
            },
            artifactVersion: {
              id: ENTITLEMENT_VERSION_ID,
              version: '1.2.0',
              status: 'published',
              publishedAt: '2026-02-01T00:00:00.000Z',
            },
          },
        ],
      },
      {
        // Closed circle: membership stays listed, entitlements legitimately
        // empty (contract G8 — empty is a fact, not a failure).
        id: OTHER_MEMBERSHIP_ID,
        status: 'active',
        billingKind: 'free',
        modeTransitionEndsAt: null,
        currentPeriodEnd: null,
        joinSource: 'free_join',
        joinedAt: '2026-01-02T00:00:00.000Z',
        circle: {
          id: CIRCLE_ID,
          name: 'Closed Circle',
          purpose: 'Archived',
          status: 'closed',
          ownerUserId: OWNER_USER_ID,
        },
        entitlements: [],
      },
    ],
  }

  it('separates circleId/membershipId/artifactId/versionId ids in the DTO', () => {
    const parsed = parseMemberCirclesResponse(validCirclesPayload)
    const paid: MemberCircleSnapshot = parsed.circles[0]!
    expect(parsed.circles).toHaveLength(2)
    expect(paid.membershipId).toBe(MEMBERSHIP_ID)
    expect(paid.circle.circleId).toBe(CIRCLE_ID)
    expect(paid.circle.circleId).not.toBe(paid.membershipId)
    expect(paid.entitlements[0]!.artifactId).toBe(ARTIFACT_ID)
    expect(paid.entitlements[0]!.artifact.id).toBe(ARTIFACT_ID)
    expect(paid.entitlements[0]!.artifact.currentStableVersionId).toBe(STABLE_VERSION_ID)
    expect(paid.entitlements[0]!.artifactVersion.id).toBe(ENTITLEMENT_VERSION_ID)
  })

  it('keeps ownerUserId as a raw uuid fact (G1), never a displayable name', () => {
    const parsed = parseMemberCirclesResponse(validCirclesPayload)
    expect(parsed.circles[0]!.circle.ownerUserId).toBe(OWNER_USER_ID)
    expect('creatorDisplayName' in parsed.circles[0]!.circle).toBe(false)
  })

  it('treats an empty circles array as a legitimate success (no memberships)', () => {
    const parsed = parseMemberCirclesResponse({ circles: [] })
    expect(parsed.circles).toEqual([])
  })

  it('keeps empty entitlements on a listed closed circle (G8) as success', () => {
    const parsed = parseMemberCirclesResponse(validCirclesPayload)
    expect(parsed.circles[1]!.entitlements).toEqual([])
  })

  it('fails closed on an unknown membership status instead of succeeding', () => {
    const mutated = structuredClone(validCirclesPayload) as typeof validCirclesPayload
    ;(mutated.circles[0] as Record<string, unknown>).status = 'unknown_status'
    expect(() => parseMemberCirclesResponse(mutated)).toThrow(AdminError)
  })

  it('fails closed on an unknown circle status', () => {
    const mutated = structuredClone(validCirclesPayload) as typeof validCirclesPayload
    ;((mutated.circles[0] as Record<string, unknown>).circle as Record<string, unknown>).status = 'deleted'
    expect(() => parseMemberCirclesResponse(mutated)).toThrow(AdminError)
  })

  it('fails closed when the envelope is missing', () => {
    expect(() => parseMemberCirclesResponse({})).toThrow(AdminError)
    expect(() => parseMemberCirclesResponse(null)).toThrow(AdminError)
  })

  it('strips unknown fields without guessing their semantics', () => {
    const mutated = structuredClone(validCirclesPayload) as typeof validCirclesPayload
    ;(mutated.circles[0] as Record<string, unknown>).creatorDisplayName = 'Injected Name'
    const parsed = parseMemberCirclesResponse(mutated)
    expect('creatorDisplayName' in parsed.circles[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Memberships with payment projections
// ---------------------------------------------------------------------------

describe('member memberships DTO', () => {
  const validMembershipsPayload = {
    memberships: [
      {
        id: MEMBERSHIP_ID,
        status: 'active',
        billingKind: 'paid',
        modeTransitionEndsAt: null,
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        suspendedReason: null,
        joinedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
        paymentOrders: [
          {
            id: ORDER_ID,
            status: 'paid',
            amountMinor: 9900,
            currency: 'CNY',
            effectivePaymentStatus: 'partially_refunded',
            correction: {
              kind: 'refund',
              amountMinor: 3000,
              partial: true,
              refundAmountMinor: 3000,
              chargebackAmountMinor: 0,
            },
          },
        ],
        circle: {
          id: CIRCLE_ID,
          name: 'Design Circle',
          purpose: 'Design reviews',
          status: 'active',
          joinMode: 'paid',
          membershipPriceMinor: 9900,
          membershipCurrency: 'CNY',
          nextPeriodPriceMinor: 12900,
          nextPriceEffectiveAt: '2026-12-01T00:00:00.000Z',
        },
      },
    ],
  }

  it('projects refund corrections on the payment order, separate from the stored status (G5)', () => {
    const parsed = parseMemberMembershipsResponse(validMembershipsPayload)
    const membership = parsed.memberships[0]!
    expect(membership.membershipId).toBe(MEMBERSHIP_ID)
    const order = membership.paymentOrders[0]!
    expect(order.orderId).toBe(ORDER_ID)
    expect(order.storedStatus).toBe('paid')
    expect(order.effectivePaymentStatus).toBe('partially_refunded')
    expect(order.correction).toEqual({
      kind: 'refund',
      amountMinor: 3000,
      partial: true,
      refundAmountMinor: 3000,
      chargebackAmountMinor: 0,
    })
  })

  it('strips membership-level projection fields the contract never registered', () => {
    // Legacy/foreign payloads carrying those keys must not leak them into
    // the DTO — the projection lives on the payment orders only.
    const mutated = structuredClone(validMembershipsPayload) as typeof validMembershipsPayload
    const item = mutated.memberships[0] as Record<string, unknown>
    item.effectivePaymentStatus = 'partially_refunded'
    item.correction = { kind: 'refund' }
    const parsed = parseMemberMembershipsResponse(mutated)
    expect('effectivePaymentStatus' in parsed.memberships[0]!).toBe(false)
    expect('correction' in parsed.memberships[0]!).toBe(false)
  })

  it('tolerates absent per-order projection fields as explicit nulls', () => {
    const mutated = structuredClone(validMembershipsPayload) as typeof validMembershipsPayload
    const order = (mutated.memberships[0] as Record<string, unknown>)
      .paymentOrders as Array<Record<string, unknown>>
    delete order[0]!.effectivePaymentStatus
    delete order[0]!.correction
    const parsed = parseMemberMembershipsResponse(mutated)
    expect(parsed.memberships[0]!.paymentOrders[0]!.effectivePaymentStatus).toBeNull()
    expect(parsed.memberships[0]!.paymentOrders[0]!.correction).toBeNull()
  })

  it('fails closed on a malformed correction', () => {
    const mutated = structuredClone(validMembershipsPayload) as typeof validMembershipsPayload
    ;((mutated.memberships[0] as Record<string, unknown>).paymentOrders as Array<Record<string, unknown>>)[0]!.correction = { kind: 'gift' }
    expect(() => parseMemberMembershipsResponse(mutated)).toThrow(AdminError)
  })

  it('treats an empty memberships array as a legitimate success', () => {
    expect(parseMemberMembershipsResponse({ memberships: [] }).memberships).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Renewal preview — priceMinor null is contractual
// ---------------------------------------------------------------------------

describe('renewal preview DTO', () => {
  const validPreviewPayload = {
    purchaseUrl: `/c/some-share-id?renew=1`,
    preview: {
      membershipId: MEMBERSHIP_ID,
      circleId: CIRCLE_ID,
      billingCycle: 'year',
      periodKind: 'calendar_year',
      priceMinor: null,
      currency: 'CNY',
      anchorAt: '2026-01-01T00:00:00.000Z',
      projectedPeriodStartAt: '2026-11-01T00:00:00.000Z',
      projectedPeriodEndAt: '2027-11-01T00:00:00.000Z',
      periodCapEndAt: '2027-11-01T00:00:00.000Z',
      canRenew: true,
      capReason: null,
    },
  }

  it('preserves a null priceMinor as a fact (contract: consumers must handle null)', () => {
    const parsed = parseMemberRenewalPreviewResponse(validPreviewPayload)
    expect(parsed.preview.priceMinor).toBeNull()
    expect(parsed.preview.membershipId).toBe(MEMBERSHIP_ID)
    expect(parsed.preview.circleId).toBe(CIRCLE_ID)
    expect(parsed.purchaseUrl).toBe('/c/some-share-id?renew=1')
  })

  it('keeps a numeric priceMinor when the provider provides it', () => {
    const mutated = structuredClone(validPreviewPayload)
    ;(mutated.preview as Record<string, unknown>).priceMinor = 12900
    expect(parseMemberRenewalPreviewResponse(mutated).preview.priceMinor).toBe(12900)
  })

  it('fails closed on a non-contractual periodKind (legacy_days is not a preview kind)', () => {
    const mutated = structuredClone(validPreviewPayload)
    ;(mutated.preview as Record<string, unknown>).periodKind = 'legacy_days'
    expect(() => parseMemberRenewalPreviewResponse(mutated)).toThrow(AdminError)
  })

  it('fails closed when the priceMinor field is dropped entirely', () => {
    const mutated = structuredClone(validPreviewPayload)
    const preview = mutated.preview as Record<string, unknown>
    delete preview.priceMinor
    expect(() => parseMemberRenewalPreviewResponse(mutated)).toThrow(AdminError)
  })
})

describe('purchaseUrl resolution', () => {
  const ADMIN = 'https://admin.example.com'

  it('resolves a relative path only against the confirmed admin origin', () => {
    const resolved = resolveMemberCirclePurchaseUrl('/c/abc?renew=1', ADMIN)
    expect(resolved).toEqual({ ok: true, url: 'https://admin.example.com/c/abc?renew=1' })
  })

  it('accepts an absolute URL that is exactly the confirmed admin origin', () => {
    const resolved = resolveMemberCirclePurchaseUrl(`${ADMIN}/c/abc?renew=1`, ADMIN)
    expect(resolved.ok).toBe(true)
  })

  it('refuses an absolute URL from any other origin (fail closed)', () => {
    const resolved = resolveMemberCirclePurchaseUrl('https://evil.example.com/c/abc', ADMIN)
    expect(resolved).toEqual({ ok: false, reason: 'untrusted_purchase_url_origin' })
  })

  it('refuses non-http schemes', () => {
    const resolved = resolveMemberCirclePurchaseUrl('javascript:%20alert(1)', ADMIN)
    expect(resolved).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })
})

// ---------------------------------------------------------------------------
// Leave (the only member write)
// ---------------------------------------------------------------------------

describe('leave command DTO', () => {
  const validLeavePayload = {
    membership: {
      id: MEMBERSHIP_ID,
      circleId: CIRCLE_ID,
      userId: ACTOR_USER_ID,
      status: 'expired',
      billingKind: 'paid',
      currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      modeTransitionEndsAt: null,
      suspendedReason: null,
      joinedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  }

  it('maps the provider membership with separate membershipId/circleId', () => {
    const parsed = parseMemberLeaveResponse(validLeavePayload)
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID)
    expect(parsed.circleId).toBe(CIRCLE_ID)
    expect(parsed.status).toBe('expired')
    expect(parsed.endedAt).toBe('2026-04-01T00:00:00.000Z')
  })

  it('serializes the strict single-field leave command', () => {
    expect(MEMBER_CIRCLE_LEAVE_COMMAND).toEqual({ action: 'leave_now' })
    expect(Object.keys(MEMBER_CIRCLE_LEAVE_COMMAND)).toEqual(['action'])
  })

  it('fails closed on a replayed/non-active leave response shape', () => {
    expect(() => parseMemberLeaveResponse({})).toThrow(AdminError)
  })
})

// ---------------------------------------------------------------------------
// Original order (raw receipt) and checkout read (authority)
// ---------------------------------------------------------------------------

describe('original order DTO', () => {
  const validOrderPayload = {
    order: {
      id: ORDER_ID,
      status: 'paid',
      amountMinor: 9900,
      currency: 'CNY',
      checkoutUrl: 'https://pay.example.com/qr/abc',
      periodEndAt: '2026-11-01T00:00:00.000Z',
      circle: { id: CIRCLE_ID, name: 'Design Circle' },
    },
    paymentOwner: 'B01',
  }

  it('keeps the stored status as display history with the B01 owner marker', () => {
    const parsed = parseMemberOriginalOrderResponse(validOrderPayload)
    expect(parsed.orderId).toBe(ORDER_ID)
    expect(parsed.storedStatus).toBe('paid')
    expect(parsed.paymentOwner).toBe('B01')
    expect(parsed.circle.circleId).toBe(CIRCLE_ID)
  })

  it('fails closed when paymentOwner is missing', () => {
    const mutated = structuredClone(validOrderPayload) as typeof validOrderPayload
    delete (mutated as Record<string, unknown>).paymentOwner
    expect(() => parseMemberOriginalOrderResponse(mutated)).toThrow(MemberCircleInvalidResponseError)
  })

  it('fails closed on a deviating paymentOwner marker (contract pins B01)', () => {
    const mutated = structuredClone(validOrderPayload) as typeof validOrderPayload
    ;(mutated as Record<string, unknown>).paymentOwner = 'B02'
    expect(() => parseMemberOriginalOrderResponse(mutated)).toThrow(MemberCircleInvalidResponseError)
  })
})

describe('checkout result DTO', () => {
  const validCheckoutPayload = {
    state: 'success',
    orderId: ORDER_ID,
    circleId: CIRCLE_ID,
    circleName: 'Design Circle',
    amountMinor: 9900,
    currency: 'CNY',
    periodDays: null,
    period: {
      kind: 'calendar_year',
      billingCycle: 'year',
      anchorAt: '2026-04-01T00:00:00.000Z',
      periodStartAt: '2026-04-01T00:00:00.000Z',
      periodEndAt: '2027-04-01T00:00:00.000Z',
      projectedPeriodEndAt: '2027-04-01T00:00:00.000Z',
      periodCapEndAt: '2028-04-01T00:00:00.000Z',
      canRenew: true,
      capReason: null,
    },
    periodEndAt: '2027-04-01T00:00:00.000Z',
    membershipPeriodEndAt: null,
    projectedPeriodEndAt: '2027-04-01T00:00:00.000Z',
    periodCapEndAt: '2028-04-01T00:00:00.000Z',
    expiresAt: '2026-04-01T00:15:00.000Z',
    qrIssuedAt: null,
    qrExpiresAt: null,
    codeUrl: null,
    merchantExpiresAt: null,
    providerState: 'paid',
    canRecoverQr: false,
    canReconsent: false,
    recoveryOrderId: ORDER_ID,
    consentVersion: 'v1',
    channel: 'wechat_native',
    currentPriceMinor: 9900,
    replacedByOrderId: null,
    canRetry: false,
  }

  it('parses the authoritative checkout aggregate including calendar periods', () => {
    const parsed = parseMemberCheckoutResultResponse(validCheckoutPayload)
    expect(parsed.state).toBe('success')
    expect(parsed.orderId).toBe(ORDER_ID)
    expect(parsed.period).toEqual({
      kind: 'calendar_year',
      billingCycle: 'year',
      anchorAt: '2026-04-01T00:00:00.000Z',
      periodStartAt: '2026-04-01T00:00:00.000Z',
      periodEndAt: '2027-04-01T00:00:00.000Z',
      projectedPeriodEndAt: '2027-04-01T00:00:00.000Z',
      periodCapEndAt: '2028-04-01T00:00:00.000Z',
      canRenew: true,
      capReason: null,
    })
  })

  it('parses the legacy_days frozen period', () => {
    const mutated = structuredClone(validCheckoutPayload)
    ;(mutated as Record<string, unknown>).period = {
      kind: 'legacy_days',
      periodDays: 30,
      periodEndAt: '2026-05-01T00:00:00.000Z',
    }
    const parsed = parseMemberCheckoutResultResponse(mutated)
    expect(parsed.period).toEqual({
      kind: 'legacy_days',
      periodDays: 30,
      periodEndAt: '2026-05-01T00:00:00.000Z',
    })
  })

  it('fails closed on an unknown checkout state', () => {
    const mutated = structuredClone(validCheckoutPayload)
    ;(mutated as Record<string, unknown>).state = 'maybe'
    expect(() => parseMemberCheckoutResultResponse(mutated)).toThrow(AdminError)
  })
})

// ---------------------------------------------------------------------------
// Error mapping — 401/403/404/409/429/503 stay distinct
// ---------------------------------------------------------------------------

describe('member circle error mapping', () => {
  const adminError = (status: number, errorCode: string) =>
    new AdminError('x', errorCode as never, { status })

  it('maps HTTP statuses to the contract error vocabulary', () => {
    expect(mapMemberCircleApiError(adminError(401, 'UNAUTHORIZED'))).toMatchObject({ code: 'unauthorized', status: 401 })
    expect(mapMemberCircleApiError(adminError(403, 'FORBIDDEN'))).toMatchObject({ code: 'forbidden', status: 403 })
    expect(mapMemberCircleApiError(adminError(404, 'NOT_FOUND'))).toMatchObject({ code: 'not_found', status: 404 })
    expect(mapMemberCircleApiError(adminError(409, 'VALIDATION_ERROR'))).toMatchObject({ code: 'conflict', status: 409 })
    expect(mapMemberCircleApiError(adminError(429, 'VALIDATION_ERROR'))).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(mapMemberCircleApiError(adminError(503, 'SERVER_ERROR'))).toMatchObject({ code: 'service_unavailable', status: 503 })
  })

  it('maps provider validation_error (400) without inventing a conflict', () => {
    expect(mapMemberCircleApiError(adminError(400, 'VALIDATION_ERROR'))).toMatchObject({ code: 'validation_error', status: 400 })
  })

  it('surfaces contract parse failures as invalid_response, never service_unavailable', () => {
    const parseFailure = new MemberCircleInvalidResponseError('unknown membership status')
    expect(parseFailure).toBeInstanceOf(AdminError)
    expect(mapMemberCircleApiError(parseFailure)).toEqual({
      code: 'invalid_response',
      status: null,
      message: getSafeMemberCircleApiErrorMessage('invalid_response'),
    })
  })

  it('throws the dedicated error class from every contract parser', () => {
    expect(() => parseMemberCirclesResponse({})).toThrow(MemberCircleInvalidResponseError)
    expect(() => parseMemberMembershipsResponse(null)).toThrow(MemberCircleInvalidResponseError)
    expect(() => parseMemberRenewalPreviewResponse({})).toThrow(MemberCircleInvalidResponseError)
    expect(() => parseMemberLeaveResponse({})).toThrow(MemberCircleInvalidResponseError)
    expect(() => parseMemberOriginalOrderResponse({})).toThrow(MemberCircleInvalidResponseError)
    expect(() => parseMemberCheckoutResultResponse({})).toThrow(MemberCircleInvalidResponseError)
  })

  it('maps transport failures', () => {
    expect(mapMemberCircleApiError(new AdminError('x', 'TIMEOUT'))).toMatchObject({ code: 'timeout' })
    expect(mapMemberCircleApiError(new AdminError('x', 'NETWORK_ERROR'))).toMatchObject({ code: 'network_error' })
  })

  it('maps foreign errors to unknown instead of a success shape', () => {
    expect(mapMemberCircleApiError(new Error('boom')).code).toBe('unknown')
    expect(mapMemberCircleApiError(undefined).code).toBe('unknown')
  })

  it('never exposes provider error text through the safe message table', () => {
    for (const code of [
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'service_unavailable',
      'invalid_response',
    ] as const) {
      expect(getSafeMemberCircleApiErrorMessage(code)).not.toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Surface guarantees: reads only, no purchase/createOrder API
// ---------------------------------------------------------------------------

describe('member circle client surface', () => {
  it('exposes no purchase/createOrder/grant member API on AdminClient', () => {
    const prototype = AdminClient.prototype as unknown as Record<string, unknown>
    for (const forbidden of [
      'purchaseMemberCircle',
      'createMemberCircleOrder',
      'createMemberCircleRenewalOrder',
      'grantMemberCircleEntitlement',
    ]) {
      expect(prototype[forbidden]).toBeUndefined()
    }
    for (const required of [
      'listMemberCircles',
      'listMemberCircleMemberships',
      'previewMemberCircleRenewal',
      'leaveMemberCircle',
      'getMemberCircleOriginalOrder',
      'getMemberCircleCheckoutResult',
    ]) {
      expect(typeof prototype[required]).toBe('function')
    }
  })

  it('constructs the leave request body from the single strict command', async () => {
    const requests: Array<{ path: string; options: { method: string; body?: unknown } }> = []
    const prototype = AdminClient.prototype as unknown as Record<string, unknown>
    const originalRequest = prototype['request']
    prototype['request'] = function (
      this: unknown,
      path: string,
      options: { method: string; body?: unknown },
    ) {
      requests.push({ path, options })
      return Promise.resolve({
        membership: {
          id: MEMBERSHIP_ID,
          circleId: CIRCLE_ID,
          userId: ACTOR_USER_ID,
          status: 'expired',
          billingKind: 'paid',
          currentPeriodEnd: null,
          modeTransitionEndsAt: null,
          suspendedReason: null,
          joinedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      })
    }
    try {
      const client = new AdminClient('https://admin.example.com')
      const membership = await client.leaveMemberCircle('token-1', MEMBERSHIP_ID)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.path).toBe(`/api/me/circle-memberships/${MEMBERSHIP_ID}`)
      expect(requests[0]!.options.method).toBe('PATCH')
      expect(requests[0]!.options.body).toEqual({ action: 'leave_now' })
      expect(membership.membershipId).toBe(MEMBERSHIP_ID)
    } finally {
      prototype['request'] = originalRequest
    }
  })
})
