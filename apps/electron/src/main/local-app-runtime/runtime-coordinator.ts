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
  AdminAdmitAppRequestInput,
  AdminAdmitAppRequestResponse,
  AdminFinishAppRunInput,
  AdminRecordAppUsageInput,
  AdminStartAppRunInput,
} from '@polo-ai/shared/admin'
import type { HostLlmBeforeSendFacts, HostLlmAdmissionDecision, HostLlmPublicResult } from '@polo-ai/shared/agent/host-llm-executor'
import { AppBillingOutbox, type AppBillingJournalScope } from './app-billing-outbox'
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
  getAppRequest?(runId: string, requestId: string, options?: { signal?: AbortSignal; accountId?: string; adminOrigin?: string }): Promise<{ request: { requestId: string; state: string }; settlement: 'pending' | 'confirmed' | 'no_charge' }>
  admitAppRequest?(runId: string, input: AdminAdmitAppRequestInput, options?: { signal?: AbortSignal; accountId?: string; adminOrigin?: string }): Promise<AdminAdmitAppRequestResponse>
  startAppRun(
    input: AdminStartAppRunInput,
    options?: { signal?: AbortSignal; accountId?: string; adminOrigin?: string },
  ): Promise<unknown>
  recordAppUsage(
    input: AdminRecordAppUsageInput,
    options?: { signal?: AbortSignal; accountId?: string; adminOrigin?: string },
  ): Promise<unknown>
  finishAppRun(
    runId: string,
    input: AdminFinishAppRunInput,
    options?: { signal?: AbortSignal; accountId?: string; adminOrigin?: string },
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
  billingOutbox?: AppBillingOutbox
  getAdminOrigin?(): string
  getBillingSession?(): Promise<{ accountId: string; adminOrigin: string } | null>
  isScopeCurrent?(identity: ProductSpaceAppRuntimeIdentity): boolean | Promise<boolean>
  admin: CoordinatorAdminAdapter
  createExecutor(options: {
    connectionSlug: string
    model?: string
    beforeSend?: (facts: HostLlmBeforeSendFacts) => Promise<HostLlmAdmissionDecision | void>
  }): CoordinatorExecutor
  resolveWorkspaceRoot(workspaceId: string): string | null | Promise<string | null>
  loadWorkspaceConfig(rootPath: string): {
    defaults?: { defaultLlmConnection?: string; model?: string }
  } | undefined | null
  getDefaultLlmConnection(): string | null
  /** Trusted production resolver; never fall back after scoped resolution fails. */
  resolveRuntimeConnection?(identity: ProductSpaceAppRuntimeIdentity): Promise<{ connectionSlug: string; model?: string }>
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

/**
 * Unambiguous tuple encoding for (account, ProductSpace, artifact instance)
 * scope matching. Delimiter concatenation is unsafe: AdminEntityIdSchema
 * accepts '|', so `a|b`+`c` and `a`+`b|c` would collide. JSON tuple encoding
 * keeps every distinct tuple distinct.
 */
export function catalogRuntimeScopeTupleKey(fields: {
  accountId: string
  productSpaceId: string
  artifactInstanceId: string
}): string {
  return JSON.stringify([
    'product-space-app-runtime-scope',
    1,
    fields.accountId,
    fields.productSpaceId,
    fields.artifactInstanceId,
  ])
}

export interface CapabilitySigning {
  capabilityGeneration: number
  /** Raw capability token: only for process-env injection, never persisted. */
  token: string
  environment: { POLO_APP_API_URL: string; POLO_APP_API_TOKEN: string }
  sensitiveValues: string[]
}

export interface ActiveRuntime {
  billingAdminOrigin?: string
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
): (Pick<import('@polo-ai/shared/agent/host-llm-executor').HostLlmPublicUsage, 'inputTokens' | 'outputTokens'> & Partial<import('@polo-ai/shared/agent/host-llm-executor').HostLlmPublicUsage>) | undefined {
  if (!('usage' in result) || !result.usage) return undefined
  const { inputTokens, outputTokens } = result.usage
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return undefined
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) return undefined
  return { ...result.usage, inputTokens, outputTokens }
}

/**
 * Immutable terminal outcome of ONE generation teardown, shared with every
 * concurrent waiter of the same teardown guard. The `ok` discriminant is the
 * ONLY failure signal: `ok: false` carries the recorded (never thrown)
 * generation-bound process-stop failure — even when that failure is itself
 * `undefined` (`Promise.reject(undefined)`), so a rejected stop can never be
 * misclassified as success by value-inspecting the error. Every boundary
 * that joins the guard reads the SAME outcome, so a frozen handler fails
 * closed on it without racing a per-execution take against a consumer-less
 * drainer.
 */
export type TeardownOutcome =
  | { readonly ok: true; readonly executionId: string }
  | {
    readonly ok: false
    readonly executionId: string
    readonly stopFailure: unknown
  }

function settledTeardownOutcome(runtime: { executionId: string }): TeardownOutcome {
  return Object.freeze({ ok: true as const, executionId: runtime.executionId })
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
  private readonly browserRuns = new Set<string>()
  private readonly cleanupRuns = new Map<string, Promise<void>>()
  private readonly active = new Map<string, ActiveRuntime>()
  private readonly inFlight = new Map<string, InFlightQuery>()
  private readonly inFlightStarts = new Map<string, InFlightStart>()
  private readonly expiryTimers = new Map<number, () => void>()
  /**
   * Unique in-progress teardown per identityKey+runtimeGeneration. The
   * composite key is load-bearing: manager-local runtime generations collide
   * across identities, so a generation-only key would let identity B reuse
   * identity A's in-flight guard and skip its own teardown entirely. The
   * shared promise resolves with the FIRST teardown's immutable outcome so
   * every waiter (frozen handler or consumer-less drainer) observes the
   * same terminal stop failure.
   */
  private readonly teardownGuarantees = new Map<string, Promise<TeardownOutcome>>()
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
  /**
   * Recorded (never thrown) rollback stop failures, keyed by executionId.
   * The value is the teardown's SHARED TeardownOutcome, so consumption can
   * retire a record only when it belongs to the exact teardown being
   * consumed. Every record has exactly ONE consumption boundary: the START
   * exit / replacement teardown / explicit STOP that owns the frozen stop
   * callback consumes it via consumeTeardownOutcome (the failure itself
   * already traveled on the shared outcome — the take is hygiene only);
   * teardown paths without such a consumer (expiry, unexpected exit,
   * scope/account teardown) drain it into the bounded unsurfaced report
   * below at their own call boundary.
   */
  private readonly rollbackStopFailures = new Map<string, TeardownOutcome>()
  /**
   * Bounded diagnostics for teardown stop failures surfaced by no frozen
   * handler: capped ring so generation churn can never grow it unboundedly.
   */
  private readonly unsurfacedTeardownStopFailures: Array<{
    executionId: string
    error: unknown
  }> = []
  private static readonly MAX_UNSURFACED_TEARDOWN_STOP_FAILURES = 16
  private shutdownPromise?: Promise<void>
  private shuttingDown = false
  private billingRetryTimer?: ReturnType<typeof setInterval>
  private billingRecoveryRunning = false
  private billingRecoveryOffset = 0

  constructor(private readonly adapters: RuntimeCoordinatorAdapters) {
    this.runState = new AppApiRunState(
      adapters.runIdTombstoneHighWater !== undefined
        ? { runIdTombstoneHighWater: adapters.runIdTombstoneHighWater }
        : undefined,
    )
  }

  /** Recovery never executes AI, signs an App capability, or replaces facts. */
  async reconcileBillingOutbox(accountId: string, adminOrigin: string): Promise<number> {
    if (this.billingRecoveryRunning || !this.adapters.billingOutbox) return 0
    this.billingRecoveryRunning = true
    let reconciled = 0
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CLEANUP_TOTAL_BUDGET_MS)
    try {
      const entries = this.adapters.billingOutbox.entries(accountId, adminOrigin)
      if (!entries.length) return 0
      const start = this.billingRecoveryOffset % entries.length
      this.billingRecoveryOffset = (start + 32) % entries.length
      for (let index = 0; index < Math.min(32, entries.length); index++) {
        if (controller.signal.aborted) break
        const entry = entries[(start + index) % entries.length]!
        // A live Host owns this pre-admission phase until its terminal arrives.
        if (entry.phase === 'admission' && [...this.inFlight.values()].some(query => query.runId === entry.runId && query.requestId === entry.admission.requestId)) continue
        const options = { signal: controller.signal, accountId: entry.scope.accountId, adminOrigin: entry.scope.adminOrigin }
        let detachAbort = () => {}
        try {
          const ack = await Promise.race([
            entry.phase === 'receipt' && entry.receipt
              ? this.adapters.admin.recordAppUsage(entry.receipt, options)
              : this.adapters.admin.getAppRequest?.(entry.runId, entry.admission.requestId, options) ?? Promise.resolve(undefined),
            new Promise<never>((_, reject) => {
              const abort = () => reject(new Error('Billing recovery budget expired'))
              if (controller.signal.aborted) abort()
              else {
                controller.signal.addEventListener('abort', abort, { once: true })
                detachAbort = () => controller.signal.removeEventListener('abort', abort)
              }
            }),
          ]) as { settlement?: 'pending' | 'confirmed' | 'no_charge' } | undefined
          if (!ack?.settlement) continue
          this.adapters.billingOutbox.applySettlement(entry.key, ack.settlement)
          if (ack.settlement !== 'pending') reconciled++
        } catch (error) {
          if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') this.adapters.billingOutbox.markConflict(entry.key)
        } finally { detachAbort() }
      }
      return reconciled
    } finally { clearTimeout(timer); this.billingRecoveryRunning = false }
  }

  private armBillingRecovery(): void {
    if (!this.adapters.billingOutbox || !this.adapters.getBillingSession || this.billingRetryTimer) return
    const replay = async () => {
      if (this.shuttingDown) return
      const session = await this.adapters.getBillingSession?.().catch(() => null)
      if (session && !this.shuttingDown) await this.reconcileBillingOutbox(session.accountId, session.adminOrigin)
    }
    this.billingRetryTimer = setInterval(() => { void replay().catch(() => {}) }, 30_000)
    this.billingRetryTimer.unref?.()
    void replay().catch(() => {})
  }

  private now(): number {
    return this.adapters.now ? this.adapters.now() : Date.now()
  }

  /** Gateway-first: the loopback boundary must exist before any App spawn. */
  async ensureGateway(): Promise<string> {
    this.armBillingRecovery()
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
    const issued = this.issueCapability({
      identityKey,
      identity: input.identity,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      runtimeGeneration: input.runtimeGeneration,
      scopeGeneration: input.scopeGeneration,
    })
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

  private issueCapability(bindings: import('./app-api-capabilities').CapabilityBindings) {
    if (this.shuttingDown) throw new Error('coordinator is shutting down')
    const issued = this.capabilities.issue(bindings, this.now())
    this.armCapabilityExpiry(issued)
    return issued
  }

  /** Main-only issuance. The discarded token never reaches static content. */
  issueBrowserCapability(input: Omit<ActiveRuntime, 'controller' | 'identityKey' | 'billingAdminOrigin' | 'capabilityGeneration'>): number {
    return this.issueCapability({ ...input, identityKey: createProductSpaceAppRuntimeIdentityKey(input.identity) }).capabilityGeneration
  }

  async verifyBrowserRuntime(runtime: ActiveRuntime): Promise<boolean> {
    if (this.shuttingDown || runtime.controller.signal.aborted || this.active.get(runtime.identityKey) !== runtime) return false
    if (runtime.capabilityGeneration === undefined || !this.capabilities.verifyGeneration(runtime.capabilityGeneration, runtime, this.now())) return false
    if (this.adapters.isScopeCurrent && !await this.adapters.isScopeCurrent(runtime.identity)) return false
    return !runtime.controller.signal.aborted && this.active.get(runtime.identityKey) === runtime
      && !!this.capabilities.verifyGeneration(runtime.capabilityGeneration, runtime, this.now())
  }

  /** Narrow Main dispatch; never exposes report/file routes to the browser. */
  async dispatchBrowser(runtime: ActiveRuntime, route: '/run/start' | '/ai/query', body: Record<string, unknown>, signal: AbortSignal, current: () => Promise<boolean>) {
    if (signal.aborted || !await this.verifyBrowserRuntime(runtime) || !await current()) return { errorCode: 'capability_invalid' as const }
    if (route !== '/run/start') return this.handleAiQuery(runtime, body, signal, current)
    const key = `${runtime.capabilityGeneration}:${body.runId}`
    this.browserRuns.add(key)
    try { return await this.handleRunStart(runtime, body, signal) }
    finally {
      const record = this.runState.getRun(capabilityGenerationOf(runtime), String(body.runId))
      if (!record || record.status === 'terminal') this.browserRuns.delete(key)
    }
  }

  /** Original-run cleanup, independent of the caller's aborted signal/scope. */
  async cleanupBrowserRun(runtime: ActiveRuntime, runId: string, status: 'completed' | 'failed' | 'cancelled' | 'unknown') {
    await this.runCleanupLane(runtime, status, runId)
    const run = this.runState.getRun(capabilityGenerationOf(runtime), runId)
    return { finished: run?.status === 'terminal', settlement: run?.settlement }
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
      billingAdminOrigin: this.adapters.getAdminOrigin?.(),
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

  private dropBrowserRunMarkers(generation: number): void {
    for (const key of this.browserRuns) if (key.startsWith(`${generation}:`)) this.browserRuns.delete(key)
  }

  /** Revokes a capability whose post-hook start failed. */
  revokeSignedCapability(capabilityGeneration: number): void {
    this.cancelCapabilityExpiry(capabilityGeneration)
    this.capabilities.revoke(capabilityGeneration)
    this.runState.releaseCapability(capabilityGeneration)
    this.capabilities.forget(capabilityGeneration)
    this.dropBrowserRunMarkers(capabilityGeneration)
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
    const outcome = await this.teardownRuntime(runtime, 'failed')
    // No frozen handler consumes this path: the recorded stop failure is
    // drained into the bounded report here (the call boundary owns it).
    this.drainUnsurfacedStopFailure(outcome)
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
    const outcome = await this.teardownRuntime(runtime, 'unknown', () =>
      this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())
    // No frozen handler consumes this path: drain at the call boundary.
    this.drainUnsurfacedStopFailure(outcome)
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
      const outcome = await this.teardownRuntime(runtime, finalStatus, () =>
        this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())
      // No frozen handler consumes this path: drain at the call boundary.
      this.drainUnsurfacedStopFailure(outcome)
    }
  }

  /**
   * Fail-closed teardown of one runtime generation: revoke → abort → bounded
   * reconfirm lane → (caller stops the process) → generation-CAS projection
   * clear → release capability resources. Best-effort at every step.
   *
   * The teardown is a UNIQUE TERMINAL operation per identityKey+generation:
   * concurrent triggers share one in-flight promise AND ONE immutable
   * TeardownOutcome — the guard resolves every waiter with the same frozen
   * outcome (including the recorded stop failure), so a frozen handler
   * (replacement / explicit STOP / RESTART) fails closed on it without
   * racing a per-execution take against a consumer-less drainer. A
   * COMPLETED generation keeps a persistent terminal marker — a stale late
   * callback (old token replay, delayed exit event, replacement-era
   * teardown) is a no-op that can neither re-stop the generation nor abort
   * a replacement's in-flight queries.
   */
  async teardownRuntime(
    runtime: ActiveRuntime,
    finalStatus: 'cancelled' | 'failed' | 'unknown',
    stopProcess?: () => Promise<void>,
  ): Promise<TeardownOutcome> {
    // Bounded terminal marker: any generation at or below the high water is
    // already terminal — a stale late callback is a fail-closed no-op.
    if (this.isGenerationTornDown(runtime)) return settledTeardownOutcome(runtime)
    const guardKey = `${runtime.identityKey}:${runtime.runtimeGeneration}`
    const inProgress = this.teardownGuarantees.get(guardKey)
    if (inProgress) return inProgress
    // Publish the guard promise BEFORE any revoke/abort side effect runs:
    // performTeardown synchronously aborts the runtime controller and its
    // abort listeners can synchronously re-enter this method — at that
    // moment the guard must already be observable. The guard settles ONLY
    // when performTeardown itself fulfills or rejects, so a concurrent
    // second teardown shares the exact first settlement (never an early
    // success) and the SAME immutable outcome.
    let guardResolve!: (outcome: TeardownOutcome) => void
    let guardReject!: (error: unknown) => void
    const guardPromise = new Promise<TeardownOutcome>((resolve, reject) => {
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
      outcome => {
        // Persist the terminal marker BEFORE clearing the guard.
        this.markGenerationTornDown(runtime)
        guardResolve(outcome)
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
  ): Promise<TeardownOutcome> {
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
    // generation-bound process stop fails. The failure is RECORDED (never
    // thrown): the single START-boundary aggregation exit surfaces it via
    // the STOP_FAILED contract after cleanup completes. Failure is tracked
    // by an INDEPENDENT boolean tag — a `Promise.reject(undefined)` reason
    // must still classify the stop as failed (never an undefined sentinel).
    let stopFailure: unknown
    let stopFailed = false
    if (stopProcess) {
      try {
        await stopProcess()
      } catch (error) {
        stopFailed = true
        stopFailure = error
      }
    }
    getAppRuntimeCenter().clear(runtime.identityKey, runtime.runtimeGeneration)
    unregisterProductSpaceExecution(runtime.executionId)
    if (runtime.capabilityGeneration !== undefined) {
      this.runState.releaseCapability(runtime.capabilityGeneration)
      this.capabilities.forget(runtime.capabilityGeneration)
      this.dropBrowserRunMarkers(runtime.capabilityGeneration)
    }
    if (this.active.get(runtime.identityKey) === runtime) {
      this.active.delete(runtime.identityKey)
    }
    // ONE immutable outcome per teardown: it is recorded for the
    // observability/consumption seams and returned to every waiter of the
    // guard — never re-derived from racy per-execution state. The `ok`
    // discriminant — never the error value — decides failure.
    const outcome: TeardownOutcome = Object.freeze(
      stopFailed
        ? {
          ok: false as const,
          executionId: runtime.executionId,
          stopFailure,
        }
        : { ok: true as const, executionId: runtime.executionId },
    )
    if (stopFailed) {
      this.rollbackStopFailures.set(runtime.executionId, outcome)
    } else {
      this.rollbackStopFailures.delete(runtime.executionId)
    }
    return outcome
  }

  /**
   * Recorded rollback stop failure for one execution, if any. Tag-driven
   * mapping: only an `ok: false` outcome maps to its recorded failure.
   * Test/observability seam — production fail-closed consumers must use the
   * tagged consumeTeardownOutcome boundary instead.
   */
  getRollbackStopFailure(executionId: string): unknown {
    const record = this.rollbackStopFailures.get(executionId)
    return record && !record.ok ? record.stopFailure : undefined
  }

  /**
   * Atomic take-and-delete of one recorded rollback stop failure: a
   * consumption primitive for boundaries that surface the failure by
   * executionId alone (legacy seam). The value is mapped by the outcome's
   * `ok` discriminant — a record exists (and is taken) for every FAILED
   * teardown, even when the failure value itself is `undefined`. Frozen
   * handlers must prefer consumeTeardownOutcome — the shared outcome cannot
   * race a concurrent drainer.
   */
  takeRollbackStopFailure(executionId: string): unknown {
    const outcome = this.rollbackStopFailures.get(executionId)
    if (outcome !== undefined) this.rollbackStopFailures.delete(executionId)
    return outcome && !outcome.ok ? outcome.stopFailure : undefined
  }

  /**
   * Frozen-handler consumption of a shared teardown outcome. The failure
   * itself travels ON the immutable outcome (race-free — the guard gave the
   * same object to every waiter), so this only retires the retained
   * diagnostic record when it belongs to THIS exact teardown: the map can
   * never accumulate consumed entries, and a concurrent consumer-less
   * drainer that already retired the record cannot resurrect or duplicate
   * the failure. Returns the SAME tagged outcome — the caller MUST fail
   * closed on `!consumed.ok` (never on the failure value being defined),
   * so a `Promise.reject(undefined)` stop still propagates.
   */
  consumeTeardownOutcome(outcome: TeardownOutcome): TeardownOutcome {
    if (this.rollbackStopFailures.get(outcome.executionId) === outcome) {
      this.rollbackStopFailures.delete(outcome.executionId)
    }
    return outcome
  }

  /** Test/observability seam: count of currently retained stop failures. */
  retainedRollbackStopFailureCount(): number {
    return this.rollbackStopFailures.size
  }

  /** Test/observability seam: bounded recent unsurfaced stop failures. */
  recentUnsurfacedTeardownStopFailures(): ReadonlyArray<{
    executionId: string
    error: unknown
  }> {
    return [...this.unsurfacedTeardownStopFailures]
  }

  /**
   * Consumption boundary for teardown paths with no frozen-handler consumer
   * (capability expiry, unexpected exit, scope/account teardown): drains the
   * outcome's failure into the bounded report so the map cannot retain it.
   * Enqueue is IDEMPOTENT PER OUTCOME — only the boundary that retires the
   * retained record for THIS exact teardown reports it, so concurrent
   * boundaries sharing one guard can never double-report the same failure.
   * Whether the failure lands here or in a frozen handler's caller is pure
   * caller error attribution; fail-closed behavior never depends on it.
   */
  private drainUnsurfacedStopFailure(outcome: TeardownOutcome): void {
    if (outcome.ok) return
    if (this.rollbackStopFailures.get(outcome.executionId) !== outcome) return
    this.rollbackStopFailures.delete(outcome.executionId)
    this.unsurfacedTeardownStopFailures.push({
      executionId: outcome.executionId,
      error: outcome.stopFailure,
    })
    if (
      this.unsurfacedTeardownStopFailures.length
      > LocalAppRuntimeCoordinator.MAX_UNSURFACED_TEARDOWN_STOP_FAILURES
    ) {
      this.unsurfacedTeardownStopFailures.shift()
    }
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
  private async runCleanupLane(runtime: ActiveRuntime, finalStatus: 'completed' | 'cancelled' | 'failed' | 'unknown', onlyRunId?: string): Promise<void> {
    const capGen = runtime.capabilityGeneration
    if (capGen === undefined) return
    const deadline = Date.now() + CLEANUP_TOTAL_BUDGET_MS
    const runs = onlyRunId === undefined ? this.runState.runsForCapability(capGen).map(r => r.runId) : [onlyRunId]
    for (const runId of runs) {
      const key = `${capGen}:${runId}`
      let cleanup = this.cleanupRuns.get(key)
      if (!cleanup) {
        cleanup = this.performRunCleanup(runtime, finalStatus, runId, deadline)
        this.cleanupRuns.set(key, cleanup)
        void cleanup.finally(() => { if (this.cleanupRuns.get(key) === cleanup) this.cleanupRuns.delete(key) }).catch(() => {})
      }
      await cleanup
    }
  }

  private async performRunCleanup(
    runtime: ActiveRuntime,
    finalStatus: 'completed' | 'cancelled' | 'failed' | 'unknown',
    onlyRunId: string,
    deadline: number,
  ): Promise<void> {
    const capabilityGeneration = runtime.capabilityGeneration
    if (capabilityGeneration === undefined || !this.gateway) return
    const controller = new AbortController()
    const runBounded = async (
      operation: (signal: AbortSignal) => Promise<unknown>,
    ): Promise<boolean> => {
      if (Date.now() >= deadline || controller.signal.aborted) return false
      const remaining = deadline - Date.now()
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
      if (onlyRunId !== undefined && runId !== onlyRunId) continue
      try {
        if (record.status === 'start_unconfirmed') {
          const confirmed = await runBounded(signal =>
            admin.startAppRun(this.adminStartBody(runtime, runId), this.originalAdminOptions(runtime, signal)))
          if (!confirmed) return
          this.runState.setRunStatus(capabilityGeneration, runId, 'running')
          record.status = 'running'
        }
        for (const { requestId, record: query } of this.runState.queriesForRun(capabilityGeneration, runId)) {
          if ((query.state !== 'receipt_unconfirmed' && query.state !== 'receipt_pending') || !query.outcome) continue
          let settlement: 'pending' | 'confirmed' | 'no_charge' | undefined
          const receiptOk = await runBounded(async signal => {
            const ack = await admin.recordAppUsage(this.receiptBody(runtime, runId, requestId, query.outcome!), this.originalAdminOptions(runtime, signal)) as { settlement?: 'pending' | 'confirmed' | 'no_charge' }
            settlement = ack?.settlement ?? (admin.admitAppRequest ? undefined : 'confirmed')
            if (!settlement) throw new Error('Canonical receipt acknowledgement is unavailable')
          })
          if (!receiptOk) return
          if (settlement === 'pending') this.runState.noteReceiptPending(capabilityGeneration, runId, requestId)
          else {
            this.runState.noteReceiptConfirmed(capabilityGeneration, runId, requestId, settlement)
            if (this.adapters.billingOutbox && admin.admitAppRequest) {
              const key = this.adapters.billingOutbox.stageReceipt(this.journalScope(runtime), this.receiptBody(runtime, runId, requestId, query.outcome!))
              this.adapters.billingOutbox.applySettlement(key, settlement!)
            }
          }
        }
        const startWasConfirmed = record.status === 'running'
        if (record.status !== 'finishing' && record.status !== 'finish_unconfirmed') {
          if (!this.runState.canFinishRun(capabilityGeneration, runId)) continue
          const outcome = this.runState.queriesForRun(capabilityGeneration, runId).find(q => q.record.outcome)?.record.outcome
          const browserOutcome = this.browserRuns.has(`${capabilityGeneration}:${runId}`) ? outcome : undefined
          const factStatus = browserOutcome?.kind === 'success' ? 'completed' : browserOutcome?.kind === 'error' ? (browserOutcome.code === 'request_cancelled' ? 'cancelled' : 'failed') : finalStatus
          this.runState.beginFinish(capabilityGeneration, runId, factStatus, fingerprint({ runId, status: factStatus }))
        }
        const finishOk = await runBounded(async signal => {
          const ack = await admin.finishAppRun(runId, { status: record.requestedFinishStatus ?? finalStatus }, this.originalAdminOptions(runtime, signal)) as { settlement?: 'pending' | 'confirmed' | 'no_charge' }
          if (admin.admitAppRequest && !ack?.settlement) throw new Error('Canonical finish acknowledgement is unavailable')
          record.settlement = ack?.settlement
        })
        if (!finishOk) {
          this.runState.noteFinishUnconfirmed(capabilityGeneration, runId)
          return
        }
        // Explicit reconciliation outcome: the start was confirmed (running)
        // and the terminal finish succeeded.
        this.browserRuns.delete(`${capabilityGeneration}:${runId}`)
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
      productSpaceId: runtime.identity.productSpaceId,
      subjectKind: 'app',
      artifactInstanceId: runtime.identity.artifactInstanceId,
      artifactVersionId: runtime.identity.versionId,
    }
  }

  private journalScope(runtime: ActiveRuntime): AppBillingJournalScope {
    const adminOrigin = runtime.billingAdminOrigin
    if (!adminOrigin) throw new Error('Original billing origin is unavailable')
    return { accountId: runtime.identity.accountId, adminOrigin, productSpaceId: runtime.identity.productSpaceId, artifactInstanceId: runtime.identity.artifactInstanceId, artifactVersionId: runtime.identity.versionId }
  }

  private originalAdminOptions(runtime: ActiveRuntime, signal?: AbortSignal) {
    return { ...(signal ? { signal } : {}), accountId: runtime.identity.accountId, ...(this.adapters.getAdminOrigin ? { adminOrigin: runtime.billingAdminOrigin } : {}) }
  }

  private receiptBody(
    runtime: ActiveRuntime,
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
    const usage = outcome.usage
    return { productSpaceId: runtime.identity.productSpaceId, runId, requestId, inputTokens, outputTokens,
      ...(this.adapters.admin.admitAppRequest ? {
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        ...(outcome.actualModel ? { actualModel: outcome.actualModel } : {}),
        providerObservation: outcome.providerObservation ?? { version: 1 as const, state: 'missing' as const },
        outputDisposition: outcome.outputDisposition ?? (outcome.kind === 'success' ? 'usable' as const : outcome.kind === 'no_output' ? 'no_output' as const : 'unknown' as const),
        ...(usage?.terminalReason ? { terminalReason: usage.terminalReason } : {}),
        ...(usage?.provenance ? { provenance: usage.provenance } : {}),
      } : {}),
    }
  }

  /**
   * TERMINAL for this coordinator instance: after the returned promise
   * resolves, no gateway can be reopened, no capability re-signed and no
   * runtime re-registered ("stop accepting starts" never lifts).
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    if (this.billingRetryTimer) { clearInterval(this.billingRetryTimer); this.billingRetryTimer = undefined }
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
      // performTeardown records (never throws) rollback stop failures and
      // resolves with the SHARED outcome: aggregation reads the outcome, so
      // a concurrent drainer retiring the record first can never turn this
      // shutdown into a false pass.
      const settled = await Promise.allSettled(
        runtimes.map(runtime => this.teardownRuntime(runtime, 'unknown', () =>
          this.adapters.stopRuntime?.(runtime) ?? Promise.resolve())),
      )
      await this.gateway?.close()
      this.gateway = undefined
      // Aggregate ONLY the runtimes this shutdown tore down: historical
      // records from already-consumed or consumer-less teardowns must never
      // reject (or pollute) a shutdown with no matching active runtime.
      // Failure is judged by the outcome's `ok` discriminant, so a
      // `Promise.reject(undefined)` stop still rejects this shutdown.
      const failures = settled.flatMap(result => {
        if (result.status === 'rejected') return [result.reason]
        return !result.value.ok ? [result.value.stopFailure] : []
      })
      // Terminal hygiene: nothing survives shutdown for this instance.
      this.rollbackStopFailures.clear()
      if (failures.length > 0) {
        const message = `coordinator shutdown: ${failures.length} runtime generation(s) failed to stop`
        // A single failure keeps the plain-Error shape (cause = the reason)
        // that quit-guard callers already handle; multiple failures must
        // preserve EVERY reason — an AggregateError keeps stop-a AND stop-b
        // independently observable in `errors`, so no evidence is lost to a
        // cause-only wrapper.
        if (failures.length === 1) {
          throw new Error(message, { cause: failures[0] })
        }
        throw new AggregateError(failures, message)
      }
    })()
    this.shutdownPromise = shutdownPromise
    // A rejected shutdown must not poison quit retries forever: the
    // teardown work itself is terminal and complete, so a retry re-runs the
    // (now empty) shutdown body instead of replaying the same failure and
    // never reaching downstream forced cleanup.
    void shutdownPromise.then(
      () => {
        if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = undefined
      },
      () => {
        if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = undefined
      },
    )
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
          await this.adapters.admin.startAppRun(this.adminStartBody(runtime, runId), this.originalAdminOptions(runtime, composed.signal))
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
        ? { data: { runId, status, ...(run.settlement ? { settlement: run.settlement } : {}) } }
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
    let settlement: 'pending' | 'confirmed' | 'no_charge' | undefined
    try {
      const composed = anySignal([signal, runtime.controller.signal])
      try {
        const ack = await this.adapters.admin.finishAppRun(runId, { status }, this.originalAdminOptions(runtime, composed.signal)) as { settlement?: 'pending' | 'confirmed' | 'no_charge' }
        settlement = ack?.settlement
        if (this.adapters.admin.admitAppRequest && !settlement) throw new Error('Canonical finish acknowledgement is unavailable')
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
    const record = this.runState.getRun(capGen, runId)
    if (record) record.settlement = settlement
    this.runState.markTerminal(capGen, runId, 'app')
    this.runState.releaseRun(capGen, runId)
    return { data: { runId, status, ...(settlement ? { settlement } : {}) } }
  }

  private async handleAiQuery(
    runtime: ActiveRuntime,
    body: Record<string, unknown>,
    signal: AbortSignal,
    current: () => Promise<boolean> = async () => true,
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
      const scoped = this.adapters.resolveRuntimeConnection
        ? await this.adapters.resolveRuntimeConnection(runtime.identity)
        : null
      const workspaceConfig = scoped ? null : this.adapters.loadWorkspaceConfig(rootPath)
      connectionSlug = scoped?.connectionSlug ?? workspaceConfig?.defaults?.defaultLlmConnection
        ?? this.adapters.getDefaultLlmConnection()
      if (!connectionSlug) {
        return this.failAdmittedQuery(capGen, runId, requestId, 'host_configuration_unavailable')
      }
      model = scoped?.model ?? workspaceConfig?.defaults?.model
    } catch {
      return this.failAdmittedQuery(capGen, runId, requestId, 'host_failed')
    }
    if (runtime.controller.signal.aborted || this.isGenerationTornDown(runtime) || !await current() || this.adapters.isScopeCurrent && !await this.adapters.isScopeCurrent(runtime.identity)) return this.failAdmittedQuery(capGen, runId, requestId, 'request_cancelled')
    const controller = new AbortController()
    const abortForward = () => controller.abort()
    if (signal.aborted) abortForward()
    else signal.addEventListener('abort', abortForward, { once: true })
    if (runtime.controller.signal.aborted) abortForward()
    else runtime.controller.signal.addEventListener('abort', abortForward, { once: true })
    const queryKey = `${runtime.identityKey}:${runId}:${requestId}`
    let executor: CoordinatorExecutor
    let admitted = false
    let admissionDispatchStarted = false
    let cancelledBeforeDispatch = false
    let admissionOpen = true
    let journalScope: AppBillingJournalScope | undefined
    let journalKey: string | undefined
    try {
      executor = this.adapters.createExecutor({ connectionSlug, model,
        ...(this.adapters.admin.admitAppRequest ? { beforeSend: async (facts: HostLlmBeforeSendFacts): Promise<HostLlmAdmissionDecision> => {
          const assertNotCancelled = () => {
            // Host admission has its own deadline. A timed-out execute may
            // leave this hook awaiting authority without aborting its signal.
            if (!admissionOpen) throw new Error('App query admission lifetime ended')
            if (controller.signal.aborted || runtime.controller.signal.aborted) {
              cancelledBeforeDispatch = true
              throw new Error('App request was cancelled before admission dispatch')
            }
          }
          assertNotCancelled()
          if (this.isGenerationTornDown(runtime)) throw new Error('Original App scope was withdrawn')
          const isCurrent = await current()
          assertNotCancelled()
          if (!isCurrent || this.isGenerationTornDown(runtime)) throw new Error('Original App scope was withdrawn')
          const isScopeCurrent = !this.adapters.isScopeCurrent || await this.adapters.isScopeCurrent(runtime.identity)
          assertNotCancelled()
          if (!isScopeCurrent || this.isGenerationTornDown(runtime)) throw new Error('Original App scope was withdrawn')
          if (!this.adapters.billingOutbox) throw new Error('Durable App billing journal is unavailable')
          journalScope = this.journalScope(runtime)
          const body = { productSpaceId: runtime.identity.productSpaceId, requestId, ...facts }
          journalKey = this.adapters.billingOutbox.stageAdmission(journalScope, runId, body)
          // Once dispatch starts, an aborted/lost acknowledgement is unknown;
          // neither cancellation nor a later empty snapshot proves no send.
          admissionDispatchStarted = true
          const response = await this.adapters.admin.admitAppRequest!(runId, body, this.originalAdminOptions(runtime, controller.signal))
          admitted = true
          if (controller.signal.aborted || runtime.controller.signal.aborted || this.isGenerationTornDown(runtime) || !await current() || this.adapters.isScopeCurrent && !await this.adapters.isScopeCurrent(runtime.identity)) throw new Error('Original App scope was withdrawn')
          return { providerCorrelation: response.request.providerCorrelation }
        } } : {}),
      })
    } catch {
      // Construction failed before the provider ran: release the reservation
      // and answer with a stable error so a retry can be admitted cleanly.
      admissionOpen = false
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
        // Match managed CLI billing: actualModel is the authorized model sent
        // upstream, while usage.reportedModel retains the response label.
        const metadata = this.adapters.admin.admitAppRequest ? { hostRequestId: result.requestId, actualModel: result.model.replace(/^pi:/, ''), providerObservation: result.providerObservation ?? { version: 1 as const, state: 'missing' as const }, outputDisposition: result.status === 'completed' || result.status === 'partial' ? 'usable' as const : result.status === 'no_output' ? 'no_output' as const : 'unknown' as const } : {}
        if (result.status === 'completed' || result.status === 'partial') {
          return {
            kind: 'success',
            status: result.status,
            text: result.text,
            usage: { ...result.usage },
            ...metadata,
          }
        }
        if (result.status === 'no_output') {
          return { kind: 'no_output', inputTokens: result.usage?.inputTokens, ...(result.usage ? { usage: { ...result.usage } } : {}), ...metadata }
        }
        return {
          kind: 'error',
          ...metadata,
          code: hostErrorCode(result) ?? 'host_failed',
          ...(hostUsage(result) ? { usage: hostUsage(result) } : {}),
        }
      } finally {
        // Close synchronously before awaiting disposal: no detached guard may
        // stage/send admission after the unique Host terminal was selected.
        admissionOpen = false
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
    if (this.adapters.admin.admitAppRequest && !admitted) {
      // A definite pre-dispatch error has no provider receipt. Strip Host
      // placeholders so cleanup can finish the original run without inventing
      // usage; a late abort must not relabel an earlier unrelated error.
      const code = !admissionDispatchStarted && outcome.kind === 'error'
        ? cancelledBeforeDispatch ? 'request_cancelled' : outcome.code
        : 'metering_unconfirmed'
      this.runState.noteHostTerminal(capGen, runId, requestId, { kind: 'error', code })
      return { errorCode: code }
    }
    const record = this.runState.noteHostTerminal(capGen, runId, requestId, outcome)
    if (!record) return { errorCode: 'run_state_conflict' }
    if (record.requiredReceipt) {
      const receiptOutcome = await this.sendReceipt(runtime, runId, requestId, outcome)
      if (receiptOutcome) return receiptOutcome
    }
    return this.outcomeResponse(requestId, outcome, this.runState.getQuery(capGen, runId, requestId)?.settlement)
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
    if (this.adapters.billingOutbox && this.adapters.admin.admitAppRequest) {
      try {
        this.adapters.billingOutbox.stageReceipt(this.journalScope(runtime), this.receiptBody(runtime, runId, requestId, outcome))
      } catch {
        // Keep the unique terminal outcome replayable, but do not send or
        // release it until its recovery metadata is durable.
        return { errorCode: 'metering_unconfirmed' }
      }
    }
    try {
      const composed = anySignal([runtime.controller.signal])
      try {
        const ack = await this.adapters.admin.recordAppUsage(
          this.receiptBody(runtime, runId, requestId, outcome),
          this.originalAdminOptions(runtime, composed.signal),
        ) as { settlement?: 'pending' | 'confirmed' | 'no_charge' }
        if (this.adapters.admin.admitAppRequest && !ack?.settlement) throw new Error('Canonical receipt acknowledgement is unavailable')
        if (ack?.settlement === 'pending') {
          this.runState.noteReceiptPending(capGen, runId, requestId)
          return null
        }
        if (this.adapters.billingOutbox && this.adapters.admin.admitAppRequest) {
          const key = this.adapters.billingOutbox.stageReceipt(this.journalScope(runtime), this.receiptBody(runtime, runId, requestId, outcome))
          this.adapters.billingOutbox.applySettlement(key, ack.settlement!)
        }
        this.runState.noteReceiptConfirmed(capGen, runId, requestId, ack?.settlement === 'no_charge' ? 'no_charge' : 'confirmed')
      } finally {
        composed.dispose()
      }
    } catch (error) {
      if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') {
        this.runState.noteReceiptRejected(capGen, runId, requestId)
        if (this.adapters.billingOutbox && this.adapters.admin.admitAppRequest) {
          const key = this.adapters.billingOutbox.stageReceipt(this.journalScope(runtime), this.receiptBody(runtime, runId, requestId, outcome))
          this.adapters.billingOutbox.markConflict(key)
        }
        return { errorCode: 'idempotency_conflict' }
      }
      if (error instanceof AdminError && error.errorCode === 'run_finalized') {
        this.runState.markTerminal(capGen, runId, 'server')
        this.runState.releaseRun(capGen, runId)
        return { errorCode: 'run_finalized' }
      }
      if (this.adapters.billingOutbox && this.adapters.admin.admitAppRequest && outcome.kind === 'success') {
        this.runState.noteReceiptPending(capGen, runId, requestId)
        return null
      }
      return { errorCode: 'metering_unconfirmed' }
    }
    return null
  }

  private async replayQuery(
    runtime: ActiveRuntime,
    runId: string,
    requestId: string,
    record: { state: string; outcome?: QueryOutcome; requiredReceipt: boolean },
  ): Promise<{ data?: unknown; errorCode?: AppApiStableErrorCode }> {
    if (record.state === 'executing') return { errorCode: 'request_in_progress' }
    if (record.state === 'receipt_rejected') return { errorCode: 'idempotency_conflict' }
    if ((record.state === 'receipt_unconfirmed' || record.state === 'receipt_pending') && record.outcome) {
      const receiptOutcome = await this.sendReceipt(runtime, runId, requestId, record.outcome)
      if (receiptOutcome) return receiptOutcome
      return this.outcomeResponse(requestId, record.outcome, this.runState.getQuery(capabilityGenerationOf(runtime), runId, requestId)?.settlement)
    }
    if (record.state === 'settled') {
      if (record.requiredReceipt && !this.hasConfirmedReceipt(runtime, runId, requestId)) {
        return { errorCode: 'metering_unconfirmed' }
      }
      if (record.outcome) return this.outcomeResponse(requestId, record.outcome, this.runState.getQuery(capabilityGenerationOf(runtime), runId, requestId)?.settlement)
    }
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
    settlement?: 'pending' | 'confirmed' | 'no_charge',
  ): { data?: unknown; errorCode?: AppApiStableErrorCode } {
    if (outcome.kind === 'success') {
      return {
        data: {
          requestId,
          status: outcome.status,
          text: outcome.text,
          usage: outcome.usage,
          ...(this.adapters.admin.admitAppRequest ? { settlement: settlement ?? 'pending' } : {}),
        },
      }
    }
    if (outcome.kind === 'no_output') {
      return {
        data: { requestId, status: 'no_output', error: { code: 'no_output' }, ...(this.adapters.admin.admitAppRequest ? { settlement: settlement ?? 'pending' } : {}) },
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
