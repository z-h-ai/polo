import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import http from 'node:http'
import { checkDescriptor, codexStreamExtras, isLoopback, JSON_OBJECT_SYSTEM_CONSTRAINT, sanitizeEnvironment, SANITIZED_ENV_KEYS } from '../host-completion.ts'
import { HOST_PARENT_MARKER, TEXT_LIMIT, validateHostRequest, type ValidatedHostRequest } from '../host-completion-protocol.ts'
import { createHostStreamTracker, type StreamVerdict } from '../host-completion-stream.ts'
import { startHostPiStream, type HostPiBindings, type HostPiRuntime, type HostPiStreamContext } from '../host-completion.ts'
import type { InstalledTransportObservation } from '../host-completion-policy.ts'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'

function mustValidate(object: Record<string, unknown>): ValidatedHostRequest {
  const verdict = validateHostRequest(object)
  if (verdict.kind !== 'valid') throw new Error(`fixture request invalid: ${verdict.kind}`)
  return verdict.request
}
import type { AssistantMessage, AssistantMessageEvent } from '@mariozechner/pi-ai'
import { acquireHostTestSerialLock, releaseHostTestSerialLock, waitOutEarlySuiteWindow } from './host-test-serial.ts'

await waitOutEarlySuiteWindow()

const ENTRY = join(import.meta.dir, '..', 'index.ts')
const HOST_FLAG = '--host-completion-v1'
const API_KEY_PROVIDERS = ['anthropic', 'google', 'openai', 'cerebras', 'deepseek', 'fireworks', 'groq', 'huggingface', 'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn', 'opencode', 'opencode-go', 'openrouter', 'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai']
const CANARY = 'CANARY-prompt-9f2c1'

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'host_completion', version: 1, parentValidation: HOST_PARENT_MARKER, requestId: 'req-1',
    route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' },
    model: 'pi/claude-3-5-haiku-20241022', prompt: 'hello', maxOutputTokens: 64, timeoutMs: 20000,
    credential: { type: 'api_key', value: 'sk-test' }, ...overrides,
  }
}

function descriptor(overrides: Record<string, unknown> = {}, credential: unknown = { type: 'api_key', value: 'k' }): ValidatedHostRequest {
  const verdict = validateHostRequest(request({ ...overrides, credential }))
  if (verdict.kind !== 'valid') throw new Error(`fixture request failed validation: ${verdict.kind}`)
  return verdict.request
}

interface MockSse {
  url: string
  hits(): string[]
  requests(): Array<{ url: string; authorization: string | null; body: string }>
  close(): void
}

function startMockSse(behavior: {
  chunks?: Array<Record<string, unknown>>
  rawEvents?: string[]
  delayMs?: number
  status?: number
  statusBody?: string
  doneSentinel?: boolean
  halfThenDropMs?: number
} = {}): MockSse {
  const requests: Array<{ url: string; authorization: string | null; body: string }> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', authorization: (req.headers.authorization as string | undefined) ?? null, body })
      if (behavior.halfThenDropMs !== undefined) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const events = behavior.rawEvents ?? (behavior.chunks ?? []).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        res.write(events[0])
        setTimeout(() => (res.socket as import('node:net').Socket | null)?.destroy(), behavior.halfThenDropMs)
        return
      }
      const respond = () => {
        if (behavior.status !== undefined) {
          res.writeHead(behavior.status, { 'content-type': 'application/json' })
          res.end(behavior.statusBody ?? '{}')
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of behavior.rawEvents ?? (behavior.chunks ?? []).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)) res.write(event)
        if (behavior.doneSentinel !== false) res.write('data: [DONE]\n\n')
        res.end()
      }
      if (behavior.delayMs) setTimeout(respond, behavior.delayMs)
      else respond()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      hits: () => requests.map((entry) => entry.url),
      requests: () => requests,
      close: () => server.close(),
    }))
  })
}

function textChunks(model: string, text: string, usage: Record<string, number>): Array<Record<string, unknown>> {
  return [
    { id: 'c1', model, choices: [{ delta: { role: 'assistant' } }] },
    { id: 'c1', model, choices: [{ delta: { content: text } }] },
    { id: 'c1', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ]
}

const WORKER_SPAWN_PACE_MS = 150

function runWorker(requestObject: Record<string, unknown>, options: { raw?: string; extraArgv?: string[]; secondWrite?: string; ambient?: Record<string, string> } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      // Nice the worker children so suite files running concurrently on this
      // machine are not starved while these single-request processes burn CPU.
      const child = spawn('/usr/bin/nice', ['-n', '20', process.execPath, ENTRY, HOST_FLAG, ...(options.extraArgv ?? [])], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(options.ambient ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      if (options.raw !== undefined) child.stdin.write(options.raw)
      else child.stdin.write(JSON.stringify(requestObject) + '\n')
      if (options.secondWrite !== undefined) setTimeout(() => { child.stdin.write(options.secondWrite!); child.stdin.end() }, 150)
      else child.stdin.end()
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    }, WORKER_SPAWN_PACE_MS)
  })
}

function parseSingleResult(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]) as Record<string, unknown>
}

describe('host worker credential descriptor matrix', () => {
  it('accepts exactly the 24 sealed catalog api-key providers', () => {
    for (const provider of API_KEY_PROVIDERS) {
      expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider, transportBaseUrl: 'https://api.example.com/' } }))).toBe(true)
    }
    expect(API_KEY_PROVIDERS.length).toBe(24)
    expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider: 'azure-openai-responses', transportBaseUrl: 'https://api.example.com/' } }))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider: 'unknown-provider', transportBaseUrl: 'https://api.example.com/' } }))).toBe(false)
  })

  it('accepts only the three oauth catalog providers and the single IAM provider', () => {
    for (const provider of ['anthropic', 'openai-codex', 'github-copilot']) {
      expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider, transportBaseUrl: 'https://api.example.com/' } }, { type: 'oauth_access', value: 'tok' }))).toBe(true)
    }
    expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider: 'openrouter', transportBaseUrl: 'https://api.example.com/' } }, { type: 'oauth_access', value: 'tok' }))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider: 'amazon-bedrock', transportBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/' } }, { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1' }))).toBe(true)
    expect(checkDescriptor(descriptor({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' } }, { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1' }))).toBe(false)
  })

  it('never accepts keyless catalog routes and restricts keyless custom routes to loopback', () => {
    expect(checkDescriptor(descriptor({}, { type: 'none' }))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8080/' } }, { type: 'none' }))).toBe(true)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://localhost:8080/' } }, { type: 'none' }))).toBe(true)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'https://[::1]:8080/' } }, { type: 'none' }))).toBe(true)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'https://example.com/' } }, { type: 'none' }))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1.anchored.example/' } }, { type: 'none' }))).toBe(false)
  })

  it('allows custom api_key on HTTPS or exact loopback HTTP(S) and rejects oauth/IAM on custom routes', () => {
    const custom = (baseUrl: string): ValidatedHostRequest => descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl } })
    expect(checkDescriptor(custom('https://example.com/'))).toBe(true)
    expect(checkDescriptor(custom('http://127.0.0.1:9/'))).toBe(true)
    expect(checkDescriptor(custom('https://localhost:9/'))).toBe(true)
    expect(checkDescriptor(custom('http://example.com/'))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/' } }, { type: 'oauth_access', value: 'tok' }))).toBe(false)
    expect(checkDescriptor(descriptor({ route: { kind: 'custom', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9/' } }, { type: 'iam', accessKeyId: 'a', secretAccessKey: 's', region: 'us-east-1' }))).toBe(false)
  })

  it('classifies loopback hosts without substring or bracket mistakes', () => {
    expect(isLoopback('http://localhost:1/')).toBe(true)
    expect(isLoopback('http://[::1]:1/')).toBe(true)
    expect(isLoopback('http://localhost.attacker/')).toBe(false)
  })
})

describe('host worker environment boundary', () => {
  it('builds codex stream extras that force SSE and inject only max_output_tokens on a cloned payload', () => {
    const extras = codexStreamExtras(64)
    expect(extras.transport).toBe('sse')
    const payload = { model: 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, store: false }
    const next = extras.onPayload(payload)
    expect(next).toEqual({ ...payload, max_output_tokens: 64 })
    expect(payload).not.toHaveProperty('max_output_tokens')
    expect(Object.keys(next).filter((key) => !(key in payload))).toEqual(['max_output_tokens'])
  })

  it('deletes provider, proxy, and ambient AWS credential/config variables', () => {
    const probe = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'https_proxy', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_BEDROCK_SKIP_AUTH', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_USE_FIPS_ENDPOINT', 'AWS_EC2_METADATA_DISABLED', 'GOOGLE_APPLICATION_CREDENTIALS']
    const saved = probe.map((key) => [key, process.env[key]] as const)
    try {
      for (const key of probe) process.env[key] = 'ambient-canary- value'
      sanitizeEnvironment()
      for (const key of probe) expect(process.env[key]).toBeUndefined()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('covers every env var the sealed pi-ai auth chain can consult', () => {
    const sealed = ['AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AZURE_OPENAI_API_KEY', 'CEREBRAS_API_KEY', 'CLOUDFLARE_API_KEY', 'COPILOT_GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'FIREWORKS_API_KEY', 'GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_CLOUD_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'KIMI_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MISTRAL_API_KEY', 'MOONSHOT_API_KEY', 'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'XIAOMI_API_KEY', 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', 'ZAI_API_KEY']
    for (const key of sealed) expect(SANITIZED_ENV_KEYS).toContain(key)
  })
})

interface TrackerHarness {
  tracker: ReturnType<typeof createHostStreamTracker>
  claims: string[]
  delta: (contentIndex: number, text: string) => AssistantMessageEvent
  thinkDelta: (contentIndex: number, text: string) => AssistantMessageEvent
  end: (contentIndex: number, text: string) => AssistantMessageEvent
  done: (reason: 'stop' | 'length' | 'toolUse', message: AssistantMessage) => AssistantMessageEvent
  error: (reason: 'aborted' | 'error', message: AssistantMessage) => AssistantMessageEvent
  finish: (observation?: Record<string, unknown>, deadlineExpired?: boolean) => StreamVerdict
}

const OK_OBSERVATION = { attempts: 1, networkFailure: false, retryBlocked: false, sdkException: false }

function finalMessage(text: string, extra: Record<string, unknown> = {}): AssistantMessage {
  return assistantMessage([{ type: 'text', text }], { usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }, model: 'm', ...extra })
}

function trackerHarness(overrides: Record<string, unknown> = {}): TrackerHarness {
  const claims: string[] = []
  const tracker = createHostStreamTracker({
    expectedModel: 'm', maxOutputTokens: 100, jsonOutput: false, bedrock: false,
    claim: (kind) => claims.push(kind), ...overrides,
  })
  const delta = (contentIndex: number, text: string): AssistantMessageEvent => ({ type: 'text_delta', contentIndex, delta: text, partial: assistantMessage([]) }) as AssistantMessageEvent
  const thinkDelta = (contentIndex: number, text: string): AssistantMessageEvent => ({ type: 'thinking_delta', contentIndex, delta: text, partial: assistantMessage([]) }) as AssistantMessageEvent
  const end = (contentIndex: number, text: string): AssistantMessageEvent => ({ type: 'text_end', contentIndex, content: text, partial: assistantMessage([]) }) as AssistantMessageEvent
  return {
    tracker, claims, delta, thinkDelta, end,
    done: (reason, message) => ({ type: 'done', reason, message }) as AssistantMessageEvent,
    error: (reason, message) => ({ type: 'error', reason, error: message }) as AssistantMessageEvent,
    finish: (observation: Record<string, unknown> = OK_OBSERVATION, deadlineExpired = false) => tracker.finish(observation as never, deadlineExpired),
  }
}

describe('host stream tracker verdicts', () => {
  it('claims done(length) as partial with terminalReason length', () => {
    const h = trackerHarness()
    h.tracker.onEvent(h.delta(0, 'hi'))
    h.tracker.onEvent(h.done('length', finalMessage('hi')))
    const verdict = h.finish()
    expect(verdict).toMatchObject({ kind: 'release', status: 'partial' })
    if (verdict.kind === 'release') expect(verdict.usage.terminalReason).toBe('length')
  })

  it('rejects any tool content even when the final message also carries valid text and done(stop)', () => {
    const h = trackerHarness()
    h.tracker.onEvent(h.delta(0, 'precious'))
    const message = assistantMessage([
      { type: 'text', text: 'precious' },
      { type: 'toolCall', id: 't1', name: 'f', arguments: { a: 1 } },
    ], { usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }, model: 'm' })
    h.tracker.onEvent(h.done('stop', message))
    expect(h.claims).toEqual(['unexpected_terminal'])
    expect(h.finish()).toMatchObject({ kind: 'failure', failure: 'unexpected_terminal' })
  })

  it('claims a bare toolcall_start event immediately', () => {
    const h = trackerHarness()
    h.tracker.onEvent({ type: 'toolcall_start', contentIndex: 0, partial: assistantMessage([]) } as AssistantMessageEvent)
    expect(h.claims).toEqual(['unexpected_terminal'])
  })

  it('lets walker overflow on a huge toolCall beat the tool rejection as result_too_large', () => {
    const h = trackerHarness()
    const message = assistantMessage([{ type: 'toolCall', id: 't1', name: 'f', arguments: { k: 'x'.repeat(TEXT_LIMIT + 1) } }], { usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }, model: 'm' })
    h.tracker.onEvent(h.done('toolUse', message))
    expect(h.claims).toEqual(['result_too_large'])
  })

  it('maps an aborted error terminal to provider_aborted and a plain error to the transport class', () => {
    const aborted = trackerHarness()
    aborted.tracker.onEvent(aborted.error('aborted', assistantMessage([])))
    expect(aborted.finish()).toMatchObject({ kind: 'failure', failure: 'provider_aborted' })
    const plain = trackerHarness()
    plain.tracker.onEvent(plain.error('error', assistantMessage([])))
    expect(plain.finish()).toMatchObject({ kind: 'failure', failure: 'provider_error_terminal' })
    const unauthorized = trackerHarness()
    unauthorized.tracker.onEvent(unauthorized.error('error', assistantMessage([])))
    expect(unauthorized.finish({ ...OK_OBSERVATION, status: 401 })).toMatchObject({ kind: 'failure', failure: 'provider_rejected_credentials' })
  })

  it('claims a stream that ends without any terminal event', () => {
    const h = trackerHarness()
    h.tracker.onEvent(h.delta(0, 'partial text'))
    expect(h.finish()).toMatchObject({ kind: 'failure', failure: 'unexpected_terminal' })
  })

  it('claims a second done instead of releasing twice and classifies attempts drift', () => {
    const h = trackerHarness()
    h.tracker.onEvent(h.delta(0, 'hi'))
    h.tracker.onEvent(h.done('stop', finalMessage('hi')))
    h.tracker.onEvent(h.done('stop', finalMessage('hi')))
    expect(h.claims[0]).toBe('unexpected_terminal')
    const zeroAttempts = trackerHarness()
    zeroAttempts.tracker.onEvent(zeroAttempts.delta(0, 'hi'))
    zeroAttempts.tracker.onEvent(zeroAttempts.done('stop', finalMessage('hi')))
    expect(zeroAttempts.finish({ ...OK_OBSERVATION, attempts: 0 })).toMatchObject({ kind: 'failure', failure: 'provider_error_terminal' })
    const retried = trackerHarness()
    retried.tracker.onEvent(retried.delta(0, 'hi'))
    retried.tracker.onEvent(retried.done('stop', finalMessage('hi')))
    expect(retried.finish({ ...OK_OBSERVATION, attempts: 2, retryBlocked: true })).toMatchObject({ kind: 'failure', failure: 'retry_blocked' })
  })

  it('validates provider-final usage: all-zero, cap, identity, and bedrock cache normalization', () => {
    const usageOf = (usage: Record<string, number>): AssistantMessage => assistantMessage([{ type: 'text', text: 'hi' }], { usage: usage as never, model: 'm' })
    const zero = trackerHarness()
    zero.tracker.onEvent(zero.done('stop', usageOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })))
    expect(zero.finish()).toMatchObject({ kind: 'failure', failure: 'provider_usage_invalid' })
    const cap = trackerHarness()
    cap.tracker.onEvent(cap.done('stop', usageOf({ input: 5, output: 101, cacheRead: 0, cacheWrite: 0, totalTokens: 106 })))
    expect(cap.finish()).toMatchObject({ kind: 'failure', failure: 'provider_usage_invalid' })
    const drift = trackerHarness()
    drift.tracker.onEvent(drift.done('stop', usageOf({ input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 99 })))
    expect(drift.finish()).toMatchObject({ kind: 'failure', failure: 'provider_usage_invalid' })
    const bedrock = trackerHarness({ bedrock: true })
    bedrock.tracker.onEvent(bedrock.done('stop', usageOf({ input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 12 })))
    const verdict = bedrock.finish()
    expect(verdict.kind).toBe('release')
    if (verdict.kind === 'release') expect(verdict.usage).toMatchObject({ inputTokens: 6, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 12 })
  })

  it('rejects reportedModel drift against the sent clone id', () => {
    const h = trackerHarness()
    h.tracker.onEvent(h.done('stop', finalMessage('hi', { responseModel: 'other' })))
    expect(h.finish()).toMatchObject({ kind: 'failure', failure: 'unexpected_terminal' })
  })

  it('preserves validated usage when json_object output fails the object gate', () => {
    const h = trackerHarness({ jsonOutput: true })
    h.tracker.onEvent(h.delta(0, '[1,2]'))
    h.tracker.onEvent(h.done('stop', finalMessage('[1,2]')))
    const verdict = h.finish()
    expect(verdict).toMatchObject({ kind: 'failure', failure: 'json_object_required' })
    if (verdict.kind === 'failure') expect(verdict.usage).toMatchObject({ inputTokens: 5, totalTokens: 9, provenance: 'provider_final' })
  })
})

function assistantMessage(content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): AssistantMessage {
  return { role: 'assistant', content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'stop', timestamp: 0, ...extra } as unknown as AssistantMessage
}

describe('host worker single-request JSONL fixtures', () => {
  beforeAll(async () => { await acquireHostTestSerialLock() })
  afterAll(() => releaseHostTestSerialLock())

  it('runs a keyless loopback custom completion with the fixed not-needed placeholder and exact options', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', 'Hello world', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) })
    try {
      const outcome = await runWorker(request({
        route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url },
        model: 'test-model', credential: { type: 'none' }, systemPrompt: 'Be terse.',
      }))
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result).toMatchObject({ type: 'host_completion_result', version: 1, requestId: 'req-1', model: 'test-model', status: 'completed', text: 'Hello world' })
      expect(result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18, reportedModel: 'test-model', terminalReason: 'stop', provenance: 'provider_final' })
      expect(mock.hits()).toHaveLength(1)
      const sent = mock.requests()[0]
      expect(sent.authorization).toBe('Bearer not-needed')
      const body = JSON.parse(sent.body)
      expect(body.messages[0].content).toBe('Be terse.')
      expect(body.messages[1].content).toBe('hello')
      expect(body.max_completion_tokens).toBe(64)
    } finally {
      mock.close()
    }
  }, 60000)

  it('composes the worker-owned json_object system constraint with and without a parent system prompt', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', '{"answer":42}', { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }) })
    try {
      const withParent = await runWorker(request({
        route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url },
        model: 'test-model', credential: { type: 'none' }, systemPrompt: 'Base.', responseFormat: 'json_object',
      }))
      expect(parseSingleResult(withParent.stdout).status).toBe('completed')
      expect(JSON.parse(mock.requests()[0].body).messages[0].content).toBe(`Base.\n\n${JSON_OBJECT_SYSTEM_CONSTRAINT}`)
      mock.requests().length = 0
      const withoutParent = await runWorker(request({
        route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url },
        model: 'test-model', credential: { type: 'none' }, responseFormat: 'json_object',
      }))
      expect(parseSingleResult(withoutParent.stdout).status).toBe('completed')
      expect(JSON.parse(mock.requests()[0].body).messages[0].content).toBe(JSON_OBJECT_SYSTEM_CONSTRAINT)
    } finally {
      mock.close()
    }
  }, 60000)

  it('fails json_object requests that produce arrays, scalars, or fenced output while preserving validated usage', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', '[1,2]', { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }) })
    try {
      const outcome = await runWorker(request({
        route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url },
        model: 'test-model', credential: { type: 'none' }, responseFormat: 'json_object',
      }))
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result.status).toBe('failed')
      expect(result.error).toMatchObject({ code: 'invalid_structured_output', reason: 'json_object_required', message: 'LLM provider returned invalid structured output' })
      expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 4, totalTokens: 9, terminalReason: 'stop', provenance: 'provider_final' })
      expect(result.text).toBeUndefined()
    } finally {
      mock.close()
    }
  }, 60000)

  it('fails provider-final usage that is missing, inconsistent, or exceeds the output cap', async () => {
    for (const usage of [{ prompt_tokens: 0, completion_tokens: 4, total_tokens: 4 }, { prompt_tokens: 5, completion_tokens: 4096, total_tokens: 4101 }, undefined]) {
      const chunks = usage === undefined
        ? [
            { id: 'c1', model: 'test-model', choices: [{ delta: { role: 'assistant' } }] },
            { id: 'c1', model: 'test-model', choices: [{ delta: { content: 'Hello' } }] },
            { id: 'c1', model: 'test-model', choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]
        : textChunks('test-model', 'Hello', usage)
      const mock = await startMockSse({ chunks })
      try {
        const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' } }))
        const result = parseSingleResult(outcome.stdout)
        expect(result.error).toMatchObject({ code: 'invalid_usage', reason: 'provider_usage_invalid', message: 'LLM provider returned invalid usage' })
      } finally {
        mock.close()
      }
    }
  }, 60000)

  it('rejects a reportedModel drift with zero text release', async () => {
    const mock = await startMockSse({ chunks: textChunks('other-model', 'Hello', { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }) })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' } }))
      const result = parseSingleResult(outcome.stdout)
      expect(result.error).toMatchObject({ code: 'provider_protocol_error', reason: 'unexpected_terminal', message: 'LLM provider returned an unsupported terminal event' })
      expect(result.text).toBeUndefined()
    } finally {
      mock.close()
    }
  }, 60000)

  it('claims the shared deadline before the delayed provider response and emits exactly one timeout result', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', 'late', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), delayMs: 3000 })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' }, timeoutMs: 100 }))
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result).toMatchObject({ requestId: 'req-1', model: 'test-model', status: 'timed_out' })
      expect(result.error).toMatchObject({ code: 'timed_out', reason: 'deadline_exceeded', message: 'Host LLM request timed out' })
      expect(result.text).toBeUndefined()
    } finally {
      mock.close()
    }
  }, 60000)

  it('maps a structured 500 to provider_request_failed without leaking the provider raw error body', async () => {
    const mock = await startMockSse({ status: 500, statusBody: JSON.stringify({ error: { message: CANARY } }) })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' }, prompt: `ignore ${CANARY}` }))
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result.error).toMatchObject({ code: 'provider_failed', reason: 'provider_request_failed', message: 'LLM provider request failed' })
      expect(outcome.stdout).not.toContain(CANARY)
      expect(outcome.stderr).not.toContain(CANARY)
    } finally {
      mock.close()
    }
  }, 60000)

  it('maps structured 401 to auth_failed and a second wire attempt to retry_blocked', async () => {
    const unauthorized = await startMockSse({ status: 401 })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: unauthorized.url }, model: 'test-model', credential: { type: 'none' } }))
      expect(parseSingleResult(outcome.stdout).error).toMatchObject({ code: 'auth_failed', reason: 'provider_rejected_credentials', message: 'LLM provider rejected the connection credential' })
      expect(unauthorized.hits()).toHaveLength(1)
    } finally {
      unauthorized.close()
    }
  }, 60000)

  it('fails framing violations before any transport: invalid UTF-8, missing LF, second line, empty line, oversize', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', 'x', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) })
    const route = { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }
    try {
      const invalidUtf8 = await runWorker(request({ route, model: 'test-model', credential: { type: 'none' } }), { raw: Buffer.concat([Buffer.from('{"type":"host_completion"', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('\n', 'utf8')]) })
      expect(parseSingleResult(invalidUtf8.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
      expect(mock.hits()).toHaveLength(0)
      const noLf = await runWorker(request({ route, model: 'test-model', credential: { type: 'none' } }), { raw: JSON.stringify(request({ route, model: 'test-model', credential: { type: 'none' } })) })
      expect(parseSingleResult(noLf.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
      const twoLines = await runWorker(request({ route, model: 'test-model', credential: { type: 'none' } }), { secondWrite: '{"type":"session"}\n' })
      expect(parseSingleResult(twoLines.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
      expect(mock.hits()).toHaveLength(0)
      const emptyLine = await runWorker(request({}), { raw: '\n' })
      expect(parseSingleResult(emptyLine.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
      const oversize = await runWorker(request({ route, model: 'test-model', credential: { type: 'none' }, prompt: 'x'.repeat(2_097_153) }))
      expect(parseSingleResult(oversize.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'result_too_large', message: 'Host LLM worker result exceeds the wire limit' })
      expect(mock.hits()).toHaveLength(0)
    } finally {
      mock.close()
    }
  }, 60000)

  it('fails catalog miss and catalog/baseUrl drift with zero transport', async () => {
    const mock = await startMockSse({})
    try {
      const miss = await runWorker(request({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' }, model: 'pi/no-such-model-xyz', credential: { type: 'api_key', value: 'sk' } }))
      const missResult = parseSingleResult(miss.stdout)
      expect(missResult.status).toBe('failed')
      expect(missResult.model).toBe('pi/no-such-model-xyz')
      expect(missResult.error).toMatchObject({ code: 'provider_protocol_error', reason: 'catalog_model_missing', message: 'Model is not available in the sealed provider catalog' })
      expect(mock.hits()).toHaveLength(0)
      const drift = await runWorker(request({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://127.0.0.1:1/' }, credential: { type: 'api_key', value: 'sk' } }))
      expect(parseSingleResult(drift.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
      expect(mock.hits()).toHaveLength(0)
    } finally {
      mock.close()
    }
  }, 60000)

  it('fails Bedrock anchors that disagree with the zero-I/O SDK endpoint resolution before any transport', async () => {
    const mismatch = await runWorker(request({
      route: { kind: 'catalog', provider: 'amazon-bedrock', transportBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/' },
      model: 'pi/amazon.nova-lite-v1:0', credential: { type: 'iam', accessKeyId: 'AKIA-canary', secretAccessKey: 'secret', region: 'us-west-2' },
    }))
    expect(mismatch.code).toBe(0)
    expect(parseSingleResult(mismatch.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'invalid_worker_message', message: 'Host LLM worker protocol failed' })
    expect(mismatch.stderr).not.toContain('AKIA-canary')
  }, 120000)

  it('claims the shared deadline from the first stdin byte even while stdin stays open before EOF', async () => {
    const outcome = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn('/usr/bin/nice', ['-n', '20', process.execPath, ENTRY, HOST_FLAG], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stdin.write(JSON.stringify(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/' }, model: 'test-model', credential: { type: 'none' }, timeoutMs: 100 })) + '\n')
      const check = setTimeout(() => {
        const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
        expect(lines).toHaveLength(1)
        const result = JSON.parse(lines[0]) as { status: string; error: { code: string; reason: string; message: string } }
        expect(result.status).toBe('timed_out')
        expect(result.error).toEqual({ code: 'timed_out', reason: 'deadline_exceeded', message: 'Host LLM request timed out' })
        child.stdin.end()
      }, 1500)
      child.on('close', (code) => { clearTimeout(check); resolve({ code, stdout }) })
    })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1)
  }, 60000)

  it('emits at most one fixed invalid_worker_message result for duplicate or unknown --host- flags', async () => {
    for (const extraArgv of [['--host-completion-v1'], ['--host-other'], ['--host-other', '--host-more']]) {
      const outcome = await runWorker(request({}), { raw: '', extraArgv })
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result.requestId).toBe('invalid')
      expect(result.model).toBe('invalid')
      expect(result.error).toMatchObject({ code: 'provider_protocol_error', reason: 'invalid_worker_message', message: 'Host LLM worker protocol failed' })
      expect(outcome.stderr).toBe('')
    }
  }, 60000)

  it('runs the production registration seam: every negative route registers and streams zero times', async () => {
    const observation = {
      observation: { attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false },
      bedrockConstructor: BedrockRuntimeClient,
    } as unknown as InstalledTransportObservation
    const makeRuntime = (catalogFor: (provider: string) => string, copilotBase: string) => {
      const state = { events: [] as string[], registrationCount: 0, streamCount: 0 }
      const runtime: HostPiRuntime = {
        bindings: {
          getModels: (provider: string) => {
            state.events.push(`getModels:${provider}`)
            const baseUrl = catalogFor(provider)
            return baseUrl === '' ? [] : [{ id: 'good-model', baseUrl }]
          },
          getGitHubCopilotBaseUrl: () => {
            state.events.push('copilot-derived')
            return copilotBase
          },
          bedrockProviderModule: { marker: 'bedrock-module' },
          setBedrockProviderModule: () => state.events.push('registered'),
          streamSimple: () => state.events.push('binding-stream-simple'),
        },
        events: state.events,
        registrationCount: state.registrationCount,
        streamCount: state.streamCount,
      }
      return { runtime, state }
    }
    const apiKey = { type: 'api_key', value: 'test-key' }
    const contextFor = (routeWithModel: Record<string, unknown>, credential: Record<string, unknown>): HostPiStreamContext => {
      const model = typeof routeWithModel.model === 'string' ? routeWithModel.model : undefined
      const { model: _ignored, ...route } = routeWithModel
      void _ignored
      return {
        request: mustValidate(request({ route, ...(model !== undefined ? { model } : {}), credential })),
        credential: credential as ValidatedHostRequest['credential'],
        observation,
        systemPrompt: 'sys', userPrompt: 'hello', maxOutputTokens: 64, apiKey: 'test-key',
        signal: new AbortController().signal, timeoutRemainingMs: 1000,
      }
    }
    const missRuntime = makeRuntime((provider) => (provider === 'anthropic' ? 'https://api.example.com/' : ''), '')
    const missStart = await startHostPiStream(missRuntime.runtime, contextFor({ kind: 'catalog', provider: 'unknown-provider', transportBaseUrl: 'https://api.example.com/' }, apiKey))
    expect(missStart).toEqual({ ok: false, failure: 'catalog_model_missing' })
    expect(missRuntime.runtime).toMatchObject({ registrationCount: 0, streamCount: 0 })
    // Ordinary catalog href drift: model hit, anchor mismatch, zero registration.
    const drift = makeRuntime(() => 'https://other.example.com/', '')
    const driftStart = await startHostPiStream(drift.runtime, contextFor({ kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.example.com/', model: 'pi/good-model' } as Record<string, unknown>, apiKey))
    expect(driftStart).toEqual({ ok: false, failure: 'invalid_worker_message' })
    expect(drift.runtime).toMatchObject({ registrationCount: 0, streamCount: 0 })
    // Copilot derived href mismatch: zero registration.
    const copilot = makeRuntime(() => 'https://api.example.com/', 'https://wrong.example.com/')
    const copilotStart = await startHostPiStream(copilot.runtime, contextFor({ kind: 'catalog', provider: 'github-copilot', transportBaseUrl: 'https://api.example.com/', model: 'pi/good-model' } as Record<string, unknown>, { type: 'oauth_access', value: 'token' }))
    expect(copilotStart).toEqual({ ok: false, failure: 'invalid_worker_message' })
    expect(copilot.runtime).toMatchObject({ registrationCount: 0, streamCount: 0 })
    // Bedrock endpoint mismatch (real zero-I/O SDK resolver against the anchor): zero registration.
    const bedrock = makeRuntime(() => 'https://api.example.com/', '')
    const bedrockStart = await startHostPiStream(bedrock.runtime, contextFor({ kind: 'catalog', provider: 'amazon-bedrock', transportBaseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com/' }, { type: 'iam', accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' }))
    expect(bedrockStart).toEqual({ ok: false, failure: 'invalid_worker_message' })
    expect(bedrock.runtime).toMatchObject({ registrationCount: 0, streamCount: 0 })
  })

  it('runs the production registration seam: legal routes construct the model, register once and stream once', async () => {
    const observation = {
      observation: { attempts: 0, networkFailure: false, retryBlocked: false, sdkException: false },
      bedrockConstructor: BedrockRuntimeClient,
    } as unknown as InstalledTransportObservation
    const makeRuntime = () => {
      const state = { events: [] as string[], registrationCount: 0, streamCount: 0, capturedModels: [] as Array<Record<string, unknown>>, capturedOptions: [] as Array<Record<string, unknown>> }
      const runtime: HostPiRuntime = {
        bindings: {
          getModels: (provider: string) => {
            state.events.push(`getModels:${provider}`)
            return [{ id: 'good-model', baseUrl: 'https://api.example.com/' }]
          },
          getGitHubCopilotBaseUrl: () => 'https://api.example.com/',
          bedrockProviderModule: { marker: 'bedrock-module' },
          setBedrockProviderModule: (module: unknown) => {
            // The seam owns the events array and the counters; this spy only captures the module.
            state.registrationCount += 1
            expect(module).toBe(runtime.bindings.bedrockProviderModule)
          },
          streamSimple: (model: unknown, streamContext: unknown, options: Record<string, unknown>) => {
            state.capturedModels.push(model as Record<string, unknown>)
            state.capturedOptions.push(options)
            return (async function* generate() { yield 'event' })()
          },
        },
        events: state.events,
        registrationCount: state.registrationCount,
        streamCount: state.streamCount,
      }
      return { runtime, state }
    }
    const apiKey = { type: 'api_key', value: 'test-key' }
    // Legal custom route: model-constructed -> registered -> stream-started, each exactly once.
    const custom = makeRuntime()
    const customStart = await startHostPiStream(custom.runtime, {
      request: mustValidate(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'https://api.example.com/' }, model: 'custom-model', credential: apiKey })),
      credential: apiKey as ValidatedHostRequest['credential'],
      observation,
      systemPrompt: 'sys', userPrompt: 'hello', maxOutputTokens: 64, apiKey: 'test-key',
      signal: new AbortController().signal, timeoutRemainingMs: 1000,
    })
    expect(customStart.ok).toBe(true)
    expect(custom.state.events).toEqual(['model-constructed', 'registered', 'stream-started'])
    expect(custom.runtime.registrationCount).toBe(1)
    expect(custom.runtime.streamCount).toBe(1)
    expect(custom.state.capturedModels[0]).toMatchObject({ id: 'custom-model', provider: 'openai', api: 'openai-completions', baseUrl: 'https://api.example.com/' })
    expect(custom.state.capturedOptions[0]).toMatchObject({ apiKey: 'test-key', maxTokens: 64, maxRetries: 0 })
    // Legal catalog route: same single registration and single stream start.
    const catalog = makeRuntime()
    const catalogStart = await startHostPiStream(catalog.runtime, {
      request: mustValidate(request({ route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.example.com/' }, model: 'pi/good-model', credential: apiKey })),
      credential: apiKey as ValidatedHostRequest['credential'],
      observation,
      systemPrompt: '', userPrompt: 'hello', maxOutputTokens: 64, apiKey: 'test-key',
      signal: new AbortController().signal, timeoutRemainingMs: 1000,
    })
    expect(catalogStart.ok).toBe(true)
    expect(catalog.state.events).toEqual(['getModels:anthropic', 'model-constructed', 'registered', 'stream-started'])
    expect(catalog.runtime.registrationCount).toBe(1)
    expect(catalog.runtime.streamCount).toBe(1)
    expect(catalog.state.capturedModels[0]).toMatchObject({ id: 'good-model', baseUrl: 'https://api.example.com/' })
    // Legal Bedrock route: real zero-I/O SDK endpoint resolution matches the anchor, registers once.
    const bedrock = makeRuntime()
    const bedrockStart = await startHostPiStream(bedrock.runtime, {
      request: mustValidate(request({ route: { kind: 'catalog', provider: 'amazon-bedrock', transportBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/' }, model: 'pi/good-model', credential: { type: 'iam', accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' } })),
      credential: { type: 'iam', accessKeyId: 'AKIA', secretAccessKey: 's', region: 'us-east-1' } as ValidatedHostRequest['credential'],
      observation,
      systemPrompt: '', userPrompt: 'hello', maxOutputTokens: 64, apiKey: undefined,
      signal: new AbortController().signal, timeoutRemainingMs: 1000,
    })
    expect(bedrockStart.ok).toBe(true)
    expect(bedrock.state.events).toEqual(['getModels:amazon-bedrock', 'model-constructed', 'registered', 'stream-started'])
    expect(bedrock.runtime.registrationCount).toBe(1)
    expect(bedrock.runtime.streamCount).toBe(1)
  })

  it('keeps ambient credential canaries out of stdout, stderr, and the wire authorization', async () => {
    const mock = await startMockSse({ chunks: textChunks('test-model', 'ok', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' }, prompt: `hello ${CANARY}` }), { ambient: { OPENAI_API_KEY: 'ambient-canary-secret', ANTHROPIC_API_KEY: 'anthropic-canary-secret' } })
      expect(parseSingleResult(outcome.stdout).status).toBe('completed')
      expect(mock.requests()[0].authorization).toBe('Bearer not-needed')
      expect(outcome.stdout).not.toContain('ambient-canary-secret')
      expect(outcome.stderr).not.toContain('ambient-canary-secret')
      expect(outcome.stderr).not.toContain(CANARY)
    } finally {
      mock.close()
    }
  }, 60000)

  it('runs the anthropic-messages adapter keylessly on loopback with the fixed placeholder and worker-owned json constraint', async () => {
    const anthropicSse = (model: string, text: string, input: number, output: number): string[] => [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: input, output_tokens: output } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]
    const mock = await startMockSse({ rawEvents: anthropicSse('test-anthropic-model', '{"ok":true}', 5, 3), doneSentinel: false })
    try {
      const outcome = await runWorker(request({
        route: { kind: 'custom', provider: 'anthropic', api: 'anthropic-messages', baseUrl: mock.url },
        model: 'test-anthropic-model', credential: { type: 'none' }, systemPrompt: 'Base.', responseFormat: 'json_object',
      }))
      expect(outcome.code).toBe(0)
      const result = parseSingleResult(outcome.stdout)
      expect(result).toMatchObject({ requestId: 'req-1', model: 'test-anthropic-model', status: 'completed', text: '{"ok":true}' })
      expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 8, reportedModel: 'test-anthropic-model', terminalReason: 'stop', provenance: 'provider_final' })
      expect(mock.hits()).toHaveLength(1)
      const sent = mock.requests()[0]
      expect(sent.url).toBe('/v1/messages')
      expect(sent.authorization).toBeNull()
      expect(JSON.parse(sent.body)).toMatchObject({ model: 'test-anthropic-model', max_tokens: 64, system: [{ type: 'text', text: `Base.\n\n${JSON_OBJECT_SYSTEM_CONSTRAINT}` }] })
    } finally {
      mock.close()
    }
  }, 60000)

  it('returns partial for done(length) and keeps the provider-final terminalReason', async () => {
    const mock = await startMockSse({ chunks: [
      { id: 'c1', model: 'test-model', choices: [{ delta: { role: 'assistant' } }] },
      { id: 'c1', model: 'test-model', choices: [{ delta: { content: 'truncated' } }] },
      { id: 'c1', model: 'test-model', choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 64, total_tokens: 67 } },
    ] })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' }, maxOutputTokens: 64 }))
      const result = parseSingleResult(outcome.stdout)
      expect(result).toMatchObject({ status: 'partial', text: 'truncated' })
      expect(result.usage).toMatchObject({ outputTokens: 64, terminalReason: 'length' })
    } finally {
      mock.close()
    }
  }, 60000)

  it('maps an IPv6 loopback transport failure to provider_request_failed without leaking the target', async () => {
    const outcome = await runWorker(request({
      route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'http://[::1]:9/' },
      model: 'test-model', credential: { type: 'none' },
    }))
    expect(outcome.code).toBe(0)
    expect(parseSingleResult(outcome.stdout).error).toMatchObject({ code: 'provider_failed', reason: 'provider_request_failed' })
  }, 60000)

  it('maps over-limit request fields to result_too_large at and below the 2MiB framing bound, and rejects trailing bytes after the LF', async () => {
    const base = JSON.stringify(request({}))
    const pad = 2_097_151 - base.length + 5
    const exact = await runWorker(request({ prompt: 'x'.repeat(pad) }))
    expect(Buffer.byteLength(JSON.stringify(request({ prompt: 'x'.repeat(pad) }))) + 1).toBe(2_097_152)
    expect(parseSingleResult(exact.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'result_too_large', message: 'Host LLM worker result exceeds the wire limit' })
    const fieldBound = await runWorker(request({ prompt: 'x'.repeat(1_048_577) }))
    expect(parseSingleResult(fieldBound.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'result_too_large' })
    const trailing = await runWorker(request({}), { raw: JSON.stringify(request({})) + '\n' + 'x' })
    expect(parseSingleResult(trailing.stdout).error).toMatchObject({ reason: 'invalid_worker_message' })
  }, 60000)

  it('fails github-copilot wire anchors that disagree with the token-derived base URL before any transport', async () => {
    const defaultToken = await runWorker(request({
      route: { kind: 'catalog', provider: 'github-copilot', transportBaseUrl: 'https://api.githubcopilot.com/' },
      model: 'pi/claude-haiku-4.5', credential: { type: 'oauth_access', value: 'tid=1;exp=2;' },
    }))
    expect(parseSingleResult(defaultToken.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'invalid_worker_message' })
    const proxyToken = await runWorker(request({
      route: { kind: 'catalog', provider: 'github-copilot', transportBaseUrl: 'https://api.individual.githubcopilot.com/' },
      model: 'pi/claude-haiku-4.5', credential: { type: 'oauth_access', value: 'tid=1;exp=2;proxy-ep=proxy.foo.githubcopilot.com;' },
    }))
    expect(parseSingleResult(proxyToken.stdout).error).toMatchObject({ code: 'provider_protocol_error', reason: 'invalid_worker_message' })
  }, 120000)

  it('fails closed on a mid-stream connection loss without releasing partial text', async () => {
    const mock = await startMockSse({ rawEvents: [`data: ${JSON.stringify({ id: 'c1', model: 'test-model', choices: [{ delta: { role: 'assistant' } }] })}\n\n`], halfThenDropMs: 150 })
    try {
      const outcome = await runWorker(request({ route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: mock.url }, model: 'test-model', credential: { type: 'none' } }))
      const result = parseSingleResult(outcome.stdout)
      expect(result.status).toBe('failed')
      expect(result.error).toMatchObject({ code: 'provider_failed' })
      expect(result.text).toBeUndefined()
    } finally {
      mock.close()
    }
  }, 60000)

  it('exits 1 only when the single result cannot be delivered on stdout', async () => {
    const outcome = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [ENTRY, HOST_FLAG], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stdout.destroy()
      setTimeout(() => child.stdin.end(JSON.stringify(request({})) + '\n'), 150)
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 30000)
      child.on('close', (code) => { clearTimeout(killTimer); resolve({ code, stdout }) })
    })
    expect(outcome.stdout).toBe('')
    expect(outcome.code).toBe(1)
  }, 45000)
})
