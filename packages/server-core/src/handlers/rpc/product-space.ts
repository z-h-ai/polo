import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import {
  AccountIdSchema,
  ExecutionIdSchema,
  ProductSpaceIdSchema,
  PRODUCT_SPACE_CONTRACT_VERSION,
  parseActiveExecutionsForProductSpace,
  parseStopAllExecutionsResultForProductSpace,
  validateExecutionScopesForProductSpace,
} from '@polo-ai/shared/product-spaces'
import type {
  ExecutionSummary,
  StopAllExecutionsResult,
  WorkspaceId,
} from '@polo-ai/shared/product-spaces'
import { purgeAppCatalogCache } from '@polo-ai/shared/admin/app-catalog-cache'
import { clearAllOrganizationContextStorage } from '@polo-ai/shared/config'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  getRuntimeActiveProductSpace,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  setRuntimeActiveProductSpace,
  stopAllRegisteredProductSpaceExecutions,
  type RegisteredProductSpaceExecution,
} from '../../runtime/product-space-executions'
import { resolveTrustedProductSpaceAccountId } from './trusted-product-space-account'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
  RPC_CHANNELS.productSpace.SET_ACTIVE_CONTEXT,
  RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE,
] as const

const EXECUTION_ID_SCHEMA = ExecutionIdSchema
const STOP_DRAIN_TIMEOUT_MS = 8_000
const STOP_DRAIN_POLL_INTERVAL_MS = 50

type TrustedExecutionRequest = {
  trustedAccountId: string
} | {
  success: false
  errorCode: string
  message: string
}

/**
 * Every execution operation derives the account from the trusted Admin
 * session. Callers may only filter inside their own account: a request whose
 * account argument disagrees with the trusted identity is rejected outright.
 */
async function resolveTrustedExecutionRequest(
  requestedAccountId: unknown,
): Promise<TrustedExecutionRequest> {
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!trustedAccountId) {
    return {
      success: false,
      errorCode: 'UNAUTHORIZED',
      message: 'No trusted Admin session is available for ProductSpace runtime operations',
    }
  }
  if (
    typeof requestedAccountId === 'string'
    && requestedAccountId
    && requestedAccountId !== trustedAccountId
  ) {
    return {
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Execution requests cannot target another account',
    }
  }
  return { trustedAccountId }
}

function isActiveExecution(execution: RegisteredProductSpaceExecution): boolean {
  return Boolean(execution.isActive())
}

function executionSummariesForSpace(
  trustedAccountId: string,
  productSpaceId: string,
): ExecutionSummary[] {
  const summaries: ExecutionSummary[] = []
  for (const execution of listRegisteredProductSpaceExecutions()) {
    if (execution.scope.accountId !== trustedAccountId) continue
    if (execution.scope.productSpaceId !== productSpaceId) continue
    if (!isActiveExecution(execution)) continue
    summaries.push({
      executionId: EXECUTION_ID_SCHEMA.parse(execution.scope.executionId),
      scope: execution.scope,
      name: execution.name,
      status: 'running',
    })
  }
  validateExecutionScopesForProductSpace(
    summaries,
    AccountIdSchema.parse(trustedAccountId),
    ProductSpaceIdSchema.parse(productSpaceId),
  )
  return summaries
}

async function waitForExecutionStop(
  execution: RegisteredProductSpaceExecution,
): Promise<ExecutionSummary['status']> {
  const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!await execution.isActive()) return 'stopped'
    await new Promise(resolve => setTimeout(resolve, STOP_DRAIN_POLL_INTERVAL_MS))
  }
  return 'failed'
}

export async function listProductSpaceActiveExecutions(input: {
  trustedAccountId: string
  productSpaceId: string
}): Promise<ExecutionSummary[]> {
  const summaries = executionSummariesForSpace(
    input.trustedAccountId,
    input.productSpaceId,
  )
  validateExecutionScopesForProductSpace(
    summaries,
    AccountIdSchema.parse(input.trustedAccountId),
    ProductSpaceIdSchema.parse(input.productSpaceId),
  )
  return summaries
}

export async function stopAllProductSpaceExecutions(input: {
  trustedAccountId: string
  productSpaceId: string
}): Promise<StopAllExecutionsResult> {
  const accountId = AccountIdSchema.parse(input.trustedAccountId)
  const productSpaceId = ProductSpaceIdSchema.parse(input.productSpaceId)
  const active = executionSummariesForSpace(input.trustedAccountId, input.productSpaceId)
  if (active.length === 0) {
    return { allStopped: true, executions: [] }
  }

  const registeredById = new Map(
    listRegisteredProductSpaceExecutions().map(execution => [
      execution.scope.executionId,
      execution,
    ]),
  )
  const summaries: ExecutionSummary[] = []
  for (const execution of active) {
    const registered = registeredById.get(execution.executionId)
    if (!registered) {
      summaries.push({ ...execution, status: 'failed', errorCode: 'runtime_stop_failed' })
      continue
    }
    let outcome: ExecutionSummary['status']
    try {
      outcome = await registered.stop()
    } catch {
      outcome = 'failed'
    }
    if (outcome === 'stopped' && await registered.isActive()) {
      outcome = await waitForExecutionStop(registered)
    }
    summaries.push(outcome === 'stopped'
      ? { ...execution, status: 'stopped' }
      : { ...execution, status: 'failed', errorCode: 'runtime_stop_failed' })
  }

  const result: StopAllExecutionsResult = {
    allStopped: summaries.every(execution => (
      execution.status === 'stopped' || execution.status === 'failed'
    )),
    executions: summaries,
  }
  return parseStopAllExecutionsResultForProductSpace(
    result,
    accountId,
    productSpaceId,
    summaries.map(execution => execution.scope),
  )
}

/**
 * Binds an assistant session to its immutable execution scope. The account
 * always comes from the trusted Admin session; the ProductSpace is the one
 * captured at creation time and can never be reclassified.
 */
export async function registerAssistantSessionExecution(input: {
  sessionManager: HandlerDeps['sessionManager']
  sessionId: string
  workspaceId: string
  productSpaceId: string
  name: string
}): Promise<void> {
  const accountId = await resolveTrustedProductSpaceAccountId()
  if (!accountId) return
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
      const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        const session = input.sessionManager
          .getSessions()
          .find(candidate => candidate.id === input.sessionId)
        if (!session || !session.isProcessing) return 'stopped'
        await new Promise(resolve => setTimeout(resolve, STOP_DRAIN_POLL_INTERVAL_MS))
      }
      return 'failed'
    },
  }
  registerProductSpaceExecution(execution)
}

export function registerProductSpaceHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
    async (_ctx, productSpaceId: unknown, requestedAccountId?: unknown) => {
      const parsedProductSpaceId = ProductSpaceIdSchema.safeParse(productSpaceId)
      if (!parsedProductSpaceId.success) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Execution list request is invalid' }
      }
      const trusted = await resolveTrustedExecutionRequest(requestedAccountId)
      if (!('trustedAccountId' in trusted)) return trusted
      try {
        const executions = await listProductSpaceActiveExecutions({
          trustedAccountId: trusted.trustedAccountId,
          productSpaceId: parsedProductSpaceId.data,
        })
        return {
          success: true as const,
          executions: parseActiveExecutionsForProductSpace(
            executions,
            AccountIdSchema.parse(trusted.trustedAccountId),
            parsedProductSpaceId.data,
          ),
        }
      } catch (error) {
        return {
          success: false as const,
          errorCode: 'SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to list active executions',
        }
      }
    },
  )

  server.handle(
    RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
    async (_ctx, productSpaceId: unknown, requestedAccountId?: unknown) => {
      const parsedProductSpaceId = ProductSpaceIdSchema.safeParse(productSpaceId)
      if (!parsedProductSpaceId.success) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Stop-all request is invalid' }
      }
      const trusted = await resolveTrustedExecutionRequest(requestedAccountId)
      if (!('trustedAccountId' in trusted)) return trusted
      try {
        const result = await stopAllProductSpaceExecutions({
          trustedAccountId: trusted.trustedAccountId,
          productSpaceId: parsedProductSpaceId.data,
        })
        return { success: true as const, result }
      } catch (error) {
        return {
          success: false as const,
          errorCode: 'SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to stop all executions',
        }
      }
    },
  )

  // The trusted client declares the committed device space. While declared,
  // the runtime hides and refuses sessions bound to any other space.
  server.handle(
    RPC_CHANNELS.productSpace.SET_ACTIVE_CONTEXT,
    async (_ctx, productSpaceId: unknown) => {
      if (productSpaceId !== null && typeof productSpaceId !== 'string') {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Active context request is invalid' }
      }
      if (productSpaceId) {
        const trusted = await resolveTrustedExecutionRequest(undefined)
        if (!('trustedAccountId' in trusted)) return trusted
      }
      setRuntimeActiveProductSpace(
        typeof productSpaceId === 'string' && productSpaceId ? productSpaceId : null,
      )
      return { success: true as const }
    },
  )

  // One-shot pre-release direct-switch cleanup. Steps run in order and every
  // result is reported; the client fails closed when any step failed.
  server.handle(RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE, async () => {
    const results: Record<string, boolean> = {}

    try {
      await deps.sessionManager.cancelAllProcessing()
      results.legacyRuntimeStopped = true
    } catch {
      results.legacyRuntimeStopped = false
    }

    results.registeredExecutionsStopped = await stopAllRegisteredProductSpaceExecutions()
    results.legacyCatalogCacheRemoved = purgeAppCatalogCache()
    results.legacyAuthorizationCacheRemoved = clearAllOrganizationContextStorage()

    return {
      success: Object.values(results).every(passed => passed),
      results,
    }
  })
}
