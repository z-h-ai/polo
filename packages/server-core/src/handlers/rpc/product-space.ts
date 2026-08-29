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
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const EXECUTION_ID_SCHEMA = ExecutionIdSchema
const STOP_DRAIN_TIMEOUT_MS = 8_000
const STOP_DRAIN_POLL_INTERVAL_MS = 50

/** Every Polo assistant session runs as the built-in app subject. */
function assistantSubject() {
  return { kind: 'built_in_app' as const, builtInAppId: 'polo_assistant' as const }
}

function executionSummaryForSession(input: {
  sessionId: string
  accountId: string
  productSpaceId: string
  name: string
  workspaceId: string
  status: ExecutionSummary['status']
}): ExecutionSummary {
  return {
    executionId: EXECUTION_ID_SCHEMA.parse(input.sessionId),
    scope: {
      contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
      executionId: EXECUTION_ID_SCHEMA.parse(input.sessionId),
      accountId: AccountIdSchema.parse(input.accountId),
      productSpaceId: ProductSpaceIdSchema.parse(input.productSpaceId),
      workspaceId: input.workspaceId as unknown as WorkspaceId,
      subject: assistantSubject(),
    },
    name: input.name,
    status: input.status,
  }
}

/**
 * Active executions are the local runtime's in-flight AI work. The client has
 * exactly one active ProductSpace at a time, so every in-flight execution
 * belongs to the requested space; the scope echoes the request tuple so
 * responses remain valid only for that tuple.
 */
export function listProductSpaceActiveExecutions(input: {
  sessionManager: HandlerDeps['sessionManager']
  accountId: string
  productSpaceId: string
}): ExecutionSummary[] {
  const executions: ExecutionSummary[] = []
  for (const session of input.sessionManager.getSessions()) {
    if (!session.isProcessing) continue
    executions.push(executionSummaryForSession({
      sessionId: session.id,
      accountId: input.accountId,
      productSpaceId: input.productSpaceId,
      name: session.name || session.id,
      workspaceId: session.workspaceId,
      status: 'running',
    }))
  }
  validateExecutionScopesForProductSpace(
    executions,
    AccountIdSchema.parse(input.accountId),
    ProductSpaceIdSchema.parse(input.productSpaceId),
  )
  return executions
}

async function waitForSessionStop(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
): Promise<'stopped' | 'failed'> {
  const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const session = sessionManager
      .getSessions()
      .find(candidate => candidate.id === sessionId)
    if (!session || !session.isProcessing) return 'stopped'
    await new Promise(resolve => setTimeout(resolve, STOP_DRAIN_POLL_INTERVAL_MS))
  }
  return 'failed'
}

export async function stopAllProductSpaceExecutions(input: {
  sessionManager: HandlerDeps['sessionManager']
  accountId: string
  productSpaceId: string
}): Promise<StopAllExecutionsResult> {
  const accountId = AccountIdSchema.parse(input.accountId)
  const productSpaceId = ProductSpaceIdSchema.parse(input.productSpaceId)
  const active = listProductSpaceActiveExecutions({
    sessionManager: input.sessionManager,
    accountId: input.accountId,
    productSpaceId: input.productSpaceId,
  })
  if (active.length === 0) {
    return { allStopped: true, executions: [] }
  }

  const summaries: ExecutionSummary[] = []
  for (const execution of active) {
    try {
      await input.sessionManager.cancelProcessing(execution.executionId, true)
    } catch {
      // Drain polling below decides the final status; a throw here means the
      // stop signal could not be delivered.
      summaries.push({ ...execution, status: 'failed', errorCode: 'runtime_stop_failed' })
      continue
    }
    const outcome = await waitForSessionStop(input.sessionManager, execution.executionId)
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

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
] as const

export function registerProductSpaceHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(
    RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
    async (_ctx, accountId: unknown, productSpaceId: unknown) => {
      const parsedAccountId = AccountIdSchema.safeParse(accountId)
      const parsedProductSpaceId = ProductSpaceIdSchema.safeParse(productSpaceId)
      if (!parsedAccountId.success || !parsedProductSpaceId.success) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Execution list request is invalid' }
      }
      try {
        const executions = listProductSpaceActiveExecutions({
          sessionManager: deps.sessionManager,
          accountId: parsedAccountId.data,
          productSpaceId: parsedProductSpaceId.data,
        })
        return {
          success: true as const,
          executions: parseActiveExecutionsForProductSpace(
            executions,
            parsedAccountId.data,
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
    async (_ctx, accountId: unknown, productSpaceId: unknown) => {
      const parsedAccountId = AccountIdSchema.safeParse(accountId)
      const parsedProductSpaceId = ProductSpaceIdSchema.safeParse(productSpaceId)
      if (!parsedAccountId.success || !parsedProductSpaceId.success) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Stop-all request is invalid' }
      }
      try {
        const result = await stopAllProductSpaceExecutions({
          sessionManager: deps.sessionManager,
          accountId: parsedAccountId.data,
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
}
