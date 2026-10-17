import { SDK_PROTOCOL_VERSION, validQuery } from './protocol'
import type { AppSdkHost, HostInfo, PoloErrorCode, PoloResult, PoloStatus, QueryInput, Reply } from './protocol'
export class PoloError extends Error {
  constructor(readonly code: PoloErrorCode) { super(code); this.name = 'PoloError' }
}
export interface PromptOptions extends QueryInput { signal?: AbortSignal }
export interface PoloTask {
  readonly result: Promise<PoloResult>
  cancel(): Promise<void>
  onStatus(listener: (status: PoloStatus) => void): () => void
}
function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new PoloError(reply.error.code)
  return reply.data
}
function resolveHost(): AppSdkHost {
  const host = (globalThis as typeof globalThis & { poloAppHost?: AppSdkHost }).poloAppHost
  if (!host || typeof host.info !== 'function' || typeof host.start !== 'function' || typeof host.cancel !== 'function' || typeof host.onStatus !== 'function') throw new PoloError('host_unavailable')
  return host
}
async function handshake(host: AppSdkHost): Promise<HostInfo> {
  let info: HostInfo
  try { info = unwrap(await host.info()) } catch (error) { throw error instanceof PoloError ? error : new PoloError('host_unavailable') }
  if (info.protocolVersion !== SDK_PROTOCOL_VERSION || !info.features?.includes('single_query')) throw new PoloError('unsupported_host')
  return info
}
export const polo = Object.freeze({
  async isAvailable(): Promise<boolean> {
    try { await handshake(resolveHost()); return true } catch { return false }
  },
  run(options: PromptOptions): PoloTask {
    const listeners = new Set<(status: PoloStatus) => void>()
    let latest: PoloStatus | undefined, terminal = false, cancelled = false, submitted = false
    let host: AppSdkHost | undefined, callId = '', off = () => {}
    let cancelSent: Promise<void> | undefined
    const notify = (status: PoloStatus) => {
      if (terminal || latest?.phase === status.phase) return
      latest = status
      for (const listener of listeners) { try { listener(status) } catch { /* User callbacks do not control the query. */ } }
    }
    const sendCancel = () => {
      if (!host || !submitted || terminal) return Promise.resolve()
      return cancelSent ??= host.cancel(callId).then(reply => { unwrap(reply) }, () => { throw new PoloError('host_unavailable') })
    }
    const cancel = async () => { cancelled = true; await sendCancel() }
    const abort = () => { void cancel().catch(() => {}) }
    const signal = options?.signal
    const result = (async (): Promise<PoloResult> => {
      try {
        // Never spread arbitrary caller keys (identity/provider fields are forbidden).
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new PoloError('invalid_request')
        const { signal: _signal, ...input } = options
        if (!validQuery(input) || signal !== undefined && !(signal instanceof AbortSignal)) throw new PoloError('invalid_request')
        if (signal?.aborted) cancelled = true
        signal?.addEventListener('abort', abort, { once: true })
        if (cancelled) throw new PoloError('request_cancelled')
        host = resolveHost()
        await handshake(host)
        if (cancelled) throw new PoloError('request_cancelled')
        callId = crypto.randomUUID()
        off = host.onStatus(event => { if (event.callId === callId) notify({ phase: event.phase }) })
        submitted = true
        const response = host.start(callId, { maxOutputTokens: 4096, timeoutMs: 60_000, ...input })
        if (cancelled) void sendCancel().catch(() => {})
        const value = unwrap(await response)
        // A late cancel cannot overwrite a completed, metered provider outcome.
        if (!value || !['completed', 'partial'].includes(value.status) || typeof value.text !== 'string' || !['pending', 'confirmed', 'no_charge', 'unknown'].includes(value.settlement)) throw new PoloError('unsupported_host')
        notify({ phase: 'completed' })
        return value
      } catch (error) {
        const safe = error instanceof PoloError ? error : new PoloError('host_unavailable')
        notify({ phase: safe.code === 'request_cancelled' ? 'cancelled' : 'failed' })
        throw safe
      } finally {
        terminal = true
        off()
        listeners.clear()
        signal?.removeEventListener('abort', abort)
      }
    })()
    return Object.freeze({ result, cancel, onStatus(listener: (status: PoloStatus) => void) {
      if (!terminal) listeners.add(listener)
      if (latest) { try { listener(latest) } catch { /* Isolated subscriber. */ } }
      return () => { listeners.delete(listener) }
    } })
  },
  prompt(options: PromptOptions): Promise<PoloResult> { return polo.run(options).result },
})
