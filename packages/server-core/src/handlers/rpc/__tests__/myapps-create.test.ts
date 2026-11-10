import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS, MyAppsCreateFromFileInputSchema } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'

/**
 * POO-205 X8 (§5) — myapps:create sourceKey boundary tests.
 *
 * The GenUiAppPublishBridge sends the A3b idempotency key on EVERY save; both
 * the shared protocol envelope and the server-core handler schema are strict,
 * so before this fix each save died with VALIDATION_ERROR at the handler
 * boundary (masked by X7's packaging failure). These tests pin the exact
 * wire contract: sourceKey optional, forwarded verbatim to the service, and
 * unknown fields still rejected.
 */

const SERVICE_ANSWER = {
  contractVersion: 'poo205-contract-r1',
  appId: 'app-1',
  published: false,
}

let createCalls: Array<Record<string, unknown>> = []

mock.module('../../../my-apps/service', () => ({
  myAppsList: async () => [],
  myAppsCreateFromFile: async (input: Record<string, unknown>) => {
    createCalls.push(input)
    return { ...SERVICE_ANSWER, status: 201 }
  },
  myAppsPublish: async () => ({}),
  myAppsWithdraw: async () => ({}),
  myAppsDelete: async () => ({}),
}))

const { registerMyAppsHandlers } = await import('../my-apps')

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }
  registerMyAppsHandlers(server, {} as Parameters<typeof registerMyAppsHandlers>[1])
  return {
    async invoke(channel: string, rawInput: unknown) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({} as Parameters<HandlerFn>[0], rawInput)
    },
  }
}

const SCOPE = {
  accountId: 'account-1',
  workspaceId: 'workspace-a',
  productSpaceId: 'space-1',
}

beforeEach(() => {
  createCalls = []
})

describe('myapps:create sourceKey wire contract (POO-205 X8)', () => {
  it('forwards the bridge-supplied sourceKey verbatim to the service', async () => {
    const harness = createHarness()
    const answer = await harness.invoke(RPC_CHANNELS.myApps.CREATE, {
      ...SCOPE,
      sourcePath: '/tmp/polo-myapps-x/bundle.zip',
      name: 'Canvas App',
      sourceKey: 'sess-1::app-abc',
    })
    expect(answer).toEqual({ ...SERVICE_ANSWER, status: 201 })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toMatchObject({
      ...SCOPE,
      sourcePath: '/tmp/polo-myapps-x/bundle.zip',
      name: 'Canvas App',
      sourceKey: 'sess-1::app-abc',
    })
  })

  it('keeps the field absent (not undefined-valued) when the caller omits it', async () => {
    const harness = createHarness()
    await harness.invoke(RPC_CHANNELS.myApps.CREATE, {
      ...SCOPE,
      sourcePath: '/tmp/polo-myapps-x/bundle.zip',
      name: 'Canvas App',
    })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].sourceKey).toBeUndefined()
    expect('sourceKey' in createCalls[0]).toBe(false)
  })

  it('still rejects unknown fields (strict envelope unchanged)', async () => {
    const harness = createHarness()
    let caught: unknown = null
    try {
      await harness.invoke(RPC_CHANNELS.myApps.CREATE, {
        ...SCOPE,
        sourcePath: '/tmp/polo-myapps-x/bundle.zip',
        name: 'Canvas App',
        smuggled: true,
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe('VALIDATION_ERROR')
    expect(createCalls).toHaveLength(0)
  })
})

describe('MyAppsCreateFromFileInputSchema sourceKey boundary (POO-205 X8)', () => {
  const base = {
    accountId: 'account-1',
    workspaceId: 'workspace-a',
    productSpaceId: 'space-1',
    sourcePath: '/tmp/bundle',
    name: 'Canvas App',
  }

  it('accepts the bridge idempotency key', () => {
    const parsed = MyAppsCreateFromFileInputSchema.safeParse({ ...base, sourceKey: 'sess-1::app-abc' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.sourceKey).toBe('sess-1::app-abc')
  })

  it('accepts input without sourceKey (older callers stay valid)', () => {
    expect(MyAppsCreateFromFileInputSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a blank or oversized sourceKey', () => {
    expect(MyAppsCreateFromFileInputSchema.safeParse({ ...base, sourceKey: '' }).success).toBe(false)
    expect(MyAppsCreateFromFileInputSchema.safeParse({ ...base, sourceKey: 'k'.repeat(257) }).success).toBe(false)
  })
})
