import {
  AccountIdSchema,
  ExecutionIdSchema,
  ProductSpaceIdSchema,
  PRODUCT_SPACE_CONTRACT_VERSION,
} from '@polo-ai/shared/product-spaces'
import type { WorkspaceId } from '@polo-ai/shared/product-spaces'
import {
  getSyncTrustedProductSpaceAccountId,
  getTrustedAccountGeneration,
  resolveTrustedProductSpaceAccountId,
} from '../handlers/rpc/trusted-product-space-account'
import {
  getRegisteredProductSpaceExecution,
  getRuntimeActiveProductSpace,
  isRuntimeOfflineReadOnly,
  isSwitchInProgress,
  registerProductSpaceExecution,
  withSwitchLock,
  type RegisteredProductSpaceExecution,
} from './product-space-executions'

const ASSISTANT_STOP_DRAIN_TIMEOUT_MS = 10_000
const ASSISTANT_STOP_POLL_INTERVAL_MS = 50

/**
 * Atomically ensures an assistant session has a registered immutable
 * execution scope. Called from every server entry that can push a session
 * into preparing/processing — including restored (cold) sessions on their
 * first send — so a switch can never leave an old assistant running in the
 * background unregistered.
 *
 * The trusted account is resolved by the CALLER: this function never
 * acquires the Admin session lock, so it is safe to call inside the switch
 * lock (GLOBAL LOCK ORDER — account replacement holds the Admin session
 * lock while revoking the fence through the switch lock).
 *
 * Returns `false` only when no trusted account was supplied: the caller
 * decides whether that is survivable (best-effort creation) or must fail
 * closed (execution start).
 */
interface AssistantExecutionSessionManager {
  getSessions(): Array<{ id: string; isProcessing: boolean }>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
}

export async function ensureAssistantSessionExecution(input: {
  sessionManager: AssistantExecutionSessionManager
  sessionId: string
  workspaceId: string
  productSpaceId: string
  name: string
  /** Trusted Admin account, resolved by the caller (never inside a lock). */
  trustedAccountId: string
}): Promise<boolean> {
  const accountId = input.trustedAccountId
  if (!accountId) return false
  const existing = getRegisteredProductSpaceExecution(input.sessionId)
  if (
    existing
    && existing.scope.productSpaceId === input.productSpaceId
    && existing.scope.accountId === accountId
  ) {
    return true
  }
  const execution: RegisteredProductSpaceExecution = {
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
      const session = input.sessionManager
        .getSessions()
        .find(candidate => candidate.id === input.sessionId)
      return Boolean(session?.isProcessing)
    },
    stop: async () => {
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
  registerProductSpaceExecution(execution)
  return true
}

/**
 * The send-path registration transaction: resolves the trusted account and
 * captures its generation BEFORE acquiring the switch lock (GLOBAL LOCK
 * ORDER — the Admin session lock must never be acquired while holding the
 * switch lock), then runs a short all-in-memory critical section that
 * re-verifies the fence, the switch state and the lock-free trusted-account
 * mirror/generation before registering. An account replacement that wins
 * concurrently advances the mirror generation, so the stale send fails
 * closed instead of registering an execution under an old account/space.
 */
export async function registerAssistantExecutionForSend(input: {
  sessionManager: AssistantExecutionSessionManager
  sessionId: string
  workspaceId: string
  productSpaceId: string
  name: string
}): Promise<void> {
  // Admin session lock acquisition BEFORE the switch lock.
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!trustedAccountId) {
    // A missing trusted account means the scope could not be bound to an
    // immutable identity — the send fails closed rather than running
    // unregistered.
    throw new Error('EXECUTION_REGISTRATION_REFUSED')
  }
  const accountGeneration = getTrustedAccountGeneration()
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
    // Lock-free freshness: the account resolved above must still be the
    // mirror's current authenticated account with the same generation.
    if (
      getSyncTrustedProductSpaceAccountId() !== trustedAccountId
      || getTrustedAccountGeneration() !== accountGeneration
    ) {
      throw new Error('EXECUTION_REGISTRATION_REFUSED')
    }
    const registered = await ensureAssistantSessionExecution({
      sessionManager: input.sessionManager,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      productSpaceId: input.productSpaceId,
      name: input.name,
      trustedAccountId,
    })
    if (!registered) {
      throw new Error('EXECUTION_REGISTRATION_REFUSED')
    }
  })
}
