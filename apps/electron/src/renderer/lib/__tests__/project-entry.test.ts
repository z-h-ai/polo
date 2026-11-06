import { describe, expect, test } from 'bun:test'
import { entryScopeMatches, selectProjectSession } from '../project-entry'

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
