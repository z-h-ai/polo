import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { toast } from 'sonner'
import type {
  KbCollection,
  KbDocumentStatus,
  KbDocumentSummary,
} from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDestructiveClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchFocusClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { renderKbMarkdown } from './kb-markdown'
import { KbUploadDialog } from './kb-upload-dialog'
import {
  classifyKbFile,
  mergeUploadRejections,
  stripKbFileExtension,
  utf8ByteLength,
  type KbActiveUpload,
  type KbQueueItem,
  type KbUploadRejection,
} from './kb-upload'

/**
 * The enterprise knowledge base app tab (POO-108 v3.1, interaction rebuild in
 * POO-143): write-side management over the workspace's knowledge base through
 * the LOCAL_ONLY kb RPC surface. Members read published documents; owners and
 * managers run the draft → review → publish flow. Every server mutation is
 * permission-checked and audited server-side — this surface only renders the
 * outcome, and where the content physically lives is invisible here by
 * contract.
 *
 * POO-143 feedback contract: there is NO global busy gate. Every operation
 * owns a row-level pending state (Spec S1), data refreshes arrive through a
 * 30s silent poll that merges WITHOUT clearing (Spec S2) and a pending row is
 * never overwritten by an older server snapshot (Spec S2.4). Uploads run as a
 * serial queue with staged progress, per-row cancel/retry and the
 * result-unknown verify path (Spec S3/S5).
 */

/** The silent-poll cadence (Spec S2.1); a failing poll backs off to the max. */
export const KB_POLL_INTERVAL_MS = 30_000
export const KB_POLL_MAX_INTERVAL_MS = 60_000
/** Consecutive silent failures before the sync banner replaces silence. */
const KB_SYNC_FAIL_THRESHOLD = 2
/** A confirmed upload sits in `submitted` this long before reading `uploading`. */
const KB_UPLOAD_STAGE_DELAY_MS = 800
/** How long a finished/cancelled upload row lingers before it disappears. */
const KB_UPLOAD_ROW_TTL_MS = 1_600
/** How long a freshly inserted document row keeps its highlight. */
const KB_FRESH_ROW_MS = 2_200

const KB_STATUS_BADGE: Record<KbDocumentStatus, string> = {
  draft: 'bg-foreground/8 text-foreground-70',
  in_review: 'bg-info/12 text-info-text',
  published: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent',
  rejected: 'bg-destructive/10 text-destructive',
}

/**
 * POO-108 F2: the electron context bridge re-creates rejected Errors from
 * their message alone, so a bridged KB error carries its code inside the
 * message (see shared/rpc-error-bridge.ts). The shared reader accepts both
 * shapes — a live `code` property (direct transport) and the bridge-carried
 * marker — so the mapping below never degrades to the generic text.
 */
function isKbError(error: unknown, code: string): boolean {
  return readRpcErrorCode(error) === code
}

function kbErrorText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown): string {
  const code = readRpcErrorCode(error)
  if (code === 'kb_manage_required') return t('knowledgeBase.errors.manageRequired')
  if (code === 'kb_content_too_large') return t('knowledgeBase.errors.tooLarge')
  if (code === 'kb_invalid_transition') return t('knowledgeBase.errors.invalidTransition')
  if (code === 'kb_delete_not_allowed') return t('knowledgeBase.errors.deleteNotAllowed')
  if (code === 'kb_collection_not_found' || code === 'kb_document_not_found') return t('knowledgeBase.errors.notFound')
  // A concurrent writer landed inside the re-read/verify window (store B6):
  // the state on the server is newer than this client's view of it.
  if (code === 'kb_conflict') return t('knowledgeBase.errors.conflict')
  if (code === 'kb_unavailable_in_personal') return t('knowledgeBase.errors.personalSpace')
  if (code === 'kb_space_read_only') return t('knowledgeBase.errors.spaceReadOnly')
  if (code === 'kb_space_mismatch') return t('knowledgeBase.errors.spaceMismatch')
  // The knowledge base service could not be reached (POO-108 v3.1): the text
  // stays neutral — never the storage vendor, a URI or a raw response.
  if (code === 'kb_service_unavailable') return t('knowledgeBase.errors.serviceUnavailable')
  if (code === 'OFFLINE_READ_ONLY') return t('knowledgeBase.errors.offline')
  return t('knowledgeBase.errors.generic')
}

type TransitionOp = 'submit' | 'publish' | 'reject' | 'revert' | 'delete'

interface RowPendingState {
  op: TransitionOp
  reason?: string
}

interface FailedRowState {
  op: TransitionOp
  reason?: string
  message: string
}

interface PendingCollectionRow {
  pid: string
  name: string
  description: string
}

interface PreviewState {
  title: string
  loading: boolean
  content: string | null
  error: string | null
}

const TRANSITION_PENDING_KEY: Record<TransitionOp, string> = {
  submit: 'knowledgeBase.pending.submit',
  publish: 'knowledgeBase.pending.publish',
  reject: 'knowledgeBase.pending.reject',
  revert: 'knowledgeBase.pending.revert',
  delete: 'knowledgeBase.pending.delete',
}

const TRANSITION_TOAST_KEY: Record<TransitionOp, string> = {
  submit: 'knowledgeBase.toast.submitted',
  publish: 'knowledgeBase.toast.published',
  reject: 'knowledgeBase.toast.rejected',
  revert: 'knowledgeBase.toast.reverted',
  delete: 'knowledgeBase.toast.deleted',
}

export interface KnowledgeBaseAppProps {
  /**
   * Test seam: overrides the silent-poll base interval. Production callers
   * omit it and get KB_POLL_INTERVAL_MS.
   */
  pollIntervalMs?: number
}

let kbUiSeq = 0
function nextKbUiId(prefix: string): string {
  kbUiSeq += 1
  return `${prefix}-${kbUiSeq}`
}

export function KnowledgeBaseApp({ pollIntervalMs }: KnowledgeBaseAppProps = {}) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const { activeWorkspaceId } = useAppShellContext()
  const workspaceId = activeWorkspaceId ?? ''

  const [collections, setCollections] = useState<KbCollection[]>([])
  // POO-108 review #6: the management capability is the trusted space role
  // returned with the list — never derived from existing rows, so an owner of
  // an empty space can still create the first collection.
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<KbDocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)

  // Silent-sync bookkeeping (Spec S2.2/S5.2): the banner only appears after
  // repeated poll failures and never replaces the stale data.
  const [syncFailed, setSyncFailed] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  // Dialog state: one open dialog at a time, keyed by intent.
  const [createOpen, setCreateOpen] = useState(false)
  const [collectionDraft, setCollectionDraft] = useState<CollectionDraft>({ name: '', description: '' })
  const [uploadTarget, setUploadTarget] = useState<KbCollection | null>(null)
  const [rejectTarget, setRejectTarget] = useState<KbDocumentSummary | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<KbDocumentSummary | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewSeqRef = useRef(0)

  // Spec S1.1: optimistic create rows at the tail of the collection list.
  const [pendingCollections, setPendingCollections] = useState<PendingCollectionRow[]>([])
  // Spec S1.2/S1.3: per-row transition pending + the inline failure state.
  const [rowPending, setRowPending] = useState<Record<string, RowPendingState>>({})
  const [failedRows, setFailedRows] = useState<Record<string, FailedRowState>>({})
  // Spec S3: the upload queue (dialog) and the confirmed-upload rows.
  const [uploadQueue, setUploadQueue] = useState<KbQueueItem[]>([])
  const [uploadRejections, setUploadRejections] = useState<KbUploadRejection[]>([])
  const [rejectionsExpanded, setRejectionsExpanded] = useState(false)
  const [uploadSelectedQid, setUploadSelectedQid] = useState<string | null>(null)
  const [activeUploads, setActiveUploads] = useState<KbActiveUpload[]>([])
  const [freshDocIds, setFreshDocIds] = useState<Set<string>>(new Set())

  // Live mirrors for async callbacks that must read the CURRENT view, not the
  // one captured when the request was issued (same discipline as
  // use-kb-selection-save): settlement-time guards and the merge protection.
  const selectedCollectionIdRef = useRef(selectedCollectionId)
  selectedCollectionIdRef.current = selectedCollectionId
  const documentsCollectionIdRef = useRef<string | null>(null)
  const documentsRef = useRef<KbDocumentSummary[]>([])
  documentsRef.current = documents
  const rowPendingRef = useRef(rowPending)
  rowPendingRef.current = rowPending
  const activeUploadsRef = useRef(activeUploads)
  activeUploadsRef.current = activeUploads
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  /**
   * Doc ids whose LOCAL row wins over the server listing, in two flavors: a
   * freshly uploaded row stays local until the listing confirms it, and a
   * transitioning row (Spec S2.4 — a pending row is never rewound by an older
   * snapshot) stays local until its operation settles. The merge only consumes
   * the upload flavor — a transition's protection must outlive the polls that
   * run while its RPC is in flight.
   */
  const protectedDocIdsRef = useRef(new Set<string>())
  const transitionDocIdsRef = useRef(new Set<string>())

  const selectedCollection = useMemo(
    () => collections.find(collection => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  )

  // Upload rows render inside the SELECTED collection's document panel, so
  // the empty-state check sees the same filtered slice — an in-flight upload
  // elsewhere must not suppress this panel's empty message.
  const visibleUploads = useMemo(
    () => activeUploads.filter(row => row.collectionId === selectedCollectionId),
    [activeUploads, selectedCollectionId],
  )

  // #region silent merge + refresh -------------------------------------------------

  const applyServerCollections = useCallback((list: { canManage: boolean; collections: KbCollection[] }, preferId?: string) => {
    setCanManage(list.canManage)
    setCollections(list.collections)
    setSelectedCollectionId(current => {
      const wanted = preferId ?? current
      return wanted && list.collections.some(row => row.id === wanted) ? wanted : list.collections[0]?.id ?? null
    })
  }, [])

  /**
   * The Spec S2.2/S2.4 merge: the server listing is authoritative EXCEPT for
   * protected local rows — a pending transition keeps its optimistic row, a
   * fresh upload stays visible until the listing confirms it. The list is
   * never cleared mid-flight, so no spinner flash is possible. The merge is
   * computed OUTSIDE the state updater and consumes protection only once, so
   * StrictMode's double-invoked updater can't release a row's protection
   * twice.
   */
  const applyServerDocuments = useCallback((incoming: KbDocumentSummary[], collectionId: string) => {
    if (documentsCollectionIdRef.current !== collectionId) return
    const protectedIds = protectedDocIdsRef.current
    const transitionIds = transitionDocIdsRef.current
    const local = new Map(documentsRef.current.map(row => [row.id, row]))
    const result: KbDocumentSummary[] = []
    const confirmedIds: string[] = []
    for (const doc of incoming) {
      const keepLocal = local.has(doc.id) && (protectedIds.has(doc.id) || transitionIds.has(doc.id))
      // Server confirmation releases only the upload flavor of protection; a
      // transitioning row keeps its protection until the operation settles.
      if (keepLocal && !transitionIds.has(doc.id)) confirmedIds.push(doc.id)
      result.push(keepLocal ? local.get(doc.id)! : doc)
    }
    // Protected rows the listing does not know about yet (a just-finished
    // upload the walk missed) stay on the face instead of vanishing.
    for (const row of documentsRef.current) {
      if (!incoming.some(doc => doc.id === row.id) && (protectedIds.has(row.id) || transitionIds.has(row.id))) result.push(row)
    }
    for (const id of confirmedIds) protectedIds.delete(id)
    setDocuments(result)
  }, [])

  const refreshCollections = useCallback(async (options: { silent?: boolean; preferId?: string } = {}) => {
    if (!workspaceId) return true
    if (!options.silent) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const list = await window.electronAPI.kbListCollections({ workspaceId })
      applyServerCollections(list, options.preferId)
      setLastSyncedAt(Date.now())
      return true
    } catch (error) {
      if (options.silent) return false
      setLoadError(kbErrorText(t, error))
      return false
    } finally {
      if (!options.silent) setLoading(false)
    }
  }, [applyServerCollections, t, workspaceId])

  const refreshDocuments = useCallback(async (collectionId: string, options: { silent?: boolean } = {}) => {
    if (!workspaceId) return true
    if (!options.silent) setDocumentsLoading(true)
    try {
      const rows = await window.electronAPI.kbListDocuments({ workspaceId, collectionId })
      applyServerDocuments(rows, collectionId)
      setLastSyncedAt(Date.now())
      return true
    } catch (error) {
      // A silent refresh keeps the stale rows (Spec S5.2); only an explicit
      // (non-silent) refresh surfaces its failure as a toast.
      if (!options.silent) toast.error(kbErrorText(t, error))
      return false
    } finally {
      if (!options.silent) setDocumentsLoading(false)
    }
  }, [applyServerDocuments, t, workspaceId])

  // Initial load only — every later arrival is a silent merge.
  useEffect(() => {
    void refreshCollections()
  }, [refreshCollections])

  useEffect(() => {
    documentsCollectionIdRef.current = selectedCollectionId
    protectedDocIdsRef.current.clear()
    transitionDocIdsRef.current.clear()
    if (!selectedCollectionId) {
      setDocuments([])
      return
    }
    void refreshDocuments(selectedCollectionId)
  }, [refreshDocuments, selectedCollectionId])

  // Tracks consecutive failed polls; a manual retry shares the same counter.
  const pollFailureRef = useRef(0)
  // One silent-sync step, shared by the poll timer and the banner retry.
  const runSilentSync = useCallback(async () => {
    const wid = workspaceIdRef.current
    if (!wid) return
    const collectionsOk = await refreshCollections({ silent: true })
    const collectionId = selectedCollectionIdRef.current
    const documentsOk = collectionId
      ? await refreshDocuments(collectionId, { silent: true })
      : true
    if (collectionsOk && documentsOk) {
      pollFailureRef.current = 0
      setSyncFailed(false)
      return
    }
    pollFailureRef.current += 1
    setSyncFailed(pollFailureRef.current >= KB_SYNC_FAIL_THRESHOLD)
  }, [refreshCollections, refreshDocuments])

  const runSilentSyncRef = useRef(runSilentSync)
  runSilentSyncRef.current = runSilentSync

  // Spec S2.1: the silent poll — base cadence, doubles while failing (capped),
  // paused while the page is hidden, an immediate tick on becoming visible.
  useEffect(() => {
    if (!workspaceId) return
    const base = pollIntervalMs ?? KB_POLL_INTERVAL_MS
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      const wait = pollFailureRef.current > 0
        ? Math.min(base * 2, KB_POLL_MAX_INTERVAL_MS)
        : base
      timer = setTimeout(() => { void tick() }, wait)
    }
    const tick = async () => {
      if (document.hidden) {
        schedule()
        return
      }
      try {
        await runSilentSyncRef.current()
      } finally {
        if (!disposed) schedule()
      }
    }
    schedule()
    const onVisibility = () => {
      if (document.hidden || timer === null) return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pollIntervalMs, workspaceId])

  // #endregion

  // #region create collection (Spec S1.1 / S5.3) -----------------------------------

  const handleCreateCollection = () => {
    const name = collectionDraft.name.trim()
    const description = collectionDraft.description
    if (name.length === 0 || !workspaceId) return
    const pid = nextKbUiId('pc')
    const issuedAtSelection = selectedCollectionIdRef.current
    // The dialog closes NOW; the list grows a pending row.
    setCreateOpen(false)
    setCollectionDraft({ name: '', description: '' })
    setPendingCollections(rows => [...rows, { pid, name, description }])
    void (async () => {
      try {
        const created = await window.electronAPI.kbCreateCollection({ workspaceId, name, description })
        setPendingCollections(rows => rows.filter(row => row.pid !== pid))
        // Spec S5.3: auto-select only while the user still sits in the view
        // that issued the create; otherwise a non-invasive entry appears.
        const movedAway = selectedCollectionIdRef.current !== issuedAtSelection
        if (movedAway) {
          toast.success(t('knowledgeBase.toast.collectionCreated'), {
            action: {
              label: t('knowledgeBase.pending.gotoCollection'),
              onClick: () => setSelectedCollectionId(created.id),
            },
          })
        } else {
          setSelectedCollectionId(created.id)
          toast.success(t('knowledgeBase.toast.collectionCreated'))
        }
        await refreshCollections({ silent: true, preferId: movedAway ? undefined : created.id })
      } catch (error) {
        setPendingCollections(rows => rows.filter(row => row.pid !== pid))
        // Spec S1.1: retry reopens the dialog with the name preserved.
        toast.error(kbErrorText(t, error), {
          action: {
            label: t('knowledgeBase.actions.retry'),
            onClick: () => {
              setCollectionDraft({ name, description })
              setCreateOpen(true)
            },
          },
        })
      }
    })()
  }

  // #endregion

  // #region transitions (Spec S1.2/S1.3) -------------------------------------------

  const startTransition = useCallback((doc: KbDocumentSummary, op: TransitionOp, options?: { reason?: string }) => {
    if (!workspaceId || rowPendingRef.current[doc.id]) return
    const reason = options?.reason
    setFailedRows(prev => {
      if (!(doc.id in prev)) return prev
      const next = { ...prev }
      delete next[doc.id]
      return next
    })
    setRowPending(prev => ({ ...prev, [doc.id]: { op, reason } }))
    // The transition protection lives until the operation settles — server
    // confirmations seen while the RPC is in flight must not release it.
    transitionDocIdsRef.current.add(doc.id)
    const invoke = async () => {
      switch (op) {
        case 'submit':
          await window.electronAPI.kbSubmitForReview({ workspaceId, docId: doc.id })
          break
        case 'publish':
          await window.electronAPI.kbPublishDocument({ workspaceId, docId: doc.id })
          break
        case 'reject':
          await window.electronAPI.kbRejectDocument({ workspaceId, docId: doc.id, reason: reason ?? '' })
          break
        case 'revert':
          await window.electronAPI.kbRevertToDraft({ workspaceId, docId: doc.id })
          break
        case 'delete':
          await window.electronAPI.kbDeleteDocument({ workspaceId, docId: doc.id })
          break
      }
    }
    void (async () => {
      try {
        await invoke()
        setRowPending(prev => {
          if (!(doc.id in prev)) return prev
          const next = { ...prev }
          delete next[doc.id]
          return next
        })
        transitionDocIdsRef.current.delete(doc.id)
        toast.success(t(TRANSITION_TOAST_KEY[op]))
        await refreshCollections({ silent: true })
        await refreshDocuments(doc.collectionId, { silent: true })
      } catch (error) {
        setRowPending(prev => {
          if (!(doc.id in prev)) return prev
          const next = { ...prev }
          delete next[doc.id]
          return next
        })
        transitionDocIdsRef.current.delete(doc.id)
        // Spec S1.2: the row rolls back to its true state and offers an
        // inline retry (the toast carries the neutral failure text).
        setFailedRows(prev => ({
          ...prev,
          [doc.id]: { op, reason, message: kbErrorText(t, error) },
        }))
        toast.error(kbErrorText(t, error))
      }
    })()
  }, [refreshCollections, refreshDocuments, t, workspaceId])

  // #endregion

  // #region upload pipeline (Spec S3 / S5.1) ---------------------------------------

  const uploadRunningRef = useRef(false)

  // Both mutators mirror the change into activeUploadsRef immediately — a
  // settle callback that reads the ref in the same tick as a cancel click
  // (nit: one-render lag) then sees the cancelled stage, not the last commit.
  const patchUpload = useCallback((qid: string, patch: Partial<KbActiveUpload>) => {
    activeUploadsRef.current = activeUploadsRef.current.map(row => (row.qid === qid ? { ...row, ...patch } : row))
    setActiveUploads(rows => rows.map(row => (row.qid === qid ? { ...row, ...patch } : row)))
  }, [])

  const removeUpload = useCallback((qid: string) => {
    activeUploadsRef.current = activeUploadsRef.current.filter(row => row.qid !== qid)
    setActiveUploads(rows => rows.filter(row => row.qid !== qid))
  }, [])

  const insertOrUpdateDocument = useCallback((summary: KbDocumentSummary) => {
    if (documentsCollectionIdRef.current !== summary.collectionId) return
    setDocuments(prev => {
      const index = prev.findIndex(row => row.id === summary.id)
      if (index < 0) return [...prev, summary]
      const next = [...prev]
      next[index] = summary
      return next
    })
    protectedDocIdsRef.current.add(summary.id)
    setFreshDocIds(prev => new Set(prev).add(summary.id))
    setTimeout(() => {
      setFreshDocIds(prev => {
        const next = new Set(prev)
        next.delete(summary.id)
        return next
      })
    }, KB_FRESH_ROW_MS)
  }, [])

  const runUpload = useCallback(async (item: KbActiveUpload) => {
    patchUpload(item.qid, { stage: 'submitted', errorText: undefined, verifyMissed: false })
    // Spec S3.4: staged progress only — `submitted` reads `uploading` after a
    // beat; never a fabricated percentage.
    const stageTimer = setTimeout(() => {
      setActiveUploads(rows => rows.map(row => (
        row.qid === item.qid && row.stage === 'submitted' ? { ...row, stage: 'uploading' } : row
      )))
    }, KB_UPLOAD_STAGE_DELAY_MS)
    try {
      const created = await window.electronAPI.kbUploadDocument({
        workspaceId: workspaceIdRef.current,
        collectionId: item.collectionId,
        title: item.title,
        content: item.text,
      })
      clearTimeout(stageTimer)
      // Spec S5.1: the server result wins — including the cancel race. A row
      // the user cancelled STILL renders its real outcome (the document
      // appears), never a fake "cancelled successfully".
      insertOrUpdateDocument(created)
      if (activeUploadsRef.current.find(row => row.qid === item.qid)?.stage === 'cancelled') {
        toast.success(t('knowledgeBase.pending.cancelledSettled'))
      } else {
        toast.success(t('knowledgeBase.toast.documentUploaded'))
      }
      patchUpload(item.qid, { stage: 'done' })
      setTimeout(() => removeUpload(item.qid), KB_UPLOAD_ROW_TTL_MS)
      void refreshCollections({ silent: true })
    } catch (error) {
      clearTimeout(stageTimer)
      const cancelled = activeUploadsRef.current.find(row => row.qid === item.qid)?.stage === 'cancelled'
      if (cancelled) {
        // The request died after the user gave up: cancelled stays cancelled.
        removeUpload(item.qid)
        return
      }
      if (isKbError(error, 'kb_result_unknown')) {
        // Spec S5.1: unknown ≠ failed. The row offers VERIFY (list the
        // collection and match by title) — never an automatic retry.
        patchUpload(item.qid, { stage: 'unknown' })
        return
      }
      patchUpload(item.qid, { stage: 'failed', errorText: kbErrorText(t, error) })
    }
  }, [insertOrUpdateDocument, patchUpload, refreshCollections, removeUpload, t])

  /**
   * The serial pump (Spec S3.1「全部上传」逐个进行), driven by state so it can
   * never race a stale ref: whenever any row sits `queued` and no upload is
   * in flight, the first queued row starts. Every settle path mutates
   * `activeUploads`, which re-runs this effect and keeps the queue draining —
   * a cancelled row frees the slot the moment its stage changes, not when the
   * abandoned request settles.
   */
  useEffect(() => {
    if (uploadRunningRef.current) return
    const next = activeUploads.find(row => row.stage === 'queued')
    if (!next) return
    uploadRunningRef.current = true
    void runUpload(next).finally(() => {
      uploadRunningRef.current = false
    })
  }, [activeUploads, runUpload])

  const handleCancelUpload = useCallback((qid: string) => {
    const row = activeUploadsRef.current.find(item => item.qid === qid)
    if (!row || row.stage === 'done' || row.stage === 'failed' || row.stage === 'cancelled' || row.stage === 'unknown') return
    patchUpload(qid, { stage: 'cancelled' })
    setTimeout(() => removeUpload(qid), KB_UPLOAD_ROW_TTL_MS)
  }, [patchUpload, removeUpload])

  const handleRetryUpload = useCallback((qid: string) => {
    patchUpload(qid, { stage: 'queued', errorText: undefined, verifyMissed: false })
  }, [patchUpload])

  /** Spec S5.1 verify: list the collection, match by title since the window. */
  const handleVerifyUpload = useCallback((qid: string) => {
    const row = activeUploadsRef.current.find(item => item.qid === qid)
    if (!row || !workspaceIdRef.current) return
    patchUpload(qid, { verifyMissed: false })
    void (async () => {
      try {
        const rows = await window.electronAPI.kbListDocuments({
          workspaceId: workspaceIdRef.current,
          collectionId: row.collectionId,
        })
        const windowFloor = row.startedAt - 60_000
        const match = rows
          .filter(candidate => candidate.title === row.title && Date.parse(candidate.updatedAt) >= windowFloor)
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
        if (match) {
          insertOrUpdateDocument(match)
          removeUpload(qid)
          toast.success(t('knowledgeBase.pending.verifiedFound'))
          void refreshCollections({ silent: true })
        } else {
          patchUpload(qid, { verifyMissed: true })
        }
      } catch (error) {
        patchUpload(qid, { verifyMissed: true, errorText: kbErrorText(t, error) })
      }
    })()
  }, [insertOrUpdateDocument, patchUpload, refreshCollections, removeUpload, t])

  /** Confirms the queue: every row becomes a document-list pending row (S3.3). */
  const handleConfirmUpload = () => {
    if (!uploadTarget || uploadQueue.length === 0) return
    const collectionId = uploadTarget.id
    const startedAt = Date.now()
    setActiveUploads(prev => [
      ...prev,
      ...uploadQueue.map(item => ({
        qid: item.qid,
        collectionId,
        fileName: item.fileName,
        title: item.title.trim().length > 0 ? item.title : item.fileName,
        text: item.text,
        stage: 'queued' as const,
        startedAt,
      })),
    ])
    setUploadQueue([])
    setUploadRejections([])
    setRejectionsExpanded(false)
    setUploadSelectedQid(null)
    setUploadTarget(null)
  }

  /**
   * Spec S3.1: ONE ingest path for picker and dropzone. Per-file verdicts are
   * immediate; a batch that added nothing APPENDS its rejections to the
   * previous ones (never overwrite, never lose a file name) while a batch
   * with at least one accepted file clears the stale list.
   */
  const ingestFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const rejectedNow: KbUploadRejection[] = []
    const accepted: KbQueueItem[] = []
    for (const file of files) {
      const reason = classifyKbFile(file)
      if (reason) {
        rejectedNow.push({ fileName: file.name, reason })
        continue
      }
      try {
        const text = await file.text()
        accepted.push({
          qid: nextKbUiId('q'),
          fileName: file.name,
          title: stripKbFileExtension(file.name),
          text,
          sizeBytes: utf8ByteLength(text),
        })
      } catch {
        rejectedNow.push({ fileName: file.name, reason: 'unreadable' })
      }
    }
    setUploadQueue(prev => [...prev, ...accepted])
    setUploadRejections(prev => mergeUploadRejections(prev, rejectedNow, accepted.length))
    if (accepted.length > 0) {
      setUploadSelectedQid(accepted[accepted.length - 1].qid)
      setRejectionsExpanded(false)
    }
  }, [])

  const updateQueueItem = useCallback((qid: string, patch: Partial<Pick<KbQueueItem, 'title' | 'text' | 'sizeBytes'>>) => {
    setUploadQueue(prev => prev.map(item => (item.qid === qid ? { ...item, ...patch } : item)))
  }, [])

  // #endregion

  // #region preview (Spec S1.4) -----------------------------------------------------

  const openPreview = useCallback((doc: KbDocumentSummary) => {
    // The dialog opens NOW with its own loading state; no global gate. The
    // sequence token guards the settle: only the LATEST open may paint.
    previewSeqRef.current += 1
    const seq = previewSeqRef.current
    setPreview({ title: doc.title, loading: true, content: null, error: null })
    void (async () => {
      try {
        const full = await window.electronAPI.kbGetDocument({ workspaceId: workspaceIdRef.current, docId: doc.id })
        if (previewSeqRef.current !== seq) return
        if (!full) {
          setPreview({ title: doc.title, loading: false, content: null, error: t('knowledgeBase.errors.notFound') })
          return
        }
        setPreview({ title: doc.title, loading: false, content: full.content, error: null })
      } catch (error) {
        if (previewSeqRef.current !== seq) return
        setPreview({ title: doc.title, loading: false, content: null, error: kbErrorText(t, error) })
      }
    })()
  }, [t])

  // #endregion

  const statusLabel = (status: KbDocumentStatus) => t(`knowledgeBase.status.${status}`)
  const formatSyncedTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const actionsFor = (doc: KbDocumentSummary) => {
    if (!canManage) return null
    // A pending row renders its badge from the row itself — the actions area
    // stays empty until it settles (Spec S1.2: ONLY this row waits).
    if (rowPending[doc.id]) return null
    switch (doc.status) {
      case 'draft':
        return (
          <>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              data-testid={`kb-doc-submit-${doc.id}`}
              onClick={() => startTransition(doc, 'submit')}
            >
              {t('knowledgeBase.actions.submit')}
            </Button>
            <DeleteButton label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
          </>
        )
      case 'in_review':
        // No delete affordance while under review: the store refuses it and
        // the review trail stays meaningful — reject (or revert) first
        // (review #14).
        return (
          <>
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              onClick={() => startTransition(doc, 'publish')}
            >
              {t('knowledgeBase.actions.publish')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              onClick={() => { setRejectReason(''); setRejectTarget(doc) }}
            >
              {t('knowledgeBase.actions.reject')}
            </Button>
          </>
        )
      case 'rejected':
        return (
          <>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              onClick={() => startTransition(doc, 'revert')}
            >
              {t('knowledgeBase.actions.revert')}
            </Button>
            <DeleteButton label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
          </>
        )
      case 'published':
        return (
          <DeleteButton label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
        )
    }
    return null
  }

  const renderUploadRow = (row: KbActiveUpload) => {
    const badge = (() => {
      switch (row.stage) {
        case 'queued':
          return { label: t('knowledgeBase.pending.stageQueued'), className: 'bg-info/12 text-info-text', spin: false }
        case 'submitted':
          return { label: t('knowledgeBase.pending.stageSubmitted'), className: 'bg-info/12 text-info-text', spin: false }
        case 'uploading':
          return { label: t('knowledgeBase.pending.stageUploading'), className: 'bg-accent/10 text-accent', spin: true }
        case 'done':
          return { label: t('knowledgeBase.pending.stageDone'), className: 'bg-accent/10 text-accent', spin: false }
        case 'failed':
          return { label: t('knowledgeBase.pending.stageFailed'), className: 'bg-destructive/10 text-destructive', spin: false }
        case 'cancelled':
          return { label: t('knowledgeBase.pending.stageCancelled'), className: 'bg-foreground/8 text-foreground-40', spin: false }
        case 'unknown':
          return { label: t('knowledgeBase.pending.stageUnknown'), className: 'bg-destructive/10 text-destructive', spin: false }
      }
    })()
    return (
      <li
        key={row.qid}
        className="flex flex-wrap items-center gap-[10px] border-b border-border/60 bg-accent/[0.03] px-[16px] py-[10px] last:border-b-0"
        data-testid={`kb-doc-pending-${row.qid}`}
        data-stage={row.stage}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground-70" title={row.fileName}>
          {row.title}
        </span>
        <span className={`inline-flex min-h-[20px] shrink-0 items-center gap-[5px] rounded-full px-[8px] text-[10px] font-semibold ${badge.className}`}>
          {badge.spin && <Icons.LoaderCircle className="size-[11px] animate-spin" aria-hidden="true" />}
          {badge.label}
        </span>
        <span className="shrink-0 text-[11px] text-foreground-40">{row.fileName}</span>
        <span className="flex shrink-0 items-center gap-[6px]">
          {row.stage === 'queued' && (
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              data-testid={`kb-upload-remove-${row.qid}`}
              onClick={() => removeUpload(row.qid)}
            >
              {t('knowledgeBase.upload.queue.removeQueued')}
            </Button>
          )}
          {(row.stage === 'submitted' || row.stage === 'uploading') && (
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              data-testid={`kb-upload-cancel-${row.qid}`}
              onClick={() => handleCancelUpload(row.qid)}
            >
              {t('knowledgeBase.upload.queue.cancel')}
            </Button>
          )}
          {row.stage === 'failed' && (
            <>
              <span className="text-[11px] text-destructive" data-testid={`kb-upload-failed-${row.qid}`}>
                {row.errorText ?? t('knowledgeBase.pending.failedHint')}
              </span>
              <Button
                type="button"
                variant="secondary"
                className={clientWorkbenchButtonClassName}
                data-testid={`kb-upload-retry-${row.qid}`}
                onClick={() => handleRetryUpload(row.qid)}
              >
                {t('knowledgeBase.actions.retry')}
              </Button>
            </>
          )}
          {row.stage === 'unknown' && (
            <>
              <span className="text-[11px] text-destructive">
                {t('knowledgeBase.pending.unknownHint')}
              </span>
              <Button
                type="button"
                variant="secondary"
                className={clientWorkbenchButtonClassName}
                data-testid={`kb-upload-verify-${row.qid}`}
                onClick={() => handleVerifyUpload(row.qid)}
              >
                {t('knowledgeBase.pending.verify')}
              </Button>
            </>
          )}
          {(row.stage === 'failed' || row.stage === 'unknown') && (
            <button
              type="button"
              aria-label={t('knowledgeBase.upload.queue.removeQueued')}
              title={t('knowledgeBase.upload.queue.removeQueued')}
              className="grid size-[22px] place-items-center rounded-[6px] text-foreground-40 hover:bg-foreground/6 hover:text-destructive"
              data-testid={`kb-upload-remove-${row.qid}`}
              onClick={() => removeUpload(row.qid)}
            >
              <Icons.X className="size-[13px]" aria-hidden="true" />
            </button>
          )}
          {row.verifyMissed && (
            <>
              <span className="text-[11px] text-destructive" data-testid={`kb-upload-verify-missed-${row.qid}`}>
                {t('knowledgeBase.pending.verifiedMissing')}
              </span>
              <Button
                type="button"
                variant="secondary"
                className={clientWorkbenchButtonClassName}
                data-testid={`kb-upload-retry-${row.qid}`}
                onClick={() => handleRetryUpload(row.qid)}
              >
                {t('knowledgeBase.actions.retry')}
              </Button>
            </>
          )}
        </span>
      </li>
    )
  }

  return (
    <div
      className={`${clientWorkbenchFocusClassName} h-full min-h-0 overflow-y-auto`}
      style={workbenchStyle}
      data-testid="knowledge-base-app"
    >
      <main className="mx-auto w-full max-w-[1260px] px-[18px] pb-[50px] pt-[30px] text-[15px] text-foreground min-[761px]:px-[26px] min-[1081px]:px-[44px]">
        <div className="mb-[24px] flex flex-wrap items-end justify-between gap-[12px]">
          <div className="min-w-0">
            <h1 className="m-0 text-[clamp(26px,2.6vw,32px)] font-[750] leading-[1.1] tracking-[-0.05em]">
              {t('knowledgeBase.title')}
            </h1>
            <p className="mt-[8px] max-w-[690px] text-[13px] leading-[1.6] text-foreground-60">
              {t('knowledgeBase.lead')}
            </p>
          </div>
          {canManage && (
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              disabled={!workspaceId}
              data-testid="kb-create-collection"
              onClick={() => { setCollectionDraft({ name: '', description: '' }); setCreateOpen(true) }}
            >
              <Icons.Plus className="size-[14px]" aria-hidden="true" />
              {t('knowledgeBase.actions.newCollection')}
            </Button>
          )}
        </div>

        {syncFailed && !loading && (
          <div
            className="mb-[12px] flex flex-wrap items-center gap-[10px] rounded-[10px] border border-destructive/25 bg-destructive/10 px-[12px] py-[8px] text-[12px]"
            data-testid="kb-sync-banner"
          >
            <Icons.CloudOff className="size-[14px] shrink-0 text-destructive" aria-hidden="true" />
            <span className="text-destructive">
              {t('knowledgeBase.sync.failed', { time: lastSyncedAt ? formatSyncedTime(lastSyncedAt) : '—' })}
            </span>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              data-testid="kb-sync-retry"
              // A retry is issued already counting one failure: if it fails
              // again the counter reaches the threshold and the banner STAYS
              // (it never drops below the threshold on a failed retry). Only
              // a successful sync clears the counter inside runSilentSync.
              onClick={() => { pollFailureRef.current = KB_SYNC_FAIL_THRESHOLD - 1; void runSilentSyncRef.current() }}
            >
              {t('knowledgeBase.sync.retry')}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center rounded-[16px] border border-border bg-surface client-material-card">
            <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div
            className="flex min-h-[220px] flex-col items-center justify-center gap-[10px] rounded-[16px] border border-destructive/25 bg-surface client-material-card px-[24px] text-center"
            data-testid="kb-load-error"
          >
            <Icons.CloudOff className="size-5 text-destructive" aria-hidden="true" />
            <p className="m-0 text-[13px] text-destructive">{loadError}</p>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              onClick={() => void refreshCollections()}
            >
              {t('knowledgeBase.actions.retry')}
            </Button>
          </div>
        ) : collections.length === 0 && pendingCollections.length === 0 ? (
          <div
            className="grid justify-items-center gap-[8px] rounded-[16px] border border-dashed border-border px-[20px] py-[40px] text-center"
            data-testid="kb-empty"
          >
            <Icons.Library className="size-[24px] text-muted-foreground" aria-hidden="true" />
            <h2 className="m-0 text-[15px] font-bold">{t('knowledgeBase.emptyTitle')}</h2>
            <p className="m-0 max-w-[460px] text-[12px] leading-[1.6] text-muted-foreground">
              {t('knowledgeBase.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-[16px] min-[851px]:grid-cols-[280px_minmax(0,1fr)]">
            {/* Collections column */}
            <nav
              className="flex flex-col gap-[6px] rounded-[16px] border border-border bg-surface client-material-card p-[8px]"
              data-testid="kb-collection-list"
            >
              {collections.map(collection => {
                const active = collection.id === selectedCollectionId
                return (
                  <button
                    key={collection.id}
                    type="button"
                    data-testid={`kb-collection-${collection.id}`}
                    onClick={() => setSelectedCollectionId(collection.id)}
                    className={`flex min-w-0 flex-col items-start gap-[2px] rounded-[10px] px-[10px] py-[8px] text-left transition-colors ${
                      active ? 'bg-foreground/6' : 'hover:bg-foreground/4'
                    }`}
                  >
                    <span className="flex w-full items-center gap-[6px]">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{collection.name}</span>
                      <span className="inline-flex min-h-[18px] shrink-0 items-center rounded-full bg-foreground/8 px-[7px] text-[10px] font-medium text-foreground-70">
                        {collection.documentCounts.published}
                      </span>
                    </span>
                    {collection.description && (
                      <span className="line-clamp-2 text-[11px] leading-[1.5] text-foreground-50">
                        {collection.description}
                      </span>
                    )}
                  </button>
                )
              })}
              {pendingCollections.map(row => (
                <div
                  key={row.pid}
                  className="flex min-w-0 flex-col items-start gap-[2px] rounded-[10px] bg-accent/[0.04] px-[10px] py-[8px] outline-1 outline-dashed outline-accent/35"
                  data-testid="kb-pending-collection"
                  data-pending-name={row.name}
                >
                  <span className="flex w-full items-center gap-[6px]">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{row.name}</span>
                    <span
                      className="inline-flex min-h-[18px] shrink-0 items-center gap-[5px] rounded-full bg-accent/10 px-[7px] text-[10px] font-semibold text-accent"
                      data-testid="kb-pending-collection-badge"
                    >
                      <Icons.LoaderCircle className="size-[11px] animate-spin" aria-hidden="true" />
                      {t('knowledgeBase.pending.collection')}
                    </span>
                  </span>
                  {row.description && (
                    <span className="line-clamp-2 text-[11px] leading-[1.5] text-foreground-50">
                      {row.description}
                    </span>
                  )}
                </div>
              ))}
            </nav>

            {/* Documents column */}
            <section
              className="min-w-0 rounded-[16px] border border-border bg-surface client-material-card"
              data-testid="kb-document-panel"
            >
              <header className="flex flex-wrap items-center justify-between gap-[10px] border-b border-border px-[16px] py-[12px]">
                <div className="min-w-0">
                  <h2 className="m-0 truncate text-[14px] font-bold">
                    {selectedCollection?.name ?? t('knowledgeBase.documentsTitle')}
                  </h2>
                  {selectedCollection?.description && (
                    <p className="m-0 mt-[2px] truncate text-[11px] text-muted-foreground">
                      {selectedCollection.description}
                    </p>
                  )}
                </div>
                {canManage && selectedCollection && (
                  <Button
                    type="button"
                    variant="secondary"
                    className={clientWorkbenchButtonClassName}
                    disabled={!workspaceId}
                    data-testid="kb-upload-document"
                    onClick={() => setUploadTarget(selectedCollection)}
                  >
                    <Icons.FileUp className="size-[14px]" aria-hidden="true" />
                    {t('knowledgeBase.actions.upload')}
                  </Button>
                )}
              </header>

              {documentsLoading ? (
                <div className="flex min-h-[160px] items-center justify-center">
                  <Icons.LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : documents.length === 0 && visibleUploads.length === 0 ? (
                <p className="m-0 px-[16px] py-[28px] text-center text-[12px] text-muted-foreground">
                  {canManage ? t('knowledgeBase.documentsEmptyManage') : t('knowledgeBase.documentsEmptyMember')}
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {documents.map(doc => {
                    const pending = rowPending[doc.id]
                    const failed = failedRows[doc.id]
                    return (
                      <li
                        key={doc.id}
                        className={`flex flex-wrap items-center gap-[10px] border-b border-border/60 px-[16px] py-[10px] last:border-b-0 ${
                          pending ? 'bg-accent/[0.03]' : ''
                        } ${freshDocIds.has(doc.id) ? 'bg-accent/10 transition-colors' : ''}`}
                        data-testid={`kb-document-${doc.id}`}
                      >
                        <button
                          type="button"
                          onClick={() => openPreview(doc)}
                          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground hover:text-accent"
                          title={doc.title}
                        >
                          {doc.title}
                        </button>
                        {pending ? (
                          <span
                            className="inline-flex min-h-[20px] shrink-0 items-center gap-[5px] rounded-full bg-accent/10 px-[8px] text-[10px] font-semibold text-accent"
                            data-testid={`kb-row-pending-${doc.id}`}
                          >
                            <Icons.LoaderCircle className="size-[11px] animate-spin" aria-hidden="true" />
                            {t(TRANSITION_PENDING_KEY[pending.op])}
                          </span>
                        ) : (
                          <span
                            className={`inline-flex min-h-[20px] shrink-0 items-center rounded-full px-[8px] text-[10px] font-semibold ${KB_STATUS_BADGE[doc.status]}`}
                            data-testid={`kb-document-status-${doc.id}`}
                          >
                            {statusLabel(doc.status)}
                          </span>
                        )}
                        <span className="shrink-0 text-[11px] text-foreground-40">
                          {t('knowledgeBase.versionShort', { version: doc.version })}
                        </span>
                        <span className="flex shrink-0 items-center gap-[6px]">
                          {actionsFor(doc)}
                        </span>
                        {failed && (
                          <span className="flex shrink-0 items-center gap-[6px]">
                            <span className="text-[11px] text-destructive" data-testid={`kb-trans-failed-${doc.id}`}>
                              {failed.message}
                            </span>
                            <button
                              type="button"
                              className="min-h-[22px] rounded-[6px] px-[6px] text-[11px] font-bold text-destructive underline underline-offset-2 hover:bg-destructive/10"
                              data-testid={`kb-trans-retry-${doc.id}`}
                              onClick={() => startTransition(doc, failed.op, { reason: failed.reason })}
                            >
                              {t('knowledgeBase.actions.retry')}
                            </button>
                          </span>
                        )}
                        {doc.status === 'rejected' && doc.rejectReason && (
                          <p className="m-0 w-full text-[11px] leading-[1.5] text-destructive/80">
                            {t('knowledgeBase.rejectReasonDetail', { reason: doc.rejectReason })}
                          </p>
                        )}
                      </li>
                    )
                  })}
                  {visibleUploads.map(row => renderUploadRow(row))}
                </ul>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Create collection */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={clientWorkbenchDialogClassName}
        >
          <DialogHeader>
            <DialogTitle>{t('knowledgeBase.createCollectionTitle')}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.createCollectionDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-[12px] px-[20px] pb-[18px]">
            <label className="grid gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('knowledgeBase.collectionName')}</span>
              <Input
                value={collectionDraft.name}
                maxLength={256}
                data-testid="kb-collection-name-input"
                onChange={event => setCollectionDraft(draft => ({ ...draft, name: event.target.value }))}
              />
            </label>
            <label className="grid gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('knowledgeBase.collectionDescription')}</span>
              <Textarea
                value={collectionDraft.description}
                maxLength={4096}
                rows={3}
                data-testid="kb-collection-description-input"
                onChange={event => setCollectionDraft(draft => ({ ...draft, description: event.target.value }))}
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" className={clientWorkbenchButtonClassName} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              disabled={collectionDraft.name.trim().length === 0 || !workspaceId}
              data-testid="kb-collection-create-confirm"
              onClick={handleCreateCollection}
            >
              {t('knowledgeBase.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload document — closing without confirming keeps the queue (S3.1). */}
      {uploadTarget && (
        <KbUploadDialog
          target={uploadTarget}
          queue={uploadQueue}
          rejected={uploadRejections}
          selectedQid={uploadSelectedQid}
          rejectionsExpanded={rejectionsExpanded}
          onIngest={files => void ingestFiles(files)}
          onSelect={setUploadSelectedQid}
          onRemoveQueued={qid => {
            setUploadQueue(prev => prev.filter(item => item.qid !== qid))
            setUploadSelectedQid(current => (current === qid ? null : current))
          }}
          onClearQueue={() => {
            setUploadQueue([])
            setUploadRejections([])
            setUploadSelectedQid(null)
          }}
          onUpdateItem={updateQueueItem}
          onDismissRejections={() => setUploadRejections([])}
          onToggleRejections={() => setRejectionsExpanded(expanded => !expanded)}
          onRepick={() => setUploadRejections([])}
          onConfirm={handleConfirmUpload}
          onCancel={() => setUploadTarget(null)}
        />
      )}

      {/* Reject with reason */}
      <Dialog open={Boolean(rejectTarget)} onOpenChange={open => { if (!open) setRejectTarget(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={clientWorkbenchDialogClassName}
        >
          <DialogHeader>
            <DialogTitle>{t('knowledgeBase.rejectTitle', { name: rejectTarget?.title ?? '' })}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.rejectDescription')}</DialogDescription>
          </DialogHeader>
          <div className="px-[20px] pb-[18px]">
            <Textarea
              value={rejectReason}
              maxLength={2048}
              rows={3}
              data-testid="kb-reject-reason-input"
              onChange={event => setRejectReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" className={clientWorkbenchButtonClassName} onClick={() => setRejectTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className={clientWorkbenchDestructiveClassName}
              disabled={rejectReason.trim().length === 0}
              data-testid="kb-reject-confirm"
              onClick={() => {
                const target = rejectTarget
                if (!target) return
                const reason = rejectReason.trim()
                setRejectTarget(null)
                setRejectReason('')
                startTransition(target, 'reject', { reason })
              }}
            >
              {t('knowledgeBase.actions.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={clientWorkbenchDialogClassName}
        >
          <DialogHeader>
            <DialogTitle>{t('knowledgeBase.deleteTitle', { name: deleteTarget?.title ?? '' })}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" className={clientWorkbenchButtonClassName} onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className={clientWorkbenchDestructiveClassName}
              data-testid="kb-delete-confirm"
              onClick={() => {
                const target = deleteTarget
                if (!target) return
                setDeleteTarget(null)
                startTransition(target, 'delete')
              }}
            >
              {t('knowledgeBase.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Read-only preview — opens instantly, content loads in place (S1.4). */}
      <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={`${clientWorkbenchDialogClassName} max-w-[860px] sm:max-w-[860px]`}
          data-testid="kb-preview-dialog"
        >
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.previewLabel')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto px-[20px] pb-[18px]">
            {preview?.loading ? (
              <div className="grid min-h-[200px] content-center place-items-center" data-testid="kb-preview-shimmer">
                <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                <span className="mt-[8px] text-[12px] text-muted-foreground">
                  {t('knowledgeBase.previewLoading')}
                </span>
              </div>
            ) : preview?.error ? (
              <div className="grid min-h-[120px] content-center justify-items-center gap-[10px]" data-testid="kb-preview-error">
                <p className="m-0 text-[13px] text-destructive">{preview.error}</p>
              </div>
            ) : (
              <div className="grid gap-[12px] min-[721px]:grid-cols-2">
                <div className="grid min-w-0 content-start gap-[6px]">
                  <h4 className="m-0 text-[11px] font-semibold tracking-[0.4px] text-foreground-50">
                    {t('knowledgeBase.previewRawLabel')}
                  </h4>
                  <pre className="m-0 max-h-[46vh] min-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-border bg-surface-strong px-[11px] py-[9px] font-mono text-[12px] leading-[1.6] text-foreground-80">
                    {preview?.content}
                  </pre>
                </div>
                <div className="grid min-w-0 content-start gap-[6px]">
                  <h4 className="m-0 text-[11px] font-semibold tracking-[0.4px] text-foreground-50">
                    {t('knowledgeBase.previewRenderedLabel')}
                  </h4>
                  <div
                    className="max-h-[46vh] min-h-[200px] overflow-auto rounded-[10px] border border-border bg-surface px-[14px] py-[12px]"
                    data-testid="kb-preview-rendered"
                  >
                    {renderKbMarkdown(preview?.content ?? '')}
                  </div>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface CollectionDraft {
  name: string
  description: string
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      className="min-h-[26px] rounded-[7px] px-[6px] text-foreground-40 hover:bg-foreground/6 hover:text-destructive"
      onClick={onClick}
    >
      <Icons.Trash2 className="size-[13px]" aria-hidden="true" />
    </Button>
  )
}
