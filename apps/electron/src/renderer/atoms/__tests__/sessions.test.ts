import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  removeSessionAtom,
  reduceGoalProjection,
  applyGoalProjectionAtom,
  goalStartIntentForSession,
  goalProjectionAtomFamily,
  goalExpandedAtomFamily,
  goalModeActiveAtomFamily,
} from '../sessions'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('session message loading atoms', () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('replaceLoadedSessionAtom marks authoritative full sessions as loaded', () => {
    const store = createStore()
    const sessionId = 'session-1'

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))

    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get(sessionId)?.messageCount).toBe(2)
  })

  it('forceSessionMessagesReloadAtom reloads an empty-but-loaded session', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const normalResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(calls).toEqual([])
    expect(normalResult?.messages).toHaveLength(0)

    const forcedResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId])
    expect(forcedResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('does not mark stale empty-response fallback as loaded', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          if (calls.length === 1) {
            return makeSession({ id, messages: [] })
          }
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('local-1'), msg('local-2', 'assistant')],
    }))

    const firstResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(firstResult?.messages.map((message) => message.id)).toEqual(['local-1', 'local-2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)

    const secondResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId, sessionId])
    expect(secondResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })
})

describe('refreshSessionsMetadataAtom', () => {
  it('preserves messages for already-loaded sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    // Pre-populate: session has messages and is marked loaded
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    // Refresh with metadata-only payload (empty messages, like getSessions returns)
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    // Messages should be preserved from the existing atom
    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('marks sessions as unloaded when atom was cleared but loadedSessionIds still tracked them', () => {
    const store = createStore()

    // Session was previously loaded, but its atom was cleared (e.g., by remove + re-add)
    // while loadedSessionsAtom still tracks it. The atom value is null.
    store.set(loadedSessionsAtom, new Set(['s1']))
    // sessionAtomFamily('s1') defaults to null — no store.set needed

    // Refresh — s1 is in loadedSessionIds but current atom is null,
    // so shouldPreserveMessages is false. Since it was in loadedSessionIds,
    // it should be removed so lazy-loading re-fetches messages.
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('removes stale sessions from all atoms', () => {
    const store = createStore()

    // Initialize with two sessions via initializeSessionsAtom
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    expect(store.get(sessionMetaMapAtom).size).toBe(2)
    expect(store.get(sessionIdsAtom)).toContain('s2')

    // Refresh with only s1 — s2 should be removed
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1' })],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom).has('s2')).toBe(false)
    expect(store.get(sessionIdsAtom)).not.toContain('s2')
    expect(store.get(sessionAtomFamily('s2'))).toBe(null)
  })

  it('preserves omitted sessions when removeMissing is false', () => {
    const store = createStore()

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ])

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', lastMessageAt: 300 })],
      loadedSessionIds: new Set<string>(),
      removeMissing: false,
    })

    expect(result.has('s1')).toBe(true)
    expect(result.has('s2')).toBe(true)
    expect(result.get('s1')?.name).toBe('First refreshed')
    expect(result.get('s2')?.name).toBe('Second')

    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.has('s2')).toBe(true)
    expect(store.get(sessionIdsAtom)).toEqual(['s1', 's2'])
    expect(store.get(sessionAtomFamily('s2'))?.name).toBe('Second')
  })

  it('non-destructive refresh still preserves loaded messages for returned sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', messages: [] }),
      makeSession({ id: 's2', name: 'Second', messages: [] }),
    ])
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', name: 'First', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', messages: [] })],
      loadedSessionIds: new Set(['s1']),
      removeMissing: false,
    })

    expect(store.get(sessionAtomFamily('s1'))?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('First refreshed')
    expect(store.get(sessionMetaMapAtom).get('s2')?.name).toBe('Second')
  })

  it('updates metadata map and returns it', () => {
    const store = createStore()

    const sessions = [
      makeSession({ id: 's1', name: 'First' }),
      makeSession({ id: 's2', name: 'Second' }),
    ]

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })

    // Returned map matches store state
    expect(result.size).toBe(2)
    expect(result.get('s1')?.name).toBe('First')
    expect(result.get('s2')?.name).toBe('Second')

    // Store is consistent
    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.size).toBe(2)
    expect(storeMap.get('s1')?.name).toBe('First')

    // IDs are set
    expect(store.get(sessionIdsAtom)).toHaveLength(2)
  })
})

const activeProjection = (revision: number, goalId = 'goal-a') => ({
  revision,
  sessionId: 's1',
  currentGoalId: goalId,
  goal: {
    id: goalId,
    sessionId: 's1',
    anchorMessageId: 'm1',
    objective: 'obj',
    supplementMessageIds: [],
    status: 'active' as const,
    version: 1,
    runGeneration: 1,
    elapsedMs: 0,
    criteria: [],
    todos: [],
    createdAt: 1,
    updatedAt: 1,
  },
})
const terminalProjection = (revision: number, goalId = 'goal-a') => ({
  revision,
  sessionId: 's1',
  goal: {
    id: goalId,
    sessionId: 's1',
    anchorMessageId: 'm1',
    objective: 'obj',
    supplementMessageIds: [],
    status: 'completed' as const,
    version: 9,
    runGeneration: 1,
    elapsedMs: 100,
    criteria: [],
    todos: [],
    createdAt: 1,
    updatedAt: 2,
  },
})

describe('reduceGoalProjection (POO-134 revision gate)', () => {
  const active = activeProjection
  const terminal = terminalProjection

  it('accepts the first projection regardless of revision', () => {
    const reduction = reduceGoalProjection(null, active(1))
    expect(reduction).not.toBeNull()
    expect(reduction?.next.revision).toBe(1)
    expect(reduction?.collapsePanel).toBe(true)
  })

  it('drops stale and equal revisions so late events never regress state', () => {
    const current = active(7, 'goal-b')
    expect(reduceGoalProjection(current, terminal(7))).toBeNull()
    expect(reduceGoalProjection(current, terminal(3))).toBeNull()
  })

  it('keeps the panel open for same-goal progress and collapses on a new goal id', () => {
    const current = active(2, 'goal-a')
    const progress = reduceGoalProjection(current, active(3, 'goal-a'))
    expect(progress?.collapsePanel).toBe(false)
    const newGoal = reduceGoalProjection(current, active(4, 'goal-b'))
    expect(newGoal?.collapsePanel).toBe(true)
  })
})

describe('applyGoalProjectionAtom + 发送链 (POO-134 review F1)', () => {
  const sessionId = 's1'

  it('armed → send carries goalIntent → non-terminal projection disarms → next send carries none', () => {
    const store = createStore()
    store.set(goalModeActiveAtomFamily(sessionId), true)

    // First send: the armed intent declares the Goal start.
    expect(goalStartIntentForSession(store.get, sessionId))
      .toEqual({ goalIntent: { action: 'start' } })

    // Server accepted the start — the authoritative projection (rev 1,
    // non-terminal) arrives through the SAME gate as the event stream.
    store.set(applyGoalProjectionAtom, sessionId, activeProjection(1))

    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(false)
    expect(store.get(goalProjectionAtomFamily(sessionId))?.revision).toBe(1)
    // Follow-up message during the run: NO goalIntent — a repeated start
    // would be rejected by the server ("a goal is already active").
    expect(goalStartIntentForSession(store.get, sessionId)).toBeUndefined()
  })

  it('hydration pull of a non-terminal projection disarms a stale armed intent (他端建 Goal)', () => {
    const store = createStore()
    store.set(goalModeActiveAtomFamily(sessionId), true)

    // No prior event stream state: the very first projection is a hydration
    // receipt of a Goal another client created.
    store.set(applyGoalProjectionAtom, sessionId, activeProjection(4, 'goal-remote'))

    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(false)
    expect(goalStartIntentForSession(store.get, sessionId)).toBeUndefined()
    expect(store.get(goalProjectionAtomFamily(sessionId))?.currentGoalId).toBe('goal-remote')
  })

  it('terminal projection still disarms and collapses; panel state follows the reduction', () => {
    const store = createStore()
    store.set(goalModeActiveAtomFamily(sessionId), true)
    store.set(applyGoalProjectionAtom, sessionId, activeProjection(1))
    store.set(goalExpandedAtomFamily(sessionId), true)

    store.set(applyGoalProjectionAtom, sessionId, terminalProjection(2))

    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(false)
    expect(store.get(goalExpandedAtomFamily(sessionId))).toBe(false)
  })

  it('journey #5: a terminal projection RETAINS the goal record for the read-only strip', () => {
    const store = createStore()
    store.set(applyGoalProjectionAtom, sessionId, terminalProjection(3))
    const projection = store.get(goalProjectionAtomFamily(sessionId))
    // currentGoalId is cleared (the Goal no longer owns the session) but the
    // last record survives so the strip can re-render it read-only after
    // re-entering the session.
    expect(projection?.currentGoalId).toBeUndefined()
    expect(projection?.goal?.status).toBe('completed')
    expect(projection?.goal?.id).toBe('goal-a')
  })

  it('same-goal progress keeps the panel open; a stale replay drops without touching armed', () => {
    const store = createStore()
    store.set(applyGoalProjectionAtom, sessionId, activeProjection(1, 'goal-a'))
    store.set(goalExpandedAtomFamily(sessionId), true)

    // Same-Goal progress: panel stays open.
    store.set(applyGoalProjectionAtom, sessionId, activeProjection(2, 'goal-a'))
    expect(store.get(goalExpandedAtomFamily(sessionId))).toBe(true)

    // Late replay of an old terminal event for the SAME goal: dropped by the
    // revision gate — must not disarm or regress anything.
    store.set(goalModeActiveAtomFamily(sessionId), true)
    store.set(applyGoalProjectionAtom, sessionId, terminalProjection(1, 'goal-a'))
    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(true)
    expect(store.get(goalExpandedAtomFamily(sessionId))).toBe(true)
  })
})

describe('goal atom families cleanup (POO-134 review F2)', () => {
  it('removeSessionAtom drops projection/expanded/armed atoms for the deleted session', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [makeSession({ id: 's1' })])
    store.set(goalProjectionAtomFamily('s1'), activeProjection(1))
    store.set(goalExpandedAtomFamily('s1'), true)
    store.set(goalModeActiveAtomFamily('s1'), true)

    store.set(removeSessionAtom, 's1')

    expect(store.get(goalProjectionAtomFamily('s1'))).toBeNull()
    expect(store.get(goalExpandedAtomFamily('s1'))).toBe(false)
    expect(store.get(goalModeActiveAtomFamily('s1'))).toBe(false)
  })

  it('initializeSessionsAtom drops goal atoms of sessions missing from the new workspace', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    store.set(goalProjectionAtomFamily('s2'), activeProjection(1))
    store.set(goalExpandedAtomFamily('s2'), true)
    store.set(goalModeActiveAtomFamily('s2'), true)

    // Workspace switch: s2 no longer exists in the returned list.
    store.set(initializeSessionsAtom, [makeSession({ id: 's1' })])

    expect(store.get(goalProjectionAtomFamily('s2'))).toBeNull()
    expect(store.get(goalExpandedAtomFamily('s2'))).toBe(false)
    expect(store.get(goalModeActiveAtomFamily('s2'))).toBe(false)
  })
})
