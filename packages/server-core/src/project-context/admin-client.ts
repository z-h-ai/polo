import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
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
    processing?: string
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

/* ------------------------------------------------------------------ */
/* Download destination (main-process authority)                       */
/* ------------------------------------------------------------------ */

/** The ONLY directory downloads may land in — decided by THIS process, never
 * by the renderer. Same convention as the app's other attachment downloads:
 * the OS Downloads folder. */
let downloadRootOverride: string | null = null

/** Test seam: pin the download root so containment/symlink behavior is
 * observable without touching the user's real Downloads folder. */
export function setProjectContextDownloadRootForTests(root: string | null): void {
  downloadRootOverride = root
}

/** Resolved REAL root: a parent-chain symlink (macOS /tmp → /private/tmp, or
 * a user-replaced Downloads entry) must not widen the writable set. */
async function projectContextDownloadRoot(): Promise<string> {
  const requested = downloadRootOverride ?? path.join(homedir(), 'Downloads')
  await mkdir(requested, { recursive: true })
  return realpath(requested)
}

/** The caller's targetPath contributes a FILE NAME at most — every directory
 * component (`..`, absolute paths, separators) is discarded before any
 * filesystem call ever sees it. */
function downloadFileNameOf(requestedPath: string): string {
  const base = path.basename(requestedPath ?? '').trim()
  if (!base || base === '.' || base === '..' || base === path.sep) {
    throw new Error('A download file name is required')
  }
  return base
}

function slotPath(fileName: string, ordinal: number): string {
  if (ordinal === 0) return fileName
  const ext = path.extname(fileName)
  const stem = ext ? fileName.slice(0, -ext.length) : fileName
  return `${stem} (${ordinal + 1})${ext}`
}

/** Finder-style naming: an existing entry is never silently overwritten, the
 * next free `name (2).ext` ordinal is used instead. */
async function firstFreeOrdinal(root: string, fileName: string): Promise<number> {
  for (let ordinal = 0; ordinal < 100; ordinal += 1) {
    try {
      await lstat(path.join(root, slotPath(fileName, ordinal)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ordinal
      throw error
    }
  }
  throw new Error(`No free download slot for ${fileName}`)
}

/** Bridges a granted response body to a node readable we own. Pumping the
 * reader by hand (instead of Readable.fromWeb) matters because a mid-transfer
 * failure must REJECT the write pipeline — fromWeb leaves the node side
 * stalled forever on some runtimes when the web stream errors, which would
 * hang this call and leave the temp file in place. */
function projectContextBodyStream(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader()
  return new Readable({
    read(this: Readable) {
      void reader.read().then(
        (chunk) => {
          if (chunk.done) this.push(null)
          else this.push(chunk.value)
        },
        (error: unknown) => {
          this.destroy(error instanceof Error ? error : new Error(String(error)))
        },
      )
    },
    destroy(this: Readable, error: Error | null, callback: (error?: Error | null) => void) {
      void reader.cancel().catch(() => {})
      callback(error)
    },
  })
}

/**
 * Streams a granted download URL to the downloads directory THIS process
 * owns. The URL is a short-lived attachment capability — no admin credential
 * is attached.
 *
 * Destination discipline (consensus S-04+X9): the renderer's targetPath only
 * ever supplies the file name; the directory is fixed here, re-checked for
 * containment, and the final entry is created by an atomic no-clobber
 * `link()` from a private temp file in the same directory — a failed or
 * interrupted download can never leave a half-written file at the visible
 * name, and an existing file (or a planted symlink) is never overwritten.
 */
export async function downloadProjectContextFile(input: {
  url: string
  targetPath: string
  timeoutMs?: number
}): Promise<string> {
  const root = await projectContextDownloadRoot()
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  const fileName = downloadFileNameOf(input.targetPath)
  // Defense in depth: even after basename-only narrowing, prove containment.
  const resolved = path.resolve(root, fileName)
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('Download destination escaped the downloads directory')
  }

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

  let ordinal = await firstFreeOrdinal(root, fileName)
  let targetPath = path.join(root, slotPath(fileName, ordinal))
  const tempPath = path.join(root, `.${fileName}.${randomUUID()}.part`)
  let placed = false
  try {
    const { pipeline } = await import('node:stream/promises')
    const { createWriteStream } = await import('node:fs')
    const { link } = await import('node:fs/promises')
    const nodeStream = projectContextBodyStream(response.body as ReadableStream<Uint8Array>)
    await pipeline(nodeStream, createWriteStream(tempPath, { flags: 'wx' }))
    // Atomic no-clobber publish: EEXIST means a concurrent download claimed
    // the name between the probe and here — fall through to the next ordinal
    // instead of ever replacing an entry this download did not write.
    for (let guard = 0; guard < 100; guard += 1) {
      try {
        await link(tempPath, targetPath)
        placed = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        ordinal += 1
        targetPath = path.join(root, slotPath(fileName, ordinal))
      }
    }
    if (!placed) throw new Error(`No free download slot for ${fileName}`)
  } catch (error) {
    void response.body?.cancel().catch(() => {})
    throw error
  } finally {
    // The temp copy is either published (hard-linked) or dead weight.
    await unlink(tempPath).catch(() => {})
  }

  // Post-publish proof: the saved entry resolves back inside the real root.
  const savedPath = await realpath(targetPath)
  if (!savedPath.startsWith(rootWithSep)) {
    await unlink(targetPath).catch(() => {})
    throw new Error('The saved download resolved outside the downloads directory')
  }
  return savedPath
}
