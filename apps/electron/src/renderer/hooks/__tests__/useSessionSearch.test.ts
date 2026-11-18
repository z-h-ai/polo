import { describe, it, expect } from 'bun:test'
import { computeCollapsedPagination } from '../useSessionSearch'
import type { SessionMeta } from '@/atoms/sessions'

function makeSession(id: string, opts: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    workspaceId: 'ws-1',
    sessionStatus: 'in-progress',
    lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z'),
    ...opts,
  }
}

describe('computeCollapsedPagination', () => {
  it('does not hide items when current view has only one group and that group is collapsed', () => {
    const sessions = [
      makeSession('s1'),
      makeSession('s2'),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['s1', 's2'])
    expect(result.collapsedGroupsMeta).toEqual([])
    expect(result.hasMore).toBe(false)
  })

  it('still collapses normally when multiple groups exist', () => {
    const sessions = [
      makeSession('today', { lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('yesterday', { lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
      makeSession('older', { lastMessageAt: Date.parse('2026-03-04T10:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['today', 'older'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: '2026-03-05T00:00:00.000Z', count: 1 }])
    expect(result.hasMore).toBe(false)
  })

  it('ignores collapsed keys that are not present in current view', () => {
    const sessions = [
      makeSession('a', { sessionStatus: 'in-progress' }),
      makeSession('b', { sessionStatus: 'done' }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['status-todo']),
      'status'
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['a', 'b'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })

  // --- Pinned top group (置顶) ---

  it('groups flagged sessions under the pinned key when the top pinned group is on', () => {
    const sessions = [
      makeSession('pin-1', { isFlagged: true, lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('pin-2', { isFlagged: true, lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
      makeSession('plain', { lastMessageAt: Date.parse('2026-03-06T09:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(sessions, 50, new Set(['pinned']), 'date', true)

    // Collapsing the pinned group hides exactly the flagged sessions.
    expect(result.paginatedItems.map(s => s.id)).toEqual(['plain'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: 'pinned', count: 2 }])
    expect(result.hasMore).toBe(false)
  })

  it('keeps date grouping for flagged sessions when the pinned group is off (pinned filter view)', () => {
    // In the "已置顶" filter view every row is flagged — a pinned split would
    // just re-count the same rows, so flagged sessions must keep their
    // regular (date/status) group key.
    const sessions = [
      makeSession('pin-1', { isFlagged: true, lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('pin-2', { isFlagged: true, lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(
      sessions,
      50,
      new Set(['2026-03-05T00:00:00.000Z']),
      'date',
      false,
    )

    expect(result.paginatedItems.map(s => s.id)).toEqual(['pin-1'])
    expect(result.collapsedGroupsMeta).toEqual([{ key: '2026-03-05T00:00:00.000Z', count: 1 }])
  })

  it('does not split a pinned group when pinnedAsGroup is omitted (default off)', () => {
    const sessions = [
      makeSession('pin', { isFlagged: true, lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') }),
      makeSession('plain', { lastMessageAt: Date.parse('2026-03-05T10:00:00.000Z') }),
    ]

    const result = computeCollapsedPagination(sessions, 50, new Set(), 'date')

    expect(result.paginatedItems.map(s => s.id)).toEqual(['pin', 'plain'])
    expect(result.collapsedGroupsMeta).toEqual([])
  })

  it('partitions pinned sessions in front of the display-limit slice so an old pin still reaches the top group', () => {
    const sessions = [
      makeSession('pin-old', { isFlagged: true, lastMessageAt: Date.parse('2026-01-01T10:00:00.000Z') }),
      ...Array.from({ length: 60 }, (_, i) =>
        makeSession(`plain-${i}`, { lastMessageAt: Date.parse('2026-03-06T10:00:00.000Z') - i * 1000 })),
    ]

    // The old pin sits at position 61 in lastMessageAt order; with a 50-item
    // display limit it must still be paginated in (partitioned to the front).
    const result = computeCollapsedPagination(sessions, 50, new Set(), 'date', true)

    expect(result.paginatedItems[0]?.id).toBe('pin-old')
    expect(result.paginatedItems.some(s => s.id === 'pin-old')).toBe(true)
    expect(result.paginatedItems.length).toBe(50)
    expect(result.hasMore).toBe(true)
  })
})
