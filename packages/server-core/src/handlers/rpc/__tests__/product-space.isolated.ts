import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  isSwitchInProgress,
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  isRuntimeOfflineReadOnly,
  type RegisteredProductSpaceExecution,
} from '../../../runtime/product-space-executions'
import {
  registerProductSpaceHandlers,
} from '../product-space'
import {
  getRuntimeActiveProductSpace as runtimeActiveSpace,
} from '../../../runtime/product-space-executions'
import {
  setTrustedProductSpaceAccountProvider,
  setTrustedProductSpaceListFetcher,
  type TrustedProductSpaceListSnapshot,
} from '../trusted-product-space-account'

const trustedAccountId = 'account-trusted'
const spaceA = 'space-a'
const spaceB = 'space-b'
const personalId = 'space-personal'

function executionScope(input: {
  executionId: string
  accountId: string
  productSpaceId: string
}): RegisteredProductSpaceExecution['scope'] {
  return ({
    contractVersion: 1,
    executionId: input.executionId,
    accountId: input.accountId,
    productSpaceId: input.productSpaceId,
    workspaceId: `ws-${input.executionId}`,
    subject: {
      kind: 'built_in_app',
      builtInAppId: 'polo_assistant',
    },
  }) as unknown as RegisteredProductSpaceExecution['scope']
}

interface FakeExecutionOptions {
  executionId: string
  accountId?: string
  productSpaceId?: string
  active?: boolean
  rejectProbe?: boolean
  refuseStop?: boolean
}

function fakeExecution(input: FakeExecutionOptions): RegisteredProductSpaceExecution {
  let active = input.active ?? true
  return {
    scope: executionScope({
      executionId: input.executionId,
      accountId: input.accountId ?? trustedAccountId,
      productSpaceId: input.productSpaceId ?? spaceA,
    }),
    kind: 'assistant_session',
    name: input.executionId,
    ref: input.executionId,
    isActive: () => {
      if (input.rejectProbe) return Promise.reject(new Error('probe broken'))
      return active
    },
    stop: async () => {
      if (input.refuseStop) return 'failed'
      active = false
      return 'stopped'
    },
  }
}

function visibleList(): TrustedProductSpaceListSnapshot {
  return {
    personalProductSpaceId: personalId,
    productSpaces: [
      { id: spaceA, kind: 'enterprise', name: 'A', accessMode: 'active' },
      { id: spaceB, kind: 'enterprise', name: 'B', accessMode: 'active' },
      { id: personalId, kind: 'personal', name: '我的空间', accessMode: 'active' },
    ],
  }
}

let listResult: TrustedProductSpaceListSnapshot | null

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return null
    },
  } as unknown as RpcServer
  registerProductSpaceHandlers(server, {
    sessionManager: {
      cancelAllProcessing: async () => {},
      getSessions: () => [],
      deleteSession: async () => {},
    },
  } as unknown as HandlerDeps)
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler for ${channel}`)
    return handler({} as never, ...args)
  }
  return { invoke }
}

beforeEach(() => {
  resetProductSpaceExecutionRegistryForTests()
  setRuntimeActiveProductSpace(spaceA)
  setRuntimeActiveProductSpaceAccount(trustedAccountId)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
  listResult = visibleList()
  setTrustedProductSpaceListFetcher(async () => listResult)
})

describe('execution enumeration fence', () => {
  it('lists only executions bound to the committed active space', async () => {
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a2', active: false,
    }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-b1', productSpaceId: spaceB,
    }))

    const { invoke } = createHarness()
    // Frontend wire contract: (accountId, productSpaceId).
    const result = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      trustedAccountId,
      spaceA,
    )
    expect(result.success).toBe(true)
    expect(result.executions.map((execution: { executionId: string }) => execution.executionId))
      .toEqual(['exec-a1'])
  })

  it('rejects the reversed (server-legacy) argument order', async () => {
    // Anti-regression: the handler once read (productSpaceId, accountId).
    // A call in that order must fail instead of silently succeeding.
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    const { invoke } = createHarness()
    const reversed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
      trustedAccountId,
    )
    expect(reversed.success).toBe(false)
    expect(['FORBIDDEN', 'VALIDATION_ERROR']).toContain(reversed.errorCode)

    const reversedStop = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      spaceB,
      trustedAccountId,
    )
    expect(reversedStop.success).toBe(false)
    expect(['FORBIDDEN', 'VALIDATION_ERROR']).toContain(reversedStop.errorCode)
    expect(
      await Promise.all(
        listRegisteredProductSpaceExecutions().map(execution => execution.isActive()),
      ),
    ).toEqual([true])
  })

  it('stops executions on the forward wire order and rejects the legacy order for the ACTIVE space', async () => {
    // The STOP anti-regression must use the CURRENT active space: a
    // cross-space call would fail for the wrong reason (space mismatch) and
    // miss a parameter-order revert entirely.
    const { invoke } = createHarness()

    // Legacy (reversed) order against the active space: must fail and leave
    // the execution untouched.
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-reverse' }))
    const reversedStop = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      spaceA,
      trustedAccountId,
    )
    expect(reversedStop.success).toBe(false)
    expect(['FORBIDDEN', 'VALIDATION_ERROR']).toContain(reversedStop.errorCode)
    expect(await Promise.all(
      listRegisteredProductSpaceExecutions().map(execution => execution.isActive()),
    )).toEqual([true])

    // Forward wire order (accountId, productSpaceId): succeeds and the
    // execution is really stopped and unregistered.
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-forward' }))
    const forwardStop = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      trustedAccountId,
      spaceA,
    )
    expect(forwardStop.success).toBe(true)
    expect(forwardStop.result.allStopped).toBe(true)
    expect(listRegisteredProductSpaceExecutions().some(
      execution => execution.scope.executionId === 'exec-forward',
    )).toBe(false)
  })

  it('fails closed when no ProductSpace is committed', async () => {
    setRuntimeActiveProductSpace(null)
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    const { invoke } = createHarness()
    const listed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      trustedAccountId,
      spaceA,
    )
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('PRODUCT_SPACE_CONTEXT_REQUIRED')
  })

  it('rejects a space that differs from the committed active space', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-b1', productSpaceId: spaceB,
    }))
    const { invoke } = createHarness()
    const listed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      trustedAccountId,
      spaceB,
    )
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('FORBIDDEN')
    const stopped = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      trustedAccountId,
      spaceB,
    )
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('FORBIDDEN')
    expect(
      await Promise.all(
        listRegisteredProductSpaceExecutions().map(execution => execution.isActive()),
      ),
    ).toEqual([true])
  })

  it('rejects malformed accountId and productSpaceId arguments', async () => {
    const { invoke } = createHarness()
    for (const malformed of [{ accountId: 'x' }, ['account-x'], 42]) {
      const result = await invoke(
        RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
        malformed,
        spaceA,
      )
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('VALIDATION_ERROR')
    }
    for (const malformedSpace of [42, { space: spaceA }, ['space-a'], '']) {
      const result = await invoke(
        RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
        trustedAccountId,
        malformedSpace,
      )
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('VALIDATION_ERROR')
    }
  })

  it('awaits async liveness probes and fails closed on probe rejection', async () => {
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-async-true' }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-async-false', active: false,
    }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-probe-reject', rejectProbe: true,
    }))
    const asyncTrue = fakeExecution({ executionId: 'exec-async-true-2' })
    asyncTrue.isActive = async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return false
    }
    registerProductSpaceExecution(asyncTrue)

    const { invoke } = createHarness()
    const result = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      trustedAccountId,
      spaceA,
    )
    expect(result.success).toBe(true)
    const ids = (result.executions as Array<{ executionId: string }>).map(
      execution => execution.executionId,
    ).sort()
    expect(ids).toEqual(['exec-async-true', 'exec-probe-reject'])
  })
})

describe('Main-side switch transaction', () => {
  it('commits the fence only after every origin execution reached a terminal state', async () => {
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a2' }))

    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    // The plan is returned before anything is stopped.
    expect(prepared.executions.map((execution: { executionId: string }) => execution.executionId).sort())
      .toEqual(['exec-a1', 'exec-a2'])
    expect(getRuntimeActive()).toBe(spaceA)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })

    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(true)
    expect(committed.from).toBe(spaceA)
    expect(committed.to).toBe(spaceB)
    expect(getRuntimeActive()).toBe(spaceB)
    expect(listRegisteredProductSpaceExecutions()).toEqual([])
  })

  it('refuses to commit while an origin execution cannot be stopped and keeps the fence', async () => {
    let refuseStop = true
    let stopped = false
    const stuck: RegisteredProductSpaceExecution = {
      scope: executionScope({
        executionId: 'exec-stuck',
        accountId: trustedAccountId,
        productSpaceId: spaceA,
      }),
      kind: 'assistant_session',
      name: 'exec-stuck',
      ref: 'exec-stuck',
      isActive: () => !stopped,
      stop: async () => {
        if (refuseStop) return 'failed'
        stopped = true
        return 'stopped'
      },
    }
    registerProductSpaceExecution(stuck)

    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)
    expect(await stuck.isActive()).toBe(true)

    const stopResult = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    expect(stopResult.success).toBe(false)
    expect(stopResult.errorCode).toBe('runtime_stop_failed')
    expect(stopResult.executions).toEqual([
      expect.objectContaining({ executionId: 'exec-stuck', status: 'failed' }),
    ])
    expect(getRuntimeActive()).toBe(spaceA)
    expect(await stuck.isActive()).toBe(true)
    // The transaction is consumed on failure — no stale token lingers.
    const lateStop = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    expect(lateStop.success).toBe(false)
    expect(lateStop.errorCode).toBe('SWITCH_TRANSACTION_INVALID')

    // Retry after the runtime becomes stoppable: fresh prepare + stop + commit.
    refuseStop = false
    const retryPrepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(retryPrepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, retryPrepared.token)).toMatchObject({ success: true })
    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      retryPrepared.token,
      spaceB,
    )
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
  }, 20_000)

  it('verifies the target against the account-visible space list', async () => {
    listResult = {
      personalProductSpaceId: personalId,
      productSpaces: [
        { id: spaceA, kind: 'enterprise', name: 'A', accessMode: 'active' },
        { id: personalId, kind: 'personal', name: '我的空间', accessMode: 'active' },
      ],
    }
    const { invoke } = createHarness()
    const result = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)

    // List fetch failure also fails closed.
    listResult = null
    const unavailable = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, personalId)
    expect(unavailable.success).toBe(false)
    expect(unavailable.errorCode).toBe('service_unavailable')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('rejects a commit from another account and re-verifies target visibility', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })

    // The token is bound to the preparing account.
    setTrustedProductSpaceAccountProvider(async () => 'account-other')
    const other = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(other.success).toBe(false)
    expect(other.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)

    // Commit re-verifies target visibility under the current contract.
    setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
    listResult = {
      personalProductSpaceId: personalId,
      productSpaces: [
        { id: spaceA, kind: 'enterprise', name: 'A', accessMode: 'active' },
        { id: personalId, kind: 'personal', name: '我的空间', accessMode: 'active' },
      ],
    }
    const stale = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(stale.success).toBe(false)
    expect(stale.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('rejects malformed switch targets and requires a trusted session', async () => {
    const { invoke } = createHarness()
    for (const malformed of [42, { space: spaceA }, ['space-a'], '']) {
      const result = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, malformed)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('VALIDATION_ERROR')
    }
    setTrustedProductSpaceAccountProvider(async () => null)
    const unauthorized = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(unauthorized.success).toBe(false)
    expect(unauthorized.errorCode).toBe('UNAUTHORIZED')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('blocks starts for the duration of a switch transaction', async () => {
    const { invoke } = createHarness()
    let releaseSwitch!: () => void
    setTrustedProductSpaceListFetcher(async () => {
      // While the transaction verifies the target, the switch is in progress.
      sawSwitchInProgress = isSwitchInProgress()
      return new Promise(resolve => {
        releaseSwitch = () => resolve(visibleList())
      })
    })
    let sawSwitchInProgress = false
    const pending = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    for (let i = 0; i < 300 && !releaseSwitch; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(isSwitchInProgress()).toBe(true)
    releaseSwitch!()
    const result = await pending
    expect(sawSwitchInProgress).toBe(true)
    expect(result.success).toBe(true)
    // The pending transaction window (prepare → stop → commit) keeps new
    // starts blocked even between RPCs…
    expect(isSwitchInProgress()).toBe(true)
    // …and cancellation releases it.
    await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, result.token)
    expect(isSwitchInProgress()).toBe(false)
  })
})

describe('two-phase switch transaction', () => {
  it('prepares with a one-time token, finalizes stops, and commits only with it', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(typeof prepared.token).toBe('string')
    expect(getRuntimeActive()).toBe(spaceA)

    // A commit without the exact token is rejected and consumes nothing.
    const badToken = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      'not-the-token',
      spaceB,
    )
    expect(badToken.success).toBe(false)
    expect(badToken.errorCode).toBe('SWITCH_TRANSACTION_INVALID')

    // A commit before the stop phase finalized is equally invalid.
    const premature = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(premature.success).toBe(false)
    expect(premature.errorCode).toBe('SWITCH_TRANSACTION_INVALID')

    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })
    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)

    // The token is one-time: a replay fails.
    const replay = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(replay.success).toBe(false)
  })

  it('fails the commit when an origin execution appears after the stop phase', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })

    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-late' }))

    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('runtime_stop_failed')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('permanently invalidates a prepared transaction after a revoke', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    expect(getRuntimeActive()).toBeNull()

    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('SWITCH_SUPERSEDED')
    expect(getRuntimeActive()).toBeNull()
  })

  it('cancelling during stopping leaves undispatched executions running', async () => {
    const first = fakeExecution({ executionId: 'exec-c1' })
    const second = fakeExecution({ executionId: 'exec-c2' })
    registerProductSpaceExecution(first)
    registerProductSpaceExecution(second)

    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(prepared.executions).toHaveLength(2)

    // Block inside the first stop dispatch so the loop is still busy on the
    // first execution when the cancel arrives.
    const firstStopStarted = new Promise<void>(resolve => { resolve = resolve })
    let releaseFirstStop!: () => void
    const firstStopReleased = new Promise<void>(resolve => { releaseFirstStop = resolve })
    void firstStopStarted
    const originalFirstStop = first.stop
    let firstStopCalls = 0
    first.stop = async () => {
      firstStopCalls += 1
      await firstStopReleased
      return originalFirstStop()
    }
    const originalSecondStop = second.stop
    let secondStopCalls = 0
    second.stop = async () => {
      secondStopCalls += 1
      return originalSecondStop()
    }
    const stopping = invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    // Wait until the stop phase is inside the first (blocked) dispatch.
    for (let i = 0; i < 300 && firstStopCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(firstStopCalls).toBe(1)
    // Cancel while the first stop is still in flight, then let it finish.
    await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    releaseFirstStop()
    const stopped = await stopping

    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_CANCELLED')
    // The first stop was already dispatched and completed; the second
    // execution was never touched.
    expect(secondStopCalls).toBe(0)
    expect(await second.isActive()).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('cancelling before the stop phase stops nothing at all', async () => {
    const execution = fakeExecution({ executionId: 'exec-c3' })
    registerProductSpaceExecution(execution)
    let stopCalls = 0
    const originalStop = execution.stop
    execution.stop = async () => {
      stopCalls += 1
      return originalStop()
    }

    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    const cancelled = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(cancelled.success).toBe(true)

    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_CANCELLED')
    expect(stopCalls).toBe(0)
    expect(await execution.isActive()).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)
  })
})

describe('offline read-only restore', () => {
  it('fails closed without a verified snapshot', async () => {
    const { invoke } = createHarness()
    const result = await invoke(RPC_CHANNELS.productSpace.RESTORE_OFFLINE_VIEW)
    expect(result.success).toBe(false)
  })

  it('a successful online commit ends the offline read-only view', async () => {
    // Simulate the restored offline view: the fence sits on the origin space
    // with the read-only flag set.
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(isRuntimeOfflineReadOnly()).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })
    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
    // Assistant/App starts consult the same flag — it must be cleared in
    // the same transaction that moved the fence.
    expect(isRuntimeOfflineReadOnly()).toBe(false)
  })

  it('recovers online in-process when the offline view revalidates the same space', async () => {
    // Offline view on spaceA; network returns and bootstrap selects the same
    // space — a plain switch would be a no-op, so the trusted revalidation
    // transaction clears the offline read-only view instead.
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(true)
    expect(isRuntimeOfflineReadOnly()).toBe(true)

    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceA,
    )
    expect(committed.success).toBe(true)
    expect(committed.from).toBe(spaceA)
    expect(committed.to).toBe(spaceA)
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(false)

    // The token is one-time here too.
    const replay = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceA,
    )
    expect(replay.success).toBe(false)
  })

  it('keeps the offline view when the restored space lost membership', async () => {
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    listResult = {
      personalProductSpaceId: personalId,
      productSpaces: [
        { id: spaceB, kind: 'enterprise', name: 'B', accessMode: 'active' },
        { id: personalId, kind: 'personal', name: '我的空间', accessMode: 'active' },
      ],
    }
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(false)
    expect(prepared.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(true)
  })

  it('still rejects a same-space switch outside the offline view', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(false)
    expect(prepared.errorCode).toBe('VALIDATION_ERROR')
    expect(isRuntimeOfflineReadOnly()).toBe(false)
  })

  it('a failed commit keeps the fence and the offline read-only view', async () => {
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)).toMatchObject({ success: true })
    // Target list becomes unavailable between prepare and commit.
    listResult = null
    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceB,
    )
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('service_unavailable')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(true)
  })
})

describe('revoke active context', () => {
  it('clears the fence (fail-closed direction only)', async () => {
    const { invoke } = createHarness()
    const result = await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    expect(result.success).toBe(true)
    expect(getRuntimeActive()).toBeNull()
  })
})

function getRuntimeActive(): string | null {
  return runtimeActiveSpace()
}

describe('legacy direct-switch cleanup', () => {
  it('stops registered executions and reports every step result', async () => {
    const legacy = fakeExecution({ executionId: 'exec-legacy' })
    registerProductSpaceExecution(legacy)
    const { invoke } = createHarness()
    const result = await invoke(RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE)
    expect(result.results.legacyRuntimeStopped).toBe(true)
    expect(result.results.legacyCatalogCacheRemoved).toBe(true)
    expect(result.results.legacySkillCachesRemoved).toBe(true)
    expect(result.results.legacyAuthorizationCacheRemoved).toBe(true)
    expect(result.results.legacyInstallationStateRemoved).toBe(true)
    expect(await legacy.isActive()).toBe(false)
  })
})
