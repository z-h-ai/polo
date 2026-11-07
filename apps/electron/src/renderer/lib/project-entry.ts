/**
 * POO-196 R3 (adjudication D13/D14) — project direct-entry session selection.
 *
 * Entering a project must land on the conversation layout "like opening the
 * assistant": the committed project scope's most recent conversation, or an
 * editable empty state when the account has no history there. `openApp` only
 * activates the assistant TAB (atoms/tab-browser POLO branch) and the
 * navigation auto-selection prefers `lastSelectedSessionId` (which may merely
 * be "the session the user last clicked") — neither guarantees the recent
 * project session, so the selection below is explicit and testable.
 *
 * "Recent" binds to ACTUAL conversation activity, never to local selection
 * bookkeeping. An empty session (created but never messaged) is NOT history:
 * entering a project must not fabricate a conversation, and every entry stays
 * zero-write (D14) — session creation happens only on the user's first send.
 */

/** The structural view of a session this module needs. Full Session objects
 * and SessionMeta both satisfy it; scope fields are carried on both. */
export interface ProjectSessionCandidate {
  id: string
  workspaceId: string
  productSpaceId?: string | null
  lastMessageAt?: number | null
  createdAt?: number | null
  /** Renderer-level visibility markers (Session/SessionMeta `hidden`). */
  hidden?: boolean | null
  isFlagged?: boolean | null
  isArchived?: boolean | null
  /** First user message preview (JSONL header projection). */
  preview?: string | null
  /** Session name — set on the first user message. */
  name?: string | null
  /** Final turn marker — present only after real exchanges. */
  lastFinalMessageId?: string | null
}

export interface ProjectSessionSelectionInput {
  accountId: string
  productSpaceId: string
  /** Every session visible to the account in the committed scope's workspace
   * (one fresh `getSessions()` read — never a stale atom snapshot). */
  sessions: readonly ProjectSessionCandidate[]
}

export type ProjectSessionSelection =
  | { kind: 'recent'; sessionId: string }
  | { kind: 'empty' }

/**
 * D13.4-6: pick the most recent REAL conversation of this account's project
 * scope. Candidates must be bound to the committed scope (explicit
 * productSpaceId — sessions missing the field go through the server-side
 * attribution recovery elsewhere, the renderer never guesses scope from
 * workspaceId alone), not hidden, not archived, and actually carry history.
 * Ties break deterministically: lastMessageAt desc → createdAt desc → id
 * code-point ascending.
 */
export function selectProjectSession(
  input: ProjectSessionSelectionInput,
): ProjectSessionSelection {
  const candidates = input.sessions.filter(session => {
    if (session.productSpaceId !== input.productSpaceId) return false
    if (session.hidden) return false
    if (session.isArchived) return false
    // "Has history" mirrors the app's own empty-session test (a session is
    // empty iff it has no final marker AND no name): `lastMessageAt` alone
    // exists on freshly created sessions (it equals the creation time), so
    // it can never certify a real conversation. An UNKNOWN state must not be
    // treated as empty either — the three signals below are all affirmative.
    const hasHistory = (typeof session.preview === 'string' && session.preview.length > 0)
      || (typeof session.name === 'string' && session.name.length > 0)
      || (session.lastFinalMessageId ?? null) !== null
    return hasHistory
  })
  if (candidates.length === 0) return { kind: 'empty' }
  const decorated = candidates.map(session => ({
    session,
    last: session.lastMessageAt ?? 0,
    created: session.createdAt ?? 0,
  }))
  decorated.sort((left, right) => {
    if (left.last !== right.last) return right.last - left.last
    if (left.created !== right.created) return right.created - left.created
    return left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0
  })
  return { kind: 'recent', sessionId: decorated[0].session.id }
}

/**
 * D13 entry fencing: an entry generation is invalidated by any account/scope
 * change so a slow entry can never land a stale selection into another
 * account's project. The hook pairs this with the committed-scope check from
 * the product-space transaction; this helper centralises the comparison so
 * both the await path and the effect path agree.
 */
export function entryScopeMatches(input: {
  accountId: string | null
  activeProductSpaceId: string | null
  pendingSwitchId: string | null
  target: { accountId: string; productSpaceId: string }
}): boolean {
  return input.accountId === input.target.accountId
    && input.activeProductSpaceId === input.target.productSpaceId
    && input.pendingSwitchId === null
}
