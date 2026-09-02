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
import { randomBytes } from 'node:crypto'
import { purgeAppCatalogCache } from '@polo-ai/shared/admin/app-catalog-cache'
import {
  clearAllOrganizationContextStorage,
  getProductSpaceContextStorage,
} from '@polo-ai/shared/config'
import {
  ListProductSpacesResponseSchema,
} from '@polo-ai/shared/product-spaces'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import {
  EXECUTION_STOP_POLL_INTERVAL_MS,
  getPendingSwitchTransaction,
  getRuntimeActiveProductSpace,
  getRuntimeActiveProductSpaceAccount,
  getRuntimeFenceGeneration,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  revokeRuntimeProductSpaceFence,
  setPendingSwitchTransaction,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  setSwitchInProgress,
  stopAllRegisteredProductSpaceExecutions,
  stopRegisteredExecutionsOnce,
  withSwitchLock,
  type RegisteredProductSpaceExecution,
} from '../../runtime/product-space-executions'
import { runLegacyLocalAppCleaner } from '../../runtime/legacy-state-cleaners'
import { clearLegacySkillCaches } from './admin'
import {
  fetchTrustedProductSpaceList,
  resolveTrustedProductSpaceAccountId,
} from './trusted-product-space-account'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
  RPC_CHANNELS.productSpace.PREPARE_SWITCH,
  RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS,
  RPC_CHANNELS.productSpace.COMMIT_SWITCH,
  RPC_CHANNELS.productSpace.CANCEL_SWITCH,
  RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT,
  RPC_CHANNELS.productSpace.RESTORE_OFFLINE_VIEW,
  RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE,
] as const

/** Stable business-RPC error for an uncommitted (null) runtime fence. */
export const PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

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
      errorCode: PRODUCT_SPACE_CONTEXT_REQUIRED,
      message: 'No committed ProductSpace is active on this device',
    }
  }
  // The fence is account-scoped: a replaced account's stale fence is never
  // operable — the renderer must re-bootstrap and commit a fresh fence.
  if (!isRuntimeFenceBoundToAccount(trustedAccountId)) {
    return {
      success: false,
      errorCode: PRODUCT_SPACE_CONTEXT_REQUIRED,
      message: 'The committed ProductSpace belongs to a different account',
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

/** Projects dispatched executions and their stop outcomes for the renderer. */
function statusesToExecutionSummaries(
  dispatched: RegisteredProductSpaceExecution[],
  statuses: Record<string, 'stopped' | 'failed'>,
): ExecutionSummary[] {
  return dispatched.map(execution => ({
    executionId: EXECUTION_ID_SCHEMA.parse(execution.scope.executionId),
    scope: execution.scope,
    name: execution.name,
    status: statuses[execution.scope.executionId] ?? 'failed',
    ...(statuses[execution.scope.executionId] === 'failed'
      ? { errorCode: 'runtime_stop_failed' }
      : {}),
  }))
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

  // One stop request per execution, dispatched concurrently; bounded workers
  // only poll liveness until a terminal outcome under one shared deadline.
  const registeredById = new Map(
    listRegisteredProductSpaceExecutions().map(execution => [
      execution.scope.executionId,
      execution,
    ]),
  )
  const targets = active.map(execution => ({
    execution,
    registered: registeredById.get(execution.executionId),
  }))
  const stopResults = await stopRegisteredExecutionsOnce(
    targets.map(target => target.registered).filter(
      (registered): registered is RegisteredProductSpaceExecution => Boolean(registered),
    ),
  )
  const outcomeById = new Map(
    stopResults.map(result => [result.executionId, result.status]),
  )

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
      const deadline = Date.now() + 10_000
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
    // Frontend wire contract: (accountId, productSpaceId) — see
    // ElectronAPI.productSpaceListActiveExecutions. The account always
    // comes first.
    async (_ctx, requestedAccountId: unknown, productSpaceId: unknown) => {
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
    // Frontend wire contract: (accountId, productSpaceId) — see
    // ElectronAPI.productSpaceStopAllExecutions. The account always
    // comes first.
    async (_ctx, requestedAccountId: unknown, productSpaceId: unknown) => {
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
  // Phase 1 of the cancellable switch: verify the target and create the
  // one-time transaction token BEFORE any execution is stopped — the token
  // is returned to the renderer immediately, so cancelling during the
  // stopping phase is real (the stop phase checks cancellation before every
  // dispatch). The fence is NOT moved and nothing is stopped yet.
  server.handle(
    RPC_CHANNELS.productSpace.PREPARE_SWITCH,
    async (_ctx, targetProductSpaceId: unknown) => {
      if (typeof targetProductSpaceId !== 'string' || !targetProductSpaceId) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Switch prepare request is invalid' }
      }
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
      }

      return withSwitchLock(async () => {
        const originProductSpaceId = getRuntimeActiveProductSpace()
        // A fence committed for another (replaced) account is never
        // switchable — it must be revoked and re-committed by a bootstrap.
        if (originProductSpaceId && !isRuntimeFenceBoundToAccount(trustedAccountId)) {
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The committed ProductSpace belongs to a different account' }
        }
        // A re-bootstrap against the already-committed SAME space is an
        // idempotent revalidation — not a no-op error. It re-verifies the
        // contract and membership online and its commit atomically
        // re-publishes the fence (clearing the offline read-only view when
        // one was active). Required so a second bootstrap of a live session
        // cannot fail and fall back to a stale device snapshot.
        const sameSpace = targetProductSpaceId === originProductSpaceId
        const offlineRevalidation =
          sameSpace && (isRuntimeOfflineReadOnly() || isRuntimeFenceBoundToAccount(trustedAccountId))
        if (sameSpace && !offlineRevalidation) {
          return {
            success: false as const,
            errorCode: 'VALIDATION_ERROR',
            message: 'The target ProductSpace is already active',
          }
        }
        // A revoke (contract loss / logout) permanently invalidates any
        // switch prepared against an older fence generation.
        const fenceGeneration = getRuntimeFenceGeneration()

        setSwitchInProgress(true)
        try {
          // Revalidation of the committed/offline view: the restored view
          // shows the same space, so a plain switch would be rejected as a
          // no-op. Instead this trusted transaction re-validates the
          // contract and membership online and its commit atomically clears
          // the offline read-only view (the fence itself is unchanged).
          const fetched = await fetchTrustedProductSpaceList()
          if (!fetched.ok) {
            // An incompatible server contract must reach the renderer
            // verbatim: it drives the fail-closed contract-blocked path
            // instead of a retryable "target failed" state. No transaction
            // exists yet, so there is nothing to revoke here.
            return {
              success: false as const,
              errorCode: fetched.errorCode,
              message: fetched.errorCode === 'product_space_contract_unsupported'
                ? 'The ProductSpace contract is not supported by this client'
                : 'ProductSpace list is unavailable',
            }
          }
          const list = fetched.list
          const target = list.productSpaces.find(space => space.id === targetProductSpaceId)
          if (!target) {
            return { success: false as const, errorCode: 'FORBIDDEN', message: 'The target ProductSpace is not available for this account' }
          }
          if (sameSpace && target.accessMode !== 'active') {
            return { success: false as const, errorCode: 'FORBIDDEN', message: 'The restored ProductSpace is no longer active' }
          }

          // Snapshot the origin executions the stop phase will terminate —
          // nothing is stopped in this phase.
          const planned: ExecutionSummary[] = []
          if (originProductSpaceId && !offlineRevalidation) {
            for (const execution of listRegisteredProductSpaceExecutions()) {
              if (execution.scope.accountId !== trustedAccountId) continue
              if (execution.scope.productSpaceId !== originProductSpaceId) continue
              let active: boolean
              try {
                active = Boolean(await execution.isActive())
              } catch {
                active = true
              }
              if (active) {
                planned.push({
                  executionId: EXECUTION_ID_SCHEMA.parse(execution.scope.executionId),
                  scope: execution.scope,
                  name: execution.name,
                  status: 'running',
                })
              }
            }
          }

          const token = randomBytes(24).toString('hex')
          setPendingSwitchTransaction({
            token,
            accountId: trustedAccountId,
            targetProductSpaceId,
            originProductSpaceId: originProductSpaceId ?? '',
            fenceGeneration,
            createdAt: Date.now(),
            status: offlineRevalidation ? 'ready' : 'prepared',
            cancelled: false,
          })
          return {
            success: true as const,
            token,
            from: originProductSpaceId,
            to: targetProductSpaceId,
            executions: planned,
          }
        } finally {
          setSwitchInProgress(false)
        }
      })
    },
  )

  // Phase 1b: the cancellable stop dispatch. Runs OUTSIDE the switch lock so
  // CANCEL_SWITCH can interleave; the pending transaction itself gates new
  // starts for the whole window. Every dispatch is preceded by a
  // cancellation check — after a cancel, executions that were not yet
  // dispatched keep running.
  server.handle(
    RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS,
    async (_ctx, stopToken: unknown) => {
      if (typeof stopToken !== 'string' || !stopToken) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Switch stop request is invalid' }
      }
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
      }
      const pending = getPendingSwitchTransaction()
      if (!pending || pending.token !== stopToken) {
        return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'No matching prepared switch transaction' }
      }
      if (pending.accountId !== trustedAccountId) {
        return { success: false as const, errorCode: 'FORBIDDEN', message: 'The prepared switch belongs to another account' }
      }
      if (pending.cancelled) {
        setPendingSwitchTransaction(null)
        setSwitchInProgress(false)
        return { success: false as const, errorCode: 'SWITCH_CANCELLED', message: 'The switch was cancelled', executions: [] }
      }
      if (pending.status === 'ready') {
        // Already finalized (idempotent retry of the stop phase).
        return { success: true as const, executions: [] }
      }
      pending.status = 'stopping'

      const originProductSpaceId = pending.originProductSpaceId || null
      const dispatched: Array<RegisteredProductSpaceExecution> = []
      const statuses: Record<string, 'stopped' | 'failed'> = {}

      setSwitchInProgress(true)
      try {
        for (const execution of listRegisteredProductSpaceExecutions()) {
          if (execution.scope.accountId !== trustedAccountId) continue
          if (execution.scope.productSpaceId !== originProductSpaceId) continue
          let active: boolean
          try {
            active = Boolean(await execution.isActive())
          } catch {
            active = true
          }
          if (!active) continue
          // Cancellation gate before EVERY dispatch.
          const current = getPendingSwitchTransaction()
          if (!current || current.token !== stopToken || current.cancelled) {
            setPendingSwitchTransaction(null)
            return {
              success: false as const,
              errorCode: 'SWITCH_CANCELLED',
              message: 'The switch was cancelled during stopping',
              executions: statusesToExecutionSummaries(dispatched, statuses),
            }
          }
          dispatched.push(execution)
          const [result] = await stopRegisteredExecutionsOnce([execution])
          statuses[execution.scope.executionId] = result?.status ?? 'failed'
        }

        // Re-enumerate under the lock: zero origin executions is a hard
        // precondition for finalizing the transaction as committable.
        const finalized = await withSwitchLock(async () => {
          const current = getPendingSwitchTransaction()
          if (!current || current.token !== stopToken || current.cancelled) {
            setPendingSwitchTransaction(null)
            return false
          }
          for (const execution of listRegisteredProductSpaceExecutions()) {
            if (execution.scope.accountId !== trustedAccountId) continue
            if (execution.scope.productSpaceId !== originProductSpaceId) continue
            let active: boolean
            try {
              active = Boolean(await execution.isActive())
            } catch {
              active = true
            }
            if (active) return false
          }
          current.status = 'ready'
          return true
        })
        if (!finalized) {
          // A failed stop phase consumes the transaction: the renderer's
          // retry always re-prepares, so no dead token lingers.
          setPendingSwitchTransaction(null)
          return {
            success: false as const,
            errorCode: 'runtime_stop_failed',
            message: 'Origin ProductSpace still has running executions',
            executions: statusesToExecutionSummaries(dispatched, statuses),
          }
        }
        return { success: true as const, executions: [] }
      } finally {
        setSwitchInProgress(false)
      }
    },
  )

  // Phase 2: one-time token commit. Requires the stop phase to have
  // finalized the transaction ('ready'), then verifies the token, the fence
  // generation (any revoke permanently invalidates prepared transactions)
  // and — inside the lock — that the origin space still has zero running
  // executions (nothing may have been registered between stop and commit).
  server.handle(
    RPC_CHANNELS.productSpace.COMMIT_SWITCH,
    async (_ctx, commitToken: unknown, targetProductSpaceId: unknown) => {
      if (typeof commitToken !== 'string' || !commitToken
        || typeof targetProductSpaceId !== 'string' || !targetProductSpaceId) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Switch commit request is invalid' }
      }
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
      }

      return withSwitchLock(async () => {
        const pending = getPendingSwitchTransaction()
        if (
          !pending
          || pending.token !== commitToken
          || pending.targetProductSpaceId !== targetProductSpaceId
        ) {
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'No matching prepared switch transaction' }
        }
        if (pending.accountId !== trustedAccountId) {
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The prepared switch belongs to another account' }
        }
        // A revoke (or any fence change) permanently invalidates the
        // prepared transaction.
        if (pending.fenceGeneration !== getRuntimeFenceGeneration()) {
          setPendingSwitchTransaction(null)
          setSwitchInProgress(false)
          return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'The prepared switch was superseded by a fence change' }
        }
        if (pending.cancelled || pending.status !== 'ready') {
          // The stop phase has not confirmed every origin execution terminal.
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'The prepared switch has not finished stopping' }
        }
        // The transaction stays PENDING and therefore cancellable through the
        // final authoritative re-validation: consuming the token before the
        // list await opened a window where CANCEL_SWITCH saw no transaction
        // and returned success while the commit still moved the fence after
        // its await resumed. Every failure below consumes the transaction.
        const consumeTransaction = (): void => {
          setPendingSwitchTransaction(null)
          setSwitchInProgress(false)
        }
        // Re-verify at commit time that the target is still visible to this
        // account under the current contract.
        const originProductSpaceId = pending.originProductSpaceId || null
        const fetched = await fetchTrustedProductSpaceList()
        if (!fetched.ok) {
          consumeTransaction()
          return {
            success: false as const,
            errorCode: fetched.errorCode,
            message: fetched.errorCode === 'product_space_contract_unsupported'
              ? 'The ProductSpace contract is not supported by this client'
              : 'ProductSpace list is unavailable',
          }
        }
        const list = fetched.list
        const target = list.productSpaces.find(space => space.id === targetProductSpaceId)
        if (!target) {
          consumeTransaction()
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The target ProductSpace is not available for this account' }
        }
        // A same-space revalidation commit re-validates online that the
        // space is still ACTIVE: a degradation to read_only between prepare
        // and commit refuses the commit without touching the fence or the
        // offline read-only view.
        if (originProductSpaceId === targetProductSpaceId && target.accessMode !== 'active') {
          consumeTransaction()
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The target ProductSpace is no longer active' }
        }
        // A same-space revalidation commit carries no origin/target delta:
        // executions of that space belong to the target as well and may keep
        // running across a re-bootstrap.
        const revalidation = originProductSpaceId === targetProductSpaceId
        if (!revalidation) {
          for (const execution of listRegisteredProductSpaceExecutions()) {
            if (execution.scope.accountId !== trustedAccountId) continue
            if (execution.scope.productSpaceId !== originProductSpaceId) continue
            let active: boolean
            try {
              active = Boolean(await execution.isActive())
            } catch {
              active = true
            }
            if (active) {
              consumeTransaction()
              return { success: false as const, errorCode: 'runtime_stop_failed', message: 'Origin executions appeared after prepare' }
            }
          }
        }
        // Final gate immediately before the fence mutation. Every await above
        // (authoritative list, liveness probes) is a window in which the user
        // may have cancelled, a logout/revoke may have advanced the fence
        // generation, or the fence may have been re-bound to another account.
        // The transaction is judged one last time as a whole, synchronously —
        // nothing can interleave between this gate and the fence write.
        const final = getPendingSwitchTransaction()
        if (
          !final
          || final.token !== commitToken
          || final.targetProductSpaceId !== targetProductSpaceId
          || final.accountId !== trustedAccountId
          || final.status !== 'ready'
        ) {
          consumeTransaction()
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'No matching prepared switch transaction' }
        }
        if (final.fenceGeneration !== getRuntimeFenceGeneration()) {
          consumeTransaction()
          return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'The prepared switch was superseded by a fence change' }
        }
        if (final.cancelled) {
          consumeTransaction()
          return { success: false as const, errorCode: 'SWITCH_CANCELLED', message: 'The switch was cancelled during commit' }
        }
        // The committed fence must never be moved for a replaced account.
        if (
          getRuntimeActiveProductSpace()
          && !isRuntimeFenceBoundToAccount(trustedAccountId)
        ) {
          consumeTransaction()
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The committed ProductSpace belongs to a different account' }
        }
        // All checks green: consume the one-time token and move the fence.
        consumeTransaction()
        // A successful online commit ends the offline read-only view and
        // (re)binds the fence to the committing trusted account.
        setRuntimeOfflineReadOnly(false)
        setRuntimeActiveProductSpaceAccount(trustedAccountId)
        setRuntimeActiveProductSpace(targetProductSpaceId)
        return { success: true as const, from: originProductSpaceId, to: targetProductSpaceId, executions: [] }
      })
    },
  )

  // Cancel is valid at any point before a commit. It runs OUTSIDE the
  // switch lock on purpose: during the stopping phase the renderer's cancel
  // must reach Main immediately, before the next stop dispatch. Clearing
  // the pending transaction both marks the cancellation (the stop phase
  // checks before every dispatch — already-dispatched stops finish, but no
  // further execution is touched) and invalidates the token.
  server.handle(
    RPC_CHANNELS.productSpace.CANCEL_SWITCH,
    async (_ctx, cancelToken: unknown) => {
      if (typeof cancelToken !== 'string' || !cancelToken) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Switch cancel request is invalid' }
      }
      const pending = getPendingSwitchTransaction()
      if (pending?.token === cancelToken && !pending.cancelled) {
        // Keep the transaction as a cancelled tombstone: the stop phase
        // observes the flag before every dispatch and reports
        // SWITCH_CANCELLED; a cancelled transaction no longer blocks new
        // starts and is cleaned up by the stop phase, the TTL, or a
        // superseding prepare.
        pending.cancelled = true
        setSwitchInProgress(false)
      }
      return { success: true as const }
    },
  )

  // The ONLY path that moves the runtime fence. Runs as one serial Main-side
  // transaction: trusted identity, target visibility/membership, running-item
  // termination and re-enumeration, then an atomic fence commit — all inside
  // the switch lock, with new starts blocked for the duration. The renderer
  // can request a verified target but can never write the fence directly.
  // Fail-closed direction only: the renderer may clear the fence (contract
  // loss, logout) but can never set it. Serialized with the switch lock and
  // it invalidates any prepared switch by consuming the pending transaction
  // and advancing the fence generation — an older prepared transaction can
  // then never commit.
  server.handle(
    RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT,
    async () => {
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session' }
      }
      // The pending transaction record is deliberately kept: its commit
      // consumes the token, then fails on the advanced fence generation —
      // a prepared switch can never land after a revoke.
      await revokeRuntimeProductSpaceFence()
      return { success: true as const }
    },
  )

  // Trusted offline restore: the snapshot comes from Main-owned preferences
  // storage (never from renderer arguments) and requires the persisted
  // verified context plus a completed cleanup ledger for the same trusted
  // account. The restored view is read-only: no resolve-launch, no new
  // App/Skill/assistant executions until an online switch re-validates.
  server.handle(RPC_CHANNELS.productSpace.RESTORE_OFFLINE_VIEW, async () => {
    const trustedAccountId = await resolveTrustedProductSpaceAccountId()
    if (!trustedAccountId) {
      return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
    }
    return withSwitchLock(async () => {
      const storage = getProductSpaceContextStorage(trustedAccountId)
      const verified = storage?.verifiedContext
      const ledger = storage?.legacyCleanup
      if (
        !verified
        || !ledger
        || !Object.values(ledger.results).every(passed => passed)
      ) {
        return {
          success: false as const,
          errorCode: PRODUCT_SPACE_CONTEXT_REQUIRED,
          message: 'No verified offline ProductSpace snapshot is available',
        }
      }
      const list = ListProductSpacesResponseSchema.safeParse(verified.list)
      if (!list.success) {
        return { success: false as const, errorCode: PRODUCT_SPACE_CONTEXT_REQUIRED, message: 'The persisted ProductSpace snapshot is invalid' }
      }
      const storedId = verified.activeProductSpaceId
        ?? list.data.personalProductSpaceId
      const listed = list.data.productSpaces.find(
        space => space.id === storedId && space.accessMode === 'active',
      )
      const activeId = listed?.id ?? list.data.personalProductSpaceId
      setPendingSwitchTransaction(null)
      setRuntimeOfflineReadOnly(true)
      // The restored read-only view belongs to the trusted account that owns
      // the verified snapshot — never to a replaced account.
      setRuntimeActiveProductSpaceAccount(trustedAccountId)
      setRuntimeActiveProductSpace(activeId)
      return {
        success: true as const,
        snapshot: {
          contractVersion: list.data.contractVersion,
          personalProductSpaceId: list.data.personalProductSpaceId,
          productSpaces: list.data.productSpaces,
          activeProductSpaceId: activeId,
        },
      }
    })
  })

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
