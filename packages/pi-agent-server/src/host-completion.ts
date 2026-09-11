import { stripPiPrefix, buildCustomEndpointModelDef } from './custom-endpoint-models.ts'
import { canonicalTransportHref, failureResult, serializeHostResult, validateHostRequest, writeHostResultLine, type HostCompletionResultV1, type HostFailureKind, type HostWorkerCredential, type ValidatedHostRequest } from './host-completion-protocol.ts'
import { classifyTransportFailure, type InstalledTransportObservation } from './host-completion-policy.ts'

const REQUEST_BYTE_LIMIT = 2_097_152
export const JSON_OBJECT_SYSTEM_CONSTRAINT = 'Respond with exactly one JSON object and no surrounding text, Markdown, or code fences.'
export const codexStreamExtras = (maxOutputTokens: number): { transport: 'sse'; onPayload: (payload: unknown) => Record<string, unknown> } => ({ transport: 'sse', onPayload: (payload) => ({ ...(payload as Record<string, unknown>), max_output_tokens: maxOutputTokens }) })
const API_KEY_CATALOG_PROVIDERS = new Set(['anthropic', 'google', 'openai', 'cerebras', 'deepseek', 'fireworks', 'groq', 'huggingface', 'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn', 'opencode', 'opencode-go', 'openrouter', 'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai'])
const OAUTH_CATALOG_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot'])
export const SANITIZED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'ZAI_API_KEY', 'MISTRAL_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MOONSHOT_API_KEY', 'HF_TOKEN', 'FIREWORKS_API_KEY', 'OPENCODE_API_KEY', 'KIMI_API_KEY', 'CLOUDFLARE_API_KEY', 'XIAOMI_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_SKIP_AUTH', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_USE_FIPS_ENDPOINT', 'AWS_USE_DUALSTACK_ENDPOINT', 'AWS_MAX_ATTEMPTS', 'AWS_EC2_METADATA_DISABLED', 'AWS_BEDROCK_FORCE_HTTP1', 'AWS_SDK_LOAD_CONFIG', 'AWS_RETRY_MODE', 'AWS_CA_BUNDLE', 'AWS_STS_REGIONAL_ENDPOINTS']
export const sanitizeEnvironment = (): void => { for (const key of SANITIZED_ENV_KEYS) delete process.env[key] }
export const isLoopback = (href: string): boolean => ['localhost', '127.0.0.1', '::1'].includes(new URL(href).hostname.replace(/^\[(.+)\]$/, '$1'))
const canonicalOf = (value: string): string | null => { try { return new URL(value).href } catch { return null } }
interface BedrockClientLike { config: { endpointProvider?: unknown }; destroy(): void }
export function checkDescriptor(request: ValidatedHostRequest): boolean {
  const credential = request.credential
  if (request.routeKind === 'catalog') {
    if (credential.type === 'api_key') return API_KEY_CATALOG_PROVIDERS.has(request.provider)
    if (credential.type === 'oauth_access') return OAUTH_CATALOG_PROVIDERS.has(request.provider)
    return credential.type === 'iam' && request.provider === 'amazon-bedrock' && credential.region.length > 0
  }
  const loopback = isLoopback(request.transportHref)
  if (credential.type === 'api_key') return request.transportHref.startsWith('https:') || loopback
  return credential.type === 'none' && loopback
}
async function resolveBedrockEndpointHref(constructor: new (config: any) => BedrockClientLike, credential: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string }): Promise<string | null> {
  let client: BedrockClientLike | null = null
  try {
    const instance = client = new constructor({ region: credential.region, maxAttempts: 1, useFipsEndpoint: false, useDualstackEndpoint: false, credentials: { accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey, ...(credential.sessionToken !== undefined ? { sessionToken: credential.sessionToken } : {}) } })
    const endpointProvider = instance.config.endpointProvider as ((params: { Region: string; UseFIPS: boolean; UseDualStack: boolean }) => { url: { href: string } | string } | PromiseLike<{ url: { href: string } | string }>) | undefined
    if (typeof endpointProvider !== 'function') return null
    const resolved = await endpointProvider({ Region: credential.region, UseFIPS: false, UseDualStack: false })
    return canonicalOf(typeof resolved.url === 'string' ? resolved.url : resolved.url.href)
  } catch {
    return null
  } finally {
    client?.destroy()
  }
}
// Production-used route/model preparation and Pi registration orchestration (R12 §6.8). Tests
// import this exact function and inject spy bindings; production wires the sealed pi-ai module
// functions into the same shape. Fixed order: Bedrock endpoint comparison → exact catalog hit or
// custom model construction → Copilot/ordinary catalog href comparison → setBedrockProviderModule
// exactly once → streamSimple exactly once. Every failure before registration leaves
// registrationCount=0 and streamCount=0.
export interface HostPiBindings {
  getModels: (provider: string) => Array<Record<string, any>>
  getGitHubCopilotBaseUrl: (token: string) => string
  bedrockProviderModule: unknown
  setBedrockProviderModule: (module: unknown) => void
  streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>
}
export interface HostPiRuntime {
  bindings: HostPiBindings
  events: string[]
  registrationCount: number
  streamCount: number
}
export interface HostPiStreamContext {
  request: ValidatedHostRequest
  credential: HostWorkerCredential
  observation: InstalledTransportObservation
  systemPrompt: string
  userPrompt: string
  maxOutputTokens: number
  apiKey: string | undefined
  signal: AbortSignal
  timeoutRemainingMs: number
  // Production wires this to `settled || controller.signal.aborted`. Every await in the seam and
  // every step before model construction / registration / stream consults it, so a deadline or
  // abort that wins during an await keeps Pi imports, registration, streaming and transport at 0
  // (R12 §6.8, Review R4 issue 1).
  shouldStop: () => boolean
}
export type HostPiStreamStart =
  | { ok: true; stream: AsyncIterable<unknown> }
  | { ok: false; failure: HostFailureKind; stopped?: true }
// Fixed order: Bedrock zero-I/O endpoint comparison → Pi bindings load (dynamic imports) → exact
// catalog hit or custom construction → href comparisons → setBedrockProviderModule once →
// streamSimple once. The resolver runs BEFORE the provider imports; the stop probe is consulted
// after every await and before model construction, registration and streaming.
export async function startHostPiStream(loadRuntime: () => Promise<HostPiRuntime | null>, context: HostPiStreamContext): Promise<HostPiStreamStart> {
  const { request, credential, observation } = context
  if (request.routeKind === 'catalog' && request.provider === 'amazon-bedrock' && credential.type === 'iam') {
    const resolvedEndpoint = await resolveBedrockEndpointHref(observation.bedrockConstructor as unknown as new (config: any) => BedrockClientLike, credential)
    if (resolvedEndpoint !== request.transportHref) return { ok: false, failure: 'invalid_worker_message' }
  }
  if (context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  const runtime = await loadRuntime()
  if (runtime === null || context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  let model: Record<string, any>
  const bareId = stripPiPrefix(request.model)
  if (request.routeKind === 'custom') {
    model = { ...buildCustomEndpointModelDef(bareId), id: bareId, name: bareId, provider: request.provider, api: request.api, baseUrl: request.transportHref }
  } else {
    const hit = runtime.bindings.getModels(request.provider).find((entry) => entry.id === bareId)
    if (hit === undefined) return { ok: false, failure: 'catalog_model_missing' }
    model = { ...hit }
    if (request.provider === 'github-copilot' && credential.type === 'oauth_access') {
      const derived = canonicalTransportHref(runtime.bindings.getGitHubCopilotBaseUrl(credential.value))
      if (derived === null || derived !== request.transportHref) return { ok: false, failure: 'invalid_worker_message' }
      model.baseUrl = derived
    } else if (request.provider !== 'amazon-bedrock') {
      const canonical = canonicalOf(model.baseUrl)
      if (canonical === null || canonical !== request.transportHref) return { ok: false, failure: 'invalid_worker_message' }
    }
    if (request.provider === 'minimax-cn') model.id = model.id.replace(/^MiniMax-/, '')
  }
  if (context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  runtime.events.push('model-constructed')
  if (context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  runtime.registrationCount += 1
  runtime.events.push('registered')
  runtime.bindings.setBedrockProviderModule(runtime.bindings.bedrockProviderModule)
  if (context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  const composedSystem = request.responseFormat === 'json_object' ? (context.systemPrompt ? `${context.systemPrompt}\n\n${JSON_OBJECT_SYSTEM_CONSTRAINT}` : JSON_OBJECT_SYSTEM_CONSTRAINT) : context.systemPrompt
  if (context.shouldStop()) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  runtime.streamCount += 1
  runtime.events.push('stream-started')
  const stream = runtime.bindings.streamSimple(model, {
    systemPrompt: composedSystem,
    messages: [{ role: 'user', content: context.userPrompt, timestamp: Date.now() }],
  }, {
    apiKey: context.apiKey, maxTokens: context.maxOutputTokens, maxRetries: 0, signal: context.signal, timeoutMs: context.timeoutRemainingMs,
    ...(request.routeKind === 'catalog' && request.provider === 'openai-codex' ? codexStreamExtras(context.maxOutputTokens) : {}),
  })
  return { ok: true, stream }
}
async function readRequestThroughEof(armDeadline: (line: string, firstByteAt: number) => void): Promise<{ ok: true; line: string; firstByteAt: number } | { ok: false; oversize: boolean }> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', bytes = 0, firstByteAt = 0, announced = false
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    firstByteAt ||= Date.now(); bytes += chunk.length
    if (bytes > REQUEST_BYTE_LIMIT) return { ok: false, oversize: true }
    try { buffer += decoder.decode(chunk, { stream: true }) } catch { return { ok: false, oversize: false } }
    const newline = buffer.indexOf('\n')
    if (!announced && newline > 0) { announced = true; armDeadline(buffer.slice(0, newline), firstByteAt) }
  }
  try { buffer += decoder.decode() } catch { return { ok: false, oversize: false } }
  const newline = buffer.indexOf('\n')
  if (newline <= 0 || newline !== buffer.length - 1) return { ok: false, oversize: false }
  return { ok: true, line: buffer.slice(0, newline), firstByteAt }
}
export async function runHostCompletion(argvInvalid = false): Promise<void> {
  let settled = false, activeRequestId = 'invalid', activeModel = 'invalid', timer: NodeJS.Timeout | null = null, installed: InstalledTransportObservation | null = null, deadlineAt = Number.MAX_SAFE_INTEGER
  const controller = new AbortController()
  let settlePromise = Promise.resolve(true)
  const settle = (result: HostCompletionResultV1): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    controller.abort()
    process.stdin.destroy()
    settlePromise = writeHostResultLine(serializeHostResult(result)).then((flushed) => { process.exitCode = flushed ? 0 : 1; return flushed })
  }
  const failWith = (kind: HostFailureKind): void => settle(failureResult(activeRequestId, activeModel, kind))
  const crash = (): void => failWith('provider_error_terminal'); process.on('uncaughtException', crash); process.on('unhandledRejection', crash)
  const armDeadline = (line: string, firstByteAt: number): void => {
    try {
      const timeout = (JSON.parse(line) as { timeoutMs?: unknown }).timeoutMs
      if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 100 && timeout <= 600_000) {
        deadlineAt = firstByteAt + timeout
        timer = setTimeout(() => failWith('deadline_exceeded'), Math.max(0, deadlineAt - Date.now()))
      }
    } catch {
      // framing gate owns the post-EOF failure
    }
  }
  if (argvInvalid) return failWith('invalid_worker_message')
  try {
    const read = await readRequestThroughEof(armDeadline)
    if (!read.ok) return failWith(read.oversize ? 'result_too_large' : 'invalid_worker_message')
    let parsed: unknown
    try { parsed = JSON.parse(read.line) } catch { return failWith('invalid_worker_message') }
    const parsedRequest = validateHostRequest(parsed)
    if (parsedRequest.kind !== 'valid') return failWith(parsedRequest.kind === 'oversize' ? 'result_too_large' : 'invalid_worker_message')
    const request = parsedRequest.request
    activeRequestId = request.requestId; activeModel = request.model
    if (settled) return
    const credential = request.credential
    const isBedrock = request.routeKind === 'catalog' && request.provider === 'amazon-bedrock'
    sanitizeEnvironment(); if (!checkDescriptor(request)) return failWith('invalid_worker_message')
    if (isBedrock && credential.type === 'iam') { for (const [key, value] of Object.entries({ AWS_ACCESS_KEY_ID: credential.accessKeyId, AWS_SECRET_ACCESS_KEY: credential.secretAccessKey, ...(credential.sessionToken !== undefined ? { AWS_SESSION_TOKEN: credential.sessionToken } : {}), AWS_REGION: credential.region, AWS_DEFAULT_REGION: credential.region, AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_BEDROCK_FORCE_HTTP1: '1', AWS_USE_FIPS_ENDPOINT: 'false', AWS_USE_DUALSTACK_ENDPOINT: 'false' })) process.env[key] = value }
    const [policy, streamModule] = await Promise.all([import('./host-completion-policy.ts'), import('./host-completion-stream.ts')])
    if (settled) return
    installed = policy.installTransportObservation(new URL(request.transportHref))
    // The provider modules load only AFTER the Bedrock zero-I/O endpoint comparison passed inside
    // startHostPiStream, so a deadline that wins during the resolver await keeps imports, Pi
    // registration, streaming and transport at zero (Review R4 issue 1).
    const loadRuntime = async (): Promise<HostPiRuntime | null> => {
      const [piAi, bedrockProviderModule, oauth] = await Promise.all([import('@mariozechner/pi-ai'), import('@mariozechner/pi-ai/bedrock-provider'),
        request.routeKind === 'catalog' && request.provider === 'github-copilot' ? import('@mariozechner/pi-ai/oauth') : Promise.resolve(null)])
      if (settled) return null
      const runtime: HostPiRuntime = {
      bindings: {
        getModels: (provider: string): Array<Record<string, any>> => (piAi.getModels as unknown as (provider: string) => Array<Record<string, any>>)(provider),
        getGitHubCopilotBaseUrl: (token: string): string => {
          if (oauth === null) throw new Error('host pi binding unavailable')
          return oauth.getGitHubCopilotBaseUrl(token)
        },
        bedrockProviderModule: bedrockProviderModule.bedrockProviderModule,
        setBedrockProviderModule: (module: unknown): void => {
          piAi.setBedrockProviderModule(module as Parameters<typeof piAi.setBedrockProviderModule>[0])
        },
        streamSimple: piAi.streamSimple as unknown as HostPiBindings['streamSimple'],
      },
      events: [],
      registrationCount: 0,
      streamCount: 0,
      }
      return runtime
    }
    const apiKey = credential.type === 'api_key' || credential.type === 'oauth_access' ? credential.value : credential.type === 'none' ? 'not-needed' : undefined
    // The tracker's expected response model must equal the SENT clone id the seam constructs:
    // bare id, plus one stripped MiniMax- prefix for the minimax-cn catalog route.
    const expectedModel = request.provider === 'minimax-cn' ? stripPiPrefix(request.model).replace(/^MiniMax-/, '') : stripPiPrefix(request.model)
    const tracker = streamModule.createHostStreamTracker({ expectedModel, maxOutputTokens: request.maxOutputTokens, jsonOutput: request.responseFormat === 'json_object', bedrock: isBedrock, claim: (kind) => failWith(kind) })
    const started = await startHostPiStream(loadRuntime, {
      request, credential, observation: installed, systemPrompt: request.systemPrompt, userPrompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens, apiKey, signal: controller.signal,
      timeoutRemainingMs: Math.max(1, deadlineAt - Date.now()),
      shouldStop: () => settled || controller.signal.aborted,
    })
    if (settled) return
    if (!started.ok) {
      if (started.stopped === true) return
      return failWith(started.failure)
    }
    try {
      for await (const event of started.stream as AsyncIterable<import('@mariozechner/pi-ai').AssistantMessageEvent>) { tracker.onEvent(event); if (settled) break }
    } catch {
      if (!settled) failWith(installed ? (classifyTransportFailure(installed.observation, { deadlineExpired: false, providerFailed: true }) ?? 'provider_error_terminal') : 'provider_error_terminal')
    }
    if (!settled) {
      const verdict = tracker.finish(installed.observation, Date.now() >= deadlineAt)
      if (verdict.kind === 'release') settle({ type: 'host_completion_result', version: 1, requestId: request.requestId, model: request.model, status: verdict.status, text: verdict.text, usage: verdict.usage })
      else settle(failureResult(request.requestId, request.model, verdict.failure, verdict.usage))
    }
  } catch {
    if (!settled) failWith('provider_error_terminal')
  }
  await settlePromise
}
