import { describe, expect, it } from 'bun:test'
import { projectScopedUnreadSessions } from '../unread-scope'

/**
 * POO-205 C9 (R12): the workbench bar's notification scope. A PROJECT tab
 * being active pins the bell dot and the list to that project's unread
 * conversations only; every other tab (Home, the personal Polo tab, webapps)
 * keeps the workspace-wide list. Pure gate — no TopBar mount needed.
 */

interface FixtureMeta {
  id: string
  hasUnread: boolean
  projectId: string | null
  lastMessageAt: number
}

function meta(id: string, overrides: Partial<FixtureMeta> = {}): FixtureMeta {
  return {
    id,
    hasUnread: true,
    projectId: null,
    lastMessageAt: 0,
    ...overrides,
  }
}

describe('projectScopedUnreadSessions (C9 R12)', () => {
  it('filters to the active project tab only — other projects and personal unread do not leak', () => {
    const sessions = [
      meta('in-project-old', { projectId: 'proj-1', lastMessageAt: 100 }),
      meta('in-project-new', { projectId: 'proj-1', lastMessageAt: 300 }),
      meta('other-project', { projectId: 'proj-2', lastMessageAt: 500 }),
      meta('personal', { projectId: null, lastMessageAt: 400 }),
      meta('read-in-project', { projectId: 'proj-1', hasUnread: false, lastMessageAt: 600 }),
    ]
    const scoped = projectScopedUnreadSessions(sessions, 'proj-1')
    expect(scoped.map(entry => entry.id)).toEqual(['in-project-new', 'in-project-old'])
  })

  it('keeps the workspace-wide list when the active tab is NOT a project (null scope)', () => {
    const sessions = [
      meta('personal', { projectId: null, lastMessageAt: 100 }),
      meta('proj-1', { projectId: 'proj-1', lastMessageAt: 200 }),
      meta('proj-2', { projectId: 'proj-2', lastMessageAt: 300 }),
    ]
    const scoped = projectScopedUnreadSessions(sessions, null)
    expect(scoped.map(entry => entry.id)).toEqual(['proj-2', 'proj-1', 'personal'])
  })

  it('sorts newest message first within the project scope', () => {
    const sessions = [
      meta('a', { projectId: 'proj-1', lastMessageAt: 5 }),
      meta('b', { projectId: 'proj-1', lastMessageAt: 900 }),
      meta('c', { projectId: 'proj-1', lastMessageAt: 50 }),
    ]
    const scoped = projectScopedUnreadSessions(sessions, 'proj-1')
    expect(scoped.map(entry => entry.id)).toEqual(['b', 'c', 'a'])
  })

  it('treats missing timestamps as oldest (null lastMessageAt sorts last)', () => {
    const sessions = [
      meta('no-time', { projectId: 'proj-1', lastMessageAt: null as unknown as number }),
      meta('timed', { projectId: 'proj-1', lastMessageAt: 1 }),
    ]
    const scoped = projectScopedUnreadSessions(sessions, 'proj-1')
    expect(scoped.map(entry => entry.id)).toEqual(['timed', 'no-time'])
  })
})
