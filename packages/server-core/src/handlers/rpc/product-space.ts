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
  stopAndDrainExecution,
  EXECUTION_STOP_DRAIN_CONCURRENCY,
  EXECUTION_STOP_DRAIN_TIMEOUT_MS,
  EXECUTION_STOP_POLL_INTERVAL_MS,
  getRuntimeActiveProductSpace,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  setRuntimeActiveProductSpace,
  stopAllRegisteredProductSpaceExecutions,
  unregisterProductSpaceExecution,
  type RegisteredProductSpaceExecution,
} from '../../runtime/product-space-executions'
import { runLegacyLocalAppCleaner } from '../../runtime/legacy-state-cleaners'
import { clearLegacySkillCaches } from './admin'
import { resolveTrustedProductSpaceAccountId } from './trusted-product-space-account'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
  RPC_CHANNELS.productSpace.SET_ACTIVE_CONTEXT,
  RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE,
] as const

const EXECUTION_ID_SCHEMA = ExecutionIdSchema
const WORKER_POLL_INTERVAL_MS = EXECUTION_STOP_POLL_INTERVAL_MS

type TrustedExecutionRequest = {
  trustedAccountId: string
  activeProductSpaceId: string
} | {
  success: false
  errorCode: string
  message: string
}

/**
 * Every execution operation derives the account from the trusted Admin
 * session and the target space from the device's committed active
 * ProductSpace. RPC arguments are parsed strictly: malformed types are
 * VALIDATION_ERROR, an account argument that disagrees with the trusted
 * identity or a space argument that disagrees with the committed runtime
 * space is FORBIDDEN — cross-space enumeration and stopping are impossible.
 */
async function resolveTrustedExecutionRequest(
  requestedAccountId: unknown,
  requestedProductSpaceId: unknown,
): Promise<TrustedExecutionRequest> {
  if (
    requestedAccountId !== undefined
    && requestedAccountId !== null
    && typeof requestedAccountId !== 'string'
  ) {
    return {
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Execution request accountId must be a string',
    }
  }
  if (typeof requestedProductSpaceId !== 'string' || !requestedProductSpaceId) {
    return {
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: 'Execution request productSpaceId must be a non-empty string',
    }
  }

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
    && requestedAccountId !== trustedAccountId
  ) {
    return {
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Execution requests cannot target another account',
    }
  }

  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId) {
    return {
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'No committed ProductSpace is active on this device',
    }
  }
  if (requestedProductSpaceId !== activeProductSpaceId) {
    return {
      success: false,
      errorCode: 'FORBIDDEN',
      message: 'Execution requests cannot target another ProductSpace',
    }
  }

  return { trustedAccountId, activeProductSpaceId }
}

/**
 * Liveness is awaited (sync or async); probe failures fail closed by treating
 * the execution as still active.
 */
async function isActiveExecution(
  execution: RegisteredProductSpaceExecution,
): Promise<boolean> {
  try {
    return Boolean(await execution.isActive())
  } catch {
    return true
  }
}

async function executionSummariesForSpace(
  trustedAccountId: string,
  productSpaceId: string,
): Promise<ExecutionSummary[]> {
  const summaries: ExecutionSummary[] = []
  for (const execution of listRegisteredProductSpaceExecutions()) {
    if (execution.scope.accountId !== trustedAccountId) continue
    if (execution.scope.productSpaceId !== productSpaceId) continue
    if (!await isActiveExecution(execution)) continue
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

export async function listProductSpaceActiveExecutions(input: {
  trustedAccountId: string
  productSpaceId: string
}): Promise<ExecutionSummary[]> {
  const summaries = await executionSummariesForSpace(
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
  const active = await executionSummariesForSpace(input.trustedAccountId, input.productSpaceId)
  if (active.length === 0) {
    return { allStopped: true, executions: [] }
  }

  const registeredById = new Map(
    listRegisteredProductSpaceExecutions().map(execution => [
      execution.scope.executionId,
      execution,
    ]),
  )

  // Dispatch every stop request concurrently, then confirm terminal outcomes
  // with bounded concurrency under one shared deadline.
  const targets = active.map(execution => ({
    execution,
    registered: registeredById.get(execution.executionId),
  }))
  const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS
  const outcomeById = new Map<string, ExecutionSummary['status']>()
  let index = 0
  const workerCount = Math.min(EXECUTION_STOP_DRAIN_CONCURRENCY, targets.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < targets.length) {
      const target = targets[index++]!
      const { execution, registered } = target
      if (!registered) {
        outcomeById.set(execution.executionId, 'failed')
        continue
      }
      const terminal = await stopAndDrainExecution(registered, deadline)
      outcomeById.set(execution.executionId, terminal ? 'stopped' : 'failed')
      // Confirmed-terminal entries leave the registry; a failed entry stays
      // registered so a retry can stop it again.
      if (terminal) unregisterProductSpaceExecution(execution.executionId)
    }
  })
  await Promise.all(workers)

  const summaries: ExecutionSummary[] = active.map(execution => {
    const status = outcomeById.get(execution.executionId) ?? 'failed'
    return status === 'stopped'
      ? { ...execution, status: 'stopped' }
      : { ...execution, status: 'failed', errorCode: 'runtime_stop_failed' }
  })

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
 * always comes from the trusted Admin session; the ProductSpace is the
 * runtime's committed active space at creation time and can never be
 * reclassified.
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
      const deadline = Date.now() + EXECUTION_STOP_DRAIN_TIMEOUT_MS
      while (Date.now() < deadline) {
        const session = input.sessionManager
          .getSessions()
          .find(candidate => candidate.id === input.sessionId)
        if (!session || !session.isProcessing) return 'stopped'
        await new Promise(resolve => setTimeout(resolve, WORKER_POLL_INTERVAL_MS))
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
      const trusted = await resolveTrustedExecutionRequest(
        requestedAccountId,
        productSpaceId,
      )
      if (!('trustedAccountId' in trusted)) return trusted
      try {
        const executions = await listProductSpaceActiveExecutions({
          trustedAccountId: trusted.trustedAccountId,
          productSpaceId: trusted.activeProductSpaceId,
        })
        return {
          success: true as const,
          executions: parseActiveExecutionsForProductSpace(
            executions,
            AccountIdSchema.parse(trusted.trustedAccountId),
            ProductSpaceIdSchema.parse(trusted.activeProductSpaceId),
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
      const trusted = await resolveTrustedExecutionRequest(
        requestedAccountId,
        productSpaceId,
      )
      if (!('trustedAccountId' in trusted)) return trusted
      try {
        const result = await stopAllProductSpaceExecutions({
          trustedAccountId: trusted.trustedAccountId,
          productSpaceId: trusted.activeProductSpaceId,
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
  // the runtime fences sessions and executions to that space only.
  server.handle(
    RPC_CHANNELS.productSpace.SET_ACTIVE_CONTEXT,
    async (_ctx, productSpaceId: unknown) => {
      if (productSpaceId !== null && typeof productSpaceId !== 'string') {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Active context request is invalid' }
      }
      if (productSpaceId) {
        const trustedAccountId = await resolveTrustedProductSpaceAccountId()
        if (!trustedAccountId) {
          return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session' }
        }
      }
      setRuntimeActiveProductSpace(
        typeof productSpaceId === 'string' && productSpaceId ? productSpaceId : null,
      )
      return { success: true as const }
    },
  )

  // One-shot pre-release direct-switch cleanup. Steps run in order and every
  // result is reported; the client persists the ledger only when every step
  // succeeded and fails closed otherwise.
  server.handle(RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE, async () => {
    const results: Record<string, boolean> = {}

    try {
      await deps.sessionManager.cancelAllProcessing()
      results.legacyRuntimeStopped = true
    } catch {
      results.legacyRuntimeStopped = false
    }

    const registeredStop = await stopAllRegisteredProductSpaceExecutions()
    results.registeredExecutionsStopped = registeredStop.ok

    // Legacy sessions were never bound to a ProductSpace; their index is
    // invalidated by removing the sessions themselves.
    let legacySessionsRemoved = true
    try {
      for (const session of deps.sessionManager.getSessions()) {
        if (session.productSpaceId) continue
        await deps.sessionManager.deleteSession(session.id)
      }
    } catch {
      legacySessionsRemoved = false
    }
    results.legacySessionIndexRemoved = legacySessionsRemoved

    const localAppCleaner = await runLegacyLocalAppCleaner()
    results.legacyInstallationStateRemoved = localAppCleaner.ok

    results.legacyCatalogCacheRemoved = purgeAppCatalogCache()
    results.legacySkillCachesRemoved = clearLegacySkillCaches()
    results.legacyAuthorizationCacheRemoved = clearAllOrganizationContextStorage()

    return {
      success: Object.values(results).every(passed => passed),
      results,
    }
  })
}
