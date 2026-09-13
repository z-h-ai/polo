import { describe, expect, it } from 'bun:test'
import { request as httpRequest } from 'node:http'
import { AdminError } from '@polo-ai/shared/admin'
import type { HostLlmPublicResult } from '@polo-ai/shared/agent/host-llm-executor'
import { LocalAppRuntimeCoordinator } from '../runtime-coordinator'
import { PER_CAPABILITY_QUERY_SLOTS } from '../app-api-run-state'

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
  sinks?: {
    reportResult?: (input: Record<string, unknown>) => Promise<{ revision: number }>
    reportFile?: (input: Record<string, unknown>) => Promise<{ revision: number }>
  }
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
  let executorCounter = 0
  const scripted = [...(options.executorResults ?? [])]
  let now = 1_000_000
  const gates: Array<() => void> = []
  let holdExecutions = false

  const coordinator = new LocalAppRuntimeCoordinator({
    admin: {
      startAppRun: async (input, signalOptions) => {
        adminCalls.push({ method: 'start', body: input })
        if (signalOptions?.signal?.aborted) throw new AdminError('aborted', 'NETWORK_ERROR')
        await options.onStart?.()
      },
      recordAppUsage: async (input, signalOptions) => {
        adminCalls.push({ method: 'usage', body: input })
        if (signalOptions?.signal?.aborted) throw new AdminError('aborted', 'NETWORK_ERROR')
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
      return {
        execute: async () => {
          if (holdExecutions) {
            await new Promise<void>(resolve => gates.push(resolve))
          }
          const next = scripted.shift()
          if (!next) throw new Error('no scripted executor result')
          return next()
        },
        dispose: async () => {},
      }
    },
    resolveWorkspaceRoot: workspaceId => (workspaceId === 'ws-a' ? '/root-a' : null),
    loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'conn-1', model: 'model-x' } }),
    getDefaultLlmConnection: () => null,
    ...(options.sinks ? { sinks: options.sinks } : {}),
    now: () => now,
  })

  let baseURL = ''
  let token = ''
  const ready = (async () => {
    const gatewayUrl = await coordinator.ensureGateway()
    baseURL = gatewayUrl.replace(/\/local-app-api\/v1$/, '')
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

  return {
    coordinator,
    adminCalls,
    executorCount: () => executorCounter,
    post,
    rawRequest,
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
