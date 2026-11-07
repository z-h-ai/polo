import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import * as React from 'react'

/**
 * POO-196 review R-2 regression: the processing poll must survive CONCURRENCY.
 * The old hook-wide counter let simultaneously armed rows cancel each other —
 * the first response to land was judged stale, its chain stopped rescheduling
 * and the row sat at 处理中 forever. Each asset now polls on its own token, a
 * row reaching a terminal state never touches a sibling chain, and a transient
 * (non-404) RPC failure retries inside the bounded budget instead of killing
 * the chain.
 */

GlobalRegistrator.register()

const { cleanup, render } = await import('@testing-library/react')
const { createElement } = await import('react')
const { useProjectAssets } = await import('../useProjectAssets')

interface AssetScript {
  /** Answers in order; the last answer repeats. An Error answer is thrown. */
  answers: Array<{ processing?: string } | Error>
  calls: number
}

const SCOPE = { workspaceId: 'ws-pc', productSpaceId: 'ps-1' }

const CAPABILITIES = {
  featureEnabled: true,
  role: 'member',
  canManage: false,
  canShare: false,
  library: { status: 'ready' },
  limits: { maxUploadBytes: 100, downloadUrlTtlSeconds: 60 },
}

function processingAsset(id: string, processing = 'processing'): Record<string, unknown> {
  return {
    id,
    name: `File ${id}`,
    tags: [],
    uploaderUserId: 'user-a',
    uploaderDisplayName: 'Alice',
    source: { kind: 'file', note: null },
    status: 'active',
    currentVersion: 1,
    revision: 1,
    pinned: false,
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    trashedAt: null,
    trashExpiresAt: null,
    deletedById: null,
    current: {
      version: 1,
      sizeBytes: 10,
      mime: 'text/plain',
      checksumSha256: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdById: 'user-a',
      processing,
      confirmedAt: null,
      confirmedByUserId: null,
    },
  }
}

function withProcessing(row: Record<string, unknown>, processing: string): Record<string, unknown> {
  return { ...row, current: { ...(row.current as Record<string, unknown>), processing } }
}

function mountPollHarness(options: { scripts: Record<string, AssetScript> }) {
  const getCalls: Array<{ assetId?: string }> = []
  const handles: { result: ReturnType<typeof useProjectAssets> | null } = { result: null }
  function PollHarness() {
    // The scope object must be STABLE across renders — the hook guards its
    // responses against scope identity, exactly like the memoized projectScope
    // the real pane passes in.
    handles.result = useProjectAssets({ scope: SCOPE, enabled: true, active: true })
    return null
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pcListCapabilities: async () => CAPABILITIES,
      pcListAssets: async () => ({
        assets: Object.keys(options.scripts).map((id) => processingAsset(id)),
        canManage: false,
      }),
      pcGetAsset: async (input: { assetId: string }) => {
        getCalls.push({ assetId: input.assetId })
        const script = options.scripts[input.assetId]
        if (!script) throw Object.assign(new Error('missing script'), { code: 'pc_not_found' })
        const answer = script.answers[Math.min(script.calls, script.answers.length - 1)]
        script.calls += 1
        if (answer instanceof Error) throw answer
        return { asset: withProcessing(processingAsset(input.assetId), answer.processing ?? 'processing') }
      },
    },
  })
  render(createElement(PollHarness))
  return { getCalls, handles }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(cleanup)

describe('useProjectAssets processing poll concurrency (POO-196 R-2)', () => {
  it('two processing rows armed in the same tick both poll, and one reaching a terminal state leaves the other running', async () => {
    const scripts: Record<string, AssetScript> = {
      'p-a': { answers: [{ processing: 'indexed' }], calls: 0 },
      'p-b': { answers: [{ processing: 'processing' }, { processing: 'indexed' }], calls: 0 },
    }
    const { getCalls, handles } = mountPollHarness({ scripts })

    // First poll tick (PC_POLL_BASE_MS = 1s) fires for BOTH rows — under the
    // old hook-wide counter the first response here was judged stale and the
    // row never updated.
    await sleep(1_400)
    expect(getCalls.map((call) => call.assetId)).toContain('p-a')
    expect(getCalls.map((call) => call.assetId)).toContain('p-b')
    const statusOf = (id: string) => handles.result?.loadedAssets.find((row) => row.id === id)?.current.processing
    expect(statusOf('p-a')).toBe('indexed')

    // p-a reached its terminal state; p-b must still re-arm and poll AGAIN.
    await sleep(1_400)
    expect(getCalls.filter((call) => call.assetId === 'p-a')).toHaveLength(1)
    expect(getCalls.filter((call) => call.assetId === 'p-b').length).toBeGreaterThanOrEqual(2)
  })

  it('a transient (non-404) RPC failure retries within the bounded budget instead of ending the chain', async () => {
    const scripts: Record<string, AssetScript> = {
      'p-x': {
        answers: [Object.assign(new Error('transport blip'), { code: 'pc_service_unavailable' }), { processing: 'indexed' }],
        calls: 0,
      },
    }
    const { getCalls } = mountPollHarness({ scripts })

    await sleep(1_400)
    expect(getCalls.filter((call) => call.assetId === 'p-x').length).toBeGreaterThanOrEqual(1)
    await sleep(1_400)
    // The failed tick is retried (and the retry lands the terminal answer).
    expect(getCalls.filter((call) => call.assetId === 'p-x').length).toBeGreaterThanOrEqual(2)
  })
})
