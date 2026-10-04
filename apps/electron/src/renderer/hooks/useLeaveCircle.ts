import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MemberMembership } from '@polo-ai/shared/admin'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import type {
  MemberCircleScopeKey,
  MemberCirclesInvalidationOutcome,
  MemberCirclesResourceState,
} from '@/hooks/useMemberCircles'

/**
 * Leave-circle confirmation flow (POO-70 C7 / POO-96; P70-LEAVE-01/02/03).
 *
 * The ONE client-side orchestrator for the member-initiated exit. It is the
 * only consumer of the C2 `leave` write and a strict follower of the C2
 * contracts (P70-CIRCLE-STATE-03):
 *
 * - P70-LEAVE-01 一次确认与防重: exactly ONE confirmation per attempt. The
 *   confirm write goes through `useMemberCircles().leave(membershipId)` with
 *   the membership id of the relation the subscription panel asked about —
 *   nothing else is sent (no userId: the main process derives the permission
 *   subject from the trusted session; the wire body `{action:'leave_now'}` is
 *   F1's strict single-value command, owned by C1). A busy flow refuses
 *   re-entry (synchronous ref guard, safe within one render frame), so a
 *   double-click can never double-write; canceling while the write is in
 *   flight is refused too — the outcome must land somewhere truthful before
 *   the dialog may go away.
 *
 * - P70-LEAVE-02 一次刷新: a CONFIRMED write never triggers a second refresh
 *   round trip here — C2's `leave` already runs `invalidateAndRefresh` on the
 *   SAME MemberCircleResourceContext exactly once (one relations refetch +
 *   one sync of the shared H1 catalog; this hook never creates its own
 *   `useAppCatalog`). What this hook adds is the honest reading of that
 *   round trip: if the post-write relations receipt is not settled-clean the
 *   outcome reports `pending-recheck` ("已退出，关系/目录待核对") instead of
 *   pretending the catalog is current. `reverify()` re-runs the same context's
 *   `invalidateAndRefresh` — a READ-ONLY re-verification (GET reads + catalog
 *   sync only), never a rewrite of the leave.
 *
 * - P70-LEAVE-03 结果未知只重读: `network_error` / `timeout` /
 *   `service_unavailable` mean the write RESULT IS UNKNOWN, and F1's 409
 *   `invalid_membership_transition` fires whenever the relation is NOT
 *   active (a replayed leave OR an expired OR a suspended relation). For
 *   both, this hook performs exactly one automatic READ-ONLY
 *   re-verification (`invalidateAndRefresh`) and judges from the fresh
 *   authoritative receipt — never a blind rewrite. The verdict distinguishes
 *   the F1 statuses honestly: `expired` (or a vanished row) means the user
 *   left; `active` means the leave never landed; `suspended` means the user
 *   did NOT leave and CANNOT leave while suspended — never presented as
 *   已退出 and never offered a rejoin. `session_changed` /
 *   `session_unavailable` auto-read NOTHING (the scope died mid-flight);
 *   the user retries actively. A definitive server rejection keeps the
 *   dialog open with the failure — the pre-leave facts on screen stay
 *   untouched ("失败不显示已退出").
 *
 * - Verdict timing (P2 hardening): every verdict is applied from a COMMITTED
 *   C2 snapshot — the same settle pattern C2 uses for the catalog outcome.
 *   `confirm` captures the scope fence (identity) and the relations
 *   `updatedAt` at confirm time; a pending judgment is released from a
 *   rendered snapshot only when BOTH the fence still matches (an account/
 *   space rebind mid-window fails closed instead of judging another
 *   identity's receipt) and `updatedAt` has moved (proof the post-refetch
 *   commit rendered — a same-continuation read could still see the
 *   pre-invalidate or nulled receipts). A bounded fallback releases from the
 *   current fact so the flow can never hang.
 *
 * - Post-leave presentation inputs: a confirmed leave reports the returned
 *   membership (`endedAt`, F1: active→expired, endedAt=now) so the page can
 *   keep the CORRECT object — per the F1 contract an EXPIRED relation STILL
 *   appears in `me/circles` / `me/circle-memberships`, and the rejoin web
 *   guidance consumes the SAME C2 `previewRenewal` `purchaseUrl` handoff
 *   (resolved against the confirmed Admin origin; never a raw URL, never an
 *   automatic payment, never a cross-account exit — and never offered for a
 *   suspended relation, which is not left). Navigation back to the
 *   list/home after the outcome is the mounting page's (C9) routing decision
 *   via N1 ClientPageContext — this hook holds no router.
 */

/** Bounded fallback for a pending verdict (mirrors C2's settle bound). */
export const LEAVE_JUDGMENT_SETTLE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Presentation class of a failed/unresolved attempt. */
export type LeaveCircleFailureKind =
  /** Server definitively rejected the write — the relation is unchanged. */
  | 'rejected'
  /** Session/scope changed mid-flight — nothing was auto-read; retry manually. */
  | 'session'
  /** The read-only re-verification proved the relation is STILL active. */
  | 'still-member'
  /**
   * The re-verification found the relation SUSPENDED (F1: status ≠ active
   * answers 409): the user has NOT left and cannot leave while suspended.
   */
  | 'suspended'

export interface LeaveCircleFailureView {
  code: string
  kind: LeaveCircleFailureKind
  /**
   * A deliberate re-confirm may succeed (session retry / transient
   * rejection); false only when contract-doomed (suspended → F1 409).
   */
  retryable: boolean
}

/** Dialog state handed to `LeaveCircleDialog` (the exact 交接接口). */
export interface LeaveCircleDialogState {
  circleId: string
  membershipId: string
  circleName: string
  /**
   * CALLER-PROVIDED H1 fact (never computed here): the works that would lose
   * their LAST valid authorization source if this leave lands. Empty = the
   * generic per-source wording is used.
   */
  lastSourceWorkNames: readonly string[]
  /** Write or read-only re-verification in flight — confirms are refused. */
  busy: boolean
  /**
   * `confirm` — awaiting the single confirmation.
   * `recheck` — write result unknown (or replay 409): the automatic READ-ONLY
   *   re-verification is running or finished unresolved; no rewrite happens.
   * `error` — the relation is unchanged (rejection / still a member /
   *   suspended / session).
   */
  phase: 'confirm' | 'recheck' | 'error'
  failure: LeaveCircleFailureView | null
  /** The re-verification finished without a verdict; only re-reads remain. */
  recheckUnresolved: boolean
}

/** Whether the post-leave relations/catalog can be trusted as current. */
export type LeaveCircleVerification = 'fresh' | 'pending-recheck'

/**
 * The flow result for the mounting page. `left` carries the F1 leave receipt
 * (status expired, endedAt=now) — the page keeps showing the correct object
 * and wires the rejoin guidance from C2 `previewRenewal(membershipId)`.
 */
export type LeaveCircleOutcome =
  | {
    kind: 'left'
    circleId: string
    membershipId: string
    /** F1: active→expired with endedAt=now; null stays null (never guessed). */
    endedAt: string | null
    verification: LeaveCircleVerification
  }
  | {
    kind: 'still-member'
    circleId: string
    membershipId: string
    code: string
  }
  | {
    kind: 'suspended'
    circleId: string
    membershipId: string
    code: string
  }
  | null

export interface LeaveCircleState {
  /** `null` = no dialog on screen. */
  dialog: LeaveCircleDialogState | null
  outcome: LeaveCircleOutcome
  /** A page-triggered read-only re-verification is in flight. */
  reverifying: boolean
}

export interface LeaveCircleRequestInput {
  circleId: string
  membershipId: string
  circleName: string
  /** H1-derived fact: works that would lose their last valid source here. */
  lastSourceWorkNames?: readonly string[]
}

export interface UseLeaveCircleResult {
  state: LeaveCircleState
  /** Open THE single confirmation for this membership (replaces any prior). */
  request: (input: LeaveCircleRequestInput) => void
  /** The single confirm. Refused while busy or with no open confirmation. */
  confirm: () => void
  /**
   * Close without writing. Refused while the confirm WRITE is in flight; the
   * read-only recheck may be dismissed (its result still lands honestly).
   */
  cancel: () => void
  /**
   * READ-ONLY re-verification through the SAME context's
   * `invalidateAndRefresh` — refreshes the relations receipt and the shared
   * H1 catalog, never rewrites the leave. Meaningful whenever a flow target
   * is still open for re-reading: after `left` with `pending-recheck`, AND
   * after a dismissed UNRESOLVED recheck (the result-unknown case has a
   * read-only recovery path that is not a new write).
   */
  reverify: () => void
}

// ---------------------------------------------------------------------------
// Pure classification / verdict helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** F1/C2 transport-class codes whose leave RESULT is unknown, not failed. */
const LEAVE_RESULT_UNKNOWN_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'timeout',
  'service_unavailable',
])

/** C2 fence codes: nothing may be auto-read; the user retries actively. */
const LEAVE_SESSION_CODES: ReadonlySet<string> = new Set([
  'session_changed',
  'session_unavailable',
])

/**
 * Failure classes for a `leave` rejection (P70-LEAVE-03):
 * - `result-unknown`: transport-class failure — the write MAY have landed;
 *   only a read may follow, never a blind rewrite.
 * - `not-active`: F1 409 `invalid_membership_transition` — the relation was
 *   NOT active (replayed leave / already expired / SUSPENDED); re-read, and
 *   let `judgeMembershipLeft` separate left from still-member from suspended.
 * - `session`: the C2 scope died mid-command; auto-read NOTHING.
 * - `rejected`: definitive server rejection — the relation is unchanged.
 */
export type LeaveWriteFailureClass = 'result-unknown' | 'not-active' | 'session' | 'rejected'

export function classifyLeaveWriteFailure(errorCode: string): LeaveWriteFailureClass {
  if (LEAVE_RESULT_UNKNOWN_CODES.has(errorCode)) return 'result-unknown'
  if (errorCode === 'conflict') return 'not-active'
  if (LEAVE_SESSION_CODES.has(errorCode)) return 'session'
  return 'rejected'
}

/**
 * Verdict for "did this membership leave?" judged ONLY from an authoritative
 * relations receipt (never from cache optimism). F1 semantics:
 * - An EXPIRED relation still appears in `me/circle-memberships` (endedAt
 *   set by the leave) → `left`.
 * - An ACTIVE relation → `member` (the leave never landed).
 * - A SUSPENDED relation answers 409 on leave_now but is NOT a departure:
 *   the user is still a member, cannot rejoin, and must never be presented
 *   as 已退出 → the distinct `suspended` verdict (P70-LEAVE-03).
 * - An ABSENT row means no relation exists under this account at all →
 *   `left` (nothing left to be a member of).
 * - A missing receipt (`null`) is `unverifiable` — unknown is a fact, never
 *   resolved by guessing in either direction.
 */
export type LeaveRelationsVerdict = 'left' | 'member' | 'suspended' | 'unverifiable'

export function judgeMembershipLeft(
  memberships: ReadonlyArray<Pick<MemberMembership, 'membershipId' | 'status'>> | null,
  membershipId: string,
): LeaveRelationsVerdict {
  if (memberships === null) return 'unverifiable'
  const row = memberships.find(candidate => candidate.membershipId === membershipId)
  if (!row) return 'left'
  if (row.status === 'expired') return 'left'
  if (row.status === 'suspended') return 'suspended'
  return 'member'
}

/**
 * Post-write verification judgment for a CONFIRMED leave: the write succeeded
 * (server-side truth), so this only asks whether the C2 single refresh round
 * trip settled cleanly. A receipt that is not settled-and-error-free —
 * or still refreshing — reports `pending-recheck` ("已退出；关系/目录待核对")
 * instead of claiming the view is current.
 */
export function judgeLeaveWriteSuccessVerification(
  state: Pick<
    MemberCirclesResourceState,
    'phase' | 'circlesError' | 'membershipsError' | 'refreshing'
  >,
): LeaveCircleVerification {
  const settledClean = (state.phase === 'ready' || state.phase === 'empty')
    && state.circlesError === null
    && state.membershipsError === null
    && state.refreshing !== true
  return settledClean ? 'fresh' : 'pending-recheck'
}

/**
 * Verification judgment after a read-only re-verification whose outcome object
 * IS observable: relations must have refreshed AND the catalog outcome must
 * report `refreshed`. Everything else — partial/failed/skipped relations,
 * pending/failed/unavailable catalog — stays honestly `pending-recheck`.
 */
export function judgeReverifyVerification(
  outcome: Pick<MemberCirclesInvalidationOutcome, 'relations' | 'catalog'>,
): LeaveCircleVerification {
  return outcome.relations === 'refreshed' && outcome.catalog === 'refreshed'
    ? 'fresh'
    : 'pending-recheck'
}

function failureView(code: string, kind: LeaveCircleFailureKind): LeaveCircleFailureView {
  return {
    code,
    kind,
    // A deliberate re-confirm is always the user's own act; the guard against
    // blind rewrites lives in the flow, not in disabling the retry forever.
    // EXCEPT `suspended`: F1 answers 409 to leave_now for any status ≠
    // active, so a suspended relation cannot be left until restored — the
    // retry is contract-doomed, not merely transient.
    retryable: kind !== 'suspended',
  }
}

// ---------------------------------------------------------------------------
// Internal pending-judgment machinery (the C2 settle-pattern analog applied
// to relation receipts: verdicts are judged from COMMITTED snapshots only)
// ---------------------------------------------------------------------------

interface RecheckRequest {
  circleId: string
  membershipId: string
}

/**
 * A verdict awaiting a COMMITTED receipt. `scopeAtIssue` is the C2 fence
 * captured at confirm: a rebind mid-window (account switch, epoch bump)
 * fails the judgment closed instead of reading another identity's receipt.
 * `updatedAtAtIssue` is the relations receipt version rendered at issue:
 * `updatedAt` moves exactly when a post-refetch `fetchRelations` commit
 * renders, so "updatedAt moved" = a fresh receipt is committed and readable.
 */
interface PendingJudgment {
  kind: 'success-left' | 'recheck' | 'reverify'
  token: number
  recheck: RecheckRequest
  scopeAtIssue: MemberCircleScopeKey | null
  updatedAtAtIssue: number | null
  /** `success-left`: the F1 write receipt's endedAt (null stays null). */
  endedAt: string | null
  /** `recheck`/`reverify`: verification derived from the C2 outcome object. */
  verification: LeaveCircleVerification
  originCode: string
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useLeaveCircle(): UseLeaveCircleResult {
  const resource = useMemberCircles()
  // Latest rendered resource: async continuations read the COMMITTED C2 state
  // through this ref instead of a closure-stale snapshot.
  const resourceRef = useRef(resource)
  resourceRef.current = resource

  const [dialog, setDialogState] = useState<LeaveCircleDialogState | null>(null)
  const [outcome, setOutcomeState] = useState<LeaveCircleOutcome>(null)
  const [reverifying, setReverifyingState] = useState(false)

  // Synchronous mirrors for event-handler guards (render-independent, so a
  // double-click inside one frame still meets a real busy flag).
  const dialogRef = useRef<LeaveCircleDialogState | null>(null)
  const outcomeRef = useRef<LeaveCircleOutcome>(null)
  const confirmInFlightRef = useRef(false)
  const reverifyInFlightRef = useRef(false)
  // Monotonic flow token: every request()/reverify() supersedes in-flight
  // continuations of a previous flow, so a late write/recheck result can
  // never apply to a dialog it was not asked for (旧回执不串流程).
  const flowTokenRef = useRef(0)
  // The relation a read-only re-verification may still target: the requested
  // flow (P2-2) — kept across `left` (re-freshen) and across an UNRESOLVED
  // recheck (including after dismissing the dialog), cleared once the flow
  // concludes with a verdict (member/suspended). Null = nothing to re-verify.
  const reverifyTargetRef = useRef<RecheckRequest | null>(null)
  // The armed verdict awaiting a committed receipt (see PendingJudgment).
  const pendingJudgmentRef = useRef<PendingJudgment | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setDialog = useCallback((next: LeaveCircleDialogState | null) => {
    dialogRef.current = next
    setDialogState(next)
  }, [])

  /**
   * Patch the OPEN dialog in place. dialogRef is updated synchronously by
   * every setDialog, so an async continuation always patches the committed
   * dialog object — never through a state-updater closure.
   */
  const patchDialog = useCallback((patch: Partial<LeaveCircleDialogState>) => {
    const prev = dialogRef.current
    if (prev) setDialog({ ...prev, ...patch })
  }, [setDialog])

  const setOutcome = useCallback((next: LeaveCircleOutcome) => {
    outcomeRef.current = next
    setOutcomeState(next)
  }, [])

  /**
   * Apply a judgment from a COMMITTED C2 snapshot. Every release path
   * (verdict / scope change / bounded fallback / superseding request / the
   * already-committed immediate path) funnels through here.
   */
  const applyJudgment = useCallback((pending: PendingJudgment, state: MemberCirclesResourceState) => {
    // Consume the armed slot exactly once. A DIRECT invocation (the
    // already-committed immediate path) arrives unarmed and must pass; only
    // a STALE judgment — a NEWER pending is armed — is dropped here.
    if (pendingJudgmentRef.current !== null && pendingJudgmentRef.current !== pending) return
    pendingJudgmentRef.current = null
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
    if (pending.kind === 'reverify') {
      reverifyInFlightRef.current = false
      setReverifyingState(false)
    }
    // Fence check (P2-1): a scope rebind during the verification window
    // means the committed receipt may be another identity's — fail closed.
    const scopeMismatch = pending.scopeAtIssue !== null && state.scope !== pending.scopeAtIssue
    const verdict = scopeMismatch
      ? 'unverifiable' as const
      : judgeMembershipLeft(state.memberships, pending.recheck.membershipId)

    if (pending.kind === 'success-left') {
      // The WRITE is server-side truth; only the freshness of the single C2
      // refresh round trip is in question. A scope rebind cannot unsay it —
      // but the receipts cannot vouch for freshness either.
      setOutcome({
        kind: 'left',
        circleId: pending.recheck.circleId,
        membershipId: pending.recheck.membershipId,
        endedAt: pending.endedAt,
        verification: scopeMismatch ? 'pending-recheck' : judgeLeaveWriteSuccessVerification(state),
      })
      setDialog(null)
      return
    }

    if (verdict === 'left') {
      // Preserve the write receipt's endedAt when re-verifying an existing
      // left outcome; the recheck path has no write receipt (null stays null).
      const prior = outcomeRef.current
      const priorEndedAt = prior?.kind === 'left' && prior.membershipId === pending.recheck.membershipId
        ? prior.endedAt
        : null
      setOutcome({
        kind: 'left',
        circleId: pending.recheck.circleId,
        membershipId: pending.recheck.membershipId,
        endedAt: priorEndedAt,
        verification: pending.verification,
      })
      setDialog(null)
      return
    }

    if (verdict === 'member' || verdict === 'suspended') {
      // The flow CONCLUDED (the leave did not land / cannot land): no further
      // read-only re-verification is pending for this relation.
      reverifyTargetRef.current = null
      setOutcome({
        kind: verdict === 'member' ? 'still-member' : 'suspended',
        circleId: pending.recheck.circleId,
        membershipId: pending.recheck.membershipId,
        code: pending.originCode,
      })
      const dialog = dialogRef.current
      if (dialog && dialog.membershipId === pending.recheck.membershipId) {
        setDialog({
          ...dialog,
          busy: false,
          phase: 'error',
          failure: failureView(pending.originCode, verdict === 'member' ? 'still-member' : 'suspended'),
        })
      }
      return
    }

    // `unverifiable` (receipts missing or scope changed): claim NEITHER left
    // NOR member. The dialog offers no further write; the page keeps the
    // honest 待核对 state, and reverify() remains the read-only recovery.
    const dialog = dialogRef.current
    if (dialog && dialog.membershipId === pending.recheck.membershipId && dialog.phase === 'recheck') {
      setDialog({ ...dialog, busy: false, phase: 'recheck', recheckUnresolved: true })
    }
  }, [setDialog, setOutcome])

  /** Arm a judgment: judge immediately when the fresh commit already
   * rendered, otherwise wait for the commit (or the bounded fallback). */
  const armJudgment = useCallback((pending: PendingJudgment) => {
    const committed = resourceRef.current.state
    if (committed.updatedAt !== pending.updatedAtAtIssue) {
      applyJudgment(pending, committed)
      return
    }
    pendingJudgmentRef.current = pending
    pendingTimerRef.current = setTimeout(() => {
      const armed = pendingJudgmentRef.current
      if (!armed || armed !== pending) return
      // Bounded fallback: by now the snapshot is committed; applyJudgment
      // still re-checks the fence before trusting it.
      applyJudgment(armed, resourceRef.current.state)
    }, LEAVE_JUDGMENT_SETTLE_TIMEOUT_MS)
  }, [applyJudgment])

  /**
   * Shared tail of the read-only re-verification (used by the confirm
   * recheck AND by reverify): gate on the C2 outcome + scope fence, then
   * judge from a COMMITTED receipt.
   */
  const startVerificationJudgment = useCallback((input: {
    kind: 'recheck' | 'reverify'
    token: number
    recheck: RecheckRequest
    scopeAtIssue: MemberCircleScopeKey | null
    updatedAtAtIssue: number | null
    originCode: string
    verificationOutcome: MemberCirclesInvalidationOutcome
  }) => {
    if (flowTokenRef.current !== input.token) return
    // (a) The C2 outcome gates the receipt: anything but a fully refreshed
    // relations refetch leaves nothing to judge — stay honestly unresolved.
    if (input.verificationOutcome.relations !== 'refreshed') {
      if (input.kind === 'reverify') {
        reverifyInFlightRef.current = false
        setReverifyingState(false)
      }
      const dialog = dialogRef.current
      if (dialog && dialog.membershipId === input.recheck.membershipId && dialog.phase === 'recheck') {
        setDialog({ ...dialog, busy: false, phase: 'recheck', recheckUnresolved: true })
      }
      return
    }
    // (b) Scope rebind detected right after the await: fail closed.
    if (input.scopeAtIssue !== null && resourceRef.current.state.scope !== input.scopeAtIssue) {
      if (input.kind === 'reverify') {
        reverifyInFlightRef.current = false
        setReverifyingState(false)
      }
      const dialog = dialogRef.current
      if (dialog && dialog.membershipId === input.recheck.membershipId && dialog.phase === 'recheck') {
        setDialog({ ...dialog, busy: false, phase: 'recheck', recheckUnresolved: true })
      }
      return
    }
    armJudgment({
      kind: input.kind,
      token: input.token,
      recheck: input.recheck,
      scopeAtIssue: input.scopeAtIssue,
      updatedAtAtIssue: input.updatedAtAtIssue,
      endedAt: null,
      verification: judgeReverifyVerification(input.verificationOutcome),
      originCode: input.originCode,
    })
  }, [armJudgment, setDialog])

  // Commit observer (the C2 settle-pattern analog for relation receipts):
  // the pending verdict is applied from the committed snapshot THIS render
  // carries — never from a same-continuation read that could still see the
  // pre-invalidate or nulled receipts (P2-1a).
  useEffect(() => {
    const pending = pendingJudgmentRef.current
    if (!pending) return
    if (pending.token !== flowTokenRef.current) {
      // Superseded: the superseding action releases the pending itself.
      return
    }
    applyJudgment(pending, resource.state)
  }, [resource, applyJudgment])

  // Unmount: never leave the bounded fallback timer running.
  useEffect(() => () => {
    if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current)
  }, [])

  const request = useCallback((input: LeaveCircleRequestInput) => {
    // Release an armed judgment from the CURRENT fact first (C2's superseded
    // release): it can never apply to a flow it was not asked for.
    const pending = pendingJudgmentRef.current
    if (pending) applyJudgment(pending, resourceRef.current.state)
    const token = ++flowTokenRef.current
    confirmInFlightRef.current = false
    reverifyInFlightRef.current = false
    setReverifyingState(false)
    setOutcome(null)
    setDialog({
      circleId: input.circleId,
      membershipId: input.membershipId,
      circleName: input.circleName,
      lastSourceWorkNames: input.lastSourceWorkNames ?? [],
      busy: false,
      phase: 'confirm',
      failure: null,
      recheckUnresolved: false,
    })
    reverifyTargetRef.current = { circleId: input.circleId, membershipId: input.membershipId }
  }, [applyJudgment, setDialog, setOutcome])

  const cancel = useCallback(() => {
    const current = dialogRef.current
    // The confirm WRITE must land somewhere truthful before the dialog may
    // go away — no cancel-while-writing (the UI disables the button as well).
    if (!current || (current.busy && current.phase === 'confirm')) return
    setDialog(null)
  }, [setDialog])

  const confirm = useCallback(() => {
    // P70-LEAVE-01 busy 防重: synchronous guard — a second click within the
    // same frame still meets a set in-flight flag.
    if (confirmInFlightRef.current) return
    const current = dialogRef.current
    if (!current || current.busy) return
    // `confirm` is the single write per attempt. It runs from the open
    // confirmation OR as the user's deliberate retry after an honest error
    // (rejection / session / still-member / suspended) — never from
    // `recheck`, which has no rewrite path at all.
    if (current.phase !== 'confirm' && current.phase !== 'error') return
    const requested: RecheckRequest = {
      circleId: current.circleId,
      membershipId: current.membershipId,
    }
    const token = ++flowTokenRef.current
    // P2-1: capture the scope fence + receipt version at confirm time — any
    // rebind or un-rendered refetch during the window fails the verdict
    // closed instead of judging a stale or another identity's receipt.
    const scopeAtIssue = resourceRef.current.state.scope
    const updatedAtAtIssue = resourceRef.current.state.updatedAt
    confirmInFlightRef.current = true
    setDialog({ ...current, busy: true, phase: 'confirm', failure: null })
    void (async () => {
      try {
        // P70-LEAVE-01: exactly one membership write, nothing else on the wire.
        const result = await resourceRef.current.leave(requested.membershipId)
        if (flowTokenRef.current !== token) return
        if (result.success) {
          // C2 consumed P70-CIRCLE-STATE-03: this leave already refreshed the
          // relations AND the shared H1 catalog exactly once — no second round
          // trip here. The freshness verdict is applied from a COMMITTED
          // receipt (immediately, or when the commit renders).
          armJudgment({
            kind: 'success-left',
            token,
            recheck: requested,
            scopeAtIssue,
            updatedAtAtIssue,
            endedAt: result.membership.endedAt,
            verification: 'fresh',
            originCode: '',
          })
          return
        }
        const errorCode = result.errorCode ?? 'unknown'
        const failureClass = classifyLeaveWriteFailure(errorCode)
        if (failureClass === 'session') {
          // P70-LEAVE-03: the scope died mid-command — auto-read NOTHING.
          // The user retries actively; no left/no member claim is made.
          patchDialog({ busy: false, phase: 'error', failure: failureView(errorCode, 'session') })
          return
        }
        if (failureClass === 'rejected') {
          // Definitive rejection: the relation is unchanged — the pre-leave
          // facts stay on screen and the dialog stays open ("失败不显示已退出").
          setOutcome({
            kind: 'still-member',
            circleId: requested.circleId,
            membershipId: requested.membershipId,
            code: errorCode,
          })
          patchDialog({ busy: false, phase: 'error', failure: failureView(errorCode, 'rejected') })
          return
        }
        // `result-unknown` (transport) / `not-active` (F1 409: replay,
        // expired or SUSPENDED): exactly ONE automatic READ-ONLY
        // re-verification, then judge from the fresh receipt — never a blind
        // rewrite. The verdict separates left / member / suspended honestly.
        patchDialog({ busy: true, phase: 'recheck', failure: null, recheckUnresolved: false })
        const verificationOutcome = await resourceRef.current.invalidateAndRefresh({
          circleId: requested.circleId,
        })
        startVerificationJudgment({
          kind: 'recheck',
          token,
          recheck: requested,
          scopeAtIssue,
          updatedAtAtIssue,
          originCode: errorCode,
          verificationOutcome,
        })
      } finally {
        if (flowTokenRef.current === token) {
          confirmInFlightRef.current = false
        }
      }
    })()
  }, [armJudgment, patchDialog, setDialog, setOutcome, startVerificationJudgment])

  const reverify = useCallback(() => {
    if (reverifyInFlightRef.current || pendingJudgmentRef.current) return
    // P2-2: the read-only recovery targets the still-open flow — an existing
    // left outcome (re-freshen) OR an unresolved recheck (result unknown,
    // including after the dialog was dismissed). Without a target there is
    // nothing to re-verify and nothing is read.
    const target = reverifyTargetRef.current
    if (!target) return
    const scopeAtIssue = resourceRef.current.state.scope
    const updatedAtAtIssue = resourceRef.current.state.updatedAt
    const token = ++flowTokenRef.current
    reverifyInFlightRef.current = true
    setReverifyingState(true)
    void (async () => {
      const verificationOutcome = await resourceRef.current.invalidateAndRefresh({
        circleId: target.circleId,
      })
      startVerificationJudgment({
        kind: 'reverify',
        token,
        recheck: target,
        scopeAtIssue,
        updatedAtAtIssue,
        originCode: 'still_member_after_recheck',
        verificationOutcome,
      })
    })()
  }, [startVerificationJudgment])

  const state = useMemo<LeaveCircleState>(() => ({
    dialog,
    outcome,
    reverifying,
  }), [dialog, outcome, reverifying])

  return useMemo<UseLeaveCircleResult>(() => ({
    state,
    request,
    confirm,
    cancel,
    reverify,
  }), [state, request, confirm, cancel, reverify])
}
