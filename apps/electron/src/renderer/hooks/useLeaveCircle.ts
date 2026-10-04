import { useCallback, useMemo, useRef, useState } from 'react'
import type { MemberCircleLeaveMembership, MemberMembership } from '@polo-ai/shared/admin'
import { useMemberCircles } from '@/context/MemberCircleResourceContext'
import type {
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
 *   `invalid_membership_transition` (replayed/expired/suspended leave) means
 *   the relation was NOT active. For both, this hook performs exactly one
 *   automatic READ-ONLY re-verification (`invalidateAndRefresh`) and judges
 *   from the fresh authoritative receipt — it never blind-rewrites the leave
 *   (a deliberate re-confirm after an honest "still a member" verdict is the
 *   user's own act, still one write per attempt). `session_changed` /
 *   `session_unavailable` auto-read NOTHING (the scope died mid-flight); the
 *   user retries actively. A definitive server rejection keeps the dialog
 *   open with the failure — the pre-leave facts on screen stay untouched
 *   ("失败不显示已退出").
 *
 * - Post-leave presentation inputs: a confirmed leave reports the returned
 *   membership (`endedAt`, F1: active→expired, endedAt=now) so the page can
 *   keep the CORRECT object — per the F1 contract an expired relation STILL
 *   appears in `me/circles` / `me/circle-memberships`, and the rejoin web
 *   guidance consumes the SAME C2 `previewRenewal` `purchaseUrl` handoff
 *   (resolved against the confirmed Admin origin; never a raw URL, never an
 *   automatic payment, never a cross-account exit). Navigation back to the
 *   list/home after the outcome is the mounting page's (C9) routing decision
 *   via N1 ClientPageContext — this hook holds no router.
 */

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

export interface LeaveCircleFailureView {
  code: string
  kind: LeaveCircleFailureKind
  /** A deliberate re-confirm may succeed (session retry / transient rejection). */
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
   * `error` — the relation is unchanged (rejection / still a member / session).
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
   * H1 catalog, never rewrites the leave. Meaningful after `left` with
   * `pending-recheck` or after a dismissed unresolved recheck.
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
 *   NOT active (replayed leave / already expired / suspended); re-read.
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
 * relations receipt (never from cache optimism). F1: an expired relation
 * still appears in `me/circle-memberships`, so presence + `status` decides;
 * ABSENCE means there is no active relation either — the membership is gone.
 * A missing receipt (`null`) is `unverifiable` — unknown is a fact, never
 * resolved by guessing in either direction.
 */
export type LeaveRelationsVerdict = 'left' | 'member' | 'unverifiable'

export function judgeMembershipLeft(
  memberships: ReadonlyArray<Pick<MemberMembership, 'membershipId' | 'status'>> | null,
  membershipId: string,
): LeaveRelationsVerdict {
  if (memberships === null) return 'unverifiable'
  const row = memberships.find(candidate => candidate.membershipId === membershipId)
  if (!row) return 'left'
  return row.status === 'active' ? 'member' : 'left'
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
    retryable: true,
  }
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
  // double-click inside one frame still hits a real busy flag).
  const dialogRef = useRef<LeaveCircleDialogState | null>(null)
  const outcomeRef = useRef<LeaveCircleOutcome>(null)
  const confirmInFlightRef = useRef(false)
  const reverifyInFlightRef = useRef(false)
  // Monotonic flow token: every request()/reverify() supersedes in-flight
  // continuations of a previous flow, so a late write/recheck result can
  // never apply to a dialog it was not asked for (旧回执不串流程).
  const flowTokenRef = useRef(0)

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

  const request = useCallback((input: LeaveCircleRequestInput) => {
    // A new request supersedes any in-flight flow of a previous dialog.
    flowTokenRef.current += 1
    confirmInFlightRef.current = false
    reverifyInFlightRef.current = false
    setOutcome(null)
    setReverifyingState(false)
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
  }, [setDialog, setOutcome])

  const cancel = useCallback(() => {
    const current = dialogRef.current
    // The confirm WRITE must land somewhere truthful before the dialog may
    // go away — no cancel-while-writing (the UI disables the button as well).
    if (!current || (current.busy && current.phase === 'confirm')) return
    setDialog(null)
  }, [setDialog])

  /**
   * The shared read-only re-verification path: ONE `invalidateAndRefresh` on
   * the SAME context, then the verdict from the fresh receipt + outcome.
   * Returns the effective verdict so callers can branch.
   */
  const runReadOnlyReverify = useCallback(async (token: number, requested: {
    circleId: string
    membershipId: string
  }): Promise<LeaveRelationsVerdict> => {
    const verificationOutcome = await resourceRef.current.invalidateAndRefresh({
      circleId: requested.circleId,
    })
    if (flowTokenRef.current !== token) return 'unverifiable'
    const verdict = judgeMembershipLeft(
      resourceRef.current.state.memberships,
      requested.membershipId,
    )
    if (verdict === 'left') {
      setOutcome({
        kind: 'left',
        circleId: requested.circleId,
        membershipId: requested.membershipId,
        // The write receipt is absent on this path (unknown/409): endedAt is
        // unknown too — the page reads the refreshed receipt instead.
        endedAt: null,
        verification: judgeReverifyVerification(verificationOutcome),
      })
    } else if (verdict === 'member') {
      // The authoritative receipt proves the relation is STILL active — the
      // leave did not land. Honest error; a NEW user confirmation may retry.
      setOutcome({
        kind: 'still-member',
        circleId: requested.circleId,
        membershipId: requested.membershipId,
        code: 'still_member_after_recheck',
      })
    }
    // `unverifiable`: claim NEITHER left NOR member — the honest 待核对 state.
    return verdict
  }, [setOutcome])

  const confirm = useCallback(() => {
    // P70-LEAVE-01 busy 防重: synchronous guard — a second click within the
    // same frame still meets a set in-flight flag.
    if (confirmInFlightRef.current) return
    const current = dialogRef.current
    if (!current || current.busy) return
    // `confirm` is the single write per attempt. It runs from the open
    // confirmation OR as the user's deliberate retry after an honest error
    // (rejection / session / still-member) — never from `recheck`, which has
    // no rewrite path at all.
    if (current.phase !== 'confirm' && current.phase !== 'error') return
    const requested = {
      circleId: current.circleId,
      membershipId: current.membershipId,
    }
    const token = ++flowTokenRef.current
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
          // trip here. Read the settled committed receipt to report whether
          // that round trip can be trusted.
          const verification = judgeLeaveWriteSuccessVerification(resourceRef.current.state)
          setOutcome({
            kind: 'left',
            circleId: requested.circleId,
            membershipId: requested.membershipId,
            endedAt: result.membership.endedAt,
            verification,
          })
          setDialog(null)
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
        // `result-unknown` (transport) / `not-active` (F1 409 replay): exactly
        // ONE automatic READ-ONLY re-verification, then judge from the fresh
        // receipt — never a blind rewrite.
        patchDialog({ busy: true, phase: 'recheck', failure: null, recheckUnresolved: false })
        const verdict = await runReadOnlyReverify(token, requested)
        if (flowTokenRef.current !== token) return
        if (verdict === 'member') {
          patchDialog({
            busy: false,
            phase: 'error',
            failure: failureView(errorCode, 'still-member'),
          })
        } else if (verdict === 'left') {
          setDialog(null)
        } else {
          patchDialog({ busy: false, phase: 'recheck', recheckUnresolved: true })
        }
      } finally {
        if (flowTokenRef.current === token) {
          confirmInFlightRef.current = false
        }
      }
    })()
  }, [patchDialog, runReadOnlyReverify, setDialog, setOutcome])

  const reverify = useCallback(() => {
    if (reverifyInFlightRef.current) return
    const pendingOutcome = outcomeRef.current
    if (pendingOutcome?.kind !== 'left') return
    const token = ++flowTokenRef.current
    reverifyInFlightRef.current = true
    setReverifyingState(true)
    void (async () => {
      try {
        const verificationOutcome = await resourceRef.current.invalidateAndRefresh()
        if (flowTokenRef.current !== token) return
        const verdict = judgeMembershipLeft(
          resourceRef.current.state.memberships,
          pendingOutcome.membershipId,
        )
        const fresh = verdict === 'left'
          && judgeReverifyVerification(verificationOutcome) === 'fresh'
        // Patch the left outcome in place from the authoritative ref (no
        // state-updater closures — outcomeRef is the committed truth).
        const current = outcomeRef.current
        if (current?.kind === 'left' && current.membershipId === pendingOutcome.membershipId) {
          setOutcome({ ...current, verification: fresh ? 'fresh' : 'pending-recheck' })
        }
      } finally {
        if (flowTokenRef.current === token) {
          reverifyInFlightRef.current = false
          setReverifyingState(false)
        }
      }
    })()
  }, [setOutcome])

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
