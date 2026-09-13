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
import type {
  AdminFinishAppRunInput,
  AdminRecordAppUsageInput,
  AdminStartAppRunInput,
} from '@polo-ai/shared/admin'
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
    input: AdminStartAppRunInput,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  recordAppUsage(
    input: AdminRecordAppUsageInput,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  finishAppRun(
    runId: string,
    input: AdminFinishAppRunInput,
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
  /**
   * Trusted process stop for one active runtime (exact-version generation
   * CAS). Used by expiry/shutdown teardowns so every stop entry follows the
   * unified revoke→abort→cleanup→stop→CAS-clear order.
   */
  stopRuntime?(runtime: {
    identity: ProductSpaceAppRuntimeIdentity
    runtimeGeneration: number
  }): Promise<void>
  now?: () => number
  /** Coordinator-wide cap on retained runId ownership tombstones. */
  runIdTombstoneHighWater?: number
  /**
   * Schedules the generation-bound capability expiry task. Defaults to
   * setTimeout/clearTimeout; tests inject a deterministic scheduler.
   */
  scheduleExpiry?(delayMs: number, callback: () => void): () => void
}

export interface CapabilitySigning {
  capabilityGeneration: number
  /** Raw capability token: only for process-env injection, never persisted. */
  token: string
  environment: { POLO_APP_API_URL: string; POLO_APP_API_TOKEN: string }
  sensitiveValues: string[]
}

export interface ActiveRuntime {
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
  runtimeGeneration: number
  runId: string
  requestId: string
  controller: AbortController
  promise: Promise<void>
}

/** An admitted (in-flight) run/start Admin fact, owned by one generation. */
interface InFlightStart {
  runtimeGeneration: number
  capabilityGeneration: number
  runId: string
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

/** Trusted provider-final usage of a terminal Host result, if present. */
function hostUsage(
  result: HostLlmPublicResult,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!('usage' in result) || !result.usage) return undefined
  const { inputTokens, outputTokens } = result.usage
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return undefined
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) return undefined
  return { inputTokens, outputTokens }
}

/**
 * Single owner of the ProductSpace App platform boundary: loopback gateway,
 * per-launch capabilities, capability-local Run/request state, POL-102
 * metering sequencing, the sessionless Host executor lifecycle, sink
 * delegation and fail-closed replacement/shutdown ordering.
 */
export class LocalAppRuntimeCoordinator {
  readonly capabilities = new AppApiCapabilityRegistry()
  readonly runState: AppApiRunState
  private gateway?: AppApiGateway
  private readonly active = new Map<string, ActiveRuntime>()
  private readonly inFlight = new Map<string, InFlightQuery>()
  private readonly inFlightStarts = new Map<string, InFlightStart>()
  private readonly expiryTimers = new Map<number, () => void>()
  /**
   * Unique in-progress teardown per identityKey+runtimeGeneration. The
   * composite key is load-bearing: manager-local runtime generations collide
   * across identities, so a generation-only key would let identity B reuse
   * identity A's in-flight guard and skip its own teardown entirely.
   */
  private readonly teardownGuarantees = new Map<string, Promise<void>>()
  /**
   * Bounded terminal lifecycle marker: per runtime identity, the highest
   * manager-local runtime generation whose teardown has settled — a stale
   * late callback for `generation <= highWater(identity)` is provably
   * terminal and fails closed. Storage is bounded by the number of DISTINCT
   * App identities on this device (never by generation churn).
   */
  private readonly tornDownThroughGeneration = new Map<string, number>()

  private isGenerationTornDown(runtime: {
    identityKey: string
    runtimeGeneration: number
  }): boolean {
    return runtime.runtimeGeneration <= (this.tornDownThroughGeneration.get(runtime.identityKey) ?? 0)
  }

  private markGenerationTornDown(runtime: {
    identityKey: string
    runtimeGeneration: number
  }): void {
    this.tornDownThroughGeneration.set(
      runtime.identityKey,
      Math.max(
        this.tornDownThroughGeneration.get(runtime.identityKey) ?? 0,
        runtime.runtimeGeneration,
      ),
    )
  }
  /** Explicit reconciliation outcomes for runs frozen during teardown. */
  private readonly reconciledStarts = new Map<string, 'confirmed_and_finished'>()
  private shutdownPromise?: Promise<void>
  private shuttingDown = false

  constructor(private readonly adapters: RuntimeCoordinatorAdapters) {
    this.runState = new AppApiRunState(
      adapters.runIdTombstoneHighWater !== undefined
        ? { runIdTombstoneHighWater: adapters.runIdTombstoneHighWater }
        : undefined,
    )
  }

  private now(): number {
    return this.adapters.now ? this.adapters.now() : Date.now()
  }

  /** Gateway-first: the loopback boundary must exist before any App spawn. */
  async ensureGateway(): Promise<string> {
    if (this.shuttingDown) {
      // Shutdown is TERMINAL for this coordinator instance: the loopback
      // platform boundary can never be reopened ("stop accepting starts").
      throw new Error('coordinator is shutting down')
    }
    if (!this.gateway) {
      const delegate: AppApiGatewayDelegate = {
        handle: (route, body, capability, signal) => this.handle(route, body, capability, signal),
      }
      const gateway = new AppApiGateway({
        delegate,
        verifyToken: (token, now) => {
          const record = this.capabilities.verify(token, now)
          if (record) return record
          // A matching-but-expired/revoked token triggers the unified
          // expiry teardown exactly once (idempotent, best-effort).
          const expired = this.capabilities.findExpiredOrRevoked(token, now)
          if (expired) {
            void this.handleCapabilityExpiry(expired.capabilityGeneration)
              .catch(() => {})
          }
          return null
        },
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
    this.armCapabilityExpiry(issued)
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

  /**
   * Arms the generation-bound TTL task at issue time: an idle runtime is
   * torn down when its capability expires even without any further request
   * (the gateway's expired-token detection remains as a backstop).
   */
  private armCapabilityExpiry(issued: {
    capabilityGeneration: number
    expiresAt: number
  }): void {
    const cancel = (this.adapters.scheduleExpiry ?? ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    }))(Math.max(0, issued.expiresAt - this.now()), () => {
      void this.handleCapabilityExpiry(issued.capabilityGeneration).catch(() => {})
    })
    this.expiryTimers.set(issued.capabilityGeneration, cancel)
  }

  private cancelCapabilityExpiry(capabilityGeneration: number): void {
    const cancel = this.expiryTimers.get(capabilityGeneration)
    if (cancel) {
      this.expiryTimers.delete(capabilityGeneration)
      cancel()
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
    if (this.shuttingDown) {
      // A runtime registered after shutdown began can never be torn down in
      // order — refuse it; the start path revokes any just-signed token.
      throw new Error('coordinator is shutting down')
    }
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
    this.cancelCapabilityExpiry(capabilityGeneration)
    this.capabilities.revoke(capabilityGeneration)
    this.runState.releaseCapability(capabilityGeneration)
    this.capabilities.forget(capabilityGeneration)
  }

  /** Manager observer for an unexpected process exit of an exact runtime. */
  async handleUnexpectedExit(event: {
    runtimeKey?: string
    runtimeGeneration: number
  }): Promise<void> {
    // Fail closed: both the immutable identity key AND the manager-local
    // runtime generation must match — two scoped managers allocate
    // generations independently, so a generation alone is ambiguous.
    if (!event.runtimeKey) return
    const runtime = [...this.active.values()]
      .find(candidate => candidate.identityKey === event.runtimeKey
        && candidate.runtimeGeneration === event.runtimeGeneration)
    if (!runtime) return
    await this.teardownRuntime(runtime, 'failed')
  }

  /**
   * Capability TTL expiry: the expired token is refused at the gateway and
   * the whole runtime generation is torn down exactly once with the unified
   * revoke→abort→cleanup→stop→CAS-clear order ('unknown' terminal status).
   */
  async handleCapabilityExpiry(capabilityGeneration: number): Promise<void> {
    const runtime = [...this.active.values()]
      .find(candidate => candidate.capabilityGeneration === capabilityGeneration)
    // The teardown guard/high-water makes repeated triggers no-ops.
    if (
      !runtime
      || this.isGenerationTornDown(runtime)
    ) return
    await this.teardownRuntime(runtime, 'unknown', () =>
      this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())
  }

  /** Read-only view of active runtimes for unified stop entry points. */
  listActiveRuntimes(): ReadonlyArray<ActiveRuntime> {
    return [...this.active.values()]
  }

  /**
   * Unified fail-closed teardown for every active runtime matching a filter
   * (scope withdrawal / organization denial / account session ending).
   */
  async teardownRuntimesFor(
    matches: (runtime: ActiveRuntime) => boolean,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
  ): Promise<void> {
    for (const runtime of [...this.active.values()]) {
      if (!matches(runtime)) continue
      await this.teardownRuntime(runtime, finalStatus, () =>
        this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())
    }
  }

  /**
   * Fail-closed teardown of one runtime generation: revoke → abort → bounded
   * reconfirm lane → (caller stops the process) → generation-CAS projection
   * clear → release capability resources. Best-effort at every step.
   *
   * The teardown is a UNIQUE TERMINAL operation per identityKey+generation:
   * concurrent triggers share one in-flight promise, and a COMPLETED
   * generation keeps a persistent terminal marker — a stale late callback
   * (old token replay, delayed exit event, replacement-era teardown) is a
   * no-op that can neither re-stop the generation nor abort a replacement's
   * in-flight queries.
   */
  async teardownRuntime(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
    stopProcess?: () => Promise<void>,
  ): Promise<void> {
    // Bounded terminal marker: any generation at or below the high water is
    // already terminal — a stale late callback is a fail-closed no-op.
    if (this.isGenerationTornDown(runtime)) return
    const guardKey = `${runtime.identityKey}:${runtime.runtimeGeneration}`
    const inProgress = this.teardownGuarantees.get(guardKey)
    if (inProgress) return inProgress
    // Publish the guard promise BEFORE any revoke/abort side effect runs:
    // performTeardown synchronously aborts the runtime controller and its
    // abort listeners can synchronously re-enter this method — at that
    // moment the guard must already be observable. The guard settles ONLY
    // when performTeardown itself fulfills or rejects, so a concurrent
    // second teardown shares the exact first settlement (never an early
    // success) and observes its rejection.
    let guardResolve!: () => void
    let guardReject!: (error: unknown) => void
    const guardPromise = new Promise<void>((resolve, reject) => {
      guardResolve = resolve
      guardReject = reject
    })
    this.teardownGuarantees.set(guardKey, guardPromise)
    // The guard mirrors the teardown rejection to concurrent callers; mark
    // it handled so bun/node never reports a spurious unhandled rejection
    // when no concurrent caller is awaiting it.
    guardPromise.catch(() => {})
    const teardown = this.performTeardown(runtime, finalStatus, stopProcess)
    void teardown.then(
      () => {
        // Persist the terminal marker BEFORE clearing the guard.
        this.markGenerationTornDown(runtime)
        guardResolve()
        if (this.teardownGuarantees.get(guardKey) === guardPromise) {
          this.teardownGuarantees.delete(guardKey)
        }
      },
      error => {
        // Cleanup completed but the aggregated stop failure rejected: the
        // generation stays terminal; the guard mirrors the rejection.
        this.markGenerationTornDown(runtime)
        guardReject(error)
        if (this.teardownGuarantees.get(guardKey) === guardPromise) {
          this.teardownGuarantees.delete(guardKey)
        }
      },
    )
    return teardown
  }

  /** Test/observability seam: bounded per-identity terminal high water. */
  terminalRuntimeGenerationHighWater(identityKey: string): number {
    return this.tornDownThroughGeneration.get(identityKey) ?? 0
  }

  private async performTeardown(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
    stopProcess?: () => Promise<void>,
  ): Promise<void> {
    if (runtime.capabilityGeneration !== undefined) {
      this.cancelCapabilityExpiry(runtime.capabilityGeneration)
      this.capabilities.revoke(runtime.capabilityGeneration)
    }
    runtime.controller.abort()
    // Freeze every admitted generation-owned start SYNCHRONOUSLY: a late
    // Admin success beyond the drain grace still lands on a replayable
    // start that the detached cleanup lane re-confirms and finishes.
    const startPrefix = `${runtime.identityKey}:`
    for (const [key, start] of this.inFlightStarts) {
      if (
        start.runtimeGeneration !== runtime.runtimeGeneration
        || !key.startsWith(startPrefix)
      ) continue
      const record = this.runState.getRun(start.capabilityGeneration, start.runId)
      if (record && record.status === 'starting_admin') {
        this.runState.setRunStatus(
          start.capabilityGeneration,
          start.runId,
          'start_unconfirmed',
        )
      }
    }
    // Drain ONLY this generation's in-flight queries and starts — never a
    // replacement's.
    await this.drainInFlight(runtime.identityKey, runtime.runtimeGeneration)
    await this.drainInFlightStarts(runtime.identityKey, runtime.runtimeGeneration)
    await this.runCleanupLane(runtime, finalStatus)
    // Best-effort: every subsequent cleanup step runs even when the
    // generation-bound process stop fails; the failure is aggregated and
    // rejected AFTER cleanup completes.
    let stopFailure: unknown
    if (stopProcess) {
      try {
        await stopProcess()
      } catch (error) {
        stopFailure = error
      }
    }
    getAppRuntimeCenter().clear(runtime.identityKey, runtime.runtimeGeneration)
    unregisterProductSpaceExecution(runtime.executionId)
    if (runtime.capabilityGeneration !== undefined) {
      this.runState.releaseCapability(runtime.capabilityGeneration)
      this.capabilities.forget(runtime.capabilityGeneration)
    }
    if (this.active.get(runtime.identityKey) === runtime) {
      this.active.delete(runtime.identityKey)
    }
    if (stopFailure !== undefined) throw stopFailure
  }

  private async drainInFlight(identityKey: string, runtimeGeneration: number): Promise<void> {
    const pending = [...this.inFlight.entries()]
      .filter(([key, query]) => query.runtimeGeneration === runtimeGeneration
        && key.startsWith(`${identityKey}:`))
    for (const [, query] of pending) query.controller.abort()
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending.map(([, query]) => query.promise)),
      new Promise((resolve) => setTimeout(resolve, CLEANUP_ABORT_GRACE_MS)),
    ])
  }

  /**
   * Waits (bounded) for the unique outcome of this generation's admitted
   * Admin starts: a late success is converted to a replayable start so the
   * cleanup lane can reconcile and finish the remote run.
   */
  private async drainInFlightStarts(identityKey: string, runtimeGeneration: number): Promise<void> {
    const pending = [...this.inFlightStarts.entries()]
      .filter(([key, start]) => start.runtimeGeneration === runtimeGeneration
        && key.startsWith(`${identityKey}:`))
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending.map(([, start]) => start.promise)),
      new Promise((resolve) => setTimeout(resolve, CLEANUP_ABORT_GRACE_MS)),
    ])
    // Deterministic retirement: a never-settling adapter can no longer hold
    // the generation's in-flight allocation after teardown.
    for (const [key, start] of pending) {
      if (this.inFlightStarts.get(key) === start) {
        this.inFlightStarts.delete(key)
      }
    }
  }

  /** Test/observability seam: count of retained in-flight Admin starts. */
  pendingInFlightStartCount(): number {
    return this.inFlightStarts.size
  }

  /**
   * Bounded generation-bound cleanup lane: at most one reconfirmation per
   * already-formed fact (start/receipt/finish), never a provider re-run and
   * never a new App payload. Falls back to the owner-specified terminal
   * status only when the run is cleanly finishable. Every Admin call is
   * bounded by min(5s, remaining total budget) with a Promise.race fallback,
   * so a hung adapter can never extend the teardown beyond its budgets.
   */
  private async runCleanupLane(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
  ): Promise<void> {
    const capabilityGeneration = runtime.capabilityGeneration
    if (capabilityGeneration === undefined || !this.gateway) return
    const deadline = this.now() + CLEANUP_TOTAL_BUDGET_MS
    const controller = new AbortController()
    const runBounded = async (
      operation: (signal: AbortSignal) => Promise<unknown>,
    ): Promise<boolean> => {
      if (this.now() >= deadline || controller.signal.aborted) return false
      const remaining = deadline - this.now()
      const budget = Math.max(0, Math.min(CLEANUP_REQUEST_BUDGET_MS, remaining))
      const timer = setTimeout(() => controller.abort(), budget)
      try {
        await Promise.race([
          operation(controller.signal),
          new Promise<void>(resolve => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true })
          }),
        ])
        return !controller.signal.aborted
      } catch {
        return false
      } finally {
        clearTimeout(timer)
      }
    }
    const admin = this.adapters.admin
    const runs = this.runState.runsForCapability(capabilityGeneration)
    for (const { runId, record } of runs) {
      try {
        if (record.status === 'start_unconfirmed') {
          const confirmed = await runBounded(signal =>
            admin.startAppRun(this.adminStartBody(runtime, runId), { signal }))
          if (!confirmed) return
          this.runState.setRunStatus(capabilityGeneration, runId, 'running')
          record.status = 'running'
        }
        for (const { requestId, record: query } of this.runState.queriesForRun(capabilityGeneration, runId)) {
          if (query.state !== 'receipt_unconfirmed' || !query.outcome) continue
          const receiptOk = await runBounded(signal =>
            admin.recordAppUsage(
              this.receiptBody(runId, requestId, query.outcome!),
              { signal },
            ))
          if (!receiptOk) return
          this.runState.noteReceiptConfirmed(capabilityGeneration, runId, requestId)
        }
        if (record.status === 'finishing' || record.status === 'finish_unconfirmed') {
          const finishOk = await runBounded(signal =>
            admin.finishAppRun(runId, {
              status: record.requestedFinishStatus ?? finalStatus,
            }, { signal }))
          if (!finishOk) return
        } else if (this.runState.canFinishRun(capabilityGeneration, runId)) {
          const finishOk = await runBounded(signal =>
            admin.finishAppRun(runId, { status: finalStatus } satisfies AdminFinishAppRunInput, { signal }))
          if (!finishOk) return
        } else {
          // Not cleanly finishable: leave reconciliation to the POL-102
          // server timeout instead of fabricating a terminal state.
          continue
        }
        // Explicit reconciliation outcome: the start was confirmed (running)
        // and the terminal finish succeeded.
        const startWasConfirmed = record.status === 'running'
        this.runState.markTerminal(capabilityGeneration, runId, 'cleanup')
        this.runState.releaseRun(capabilityGeneration, runId)
        if (startWasConfirmed) {
          this.reconciledStarts.set(`${capabilityGeneration}:${runId}`, 'confirmed_and_finished')
        }
      } catch {
        // Budget/boundary failures stop this run's local reconciliation.
      }
    }
    controller.abort()
  }

  private adminStartBody(
    runtime: ActiveRuntime,
    runId: string,
  ): AdminStartAppRunInput {
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
    runId: string,
    requestId: string,
    outcome: QueryOutcome,
  ): AdminRecordAppUsageInput {
    const inputTokens = outcome.kind === 'success'
      ? outcome.usage.inputTokens
      : outcome.kind === 'no_output'
        ? outcome.inputTokens ?? 0
        : outcome.usage?.inputTokens ?? 0
    const outputTokens = outcome.kind === 'success'
      ? outcome.usage.outputTokens
      : outcome.kind === 'no_output'
        ? 0
        : outcome.usage?.outputTokens ?? 0
    return { runId, requestId, inputTokens, outputTokens }
  }

  /**
   * TERMINAL for this coordinator instance: after the returned promise
   * resolves, no gateway can be reopened, no capability re-signed and no
   * runtime re-registered ("stop accepting starts" never lifts).
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    const shutdownPromise = (async (): Promise<void> => {
      for (const cancel of this.expiryTimers.values()) cancel()
      this.expiryTimers.clear()
      const runtimes = [...this.active.values()]
      for (const runtime of runtimes) {
        if (runtime.capabilityGeneration !== undefined) {
          this.capabilities.revoke(runtime.capabilityGeneration)
        }
        runtime.controller.abort()
      }
      const teardownResults = await Promise.allSettled(
        runtimes.map(runtime => this.teardownRuntime(runtime, 'unknown', () =>
          this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())),
      )
      await this.gateway?.close()
      this.gateway = undefined
      // Aggregate: a failed generation-bound process stop must not pass
      // silently even though every other cleanup step completed.
      const failures = teardownResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason)
      if (failures.length > 0) {
        throw new Error(
          `coordinator shutdown: ${failures.length} runtime generation(s) failed to stop`,
          { cause: failures[0] },
        )
      }
    })()
    this.shutdownPromise = shutdownPromise
    return shutdownPromise
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
    let record = existing
    if (!record) {
      const created = this.runState.createRun(capGen, runId, fingerprint(body))
      if (created.status === 'cross_generation') {
        // The runId is owned by another capability generation.
        return { errorCode: 'run_state_conflict' }
      }
      if (created.status === 'registry_full') {
        // Coordinator-wide tombstone high water reached: fail closed
        // BEFORE any Admin call; recorded runIds are never re-opened.
        return { errorCode: 'run_registry_full' }
      }
      record = created.record
    }
    if (record.status === 'start_rejected') {
      // The previous Admin start was schema-validated rejected: replays
      // answer the same stable error without re-entering Admin.
      return { errorCode: 'idempotency_conflict' }
    }
    record.status = existing?.status === 'start_unconfirmed'
      ? 'start_unconfirmed'
      : 'starting_admin'
    const startKey = `${runtime.identityKey}:${runId}`
    let settleStartOutcome!: () => void
    const inFlightStart: InFlightStart = {
      runtimeGeneration: runtime.runtimeGeneration,
      capabilityGeneration: capGen,
      runId,
      promise: new Promise<void>(resolve => {
        settleStartOutcome = resolve
      }),
    }
    this.inFlightStarts.set(startKey, inFlightStart)
    try {
      try {
        const composed = anySignal([signal, runtime.controller.signal])
        try {
          await this.adapters.admin.startAppRun(this.adminStartBody(runtime, runId), {
            signal: composed.signal,
          })
        } finally {
          composed.dispose()
        }
      } catch (error) {
        if (error instanceof AdminError && error.errorCode === 'insufficient_credit') {
          // Completed rejection: dispose the per-generation run record (the
          // owner tombstone is retained) so an exact retry re-enters Admin.
          this.runState.discardRun(capGen, runId)
          return { errorCode: 'insufficient_credit' }
        }
        if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') {
          // Explicit stable rejected state — never left in starting_admin.
          this.runState.setRunStatus(capGen, runId, 'start_rejected')
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
      if (
        runtime.controller.signal.aborted
        || this.isGenerationTornDown(runtime)
      ) {
        // Teardown is in progress but the idempotent Admin start SUCCEEDED:
        // freeze the run replayable for the detached cleanup lane, then wait
        // for the EXPLICIT reconciliation outcome. 200 running is returned
        // only when the start was re-confirmed AND the terminal finish
        // succeeded; anything else answers a stable error.
        // Freeze ONLY a still-admitting record: never downgrade a run the
        // cleanup lane has already confirmed (running/terminal).
        const frozen = this.runState.getRun(capGen, runId)
        if (frozen && frozen.status === 'starting_admin') {
          this.runState.setRunStatus(capGen, runId, 'start_unconfirmed')
        }
        const reconcileKey = `${capGen}:${runId}`
        // REAL-TIME budget: a monotonic timer enforces the total cleanup
        // budget even when the injectable clock is frozen or rolled back.
        let timedOut = false
        const budgetTimer = setTimeout(() => {
          timedOut = true
        }, CLEANUP_TOTAL_BUDGET_MS)
        try {
          while (!timedOut) {
            if (this.reconciledStarts.get(reconcileKey) === 'confirmed_and_finished') {
              return { data: { runId, status: 'running' } }
            }
            if (this.isGenerationTornDown(runtime)) {
              // The teardown settled without a confirmed reconciliation:
              // never fabricate a success.
              return { errorCode: 'shutting_down' }
            }
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          return { errorCode: 'shutting_down' }
        } finally {
          clearTimeout(budgetTimer)
        }
      }
      this.runState.setRunStatus(capGen, runId, 'running')
      return { data: { runId, status: 'running' } }
    } finally {
      // The unique start outcome is now known: release the drain.
      settleStartOutcome()
      if (this.inFlightStarts.get(startKey) === inFlightStart) {
        this.inFlightStarts.delete(startKey)
      }
    }
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
      const composed = anySignal([signal, runtime.controller.signal])
      try {
        await this.adapters.admin.finishAppRun(runId, { status }, {
          signal: composed.signal,
        })
      } finally {
        composed.dispose()
      }
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
    // executor under its own abort controller. Everything between admission
    // and provider start shares ONE failure boundary: any exception releases
    // the full reservation so a retry can be admitted cleanly.
    let rootPath: string | null
    let connectionSlug: string | null | undefined
    let model: string | undefined
    try {
      rootPath = await this.adapters.resolveWorkspaceRoot(runtime.workspaceId)
      if (!rootPath) return this.failAdmittedQuery(capGen, runId, requestId, 'host_configuration_unavailable')
      const workspaceConfig = this.adapters.loadWorkspaceConfig(rootPath)
      connectionSlug = workspaceConfig?.defaults?.defaultLlmConnection
        ?? this.adapters.getDefaultLlmConnection()
      if (!connectionSlug) {
        return this.failAdmittedQuery(capGen, runId, requestId, 'host_configuration_unavailable')
      }
      model = workspaceConfig?.defaults?.model
    } catch {
      return this.failAdmittedQuery(capGen, runId, requestId, 'host_failed')
    }
    const controller = new AbortController()
    const abortForward = () => controller.abort()
    if (signal.aborted) abortForward()
    else signal.addEventListener('abort', abortForward, { once: true })
    runtime.controller.signal.addEventListener('abort', abortForward, { once: true })
    const queryKey = `${runtime.identityKey}:${runId}:${requestId}`
    let executor: CoordinatorExecutor
    try {
      executor = this.adapters.createExecutor({ connectionSlug, model })
    } catch {
      // Construction failed before the provider ran: release the reservation
      // and answer with a stable error so a retry can be admitted cleanly.
      this.releaseReservation(capGen, runId, requestId)
      signal.removeEventListener('abort', abortForward)
      runtime.controller.signal.removeEventListener('abort', abortForward)
      return { errorCode: 'host_failed' }
    }
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
        return {
          kind: 'error',
          code: hostErrorCode(result) ?? 'host_failed',
          ...(hostUsage(result) ? { usage: hostUsage(result) } : {}),
        }
      } finally {
        await executor.dispose().catch(() => {})
      }
    })()
    const inFlight: InFlightQuery = {
      runtimeGeneration: runtime.runtimeGeneration,
      runId,
      requestId,
      controller,
      promise: completion.then(() => {}, () => {}),
    }
    this.inFlight.set(queryKey, inFlight)
    let outcome: QueryOutcome
    try {
      outcome = await completion
    } catch {
      // Executor failure without a Host terminal: record a stable replayable
      // outcome instead of leaving the reservation stuck in flight.
      outcome = { kind: 'error', code: 'host_failed' }
    } finally {
      this.inFlight.delete(queryKey)
      runtime.controller.signal.removeEventListener('abort', abortForward)
      signal.removeEventListener('abort', abortForward)
    }
    if (!this.runState.getQuery(capGen, runId, requestId)) {
      // Admission was released (e.g. replaced/shutdown mid-flight).
      return { errorCode: outcome.kind === 'error' ? outcome.code : 'run_state_conflict' }
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

  /** Failure boundary for an admitted query before the provider started. */
  private failAdmittedQuery(
    capGen: number,
    runId: string,
    requestId: string,
    code: AppApiStableErrorCode,
  ): { data?: unknown; errorCode?: AppApiStableErrorCode } {
    this.releaseReservation(capGen, runId, requestId)
    return { errorCode: code }
  }

  private async sendReceipt(
    runtime: ActiveRuntime,
    runId: string,
    requestId: string,
    outcome: QueryOutcome,
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode } | null> {
    const capGen = capabilityGenerationOf(runtime)
    try {
      const composed = anySignal([runtime.controller.signal])
      try {
        await this.adapters.admin.recordAppUsage(
          this.receiptBody(runId, requestId, outcome),
          { signal: composed.signal },
        )
      } finally {
        composed.dispose()
      }
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

function anySignal(signals: Array<AbortSignal>): {
  signal: AbortSignal | undefined
  dispose: () => void
} {
  const controller = new AbortController()
  const disposers: Array<() => void> = []
  for (const source of signals) {
    if (source.aborted) {
      controller.abort()
      continue
    }
    const listener = () => controller.abort()
    source.addEventListener('abort', listener, { once: true })
    disposers.push(() => source.removeEventListener('abort', listener))
  }
  return {
    signal: signals.length > 0 ? controller.signal : undefined,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}
