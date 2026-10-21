/**
 * Coded-RPC-error carriage across the Electron context bridge (POO-108 F2).
 *
 * Electron's context bridge re-creates every rejected/thrown native Error in
 * the destination context from its MESSAGE alone
 * (`electron_api_context_bridge.cc` — "Errors aren't serializable currently,
 * we need to pull the message out and re-construct in the destination
 * context"). Custom properties such as `code` never survive, so the renderer
 * cannot branch on the KB error codes the server put on the wire
 * (`kbErrorText`'s whole mapping degraded to the generic text).
 *
 * The bridge layer therefore carries the code IN the message — the one
 * property the clone preserves — and the renderer recovers it with
 * `readRpcErrorCode`. The marker is scoped to the channels that opt in
 * (`codedErrors` in the channel map), so every other surface's error shape is
 * untouched. A direct (non-bridged) client still rejects real coded Errors;
 * `readRpcErrorCode` prefers a live `code` property and only falls back to
 * the marker, so both paths read identically.
 */

/** The head marker distinguishing a bridge-carried coded error message. */
const CODE_MARKER = 'polo-rpc-code:'
const MARKER_END = ':'

/** Encodes a coded error's message for the context-bridge clone. */
export function encodeRpcErrorCodeInMessage(code: string, message: string): string {
  return `${CODE_MARKER}${code}${MARKER_END}${message}`
}

/**
 * Recovers a code from a bridge-carried message, or null when the message
 * carries no marker (a plain failure, or a live coded Error that never
 * crossed the bridge).
 */
export function decodeRpcErrorCodeFromMessage(message: unknown): string | null {
  if (typeof message !== 'string' || !message.startsWith(CODE_MARKER)) return null
  const rest = message.slice(CODE_MARKER.length)
  const end = rest.indexOf(MARKER_END)
  if (end < 0) return rest.length > 0 ? rest : null
  return end > 0 ? rest.slice(0, end) : null
}

/**
 * Strips the bridge marker off a message, leaving the original text for
 * display once the code has been recovered.
 */
export function stripRpcErrorCodeFromMessage(message: unknown): string {
  if (typeof message !== 'string' || !message.startsWith(CODE_MARKER)) {
    return typeof message === 'string' ? message : ''
  }
  const rest = message.slice(CODE_MARKER.length)
  const end = rest.indexOf(MARKER_END)
  return end > 0 ? rest.slice(end + MARKER_END.length) : rest
}

/**
 * The ONE error-code reader the renderer-side KB surface uses: a live `code`
 * property (direct WsRpc/WebUI path) wins; otherwise the bridge marker inside
 * the message is decoded (context-bridge path).
 */
export function readRpcErrorCode(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === 'string' && direct.length > 0) return direct
  return decodeRpcErrorCodeFromMessage((error as { message?: unknown } | null)?.message)
}

/**
 * The bridge-side rewrite: keeps the error an Error (every renderer
 * `instanceof Error ? error.message : …` branch keeps working), carries the
 * code inside the message — the only field the clone preserves — and keeps
 * the live `code` property too, so a client WITHOUT a context bridge in
 * between (the WebUI adapter reuses this channel map) reads it exactly as
 * before. An error without a string code passes through unchanged — nothing
 * else's semantics move.
 */
export function toBridgeCarriableError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || code.length === 0) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const message = error instanceof Error ? error.message : String(error)
  const bridged = new Error(encodeRpcErrorCodeInMessage(code, message))
  ;(bridged as { code?: string }).code = code
  return bridged
}
