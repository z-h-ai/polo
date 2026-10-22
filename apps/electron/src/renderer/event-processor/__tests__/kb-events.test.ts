import { describe, expect, it } from 'bun:test'
import { processEvent } from '../processor'
import type { KbCollectionsChangedEvent, SessionState, UserMessageEvent } from '../types'
import type { Message } from '../../../shared/types'

/**
 * KB renderer-side event contracts (POO-108 review fixes #8 and #11):
 * the server's authoritative collection scope converges every window via
 * `kb_collections_changed`, and the optimistic user message merges the
 * canonical `kbReferences` snapshot instead of dropping it.
 */

function state(messages: Message[]): SessionState {
  return {
    session: {
      id: 'session-1',
      workspaceId: 'ws-one',
      createdAt: 1,
      lastUsedAt: 1,
      messages,
    },
    streaming: null,
  } as unknown as SessionState
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-optimistic',
    role: 'user',
    content: 'how do I book flights?',
    timestamp: 1_000,
    isPending: true,
    ...overrides,
  } as Message
}

function userMessageEvent(message: Message): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message,
    status: 'processing',
    optimisticMessageId: 'msg-optimistic',
  }
}

describe('kb_collections_changed event', () => {
  it('writes the server-authoritative scope onto the session', () => {
    const event: KbCollectionsChangedEvent = {
      type: 'kb_collections_changed',
      sessionId: 'session-1',
      collectionIds: ['kb-a', 'kb-b'],
    }
    const result = processEvent(state([]), event)
    expect(result.state.session.kbCollectionIds).toEqual(['kb-a', 'kb-b'])
    expect(result.effects).toEqual([])
    // New reference, untouched message list.
    expect(result.state).not.toBe(state)
    expect(result.state.session.messages).toEqual([])
  })

  it('clears the scope when another window removed every collection', () => {
    const current = state([])
    current.session.kbCollectionIds = ['kb-a']
    const result = processEvent(current, {
      type: 'kb_collections_changed',
      sessionId: 'session-1',
      collectionIds: [],
    })
    expect(result.state.session.kbCollectionIds).toEqual([])
  })
})

describe('user_message kbReferences merge (review #8)', () => {
  const canonicalReferences = [
    { docId: 'kb-doc-1', collectionId: 'kb-a', collectionName: 'Handbook', title: 'Travel policy', snippet: '…', score: 4 },
  ]

  it('merges the canonical snapshot into the optimistic message', () => {
    const optimistic = userMessage() // created before the server resolved references
    const confirmed = userMessage({
      id: 'msg-server',
      isPending: false,
      kbReferences: canonicalReferences,
    })
    const result = processEvent(state([optimistic]), userMessageEvent(confirmed))

    const messages = result.state.session.messages
    expect(messages).toHaveLength(1)
    // The optimistic id survives (turn keys and timers depend on it)…
    expect(messages[0].id).toBe('msg-optimistic')
    expect(messages[0].isPending).toBe(false)
    // …and the reference chips render without a reload.
    expect(messages[0].kbReferences).toEqual(canonicalReferences)
  })

  it('never overwrites references the optimistic message already carries', () => {
    const localReferences = [
      { docId: 'kb-local', collectionId: 'kb-a', collectionName: 'Handbook', title: 'Local', snippet: '…', score: 1 },
    ]
    const optimistic = userMessage({ kbReferences: localReferences })
    const confirmed = userMessage({
      id: 'msg-server',
      isPending: false,
      kbReferences: canonicalReferences,
    })
    const result = processEvent(state([optimistic]), userMessageEvent(confirmed))
    expect(result.state.session.messages[0].kbReferences).toEqual(localReferences)
  })

  it('keeps the message unchanged when the event carries no references', () => {
    const optimistic = userMessage()
    const confirmed = userMessage({ id: 'msg-server', isPending: false })
    const result = processEvent(state([optimistic]), userMessageEvent(confirmed))
    expect(result.state.session.messages[0].kbReferences).toBeUndefined()
  })
})
