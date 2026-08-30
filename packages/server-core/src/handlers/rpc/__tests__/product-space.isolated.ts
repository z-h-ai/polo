import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
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
    contractVersion: 1 as const,
    executionId: input.executionId,
    accountId: input.accountId,
    productSpaceId: input.productSpaceId,
    workspaceId: `ws-${input.executionId}`,
    subject: {
      kind: 'built_in_app' as const,
      builtInAppId: 'polo_assistant' as const,
    },
  }) as unknown as RegisteredProductSpaceExecution['scope']
}

function fakeExecution(input: {
  executionId: string
  accountId: string
  productSpaceId: string
  active?: boolean
  refuseStop?: boolean
}): RegisteredProductSpaceExecution {
  let active = input.active ?? true
  return {
    scope: executionScope(input),
    kind: 'assistant_session',
    name: input.executionId,
    ref: input.executionId,
    isActive: () => active,
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
  setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
})

describe('trusted execution enumeration', () => {
  it('derives the account from the trusted session and filters by real scope', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a1', accountId: trustedAccountId, productSpaceId: spaceA,
    }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a2', accountId: trustedAccountId, productSpaceId: spaceA, active: false,
    }))
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-b1', accountId: trustedAccountId, productSpaceId: spaceB,
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
      expect(execution.scope.accountId).toBe(trustedAccountId)
      expect(execution.scope.productSpaceId).toBe(spaceA)
    }
  })

  it('rejects requests whose account argument disagrees with the trusted identity', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a1', accountId: trustedAccountId, productSpaceId: spaceA,
    }))
    const { invoke } = createHarness()
    const result = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
      'account-forged',
    )
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('FORBIDDEN')
  })

  it('rejects execution operations without a trusted Admin session', async () => {
    setTrustedProductSpaceAccountProvider(async () => null)
    const { invoke } = createHarness()
    const listed = await invoke(
      RPC_CHANNELS.productSpace.LIST_ACTIVE_EXECUTIONS,
      spaceA,
    )
    expect(listed.success).toBe(false)
    expect(listed.errorCode).toBe('UNAUTHORIZED')
    const stopped = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      spaceA,
    )
    expect(stopped.success).toBe(false)
    expect(stopped.errorCode).toBe('UNAUTHORIZED')
  })
})

describe('cross-scope stop fence', () => {
  it('never stops executions of another ProductSpace', async () => {
    const otherSpace = fakeExecution({
      executionId: 'exec-b1', accountId: trustedAccountId, productSpaceId: spaceB,
    })
    registerProductSpaceExecution(otherSpace)
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a1', accountId: trustedAccountId, productSpaceId: spaceA,
    }))

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

  it('reports failed stops and keeps the execution non-terminal', async () => {
    registerProductSpaceExecution(fakeExecution({
      executionId: 'exec-a1', accountId: trustedAccountId, productSpaceId: spaceA,
    }))
    const stuck = fakeExecution({
      executionId: 'exec-a2', accountId: trustedAccountId, productSpaceId: spaceA,
      refuseStop: true,
    })
    registerProductSpaceExecution(stuck)

    const { invoke } = createHarness()
    const result = await invoke(
      RPC_CHANNELS.productSpace.STOP_ALL_EXECUTIONS,
      spaceA,
    )
    expect(result.success).toBe(true)
    const byId = new Map(
      (result.result.executions as Array<Record<string, unknown>>).map(
        execution => [execution.executionId, execution],
      ),
    )
    expect(byId.get('exec-a1')?.status).toBe('stopped')
    expect(byId.get('exec-a2')?.status).toBe('failed')
    expect(byId.get('exec-a2')?.errorCode).toBe('runtime_stop_failed')
    expect(await stuck.isActive()).toBe(true)
  })
})

describe('legacy direct-switch cleanup', () => {
  it('stops registered executions and reports every step result', async () => {
    const legacy = fakeExecution({
      executionId: 'exec-legacy', accountId: trustedAccountId, productSpaceId: spaceA,
    })
    registerProductSpaceExecution(legacy)
    const { invoke } = createHarness()
    const result = await invoke(RPC_CHANNELS.productSpace.CLEANUP_LEGACY_STATE)
    expect(result.results.legacyRuntimeStopped).toBe(true)
    expect(result.results.legacyCatalogCacheRemoved).toBe(true)
    expect(result.results.legacyAuthorizationCacheRemoved).toBe(true)
    expect(await legacy.isActive()).toBe(false)
  })
})
