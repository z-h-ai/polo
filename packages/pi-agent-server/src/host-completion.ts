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
// Production-used route/model preparation, Pi registration and stream orchestration (R14 §3.2):
// three named phases with injectable bindings/importers. Tests import these exact functions and
// inject spies; production wires the sealed pi-ai module functions into the same shape.
export type HostPiImportStage = 'piAi' | 'bedrock' | 'oauth'
export type HostPiProbeStage =
  | 'route:after-await'
  | `import:${HostPiImportStage}:before`
  | `import:${HostPiImportStage}:after`
  | 'start:before-model'
  | 'start:before-register'
  | 'start:before-stream'
export interface HostPiModule {
  getModels: (provider: string) => Array<Record<string, any>>
  setBedrockProviderModule: (module: unknown) => void
  streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>
}
export interface HostPiBindings {
  module: HostPiModule
  bedrockProviderModule: unknown
  getGitHubCopilotBaseUrl: (token: string) => string
  setBedrockProviderModule: (module: unknown) => void
  streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>
}
export interface HostPiRuntime {
  bindings: HostPiBindings
  events: string[]
  registrationCount: number
  streamCount: number
}
export interface HostPiImporters {
  importPiAi: () => Promise<HostPiModule>
  importBedrockProvider: () => Promise<{ bedrockProviderModule: unknown }>
  importCopilotOAuth: () => Promise<{ getGitHubCopilotBaseUrl: (token: string) => string }>
}
export interface HostPiPhaseContext {
  request: ValidatedHostRequest
  credential: HostWorkerCredential
  observation: InstalledTransportObservation
  shouldStop: (stage: HostPiProbeStage) => boolean
}
export interface HostPiStreamInputs {
  systemPrompt: string
  userPrompt: string
  maxOutputTokens: number
  apiKey: string | undefined
  signal: AbortSignal
  timeoutRemainingMs: number
}
export type HostPiRoutePreparation = { ok: true } | { ok: false; failure: HostFailureKind; stopped?: true }
export type HostPiRuntimePreparation = { ok: true; runtime: HostPiRuntime } | { ok: false; failure: HostFailureKind; stopped?: true }
export type HostPiStreamStart = { ok: true; stream: AsyncIterable<unknown>; expectedModel: string } | { ok: false; failure: HostFailureKind; stopped?: true }
const stoppedResult = (budget: 'deadline_exceeded'): HostPiRoutePreparation => ({ ok: false, failure: budget, stopped: true })
// Phase 1: Bedrock zero-I/O endpoint resolution and exact anchor comparison. The FIRST semantic
// operation after the resolver await is the shouldStop probe — endpoint inspection, comparison
// and classification all obey deadline precedence (R14 §3.2).
export async function resolveHostPiRoute(context: HostPiPhaseContext): Promise<HostPiRoutePreparation> {
  const { request, credential, observation } = context
  if (request.routeKind === 'catalog' && request.provider === 'amazon-bedrock' && credential.type === 'iam') {
    const resolvedEndpoint = await resolveBedrockEndpointHref(observation.bedrockConstructor as unknown as new (config: any) => BedrockClientLike, credential)
    if (context.shouldStop('route:after-await')) return stoppedResult('deadline_exceeded')
    if (resolvedEndpoint !== request.transportHref) return { ok: false, failure: 'invalid_worker_message' }
  }
  return { ok: true }
}
// Phase 2: provider module loading in the fixed order pi-ai → bedrock-provider → optional Copilot
// oauth. Every import dispatch is preceded by a stop probe; after settle or after an exception the
// probe is the first semantic operation again. A deadline that wins inside import N keeps the
// already-started prefix; import N+1 and everything downstream stay at zero (R14 §3.2).
export async function loadHostPiRuntime(importers: HostPiImporters, context: HostPiPhaseContext): Promise<HostPiRuntimePreparation> {
  const { request, credential } = context
  if (context.shouldStop('import:piAi:before')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  let piAi: HostPiModule
  try {
    piAi = await importers.importPiAi()
  } catch (error) {
    if (context.shouldStop('import:piAi:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
    throw error
  }
  if (context.shouldStop('import:piAi:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  if (context.shouldStop('import:bedrock:before')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  let bedrockModule: { bedrockProviderModule: unknown }
  try {
    bedrockModule = await importers.importBedrockProvider()
  } catch (error) {
    if (context.shouldStop('import:bedrock:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
    throw error
  }
  if (context.shouldStop('import:bedrock:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  let copilot: { getGitHubCopilotBaseUrl: (token: string) => string } | null = null
  if (request.routeKind === 'catalog' && request.provider === 'github-copilot' && credential.type === 'oauth_access') {
    if (context.shouldStop('import:oauth:before')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
    try {
      copilot = await importers.importCopilotOAuth()
    } catch (error) {
      if (context.shouldStop('import:oauth:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
      throw error
    }
    if (context.shouldStop('import:oauth:after')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  }
  const module = piAi
  const runtime: HostPiRuntime = {
    bindings: {
      module,
      bedrockProviderModule: bedrockModule.bedrockProviderModule,
      getGitHubCopilotBaseUrl: (token: string): string => {
        if (copilot === null) throw new Error('host pi binding unavailable')
        return copilot.getGitHubCopilotBaseUrl(token)
      },
      setBedrockProviderModule: (providerModule: unknown): void => {
        module.setBedrockProviderModule(providerModule)
      },
      streamSimple: module.streamSimple,
    },
    events: [],
    registrationCount: 0,
    streamCount: 0,
  }
  return { ok: true, runtime }
}
// Phase 3 (synchronous): exact catalog hit or custom construction → Copilot/ordinary href
// comparison → setBedrockProviderModule exactly once → streamSimple exactly once, with stop
// probes before model, register and stream (R14 §3.2). Failures before registration leave zero
// registration and zero stream side effects.
export function startHostPiStream(runtime: HostPiRuntime, context: HostPiPhaseContext & HostPiStreamInputs): HostPiStreamStart {
  const { request, credential } = context
  if (context.shouldStop('start:before-model')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  let model: Record<string, any>
  const bareId = stripPiPrefix(request.model)
  if (request.routeKind === 'custom') {
    model = { ...buildCustomEndpointModelDef(bareId), id: bareId, name: bareId, provider: request.provider, api: request.api, baseUrl: request.transportHref }
  } else {
    const hit = runtime.bindings.module.getModels(request.provider).find((entry) => entry.id === bareId)
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
  runtime.events.push('model-constructed')
  if (context.shouldStop('start:before-register')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  runtime.registrationCount += 1
  runtime.events.push('registered')
  runtime.bindings.setBedrockProviderModule(runtime.bindings.bedrockProviderModule)
  if (context.shouldStop('start:before-stream')) return { ok: false, failure: 'deadline_exceeded', stopped: true }
  const composedSystem = request.responseFormat === 'json_object' ? (context.systemPrompt ? `${context.systemPrompt}\n\n${JSON_OBJECT_SYSTEM_CONSTRAINT}` : JSON_OBJECT_SYSTEM_CONSTRAINT) : context.systemPrompt
  runtime.streamCount += 1
  runtime.events.push('stream-started')
  const stream = runtime.bindings.streamSimple(model, {
    systemPrompt: composedSystem,
    messages: [{ role: 'user', content: context.userPrompt, timestamp: Date.now() }],
  }, {
    apiKey: context.apiKey, maxTokens: context.maxOutputTokens, maxRetries: 0, signal: context.signal, timeoutMs: context.timeoutRemainingMs,
    ...(request.routeKind === 'catalog' && request.provider === 'openai-codex' ? codexStreamExtras(context.maxOutputTokens) : {}),
  })
  return { ok: true, stream, expectedModel: model.id }
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
    // Named probe trace (R14 §4): bounded, wire-protocol-external, test-observable.
    const probeTrace: HostPiProbeStage[] = []
    const phaseShouldStop = (stage: HostPiProbeStage): boolean => {
      probeTrace.push(stage)
      return settled || controller.signal.aborted
    }
    const phaseContext: HostPiPhaseContext = { request, credential, observation: installed, shouldStop: phaseShouldStop }
    const route = await resolveHostPiRoute(phaseContext)
    if (settled) return
    if (!route.ok) {
      if (route.stopped === true) return
      return failWith(route.failure)
    }
    const runtimePreparation = await loadHostPiRuntime({
      importPiAi: async () => await import('@mariozechner/pi-ai') as unknown as HostPiModule,
      importBedrockProvider: async () => await import('@mariozechner/pi-ai/bedrock-provider'),
      importCopilotOAuth: async () => await import('@mariozechner/pi-ai/oauth') as unknown as { getGitHubCopilotBaseUrl: (token: string) => string },
    }, phaseContext)
    if (settled) return
    if (!runtimePreparation.ok) {
      if (runtimePreparation.stopped === true) return
      return failWith(runtimePreparation.failure)
    }
    const runtime = runtimePreparation.runtime
    const apiKey = credential.type === 'api_key' || credential.type === 'oauth_access' ? credential.value : credential.type === 'none' ? 'not-needed' : undefined
    // The tracker's expected response model must equal the SENT clone id the seam constructs:
    // bare id, plus one stripped MiniMax- prefix for the minimax-cn catalog route.
    const expectedModel = request.provider === 'minimax-cn' ? stripPiPrefix(request.model).replace(/^MiniMax-/, '') : stripPiPrefix(request.model)
    const tracker = streamModule.createHostStreamTracker({ expectedModel, maxOutputTokens: request.maxOutputTokens, jsonOutput: request.responseFormat === 'json_object', bedrock: isBedrock, claim: (kind) => failWith(kind) })
    const started = startHostPiStream(runtime, {
      ...phaseContext, systemPrompt: request.systemPrompt, userPrompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens, apiKey, signal: controller.signal,
      timeoutRemainingMs: Math.max(1, deadlineAt - Date.now()),
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
