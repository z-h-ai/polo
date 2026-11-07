import { IncrementalSha256 } from '../../../shared/sha256'

/**
 * Local file preparation for the project-context upload RPC (POO-196).
 *
 * The renderer hands the upload a LOCAL PATH (never a transfer URL — the
 * trusted side streams the bytes). Before the RPC can fire, this module:
 * reads the file once, measures it, derives a display mime from the
 * extension and computes the SHA-256 integrity digest the contract requires.
 *
 * Implementation note (chunking): the renderer-facing electronAPI exposes
 * only a whole-file `readFileBinary` — there is no chunked read RPC — so the
 * read cannot be split today. The exposure is bounded instead: the caller
 * gates on the server-advertised `limits.maxUploadBytes` BEFORE reading, and
 * a read that still comes back oversized is refused without ever reaching
 * the wire. If a ranged read API lands later, this is the one module to
 * swap for chunked hashing (IncrementalSha256 already supports it).
 */

export type AssetUploadPrepFailure =
  | 'too_large'
  | 'read_failed'

export class AssetUploadPrepError extends Error {
  readonly failure: AssetUploadPrepFailure
  constructor(failure: AssetUploadPrepFailure, cause?: unknown) {
    super(failure)
    this.name = 'AssetUploadPrepError'
    this.failure = failure
    if (cause) (this as { cause?: unknown }).cause = cause
  }
}

const SHA256_CHUNK_BYTES = 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function basenameOfPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '')
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
}

export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

export interface PreparedAssetUpload {
  filePath: string
  name: string
  sizeBytes: number
  mime: string
  /** Lowercase hex SHA-256 of the file bytes (contract `checksumSha256`). */
  digestSha256: string
}

/**
 * Reads the picked file once and derives everything the upload RPC needs.
 * `maxBytes` is the server-advertised limit — enforced here so an oversized
 * pick fails locally with actionable copy instead of a wire rejection.
 */
export async function prepareAssetUploadFile(
  filePath: string,
  maxBytes: number,
  options: { signal?: AbortSignal } = {},
): Promise<PreparedAssetUpload> {
  let bytes: Uint8Array
  try {
    bytes = await window.electronAPI.readFileBinary(filePath)
  } catch (cause) {
    throw new AssetUploadPrepError('read_failed', cause)
  }
  if (options.signal?.aborted) throw new AssetUploadPrepError('read_failed')
  if (bytes.byteLength <= 0 || bytes.byteLength > maxBytes) {
    throw new AssetUploadPrepError('too_large')
  }

  // Incremental SHA-256 over fixed chunks: identical digest to a one-shot
  // crypto.subtle.digest, but the hashing stays cancellable and never
  // doubles the file's memory footprint.
  const hash = new IncrementalSha256()
  for (let offset = 0; offset < bytes.byteLength; offset += SHA256_CHUNK_BYTES) {
    if (options.signal?.aborted) throw new AssetUploadPrepError('read_failed')
    hash.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + SHA256_CHUNK_BYTES)))
  }

  const name = basenameOfPath(filePath)
  return {
    filePath,
    name,
    sizeBytes: bytes.byteLength,
    mime: mimeFromName(name),
    digestSha256: hash.digestHex(),
  }
}

/** Locale-aware size rendering for the upload dialog and list rows. */
export function formatAssetBytes(t: (key: string, options?: Record<string, unknown>) => string, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return t('projectContext.size.bytes', { value: 0 })
  }
  if (sizeBytes < 1024) return t('projectContext.size.bytes', { value: sizeBytes })
  if (sizeBytes < 1024 * 1024) return t('projectContext.size.kilobytes', { value: Math.round(sizeBytes / 1024) })
  if (sizeBytes < 1024 * 1024 * 1024) {
    return t('projectContext.size.megabytes', { value: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10 })
  }
  return t('projectContext.size.gigabytes', { value: Math.round((sizeBytes / (1024 * 1024 * 1024)) * 10) / 10 })
}
