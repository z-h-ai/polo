import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type {
  PcScanFolderInput,
  PcScanFolderResponse,
  PcStageZipBatchInput,
  PcStagedZipBatchResponse,
  ProjectAssetReference,
} from '@polo-ai/shared/protocol'
import type { PcSummaryResponse } from '@polo-ai/shared/admin/project-context-contract'
import {
  PcCreateAssetInputSchema,
  PcCreateUploadInputSchema,
  PcUpdateAssetInputSchema,
  PcSetConfirmedInputSchema,
  PcSetPinnedInputSchema,
  PcRestoreInputSchema,
} from '@polo-ai/shared/admin/project-context-contract'
import type { RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { getBoundWorkspace, currentWorkspaceId } from '../handlers/rpc/skills'
import {
  captureCompleteTrustedSessionScopeToken,
  isTrustedSessionScopeTokenCurrent,
  resolveTrustedProductSpaceAccountId,
  type TrustedSessionScopeToken,
} from '../handlers/rpc/trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  isRuntimeFenceBoundToAccount,
  isRuntimeOfflineReadOnly,
  isRuntimeProductSpaceRestricted,
} from '../runtime/product-space-executions'
import {
  ProjectContextAdminUnavailableError,
  getProjectContextAdmin,
  projectContextErrorCodeOf,
  putProjectContextFile,
  downloadProjectContextFile,
  type ProjectContextAdmin,
} from './admin-client'
import { cleanupStagedBatch, stageZipBatch } from './batch-staging'
import { scanFolderBatch } from './batch-source'

/**
 * POO-196 project-context service — the client-side composition layer
 * (adjudication D3.4).
 *
 * Every entry derives its authorization from the SAME trusted-scope fence as
 * the KB surface (admin session + committed enterprise ProductSpace + bound
 * workspace), enforces that the requested `productSpaceId` IS the committed
 * space and that a non-blank `projectId` rides the call (POO-205: the
 * project — not the space — owns the shared-file area; the admin route
 * re-validates project ⊆ organization ⊕ membership), and maps every admin
 * outcome onto the stable pc_* wire codes. The admin API is the ONLY
 * authority: no client-side cache ever decides membership or role (D7), and
 * no project credential or transfer capability ever reaches the renderer —
 * the upload grant lives entirely inside this process (grant → direct PUT →
 * complete in one RPC).
 */

/** Stable business-RPC error for an uncommitted runtime fence (KB 同款). */
export const PC_PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

/** The send-path resolution wall clock (same budget discipline as the KB). */
export const PC_SEND_RESOLVE_TIMEOUT_MS = 4_000

/** Block budgets mirroring the KB model-context discipline. */
const PC_BLOCK_TOTAL_BYTES = 16_000
const PC_REF_SECTION_BYTES = 4_000
/** Explicit @ references accepted per send — a bounded input is a bounded
 * resolution. */
const PC_REFS_PER_SEND_MAX = 10
/**
 * POO-215 U7: the first-turn header lists at most this many pinned assets by
 * name. The list query fetches one extra row so 「还有更多置顶」 is derivable
 * from the page itself (no admin count endpoint exists), and an overflow
 * degrades to a count line instead of an unbounded header.
 */
const PC_HEADER_PINNED_LIST_MAX = 8

export function pcError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? code), { code })
}

export interface ProjectContextScope {
  workspace: { id: string; rootPath: string; name: string; remoteServer?: unknown }
  space: TrustedProductSpaceSummary & { kind: 'enterprise'; role: 'owner' | 'manager' | 'member' }
  canManage: boolean
  accountId: string
  token: TrustedSessionScopeToken
}

type ActiveProductSpaceReader = (
  accountId: string,
  productSpaceId: string,
) => TrustedProductSpaceSummary | null

const defaultActiveProductSpaceReader: ActiveProductSpaceReader = (accountId, productSpaceId) => {
  const verified = getProductSpaceContextStorage(accountId)?.verifiedContext
  if (!verified || verified.activeProductSpaceId !== productSpaceId) return null
  return verified.list.productSpaces.find(space => space.id === productSpaceId) ?? null
}

let activeProductSpaceReader: ActiveProductSpaceReader = defaultActiveProductSpaceReader

/** Test seam: pin the active-space reader for one file. */
export function setProjectContextActiveProductSpaceReaderForTests(reader: ActiveProductSpaceReader | null): void {
  activeProductSpaceReader = reader ?? defaultActiveProductSpaceReader
}

export function resetProjectContextActiveProductSpaceReaderForTests(): void {
  activeProductSpaceReader = defaultActiveProductSpaceReader
}

let sendResolveTimeoutMs = PC_SEND_RESOLVE_TIMEOUT_MS

/** Test seam: shrink the send-path wall clock so expiry is observable. */
export function setProjectContextSendResolveTimeoutForTests(ms: number): void {
  sendResolveTimeoutMs = ms
}

export function resetProjectContextSendResolveTimeoutForTests(): void {
  sendResolveTimeoutMs = PC_SEND_RESOLVE_TIMEOUT_MS
}

/** Admin adapter seam for tests. */
let adminAdapter: ProjectContextAdmin | null = null

export function setProjectContextAdminForTests(admin: ProjectContextAdmin | null): void {
  adminAdapter = admin
}

export function resetProjectContextAdminForTests(): void {
  adminAdapter = null
}

function theAdmin(): ProjectContextAdmin {
  return adminAdapter ?? getProjectContextAdmin()
}

/** Maps any admin-side failure onto the stable pc_* wire codes (D7). */
function mapAdminFailure(error: unknown): Error {
  if (error instanceof ProjectContextAdminUnavailableError) {
    return pcError(error.code === 'pc_signed_out' ? 'pc_signin_required' : 'pc_service_unavailable')
  }
  const code = projectContextErrorCodeOf(error)
  if (code) return pcError(code)
  // A 401 that survived the client's refresh-and-retry pass means the admin
  // session itself is gone — tell the member to sign in again instead of the
  // misleading "check your network" service-unavailable copy.
  if ((error as { status?: unknown })?.status === 401) {
    return pcError('pc_signin_required')
  }
  return pcError('pc_service_unavailable', error instanceof Error ? error.message : undefined)
}

async function requireProjectContextScope(
  ctx: RequestContext,
  workspaceId: string,
  deps: HandlerDeps,
): Promise<ProjectContextScope> {
  const callerWorkspaceId = currentWorkspaceId(ctx, deps)
  const token = captureCompleteTrustedSessionScopeToken(callerWorkspaceId)
  if (!token) throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted caller scope is available')
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  // Post-await CAS: the account/space/fence state may have moved while the
  // trusted account was being resolved.
  if (!isTrustedSessionScopeTokenCurrent(token)) {
    throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The trusted scope changed during the operation')
  }
  if (!trustedAccountId) {
    throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted Admin session is available')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No committed ProductSpace is active for this account')
  }
  const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
  if (!space || space.id !== activeProductSpaceId) {
    throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The active ProductSpace is not resolvable for this account')
  }
  if (space.kind !== 'enterprise') {
    throw pcError('pc_unavailable_in_personal', 'Project files are only available in an enterprise project')
  }
  const workspace = getBoundWorkspace(ctx, workspaceId, deps)
  if (!workspace) throw pcError('workspace_context_mismatch', 'Workspace context mismatch')
  return {
    workspace: workspace as ProjectContextScope['workspace'],
    space: space as ProjectContextScope['space'],
    canManage: space.role === 'owner' || space.role === 'manager',
    accountId: trustedAccountId,
    token,
  }
}

function assertScopeCurrent(scope: ProjectContextScope): void {
  if (!isTrustedSessionScopeTokenCurrent(scope.token)) {
    throw pcError(PC_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The trusted scope changed during the operation')
  }
}

/**
 * POO-196 tool-facade seam: the SYNCHRONOUS half of the session-authorization
 * judgment, exported so `createProjectContextToolFacade` (tool-facade.ts) can
 * pre-gate a facade construction without re-deriving the reader/fence logic —
 * the reader stays internal to this module's closure. This is only the cheap
 * fail-closed pre-check: EVERY facade search/read still re-runs the full
 * `requireProjectContextScope` gate per call.
 */
export function isProjectSessionAuthorizedNow(input: {
  workspaceId: string
  sessionProductSpaceId: string | null | undefined
  sessionProjectId?: string | null | undefined
}): boolean {
  if (!input.sessionProductSpaceId) return false
  // POO-205: without the session's immutable project binding nothing can
  // address the project asset scope — fail closed at construction time.
  if (!input.sessionProjectId || input.sessionProjectId.trim().length === 0) return false
  const token = captureCompleteTrustedSessionScopeToken(input.workspaceId)
  if (!token || !isTrustedSessionScopeTokenCurrent(token)) return false
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || activeProductSpaceId !== input.sessionProductSpaceId) return false
  if (!isRuntimeFenceBoundToAccount(token.accountId)) return false
  const space = activeProductSpaceReader(token.accountId, activeProductSpaceId)
  return Boolean(space && space.kind === 'enterprise' && space.id === input.sessionProductSpaceId)
}

/** The committed fence is the ONLY space an entry may address. */
function assertRequestedSpace(scope: ProjectContextScope, productSpaceId: string): void {
  if (productSpaceId !== scope.space.id) {
    throw pcError('pc_forbidden', 'The requested project is not the active one')
  }
}

/**
 * POO-205: every asset call must name the project inside the committed space.
 * Only the non-blank bound is checked here (the wire schema already bounds
 * the format); the admin route re-validates project ⊆ organization ⊕
 * membership, so no local remote call duplicates that judgment — this is the
 * transport-consistency passthrough for direct (non-RPC) callers.
 */
function assertRequestedProject(projectId: string): void {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw pcError('VALIDATION_ERROR', 'A non-blank projectId is required for project assets')
  }
}

function assertWritable(scope: ProjectContextScope): void {
  if (isRuntimeOfflineReadOnly()) {
    throw pcError('OFFLINE_READ_ONLY', 'The offline read-only view cannot modify project files')
  }
  if (scope.space.accessMode !== 'active' || isRuntimeProductSpaceRestricted(scope.space.id)) {
    throw pcError('pc_read_only', 'This project is read-only right now')
  }
}

export function parsePcInput<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  const input = schema.safeParse(raw)
  if (!input.success || input.data === undefined) throw pcError('VALIDATION_ERROR')
  return input.data
}

/* ------------------------------------------------------------------ */
/* Handler-facing operations                                           */
/* ------------------------------------------------------------------ */

export async function pcCapabilities(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().capabilities(input.productSpaceId, input.projectId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSummary(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().summary(input.productSpaceId, input.projectId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcListAssets(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: {
    workspaceId: string
    productSpaceId: string
    projectId: string
    view?: string
    tag?: string
    pinned?: string
    processing?: string
    q?: string
    limit?: number
    cursor?: string
  },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().listAssets(input.productSpaceId, input.projectId, {
      view: input.view,
      tag: input.tag,
      pinned: input.pinned,
      processing: input.processing,
      q: input.q,
      limit: input.limit,
      cursor: input.cursor,
    })
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcGetAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().getAsset(input.productSpaceId, input.projectId, input.assetId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export interface PcUploadFileInput {
  workspaceId: string
  productSpaceId: string
  projectId: string
  mode: 'create' | 'replace'
  filePath: string
  name: string
  tags: string[]
  source?: { kind: 'file' | 'url' | 'session'; note?: string }
  sizeBytes: number
  mime?: string
  checksumSha256: string
  assetId?: string
  expectedRevision?: number
}

/**
 * The whole upload flow in one RPC: the grant is requested, the bytes are
 * streamed to the granted URL, and the admin verifies + publishes. The
 * renderer sees only the final asset snapshot — never the grant, the URL or
 * any header (adjudication D3.4: the transfer lives in server-core).
 */
export async function pcUploadFile(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: PcUploadFileInput,
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const mime = input.mime ?? 'application/octet-stream'
  try {
    const grant = input.mode === 'create'
      ? await theAdmin().createAsset(input.productSpaceId, input.projectId, parsePcInput(PcCreateAssetInputSchema, {
        name: input.name,
        tags: input.tags,
        source: input.source,
        sizeBytes: input.sizeBytes,
        mime,
        checksumSha256: input.checksumSha256,
      }))
      : await theAdmin().createUpload(
        input.productSpaceId,
        input.projectId,
        input.assetId ?? '',
        parsePcInput(PcCreateUploadInputSchema, {
          expectedRevision: input.expectedRevision ?? 0,
          sizeBytes: input.sizeBytes,
          mime,
          checksumSha256: input.checksumSha256,
        }),
      )
    await putProjectContextFile({ grant, filePath: input.filePath })
    const result = await theAdmin().completeUpload(input.productSpaceId, input.projectId, grant.assetId, grant.uploadId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    if (error instanceof ProjectContextAdminUnavailableError || projectContextErrorCodeOf(error)) {
      throw mapAdminFailure(error)
    }
    // Local file problems (missing, drifted size, unreadable) are the
    // caller's to fix: a validation-grade failure, not a service outage.
    deps.platform.logger?.warn(`PC_UPLOAD: ${error instanceof Error ? error.message : String(error)}`)
    throw pcError('pc_validation_error', 'The file could not be uploaded')
  }
}

export async function pcUpdateAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const payload = parsePcInput(PcUpdateAssetInputSchema, input.input)
  try {
    const result = await theAdmin().updateAsset(input.productSpaceId, input.projectId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSetConfirmed(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const payload = parsePcInput(PcSetConfirmedInputSchema, input.input)
  try {
    const result = await theAdmin().setConfirmed(input.productSpaceId, input.projectId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSetPinned(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const payload = parsePcInput(PcSetPinnedInputSchema, input.input)
  try {
    const result = await theAdmin().setPinned(input.productSpaceId, input.projectId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcTrashAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; expectedRevision: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  try {
    const result = await theAdmin().trashAsset(input.productSpaceId, input.projectId, input.assetId, input.expectedRevision)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcRestoreAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const payload = parsePcInput(PcRestoreInputSchema, input.input)
  try {
    const result = await theAdmin().restoreAsset(input.productSpaceId, input.projectId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcDownloadAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; version?: number; targetPath: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const grant = await theAdmin().getDownload(input.productSpaceId, input.projectId, input.assetId, input.version)
    const savedPath = await downloadProjectContextFile({ url: grant.url, targetPath: input.targetPath })
    assertScopeCurrent(scope)
    return { savedPath }
  } catch (error) {
    if (error instanceof ProjectContextAdminUnavailableError || projectContextErrorCodeOf(error)) {
      throw mapAdminFailure(error)
    }
    deps.platform.logger?.warn(`PC_DOWNLOAD: ${error instanceof Error ? error.message : String(error)}`)
    // Review R-6: a local disk failure (missing file name, containment
    // refusal, broken stream) is not the admin service being down — it gets
    // its own code so the renderer shows "download failed" copy, and a real
    // admin outage keeps pc_service_unavailable.
    throw pcError('pc_download_failed', 'The download failed')
  }
}

export async function pcReadAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; version?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().getRead(input.productSpaceId, input.projectId, input.assetId, input.version)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcGetPreviewUrl(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string; version?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().getPreview(input.productSpaceId, input.projectId, input.assetId, input.version)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSearchAssets(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; q: string; tag?: string; limit?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  try {
    const result = await theAdmin().search(input.productSpaceId, input.projectId, { q: input.q, tag: input.tag, limit: input.limit })
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcRebuild(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  try {
    const result = await theAdmin().rebuild(input.productSpaceId, input.projectId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/**
 * POO-215 U5: retry the index pipeline for ONE failed asset. Same gate set
 * as the project-wide rebuild — the admin side owns the per-asset state
 * check (a non-`failed` asset refuses with the stable `pc_validation_error`).
 */
export async function pcIndexRetry(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; projectId: string; assetId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  try {
    const result = await theAdmin().indexRetry(input.productSpaceId, input.projectId, input.assetId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/* ------------------------------------------------------------------ */
/* Send path: @ reference resolution + bounded project header          */
/* ------------------------------------------------------------------ */

export interface ResolvedSessionProjectContext {
  references: ProjectAssetReference[]
  modelContext?: { block: string; docs: number; bytes: number }
}

function raceSendDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  onTimeout: () => T,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(onTimeout()), Math.max(0, deadline - Date.now()))
    }),
  ])
}

/** UTF-8-safe bounded slice (KB 同款：按字节预算截断，不劈代理对）。 */
function boundedUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  let sliced = buffer.subarray(0, maxBytes).toString('utf8')
  // A cut inside a multi-byte sequence yields U+FFFD — drop the tail garbage.
  while (sliced.endsWith('\uFFFD') && sliced.length > 0) {
    sliced = sliced.slice(0, -1)
  }
  return sliced
}

function buildProjectModelContextBlock(input: {
  headerLines: string[]
  references: Array<ProjectAssetReference & { content?: string }>
}): { block: string; docs: number; bytes: number } | null {
  const sections: string[] = []
  if (input.headerLines.length > 0) {
    sections.push(
      ['<project-context>', ...input.headerLines, '</project-context>'].join('\n'),
    )
  }
  let docs = 0
  for (const reference of input.references) {
    if (reference.status !== 'ok') continue
    docs += 1
    const body = boundedUtf8(reference.content ?? '', PC_REF_SECTION_BYTES)
    sections.push(
      [
        `<project-file id="${reference.assetId}" version="${reference.version}" name="${reference.name}">`,
        body,
        '</project-file>',
      ].join('\n'),
    )
  }
  if (sections.length === 0) return null
  const joined = sections.join('\n\n')
  const block = boundedUtf8(joined, PC_BLOCK_TOTAL_BYTES)
  const bytes = Buffer.byteLength(block, 'utf8')
  return { block, docs, bytes }
}

/**
 * POO-215 U7: the first-turn project header content — asset statistics +
 * confirmed/pinned digest + the admin overview, then one line pointing the
 * model at the on-demand tools. Project instructions deliberately do NOT ride
 * here: POO-205 C7a already injects `<project_instructions>` into the system
 * prompt every turn (the correct channel for standing constraints), and a
 * second copy in the send-path block would be redundant token spend with a
 * different clamp/neutralization behavior.
 */
export function buildProjectHeaderLines(input: {
  summary: PcSummaryResponse
  pinned: Array<{ name: string; version: number }>
  pinnedHasMore: boolean
}): string[] {
  const pinnedTotalText = input.pinned.length === 0
    ? ''
    : input.pinnedHasMore ? `${input.pinned.length}+ 个置顶` : `${input.pinned.length} 个置顶`
  const lines = [
    `项目共享文件区：${input.summary.assetCount} 个文件，${input.summary.confirmedCount} 个已确认结论${pinnedTotalText ? `，${pinnedTotalText}` : ''}`,
  ]
  if (input.pinned.length > 0) {
    const listing = input.pinned.map(entry => `${entry.name} (v${entry.version})`).join('、')
    lines.push(`置顶文件：${listing}${input.pinnedHasMore ? '（未列全）' : ''}`)
  }
  if (input.summary.overview.trim().length > 0) {
    lines.push(input.summary.overview)
  }
  // Tool on-demand guidance rides the reminder wrapper (SessionManager), not
  // the header — it must also reach later, header-less reference-only turns.
  return lines
}

/** Was the session's first user message already persisted? A session whose
 * JSONL carries any user turn — in memory OR in the lazy header preview —
 * has had its first-turn injection, so the header must not ride again. */
function hasEarlierUserTurn(session: { messages?: Array<{ role: string }>; preview?: string } | null): boolean {
  if (!session) return false
  if ((session.messages ?? []).some(message => message.role === 'user')) return true
  // Lazy-loaded sessions keep a JSONL-header signature of the first user
  // message even when the body array is still empty — trust it as a
  // conservative "not first" signal (a false positive only skips a header;
  // a false negative would re-inject every turn, the old behavior).
  return typeof session.preview === 'string' && session.preview.length > 0
}

/**
 * The send-path resolution (adjudication D8/D7 + R8b; POO-215 Q7/U7):
 *
 * - a session bound to the committed project gets a bounded project header
 *   injected ONCE — on the send that carries the session's FIRST user
 *   message. Later sends inject no header at all: the model falls back to
 *   the on-demand `project_context_search`/`project_context_read` tools.
 *   A failed/timed-out first header is not retried (one-shot semantics; the
 *   tools remain the recovery path);
 * - explicit @ references are resolved ONE BY ONE against the admin read
 *   path — every reference carries its outcome (`ok` / `missing` /
 *   `stale` / `failed`) in the persisted snapshot, so the renderer can tell
 *   the user exactly which reference did not make it (never a silent drop).
 *   This per-send resolution is UNCHANGED by the first-turn convergence;
 * - the whole resolution is raced against one wall clock and NEVER blocks a
 *   send longer than its budget: on timeout the references still persist
 *   (marked per outcome) and the header is skipped.
 *
 * POO-205: the asset scope is 「organization space + projectId」 — the
 * session's immutable project binding rides in as `sessionProjectId` (the
 * caller reads it off the session record). A session without the binding
 * cannot address any project asset, so the resolution fails closed exactly
 * like a lost fence: nothing is injected and no references persist.
 */
export async function resolveSessionProjectContext(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  assetRefs: Array<{ assetId: string; version: number; name: string }> | undefined,
  callerWorkspaceId?: string | null,
  entryScopeToken?: TrustedSessionScopeToken | null,
  sessionProjectId?: string | null,
): Promise<ResolvedSessionProjectContext | undefined> {
  try {
    const indexed = deps.sessionManager
      .getSessions()
      .find(candidate => candidate.id === sessionId)
    const sessionSpaceId = indexed?.productSpaceId ?? null
    // POO-205: the record's immutable projectId decides — a caller-supplied
    // value is only a consistency assertion, never the source of truth.
    const projectId = (typeof sessionProjectId === 'string' && sessionProjectId.trim().length > 0
      ? sessionProjectId
      : indexed?.projectId) ?? null
    const normalizedRefs = (assetRefs ?? []).slice(0, PC_REFS_PER_SEND_MAX)
    if (!projectId) return undefined
    if (!sessionSpaceId && normalizedRefs.length === 0) return undefined

    const token = entryScopeToken
      ?? captureCompleteTrustedSessionScopeToken(callerWorkspaceId ?? indexed?.workspaceId ?? null)
    if (!token || !isTrustedSessionScopeTokenCurrent(token)) return undefined

    // The session's bound space must still be the committed active space —
    // a send must never inject content for a space the fence no longer
    // authorizes (post-switch stale session, revoked membership).
    const trustedAccountId = await resolveTrustedProductSpaceAccountId()
    if (!trustedAccountId) return undefined
    const activeProductSpaceId = getRuntimeActiveProductSpace()
    if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) return undefined
    const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
    if (!space || space.kind !== 'enterprise' || space.id !== sessionSpaceId) return undefined

    const deadline = Date.now() + sendResolveTimeoutMs
    const admin = theAdmin()

    // POO-215 Q7: the header is a FIRST-USER-MESSAGE injection. Reads the
    // session's message history (ensureMessagesLoaded makes lazy sessions
    // authoritative here) — after this send persists, the header never rides
    // again. The admin calls below are therefore skipped entirely on every
    // later send of the session.
    const firstTurnSession = await deps.sessionManager.getSession(sessionId).catch(() => null)
    // Unreadable session state = header SKIPPED (fail-closed): guessing
    // "first turn" here could re-flood an old session with its header.
    const isFirstProjectHeaderTurn = firstTurnSession !== null && !hasEarlierUserTurn(firstTurnSession)

    // The bounded header (first turn only; skipped on timeout/failure and
    // never retried). The pinned digest is an enhancement: its own failure
    // degrades to statistics-only, it never sinks the header.
    const headerPromise: Promise<string[]> = isFirstProjectHeaderTurn
      ? (async (): Promise<string[]> => {
        const summary = await admin.summary(sessionSpaceId as string, projectId)
        let pinned: Array<{ name: string; version: number }> = []
        let pinnedHasMore = false
        try {
          const page = await admin.listAssets(sessionSpaceId as string, projectId, {
            view: 'active',
            pinned: 'true',
            limit: PC_HEADER_PINNED_LIST_MAX + 1,
          })
          pinnedHasMore = page.assets.length > PC_HEADER_PINNED_LIST_MAX || typeof page.nextCursor === 'string'
          pinned = page.assets.slice(0, PC_HEADER_PINNED_LIST_MAX).map(asset => ({
            name: asset.name,
            version: asset.current.version,
          }))
        } catch (error) {
          deps.platform.logger?.warn(`PC_SEND_HEADER_PINNED: digest skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
        return buildProjectHeaderLines({ summary, pinned, pinnedHasMore })
      })()
      : Promise.resolve([])

    // The explicit references, one authorized read each.
    const referencePromise = (async (): Promise<Array<ProjectAssetReference & { content?: string }>> => {
      const resolved: Array<ProjectAssetReference & { content?: string }> = []
      for (const ref of normalizedRefs) {
        try {
          const read = await admin.getRead(sessionSpaceId as string, projectId, ref.assetId, ref.version)
          resolved.push({
            assetId: ref.assetId,
            version: ref.version,
            name: ref.name,
            status: 'ok',
            snippet: read.content.slice(0, 200),
            content: read.content,
          })
        } catch (error) {
          const code = projectContextErrorCodeOf(error)
          const status: ProjectAssetReference['status']
            = code === 'pc_not_found' ? 'missing'
              : code === 'pc_content_not_indexed' ? 'stale'
                : 'failed'
          resolved.push({
            assetId: ref.assetId,
            version: ref.version,
            name: ref.name,
            status,
            snippet: null,
          })
        }
      }
      return resolved
    })()

    const [headerLines, references] = await Promise.all([
      raceSendDeadline<string[]>(headerPromise, deadline, () => []),
      raceSendDeadline<Array<ProjectAssetReference & { content?: string }>>(referencePromise, deadline, () => {
        // On deadline: persist the refs as failed so the UI can surface
        // them — an explicit reference never silently vanishes (D7).
        return normalizedRefs.map(ref => ({
          assetId: ref.assetId,
          version: ref.version,
          name: ref.name,
          status: 'failed' as const,
          snippet: null,
        }))
      }),
    ])

    if (references.length === 0 && headerLines.length === 0) return undefined
    const modelContext = buildProjectModelContextBlock({ headerLines, references }) ?? undefined
    const cleanReferences: ProjectAssetReference[] = references.map(({ content: _body, ...rest }) => rest)
    return {
      references: cleanReferences,
      ...(modelContext ? { modelContext } : {}),
    }
  } catch (error) {
    deps.platform.logger?.warn(`PC_SEND_REFERENCES: resolution failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* POO-210 batch upload staging                                        */
/* ------------------------------------------------------------------ */

/**
 * The zip unpack + folder scan that build the batch upload entry list, and
 * the cleanup for the staging they write.
 *
 * Transport-layer only: nothing here touches the PC admin contract — these
 * are LOCAL channels whose error codes (`pc_stage_*`) are a CLIENT-side
 * vocabulary mapped to copy in the renderer, NOT new PC_ERROR_CODES entries
 * (that list governs the admin HTTP surface and stays untouched).
 *
 * The scope gate matches the upload it feeds: same trusted fence, requested
 * space/project must be current, and the space must be writable — staging
 * exists solely to produce upload candidates.
 */

const BATCH_MAX_ENTRY_BYTES_CEILING = 10 * 1024 * 1024 * 1024

function batchMaxEntryBytes(requested: unknown): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : 0
  if (value < 1) throw pcError('pc_validation_error', 'maxEntryBytes must be a positive integer')
  return Math.min(value, BATCH_MAX_ENTRY_BYTES_CEILING)
}

/** The staging failure → LOCAL pc_stage_* code. These codes live in
 * `PC_LOCAL_ERROR_CODES` (the client's own boundary list) — the admin wire
 * contract is untouched. */
function batchSourceError(failure: string): Error {
  const codeOf: Record<string, string> = {
    zip_too_large: 'pc_stage_zip_too_large',
    zip_bomb: 'pc_stage_zip_bomb',
    not_a_zip: 'pc_stage_zip_invalid',
    read_failed: 'pc_stage_read_failed',
    stage_failed: 'pc_stage_write_failed',
  }
  return pcError(codeOf[failure] ?? 'pc_stage_read_failed')
}

export async function pcStageZipBatch(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: PcStageZipBatchInput,
): Promise<PcStagedZipBatchResponse> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const result = await stageZipBatch(input.zipPath, { maxEntryBytes: batchMaxEntryBytes(input.maxEntryBytes) })
  if (!result.ok) {
    deps.platform.logger?.warn(`PC_STAGE_ZIP: ${result.failure} (${input.zipPath})`)
    throw batchSourceError(result.failure)
  }
  return result.batch
}

export async function pcScanFolder(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: PcScanFolderInput,
): Promise<PcScanFolderResponse> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertRequestedProject(input.projectId)
  assertWritable(scope)
  const result = await scanFolderBatch(input.folderPath, { maxEntryBytes: batchMaxEntryBytes(input.maxEntryBytes) })
  if (!result.ok) {
    deps.platform.logger?.warn(`PC_SCAN_FOLDER: ${result.failure} (${input.folderPath})`)
    throw batchSourceError(result.failure)
  }
  return {
    // Folder scans stage nothing: the upload RPC streams straight from the
    // original file, so stagedPath IS the source path (same contract as zip
    // staging, where it points at the generated staging file instead).
    entries: result.entries.map((entry) => ({ ...entry, entryId: `${entry.sourcePath}:${entry.sizeBytes}`, stagedPath: entry.sourcePath })),
    truncated: result.truncated,
  }
}

export async function pcStageCleanup(
  _deps: HandlerDeps,
  _ctx: RequestContext,
  input: { batchId: string },
): Promise<{ cleaned: boolean }> {
  // Deliberately scope-free: a batchId only ever names a directory INSIDE
  // the staging root (format-checked in cleanupStagedBatch), so the worst a
  // stale or foreign caller can do is remove its own temp debris.
  const cleaned = await cleanupStagedBatch(input.batchId)
  return { cleaned }
}
