import { describe, expect, it } from 'bun:test'
import type { RpcClient } from '@polo-ai/server-core/transport'
import { buildClientApi } from '../build-api'
import { CHANNEL_MAP } from '../channel-map'
import { RPC_CHANNELS } from '../../shared/types'
import { readRpcErrorCode, stripRpcErrorCodeFromMessage } from '../../shared/rpc-error-bridge'

/**
 * POO-108 F2: the electron context bridge re-creates a rejected native Error
 * in the destination context from its MESSAGE alone
 * (`electron_api_context_bridge.cc`), so a server-coded error crosses as a
 * bare `new Error(message)` and the renderer's KB error mapping degraded to
 * the generic text. The KB channels opt into message carriage; these tests
 * simulate the crossing exactly and pin the recovered contract.
 */

/**
 * The context-bridge crossing for a promise rejection: a native Error is
 * re-created in the destination context from its message alone; any other
 * cloneable value keeps its shape.
 */
function bridgeCross(value: unknown): unknown {
  if (value instanceof Error) return new Error(value.message)
  return JSON.parse(JSON.stringify(value))
}

/** A client whose invoke always rejects with the given value. */
function rejectingClient(rejection: unknown): RpcClient {
  return {
    invoke: () => Promise.reject(rejection),
    on: () => () => {},
  } as unknown as RpcClient
}

const CODED_FAILURE = Object.assign(
  new Error('The knowledge base service is temporarily unavailable'),
  { code: 'kb_service_unavailable' },
)

describe('buildClientApi coded-error bridge', () => {
  it('delivers a KB channel error whose code survives the context bridge', async () => {
    const api = buildClientApi(rejectingClient(CODED_FAILURE), CHANNEL_MAP)
    const bridged = bridgeCross(await api.kbListCollections({ workspaceId: 'ws' }).then(
      () => { throw new Error('expected rejection') },
      error => error,
    )) as Error

    // The crossing itself still erases the code property — the message
    // carriage is what the renderer reads.
    expect((bridged as { code?: string }).code).toBeUndefined()
    const code = readRpcErrorCode(bridged)
    expect(code).toBe('kb_service_unavailable')
    expect(stripRpcErrorCodeFromMessage(bridged.message)).toBe('The knowledge base service is temporarily unavailable')
  })

  it('keeps every KB channel opted in', () => {
    for (const [method, entry] of Object.entries(CHANNEL_MAP)) {
      if (!method.startsWith('kb')) continue
      expect(entry.type).toBe('invoke')
      expect((entry as { codedErrors?: boolean }).codedErrors).toBe(true)
    }
    expect(CHANNEL_MAP.kbListCollections.channel).toBe(RPC_CHANNELS.kb.LIST_COLLECTIONS)
  })

  it('leaves a channel without codedErrors untouched — same error object, no marker', async () => {
    const api = buildClientApi(rejectingClient(CODED_FAILURE), CHANNEL_MAP)
    const error = await api.getSessions().then(
      () => { throw new Error('expected rejection') },
      e => e,
    ) as Error
    // The exact rejection passes through: live code intact, message bare.
    expect(error).toBe(CODED_FAILURE)
    expect(error.message).toBe('The knowledge base service is temporarily unavailable')
  })

  it('leaves a code-less failure on a coded channel unchanged', async () => {
    const bare = new Error('Request timeout: kb.LIST_COLLECTIONS (30000ms)')
    const api = buildClientApi(rejectingClient(bare), CHANNEL_MAP)
    const error = await api.kbListCollections({ workspaceId: 'ws' }).then(
      () => { throw new Error('expected rejection') },
      e => e,
    ) as Error
    expect(error).toBe(bare)
    expect(readRpcErrorCode(error)).toBeNull()
  })
})
