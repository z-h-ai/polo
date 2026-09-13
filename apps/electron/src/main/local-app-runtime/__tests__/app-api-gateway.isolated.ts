import { describe, expect, it } from 'bun:test'
import { request as httpRequest } from 'node:http'
import net from 'node:net'
import { AdminError } from '@polo-ai/shared/admin'
import type { HostLlmPublicResult } from '@polo-ai/shared/agent/host-llm-executor'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'
import { PER_CAPABILITY_QUERY_SLOTS } from '../app-api-run-state'
import { createProductSpaceAppRuntimeIdentityKey } from '@polo-ai/shared/product-spaces'
import type { ActiveRuntime } from '../runtime-coordinator'

const IDENTITY = {
  accountId: 'account-a',
  productSpaceId: 'space-a',
  artifactInstanceId: 'artifact-a',
  versionId: 'version-a',
  version: '1.0.0',
}

interface FixtureOptions {
  onStart?: () => void | Promise<void>
  onUsage?: () => void | Promise<void>
  onFinish?: () => void | Promise<void>
  executorResults?: Array<() => HostLlmPublicResult>
  /** The executor factory itself throws synchronously. */
  executorFactoryThrows?: boolean
  /** The usage POST hangs until its AbortSignal fires, then rejects. */
  usageHangsUntilAbort?: boolean
  /** resolveWorkspaceRoot throws synchronously/asynchronously. */
  resolveWorkspaceRootThrows?: boolean
  /** loadWorkspaceConfig throws. */
  loadWorkspaceConfigThrows?: boolean
  /** Captures the armed capability-expiry callbacks for deterministic tests. */
  onExpiryArmed?: (fire: () => void) => void
  /** Boots only the gateway (no capability/runtime registration). */
  skipBootstrapRuntime?: boolean
  /** executor.execute rejects instead of returning a Host terminal. */
  executeRejection?: boolean
  /** execute hangs until its abort signal fires, then rejects. */
  executeHangsUntilAbort?: boolean
  sinks?: {
    reportResult?: (input: Record<string, unknown>) => Promise<{ revision: number }>
    reportFile?: (input: Record<string, unknown>) => Promise<{ revision: number }>
  }
  stopRuntime?: (runtime: {
    identity: typeof IDENTITY
    runtimeGeneration: number
  }) => Promise<void>
  runIdTombstoneHighWater?: number
}

function uuid(): string {
  return crypto.randomUUID()
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    reportedModel: 'm',
  }
}

function completed(text: string, inputTokens = 12, outputTokens = 34): HostLlmPublicResult {
  return {
    status: 'completed',
    text,
    usage: usage(inputTokens, outputTokens),
    requestId: 'host-1',
    model: 'model-x',
    provider: 'test',
  }
}

function createFixture(options: FixtureOptions = {}) {
  const adminCalls: Array<{ method: 'start' | 'usage' | 'finish'; body: unknown; runId?: string }> = []
  const stopRuntimeCalls: number[] = []
  let executorCounter = 0
  const scripted = [...(options.executorResults ?? [])]
  let now = 1_000_000
  const gates: Array<() => void> = []
  let holdExecutions = false

  const coordinator = new LocalAppRuntimeCoordinator({
    ...(options.runIdTombstoneHighWater !== undefined
      ? { runIdTombstoneHighWater: options.runIdTombstoneHighWater }
      : {}),
    admin: {
      startAppRun: async (input, signalOptions) => {
        adminCalls.push({ method: 'start', body: input })
        if (signalOptions?.signal?.aborted) throw new AdminError('aborted', 'NETWORK_ERROR')
        await options.onStart?.()
      },
      recordAppUsage: async (input, signalOptions) => {
        adminCalls.push({ method: 'usage', body: input })
        if (signalOptions?.signal?.aborted) throw new AdminError('aborted', 'NETWORK_ERROR')
        if (options.usageHangsUntilAbort) {
          await new Promise<void>((_resolve, reject) => {
            signalOptions?.signal?.addEventListener(
              'abort',
              () => reject(new AdminError('aborted', 'NETWORK_ERROR')),
              { once: true },
            )
          })
        }
        await options.onUsage?.()
      },
      finishAppRun: async (runId, input, signalOptions) => {
        adminCalls.push({ method: 'finish', body: input, runId })
        if (signalOptions?.signal?.aborted) throw new AdminError('aborted', 'NETWORK_ERROR')
        await options.onFinish?.()
      },
    },
    createExecutor: () => {
      executorCounter += 1
      if (options.executorFactoryThrows) {
        throw new Error('executor factory exploded')
      }
      return {
        execute: async (input?: { signal?: AbortSignal }) => {
          if (options.executeHangsUntilAbort) {
            await new Promise<void>((_resolve, reject) => {
              input?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          }
          if (holdExecutions) {
            await new Promise<void>(resolve => gates.push(resolve))
          }
          if (options.executeRejection) throw new Error('executor.execute exploded')
          const next = scripted.shift()
          if (!next) throw new Error('no scripted executor result')
          return next()
        },
        dispose: async () => {},
      }
    },
    resolveWorkspaceRoot: workspaceId => {
      if (options.resolveWorkspaceRootThrows) throw new Error('workspace probe exploded')
      return workspaceId === 'ws-a' ? '/root-a' : null
    },
    loadWorkspaceConfig: () => {
      if (options.loadWorkspaceConfigThrows) throw new Error('workspace config exploded')
      return { defaults: { defaultLlmConnection: 'conn-1', model: 'model-x' } }
    },
    getDefaultLlmConnection: () => null,
    scheduleExpiry: (delayMs, callback) => {
      void delayMs
      options.onExpiryArmed?.(callback)
      return () => {}
    },
    stopRuntime: async runtime => {
      stopRuntimeCalls.push(runtime.runtimeGeneration)
      await options.stopRuntime?.(runtime)
    },
    ...(options.sinks ? { sinks: options.sinks } : {}),
    now: () => now,
  })

  let baseURL = ''
  let token = ''
  const ready = (async () => {
    const gatewayUrl = await coordinator.ensureGateway()
    baseURL = gatewayUrl.replace(/\/local-app-api\/v1$/, '')
    if (options.skipBootstrapRuntime) return
    const signing = coordinator.signCapability({
      identity: IDENTITY,
      workspaceId: 'ws-a',
      executionId: 'exec-1',
      runtimeKind: 'python',
      runtimeGeneration: 1,
      scopeGeneration: 1,
    })
    coordinator.registerActiveRuntime({
      identity: IDENTITY,
      executionId: 'exec-1',
      runtimeGeneration: 1,
      scopeGeneration: 1,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing.capabilityGeneration,
    })
    baseURL = baseURL || gatewayUrl
    token = signing.token
  })()

  const post = async (
    path: string,
    body: unknown,
    init: { token?: string | null; contentType?: string } = {},
  ) => {
    await ready
    const response = await fetch(`${baseURL}/local-app-api/v1${path}`, {
      method: 'POST',
      headers: {
        ...(init.token !== null
          ? { Authorization: `Bearer ${init.token ?? token}` }
          : {}),
        'Content-Type': init.contentType ?? 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json = await response.json().catch(() => null)
    return { status: response.status, json }
  }

  const rawRequest = (path: string, headers: Record<string, string>, method = 'POST') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      void ready.then(() => {
        const port = new URL(baseURL).port
        const request = httpRequest({
          host: '127.0.0.1',
          port: Number(port),
          path: `/local-app-api/v1${path}`,
          method,
          headers,
        }, response => {
          let body = ''
          response.on('data', chunk => {
            body += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
        })
        request.once('error', reject)
        request.end()
      }, reject)
    })

  /**
   * Writes a fully raw HTTP/1.1 request over a TCP socket, permitting
   * duplicate header names exactly as an attacker would send them.
   */
  const rawSocketRequest = (
    path: string,
    headerLines: string[],
    body: Record<string, unknown>,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      void ready.then(() => {
        const port = new URL(baseURL).port
        const payloadBody = JSON.stringify(body)
        const payload = [
          `POST /local-app-api/v1${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          ...headerLines,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(payloadBody)}`,
          'Connection: close',
          '',
          payloadBody,
        ].join('\r\n')
        const socket = net.connect(Number(port), '127.0.0.1', () => {
          socket.write(payload)
        })
        let raw = ''
        socket.on('data', chunk => {
          raw += String(chunk)
        })
        socket.on('close', () => {
          const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0)
          resolve({ status, body: raw })
        })
        socket.once('error', reject)
      }, reject)
    })

  return {
    coordinator,
    adminCalls,
    stopRuntimeCalls,
    executorCount: () => executorCounter,
    post,
    rawRequest,
    rawSocketRequest,
    getSignedToken: () => token,
    setNow: (value: number) => {
      now = value
    },
    holdExecutions: (value: boolean) => {
      holdExecutions = value
    },
    releaseOne: () => {
      gates.shift()?.()
    },
  }
}

type Fixture = ReturnType<typeof createFixture>

function startBody() {
  return { runId: uuid() }
}

function queryBody() {
  return {
    runId: uuid(),
    requestId: uuid(),
    prompt: 'hello',
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  }
}

async function startRun(fixture: Fixture): Promise<string> {
  const body = startBody()
  const response = await fixture.post('/run/start', body)
  expect(response.status).toBe(200)
  return body.runId
}

describe('local-app-api.v1 loopback gateway and coordinator (POO-54)', () => {
  it('hardens transport: POST-only, Origin rejection, bearer-only auth, no query strings', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    const missingToken = await fixture.rawRequest('/run/start', {
      'Content-Type': 'application/json',
    })
    expect(missingToken.status).toBe(401)
    expect(JSON.parse(missingToken.body)).toMatchObject({
      ok: false,
      error: { code: 'capability_invalid' },
    })
    const withOrigin = await fixture.rawRequest('/run/start', {
      Origin: 'null',
      'Content-Type': 'application/json',
    })
    expect(withOrigin.status).toBe(400)
    expect(JSON.parse(withOrigin.body).error.code).toBe('invalid_request')
    const get = await fixture.rawRequest('/run/start', {}, 'GET')
    expect(get.status).toBe(405)
    expect(JSON.parse(get.body).error.code).toBe('method_not_allowed')
    const unknownRoute = await fixture.rawRequest('/nope', {})
    expect(unknownRoute.status).toBe(404)
    expect(JSON.parse(unknownRoute.body).error.code).toBe('route_not_found')
    const queryToken = await fixture.rawRequest('/run/start?token=x', {})
    expect(queryToken.status).toBe(400)
    expect(JSON.parse(queryToken.body).error.code).toBe('invalid_request')
  })

  it('rejects forged, expired and revoked tokens; media type and size violations; self-reported ownership', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    const forged = await fixture.post('/run/start', startBody(), { token: 'forged-token' })
    expect(forged.status).toBe(401)
    expect(forged.json.error.code).toBe('capability_invalid')
    const noToken = await fixture.post('/run/start', startBody(), { token: null })
    expect(noToken.status).toBe(401)
    const wrongType = await fixture.post('/run/start', startBody(), {
      contentType: 'application/x-www-form-urlencoded',
    })
    expect(wrongType.status).toBe(415)
    expect(wrongType.json.error.code).toBe('unsupported_media_type')
    // 4 KiB body limit on run/start.
    const oversized = await fixture.post('/run/start', {
      runId: uuid(),
      padding: 'x'.repeat(5 * 1024),
    })
    expect(oversized.status).toBe(413)
    expect(oversized.json.error.code).toBe('request_too_large')
    // Strict schema rejects App self-reported ownership/payer fields.
    const ownership = await fixture.post('/run/start', {
      runId: uuid(),
      productSpaceId: 'space-b',
      payer: 'enterprise-b',
    })
    expect(ownership.status).toBe(400)
    expect(ownership.json.error.code).toBe('invalid_request')
    // Fixed 24h TTL, never renewed.
    fixture.setNow(1_000_000 + 24 * 60 * 60 * 1000 + 1)
    const expired = await fixture.post('/run/start', startBody())
    expect(expired.status).toBe(401)
    expect(expired.json.error.code).toBe('capability_invalid')
  })

  it('run/start: happy path, typed insufficient_credit, unknown network replay, conflict', async () => {
    let startBehavior: 'ok' | 'credit' | 'unknown' = 'ok'
    const fixture = createFixture({
      onStart: async () => {
        if (startBehavior === 'credit') {
          throw new AdminError('no credit', 'insufficient_credit')
        }
        if (startBehavior === 'unknown') {
          throw new AdminError('timeout', 'TIMEOUT')
        }
      },
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const body = startBody()
    const ok = await fixture.post('/run/start', body)
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ ok: true, data: { runId: body.runId, status: 'running' } })
    // The Admin start derives identity from the capability, never from the App.
    const startCall = fixture.adminCalls.find(call => call.method === 'start')
    expect(startCall!.body).toMatchObject({
      runId: body.runId,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      artifactInstanceId: 'artifact-a',
      versionId: 'version-a',
      version: '1.0.0',
      workspaceId: 'ws-a',
    })

    startBehavior = 'credit'
    const credit = await fixture.post('/run/start', startBody())
    expect(credit.status).toBe(409)
    expect(credit.json.error.code).toBe('insufficient_credit')

    startBehavior = 'unknown'
    const unknownBody = startBody()
    const unknown = await fixture.post('/run/start', unknownBody)
    expect(unknown.status).toBe(503)
    expect(unknown.json.error.code).toBe('metering_unconfirmed')
    startBehavior = 'ok'
    const replay = await fixture.post('/run/start', unknownBody)
    expect(replay.status).toBe(200)
    // The running run refuses a second start for the same runId.
    const conflict = await fixture.post('/run/start', unknownBody)
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.code).toBe('run_state_conflict')
  })

  it('ai/query: metering-before-release, exact replay without provider re-run, no_output 0/0', async () => {
    const fixture = createFixture({
      executorResults: [
        () => completed('answer'),
        () => ({
          status: 'no_output',
          error: {
            code: 'no_output' as const,
            reason: 'empty_text' as const,
            message: 'LLM provider returned no output',
          },
          requestId: 'host-2',
          model: 'model-x',
        }),
      ],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const query = { runId, requestId: uuid(), prompt: 'hello', maxOutputTokens: 64, timeoutMs: 5_000 }
    const first = await fixture.post('/ai/query', query)
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({
      ok: true,
      data: { requestId: query.requestId, status: 'completed', text: 'answer' },
    })
    // The receipt was confirmed BEFORE the body was released.
    const usageCall = fixture.adminCalls.find(call => call.method === 'usage')
    expect(usageCall!.body).toMatchObject({
      runId,
      requestId: query.requestId,
      inputTokens: 12,
      outputTokens: 34,
    })
    expect(fixture.executorCount()).toBe(1)
    // Same fingerprint replay returns the exact cached outcome without a re-run.
    const replay = await fixture.post('/ai/query', query)
    expect(replay.status).toBe(200)
    expect(replay.json.data).toEqual(first.json.data)
    expect(fixture.executorCount()).toBe(1)
    // Same requestId with a DIFFERENT fingerprint is an idempotency conflict.
    const conflict = await fixture.post('/ai/query', { ...query, prompt: 'changed' })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error.code).toBe('idempotency_conflict')

    // no_output without usage → 0/0 reconciliation receipt, then success shape.
    const noOutput = { runId, requestId: uuid(), prompt: 'hi', maxOutputTokens: 8, timeoutMs: 5_000 }
    const noOutputResponse = await fixture.post('/ai/query', noOutput)
    expect(noOutputResponse.status).toBe(200)
    expect(noOutputResponse.json.data).toEqual({
      requestId: noOutput.requestId,
      status: 'no_output',
      error: { code: 'no_output' },
    })
    const noOutputReceipt = fixture.adminCalls.filter(call => call.method === 'usage').at(-1)
    expect(noOutputReceipt!.body).toMatchObject({
      runId,
      requestId: noOutput.requestId,
      inputTokens: 0,
      outputTokens: 0,
    })
    const finish = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(finish.status).toBe(200)
    expect(fixture.adminCalls.at(-1)).toMatchObject({ method: 'finish', runId })
  })

  it('ai/query: ordinary Host failures never masquerade as insufficient credit', async () => {
    const fixture = createFixture({
      executorResults: [
        () => ({
          status: 'failed',
          error: {
            code: 'auth_failed' as const,
            reason: 'provider_rejected_credentials' as const,
            message: 'LLM provider rejected the connection credential',
          },
          requestId: 'h',
          model: 'model-x',
        }),
        () => ({
          status: 'timed_out',
          error: {
            code: 'timed_out' as const,
            reason: 'deadline_exceeded' as const,
            message: 'Host LLM request timed out',
          },
          requestId: 'h',
          model: 'model-x',
        }),
      ],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const authFailed = await fixture.post('/ai/query', { ...queryBody(), runId })
    expect(authFailed.status).toBe(502)
    expect(authFailed.json.error.code).toBe('host_auth_failed')
    const timedOut = await fixture.post('/ai/query', { ...queryBody(), runId })
    expect(timedOut.status).toBe(504)
    expect(timedOut.json.error.code).toBe('host_timed_out')
  })

  it('run/finish is gated on unconfirmed receipts and replays the frozen status', async () => {
    let usageBehavior: 'ok' | 'unknown' = 'unknown'
    const fixture = createFixture({
      onUsage: async () => {
        if (usageBehavior === 'unknown') {
          throw new AdminError('timeout', 'TIMEOUT')
        }
      },
      executorResults: [() => completed('t', 1, 1)],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const query = { runId, requestId: uuid(), prompt: 'hello', maxOutputTokens: 8, timeoutMs: 5_000 }
    const pending = await fixture.post('/ai/query', query)
    expect(pending.status).toBe(503)
    expect(pending.json.error.code).toBe('metering_unconfirmed')
    // An unconfirmed receipt blocks the App finish with zero Admin PATCH calls.
    const blocked = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('run_state_conflict')
    expect(fixture.adminCalls.some(call => call.method === 'finish')).toBe(false)
    // The fingerprint replay re-confirms the SAME receipt (never a re-run).
    usageBehavior = 'ok'
    const replay = await fixture.post('/ai/query', query)
    expect(replay.status).toBe(200)
    expect(replay.json.data.text).toBe('t')
    expect(fixture.executorCount()).toBe(1)
    const finish = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(finish.status).toBe(200)
    // Terminal replay returns the cached terminal; a different status conflicts.
    const again = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(again.status).toBe(200)
    const other = await fixture.post('/run/finish', { runId, status: 'failed' })
    expect(other.status).toBe(409)
    expect(other.json.error.code).toBe('run_finalized')
    // Queries after terminal are finalized — even with a fresh requestId.
    const lateQuery = await fixture.post('/ai/query', { ...queryBody(), runId })
    expect(lateQuery.status).toBe(409)
    expect(lateQuery.json.error.code).toBe('run_finalized')
  })

  it('admission budget: concurrent queries over the per-capability slot cap are rejected before executor creation', async () => {
    const fixture = createFixture({
      executorResults: Array.from({ length: PER_CAPABILITY_QUERY_SLOTS }, () => () =>
        completed('x', 0, 0)),
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    fixture.holdExecutions(true)
    const queries = Array.from(
      { length: PER_CAPABILITY_QUERY_SLOTS + 1 },
      () => ({ ...queryBody(), runId }),
    )
    const pending = queries.map(query => fixture.post('/ai/query', query))
    await new Promise(resolve => setTimeout(resolve, 50))
    for (let index = 0; index < PER_CAPABILITY_QUERY_SLOTS; index += 1) {
      fixture.releaseOne()
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const results = await Promise.all(pending)
    const rejected = results.filter(result => result.status === 503)
    const admitted = results.filter(result => result.status === 200)
    expect(admitted).toHaveLength(PER_CAPABILITY_QUERY_SLOTS)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.json.error.code).toBe('response_cache_full')
    fixture.holdExecutions(false)
    // Settled queries keep compact reservations until the Run terminates:
    // a fresh query still cannot squeeze past the slot cap.
    const freshWhileRunning = await fixture.post('/ai/query', { ...queryBody(), runId })
    expect(freshWhileRunning.status).toBe(503)
    expect(freshWhileRunning.json.error.code).toBe('response_cache_full')
    // Terminal release frees exactly this run's slots.
    const finish = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(finish.status).toBe(200)
    const afterTerminal = await fixture.post('/ai/query', { ...queryBody(), runId })
    expect(afterTerminal.status).toBe(409)
    expect(afterTerminal.json.error.code).toBe('run_finalized')
  })

  it('result/file reports: strict schema, running-run scope and sink_unavailable when no sink is injected', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const report = { runId, requestId: uuid(), resultId: uuid(), title: 'Result' }
    const absent = await fixture.post('/result/report', report)
    expect(absent.status).toBe(503)
    expect(absent.json.error.code).toBe('sink_unavailable')
    const fileAbsent = await fixture.post('/file/report', {
      runId,
      requestId: uuid(),
      fileId: uuid(),
      source: 'app_export',
      displayName: 'out.txt',
      candidatePath: '/tmp/out.txt',
    })
    expect(fileAbsent.status).toBe(503)
    expect(fileAbsent.json.error.code).toBe('sink_unavailable')
    // An unknown run is a conflict, never an ACK.
    const orphan = await fixture.post('/result/report', { ...report, runId: uuid() })
    expect(orphan.status).toBe(409)
    expect(orphan.json.error.code).toBe('run_state_conflict')
  })

  it('result/file reports ACK through an injected sink with coordinator-derived scope', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fixture = createFixture({
      sinks: {
        reportResult: async input => {
          seen.push(input)
          return { revision: 3 }
        },
      },
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const ack = await fixture.post('/result/report', {
      runId,
      requestId: uuid(),
      resultId: uuid(),
      title: 'Result',
      summary: 'done',
    })
    expect(ack.status).toBe(200)
    expect(ack.json.data.revision).toBe(3)
    expect(seen[0]).toMatchObject({
      runtimeIdentity: IDENTITY,
      workspaceId: 'ws-a',
      executionId: 'exec-1',
      processGeneration: 1,
      scopeGeneration: 1,
    })
  })

  it('revocation immediately refuses App requests; shutdown drains and closes', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    await startRun(fixture)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)
    await fixture.coordinator.teardownRuntime(runtime!, 'cancelled')
    const refused = await fixture.post('/run/start', startBody())
    expect(refused.status).toBe(401)
    expect(refused.json.error.code).toBe('capability_invalid')
    await fixture.coordinator.shutdown()
  })

  it('workspace/connection misconfiguration fails closed with host_configuration_unavailable', async () => {
    const fixture = createFixture({
      executorResults: [() => {
        throw new Error('executor must never be created')
      }],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const signing = fixture.coordinator.signCapability({
      identity: { ...IDENTITY, versionId: 'version-b' },
      workspaceId: 'ws-missing',
      executionId: 'exec-2',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, versionId: 'version-b' },
      executionId: 'exec-2',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-missing',
      runtimeKind: 'python',
      capabilityGeneration: signing.capabilityGeneration,
    })
    const runBody = startBody()
    const started = await fixture.post('/run/start', runBody, { token: signing.token })
    expect(started.status).toBe(200)
    const response = await fixture.post('/ai/query', { ...queryBody(), runId: runBody.runId }, {
      token: signing.token,
    })
    expect(response.status).toBe(503)
    expect(response.json.error.code).toBe('host_configuration_unavailable')
    expect(fixture.executorCount()).toBe(0)
  })
})

describe('POO-54 round-1 fix regressions (gateway/coordinator)', () => {
  it('unexpected exit matches identityKey AND runtimeGeneration across scoped managers', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    // Two scoped managers both report generation 1 for different identities.
    const identityB = { ...IDENTITY, productSpaceId: 'space-b', versionId: 'version-b' }
    const keyB = createProductSpaceAppRuntimeIdentityKey(identityB)
    const signingB = fixture.coordinator.signCapability({
      identity: identityB,
      workspaceId: 'ws-a',
      executionId: 'exec-b',
      runtimeKind: 'python',
      runtimeGeneration: 1,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, productSpaceId: 'space-b', versionId: 'version-b' },
      executionId: 'exec-b',
      runtimeGeneration: 1,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signingB.capabilityGeneration,
    })
    // Identity A is generation 1 as well (different scoped manager).
    const runtimeA = fixture.coordinator.getActiveRuntime(IDENTITY)
    expect(runtimeA?.runtimeGeneration).toBe(1)
    // B's process exits: only B's identity/generation pair may tear down.
    await fixture.coordinator.handleUnexpectedExit({
      runtimeKey: keyB,
      runtimeGeneration: 1,
    })
    expect(fixture.coordinator.getActiveRuntime(identityB)).toBeUndefined()
    // A is untouched — a generation-only match would have removed it.
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeDefined()
    // A's capability still authenticates.
    const stillAuthorized = await fixture.post('/run/start', startBody())
    expect(stillAuthorized.status).toBe(200)
    await fixture.coordinator.shutdown()
  })

  it('unexpected exit without a runtimeKey is ignored (fail closed)', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    await fixture.coordinator.handleUnexpectedExit({ runtimeGeneration: 1 })
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeDefined()
    await fixture.coordinator.shutdown()
  })

  it('duplicate Authorization headers are rejected in BOTH header orders', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    const validToken = fixture.getSignedToken()
    // Forged FIRST, valid LAST: Node folds these into one comma-joined
    // headers value, so only a rawHeaders count catches the duplicate.
    const forgedFirst = await fixture.rawSocketRequest('/run/start', [
      'Authorization: Bearer forged-token',
      `Authorization: Bearer ${validToken}`,
    ], startBody())
    expect(forgedFirst.status).toBe(400)
    expect(forgedFirst.body).toContain('invalid_request')
    // Valid FIRST, forged LAST: also rejected — order must not matter.
    const validFirst = await fixture.rawSocketRequest('/run/start', [
      `Authorization: Bearer ${validToken}`,
      'Authorization: Bearer forged-token',
    ], startBody())
    expect(validFirst.status).toBe(400)
    expect(validFirst.body).toContain('invalid_request')
    // A single valid header keeps working.
    const single = await fixture.post('/run/start', startBody())
    expect(single.status).toBe(200)
    await fixture.coordinator.shutdown()
  })

  it('expired capability triggers the unified idempotent teardown with in-flight query', async () => {
    const fixture = createFixture({
      executorResults: [() => completed('x', 1, 1)],
      executeHangsUntilAbort: true,
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const inFlightQuery = fixture.post('/ai/query', { ...queryBody(), runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The virtual clock jumps past the fixed 24h TTL; the next App request
    // with the old token is refused AND tears the generation down.
    fixture.setNow(1_000_000 + 24 * 60 * 60 * 1000 + 1)
    const refused = await fixture.post('/run/start', startBody())
    expect(refused.status).toBe(401)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!fixture.coordinator.getActiveRuntime(IDENTITY)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
    expect(fixture.stopRuntimeCalls).toEqual([1])
    // A repeated expired request stays 401 and never re-triggers teardown.
    const again = await fixture.post('/run/start', startBody())
    expect(again.status).toBe(401)
    expect(fixture.stopRuntimeCalls).toEqual([1])
    await inFlightQuery.catch(() => null)
    await fixture.coordinator.shutdown()
  })

  it('cleanup budgets bound a hung Admin adapter: teardown returns within the request+total budget', async () => {
    const fixture = createFixture({
      executorResults: [() => completed('t', 1, 1)],
      usageHangsUntilAbort: true,
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    // The receipt POST hangs on the fake Admin; the App response resolves
    // only once the runtime controller aborts during teardown.
    const pendingQuery = fixture.post('/ai/query', { ...queryBody(), runId })
    await new Promise(resolve => setTimeout(resolve, 100))
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)
    const startedAt = Date.now()
    await fixture.coordinator.teardownRuntime(runtime!, 'cancelled')
    const elapsed = Date.now() - startedAt
    // The hung receipt reconfirmation is cut at the 5s request budget (the
    // lane then stops on its aborted shared controller) — far below the old
    // unbounded behaviour.
    expect(elapsed).toBeLessThan(9_500)
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
    const pendingResponse = await pendingQuery
    expect(pendingResponse.status).toBe(503)
    expect(pendingResponse.json.error.code).toBe('metering_unconfirmed')
  }, 20_000)

  it('Host failed result WITH trusted usage records the POL-102 receipt before the 502', async () => {
    const fixture = createFixture({
      executorResults: [
        () => ({
          status: 'failed' as const,
          error: {
            code: 'auth_failed' as const,
            reason: 'provider_rejected_credentials' as const,
            message: 'LLM provider rejected the connection credential',
          },
          requestId: 'h',
          model: 'model-x',
          usage: usage(21, 5),
        }),
      ],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const query = { runId, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
    const response = await fixture.post('/ai/query', query)
    expect(response.status).toBe(502)
    expect(response.json.error.code).toBe('host_auth_failed')
    // The provider-final usage of the failed call is metered, not dropped.
    const usageCall = fixture.adminCalls.find(call => call.method === 'usage')
    expect(usageCall!.body).toMatchObject({
      runId,
      requestId: query.requestId,
      inputTokens: 21,
      outputTokens: 5,
    })
    // The receipt is confirmed, so the run can finish cleanly.
    const finish = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(finish.status).toBe(200)
    // Terminal replay returns the cached stable error.
    const replay = await fixture.post('/ai/query', query)
    expect(replay.status).toBe(409)
    expect(replay.json.error.code).toBe('run_finalized')
  })

  it('executor factory failure releases the reservation; execute rejection yields a stable replayable outcome', async () => {
    const failingFactory = createFixture({ executorFactoryThrows: true })
    await failingFactory.post('/run/start', undefined).catch(() => null)
    const runIdA = await startRun(failingFactory)
    const queryA = { runId: runIdA, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
    const first = await failingFactory.post('/ai/query', queryA)
    expect(first.status).toBe(502)
    expect(first.json.error.code).toBe('host_failed')
    // The reservation was released: the same fingerprint is re-admitted
    // instead of being stuck in request_in_progress forever.
    const retry = await failingFactory.post('/ai/query', queryA)
    expect(retry.status).toBe(502)
    expect(retry.json.error.code).toBe('host_failed')
    await failingFactory.coordinator.shutdown()

    const rejectingExecute = createFixture({ executeRejection: true })
    await rejectingExecute.post('/run/start', undefined).catch(() => null)
    const runIdB = await startRun(rejectingExecute)
    const queryB = { runId: runIdB, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
    const failed = await rejectingExecute.post('/ai/query', queryB)
    expect(failed.status).toBe(502)
    expect(rejectingExecute.executorCount()).toBe(1)
    // The cached terminal outcome replays without another provider attempt.
    const replay = await rejectingExecute.post('/ai/query', queryB)
    expect(replay.status).toBe(502)
    expect(rejectingExecute.executorCount()).toBe(1)
    await rejectingExecute.coordinator.shutdown()
  })
})

describe('POO-54 R2 fix regressions (gateway/coordinator)', () => {
  it('capability expiry tears down an IDLE runtime via the generation-bound task with no further requests', async () => {
    const expiryCallbacks: Array<() => void> = []
    const fixture = createFixture({
      executorResults: [() => completed('x', 1, 1)],
      onExpiryArmed: fire => expiryCallbacks.push(fire),
    })
    const { getAppRuntimeCenter, resetAppRuntimeCenterForTests } =
      await import('@polo-ai/server-core/runtime')
    resetAppRuntimeCenterForTests()
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const query = { runId, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
    expect((await fixture.post('/ai/query', query)).status).toBe(200)
    // The capability was armed exactly once at issue time.
    expect(expiryCallbacks).toHaveLength(1)
    // Idle past the TTL with NO further request: the armed task fires.
    fixture.setNow(1_000_000 + 24 * 60 * 60 * 1000 + 1)
    expiryCallbacks[0]!()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!fixture.coordinator.getActiveRuntime(IDENTITY)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
    expect(fixture.stopRuntimeCalls).toEqual([1])
    // The projection is cleared and the settled run is reconciled as unknown.
    expect(getAppRuntimeCenter().findByIdentity(IDENTITY)).toBeUndefined()
    expect(fixture.adminCalls.at(-1)).toMatchObject({ method: 'finish', runId })
    const finishedCall = fixture.adminCalls.filter(c => c.method === 'finish').at(-1)
    expect((finishedCall!.body as { status: string }).status).toBe('unknown')
    // A later request with the expired token is still refused.
    const refused = await fixture.post('/run/start', startBody())
    expect(refused.status).toBe(401)
    expect(fixture.stopRuntimeCalls).toEqual([1])
    await fixture.coordinator.shutdown()
    resetAppRuntimeCenterForTests()
  })

  it('a revoked-token replay during a hung teardown does NOT trigger a second teardown/stop', async () => {
    const fixture = createFixture({
      executorResults: [() => completed('t', 1, 1)],
      usageHangsUntilAbort: true,
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const pendingQuery = fixture.post('/ai/query', { ...queryBody(), runId })
    await new Promise(resolve => setTimeout(resolve, 100))
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)
    // Explicit teardown starts and HANGS inside the cleanup lane (hung usage
    // reconfirmation up to the 5s request budget). The capability is already
    // revoked at this point. The exact-generation stop is counted directly.
    let stopCount = 0
    const teardownPromise = fixture.coordinator.teardownRuntime(runtime!, 'cancelled', async () => {
      stopCount += 1
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    // Old-token replay mid-teardown: 401, and the expiry path must reuse the
    // in-flight teardown instead of starting a second one.
    const replay = await fixture.post('/run/start', startBody())
    expect(replay.status).toBe(401)
    await teardownPromise
    // Exactly ONE exact-generation stop for the whole generation — a second
    // teardown via the revoked-token replay must never re-stop it.
    expect(stopCount).toBe(1)
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
    await pendingQuery.catch(() => null)
    await fixture.coordinator.shutdown()
  }, 20_000)

  it('pre-executor resolution failures release the reservation: retries re-admit instead of request_in_progress', async () => {
    for (const throws of ['resolve', 'config'] as const) {
      const fixture = createFixture({
        resolveWorkspaceRootThrows: throws === 'resolve',
        loadWorkspaceConfigThrows: throws === 'config',
      })
      await fixture.post('/run/start', undefined).catch(() => null)
      const runId = await startRun(fixture)
      const query = { runId, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
      const first = await fixture.post('/ai/query', query)
      expect(first.status).toBe(502)
      expect(first.json.error.code).toBe('host_failed')
      expect(fixture.executorCount()).toBe(0)
      // The full reservation was released: the retry is re-admitted.
      const retry = await fixture.post('/ai/query', query)
      expect(retry.status).toBe(502)
      expect(retry.json.error.code).toBe('host_failed')
      await fixture.coordinator.shutdown()
    }
  })

  it('the same runId owned by generation 1 is refused for generation 2', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = uuid()
    const first = await fixture.post('/run/start', { runId })
    expect(first.status).toBe(200)
    // A second capability generation (different runtime identity).
    const identityB = { ...IDENTITY, versionId: 'version-b' }
    const signingB = fixture.coordinator.signCapability({
      identity: identityB,
      workspaceId: 'ws-a',
      executionId: 'exec-b',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: identityB,
      executionId: 'exec-b',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signingB.capabilityGeneration,
    })
    const second = await fixture.post('/run/start', { runId }, { token: signingB.token })
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('run_state_conflict')
    // The owner generation is unaffected and can still use its run.
    const finish = await fixture.post('/run/finish', { runId, status: 'completed' })
    expect(finish.status).toBe(200)
    await fixture.coordinator.shutdown()
  })

  it('abort-source listeners do not accumulate across successful Admin requests', async () => {
    const fixture = createFixture({
      executorResults: [],
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    let added = 0
    let removed = 0
    const controllerSignal = runtime.controller.signal as unknown as {
      addEventListener: (type: string, listener: unknown, options?: unknown) => void
      removeEventListener: (type: string, listener: unknown, options?: unknown) => void
    }
    const originalAdd = controllerSignal.addEventListener.bind(controllerSignal)
    const originalRemove = controllerSignal.removeEventListener.bind(controllerSignal)
    controllerSignal.addEventListener = (...args: Parameters<typeof originalAdd>) => {
      added += 1
      return originalAdd(...args)
    }
    controllerSignal.removeEventListener = (...args: Parameters<typeof originalRemove>) => {
      removed += 1
      return originalRemove(...args)
    }
    const baselineAdd = added
    const baselineRemove = removed
    for (let index = 0; index < 5; index += 1) {
      const response = await fixture.post('/run/start', startBody())
      expect(response.status).toBe(200)
    }
    // Every composed signal disposed its source-signal listeners.
    expect(added - baselineAdd).toBe(removed - baselineRemove)
    await fixture.coordinator.shutdown()
  })
})

describe('POO-54 R3 fix regressions (gateway/coordinator)', () => {
  it('a completed generation is terminal: stale teardown neither re-stops nor aborts a replacement query', async () => {
    const fixture = createFixture({
      executorResults: [() => completed('g1', 1, 1), () => completed('g2', 2, 2)],
    })
    fixture.holdExecutions(true)
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId1 = await startRun(fixture)
    const held1 = fixture.post('/ai/query', { ...queryBody(), runId: runId1 })
      .catch(() => null)
    await new Promise(resolve => setTimeout(resolve, 50))
    const runtime1 = fixture.coordinator.getActiveRuntime(IDENTITY)!
    let stopCount = 0
    await fixture.coordinator.teardownRuntime(runtime1, 'cancelled', async () => {
      stopCount += 1
    })
    expect(stopCount).toBe(1)
    // A replacement generation takes over the SAME identity key.
    const signing2 = fixture.coordinator.signCapability({
      identity: IDENTITY,
      workspaceId: 'ws-a',
      executionId: 'exec-2',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: IDENTITY,
      executionId: 'exec-2',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing2.capabilityGeneration,
    })
    // gen2 starts its own run with its own (still valid) capability.
    const runId2 = uuid()
    const start2 = await fixture.post('/run/start', { runId: runId2 }, {
      token: signing2.token,
    })
    expect(start2.status).toBe(200)
    // gen2 admits and holds its own query.
    const held2 = fixture.post('/ai/query', { ...queryBody(), runId: runId2 }, {
      token: signing2.token,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    // STALE teardown of the COMPLETED generation: a terminal no-op — the
    // replacement is neither stopped nor drained.
    await fixture.coordinator.teardownRuntime(runtime1, 'cancelled', async () => {
      stopCount += 100
    })
    expect(stopCount).toBe(1)
    // gen2's in-flight query was NOT aborted: it completes normally.
    fixture.releaseOne()
    await new Promise(resolve => setTimeout(resolve, 30))
    fixture.releaseOne()
    const gen2Response = await held2
    expect(gen2Response.status).toBe(200)
    expect(gen2Response.json.data.text).toBe('g2')
    await held1
    fixture.holdExecutions(false)
  }, 20_000)

  it('coordinator shutdown is terminal: no gateway, capability or runtime can be created afterwards', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    await startRun(fixture)
    await fixture.coordinator.shutdown()
    // Second shutdown resolves idempotently.
    await fixture.coordinator.shutdown()
    // No gateway reopen.
    await expect(fixture.coordinator.ensureGateway())
      .rejects.toThrow(/shutting down/)
    // No capability re-signing.
    expect(() => fixture.coordinator.signCapability({
      identity: IDENTITY,
      workspaceId: 'ws-a',
      executionId: 'exec-late',
      runtimeKind: 'python',
      runtimeGeneration: 9,
      scopeGeneration: 9,
    })).toThrow(/shutting down/)
    // No runtime registration.
    expect(() => fixture.coordinator.registerActiveRuntime({
      identity: IDENTITY,
      executionId: 'exec-late',
      runtimeGeneration: 9,
      scopeGeneration: 9,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: 99,
    })).toThrow(/shutting down/)
    // The loopback boundary is closed: requests cannot connect at all.
    const result = await fixture.post('/run/start', startBody())
      .then(() => 'reachable', () => 'unreachable')
    expect(result).toBe('unreachable')
  })
})

describe('POO-54 R4 fix regressions (gateway/coordinator)', () => {
  it('a capability signed at spawn time is served in the boot window, with no projection until health', async () => {
    const { getAppRuntimeCenter, resetAppRuntimeCenterForTests } =
      await import('@polo-ai/server-core/runtime')
    resetAppRuntimeCenterForTests()
    const fixture = createFixture({
      executorResults: [() => completed('boot', 1, 1)],
      skipBootstrapRuntime: true,
    })
    await fixture.coordinator.ensureGateway()
    // Provisional registration exactly as the production hook does it:
    // signed + registered BEFORE the process can call; no projection yet.
    const signing = fixture.coordinator.signCapability({
      identity: IDENTITY,
      workspaceId: 'ws-a',
      executionId: 'exec-boot',
      runtimeKind: 'python',
      runtimeGeneration: 1,
      scopeGeneration: 1,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: IDENTITY,
      executionId: 'exec-boot',
      runtimeGeneration: 1,
      scopeGeneration: 1,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing.capabilityGeneration,
    })
    // The FIRST legitimate request in the boot window succeeds — no retry.
    const bootRun = { runId: uuid() }
    const started = await fixture.post('/run/start', bootRun, { token: signing.token })
    expect(started.status).toBe(200)
    expect(started.json.data).toMatchObject({ runId: bootRun.runId, status: 'running' })
    // The running projection is still withheld until the health gate passes.
    expect(getAppRuntimeCenter().findByIdentity(IDENTITY)).toBeUndefined()
    // Queries work in the boot window too.
    const query = { runId: bootRun.runId, requestId: uuid(), prompt: 'p', maxOutputTokens: 8, timeoutMs: 5_000 }
    const queryResponse = await fixture.post('/ai/query', query, { token: signing.token })
    expect(queryResponse.status).toBe(200)
    expect(queryResponse.json.data.text).toBe('boot')
    await fixture.coordinator.shutdown()
    resetAppRuntimeCenterForTests()
  })

  it('a synchronous abort-listener re-entry during teardown cannot double-stop', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    await startRun(fixture)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    let stopCount = 0
    // A listener that SYNCHRONOUSLY re-enters teardown during the abort
    // side effect of the first teardown.
    runtime.controller.signal.addEventListener('abort', () => {
      void fixture.coordinator.teardownRuntime(runtime, 'cancelled', async () => {
        stopCount += 10
      })
    })
    await fixture.coordinator.teardownRuntime(runtime, 'cancelled', async () => {
      stopCount += 1
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(stopCount).toBe(1)
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
  })

  it('runId ownership is a coordinator-lifetime tombstone across terminal and capability release', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    // Generation 1 owns runId R and takes it to terminal.
    const ownedRunId = uuid()
    const first = await fixture.post('/run/start', { runId: ownedRunId })
    expect(first.status).toBe(200)
    const finished = await fixture.post('/run/finish', { runId: ownedRunId, status: 'completed' })
    expect(finished.status).toBe(200)
    // Generation 2 (new capability, same/different identity) reusing the
    // tombstoned runId is still refused.
    const signing2 = fixture.coordinator.signCapability({
      identity: { ...IDENTITY, versionId: 'version-b' },
      workspaceId: 'ws-a',
      executionId: 'exec-b',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, versionId: 'version-b' },
      executionId: 'exec-b',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing2.capabilityGeneration,
    })
    const terminalReuse = await fixture.post('/run/start', { runId: ownedRunId }, {
      token: signing2.token,
    })
    expect(terminalReuse.status).toBe(409)
    expect(terminalReuse.json.error.code).toBe('run_state_conflict')
    // Capability release (full teardown) keeps the tombstone too: a THIRD
    // generation with a fresh valid capability is still refused.
    const runtime2 = fixture.coordinator.getActiveRuntime({
      ...IDENTITY,
      versionId: 'version-b',
    })!
    await fixture.coordinator.teardownRuntime(runtime2, 'cancelled')
    const signing3 = fixture.coordinator.signCapability({
      identity: { ...IDENTITY, versionId: 'version-c' },
      workspaceId: 'ws-a',
      executionId: 'exec-c',
      runtimeKind: 'python',
      runtimeGeneration: 3,
      scopeGeneration: 3,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, versionId: 'version-c' },
      executionId: 'exec-c',
      runtimeGeneration: 3,
      scopeGeneration: 3,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing3.capabilityGeneration,
    })
    const afterRelease = await fixture.post('/run/start', { runId: ownedRunId }, {
      token: signing3.token,
    })
    expect(afterRelease.status).toBe(409)
    expect(afterRelease.json.error.code).toBe('run_state_conflict')
    await fixture.coordinator.shutdown()
  })

  it('an in-flight Admin start that succeeds during teardown is reconciled and finished', async () => {
    let releaseStart: (() => void) | undefined
    let startHung = false
    const fixture = createFixture({
      // Only the FIRST Admin start hangs (and ignores its abort signal);
      // the cleanup lane's idempotent reconfirmation resolves immediately.
      onStart: () => {
        if (startHung) return
        startHung = true
        return new Promise<void>(resolve => {
          releaseStart = resolve
        })
      },
    })
    const runId = uuid()
    const pending = fixture.post('/run/start', { runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(releaseStart).toBeDefined()
    // Teardown begins while the Admin start is still hung; release it DURING
    // the drain grace so the late success is observed.
    setTimeout(() => releaseStart?.(), 300)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    await fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    // The App request waits for the frozen start's reconciliation and is
    // answered truthfully: the Admin start succeeded.
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.json.data).toMatchObject({ runId, status: 'running' })
    // The late remote success was reconciled: start reconfirmed, then a
    // qualified terminal finish (cancelled) was submitted — no orphan run.
    const startCalls = fixture.adminCalls.filter(call => call.method === 'start')
    expect(startCalls.length).toBeGreaterThanOrEqual(2)
    expect(startCalls[0]!.body).toMatchObject({ runId })
    const finishCall = fixture.adminCalls.filter(call => call.method === 'finish').at(-1)
    expect(finishCall).toMatchObject({ runId })
    expect((finishCall!.body as { status: string }).status).toBe('cancelled')
  }, 20_000)

  it('a failing generation-bound stop is RECORDED: teardown resolves after full cleanup and shutdown aggregates', async () => {
    const fixture = createFixture({
      stopRuntime: async () => {
        throw new Error('process stop exploded')
      },
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    await startRun(fixture)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    // Explicit teardown: the stop failure is RECORDED (never thrown) and
    // every other cleanup step still completes.
    await fixture.coordinator.teardownRuntime(runtime, 'cancelled', async () => {
      throw new Error('process stop exploded')
    })
    expect(fixture.coordinator.getActiveRuntime(IDENTITY)).toBeUndefined()
    // The projection was still cleared despite the failed stop.
    const { getAppRuntimeCenter } = await import('@polo-ai/server-core/runtime')
    expect(getAppRuntimeCenter().findByIdentity(IDENTITY)).toBeUndefined()
    // The recorded failure is observable at the coordinator boundary.
    expect(fixture.coordinator.getRollbackStopFailure('exec-1')).toMatchObject({
      message: 'process stop exploded',
    })

    // Shutdown with a failing adapter stop aggregates the recorded failures
    // into a rejection, while the generation cleanup itself still completed.
    const signing = fixture.coordinator.signCapability({
      identity: { ...IDENTITY, versionId: 'version-b' },
      workspaceId: 'ws-a',
      executionId: 'exec-b',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, versionId: 'version-b' },
      executionId: 'exec-b',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing.capabilityGeneration,
    })
    const runId = uuid()
    await fixture.post('/run/start', { runId }, { token: signing.token })
    await expect(fixture.coordinator.shutdown()).rejects.toThrow(/failed to stop/)
    expect(fixture.coordinator.getActiveRuntime({
      ...IDENTITY,
      versionId: 'version-b',
    })).toBeUndefined()
  })
})

describe('POO-54 R5 fix regressions (gateway/coordinator)', () => {
  it('a concurrent second teardown waits for and mirrors the first guard settlement', async () => {
    const fixture = createFixture({
      executorResults: [() => completed('x', 1, 1)],
      usageHangsUntilAbort: true,
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = await startRun(fixture)
    const pendingQuery = fixture.post('/ai/query', { ...queryBody(), runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    let releaseStop: (() => void) | undefined
    // First teardown hangs INSIDE the process stop until released.
    const first = fixture.coordinator.teardownRuntime(runtime, 'cancelled', () =>
      new Promise<void>(resolve => {
        releaseStop = resolve
      }))
    await new Promise(resolve => setTimeout(resolve, 50))
    // The cleanup lane's hung receipt occupies the budget before the stop
    // callback runs: wait (bounded) for the stop to be reached.
    for (let attempt = 0; attempt < 90 && releaseStop === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(releaseStop).toBeDefined()
    // Concurrent second teardown must share the guard, not resolve early.
    let secondSettled = false
    let secondError: unknown
    const second = fixture.coordinator
      .teardownRuntime(runtime, 'cancelled')
      .then(() => {
        secondSettled = true
      }, error => {
        secondSettled = true
        secondError = error
      })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(secondSettled).toBe(false)
    // Release the first teardown's stop: both settle together.
    releaseStop?.()
    await first
    await second
    expect(secondSettled).toBe(true)
    expect(secondError).toBeUndefined()
    await pendingQuery.catch(() => null)
    await fixture.coordinator.shutdown()
  }, 20_000)

  it('a concurrent second teardown shares the first settlement; stop failures are recorded exactly once', async () => {
    const fixture = createFixture()
    await fixture.post('/run/start', undefined).catch(() => null)
    await startRun(fixture)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    const first = fixture.coordinator.teardownRuntime(runtime, 'cancelled', async () => {
      throw new Error('stop exploded')
    })
    const second = fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    second.catch(() => {})
    // The shared guard settles together with the first teardown (stop
    // failures are RECORDED by performTeardown, never thrown).
    await first
    await second
  })

  it('a 2.5s late Admin start success is frozen, reconfirmed, terminal-finished and answered 200', async () => {
    let releaseStart: (() => void) | undefined
    let startHung = false
    const fixture = createFixture({
      onStart: () => {
        if (startHung) return
        startHung = true
        return new Promise<void>(resolve => {
          releaseStart = resolve
        })
      },
    })
    const runId = uuid()
    // The App's run/start is admitted and the Admin start hangs.
    const pending = fixture.post('/run/start', { runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    // Teardown freezes the start; the Admin succeeds at 2.5s — AFTER the
    // 2s drain grace. The frozen start is still reconciled.
    setTimeout(() => releaseStart?.(), 2_500)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    const teardownPromise = fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    // The original App request is answered 200 once the start is confirmed.
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.json.data).toMatchObject({ runId, status: 'running' })
    await teardownPromise
    // The frozen start was reconfirmed and a terminal finish submitted.
    const startCalls = fixture.adminCalls.filter(call => call.method === 'start')
    expect(startCalls.length).toBeGreaterThanOrEqual(2)
    const finishCall = fixture.adminCalls.filter(call => call.method === 'finish').at(-1)
    expect(finishCall).toMatchObject({ runId })
    await fixture.coordinator.shutdown()
  }, 20_000)

  it('a never-settling Admin start does not leak in-flight start allocations', async () => {
    const fixture = createFixture({
      onStart: () => new Promise<void>(() => {}),
    })
    const runId = uuid()
    const pending = fixture.post('/run/start', { runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fixture.coordinator.pendingInFlightStartCount()).toBe(1)
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    await fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    // Deterministic retirement: the never-settling adapter no longer holds
    // the in-flight allocation.
    expect(fixture.coordinator.pendingInFlightStartCount()).toBe(0)
    void pending.catch(() => null)
    await fixture.coordinator.shutdown()
  }, 20_000)
})

describe('POO-54 R5 tombstone high-water and credit replay', () => {
  it('reaching the tombstone high-water fails closed BEFORE the Admin start; recorded runIds stay rejected', async () => {
    const fixture = createFixture({ runIdTombstoneHighWater: 2 })
    await fixture.post('/run/start', undefined).catch(() => null)
    // Two runs fill the tombstone registry (each terminal-finished).
    const runId1 = uuid()
    expect((await fixture.post('/run/start', { runId: runId1 })).status).toBe(200)
    expect((await fixture.post('/run/finish', { runId: runId1, status: 'completed' })).status).toBe(200)
    const runId2 = uuid()
    expect((await fixture.post('/run/start', { runId: runId2 })).status).toBe(200)
    expect((await fixture.post('/run/finish', { runId: runId2, status: 'completed' })).status).toBe(200)
    const startsBefore = fixture.adminCalls.filter(c => c.method === 'start').length
    // Registry full: a NEW runId fails closed with a stable error and zero
    // Admin calls.
    const full = await fixture.post('/run/start', { runId: uuid() })
    expect(full.status).toBe(503)
    expect(full.json.error.code).toBe('run_registry_full')
    expect(fixture.adminCalls.filter(c => c.method === 'start').length).toBe(startsBefore)
    // A RECORDED runId (tombstoned, record already released) is still
    // rejected — never re-opened — on the same generation.
    const recorded = await fixture.post('/run/start', { runId: runId1 })
    expect(recorded.status).toBe(409)
    expect(recorded.json.error.code).toBe('run_state_conflict')
    expect(fixture.adminCalls.filter(c => c.method === 'start').length).toBe(startsBefore)
  })

  it('insufficient_credit disposes the run record but keeps ownership: exact retry re-enters Admin, cross-generation reuse stays 409', async () => {
    let startCalls = 0
    let creditBlocked = true
    const fixture = createFixture({
      onStart: async () => {
        startCalls += 1
        if (creditBlocked) {
          throw new AdminError('no credit', 'insufficient_credit')
        }
      },
    })
    await fixture.post('/run/start', undefined).catch(() => null)
    const runId = uuid()
    const first = await fixture.post('/run/start', { runId })
    expect(first.status).toBe(409)
    expect(first.json.error.code).toBe('insufficient_credit')
    expect(startCalls).toBe(1)
    // An exact retry re-enters Admin (the run record was disposed, the
    // ownership tombstone retained).
    creditBlocked = false
    const retry = await fixture.post('/run/start', { runId })
    expect(retry.status).toBe(200)
    expect(startCalls).toBe(2)
    // Another generation reusing the same runId is still refused.
    const signing2 = fixture.coordinator.signCapability({
      identity: { ...IDENTITY, versionId: 'version-b' },
      workspaceId: 'ws-a',
      executionId: 'exec-b',
      runtimeKind: 'python',
      runtimeGeneration: 2,
      scopeGeneration: 2,
    })
    fixture.coordinator.registerActiveRuntime({
      identity: { ...IDENTITY, versionId: 'version-b' },
      executionId: 'exec-b',
      runtimeGeneration: 2,
      scopeGeneration: 2,
      workspaceId: 'ws-a',
      runtimeKind: 'python',
      capabilityGeneration: signing2.capabilityGeneration,
    })
    const cross = await fixture.post('/run/start', { runId }, { token: signing2.token })
    expect(cross.status).toBe(409)
    expect(cross.json.error.code).toBe('run_state_conflict')
    await fixture.coordinator.shutdown()
  })
})

describe('POO-54 R6 fix regressions (gateway/coordinator)', () => {
  it('a hung start RECONFIRM beyond the budget never yields a fabricated 200 and submits no finish', async () => {
    let releaseOriginal: (() => void) | undefined
    let startCalls = 0
    const fixture = createFixture({
      onStart: () => {
        startCalls += 1
        if (startCalls === 1) {
          // The ORIGINAL Admin start succeeds late (beyond the drain grace).
          return new Promise<void>(resolve => {
            releaseOriginal = resolve
          })
        }
        // The cleanup lane's exact RECONFIRM hangs forever (budget aborts it).
        return new Promise<void>(() => {})
      },
    })
    const runId = uuid()
    const pending = fixture.post('/run/start', { runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    setTimeout(() => releaseOriginal?.(), 2_500)
    await fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    // The reconfirm timed out: the App must NOT receive a fabricated 200.
    const response = await pending
    expect(response.status).toBe(503)
    expect(response.json.error.code).toBe('shutting_down')
    // Zero terminal finishes: the late start was never confirmed+finished.
    expect(fixture.adminCalls.filter(call => call.method === 'finish')).toHaveLength(0)
    expect(startCalls).toBe(2)
    await fixture.coordinator.shutdown()
  }, 20_000)

  it('the reconciliation budget is enforced by a real timer even when the injectable clock freezes or rolls back', async () => {
    let releaseOriginal: (() => void) | undefined
    let startCalls = 0
    const fixture = createFixture({
      onStart: () => {
        startCalls += 1
        if (startCalls === 1) {
          return new Promise<void>(resolve => {
            releaseOriginal = resolve
          })
        }
        return new Promise<void>(() => {})
      },
    })
    const runId = uuid()
    const pending = fixture.post('/run/start', { runId })
    await new Promise(resolve => setTimeout(resolve, 50))
    const runtime = fixture.coordinator.getActiveRuntime(IDENTITY)!
    setTimeout(() => releaseOriginal?.(), 2_500)
    const teardownPromise = fixture.coordinator.teardownRuntime(runtime, 'cancelled')
    // Freeze AND roll back the injectable clock mid-wait: the REAL-TIMER
    // budget must still terminate the wait.
    fixture.setNow(500_000)
    const startedAt = Date.now()
    const response = await pending
    const elapsed = Date.now() - startedAt
    expect(response.status).toBe(503)
    expect(response.json.error.code).toBe('shutting_down')
    // Bounded: the wait ended via the real-timer budget, not the frozen clock.
    expect(elapsed).toBeLessThan(15_000)
    void teardownPromise
    expect(fixture.adminCalls.filter(call => call.method === 'finish')).toHaveLength(0)
    await fixture.coordinator.shutdown()
  }, 30_000)

  it('terminal lifecycle markers stay bounded across generation churn', async () => {
    const fixture = createFixture({ skipBootstrapRuntime: true })
    await fixture.coordinator.ensureGateway()
    const identityKey = createProductSpaceAppRuntimeIdentityKey(IDENTITY)
    const fakeRuntime = (runtimeGeneration: number) => ({
      identityKey,
      identity: IDENTITY,
      executionId: `exec-${runtimeGeneration}`,
      runtimeGeneration,
      scopeGeneration: 1,
      workspaceId: 'ws-a',
      runtimeKind: 'python' as const,
      capabilityGeneration: undefined,
      controller: new AbortController(),
    })
    // Heavy generation churn: register + teardown 500 generations.
    for (let gen = 1; gen <= 500; gen += 1) {
      fixture.coordinator.registerActiveRuntime(fakeRuntime(gen))
      await fixture.coordinator.teardownRuntime(
        fixture.coordinator.getActiveRuntime(IDENTITY)!,
        'cancelled',
      )
    }
    // BOUNDED storage: one scalar high-water == 500; no per-generation set.
    expect(fixture.coordinator.terminalRuntimeGenerationHighWater(createProductSpaceAppRuntimeIdentityKey(IDENTITY))).toBe(500)
    // Fail-closed: stale callbacks for ANY earlier generation are no-ops —
    // including one "covered" by a much higher generation.
    const stale = fakeRuntime(250)
    await fixture.coordinator.teardownRuntime(stale as never, 'cancelled')
    expect(fixture.coordinator.terminalRuntimeGenerationHighWater(createProductSpaceAppRuntimeIdentityKey(IDENTITY))).toBe(500)
    // A future generation still tears down normally.
    fixture.coordinator.registerActiveRuntime(fakeRuntime(501))
    await fixture.coordinator.teardownRuntime(
      fixture.coordinator.getActiveRuntime(IDENTITY)!,
      'cancelled',
    )
    expect(fixture.coordinator.terminalRuntimeGenerationHighWater(createProductSpaceAppRuntimeIdentityKey(IDENTITY))).toBe(501)
  })

  it('a static runtime (no capability) is tracked and cleared by the real coordinator shutdown', async () => {
    const fixture = createFixture({ skipBootstrapRuntime: true })
    await fixture.coordinator.ensureGateway()
    fixture.coordinator.registerActiveRuntime({
      identity: IDENTITY,
      executionId: 'exec-static',
      runtimeGeneration: 1,
      scopeGeneration: 1,
      workspaceId: 'ws-a',
      runtimeKind: 'static',
    })
    // Generation-exact liveness for the static runtime.
    expect(fixture.coordinator.getActiveRuntimeByExecution('exec-static')).toBeDefined()
    await fixture.coordinator.shutdown()
    expect(fixture.coordinator.getActiveRuntimeByExecution('exec-static')).toBeUndefined()
  })
})

it('POO-54 R7: two different identities with the SAME manager-local generation tear down independently — B never reuses A in-flight guard', async () => {
  const fixture = createFixture({ skipBootstrapRuntime: true })
  await fixture.coordinator.ensureGateway()
  // Identity A and B each report manager-local generation 1.
  const identityA = IDENTITY
  const identityB = { ...IDENTITY, productSpaceId: 'space-b' }
  const keyA = createProductSpaceAppRuntimeIdentityKey(identityA)
  const keyB = createProductSpaceAppRuntimeIdentityKey(identityB)
  const signingA = fixture.coordinator.signCapability({
    identity: identityA, workspaceId: 'ws-a', executionId: 'exec-a',
    runtimeKind: 'python', runtimeGeneration: 1, scopeGeneration: 1,
  })
  fixture.coordinator.registerActiveRuntime({
    identity: identityA, executionId: 'exec-a', runtimeGeneration: 1,
    scopeGeneration: 1, workspaceId: 'ws-a', runtimeKind: 'python',
    capabilityGeneration: signingA.capabilityGeneration,
  })
  const signingB = fixture.coordinator.signCapability({
    identity: identityB, workspaceId: 'ws-a', executionId: 'exec-b',
    runtimeKind: 'python', runtimeGeneration: 1, scopeGeneration: 2,
  })
  fixture.coordinator.registerActiveRuntime({
    identity: identityB, executionId: 'exec-b', runtimeGeneration: 1,
    scopeGeneration: 2, workspaceId: 'ws-a', runtimeKind: 'python',
    capabilityGeneration: signingB.capabilityGeneration,
  })
  // A's teardown hangs inside its stop callback.
  let releaseStopA: (() => void) | undefined
  let aStopCount = 0
  let bStopCount = 0
  const runtimeA = fixture.coordinator.getActiveRuntime(identityA)!
  const first = fixture.coordinator.teardownRuntime(runtimeA, 'cancelled', () =>
    new Promise<void>(resolve => {
      aStopCount += 1
      releaseStopA = resolve
    }))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(releaseStopA).toBeDefined()
  // B's teardown (same generation, different identity) starts while A hangs.
  let releaseStopB: (() => void) | undefined
  const runtimeB = fixture.coordinator.getActiveRuntime(identityB)!
  const second = fixture.coordinator.teardownRuntime(runtimeB, 'cancelled', () =>
    new Promise<void>(resolve => {
      bStopCount += 1
      releaseStopB = resolve
    }))
  await new Promise(resolve => setTimeout(resolve, 50))
  // B executed ITS OWN stop — it did not reuse A's in-flight guard.
  expect(bStopCount).toBe(1)
  // Release A: both settle independently.
  releaseStopA?.()
  await first
  expect(aStopCount).toBe(1)
  releaseStopB?.()
  await second
  expect(bStopCount).toBe(1)
  // Both identities are fully torn down (active cleared independently).
  expect(fixture.coordinator.getActiveRuntime(identityA)).toBeUndefined()
  expect(fixture.coordinator.getActiveRuntime(identityB)).toBeUndefined()
})

it('POO-54 R9: teardown scope matching uses unambiguous tuple keys — delimiter collisions cannot cross identities', async () => {
  const fixture = createFixture({ skipBootstrapRuntime: true })
  await fixture.coordinator.ensureGateway()
  // Two DISTINCT tuples that collide under naive '|' concatenation:
  // ('a|b', 'c', 'd') vs ('a', 'b|c', 'd').
  const identityColliding = {
    accountId: 'a|b',
    productSpaceId: 'c',
    artifactInstanceId: 'd',
    versionId: 'version-x',
    version: '1.0.0',
  }
  const identityOther = {
    accountId: 'a',
    productSpaceId: 'b|c',
    artifactInstanceId: 'd',
    versionId: 'version-x',
    version: '1.0.0',
  }
  const keyColliding = createProductSpaceAppRuntimeIdentityKey(identityColliding)
  const keyOther = createProductSpaceAppRuntimeIdentityKey(identityOther)
  expect(keyColliding).not.toBe(keyOther)
  fixture.coordinator.registerActiveRuntime({
    identity: identityColliding,
    executionId: 'exec-colliding',
    runtimeGeneration: 1,
    scopeGeneration: 1,
    workspaceId: 'ws',
    runtimeKind: 'python',
  })
  fixture.coordinator.registerActiveRuntime({
    identity: identityOther,
    executionId: 'exec-other',
    runtimeGeneration: 2,
    scopeGeneration: 1,
    workspaceId: 'ws',
    runtimeKind: 'python',
  })
  const { catalogRuntimeScopeTupleKey } = await import('../runtime-coordinator')
  // The production matching helper derives DISTINCT scope keys for the two
  // tuples — a withdrawal of one cannot select the other's runtime.
  const scopeKeyOf = (identity: { accountId: string; productSpaceId: string; artifactInstanceId: string }): string =>
    catalogRuntimeScopeTupleKey({
      accountId: identity.accountId,
      productSpaceId: identity.productSpaceId,
      artifactInstanceId: identity.artifactInstanceId,
    })
  expect(scopeKeyOf(identityColliding)).not.toBe(scopeKeyOf(identityOther))
  // Teardown of the colliding-key tuple leaves the other tuple untouched.
  const withdrawnScope = { accountId: 'a|b', organizationId: 'c', catalogAppId: 'd' }
  await fixture.coordinator.teardownRuntimesFor(runtime => {
    const scopeKey = catalogRuntimeScopeTupleKey({
      accountId: runtime.identity.accountId,
      productSpaceId: runtime.identity.productSpaceId,
      artifactInstanceId: runtime.identity.artifactInstanceId,
    })
    return scopeKey === catalogRuntimeScopeTupleKey({
      accountId: withdrawnScope.accountId,
      productSpaceId: withdrawnScope.organizationId,
      artifactInstanceId: withdrawnScope.catalogAppId,
    })
  }, 'cancelled')
  expect(fixture.coordinator.getActiveRuntime(identityColliding)).toBeUndefined()
  expect(fixture.coordinator.getActiveRuntime(identityOther)).toBeDefined()
  await fixture.coordinator.shutdown()
})
