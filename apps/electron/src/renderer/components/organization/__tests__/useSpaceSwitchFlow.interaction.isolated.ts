import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type {
  RunningActivity,
  SpaceSwitchFlowApi,
  SpaceSwitchFlowDeps,
  SpaceSwitchTarget,
} from '../useSpaceSwitchFlow'

GlobalRegistrator.register()

const { act, cleanup, render, waitFor } = await import('@testing-library/react')
const { useSpaceSwitchFlowMachine } = await import('../useSpaceSwitchFlow')
const { OrganizationProvider } = await import('@/context/OrganizationContext')

type OrganizationContextValue = Parameters<typeof OrganizationProvider>[0]['value']

const TARGET: SpaceSwitchTarget = { id: 'org-personal', name: '我的空间' }

const ACTIVITIES: RunningActivity[] = [
  { id: 'act-report', kind: 'app', name: '数据报表生成器', detail: '同空间后台运行' },
  { id: 'act-crm', kind: 'app', name: '客户资料面板', detail: '运行中 · 前台' },
  { id: 'act-weekly', kind: 'assistant', name: '销售周报', detail: '正在生成回答' },
]

type TargetLoadOutcomeLike = { ok: true } | { ok: false; cause: 'load-error' | 'access-lost' }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface HarnessProps {
  deps: SpaceSwitchFlowDeps
}

/** Renders the machine and keeps the latest api reachable from the test. */
let api: SpaceSwitchFlowApi

function FlowHarness({ deps }: HarnessProps) {
  api = useSpaceSwitchFlowMachine(deps)
  return null
}

function renderMachine(deps: SpaceSwitchFlowDeps, organizationValue?: OrganizationContextValue) {
  const harness = createElement(FlowHarness, { deps })
  return render(
    organizationValue
      ? createElement(OrganizationProvider, { value: organizationValue, children: harness })
      : harness,
  )
}

async function settle() {
  await act(async () => {})
}

beforeEach(() => {
  api = undefined as unknown as SpaceSwitchFlowApi
})

afterEach(() => {
  cleanup()
})

describe('useSpaceSwitchFlowMachine · direct switch (no running items)', () => {
  it('skips confirm/stop and commits after the target loads', async () => {
    const loaded: string[] = []
    const committed: string[] = []
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: async (target) => {
        loaded.push(target.id)
        return { ok: true }
      },
      commitSwitch: (target) => { committed.push(target.id) },
    })
    act(() => api.requestSwitch(TARGET))
    expect(api.phase).toBe('targetLoading')
    await waitFor(() => expect(api.phase).toBe('done'))
    expect(loaded).toEqual(['org-personal'])
    expect(committed).toEqual(['org-personal'])
  })
})

describe('useSpaceSwitchFlowMachine · confirm → stop → commit', () => {
  it('locks the ledger at request time and stops items sequentially before committing', async () => {
    const stopOrder: string[] = []
    let ledgerCalls = 0
    let running: RunningActivity[] = ACTIVITIES
    renderMachine({
      getRunningActivities: () => {
        ledgerCalls += 1
        return running
      },
      stopActivity: async (activity) => {
        stopOrder.push(activity.id)
        return true
      },
      loadTargetSpace: async () => ({ ok: true }),
      commitSwitch: () => {},
    })

    act(() => api.requestSwitch(TARGET))
    expect(api.phase).toBe('confirm')
    expect(api.activities.map((entry) => entry.status)).toEqual(['running', 'running', 'running'])
    expect(api.stoppedCount).toBe(0)
    expect(api.remainingRunningCount).toBe(3)

    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('done'))
    expect(stopOrder).toEqual(['act-report', 'act-crm', 'act-weekly'])
    expect(api.activities.every((entry) => entry.status === 'stopped')).toBe(true)

    // C-R03: the ledger reflects the set locked at request time only.
    running = []
    expect(ledgerCalls).toBe(1)
    expect(api.activities).toHaveLength(3)
  })

  it('marks each item stopping while its stop is in flight', async () => {
    const gate = deferred<boolean>()
    renderMachine({
      getRunningActivities: () => [ACTIVITIES[0]],
      stopActivity: () => gate.promise,
    })
    act(() => api.requestSwitch(TARGET))
    await act(async () => { api.confirmStop() })
    expect(api.phase).toBe('stopping')
    expect(api.activities[0].status).toBe('stopping')
    await act(async () => { gate.resolve(true) })
    await waitFor(() => expect(api.phase).toBe('done'))
  })
})

describe('useSpaceSwitchFlowMachine · partial failure (C-R04)', () => {
  function renderPartialFailure(overrides: Partial<SpaceSwitchFlowDeps> = {}) {
    const stopCalls: string[] = []
    let failSecond = true
    const loadCalls: string[] = []
    const commitCalls: string[] = []
    const deps: SpaceSwitchFlowDeps = {
      getRunningActivities: () => ACTIVITIES,
      stopActivity: async (activity) => {
        stopCalls.push(activity.id)
        return !(failSecond && activity.id === 'act-crm')
      },
      loadTargetSpace: async (target) => {
        loadCalls.push(target.id)
        return { ok: true }
      },
      commitSwitch: (target) => { commitCalls.push(target.id) },
      ...overrides,
    }
    renderMachine(deps)
    act(() => api.requestSwitch(TARGET))
    return {
      stopCalls,
      loadCalls,
      commitCalls,
      allowRetrySuccess: () => { failSecond = false },
    }
  }

  it('stops at stopFailed with the failed item marked failed', async () => {
    const { stopCalls } = renderPartialFailure()
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    expect(api.activities.map((entry) => entry.status)).toEqual(['stopped', 'failed', 'stopped'])
    expect(api.stoppedCount).toBe(2)
    expect(api.remainingRunningCount).toBe(1)
    expect(stopCalls).toEqual(['act-report', 'act-crm', 'act-weekly'])
  })

  it('never loads or commits while stopped at stopFailed', async () => {
    const { loadCalls, commitCalls } = renderPartialFailure()
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    await settle()
    expect(loadCalls).toEqual([])
    expect(commitCalls).toEqual([])
  })

  it('retries only the failed item and commits once it stops', async () => {
    const { stopCalls, allowRetrySuccess } = renderPartialFailure()
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    stopCalls.length = 0
    allowRetrySuccess()

    await act(async () => { api.retryFailedStops() })
    await waitFor(() => expect(api.phase).toBe('done'))
    // Stopped items are never re-stopped or revived.
    expect(stopCalls).toEqual(['act-crm'])
    expect(api.activities.map((entry) => entry.status)).toEqual(['stopped', 'stopped', 'stopped'])
  })

  it('keeps failing → stopFailed again on retry', async () => {
    renderPartialFailure()
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    await act(async () => { api.retryFailedStops() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    expect(api.activities[1].status).toBe('failed')
  })

  it('cancel keeps stopped items stopped (ledger survives, no rollback)', async () => {
    renderPartialFailure()
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('stopFailed'))
    await act(async () => { api.cancelSwitch() })
    expect(api.phase).toBe('stopCancel')
    expect(api.activities.map((entry) => entry.status)).toEqual(['stopped', 'failed', 'stopped'])
    expect(api.stoppedCount).toBe(2)
    // 顶栏账目 = 未成功停止的项数（失败项）
    expect(api.remainingRunningCount).toBe(1)
    act(() => api.dismiss())
    expect(api.phase).toBe('idle')
  })
})

describe('useSpaceSwitchFlowMachine · cancel semantics', () => {
  it('cancel from confirm returns to idle without stopping anything', async () => {
    const stopCalls: string[] = []
    renderMachine({
      getRunningActivities: () => ACTIVITIES,
      stopActivity: async (activity) => {
        stopCalls.push(activity.id)
        return true
      },
    })
    act(() => api.requestSwitch(TARGET))
    expect(api.phase).toBe('confirm')
    act(() => api.cancelSwitch())
    expect(api.phase).toBe('idle')
    expect(stopCalls).toEqual([])
  })

  it('cancel during stopping records a late stop success without advancing', async () => {
    const gate = deferred<boolean>()
    renderMachine({
      getRunningActivities: () => [ACTIVITIES[0], ACTIVITIES[1]],
      stopActivity: (activity) => (activity.id === 'act-report' ? Promise.resolve(true) : gate.promise),
      loadTargetSpace: async () => ({ ok: true }),
    })
    act(() => api.requestSwitch(TARGET))
    await act(async () => { api.confirmStop() })
    // First item stopped, second one in flight.
    await waitFor(() => expect(api.activities[0].status).toBe('stopped'))
    expect(api.activities[1].status).toBe('stopping')

    act(() => api.cancelSwitch())
    expect(api.phase).toBe('stopCancel')
    expect(api.activities[0].status).toBe('stopped')
    expect(api.activities[1].status).toBe('running')

    // The in-flight stop succeeds after the cancel — C-R04: the finished stop
    // is recorded on the ledger, but the flow stays in the cancelled state.
    await act(async () => { gate.resolve(true) })
    await settle()
    expect(api.phase).toBe('stopCancel')
    expect(api.activities[1].status).toBe('stopped')
    expect(api.stoppedCount).toBe(2)
  })

  it('a newer requestSwitch supersedes an in-flight run — late writes never touch the new ledger', async () => {
    const gate = deferred<boolean>()
    const SECOND_TARGET: SpaceSwitchTarget = { id: 'org-other', name: '其他空间' }
    renderMachine({
      getRunningActivities: () => [ACTIVITIES[0]],
      stopActivity: () => gate.promise,
      loadTargetSpace: async () => ({ ok: true }),
      commitSwitch: () => {},
    })
    act(() => api.requestSwitch(TARGET))
    await act(async () => { api.confirmStop() })
    expect(api.activities[0].status).toBe('stopping')

    // A new request while the first stop is still in flight.
    act(() => api.requestSwitch(SECOND_TARGET))
    expect(api.phase).toBe('confirm')
    expect(api.activities[0].status).toBe('running')

    await act(async () => { gate.resolve(true) })
    await settle()
    // The superseded run's late success does not leak into the new transaction.
    expect(api.phase).toBe('confirm')
    expect(api.activities[0].status).toBe('running')
    expect(api.target?.id).toBe('org-other')

    // The new transaction proceeds on its own.
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('done'))
    expect(api.activities[0].status).toBe('stopped')
  })

  it('cancel during target loading falls back to the current space', async () => {
    const committed: string[] = []
    const gate = deferred<TargetLoadOutcomeLike>()
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: () => gate.promise,
      commitSwitch: (target) => { committed.push(target.id) },
    })
    act(() => api.requestSwitch(TARGET))
    expect(api.phase).toBe('targetLoading')
    act(() => api.cancelSwitch())
    expect(api.phase).toBe('stopCancel')
    await act(async () => { gate.resolve({ ok: true }) })
    await settle()
    expect(api.phase).toBe('stopCancel')
    expect(committed).toEqual([])
  })
})

describe('useSpaceSwitchFlowMachine · target load failures', () => {
  it('load error → targetFailed, retry succeeds → done', async () => {
    let attempts = 0
    renderMachine({
      getRunningActivities: () => ACTIVITIES,
      stopActivity: async () => true,
      loadTargetSpace: async () => {
        attempts += 1
        return attempts === 1 ? { ok: false, cause: 'load-error' } : { ok: true }
      },
      commitSwitch: () => {},
    })
    act(() => api.requestSwitch(TARGET))
    await act(async () => { api.confirmStop() })
    await waitFor(() => expect(api.phase).toBe('targetFailed'))
    // Stops already completed stay stopped while the target failed.
    expect(api.stoppedCount).toBe(3)

    await act(async () => { api.retryLoad() })
    await waitFor(() => expect(api.phase).toBe('done'))
    expect(attempts).toBe(2)
  })

  it('a throwing commit falls back to targetFailed, not done', async () => {
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: async () => ({ ok: true }),
      commitSwitch: () => { throw new Error('commit channel down') },
    })
    act(() => api.requestSwitch(TARGET))
    await waitFor(() => expect(api.phase).toBe('targetFailed'))
    // The targetFailed surface offers retry / stay — retry hits the same path.
    await act(async () => { api.retryLoad() })
    await waitFor(() => expect(api.phase).toBe('targetFailed'))
  })

  it('stayInCurrentSpace resets to idle', async () => {
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: async () => ({ ok: false, cause: 'load-error' }),
    })
    act(() => api.requestSwitch(TARGET))
    await waitFor(() => expect(api.phase).toBe('targetFailed'))
    act(() => api.stayInCurrentSpace())
    expect(api.phase).toBe('idle')
  })

  it('access-lost outcome → accessLost explanation state', async () => {
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: async () => ({ ok: false, cause: 'access-lost' }),
    })
    act(() => api.requestSwitch(TARGET))
    await waitFor(() => expect(api.phase).toBe('accessLost'))
    expect(api.target?.name).toBe('我的空间')
    act(() => api.dismiss())
    expect(api.phase).toBe('idle')
  })

  it('a throwing loader is treated as a load error', async () => {
    renderMachine({
      getRunningActivities: () => [],
      loadTargetSpace: async () => { throw new Error('network down') },
    })
    act(() => api.requestSwitch(TARGET))
    await waitFor(() => expect(api.phase).toBe('targetFailed'))
  })
})

describe('useSpaceSwitchFlowMachine · current space name', () => {
  it('reads the active organization name without touching the context', () => {
    renderMachine(
      { getRunningActivities: () => [] },
      {
        accountId: 'account-1',
        activeOrganizationId: 'org-enterprise',
        organizationSummaries: [
          {
            id: 'org-enterprise',
            type: 'enterprise_workspace',
            name: '晨星科技',
            purpose: '',
            membership: { id: 'membership-ent', role: 'member', status: 'active' },
            memberCount: 6,
          },
        ],
        organizationMembershipRole: 'member',
        organizationContextKey: 'account-1:org-enterprise',
        contextVersion: 1,
        onSelectOrganization: () => {},
        onManageOrganization: () => {},
        onCreateOrganization: () => {},
      },
    )
    expect(api.currentSpaceName).toBe('晨星科技')
  })

  it('falls back to an empty name outside an organization provider', () => {
    renderMachine({ getRunningActivities: () => [] })
    expect(api.currentSpaceName).toBe('')
  })
})
