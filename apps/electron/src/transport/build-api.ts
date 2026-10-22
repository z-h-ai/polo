/**
 * Build the client API proxy.
 *
 * Replaces the 329-line preload. The ElectronAPI TypeScript interface still
 * enforces types at compile time — this proxy provides runtime dispatch.
 */

import type { RpcClient } from '@polo-ai/server-core/transport'
import type { ElectronAPI } from '../shared/types'
import { toBridgeCarriableError } from '../shared/rpc-error-bridge'
import type { LocalAppAdmissionFailure } from '@polo-ai/shared/protocol'

// ---------------------------------------------------------------------------
// Channel map entry
// ---------------------------------------------------------------------------

export type ChannelMapEntry =
  | { type: 'invoke'; channel: string; transform?: (result: any) => any; codedErrors?: boolean }
  | { type: 'listener'; channel: string }

export type ChannelMap = Record<string, ChannelMapEntry>

// ---------------------------------------------------------------------------
// Proxy builder
// ---------------------------------------------------------------------------

export function buildClientApi(
  client: RpcClient,
  channelMap: ChannelMap,
  isChannelAvailable?: (channel: string) => boolean,
): ElectronAPI {
  const api: Record<string, any> = {}
  const nested: Record<string, Record<string, any>> = {}

  for (const [key, entry] of Object.entries(channelMap)) {
    let fn: (...a: any[]) => any
    if (entry.type === 'listener') {
      fn = (cb: (...args: any[]) => void) => client.on(entry.channel, cb)
    } else if (entry.transform) {
      const t = entry.transform
      fn = async (...args: any[]) => t(await client.invoke(entry.channel, ...args))
    } else {
      fn = (...args: any[]) => client.invoke(entry.channel, ...args)
    }

    // R5A/R6 admission closure: these two channels surface a paid-admission
    // failure as a STRUCTURED result (the bridge would erase `code`/`data`).
    // Registered BEFORE the codedErrors wrapper below so it sees the raw
    // error; non-admission errors still fall through to the bridge carry.
    if (key === 'localApps.installProductSpaceBundle' || key === 'localApps.start') {
      const invoke = fn
      fn = async (...args: any[]) => {
        try { return await invoke(...args) }
        catch (error) {
          const coded = error as { code?: unknown; message?: unknown; data?: { reason?: unknown; recovery?: unknown } }
          if (coded?.code !== 'CIRCLE_ENTITLEMENT_REQUIRED'
            || !['unknown', 'not_entitled', 'expired'].includes(String(coded.data?.reason))
            || coded.data?.recovery !== 'refresh_membership') throw error
          return { kind: 'circle_entitlement_required', error: {
            code: coded.code, message: String(coded.message),
            details: { reason: coded.data.reason as LocalAppAdmissionFailure['error']['details']['reason'], recovery: 'refresh_membership' },
          } } satisfies LocalAppAdmissionFailure
        }
      }
    }

    if (entry.type === 'invoke' && entry.codedErrors) {
      // POO-108 F2: the context bridge re-creates rejected Errors from their
      // message alone, erasing `code`. Carry the code in the message (see
      // rpc-error-bridge.ts) so the renderer-side mapping can recover it.
      const inner = fn
      fn = async (...args: any[]) => {
        try {
          return await inner(...args)
        } catch (error) {
          throw toBridgeCarriableError(error)
        }
      }
    }

    // Dotted keys like "browserPane.create" become nested: api.browserPane.create
    const dotIdx = key.indexOf('.')
    if (dotIdx !== -1) {
      const ns = key.slice(0, dotIdx)
      const method = key.slice(dotIdx + 1)
      if (!nested[ns]) nested[ns] = {}
      nested[ns][method] = fn
    } else {
      api[key] = fn
    }
  }

  // Attach nested namespaces as plain objects
  for (const [ns, methods] of Object.entries(nested)) {
    api[ns] = methods
  }

  // Expose channel availability check for GUI-aware code
  api.isChannelAvailable = isChannelAvailable ?? (() => true)

  return api as ElectronAPI
}
