import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  getRegisteredProductSpaceExecution,
  isRuntimeProductSpaceRestricted,
  unregisterProductSpaceExecution,
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
import { withSwitchLock } from '../../../runtime/switch-lock-internal'
import {
  registerProductSpaceHandlers,
  stopAllProductSpaceExecutions,
} from '../product-space'
import {
  getRuntimeActiveProductSpace as runtimeActiveSpace,
} from '../../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
  setTrustedProductSpaceListFetcher,
  type TrustedProductSpaceListResult,
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
    generation: 0,
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

/**
 * The falsy states of the trusted list fetcher: `null` is a transient
 * outage, `contract_unsupported` is the typed contract incompatibility that
 * must survive into the switch transaction verbatim.
 */
let listResult: TrustedProductSpaceListSnapshot | null | 'contract_unsupported'

function listFetcherResult(): TrustedProductSpaceListResult {
  if (listResult === 'contract_unsupported') {
    return { ok: false, errorCode: 'product_space_contract_unsupported' }
  }
  if (listResult === null) return { ok: false, errorCode: 'service_unavailable' }
  return { ok: true, list: listResult }
}

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
  // The synchronous trusted-account mirror is the lock-free authenticator
  // for the pending-cancel gate; the harness keeps it bound to the same
  // trusted account the provider resolves.
  setSyncTrustedProductSpaceAccountId(trustedAccountId)
  listResult = visibleList()
  setTrustedProductSpaceListFetcher(async () => listFetcherResult())
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
      generation: 0,
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
      return new Promise<TrustedProductSpaceListResult>(resolve => {
        releaseSwitch = () => resolve({ ok: true, list: visibleList() })
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
    // R34-4: behavior hooks are adjusted on the REGISTRY-OWNED entry — the
    // producer object is only a registration request.
    const ownedFirst = registerProductSpaceExecution(first)
    const ownedSecond = registerProductSpaceExecution(second)

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
    const originalFirstStop = ownedFirst.stop
    let firstStopCalls = 0
    ownedFirst.stop = async () => {
      firstStopCalls += 1
      await firstStopReleased
      return originalFirstStop()
    }
    const originalSecondStop = ownedSecond.stop
    let secondStopCalls = 0
    ownedSecond.stop = async () => {
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
    const ownedExecution = registerProductSpaceExecution(execution)
    let stopCalls = 0
    const originalStop = ownedExecution.stop
    ownedExecution.stop = async () => {
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

  it('keeps the commit cancellable through the final authoritative list await', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })

    // Gate the final authoritative list fetch: COMMIT must hold the
    // transaction PENDING (cancellable) while it awaits, not consume it.
    let fetchCalls = 0
    let releaseList!: () => void
    const gatedList = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseList = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      return gatedList
    })

    const committing = invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    for (let i = 0; i < 300 && fetchCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fetchCalls).toBe(1)

    // The user cancels while the commit is still awaiting the list: the
    // pending transaction must still exist and accept the cancellation.
    const cancelled = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(cancelled.success).toBe(true)
    expect(cancelled.outcome).toBe('cancelled')

    releaseList()
    const committed = await committing
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('SWITCH_CANCELLED')
    // The fence never moved and the switch-in-progress gate is released.
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isSwitchInProgress()).toBe(false)
    // The failed commit consumed the tombstoned transaction: a replay is
    // invalid and cannot revive it.
    const replay = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(replay.success).toBe(false)
    expect(replay.errorCode).toBe('SWITCH_TRANSACTION_INVALID')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('reports already_committed with the authoritative fence when the cancel arrives after the commit won', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })

    // Gate the final authoritative list so the cancel can only be scheduled
    // after the commit already passed its final gate and wrote the fence.
    let fetchCalls = 0
    let releaseList!: () => void
    const gatedList = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseList = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      return gatedList
    })

    const committing = invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    for (let i = 0; i < 300 && fetchCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    releaseList()
    const committed = await committing
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)

    // The late cancellation must learn that the commit won — with the
    // committed target and the CURRENT authoritative fence read-back —
    // instead of receiving a meaningless no-op success.
    const lateCancel = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(lateCancel.success).toBe(true)
    expect(lateCancel.outcome).toBe('already_committed')
    expect(lateCancel.committedTargetProductSpaceId).toBe(spaceB)
    expect(lateCancel.activeProductSpaceId).toBe(spaceB)
    expect(getRuntimeActive()).toBe(spaceB)

    // An unknown token matches nothing: stay-put verdict.
    const unknown = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, 'not-a-known-token')
    expect(unknown.success).toBe(true)
    expect(unknown.outcome).toBe('no_transaction')
  })

  it('never authenticates the committed anchor across an account replacement', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)

    // Account replacement: the trusted Admin session now belongs to another
    // account (the replacement also revoked the replaced account's fence).
    setTrustedProductSpaceAccountProvider(async () => 'account-other')
    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    setRuntimeActiveProductSpace(spaceB)
    setRuntimeActiveProductSpaceAccount('account-other')

    // The delayed account-A cancel can neither authenticate nor disclose
    // anything about account B's fence.
    const stale = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(stale.success).toBe(true)
    expect(stale.outcome).toBe('no_transaction')
    expect(stale.committedTargetProductSpaceId).toBeUndefined()
    expect(stale.activeProductSpaceId).toBeUndefined()

    // The anchor is also fence-generation-bound: even the ORIGINAL account
    // cannot revive it after the revoke/rebind (the record was cleared
    // atomically with the fence mutation).
    setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
    setRuntimeActiveProductSpace(spaceB)
    setRuntimeActiveProductSpaceAccount(trustedAccountId)
    const revived = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(revived.success).toBe(true)
    expect(revived.outcome).toBe('no_transaction')
  })

  it('invalidates the committed anchor when the fence is revoked', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(true)

    // Logout/contract-loss revoke: the anchor dies with the fence.
    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    expect(getRuntimeActive()).toBeNull()
    const afterRevoke = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(afterRevoke.success).toBe(true)
    expect(afterRevoke.outcome).toBe('no_transaction')

    // An offline restore re-commits a fence (account-scoped read-only view):
    // that rebind also invalidates the anchor — restore needs a verified
    // snapshot, so here a fresh commit re-establishes and a fence rewrite
    // through the same primitives is proven instead.
    const prepared2 = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared2.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared2.token))
      .toMatchObject({ success: true })
    const recommitted = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared2.token, spaceB)
    expect(recommitted.success).toBe(true)
    // The OLD token still does not match the NEW anchor record.
    const oldToken = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    expect(oldToken.outcome).toBe('no_transaction')
    const newToken = await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared2.token)
    expect(newToken.outcome).toBe('already_committed')
    expect(newToken.activeProductSpaceId).toBe(spaceB)
  })

  it('keeps the switch lock free while COMMIT verifies the target and loses to a concurrent revoke', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })

    let fetchCalls = 0
    let releaseList!: () => void
    const gatedList = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseList = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      return gatedList
    })

    const committing = invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    for (let i = 0; i < 300 && fetchCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fetchCalls).toBe(1)

    // Bounded-concurrency proof of the global lock order: while COMMIT is
    // inside its (Admin-session-lock-taking) list fetch, the switch lock
    // MUST be acquirable — account replacement's revoke path depends on it.
    const lockAcquired = await Promise.race([
      withSwitchLock(async () => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    expect(lockAcquired).toBe(true)

    // A revoke completing inside that window (as account replacement does)
    // advances the fence generation; the stale commit must lose against it.
    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    releaseList()
    const committed = await committing
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('SWITCH_SUPERSEDED')
    expect(getRuntimeActive()).toBeNull()
    expect(isSwitchInProgress()).toBe(false)
  })

  it('keeps the switch lock free while PREPARE verifies the target and loses to a concurrent revoke', async () => {
    const { invoke } = createHarness()
    let fetchCalls = 0
    let releaseList!: () => void
    const gatedList = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseList = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      return gatedList
    })

    const preparing = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    for (let i = 0; i < 300 && fetchCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(fetchCalls).toBe(1)

    const lockAcquired = await Promise.race([
      withSwitchLock(async () => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    expect(lockAcquired).toBe(true)

    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    releaseList()
    const prepared = await preparing
    expect(prepared.success).toBe(false)
    expect(prepared.errorCode).toBe('SWITCH_SUPERSEDED')
    expect(getRuntimeActive()).toBeNull()
    // No transaction was created against the revoked fence.
    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, 'any-token')
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_TRANSACTION_INVALID')
    expect(isSwitchInProgress()).toBe(false)
  })

  it('still commits through a deferred authoritative list when nothing cancels', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })

    let fetchCalls = 0
    let releaseList!: () => void
    const gatedList = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseList = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      return gatedList
    })

    const committing = invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    for (let i = 0; i < 300 && fetchCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    releaseList()
    const committed = await committing
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
    const replay = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(replay.success).toBe(false)
  })

  it('fails PREPARE with the typed contract error and prepares no transaction', async () => {
    const { invoke } = createHarness()
    listResult = 'contract_unsupported'
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(false)
    expect(prepared.errorCode).toBe('product_space_contract_unsupported')
    expect(getRuntimeActive()).toBe(spaceA)
    // No transaction was created: any stop request finds nothing.
    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, 'any-token')
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_TRANSACTION_INVALID')
    expect(isSwitchInProgress()).toBe(false)
  })

  it('fails COMMIT closed on an incompatible contract and keeps the fence', async () => {
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })

    listResult = 'contract_unsupported'
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('product_space_contract_unsupported')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isSwitchInProgress()).toBe(false)
    // The consumed transaction cannot commit again after the contract loss.
    const replay = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(replay.success).toBe(false)
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('a late superseded PREPARE never replaces the newer transaction and B carries through STOP and COMMIT', async () => {
    const { invoke } = createHarness()
    // Two overlapping prepares with opposite fetch completion order: A
    // claims its intent first but its authoritative list resolves LAST.
    const fetchOrder: string[] = []
    let releaseListA!: () => void
    const gatedListA = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseListA = () => resolve({ ok: true, list: visibleList() })
    })
    setTrustedProductSpaceListFetcher(async () => {
      fetchOrder.push(fetchOrder.length === 0 ? 'A' : 'B')
      if (fetchOrder.length === 1) return gatedListA
      return { ok: true, list: visibleList() }
    })

    const preparingA = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    for (let i = 0; i < 300 && fetchOrder.length < 1; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const preparingB = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    // B completes first (its fetch resolves immediately) and installs the
    // pending transaction with token B.
    const preparedB = await preparingB
    expect(preparedB.success).toBe(true)
    expect(typeof preparedB.token).toBe('string')

    // Late A finishes after B: it must be rejected WITHOUT replacing,
    // cancelling or consuming B's pending transaction.
    releaseListA()
    const preparedA = await preparingA
    expect(preparedA.success).toBe(false)
    expect(preparedA.errorCode).toBe('SWITCH_SUPERSEDED')

    // B's token still carries through the whole transaction.
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, preparedB.token))
      .toMatchObject({ success: true })
    const committedB = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, preparedB.token, spaceB)
    expect(committedB.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
  })

  it('a cancellation received after the first stop dispatch prevents the second dispatch even while the Admin resolver is unavailable', async () => {
    const first = fakeExecution({ executionId: 'exec-d1' })
    const second = fakeExecution({ executionId: 'exec-d2' })
    const ownedFirst = registerProductSpaceExecution(first)
    const ownedSecond = registerProductSpaceExecution(second)

    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    expect(prepared.executions).toHaveLength(2)

    // Block inside the first stop dispatch; while it is in flight the Admin
    // account resolver (Admin session lock) is UNAVAILABLE.
    let releaseFirstStop!: () => void
    const firstStopReleased = new Promise<void>(resolve => { releaseFirstStop = resolve })
    const originalFirstStop = ownedFirst.stop
    let firstStopCalls = 0
    ownedFirst.stop = async () => {
      firstStopCalls += 1
      await firstStopReleased
      return originalFirstStop()
    }
    const originalSecondStop = ownedSecond.stop
    let secondStopCalls = 0
    ownedSecond.stop = async () => {
      secondStopCalls += 1
      return originalSecondStop()
    }
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(trustedAccountId) })
    // The provider stays available for STOP's own start-of-handler
    // resolution, then becomes unavailable (Admin session lock held) —
    // CANCEL must not need it for the pending cancellation gate.
    let providerGated = false
    setTrustedProductSpaceAccountProvider(async () => {
      if (!providerGated) return trustedAccountId
      return gatedProvider
    })

    const stopping = invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    for (let i = 0; i < 300 && firstStopCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(firstStopCalls).toBe(1)
    providerGated = true

    // The user cancels while the first stop is blocked and the Admin
    // resolver cannot answer: the synchronous pending-cancel gate must mark
    // the transaction cancelled WITHOUT any await.
    const cancelled = await Promise.race([
      invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancel waited on the Admin lock')), 500)),
    ])
    expect(cancelled.success).toBe(true)
    expect(cancelled.outcome).toBe('cancelled')

    // The first (already dispatched) stop finishes; the second execution
    // must NEVER be dispatched and the stop phase reports SWITCH_CANCELLED.
    releaseFirstStop()
    const stopped = await stopping
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_CANCELLED')
    expect(secondStopCalls).toBe(0)
    expect(await second.isActive()).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)

    // Cleanup: the pending tombstone is consumed; release the provider for
    // later asserts.
    releaseProvider()
  })

  it('a newer prepare intent supersedes PREPARE A even when B ends in a typed contract error (final post-await CAS)', async () => {
    const { invoke } = createHarness()
    // An origin execution whose liveness probe A blocks on.
    const probeExecution = fakeExecution({ executionId: 'exec-probe' })
    let releaseProbe!: () => void
    const probeReleased = new Promise<void>(resolve => { releaseProbe = () => resolve() })
    const originalIsActive = probeExecution.isActive
    let probeCalls = 0
    probeExecution.isActive = () => {
      probeCalls += 1
      return probeReleased.then(() => originalIsActive())
    }
    registerProductSpaceExecution(probeExecution)

    // Fetch sequencing: call 1 (A) gates; call 2 (B) returns the typed
    // contract error.
    let releaseListA!: () => void
    const gatedListA = new Promise<TrustedProductSpaceListResult>(resolve => {
      releaseListA = () => resolve({ ok: true, list: visibleList() })
    })
    let fetchCalls = 0
    setTrustedProductSpaceListFetcher(async () => {
      fetchCalls += 1
      if (fetchCalls === 1) return gatedListA
      return { ok: false, errorCode: 'product_space_contract_unsupported' }
    })

    const preparingA = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    for (let i = 0; i < 300 && fetchCalls < 1; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    releaseListA()
    // A passes its early intent CAS and blocks inside the liveness probe.
    for (let i = 0; i < 300 && probeCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(probeCalls).toBe(1)

    // B claims the NEWER intent (synchronously at handler start) and ends in
    // a typed contract error.
    const preparingB = invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    // Let B's handler claim its intent (it then queues for the switch lock
    // behind A's probe-blocked critical section).
    await new Promise(resolve => setTimeout(resolve, 25))

    // A resumes after the probe: the final post-await intent CAS must
    // reject it — A never publishes a usable token. A's release also lets
    // B enter the critical section and report its typed contract error.
    releaseProbe()
    const preparedA = await preparingA
    const preparedB = await preparingB
    expect(preparedA.success).toBe(false)
    expect(preparedA.errorCode).toBe('SWITCH_SUPERSEDED')
    expect(preparedB.success).toBe(false)
    expect(preparedB.errorCode).toBe('product_space_contract_unsupported')

    // Neither prepare left a pending transaction behind.
    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, 'any-token')
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('SWITCH_TRANSACTION_INVALID')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isSwitchInProgress()).toBe(false)
  })

  it('a stale STOP loop mismatch cannot consume the newer prepare (loop-mismatch regression)', async () => {
    const first = fakeExecution({ executionId: 'exec-e1' })
    const second = fakeExecution({ executionId: 'exec-e2' })
    const ownedFirst = registerProductSpaceExecution(first)
    const ownedSecond = registerProductSpaceExecution(second)

    const { invoke } = createHarness()
    const preparedA = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(preparedA.success).toBe(true)

    // Gate the FIRST stop dispatch so A is mid-loop.
    let releaseFirstStop!: () => void
    const firstStopReleased = new Promise<void>(resolve => { releaseFirstStop = () => resolve() })
    const originalFirstStop = ownedFirst.stop
    let firstStopCalls = 0
    ownedFirst.stop = async () => {
      firstStopCalls += 1
      await firstStopReleased
      return originalFirstStop()
    }
    const originalSecondStop = ownedSecond.stop
    let secondStopCalls = 0
    ownedSecond.stop = async () => {
      secondStopCalls += 1
      return originalSecondStop()
    }

    const stopping = invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, preparedA.token)
    for (let i = 0; i < 300 && firstStopCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(firstStopCalls).toBe(1)

    // PREPARE B replaces the pending record while A is mid-loop.
    const preparedB = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, personalId)
    expect(preparedB.success).toBe(true)

    releaseFirstStop()
    // A's loop gate must detect the newer transaction and leave it intact —
    // the second execution is never dispatched.
    const stoppedA = await stopping
    expect(stoppedA.success).toBe(false)
    expect(stoppedA.errorCode).toBe('SWITCH_SUPERSEDED')
    expect(secondStopCalls).toBe(0)
    expect(await second.isActive()).toBe(true)

    // B carries through STOP and COMMIT.
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, preparedB.token))
      .toMatchObject({ success: true })
    const committedB = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, preparedB.token, personalId)
    expect(committedB.success).toBe(true)
    expect(getRuntimeActive()).toBe(personalId)
  })

  it('a stale STOP finalization mismatch cannot consume the newer prepare (finalization regression)', async () => {
    const only = fakeExecution({ executionId: 'exec-e3' })
    const ownedOnly = registerProductSpaceExecution(only)

    const { invoke } = createHarness()
    const preparedA = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(preparedA.success).toBe(true)

    let releaseOnlyStop!: () => void
    const onlyStopReleased = new Promise<void>(resolve => { releaseOnlyStop = () => resolve() })
    const originalOnlyStop = ownedOnly.stop
    let onlyStopCalls = 0
    ownedOnly.stop = async () => {
      onlyStopCalls += 1
      await onlyStopReleased
      return originalOnlyStop()
    }

    const stopping = invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, preparedA.token)
    for (let i = 0; i < 300 && onlyStopCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(onlyStopCalls).toBe(1)

    // PREPARE B replaces the pending record while A's only dispatch is in
    // flight: A proceeds straight to finalization after the release.
    const preparedB = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, personalId)
    expect(preparedB.success).toBe(true)

    releaseOnlyStop()
    const stoppedA = await stopping
    expect(stoppedA.success).toBe(false)
    expect(stoppedA.errorCode).toBe('SWITCH_SUPERSEDED')

    // R31-6: stale A's finalization released only its own activity claim —
    // B's switch activity stays owned by B through STOP and COMMIT.
    expect(isSwitchInProgress()).toBe(true)
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, preparedB.token))
      .toMatchObject({ success: true })
    expect(isSwitchInProgress()).toBe(true)
    const committedB = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, preparedB.token, personalId)
    expect(committedB.success).toBe(true)
    expect(getRuntimeActive()).toBe(personalId)
    // B's commit consumed the pending transaction and every claim is gone.
    expect(isSwitchInProgress()).toBe(false)
  })
})

describe('access-mode restriction transition (R32-3)', () => {
  it('stops in-flight executions, keeps new starts blocked, and recovers without restarting prior work', async () => {
    const { invoke } = createHarness()
    const inFlight = fakeExecution({ executionId: 'exec-restrict' })
    registerProductSpaceExecution(inFlight)

    const restricted = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      true,
    )
    expect(restricted.success).toBe(true)
    // The in-flight execution was terminated and unregistered.
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)
    expect(await inFlight.isActive()).toBe(false)
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(true)

    // The restricted space also refuses fresh registration through the
    // shared start gate used by Assistant and Local App paths.
    const { registerAssistantExecutionForSend } = await import('../../../runtime/assistant-executions')
    await expect(registerAssistantExecutionForSend({
      sessionManager: { getSessions: () => [], cancelProcessing: async () => {} },
      sessionId: 'session-restricted',
      workspaceId: 'ws-a',
      productSpaceId: spaceA,
      name: 'restricted',
    })).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')

    // Recovery: restoring active access clears the fence without
    // restarting any prior work.
    const recovered = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      false,
    )
    expect(recovered.success).toBe(true)
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(false)
  })

  it('refuses the restriction transition for a replaced account or cleared fence', async () => {
    const { invoke } = createHarness()
    setTrustedProductSpaceAccountProvider(async () => 'account-other')
    const refused = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      true,
    )
    expect(refused.success).toBe(false)
    // The account/space mismatch fails closed before any restriction is
    // published (resolveTrustedExecutionRequest / fence-binding check).
    expect(refused.errorCode).toBe('FORBIDDEN')
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(false)

    await invoke(RPC_CHANNELS.productSpace.REVOKE_ACTIVE_CONTEXT)
    setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
    const noFence = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      true,
    )
    expect(noFence.success).toBe(false)
    expect(noFence.errorCode).toBe('PRODUCT_SPACE_CONTEXT_REQUIRED')
  })
})

describe('per-item stop and real statuses (R32-4)', () => {
  it('stops one execution atomically, rejects stale token and out-of-scope ids, and keeps active statuses blocking COMMIT', async () => {
    const { invoke } = createHarness()
    const first = fakeExecution({ executionId: 'exec-s1' })
    const second = fakeExecution({ executionId: 'exec-s2' })
    // Real status projection: the item is preparing while active.
    first.getStatus = () => 'preparing'
    second.getStatus = () => 'running'
    registerProductSpaceExecution(first)
    registerProductSpaceExecution(second)

    const list = await invoke(RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS, trustedAccountId, spaceA)
    expect(list.success).toBe(true)
    const statuses = Object.fromEntries(
      (list.executions as Array<{ executionId: string; status: string }>).map(item => [item.executionId, item.status]),
    )
    expect(statuses['exec-s1']).toBe('preparing')
    expect(statuses['exec-s2']).toBe('running')

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    // Active statuses (preparing/running) block the final PREPARE/COMMIT:
    // both executions are planned for termination.
    expect(prepared.executions).toHaveLength(2)

    // Stale token and out-of-scope ids are rejected without side effects.
    const stale = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, 'not-the-token', 'exec-s1')
    expect(stale.success).toBe(false)
    expect(stale.errorCode).toBe('SWITCH_TRANSACTION_INVALID')
    const outOfScope = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-unknown')
    expect(outOfScope.success).toBe(false)
    expect(outOfScope.errorCode).toBe('EXECUTION_NOT_FOUND')

    // Atomic single stop: only the targeted execution is terminated.
    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-s1')
    expect(stopped.success).toBe(true)
    expect(stopped.status).toBe('stopped')
    expect(await first.isActive()).toBe(false)
    expect(await second.isActive()).toBe(true)

    // The remaining execution still blocks; STOP_ALL finalizes and COMMIT
    // succeeds with the per-item stop result retained.
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
  })

  // A truthfully-failed per-item stop keeps the execution active, so the
  // stop drain runs to its shared 10s deadline before reporting 'failed' —
  // the test timeout must cover both attempts (bounded, never hanging).
  it('reports truthful failed per-item status and supports retry before finalization', async () => {
    const { invoke } = createHarness()
    const flaky = fakeExecution({ executionId: 'exec-flaky', refuseStop: true })
    const ownedFlaky = registerProductSpaceExecution(flaky)

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    // First per-item stop fails truthfully (the stop cannot reach a
    // terminal state yet — the 10s shared drain applies).
    let flakyStopCalls = 0
    let flakyRecovered = false
    const originalFlakyStop = ownedFlaky.stop
    const originalFlakyIsActive = ownedFlaky.isActive
    ownedFlaky.stop = async () => {
      flakyStopCalls += 1
      if (flakyStopCalls >= 2) flakyRecovered = true
      return originalFlakyStop()
    }
    ownedFlaky.isActive = () => (flakyRecovered ? false : originalFlakyIsActive())
    const failed = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-flaky')
    expect(failed.success).toBe(false)
    expect(failed.status).toBe('failed')
    expect(await ownedFlaky.isActive()).toBe(true)



    // Retry succeeds; the transaction then finalizes and commits.
    const retried = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-flaky')
    expect(retried.success).toBe(true)
    expect(retried.status).toBe('stopped')
    expect(await invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token))
      .toMatchObject({ success: true })
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceB)
  }, 30_000)

  it('a cancelled pending transaction refuses per-item stops (R32-4)', async () => {
    const { invoke } = createHarness()
    const execution = fakeExecution({ executionId: 'exec-c10' })
    registerProductSpaceExecution(execution)
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)

    const refused = await invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-c10')
    expect(refused.success).toBe(false)
    expect(refused.errorCode).toBe('SWITCH_CANCELLED')
    expect(await execution.isActive()).toBe(true)
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

  it('refuses a same-space revalidation commit when the space degraded to read_only', async () => {
    // Offline same-space PREPARE succeeds while spaceA is active...
    setRuntimeOfflineReadOnly(true)
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(true)

    // ...but the authoritative list degrades spaceA to read_only before the
    // commit: the commit must fail WITHOUT moving the fence or clearing the
    // offline read-only view.
    listResult = {
      personalProductSpaceId: personalId,
      productSpaces: [
        { id: spaceA, kind: 'enterprise', name: 'A', accessMode: 'read_only' },
        { id: spaceB, kind: 'enterprise', name: 'B', accessMode: 'active' },
        { id: personalId, kind: 'personal', name: '我的空间', accessMode: 'active' },
      ],
    }
    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceA,
    )
    expect(committed.success).toBe(false)
    expect(committed.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(true)

    // The token is consumed by the failed commit; a replay fails and the
    // fail-closed state is still intact.
    const replay = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceA,
    )
    expect(replay.success).toBe(false)
    expect(getRuntimeActive()).toBe(spaceA)
    expect(isRuntimeOfflineReadOnly()).toBe(true)
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

  it('treats a same-space prepare against the bound fence as idempotent revalidation', async () => {
    // A re-bootstrap of a live session targets the already-committed space:
    // this is an online revalidation (re-verified membership, fence kept),
    // not a no-op error — otherwise a second bootstrap would fall back to a
    // stale device snapshot.
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(true)
    expect(getRuntimeActive()).toBe(spaceA)

    const committed = await invoke(
      RPC_CHANNELS.productSpace.COMMIT_SWITCH,
      prepared.token,
      spaceA,
    )
    expect(committed.success).toBe(true)
    expect(committed.from).toBe(spaceA)
    expect(committed.to).toBe(spaceA)
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('still rejects a same-space prepare when the fence belongs to another account', async () => {
    setRuntimeActiveProductSpaceAccount('account-other')
    const { invoke } = createHarness()
    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceA)
    expect(prepared.success).toBe(false)
    expect(prepared.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)
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

describe('generation-owned terminal cleanup and post-await revalidation (R33-4)', () => {
  it('reports superseded and preserves a same-ID replacement that registered during the awaited stop', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-reuse' })
    old.isActive = async () => {
      probeCalls += 1
      if (probeCalls === 1) return true
      // Probe 2 is the awaited drain window of the per-item stop.
      if (probeCalls === 2) await probeGate
      return false
    }
    registerProductSpaceExecution(old)

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    // The per-item stop enters the old entry's terminal probe.
    const pending = invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-reuse')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(probeCalls).toBe(2)

    // A same-ID replacement (new registration generation) takes the slot
    // while the old stop is still awaiting its drain.
    const replacement = fakeExecution({ executionId: 'exec-reuse' })
    const ownedOld = getRegisteredProductSpaceExecution('exec-reuse')
    const ownedReplacement = registerProductSpaceExecution(replacement)
    expect(ownedOld).toBeTruthy()
    expect(ownedReplacement.generation).not.toBe(ownedOld!.generation)

    releaseProbe()
    const result = await pending
    // The stale completion is NOT reported as success against the newer
    // ownership.
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('EXECUTION_SUPERSEDED')
    expect(result.status).toBe('failed')
    // The replacement is untouched and still blocks the switch.
    expect(await replacement.isActive()).toBe(true)
    expect(listRegisteredProductSpaceExecutions().some(execution => (
      execution === ownedReplacement
    ))).toBe(true)
  })

  it('revalidates the transaction after the drain: a cancel racing the stop is truthfully reported', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const execution = fakeExecution({ executionId: 'exec-race-cancel' })
    execution.isActive = async () => {
      probeCalls += 1
      if (probeCalls === 1) return true
      if (probeCalls === 2) await probeGate
      return false
    }
    registerProductSpaceExecution(execution)

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-race-cancel')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(probeCalls).toBe(2)
    await invoke(RPC_CHANNELS.productSpace.CANCEL_SWITCH, prepared.token)
    releaseProbe()

    const result = await pending
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('SWITCH_CANCELLED')
  })

  it('a replacement that is itself cleaned up during the old drain is still superseded, never a false success (R34-4)', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-reuse-2' })
    old.isActive = async () => {
      probeCalls += 1
      if (probeCalls === 1) return true
      if (probeCalls === 2) await probeGate
      return false
    }
    registerProductSpaceExecution(old)

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_EXECUTION, prepared.token, 'exec-reuse-2')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(probeCalls).toBe(2)

    // A replacement takes the slot AND is stopped/cleaned by a concurrent
    // path before the old drain completes. The handler must still treat the
    // lost ownership as superseded — a null generation read can never
    // upgrade this stale completion into a success.
    const replacement = fakeExecution({ executionId: 'exec-reuse-2' })
    registerProductSpaceExecution(replacement)
    unregisterProductSpaceExecution('exec-reuse-2')

    releaseProbe()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('EXECUTION_SUPERSEDED')
    expect(result.status).toBe('failed')
  })

  it('LIST and PREPARE project the real owner-scoped provider status instead of hardcoded running', async () => {
    const { invoke } = createHarness()
    const waiting = fakeExecution({ executionId: 'exec-wait' })
    waiting.getStatus = () => 'waiting_for_network'
    const bootstrapping = fakeExecution({ executionId: 'exec-boot' })
    bootstrapping.getStatus = () => 'preparing'
    registerProductSpaceExecution(waiting)
    registerProductSpaceExecution(bootstrapping)

    const list = await invoke(RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS, trustedAccountId, spaceA)
    expect(list.success).toBe(true)
    const statuses = Object.fromEntries(
      (list.executions as Array<{ executionId: string; status: string }>).map(item => [item.executionId, item.status]),
    )
    expect(statuses['exec-wait']).toBe('waiting_for_network')
    expect(statuses['exec-boot']).toBe('preparing')

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)
    const planned = Object.fromEntries(
      (prepared.executions as Array<{ executionId: string; status: string }>).map(item => [item.executionId, item.status]),
    )
    expect(planned['exec-wait']).toBe('waiting_for_network')
    expect(planned['exec-boot']).toBe('preparing')
  })
})

describe('restriction transaction with authoritative fence state (R33-2)', () => {
  it('keeps the fence on a failed stop, reports the authoritative state, and a verified clear recovers', async () => {
    const { invoke } = createHarness()
    const stuck = fakeExecution({ executionId: 'exec-stuck', refuseStop: true })
    registerProductSpaceExecution(stuck)

    // Fence FIRST, stop fails: the response is a truthful failure AND the
    // authoritative post-operation fence state (restricted: true).
    const restricted = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      true,
    )
    expect(restricted.success).toBe(false)
    expect(restricted.errorCode).toBe('runtime_stop_failed')
    expect(restricted.restricted).toBe(true)
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(true)

    // A verified active recovery clears the fence; the response again
    // carries the authoritative state.
    const cleared = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      false,
    )
    expect(cleared.success).toBe(true)
    expect(cleared.restricted).toBe(false)
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(false)
  }, 30_000)

  it('a tracked Skill operation is a stoppable ProductSpace execution of the restricted space', async () => {
    const { invoke } = createHarness()
    let skillSettled = false
    let skillCancelRequested = false
    const skillOp: RegisteredProductSpaceExecution = {
      scope: executionScope({ executionId: 'skill-op-1', accountId: trustedAccountId, productSpaceId: spaceA }),
      kind: 'skill_operation',
      name: 'safe-skill',
      ref: 'skill-op-1',
      generation: 0,
      isActive: () => !skillSettled,
      getStatus: () => (skillCancelRequested ? 'stopping' : 'running'),
      stop: async () => {
        skillCancelRequested = true
        skillSettled = true
        return 'stopped'
      },
    }
    registerProductSpaceExecution(skillOp)

    const restricted = await invoke(
      RPC_CHANNELS.productSpace.RESTRICT_ACTIVE_SPACE,
      trustedAccountId,
      spaceA,
      true,
    )
    expect(restricted.success).toBe(true)
    expect(restricted.restricted).toBe(true)
    // The Skill work was terminated through the shared no-confirmation
    // path — read_only only became usable once it was terminal.
    expect(skillCancelRequested).toBe(true)
    expect(isRuntimeProductSpaceRestricted(spaceA)).toBe(true)
  })
})

describe('aggregate stop supersession (R35-3)', () => {
  it('STOP_ALL keeps an active superseding generation nonterminal: allStopped=false with its real status (R36-2)', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-stopall-superseded' })
    old.isActive = async () => {
      probeCalls += 1
      if (probeCalls === 1) return true
      if (probeCalls === 2) await probeGate
      return false
    }
    registerProductSpaceExecution(old)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, trustedAccountId, spaceA)
    await new Promise(resolve => setTimeout(resolve, 30))
    // A same-ID replacement takes the slot during the awaited drain and
    // carries its own live status provider.
    const replacement = fakeExecution({ executionId: 'exec-stopall-superseded' })
    replacement.getStatus = () => 'running'
    const ownedReplacement = registerProductSpaceExecution(replacement)
    releaseProbe()

    const result = await pending
    expect(result.success).toBe(true)
    const aggregate = (result as { result: { allStopped: boolean; executions: Array<{ executionId: string; status: string; errorCode?: string }> } }).result
    // R36-2: the surviving replacement keeps the aggregate explicitly
    // NONTERMINAL — allStopped=false, real active status, no failure mask.
    expect(aggregate.allStopped).toBe(false)
    const summary = aggregate.executions.find(execution => execution.executionId === 'exec-stopall-superseded')
    expect(summary?.status).toBe('running')
    expect(summary?.errorCode).toBeUndefined()
    // The replacement is untouched, still registered and active.
    expect(getRegisteredProductSpaceExecution('exec-stopall-superseded')).toBe(ownedReplacement)
    expect(await ownedReplacement.isActive()).toBe(true)
  })

  it('STOP_ALL keeps a SAME-OBJECT superseding registration nonterminal (R36-2 runtime reproduction)', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const producer = fakeExecution({ executionId: 'exec-stopall-same-object' })
    producer.isActive = async () => {
      probeCalls += 1
      // Call 1: the STOP_ALL liveness snapshot (still active). Call 2: the
      // awaited drain window of the stop itself.
      if (probeCalls === 2) await probeGate
      return probeCalls <= 1
    }
    registerProductSpaceExecution(producer)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, trustedAccountId, spaceA)
    await new Promise(resolve => setTimeout(resolve, 30))
    // The exact R36 runtime reproduction: the SAME producer object
    // re-registers during the awaited stop — a new registry-owned
    // generation takes the slot and stays live.
    const replacement = registerProductSpaceExecution(producer)
    replacement.isActive = () => true
    replacement.getStatus = () => 'waiting_for_network'
    releaseProbe()

    const result = await pending
    expect(result.success).toBe(true)
    const aggregate = (result as { result: { allStopped: boolean; executions: Array<{ executionId: string; status: string }> } }).result
    expect(aggregate.allStopped).toBe(false)
    const summary = aggregate.executions.find(execution => execution.executionId === 'exec-stopall-same-object')
    expect(summary?.status).toBe('waiting_for_network')
    expect(getRegisteredProductSpaceExecution('exec-stopall-same-object')).toBe(replacement)
    expect(await replacement.isActive()).toBe(true)
  })

  it('the switch stop phase records superseded as failed and the finalize gate keeps the transaction non-committable', async () => {
    const { invoke } = createHarness()
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-switch-superseded' })
    old.isActive = async () => {
      probeCalls += 1
      // Call 1: the PREPARE snapshot. Call 2: the stop loop's liveness check
      // (still active → dispatched). Call 3: the awaited drain window.
      if (probeCalls === 2) return true
      if (probeCalls === 3) await probeGate
      return probeCalls <= 1
    }
    registerProductSpaceExecution(old)

    const prepared = await invoke(RPC_CHANNELS.productSpace.PREPARE_SWITCH, spaceB)
    expect(prepared.success).toBe(true)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_SWITCH_EXECUTIONS, prepared.token)
    await new Promise(resolve => setTimeout(resolve, 30))
    const replacement = fakeExecution({ executionId: 'exec-switch-superseded' })
    const ownedReplacement = registerProductSpaceExecution(replacement)
    releaseProbe()

    const stopped = await pending
    // The per-row projection is a truthful retryable failure.
    expect(stopped.success).toBe(false)
    const summary = (stopped as { executions: Array<{ executionId: string; status: string; errorCode?: string }> })
      .executions.find(execution => execution.executionId === 'exec-switch-superseded')
    expect(summary?.status).toBe('failed')
    expect(summary?.errorCode).toBe('runtime_stop_failed')
    // The transaction is NOT finalized: the surviving replacement blocks
    // COMMIT through the re-enumeration fence.
    const committed = await invoke(RPC_CHANNELS.productSpace.COMMIT_SWITCH, prepared.token, spaceB)
    expect(committed.success).toBe(false)
    expect(getRuntimeActive()).toBe(spaceA)
    // The replacement survives.
    expect(getRegisteredProductSpaceExecution('exec-switch-superseded')).toBe(ownedReplacement)
    expect(await ownedReplacement.isActive()).toBe(true)
  })
})

describe('STOP_ALL generation-stable final projection (R37-5)', () => {
  it('a replacement registered during the final liveness probe forces allStopped=false (R37-5)', async () => {
    const { invoke } = createHarness()
    const releaseDrainGate = (() => {
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      return { gate, release: () => release() }
    })()
    const releaseFinalGate = (() => {
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      return { gate, release: () => release() }
    })()

    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-final-race' })
    old.isActive = async () => {
      probeCalls += 1
      // Call 1: the STOP_ALL snapshot. Call 2: the awaited drain window.
      if (probeCalls === 2) await releaseDrainGate.gate
      return probeCalls <= 1
    }
    registerProductSpaceExecution(old)

    const pending = invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, trustedAccountId, spaceA)
    await new Promise(resolve => setTimeout(resolve, 30))
    // A same-ID replacement registers during the awaited drain.
    const replacement = fakeExecution({ executionId: 'exec-final-race' })
    // Its own liveness parks during the FINAL projection pass so the test
    // can register a third generation mid-pass — the exact R37 race.
    replacement.isActive = async () => {
      await releaseFinalGate.gate
      return true
    }
    replacement.getStatus = () => 'running'
    const ownedReplacement = registerProductSpaceExecution(replacement)
    releaseDrainGate.release()
    await new Promise(resolve => setTimeout(resolve, 30))

    // Pass 1 of the final projection is now parked probing the a:2
    // generation — register the third generation mid-pass.
    const third = fakeExecution({ executionId: 'exec-final-race' })
    third.isActive = () => true
    third.getStatus = () => 'preparing'
    const ownedThird = registerProductSpaceExecution(third)
    releaseFinalGate.release()

    const result = await pending
    expect(result.success).toBe(true)
    const aggregate = (result as { result: { allStopped: boolean; executions: Array<{ executionId: string; status: string }> } }).result
    // The generation-stable strategy re-enumerated after the mid-pass
    // registration: the surviving generation keeps the aggregate
    // nonterminal with its real status.
    expect(aggregate.allStopped).toBe(false)
    const summary = aggregate.executions.find(execution => execution.executionId === 'exec-final-race')
    expect(summary?.status).toBe('preparing')
    // The newest generation survives, registered and active.
    expect(getRegisteredProductSpaceExecution('exec-final-race')).toBe(ownedThird)
    expect(await ownedThird.isActive()).toBe(true)
    void ownedReplacement
  })
})

describe('STOP_ALL generation stability end-to-end (R38-5)', () => {
  it('a replacement registered during the INITIAL selection scan is enumerated and stopped (R38-5 initial race)', async () => {
    const { invoke } = createHarness()
    // R39-6 fake timing: the bounded stop-drain window is injected PER CALL
    // so the refusing-stop survivor scenario is deterministic and fast
    // without touching any process-global state.
    let releaseInitial: () => void = () => {}
    const initialGate = new Promise<void>(resolve => {
      releaseInitial = resolve
    })
    let probeCalls = 0
    const old = fakeExecution({ executionId: 'exec-initial-race' })
    old.isActive = async () => {
      probeCalls += 1
      // Call 1: the initial selection probe parks; the replacement lands
      // mid-selection, invalidating that pass.
      if (probeCalls === 1) await initialGate
      return probeCalls <= 1
    }
    registerProductSpaceExecution(old)

    // R39-6: the drain deadline is injected per call — no global timing
    // state that could leak into a concurrent unrelated stop.
    const pending = stopAllProductSpaceExecutions(
      { trustedAccountId, productSpaceId: spaceA },
      { drainTimeoutMs: 120 },
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    const replacement = fakeExecution({ executionId: 'exec-initial-race' })
    // The replacement stays active after its own stop is dispatched.
    replacement.stop = async () => 'failed'
    const ownedReplacement = registerProductSpaceExecution(replacement)
    releaseInitial()

    const result = await pending
    const aggregate = (result as { allStopped: boolean; executions: Array<{ executionId: string; status: string }> })
    // The re-bracketed selection enumerated the replacement; its stop
    // refused, so the aggregate stays NONTERMINAL with the live row.
    expect(aggregate.allStopped).toBe(false)
    const summary = aggregate.executions.find(execution => execution.executionId === 'exec-initial-race')
    expect(summary?.status).not.toBe('stopped')
    expect(summary?.status === 'running' || summary?.status === 'failed').toBe(true)
    expect(getRegisteredProductSpaceExecution('exec-initial-race')).toBe(ownedReplacement)
    expect(await ownedReplacement.isActive()).toBe(true)
  })

  it('five continuously unstable final passes end in a nonterminal survivor state (R38-5 exhaustion)', async () => {
    const { invoke } = createHarness()
    // R39-6 fake timing: the bounded stop-drain window is injected PER CALL
    // (no process-global state to restore).
    // A self-replacing execution: every liveness probe registers a NEW
    // generation of the same ID, so the registry revision never stabilizes.
    const producer = fakeExecution({ executionId: 'exec-churn' })
    producer.isActive = async () => {
      const next = fakeExecution({ executionId: 'exec-churn' })
      next.isActive = () => true
      next.getStatus = () => 'stopping'
      registerProductSpaceExecution(next)
      return true
    }
    producer.getStatus = () => 'running'
    registerProductSpaceExecution(producer)

    const result = await stopAllProductSpaceExecutions(
      { trustedAccountId, productSpaceId: spaceA },
      { drainTimeoutMs: 120 },
    )
    const aggregate = (result as { allStopped: boolean; executions: Array<{ executionId: string; status: string; errorCode?: string }> })
    // Bounded retries exhausted: the survivor is projected NONTERMINAL —
    // never converted into terminal failed rows that aggregate to true.
    expect(aggregate.allStopped).toBe(false)
    const summary = aggregate.executions.find(execution => execution.executionId === 'exec-churn')
    expect(summary?.status).toBe('stopping')
    expect(summary?.status === 'stopped' || summary?.status === 'failed').toBe(false)
    // The newest generation remains registered and active.
    expect(await getRegisteredProductSpaceExecution('exec-churn')!.isActive()).toBe(true)
  })
})
