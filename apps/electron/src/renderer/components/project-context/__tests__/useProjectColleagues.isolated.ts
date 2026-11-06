import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ClientColleagueOptionsResponse } from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * POO-196 R3 colleague-directory hook (adjudication D3, B3 gate "hooks 用
 * 例，mock transport"). Proven here against a mocked electronAPI transport:
 *
 * - the committed-space scope auto-loads page 1 and `loadMore` APPENDS page 2
 *   through the server's cursor (server-side pagination, client never
 *   re-derives members);
 * - a server-side search resets to the first page with the new `q` and the
 *   held cursor is never replayed across queries;
 * - a scope change (account/project/source) mid-flight clears everything and
 *   DISCARDS the late response of the previous scope;
 * - `colleague_source_unavailable` maps to its own copy; `none`/`ambiguous`
 *   source states stay SUCCESS faces with their fallback notice keys.
 */

GlobalRegistrator.register()

const { act, cleanup, render } = await import('@testing-library/react')
const { useProjectColleagues, colleagueProjectStateKeyOf } = await import('../useProjectColleagues')

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: ReturnType<typeof useProjectColleagues> | null }

const SCOPE = { accountId: 'account-a', productSpaceId: 'space-project', sourceEnterpriseId: 'ent-src' }

function member(userId: string, name: string | null, projectState: 'joined' | 'pending' | 'available' | 'unavailable') {
  return { userId, displayName: name, avatarUrl: null, projectState }
}

function page(members: ClientColleagueOptionsResponse['members'], nextCursor: string | null): ClientColleagueOptionsResponse {
  return {
    sourceState: 'available',
    source: { enterpriseId: '11111111-1111-4111-8111-111111111111', name: '主企业' },
    members,
    nextCursor,
  }
}

interface Harness {
  calls: Array<Record<string, unknown>>
  respond: (input: Record<string, unknown>) => Promise<ClientColleagueOptionsResponse>
}

function makeHarness(implementation?: (harness: Harness, input: Record<string, unknown>) => Promise<ClientColleagueOptionsResponse>): Harness {
  const harness: Harness = { calls: [], respond: async () => page([], null) }
  harness.respond = async (input: Record<string, unknown>) => {
    if (implementation) return implementation(harness, input)
    return page([member('22222222-2222-4222-8222-222222222222', '王芳', 'available')], null)
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListColleagueOptions: async (input: Record<string, unknown>) => {
        harness.calls.push(input)
        return harness.respond(input)
      },
    },
  })
  return harness
}

function Probe({ scope, recorder }: { scope: typeof SCOPE | null; recorder: ProbeRecorder }) {
  recorder.current = useProjectColleagues(scope)
  return null
}

async function mountWith(scope: typeof SCOPE | null, recorder: ProbeRecorder) {
  const view = render(createElement(Probe, { scope, recorder }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return view
}

describe('useProjectColleagues (POO-196 R3, D3)', () => {
  it('auto-loads page 1 for the committed scope and marks server projectStates', async () => {
    const harness = makeHarness(async (_h, input) => page(
      [member('22222222-2222-4222-8222-222222222222', '王芳', input.q === '王' ? 'available' : 'joined')],
      null,
    ))
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({ accountId: SCOPE.accountId, productSpaceId: SCOPE.productSpaceId })
    expect(recorder.current?.loading).toBe(false)
    expect(recorder.current?.members).toHaveLength(1)
    expect(recorder.current?.sourceState).toBe('available')
    expect(recorder.current?.source?.name).toBe('主企业')
    expect(recorder.current?.sourceNoticeKey).toBeNull()
    // The server-computed state maps to its badge key; `available` has none.
    expect(colleagueProjectStateKeyOf(recorder.current!.members[0]!)).toBe('projectMembers.directory.joined')
  })

  it('pages through the server cursor: loadMore appends page 2 (cursor advances)', async () => {
    const harness = makeHarness(async (_h, input) => {
      if (input.cursor === undefined) {
        return page([member('22222222-2222-4222-8222-222222222222', '王芳', 'available')], 'cursor-1')
      }
      // The continuation MUST replay the held cursor.
      expect(input.cursor).toBe('cursor-1')
      return page([member('33333333-3333-4333-8333-333333333333', null, 'pending')], null)
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)
    expect(recorder.current?.nextCursor).toBe('cursor-1')

    await act(async () => { recorder.current?.loadMore() ; await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]).toMatchObject({ cursor: 'cursor-1' })
    // Appended, not replaced — and the null displayName is preserved for the
    // localized 未命名成员 placeholder.
    expect(recorder.current?.members).toHaveLength(2)
    expect(recorder.current?.members[1]?.displayName).toBeNull()
    expect(colleagueProjectStateKeyOf(recorder.current!.members[1]!)).toBe('projectMembers.directory.pending')
  })

  it('restarts from page 1 on a server-side search and never replays the old cursor', async () => {
    let searchActive = false
    const harness = makeHarness(async (_h, input) => {
      if (input.q === undefined) return page([member('22222222-2222-4222-8222-222222222222', '王芳', 'available')], 'cursor-1')
      searchActive = true
      return page([member('44444444-4444-4444-8444-444444444444', '王大', 'available')], null)
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    await act(async () => { recorder.current?.search('  王  '); await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(searchActive).toBe(true)
    expect(harness.calls[1]).toMatchObject({ q: '王' })
    expect(recorder.current?.members).toHaveLength(1)
    expect(recorder.current?.members[0]?.displayName).toBe('王大')
    // Continuation after the search only exists through the NEW page's
    // cursor — the old cursor-1 was discarded with the previous query.
    expect(recorder.current?.nextCursor).toBeNull()
  })

  it('clears on scope change and DISCARDS the late response of the previous scope', async () => {
    // One INDEPENDENT gate per call: releasing the old scope's response must
    // never satisfy the new scope's own in-flight load.
    const gates: Array<(response: ClientColleagueOptionsResponse) => void> = []
    const harness = makeHarness(async () => new Promise<ClientColleagueOptionsResponse>(resolve => { gates.push(resolve) }))
    const recorder: ProbeRecorder = { current: null }
    const view = await mountWith(SCOPE, recorder)
    expect(recorder.current?.loading).toBe(true)
    expect(gates).toHaveLength(1)

    // The account moves while page 1 is in flight.
    const otherScope = { accountId: 'account-b', productSpaceId: 'space-project', sourceEnterpriseId: 'ent-src' }
    await act(async () => { view.rerender(createElement(Probe, { scope: otherScope, recorder })) })
    expect(recorder.current?.members).toHaveLength(0)
    expect(harness.calls).toHaveLength(2) // the NEW scope's own load started
    expect(gates).toHaveLength(2)

    // The old scope's response lands late — it must NOT be published.
    await act(async () => {
      gates[0]!(page([member('99999999-9999-4999-8999-999999999999', '迟到者', 'available')], null))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(recorder.current?.members).toHaveLength(0)
    expect(recorder.current?.loading).toBe(true) // still on the NEW scope's page 1
    expect(recorder.current?.scopeKey).toContain('account-b')
  })

  it('maps colleague_source_unavailable to its own copy; keeps success faces for none/ambiguous', async () => {
    const harness = makeHarness(async (_h, _input) => {
      if (harness.calls.length === 1) {
        throw Object.assign(new Error('colleague_source_unavailable'), { code: 'colleague_source_unavailable' })
      }
      if (harness.calls.length === 2) {
        return { sourceState: 'none', source: null, members: [], nextCursor: null }
      }
      return { sourceState: 'ambiguous', source: null, members: [], nextCursor: null }
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    // (call 1) the source资格 changed server-side → its own copy.
    expect(recorder.current?.errorKey).toBe('projectMembers.directory.sourceUnavailable')

    // (call 2) retry — `none` is a SUCCESS body with the direct-invite fallback.
    await act(async () => { recorder.current?.retry(); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(recorder.current?.errorKey).toBeNull()
    expect(recorder.current?.sourceState).toBe('none')
    expect(recorder.current?.sourceNoticeKey).toBe('projectMembers.directory.noSource')

    // (call 3) ambiguous keeps the same success face with its own copy.
    await act(async () => { recorder.current?.search('x'); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(recorder.current?.query).toBe('x')
    expect(recorder.current?.sourceState).toBe('ambiguous')
    expect(recorder.current?.sourceNoticeKey).toBe('projectMembers.directory.ambiguousSource')
  })
})
