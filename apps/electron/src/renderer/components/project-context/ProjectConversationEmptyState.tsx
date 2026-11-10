import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { MessageSquareText, Upload, UserPlus } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ProjectContextTabs, type ProjectContextTab } from '@/components/project-context/ProjectContextTabs'
import { ProjectFileLibrary } from '@/components/project-context/ProjectFileLibrary'
import { ProjectPinPane } from '@/components/project-context/ProjectPinPane'
import {
  ProjectMembersEntryLabel,
  ProjectMembersPanel,
} from '@/components/project-context/ProjectMembersPanel'
import { useProjectMembersPanelHost } from '@/components/project-context/useProjectMembersPanelHost'
import { useCollaborationRoster } from '@/components/project-context/useCollaborationRoster'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { projectEntryAtom, projectEntrySendNoticesAtom, emptyDraftKey, isEntryPendingState } from '@/atoms/project-entry'
import { getActiveProjectFor } from '@/components/projects/projects-bus'
import type { ClientMemberRole } from '@polo-ai/shared/admin/client-enterprise-contract'
import type { FileAttachment } from '../../../shared/types'
import type { WebElementReference } from '@polo-ai/core/types'
import type { ProjectAssetMentionDraft } from '@/atoms/project-context'

/**
 * POO-196 R3 (adjudication D14) — the project conversation empty state,
 * POO-205 revised.
 *
 * Entering a project with no account history lands here instead of the
 * generic "no session selected" panel: a REAL conversation layout (header,
 * 消息/文件/Pin tabs, members entry and the trusted composer) that lets the
 * user start talking. Entering stays zero-write — the session is created
 * ONLY by the user's first explicit send through the trusted
 * onCreateSession→onSendMessage path, and the created session binds THIS
 * project (Spec Q2: the POO-205 immutable `projectId` + the authoritative
 * projectContext snapshot from the active-project bus).
 *
 * POO-205: the committed enterprise space is an ORGANIZATION; the empty
 * state binds to the ENTERED project (the active-project bus, stamped with
 * this account + committed org space). Without an entered project there is
 * no project scope to read — the members entry, the file/pin tabs and the
 * upload/invite cards hide (chat stays a base capability) instead of
 * issuing doomed pm/pc calls. Drafts persist per account+scope in memory so
 * a failed create keeps everything the user typed.
 *
 * The members entry mounts the SAME panel host as ChatPage (P9: one members
 * surface, no second dialog).
 */

interface ScopeDraft {
  input: string
  attachments: FileAttachment[]
  elementReferences: WebElementReference[]
  projectAssetRefs: ProjectAssetMentionDraft[]
}

const scopeDrafts = new Map<string, ScopeDraft>()

function readScopeDraft(key: string): ScopeDraft {
  const existing = scopeDrafts.get(key)
  if (existing) return existing
  const fresh: ScopeDraft = { input: '', attachments: [], elementReferences: [], projectAssetRefs: [] }
  scopeDrafts.set(key, fresh)
  return fresh
}

export interface ProjectConversationEmptyStateProps {
  accountId: string
  workspaceId: string
  /** The committed ORGANIZATION space id (POO-205 revision). */
  productSpaceId: string
  /** Display fallback; the ENTERED project's name wins when one is active. */
  projectName: string
  /** Space-summary role — only a fallback until the project roster speaks. */
  viewerRole: ClientMemberRole
  /** The committed organization's enterprise id (pm scope consistency). */
  enterpriseId: string
}

export function ProjectConversationEmptyState({
  accountId,
  workspaceId,
  productSpaceId,
  projectName: fallbackProjectName,
  viewerRole,
  enterpriseId,
}: ProjectConversationEmptyStateProps) {
  const { t } = useTranslation()
  const { onCreateSession, onSendMessage, filePreview, filePreviewVisible } = useAppShellContext()
  const [projectTab, setProjectTab] = useState<ProjectContextTab>('messages')
  const submittingRef = useRef(false)

  // POO-205: the project this surface binds to is the ENTERED project — the
  // active-project bus, scope-stamped to THIS account + committed org space.
  // Everything project-scoped (roster, members panel, pc library, the
  // first-send binding) hangs off it; without it the surface degrades to the
  // chat-only face.
  const activeProject = getActiveProjectFor(accountId, productSpaceId)
  const projectName = activeProject?.name ?? fallbackProjectName
  // POO-205 C3: the composer draft (and its blocked-send notice marker) is
  // keyed PER PROJECT — project A's half-typed draft must never resurface on
  // project B's tab (one organization space hosts many projects).
  const draftKey = emptyDraftKey(accountId, productSpaceId, activeProject?.projectId ?? null)
  const draft = readScopeDraft(draftKey)
  const projectScope = activeProject && enterpriseId
    ? {
      accountId,
      productSpaceId,
      organizationEnterpriseId: enterpriseId,
      projectId: activeProject.projectId,
    }
    : null

  // The panel host (push/drawer + suspension) and the P9 entry roster — the
  // empty state has no session, so no tool pane can occupy the right column.
  const laneRef = useRef<HTMLDivElement | null>(null)
  const membersTriggerRef = useRef<HTMLButtonElement | null>(null)
  // UB4 (U5): the composer ref — closing the one-time onboarding panel hands
  // focus back to the input (「关闭后聚焦输入框」), never a dead surface.
  const composerRef = useRef<RichTextInputHandle | null>(null)
  // UB4 (U5): the「上传」action card's one-shot request into the files tab's
  // EXISTING upload dialog (explicit trigger wiring only — no new flow).
  const [uploadSignal, setUploadSignal] = useState(0)
  const membersRoster = useCollaborationRoster(projectScope)
  // U7: the members entry is a real ≥32px bordered button in BOTH hosts. The
  // roster viewerRole is the live add-members authority (the prop role only
  // fills in until the roster speaks; a roster 403 removes the glyph).
  const membersEntryLostAccess = membersRoster.errorKey === 'projectMembers.error.forbidden'
  const membersEntryRole = membersEntryLostAccess
    ? null
    : (membersRoster.viewerRole ?? viewerRole)
  const membersCanInvite = membersEntryRole === 'owner' || membersEntryRole === 'manager'
  const membersPanelHost = useProjectMembersPanelHost({
    enabled: projectScope !== null,
    laneRef,
    toolPaneOccupied: Boolean(filePreview && filePreviewVisible),
    triggerRef: membersTriggerRef,
    // UB4 (U5): this empty state IS the conversation host for the scope —
    // the recorded one-time intent is consumed HERE when the entry is ready,
    // the project is committed and this viewer may add members; the panel
    // opens straight on the 添加成员 selection page and closing it refocuses
    // the composer below.
    onboardingScope: { accountId, productSpaceId },
    canInvite: membersCanInvite,
    onOnboardingClosed: () => { composerRef.current?.focus() },
  })

  // UB2 (U11): the SHARED entry transaction state — the composer gate reads
  // the same owner the HomePage cards and the history-error face consume, so
  // a blocked first send can never create a session into a scope that is
  // still switching, and the draft stays exactly as typed.
  const entryState = useAtomValue(projectEntryAtom)
  const entryStateRef = useRef(entryState)
  entryStateRef.current = entryState
  const setSendNotices = useSetAtom(projectEntrySendNoticesAtom)
  const sendNotices = useAtomValue(projectEntrySendNoticesAtom)
  // ONE draft scope identity for the whole surface: the scope draft map and
  // the entry-transaction notice markers address the SAME per-project key.
  const composerDraftKey = draftKey

  const handleInputChange = useCallback((value: string) => {
    draft.input = value
  }, [draft])

  const handleAttachmentsChange = useCallback((attachments: FileAttachment[]) => {
    draft.attachments = attachments
  }, [draft])

  const handleElementReferencesChange = useCallback((references: WebElementReference[]) => {
    draft.elementReferences = references
  }, [draft])

  const handleProjectAssetRefsChange = useCallback((references: ProjectAssetMentionDraft[]) => {
    draft.projectAssetRefs = references
  }, [draft])

  // U11: the synchronous admission gate — a send while the entry is in
  // flight records ONE contentless notice marker and refuses INSIDE the
  // composer, before any session creation or draft clear.
  const submitGate = useCallback(() => {
    if (!isEntryPendingState(entryStateRef.current)) return true
    setSendNotices(notices => [
      ...notices.filter(notice => !(notice.accountId === accountId && notice.draftKey === composerDraftKey)),
      {
        accountId,
        productSpaceId,
        draftKey: composerDraftKey,
        generation: entryStateRef.current.generation,
      },
    ])
    toast.error(t('project.entry.sendBlocked'))
    return false
  }, [accountId, composerDraftKey, productSpaceId, setSendNotices, t])

  // U11 persistent notice above the composer: the waiting-time prompt while
  // an entry is in flight, then「项目已打开，刚才的内容还在，请点击发送。」
  // once THIS scope landed and the retained draft still exists. (The
  // empty-state composer IS its own draft scope —「返回原对话」cannot happen
  // here; leaving the surface unmounts this composer entirely.)
  const gateNotice = useMemo(() => {
    if (isEntryPendingState(entryState)) return t('project.entry.sendBlocked')
    const mine = sendNotices.find(notice => notice.accountId === accountId && notice.draftKey === composerDraftKey)
    if (!mine) return null
    const retainedDraft = draft.input.trim().length > 0
      || draft.attachments.length > 0
      || draft.elementReferences.length > 0
      || draft.projectAssetRefs.length > 0
    return retainedDraft ? t('project.entry.sendReady') : null
  }, [accountId, composerDraftKey, draft, entryState, sendNotices, t])

  const handleFirstSend = useCallback((
    message: string,
    attachments?: FileAttachment[],
    skillSlugs?: string[],
    elementReferences?: WebElementReference[],
    projectAssetRefs?: ProjectAssetMentionDraft[],
  ) => {
    // Single-submit lock: a double click or Enter repeat must never mint two
    // sessions for one message (D14 first-send discipline).
    if (submittingRef.current) return
    submittingRef.current = true
    void (async () => {
      try {
        // POO-205: the created session binds THIS project — the immutable
        // projectId plus the authoritative context snapshot (name / purpose /
        // instructions) the entry published. Without an entered project the
        // creation stays unbound (the trusted side owns the default binding).
        const entered = getActiveProjectFor(accountId, productSpaceId)
        const session = await onCreateSession(workspaceId, entered
          ? {
            projectId: entered.projectId,
            projectContext: {
              name: entered.name,
              ...(entered.purpose ? { purpose: entered.purpose } : {}),
              ...(entered.instructions ? { instructions: entered.instructions } : {}),
            },
          }
          : {
            projectContext: {
              name: projectName,
            },
          })
        // Scope fence (D14): the created session's immutable bindings must
        // match THIS scope before anything is sent into it.
        if (session.productSpaceId !== productSpaceId || (session.accountId && session.accountId !== accountId)) {
          toast.error(t('project.entry.scopeChanged'))
          return
        }
        if (entered && session.projectId !== entered.projectId) {
          toast.error(t('project.entry.scopeChanged'))
          return
        }
        // Hand the conversation to the real ChatPage, then deliver the
        // first message through the trusted send path (the deep-link flow's
        // short delay lets the panel mount and register the session).
        navigate(routes.view.allSessions(session.id))
        window.setTimeout(() => {
          onSendMessage(
            session.id,
            message,
            attachments,
            skillSlugs,
            undefined,
            elementReferences,
            projectAssetRefs,
          )
        }, 100)
        // U11: the accepted first send consumes this scope's blocked-send
        // notice marker (the guidance did its job) along with the served
        // draft — the project conversation starts clean.
        setSendNotices(notices => notices.filter(notice => !(notice.accountId === accountId && notice.draftKey === composerDraftKey)))
        // The draft's purpose is served; start the project conversation clean.
        scopeDrafts.delete(draftKey)
      } catch {
        // Create failed: keep every draft byte and let the user retry —
        // no session row was created on this path's failures.
        toast.error(t('project.entry.historyFailed'))
      } finally {
        submittingRef.current = false
      }
    })()
  }, [accountId, composerDraftKey, draftKey, onCreateSession, onSendMessage, productSpaceId, projectName, setSendNotices, t, workspaceId])

  const projectId = activeProject?.projectId ?? null

  const projectAssetMention = useMemo(() => ({
    search: (q: string) => projectId
      ? window.electronAPI.pcSearchAssets({
        workspaceId,
        productSpaceId,
        projectId,
        q,
        limit: 20,
      })
      : Promise.resolve({ degraded: true, hits: [] }),
  }), [productSpaceId, projectId, workspaceId])

  const projectPaneVisible = projectScope !== null && projectTab !== 'messages'
  const projectPaneKey = `${accountId}:${productSpaceId}:${projectId ?? ''}`

  // UB4 (U5) three action cards:
  // - 「邀请同事」(primary, invite-capable viewers only) → the members panel's
  //   existing 添加成员 selection page through the host's open channel —
  //   nothing invites until the in-panel confirm (0 invite here);
  // - 「上传」→ switches to the files tab AND raises the one-shot signal into
  //   the EXISTING AssetUploadDialog (capability-gated inside the library);
  // - 「直接开始聊」→ focuses the composer ONLY.
  // All three are pure presentation actions: 0 createSession / 0 send / 0
  // invitation write before AND after the click.
  const handleUploadAction = useCallback(() => {
    setProjectTab('files')
    setUploadSignal(signal => signal + 1)
  }, [])
  const handleInviteAction = useCallback(() => {
    if (!membersCanInvite) return
    membersPanelHost.openInvitePanel()
  }, [membersCanInvite, membersPanelHost])
  const handleStartChatAction = useCallback(() => {
    composerRef.current?.focus()
  }, [])

  return (
    // The chat lane (D8 measurement node) — same contract as ChatPage.
    <div ref={laneRef} className="h-full flex min-h-0 min-w-0">
      <div className="h-full flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-entry-empty">
        <PanelHeader
          title={projectName}
          actions={projectScope ? (
            <button
              type="button"
              ref={membersTriggerRef}
              data-testid="pc-members-button"
              aria-label={t(membersCanInvite ? 'projectMembers.openMembersAndInvite' : 'projectMembers.buttonAria')}
              aria-haspopup="dialog"
              aria-expanded={membersPanelHost.open}
              onClick={membersPanelHost.openPanel}
              className="inline-flex h-8 min-h-[32px] shrink-0 items-center gap-1.5 rounded-[6px] border border-border bg-foreground-5 px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <ProjectMembersEntryLabel roster={membersRoster} showInviteAffordance={membersCanInvite} />
            </button>
          ) : undefined}
        />
        {projectScope ? (
          <ProjectContextTabs
            value={projectTab}
            onValueChange={setProjectTab}
          />
        ) : null}
        <div className={projectPaneVisible ? 'hidden' : 'flex flex-1 flex-col items-center justify-center gap-2 px-6'}>
          <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">{t('project.entry.emptyTitle')}</h2>
          {/* U5: honest capability copy — the assistant's real scope first;
              the add-members sentence ONLY for viewers who can actually add
              (a member host never sees the second sentence nor the card —
              no misleading affordance). */}
          <p className="m-0 max-w-[460px] text-center text-[13px] leading-[1.6] text-muted-foreground" data-testid="project-entry-empty-hint">
            {t('project.entry.emptyHint')}
            {membersCanInvite && projectScope ? <span>{t('project.entry.inviteHint')}</span> : null}
          </p>
          {/* U5 three action cards (project-bound only): desktop side-by-side,
              narrow wraps. Without a project scope the chat-only face keeps
              the composer and hides every project-scoped affordance. */}
          {projectScope ? (
            <div className="mt-4 flex w-full max-w-[520px] flex-wrap items-stretch justify-center gap-[10px]" data-testid="project-entry-actions">
              {membersCanInvite ? (
              <button
                type="button"
                data-testid="project-entry-action-invite"
                onClick={handleInviteAction}
                className="inline-flex min-h-[44px] min-w-[140px] flex-1 items-center justify-center gap-[8px] rounded-[10px] border border-accent bg-[var(--accent-soft)] px-[14px] text-[13px] font-semibold text-accent transition-colors hover:bg-accent hover:text-[var(--on-accent,#fff)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                <UserPlus className="size-[15px] shrink-0" aria-hidden="true" />
                {t('project.entry.inviteColleagues')}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="project-entry-action-upload"
              onClick={handleUploadAction}
              className="inline-flex min-h-[44px] min-w-[120px] flex-1 items-center justify-center gap-[8px] rounded-[10px] border border-border bg-foreground-5 px-[14px] text-[13px] font-medium text-foreground transition-colors hover:bg-foreground-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <Upload className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
              {t('projectContext.library.upload')}
            </button>
            <button
              type="button"
              data-testid="project-entry-action-start"
              onClick={handleStartChatAction}
              className="inline-flex min-h-[44px] min-w-[120px] flex-1 items-center justify-center gap-[8px] rounded-[10px] border border-border bg-foreground-5 px-[14px] text-[13px] font-medium text-foreground transition-colors hover:bg-foreground-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <MessageSquareText className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
              {t('project.entry.startChatting')}
            </button>
            </div>
          ) : null}
          <div className="mt-4 w-full max-w-[720px]">
            <FreeFormInput
              inputRef={composerRef}
              projectComposer={projectScope !== null}
              placeholder={t('project.entry.emptyHint')}
              onSubmit={handleFirstSend}
              submitGate={submitGate}
              gateNotice={gateNotice}
              currentModel=""
              inputValue={draft.input}
              onInputChange={handleInputChange}
              attachmentsValue={draft.attachments}
              onAttachmentsChange={handleAttachmentsChange}
              elementReferencesValue={draft.elementReferences}
              onElementReferencesChange={handleElementReferencesChange}
              projectAssetMention={projectAssetMention}
              projectAssetRefsValue={draft.projectAssetRefs}
              onProjectAssetRefsChange={handleProjectAssetRefsChange}
              disabled={submittingRef.current}
            />
          </div>
        </div>
        {projectPaneVisible && (
          <>
            <div className={projectTab === 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
              <ProjectFileLibrary
                key={projectPaneKey}
                scope={{ workspaceId, productSpaceId, projectId: projectScope!.projectId }}
                currentUserId={accountId}
                active={projectTab === 'files'}
                pinMutations={0}
                uploadSignal={uploadSignal}
                onUploadSignalConsumed={() => setUploadSignal(0)}
              />
            </div>
            <div className={projectTab !== 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
              <ProjectPinPane
                key={projectPaneKey}
                scope={{ workspaceId, productSpaceId, projectId: projectScope!.projectId }}
                active={projectTab !== 'files'}
                onChanged={() => {}}
              />
            </div>
          </>
        )}
      </div>
      {projectScope ? (
        <ProjectMembersPanel
          open={membersPanelHost.open}
          mode={membersPanelHost.mode}
          scope={projectScope}
          projectName={projectName}
          roster={membersRoster}
          onClose={membersPanelHost.closePanel}
          initialDirectory={membersPanelHost.directoryLanding}
          onboardingOpen={membersPanelHost.onboardingAutoOpen}
        />
      ) : null}
    </div>
  )
}
