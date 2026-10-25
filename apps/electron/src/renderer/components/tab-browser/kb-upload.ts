import { KB_MAX_CONTENT_BYTES } from '@polo-ai/shared/protocol'

/**
 * Pure upload-queue logic for the POO-143 knowledge-base management surface.
 * The file-classification and byte-accounting rules live here (not in the
 * component) so the selection guard is testable without rendering: the SAME
 * path serves the file picker and the drag-and-drop dropzone (Spec S3.1).
 */

/** The file types the KB accepts — mirrored by the picker's `accept` attribute. */
const KB_FILE_EXTENSION_PATTERN = /\.(md|markdown|txt)$/i

export function isAllowedKbFileName(fileName: string): boolean {
  return KB_FILE_EXTENSION_PATTERN.test(fileName)
}

/** The upload title defaults to the file name without its extension. */
export function stripKbFileExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|txt)$/i, '')
}

/** Why a picked file was refused at selection time (Spec S3.1 aggregate). */
export type KbFileRejectionReason = 'badType' | 'tooLarge' | 'unreadable'

/** One refused file in the aggregated pick summary (Spec S3.1). */
export interface KbUploadRejection {
  fileName: string
  reason: KbFileRejectionReason
}

export function classifyKbFile(file: { name: string; size: number }): KbFileRejectionReason | null {
  if (!isAllowedKbFileName(file.name)) return 'badType'
  if (file.size > KB_MAX_CONTENT_BYTES) return 'tooLarge'
  return null
}

/** One queue row inside the upload dialog (Spec S3.1/S3.2). */
export interface KbQueueItem {
  qid: string
  fileName: string
  title: string
  text: string
  sizeBytes: number
}

/**
 * The per-row lifecycle of a CONFIRMED upload rendered as a pending document
 * row (Spec S3.3/S3.4): staged progress (never a fabricated percentage), a
 * cancelled state that defers to the server result (Spec S5.1), and the
 * result-unknown state that offers verification instead of a blind retry.
 */
export type KbUploadStage = 'queued' | 'submitted' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'unknown'

export interface KbActiveUpload {
  qid: string
  collectionId: string
  fileName: string
  title: string
  text: string
  stage: KbUploadStage
  /** Captured when the upload was confirmed — the verify window's floor. */
  startedAt: number
  errorText?: string
  /** Set when a verify found no matching document: retry becomes available. */
  verifyMissed?: boolean
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The aggregate pick summary (Spec S3.1): "added X, rejected Y" over the LIVE
 * queue — rejections from a batch that added nothing APPEND to the previous
 * list (never overwrite, never drop a file name); a batch that added at least
 * one file clears the stale list instead.
 */
export function mergeUploadRejections(
  previous: KbUploadRejection[],
  rejectedNow: KbUploadRejection[],
  addedCount: number,
): KbUploadRejection[] {
  if (addedCount > 0) return rejectedNow
  if (rejectedNow.length === 0) return previous
  return [...previous, ...rejectedNow]
}
