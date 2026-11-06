import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ClientCollaborationRosterResponse } from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 R3 collaboration-roster hook (adjudication D4, B3 gate "hooks 用
 * 例，mock transport"). Proven here against a mocked electronAPI transport:
 *
 * - the committed-space scope auto-loads the SAFE roster; the viewer role,
   the unfiltered total and isSelf ride the server response verbatim;
 * - search passes `q` THROUGH (server-side filter) — the client never
 *   filters rows locally and never counts rows into the total;
 * - a 403 is a real authority change: the count and viewer role fall back to
 *   unknown/null, never to a stale roster;
 * - a scope change mid-flight clears everything and DISCARDS the late
 *   response of the previous scope.
 */

GlobalRegistrator.register()

const { act, cleanup, render } = await import('@testing-library/react')
const { useCollaborationRoster } = await import('../useCollaborationRoster')

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: ReturnType<typeof useCollaborationRoster> | null }

const SCOPE = { accountId: 'account-a', productSpaceId: 'space-project' }

function rosterMember(userId: string, name: string, role: 'owner' | 'manager' | 'member', isSelf: boolean) {
  return { userId, displayName: name, avatarUrl: null, role, isSelf }
}

function roster(overrides: Partial<ClientCollaborationRosterResponse> = {}): ClientCollaborationRosterResponse {
  return {
    productSpaceId: SCOPE.productSpaceId,
    enterpriseName: '华东区销售项目',
    viewerRole: 'member',
    totalActiveMembers: 3,
    members: [
      rosterMember('22222222-2222-4222-8222-222222222222', '王芳', 'owner', false),
      rosterMember('55555555-5555-4555-8555-555555555555', '李明', 'member', true),
    ],
    nextCursor: null,
    ...overrides,
  }
}

interface Harness {
  calls: Array<Record<string, unknown>>
  respond: (input: Record<string, unknown>) => Promise<ClientCollaborationRosterResponse>
}

function makeHarness(implementation?: (harness: Harness, input: Record<string, unknown>) => Promise<ClientCollaborationRosterResponse>): Harness {
  const harness: Harness = { calls: [], respond: async () => roster() }
  harness.respond = async (input: Record<string, unknown>) => {
    if (implementation) return implementation(harness, input)
    return roster()
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListCollaborationRoster: async (input: Record<string, unknown>) => {
        harness.calls.push(input)
        return harness.respond(input)
      },
    },
  })
  return harness
}

function Probe({ scope, recorder }: { scope: typeof SCOPE | null; recorder: ProbeRecorder }) {
  recorder.current = useCollaborationRoster(scope)
  return null
}

async function mountWith(scope: typeof SCOPE | null, recorder: ProbeRecorder) {
  const view = render(createElement(Probe, { scope, recorder }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return view
}

describe('useCollaborationRoster (POO-196 R3, D4)', () => {
  it('auto-loads the safe roster and surfaces viewerRole/total/isSelf verbatim', async () => {
    const harness = makeHarness()
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({ accountId: SCOPE.accountId, productSpaceId: SCOPE.productSpaceId })
    expect(recorder.current?.viewerRole).toBe('member')
    expect(recorder.current?.totalActiveMembers).toBe(3)
    expect(recorder.current?.enterpriseName).toBe('华东区销售项目')
    expect(recorder.current?.members).toHaveLength(2)
    expect(recorder.current?.members[1]?.isSelf).toBe(true)
    expect(recorder.current?.errorKey).toBeNull()
  })

  it('passes q through (server-side search) and keeps the server total — no client filtering', async () => {
    const harness = makeHarness(async (_h, input) => {
      // The SERVER answers a q-filtered page but the SAME unfiltered total.
      if (input.q === '芳') {
        return roster({
          members: [rosterMember('22222222-2222-4222-8222-222222222222', '王芳', 'owner', false)],
          nextCursor: 'cursor-q1',
        })
      }
      return roster()
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    await act(async () => { recorder.current?.search('  芳  '); await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(harness.calls[1]).toMatchObject({ q: '芳' })
    // One filtered row — the client did NOT merge the previous page's rows.
    expect(recorder.current?.members).toHaveLength(1)
    // The total is the server's unfiltered count from the same snapshot.
    expect(recorder.current?.totalActiveMembers).toBe(3)
    expect(recorder.current?.nextCursor).toBe('cursor-q1')
  })

  it('pages through the roster cursor: loadMore appends the next page', async () => {
    const harness = makeHarness(async (_h, input) => {
      if (input.cursor === 'cursor-1') {
        return roster({ members: [rosterMember('44444444-4444-4444-8444-444444444444', '赵六', 'manager', false)], nextCursor: null })
      }
      return roster({ nextCursor: 'cursor-1', totalActiveMembers: 3 })
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)
    expect(recorder.current?.nextCursor).toBe('cursor-1')

    await act(async () => { recorder.current?.loadMore(); await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(harness.calls[1]).toMatchObject({ cursor: 'cursor-1' })
    expect(recorder.current?.members).toHaveLength(3)
    expect(recorder.current?.members[2]?.displayName).toBe('赵六')
    expect(recorder.current?.totalActiveMembers).toBe(3)
  })

  it('treats a 403 as authority loss: count/role fall back to unknown, never stale data', async () => {
    const harness = makeHarness(async (_h, input) => {
      if (input.cursor === undefined && harness.calls.length > 1) {
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
      }
      return roster({ nextCursor: 'cursor-1' })
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)
    expect(recorder.current?.totalActiveMembers).toBe(3)

    // The member lost access (search re-read hits the 403).
    await act(async () => { recorder.current?.search('芳'); await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(recorder.current?.errorKey).toBe('projectMembers.error.forbidden')
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(recorder.current?.viewerRole).toBeNull()
  })

  it('clears on scope change and DISCARDS the late response of the previous scope', async () => {
    // One INDEPENDENT gate per call: releasing the old scope's roster must
    // never satisfy the new scope's own in-flight read.
    const gates: Array<(response: ClientCollaborationRosterResponse) => void> = []
    const harness = makeHarness(async () => new Promise<ClientCollaborationRosterResponse>(resolve => { gates.push(resolve) }))
    const recorder: ProbeRecorder = { current: null }
    const view = await mountWith(SCOPE, recorder)
    expect(recorder.current?.loading).toBe(true)

    const otherScope = { accountId: 'account-b', productSpaceId: 'space-project' }
    await act(async () => { view.rerender(createElement(Probe, { scope: otherScope, recorder })) })
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(harness.calls).toHaveLength(2)

    await act(async () => {
      gates[0]!(roster({ members: [rosterMember('99999999-9999-4999-8999-999999999999', '迟到者', 'member', false)] }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // The late roster of the PREVIOUS account was discarded, not published.
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(recorder.current?.loading).toBe(true)
    expect(recorder.current?.scopeKey).toContain('account-b')
  })
})
