import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MemberCircleCheckoutResult,
  MemberMembership,
  OriginalCircleOrder,
} from '@polo-ai/shared/admin'
import type { CircleReturnCandidate, CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import type { MemberCirclesResource } from '@/hooks/useMemberCircles'
import {
  circleReturnConsumptionKey,
  circleReturnScopeKey,
  circleReturnTargetKind,
  deriveCircleReturnVerdict,
  heldCandidateFromBridge,
  heldCandidateFromExplicit,
  sameCircleReturnTarget,
  type CircleReturnScopeIdentity,
  type HeldCircleReturnCandidate,
} from '@/lib/circle-return-target'

/**
 * Circle-return verification hook (POO-70 C8 / P70-RETURN-01/02).
 *
 * The desktop-side proactive verification after a web join/payment. The B1
 * bridge delivers ONE pending navigation candidate (ids only — never an
 * authorization, never evidence); this hook presents it and, ONLY on the
 * user's click, runs ONE round of authoritative reads against the C2 trusted
 * resource and the F1 reads. Nothing auto-joins, auto-pays, opens the app or
 * enables a skill, and a failed read never auto-loops (P70-RETURN-01/02).
 *
 * B1 consumption contract (event-first, P70-RETURN-BRIDGE-03): the typed
 * candidate event subscription is registered BEFORE the `getPending()` read,
 * and consumption dedups on a candidateId+scope key, so any event/read
 * interleaving surfaces the candidate exactly once per identity scope.
 * Delivery is gated by the A4 mirror: `unavailable` RETRIES the read (never
 * consumes, never mutates). `ack` fires only after a definitive locate under
 * the current account; `cancel` is the user declining. An account switch
 * re-anchors the candidate in Main — the scope-fenced dedup key lets the new
 * identity consume it again and RE-VERIFY (C1 fail-closes a wrong account).
 *
 * One authoritative round per click (P70-RETURN-02): `checkOnce` issues
 * exactly one `invalidateAndRefresh({circleId, orderId})` round-trip plus —
 * only when the candidate carries an orderId — the original-order GET and
 * the authoritative checkout read. The membership's recent-5 paymentOrders
 * list NEVER substitutes for the original order object; the refreshed
 * membership row serves only as the correction-aware cross-check (G5).
 *
 * Identity binding: every round captures the ProductSpace fence at click
 * time and applies its results only while that fence is still current; a
 * scope change drops the verification state (old-account facts lose display
 * authority immediately). The candidate itself is held in MEMORY ONLY as
 * minimal ids — nothing is persisted, no secret or phone number is stored.
 */

// ---------------------------------------------------------------------------
// Public types (交接接口: state / checkOnce / reauthenticate / cancel)
// ---------------------------------------------------------------------------

export type CircleReturnPhase =
  | 'idle' // no candidate surfaced
  | 'candidate' // candidate presented, awaiting the user's verification click
  | 'checking' // one authoritative round in flight
  | 'verified' // a definitive answer was located for the current account
  | 'failed' // the round could not complete (retryable by design)
  | 'account-mismatch' // definitive negative for the current account (no disclosure)

/** Classification of a completed round's failure (drives the retry wording). */
export type CircleReturnFailureKind =
  | 'read-failed' // authoritative reads failed — retry allowed, nothing granted
  | 'relations-changed' // C2 relations refetch half-failed — 待核对, retry allowed
  | 'session-unavailable' // no trusted scope to read under (signed out etc.)

export interface CircleReturnOriginalOrderFacts {
  /** The ORIGINAL order object (GET me/circle-payment-orders/{orderId}). */
  order: OriginalCircleOrder
  /** Display-history stored status — never an entitlement judgment (G5). */
  storedStatusIsHistoryOnly: true
  /** Authoritative checkout read, when this round obtained one. */
  checkout: MemberCircleCheckoutResult | null
  /** True when the checkout read failed — the entitlement stays unknown. */
  checkoutUnknown: boolean
}

export interface CircleReturnState {
  phase: CircleReturnPhase
  /** The surfaced candidate's navigation target (validated ids only). */
  target: CircleReturnTargetIds | null
  /** Main's candidate handle (null for an explicit local candidate). */
  candidateId: string | null
  kind: 'order' | 'circle' | null
  /** The located ORIGINAL object facts — null until a round locates them. */
  orderFacts: CircleReturnOriginalOrderFacts | null
  /** Entitlement verdict of the last completed round. */
  entitlement: 'valid' | 'invalid' | 'unknown' | null
  /** Why a round failed (failed phase only). */
  failure: CircleReturnFailureKind | null
  /** True while a round is in flight (double-click guard lives in the hook). */
  checking: boolean
  /** Identity scope the current state belongs to (null when scopeless). */
  scopeKey: string | null
}

export interface UseCircleReturnOptions {
  /** THE shared C2 member-circle resource (authoritative read surface). */
  resource: MemberCirclesResource
  /**
   * Explicit candidate from a verified system deep link or the local
   * original-object record (F1-recorded parameter spec; C9 wires it).
   * Applied when no bridge candidate is active; ids are re-validated.
   */
  candidate?: CircleReturnTargetIds | null
  /**
   * Existing A1 auth-chain callback (C9 wires the account/login entry).
   * Invoked by `reauthenticate()` with the held minimal target; the hook
   * itself never opens a login surface and never persists anything.
   */
  onReauthenticateRequest?: (target: CircleReturnTargetIds | null) => void
  /**
   * Test seam: the B1 bridge. Defaults to `window.electronAPI` (absent in
   * hardened/broken-preload environments → candidate delivery stays idle
   * instead of throwing; the explicit candidate path still works).
   */
  bridge?: CircleReturnBridge | null
}

/** The slice of `window.electronAPI` this hook consumes (B1 contract). */
export interface CircleReturnBridge {
  circleReturn: {
    getPending(): Promise<
      | { status: 'pending'; candidate: CircleReturnCandidate }
      | { status: 'none' }
      | { status: 'unavailable'; reason: 'session_unavailable' }
    >
    ack(candidateId: string): Promise<{ status: 'acked' | 'not_found' }>
    cancel(candidateId: string): Promise<{ status: 'cancelled' | 'not_found' }>
  }
  onCircleReturnCandidate(
    callback: (candidate: CircleReturnCandidate) => void,
  ): () => void
}

export function getCircleReturnBridge(): CircleReturnBridge | null {
  const electronApi = (typeof window !== 'undefined' ? window.electronAPI : undefined) as
    | (CircleReturnBridge & Record<string, unknown>)
    | undefined
  if (!electronApi?.circleReturn || !electronApi.onCircleReturnCandidate) return null
  return { circleReturn: electronApi.circleReturn, onCircleReturnCandidate: electronApi.onCircleReturnCandidate }
}

/** Bounded mirror-gate retry: `unavailable` retries the READ, never consumes. */
export const CIRCLE_RETURN_PENDING_READ_ATTEMPTS = 8
export const CIRCLE_RETURN_PENDING_READ_RETRY_MS = 750

const EMPTY_STATE: CircleReturnState = {
  phase: 'idle',
  target: null,
  candidateId: null,
  kind: null,
  orderFacts: null,
  entitlement: null,
  failure: null,
  checking: false,
  scopeKey: null,
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useCircleReturn(options: UseCircleReturnOptions) {
  const { resource, candidate, onReauthenticateRequest, bridge } = options
  const productSpace = useOptionalProductSpaceContext()

  const scopeIdentity: CircleReturnScopeIdentity = {
    accountId: productSpace?.accountId ?? null,
    personalProductSpaceId: productSpace?.personalProductSpaceId ?? null,
    contextKey: productSpace?.productSpaceContextKey ?? null,
    epoch: productSpace?.contextVersion ?? 0,
  }
  const isPersonalScope = Boolean(
    scopeIdentity.accountId
    && scopeIdentity.personalProductSpaceId
    && scopeIdentity.contextKey,
  ) && productSpace?.activeProductSpace?.kind !== 'enterprise'

  const [state, setState] = useState<CircleReturnState>(EMPTY_STATE)
  const scopeKey = useMemo(() => circleReturnScopeKey(scopeIdentity), [
    scopeIdentity.accountId,
    scopeIdentity.personalProductSpaceId,
    scopeIdentity.contextKey,
    scopeIdentity.epoch,
  ])

  // Live refs for async closures (the fence a round captured at click time).
  const stateRef = useRef(state)
  stateRef.current = state
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey
  const isPersonalScopeRef = useRef(isPersonalScope)
  isPersonalScopeRef.current = isPersonalScope
  const resourceRef = useRef(resource)
  resourceRef.current = resource
  const onReauthenticateRef = useRef(onReauthenticateRequest)
  onReauthenticateRef.current = onReauthenticateRequest

  // Consumed-candidate ledger: candidateId+scope so an event/read interleaving
  // consumes ONCE per identity scope, while an A4 re-anchor (account switch)
  // legitimately re-consumes under the NEW scope (re-verification duty).
  const consumedRef = useRef<Set<string>>(new Set())
  // SYNCHRONOUS in-flight guard: a second click while a round is in flight is
  // absorbed into the same round (查询双击 → 一轮), independent of render timing.
  const roundInFlightRef = useRef(false)

  const applyHeldCandidate = useCallback((held: HeldCircleReturnCandidate) => {
    setState(previous => {
      // A already-active bridge candidate is not downgraded by an explicit one.
      if (previous.phase !== 'idle' && held.source === 'explicit' && previous.candidateId) {
        return previous
      }
      // Same target re-surfaced (duplicated bridge delivery) keeps the state.
      if (
        previous.phase === 'candidate'
        && previous.candidateId === held.candidateId
        && sameCircleReturnTarget(previous.target, held.target)
      ) {
        return previous
      }
      return {
        ...EMPTY_STATE,
        phase: 'candidate',
        target: held.target,
        candidateId: held.candidateId,
        kind: circleReturnTargetKind(held.target) === 'order' ? 'order' : 'circle',
        scopeKey: scopeKeyRef.current,
      }
    })
  }, [])

  // -------------------------------------------------------------------------
  // B1 delivery: typed event registered BEFORE the getPending read; dedup by
  // candidateId+scope; `unavailable` retries the read (never consumes).
  // -------------------------------------------------------------------------

  useEffect(() => {
    const resolvedBridge = bridge ?? getCircleReturnBridge()
    if (!resolvedBridge) return
    let disposed = false

    const consumeCandidate = (rawCandidate: CircleReturnCandidate) => {
      if (disposed) return
      const key = circleReturnConsumptionKey(scopeKeyRef.current, rawCandidate.candidateId)
      if (consumedRef.current.has(key)) return
      const held = heldCandidateFromBridge(rawCandidate)
      if (!held) {
        // Malicious/unaddressable candidate: mark consumed so neither delivery
        // path re-processes it; nothing is rendered and Main keeps it pending
        // until the user navigates away (never acked — Main's logout clears).
        consumedRef.current.add(key)
        return
      }
      consumedRef.current.add(key)
      applyHeldCandidate(held)
    }

    // 1. Event subscription FIRST (event-first contract).
    const unsubscribe = resolvedBridge.onCircleReturnCandidate(consumeCandidate)

    // 2. Then the pending read, with the bounded mirror-gate retry.
    const readPending = async () => {
      for (let attempt = 0; attempt < CIRCLE_RETURN_PENDING_READ_ATTEMPTS; attempt += 1) {
        if (disposed) return
        const pendingState = await resolvedBridge.circleReturn.getPending().catch(() => null)
        if (disposed) return
        if (!pendingState) return // transport dead — a later mount/scope change re-reads
        if (pendingState.status === 'unavailable') {
          // A4 mirror not settled: retry the READ, consume nothing.
          await new Promise(resolve => setTimeout(resolve, CIRCLE_RETURN_PENDING_READ_RETRY_MS))
          continue
        }
        if (pendingState.status === 'pending') {
          consumeCandidate(pendingState.candidate)
        }
        return
      }
    }
    void readPending()

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [bridge, scopeKey, applyHeldCandidate])

  // -------------------------------------------------------------------------
  // Explicit candidate (local original-object record; C9 wiring)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!candidate) return
    const held = heldCandidateFromExplicit(candidate)
    if (!held) return
    // Only when no bridge candidate is active — the bridge candidate is the
    // fresher user intent and carries Main's ack/cancel handle.
    if (stateRef.current.phase !== 'idle' && stateRef.current.candidateId) return
    applyHeldCandidate(held)
  }, [candidate, applyHeldCandidate])

  // -------------------------------------------------------------------------
  // Scope fence change: the previous identity's verification state dies
  // immediately; the candidate target itself is retained (ids only) so the
  // SAME original object is re-verified under the new account after a
  // proactive re-login (P70-RETURN-01). Main re-delivers an un-acked bridge
  // candidate through the re-run read above (scope-fenced dedup key).
  // -------------------------------------------------------------------------

  useEffect(() => {
    setState(previous => {
      if (previous.phase === 'idle' && !previous.target) {
        return previous.scopeKey === scopeKey ? previous : { ...EMPTY_STATE, scopeKey }
      }
      return {
        ...EMPTY_STATE,
        phase: 'candidate',
        target: previous.target,
        candidateId: previous.candidateId,
        kind: previous.kind,
        scopeKey,
      }
    })
  }, [scopeKey])

  // -------------------------------------------------------------------------
  // ONE authoritative round per click (P70-RETURN-02)
  // -------------------------------------------------------------------------

  /**
   * The single authoritative round. Precondition: a checkable candidate is
   * held and no round is in flight (checked by `checkOnce` below). Stable on
   * purpose — every live dependency is read through refs.
   */
  const runVerificationRound = useCallback(async (current: CircleReturnState): Promise<void> => {
    const fence = scopeKeyRef.current
    const heldTarget = current.target!
    const heldCandidateId = current.candidateId

    if (!fence || !isPersonalScopeRef.current) {
      // No trusted personal scope to read under — fail closed, retry allowed
      // once a scope binds (never treated as a definitive negative).
      setState(previous => ({ ...previous, phase: 'failed', failure: 'session-unavailable', checking: false }))
      return
    }

    setState(previous => ({ ...previous, phase: 'checking', checking: true, failure: null }))

    const kind = circleReturnTargetKind(heldTarget)
    const circleId = heldTarget.circleId ?? null
    const orderId = heldTarget.orderId ?? null

    // Round step 1 — the single C2 invalidation round-trip: refresh shared
    // relations AND the shared catalog (P70-RETURN-01 同账号核对成功刷新).
    // The hint carries circleId+orderId for the same one-round contract.
    const invalidation = await resourceRef.current.invalidateAndRefresh({
      ...(circleId ? { circleId } : {}),
      ...(orderId ? { orderId } : {}),
    })

    // Round step 2 — original-order + authoritative checkout reads, ONLY for
    // an order-return. These never read the membership's recent-5 list.
    let order: OriginalCircleOrder | null = null
    let orderReadFailed = false
    let orderErrorCode: string | null = null
    let checkout: MemberCircleCheckoutResult | null = null
    let checkoutReadFailed = false
    let checkoutErrorCode: string | null = null
    if (kind === 'order' && orderId) {
      const [orderResult, checkoutResult] = await Promise.all([
        resourceRef.current.getOrder(orderId),
        resourceRef.current.getCheckoutResult(orderId),
      ])
      if (orderResult.success) {
        order = orderResult.order
      } else {
        orderReadFailed = true
        orderErrorCode = orderResult.errorCode ?? null
      }
      if (checkoutResult.success) {
        checkout = checkoutResult.checkout
      } else {
        checkoutReadFailed = true
        checkoutErrorCode = checkoutResult.errorCode ?? null
      }
    }

    // Fence re-validation: a scope change mid-round voids every payload (the
    // facts may belong to another identity — fail closed, nothing rendered).
    if (scopeKeyRef.current !== fence) {
      setState(previous => (
        previous.scopeKey === fence
          ? { ...previous, phase: 'candidate', checking: false, failure: null }
          : previous
      ))
      return
    }

    // The refreshed authoritative membership row for this circle (cross-check
    // only — never an order substitute). MembershipId is C2's stable handle;
    // the row is matched by circle (actor-filtered C1 receipt).
    const memberships = resourceRef.current.memberships ?? []
    const membership: MemberMembership | null = (heldTarget.membershipId
      ? memberships.find(row => row.membershipId === heldTarget.membershipId)
      : null)
      ?? (circleId
        ? memberships.find(row => row.circle.circleId === circleId)
          ?? null
        : null)
      ?? null

    const verdict = deriveCircleReturnVerdict({
      kind: kind === 'order' ? 'order' : 'circle',
      order,
      orderReadFailed,
      orderErrorCode,
      checkout,
      checkoutReadFailed,
      checkoutErrorCode,
      relations: invalidation.relations,
      membership,
    })

    if (verdict.accountMismatch) {
      setState(previous => ({
        ...previous,
        phase: 'account-mismatch',
        orderFacts: null, // no disclosure of the object this account cannot see
        entitlement: null,
        checking: false,
      }))
      return
    }

    if (verdict.entitlementState === 'unknown' && !(kind === 'order' && order)) {
      // No authoritative answer and no order fact to show: retryable failure.
      setState(previous => ({
        ...previous,
        phase: 'failed',
        failure: invalidation.relations === 'refreshed' ? 'read-failed' : 'relations-changed',
        orderFacts: null,
        entitlement: 'unknown',
        checking: false,
      }))
      return
    }

    // Definitive locate under THIS account: publish the facts, then ack the
    // bridge candidate (Main stops re-delivering). A failed/unknown round
    // keeps the candidate pending so a later click can still complete it.
    const orderFacts: CircleReturnOriginalOrderFacts | null = order
      ? {
        order,
        storedStatusIsHistoryOnly: true,
        checkout,
        checkoutUnknown: !(checkout && (checkout.state === 'success' || checkout.state === 'failed')),
      }
      : null
    setState(previous => ({
      ...previous,
      phase: 'verified',
      orderFacts,
      entitlement: verdict.entitlementState,
      checking: false,
      failure: null,
    }))

    if (heldCandidateId) {
      const activeBridge = bridge ?? getCircleReturnBridge()
      try {
        await activeBridge?.circleReturn.ack(heldCandidateId)
      } catch {
        // Ack is best-effort post-locate: Main re-delivering an acked-target
        // candidate re-presents the SAME located object; never an error to the user.
      }
    }
  }, [bridge]) // stable in practice: `bridge` only comes from options/injection

  /**
   * The user-facing click entry: absorbs double-clicks into ONE round and
   * only fires on a checkable candidate state.
   */
  const checkOnce = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    if (roundInFlightRef.current) return // 双击合并为一轮（同步守卫，不依赖渲染时序）
    if (current.checking || current.phase === 'checking') return
    if (!current.target || (current.phase !== 'candidate' && current.phase !== 'failed' && current.phase !== 'account-mismatch' && current.phase !== 'verified')) return
    roundInFlightRef.current = true
    try {
      await runVerificationRound(current)
    } finally {
      roundInFlightRef.current = false
    }
  }, [runVerificationRound])

  // -------------------------------------------------------------------------
  // Reauthenticate through the EXISTING A1 auth chain (C9 wires the entry)
  // -------------------------------------------------------------------------

  const reauthenticate = useCallback(() => {
    const current = stateRef.current
    if (current.checking) return
    // Drop the previous account's facts immediately; keep the minimal target
    // (ids only) so the same original object is re-verified after login.
    setState(previous => ({
      ...EMPTY_STATE,
      phase: 'candidate',
      target: previous.target,
      candidateId: previous.candidateId,
      kind: previous.kind,
      scopeKey: scopeKeyRef.current,
    }))
    onReauthenticateRef.current?.(stateRef.current.target)
  }, [])

  // -------------------------------------------------------------------------
  // Cancel: the user declines — clear locally and release Main's candidate
  // -------------------------------------------------------------------------

  const cancel = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const candidateId = current.candidateId
    setState(previous => (
      previous.phase === 'idle' && !previous.target ? previous : { ...EMPTY_STATE }
    ))
    if (!candidateId) return
    const activeBridge = bridge ?? getCircleReturnBridge()
    try {
      await activeBridge?.circleReturn.cancel(candidateId)
    } catch {
      // Idempotent best-effort; not_found = already handled (contract).
    }
  }, [bridge])

  return { state, checkOnce, reauthenticate, cancel }
}
