import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
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
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'

const trustedAccountId = 'account-trusted'
const spaceA = 'space-a'
const spaceB = 'space-b'

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

function fakeExecution(input: {
  executionId: string
  accountId?: string
  productSpaceId?: string
  active?: boolean
  /** Liveness probe that always rejects — enumeration must fail closed. */
  rejectProbe?: boolean
  refuseStop?: boolean
}): RegisteredProductSpaceExecution {
  let active = input.active ?? true
  const isActive = (): boolean | Promise<boolean> => {
    if (input.rejectProbe) return Promise.reject(new Error('probe broken'))
    return active
  }
  return {
    scope: executionScope({
      executionId: input.executionId,
      accountId: input.accountId ?? trustedAccountId,
      productSpaceId: input.productSpaceId ?? spaceA,
    }),
    kind: 'assistant_session',
    name: input.executionId,
    ref: input.executionId,
    isActive,
    stop: async () => {
      if (input.refuseStop) return 'failed'
      active = false
      return 'stopped'
    },
  }
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
  setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
})

describe('trusted execution enumeration', () => {
  it('lists only executions bound to the committed active space', async () => {
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a2', active: false,
    }))

    const { invoke } = createHarness()
    const result = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
    )
    expect(result.success).toBe(true)
    expect(result.executions.map((execution: { executionId: string }) => execution.executionId))
      .toEqual(['exec-a1'])
    for (const execution of result.executions) {
      expect(execution.scope.productSpaceId).toBe(spaceA)
    }
  })

  it('rejects a space that differs from the committed active space', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-b1', productSpaceId: spaceB,
    }))

    const { invoke } = createHarness()
    const listed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceB,
    )
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('FORBIDDEN')

    const stopped = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
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

  it('rejects execution operations without a committed active space', async () => {
    setRuntimeActiveProductSpace(null)
    const { invoke } = createHarness()
    const listed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
    )
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('FORBIDDEN')
  })

  it('awaits async liveness probes and fails closed on probe rejection', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-async-true',
    }))
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

describe('cross-scope stop fence', () => {
  it('never stops executions of another ProductSpace', async () => {
    const otherSpace = fakeExecution({
      executionId: 'exec-b1', productSpaceId: spaceB,
    })
    registerProductSpaceExecution(otherSpace)
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))

    const { invoke } = createHarness()
    const result = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      spaceA,
    )
    expect(result.success).toBe(true)
    expect(result.result.executions.map((execution: { executionId: string }) => execution.executionId))
      .toEqual(['exec-a1'])
    expect(await otherSpace.isActive()).toBe(true)
  })

  it('reports failed stops, keeps them registered, and succeeds on retry', async () => {
    let refuseStop = true
    let stopped = false
    const stuck: RegisteredProductSpaceExecution = {
      scope: executionScope({ executionId: 'exec-a2', accountId: trustedAccountId, productSpaceId: spaceA }),
      kind: 'assistant_session',
      name: 'exec-a2',
      ref: 'exec-a2',
      isActive: () => !stopped,
      stop: async () => {
        if (refuseStop) return 'failed'
        stopped = true
        return 'stopped'
      },
    }
    registerProductSpaceExecution(stuck)
    registerProductSpaceExecution(fakeExecution({ executionId: 'exec-a1' }))

    const { invoke } = createHarness()
    const first = await invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, spaceA)
    const firstById = new Map(
      (first.result.executions as Array<Record<string, unknown>>).map(
        execution => [execution.executionId, execution],
      ),
    )
    expect(firstById.get('exec-a2')?.status).toBe('failed')
    expect(firstById.get('exec-a2')?.errorCode).toBe('runtime_stop_failed')
    expect(await stuck.isActive()).toBe(true)
    // The failed entry stays registered so a retry can still stop it.
    expect(listRegisteredProductSpaceExecutions().some(
      execution => execution.scope.executionId === 'exec-a2',
    )).toBe(true)

    refuseStop = false
    const second = await invoke(RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS, spaceA)
    expect(second.result.executions.length).toBe(1)
    expect(second.result.executions[0].status).toBe('stopped')
    expect(listRegisteredProductSpaceExecutions()).toEqual([])
  })
})

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
