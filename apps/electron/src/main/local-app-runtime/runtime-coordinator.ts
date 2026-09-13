import { createHash } from 'node:crypto'
import {
  AppAiQuerySchema,
  AppApiFileReportSchema,
  AppApiResultReportSchema,
  AppApiRunFinishSchema,
  AppApiRunStartSchema,
  createProductSpaceAppRuntimeIdentityKey,
  type AppApiStableErrorCode,
  type ProductSpaceAppRuntimeIdentity,
} from '@polo-ai/shared/product-spaces'
import { AdminError } from '@polo-ai/shared/admin'
import type { HostLlmPublicResult } from '@polo-ai/shared/agent/host-llm-executor'
import { getAppRuntimeCenter } from '@polo-ai/server-core/runtime'
import { unregisterProductSpaceExecution } from '@polo-ai/server-core/runtime/product-space-executions'
import { AppApiCapabilityRegistry, type CapabilityRecord } from './app-api-capabilities'
import {
  AppApiGateway,
  type AppApiGatewayDelegate,
  type AppApiRoute,
} from './app-api-gateway'
import {
  AppApiRunState,
  type QueryOutcome,
} from './app-api-run-state'

export interface CoordinatorAdminAdapter {
  startAppRun(
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  recordAppUsage(
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  finishAppRun(
    runId: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

export interface CoordinatorExecutor {
  execute(input: {
    prompt: string
    systemPrompt?: string
    responseFormat?: 'text' | 'json_object'
    maxOutputTokens: number
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<HostLlmPublicResult>
  dispose(): Promise<void>
}

export interface RuntimeCoordinatorAdapters {
  admin: CoordinatorAdminAdapter
  createExecutor(options: {
    connectionSlug: string
    model?: string
  }): CoordinatorExecutor
  resolveWorkspaceRoot(workspaceId: string): string | null | Promise<string | null>
  loadWorkspaceConfig(rootPath: string): {
    defaults?: { defaultLlmConnection?: string; model?: string }
  } | undefined | null
  getDefaultLlmConnection(): string | null
  sinks?: {
    reportResult?(input: Record<string, unknown>): Promise<{ revision: number }>
    reportFile?(input: Record<string, unknown>): Promise<{ revision: number }>
  }
  now?: () => number
}

export interface CapabilitySigning {
  capabilityGeneration: number
  /** Raw capability token: only for process-env injection, never persisted. */
  token: string
  environment: { POLO_APP_API_URL: string; POLO_APP_API_TOKEN: string }
  sensitiveValues: string[]
}

interface ActiveRuntime {
  identityKey: string
  identity: ProductSpaceAppRuntimeIdentity
  executionId: string
  runtimeGeneration: number
  scopeGeneration: number
  workspaceId: string
  runtimeKind: 'python' | 'js' | 'static'
  capabilityGeneration?: number
  controller: AbortController
}

interface InFlightQuery {
  runId: string
  requestId: string
  controller: AbortController
  promise: Promise<void>
}

const CLEANUP_ABORT_GRACE_MS = 2_000
const CLEANUP_REQUEST_BUDGET_MS = 5_000
const CLEANUP_TOTAL_BUDGET_MS = 10_000

function isUnknownAdminFailure(error: unknown): boolean {
  return error instanceof AdminError
    && (error.errorCode === 'TIMEOUT' || error.errorCode === 'NETWORK_ERROR')
}

function hostErrorCode(result: HostLlmPublicResult): AppApiStableErrorCode | null {
  if (result.status === 'completed' || result.status === 'partial') return null
  if (!('error' in result) || !result.error) return null
  switch (result.error.code) {
    case 'cancelled':
    case 'executor_closed':
      return 'request_cancelled'
    case 'auth_failed':
    case 'credential_unavailable':
      return 'host_auth_failed'
    case 'connection_not_found':
    case 'connection_changed':
    case 'invalid_connection':
    case 'model_not_allowed':
      return 'host_configuration_unavailable'
    case 'timed_out':
      return 'host_timed_out'
    default:
      return 'host_failed'
  }
}

/**
 * Single owner of the ProductSpace App platform boundary: loopback gateway,
 * per-launch capabilities, capability-local Run/request state, POL-102
 * metering sequencing, the sessionless Host executor lifecycle, sink
 * delegation and fail-closed replacement/shutdown ordering.
 */
export class LocalAppRuntimeCoordinator {
  readonly capabilities = new AppApiCapabilityRegistry()
  readonly runState = new AppApiRunState()
  private gateway?: AppApiGateway
  private readonly active = new Map<string, ActiveRuntime>()
  private readonly inFlight = new Map<string, InFlightQuery>()
  private shuttingDown = false

  constructor(private readonly adapters: RuntimeCoordinatorAdapters) {}

  private now(): number {
    return this.adapters.now ? this.adapters.now() : Date.now()
  }

  /** Gateway-first: the loopback boundary must exist before any App spawn. */
  async ensureGateway(): Promise<string> {
    if (!this.gateway) {
      const delegate: AppApiGatewayDelegate = {
        handle: (route, body, capability, signal) => this.handle(route, body, capability, signal),
      }
      const gateway = new AppApiGateway({
        delegate,
        verifyToken: (token, now) => this.capabilities.verify(token, now),
        now: () => this.now(),
      })
      await gateway.start()
      this.gateway = gateway
    }
    return this.gateway.url
  }

  /**
   * Signs a capability exactly once per process start, right before spawn,
   * for trusted python/js runtimes only. Static runtimes never reach here.
   */
  signCapability(input: {
    identity: ProductSpaceAppRuntimeIdentity
    workspaceId: string
    executionId: string
    runtimeKind: 'python' | 'js'
    runtimeGeneration: number
    scopeGeneration: number
  }): CapabilitySigning {
    if (this.shuttingDown) throw new Error('coordinator is shutting down')
    const identityKey = createProductSpaceAppRuntimeIdentityKey(input.identity)
    const gatewayUrl = this.gateway?.url
    if (!gatewayUrl) throw new Error('gateway is not started')
    const issued = this.capabilities.issue({
      identityKey,
      identity: input.identity,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      runtimeGeneration: input.runtimeGeneration,
      scopeGeneration: input.scopeGeneration,
    }, this.now())
    const existing = this.active.get(identityKey)
    if (existing && existing.capabilityGeneration === undefined) {
      existing.capabilityGeneration = issued.capabilityGeneration
    }
    return {
      capabilityGeneration: issued.capabilityGeneration,
      token: issued.token,
      environment: {
        POLO_APP_API_URL: gatewayUrl,
        POLO_APP_API_TOKEN: issued.token,
      },
      sensitiveValues: [issued.token],
    }
  }

  registerActiveRuntime(input: {
    identity: ProductSpaceAppRuntimeIdentity
    executionId: string
    runtimeGeneration: number
    scopeGeneration: number
    workspaceId: string
    runtimeKind: 'python' | 'js' | 'static'
    capabilityGeneration?: number
  }): ActiveRuntime {
    const identityKey = createProductSpaceAppRuntimeIdentityKey(input.identity)
    const runtime: ActiveRuntime = {
      identityKey,
      identity: input.identity,
      executionId: input.executionId,
      runtimeGeneration: input.runtimeGeneration,
      scopeGeneration: input.scopeGeneration,
      workspaceId: input.workspaceId,
      runtimeKind: input.runtimeKind,
      capabilityGeneration: input.capabilityGeneration,
      controller: new AbortController(),
    }
    this.active.set(identityKey, runtime)
    return runtime
  }

  getActiveRuntime(identity: ProductSpaceAppRuntimeIdentity): ActiveRuntime | undefined {
    return this.active.get(createProductSpaceAppRuntimeIdentityKey(identity))
  }

  getActiveRuntimeByExecution(executionId: string): ActiveRuntime | undefined {
    for (const runtime of this.active.values()) {
      if (runtime.executionId === executionId) return runtime
    }
    return undefined
  }

  /** Revokes a capability whose post-hook start failed. */
  revokeSignedCapability(capabilityGeneration: number): void {
    this.capabilities.revoke(capabilityGeneration)
    this.runState.releaseCapability(capabilityGeneration)
    this.capabilities.forget(capabilityGeneration)
  }

  /** Manager observer for an unexpected process exit of an exact runtime. */
  async handleUnexpectedExit(event: {
    runtimeGeneration: number
  }): Promise<void> {
    const runtime = [...this.active.values()]
      .find(candidate => candidate.runtimeGeneration === event.runtimeGeneration)
    if (!runtime) return
    await this.teardownRuntime(runtime, 'failed')
  }

  /**
   * Fail-closed teardown of one runtime generation: revoke → abort → bounded
   * reconfirm lane → (caller stops the process) → generation-CAS projection
   * clear → release capability resources. Best-effort at every step.
   */
  async teardownRuntime(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
    stopProcess?: () => Promise<void>,
  ): Promise<void> {
    if (runtime.capabilityGeneration !== undefined) {
      this.capabilities.revoke(runtime.capabilityGeneration)
    }
    runtime.controller.abort()
    await this.drainInFlight(runtime.identityKey)
    await this.runCleanupLane(runtime, finalStatus)
    if (stopProcess) await stopProcess().catch(() => {})
    getAppRuntimeCenter().clear(runtime.identityKey, runtime.runtimeGeneration)
    unregisterProductSpaceExecution(runtime.executionId)
    if (runtime.capabilityGeneration !== undefined) {
      this.runState.releaseCapability(runtime.capabilityGeneration)
      this.capabilities.forget(runtime.capabilityGeneration)
    }
    if (this.active.get(runtime.identityKey) === runtime) {
      this.active.delete(runtime.identityKey)
    }
  }

  private async drainInFlight(identityKey: string): Promise<void> {
    const pending = [...this.inFlight.entries()]
      .filter(([key]) => key.startsWith(`${identityKey}:`))
    for (const [, query] of pending) query.controller.abort()
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending.map(([, query]) => query.promise)),
      new Promise((resolve) => setTimeout(resolve, CLEANUP_ABORT_GRACE_MS)),
    ])
  }

  /**
   * Bounded generation-bound cleanup lane: at most one reconfirmation per
   * already-formed fact (start/receipt/finish), never a provider re-run and
   * never a new App payload. Falls back to the owner-specified terminal
   * status only when the run is cleanly finishable.
   */
  private async runCleanupLane(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
  ): Promise<void> {
    const capabilityGeneration = runtime.capabilityGeneration
    if (capabilityGeneration === undefined || !this.gateway) return
    const deadline = this.now() + CLEANUP_TOTAL_BUDGET_MS
    const controller = new AbortController()
    const budgetCheck = (): AbortSignal | undefined => {
      if (this.now() >= deadline || controller.signal.aborted) {
        controller.abort()
        return undefined
      }
      return controller.signal
    }
    const admin = this.adapters.admin
    const runs = this.runState.runsForCapability(capabilityGeneration)
    for (const { runId, record } of runs) {
      if (!budgetCheck()) return
      try {
        if (record.status === 'start_unconfirmed') {
          await admin.startAppRun(this.adminStartBody(runtime, runId), {
            signal: budgetCheck(),
          })
          this.runState.setRunStatus(capabilityGeneration, runId, 'running')
          record.status = 'running'
        }
        for (const { requestId, record: query } of this.runState.queriesForRun(capabilityGeneration, runId)) {
          if (query.state !== 'receipt_unconfirmed' || !query.outcome) continue
          await admin.recordAppUsage(
            this.receiptBody(runtime, runId, requestId, query.outcome),
            { signal: budgetCheck() },
          )
          this.runState.noteReceiptConfirmed(capabilityGeneration, runId, requestId)
        }
        if (record.status === 'finishing' || record.status === 'finish_unconfirmed') {
          await admin.finishAppRun(runId, {
            status: record.requestedFinishStatus ?? finalStatus,
          }, { signal: budgetCheck() })
        } else if (this.runState.canFinishRun(capabilityGeneration, runId)) {
          await admin.finishAppRun(runId, { status: finalStatus }, {
            signal: budgetCheck(),
          })
        } else {
          // Not cleanly finishable: leave reconciliation to the POL-102
          // server timeout instead of fabricating a terminal state.
          continue
        }
        this.runState.markTerminal(capabilityGeneration, runId, 'cleanup')
        this.runState.releaseRun(capabilityGeneration, runId)
      } catch {
        // Budget/boundary failures stop this run's local reconciliation.
      }
    }
    controller.abort()
  }

  private adminStartBody(
    runtime: ActiveRuntime,
    runId: string,
  ): Record<string, unknown> {
    return {
      runId,
      workspaceId: runtime.workspaceId,
      accountId: runtime.identity.accountId,
      productSpaceId: runtime.identity.productSpaceId,
      artifactInstanceId: runtime.identity.artifactInstanceId,
      versionId: runtime.identity.versionId,
      version: runtime.identity.version,
    }
  }

  private receiptBody(
    runtime: ActiveRuntime,
    runId: string,
    requestId: string,
    outcome: QueryOutcome,
  ): Record<string, unknown> {
    const inputTokens = outcome.kind === 'success'
      ? outcome.usage.inputTokens
      : outcome.kind === 'no_output'
        ? outcome.inputTokens ?? 0
        : 0
    const outputTokens = outcome.kind === 'success' ? outcome.usage.outputTokens : 0
    void runtime
    return { runId, requestId, inputTokens, outputTokens }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const runtimes = [...this.active.values()]
    for (const runtime of runtimes) {
      if (runtime.capabilityGeneration !== undefined) {
        this.capabilities.revoke(runtime.capabilityGeneration)
      }
      runtime.controller.abort()
    }
    await Promise.allSettled(runtimes.map(runtime => this.teardownRuntime(runtime, 'unknown')))
    await this.gateway?.close()
    this.gateway = undefined
    this.shuttingDown = false
  }

  /** Handles one authenticated gateway request end-to-end. */
  private async handle(
    route: AppApiRoute,
    body: Record<string, unknown>,
    capability: CapabilityRecord,
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const runtime = this.active.get(capability.identityKey)
    if (!runtime || runtime.capabilityGeneration !== capability.capabilityGeneration) {
      return { errorCode: 'capability_invalid' }
    }
    if (route === '/result/report' || route === '/file/report') {
      return this.handleReport(route, runtime, body)
    }
    if (route === '/run/start') return this.handleRunStart(runtime, body, signal)
    if (route === '/run/finish') return this.handleRunFinish(runtime, body, signal)
    return this.handleAiQuery(runtime, body, signal)
  }

  private async handleReport(
    route: AppApiRoute,
    runtime: ActiveRuntime,
    body: Record<string, unknown>,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const parsed = route === '/result/report'
      ? AppApiResultReportSchema.safeParse(body)
      : AppApiFileReportSchema.safeParse(body)
    if (!parsed.success) return { errorCode: 'invalid_request' }
    const run = this.runState.getRun(capabilityGenerationOf(runtime), parsed.data.runId)
    if (!run || run.status !== 'running') {
      return { errorCode: run?.status === 'terminal' ? 'run_finalized' : 'run_state_conflict' }
    }
    const sink = route === '/result/report'
      ? this.adapters.sinks?.reportResult
      : this.adapters.sinks?.reportFile
    if (!sink) return { errorCode: 'sink_unavailable' }
    const payload = parsed.data as unknown as Record<string, unknown>
    const idField = route === '/result/report' ? 'resultId' : 'fileId'
    const id = payload[idField]
    try {
      const result = await sink({
        runtimeIdentity: runtime.identity,
        workspaceId: runtime.workspaceId,
        executionId: runtime.executionId,
        processGeneration: runtime.runtimeGeneration,
        scopeGeneration: runtime.scopeGeneration,
        payload,
      })
      return { data: { [idField]: id, revision: result.revision } }
    } catch {
      return { errorCode: 'sink_unavailable' }
    }
  }

  private async handleRunStart(
    runtime: ActiveRuntime,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const parsed = AppApiRunStartSchema.safeParse(body)
    if (!parsed.success) return { errorCode: 'invalid_request' }
    const capGen = capabilityGenerationOf(runtime)
    const runId = parsed.data.runId
    const existing = this.runState.getRun(capGen, runId)
    if (existing && existing.status === 'starting_admin') {
      return { errorCode: 'request_in_progress' }
    }
    if (existing && (existing.status === 'running' || existing.status === 'terminal'
      || existing.status === 'finishing' || existing.status === 'finish_unconfirmed')) {
      return { errorCode: 'run_state_conflict' }
    }
    const record = existing ?? this.runState.createRun(capGen, runId, fingerprint(body))
    record.status = existing?.status === 'start_unconfirmed'
      ? 'start_unconfirmed'
      : 'starting_admin'
    try {
      await this.adapters.admin.startAppRun(this.adminStartBody(runtime, runId), {
        signal: anySignal([signal, runtime.controller.signal]),
      })
    } catch (error) {
      if (error instanceof AdminError && error.errorCode === 'insufficient_credit') {
        this.runState.releaseRun(capGen, runId)
        return { errorCode: 'insufficient_credit' }
      }
      if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') {
        return { errorCode: 'idempotency_conflict' }
      }
      if (error instanceof AdminError && error.errorCode === 'run_finalized') {
        this.runState.markTerminal(capGen, runId, 'server')
        this.runState.releaseRun(capGen, runId)
        return { errorCode: 'run_finalized' }
      }
      // Unknown network outcome: keep the idempotent start replayable.
      this.runState.setRunStatus(capGen, runId, 'start_unconfirmed')
      return { errorCode: 'metering_unconfirmed' }
    }
    if (runtime.controller.signal.aborted) return { errorCode: 'shutting_down' }
    this.runState.setRunStatus(capGen, runId, 'running')
    return { data: { runId, status: 'running' } }
  }

  private async handleRunFinish(
    runtime: ActiveRuntime,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const parsed = AppApiRunFinishSchema.safeParse(body)
    if (!parsed.success) return { errorCode: 'invalid_request' }
    const capGen = capabilityGenerationOf(runtime)
    const { runId, status } = parsed.data
    const run = this.runState.getRun(capGen, runId)
    if (run?.status === 'terminal') {
      return run.requestedFinishStatus === status
        ? { data: { runId, status } }
        : { errorCode: 'run_finalized' }
    }
    // An unconfirmed finish is replayed with the SAME frozen status before
    // any canFinishRun gate — never rewritten to another status.
    if (run?.status === 'finishing' || run?.status === 'finish_unconfirmed') {
      if (run.requestedFinishStatus !== status) return { errorCode: 'run_finalized' }
      return this.sendFinish(runtime, runId, status, signal)
    }
    if (!run || !this.runState.canFinishRun(capGen, runId)) {
      return { errorCode: 'run_state_conflict' }
    }
    const outcome = this.runState.beginFinish(capGen, runId, status, fingerprint(body))
    if (outcome === 'status_conflict') return { errorCode: 'run_finalized' }
    if (outcome === 'not_running') return { errorCode: 'run_state_conflict' }
    return this.sendFinish(runtime, runId, status, signal)
  }

  private async sendFinish(
    runtime: ActiveRuntime,
    runId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'unknown',
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const capGen = capabilityGenerationOf(runtime)
    try {
      await this.adapters.admin.finishAppRun(runId, { status }, {
        signal: anySignal([signal, runtime.controller.signal]),
      })
    } catch (error) {
      if (error instanceof AdminError && error.errorCode === 'run_finalized') {
        this.runState.markTerminal(capGen, runId, 'server')
        this.runState.releaseRun(capGen, runId)
        return { errorCode: 'run_finalized' }
      }
      if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') {
        return { errorCode: 'idempotency_conflict' }
      }
      this.runState.noteFinishUnconfirmed(capGen, runId)
      return { errorCode: 'metering_unconfirmed' }
    }
    if (runtime.controller.signal.aborted) return { errorCode: 'shutting_down' }
    this.runState.markTerminal(capGen, runId, 'app')
    this.runState.releaseRun(capGen, runId)
    return { data: { runId, status } }
  }

  private async handleAiQuery(
    runtime: ActiveRuntime,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const parsed = AppAiQuerySchema.safeParse(body)
    if (!parsed.success) return { errorCode: 'invalid_request' }
    const capGen = capabilityGenerationOf(runtime)
    const { runId, requestId } = parsed.data
    const admission = this.runState.admitQuery(capGen, runId, requestId, fingerprint(body))
    if (admission.kind === 'run_not_ready') {
      return {
        errorCode: admission.runStatus === 'terminal' ? 'run_finalized' : 'run_state_conflict',
      }
    }
    if (admission.kind === 'idempotency_conflict') return { errorCode: 'idempotency_conflict' }
    if (admission.kind === 'request_in_progress') return { errorCode: 'request_in_progress' }
    if (admission.kind === 'response_cache_full') return { errorCode: 'response_cache_full' }
    if (admission.kind === 'replay') {
      return this.replayQuery(runtime, runId, requestId, admission.record)
    }
    // Admitted: resolve the trusted connection/model, then run one dedicated
    // executor under its own abort controller.
    const rootPath = await this.adapters.resolveWorkspaceRoot(runtime.workspaceId)
    if (!rootPath) {
      this.releaseReservation(capGen, runId, requestId)
      return { errorCode: 'host_configuration_unavailable' }
    }
    const workspaceConfig = this.adapters.loadWorkspaceConfig(rootPath)
    const connectionSlug = workspaceConfig?.defaults?.defaultLlmConnection
      ?? this.adapters.getDefaultLlmConnection()
    if (!connectionSlug) {
      this.releaseReservation(capGen, runId, requestId)
      return { errorCode: 'host_configuration_unavailable' }
    }
    const model = workspaceConfig?.defaults?.model
    const controller = new AbortController()
    const abortForward = () => controller.abort()
    if (signal.aborted) abortForward()
    else signal.addEventListener('abort', abortForward, { once: true })
    runtime.controller.signal.addEventListener('abort', abortForward, { once: true })
    const queryKey = `${runtime.identityKey}:${runId}:${requestId}`
    const executor = this.adapters.createExecutor({ connectionSlug, model })
    const completion = (async (): Promise<QueryOutcome> => {
      try {
        const result = await executor.execute({
          prompt: parsed.data.prompt,
          ...(parsed.data.systemPrompt ? { systemPrompt: parsed.data.systemPrompt } : {}),
          ...(parsed.data.responseFormat ? { responseFormat: parsed.data.responseFormat } : {}),
          maxOutputTokens: parsed.data.maxOutputTokens,
          timeoutMs: parsed.data.timeoutMs,
          signal: controller.signal,
        })
        if (result.status === 'completed' || result.status === 'partial') {
          return {
            kind: 'success',
            status: result.status,
            text: result.text,
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
          }
        }
        if (result.status === 'no_output') {
          return { kind: 'no_output', inputTokens: result.usage?.inputTokens }
        }
        return { kind: 'error', code: hostErrorCode(result) ?? 'host_failed' }
      } finally {
        await executor.dispose().catch(() => {})
      }
    })()
    const inFlight: InFlightQuery = {
      runId,
      requestId,
      controller,
      promise: completion.then(() => {}),
    }
    this.inFlight.set(queryKey, inFlight)
    const outcome = await completion
    this.inFlight.delete(queryKey)
    runtime.controller.signal.removeEventListener('abort', abortForward)
    if (outcome.kind === 'error' && !this.runState.getQuery(capGen, runId, requestId)) {
      // Admission was released (e.g. replaced/shutdown mid-flight).
      return { errorCode: outcome.code }
    }
    const record = this.runState.noteHostTerminal(capGen, runId, requestId, outcome)
    if (!record) return { errorCode: 'run_state_conflict' }
    if (record.requiredReceipt) {
      const receiptOutcome = await this.sendReceipt(runtime, runId, requestId, outcome)
      if (receiptOutcome) return receiptOutcome
    }
    return this.outcomeResponse(requestId, outcome)
  }

  private releaseReservation(capGen: number, runId: string, requestId: string): void {
    this.runState.releaseQuery(capGen, runId, requestId)
  }

  private async sendReceipt(
    runtime: ActiveRuntime,
    runId: string,
    requestId: string,
    outcome: QueryOutcome,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode } | null> {
    const capGen = capabilityGenerationOf(runtime)
    try {
      await this.adapters.admin.recordAppUsage(
        this.receiptBody(runtime, runId, requestId, outcome),
        { signal: anySignal([runtime.controller.signal]) },
      )
    } catch (error) {
      if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') {
        this.runState.noteReceiptRejected(capGen, runId, requestId)
        return { errorCode: 'idempotency_conflict' }
      }
      if (error instanceof AdminError && error.errorCode === 'run_finalized') {
        this.runState.markTerminal(capGen, runId, 'server')
        this.runState.releaseRun(capGen, runId)
        return { errorCode: 'run_finalized' }
      }
      // Unknown: never release the body; the same receipt is replayed only.
      return { errorCode: 'metering_unconfirmed' }
    }
    this.runState.noteReceiptConfirmed(capGen, runId, requestId)
    return null
  }

  private async replayQuery(
    runtime: ActiveRuntime,
    runId: string,
    requestId: string,
    record: { state: string; outcome?: QueryOutcome; requiredReceipt: boolean },
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    const capGen = capabilityGenerationOf(runtime)
    if (record.state === 'executing') return { errorCode: 'request_in_progress' }
    if (record.state === 'receipt_rejected') return { errorCode: 'idempotency_conflict' }
    if (record.state === 'receipt_unconfirmed' && record.outcome) {
      const receiptOutcome = await this.sendReceipt(runtime, runId, requestId, record.outcome)
      if (receiptOutcome) return receiptOutcome
      return this.outcomeResponse(requestId, record.outcome)
    }
    if (record.state === 'settled') {
      if (record.requiredReceipt && !this.hasConfirmedReceipt(runtime, runId, requestId)) {
        return { errorCode: 'metering_unconfirmed' }
      }
      if (record.outcome) return this.outcomeResponse(requestId, record.outcome)
    }
    void capGen
    return { errorCode: 'run_state_conflict' }
  }

  private hasConfirmedReceipt(runtime: ActiveRuntime, runId: string, requestId: string): boolean {
    const record = this.runState.getQuery(
      capabilityGenerationOf(runtime),
      runId,
      requestId,
    )
    return Boolean(record && (!record.requiredReceipt || record.receiptConfirmed))
  }

  private outcomeResponse(
    requestId: string,
    outcome: QueryOutcome,
  ): { data?: unknown; errorCode?: AppApiStableErrorCode } {
    if (outcome.kind === 'success') {
      return {
        data: {
          requestId,
          status: outcome.status,
          text: outcome.text,
          usage: outcome.usage,
        },
      }
    }
    if (outcome.kind === 'no_output') {
      return {
        data: { requestId, status: 'no_output', error: { code: 'no_output' } },
      }
    }
    return { errorCode: outcome.code }
  }
}

function capabilityGenerationOf(runtime: ActiveRuntime): number {
  return runtime.capabilityGeneration ?? -1
}

function fingerprint(body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function anySignal(signals: Array<AbortSignal>): AbortSignal | undefined {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return signals.length > 0 ? controller.signal : undefined
}
