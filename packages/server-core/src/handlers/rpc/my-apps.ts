import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { z } from 'zod'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import {
  myAppsList,
  myAppsCreateFromFile,
  myAppsPublish,
  myAppsWithdraw,
  myAppsDelete,
} from '../../my-apps/service'

/**
 * POO-205 member apps ("我的应用", Q7/Q11) RPC handlers.
 *
 * Every channel is LOCAL_ONLY and gated by the trusted committed-space scope
 * in the service layer — the handler bodies are thin: parse the shared
 * schema, delegate, map failures to stable myapps_* codes. The gate re-proves
 * the committed fence on EVERY entry, and the requested productSpaceId must
 * equal the committed space.
 */

/** Manifest of every channel this module registers (registration coverage
 * test consumes this; keep in sync with the server.handle calls below). */
export const MY_APPS_HANDLED_CHANNELS = [
  RPC_CHANNELS.myApps.LIST,
  RPC_CHANNELS.myApps.CREATE,
  RPC_CHANNELS.myApps.PUBLISH,
  RPC_CHANNELS.myApps.WITHDRAW,
  RPC_CHANNELS.myApps.DELETE,
] as const

const SpaceScopeSchema = z.object({
  accountId: z.string().min(1).max(512),
  workspaceId: z.string().min(1).max(512),
  productSpaceId: z.string().min(1).max(128),
}).strict()

const ListSchema = SpaceScopeSchema.strict()

const CreateSchema = SpaceScopeSchema.extend({
  sourcePath: z.string().min(1).max(4_096),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(2_000).optional(),
}).strict()

const AppIdSchema = SpaceScopeSchema.extend({
  accountId: z.string().min(1).max(512),
  appId: z.string().min(1).max(512),
}).strict()

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success || parsed.data === undefined) {
    throw new Error('VALIDATION_ERROR')
  }
  return parsed.data
}

export function registerMyAppsHandlers(
  server: RpcServer,
  deps: HandlerDeps<ISessionManager>,
): void {
  void deps
  server.handle(RPC_CHANNELS.myApps.LIST, async (_ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(ListSchema, rawInput)
    return myAppsList(input)
  })

  server.handle(RPC_CHANNELS.myApps.CREATE, async (_ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(CreateSchema, rawInput)
    return myAppsCreateFromFile(input)
  })

  server.handle(RPC_CHANNELS.myApps.PUBLISH, async (_ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AppIdSchema, rawInput)
    return myAppsPublish(input)
  })

  server.handle(RPC_CHANNELS.myApps.WITHDRAW, async (_ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AppIdSchema, rawInput)
    return myAppsWithdraw(input)
  })

  server.handle(RPC_CHANNELS.myApps.DELETE, async (_ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AppIdSchema, rawInput)
    return myAppsDelete(input)
  })
}
