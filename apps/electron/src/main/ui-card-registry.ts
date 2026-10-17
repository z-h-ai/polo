/**
 * UiCardRegistry — the two-dimensional ownership model for GenUI canvas cards
 * (POO-103, proposal §7).
 *
 * Dimension 1 (session → card): `sessionId → Map<cardId, UiCardEntry>` records
 * which cardIds are live in which chat session, and which guest webContents
 * each one renders in. Dimension 2 (guest attach): Main observes every
 * `genui-app-<sessionId>` webview attach itself (webview-security) and keeps
 * `guestWebContentsId → GuestAttachRecord` — the renderer's RPC registration
 * is only honored when it agrees with that Main-observed attach record, so a
 * renderer (or a compromised chat window) can never register a cardId pointing
 * at a webContents it does not own.
 *
 * Capabilities follow the ADR-0020 mechanism without its trust root: the
 * capability set is extracted by Main from the exact document the guest
 * attaches with (issue-at-mount) and dies with the attach record (a new
 * document means a new attach, which re-signs). Cards never persist capabilities
 * beyond the attach that declared them.
 *
 * Everything here is in-memory main-process state: registry entries are
 * Re-created on remount and dropped when the session is destroyed.
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  GENUI_BRIDGE_CAPABILITIES_META_NAME,
  GENUI_UI_CARD_ID_PATTERN,
  isValidGenUiUiCardId,
  parseGenUiBridgeCapabilities,
} from '@polo-ai/shared/protocol'
import { validateSessionId } from '@polo-ai/shared/sessions'

/** Hard cap on the document read during capability extraction (fail closed above it). */
const CAPABILITY_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024

export interface GenUiGuestAttachRecord {
  guestWebContentsId: number
  hostWebContentsId: number
  sessionId: string
  partition: string
  /** Bridge capabilities extracted by Main from the attached document. */
  capabilities: string[]
  attachedAt: number
}

export interface UiCardEntry {
  cardId: string
  sessionId: string
  /** The canvas guest webContents that renders this card. */
  webContentsId: number
  hostWebContentsId: number
  capabilities: string[]
  registeredAt: number
  lastActiveAt: number
}

export type RegisterCardVerdict =
  | { ok: true; entry: UiCardEntry }
  | { ok: false; reason: 'invalid_session' | 'invalid_card_id' | 'guest_unknown' | 'guest_session_mismatch' | 'guest_host_mismatch' }

export interface RegisterCardInput {
  sessionId: string
  cardId: string
  guestWebContentsId: number
  hostWebContentsId: number
}

export class UiCardRegistry {
  private readonly cards = new Map<string, Map<string, UiCardEntry>>()
  private readonly guests = new Map<number, GenUiGuestAttachRecord>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /**
   * Record a Main-observed canvas guest attach (from webview-security's
   * did-attach-webview). The capabilities here were extracted from the
   * attached document — the guest re-signs its bridge powers on every attach,
   * and a previous attach record for the same guest (a re-attach after
   * navigation can never happen for genui guests, but defensiveness is cheap)
   * drops the cards that pointed at it.
   */
  noteGuestAttached(record: Omit<GenUiGuestAttachRecord, 'attachedAt'>): void {
    const previous = this.guests.get(record.guestWebContentsId)
    if (previous) {
      this.unregisterCardsForGuest(record.guestWebContentsId)
    }
    this.guests.set(record.guestWebContentsId, { ...record, attachedAt: this.now() })
  }

  /**
   * Drop the attach record and every card registered against this guest —
   * wired from the guest's `destroyed` event, so a closed webview can never
   * keep accepting events attributed to it.
   * Returns the unregistered cardIds (session-qualified) for logging.
   */
  noteGuestDetached(guestWebContentsId: number): Array<{ sessionId: string; cardId: string }> {
    if (!this.guests.delete(guestWebContentsId)) return []
    return this.unregisterCardsForGuest(guestWebContentsId)
  }

  /**
   * Register a mounted card. Only accepted when the claimed guest webContents
   * has a live Main-observed attach record for the same session and the same
   * host window — the renderer reports ids, Main verifies them.
   */
  registerCard(input: RegisterCardInput): RegisterCardVerdict {
    try {
      validateSessionId(input.sessionId)
    } catch {
      return { ok: false, reason: 'invalid_session' }
    }
    if (!isValidGenUiUiCardId(input.cardId) || !GENUI_UI_CARD_ID_PATTERN.test(input.cardId)) {
      return { ok: false, reason: 'invalid_card_id' }
    }

    const attach = this.guests.get(input.guestWebContentsId)
    if (!attach) return { ok: false, reason: 'guest_unknown' }
    if (attach.sessionId !== input.sessionId) return { ok: false, reason: 'guest_session_mismatch' }
    if (attach.hostWebContentsId !== input.hostWebContentsId) {
      return { ok: false, reason: 'guest_host_mismatch' }
    }

    const now = this.now()
    const entry: UiCardEntry = {
      cardId: input.cardId,
      sessionId: input.sessionId,
      webContentsId: input.guestWebContentsId,
      hostWebContentsId: input.hostWebContentsId,
      // Issued from the attach-time document extraction — never from the
      // renderer's claim. Re-registration (React remount) re-signs.
      capabilities: [...attach.capabilities],
      registeredAt: now,
      lastActiveAt: now,
    }

    let byCard = this.cards.get(input.sessionId)
    if (!byCard) {
      byCard = new Map()
      this.cards.set(input.sessionId, byCard)
    }
    byCard.set(input.cardId, entry)
    return { ok: true, entry }
  }

  /** Remove one card registration. Returns whether an entry existed. */
  unregisterCard(sessionId: string, cardId: string): boolean {
    const byCard = this.cards.get(sessionId)
    if (!byCard) return false
    const removed = byCard.delete(cardId)
    if (byCard.size === 0) this.cards.delete(sessionId)
    return removed
  }

  /** Lookup used by every ui-event validation (step 2 of proposal §7.2). */
  getCard(sessionId: string, cardId: string): UiCardEntry | undefined {
    return this.cards.get(sessionId)?.get(cardId)
  }

  /** Touch a card's activity timestamp (ui-event acceptance). */
  touchCard(sessionId: string, cardId: string): void {
    const entry = this.cards.get(sessionId)?.get(cardId)
    if (entry) entry.lastActiveAt = this.now()
  }

  /** Whether any card is registered for the session (without enumerating ids). */
  hasCardsForSession(sessionId: string): boolean {
    const byCard = this.cards.get(sessionId)
    return byCard !== undefined && byCard.size > 0
  }

  getCardCount(sessionId: string): number {
    return this.cards.get(sessionId)?.size ?? 0
  }

  /**
   * Clear every card of one session — wired into the session-destruction hook
   * so a deleted session's cardIds can never validate again.
   */
  clearSession(sessionId: string): number {
    const byCard = this.cards.get(sessionId)
    if (!byCard) return 0
    const count = byCard.size
    this.cards.delete(sessionId)
    return count
  }

  /** Test/shutdown seam: drop all state. */
  clearAll(): void {
    this.cards.clear()
    this.guests.clear()
  }

  private unregisterCardsForGuest(guestWebContentsId: number): Array<{ sessionId: string; cardId: string }> {
    const removed: Array<{ sessionId: string; cardId: string }> = []
    for (const [sessionId, byCard] of this.cards) {
      for (const [cardId, entry] of byCard) {
        if (entry.webContentsId !== guestWebContentsId) continue
        byCard.delete(cardId)
        removed.push({ sessionId, cardId })
      }
      if (byCard.size === 0) this.cards.delete(sessionId)
    }
    return removed
  }
}

// ── Capability extraction (Main-trusted, from the attached document) ─────────

/**
 * Parse the declared bridge capabilities out of a canvas document. `src` is
 * the exact initial webview src Main already validated (data: URL or a
 * generated bundle file: URL). Anything unreadable, oversized, or undeclared
 * yields an empty capability set — the guest simply has no bridge.
 *
 * Only the meta declaration is consulted; there is no Catalog or manifest
 * trust root (ADR-0020 mechanism, not its infrastructure): the declaration
 * lives and dies with this exact document version.
 */
export function extractPoloBridgeCapabilities(src: string): string[] {
  let document: string
  try {
    const parsed = new URL(src)
    if (parsed.protocol === 'data:') {
      const decoded = decodeDataUrlPayload(src)
      if (decoded === null) return []
      document = decoded
    } else if (parsed.protocol === 'file:') {
      const path = fileURLToPathSafe(src)
      if (!path) return []
      const size = statSync(path).size
      if (size > CAPABILITY_DOCUMENT_MAX_BYTES) return []
      document = readFileSync(path, 'utf-8')
    } else {
      return []
    }
  } catch {
    return []
  }
  return extractCapabilitiesFromDocument(document)
}

/** Testable core: find the capabilities meta tag in document markup. */
export function extractCapabilitiesFromDocument(document: string): string[] {
  // The name attribute may precede or follow content; scan the whole tag.
  const metaTagPattern = /<meta\b[^>]*>/gi
  for (const match of document.matchAll(metaTagPattern)) {
    const tag = match[0]
    const namePattern = new RegExp(`\\bname\\s*=\\s*(?:"${GENUI_BRIDGE_CAPABILITIES_META_NAME}"|'${GENUI_BRIDGE_CAPABILITIES_META_NAME}'|${GENUI_BRIDGE_CAPABILITIES_META_NAME}(?=[\\s>]))`, 'i')
    if (!namePattern.test(tag)) continue
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const content = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3]
    return parseGenUiBridgeCapabilities(content)
  }
  return []
}

function decodeDataUrlPayload(src: string): string | null {
  const commaIdx = src.indexOf(',')
  if (commaIdx < 0) return null
  const meta = src.slice('data:'.length, commaIdx)
  const payload = src.slice(commaIdx + 1)
  try {
    if (/;base64$/i.test(meta)) {
      return Buffer.from(payload, 'base64').toString('utf-8')
    }
    return decodeURIComponent(payload)
  } catch {
    return null
  }
}

function fileURLToPathSafe(src: string): string | null {
  try {
    return fileURLToPath(new URL(src))
  } catch {
    return null
  }
}

// ── Process-wide singleton ───────────────────────────────────────────────────

let registry: UiCardRegistry | null = null

export function getUiCardRegistry(): UiCardRegistry {
  if (!registry) registry = new UiCardRegistry()
  return registry
}

/** Test seam. */
export function __resetUiCardRegistryForTests(): void {
  registry = null
}
