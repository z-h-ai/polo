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
}

/**
 * Live start reservations by executionId. Only live (bootstrap-in-flight)
 * reservations are held here; settling or cancelling removes the entry, so
 * the map never accumulates stale records.
 */
const liveStartReservations = new Map<string, AssistantStartReservation>()

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
  const reservation: AssistantStartReservation = {
    executionId: input.sessionId,
    accountId: gate.accountId,
    productSpaceId: input.productSpaceId,
    gate,
    cancelled: false,
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
      existing
      && existing.scope.productSpaceId === input.productSpaceId
      && existing.scope.accountId === gate.accountId
    ) {
      // Already bound to the same immutable scope — adopt a fresh
      // reservation for this send.
      liveStartReservations.set(input.sessionId, reservation)
      return
    }
    const execution = buildAssistantExecution(input, gate.accountId, reservation)
    registerProductSpaceExecution(execution)
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
  reservation: AssistantStartReservation,
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
      // A live start reservation keeps the execution active through the
      // whole bootstrap so account cleanup and switch stops always see it —
      // the bootstrapping send can never be treated as a terminal record.
      const live = liveStartReservations.get(input.sessionId)
      if (live === reservation && !reservation.cancelled) return true
      const session = input.sessionManager
        .getSessions()
        .find(candidate => candidate.id === input.sessionId)
      return Boolean(session?.isProcessing)
    },
    stop: async () => {
      // Cancelling the reservation refuses any later transition to
      // processing; cancelProcessing is a safe no-op while still
      // bootstrapping.
      if (liveStartReservations.get(input.sessionId) === reservation) {
        reservation.cancelled = true
      }
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
  const live = liveStartReservations.get(input.sessionId)
  if (live !== input.reservation || live.cancelled) {
    cancelAssistantStartReservation(input.reservation)
    return false
  }
  if (
    !isTrustedStartGateCurrent(input.reservation.gate)
    || getRuntimeActiveProductSpace() !== input.reservation.productSpaceId
  ) {
    cancelAssistantStartReservation(input.reservation)
    unregisterProductSpaceExecution(input.sessionId)
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
