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
import type { ExecutionStatus } from '@polo-ai/shared/product-spaces'
import type { HandlerDeps } from '../handler-deps'
import {
  acquireSwitchActivityClaim,
  registeredExecutionsScopeRevision,
  claimSwitchPrepareIntent,
  getLastCommittedSwitch,
  getLatestSwitchPrepareIntent,
  getPendingSwitchTransaction,
  getRuntimeActiveProductSpace,
  getRuntimeActiveProductSpaceAccount,
  getRuntimeFenceGeneration,
  getRegisteredProductSpaceExecutionGeneration,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  releaseSwitchActivityClaim,
  revokeRuntimeProductSpaceFence,
  setLastCommittedSwitch,
  setPendingSwitchTransaction,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  setRuntimeProductSpaceRestricted,
  stopAllRegisteredProductSpaceExecutions,
  stopRegisteredExecutionsOnce,
  stopRegisteredProductSpaceExecutionsForSpace,
  withSwitchLock,
  type RegisteredProductSpaceExecution,
} from '../../runtime/product-space-executions'
import { runLegacyLocalAppCleaner } from '../../runtime/legacy-state-cleaners'
import { clearLegacySkillCaches } from './admin'
import {
  fetchTrustedProductSpaceList,
  getSyncTrustedProductSpaceAccountId,
  getTrustedAccountGeneration,
  resolveTrustedProductSpaceAccountId,
} from './trusted-product-space-account'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
  RPC_CHANNELS.productSpace.STOP_EXECUTION,
  RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
  RPC_CHANNELS.productSpace.GET_RESTRICTION_STATE,
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
      // Real owner-scoped runtime status (R32-4); active executions without
      // a status provider project as 'running' (historical behavior).
      status: execution.getStatus?.() ?? 'running',
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

  // R38-5: the INITIAL selection is revision-bracketed — a replacement
  // registered during the awaited liveness probes invalidates the pass and
  // the enumeration restarts against the new registry set (bounded). A
  // selection that never stabilized cannot report an empty space.
  const INITIAL_SELECTION_PASSES = 5
  let active: ExecutionSummary[] | null = null
  let selectionUnstable = false
  for (let pass = 0; pass < INITIAL_SELECTION_PASSES; pass++) {
    const revisionBefore = registeredExecutionsScopeRevision(accountId, productSpaceId)
    const selected = await executionSummariesForSpace(input.trustedAccountId, input.productSpaceId)
    if (registeredExecutionsScopeRevision(accountId, productSpaceId) === revisionBefore) {
      active = selected
      break
    }
  }
  if (active === null) {
    // R38-5: explicit nonterminal survivor state — the newest generation is
    // registered and live; project it as `stopping` with allStopped=false.
    // Never report terminal success over unresolved active work.
    selectionUnstable = true
    const survivors = listRegisteredProductSpaceExecutions().filter(
      execution => execution.scope.accountId === accountId
        && execution.scope.productSpaceId === productSpaceId,
    )
    const executions: ExecutionSummary[] = survivors.map(execution => ({
      executionId: EXECUTION_ID_SCHEMA.parse(execution.scope.executionId),
      scope: execution.scope,
      name: execution.name,
      status: 'stopping',
    }))
    const result: StopAllExecutionsResult = { allStopped: false, executions }
    return parseStopAllExecutionsResultForProductSpace(
      result,
      accountId,
      productSpaceId,
      executions.map(execution => execution.scope),
    )
  }
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
    stopResults.map(result => [result.executionId, result]),
  )

  // R35-3: a superseded drain outcome is NEVER terminal success — the
  // replacement generation that took the slot maps to a retryable failure.
  const baseSummaries: ExecutionSummary[] = active.map(execution => {
    const outcome = outcomeById.get(execution.executionId)
    const stopped = outcome?.status === 'stopped' && outcome.superseded !== true
    return stopped
      ? { ...execution, status: 'stopped' }
      : { ...execution, status: 'failed', errorCode: 'runtime_stop_failed' }
  })

  // R35-3/R37-5/R38-5: generation-stable final projection. EVERY pass builds
  // a FRESH projection from the terminal base rows; any row invalidated by a
  // mid-pass registry change is discarded with the pass and rebuilt by the
  // next pass against the new registry set. Surviving active executions are
  // projected with their REAL owner-scoped status as explicit NONTERMINAL
  // rows — allStopped is false while any scoped execution is live.
  const FINAL_PROJECTION_PASSES = 5
  let summaries: ExecutionSummary[] = baseSummaries
  let projectionStable = false
  for (let pass = 0; pass < FINAL_PROJECTION_PASSES && !projectionStable; pass++) {
    const passRows = baseSummaries.map(summary => ({ ...summary }))
    const revisionBefore = registeredExecutionsScopeRevision(accountId, productSpaceId)
    for (const execution of listRegisteredProductSpaceExecutions()) {
      if (execution.scope.accountId !== accountId) continue
      if (execution.scope.productSpaceId !== productSpaceId) continue
      let activeNow: boolean
      try {
        activeNow = Boolean(await execution.isActive())
      } catch {
        activeNow = true
      }
      if (!activeNow) continue
      const realStatus: ExecutionStatus = execution.getStatus?.() ?? 'running'
      const parsedId = EXECUTION_ID_SCHEMA.parse(execution.scope.executionId)
      const existing = passRows.find(summary => summary.executionId === parsedId)
      if (existing) {
        existing.status = realStatus
        delete existing.errorCode
      } else {
        passRows.push({
          executionId: parsedId,
          scope: execution.scope,
          name: execution.name,
          status: realStatus,
        })
      }
    }
    if (registeredExecutionsScopeRevision(accountId, productSpaceId) === revisionBefore) {
      summaries = passRows
      projectionStable = true
    }
    // An unstable pass is DISCARDED entirely — its provisional rows were
    // observed against a registry set that no longer exists.
  }
  if (!projectionStable) {
    // R38-5: the scope kept changing through every pass — bounded retries
    // are exhausted. Report a schema-compatible NONTERMINAL survivor state:
    // every in-scope live generation is projected as `stopping` (with its
    // real status when available), allStopped stays FALSE, and no row is
    // converted into terminal success over unresolved active work.
    summaries = baseSummaries.map(summary => ({ ...summary }))
    const liveRows: ExecutionSummary[] = []
    for (const execution of listRegisteredProductSpaceExecutions()) {
      if (execution.scope.accountId !== accountId) continue
      if (execution.scope.productSpaceId !== productSpaceId) continue
      let activeNow: boolean
      try {
        activeNow = Boolean(await execution.isActive())
      } catch {
        activeNow = true
      }
      if (!activeNow) continue
      const realStatus: ExecutionStatus = execution.getStatus?.() === 'stopping' || execution.getStatus?.() === 'waiting_for_network'
        ? execution.getStatus!()
        : 'stopping'
      const parsedId = EXECUTION_ID_SCHEMA.parse(execution.scope.executionId)
      const existing = summaries.find(summary => summary.executionId === parsedId)
      if (existing) {
        existing.status = realStatus
        delete existing.errorCode
      } else {
        liveRows.push({
          executionId: parsedId,
          scope: execution.scope,
          name: execution.name,
          status: realStatus,
        })
      }
    }
    summaries = [...summaries, ...liveRows]
  }

  const result: StopAllExecutionsResult = {
    // R36-2/R38-5: a surviving active replacement keeps the aggregate
    // explicitly NONTERMINAL — allStopped is false while any scoped
    // execution is live.
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
 * R34: the former dormant `registerAssistantSessionExecution` export was
 * removed — it was a repository-unused second Assistant registration path
 * that bypassed the authoritative reservation/confirmation state machine.
 * Assistant executions are registered exclusively through
 * `registerAssistantExecutionForSend` (runtime/assistant-executions), the
 * canonical reservation lifecycle.
 */

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

  // R32-4: atomic single-execution termination. The stop is scoped to the
  // one-time switch token, the trusted account and the transaction's origin
  // ProductSpace: a stale token, another account's token, or an executionId
  // outside that scope can never terminate anything. Per-item stop results
  // are reported truthfully so the frozen switch dialog can retry failures.
  server.handle(
    RPC_CHANNELS.productSpace.STOP_EXECUTION,
    async (_ctx, stopToken: unknown, executionId: unknown) => {
      if (typeof stopToken !== 'string' || !stopToken
        || typeof executionId !== 'string' || !executionId) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Execution stop request is invalid' }
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
        return { success: false as const, errorCode: 'SWITCH_CANCELLED', message: 'The switch was cancelled', status: 'stopping' as const }
      }
      const originProductSpaceId = pending.originProductSpaceId || null
      const execution = listRegisteredProductSpaceExecutions().find(
        candidate => candidate.scope.executionId === executionId
          && candidate.scope.accountId === trustedAccountId
          && candidate.scope.productSpaceId === originProductSpaceId,
      )
      if (!execution) {
        return { success: false as const, errorCode: 'EXECUTION_NOT_FOUND', message: 'The execution does not belong to this switch transaction' }
      }
      // R33-4/R34-4: capture the registry-owned entry AND its immutable
      // registration generation BEFORE the awaited stop — the drain below
      // can outlive this entry's ownership.
      const capturedGeneration = execution.generation
      // Cancellation gate before the dispatch (same rule as the all-stop
      // loop): a cancelled transaction stops accepting new terminations.
      const current = getPendingSwitchTransaction()
      if (!current || current.token !== stopToken) {
        return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'No matching prepared switch transaction' }
      }
      if (current.cancelled) {
        return { success: false as const, errorCode: 'SWITCH_CANCELLED', message: 'The switch was cancelled', status: 'stopping' as const }
      }
      const [result] = await stopRegisteredExecutionsOnce([execution])
      // R33-4/R34-4: revalidate token/account/scope/generation AFTER the
      // awaited drain. The await is a window in which the transaction may
      // have been cancelled or superseded and a same-ID replacement may have
      // taken the registry slot — a stale completion is never reported
      // against newer ownership, and a slot that lost the captured
      // registration in any way (replacement, replacement-then-cleanup) is
      // superseded rather than terminal success.
      const afterDrain = getPendingSwitchTransaction()
      if (
        !afterDrain
        || afterDrain.token !== stopToken
        || afterDrain.accountId !== trustedAccountId
        || afterDrain.cancelled
      ) {
        return {
          success: false as const,
          errorCode: afterDrain?.cancelled ? 'SWITCH_CANCELLED' : 'SWITCH_TRANSACTION_INVALID',
          message: afterDrain?.cancelled ? 'The switch was cancelled' : 'No matching prepared switch transaction',
          status: 'stopping' as const,
        }
      }
      const generationNow = getRegisteredProductSpaceExecutionGeneration(executionId)
      if (
        result?.superseded === true
        || (generationNow !== null && generationNow !== capturedGeneration)
      ) {
        // A same-ID replacement owns (or owned) the slot: this stop's
        // terminal outcome belongs to the older generation only.
        return {
          success: false as const,
          errorCode: 'EXECUTION_SUPERSEDED',
          message: 'The execution was replaced while the stop was in flight',
          status: 'failed' as const,
        }
      }
      const status: ExecutionStatus = result?.status === 'stopped' ? 'stopped' : 'failed'
      return {
        success: status === 'stopped',
        executionId,
        status,
        ...(result?.status === 'failed' ? { errorCode: 'runtime_stop_failed' as const } : {}),
      }
    },
  )

  // R32-3: trusted access-mode restriction transition. A verified list
  // refresh that degrades the active space to read_only publishes the
  // restriction fence and terminates the space's executions through the
  // no-confirmation trusted path BEFORE the restricted projection becomes
  // usable. Restoring active access clears the fence without restarting any
  // prior work. Account resolution happens BEFORE the switch lock; the
  // critical section is all in-memory (global lock order).
  server.handle(
    RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
    async (_ctx, requestedAccountId: unknown, productSpaceId: unknown, restricted: unknown) => {
      if (typeof productSpaceId !== 'string' || !productSpaceId
        || typeof restricted !== 'boolean') {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Restriction request is invalid' }
      }
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
      }
      const resolved = await resolveTrustedExecutionRequest(
        requestedAccountId,
        productSpaceId,
      )
      if (!('trustedAccountId' in resolved)) return resolved
      return withSwitchLock(async () => {
        // The fence must still be committed to this exact account/space —
        // an offline view or replaced account cannot publish restrictions.
        if (
          getRuntimeActiveProductSpace() !== productSpaceId
          || !isRuntimeFenceBoundToAccount(trustedAccountId)
          || isRuntimeOfflineReadOnly()
        ) {
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The committed ProductSpace does not match the restriction target' }
        }
        if (restricted) {
          // Fence FIRST (new starts fail closed immediately), then terminate
          // the in-flight executions without confirmation. A failed stop
          // keeps the fence set — recovery is the verified active-clear
          // transaction, never a silent unfenced window.
          setRuntimeProductSpaceRestricted(productSpaceId, true)
          const stopped = await stopRegisteredProductSpaceExecutionsForSpace(
            trustedAccountId,
            productSpaceId,
          )
          return {
            success: stopped.ok,
            // R33-2: the AUTHORITATIVE post-operation Main fence state, so
            // the renderer can reconcile against Main instead of a cached
            // previousMode.
            restricted: isRuntimeProductSpaceRestricted(productSpaceId),
            ...(stopped.ok ? {} : { errorCode: 'runtime_stop_failed', failedExecutionIds: stopped.failedExecutionIds }),
          }
        }
        setRuntimeProductSpaceRestricted(productSpaceId, false)
        return {
          success: true as const,
          restricted: isRuntimeProductSpaceRestricted(productSpaceId),
        }
      })
    },
  )

  // R34-2: authoritative Main-owned restriction state query. The renderer's
  // fence memory is ephemeral (a reload or retryBootstrap erases it), so it
  // reconciles against THIS state during bootstrap and before every
  // restriction transition decision. Main's fence — never renderer memory —
  // is the source of truth for whether a verified active recovery must
  // clear a lingering restriction.
  server.handle(
    RPC_CHANNELS.productSpace.GET_RESTRICTION_STATE,
    async (_ctx, requestedAccountId: unknown, productSpaceId: unknown) => {
      if (typeof productSpaceId !== 'string' || !productSpaceId) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Restriction query is invalid' }
      }
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      if (!trustedAccountId) {
        return { success: false as const, errorCode: 'UNAUTHORIZED', message: 'No trusted Admin session is available' }
      }
      // The query discloses restriction state only to the trusted account
      // that owns the fence; a replaced account learns nothing about its
      // predecessor's spaces.
      if (requestedAccountId !== trustedAccountId) {
        return { success: false as const, errorCode: 'FORBIDDEN', message: 'The restriction state belongs to another account' }
      }
      return {
        success: true as const,
        restricted: isRuntimeProductSpaceRestricted(productSpaceId),
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

      // Advisory pre-fetch gate (no lock held): keeps the cheap no-op
      // rejection exact without carrying the switch lock across I/O. Every
      // decision is re-verified inside the critical section below.
      {
        const preOrigin = getRuntimeActiveProductSpace()
        if (preOrigin && !isRuntimeFenceBoundToAccount(trustedAccountId)) {
          return { success: false as const, errorCode: 'FORBIDDEN', message: 'The committed ProductSpace belongs to a different account' }
        }
        const preSameSpace = targetProductSpaceId === preOrigin
        const preOfflineRevalidation =
          preSameSpace && (isRuntimeOfflineReadOnly() || isRuntimeFenceBoundToAccount(trustedAccountId))
        if (preSameSpace && !preOfflineRevalidation) {
          return {
            success: false as const,
            errorCode: 'VALIDATION_ERROR',
            message: 'The target ProductSpace is already active',
          }
        }
      }

      // Claim the monotonic prepare intent BEFORE the unlocked fetch: on
      // switch-lock re-entry only the LATEST claimed intent may install the
      // pending transaction, so two prepares finishing out of order can
      // never let the older one overwrite the newer one's token.
      const prepareIntent = claimSwitchPrepareIntent()
      const prepareActivityOwner = `prepare:${prepareIntent}`
      acquireSwitchActivityClaim(prepareActivityOwner)
      try {
        // GLOBAL LOCK ORDER: the contract-validated list fetch acquires the
        // Admin session lock (ensureValidTokens → capture) and performs
        // network I/O — it must run OUTSIDE the switch lock, because account
        // replacement holds the Admin session lock while revoking the fence
        // through the switch lock. Holding the switch lock here would let
        // COMMIT/PREPARE and login/replacement deadlock each other.
        const accountGenerationBeforeFetch = getTrustedAccountGeneration()
        const fenceGenerationBeforeFetch = getRuntimeFenceGeneration()
        const fetched = await fetchTrustedProductSpaceList()
        return await withSwitchLock(async () => {
          // Freshness proof for the unlocked fetch: the trusted account and
          // the fence must be exactly the ones the list was captured for.
          if (
            getTrustedAccountGeneration() !== accountGenerationBeforeFetch
            || getRuntimeFenceGeneration() !== fenceGenerationBeforeFetch
          ) {
            return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'The account session or fence changed during target verification' }
          }
          // CAS the prepare intent: a late (older) PREPARE must never
          // replace, cancel or consume a newer pending transaction.
          if (prepareIntent !== getLatestSwitchPrepareIntent()) {
            return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'A newer switch prepare superseded this one' }
          }
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
                  // R33-3: real owner-scoped status — the planned snapshot
                  // keeps preparing/running/waiting_for_network/stopping
                  // truthful instead of hardcoding 'running'.
                  status: execution.getStatus?.() ?? 'running',
                })
              }
            }
          }

          // Final post-await ownership gate (R30-D): every liveness probe
          // above is an await — the prepare intent, the trusted-account
          // binding and the fence must ALL still be ours immediately before
          // the transaction is installed, even when a newer prepare already
          // ended in a typed contract error. The early CAS remains as a fast
          // rejection; this is the authoritative one.
          if (
            prepareIntent !== getLatestSwitchPrepareIntent()
            || getTrustedAccountGeneration() !== accountGenerationBeforeFetch
            || getRuntimeFenceGeneration() !== fenceGenerationBeforeFetch
          ) {
            return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'A newer switch prepare superseded this one' }
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
        })
      } finally {
        releaseSwitchActivityClaim(prepareActivityOwner)
      }
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

      // Token-owned compare-and-clear (R30-E): the pending record may only
      // be consumed by the transaction it belongs to. A stale STOP whose
      // record was replaced by a newer PREPARE must NEVER clear the newer
      // transaction — it reports superseded/invalid and leaves B intact.
      const clearOwnPending = (): void => {
        const current = getPendingSwitchTransaction()
        if (current && current.token === stopToken) {
          setPendingSwitchTransaction(null)
        }
      }

      const stopActivityOwner = `stop:${stopToken}`
      acquireSwitchActivityClaim(stopActivityOwner)
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
          // Cancellation/ownership gate before EVERY dispatch.
          const current = getPendingSwitchTransaction()
          if (!current) {
            return {
              success: false as const,
              errorCode: 'SWITCH_TRANSACTION_INVALID',
              message: 'No matching prepared switch transaction',
              executions: statusesToExecutionSummaries(dispatched, statuses),
            }
          }
          if (current.token !== stopToken) {
            // A newer PREPARE owns the pending record: leave it untouched.
            return {
              success: false as const,
              errorCode: 'SWITCH_SUPERSEDED',
              message: 'The switch was superseded by a newer prepare',
              executions: statusesToExecutionSummaries(dispatched, statuses),
            }
          }
          if (current.cancelled) {
            clearOwnPending()
            return {
              success: false as const,
              errorCode: 'SWITCH_CANCELLED',
              message: 'The switch was cancelled during stopping',
              executions: statusesToExecutionSummaries(dispatched, statuses),
            }
          }
          dispatched.push(execution)
          const [result] = await stopRegisteredExecutionsOnce([execution])
          // R35-3: a superseded outcome is a retryable failure in the
          // per-row projection — never a terminal success against the
          // replacement generation that now owns the slot.
          statuses[execution.scope.executionId] = result?.status === 'stopped' && result.superseded !== true
            ? 'stopped'
            : 'failed'
        }

        // Re-enumerate under the lock: zero origin executions is a hard
        // precondition for finalizing the transaction as committable.
        const finalized = await withSwitchLock(async (): Promise<'ready' | 'gone' | 'superseded' | 'cancelled' | 'busy'> => {
          const current = getPendingSwitchTransaction()
          if (!current) return 'gone'
          if (current.token !== stopToken) return 'superseded'
          if (current.cancelled) {
            clearOwnPending()
            return 'cancelled'
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
            if (active) return 'busy'
          }
          current.status = 'ready'
          return 'ready'
        })
        if (finalized === 'ready') {
          return { success: true as const, executions: [] }
        }
        if (finalized === 'cancelled') {
          return {
            success: false as const,
            errorCode: 'SWITCH_CANCELLED',
            message: 'The switch was cancelled during stopping',
            executions: statusesToExecutionSummaries(dispatched, statuses),
          }
        }
        if (finalized === 'superseded' || finalized === 'gone') {
          // A newer PREPARE owns the pending record (or none is left): stale
          // STOP A must not consume it.
          return {
            success: false as const,
            errorCode: finalized === 'superseded' ? 'SWITCH_SUPERSEDED' : 'SWITCH_TRANSACTION_INVALID',
            message: finalized === 'superseded'
              ? 'The switch was superseded by a newer prepare'
              : 'No matching prepared switch transaction',
            executions: statusesToExecutionSummaries(dispatched, statuses),
          }
        }
        // A failed stop phase consumes the transaction: the renderer's
        // retry always re-prepares, so no dead token lingers.
        clearOwnPending()
        return {
          success: false as const,
          errorCode: 'runtime_stop_failed',
          message: 'Origin ProductSpace still has running executions',
          executions: statusesToExecutionSummaries(dispatched, statuses),
        }
      } finally {
        releaseSwitchActivityClaim(stopActivityOwner)
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

      // GLOBAL LOCK ORDER: the contract-validated list fetch acquires the
      // Admin session lock (ensureValidTokens → capture) and performs
      // network I/O — it must run OUTSIDE the switch lock. Account
      // replacement holds the Admin session lock while revoking the fence
      // through the switch lock; acquiring the Admin session lock under the
      // switch lock would let COMMIT and login/replacement deadlock each
      // other. The transaction stays PENDING and therefore cancellable
      // through this unlocked window and the probes below.
      const accountGenerationBeforeFetch = getTrustedAccountGeneration()
      const fenceGenerationBeforeFetch = getRuntimeFenceGeneration()
      const fetched = await fetchTrustedProductSpaceList()

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
          return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'The prepared switch was superseded by a fence change' }
        }
        if (pending.cancelled) {
          // Cancelled during the unlocked fetch window: the switch stays on
          // the origin and the tombstone is consumed.
          setPendingSwitchTransaction(null)
          return { success: false as const, errorCode: 'SWITCH_CANCELLED', message: 'The switch was cancelled during commit' }
        }
        if (pending.status !== 'ready') {
          // The stop phase has not confirmed every origin execution terminal.
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', message: 'The prepared switch has not finished stopping' }
        }
        // Every failure below consumes the transaction.
        const consumeTransaction = (): void => {
          setPendingSwitchTransaction(null)
        }
        // Membership/list freshness: the captured list must still belong to
        // the trusted account, and the fence must be exactly the one the
        // fetch was bracketed by — no revoke, rebind, restore or account
        // transition may have happened while the fetch was in flight.
        if (
          getTrustedAccountGeneration() !== accountGenerationBeforeFetch
          || getRuntimeFenceGeneration() !== fenceGenerationBeforeFetch
        ) {
          consumeTransaction()
          return { success: false as const, errorCode: 'SWITCH_SUPERSEDED', message: 'The account session or fence changed during commit verification' }
        }
        // Re-verify at commit time that the target is still visible to this
        // account under the current contract.
        const originProductSpaceId = pending.originProductSpaceId || null
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
        // (liveness probes) is a window in which the user may have cancelled
        // or a revoke may have advanced the fence generation. The transaction
        // is judged one last time as a whole, synchronously — nothing can
        // interleave between this gate and the fence write.
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
        // Linearization record: a cancellation that is only processed after
        // this point must learn that the commit won, with the authoritative
        // target, instead of receiving a no-op success. The record is bound
        // to the fence generation this commit produced, so a later revoke,
        // rebind, restore or account replacement invalidates it atomically.
        setLastCommittedSwitch({
          token: commitToken,
          accountId: trustedAccountId,
          targetProductSpaceId,
          fenceGeneration: getRuntimeFenceGeneration(),
        })
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
  //
  // The response is the AUTHORITATIVE linearization verdict for the
  // renderer: `cancelled` means the transaction was still cancellable (the
  // commit's final gate will reject it — the switch stays on the origin);
  // `already_committed` means the commit already won its final gate and
  // moved the fence, and the response carries the committed target plus the
  // CURRENT authoritative fence read-back so the renderer can converge to
  // the committed target (or detect a newer commit superseded it);
  // `no_transaction` matches nothing known (stale token) — stay put.
  server.handle(
    RPC_CHANNELS.productSpace.CANCEL_SWITCH,
    async (_ctx, cancelToken: unknown) => {
      if (typeof cancelToken !== 'string' || !cancelToken) {
        return { success: false as const, errorCode: 'VALIDATION_ERROR', message: 'Switch cancel request is invalid' }
      }
      // SYNCHRONOUS, lock-free pending-cancel gate — runs before ANY await so
      // a cancellation is never delayed behind the Admin session lock while
      // the stop phase keeps dispatching. The transaction captured the
      // trusted account at prepare time; the synchronous trusted-account
      // mirror (maintained by the Admin session lifecycle, no lock) proves
      // the canceller is still the same account, fail-closed on `unknown`.
      const pending = getPendingSwitchTransaction()
      if (pending?.token === cancelToken) {
        const mirrorAccountId = getSyncTrustedProductSpaceAccountId()
        if (mirrorAccountId && mirrorAccountId === pending.accountId) {
          if (!pending.cancelled) {
            // Keep the transaction as a cancelled tombstone: the stop phase
            // observes the flag before every dispatch and reports
            // SWITCH_CANCELLED; a cancelled transaction no longer blocks new
            // starts and is cleaned up by the stop phase, the TTL, or a
            // superseding prepare.
            pending.cancelled = true
          }
          return { success: true as const, outcome: 'cancelled' as const }
        }
        // A stale/replaced-account token stays invalid: it must not mark the
        // transaction and reveals nothing about any fence.
        return { success: true as const, outcome: 'no_transaction' as const }
      }
      // The disclosing `already_committed` branch is account-authenticated:
      // the committed record may only be read back by the same trusted
      // Admin account that committed it. (Runs outside the switch lock; the
      // Admin session lock is never held by the switch lock. The pending
      // cancellation gate above was already handled synchronously.)
      const trustedAccountId = await resolveTrustedProductSpaceAccountId()
      const committed = getLastCommittedSwitch()
      if (
        committed
        && committed.token === cancelToken
        && trustedAccountId !== null
        && committed.accountId === trustedAccountId
        // The anchor must still describe the CURRENT fence: a revoke,
        // rebind, restore, logout or account replacement cleared the record
        // and advanced the generation, so a stale token can neither
        // authenticate nor disclose anything.
        && committed.fenceGeneration === getRuntimeFenceGeneration()
        && getRuntimeActiveProductSpace() === committed.targetProductSpaceId
      ) {
        return {
          success: true as const,
          outcome: 'already_committed' as const,
          committedTargetProductSpaceId: committed.targetProductSpaceId,
          // Authoritative fence read-back: when a newer commit has already
          // moved the fence elsewhere, this diverges from the committed
          // target above and the renderer must not converge to it.
          activeProductSpaceId: getRuntimeActiveProductSpace(),
        }
      }
      return { success: true as const, outcome: 'no_transaction' as const }
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
