import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { entryScopeMatches, selectProjectSession } from '../project-entry'
import {
  PROJECT_ENTRY_IDLE,
  emptyDraftKey,
  isEntryFailedState,
  isEntryPendingState,
  projectEntryAtom,
  projectEntryPendingAtom,
  projectEntrySendNoticesAtom,
  type ProjectEntryState,
} from '../../atoms/project-entry'

const base = {
  accountId: 'account-1',
  productSpaceId: 'project-1',
}

describe('selectProjectSession', () => {
  test('picks the most recent real conversation in the committed scope', () => {
    const selection = selectProjectSession({
      ...base,
      sessions: [
        { id: 'a', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, preview: 'old' },
        { id: 'b', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 300, preview: 'new' },
        { id: 'c', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 200, preview: 'mid' },
      ],
    })
    expect(selection).toEqual({ kind: 'recent', sessionId: 'b' })
  })

  test('ignores sessions of other scopes and the personal space', () => {
    const selection = selectProjectSession({
      ...base,
      sessions: [
        { id: 'other', workspaceId: 'w1', productSpaceId: 'project-2', lastMessageAt: 999, preview: 'foreign' },
        { id: 'nostatic', workspaceId: 'w1', lastMessageAt: 999, preview: 'legacy-no-scope' },
        { id: 'mine', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 10, preview: 'mine' },
      ],
    })
    expect(selection).toEqual({ kind: 'recent', sessionId: 'mine' })
  })

  test('hidden and archived sessions are not candidates', () => {
    const selection = selectProjectSession({
      ...base,
      sessions: [
        { id: 'hidden', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 999, preview: 'x', hidden: true },
        { id: 'archived', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 999, preview: 'x', isArchived: true },
        { id: 'live', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 1, preview: 'y' },
      ],
    })
    expect(selection).toEqual({ kind: 'recent', sessionId: 'live' })
  })

  test('an empty session (never messaged) is NOT history — entry stays zero-write', () => {
    const selection = selectProjectSession({
      ...base,
      sessions: [
        { id: 'blank', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 999 },
      ],
    })
    expect(selection).toEqual({ kind: 'empty' })
  })

  test('no candidates at all → empty', () => {
    expect(selectProjectSession({ ...base, sessions: [] })).toEqual({ kind: 'empty' })
  })

  test('ties break by createdAt desc then id code-point ascending', () => {
    const selection = selectProjectSession({
      ...base,
      sessions: [
        { id: 'zz', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, createdAt: 50, preview: 'x' },
        { id: 'aa', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, createdAt: 50, preview: 'x' },
        { id: 'mm', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, createdAt: 70, preview: 'x' },
      ],
    })
    expect(selection).toEqual({ kind: 'recent', sessionId: 'mm' })
    const tie = selectProjectSession({
      ...base,
      sessions: [
        { id: 'zz', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, createdAt: 50, preview: 'x' },
        { id: 'aa', workspaceId: 'w1', productSpaceId: 'project-1', lastMessageAt: 100, createdAt: 50, preview: 'x' },
      ],
    })
    expect(tie).toEqual({ kind: 'recent', sessionId: 'aa' })
  })
})

describe('entryScopeMatches', () => {
  const target = { accountId: 'account-1', productSpaceId: 'project-1' }

  test('committed and pending-free scope matches', () => {
    expect(entryScopeMatches({
      accountId: 'account-1',
      activeProductSpaceId: 'project-1',
      pendingSwitchId: null,
      target,
    })).toBe(true)
  })

  test('a pending switch blocks the completion routing', () => {
    expect(entryScopeMatches({
      accountId: 'account-1',
      activeProductSpaceId: 'project-1',
      pendingSwitchId: 'project-1',
      target,
    })).toBe(false)
  })

  test('another account or another space never matches', () => {
    expect(entryScopeMatches({
      accountId: 'account-2',
      activeProductSpaceId: 'project-1',
      pendingSwitchId: null,
      target,
    })).toBe(false)
    expect(entryScopeMatches({
      accountId: 'account-1',
      activeProductSpaceId: 'project-2',
      pendingSwitchId: null,
      target,
    })).toBe(false)
  })
})

/**
 * POO-196 R3 UB2 (adjudication U3/U10/U11) — the SHARED entry transaction
 * state semantics. The atom module is the single renderer-wide owner the
 * HomePage cards, the create dialog, the history-error face and both composer
 * gates subscribe to; these tests pin the shape every consumer relies on.
 */
describe('shared project entry state (U3)', () => {
  const switching: ProjectEntryState = {
    accountId: 'account-1',
    productSpaceId: 'project-1',
    generation: 3,
    phase: 'switching',
    origin: 'home',
  }

  test('idle keeps nothing — no target, no origin, no pending', () => {
    expect(PROJECT_ENTRY_IDLE).toEqual({
      accountId: null,
      productSpaceId: null,
      generation: 0,
      phase: 'idle',
      origin: null,
    })
    expect(isEntryPendingState(PROJECT_ENTRY_IDLE)).toBe(false)
    expect(isEntryFailedState(PROJECT_ENTRY_IDLE)).toBe(false)
  })

  test('switching and resuming are the pending (send-gate) phases', () => {
    expect(isEntryPendingState(switching)).toBe(true)
    expect(isEntryPendingState({ ...switching, phase: 'resuming' })).toBe(true)
    expect(isEntryPendingState({ ...switching, phase: 'ready' })).toBe(false)
    expect(isEntryPendingState({ ...switching, phase: 'enter-failed' })).toBe(false)
    expect(isEntryPendingState({ ...switching, phase: 'history-failed' })).toBe(false)
  })

  test('failure phases KEEP their target (accountId/productSpaceId/origin) for retry — U3 never wipes the target like the old finishEntry did', () => {
    for (const phase of ['enter-failed', 'history-failed'] as const) {
      const failed: ProjectEntryState = { ...switching, phase }
      expect(failed.productSpaceId).toBe('project-1')
      expect(failed.accountId).toBe('account-1')
      expect(failed.origin).toBe('home')
      expect(isEntryFailedState(failed)).toBe(true)
    }
    expect(isEntryFailedState({ ...switching, phase: 'ready' })).toBe(false)
  })

  test('the derived pending atom mirrors the shared state in one store', () => {
    const store = createStore()
    expect(store.get(projectEntryAtom)).toEqual(PROJECT_ENTRY_IDLE)
    expect(store.get(projectEntryPendingAtom)).toBe(false)
    store.set(projectEntryAtom, switching)
    expect(store.get(projectEntryPendingAtom)).toBe(true)
    store.set(projectEntryAtom, { ...switching, phase: 'resuming' })
    expect(store.get(projectEntryPendingAtom)).toBe(true)
    store.set(projectEntryAtom, { ...switching, phase: 'history-failed' })
    expect(store.get(projectEntryPendingAtom)).toBe(false)
    store.set(projectEntryAtom, PROJECT_ENTRY_IDLE)
    expect(store.get(projectEntryPendingAtom)).toBe(false)
  })
})

/**
 * POO-196 R3 UB2 (adjudication U11) — the blocked-send notice markers: ONE
 * contentless marker per draft scope (account/project/session-or-empty
 * draft key/generation). No message content ever rides the marker.
 */
describe('U11 send-notice markers', () => {
  test('the empty-state draft key is scoped by account AND project', () => {
    expect(emptyDraftKey('account-1', 'project-1')).toBe('empty:account-1:project-1')
    expect(emptyDraftKey('account-1', 'project-2')).not.toBe(emptyDraftKey('account-1', 'project-1'))
    expect(emptyDraftKey('account-2', 'project-1')).not.toBe(emptyDraftKey('account-1', 'project-1'))
  })

  test('markers record scope identity + generation, never message content', () => {
    const store = createStore()
    const marker = {
      accountId: 'account-1',
      productSpaceId: 'project-1',
      draftKey: 'sess-1',
      generation: 7,
    }
    store.set(projectEntrySendNoticesAtom, [marker])
    const notices = store.get(projectEntrySendNoticesAtom)
    expect(notices).toEqual([marker])
    expect(Object.values(marker).every(value => typeof value === 'string' || typeof value === 'number')).toBe(true)
  })
})
