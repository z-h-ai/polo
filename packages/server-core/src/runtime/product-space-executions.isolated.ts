import { describe, expect, it } from 'bun:test'
import {
  EXECUTION_STOP_DRAIN_TIMEOUT_MS,
  onRuntimeScopeChanged,
  setRuntimeActiveProductSpace,
  getRuntimeActiveProductSpace,
  getRegisteredProductSpaceExecution,
  getRegisteredProductSpaceExecutionGeneration,
  stopAllRegisteredProductSpaceExecutions,
  stopRegisteredProductSpaceExecutionsForAccount,
  stopRegisteredProductSpaceExecutionsForSpace,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  unregisterProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
  stopRegisteredExecutionsOnce,
  type RegisteredProductSpaceExecution,
} from './product-space-executions'

describe('runtime owner teardown completion', () => {
  function runtime(stop: () => Promise<'stopped' | 'failed'>, isActive: () => boolean): RegisteredProductSpaceExecution {
    return { ...executionWithNeverResolvingStop(), kind: 'local_app', scope: {
      ...executionWithNeverResolvingStop().scope, executionId: 'self-teardown',
    } as never, stop, isActive }
  }

  it('accepts a healthy runtime that unregisters itself during its real stop', async () => {
    resetProductSpaceExecutionRegistryForTests()
    let active = true
    registerProductSpaceExecution(runtime(async () => {
      active = false
      unregisterProductSpaceExecution('self-teardown')
      return 'stopped'
    }, () => active))
    expect(await stopRegisteredProductSpaceExecutionsForSpace('account-a', 'space-a'))
      .toEqual({ ok: true, failedExecutionIds: [] })
    expect(getRegisteredProductSpaceExecution('self-teardown')).toBeUndefined()
  })

  for (const outcome of ['failed', 'rejected'] as const) {
    it(`keeps a ${outcome} stop failed even if teardown already unregistered`, async () => {
      resetProductSpaceExecutionRegistryForTests()
      let active = true
      let release!: () => void
      const acknowledged = new Promise<void>(resolve => { release = resolve })
      registerProductSpaceExecution(runtime(async () => {
        active = false
        unregisterProductSpaceExecution('self-teardown')
        await acknowledged
        if (outcome === 'rejected') throw undefined
        return 'failed'
      }, () => active))
      let settled = false
      const pending = stopRegisteredProductSpaceExecutionsForSpace('account-a', 'space-a')
        .then(result => { settled = true; return result })
      try {
        await new Promise(resolve => setTimeout(resolve, 100))
        // Disappearance/liveness alone cannot certify the owner's result.
        expect(settled).toBe(false)
      } finally { release() }
      expect(await pending).toEqual({ ok: false, failedExecutionIds: ['self-teardown'] })
    })
  }

  it('retains supersession when a replacement appears and disappears while the removed owner acknowledges', async () => {
    resetProductSpaceExecutionRegistryForTests()
    let active = true
    let stopStarted!: () => void
    const started = new Promise<void>(resolve => { stopStarted = resolve })
    let acknowledge!: () => void
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve })
    registerProductSpaceExecution(runtime(async () => {
      active = false
      unregisterProductSpaceExecution('self-teardown')
      stopStarted()
      await acknowledged
      return 'stopped'
    }, () => active))
    const pending = stopRegisteredProductSpaceExecutionsForSpace('account-a', 'space-a')
    await started
    registerProductSpaceExecution(runtime(async () => 'stopped', () => false))
    unregisterProductSpaceExecution('self-teardown')
    acknowledge()
    expect(await pending).toEqual({ ok: false, failedExecutionIds: ['self-teardown'] })
  })
})

function executionWithNeverResolvingStop(): RegisteredProductSpaceExecution {
  return {
    scope: {
      contractVersion: 1,
      executionId: 'exec-never-resolving-stop',
      accountId: 'account-a',
      productSpaceId: 'space-a',
      workspaceId: 'ws-a',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
    } as never,
    kind: 'assistant_session',
    name: 'stuck runtime',
    ref: 'session-a',
    generation: 0,
    isActive: () => true,
    stop: () => new Promise<'stopped'>(() => {
      // Never resolves: a broken or malicious implementation must not extend
      // the stop window beyond the shared deadline.
    }),
  }
}

describe('stopRegisteredExecutionsOnce bounded window', () => {
  it('returns a bounded failure when a stop call never resolves', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const stuck = executionWithNeverResolvingStop()
    registerProductSpaceExecution(stuck)

    const startedAt = Date.now()
    const results = await stopRegisteredExecutionsOnce([stuck])
    const elapsed = Date.now() - startedAt

    expect(results).toEqual([{
      executionId: 'exec-never-resolving-stop',
      status: 'failed',
      errorCode: 'runtime_stop_failed',
    }])
    // The whole window stays bounded by the shared deadline even though the
    // stop promise never settles.
    expect(elapsed).toBeLessThan(EXECUTION_STOP_DRAIN_TIMEOUT_MS + 2_500)
    // The entry stays registered for retry.
    expect(listRegisteredProductSpaceExecutions()
      .some(execution => execution.scope.executionId === 'exec-never-resolving-stop'))
      .toBe(true)
  }, EXECUTION_STOP_DRAIN_TIMEOUT_MS + 5_000)

  it('preserves per-execution outcomes when one sibling stop never resolves', async () => {
    resetProductSpaceExecutionRegistryForTests()

    // A well-behaved execution that stops immediately.
    let fastActive = true
    let fastStopCalls = 0
    const fast: RegisteredProductSpaceExecution = {
      scope: {
        contractVersion: 1,
        executionId: 'exec-fast',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'fast runtime',
      ref: 'session-fast',
      generation: 0,
      isActive: () => fastActive,
      stop: async () => {
        fastStopCalls += 1
        fastActive = false
        return 'stopped'
      },
    }
    // A broken execution whose stop call never settles.
    const stuck = executionWithNeverResolvingStop()
    registerProductSpaceExecution(fast)
    registerProductSpaceExecution(stuck)

    const results = await stopRegisteredExecutionsOnce([fast, stuck])
    const byId = new Map(results.map(result => [result.executionId, result]))

    // The fast execution is confirmed stopped, unregistered, and NOT marked
    // failed by its sibling's hang.
    expect(byId.get('exec-fast')).toEqual({ executionId: 'exec-fast', status: 'stopped' })
    expect(fastStopCalls).toBe(1)
    expect(listRegisteredProductSpaceExecutions()
      .some(execution => execution.scope.executionId === 'exec-fast'))
      .toBe(false)
    // The stuck one keeps the retryable failed state and its registration.
    expect(byId.get('exec-never-resolving-stop')).toEqual({
      executionId: 'exec-never-resolving-stop',
      status: 'failed',
      errorCode: 'runtime_stop_failed',
    })
    expect(listRegisteredProductSpaceExecutions()
      .some(execution => execution.scope.executionId === 'exec-never-resolving-stop'))
      .toBe(true)
  }, EXECUTION_STOP_DRAIN_TIMEOUT_MS + 5_000)

  it('a same-ID replacement registered during the old drain survives the terminal cleanup (R33-4/R34-4)', async () => {
    resetProductSpaceExecutionRegistryForTests()

    // The OLD execution's liveness probe blocks until the test releases it,
    // which is exactly the awaited-drain window the review identified.
    let releaseOldProbe: () => void = () => {}
    const oldProbeGate = new Promise<void>(resolve => {
      releaseOldProbe = resolve
    })
    let oldProbeCalls = 0
    const old: RegisteredProductSpaceExecution = {
      scope: {
        contractVersion: 1,
        executionId: 'exec-reuse',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'old turn',
      ref: 'session-a',
      generation: 0,
      isActive: async () => {
        oldProbeCalls += 1
        if (oldProbeCalls === 1) await oldProbeGate
        return false
      },
      stop: async () => 'stopped',
    }
    // R34-4: registration returns the fresh REGISTRY-OWNED entry; the
    // producer object is copied, never mutated.
    const ownedOld = registerProductSpaceExecution(old)
    expect(ownedOld).not.toBe(old)
    expect(old.generation).toBe(0)
    const oldGeneration = ownedOld.generation

    // The stale stop starts and enters the old entry's terminal probe.
    const pending = stopRegisteredExecutionsOnce([old])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(oldProbeCalls).toBe(1)

    // A same-ID replacement registers while the old stop is still awaiting
    // its probe — reachable in production after a cancelled switch re-opens
    // starts and an Assistant send deliberately reuses the session ID.
    const replacement: RegisteredProductSpaceExecution = {
      scope: {
        contractVersion: 1,
        executionId: 'exec-reuse',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'replacement turn',
      ref: 'session-a',
      generation: 0,
      isActive: () => true,
      stop: async () => 'stopped',
    }
    const ownedReplacement = registerProductSpaceExecution(replacement)
    expect(ownedReplacement.generation).not.toBe(oldGeneration)

    // The old probe now observes terminal and the stale cleanup completes.
    releaseOldProbe()
    const results = await pending
    // The work reached terminal, but the slot now belongs to the newer
    // registration: the outcome is truthfully flagged superseded.
    expect(results).toEqual([{ executionId: 'exec-reuse', status: 'stopped', superseded: true }])

    // The generation CAS kept the REPLACEMENT registered — the stale stop
    // could never delete the newer ownership.
    const survivor = getRegisteredProductSpaceExecution('exec-reuse')
    expect(survivor).toBe(ownedReplacement)
    expect(getRegisteredProductSpaceExecutionGeneration('exec-reuse')).toBe(ownedReplacement.generation)
  })

  it('re-registering the SAME producer object during the old drain is a new generation the stale stop cannot delete (R34-4)', async () => {
    resetProductSpaceExecutionRegistryForTests()

    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const shared: RegisteredProductSpaceExecution = {
      scope: {
        contractVersion: 1,
        executionId: 'exec-same-object',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'shared producer',
      ref: 'session-a',
      generation: 0,
      isActive: async () => {
        await probeGate
        return false
      },
      stop: async () => 'stopped',
    }

    const first = registerProductSpaceExecution(shared)
    const pending = stopRegisteredExecutionsOnce([shared])
    await new Promise(resolve => setTimeout(resolve, 30))

    // The exact review exploit: the SAME caller object is re-registered
    // while the old terminal probe is still awaited. The registry-owned
    // clone makes this a NEW generation — the stale stop can neither delete
    // it nor claim its ownership, and the caller object was never mutated
    // into the replacement.
    const second = registerProductSpaceExecution(shared)
    expect(second).not.toBe(first)
    expect(second.generation).not.toBe(first.generation)
    expect(shared.generation).toBe(0)

    releaseProbe()
    const results = await pending
    expect(results).toEqual([{ executionId: 'exec-same-object', status: 'stopped', superseded: true }])

    const survivor = getRegisteredProductSpaceExecution('exec-same-object')
    expect(survivor).toBe(second)
    expect(getRegisteredProductSpaceExecutionGeneration('exec-same-object')).toBe(second.generation)
  })
})

describe('aggregate stop supersession (R35-3)', () => {
  const scopedProducer = (executionId: string, gate: Promise<void>): RegisteredProductSpaceExecution => ({
    scope: {
      contractVersion: 1,
      executionId,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      workspaceId: 'ws-a',
      subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
    } as never,
    kind: 'assistant_session',
    name: executionId,
    ref: executionId,
    generation: 0,
    isActive: async () => {
      await gate
      return false
    },
    stop: async () => 'stopped',
  })

  it('account cleanup reports a surviving same-object replacement as nonterminal (R35-3)', async () => {
    resetProductSpaceExecutionRegistryForTests()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const producer = scopedProducer('exec-agg-account', probeGate)
    registerProductSpaceExecution(producer)

    const pending = stopRegisteredProductSpaceExecutionsForAccount('account-a')
    await new Promise(resolve => setTimeout(resolve, 30))
    // The SAME object re-registers during the awaited drain: a new
    // registry-owned generation takes the slot. The replacement carries its
    // OWN live liveness — it is a genuinely running new turn.
    const replacement = registerProductSpaceExecution(producer)
    replacement.isActive = () => true
    releaseProbe()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.failedExecutionIds).toEqual(['exec-agg-account'])
    // The replacement survives, active, still blocking.
    expect(getRegisteredProductSpaceExecution('exec-agg-account')).toBe(replacement)
    expect(await replacement.isActive()).toBe(true)
  })

  it('restriction cleanup reports a surviving distinct-object replacement as nonterminal (R35-3)', async () => {
    resetProductSpaceExecutionRegistryForTests()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const old = scopedProducer('exec-agg-space', probeGate)
    registerProductSpaceExecution(old)

    const pending = stopRegisteredProductSpaceExecutionsForSpace('account-a', 'space-a')
    await new Promise(resolve => setTimeout(resolve, 30))
    const replacement = scopedProducer('exec-agg-space', Promise.resolve())
    replacement.isActive = () => true
    const ownedReplacement = registerProductSpaceExecution(replacement)
    releaseProbe()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.failedExecutionIds).toEqual(['exec-agg-space'])
    expect(getRegisteredProductSpaceExecution('exec-agg-space')).toBe(ownedReplacement)
  })

  it('the legacy stop-all cleanup treats superseded as nonterminal (R35-3)', async () => {
    resetProductSpaceExecutionRegistryForTests()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const producer = scopedProducer('exec-agg-all', probeGate)
    registerProductSpaceExecution(producer)

    const pending = stopAllRegisteredProductSpaceExecutions()
    await new Promise(resolve => setTimeout(resolve, 30))
    const replacement = registerProductSpaceExecution(producer)
    replacement.isActive = () => true
    releaseProbe()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.failedExecutionIds).toEqual(['exec-agg-all'])
    expect(getRegisteredProductSpaceExecution('exec-agg-all')).toBe(replacement)
  })
})

describe('per-call stop-drain deadline isolation (R39-6)', () => {
  function gatedExecution(id: string): { execution: RegisteredProductSpaceExecution; deactivate: () => void } {
    let active = true
    return {
      execution: {
        scope: {
          contractVersion: 1,
          executionId: id,
          accountId: 'account-a',
          productSpaceId: 'space-a',
          workspaceId: 'ws-a',
          subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
        } as never,
        kind: 'assistant_session',
        name: id,
        ref: id,
        generation: 0,
        isActive: async () => active,
        getStatus: () => (active ? 'running' : 'stopping'),
        stop: async () => 'failed',
      },
      deactivate: () => {
        active = false
      },
    }
  }

  it('a per-call short deadline never leaks into a concurrent unrelated stop (R39-6)', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const unrelated = gatedExecution('unrelated-production-stop')
    const intended = gatedExecution('intended-short-stop')

    // The unrelated stop uses the PRODUCTION deadline (no options).
    const unrelatedRun = stopRegisteredExecutionsOnce([unrelated.execution])
    // The intended test-owned stop injects a short per-call deadline.
    const intendedRun = stopRegisteredExecutionsOnce([intended.execution], { drainTimeoutMs: 30 })

    // The intended stop completes under its short window (~30ms)…
    expect((await intendedRun)[0]?.status).toBe('failed')

    // …while the unrelated concurrent stop is STILL running — the short
    // per-call deadline did not leak into it (production 10s window intact).
    const unrelatedStillRunning = await Promise.race([
      unrelatedRun.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 150)),
    ])
    expect(unrelatedStillRunning).toBe(true)

    // Release the unrelated execution's controllable isActive flag and
    // await its cleanup — no floating promises or timers remain. The drain
    // observes the terminal flip and finishes promptly.
    unrelated.deactivate()
    const unrelatedResults = await unrelatedRun
    expect(unrelatedResults[0]?.executionId).toBe('unrelated-production-stop')
    expect(getRegisteredProductSpaceExecution('unrelated-production-stop')).toBeUndefined()
    resetProductSpaceExecutionRegistryForTests()
  })

  it('a failing short-deadline stop leaves no residual deadline state (R39-6)', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const first = gatedExecution('first-short-failed')
    const firstRun = stopRegisteredExecutionsOnce([first.execution], { drainTimeoutMs: 30 })
    // The short-deadline stop fails; per-call options carry no state, so
    // nothing needs restoring — proven by the immediately following
    // default-deadline stop still occupying its full production window.
    expect((await firstRun)[0]?.status).toBe('failed')

    const second = gatedExecution('second-default-stop')
    const secondRun = stopRegisteredExecutionsOnce([second.execution])
    const secondStillRunning = await Promise.race([
      secondRun.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 150)),
    ])
    expect(secondStillRunning).toBe(true)

    second.deactivate()
    expect((await secondRun)[0]?.executionId).toBe('second-default-stop')
    expect(getRegisteredProductSpaceExecution('second-default-stop')).toBeUndefined()
    resetProductSpaceExecutionRegistryForTests()
  })
})


describe('runtime scope invalidation observers', () => {
  it('a failed consumer cannot interrupt committed scope state or later owner cleanup', () => {
    let cleaned = false
    const offFailure = onRuntimeScopeChanged(() => { throw new Error('injected listener failure') })
    const offCleanup = onRuntimeScopeChanged(() => { cleaned = true })
    try {
      expect(() => setRuntimeActiveProductSpace('next-space')).not.toThrow()
      expect(getRuntimeActiveProductSpace()).toBe('next-space')
      expect(cleaned).toBe(true)
    } finally { offFailure(); offCleanup(); setRuntimeActiveProductSpace(null) }
  })
})
