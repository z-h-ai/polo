/**
 * useCircleReturn tests (POO-70 C8 / P70-RETURN-01/02) + the pure
 * circle-return-target helpers.
 *
 * Coverage required by the card (证明完成): malicious candidate / wrong
 * account / original target after password+code re-login / cold start /
 * original order NOT in the recent-5 list / unknown / double-click / support
 * failure is S1's surface (asserted here only as "no support affordance is
 * fabricated"), plus: event/read dedup by candidateId per scope, ack timing
 * (only after a definitive locate), cancel, unavailable mirror retry,
 * no auto-loop on read errors, paid-alone never grants (G5), and scope
 * re-verification after an account switch.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type {
  MemberCircleCheckoutResult,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'
import type { CircleReturnCandidate } from '@polo-ai/shared/protocol'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

GlobalRegistrator.register()
setupI18n()

// ---------------------------------------------------------------------------
// ProductSpace context double (identity/epoch source)
// ---------------------------------------------------------------------------

interface SpaceContextOverrides {
  accountId?: string | null
  personalProductSpaceId?: string | null
  contextVersion?: number
  spaceKind?: 'personal' | 'enterprise'
}

function spaceContext(overrides: SpaceContextOverrides = {}) {
  const accountId = overrides.accountId === undefined ? 'account-a' : overrides.accountId
  const personalId = overrides.personalProductSpaceId === undefined ? 'personal-space' : overrides.personalProductSpaceId
  const epoch = overrides.contextVersion ?? 1
  const kind = overrides.spaceKind ?? 'personal'
  if (!accountId || !personalId) return null
  const activeId = kind === 'enterprise' ? 'enterprise-space' : personalId
  return {
    accountId,
    activeProductSpaceId: activeId,
    personalProductSpaceId: personalId,
    productSpaceContextKey: createProductSpaceContextKey(accountId, activeId),
    contextVersion: epoch,
    activeProductSpace: {
      id: activeId,
      kind,
      name: kind === 'enterprise' ? '企业空间' : '我的空间',
      accessMode: 'active',
    },
  }
}

let productSpaceContextState: ReturnType<typeof spaceContext> = spaceContext()

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

// ---------------------------------------------------------------------------
// B1 bridge double (circleReturn + typed event)
// ---------------------------------------------------------------------------

type PendingState =
  | { status: 'pending'; candidate: CircleReturnCandidate }
  | { status: 'none' }
  | { status: 'unavailable'; reason: 'session_unavailable' }

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_M = '33333333-3333-4333-8333-333333333333'
const UUID_O = '44444444-4444-4444-8444-444444444444'
const UUID_TOP5 = '55555555-5555-4555-8555-555555555555'

let candidateSeq = 0

function bridgeCandidate(overrides: Partial<CircleReturnCandidate> = {}): CircleReturnCandidate {
  candidateSeq += 1
  return {
    candidateId: `candidate-${candidateSeq}`,
    protocolVersion: 1,
    target: { circleId: UUID_A, membershipId: UUID_M, orderId: UUID_O },
    createdAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  }
}

const bridgeCounts = { getPending: 0, ack: 0, cancel: 0 }

let pendingQueue: PendingState[] = []
let eventSubscriber: ((candidate: CircleReturnCandidate) => void) | null = null
const ackedIds: string[] = []
const cancelledIds: string[] = []

function installBridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      circleReturn: {
        getPending: () => {
          bridgeCounts.getPending += 1
          return Promise.resolve(pendingQueue.shift() ?? { status: 'none' })
        },
        ack: (candidateId: string) => {
          bridgeCounts.ack += 1
          ackedIds.push(candidateId)
          return Promise.resolve({ status: 'acked' })
        },
        cancel: (candidateId: string) => {
          bridgeCounts.cancel += 1
          cancelledIds.push(candidateId)
          return Promise.resolve({ status: 'cancelled' })
        },
      },
      onCircleReturnCandidate: (callback: (candidate: CircleReturnCandidate) => void) => {
        eventSubscriber = callback
        return () => {
          eventSubscriber = null
        }
      },
    },
  })
}

function emitEvent(candidate: CircleReturnCandidate) {
  eventSubscriber?.(candidate)
}

function resetBridge() {
  pendingQueue = []
  ackedIds.length = 0
  cancelledIds.length = 0
  bridgeCounts.getPending = 0
  bridgeCounts.ack = 0
  bridgeCounts.cancel = 0
}

// ---------------------------------------------------------------------------
// C2 resource double (authoritative read surface)
// ---------------------------------------------------------------------------

interface ResourceDouble {
  memberships: MemberMembership[]
  calls: { invalidate: number; getOrder: number; getCheckoutResult: number }
  invalidateHints: Array<{ circleId?: string; orderId?: string }>
  orderImpl: (orderId: string) => Promise<unknown>
  checkoutImpl: (orderId: string) => Promise<unknown>
  invalidateImpl: (hint: { circleId?: string; orderId?: string }) => Promise<unknown>
}

function membershipWithRecent5(circleId: string, overrides: Partial<MemberMembership> = {}): MemberMembership {
  return {
    membershipId: UUID_M,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    // Provider take:5 — the ORIGINAL order (UUID_O) is deliberately NOT here.
    paymentOrders: [1, 2, 3, 4, 5].map(index => ({
      orderId: `${UUID_TOP5.slice(0, -1)}${index}`,
      storedStatus: 'paid',
      amountMinor: 9900,
      currency: 'CNY',
      effectivePaymentStatus: 'paid',
      correction: null,
    })),
    circle: {
      circleId,
      name: '晨星设计圈',
      purpose: '',
      status: 'active',
      joinMode: 'paid',
      membershipPriceMinor: 9900,
      membershipCurrency: 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
    ...overrides,
  }
}

function originalOrder(orderId: string = UUID_O): OriginalCircleOrder {
  return {
    orderId,
    storedStatus: 'paid', // display history ONLY — never a grant (G5)
    amountMinor: 9900,
    currency: 'CNY',
    checkoutUrl: 'https://checkout.example/pay',
    periodEndAt: '2026-11-01T00:00:00.000Z',
    circle: { circleId: UUID_A, name: '晨星设计圈' },
    paymentOwner: 'B01',
  }
}

function checkoutResult(state: MemberCircleCheckoutResult['state']): MemberCircleCheckoutResult {
  return {
    state,
    orderId: UUID_O,
    circleId: UUID_A,
    circleName: '晨星设计圈',
    amountMinor: 9900,
    currency: 'CNY',
    periodDays: null,
    period: null,
    periodEndAt: '2026-11-01T00:00:00.000Z',
    membershipPeriodEndAt: '2026-11-01T00:00:00.000Z',
    projectedPeriodEndAt: '2026-11-01T00:00:00.000Z',
    periodCapEndAt: null,
    expiresAt: null,
    qrIssuedAt: null,
    qrExpiresAt: null,
    codeUrl: null,
    merchantExpiresAt: null,
    providerState: null,
    canRecoverQr: null,
    canReconsent: null,
    recoveryOrderId: null,
    consentVersion: null,
    channel: null,
    currentPriceMinor: null,
    replacedByOrderId: null,
    canRetry: null,
  }
}

function makeResourceDouble(overrides: Partial<ResourceDouble> = {}): ResourceDouble {
  const resource: ResourceDouble = {
    memberships: [membershipWithRecent5(UUID_A)],
    calls: { invalidate: 0, getOrder: 0, getCheckoutResult: 0 },
    invalidateHints: [],
    orderImpl: () => Promise.resolve({ success: true, order: originalOrder() }),
    checkoutImpl: () => Promise.resolve({ success: true, checkout: checkoutResult('success') }),
    invalidateImpl: () => Promise.resolve({ relations: 'refreshed', catalog: 'unavailable', circleId: null, orderId: null }),
    ...overrides,
  }
  // Wire live call counters AFTER overrides so they cannot be stubbed away.
  const orderImpl = resource.orderImpl
  const checkoutImpl = resource.checkoutImpl
  const invalidateImpl = resource.invalidateImpl
  resource.orderImpl = orderId => {
    resource.calls.getOrder += 1
    return orderImpl(orderId)
  }
  resource.checkoutImpl = orderId => {
    resource.calls.getCheckoutResult += 1
    return checkoutImpl(orderId)
  }
  resource.invalidateImpl = hint => {
    resource.calls.invalidate += 1
    resource.invalidateHints.push({ ...hint })
    return invalidateImpl(hint)
  }
  return resource
}

function asResource(double: ResourceDouble) {
  return {
    state: {
      phase: 'ready' as const,
      scope: null,
      circles: [],
      memberships: double.memberships,
      circlesError: null,
      membershipsError: null,
      refreshing: false,
      updatedAt: null,
    },
    circles: [],
    memberships: double.memberships,
    updateStates: {},
    profileStates: {},
    supportState: null,
    getCircle: () => ({ availability: 'unknown_circle' as const }),
    refresh: () => Promise.resolve({ skipped: true as const, reason: 'no_scope' as const }),
    invalidateAndRefresh: (hint: { circleId?: string; orderId?: string }) =>
      double.invalidateImpl(hint) as Promise<{ relations: 'refreshed' | 'partial' | 'failed' | 'skipped'; catalog: 'refreshed' | 'pending' | 'failed' | 'unavailable'; circleId: string | null; orderId: string | null }>,
    previewRenewal: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    leave: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    getOrder: (orderId: string) => double.orderImpl(orderId) as Promise<{ success: true; order: OriginalCircleOrder } | { success: false; errorCode: string; message: string }>,
    getCheckoutResult: (orderId: string) => double.checkoutImpl(orderId) as Promise<{ success: true; checkout: MemberCircleCheckoutResult } | { success: false; errorCode: string; message: string }>,
    getUpdates: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    refreshUpdates: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    getProfile: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    getSupport: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
    refreshSupport: () => Promise.resolve({ success: false as const, errorCode: 'unknown' as const, message: 'not used' }),
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} = await import('@testing-library/react')
const { useCircleReturn } = await import('../useCircleReturn')
const { CircleReturnPanel } = await import('@/components/circles/CircleReturnPanel')
const {
  circleReturnConsumptionKey,
  circleReturnScopeKey,
  circleReturnTargetKind,
  deriveCircleReturnRoute,
  deriveCircleReturnVerdict,
  deriveMembershipEntitlementState,
  normalizeCircleReturnTarget,
  sameCircleReturnTarget,
} = await import('@/lib/circle-return-target')

beforeEach(() => {
  productSpaceContextState = spaceContext()
  resetBridge()
  installBridge()
})

afterEach(() => {
  cleanup()
})

interface RenderReturnProps {
  bridge?: unknown
  onReauthenticateRequest?: (target: unknown) => void
}

function renderReturn(bridge: unknown, resource: ResourceDouble, props: { candidate?: unknown } = {}) {
  return renderHook((rerenderProps: RenderReturnProps = {}) => useCircleReturn({
    resource: asResource(resource),
    bridge: (rerenderProps.bridge ?? bridge) as never,
    candidate: (props.candidate ?? null) as never,
    ...(rerenderProps.onReauthenticateRequest
      ? { onReauthenticateRequest: rerenderProps.onReauthenticateRequest as never }
      : {}),
  }))
}

async function waitForPhase(hook: ReturnType<typeof renderReturn>, phase: string, timeout = 1000) {
  await waitFor(() => {
    if (hook.result.current.state.phase !== phase) {
      throw new Error(`phase is ${hook.result.current.state.phase}, expected ${phase}`)
    }
  }, { timeout })
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('circle-return-target helpers', () => {
  it('normalizes strictly-valid ids and drops invalid ones (fail closed)', () => {
    expect(normalizeCircleReturnTarget({ circleId: UUID_A, orderId: 'not-a-uuid' }))
      .toEqual({ circleId: UUID_A })
    expect(normalizeCircleReturnTarget({ circleId: 'DROP TABLE' })).toBeNull()
    expect(normalizeCircleReturnTarget(null)).toBeNull()
    expect(normalizeCircleReturnTarget('poloai://circle-return')).toBeNull()
  })

  it('classifies order vs circle targets and rejects unaddressable ones', () => {
    expect(circleReturnTargetKind({ orderId: UUID_O })).toBe('order')
    expect(circleReturnTargetKind({ circleId: UUID_A })).toBe('circle')
    expect(circleReturnTargetKind({ membershipId: UUID_M })).toBe('circle')
    expect(circleReturnTargetKind({})).toBe('invalid')
    expect(circleReturnTargetKind(null)).toBe('invalid')
  })

  it('derives the original-object route (order → subscription section)', () => {
    expect(deriveCircleReturnRoute({ target: { circleId: UUID_A }, order: null, checkout: null }))
      .toEqual({ kind: 'circle-detail', circleId: UUID_A, section: 'content' })
    expect(deriveCircleReturnRoute({
      target: { orderId: UUID_O },
      order: originalOrder(),
      checkout: null,
    })).toEqual({ kind: 'circle-detail', circleId: UUID_A, section: 'subscription' })
    expect(deriveCircleReturnRoute({ target: { membershipId: UUID_M }, order: null, checkout: null }))
      .toBeNull()
  })

  it('keys consumption by scope+candidateId so a re-anchor re-consumes', () => {
    expect(circleReturnConsumptionKey('scope-1', 'c1')).toBe('scope-1::c1')
    expect(circleReturnConsumptionKey('scope-2', 'c1')).not.toBe(circleReturnConsumptionKey('scope-1', 'c1'))
    expect(circleReturnScopeKey({ accountId: 'a', personalProductSpaceId: 'p', contextKey: 'k', epoch: 1 })).toBeTypeOf('string')
    expect(circleReturnScopeKey({ accountId: null, personalProductSpaceId: 'p', contextKey: 'k', epoch: 1 })).toBeNull()
  })

  it('sameCircleReturnTarget compares structurally', () => {
    expect(sameCircleReturnTarget({ circleId: UUID_A }, { circleId: UUID_A })).toBe(true)
    expect(sameCircleReturnTarget({ circleId: UUID_A }, { circleId: UUID_B })).toBe(false)
    expect(sameCircleReturnTarget(null, null)).toBe(true)
  })

  it('membership entitlement follows the correction-aware projection (G5)', () => {
    const paidStored = membershipWithRecent5(UUID_A)
    expect(deriveMembershipEntitlementState(paidStored)).toBe('valid')
    // Refunded correction invalidates even though the stored status says paid.
    const refunded = membershipWithRecent5(UUID_A, {
      paymentOrders: [{
        orderId: UUID_TOP5,
        storedStatus: 'paid',
        amountMinor: 9900,
        currency: 'CNY',
        effectivePaymentStatus: 'refunded',
        correction: { kind: 'refund', amountMinor: 9900, partial: false, refundAmountMinor: 9900, chargebackAmountMinor: 0 },
      }],
    })
    expect(deriveMembershipEntitlementState(refunded)).toBe('invalid')
    const suspended = membershipWithRecent5(UUID_A, { status: 'suspended' })
    expect(deriveMembershipEntitlementState(suspended)).toBe('invalid')
    expect(deriveMembershipEntitlementState(null)).toBe('unknown')
  })

  it('verdict: same-shape 404 on the original order is an account mismatch', () => {
    const verdict = deriveCircleReturnVerdict({
      kind: 'order',
      order: null,
      orderReadFailed: true,
      orderErrorCode: 'not_found',
      checkout: null,
      checkoutReadFailed: false,
      checkoutErrorCode: null,
      relations: 'refreshed',
      membership: null,
    })
    expect(verdict.accountMismatch).toBe(true)
    expect(verdict.retryable).toBe(false)
  })

  it('verdict: stored paid alone never grants — unknown checkout stays unknown', () => {
    const verdict = deriveCircleReturnVerdict({
      kind: 'order',
      order: originalOrder(), // storedStatus 'paid'
      orderReadFailed: false,
      orderErrorCode: null,
      checkout: null,
      checkoutReadFailed: true,
      checkoutErrorCode: 'network_error',
      relations: 'refreshed',
      membership: membershipWithRecent5(UUID_A),
    })
    expect(verdict.accountMismatch).toBe(false)
    expect(verdict.entitlementState).toBe('unknown')
    expect(verdict.retryable).toBe(true)
  })

  it('verdict: circle-only refreshed relations without the membership is a mismatch', () => {
    const verdict = deriveCircleReturnVerdict({
      kind: 'circle',
      order: null,
      orderReadFailed: false,
      orderErrorCode: null,
      checkout: null,
      checkoutReadFailed: false,
      checkoutErrorCode: null,
      relations: 'refreshed',
      membership: null,
    })
    expect(verdict.accountMismatch).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B1 delivery: cold start, event/read dedup, malicious candidates
// ---------------------------------------------------------------------------

describe('useCircleReturn — B1 candidate delivery', () => {
  it('cold start consumes the pending candidate from getPending (event-first registration)', async () => {
    const candidate = bridgeCandidate()
    pendingQueue = [{ status: 'pending', candidate }]
    const resource = makeResourceDouble()
    lastResource = resource
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    expect(hook.result.current.state.candidateId).toBe(candidate.candidateId)
    expect(hook.result.current.state.target).toEqual(candidate.target)
    expect(hook.result.current.state.kind).toBe('order')
    // Event subscription was registered (before the read consumed it).
    expect(eventSubscriber).not.toBeNull()
    // No authoritative read runs on delivery alone (click-driven only).
    expect(resource.calls.invalidate).toBe(0)
  })

  it('event/read interleaving consumes exactly once per scope (dedup by candidateId)', async () => {
    const candidate = bridgeCandidate()
    pendingQueue = [{ status: 'pending', candidate }]
    const hook = renderReturn(window.electronAPI, makeResourceDouble())
    await waitForPhase(hook, 'candidate')

    // Move to verified, then replay the SAME candidate through the typed
    // event — dedup must keep the verified state (no re-consumption).
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
    emitEvent(candidate)
    await act(async () => {})
    expect(hook.result.current.state.phase).toBe('verified')
  })

  it('re-delivery under a NEW scope re-consumes and re-verifies (account switch)', async () => {
    const candidate = bridgeCandidate()
    pendingQueue = [{ status: 'pending', candidate }]
    const hook = renderReturn(window.electronAPI, makeResourceDouble())
    await waitForPhase(hook, 'candidate')

    // Account B signs in (epoch bump): the old scope's facts die, the target
    // is retained, and the re-anchored pending read re-delivers.
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    pendingQueue = [{ status: 'pending', candidate }]
    await act(async () => {
      hook.rerender()
    })
    await waitForPhase(hook, 'candidate')
    expect(hook.result.current.state.target).toEqual(candidate.target)
    expect(hook.result.current.state.orderFacts).toBeNull()
  })

  it('malicious candidates are consumed without being surfaced', async () => {
    const hook = renderReturn(window.electronAPI, makeResourceDouble())
    emitEvent(bridgeCandidate({
      candidateId: 'evil-1',
      target: { circleId: "'; DROP TABLE circles; --" },
    }))
    emitEvent(bridgeCandidate({ candidateId: 'evil-2', target: {} }))
    await act(async () => {})
    expect(hook.result.current.state.phase).toBe('idle')
    expect(hook.result.current.state.target).toBeNull()
  })

  it('unavailable mirror retries the READ instead of consuming, then delivers', async () => {
    pendingQueue = [
      { status: 'unavailable', reason: 'session_unavailable' },
      { status: 'unavailable', reason: 'session_unavailable' },
      { status: 'pending', candidate: bridgeCandidate() },
    ]
    const hook = renderReturn(window.electronAPI, makeResourceDouble())
    await waitForPhase(hook, 'candidate', 5000)
    expect(bridgeCounts.getPending).toBe(3)
  }, 10000)
})

// ---------------------------------------------------------------------------
// ONE authoritative round per click (P70-RETURN-02)
// ---------------------------------------------------------------------------

let lastResource: ResourceDouble | null = null

describe('useCircleReturn — checkOnce (one round, order path)', () => {
  it('runs ONE round: invalidate hint carries circleId+orderId; original order is fetched by id, never from the recent-5', async () => {
    const candidateRef = bridgeCandidate()
    pendingQueue = [{ status: 'pending', candidate: candidateRef }]
    const resource = makeResourceDouble()
    lastResource = resource
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')

    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')

    expect(resource.calls.invalidate).toBe(1)
    expect(resource.invalidateHints[0]).toEqual({ circleId: UUID_A, orderId: UUID_O })
    expect(resource.calls.getOrder).toBe(1)
    // The located ORIGINAL object — the membership's take:5 rows never
    // substitute for it (none of them carries UUID_O).
    expect(hook.result.current.state.orderFacts?.order.orderId).toBe(UUID_O)
    // storedStatus 'paid' + authoritative checkout success + membership row
    // → valid; the raw paid status alone would not have granted.
    expect(hook.result.current.state.entitlement).toBe('valid')
    // Definitive locate under this account → acked exactly once.
    await waitFor(() => {
      if (bridgeCounts.ack !== 1) throw new Error('ack not settled')
    })
    expect(ackedIds).toEqual([candidateRef.candidateId])
  })

  it('merges a double-click into ONE round (no second authoritative read)', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const resource = makeResourceDouble({
      checkoutImpl: () => new Promise(resolve => setTimeout(() => resolve({ success: true, checkout: checkoutResult('success') }), 20)),
    })
    lastResource = resource
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')

    const first = act(async () => { await hook.result.current.checkOnce() })
    const second = act(async () => { await hook.result.current.checkOnce() })
    await Promise.all([first, second])
    await waitForPhase(hook, 'verified')
    expect(resource.calls.invalidate).toBe(1)
    expect(resource.calls.getOrder).toBe(1)
    expect(resource.calls.getCheckoutResult).toBe(1)
  })

  it('wrong account: same-shape 404 → mismatch, NO disclosure, no ack; re-login re-checks the ORIGINAL object', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    let orderBehavior: (orderId: string) => Promise<unknown> = () =>
      Promise.resolve({ success: false, errorCode: 'not_found', message: 'same-shape 404' })
    const resource = makeResourceDouble({
      orderImpl: orderId => orderBehavior(orderId),
    })
    lastResource = resource
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')

    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'account-mismatch')
    // Fail closed: nothing about the object this account cannot see.
    expect(hook.result.current.state.orderFacts).toBeNull()
    expect(hook.result.current.state.entitlement).toBeNull()
    // A definitive negative for THIS account is not a locate — no ack.
    expect(bridgeCounts.ack).toBe(0)

    // Proactive re-login (password/code) → new epoch; the candidate target
    // survives in memory and re-checks the SAME original object.
    productSpaceContextState = spaceContext({ accountId: 'account-a', contextVersion: 9 })
    orderBehavior = () => Promise.resolve({ success: true, order: originalOrder() })
    await act(async () => {
      hook.rerender()
    })
    await waitForPhase(hook, 'candidate')
    expect(hook.result.current.state.target).toEqual({ circleId: UUID_A, membershipId: UUID_M, orderId: UUID_O })

    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
    expect(resource.calls.getOrder).toBe(2) // re-queried the original object
    expect(hook.result.current.state.orderFacts?.order.orderId).toBe(UUID_O)
  })

  it('unknown stays retryable, never grants: paid storedStatus + unsettled checkout', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const resource = makeResourceDouble({
      checkoutImpl: () => Promise.resolve({ success: true, checkout: checkoutResult('processing') }),
    })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    // The order itself WAS located (this account's object) — displayed with
    // an explicitly unknown entitlement and a retry affordance.
    await waitForPhase(hook, 'verified')
    expect(hook.result.current.state.entitlement).toBe('unknown')
    expect(hook.result.current.state.orderFacts?.order.storedStatus).toBe('paid')
    expect(hook.result.current.state.orderFacts?.checkoutUnknown).toBe(true)
    // A recheck click is accepted (retryable) — no lock-out.
    resource.checkoutImpl = () => Promise.resolve({ success: true, checkout: checkoutResult('success') })
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    expect(hook.result.current.state.entitlement).toBe('valid')
  })

  it('authoritative failed checkout is invalid even when the stored status says paid (G5)', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const resource = makeResourceDouble({
      checkoutImpl: () => Promise.resolve({ success: true, checkout: checkoutResult('failed') }),
    })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
    expect(hook.result.current.state.entitlement).toBe('invalid')
  })

  it('read errors do not auto-loop: one round stays failed until the user clicks again', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    let orderBehavior: (orderId: string) => Promise<unknown> = () =>
      Promise.resolve({ success: false, errorCode: 'network_error', message: 'down' })
    const resource = makeResourceDouble({
      orderImpl: orderId => orderBehavior(orderId),
    })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'failed')
    expect(hook.result.current.state.failure).toBe('read-failed')
    const callsAfterFirstRound = resource.calls.getOrder
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(resource.calls.getOrder).toBe(callsAfterFirstRound) // no auto-loop
    // Explicit retry recovers.
    orderBehavior = () => Promise.resolve({ success: true, order: originalOrder() })
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
  })

  it('relations partial: order located but joint judgment stays unknown and retryable (关系已变待核对)', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const resource = makeResourceDouble({
      invalidateImpl: () => Promise.resolve({ relations: 'partial', catalog: 'pending', circleId: UUID_A, orderId: UUID_O }),
    })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    // The original order object IS this account's and stays on screen
    // (留原对象), but the membership cross-check is not current — the
    // entitlement is explicitly unknown, never guessed into valid.
    await waitForPhase(hook, 'verified')
    expect(hook.result.current.state.entitlement).toBe('unknown')
    expect(hook.result.current.state.orderFacts?.order.orderId).toBe(UUID_O)
    // The checkout read itself answered; the JOINT judgment is what's unknown.
    expect(hook.result.current.state.orderFacts?.checkoutUnknown).toBe(false)
    // A recheck click completes the joint judgment once relations settle.
    resource.invalidateImpl = () => Promise.resolve({ relations: 'refreshed', catalog: 'refreshed', circleId: UUID_A, orderId: UUID_O })
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    expect(hook.result.current.state.entitlement).toBe('valid')
  })

  it('relations partial with NO located object stays a retryable failure', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate({ target: { circleId: UUID_A } }) }]
    const resource = makeResourceDouble({
      invalidateImpl: () => Promise.resolve({ relations: 'failed', catalog: 'failed', circleId: UUID_A, orderId: null }),
    })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'failed')
    expect(hook.result.current.state.failure).toBe('relations-changed')
    expect(hook.result.current.state.orderFacts).toBeNull()
    // The candidate stays pending (no ack, no cancel) — a later click can finish it.
    expect(bridgeCounts.ack).toBe(0)
    expect(bridgeCounts.cancel).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Circle-only returns + cancel/reauthenticate + scope fencing
// ---------------------------------------------------------------------------

describe('useCircleReturn — circle-only return, cancel, reauthenticate', () => {
  it('circle-only candidate verifies from the refreshed relations (no order reads)', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate({ target: { circleId: UUID_A } }) }]
    const resource = makeResourceDouble()
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
    expect(hook.result.current.state.kind).toBe('circle')
    expect(hook.result.current.state.entitlement).toBe('valid')
    expect(hook.result.current.state.orderFacts).toBeNull() // 有原orderId才显示原订单
    expect(resource.calls.getOrder).toBe(0)
    expect(resource.calls.getCheckoutResult).toBe(0)
    // B1 事件无目标时仅刷新我的圈子（relations/catalog round-trip）。
    expect(resource.calls.invalidate).toBe(1)
    expect(resource.invalidateHints[0]).toEqual({ circleId: UUID_A })
  })

  it('circle-only: refreshed relations without the membership → mismatch, reauthenticate surfaces the target', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate({ target: { circleId: UUID_A } }) }]
    const resource = makeResourceDouble({ memberships: [] })
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'account-mismatch')

    // reauthenticate keeps the minimal candidate in memory and hands the
    // existing A1 auth chain the target (no persistence, no secrets).
    let requested: unknown = 'not-called'
    hook.rerender({ onReauthenticateRequest: (target: unknown) => { requested = target } })
    await act(async () => {
      hook.result.current.reauthenticate()
    })
    expect(hook.result.current.state.phase).toBe('candidate')
    expect(hook.result.current.state.target).toEqual({ circleId: UUID_A })
    expect(requested).toEqual({ circleId: UUID_A })
  })

  it('cancel clears locally and releases Main candidate exactly once', async () => {
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const hook = renderReturn(window.electronAPI, makeResourceDouble())
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.cancel()
    })
    expect(hook.result.current.state.phase).toBe('idle')
    expect(hook.result.current.state.target).toBeNull()
    expect(bridgeCounts.cancel).toBe(1)
    expect(cancelledIds).toHaveLength(1)
  })

  it('session-less scope fails the round retryable (no definitive negative)', async () => {
    productSpaceContextState = null
    pendingQueue = [{ status: 'pending', candidate: bridgeCandidate() }]
    const resource = makeResourceDouble()
    const hook = renderReturn(window.electronAPI, resource)
    await waitForPhase(hook, 'candidate')
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'failed')
    expect(hook.result.current.state.failure).toBe('session-unavailable')
    expect(resource.calls.invalidate).toBe(0)
  })

  it('explicit candidate works without any bridge (local original-object record)', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
    const resource = makeResourceDouble()
    const hook = renderReturn(null, resource, { candidate: { circleId: UUID_A, orderId: UUID_O } })
    await waitForPhase(hook, 'candidate')
    expect(hook.result.current.state.candidateId).toBeNull()
    await act(async () => {
      await hook.result.current.checkOnce()
    })
    await waitForPhase(hook, 'verified')
    expect(hook.result.current.state.orderFacts?.order.orderId).toBe(UUID_O)
    expect(bridgeCounts.ack).toBe(0) // nothing to ack without a bridge handle
  })
})

// ---------------------------------------------------------------------------
// CircleReturnPanel display guarantees (same owned test module; the panel is
// a pure projection of the hook state — no data source of its own)
// ---------------------------------------------------------------------------

function candidateState(kind: 'order' | 'circle'): import('../useCircleReturn').CircleReturnState {
  return {
    phase: 'candidate',
    target: kind === 'order' ? { circleId: UUID_A, orderId: UUID_O } : { circleId: UUID_A },
    candidateId: 'candidate-x',
    kind,
    orderFacts: null,
    entitlement: null,
    failure: null,
    checking: false,
    scopeKey: 'scope',
  }
}

function renderPanel(state: import('../useCircleReturn').CircleReturnState, overrides: Partial<Parameters<typeof CircleReturnPanel>[0]> = {}) {
  return render(createElement(I18nextProvider, { i18n }, createElement(CircleReturnPanel, {
    state,
    onCheck: () => {},
    onReauthenticate: () => {},
    onCancel: () => {},
    ...overrides,
  })))
}

describe('CircleReturnPanel display guarantees', () => {
  it('renders nothing when no candidate is surfaced', () => {
    const { container } = renderPanel({ ...candidateState('order'), phase: 'idle', target: null, kind: null })
    expect(container.querySelectorAll('[data-testid]')).toHaveLength(0)
    expect(screen.queryByTestId('circle-return-panel')).toBeNull()
  })

  it('candidate (order): shows the original order id fact and the check action', () => {
    renderPanel(candidateState('order'))
    expect(screen.getByTestId('circle-return-panel').getAttribute('data-return-kind')).toBe('order')
    expect(screen.getByTestId('circle-return-fact-order-id').textContent).toContain(UUID_O)
    expect(screen.getByTestId('circle-return-fact-next-step')).toBeTruthy()
    expect(screen.getByTestId('circle-return-check')).toBeTruthy()
    expect(screen.getByTestId('circle-return-back')).toBeTruthy()
  })

  it('mismatch: renders the permission state INSTEAD of any object fact (no disclosure)', () => {
    renderPanel({
      ...candidateState('order'),
      phase: 'account-mismatch',
      orderFacts: null,
      entitlement: null,
    })
    expect(screen.getByTestId('circle-return-reauthenticate')).toBeTruthy()
    expect(screen.queryByTestId('circle-return-facts')).toBeNull()
    expect(screen.queryByTestId('circle-return-order')).toBeNull()
    expect(screen.queryByTestId('circle-return-check')).toBeNull()
    expect(screen.queryByText(UUID_O)).toBeNull()
  })

  it('verified (order): shows the located original order with stored status labelled as history', () => {
    renderPanel({
      ...candidateState('order'),
      phase: 'verified',
      entitlement: 'valid',
      orderFacts: {
        order: originalOrder(),
        storedStatusIsHistoryOnly: true,
        checkout: checkoutResult('success'),
        checkoutUnknown: false,
      },
    })
    expect(screen.getByTestId('circle-return-order')).toBeTruthy()
    expect(screen.getByTestId('circle-return-order-status').textContent).toContain('paid')
    const entitlementText = screen.getByTestId('circle-return-fact-entitlement-value').textContent ?? ''
    expect(entitlementText.length).toBeGreaterThan(0)
    expect(entitlementText).not.toContain('待查询')
    expect(entitlementText.toLowerCase()).not.toContain('not checked')
    expect(screen.getByTestId('circle-return-open')).toBeTruthy()
    // No retry in a definitive state.
    expect(screen.queryByTestId('circle-return-retry')).toBeNull()
  })

  it('unknown entitlement keeps the retry affordance; failed state offers recheck', () => {
    const { unmount } = renderPanel({
      ...candidateState('order'),
      phase: 'verified',
      entitlement: 'unknown',
      orderFacts: {
        order: originalOrder(),
        storedStatusIsHistoryOnly: true,
        checkout: null,
        checkoutUnknown: true,
      },
    })
    expect(screen.getByTestId('circle-return-retry')).toBeTruthy()
    expect(screen.getByTestId('circle-return-unknown-note')).toBeTruthy()
    unmount()

    renderPanel({ ...candidateState('circle'), phase: 'failed', failure: 'read-failed' })
    expect(screen.getByTestId('circle-return-failed')).toBeTruthy()
    expect(screen.getByTestId('circle-return-retry')).toBeTruthy()
    expect(screen.queryByTestId('circle-return-open')).toBeNull()
  })

  it('no state offers join/pay/open-app/enable-skill or support affordances (read-only surface)', () => {
    const states: Array<import('../useCircleReturn').CircleReturnState> = [
      candidateState('order'),
      candidateState('circle'),
      { ...candidateState('order'), phase: 'checking', checking: true },
      { ...candidateState('order'), phase: 'failed', failure: 'read-failed' },
      { ...candidateState('circle'), phase: 'account-mismatch' },
      {
        ...candidateState('order'),
        phase: 'verified',
        entitlement: 'valid',
        orderFacts: { order: originalOrder(), storedStatusIsHistoryOnly: true, checkout: checkoutResult('success'), checkoutUnknown: false },
      },
    ]
    for (const state of states) {
      const { container, unmount } = renderPanel(state)
      const buttons = Array.from(container.querySelectorAll('button'))
      for (const button of buttons) {
        const text = button.textContent ?? ''
        expect(text.includes('加入')).toBe(false)
        expect(text.includes('支付')).toBe(false)
        expect(text.includes('付款')).toBe(false)
        expect(text.includes('启用')).toBe(false)
        expect(text.toLowerCase().includes('open polo')).toBe(false)
        expect(text.includes('客服')).toBe(false) // support lives in S1/G4
      }
      unmount()
    }
  })
})
