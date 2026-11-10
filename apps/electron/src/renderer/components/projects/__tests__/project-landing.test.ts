import { describe, expect, it } from 'bun:test'
import { resolveChatEntryTarget, resolveProjectLanding, selectProjectSessionByProjectId, shouldLandProject } from '../enter-project'

/**
 * POO-205 §10 (C3): the PROJECT LANDING resolver — NavigationProvider's
 * invariant backstop. While a project tab is active the sessions landing
 * order is: the project's stored last selection → the project's most recent
 * REAL conversation → the project empty state. Archived, hidden, empty
 * (never-messaged) and OTHER projects' sessions never land.
 */

type Meta = Parameters<typeof selectProjectSessionByProjectId>[0][number]

function meta(overrides: Partial<Meta> & { id: string; projectId?: string | null }): Meta {
  return {
    hidden: false,
    isArchived: false,
    preview: null,
    name: null,
    lastFinalMessageId: null,
    lastMessageAt: null,
    createdAt: null,
    ...overrides,
  }
}

const PROJECT_A = 'proj-a'
const PROJECT_B = 'proj-b'

/** The shared fixture: project A owns a real conversation, a never-messaged
 * draft session (NEWER than the real one), an archived session and a hidden
 * session; project B owns its own real conversation; one session has no
 * project binding at all. */
function metas(): Meta[] {
  return [
    meta({ id: 'a-recent', projectId: PROJECT_A, preview: 'A 的真实对话', lastMessageAt: 200, createdAt: 100 }),
    // The empty session is NEWER — the recent fallback must still skip it.
    meta({ id: 'a-empty', projectId: PROJECT_A, lastMessageAt: 300, createdAt: 250 }),
    meta({ id: 'a-archived', projectId: PROJECT_A, preview: '已归档', isArchived: true, lastMessageAt: 150 }),
    meta({ id: 'a-hidden', projectId: PROJECT_A, preview: 'mini-agent', hidden: true, lastMessageAt: 160 }),
    meta({ id: 'b-recent', projectId: PROJECT_B, preview: 'B 的真实对话', lastMessageAt: 400, createdAt: 50 }),
    meta({ id: 'no-project', preview: '个人空间会话', lastMessageAt: 500 }),
  ]
}

describe('resolveProjectLanding (POO-205 §10 project landing)', () => {
  it('level 1: a valid stored selection wins (still present, THIS project, not archived/hidden)', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'a-recent')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'stored',
    })
  })

  it('level 2: no stored selection falls back to the project’s most recent REAL conversation', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, null)).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })

  it('level 3: a project with no landable session answers the empty state', () => {
    expect(resolveProjectLanding(metas(), 'proj-none', null)).toEqual({ kind: 'empty' })
  })

  it('a stored selection that was deleted falls back to the recent conversation', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'deleted-id')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })

  it('a stored ARCHIVED session no longer lands — falls back to recent', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'a-archived')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })

  it('a stored HIDDEN session no longer lands — falls back to recent', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'a-hidden')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })

  it('a stored session of ANOTHER project never lands — falls back within THIS project', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'b-recent')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
    expect(resolveProjectLanding(metas(), PROJECT_B, 'a-recent')).toEqual({
      kind: 'session',
      sessionId: 'b-recent',
      source: 'recent',
    })
  })

  it('an EMPTY stored session still lands (it exists, belongs to the project, not archived)', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'a-empty')).toEqual({
      kind: 'session',
      sessionId: 'a-empty',
      source: 'stored',
    })
  })

  it('the recent fallback NEVER lands an empty session, even a newer one', () => {
    // a-empty is newer than a-recent; only a-recent is real history.
    expect(resolveProjectLanding(metas(), PROJECT_A, null)).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })

  it('a project whose only sessions are empty/archived/hidden lands the empty state', () => {
    const onlyDead = [
      meta({ id: 'a-empty', projectId: PROJECT_A, lastMessageAt: 300 }),
      meta({ id: 'a-archived', projectId: PROJECT_A, preview: '归档', isArchived: true, lastMessageAt: 150 }),
      meta({ id: 'a-hidden', projectId: PROJECT_A, preview: 'mini', hidden: true, lastMessageAt: 160 }),
    ]
    expect(resolveProjectLanding(onlyDead, PROJECT_A, 'a-archived')).toEqual({ kind: 'empty' })
    expect(resolveProjectLanding(onlyDead, PROJECT_A, null)).toEqual({ kind: 'empty' })
  })

  it('sessions without any project binding are invisible to a project landing', () => {
    expect(resolveProjectLanding(metas(), PROJECT_A, 'no-project')).toEqual({
      kind: 'session',
      sessionId: 'a-recent',
      source: 'recent',
    })
  })
})

describe('selectProjectSessionByProjectId (recent-order discipline)', () => {
  it('orders by lastMessageAt, then createdAt, then id', () => {
    const sessions: Meta[] = [
      meta({ id: 'old', projectId: 'p', preview: 'x', lastMessageAt: 100, createdAt: 999 }),
      meta({ id: 'by-created', projectId: 'p', preview: 'x', lastMessageAt: 200, createdAt: 20 }),
      meta({ id: 'by-created-2', projectId: 'p', preview: 'x', lastMessageAt: 200, createdAt: 30 }),
      meta({ id: 'by-id', projectId: 'p', preview: 'x', lastMessageAt: 200, createdAt: 20 }),
    ]
    expect(selectProjectSessionByProjectId(sessions, 'p')).toEqual({ kind: 'recent', sessionId: 'by-created-2' })
  })

  it('an empty session is not history', () => {
    const sessions: Meta[] = [
      meta({ id: 'draft-only', projectId: 'p', lastMessageAt: 999, createdAt: 999 }),
    ]
    expect(selectProjectSessionByProjectId(sessions, 'p')).toEqual({ kind: 'empty' })
  })
})

/**
 * POO-205 C3-fix: the transition/within-project split behind the landing
 * invariant. A PROJECT TRANSITION lands the conversation regardless of which
 * navigator the panel shows (the only pass is a focused session already
 * provably the new project's — `unknown` is NOT a pass); WITHIN one project
 * the invariant stays surgical (only a foreign session in the sessions
 * navigator is corrected).
 */
describe('shouldLandProject (C3-fix transition vs within-project)', () => {
  const land = (input: Parameters<typeof shouldLandProject>[0]) => shouldLandProject(input)

  it('transition: a NON-sessions navigator (sources/skills/settings) still lands the project conversation', () => {
    expect(land({ transition: true, isSessions: false, details: 'none', hasLandingSession: true })).toBe(true)
    expect(land({ transition: true, isSessions: false, details: 'none', hasLandingSession: false })).toBe(true)
  })

  it('transition: a focused FOREIGN session lands', () => {
    expect(land({ transition: true, isSessions: true, details: 'foreign', hasLandingSession: true })).toBe(true)
  })

  it('transition: an UNKNOWN meta (details set, meta not in the map) lands — it cannot vouch for the new project', () => {
    expect(land({ transition: true, isSessions: true, details: 'unknown', hasLandingSession: true })).toBe(true)
    expect(land({ transition: true, isSessions: true, details: 'unknown', hasLandingSession: false })).toBe(true)
  })

  it('transition: a focused session already belonging to the project does NOT re-land', () => {
    expect(land({ transition: true, isSessions: true, details: 'mine', hasLandingSession: true })).toBe(false)
  })

  it('within a project: a NON-sessions navigator is never yanked back', () => {
    expect(land({ transition: false, isSessions: false, details: 'none', hasLandingSession: true })).toBe(false)
    expect(land({ transition: false, isSessions: false, details: 'foreign', hasLandingSession: true })).toBe(false)
  })

  it('within a project: an UNKNOWN meta is left alone (a fresh creation navigates before its meta lands)', () => {
    expect(land({ transition: false, isSessions: true, details: 'unknown', hasLandingSession: true })).toBe(false)
    expect(land({ transition: false, isSessions: true, details: 'unknown', hasLandingSession: false })).toBe(false)
  })

  it('within a project: details=null over an EMPTY project is already the correct landing', () => {
    expect(land({ transition: false, isSessions: true, details: 'none', hasLandingSession: false })).toBe(false)
  })

  it('within a project: a FOREIGN session in the sessions navigator is corrected (C3 behavior kept)', () => {
    expect(land({ transition: false, isSessions: true, details: 'foreign', hasLandingSession: true })).toBe(true)
    expect(land({ transition: false, isSessions: true, details: 'foreign', hasLandingSession: false })).toBe(true)
  })

  it('within a project: details=null with a landable session re-lands it (C3 behavior kept)', () => {
    expect(land({ transition: false, isSessions: true, details: 'none', hasLandingSession: true })).toBe(true)
  })

  it('within a project: the project’s own focused session wins (user click)', () => {
    expect(land({ transition: false, isSessions: true, details: 'mine', hasLandingSession: true })).toBe(false)
  })

  // POO-205 C4 (R3): an explicit「新建会话」inside a project tab records the
  // empty-state intent for THAT project. While it is armed, the within-project
  // details=null re-land must NOT pull the stored/recent conversation back —
  // the empty state IS the requested surface.
  it('C4 R3: empty-state intent arms — same-project details=null does NOT re-land (has or has not a session)', () => {
    expect(land({ transition: false, isSessions: true, details: 'none', hasLandingSession: true, emptyIntent: true })).toBe(false)
    expect(land({ transition: false, isSessions: true, details: 'none', hasLandingSession: false, emptyIntent: true })).toBe(false)
    // The intent only shields the SAME project's details=null case.
    expect(land({ transition: true, isSessions: true, details: 'foreign', hasLandingSession: true, emptyIntent: true })).toBe(true)
    expect(land({ transition: false, isSessions: true, details: 'unknown', hasLandingSession: true, emptyIntent: true })).toBe(false)
  })

  it('C4 R3: the intent is inert when not armed — C3 landing behavior is intact', () => {
    // Default (no emptyIntent field) keeps every C3-fix expectation above.
    expect(land({ transition: false, isSessions: true, details: 'none', hasLandingSession: true })).toBe(true)
    expect(land({ transition: true, isSessions: true, details: 'none', hasLandingSession: true })).toBe(true)
  })
})

// POO-205 C4 (R4): the chat-entry split — a pure function deciding where a
// 「新建会话」 request lands in each committed space. The personal space keeps
// its assistant-tab default; an enterprise space routes to the active project
// tab, else the most recently VISITED project that is STILL VISIBLE, else the
// home hint (「先创建或进入一个项目」).
describe('resolveChatEntryTarget (C4 R4 chat-entry split)', () => {
  const resolve = (input: Parameters<typeof resolveChatEntryTarget>[0]) => resolveChatEntryTarget(input)
  const VISIBLE = [{ id: 'proj-a' }, { id: 'proj-b' }]

  it('the personal space (and any un-committed/null space) keeps its assistant default', () => {
    expect(resolve({ spaceKind: 'personal', activeTab: null, recentProjectIds: [], visibleProjects: VISIBLE }))
      .toEqual({ kind: 'personal-default' })
    expect(resolve({ spaceKind: null, activeTab: { type: 'project', project: { projectId: 'proj-a' } }, recentProjectIds: ['proj-a'], visibleProjects: VISIBLE }))
      .toEqual({ kind: 'personal-default' })
  })

  it('an ACTIVE project tab wins — the entry opens THIS project (R3 empty state)', () => {
    expect(resolve({
      spaceKind: 'enterprise',
      activeTab: { type: 'project', project: { projectId: 'proj-b' } },
      recentProjectIds: ['proj-a'],
      visibleProjects: VISIBLE,
    })).toEqual({ kind: 'project', projectId: 'proj-b' })
  })

  it('no project tab: the most recently visited project that is STILL visible wins', () => {
    expect(resolve({
      spaceKind: 'enterprise',
      activeTab: { type: 'home' },
      recentProjectIds: ['proj-a', 'proj-b'],
      visibleProjects: VISIBLE,
    })).toEqual({ kind: 'project', projectId: 'proj-a' })
  })

  it('a recently visited project that is NO LONGER visible is skipped, not fatal', () => {
    expect(resolve({
      spaceKind: 'enterprise',
      activeTab: { type: 'webapp' },
      recentProjectIds: ['proj-gone', 'proj-b'],
      visibleProjects: VISIBLE,
    })).toEqual({ kind: 'project', projectId: 'proj-b' })
    expect(resolve({
      spaceKind: 'enterprise',
      activeTab: null,
      recentProjectIds: ['proj-gone'],
      visibleProjects: VISIBLE,
    })).toEqual({ kind: 'home-hint' })
  })

  it('no accessible project at all: home-hint (「先创建或进入一个项目」)', () => {
    expect(resolve({ spaceKind: 'enterprise', activeTab: null, recentProjectIds: [], visibleProjects: [] }))
      .toEqual({ kind: 'home-hint' })
    expect(resolve({ spaceKind: 'enterprise', activeTab: { type: 'home' }, recentProjectIds: ['proj-x'], visibleProjects: [{ id: 'proj-y' }] }))
      .toEqual({ kind: 'home-hint' })
  })
})
