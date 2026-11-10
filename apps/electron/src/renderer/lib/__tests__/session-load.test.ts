import { describe, expect, it } from 'bun:test'
import type { Session, TransportConnectionState } from '../../../shared/types'
import { deriveSessionMessagesLoadState, formatSessionLoadFailure, isSessionSendBlockedByLoadState, shouldTreatSessionLoadFailureAsTransportFallback } from '../session-load'

function createState(overrides?: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

describe('deriveSessionMessagesLoadState', () => {
  it('loads metadata-only sessions that are not marked loaded', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('treats in-memory messages as ready even when the loaded flag is stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
    })

    expect(state.hasInMemoryMessages).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats loaded empty sessions as ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 0 }),
      sessionMeta: { messageCount: 0 },
      messagesLoaded: true,
    })

    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats an empty loaded atom with expected messages as stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: true,
    })

    expect(state.hasStaleLoadedFlag).toBe(true)
    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('surfaces load errors instead of continuing to load forever', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
      loadError: 'boom',
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(false)
    expect(state.error).toBe('boom')
  })

  it('clears stale load errors once messages are ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'assistant', content: 'ready', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
      loadError: 'old failure',
    })

    expect(state.messagesReady).toBe(true)
    expect(state.error).toBe(null)
  })
})

describe('shouldTreatSessionLoadFailureAsTransportFallback', () => {
  it('returns true for remote reconnecting state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'reconnecting' }),
    )).toBe(true)
  })

  it('returns true for remote auth/network/timeout failures', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({
        status: 'connected',
        lastError: { kind: 'auth', message: 'Bad token' },
      }),
    )).toBe(true)
  })

  it('returns false for remote connected state without transport errors', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'connected' }),
    )).toBe(false)
  })

  it('returns false for local transport state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ mode: 'local', status: 'failed' }),
    )).toBe(false)
  })
})

// POO-205 C5 (X2): the composer send block is exactly "not ready AND an
// error is showing" — a load still in flight must never block.
describe('isSessionSendBlockedByLoadState', () => {
  function loadState(overrides: Partial<Parameters<typeof deriveSessionMessagesLoadState>[0]> = {}) {
    return deriveSessionMessagesLoadState({
      session: null,
      sessionMeta: null,
      messagesLoaded: false,
      ...overrides,
    })
  }

  it('blocks when the load failed and nothing is ready', () => {
    expect(isSessionSendBlockedByLoadState(loadState({ loadError: 'boom' }))).toBe(true)
  })

  it('does not block while the load is still in flight (no error yet)', () => {
    expect(isSessionSendBlockedByLoadState(loadState())).toBe(false)
  })

  it('does not block once messages are ready, even with a stale error string', () => {
    expect(isSessionSendBlockedByLoadState(loadState({
      messagesLoaded: true,
      session: { messages: [{ id: 'm1' }] } as Session,
      loadError: 'stale',
    }))).toBe(false)
  })

  it('does not block for a known-empty session with an error string', () => {
    expect(isSessionSendBlockedByLoadState(loadState({
      messagesLoaded: true,
      session: { id: 's1', messages: [], messageCount: 0 } as unknown as Session,
      loadError: 'stale',
    }))).toBe(false)
  })
})

describe('formatSessionLoadFailure', () => {
  it('prefers Error.message', () => {
    expect(formatSessionLoadFailure(new Error('boom'))).toBe('boom')
  })

  it('falls back to a generic message', () => {
    expect(formatSessionLoadFailure(null)).toBe('Unknown error')
  })
})
