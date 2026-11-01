import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import type {
  PcCapabilitiesResponse,
  PcCompleteUploadResponse,
  PcCreateAssetInput,
  PcCreateUploadInput,
  PcDownloadResponse,
  PcMutationResponse,
  PcPreviewResponse,
  PcReadResponse,
  PcRestoreInput,
  PcSearchResponse,
  PcSetConfirmedInput,
  PcSetPinnedInput,
  PcSummaryResponse,
  PcUpdateAssetInput,
  PcUploadGrantResponse,
} from '@polo-ai/shared/admin/project-context-contract'

/**
 * The project-context admin adapter (adjudication D3.4).
 *
 * The Polo client NEVER holds project storage credentials. This module is the
 * server-side bridge that: resolves the signed-in member's admin Bearer
 * (CredentialManager — the same token the KB admin mode already rides),
 * issues the admin control-plane calls, and performs the two byte channels —
 * streaming a local file straight to the granted upload URL (headers bound by
 * the grant, NO admin Bearer attached), and streaming a granted download URL
 * to a local path. The URLs are short-lived single-object capabilities.
 *
 * Failure shape: admin-unreachable / signed-out resolves per-call — the RPC
 * layer turns them into stable pc_* codes; nothing here invents fallbacks.
 */

const PC_REQUEST_TIMEOUT_MS = 15_000

export interface ProjectContextAdmin {
  capabilities(productSpaceId: string): Promise<PcCapabilitiesResponse>
  summary(productSpaceId: string): Promise<PcSummaryResponse>
  listAssets(productSpaceId: string, query: {
    view?: string
    tag?: string
    pinned?: string
    q?: string
    limit?: number
    cursor?: string
  }): Promise<{ assets: PcMutationResponse['asset'][]; nextCursor?: string; canManage: boolean }>
  getAsset(productSpaceId: string, assetId: string): Promise<PcMutationResponse>
  createAsset(productSpaceId: string, input: PcCreateAssetInput): Promise<PcUploadGrantResponse>
  createUpload(productSpaceId: string, assetId: string, input: PcCreateUploadInput): Promise<PcUploadGrantResponse>
  completeUpload(productSpaceId: string, assetId: string, uploadId: string): Promise<PcCompleteUploadResponse>
  updateAsset(productSpaceId: string, assetId: string, input: PcUpdateAssetInput): Promise<PcMutationResponse>
  setConfirmed(productSpaceId: string, assetId: string, input: PcSetConfirmedInput): Promise<PcMutationResponse>
  setPinned(productSpaceId: string, assetId: string, input: PcSetPinnedInput): Promise<PcMutationResponse>
  trashAsset(productSpaceId: string, assetId: string, expectedRevision: number): Promise<PcMutationResponse>
  restoreAsset(productSpaceId: string, assetId: string, input: PcRestoreInput): Promise<PcMutationResponse>
  getDownload(productSpaceId: string, assetId: string, version?: number): Promise<PcDownloadResponse>
  getRead(productSpaceId: string, assetId: string, version?: number): Promise<PcReadResponse>
  getPreview(productSpaceId: string, assetId: string, version?: number): Promise<PcPreviewResponse>
  search(productSpaceId: string, query: { q: string; tag?: string; limit?: number }): Promise<PcSearchResponse>
  rebuild(productSpaceId: string): Promise<{ jobId: string }>
}

export class ProjectContextAdminUnavailableError extends Error {
  readonly code: 'pc_admin_unreachable' | 'pc_signed_out'
  constructor(code: 'pc_admin_unreachable' | 'pc_signed_out', message: string) {
    super(message)
    this.name = 'ProjectContextAdminUnavailableError'
    this.code = code
  }
}

/** The admin error's stable pc_* wire code, when one rode the response. */
export function projectContextErrorCodeOf(error: unknown): string | null {
  if (error instanceof AdminError) {
    const code = (error as unknown as { errorCode?: unknown }).errorCode
    if (typeof code === 'string' && code.startsWith('pc_')) return code
  }
  return null
}

async function withAdmin<T>(run: (client: AdminClient, accessToken: string) => Promise<T>): Promise<T> {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new ProjectContextAdminUnavailableError('pc_admin_unreachable', 'No admin server is configured')
  }
  let accessToken: string | null = null
  try {
    const tokens = await getCredentialManager().getAdminTokens()
    accessToken = tokens?.accessToken ?? null
  } catch {
    accessToken = null
  }
  if (!accessToken) {
    throw new ProjectContextAdminUnavailableError('pc_signed_out', 'No signed-in admin session is available')
  }
  return run(new AdminClient(adminUrl, { requestTimeoutMs: PC_REQUEST_TIMEOUT_MS }), accessToken)
}

/** The live adapter used by RPC handlers and the send path. */
export function getProjectContextAdmin(): ProjectContextAdmin {
  const encoded = (productSpaceId: string) => encodeURIComponent(productSpaceId)
  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value))
    }
    const encodedQuery = search.toString()
    return encodedQuery ? `?${encodedQuery}` : ''
  }
  return {
    capabilities: (productSpaceId) =>
      withAdmin((client, token) =>
        client.getProjectContextCapabilities(token, productSpaceId)),
    summary: (productSpaceId) =>
      withAdmin((client, token) => client.getProjectContextSummary(token, productSpaceId)),
    listAssets: (productSpaceId, listQuery) =>
      withAdmin((client, token) =>
        client.listProjectContextAssets(token, productSpaceId, listQuery)),
    getAsset: (productSpaceId, assetId) =>
      withAdmin((client, token) => client.getProjectContextAsset(token, productSpaceId, assetId)),
    createAsset: (productSpaceId, input) =>
      withAdmin((client, token) => client.createProjectContextAsset(token, productSpaceId, input)),
    createUpload: (productSpaceId, assetId, input) =>
      withAdmin((client, token) =>
        client.createProjectContextUpload(token, productSpaceId, assetId, input)),
    completeUpload: (productSpaceId, assetId, uploadId) =>
      withAdmin((client, token) =>
        client.completeProjectContextUpload(token, productSpaceId, assetId, uploadId)),
    updateAsset: (productSpaceId, assetId, input) =>
      withAdmin((client, token) =>
        client.updateProjectContextAsset(token, productSpaceId, assetId, input)),
    setConfirmed: (productSpaceId, assetId, input) =>
      withAdmin((client, token) =>
        client.setProjectContextConfirmed(token, productSpaceId, assetId, input)),
    setPinned: (productSpaceId, assetId, input) =>
      withAdmin((client, token) =>
        client.setProjectContextPinned(token, productSpaceId, assetId, input)),
    trashAsset: (productSpaceId, assetId, expectedRevision) =>
      withAdmin((client, token) =>
        client.trashProjectContextAsset(token, productSpaceId, assetId, expectedRevision)),
    restoreAsset: (productSpaceId, assetId, input) =>
      withAdmin((client, token) =>
        client.restoreProjectContextAsset(token, productSpaceId, assetId, input)),
    getDownload: (productSpaceId, assetId, version) =>
      withAdmin((client, token) =>
        client.getProjectContextDownload(token, productSpaceId, assetId, version)),
    getRead: (productSpaceId, assetId, version) =>
      withAdmin((client, token) =>
        client.getProjectContextRead(token, productSpaceId, assetId, version)),
    getPreview: (productSpaceId, assetId, version) =>
      withAdmin((client, token) =>
        client.getProjectContextPreview(token, productSpaceId, assetId, version)),
    search: (productSpaceId, searchQuery) =>
      withAdmin((client, token) =>
        client.searchProjectContextAssets(token, productSpaceId, searchQuery)),
    rebuild: (productSpaceId) =>
      withAdmin((client, token) => client.rebuildProjectContext(token, productSpaceId)),
  }
}

/**
 * Streams a local file DIRECTLY to the granted upload URL. The grant's
 * requiredHeaders travel verbatim; no admin credential is ever attached to
 * this request. Completion (admin verification + publish) is a separate
 * call the service composes after this resolves.
 */
export async function putProjectContextFile(input: {
  grant: PcUploadGrantResponse
  filePath: string
  timeoutMs?: number
}): Promise<void> {
  const fileStat = await stat(input.filePath)
  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${input.filePath}`)
  }
  const announced = input.grant.requiredHeaders['content-length']
  if (announced !== undefined && Number(announced) !== fileStat.size) {
    // The grant is bound to the announced size; a drifted file must not be
    // uploaded (the storage-side size check would reject it anyway).
    throw new Error('Local file size no longer matches the announced upload')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30 * 60_000)
  let response: Response
  try {
    const stream = Readable.toWeb(createReadStream(input.filePath)) as unknown as ReadableStream
    response = await fetch(input.grant.uploadUrl, {
      method: input.grant.method,
      headers: input.grant.requiredHeaders,
      body: stream,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Upload was rejected (${response.status})`)
  }
  void response.body?.cancel().catch(() => {})
}

/**
 * Streams a granted download URL to a local path. The URL is a short-lived
 * attachment capability — no admin credential is attached.
 */
export async function downloadProjectContextFile(input: {
  url: string
  targetPath: string
  timeoutMs?: number
}): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30 * 60_000)
  let response: Response
  try {
    response = await fetch(input.url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Download failed (${response.status})`)
  }
  const { writeFile } = await import('node:fs/promises')
  const { pipeline } = await import('node:stream/promises')
  const nodeStream = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
  await pipeline(nodeStream, (await import('node:fs')).createWriteStream(input.targetPath))
  // Return an absolute path so the renderer can reveal/open it safely.
  return path.resolve(input.targetPath)
}
