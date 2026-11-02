import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type { ProjectAssetReference } from '@polo-ai/shared/protocol'
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

/**
 * POO-196 project-context service — the client-side composition layer
 * (adjudication D3.4).
 *
 * Every entry derives its authorization from the SAME trusted-scope fence as
 * the KB surface (admin session + committed enterprise ProductSpace + bound
 * workspace), enforces that the requested `productSpaceId` IS the committed
 * space (a renderer cannot probe a foreign space id), and maps every admin
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
}): boolean {
  if (!input.sessionProductSpaceId) return false
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
  input: { workspaceId: string; productSpaceId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().capabilities(input.productSpaceId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSummary(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().summary(input.productSpaceId)
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
  try {
    const result = await theAdmin().listAssets(input.productSpaceId, {
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
  input: { workspaceId: string; productSpaceId: string; assetId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().getAsset(input.productSpaceId, input.assetId)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export interface PcUploadFileInput {
  workspaceId: string
  productSpaceId: string
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
  assertWritable(scope)
  const mime = input.mime ?? 'application/octet-stream'
  try {
    const grant = input.mode === 'create'
      ? await theAdmin().createAsset(input.productSpaceId, parsePcInput(PcCreateAssetInputSchema, {
        name: input.name,
        tags: input.tags,
        source: input.source,
        sizeBytes: input.sizeBytes,
        mime,
        checksumSha256: input.checksumSha256,
      }))
      : await theAdmin().createUpload(
        input.productSpaceId,
        input.assetId ?? '',
        parsePcInput(PcCreateUploadInputSchema, {
          expectedRevision: input.expectedRevision ?? 0,
          sizeBytes: input.sizeBytes,
          mime,
          checksumSha256: input.checksumSha256,
        }),
      )
    await putProjectContextFile({ grant, filePath: input.filePath })
    const result = await theAdmin().completeUpload(input.productSpaceId, grant.assetId, grant.uploadId)
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
  input: { workspaceId: string; productSpaceId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  const payload = parsePcInput(PcUpdateAssetInputSchema, input.input)
  try {
    const result = await theAdmin().updateAsset(input.productSpaceId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSetConfirmed(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  const payload = parsePcInput(PcSetConfirmedInputSchema, input.input)
  try {
    const result = await theAdmin().setConfirmed(input.productSpaceId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSetPinned(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  const payload = parsePcInput(PcSetPinnedInputSchema, input.input)
  try {
    const result = await theAdmin().setPinned(input.productSpaceId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcTrashAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; expectedRevision: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  try {
    const result = await theAdmin().trashAsset(input.productSpaceId, input.assetId, input.expectedRevision)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcRestoreAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; input: unknown },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  const payload = parsePcInput(PcRestoreInputSchema, input.input)
  try {
    const result = await theAdmin().restoreAsset(input.productSpaceId, input.assetId, payload)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcDownloadAsset(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; version?: number; targetPath: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const grant = await theAdmin().getDownload(input.productSpaceId, input.assetId, input.version)
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
  input: { workspaceId: string; productSpaceId: string; assetId: string; version?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().getRead(input.productSpaceId, input.assetId, input.version)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcGetPreviewUrl(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; assetId: string; version?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().getPreview(input.productSpaceId, input.assetId, input.version)
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcSearchAssets(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string; q: string; tag?: string; limit?: number },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  try {
    const result = await theAdmin().search(input.productSpaceId, { q: input.q, tag: input.tag, limit: input.limit })
    assertScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pcRebuild(
  deps: HandlerDeps,
  ctx: RequestContext,
  input: { workspaceId: string; productSpaceId: string },
): Promise<unknown> {
  const scope = await requireProjectContextScope(ctx, input.workspaceId, deps)
  assertRequestedSpace(scope, input.productSpaceId)
  assertWritable(scope)
  try {
    const result = await theAdmin().rebuild(input.productSpaceId)
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
 * The send-path resolution (adjudication D8/D7 + R8b):
 *
 * - a session bound to the committed project gets a bounded project header
 *   (overview + confirmed count + recent files) injected once per send;
 * - explicit @ references are resolved ONE BY ONE against the admin read
 *   path — every reference carries its outcome (`ok` / `missing` /
 *   `stale` / `failed`) in the persisted snapshot, so the renderer can tell
 *   the user exactly which reference did not make it (never a silent drop);
 * - the whole resolution is raced against one wall clock and NEVER blocks a
 *   send longer than its budget: on timeout the references still persist
 *   (marked per outcome) and the header is skipped.
 */
export async function resolveSessionProjectContext(
  deps: HandlerDeps<ISessionManager>,
  sessionId: string,
  assetRefs: Array<{ assetId: string; version: number; name: string }> | undefined,
  callerWorkspaceId?: string | null,
  entryScopeToken?: TrustedSessionScopeToken | null,
): Promise<ResolvedSessionProjectContext | undefined> {
  try {
    const indexed = deps.sessionManager
      .getSessions()
      .find(candidate => candidate.id === sessionId)
    const sessionSpaceId = indexed?.productSpaceId ?? null
    const normalizedRefs = (assetRefs ?? []).slice(0, PC_REFS_PER_SEND_MAX)
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

    // The bounded header (one admin call, skipped on timeout/failure).
    const headerPromise = (async (): Promise<string[]> => {
      const summary = await admin.summary(sessionSpaceId as string)
      return [
        `项目：${summary.assetCount} 个共享文件，其中 ${summary.confirmedCount} 个已确认结论`,
        summary.overview,
      ]
    })()

    // The explicit references, one authorized read each.
    const referencePromise = (async (): Promise<Array<ProjectAssetReference & { content?: string }>> => {
      const resolved: Array<ProjectAssetReference & { content?: string }> = []
      for (const ref of normalizedRefs) {
        try {
          const read = await admin.getRead(sessionSpaceId as string, ref.assetId, ref.version)
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
