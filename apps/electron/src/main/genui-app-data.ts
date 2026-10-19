/**
 * GenUI canvas app data channel (P1-3/P2-1) — Main-side owner.
 *
 * A generate_app bundle declares its mutable-state JSON files with
 * `<meta name="polo-app-data" content="data/state.json">` (paths relative to
 * the session data/ directory). Main reads that declaration from the exact
 * attached document at did-attach (same issue-at-mount discipline as the
 * bridge capabilities — no manifest trust root), reads the declared files
 * behind the data/ fence, and pushes their content to the mounted card as a
 * `ui_state` protocol event over the existing DeepLinkCallbackBridge
 * point-to-point channel. This is what makes data iteration work under file:
 * where the guest's own fetch is unavailable.
 *
 * Security model (fail closed, zero new trust roots):
 * - Every read goes through readGenUiAppDataFile: the declared path —
 *   relative or absolute-inside-data — must, AFTER realpath resolution, stay
 *   inside the session data/ directory (the payloadSrc validation, shared
 *   constants). Symlinks, `..` segments and absolute escapes are rejected,
 *   never clamped; files are capped at GENUI_APP_DATA_MAX_FILE_BYTES and
 *   re-checked after read (stat/read races).
 * - Declarations are capped per card (GENUI_APP_DATA_MAX_FILES_PER_CARD) by
 *   the shared parser; only DECLARED files are ever read or pushed — there is
 *   no path from the model or the card to an undeclared file's content.
 * - Pushes travel postUiStateToCard on a state callback Main registers for
 *   the exact guest webContents — the bridge's ownership checks stay
 *   meaningful; ui_state remains ephemeral and is never persisted, and no
 *   data ever leaves the data/ fence.
 *
 * Lifecycle: channels are created on guest attach and released on card
 * unregistration (UNREGISTER_UI_CARD), guest destruction, and session
 * teardown — a released channel stops every push for its card.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  GENUI_APP_DATA_MAX_FILE_BYTES,
  GENUI_APP_DATA_MAX_SRC_LENGTH,
  isValidGenUiUiCardId,
} from '@polo-ai/shared/protocol'
import { extractPoloAppDataDeclarations } from './ui-card-registry'
import { mainLog } from './logger'

// ── The data/ fence (shared by injection, update push and the P2-1 watcher) ──

export type AppDataReadVerdict =
  | { ok: true; state: unknown }
  | { ok: false; reason: string }

/**
 * Read one declared data file behind the session data/ fence. This is the
 * payloadSrc confinement applied to the app-data declaration: relative paths
 * resolve against `dataDir`, absolute paths must already be inside it, and
 * the verdict is decided in real-path space so symlinks cannot walk out.
 * Content is bounded before AND after the read and must parse as JSON.
 */
export function readGenUiAppDataFile(dataDir: string, declaredPath: string): AppDataReadVerdict {
  if (
    typeof declaredPath !== 'string'
    || declaredPath.length === 0
    || declaredPath.length > GENUI_APP_DATA_MAX_SRC_LENGTH
    || declaredPath.includes('\0')
  ) {
    return { ok: false, reason: 'data declaration is malformed' }
  }
  let realBoundary: string
  try {
    realBoundary = realpathSync(dataDir)
  } catch {
    return { ok: false, reason: 'session data directory is unavailable' }
  }
  const candidate = isAbsolute(declaredPath) ? resolve(declaredPath) : resolve(dataDir, declaredPath)
  let realCandidate: string
  try {
    realCandidate = realpathSync(candidate)
  } catch {
    return { ok: false, reason: 'declared data file does not exist' }
  }
  if (!isWithinRealPath(realBoundary, realCandidate)) {
    return { ok: false, reason: 'declared data file escapes the session data directory' }
  }
  let raw: string
  try {
    const size = statSync(realCandidate).size
    if (size > GENUI_APP_DATA_MAX_FILE_BYTES) {
      return { ok: false, reason: `declared data file exceeds ${GENUI_APP_DATA_MAX_FILE_BYTES} bytes` }
    }
    raw = readFileSync(realCandidate, 'utf-8')
  } catch (error) {
    return { ok: false, reason: `declared data file is unreadable: ${toMessage(error)}` }
  }
  // Re-check post-read: stat/read races must not slip oversized content through.
  if (Buffer.byteLength(raw, 'utf8') > GENUI_APP_DATA_MAX_FILE_BYTES) {
    return { ok: false, reason: `declared data file exceeds ${GENUI_APP_DATA_MAX_FILE_BYTES} bytes` }
  }
  try {
    return { ok: true, state: JSON.parse(raw) as unknown }
  } catch (error) {
    return { ok: false, reason: `declared data file is not valid JSON: ${toMessage(error)}` }
  }
}

/**
 * Separator-aware containment in real-path space (path.relative semantics, so
 * no sibling-prefix bypass) — genui-ui-event.ts isWithinRealPath precedent.
 */
function isWithinRealPath(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Channel registry ─────────────────────────────────────────────────────────

/**
 * The bridge surface this module consumes — the real DeepLinkCallbackBridge
 * satisfies it structurally; tests stand in with a fake. Narrow on purpose:
 * the state callback is registered and bound by Main itself, so every push
 * rides the bridge's ownership checks.
 */
export interface GenUiAppDataBridge {
  registerCallback(callbackId: string, webContentsId: number): { ok: boolean; error?: unknown }
  bindCallbackToSession(callbackId: string, webContentsId: number, sessionId: string): { ok: boolean }
  postUiStateToCard(
    callbackId: string,
    webContentsId: number,
    event: { sessionId: string; cardId: string; state: unknown; modelContextTruncated: boolean },
  ): void
}

export interface GenUiAppDataDeps {
  bridge: GenUiAppDataBridge
  /** Same managed-vs-storage data/ resolver the ui-event wiring uses. */
  resolveSessionDataPath: (sessionId: string) => string | null
}

interface GenUiAppDataChannel {
  sessionId: string
  cardId: string
  appId: string
  guestWebContentsId: number
  hostWebContentsId: number
  /** Main-registered callback id this card's ui_state pushes travel on. */
  stateCallbackId: string
  /** Raw declared paths (data-dir-relative or absolute-inside-data). */
  declarations: string[]
}

const channelsBySession = new Map<string, Map<string, GenUiAppDataChannel>>()
const channelsByGuest = new Map<number, GenUiAppDataChannel>()

let deps: GenUiAppDataDeps | null = null

/** Wire the process-wide deps — called from the genui RPC handler registration. */
export function setGenUiAppDataDeps(next: GenUiAppDataDeps | null): void {
  deps = next
}

/** Test/shutdown seam: drop every channel and dep. */
export function __resetGenUiAppDataForTests(): void {
  deps = null
  channelsBySession.clear()
  channelsByGuest.clear()
}

const GENUI_APP_PATH_PATTERN = /[/]genui-apps[/]([A-Za-z0-9][A-Za-z0-9_-]*)[/]index\.html$/

/**
 * The guest identity Main can derive from the validated initial src: the
 * renderer appends `?poloCard=…` to the file: URL (the bundle reads its own
 * ids from there), and the bundle path names the app id. Both are re-derived
 * here — never taken from an RPC claim.
 */
function parseGuestIdentityFromSrc(src: string): { cardId: string; appId: string } | null {
  try {
    const url = new URL(src)
    if (url.protocol !== 'file:') return null
    const cardId = url.searchParams.get('poloCard') ?? ''
    if (!isValidGenUiUiCardId(cardId)) return null
    const match = GENUI_APP_PATH_PATTERN.exec(url.pathname)
    const appId = match?.[1]
    if (!appId) return null
    return { cardId, appId }
  } catch {
    return null
  }
}

/**
 * Observe a canvas guest attach (wired from webview-security's did-attach, by
 * the genui RPC handler registration). Builds the card's data channel from
 * the attach-time document declaration and injects the current data content.
 * Anything unparsable/undeclared/unresolvable simply creates no channel.
 */
export function observeGenUiGuestForAppData(info: {
  sessionId: string
  guestWebContentsId: number
  hostWebContentsId: number
  src: string
}): void {
  try {
    const identity = parseGuestIdentityFromSrc(info.src)
    if (!identity) return
    const declarations = extractPoloAppDataDeclarations(info.src)
    if (declarations.length === 0) return
    if (!deps?.resolveSessionDataPath(info.sessionId)) return

    // A re-attach of the same guest replaces its previous channel (the old
    // document's declarations are dead with their attach record).
    releaseGenUiAppDataForGuest(info.guestWebContentsId)
    const channel: GenUiAppDataChannel = {
      sessionId: info.sessionId,
      cardId: identity.cardId,
      appId: identity.appId,
      guestWebContentsId: info.guestWebContentsId,
      hostWebContentsId: info.hostWebContentsId,
      stateCallbackId: `polo-data-${randomBytes(8).toString('hex')}`,
      declarations,
    }
    let byCard = channelsBySession.get(info.sessionId)
    if (!byCard) {
      byCard = new Map()
      channelsBySession.set(info.sessionId, byCard)
    }
    byCard.set(channel.cardId, channel)
    channelsByGuest.set(channel.guestWebContentsId, channel)

    // Initial injection (P1-3): the attached card starts with current data.
    injectGenUiAppDataForChannel(channel)
    // P2-1 (auto-refresh) registers its per-declaration watchers here.
  } catch (error) {
    mainLog.warn('[genui-app-data] guest observation failed:', toMessage(error))
  }
}

/**
 * Re-inject after the guest document is ready (wired from webview-security's
 * guest dom-ready): the attach-time push can outrun the page's message
 * listener, so the same validated content is delivered once more when the
 * document can actually receive it. Idempotent for the app (state set).
 */
export function injectGenUiAppDataForGuest(guestWebContentsId: number): void {
  const channel = channelsByGuest.get(guestWebContentsId)
  if (!channel) return
  injectGenUiAppDataForChannel(channel)
}

function injectGenUiAppDataForChannel(channel: GenUiAppDataChannel): void {
  const dataDir = deps?.resolveSessionDataPath(channel.sessionId)
  if (!dataDir) return
  for (const declaration of channel.declarations) {
    pushDeclaration(channel, dataDir, declaration)
  }
}

/** Read one path behind the fence and push it to the channel's card. */
function pushDeclaration(channel: GenUiAppDataChannel, dataDir: string, dataPath: string): boolean {
  const verdict = readGenUiAppDataFile(dataDir, dataPath)
  if (!verdict.ok) {
    mainLog.warn(
      `[genui-app-data] skipped data push for card ${channel.cardId}: ${verdict.reason}`,
    )
    return false
  }
  return postUiState(channel, verdict.state)
}

function postUiState(channel: GenUiAppDataChannel, state: unknown): boolean {
  const bridge = deps?.bridge
  if (!bridge) return false
  // Ensure the state callback is alive: the bridge's 30-minute TTL cleans
  // idle entries, so every push re-asserts registration + session binding
  // (idempotent for an existing entry on the same webContents).
  const registered = bridge.registerCallback(channel.stateCallbackId, channel.guestWebContentsId)
  if (!registered.ok) return false
  const bound = bridge.bindCallbackToSession(channel.stateCallbackId, channel.guestWebContentsId, channel.sessionId)
  if (!bound.ok) return false
  bridge.postUiStateToCard(channel.stateCallbackId, channel.guestWebContentsId, {
    sessionId: channel.sessionId,
    cardId: channel.cardId,
    state,
    modelContextTruncated: false,
  })
  return true
}

// ── Push entry points ────────────────────────────────────────────────────────

/**
 * P1-3: push one freshly written app data file to the mounted card(s) of one
 * app id in one session (the update_app_data notification). Returns how many
 * cards received the update. The path is re-validated through the same fence
 * as every other read — a write can never smuggle an escape in at push time.
 */
export function pushGenUiAppDataUpdate(sessionId: string, appId: string, dataPath: string): number {
  const dataDir = deps?.resolveSessionDataPath(sessionId)
  if (!dataDir) return 0
  const byCard = channelsBySession.get(sessionId)
  if (!byCard) return 0
  let pushed = 0
  for (const channel of byCard.values()) {
    if (channel.appId !== appId) continue
    if (pushDeclaration(channel, dataDir, dataPath)) pushed += 1
  }
  return pushed
}

/**
 * True when the channel declared (and the fence resolves) exactly this file —
 * the P2-1 watcher's point-to-point routing predicate.
 */
function declaresResolvedPath(channel: GenUiAppDataChannel, dataDir: string, realDataPath: string): boolean {
  for (const declaration of channel.declarations) {
    const candidate = isAbsolute(declaration) ? resolve(declaration) : resolve(dataDir, declaration)
    try {
      if (realpathSync(candidate) === realDataPath) return true
    } catch {
      // Not resolvable right now — cannot match a fired change either.
    }
  }
  return false
}

/**
 * P2-1: push a changed data file to exactly the card(s) in this session that
 * DECLARED it. Never a broadcast: an undeclared file matches nothing.
 */
export function pushGenUiAppDataToDeclared(sessionId: string, dataPath: string): number {
  const dataDir = deps?.resolveSessionDataPath(sessionId)
  if (!dataDir) return 0
  const byCard = channelsBySession.get(sessionId)
  if (!byCard) return 0
  let realDataPath: string
  try {
    realDataPath = realpathSync(dataPath)
  } catch {
    return 0
  }
  let pushed = 0
  for (const channel of byCard.values()) {
    if (!declaresResolvedPath(channel, dataDir, realDataPath)) continue
    if (pushDeclaration(channel, dataDir, dataPath)) pushed += 1
  }
  return pushed
}

// ── Lifecycle teardown (watcher/push channels die with their owners) ─────────

/** Release one card's channel (card unmount / unregister). */
export function releaseGenUiAppDataChannel(sessionId: string, cardId: string): void {
  const byCard = channelsBySession.get(sessionId)
  const channel = byCard?.get(cardId)
  if (!byCard || !channel) return
  byCard.delete(cardId)
  if (byCard.size === 0) channelsBySession.delete(sessionId)
  if (channelsByGuest.get(channel.guestWebContentsId) === channel) {
    channelsByGuest.delete(channel.guestWebContentsId)
  }
  // P2-1: the channel's watcher references are dropped here too.
}

/** Release the channel bound to one guest webContents (guest destroyed). */
export function releaseGenUiAppDataForGuest(guestWebContentsId: number): void {
  const channel = channelsByGuest.get(guestWebContentsId)
  if (!channel) return
  releaseGenUiAppDataChannel(channel.sessionId, channel.cardId)
}

/** Session teardown: drop every channel (and watcher) of one session. */
export function clearGenUiAppDataForSession(sessionId: string): void {
  const byCard = channelsBySession.get(sessionId)
  if (!byCard) return
  for (const channel of byCard.values()) {
    if (channelsByGuest.get(channel.guestWebContentsId) === channel) {
      channelsByGuest.delete(channel.guestWebContentsId)
    }
  }
  channelsBySession.delete(sessionId)
}
