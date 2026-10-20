import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { toast } from 'sonner'
import type {
  KbCollection,
  KbDocumentStatus,
  KbDocumentSummary,
} from '@polo-ai/shared/protocol'
import {
  KB_MAX_CONTENT_BYTES,
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
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDestructiveClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchFocusClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'

/**
 * The enterprise knowledge base app tab (POO-108): write-side management over
 * the workspace's `.polo-kb/` store through the LOCAL_ONLY kb RPC surface.
 * Members read published documents; owners/managers run the draft → review →
 * publish flow. Every server mutation is permission-checked and audited
 * server-side — this surface only renders the outcome.
 */

const KB_STATUS_BADGE: Record<KbDocumentStatus, string> = {
  draft: 'bg-foreground/8 text-foreground-70',
  in_review: 'bg-info/12 text-info-text',
  published: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent',
  rejected: 'bg-destructive/10 text-destructive',
}

function isKbError(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code
}

function kbErrorText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'kb_manage_required') return t('knowledgeBase.errors.manageRequired')
  if (code === 'kb_content_too_large') return t('knowledgeBase.errors.tooLarge')
  if (code === 'kb_invalid_transition') return t('knowledgeBase.errors.invalidTransition')
  if (code === 'kb_delete_not_allowed') return t('knowledgeBase.errors.deleteNotAllowed')
  if (code === 'kb_collection_not_found' || code === 'kb_document_not_found') return t('knowledgeBase.errors.notFound')
  if (code === 'kb_unavailable_in_personal') return t('knowledgeBase.errors.personalSpace')
  if (code === 'kb_space_read_only') return t('knowledgeBase.errors.spaceReadOnly')
  if (code === 'kb_space_mismatch') return t('knowledgeBase.errors.spaceMismatch')
  if (code === 'OFFLINE_READ_ONLY') return t('knowledgeBase.errors.offline')
  return t('knowledgeBase.errors.generic')
}

interface CollectionDraft {
  name: string
  description: string
}

interface DocumentDraft {
  title: string
  content: string
}

export function KnowledgeBaseApp() {
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

  // Dialog state: one open dialog at a time, keyed by intent.
  const [createOpen, setCreateOpen] = useState(false)
  const [collectionDraft, setCollectionDraft] = useState<CollectionDraft>({ name: '', description: '' })
  const [uploadTarget, setUploadTarget] = useState<KbCollection | null>(null)
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft>({ title: '', content: '' })
  const [rejectTarget, setRejectTarget] = useState<KbDocumentSummary | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<KbDocumentSummary | null>(null)
  const [previewDoc, setPreviewDoc] = useState<{ title: string; content: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedCollection = useMemo(
    () => collections.find(collection => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  )

  const refreshCollections = useCallback(async (preferId?: string) => {
    if (!workspaceId) return
    setLoading(true)
    setLoadError(null)
    try {
      const list = await window.electronAPI.kbListCollections({ workspaceId })
      setCanManage(list.canManage)
      setCollections(list.collections)
      setSelectedCollectionId(current => {
        const wanted = preferId ?? current
        return wanted && list.collections.some(row => row.id === wanted) ? wanted : list.collections[0]?.id ?? null
      })
    } catch (error) {
      setLoadError(kbErrorText(t, error))
    } finally {
      setLoading(false)
    }
  }, [t, workspaceId])

  const refreshDocuments = useCallback(async (collectionId: string) => {
    setDocumentsLoading(true)
    try {
      setDocuments(await window.electronAPI.kbListDocuments({ workspaceId, collectionId }))
    } catch (error) {
      toast.error(kbErrorText(t, error))
    } finally {
      setDocumentsLoading(false)
    }
  }, [t, workspaceId])

  useEffect(() => {
    void refreshCollections()
  }, [refreshCollections])

  useEffect(() => {
    if (!selectedCollectionId) {
      setDocuments([])
      return
    }
    void refreshDocuments(selectedCollectionId)
  }, [refreshDocuments, selectedCollectionId])

  const runMutation = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(kbErrorText(t, error))
    } finally {
      setBusy(false)
    }
  }, [t])

  const handleCreateCollection = () => runMutation(async () => {
    const created = await window.electronAPI.kbCreateCollection({
      workspaceId,
      name: collectionDraft.name,
      description: collectionDraft.description,
    })
    setCreateOpen(false)
    setCollectionDraft({ name: '', description: '' })
    toast.success(t('knowledgeBase.toast.collectionCreated'))
    await refreshCollections(created.id)
  })

  const handleUploadDocument = () => runMutation(async () => {
    if (!uploadTarget) return
    const created = await window.electronAPI.kbUploadDocument({
      workspaceId,
      collectionId: uploadTarget.id,
      title: documentDraft.title,
      content: documentDraft.content,
    })
    setUploadTarget(null)
    setDocumentDraft({ title: '', content: '' })
    toast.success(t('knowledgeBase.toast.documentUploaded'))
    await refreshCollections(uploadTarget.id)
    await refreshDocuments(created.collectionId)
  })

  const handleFilePick = async (file: File | undefined) => {
    if (!file) return
    if (file.size > KB_MAX_CONTENT_BYTES) {
      toast.error(t('knowledgeBase.errors.tooLarge'))
      return
    }
    const text = await file.text()
    setDocumentDraft(draft => ({
      title: draft.title || file.name.replace(/\.(md|markdown|txt)$/i, ''),
      content: text,
    }))
  }

  const handleTransition = (doc: KbDocumentSummary, action: 'submit' | 'publish' | 'revert') => runMutation(async () => {
    if (action === 'submit') {
      await window.electronAPI.kbSubmitForReview({ workspaceId, docId: doc.id })
      toast.success(t('knowledgeBase.toast.submitted'))
    } else if (action === 'publish') {
      await window.electronAPI.kbPublishDocument({ workspaceId, docId: doc.id })
      toast.success(t('knowledgeBase.toast.published'))
    } else {
      await window.electronAPI.kbRevertToDraft({ workspaceId, docId: doc.id })
      toast.success(t('knowledgeBase.toast.reverted'))
    }
    await refreshCollections(doc.collectionId)
    await refreshDocuments(doc.collectionId)
  })

  const handleReject = () => runMutation(async () => {
    if (!rejectTarget) return
    await window.electronAPI.kbRejectDocument({
      workspaceId,
      docId: rejectTarget.id,
      reason: rejectReason,
    })
    const collectionId = rejectTarget.collectionId
    setRejectTarget(null)
    setRejectReason('')
    toast.success(t('knowledgeBase.toast.rejected'))
    await refreshCollections(collectionId)
    await refreshDocuments(collectionId)
  })

  const handleDelete = () => runMutation(async () => {
    if (!deleteTarget) return
    await window.electronAPI.kbDeleteDocument({ workspaceId, docId: deleteTarget.id })
    const collectionId = deleteTarget.collectionId
    setDeleteTarget(null)
    toast.success(t('knowledgeBase.toast.deleted'))
    await refreshCollections(collectionId)
    await refreshDocuments(collectionId)
  })

  const openPreview = async (doc: KbDocumentSummary) => runMutation(async () => {
    const full = await window.electronAPI.kbGetDocument({ workspaceId, docId: doc.id })
    if (!full) {
      toast.error(t('knowledgeBase.errors.notFound'))
      return
    }
    setPreviewDoc({ title: full.title, content: full.content })
  })

  const statusLabel = (status: KbDocumentStatus) => t(`knowledgeBase.status.${status}`)

  const actionsFor = (doc: KbDocumentSummary) => {
    if (!canManage) return null
    switch (doc.status) {
      case 'draft':
        return (
          <>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              disabled={busy}
              onClick={() => void handleTransition(doc, 'submit')}
            >
              {t('knowledgeBase.actions.submit')}
            </Button>
            <DeleteButton disabled={busy} label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
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
              disabled={busy}
              onClick={() => void handleTransition(doc, 'publish')}
            >
              {t('knowledgeBase.actions.publish')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className={clientWorkbenchButtonClassName}
              disabled={busy}
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
              disabled={busy}
              onClick={() => void handleTransition(doc, 'revert')}
            >
              {t('knowledgeBase.actions.revert')}
            </Button>
            <DeleteButton disabled={busy} label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
          </>
        )
      case 'published':
        return (
          <DeleteButton disabled={busy} label={t('knowledgeBase.actions.delete')} onClick={() => setDeleteTarget(doc)} />
        )
    }
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
              disabled={!workspaceId || busy}
              data-testid="kb-create-collection"
              onClick={() => { setCollectionDraft({ name: '', description: '' }); setCreateOpen(true) }}
            >
              <Icons.Plus className="size-[14px]" aria-hidden="true" />
              {t('knowledgeBase.actions.newCollection')}
            </Button>
          )}
        </div>

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
        ) : collections.length === 0 ? (
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
                    disabled={!workspaceId || busy}
                    data-testid="kb-upload-document"
                    onClick={() => { setDocumentDraft({ title: '', content: '' }); setUploadTarget(selectedCollection) }}
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
              ) : documents.length === 0 ? (
                <p className="m-0 px-[16px] py-[28px] text-center text-[12px] text-muted-foreground">
                  {canManage ? t('knowledgeBase.documentsEmptyManage') : t('knowledgeBase.documentsEmptyMember')}
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {documents.map(doc => (
                    <li
                      key={doc.id}
                      className="flex flex-wrap items-center gap-[10px] border-b border-border/60 px-[16px] py-[10px] last:border-b-0"
                      data-testid={`kb-document-${doc.id}`}
                    >
                      <button
                        type="button"
                        onClick={() => void openPreview(doc)}
                        className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground hover:text-accent"
                        title={doc.title}
                      >
                        {doc.title}
                      </button>
                      <span
                        className={`inline-flex min-h-[20px] shrink-0 items-center rounded-full px-[8px] text-[10px] font-semibold ${KB_STATUS_BADGE[doc.status]}`}
                        data-testid={`kb-document-status-${doc.id}`}
                      >
                        {statusLabel(doc.status)}
                      </span>
                      <span className="shrink-0 text-[11px] text-foreground-40">
                        {t('knowledgeBase.versionShort', { version: doc.version })}
                      </span>
                      <span className="flex shrink-0 items-center gap-[6px]">
                        {actionsFor(doc)}
                      </span>
                      {doc.status === 'rejected' && doc.rejectReason && (
                        <p className="m-0 w-full text-[11px] leading-[1.5] text-destructive/80">
                          {t('knowledgeBase.rejectReasonDetail', { reason: doc.rejectReason })}
                        </p>
                      )}
                    </li>
                  ))}
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
              disabled={busy || collectionDraft.name.trim().length === 0 || !workspaceId}
              data-testid="kb-collection-create-confirm"
              onClick={() => void handleCreateCollection()}
            >
              {t('knowledgeBase.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload document */}
      <Dialog open={Boolean(uploadTarget)} onOpenChange={open => { if (!open) setUploadTarget(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={clientWorkbenchDialogClassName}
        >
          <DialogHeader>
            <DialogTitle>{t('knowledgeBase.uploadTitle', { name: uploadTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.uploadDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-[12px] px-[20px] pb-[18px]">
            <label className="grid gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('knowledgeBase.documentTitle')}</span>
              <Input
                value={documentDraft.title}
                maxLength={512}
                data-testid="kb-document-title-input"
                onChange={event => setDocumentDraft(draft => ({ ...draft, title: event.target.value }))}
              />
            </label>
            <div className="flex items-center gap-[8px]">
              <Button
                type="button"
                variant="secondary"
                className={clientWorkbenchButtonClassName}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icons.FileUp className="size-[14px]" aria-hidden="true" />
                {t('knowledgeBase.actions.pickFile')}
              </Button>
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {t('knowledgeBase.pickFileHint')}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="hidden"
                onChange={event => {
                  void handleFilePick(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </div>
            <label className="grid gap-[6px] text-[12px] text-muted-foreground">
              <span>{t('knowledgeBase.documentContent')}</span>
              <Textarea
                value={documentDraft.content}
                rows={10}
                data-testid="kb-document-content-input"
                onChange={event => setDocumentDraft(draft => ({ ...draft, content: event.target.value }))}
              />
              <span className="text-[11px] text-foreground-40">
                {t('knowledgeBase.contentBytes', {
                  bytes: new TextEncoder().encode(documentDraft.content).length,
                  max: KB_MAX_CONTENT_BYTES,
                })}
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" className={clientWorkbenchButtonClassName} onClick={() => setUploadTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              disabled={busy || documentDraft.title.trim().length === 0 || !workspaceId}
              data-testid="kb-document-upload-confirm"
              onClick={() => void handleUploadDocument()}
            >
              {t('knowledgeBase.actions.upload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              disabled={busy || rejectReason.trim().length === 0}
              data-testid="kb-reject-confirm"
              onClick={() => void handleReject()}
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
              disabled={busy}
              data-testid="kb-delete-confirm"
              onClick={() => void handleDelete()}
            >
              {t('knowledgeBase.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Read-only preview */}
      <Dialog open={Boolean(previewDoc)} onOpenChange={open => { if (!open) setPreviewDoc(null) }}>
        <DialogContent
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={`${clientWorkbenchDialogClassName} max-w-[720px] sm:max-w-[720px]`}
        >
          <DialogHeader>
            <DialogTitle>{previewDoc?.title}</DialogTitle>
            <DialogDescription>{t('knowledgeBase.previewLabel')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto px-[20px] pb-[18px]">
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[13px] leading-[1.7] text-foreground-80">
              {previewDoc?.content}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DeleteButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={label}
      title={label}
      className="min-h-[26px] rounded-[7px] px-[6px] text-foreground-40 hover:bg-foreground/6 hover:text-destructive"
      onClick={onClick}
    >
      <Icons.Trash2 className="size-[13px]" aria-hidden="true" />
    </Button>
  )
}
