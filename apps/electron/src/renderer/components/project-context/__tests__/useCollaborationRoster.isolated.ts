import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ListProjectMembersResponse } from '@polo-ai/shared/protocol'

/**
 * POO-205 collaboration-roster hook (rewritten from the POO-196 R3 D4
 * surface; B3 gate "hooks 用例，mock transport"). Proven against a mocked
 * electronAPI transport:
 *
 * - the committed-organization PROJECT scope auto-loads the safe roster;
 *   the viewer role is derived from the list's OWN row (isSelf) and the
 *   count is the server snapshot's length — never a fabricated 0;
 * - search is CLIENT-side (the wire takes no `q`): the full snapshot keeps
 *   its unfiltered total while `members` narrows;
 * - a forbidden read is a real authority loss: data clears, count/role fall
 *   back to unknown — never a stale roster behind the error;
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

const SCOPE = {
  accountId: 'account-a',
  productSpaceId: 'space-org',
  organizationEnterpriseId: 'ent-org',
  projectId: 'pj-1',
}

function member(accountId: string, name: string, role: 'owner' | 'manager' | 'member') {
  return { accountId, displayName: name, role, createdAt: '2026-11-08T00:00:00.000Z' }
}

function rosterResponse(overrides: Partial<ListProjectMembersResponse> = {}): ListProjectMembersResponse {
  return {
    contractVersion: 'poo205-contract-r1',
    projectId: SCOPE.projectId,
    members: [
      member('22222222-2222-4222-8222-222222222222', '王芳', 'owner'),
      // The acting account's OWN row — the viewer-role authority.
      member('account-a', '李明', 'member'),
    ],
    ...overrides,
  }
}

interface Harness {
  calls: Array<Record<string, unknown>>
  respond: (input: Record<string, unknown>) => Promise<ListProjectMembersResponse>
}

function makeHarness(implementation?: (harness: Harness, input: Record<string, unknown>) => Promise<ListProjectMembersResponse>): Harness {
  const harness: Harness = { calls: [], respond: async () => rosterResponse() }
  harness.respond = async (input: Record<string, unknown>) => {
    if (implementation) return implementation(harness, input)
    return rosterResponse()
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListProjectMembers: async (input: Record<string, unknown>) => {
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

describe('useCollaborationRoster (POO-205, Q10)', () => {
  it('auto-loads the project roster; the viewer role derives from the own row and the count is the server snapshot', async () => {
    const harness = makeHarness()
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
      projectId: SCOPE.projectId,
    })
    expect(recorder.current?.viewerRole).toBe('member')
    expect(recorder.current?.totalActiveMembers).toBe(2)
    expect(recorder.current?.members).toHaveLength(2)
    expect(recorder.current?.members[1]?.isSelf).toBe(true)
    expect(recorder.current?.members[0]?.isSelf).toBe(false)
    expect(recorder.current?.errorKey).toBeNull()
    // The wire takes no pagination on this channel.
    expect(recorder.current?.nextCursor).toBeNull()
  })

  it('a missing own row degrades the viewer role to null — never a guessed authority', async () => {
    makeHarness(async () => rosterResponse({
      members: [member('22222222-2222-4222-8222-222222222222', '王芳', 'owner')],
    }))
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(recorder.current?.viewerRole).toBeNull()
    expect(recorder.current?.totalActiveMembers).toBe(1)
  })

  it('search is CLIENT-side: the filtered view narrows while the total keeps the unfiltered snapshot', async () => {
    const harness = makeHarness(async () => rosterResponse({
      members: [
        member('22222222-2222-4222-8222-222222222222', '王芳', 'owner'),
        member('55555555-5555-4555-8555-555555555555', '李明', 'member'),
        member('66666666-6666-4666-8666-666666666666', '赵六', 'manager'),
      ],
    }))
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)
    expect(harness.calls).toHaveLength(1)

    await act(async () => { recorder.current?.search('  芳  ') })

    // NO second wire call — the filter is local.
    expect(harness.calls).toHaveLength(1)
    expect(recorder.current?.members).toHaveLength(1)
    expect(recorder.current?.members[0]?.displayName).toBe('王芳')
    // C10: the raw text is stored verbatim (trim happens at MATCH time, never
    // on the stored query — the input shows what the user typed).
    expect(recorder.current?.query).toBe('  芳  ')
    // The unfiltered total survives the search (never a fabricated count).
    expect(recorder.current?.totalActiveMembers).toBe(3)

    await act(async () => { recorder.current?.search('不存在') })
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.totalActiveMembers).toBe(3)

    await act(async () => { recorder.current?.search('') })
    expect(recorder.current?.members).toHaveLength(3)
  })

  it('treats a forbidden read as authority loss: data clears, count/role fall back to unknown', async () => {
    makeHarness(async () => {
      throw Object.assign(new Error('forbidden'), { code: 'prj_forbidden' })
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(recorder.current?.errorKey).toBe('projectMembers.error.forbidden')
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(recorder.current?.viewerRole).toBeNull()
    expect(recorder.current?.members).toHaveLength(0)
  })

  it('clears on scope change and DISCARDS the late response of the previous scope', async () => {
    const gates: Array<(response: ListProjectMembersResponse) => void> = []
    const harness = makeHarness(async () => new Promise<ListProjectMembersResponse>(resolve => { gates.push(resolve) }))
    const recorder: ProbeRecorder = { current: null }
    const view = await mountWith(SCOPE, recorder)
    expect(recorder.current?.loading).toBe(true)

    const otherScope = { ...SCOPE, accountId: 'account-b' }
    await act(async () => { view.rerender(createElement(Probe, { scope: otherScope, recorder })) })
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(harness.calls).toHaveLength(2)

    await act(async () => {
      gates[0]!(rosterResponse({
        members: [member('99999999-9999-4999-8999-999999999999', '迟到者', 'member')],
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // The late roster of the PREVIOUS account was discarded, not published.
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.totalActiveMembers).toBeNull()
    expect(recorder.current?.loading).toBe(true)
    expect(recorder.current?.scopeKey).toContain('account-b')
  })
})
