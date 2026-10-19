/**
 * GenUI ui-event loop — host-side handler for `poloai://action/ui-event/{sessionId}`
 * (POO-103, proposal §7.2).
 *
 * A canvas card reaches the host bridge ONLY through this one deep link. Every
 * URL passes the six-step validation before anything happens:
 *
 * 1. URL shape + session alive (`session_not_found`).
 * 2. cardId registered in the UiCardRegistry (`card_not_registered`).
 * 3. event.sender.id === the registry's recorded webContentsId — the core
 *    two-dimensional ownership check; a sibling card in the SAME session
 *    impersonating another cardId fails here (`not_authorized`).
 * 4. the guest's attach-time `polo-bridge-capabilities` declaration includes
 *    `ui-event` (`capability_denied`) — P1 bundles declare nothing and are
 *    always rejected.
 * 5. payload bounds: inline payload ≤ 8KB, payloadSrc confined to the
 *    session's data/ directory and ≤ 1MB (`payload_too_large` /
 *    `invalid_payload`).
 * 6. per-card sliding-window rate limit, 10 events/second (`rate_limited`).
 *
 * Every verdict — success or failure — is delivered back to the exact card
 * over the existing poloai:ack / poloai:error channels (callbackId pairing).
 * Accepted events feed the widgetState three-way split: modelContext (≤2KB,
 * truncated) is queued into the session's next-turn context, privateState is
 * pushed back to the card alone as a ui_state protocol event.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { mainLog } from './logger'
import { getDeepLinkCallbackBridge, type DeepLinkCallbackBridge } from './deep-link-callback-bridge'
import type { UiCardRegistry } from './ui-card-registry'
import { describeUrlForLog } from './deep-link-log'
import {
  GENUI_UI_EVENT_ACTION,
  GENUI_UI_EVENT_MAX_PAYLOAD_BYTES,
  GENUI_UI_EVENT_MAX_PAYLOAD_SRC_BYTES,
  GENUI_UI_EVENT_RATE_LIMIT,
  GENUI_UI_EVENT_RATE_WINDOW_MS,
  GENUI_MODEL_CONTEXT_MAX_BYTES,
  isValidGenUiUiCardId,
  isValidPoloaiCallbackId,
  isValidGenUiUiEventType,
  truncateGenUiModelContext,
  type PoloaiProtocolErrorCode,
  type GenUiUiEventType,
} from '@polo-ai/shared/protocol'
import { validateSessionId } from '@polo-ai/shared/sessions'

// ── Strict URL parsing ───────────────────────────────────────────────────────

export interface ParsedUiEventUrl {
  sessionId: string
  cardId: string
  eventId: string
  type: GenUiUiEventType
  callbackId: string
  /** Inline payload (decoded URL parameter), when present. */
  payload?: string
  /** Session-data-relative or absolute path, when present. */
  payloadSrc?: string
}

export type UiEventParseResult =
  | { ok: true; parsed: ParsedUiEventUrl }
  | { ok: false; code: PoloaiProtocolErrorCode; message: string; callbackId?: string }

/** Search parameters a ui-event URL may carry — anything else is rejected. */
const ALLOWED_UI_EVENT_PARAMS = new Set(['cardId', 'eventId', 'type', 'callbackId', 'payload', 'payloadSrc'])

const EVENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const PAYLOAD_SRC_MAX_LENGTH = 1024

/**
 * Strict parse of `poloai://action/ui-event/{sessionId}` — deliberately NOT
 * the generic deep-link router table: unknown/duplicated parameters are
 * rejected outright so a future query parameter can never silently change
 * this handler's behavior.
 */
export function parseUiEventDeepLink(rawUrl: string): UiEventParseResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, code: 'invalid_payload', message: 'ui-event URL is not parseable' }
  }
  if (url.protocol !== 'poloai:' || url.hostname !== 'action') {
    return { ok: false, code: 'invalid_payload', message: 'ui-event URL must be poloai://action/ui-event/…' }
  }
  const pathParts = url.pathname.split('/').filter(Boolean)
  if (pathParts.length !== 2 || pathParts[0] !== GENUI_UI_EVENT_ACTION) {
    return { ok: false, code: 'invalid_payload', message: 'ui-event URL must be poloai://action/ui-event/{sessionId}' }
  }
  let sessionId: string
  try {
    sessionId = decodeURIComponent(pathParts[1] ?? '')
  } catch {
    // e.g. a malformed percent escape (%zz) — report it, never throw out of
    // the parser (the card would get no verdict at all).
    return { ok: false, code: 'invalid_payload', message: 'ui-event sessionId is malformed' }
  }
  try {
    validateSessionId(sessionId)
  } catch {
    return { ok: false, code: 'invalid_payload', message: 'ui-event sessionId is malformed' }
  }

  for (const key of new Set(url.searchParams.keys())) {
    if (!ALLOWED_UI_EVENT_PARAMS.has(key)) {
      return { ok: false, code: 'invalid_payload', message: `Unknown ui-event parameter: ${key}` }
    }
    if (url.searchParams.getAll(key).length !== 1) {
      return { ok: false, code: 'invalid_payload', message: `Duplicate ui-event parameter: ${key}` }
    }
  }

  const callbackId = url.searchParams.get('callbackId') ?? ''
  if (!isValidPoloaiCallbackId(callbackId)) {
    // Without a well-formed callbackId there is no channel to report the
    // verdict on — the event is dropped silently (logged by the caller).
    return { ok: false, code: 'invalid_payload', message: 'ui-event requires a valid callbackId' }
  }
  const fail = (code: PoloaiProtocolErrorCode, message: string): UiEventParseResult => ({
    ok: false,
    code,
    message,
    callbackId,
  })

  const cardId = url.searchParams.get('cardId') ?? ''
  if (!isValidGenUiUiCardId(cardId)) return fail('invalid_payload', 'ui-event cardId is malformed')
  const eventId = url.searchParams.get('eventId') ?? ''
  if (!EVENT_ID_PATTERN.test(eventId)) return fail('invalid_payload', 'ui-event eventId is malformed')
  const type = url.searchParams.get('type') ?? ''
  if (!isValidGenUiUiEventType(type)) {
    return fail('invalid_payload', `ui-event type must be one of: button-click, value-change, submit`)
  }

  const payload = url.searchParams.get('payload') ?? undefined
  const payloadSrc = url.searchParams.get('payloadSrc') ?? undefined
  if (payload !== undefined && payloadSrc !== undefined) {
    return fail('invalid_payload', 'ui-event accepts either payload or payloadSrc, not both')
  }
  if (payload !== undefined && Buffer.byteLength(payload, 'utf8') > GENUI_UI_EVENT_MAX_PAYLOAD_BYTES) {
    return fail('payload_too_large', `ui-event payload exceeds ${GENUI_UI_EVENT_MAX_PAYLOAD_BYTES} bytes`)
  }
  if (payloadSrc !== undefined) {
    if (payloadSrc.length === 0 || payloadSrc.length > PAYLOAD_SRC_MAX_LENGTH || payloadSrc.includes('\0')) {
      return fail('invalid_payload', 'ui-event payloadSrc is malformed')
    }
  }

  return { ok: true, parsed: { sessionId, cardId, eventId, type, callbackId, payload, payloadSrc } }
}

// ── Rate limiting (proposal §7.2 step 6) ─────────────────────────────────────

/** Global key cap — a safety valve; live keys are bounded by registered cards. */
const RATE_LIMIT_MAX_KEYS = 1024

export class UiEventRateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** Whether one more event from this card fits the sliding window. */
  allow(sessionId: string, cardId: string): boolean {
    const now = this.now()
    if (this.hits.size > RATE_LIMIT_MAX_KEYS) this.prune(now - 2 * GENUI_UI_EVENT_RATE_WINDOW_MS)
    const key = `${sessionId}\u0000${cardId}`
    const windowStart = now - GENUI_UI_EVENT_RATE_WINDOW_MS
    const recent = (this.hits.get(key) ?? []).filter(at => at > windowStart)
    if (recent.length >= GENUI_UI_EVENT_RATE_LIMIT) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  clear(): void {
    this.hits.clear()
  }

  private prune(olderThan: number): void {
    for (const [key, ats] of this.hits) {
      const recent = ats.filter(at => at > olderThan)
      if (recent.length === 0) this.hits.delete(key)
      else this.hits.set(key, recent)
    }
  }
}

// ── Six-step validation (pure, exported for tests) ───────────────────────────

export type UiEventPayload = Record<string, unknown>

export type UiEventVerdict =
  | { ok: true; payload: UiEventPayload }
  | { ok: false; code: PoloaiProtocolErrorCode; message: string }

export interface UiEventValidationContext {
  registry: UiCardRegistry
  hasLiveSession: (sessionId: string) => boolean
  resolveSessionDataPath: (sessionId: string) => string | null
  rateLimiter: UiEventRateLimiter
}

/**
 * Steps 0 and 2–6 of proposal §7.2 (step 1's URL-shape half happens in the
 * parser; the session-alive half is the first check here). Each failure maps
 * onto exactly one §7.3 error code — except step 0, which collapses every
 * unknown-sender rejection into a uniform `not_authorized` so untrusted
 * senders can't probe the registry.
 */
export function validateUiEvent(
  parsed: ParsedUiEventUrl,
  senderWebContentsId: number,
  ctx: UiEventValidationContext,
): UiEventVerdict {
  // Step 0 — the sender must be a webContents Main saw attach as a genui
  // guest. Anything else (tab webviews, browser-pane pages, spoofed handles)
  // gets one uniform code with no oracle about which sessions are live or
  // which cards are registered.
  if (!ctx.registry.isKnownGuest(senderWebContentsId)) {
    return { ok: false, code: 'not_authorized', message: `ui-event sender ${senderWebContentsId} is not a canvas card guest` }
  }

  // Step 1 — the session must still be alive in this desktop main.
  if (!ctx.hasLiveSession(parsed.sessionId)) {
    return { ok: false, code: 'session_not_found', message: `Session not found: ${parsed.sessionId}` }
  }

  // Step 2 — the card must be registered for this exact session.
  const entry = ctx.registry.getCard(parsed.sessionId, parsed.cardId)
  if (!entry) {
    if (ctx.registry.hasCardsForSession(parsed.sessionId)) {
      return { ok: false, code: 'card_not_registered', message: `Card not registered: ${parsed.cardId}` }
    }
    return { ok: false, code: 'session_not_found', message: `Session has no registered cards: ${parsed.sessionId}` }
  }

  // Step 3 — THE ownership check: the sender must be the exact guest
  // webContents the card registered with. A different card (or any other
  // webContents) in the same session quoting this cardId fails here.
  if (senderWebContentsId !== entry.webContentsId) {
    return {
      ok: false,
      code: 'not_authorized',
      message: `ui-event sender ${senderWebContentsId} is not the registered card owner of ${parsed.cardId}`,
    }
  }

  // Step 4 — the attach-time capability declaration must include ui-event.
  // P1 bundles declare nothing and are always rejected.
  if (!entry.capabilities.includes('ui-event')) {
    return {
      ok: false,
      code: 'capability_denied',
      message: `Card ${parsed.cardId} did not declare the ui-event bridge capability`,
    }
  }

  // Step 5 — payload bounds and JSON shape.
  const payloadVerdict = resolveUiEventPayload(parsed, ctx.resolveSessionDataPath)
  if (!payloadVerdict.ok) return payloadVerdict

  // Step 6 — per-card sliding-window rate limit.
  if (!ctx.rateLimiter.allow(parsed.sessionId, parsed.cardId)) {
    return {
      ok: false,
      code: 'rate_limited',
      message: `Card ${parsed.cardId} exceeded the ${GENUI_UI_EVENT_RATE_LIMIT} events/second ui-event limit`,
    }
  }

  return { ok: true, payload: payloadVerdict.payload }
}

function resolveUiEventPayload(
  parsed: ParsedUiEventUrl,
  resolveSessionDataPath: (sessionId: string) => string | null,
): UiEventVerdict {
  if (parsed.payloadSrc !== undefined) {
    const dataDir = resolveSessionDataPath(parsed.sessionId)
    if (!dataDir) return { ok: false, code: 'session_not_found', message: 'Session data directory is unavailable' }
    // payloadSrc may be session-data-relative or absolute-inside-data — but it
    // is confined to data/ either way, resolved in real-path space so symlinks
    // cannot walk out (render_ui data-table precedent).
    const candidate = isAbsolute(parsed.payloadSrc) ? parsed.payloadSrc : resolve(dataDir, parsed.payloadSrc)
    let realCandidate: string
    try {
      realCandidate = realpathSync(candidate)
    } catch {
      return { ok: false, code: 'invalid_payload', message: 'payloadSrc file does not exist' }
    }
    let realBoundary: string
    try {
      realBoundary = realpathSync(dataDir)
    } catch {
      return { ok: false, code: 'session_not_found', message: 'Session data directory is unavailable' }
    }
    if (!isWithinRealPath(realBoundary, realCandidate)) {
      return { ok: false, code: 'invalid_payload', message: 'payloadSrc escapes the session data directory' }
    }
    let raw: string
    try {
      const size = statSync(realCandidate).size
      if (size > GENUI_UI_EVENT_MAX_PAYLOAD_SRC_BYTES) {
        return { ok: false, code: 'payload_too_large', message: `payloadSrc exceeds ${GENUI_UI_EVENT_MAX_PAYLOAD_SRC_BYTES} bytes` }
      }
      raw = readFileSync(realCandidate, 'utf-8')
    } catch (error) {
      return { ok: false, code: 'invalid_payload', message: `payloadSrc is unreadable: ${toMessage(error)}` }
    }
    // Re-check post-read: stat/read races must not slip an oversized payload through.
    if (Buffer.byteLength(raw, 'utf8') > GENUI_UI_EVENT_MAX_PAYLOAD_SRC_BYTES) {
      return { ok: false, code: 'payload_too_large', message: `payloadSrc exceeds ${GENUI_UI_EVENT_MAX_PAYLOAD_SRC_BYTES} bytes` }
    }
    return parsePayloadObject(raw)
  }

  if (parsed.payload !== undefined) {
    if (Buffer.byteLength(parsed.payload, 'utf8') > GENUI_UI_EVENT_MAX_PAYLOAD_BYTES) {
      return { ok: false, code: 'payload_too_large', message: `ui-event payload exceeds ${GENUI_UI_EVENT_MAX_PAYLOAD_BYTES} bytes` }
    }
    return parsePayloadObject(parsed.payload)
  }

  // A button-click without payload is legitimate; treat it as an empty object.
  return { ok: true, payload: {} }
}

/**
 * Separator-aware containment in real-path space (path.relative semantics, so
 * no sibling-prefix bypass and Windows backslashes compare correctly) —
 * mode-manager.ts `isWithin` precedent.
 */
function isWithinRealPath(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function parsePayloadObject(raw: string): UiEventVerdict {
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, code: 'invalid_payload', message: 'ui-event payload must be a JSON object' }
    }
    return { ok: true, payload: value as UiEventPayload }
  } catch (error) {
    return { ok: false, code: 'invalid_payload', message: `ui-event payload is not valid JSON: ${toMessage(error)}` }
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── widgetState processing (proposal §8 GENUI-09) ────────────────────────────

export interface GenUiModelContextQueue {
  /** Queue a (pre-truncated) context for the session's NEXT turn. */
  (sessionId: string, entry: { cardId: string; context: string }): boolean
}

export interface GenUiUiEventDeps {
  registry: UiCardRegistry
  bridge: DeepLinkCallbackBridge
  hasLiveSession: (sessionId: string) => boolean
  queueGenUiModelContext: GenUiModelContextQueue
  resolveSessionDataPath: (sessionId: string) => string | null
}

let deps: GenUiUiEventDeps | null = null
const rateLimiter = new UiEventRateLimiter()

/**
 * Wire the process-wide deps — called from the genui RPC handler registration
 * (which owns the SessionManager/storage pair). While unset, ui-event URLs
 * fail closed at the session-alive step.
 */
export function setGenUiUiEventDeps(next: GenUiUiEventDeps | null): void {
  deps = next
  rateLimiter.clear()
}

/** Test seam. */
export function __resetGenUiUiEventForTests(): void {
  deps = null
  rateLimiter.clear()
}

/**
 * Entry point for every `poloai://action/ui-event/…` URL, from both dispatch
 * sites: browser-pane-manager's deep link interception and webview-security's
 * canvas-guest will-navigate forwarding. Always consumes the URL (never
 * navigates anything).
 */
export function handleUiEventUrl(rawUrl: string, senderWebContentsId: number): void {
  const currentDeps = deps
  const bridge = currentDeps?.bridge ?? getDeepLinkCallbackBridge()
  const parsedResult = parseUiEventDeepLink(rawUrl)
  if (!parsedResult.ok) {
    // The parser only returns a callbackId when it is well-formed enough to
    // reply on; otherwise the event is dropped (logged).
    if (parsedResult.callbackId) {
      bridge.sendError(parsedResult.callbackId, senderWebContentsId, {
        code: parsedResult.code,
        message: parsedResult.message,
      })
    }
    mainLog.warn(
      '[genui-ui-event] rejected ui-event URL:',
      describeUrlForLog(rawUrl),
      parsedResult.code,
      parsedResult.message,
    )
    return
  }
  const parsed = parsedResult.parsed

  if (!currentDeps) {
    bridge.sendError(parsed.callbackId, senderWebContentsId, {
      code: 'session_not_found',
      message: 'ui-event is not wired in this process',
    })
    return
  }

  // Pair the callback BEFORE validation so every verdict — including the
  // validation failures below — reaches the card that asked (origin pinning
  // happens inside registerCallback).
  const registered = bridge.registerCallback(parsed.callbackId, senderWebContentsId)
  if (!registered.ok) {
    bridge.sendError(parsed.callbackId, senderWebContentsId, registered.error)
    return
  }

  const verdict = validateUiEvent(parsed, senderWebContentsId, {
    registry: currentDeps.registry,
    hasLiveSession: currentDeps.hasLiveSession,
    resolveSessionDataPath: currentDeps.resolveSessionDataPath,
    rateLimiter,
  })
  if (!verdict.ok) {
    bridge.sendError(parsed.callbackId, senderWebContentsId, { code: verdict.code, message: verdict.message })
    mainLog.warn(
      `[genui-ui-event] ui-event rejected (${verdict.code}):`,
      verdict.message,
      `session=${parsed.sessionId} card=${parsed.cardId} sender=${senderWebContentsId}`,
    )
    return
  }

  // A validated event binds this callback to the session: the card now
  // receives the session's whitelisted protocol events (turn lifecycle) via
  // the existing v1 fan-out. Deliberately NOT the send-message session
  // ownership — that stays exclusive to tab protocol pages.
  bridge.bindCallbackToSession(parsed.callbackId, senderWebContentsId, parsed.sessionId)

  // widgetState three-way split (§8 GENUI-09). modelContext: hard 2KB cap,
  // truncated — never rejected — and queued one-shot into the next turn. The
  // queue is bounded; if a teardown race dropped the entry (queue returns
  // false), the event is still acked — the ack means "event accepted", not
  // "state will reach the model".
  let modelContextTruncated = false
  const rawModelContext = (verdict.payload as { modelContext?: unknown }).modelContext
  if (rawModelContext !== undefined && rawModelContext !== null) {
    const asText = typeof rawModelContext === 'string' ? rawModelContext : JSON.stringify(rawModelContext)
    if (asText) {
      const { text, truncated } = truncateGenUiModelContext(asText, GENUI_MODEL_CONTEXT_MAX_BYTES)
      modelContextTruncated = truncated
      currentDeps.queueGenUiModelContext(parsed.sessionId, { cardId: parsed.cardId, context: text })
    }
  }

  // privateState: pushed back to exactly this card — never broadcast, never
  // persisted, never shown to the model.
  const privateState = (verdict.payload as { privateState?: unknown }).privateState
  if (privateState !== undefined) {
    bridge.postUiStateToCard(parsed.callbackId, senderWebContentsId, {
      sessionId: parsed.sessionId,
      cardId: parsed.cardId,
      state: privateState,
      modelContextTruncated,
    })
  }

  currentDeps.registry.touchCard(parsed.sessionId, parsed.cardId)
  bridge.sendUiEventAck(parsed.callbackId, senderWebContentsId, parsed.eventId, parsed.sessionId)
  mainLog.info(
    `[genui-ui-event] accepted ${parsed.type} event: session=${parsed.sessionId} card=${parsed.cardId} sender=${senderWebContentsId}`,
  )
}
