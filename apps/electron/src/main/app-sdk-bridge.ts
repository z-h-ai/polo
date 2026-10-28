import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain, WebPreferences } from 'electron'
import { AppAiQuerySchema } from '@polo-ai/shared/product-spaces'
import { SDK_PROTOCOL_VERSION, SDK_STATUS_CHANNEL, validCallId, validQuery } from '../../../../packages/sdk/src/protocol'
import type { HostInfo, PoloPhase, PoloResult, Reply, PoloErrorCode } from '../../../../packages/sdk/src/protocol'
import type { ActiveRuntime, LocalAppRuntimeCoordinator } from './local-app-runtime/runtime-coordinator'

interface Launch { runtime: ActiveRuntime; hostId: number; origin: string; guest?: DocumentBinding; dispose: () => void }
interface DocumentBinding {
  launch: Launch; guest: WebContents; generation: number; ready: boolean
  calls: Map<string, { controller: AbortController; generation: number }>
  used: Set<string>; cancelled: Set<string>; dispose: () => void
}
const failure = (code: PoloErrorCode): Reply<never> => ({ ok: false, error: { code } })
export function sdkLocalOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && !url.username && !url.password ? url.origin : null
  } catch { return null }
}

/** All identity comes from a successful Main START, never from guest arguments. */
export class AppSdkBridge {
  private readonly launches = new Map<string, Launch>()
  private readonly pending = new Map<string, Launch>()
  private readonly attachedHosts = new WeakMap<WebContents, WebContents>()
  private readonly documents = new Map<number, DocumentBinding>()
  constructor(private readonly options: {
    coordinator: LocalAppRuntimeCoordinator
    preloadPath: string
    workspaceForHost: (id: number) => string | null
    scopeCurrent: (runtime: ActiveRuntime) => boolean
  }) {}

  registerLaunch(hostId: number, runtime: ActiveRuntime, uiUrl: string): void {
    const origin = sdkLocalOrigin(uiUrl)
    if (!origin || this.options.workspaceForHost(hostId) !== runtime.workspaceId || !this.options.scopeCurrent(runtime)) throw new Error('SDK launch binding unavailable')
    const key = JSON.stringify([hostId, runtime.executionId])
    this.launches.get(key)?.dispose()
    const launch: Launch = { hostId, runtime, origin, dispose: () => {} }
    const abort = () => launch.dispose()
    launch.dispose = () => {
      runtime.controller.signal.removeEventListener('abort', abort)
      launch.guest?.dispose()
      for (const [nonce, value] of this.pending) if (value === launch) this.pending.delete(nonce)
      if (this.launches.get(key) === launch) this.launches.delete(key)
    }
    runtime.controller.signal.addEventListener('abort', abort, { once: true })
    this.launches.set(key, launch)
    if (runtime.controller.signal.aborted) launch.dispose()
  }

  /** Called only after the existing Main partition/fence attach gate succeeds. */
  prepareGuest(hostId: number, src: string, prefs: WebPreferences): void {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    prefs.additionalArguments = []
    const origin = sdkLocalOrigin(src)
    const launch = [...this.launches.values()].find(candidate => candidate.hostId === hostId && candidate.origin === origin && this.live(candidate))
    if (!launch || launch.guest || [...this.pending.values()].includes(launch)) return
    const nonce = randomUUID()
    this.pending.set(nonce, launch)
    prefs.preload = this.options.preloadPath
    prefs.additionalArguments = [`--polo-app-sdk-attach=${nonce}`]
  }

  attachGuest(host: WebContents, guest: WebContents): void {
    if (guest.hostWebContents === host && guest.getType() === 'webview') this.attachedHosts.set(guest, host)
  }

  private claimGuest(guest: WebContents, frame: WebFrameMain, nonce: unknown): void {
    if (typeof nonce !== 'string' || frame !== guest.mainFrame) return
    const launch = this.pending.get(nonce)
    const host = this.attachedHosts.get(guest)
    if (!launch || !host || host.id !== launch.hostId || guest.hostWebContents !== host || launch.guest || !this.live(launch) || sdkLocalOrigin(frame.url) !== launch.origin) return
    this.pending.delete(nonce)
    const doc: DocumentBinding = { launch, guest, generation: 0, ready: !guest.isLoadingMainFrame(), calls: new Map(), used: new Set(), cancelled: new Set(), dispose: () => {} }
    const invalidate = () => {
      doc.ready = false
      doc.generation++
      for (const call of doc.calls.values()) call.controller.abort()
      doc.calls.clear()
      doc.used.clear()
      doc.cancelled.clear()
    }
    const navigate = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !inPlace) invalidate() }
    const ready = () => { doc.ready = sdkLocalOrigin(guest.mainFrame.url) === launch.origin && this.live(launch) }
    const crashed = () => invalidate()
    const hostGone = () => launch.dispose()
    doc.dispose = () => {
      invalidate()
      guest.removeListener('did-start-navigation', navigate)
      guest.removeListener('dom-ready', ready)
      guest.removeListener('render-process-gone', crashed)
      guest.removeListener('destroyed', doc.dispose)
      host.removeListener('destroyed', hostGone)
      this.documents.delete(guest.id)
      if (launch.guest === doc) launch.guest = undefined
    }
    launch.guest = doc
    this.documents.set(guest.id, doc)
    guest.on('did-start-navigation', navigate)
    guest.on('dom-ready', ready)
    guest.on('render-process-gone', crashed)
    guest.once('destroyed', doc.dispose)
    host.once('destroyed', hostGone)
  }

  private live(launch: Launch): boolean {
    return !launch.runtime.controller.signal.aborted
      && this.options.workspaceForHost(launch.hostId) === launch.runtime.workspaceId
      && this.options.scopeCurrent(launch.runtime)
  }
  private matches(doc: DocumentBinding, frame: WebFrameMain, generation: number): boolean {
    return this.documents.get(doc.guest.id) === doc && doc.ready && doc.generation === generation
      && !doc.guest.isDestroyed() && doc.guest.hostWebContents?.id === doc.launch.hostId
      && doc.guest.mainFrame === frame && !frame.detached
      && sdkLocalOrigin(frame.url) === doc.launch.origin && this.live(doc.launch)
  }
  private async current(doc: DocumentBinding, frame: WebFrameMain, generation: number): Promise<boolean> {
    try {
      if (!this.matches(doc, frame, generation)) return false
      const valid = await this.options.coordinator.verifyBrowserRuntime(doc.launch.runtime)
      return valid && this.matches(doc, frame, generation)
    } catch { return false }
  }
  async invoke(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, raw: unknown, attachNonce?: unknown): Promise<Reply<unknown>> {
    const frame = event.senderFrame
    if (frame && !this.documents.has(event.sender.id)) this.claimGuest(event.sender, frame, attachNonce)
    const doc = this.documents.get(event.sender.id)
    if (!doc || !frame || event.sender !== doc.guest || frame !== event.sender.mainFrame) return failure('capability_invalid')
    const generation = doc.generation
    if (!await this.current(doc, frame, generation)) return failure('capability_invalid')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('invalid_request')
    const request = raw as Record<string, unknown>
    const keys = Object.keys(request).sort().join(',')
    if (request.action === 'info' && keys === 'action') {
      return { ok: true, data: { protocolVersion: SDK_PROTOCOL_VERSION, features: ['single_query', 'cancel', 'status'] } satisfies HostInfo }
    }
    if (!validCallId(request.callId)) return failure('invalid_request')
    if (request.action === 'cancel' && keys === 'action,callId') {
      const call = doc.calls.get(request.callId)
      if (call?.generation === generation) call.controller.abort()
      else if (!doc.used.has(request.callId) && doc.cancelled.size < 256) doc.cancelled.add(request.callId)
      return { ok: true, data: { accepted: !!call } }
    }
    if (request.action !== 'start' || keys !== 'action,callId,input' || !validQuery(request.input)) return failure('invalid_request')
    if (doc.cancelled.has(request.callId)) return failure('request_cancelled')
    if (doc.used.has(request.callId)) return failure('idempotency_conflict')
    if (doc.calls.size) return failure('request_in_progress')
    if (doc.used.size >= 256) return failure('run_registry_full')
    const runId = randomUUID(), requestId = randomUUID(), callId = request.callId
    // Omitted maxOutputTokens resolves to the selected model's own output limit (per-model cap).
    const query = AppAiQuerySchema.safeParse({ timeoutMs: 300_000, ...request.input, runId, requestId })
    if (!query.success) return failure('invalid_request')
    const controller = new AbortController()
    const call = { controller, generation }
    doc.used.add(callId)
    doc.calls.set(callId, call)
    const runtime = doc.launch.runtime
    const abortRuntime = () => controller.abort()
    runtime.controller.signal.addEventListener('abort', abortRuntime, { once: true })
    const current = () => this.current(doc, frame, generation)
    const emit = async (phase: PoloPhase) => {
      if (await current()) { try { frame.send(SDK_STATUS_CHANNEL, { callId, phase }) } catch { /* Frame gone. */ } }
    }
    let startAccepted = false
    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'unknown' = 'unknown'
    let reply: Reply<PoloResult> = failure('host_failed')
    try {
      await emit('starting')
      const started = await this.options.coordinator.dispatchBrowser(runtime, '/run/start', { runId }, controller.signal, current)
      if (started.errorCode) { finalStatus = controller.signal.aborted ? 'cancelled' : 'unknown'; reply = failure(started.errorCode) }
      else if (controller.signal.aborted || !await current()) { startAccepted = true; finalStatus = 'cancelled'; reply = failure('request_cancelled') }
      else {
        startAccepted = true
        await emit('running')
        const result = await this.options.coordinator.dispatchBrowser(runtime, '/ai/query', query.data, controller.signal, current)
        // Query outcome is immutable, including provider-completed/receipt-pending cancellation races.
        const data = result.data as { status?: string; text?: string; settlement?: PoloResult['settlement'] } | undefined
        if (data && (data.status === 'completed' || data.status === 'partial') && typeof data.text === 'string') {
          finalStatus = 'completed'
          reply = { ok: true, data: { requestId, text: data.text, status: data.status, settlement: data.settlement ?? 'unknown' } }
        } else {
          const code = result.errorCode ?? 'no_output'
          finalStatus = code === 'request_cancelled' ? 'cancelled' : 'failed'
          reply = failure(code)
        }
      }
    } catch { reply = failure('host_failed') }
    finally {
      await emit('settling')
      // Cleanup has its own bounded signal and the original run/runtime/account.
      const cleanup = await this.options.coordinator.cleanupBrowserRun(runtime, runId, finalStatus).catch(() => ({ finished: false, settlement: undefined }))
      if (!cleanup.finished) {
        if (reply.ok) reply.data.settlement = 'unknown'
        else if (startAccepted) reply = failure('metering_unconfirmed')
      } else if (reply.ok && (reply.data.settlement === 'pending' || cleanup.settlement === 'pending')) reply.data.settlement = 'pending'
      await emit(reply.ok ? 'completed' : reply.error.code === 'request_cancelled' ? 'cancelled' : 'failed')
      runtime.controller.signal.removeEventListener('abort', abortRuntime)
      if (doc.calls.get(callId) === call) doc.calls.delete(callId)
    }
    return await current() ? reply : failure('request_cancelled')
  }

  dispose(): void {
    for (const launch of [...this.launches.values()]) launch.dispose()
    this.pending.clear()
  }
}
