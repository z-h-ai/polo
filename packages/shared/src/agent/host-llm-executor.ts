import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import {
  HOST_PARENT_MARKER, AGGREGATE_BYTE_LIMIT, MAX_OUTPUT_TOKENS_MAX, TIMEOUT_MS_MAX,
  validateWorkerResult, makePublicError, type HostLlmPublicResult, type HostLlmPublicUsage,
  type HostLlmExecuteInput, type HostLlmExecutorOptions, type SessionlessHostLlmExecutor,
  type HostLlmErrorCode, type HostLlmErrorReason, type WireResult, HostLlmConfigurationError,
} from './host-llm-contract.ts'
import {
  resolveExecutablePolicy, selectExactModel, readCredentialSnapshot, createHostDescriptor, computeFingerprint,
  type WireCredential, type HostSpawnDescriptor,
} from './backend/host-executor-factory.ts'
import { getLlmConnection } from '../config/storage.ts'
import { resolveBackendRuntimePaths } from './backend/internal/runtime-resolver.ts'
import type { BackendHostRuntimeContext } from './backend/types.ts'
export { HOST_PARENT_MARKER, HostLlmConfigurationError }
export type { HostLlmExecuteInput, HostLlmExecutorOptions, HostLlmPublicResult, HostLlmPublicUsage, HostLlmErrorCode, HostLlmErrorReason, SessionlessHostLlmExecutor, BackendHostRuntimeContext }

const PROMPT_LIMIT = 1_048_576, SYSTEM_LIMIT = 524_288, STDOUT_LIMIT = 4 * 1024 * 1024, CLOSE_GRACE_MS = 250

function validateExecuteInput(input: HostLlmExecuteInput, m: string): HostLlmPublicResult | null {
  if (typeof input.prompt !== 'string' || !input.prompt || Buffer.byteLength(input.prompt, 'utf8') > PROMPT_LIMIT) return makePublicError('invalid_request', 'invalid_input', '', m)
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > MAX_OUTPUT_TOKENS_MAX) return makePublicError('invalid_request', 'invalid_input', '', m)
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > TIMEOUT_MS_MAX) return makePublicError('invalid_request', 'invalid_input', '', m)
  if (input.responseFormat !== undefined && input.responseFormat !== 'text' && input.responseFormat !== 'json_object') return makePublicError('invalid_request', 'invalid_input', '', m)
  if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || Buffer.byteLength(input.systemPrompt, 'utf8') > SYSTEM_LIMIT)) return makePublicError('invalid_request', 'invalid_input', '', m)
  return null
}

function encodeRequestLine(requestId: string, model: string, input: HostLlmExecuteInput, route: HostSpawnDescriptor['wireRoute'], cred: WireCredential): { ok: true; line: string } | { ok: false } {
  const w: Record<string, unknown> = { type: 'host_completion', version: 1, parentValidation: HOST_PARENT_MARKER, requestId, model, route, prompt: input.prompt, maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, responseFormat: input.responseFormat ?? 'text', credential: cred }
  if (input.systemPrompt) w['systemPrompt'] = input.systemPrompt
  const line = JSON.stringify(w)
  return Buffer.byteLength(line, 'utf8') > AGGREGATE_BYTE_LIMIT ? { ok: false } : { ok: true, line }
}

function toPublicResult(wire: WireResult, provider: string): HostLlmPublicResult {
  const rid = wire.requestId, model = wire.model
  if (wire.status === 'completed' || wire.status === 'partial') {
    const u = wire.usage!
    return { status: wire.status, text: wire.text!, usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, totalTokens: u.totalTokens, reportedModel: u.reportedModel }, requestId: rid, model, provider }
  }
  const e = wire.error!
  const base = { status: wire.status as 'no_output' | 'timed_out' | 'failed' | 'cancelled', error: { code: e.code as HostLlmErrorCode, reason: e.reason as HostLlmErrorReason, message: e.message }, requestId: rid, model }
  return wire.usage ? { ...base, usage: { inputTokens: wire.usage.inputTokens, outputTokens: wire.usage.outputTokens, cacheReadTokens: wire.usage.cacheReadTokens, cacheWriteTokens: wire.usage.cacheWriteTokens, totalTokens: wire.usage.totalTokens, reportedModel: wire.usage.reportedModel } } : base
}

async function cleanupChild(child: ChildProcess | null, privateHome: string | null): Promise<void> {
  if (child && !child.killed) {
    await new Promise<void>((r) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} r() }, CLOSE_GRACE_MS)
      child.once('exit', () => { clearTimeout(t); r() })
    })
  }
  if (privateHome) { try { rmSync(privateHome, { recursive: true, force: true }) } catch {} }
}

export function createSessionlessHostLlmExecutor(options: HostLlmExecutorOptions): SessionlessHostLlmExecutor {
  const slug = options.connectionSlug
  if (!slug) throw new HostLlmConfigurationError('')
  const conn = getLlmConnection(slug)
  if (!conn) throw new HostLlmConfigurationError(slug)
  const policyResult = resolveExecutablePolicy(conn)
  const policy = policyResult.ok ? policyResult.policy : null
  const fingerprint = computeFingerprint(conn)
  const defaultModel = conn.defaultModel
  const resolved = options.hostRuntime ? resolveBackendRuntimePaths(options.hostRuntime) : null
  const serverPath = options.serverPath ?? resolved?.piServerPath
  const nodeRuntimePath = options.nodeRuntimePath ?? resolved?.nodeRuntimePath ?? process.execPath
  let disposed = false, busy = false
  let disposePromise: Promise<void> | null = null
  let pendingResolve: ((r: HostLlmPublicResult) => void) | null = null
  let pendingChild: ChildProcess | null = null
  let pendingTimer: NodeJS.Timeout | null = null
  let pendingAbortListener: (() => void) | null = null
  let pendingCleanup: Promise<void> = Promise.resolve()

  async function execute(input: HostLlmExecuteInput): Promise<HostLlmPublicResult> {
    const attemptedModel = input.model ?? options.model ?? defaultModel ?? ''
    if (disposed) return makePublicError('executor_closed', 'host_disposed', '', attemptedModel)
    if (busy) return makePublicError('executor_busy', 'concurrent_execute', '', attemptedModel)
    const inputErr = validateExecuteInput(input, attemptedModel)
    if (inputErr) return inputErr
    busy = true
    try {
      const liveConn = getLlmConnection(slug)
      if (!liveConn) return makePublicError('connection_not_found', 'missing_slug', '', attemptedModel)
      if (computeFingerprint(liveConn) !== fingerprint) return makePublicError('connection_changed', 'configuration_drift', '', attemptedModel)
      if (!policy) return makePublicError('invalid_connection', 'unsupported_provider_auth', '', attemptedModel)
      const modelResult = selectExactModel(liveConn, input.model ?? options.model)
      if (!modelResult.ok) return makePublicError('model_not_allowed', modelResult.reason, '', attemptedModel)
      const selectedModel = modelResult.model
      const credResult = await readCredentialSnapshot(liveConn, input.timeoutMs)
      if (!credResult.ok) return makePublicError('credential_unavailable', credResult.reason, '', selectedModel)
      if (disposed) return makePublicError('executor_closed', 'host_disposed', '', selectedModel)
      if (!serverPath) return makePublicError('worker_failed', 'spawn_failed', '', selectedModel)
      const descriptor = createHostDescriptor(liveConn, policy, credResult.credential)
      const requestId = `host-${crypto.randomUUID()}`
      const encoded = encodeRequestLine(requestId, selectedModel, input, descriptor.wireRoute, descriptor.wireCredential)
      if (!encoded.ok) { try { rmSync(descriptor.privateHome, { recursive: true, force: true }) } catch {} return makePublicError('invalid_request', 'wire_request_too_large', requestId, selectedModel) }
      const provider = descriptor.provider
      let child: ChildProcess
      try { child = spawn(nodeRuntimePath, [serverPath, '--host-completion-v1'], { env: descriptor.env, cwd: descriptor.privateHome, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
      catch { try { rmSync(descriptor.privateHome, { recursive: true, force: true }) } catch {} return makePublicError('worker_failed', 'spawn_failed', requestId, selectedModel) }
      pendingChild = child
      const result = await new Promise<HostLlmPublicResult>((resolve) => {
        let settled = false, stdoutBuf = '', stdoutBytes = 0
        const finish = (r: HostLlmPublicResult) => { if (settled) return; settled = true; if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null } if (input.signal && pendingAbortListener) { input.signal.removeEventListener('abort', pendingAbortListener); pendingAbortListener = null } pendingResolve = null; resolve(r) }
        pendingResolve = finish
        pendingTimer = setTimeout(() => finish(makePublicError('timed_out', 'deadline_exceeded', requestId, selectedModel)), input.timeoutMs)
        pendingAbortListener = () => finish(makePublicError('cancelled', 'caller_aborted', requestId, selectedModel))
        if (input.signal) { if (input.signal.aborted) pendingAbortListener(); else input.signal.addEventListener('abort', pendingAbortListener, { once: true }) }
        if (disposed) finish(makePublicError('executor_closed', 'host_disposed', requestId, selectedModel))
        child.stdout!.on('data', (chunk: Buffer) => {
          if (settled) return
          stdoutBytes += chunk.length
          if (stdoutBytes > STDOUT_LIMIT) { finish(makePublicError('provider_protocol_error', 'result_too_large', requestId, selectedModel)); return }
          stdoutBuf += chunk.toString('utf8')
          const nl = stdoutBuf.indexOf('\n')
          if (nl >= 0) { const v = validateWorkerResult(stdoutBuf.slice(0, nl), requestId, selectedModel); finish(v.ok ? toPublicResult(v.result, provider) : makePublicError('provider_protocol_error', 'invalid_worker_message', requestId, selectedModel)) }
        })
        child.on('exit', () => finish(makePublicError('worker_failed', 'worker_exited', requestId, selectedModel)))
        child.on('error', () => finish(makePublicError('worker_failed', 'spawn_failed', requestId, selectedModel)))
        child.stdin!.write(encoded.line + '\n', (err) => { if (err) finish(makePublicError('provider_protocol_error', 'invalid_worker_message', requestId, selectedModel)); else { try { child.stdin!.end() } catch {} } })
      })
      pendingChild = null
      pendingCleanup = cleanupChild(child, descriptor.privateHome)
      await pendingCleanup
      return result
    } finally { busy = false }
  }

  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise
    disposed = true
    if (pendingResolve) {
      if (pendingChild && !pendingChild.killed) { try { pendingChild.kill('SIGTERM') } catch {} }
      pendingResolve(makePublicError('executor_closed', 'host_disposed', '', ''))
    }
    await pendingCleanup
    disposePromise = Promise.resolve()
    return disposePromise
  }

  return { execute, dispose }
}
