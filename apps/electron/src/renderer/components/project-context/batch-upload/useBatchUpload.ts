import * as React from 'react'
import {
  PC_BATCH_SUBMIT_MAX,
  type PcBatchExclusionReason,
  type PcScanFolderResponse,
  type PcStagedZipBatchResponse,
} from '@polo-ai/shared/protocol'
import type { PcScope } from '../useProjectAssets'
import { basenameOfPath, mimeFromName, prepareAssetUploadFile } from '../asset-upload-prep'
import { projectContextUploadErrorKey, type AssetUploadInput } from '../AssetUploadDialog'

/**
 * POO-210 batch upload state machine (renderer side of decisions D3–D5).
 *
 * The hook owns ONE batch lifecycle: source in (zip unpack / folder scan /
 * explicit multi-pick) → review checklist → serialized uploads → settled.
 * Everything heavy (unpack, scan, staging, the actual byte streaming) already
 * happened or happens on the trusted side; this module only sequences the
 * per-entry `pcUploadFile` calls, which are the UNCHANGED single-file RPC —
 * the admin wire never learns that a batch existed.
 *
 * The trusted side answers with the finished checklist, including the D2
 * classification (`included`/`reason`) and the zip-self entry (D3c, listed
 * unchecked). This module re-derives NOTHING about formats — the renderer
 * only owns the selection state and the queue.
 *
 * Budgets (D5): `PC_BATCH_SUBMIT_MAX` checked entries by default; the rest
 * stay listed but unchecked, and the view says so (`defaultedDown`). The
 * queue is strictly serial — one file in flight, the next starts only after
 * the previous settles, so a failure never multiplies and the progress
 * counter reads honestly. Cancelling is honest about the wire: the
 * in-flight `pcUploadFile` cannot be revoked, so cancel lets THAT entry
 * settle (success or failure recorded), then stops the queue and rewinds to
 * review — nothing is silently dropped, the user retries or closes.
 *
 * Lifecycle hygiene: the staging directory a zip batch created is cleaned up
 * when the dialog unmounts, and on the guarded close path via `stopForClose`.
 * A failed stage needs no cleanup (the trusted side already removed it).
 */

export type BatchUploadPhase = 'review' | 'uploading' | 'settled'

export type BatchUploadEntryStatus = 'pending' | 'uploading' | 'success' | 'failed'

export interface BatchUploadEntry {
  entryId: string
  /** Editable upload name (D3: basename by default, user-tweakable). */
  displayName: string
  /** Original absolute path or zip-internal path — shown as context, never sent. */
  sourcePath: string
  /** Null until the upload loop measures the file (explicit multi-pick). */
  sizeBytes: number | null
  /** False for entries the scan classified OUT (grey row + reason copy). */
  checkable: boolean
  selected: boolean
  reason: PcBatchExclusionReason | null
  status: BatchUploadEntryStatus
  /** i18n key of the failure, set when status === 'failed'. */
  errorKey: string | null
  /** The local path the upload RPC streams (staging file or original). */
  stagedPath: string
}

export type BatchSourceKind = 'zip' | 'folder' | 'files'

export interface BatchUploadTotals {
  succeeded: number
  failed: number
}

const CANCELLED_ERROR_KEY = 'projectContext.upload.batch.cancelled'

interface UseBatchUploadOptions {
  /** Null keeps the hook idle — the batch entries are hidden without it. */
  scope: PcScope | null
  maxUploadBytes: number
  /**
   * The per-entry write — the same shape the single-file form submits. A
   * rejection marks THAT entry failed with the mapped pc_* copy; the queue
   * moves on.
   */
  onSubmit: (input: AssetUploadInput) => Promise<void>
  /** Fired once, when every checked entry has settled (success or failure). */
  onSettled?: (totals: BatchUploadTotals) => void
}

export function useBatchUpload({ scope, maxUploadBytes, onSubmit, onSettled }: UseBatchUploadOptions) {
  const [phase, setPhase] = React.useState<BatchUploadPhase>('review')
  const [sourceKind, setSourceKind] = React.useState<BatchSourceKind>('files')
  const [sourceLabel, setSourceLabel] = React.useState('')
  const [entries, setEntries] = React.useState<BatchUploadEntry[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [batchTags, setBatchTags] = React.useState<string[]>([])
  const [sourceNote, setSourceNote] = React.useState('')
  /** True when the scan found more entries than the submit budget can carry. */
  const [defaultedDown, setDefaultedDown] = React.useState(false)
  const [scanning, setScanning] = React.useState(false)

  // The batchId names the staging directory ONLY a zip batch created; the
  // ref survives re-renders so the unmount cleanup can always reach it.
  const batchIdRef = React.useRef<string | null>(null)
  const uploadAbortRef = React.useRef<AbortController | null>(null)
  const uploadingRef = React.useRef(false)
  // Latest-state snapshot for the running queue (state closures go stale).
  const entriesRef = React.useRef<BatchUploadEntry[]>([])
  entriesRef.current = entries

  const patchEntry = React.useCallback((entryId: string, patch: Partial<BatchUploadEntry>) => {
    setEntries((prev) => prev.map((entry) => (entry.entryId === entryId ? { ...entry, ...patch } : entry)))
  }, [])

  /* ---------------------------------------------------------------- */
  /* Source ingestion — three ways in, one entry shape out            */
  /* ---------------------------------------------------------------- */

  const adoptScanResult = React.useCallback((result: PcStagedZipBatchResponse | PcScanFolderResponse, kind: BatchSourceKind, label: string) => {
    const adopted: BatchUploadEntry[] = result.entries.map((entry) => ({
      entryId: entry.entryId,
      displayName: entry.displayName,
      sourcePath: entry.sourcePath,
      sizeBytes: entry.sizeBytes,
      checkable: entry.included,
      // The default selection IS the server classification; the submit
      // budget (D5) caps it — the overflow stays listed and unchecked, and
      // `defaultedDown` says so. The zip-self entry arrives included:false
      // (D3c), so "listed but unchecked" falls out of the same rule.
      selected: entry.included,
      reason: entry.reason,
      status: 'pending' as const,
      errorKey: null,
      stagedPath: entry.stagedPath,
    }))
    let defaultedDownNext = false
    let budget = PC_BATCH_SUBMIT_MAX
    const capped = adopted.map((entry) => {
      if (!entry.selected) return entry
      if (budget <= 0) {
        defaultedDownNext = true
        return { ...entry, selected: false }
      }
      budget -= 1
      return entry
    })
    if ('batchId' in result) batchIdRef.current = result.batchId
    setSourceKind(kind)
    setSourceLabel(label)
    setEntries(capped)
    setTruncated(result.truncated)
    setDefaultedDown(defaultedDownNext)
    setPhase('review')
  }, [])

  const beginZipBatch = React.useCallback(async (zipPath: string) => {
    if (!scope) return
    setScanning(true)
    try {
      const result = await window.electronAPI.pcStageZipBatch({
        workspaceId: scope.workspaceId,
        productSpaceId: scope.productSpaceId,
        projectId: scope.projectId,
        zipPath,
        maxEntryBytes: maxUploadBytes,
      })
      adoptScanResult(result, 'zip', basenameOfPath(zipPath))
    } finally {
      setScanning(false)
    }
  }, [adoptScanResult, maxUploadBytes, scope])

  const beginFolderBatch = React.useCallback(async (folderPath: string) => {
    if (!scope) return
    setScanning(true)
    try {
      const result = await window.electronAPI.pcScanFolder({
        workspaceId: scope.workspaceId,
        productSpaceId: scope.productSpaceId,
        projectId: scope.projectId,
        folderPath,
        maxEntryBytes: maxUploadBytes,
      })
      adoptScanResult(result, 'folder', basenameOfPath(folderPath))
    } finally {
      setScanning(false)
    }
  }, [adoptScanResult, maxUploadBytes, scope])

  /** Explicit multi-pick (D4): the user named these files, so the D2 format
   * rules do NOT re-judge them — only the hard bounds do, and those are
   * enforced in the upload loop's prep (empty/too_large/read_failed land as
   * single-entry failures, never as a blocked batch). */
  const beginFilesBatch = React.useCallback((paths: string[]) => {
    batchIdRef.current = null
    setSourceKind('files')
    setSourceLabel('')
    setTruncated(false)
    setDefaultedDown(paths.length > PC_BATCH_SUBMIT_MAX)
    // The full list stays VISIBLE; only the default selection is capped
    // (D5) — the overflow is unchecked, never silently dropped.
    setEntries(paths.map((filePath, index) => ({
      entryId: `${filePath}#${index}`,
      displayName: basenameOfPath(filePath),
      sourcePath: filePath,
      sizeBytes: null,
      checkable: true,
      selected: index < PC_BATCH_SUBMIT_MAX,
      reason: null,
      status: 'pending' as const,
      errorKey: null,
      stagedPath: filePath,
    })))
    setPhase('review')
  }, [])

  /* ---------------------------------------------------------------- */
  /* Checklist interactions                                           */
  /* ---------------------------------------------------------------- */

  const toggleEntry = React.useCallback((entryId: string) => {
    setEntries((prev) => prev.map((entry) => (
      entry.entryId === entryId && entry.checkable && entry.status !== 'uploading'
        ? { ...entry, selected: !entry.selected }
        : entry
    )))
  }, [])

  const renameEntry = React.useCallback((entryId: string, displayName: string) => {
    const trimmed = displayName.trim()
    if (!trimmed) return
    patchEntry(entryId, { displayName: trimmed })
  }, [patchEntry])

  const toggleAllCheckable = React.useCallback((selected: boolean) => {
    setEntries((prev) => {
      let budget = PC_BATCH_SUBMIT_MAX
      return prev.map((entry) => {
        if (!entry.checkable || entry.status === 'uploading') return entry
        if (!selected) return { ...entry, selected: false }
        if (budget <= 0) return entry
        budget -= 1
        return { ...entry, selected: true }
      })
    })
  }, [])

  /* ---------------------------------------------------------------- */
  /* The serialized upload queue                                      */
  /* ---------------------------------------------------------------- */

  const uploadQueue = React.useCallback(async (signal: AbortSignal) => {
    uploadingRef.current = true
    setPhase('uploading')
    let succeeded = 0
    let failed = 0
    try {
      // Snapshot the check order ONCE: toggles during an upload don't sneak
      // new entries into the running batch (they take effect next run).
      const queue = entriesRef.current.filter((entry) => entry.checkable && entry.selected && entry.status !== 'success')
      for (const entry of queue) {
        if (signal.aborted) break
        patchEntry(entry.entryId, { status: 'uploading', errorKey: null })
        try {
          const prepared = await prepareAssetUploadFile(entry.stagedPath, maxUploadBytes, { signal })
          if (signal.aborted) break
          await onSubmit({
            filePath: entry.stagedPath,
            name: entry.displayName,
            tags: batchTags,
            source: sourceNote.trim() ? { kind: 'file', note: sourceNote.trim() } : undefined,
            sizeBytes: prepared.sizeBytes,
            mime: mimeFromName(entry.displayName),
            checksumSha256: prepared.digestSha256,
          })
          patchEntry(entry.entryId, { status: 'success', errorKey: null })
          succeeded += 1
        } catch (error) {
          if (signal.aborted) {
            patchEntry(entry.entryId, { status: 'failed', errorKey: CANCELLED_ERROR_KEY })
            break
          }
          patchEntry(entry.entryId, { status: 'failed', errorKey: projectContextUploadErrorKey(error) })
          failed += 1
        }
      }
    } finally {
      uploadingRef.current = false
      uploadAbortRef.current = null
      if (signal.aborted) {
        // Cancel rewinds to review: unattempted entries stay pending, the
        // user retries or closes (both paths clean the staging directory).
        setPhase('review')
      } else {
        setPhase('settled')
        onSettled?.({ succeeded, failed })
      }
    }
  }, [batchTags, maxUploadBytes, onSubmit, onSettled, patchEntry, sourceNote])

  const startUpload = React.useCallback(() => {
    if (uploadingRef.current) return
    if (!entriesRef.current.some((entry) => entry.checkable && entry.selected && entry.status !== 'success')) return
    const controller = new AbortController()
    uploadAbortRef.current = controller
    void uploadQueue(controller.signal)
  }, [uploadQueue])

  /** D5: cancel stops the queue once the in-flight entry settles (the
   * transfer itself cannot be revoked) and rewinds to review. */
  const cancelUpload = React.useCallback(() => {
    uploadAbortRef.current?.abort()
  }, [])

  /** Single-failure recovery: requeue every failed entry and run again. */
  const retryFailed = React.useCallback(() => {
    if (uploadingRef.current) return
    const rewind = (list: BatchUploadEntry[]): BatchUploadEntry[] => list.map((entry) => (
      entry.status === 'failed' && entry.checkable && entry.selected
        ? { ...entry, status: 'pending' as const, errorKey: null }
        : entry
    ))
    // Both the state and the snapshot move synchronously — startUpload's
    // guard reads the snapshot, not the not-yet-committed state.
    entriesRef.current = rewind(entriesRef.current)
    setEntries(entriesRef.current)
    startUpload()
  }, [startUpload])

  /* ---------------------------------------------------------------- */
  /* Staging lifecycle                                                */
  /* ---------------------------------------------------------------- */

  /** Drops the zip batch's staging directory. Idempotent; a files/folder
   * batch has nothing staged and resolves immediately. */
  const cleanupStaging = React.useCallback(async () => {
    const batchId = batchIdRef.current
    batchIdRef.current = null
    if (!batchId) return
    try {
      await window.electronAPI.pcStageCleanup({ batchId })
    } catch {
      // The trusted side also sweeps the staging root at registration;
      // a failed cleanup here must never block closing the dialog.
    }
  }, [])

  /** The guarded close's cleanup step: stop the queue, drop the staging. */
  const stopForClose = React.useCallback(async () => {
    uploadAbortRef.current?.abort()
    await cleanupStaging()
  }, [cleanupStaging])

  // A gone dialog must not leave staging debris or an in-flight upload.
  React.useEffect(() => () => {
    uploadAbortRef.current?.abort()
    void cleanupStaging()
  }, [cleanupStaging])

  return {
    // state
    phase,
    sourceKind,
    sourceLabel,
    entries,
    truncated,
    defaultedDown,
    scanning,
    batchTags,
    sourceNote,
    uploading: phase === 'uploading',
    settled: phase === 'settled',
    selectedCount: entries.filter((entry) => entry.checkable && entry.selected && entry.status !== 'success').length,
    selectedBytes: entries
      .filter((entry) => entry.checkable && entry.selected)
      .reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
    doneCount: entries.filter((entry) => entry.status === 'success' || entry.status === 'failed').length,
    failedCount: entries.filter((entry) => entry.status === 'failed').length,
    // actions
    beginZipBatch,
    beginFolderBatch,
    beginFilesBatch,
    toggleEntry,
    toggleAllCheckable,
    renameEntry,
    setBatchTags,
    setSourceNote,
    startUpload,
    cancelUpload,
    retryFailed,
    stopForClose,
  }
}

export type BatchUploadController = ReturnType<typeof useBatchUpload>
