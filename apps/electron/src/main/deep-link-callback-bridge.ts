import { ipcMain, webContents } from 'electron'
import { mainLog } from './logger'
import { RPC_CHANNELS } from '../shared/types'
import type { EventSink } from '@polo-ai/server-core/transport'
import type {
  DeepLinkActionResult,
  PoloaiProtocolError,
  PoloaiProtocolEvent,
  PoloaiProtocolMessage,
  PoloaiProtocolErrorCode,
  SessionEvent,
} from '../shared/types'
import { isValidPoloaiCallbackId } from '../shared/types'

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_CALLBACKS_PER_WEB_CONTENTS = 8
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

interface CallbackEntry {
  callbackId: string
  webContentsId: number
  sessionId?: string
  createdAt: number
  lastActiveAt: number
  pageOrigin: string
}

interface WebContentsTarget {
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
}

interface BridgeOptions {
  now?: () => number
  ttlMs?: number
  maxCallbacksPerWebContents?: number
  cleanupIntervalMs?: number
  registerIpc?: boolean
  getWebContentsById?: (webContentsId: number) => WebContentsTarget | undefined
}

type BridgeResult = { ok: true } | { ok: false; error: PoloaiProtocolError }

function makeError(code: PoloaiProtocolErrorCode, message: string): PoloaiProtocolError {
  return { code, message }
}

function getPostMessageOrigin(url: string): string {
  try {
    const origin = new URL(url).origin
    return origin && origin !== 'null' ? origin : '*'
  } catch {
    return '*'
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toProtocolEvent(event: SessionEvent): PoloaiProtocolEvent | null {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', sessionId: event.sessionId, delta: event.delta }
    case 'text_complete':
      return { type: 'text_complete', sessionId: event.sessionId, text: event.text }
    case 'tool_start':
      return { type: 'tool_start', sessionId: event.sessionId, toolName: event.toolName }
    case 'tool_result':
      return { type: 'tool_result', sessionId: event.sessionId, toolName: event.toolName }
    case 'complete':
      return { type: 'complete', sessionId: event.sessionId }
    case 'error':
      return { type: 'error', sessionId: event.sessionId, error: event.error }
    case 'interrupted':
      return { type: 'interrupted', sessionId: event.sessionId }
    default:
      return null
  }
}

export class DeepLinkCallbackBridge {
  private readonly callbacks = new Map<string, CallbackEntry>()
  private readonly sessionOwners = new Map<string, number>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxCallbacksPerWebContents: number
  private readonly getWebContentsById: (webContentsId: number) => WebContentsTarget | undefined
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null
  private readonly actionResultHandler: (_event: Electron.IpcMainEvent, result: DeepLinkActionResult) => void

  constructor(options: BridgeOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxCallbacksPerWebContents = options.maxCallbacksPerWebContents ?? DEFAULT_MAX_CALLBACKS_PER_WEB_CONTENTS
    this.getWebContentsById = options.getWebContentsById ?? ((webContentsId) => webContents.fromId(webContentsId) ?? undefined)

    this.actionResultHandler = (_event, result) => {
      this.handleActionResult(result)
    }

    if (options.registerIpc !== false) {
      ipcMain.on(RPC_CHANNELS.deeplink.ACTION_RESULT, this.actionResultHandler)
    }

    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    if (intervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupExpired(), intervalMs)
      ;(this.cleanupTimer as { unref?: () => void }).unref?.()
    } else {
      this.cleanupTimer = null
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    ipcMain.off?.(RPC_CHANNELS.deeplink.ACTION_RESULT, this.actionResultHandler)
  }

  registerCallback(callbackId: string, webContentsId: number): BridgeResult {
    if (!isValidPoloaiCallbackId(callbackId)) {
      return { ok: false, error: makeError('invalid_action', 'Invalid callbackId') }
    }

    this.cleanupExpired()

    const existing = this.callbacks.get(callbackId)
    if (existing) {
      if (existing.webContentsId !== webContentsId) {
        return { ok: false, error: makeError('not_authorized', 'callbackId is already active in another page') }
      }
      existing.lastActiveAt = this.now()
      return { ok: true }
    }

    const activeCount = Array.from(this.callbacks.values()).filter(entry => entry.webContentsId === webContentsId).length
    if (activeCount >= this.maxCallbacksPerWebContents) {
      return {
        ok: false,
        error: makeError(
          'invalid_action',
          `Too many active poloai:// callbacks for this page (max ${this.maxCallbacksPerWebContents})`,
        ),
      }
    }

    const wc = this.getWebContentsById(webContentsId)
    const now = this.now()
    this.callbacks.set(callbackId, {
      callbackId,
      webContentsId,
      createdAt: now,
      lastActiveAt: now,
      pageOrigin: wc && !wc.isDestroyed() ? getPostMessageOrigin(wc.getURL()) : '*',
    })

    return { ok: true }
  }

  prepareSendMessage(callbackId: string, webContentsId: number, sessionId: string | undefined): BridgeResult {
    if (!sessionId) {
      return { ok: false, error: makeError('invalid_action', 'send-message requires a sessionId') }
    }

    const ownerWebContentsId = this.sessionOwners.get(sessionId)
    if (ownerWebContentsId == null) {
      return { ok: false, error: makeError('session_not_found', 'Session is not owned by this protocol page') }
    }
    if (ownerWebContentsId !== webContentsId) {
      return { ok: false, error: makeError('not_authorized', 'Session belongs to another protocol page') }
    }

    const registered = this.registerCallback(callbackId, webContentsId)
    if (!registered.ok) return registered

    const entry = this.callbacks.get(callbackId)
    if (entry) {
      entry.sessionId = sessionId
      entry.lastActiveAt = this.now()
    }

    return { ok: true }
  }

  sendError(callbackId: string, webContentsId: number, error: PoloaiProtocolError): void {
    if (!isValidPoloaiCallbackId(callbackId)) return
    const wc = this.getWebContentsById(webContentsId)
    const entry: CallbackEntry = {
      callbackId,
      webContentsId,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      pageOrigin: wc && !wc.isDestroyed() ? getPostMessageOrigin(wc.getURL()) : '*',
    }
    this.postToEntry(entry, { type: 'poloai:error', callbackId, error })
  }

  handleActionResult(result: DeepLinkActionResult): void {
    if (!isValidPoloaiCallbackId(result?.callbackId)) return

    const entry = this.callbacks.get(result.callbackId)
    if (!entry) return

    entry.lastActiveAt = this.now()

    if (result.error) {
      this.postToEntry(entry, {
        type: 'poloai:error',
        callbackId: result.callbackId,
        error: result.error,
      })
      return
    }

    if (result.sessionId) {
      entry.sessionId = result.sessionId
      this.sessionOwners.set(result.sessionId, entry.webContentsId)
    }

    this.postToEntry(entry, {
      type: 'poloai:ack',
      callbackId: result.callbackId,
      result: { sessionId: result.sessionId },
    })
  }

  handleSessionEvent(event: SessionEvent): void {
    const protocolEvent = toProtocolEvent(event)
    if (!protocolEvent) return

    for (const entry of this.callbacks.values()) {
      if (entry.sessionId !== event.sessionId) continue
      entry.lastActiveAt = this.now()
      this.postToEntry(entry, {
        type: 'poloai:event',
        callbackId: entry.callbackId,
        event: protocolEvent,
      })
    }
  }

  wrapEventSink(sink: EventSink): EventSink {
    return (channel, target, ...args) => {
      if (channel === RPC_CHANNELS.sessions.EVENT) {
        const [event] = args
        if (event && typeof event === 'object' && 'type' in event && 'sessionId' in event) {
          this.handleSessionEvent(event as SessionEvent)
        }
      }
      sink(channel, target, ...args)
    }
  }

  cleanupWebContents(webContentsId: number): void {
    const removedSessionIds = new Set<string>()

    for (const [callbackId, entry] of this.callbacks) {
      if (entry.webContentsId !== webContentsId) continue
      if (entry.sessionId) removedSessionIds.add(entry.sessionId)
      this.callbacks.delete(callbackId)
    }

    for (const sessionId of removedSessionIds) {
      if (!this.hasCallbackForSession(sessionId)) {
        this.sessionOwners.delete(sessionId)
      }
    }
  }

  cleanupExpired(now = this.now()): void {
    const removedSessionIds = new Set<string>()

    for (const [callbackId, entry] of this.callbacks) {
      if (now - entry.lastActiveAt <= this.ttlMs) continue
      if (entry.sessionId) removedSessionIds.add(entry.sessionId)
      this.callbacks.delete(callbackId)
    }

    for (const sessionId of removedSessionIds) {
      if (!this.hasCallbackForSession(sessionId)) {
        this.sessionOwners.delete(sessionId)
      }
    }
  }

  getActiveCallbackCount(webContentsId: number): number {
    return Array.from(this.callbacks.values()).filter(entry => entry.webContentsId === webContentsId).length
  }

  private hasCallbackForSession(sessionId: string): boolean {
    return Array.from(this.callbacks.values()).some(entry => entry.sessionId === sessionId)
  }

  private postToEntry(entry: CallbackEntry, payload: PoloaiProtocolMessage): void {
    const wc = this.getWebContentsById(entry.webContentsId)
    if (!wc || wc.isDestroyed()) return

    const currentOrigin = getPostMessageOrigin(wc.getURL())
    if (entry.pageOrigin !== '*' && currentOrigin !== entry.pageOrigin) {
      this.cleanupWebContents(entry.webContentsId)
      return
    }

    const targetOrigin = currentOrigin === '*' ? '*' : currentOrigin
    const script = `window.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(targetOrigin)})`
    void wc.executeJavaScript(script).catch(error => {
      mainLog.debug('[DeepLinkCallbackBridge] postMessage failed:', toMessage(error))
    })
  }
}

let bridge: DeepLinkCallbackBridge | null = null

export function getDeepLinkCallbackBridge(): DeepLinkCallbackBridge {
  if (!bridge) bridge = new DeepLinkCallbackBridge()
  return bridge
}
