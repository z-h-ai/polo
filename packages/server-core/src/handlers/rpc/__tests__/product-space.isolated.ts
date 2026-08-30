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
    const result = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
    )
    expect(result.success).toBe(true)
    expect(result.executions.map((execution: { executionId: string }) => execution.executionId))
      .toEqual(['exec-a1'])
  })

  it('fails closed when no ProductSpace is committed', async () => {
    setRuntimeActiveProductSpace(null)
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    const { invoke } = createHarness()
    const listed = await invoke(RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS, spaceA)
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('PRODUCT_SPACE_CONTEXT_REQUIRED')
  })

  it('rejects a space that differs from the committed active space', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-b1', productSpaceId: spaceB,
    }))
    const { invoke } = createHarness()
    const listed = await invoke(RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS, spaceB)
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('FORBIDDEN')
    const stopped = await invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, spaceB)
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
        spaceA,
        malformed,
      )
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('VALIDATION_ERROR')
    }
    for (const malformedSpace of [42, { space: spaceA }, ['space-a'], '']) {
      const result = await invoke(
        RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
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
    const result = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
    expect(result.success).toBe(true)
    expect(result.from).toBe(spaceA)
    expect(result.to).toBe(spaceB)
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
    const result = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('runtime_stop_failed')
    expect(getRuntimeActive()).toBe(spaceA)
    expect(await stuck.isActive()).toBe(true)
    // Failed entries stay registered for retry.
    expect(listRegisteredProductSpaceExecutions().some(
      execution => execution.scope.executionId === 'exec-stuck',
    )).toBe(true)

    // Retry after the runtime becomes stoppable.
    refuseStop = false
    const retry = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
    expect(retry.success).toBe(true)
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
    const result = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('FORBIDDEN')
    expect(getRuntimeActive()).toBe(spaceA)

    // List fetch failure also fails closed.
    listResult = null
    const unavailable = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, personalId)
    expect(unavailable.success).toBe(false)
    expect(unavailable.errorCode).toBe('service_unavailable')
    expect(getRuntimeActive()).toBe(spaceA)
  })

  it('rejects malformed switch targets and requires a trusted session', async () => {
    const { invoke } = createHarness()
    for (const malformed of [42, { space: spaceA }, ['space-a'], '']) {
      const result = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, malformed)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('VALIDATION_ERROR')
    }
    setTrustedProductSpaceAccountProvider(async () => null)
    const unauthorized = await invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
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
    const pending = invoke(RPC_CHANNELS.productSpace.EXECUTE_SWITCH, spaceB)
    for (let i = 0; i < 300 && !releaseSwitch; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(isSwitchInProgress()).toBe(true)
    releaseSwitch!()
    const result = await pending
    expect(sawSwitchInProgress).toBe(true)
    expect(result.success).toBe(true)
    expect(isSwitchInProgress()).toBe(false)
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
