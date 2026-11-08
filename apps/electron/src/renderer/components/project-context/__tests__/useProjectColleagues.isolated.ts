import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ListOrganizationColleaguesResponse } from '@polo-ai/shared/protocol'

/**
 * POO-205 organization colleague directory (Spec Q10 — the ONLY source a
 * project can pick members from; B3 gate "hooks 用例，mock transport").
 * Proven against a mocked electronAPI transport:
 *
 * - the committed-organization scope auto-loads the directory in ONE shot
 *   (the wire caps the roster well above real size — no pagination);
 * - name search is CLIENT-side over the loaded snapshot: filtering hides
 *   rows and never rewrites the wire state (no second call);
 * - a forbidden read is a real authority loss (the panel shows the error +
 *   retry, never a partial stale directory);
 * - a scope change mid-flight clears everything and DISCARDS the late
 *   response of the previous scope (失权即清数据).
 */

GlobalRegistrator.register()

const { act, cleanup, render } = await import('@testing-library/react')
const { useProjectColleagues } = await import('../useProjectColleagues')

afterEach(() => {
  cleanup()
})

type ProbeRecorder = { current: ReturnType<typeof useProjectColleagues> | null }

const SCOPE = {
  accountId: 'account-a',
  productSpaceId: 'space-org',
  organizationEnterpriseId: 'ent-org',
}

function colleague(accountId: string, name: string): { accountId: string; displayName: string | null; organizationRole: 'owner' | 'manager' | 'member' } {
  return { accountId, displayName: name, organizationRole: 'member' }
}

function directoryResponse(overrides: Partial<ListOrganizationColleaguesResponse> = {}): ListOrganizationColleaguesResponse {
  return {
    contractVersion: 'poo205-contract-r1',
    organizationEnterpriseId: SCOPE.organizationEnterpriseId,
    colleagues: [
      colleague('22222222-2222-4222-8222-222222222222', '王芳'),
      colleague('55555555-5555-4555-8555-555555555555', '李明'),
    ],
    ...overrides,
  }
}

interface Harness {
  calls: Array<Record<string, unknown>>
  respond: (input: Record<string, unknown>) => Promise<ListOrganizationColleaguesResponse>
}

function makeHarness(implementation?: (harness: Harness, input: Record<string, unknown>) => Promise<ListOrganizationColleaguesResponse>): Harness {
  const harness: Harness = { calls: [], respond: async () => directoryResponse() }
  harness.respond = async (input: Record<string, unknown>) => {
    if (implementation) return implementation(harness, input)
    return directoryResponse()
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmListOrganizationColleagues: async (input: Record<string, unknown>) => {
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

describe('useProjectColleagues (POO-205, Q10)', () => {
  it('auto-loads the organization directory in one shot, carrying the exact org scope', async () => {
    const harness = makeHarness()
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]).toMatchObject({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      organizationEnterpriseId: SCOPE.organizationEnterpriseId,
    })
    expect(recorder.current?.colleagues).toHaveLength(2)
    expect(recorder.current?.allColleagues).toHaveLength(2)
    expect(recorder.current?.errorKey).toBeNull()
    expect(recorder.current?.loading).toBe(false)
  })

  it('search is CLIENT-side: the visible list narrows, the loaded snapshot stays intact, no extra wire call', async () => {
    const harness = makeHarness(async () => directoryResponse({
      colleagues: [
        colleague('22222222-2222-4222-8222-222222222222', '王芳'),
        colleague('55555555-5555-4555-8555-555555555555', '李明'),
      ],
    }))
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)
    expect(harness.calls).toHaveLength(1)

    await act(async () => { recorder.current?.search('  芳  ') })

    expect(harness.calls).toHaveLength(1)
    expect(recorder.current?.colleagues).toHaveLength(1)
    expect(recorder.current?.colleagues[0]?.displayName).toBe('王芳')
    expect(recorder.current?.allColleagues).toHaveLength(2)

    await act(async () => { recorder.current?.search('不存在') })
    expect(recorder.current?.colleagues).toHaveLength(0)
    expect(recorder.current?.allColleagues).toHaveLength(2)

    await act(async () => { recorder.current?.search('') })
    expect(recorder.current?.colleagues).toHaveLength(2)
  })

  it('a forbidden read is an authority loss with its own copy; retry re-issues the read', async () => {
    let attempts = 0
    const harness = makeHarness(async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('forbidden'), { code: 'prj_forbidden' })
      return directoryResponse()
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    expect(recorder.current?.errorKey).toBe('projectMembers.error.forbidden')
    expect(recorder.current?.colleagues).toHaveLength(0)

    await act(async () => { recorder.current?.retry() })
    expect(recorder.current?.errorKey).toBeNull()
    expect(recorder.current?.colleagues).toHaveLength(2)
    expect(harness.calls).toHaveLength(2)
  })

  it('clears on scope change and DISCARDS the late response of the previous scope', async () => {
    const gates: Array<(response: ListOrganizationColleaguesResponse) => void> = []
    const harness = makeHarness(async () => new Promise<ListOrganizationColleaguesResponse>(resolve => { gates.push(resolve) }))
    const recorder: ProbeRecorder = { current: null }
    const view = await mountWith(SCOPE, recorder)
    expect(recorder.current?.loading).toBe(true)

    const otherScope = { ...SCOPE, organizationEnterpriseId: 'ent-other' }
    await act(async () => { view.rerender(createElement(Probe, { scope: otherScope, recorder })) })
    expect(recorder.current?.colleagues).toHaveLength(0)
    expect(harness.calls).toHaveLength(2)

    await act(async () => {
      gates[0]!(directoryResponse({
        colleagues: [colleague('99999999-9999-4999-8999-999999999999', '迟到者')],
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // The late directory of the PREVIOUS organization was discarded.
    expect(recorder.current?.colleagues).toHaveLength(0)
    expect(recorder.current?.loading).toBe(true)
    expect(recorder.current?.scopeKey).toContain('ent-other')
  })
})
