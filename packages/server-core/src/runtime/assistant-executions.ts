import {
  AccountIdSchema,
  ExecutionIdSchema,
  ProductSpaceIdSchema,
  PRODUCT_SPACE_CONTRACT_VERSION,
} from '@polo-ai/shared/product-spaces'
import type { WorkspaceId } from '@polo-ai/shared/product-spaces'
import {
  getRegisteredProductSpaceExecution,
  getRuntimeActiveProductSpace,
  isRuntimeOfflineReadOnly,
  isSwitchInProgress,
  registerProductSpaceExecution,
  unregisterProductSpaceExecution,
  withSwitchLock,
  type RegisteredProductSpaceExecution,
} from './product-space-executions'
import {
  captureTrustedStartGate,
  isTrustedStartGateCurrent,
  type TrustedStartGate,
} from './trusted-start-gate'

const ASSISTANT_STOP_DRAIN_TIMEOUT_MS = 10_000
const ASSISTANT_STOP_POLL_INTERVAL_MS = 50

/**
 * Operation-owned, cancellable Assistant start reservation (R30-B). Created
 * with the execution registration BEFORE any send bootstrap work, it keeps
 * the execution visible and active to account cleanup and switch stops
 * through the whole bootstrap — until the atomic transition to processing.
 *
 * - `stop()` (account cleanup / switch stop / logout) cancels the
 *   reservation: the later `setProcessing`/`agent.chat` transition is then
 *   refused by `confirmAssistantStartProcessing`, so no processing session
 *   agent can survive without a registered ProductSpace execution.
 * - `confirmAssistantStartProcessing` CAS-checks the reservation identity
 *   together with the trusted account/fence context immediately before the
 *   transition and settles the reservation on success.
 */
export interface AssistantStartReservation {
  executionId: string
  accountId: string
  productSpaceId: string
  gate: TrustedStartGate
  cancelled: boolean
  /**
   * Registration version (R31-3): monotonic per executionId. Every
   * registration adopts a new version, and confirm/release operations CAS
   * on it — a stale reservation can never confirm, unregister or release a
   * newer send's execution.
   */
  registrationVersion: number
}

/**
 * Live start reservations by executionId. Only live (bootstrap-in-flight)
 * reservations are held here; settling or cancelling removes the entry, so
 * the map never accumulates stale records.
 */
const liveStartReservations = new Map<string, AssistantStartReservation>()

/** Latest registration version per executionId (R31-3 ownership CAS). */
const sessionRegistrationVersions = new Map<string, number>()

interface AssistantExecutionSessionManager {
  getSessions(): Array<{ id: string; isProcessing: boolean }>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
}

/**
 * Atomically ensures an assistant session has a registered immutable
 * execution scope with a live start reservation. Called from the send path
 * BEFORE any bootstrap work.
 *
 * The trusted-start gate is captured by the CALLER before the switch lock
 * (GLOBAL LOCK ORDER — the Admin session lock must never be acquired while
 * holding the switch lock; account replacement holds the Admin session lock
 * while revoking the fence through the switch lock). The short critical
 * section re-verifies fence, switch state and the full gate — including the
 * account-bound fence (`isRuntimeFenceBoundToAccount`) — so a fence bound to
 * another account can never host a registration.
 */
export async function registerAssistantExecutionForSend(input: {
  sessionManager: AssistantExecutionSessionManager
  sessionId: string
  workspaceId: string
  productSpaceId: string
  name: string
}): Promise<AssistantStartReservation> {
  const gate = await captureTrustedStartGate()
  if (!gate) {
    // A missing trusted account means the scope could not be bound to an
    // immutable identity — the send fails closed rather than running
    // unregistered.
    throw new Error('EXECUTION_REGISTRATION_REFUSED')
  }
  // R31-3: every registration adopts a new ownership version for the
  // session; the registry entry's closures resolve THIS version's live
  // reservation dynamically, so a second/concurrent send fully owns its own
  // reservation and no stale closure can cancel it.
  const registrationVersion = (sessionRegistrationVersions.get(input.sessionId) ?? 0) + 1
  sessionRegistrationVersions.set(input.sessionId, registrationVersion)
  const reservation: AssistantStartReservation = {
    executionId: input.sessionId,
    accountId: gate.accountId,
    productSpaceId: input.productSpaceId,
    gate,
    cancelled: false,
    registrationVersion,
  }
  await withSwitchLock(async () => {
    const fence = getRuntimeActiveProductSpace()
    if (
      !fence
      || isRuntimeOfflineReadOnly()
      || isSwitchInProgress()
      || input.productSpaceId !== fence
    ) {
      throw new Error('EXECUTION_REGISTRATION_REFUSED')
    }
    // Complete account-fence gate (R30-C): the fence must be bound to the
    // trusted account as well as matching the ProductSpace id, and no
    // account transition may have begun.
    if (!isTrustedStartGateCurrent(gate)) {
      throw new Error('EXECUTION_REGISTRATION_REFUSED')
    }
    const existing = getRegisteredProductSpaceExecution(input.sessionId)
    if (
      !existing
      || existing.scope.productSpaceId !== input.productSpaceId
      || existing.scope.accountId !== gate.accountId
    ) {
      // (Re)bind the immutable scope; the closures resolve the CURRENT live
      // reservation dynamically (R31-3), so adopting a new reservation never
      // leaves the registry bound to a stale one.
      const execution = buildAssistantExecution(input, gate.accountId)
      registerProductSpaceExecution(execution)
    }
    liveStartReservations.set(input.sessionId, reservation)
  })
  return reservation
}

function buildAssistantExecution(
  input: {
    sessionManager: AssistantExecutionSessionManager
    sessionId: string
    workspaceId: string
    productSpaceId: string
    name: string
  },
  accountId: string,
): RegisteredProductSpaceExecution {
  return {
    scope: {
      contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
      executionId: ExecutionIdSchema.parse(input.sessionId),
      accountId: AccountIdSchema.parse(accountId),
      productSpaceId: ProductSpaceIdSchema.parse(input.productSpaceId),
      workspaceId: (input.workspaceId || 'assistant') as unknown as WorkspaceId,
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
    },
    kind: 'assistant_session',
    name: input.name,
    ref: input.sessionId,
    isActive: () => {
      // R31-3: the closure resolves the CURRENT operation-owned reservation
      // dynamically — a second/concurrent send's reservation is the one
      // that keeps the execution active through its bootstrap, and a stale
      // reservation can never mask it.
      const live = liveStartReservations.get(input.sessionId)
      if (live && !live.cancelled) return true
      const session = input.sessionManager
        .getSessions()
        .find(candidate => candidate.id === input.sessionId)
      return Boolean(session?.isProcessing)
    },
    stop: async () => {
      // Cancelling the CURRENT live reservation refuses any later transition
      // to processing for whichever send owns it now (R31-3);
      // cancelProcessing is a safe no-op while still bootstrapping.
      const live = liveStartReservations.get(input.sessionId)
      if (live) live.cancelled = true
      await input.sessionManager.cancelProcessing(input.sessionId, true)
      const deadline = Date.now() + ASSISTANT_STOP_DRAIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        const session = input.sessionManager
          .getSessions()
          .find(candidate => candidate.id === input.sessionId)
        if (!session || !session.isProcessing) return 'stopped'
        await new Promise(resolve => setTimeout(resolve, ASSISTANT_STOP_POLL_INTERVAL_MS))
      }
      return 'failed'
    },
  }
}

/**
 * The atomic transition to processing. The send path must call this
 * immediately before `setProcessing`/agent start: it CAS-checks the live
 * reservation identity, cancellation state and the full trusted-start gate
 * (mirror account, account generation, transition epoch, account-bound
 * fence). On success the reservation settles. On any mismatch the
 * reservation is cancelled, the unregistered execution is removed, and
 * `false` is returned — the send must fail closed without reaching
 * `agent.chat`.
 */
export function confirmAssistantStartProcessing(input: {
  sessionId: string
  reservation: AssistantStartReservation
}): boolean {
  // R31-3 CAS: the SAME live reservation AND the same registered execution
  // (still present, still this registration version) — cleanup must never
  // be able to unregister the execution and then let a stale send confirm.
  const live = liveStartReservations.get(input.sessionId)
  const registered = getRegisteredProductSpaceExecution(input.sessionId)
  if (
    live !== input.reservation
    || live.cancelled
    || !registered
    || sessionRegistrationVersions.get(input.sessionId) !== input.reservation.registrationVersion
  ) {
    cancelAssistantStartReservation(input.reservation)
    return false
  }
  if (
    !isTrustedStartGateCurrent(input.reservation.gate)
    || getRuntimeActiveProductSpace() !== input.reservation.productSpaceId
  ) {
    cancelAssistantStartReservation(input.reservation)
    unregisterProductSpaceExecution(input.sessionId)
    sessionRegistrationVersions.delete(input.sessionId)
    return false
  }
  // Settled: from here the execution's liveness is `isProcessing`.
  liveStartReservations.delete(input.sessionId)
  return true
}

/** Releases a live reservation without unregistering the execution (paths
 * that end without starting processing, e.g. mid-stream queue or dedup). */
export function cancelAssistantStartReservation(reservation: AssistantStartReservation): void {
  reservation.cancelled = true
  const live = liveStartReservations.get(reservation.executionId)
  if (live === reservation) liveStartReservations.delete(reservation.executionId)
}

/**
 * Ownership-aware release (R31-4): cancels the reservation and unregisters
 * the execution ONLY when the reservation still owns the session's latest
 * registration version. A newer send's registration is never touched.
 */
export function releaseAssistantStartExecution(reservation: AssistantStartReservation): void {
  cancelAssistantStartReservation(reservation)
  releaseAssistantStartExecutionVersion(reservation.executionId, reservation.registrationVersion)
}

/**
 * Version-CAS release for paths that no longer hold the reservation object
 * (post-confirm failures): unregisters the execution only when
 * `registrationVersion` is still the session's latest registration.
 */
export function releaseAssistantStartExecutionVersion(
  executionId: string,
  registrationVersion: number | null | undefined,
): void {
  if (registrationVersion === null || registrationVersion === undefined) return
  if (sessionRegistrationVersions.get(executionId) !== registrationVersion) return
  if (getRegisteredProductSpaceExecution(executionId)) {
    unregisterProductSpaceExecution(executionId)
  }
  sessionRegistrationVersions.delete(executionId)
}

/** Test reset: clears all live reservations and ownership versions. */
export function resetAssistantStartReservationsForTests(): void {
  liveStartReservations.clear()
  sessionRegistrationVersions.clear()
}
