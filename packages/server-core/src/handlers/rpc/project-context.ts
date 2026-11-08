import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import {
  pcCapabilities,
  pcSummary,
  pcListAssets,
  pcGetAsset,
  pcUploadFile,
  pcUpdateAsset,
  pcSetConfirmed,
  pcSetPinned,
  pcTrashAsset,
  pcRestoreAsset,
  pcDownloadAsset,
  pcReadAsset,
  pcGetPreviewUrl,
  pcSearchAssets,
  pcRebuild,
  parsePcInput,
} from '../../project-context/service'
import { z } from 'zod'

/**
 * POO-196 project-context RPC handlers (adjudication D3.4).
 *
 * Every channel is LOCAL_ONLY and gated by the trusted enterprise scope in
 * the service layer — the handler bodies are thin: parse the shared schema,
 * delegate, map failures to stable pc_* codes. The scope gate re-proves the
 * committed fence on EVERY entry (never once per session), the requested
 * productSpaceId must equal the committed space, and (POO-205) a non-blank
 * projectId rides every payload: the project — inside the organization
 * space — owns the asset scope, and the admin route re-validates
 * project ⊆ organization ⊕ membership.
 */

/** Manifest of every channel this module registers (registration coverage
 * test consumes this; keep in sync with the server.handle calls below). */
export const PROJECT_CONTEXT_HANDLED_CHANNELS = [
  RPC_CHANNELS.projectContext.LIST_CAPABILITIES,
  RPC_CHANNELS.projectContext.GET_SUMMARY,
  RPC_CHANNELS.projectContext.LIST_ASSETS,
  RPC_CHANNELS.projectContext.GET_ASSET,
  RPC_CHANNELS.projectContext.UPLOAD_FILE,
  RPC_CHANNELS.projectContext.UPDATE_ASSET,
  RPC_CHANNELS.projectContext.SET_CONFIRMED,
  RPC_CHANNELS.projectContext.SET_PINNED,
  RPC_CHANNELS.projectContext.TRASH_ASSET,
  RPC_CHANNELS.projectContext.RESTORE_ASSET,
  RPC_CHANNELS.projectContext.DOWNLOAD_ASSET,
  RPC_CHANNELS.projectContext.READ_ASSET,
  RPC_CHANNELS.projectContext.GET_PREVIEW_URL,
  RPC_CHANNELS.projectContext.SEARCH_ASSETS,
  RPC_CHANNELS.projectContext.REBUILD,
] as const

const WorkspaceScopeSchema = z.object({
  workspaceId: z.string().min(1).max(512),
  productSpaceId: z.string().min(1).max(128),
  // POO-205: the project is the asset scope key — required on EVERY channel
  // (extend chains below carry it to the asset-level payloads too).
  projectId: z.string().min(1).max(128),
}).strict()

const AssetIdSchema = WorkspaceScopeSchema.extend({
  assetId: z.string().min(1).max(128),
}).strict()

const ReadQuerySchema = AssetIdSchema.extend({
  version: z.coerce.number().int().min(1).optional(),
}).strict()

const ListQuerySchema = WorkspaceScopeSchema.extend({
  view: z.enum(['active', 'trash']).optional(),
  tag: z.string().max(64).optional(),
  pinned: z.enum(['true', 'false']).optional(),
  q: z.string().max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
}).strict()

const SearchQuerySchema = WorkspaceScopeSchema.extend({
  q: z.string().min(1).max(2_048),
  tag: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict()

const UploadFileSchema = z.object({
  workspaceId: z.string().min(1).max(512),
  productSpaceId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  mode: z.enum(['create', 'replace']),
  filePath: z.string().min(1).max(4_096),
  name: z.string().min(1).max(512),
  tags: z.array(z.string().min(1).max(64)).max(8).default([]),
  source: z.object({
    kind: z.enum(['file', 'url', 'session']),
    note: z.string().max(512).optional(),
  }).strict().optional(),
  sizeBytes: z.number().int().min(1),
  mime: z.string().min(1).max(128).optional(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  assetId: z.string().min(1).max(128).optional(),
  expectedRevision: z.number().int().min(1).optional(),
}).strict()

const DownloadSchema = AssetIdSchema.extend({
  version: z.coerce.number().int().min(1).optional(),
  targetPath: z.string().min(1).max(4_096),
}).strict()

const TrashSchema = AssetIdSchema.extend({
  expectedRevision: z.number().int().min(1),
}).strict()

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  return parsePcInput(schema, raw)
}

export function registerProjectContextHandlers(
  server: RpcServer,
  deps: HandlerDeps<ISessionManager>,
): void {
  server.handle(RPC_CHANNELS.projectContext.LIST_CAPABILITIES, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(WorkspaceScopeSchema, rawInput)
    return pcCapabilities(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.GET_SUMMARY, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(WorkspaceScopeSchema, rawInput)
    return pcSummary(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.LIST_ASSETS, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(ListQuerySchema, rawInput)
    return pcListAssets(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.GET_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AssetIdSchema, rawInput)
    return pcGetAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.UPLOAD_FILE, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(UploadFileSchema, rawInput)
    return pcUploadFile(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.UPDATE_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AssetIdSchema.extend({ input: z.record(z.string(), z.unknown()) }).strict(), rawInput)
    return pcUpdateAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.SET_CONFIRMED, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AssetIdSchema.extend({ input: z.record(z.string(), z.unknown()) }).strict(), rawInput)
    return pcSetConfirmed(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.SET_PINNED, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AssetIdSchema.extend({ input: z.record(z.string(), z.unknown()) }).strict(), rawInput)
    return pcSetPinned(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.TRASH_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(TrashSchema, rawInput)
    return pcTrashAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.RESTORE_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(AssetIdSchema.extend({ input: z.record(z.string(), z.unknown()) }).strict(), rawInput)
    return pcRestoreAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.DOWNLOAD_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(DownloadSchema, rawInput)
    return pcDownloadAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.READ_ASSET, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(ReadQuerySchema, rawInput)
    return pcReadAsset(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.GET_PREVIEW_URL, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(ReadQuerySchema, rawInput)
    return pcGetPreviewUrl(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.SEARCH_ASSETS, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(SearchQuerySchema, rawInput)
    return pcSearchAssets(deps, ctx, input)
  })

  server.handle(RPC_CHANNELS.projectContext.REBUILD, async (ctx: RequestContext, rawInput: unknown) => {
    const input = parseOrThrow(WorkspaceScopeSchema, rawInput)
    return pcRebuild(deps, ctx, input)
  })
}
