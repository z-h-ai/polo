import {
  AccountIdSchema,
  ExecutionIdSchema,
  ProductSpaceIdSchema,
  PRODUCT_SPACE_CONTRACT_VERSION,
} from '@polo-ai/shared/product-spaces'
import type { WorkspaceId } from '@polo-ai/shared/product-spaces'
import { resolveTrustedProductSpaceAccountId } from '../handlers/rpc/trusted-product-space-account'
import {
  getRegisteredProductSpaceExecution,
  registerProductSpaceExecution,
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
 * Returns `false` only when no trusted Admin account is available: the
 * caller decides whether that is survivable (best-effort creation) or must
 * fail closed (execution start).
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
}): Promise<boolean> {
  const accountId = await resolveTrustedProductSpaceAccountId()
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
